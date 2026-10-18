# -*- coding: utf-8 -*-
"""
ai_service.py — 「场景对话」的 Claude 调用层（跑在本地 Python 服务里，密钥不进浏览器）

三个调用，全部结构化输出，LLM 永远不写坐标：
- draft(intent, axis, targets, locked)   一句话 → 3 张卡（原型 + 参数 + 放置类 + 密度 + 调色板 + 文案）
- revise(card, action, locked)            人的一次动作（选择 / 笔画事实 / 一句话）→ 对当前卡的结构 patch + 复述 + 可选的一个追问
- restate(card, facts)                    由卡与引擎事实生成「我理解为」清单（模板优先，AI 只润色）

没有密钥时走 MockAI（确定性脚本），整条链路照样能跑。
配置：%LOCALAPPDATA%/ai-scene-bridge/config.json {"api_key": "...", "model": "claude-opus-5-5", "mock": false}
或环境变量 ANTHROPIC_API_KEY。
"""
from __future__ import annotations

import copy
import json
import os
from typing import Any

DEFAULT_MODEL = "claude-opus-5-5"

ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"]
PLACEMENTS = ["top", "ridge_end", "cliff_edge", "plaza"]
SPAWNS = ["valley_bottom", "side_slope", "summit", "S", "E", "W"]
LANDMARK_KINDS = ["temple", "pagoda", "tree", "wheel", "gate"]
REGION_KINDS = ["other", "gathering", "plaza", "forest", "farmland", "terrace"]
ROLES = ["roof", "wall", "stone", "foliage", "mist"]
TIMES = ["dawn", "morning", "noon", "afternoon", "dusk", "night", "overcast"]
REGION_LABELS = {"other": "民居", "gathering": "聚集地", "plaza": "广场", "forest": "林子", "farmland": "农田", "terrace": "梯田", "dense": "这里更密", "sparse": "这里更稀"}

# ------------------------------------------------------------ JSON Schema（严格，additionalProperties=false）
PALETTE_ITEM = {"type": "object", "properties": {"role": {"type": "string", "enum": ROLES}, "hex": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}, "note": {"type": "string"}}, "required": ["role", "hex", "note"], "additionalProperties": False}
CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "≤ 8 字的空间类型名，如 环湾叠落型"},
        "one_liner": {"type": "string", "description": "一句话说这个方案长什么样、玩家第一眼看到什么"},
        "archetype": {"type": "string", "enum": ARCHETYPES},
        "params": {"type": "object", "properties": {
            "entry_side": {"type": "string", "enum": ["S", "E", "W"]},
            "terraces": {"type": "integer", "minimum": 3, "maximum": 7},
            "layer_height_m": {"type": "number", "minimum": 2.5, "maximum": 6},
            "plateau_width": {"type": "string", "enum": ["narrow", "medium", "wide"]},
            "stream": {"type": "boolean"},
        }, "required": ["entry_side", "terraces", "layer_height_m", "plateau_width", "stream"], "additionalProperties": False},
        "landmark": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": LANDMARK_KINDS},
            "label": {"type": "string"},
            "placement": {"type": "string", "enum": PLACEMENTS},
            "size_m": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
        }, "required": ["kind", "label", "placement", "size_m"], "additionalProperties": False},
        "spawn": {"type": "object", "properties": {"placement": {"type": "string", "enum": SPAWNS}}, "required": ["placement"], "additionalProperties": False},
        "regions": {"type": "array", "items": {"type": "object", "properties": {
            "terrace": {"type": "integer", "minimum": 0, "maximum": 6},
            "kind": {"type": "string", "enum": REGION_KINDS},
            "density": {"type": "number", "minimum": 0, "maximum": 1.6},
            "label": {"type": "string"},
        }, "required": ["terrace", "kind", "density", "label"], "additionalProperties": False}},
        "palette": {"type": "array", "items": PALETTE_ITEM, "minItems": 5, "maxItems": 5},
        "lighting": {"type": "object", "properties": {"time_of_day": {"type": "string", "enum": TIMES}}, "required": ["time_of_day"], "additionalProperties": False},
        "mood": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
        "summary": {"type": "string"},
    },
    "required": ["name", "one_liner", "archetype", "params", "landmark", "spawn", "regions", "palette", "lighting", "mood", "summary"],
    "additionalProperties": False,
}
DRAFT_SCHEMA = {"type": "object", "properties": {"cards": {"type": "array", "items": CARD_SCHEMA, "minItems": 3, "maxItems": 3}}, "required": ["cards"], "additionalProperties": False}

PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "params": {"type": "object", "properties": {
            "entry_side": {"type": "string", "enum": ["S", "E", "W"]},
            "terraces": {"type": "integer", "minimum": 3, "maximum": 7},
            "layer_height_m": {"type": "number", "minimum": 2.5, "maximum": 6},
            "plateau_width": {"type": "string", "enum": ["narrow", "medium", "wide"]},
            "stream": {"type": "boolean"},
        }, "additionalProperties": False},
        "landmark": {"type": "object", "properties": {"kind": {"type": "string", "enum": LANDMARK_KINDS}, "label": {"type": "string"}, "placement": {"type": "string", "enum": PLACEMENTS}}, "additionalProperties": False},
        "spawn": {"type": "object", "properties": {"placement": {"type": "string", "enum": SPAWNS}}, "additionalProperties": False},
        "regions": {"type": "array", "items": {"type": "object", "properties": {"terrace": {"type": "integer"}, "kind": {"type": "string", "enum": REGION_KINDS}, "density": {"type": "number", "minimum": 0, "maximum": 1.6}, "label": {"type": "string"}}, "required": ["terrace"], "additionalProperties": False}},
        "density_scale": {"type": "number", "minimum": 0.4, "maximum": 1.8},
        "palette": {"type": "array", "items": PALETTE_ITEM},
        "palette_shift": {"type": "string", "enum": ["cool", "warm", "desaturate", "neutral"]},
        "lighting": {"type": "object", "properties": {"time_of_day": {"type": "string", "enum": TIMES}}, "additionalProperties": False},
        "mood": {"type": "array", "items": {"type": "string"}},
    },
    "additionalProperties": False,
}
REVISE_SCHEMA = {
    "type": "object",
    "properties": {
        "understood": {"type": "boolean", "description": "是否把人的动作翻成了可执行的 patch"},
        "patch": PATCH_SCHEMA,
        "restatement": {"type": "string", "description": "一句话复述改了什么（引用卡里的真实字段值，不编数字）"},
        "question": {"type": "object", "properties": {"text": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4}}, "required": ["text", "options"], "additionalProperties": False},
        "ask_to_point": {"type": "boolean", "description": "翻不了时为 true：请人在图上指"},
    },
    "required": ["understood", "patch", "restatement", "ask_to_point"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """你是「场景对话」里的山地村落结构设计师。人用一句话或一个动作表达意图，你只做结构级决定，几何由程序算。

铁律：
1. 你永远不输出坐标、尺寸（地标 size_m 除外）、高度、角度。你只选：地形原型与参数、地标放在哪类位置、出生点放在哪类位置、每层台地的用途与密度、调色板（hex）、时段、文案。
2. 三张卡必须结构上明显不同：至少在「地标位置 / 台地层数 / 入口方位 / 原型」中的两项上不同；如果调用方给了每张卡的目标值（targets），严格按目标值填，其它字段自由发挥。
3. 山城的设计因果：先定地标在哪个顶，再定玩家从哪仰望它；主路之字形上山；上密下疏；溪在谷底；地标 placement=top 时层数 ≥ 4 才有仰望感。
4. 文案用简体中文，具体、短；name ≤ 8 字；one_liner 说清"玩家第一眼看到什么"。
5. 调色板给 5 个角色 roof/wall/stone/foliage/mist，hex 要和题材、时段匹配，不要都给灰色。
6. 遇到 locked（人已确认锁住的字段）绝不改动。
7. 人「圈区域」的动作带 handled_by_program=true 时（林子 / 广场 / 梯田 / 农田），程序已按多边形处理，你只复述，patch 不要改 regions；只有密度类（更密 / 更稀）才返回 regions 的 density patch（按 facts.levels_touched 的层号）。
8. 人「画一笔」（stroke_path）与「拖图钉」（pin）的动作只复述程序给出的事实（折点、吸附、穿过哪几层、跨溪、可见性），patch 留空。

原型词表：
- slope_zigzag：单面坡，台地从入口一侧往上一层层叠，之字形石阶上山。最经典的"山城"。
- ring_terrace：半山一块平台当广场，房子一圈圈往外、往上长，主路绕着平台上去。
- valley_two_banks：一条溪从山上下来，两岸各一片坡，一座桥把两边接起来。
placement：top 顶层台地中央 / ridge_end 顶层台地的尽头 / cliff_edge 顶层朝入口的崖边（最醒目） / plaza 中层广场。
spawn：valley_bottom 入口侧山脚 / side_slope 侧坡半山 / summit 山顶俯视全村 / S E W 指定边。
region kind：other 民居 / gathering 聚集 / plaza 广场（不放房） / forest 林子（只有树） / farmland 农田 / terrace 梯田。"""


# ------------------------------------------------------------ 配置
def config_path() -> str:
    d = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ai-scene-bridge")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "config.json")


def load_config() -> dict:
    cfg = {"api_key": "", "model": DEFAULT_MODEL, "mock": False}
    try:
        with open(config_path(), encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    if not cfg.get("api_key") and os.environ.get("ANTHROPIC_API_KEY"):
        cfg["api_key"] = os.environ["ANTHROPIC_API_KEY"]
        cfg["key_source"] = "env"
    return cfg


def save_config(patch: dict) -> dict:
    cfg = load_config()
    cfg.pop("key_source", None)
    for k in ("api_key", "model", "mock"):
        if k in patch and patch[k] is not None:
            cfg[k] = patch[k]
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return load_config()


def public_config() -> dict:
    cfg = load_config()
    key = cfg.get("api_key") or ""
    return {"has_key": bool(key), "key_hint": (key[:7] + "…" + key[-4:]) if len(key) > 12 else ("已设置" if key else ""), "model": cfg.get("model") or DEFAULT_MODEL, "mock": bool(cfg.get("mock")) or not key, "key_source": cfg.get("key_source", "config" if key else "")}


# ------------------------------------------------------------ 模拟 AI（无密钥时用；确定性）
MOCK_PALETTES = {
    "dusk": [["roof", "#4A4A4A", "青瓦"], ["wall", "#D9C9A3", "夯土墙"], ["stone", "#9A9890", "石阶"], ["foliage", "#4F6B3A", "树"], ["mist", "#E8A86A", "黄昏天光"]],
    "morning": [["roof", "#5A5F63", "灰瓦"], ["wall", "#E8E0CF", "白灰墙"], ["stone", "#A8A49C", "浅石"], ["foliage", "#6E8B4E", "黄绿"], ["mist", "#E6ECEF", "晨雾"]],
    "night": [["roof", "#3B2A22", "深褐瓦"], ["wall", "#C98A3D", "暖木墙"], ["stone", "#6E6A66", "青石"], ["foliage", "#2F4A33", "深绿"], ["mist", "#F2B85C", "灯光雾"]],
}
MOCK_BASE = [
    {"name": "之字叠落型", "archetype": "slope_zigzag", "one_liner": "从南边山脚仰望，一条之字石阶把四层木屋串到顶上的寺庙。", "landmark": {"kind": "temple", "label": "山顶寺", "placement": "top", "size_m": [8, 9, 8]}, "spawn": {"placement": "valley_bottom"}, "terraces": 4},
    {"name": "环台广场型", "archetype": "ring_terrace", "one_liner": "半山一块石板广场，房子一圈圈往上长，玩家从谷口上来先看见广场边的鼓楼。", "landmark": {"kind": "pagoda", "label": "鼓楼", "placement": "plaza", "size_m": [7, 11, 7]}, "spawn": {"placement": "valley_bottom"}, "terraces": 5},
    {"name": "溪谷双坡型", "archetype": "valley_two_banks", "one_liner": "溪从山上下来，两岸各三层房子，一座桥把两边接起来，水车在东坡尽头。", "landmark": {"kind": "wheel", "label": "水车", "placement": "ridge_end", "size_m": [6, 8, 6]}, "spawn": {"placement": "valley_bottom"}, "terraces": 3},
]


def _mock_card(i: int, intent: str, time_of_day: str = "dusk") -> dict:
    b = copy.deepcopy(MOCK_BASE[i % 3])
    n = b.pop("terraces")
    regions = []
    for k in range(n):
        if b["archetype"] == "ring_terrace" and k == n // 2:
            regions.append({"terrace": k, "kind": "plaza", "density": 0, "label": "广场"})
        else:
            regions.append({"terrace": k, "kind": "other", "density": round(0.6 + 0.8 * k / max(1, n - 1), 2), "label": f"第 {k + 1} 层民居"})
    pal = MOCK_PALETTES.get(time_of_day, MOCK_PALETTES["dusk"])
    b.update({
        "params": {"entry_side": "S", "terraces": n, "layer_height_m": 3 if i != 0 else 4, "plateau_width": ["medium", "wide", "narrow"][i % 3], "stream": b["archetype"] == "valley_two_banks"},
        "regions": regions,
        "palette": [{"role": r, "hex": h, "note": note} for r, h, note in pal],
        "lighting": {"time_of_day": time_of_day},
        "mood": ["宁静", "叠落"],
        "summary": f"「{intent}」的第 {i + 1} 种切法：{b['one_liner']}",
    })
    return b


def _apply_targets(card: dict, target: dict | None) -> dict:
    if not target:
        return card
    c = copy.deepcopy(card)
    for k, v in target.items():
        if k == "params":
            c["params"].update(v)
        elif k == "landmark":
            c["landmark"].update(v)
        elif k == "spawn":
            c["spawn"].update(v)
        elif k == "density_scale":
            for r in c["regions"]:
                r["density"] = round(min(1.6, r["density"] * float(v)), 2)
        elif k == "palette_shift":
            c["_palette_shift"] = v
        elif k == "palette":
            c["palette"] = v
    return c


class MockAI:
    name = "mock"

    def draft(self, intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> dict:
        tod = "night" if any(w in intent for w in ("夜", "灯")) else "morning" if any(w in intent for w in ("清晨", "早")) else "dusk"
        cards = []
        for i in range(3):
            base = _mock_card(i if not axis else 0, intent, tod)
            if locked and locked.get("card"):
                base = copy.deepcopy(locked["card"])
            cards.append(_apply_targets(base, targets[i] if targets and i < len(targets) else None))
            if axis:
                cards[-1]["name"] = f"{cards[-1]['name']} · 变体 {i + 1}"
        return {"cards": cards, "provider": "mock"}

    def revise(self, card: dict, action: dict, locked: dict | None) -> dict:
        kind = action.get("type")
        patch: dict[str, Any] = {}
        text = ""
        if kind == "text":
            t = action.get("text", "")
            if "陡" in t:
                patch["params"] = {"layer_height_m": min(6, float(card["params"]["layer_height_m"]) + 1.5)}
                text = f"坡度加陡：每层约 {patch['params']['layer_height_m']} m。"
            elif "缓" in t or "平" in t:
                patch["params"] = {"layer_height_m": max(2.5, float(card["params"]["layer_height_m"]) - 1.5)}
                text = f"坡度放缓：每层约 {patch['params']['layer_height_m']} m。"
            elif "密" in t:
                patch["density_scale"] = 1.3
                text = "房子加密三成，上密下疏保持。"
            elif "稀" in t or "少" in t:
                patch["density_scale"] = 0.7
                text = "房子减三成。"
            elif "大" in t:
                patch["params"] = {"terraces": min(7, int(card["params"]["terraces"]) + 1)}
                text = f"多加一层，共 {patch['params']['terraces']} 层。"
            elif "小" in t:
                patch["params"] = {"terraces": max(3, int(card["params"]["terraces"]) - 1)}
                text = f"少一层，共 {patch['params']['terraces']} 层。"
            elif any(w in t for w in ("寺", "塔", "树", "水车", "门")):
                k = "temple" if "寺" in t else "pagoda" if "塔" in t else "tree" if "树" in t else "wheel" if "水车" in t else "gate"
                label = {"temple": "寺庙", "pagoda": "塔楼", "tree": "大树", "wheel": "水车", "gate": "寨门"}[k]
                patch["landmark"] = {"kind": k, "label": label}
                if "夕阳" in t or "黄昏" in t:
                    patch["lighting"] = {"time_of_day": "dusk"}
                elif "夜" in t:
                    patch["lighting"] = {"time_of_day": "night"}
                elif "清晨" in t or "早" in t:
                    patch["lighting"] = {"time_of_day": "morning"}
                text = f"地标换成{label}" + ("，时段也跟着改了。" if "lighting" in patch else "。")
            elif "东" in t and "入口" in t:
                patch["spawn"] = {"placement": "E"}; text = "入口改到东侧。"
            elif "西" in t and "入口" in t:
                patch["spawn"] = {"placement": "W"}; text = "入口改到西侧。"
            elif "南" in t and "入口" in t:
                patch["spawn"] = {"placement": "S"}; text = "入口改到南侧。"
            elif "暖" in t:
                patch["palette_shift"] = "warm"; text = "色调偏暖。"
            elif "冷" in t:
                patch["palette_shift"] = "cool"; text = "色调偏冷。"
            else:
                return {"understood": False, "patch": {}, "restatement": "这句我没把握翻成空间：是位置、大小，还是长相的事？", "ask_to_point": True, "question": {"text": "在图上指给我最准，或者选一个：", "options": ["在图上画一笔", "圈一块地", "换个方向重来"]}, "provider": "mock"}
        elif kind == "choice":
            field, value = action.get("field"), action.get("value")
            if field == "landmark.placement":
                patch["landmark"] = {"placement": value}; text = f"地标放到{value}。"
            elif field == "spawn.placement":
                patch["spawn"] = {"placement": value}; text = f"入口定在{value}。"
            elif field == "params.terraces":
                patch["params"] = {"terraces": int(value)}; text = f"{value} 层台地。"
            elif field == "params.layer_height_m":
                patch["params"] = {"layer_height_m": float(value)}; text = f"每层约 {value} m。"
            elif field == "landmark.kind":
                patch["landmark"] = {"kind": value}; text = f"地标种类改为 {value}。"
            elif field == "lighting.time_of_day":
                patch["lighting"] = {"time_of_day": value}; text = f"时段改为 {value}。"
            else:
                patch = action.get("patch", {}) or {}; text = "按你选的改了。"
        elif kind == "region":
            f = action.get("facts", {})
            label = action.get("tag_label") or REGION_LABELS.get(action.get("kind"), action.get("kind", "other"))
            levels = ", ".join(str(l + 1) for l in f.get("levels_touched", []))
            if action.get("handled_by_program"):
                text = f"你圈的这块（约 {f.get('area_m2', '?')} m²，第 {levels} 层）记为「{label}」，房子挪开，形状按你圈的来。"
            else:
                patch["regions"] = [{"terrace": int(l), "kind": "other", "density": float(action.get("density", 1.0))} for l in f.get("levels_touched", [])]
                text = f"你圈的这块跨第 {levels} 层，{label}：这几层的密度改成 {action.get('density', 1.0)}，上密下疏的关系保持。"
        elif kind == "stroke_path":
            f = action.get("facts", {})
            text = f"读到你的笔画：{f.get('n_points')} 个折点，起点{'吸附到入口' if f.get('start_snapped_to') == 'spawn' else '在图中'}，终点{'吸附到地标' if f.get('end_snapped_to') == 'landmark' else '没到地标'}，穿过第 {', '.join(str(l + 1) for l in f.get('levels_crossed', []))} 层。主路按它走，台阶我按坡度算。"
        elif kind == "pin":
            text = "地标挪到了你指的位置，主路重新接过去，关系重新算。"
        else:
            text = "好。"
        return {"understood": True, "patch": patch, "restatement": text, "ask_to_point": False, "provider": "mock"}


# ------------------------------------------------------------ 真 AI
class ClaudeAI:
    name = "claude"

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL):
        import anthropic  # 延迟导入：没装 / 没密钥时不影响服务启动
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, timeout=90.0, max_retries=2)
        self.model = model or DEFAULT_MODEL

    def _structured(self, user_text: str, schema: dict, effort: str = "medium") -> dict:
        """结构化输出；Opus 5.5 默认带服务端 refusal fallback，被拒绝或不支持时退回普通调用。"""
        a = self.anthropic
        kwargs = dict(
            model=self.model,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_text}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        try:
            resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
        except a.BadRequestError as e:
            if "fallback" in str(e).lower() or "beta" in str(e).lower():
                resp = self.client.messages.create(**kwargs)
            else:
                raise
        if resp.stop_reason == "refusal":
            raise RuntimeError("模型拒绝了这个请求：" + (getattr(getattr(resp, "stop_details", None), "explanation", "") or ""))
        text = next((b.text for b in resp.content if b.type == "text"), "")
        data = json.loads(text)
        data["_usage"] = {"input": getattr(resp.usage, "input_tokens", None), "output": getattr(resp.usage, "output_tokens", None), "cache_read": getattr(resp.usage, "cache_read_input_tokens", None), "model": resp.model}
        return data

    def draft(self, intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> dict:
        parts = [f"用户的一句话：「{intent}」", "请给出 3 张结构不同的方案卡。"]
        if axis:
            parts.append(f"这批只在「{axis}」这一条轴上不同，其它结构尽量与下面的当前卡一致。")
        if targets:
            parts.append("每张卡的目标值（必须严格采用）：\n" + "\n".join(f"卡 {i + 1}: {json.dumps(t, ensure_ascii=False)}" for i, t in enumerate(targets)))
        if locked and locked.get("card"):
            parts.append("当前卡（变体的基准）：\n" + json.dumps(locked["card"], ensure_ascii=False))
        if locked and locked.get("fields"):
            parts.append("已锁定、不可改的字段：" + json.dumps(locked["fields"], ensure_ascii=False))
        data = self._structured("\n\n".join(parts), DRAFT_SCHEMA, effort="low")
        data["provider"] = "claude"
        return data

    def revise(self, card: dict, action: dict, locked: dict | None) -> dict:
        parts = [
            "当前卡：\n" + json.dumps(card, ensure_ascii=False),
            "人的动作（已由程序转成结构化事实，不是像素）：\n" + json.dumps(action, ensure_ascii=False),
            "请只输出对当前卡的结构 patch（能不改的字段不要出现在 patch 里），一句复述，必要时一个带 2–4 个选项的追问。"
            "如果这个动作无法翻成结构级改动（例如模糊的形容词），understood=false、ask_to_point=true，并在 restatement 里问清是位置、大小还是长相的事。",
        ]
        if locked and locked.get("fields"):
            parts.append("已锁定、不可改的字段：" + json.dumps(locked["fields"], ensure_ascii=False))
        data = self._structured("\n\n".join(parts), REVISE_SCHEMA, effort="medium")
        data["provider"] = "claude"
        return data


def get_ai(cfg: dict | None = None):
    cfg = cfg or load_config()
    if cfg.get("mock") or not cfg.get("api_key"):
        return MockAI()
    try:
        return ClaudeAI(cfg["api_key"], cfg.get("model") or DEFAULT_MODEL)
    except Exception:
        return MockAI()
