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

真模型调用路径（对照 claude-api 技能文档核过，anthropic SDK 1.15.0）：
- 不传 thinking（Opus 5.5 思考常开，disabled / budget_tokens 都 400）、不传 temperature / top_p / top_k（400）；深度只用 output_config.effort。
- 结构化输出用 output_config.format；schema 先经 schema_lite.api_schema 剥掉 API 不支持的 minimum / maximum / pattern / minItems(>1) / maxItems
  （SDK 只在 messages.parse() 自动剥；create() 原样发会 400），模型回来后本地校验 + 夹取。
- 默认开服务端 refusal fallback（betas=server-side-fallback-2026-07-01 + fallbacks="default"）；beta 被 400 时退回普通 messages.create 且本进程内不再试。
- stop_reason 先看再读 content：refusal → AIError(refusal, 带 stop_details.category)；max_tokens → AIError(truncated)。
- usage 记 input / output / cache_read / cache_write / request_id / 耗时 / 是否 fallback 代答 / 按 Opus 5.5 定价估算的费用。
"""
from __future__ import annotations

import copy
import json
import os
import sys
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import schema_lite  # noqa: E402

DEFAULT_MODEL = "claude-opus-5-5"
# 美元 / 百万 token。来源：claude-api 技能 shared/model-migration.md「Migrating to Claude Opus 5.5」：$4 / $20，5 分钟缓存写 $5（1.25×），缓存读 $0.20（0.05×）。
PRICING_USD_PER_MTOK = {"claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.20}}

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

# 系统提示里的示例卡：一张完整、合 CARD_SCHEMA 的山城卡（测试会校验它）。只示范结构与文案口吻，不含任何坐标。
EXAMPLE_CARD = {
    "name": "之字叠落型",
    "one_liner": "从南边山脚抬头，一条之字石阶把五层木屋串到顶上的寺庙，夕阳打在寺的青瓦上。",
    "archetype": "slope_zigzag",
    "params": {"entry_side": "S", "terraces": 5, "layer_height_m": 3.5, "plateau_width": "medium", "stream": False},
    "landmark": {"kind": "temple", "label": "山顶寺", "placement": "top", "size_m": [8, 9, 8]},
    "spawn": {"placement": "valley_bottom"},
    "regions": [
        {"terrace": 0, "kind": "farmland", "density": 0.3, "label": "山脚菜地"},
        {"terrace": 1, "kind": "other", "density": 0.7, "label": "下村"},
        {"terrace": 2, "kind": "other", "density": 1.0, "label": "中村"},
        {"terrace": 3, "kind": "gathering", "density": 1.2, "label": "寺前聚落"},
        {"terrace": 4, "kind": "plaza", "density": 0, "label": "寺前平台"},
    ],
    "palette": [
        {"role": "roof", "hex": "#4A4A4A", "note": "青瓦"},
        {"role": "wall", "hex": "#D9C9A3", "note": "夯土墙"},
        {"role": "stone", "hex": "#9A9890", "note": "石阶"},
        {"role": "foliage", "hex": "#4F6B3A", "note": "松杉"},
        {"role": "mist", "hex": "#E8A86A", "note": "黄昏天光"},
    ],
    "lighting": {"time_of_day": "dusk"},
    "mood": ["宁静", "叠落", "仰望"],
    "summary": "单面坡之字上山，地标寺在顶层中央，入口在南边山脚，上密下疏，顶层留平台。",
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
region kind：other 民居 / gathering 聚集 / plaza 广场（不放房） / forest 林子（只有树） / farmland 农田 / terrace 梯田。

取值范围（程序会校验，越界会被夹回）：terraces 3–7 的整数；layer_height_m 2.5–6；regions[].terrace 0–6 且 < terraces；density 0–1.6；palette 恰好 5 项、hex 形如 #RRGGBB；mood ≤ 4 条。

一张完整的示例卡（口吻与完整度照它来；三张卡不要都抄它的结构）：
""" + json.dumps(EXAMPLE_CARD, ensure_ascii=False) + """

再说一遍最要紧的两条：三张卡在「原型 / 地标位置 / 台地层数 / 入口方位」里至少两项不同，不许只换名字和颜色；
你不写任何坐标、高度、角度，只写上面这些枚举、整数和颜色。"""


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
class AIError(RuntimeError):
    """HTTP 200 回来了但结果不能用：kind ∈ refusal / truncated / empty / bad_json / schema。detail 原样透给前端做诊断。"""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail


def estimate_cost_usd(usage: dict | None, model: str | None = None) -> float | None:
    """按 PRICING_USD_PER_MTOK 估费用；模型不在表里（或没有 usage）返回 None，报告里留空。"""
    if not usage:
        return None
    key = next((k for k in PRICING_USD_PER_MTOK if (model or usage.get("model") or "").startswith(k)), None)
    if not key:
        return None
    p = PRICING_USD_PER_MTOK[key]
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    return round((n("input") * p["input"] + n("output") * p["output"] + n("cache_write") * p["cache_write"] + n("cache_read") * p["cache_read"]) / 1e6, 6)


def _usage_of(resp: Any, ms: int) -> dict:
    u = getattr(resp, "usage", None)
    g = lambda k: getattr(u, k, None)  # noqa: E731
    served_by_fallback = any(getattr(it, "type", None) == "fallback_message" for it in (g("iterations") or []))
    out = {"input": g("input_tokens"), "output": g("output_tokens"), "cache_read": g("cache_read_input_tokens"), "cache_write": g("cache_creation_input_tokens"),
           "model": getattr(resp, "model", None), "stop_reason": getattr(resp, "stop_reason", None), "request_id": getattr(resp, "_request_id", None), "ms": ms, "fallback_used": served_by_fallback}
    out["cost_usd"] = estimate_cost_usd(out)
    return out


def _is_beta_rejection(e: Any) -> bool:
    """服务端 fallback 这个 beta 不开放时的 400：错误信息提到 anthropic-beta 头或 fallbacks 参数。其它 400 是我们的请求有错，要抛出去。"""
    body = getattr(e, "body", None)
    msg = str((body.get("error") or {}).get("message") if isinstance(body, dict) and isinstance(body.get("error"), dict) else "") + " " + str(e)
    low = msg.lower()
    return "anthropic-beta" in low or "fallback" in low


class ClaudeAI:
    name = "claude"
    fallback_beta_ok = True  # 服务端 fallback beta 被 400 后本进程内不再带它（省一次往返）
    MAX_TOKENS = 16000  # 含思考 token；三张卡 JSON 约 3k，留足余量

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, timeout: float = 180.0, max_retries: int = 2):
        import anthropic  # 延迟导入：没装 / 没密钥时不影响服务启动
        self.anthropic = anthropic
        # timeout 是单次请求的秒数；SDK 对 408/409/429/5xx/超时/断连自动重试 max_retries 次，最坏墙钟 = timeout × (max_retries + 1)
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)
        self.model = model or DEFAULT_MODEL

    def _request_kwargs(self, user_text: str, schema: dict, effort: str) -> dict:
        return dict(
            model=self.model,
            max_tokens=self.MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],  # 系统提示 > 512 token，Opus 5.5 可缓存
            messages=[{"role": "user", "content": user_text}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema_lite.api_schema(schema)}},
        )

    def _structured(self, user_text: str, schema: dict, effort: str = "medium") -> dict:
        """结构化输出一次调用：带服务端 refusal fallback → 退回普通调用 → 看 stop_reason → 解析 → 本地校验 / 夹取 → 附 usage。"""
        a = self.anthropic
        kwargs = self._request_kwargs(user_text, schema, effort)
        t0 = time.time()
        resp = None
        if ClaudeAI.fallback_beta_ok:
            try:
                resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            except a.BadRequestError as e:
                if not _is_beta_rejection(e):
                    raise
                ClaudeAI.fallback_beta_ok = False
        if resp is None:
            resp = self.client.messages.create(**kwargs)
        usage = _usage_of(resp, int((time.time() - t0) * 1000))
        stop = getattr(resp, "stop_reason", None)
        if stop == "refusal":  # 先看 stop_reason 再读 content；stop_details 可能为 None
            sd = getattr(resp, "stop_details", None)
            cat, expl = getattr(sd, "category", None), getattr(sd, "explanation", None)
            raise AIError("refusal", "模型拒绝了这个请求" + (f"（类别 {cat}）" if cat else "") + (f"：{expl}" if expl else ""), category=cat, explanation=expl, usage=usage)
        text = next((b.text for b in (getattr(resp, "content", None) or []) if getattr(b, "type", None) == "text"), "")
        if stop == "max_tokens":
            raise AIError("truncated", f"输出到 {usage.get('output')} token 被截断（max_tokens={self.MAX_TOKENS}），JSON 不完整；可换更低 effort 或减少要求", usage=usage, sample=text[-200:])
        if not text:
            raise AIError("empty", f"模型没有返回文本块（stop_reason={stop}）", usage=usage)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300]) from e
        fixes = schema_lite.clamp(schema, data)
        errors = schema_lite.validate(schema, data)
        if errors:
            raise AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors, usage=usage)
        data["_usage"] = usage
        if fixes:
            data["_fixes"] = fixes
        return data

    def draft(self, intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> dict:
        parts = [
            f"用户的一句话：「{intent}」",
            "请给出 3 张结构不同的方案卡（至少在 原型 / 地标位置 / 台地层数 / 入口方位 中的两项不同）。",
            "可选的词：原型 archetype ∈ slope_zigzag（单面坡之字叠落）/ ring_terrace（半山广场环台）/ valley_two_banks（溪谷双坡一桥）；"
            "地标 kind ∈ temple 寺 / pagoda 塔 / tree 大树 / wheel 水车 / gate 寨门；"
            "地标 placement ∈ top 顶层中央 / ridge_end 顶层尽头 / cliff_edge 顶层朝入口的崖边 / plaza 中层广场；"
            "出生点 spawn.placement ∈ valley_bottom 入口侧山脚 / side_slope 侧坡半山 / summit 山顶 / S E W 指定边；"
            "region kind ∈ other 民居 / gathering 聚集 / plaza 广场 / forest 林子 / farmland 农田 / terrace 梯田；"
            "time_of_day ∈ dawn / morning / noon / afternoon / dusk / night / overcast。",
            "把这句话里的时段、有没有溪、地标是什么、规模（小村 3–4 层 / 大寨 5–7 层）、陡缓（layer_height_m 大则陡）都落到字段上；没说的你定。",
        ]
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
            "请只输出对当前卡的结构 patch，一句复述，必要时一个带 2–4 个选项的追问。"
            "patch 只放真的要改的字段：能不改的字段不要出现在 patch 里（不要把整张卡抄回来，不要重复当前值）；"
            "动作已由程序处理（handled_by_program=true）或只是画一笔 / 拖图钉时，patch 留空对象 {}。"
            "如果这个动作无法翻成结构级改动（例如模糊的形容词），understood=false、ask_to_point=true、patch={}，并在 restatement 里问清是位置、大小还是长相的事。",
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
    except ImportError as e:  # 有密钥却没装 SDK：明说，不悄悄退回模拟（否则人以为在用真模型）
        raise RuntimeError("anthropic SDK 未安装：在仓库根目录执行 .venv\\Scripts\\pip install anthropic，或在 AI 设置里勾「模拟」") from e
