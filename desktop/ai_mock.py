# -*- coding: utf-8 -*-
"""
ai_mock.py — 模拟 AI（确定性脚本，不联网、不花钱）。没有密钥、勾了「模拟」、或请求带 force_mock 时用它。

识别多层空间关键词（地下 / 地宫 / 溶洞 / 地道 / 地窖 / 井 / 空中 / 栈道 / 浮岛 / 天桥 / 多层）生成 levels；
revise 能「加一个地宫」「去掉空中平台」「换成夜里」。依旧不写坐标。
"""
from __future__ import annotations

import copy
from typing import Any

from ai_common import MAX_LEVELS, REGION_LABELS
from intent_rules import entry_mentioned

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

# 关键词 → 一个空间的模板（顺序即优先级；同一句话最多取 3 个）
LEVEL_RULES = [
    ("地宫", {"stratum": "underground", "kind": "crypt", "anchor": "landmark", "depth_layers": 2, "connect": "stairs", "label": "地宫"}),
    ("溶洞", {"stratum": "underground", "kind": "cave", "anchor": "landmark", "depth_layers": 2, "connect": "stairs", "label": "地下溶洞"}),
    ("地道", {"stratum": "underground", "kind": "tunnel", "anchor": "village", "depth_layers": 1, "connect": "ladder", "label": "地道"}),
    ("地窖", {"stratum": "underground", "kind": "cellar", "anchor": "village", "depth_layers": 1, "connect": "ladder", "label": "地窖"}),
    ("栈道", {"stratum": "sky", "kind": "walkway", "anchor": "cliff_edge", "height_layers": 2, "connect": "ladder", "label": "崖顶栈道"}),
    ("浮岛", {"stratum": "sky", "kind": "island", "anchor": "top", "height_layers": 3, "connect": "rope_bridge", "label": "浮岛"}),
    ("天桥", {"stratum": "sky", "kind": "bridge", "anchor": "ridge_end", "height_layers": 2, "connect": "stairs", "label": "天桥"}),
    ("空中", {"stratum": "sky", "kind": "platform", "anchor": "top", "height_layers": 2, "connect": "ladder", "label": "空中平台"}),
    ("天上", {"stratum": "sky", "kind": "platform", "anchor": "top", "height_layers": 2, "connect": "ladder", "label": "空中平台"}),
    ("地下", {"stratum": "underground", "kind": "cave", "anchor": "landmark", "depth_layers": 2, "connect": "stairs", "label": "地下空间"}),
]
# 「去掉 X」：X 是具体种类就删这一种，是笼统的层名就删整层
KIND_WORDS = {"地宫": "crypt", "溶洞": "cave", "地道": "tunnel", "地窖": "cellar", "栈道": "walkway", "浮岛": "island", "天桥": "bridge", "平台": "platform"}
STRATUM_WORDS = {"地下": "underground", "空中": "sky", "天上": "sky"}
REMOVE_WORDS = ("去掉", "不要", "删掉", "删除", "拿掉", "取消")
TIME_WORDS = [("夜", "night"), ("晚上", "night"), ("黄昏", "dusk"), ("傍晚", "dusk"), ("夕阳", "dusk"), ("清晨", "morning"), ("早上", "morning"), ("中午", "noon"), ("下午", "afternoon"), ("阴", "overcast"), ("破晓", "dawn")]
TIME_ZH = {"night": "夜里", "dusk": "黄昏", "morning": "清晨", "noon": "中午", "afternoon": "下午", "overcast": "阴天", "dawn": "破晓"}


def levels_from_text(text: str, size: str = "medium") -> list[dict]:
    """一句话里提到的地下 / 空中空间 → levels（≤ 3）。「多层」= 一个地下溶洞 + 一个空中平台；「井」把地下项的连接改成 well。"""
    out: list[dict] = []
    seen: set = set()
    for word, tpl in LEVEL_RULES:
        if word in text and (tpl["stratum"], tpl["kind"]) not in seen and not (word == "地下" and any(o["stratum"] == "underground" for o in out)) \
                and not (word in ("空中", "天上") and any(o["stratum"] == "sky" for o in out)):
            seen.add((tpl["stratum"], tpl["kind"]))
            out.append(dict(tpl, size=size))
    if "多层" in text and not out:
        out = [dict(LEVEL_RULES[-1][1], size=size), dict(LEVEL_RULES[7][1], size=size)]
    if "井" in text:
        for o in out:
            if o["stratum"] == "underground":
                o["connect"] = "well"
    if out and any(w in text for w in ("山城", "村")) and "下面" in text:
        for o in out:
            if o["stratum"] == "underground" and o["anchor"] == "landmark" and not any(w in text for w in ("寺", "塔", "庙")):
                o["anchor"] = "village"
    return out[:MAX_LEVELS]


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
    lv = levels_from_text(intent, ["medium", "large", "small"][i % 3])
    if lv:
        b["levels"] = lv
    if entry_mentioned(intent):  # 「村口有棵大树」→ 地标放村口（三张都放）
        b["landmark"]["placement"] = "entry"
        b["landmark"]["label"] = {"temple": "村口庙", "pagoda": "村口塔", "wheel": "村口水车"}.get(b["landmark"]["kind"], b["landmark"]["label"])
        b["one_liner"] = f"一进村口就看见{b['landmark']['label']}，主路从它身边上山。"
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
        elif k in ("palette", "levels"):
            c[k] = v
    return c


def _revise_levels(card: dict, t: str) -> tuple[dict, str] | None:
    """「加一个地宫」「去掉空中平台」→ patch.levels（改后的完整列表）。不涉及空间就返回 None。"""
    cur = copy.deepcopy(card.get("levels") or [])
    if any(w in t for w in REMOVE_WORDS):
        kinds = {k for w, k in KIND_WORDS.items() if w in t}
        strata = {s for w, s in STRATUM_WORDS.items() if w in t}
        if not kinds and not strata:
            return None
        # 先按具体种类删；这一种当前没有（如「去掉空中平台」而现有的是栈道）就按层删
        keep = [o for o in cur if o["kind"] not in kinds]
        if len(keep) == len(cur):
            keep = [o for o in cur if o["stratum"] not in strata]
        gone = [o["label"] for o in cur if o not in keep]
        return {"levels": keep}, ("去掉了" + "、".join(gone) + "。" if gone else "现在没有这样的空间，没改。")
    new = levels_from_text(t)
    if not new:
        return None
    have = {(o["stratum"], o["kind"]) for o in cur}
    add = [o for o in new if (o["stratum"], o["kind"]) not in have]
    if not add:
        return {}, "已经有这个空间了，没改。"
    if len(cur) + len(add) > MAX_LEVELS:
        return {}, f"最多 {MAX_LEVELS} 个地下 / 空中空间，先去掉一个再加。"
    return {"levels": cur + add}, "加了" + "、".join(o["label"] for o in add) + "（" + "、".join(("地下 " + str(o.get("depth_layers")) + " 层") if o["stratum"] == "underground" else ("地上 " + str(o.get("height_layers")) + " 层") for o in add) + "），连接点程序会放。"


class MockAI:
    name = "mock"
    model = "mock"

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
            lv = _revise_levels(card, t)
            tod = next((v for w, v in TIME_WORDS if w in t), None)
            if lv is not None:
                patch, text = lv
            elif entry_mentioned(t):  # 「把寨门挪到村口」
                patch["landmark"] = {"placement": "entry"}
                k = next((v for w, v in (("寺", "temple"), ("塔", "pagoda"), ("树", "tree"), ("水车", "wheel"), ("门", "gate"), ("牌楼", "gate")) if w in t), None)
                if k:
                    patch["landmark"]["kind"] = k
                text = "地标挪到村口：最低一层靠入口，进村第一眼就看见。"
            elif "陡" in t:
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
                if tod:
                    patch["lighting"] = {"time_of_day": tod}
                text = f"地标换成{label}" + ("，时段也跟着改了。" if "lighting" in patch else "。")
            elif tod:
                patch["lighting"] = {"time_of_day": tod}
                pal = MOCK_PALETTES.get(tod)
                if pal:
                    patch["palette"] = [{"role": r, "hex": h, "note": note} for r, h, note in pal]
                text = f"时段换成{TIME_ZH[tod]}" + ("，调色板跟着换。" if pal else "。")
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
