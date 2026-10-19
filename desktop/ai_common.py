# -*- coding: utf-8 -*-
"""
ai_common.py — 各服务商共用的部分：词表、JSON Schema（卡 / patch / revise）、示例卡、系统提示、用户文本拼装、AIError。

LLM 永远不写坐标：schema 里只有枚举、小整数、颜色与文案；多层空间（levels）也只写「锚在哪类位置 / 几层深 / 多大 / 怎么连」，
多边形、高度、连接点全部由引擎（medium/engine/strata.js）按 docs/04 §4.3 算。
"""
from __future__ import annotations

import json
from typing import Any

ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"]
PLACEMENTS = ["top", "ridge_end", "cliff_edge", "plaza", "entry"]
SPAWNS = ["valley_bottom", "side_slope", "summit", "S", "E", "W"]
LANDMARK_KINDS = ["temple", "pagoda", "tree", "wheel", "gate"]
REGION_KINDS = ["other", "gathering", "plaza", "forest", "farmland", "terrace"]
ROLES = ["roof", "wall", "stone", "foliage", "mist"]
TIMES = ["dawn", "morning", "noon", "afternoon", "dusk", "night", "overcast"]
REGION_LABELS = {"other": "民居", "gathering": "聚落", "plaza": "广场", "forest": "林子", "farmland": "农田", "terrace": "梯田", "dense": "这里更密", "sparse": "这里更稀"}

# 多层空间（docs/04 §4.1–4.2）
STRATA = ["underground", "sky"]
LEVEL_KINDS_UNDER = ["cave", "tunnel", "cellar", "crypt"]
LEVEL_KINDS_SKY = ["platform", "walkway", "island", "bridge"]
LEVEL_KINDS = LEVEL_KINDS_UNDER + LEVEL_KINDS_SKY
LEVEL_ANCHORS = ["landmark", "village", "top", "plaza", "ridge_end", "cliff_edge", "entry"]
LEVEL_SIZES = ["small", "medium", "large"]
CONNECTS = ["stairs", "ladder", "well", "shaft", "elevator", "rope_bridge", "ramp"]
MAX_LEVELS = 3

# ------------------------------------------------------------ JSON Schema（严格，additionalProperties=false）
PALETTE_ITEM = {"type": "object", "properties": {"role": {"type": "string", "enum": ROLES}, "hex": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}, "note": {"type": "string"}}, "required": ["role", "hex", "note"], "additionalProperties": False}
LEVEL_ITEM = {
    "type": "object",
    "description": "一个地下或空中的空间；不写坐标，引擎按锚点 / 层数 / 大小生成",
    "properties": {
        "stratum": {"type": "string", "enum": STRATA, "description": "underground 地下 / sky 空中"},
        "kind": {"type": "string", "enum": LEVEL_KINDS, "description": "地下 cave 溶洞 / tunnel 地道 / cellar 地窖 / crypt 地宫；空中 platform 平台 / walkway 栈道 / island 浮岛 / bridge 天桥"},
        "anchor": {"type": "string", "enum": LEVEL_ANCHORS, "description": "挂在哪类位置下面 / 上面：landmark 地标 / village 村子中部 / top 顶层 / plaza 广场 / ridge_end 顶层尽头 / cliff_edge 崖边 / entry 入口"},
        "depth_layers": {"type": "integer", "minimum": 1, "maximum": 3, "description": "地下才给：在地面下几层（层高同台地）"},
        "height_layers": {"type": "integer", "minimum": 1, "maximum": 4, "description": "空中才给：在锚点地面上几层"},
        "size": {"type": "string", "enum": LEVEL_SIZES},
        "connect": {"type": "string", "enum": CONNECTS, "description": "从地面怎么到：stairs 石阶 / ladder 梯子 / well 井 / shaft 竖井 / elevator 升降台 / rope_bridge 索桥 / ramp 坡道"},
        "label": {"type": "string", "description": "≤ 6 字，如 寺下溶洞"},
    },
    "required": ["stratum", "kind", "anchor", "size", "connect", "label"],
    "additionalProperties": False,
}
LEVELS_SCHEMA = {"type": "array", "items": LEVEL_ITEM, "maxItems": MAX_LEVELS}
PARAMS_PROPS = {
    "entry_side": {"type": "string", "enum": ["S", "E", "W"]},
    "terraces": {"type": "integer", "minimum": 3, "maximum": 7},
    "layer_height_m": {"type": "number", "minimum": 2.5, "maximum": 6},
    "plateau_width": {"type": "string", "enum": ["narrow", "medium", "wide"]},
    "stream": {"type": "boolean"},
}
CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "≤ 8 字的空间类型名，如 环湾叠落型"},
        "one_liner": {"type": "string", "description": "一句话说这个方案长什么样、玩家第一眼看到什么"},
        "archetype": {"type": "string", "enum": ARCHETYPES},
        "params": {"type": "object", "properties": PARAMS_PROPS, "required": list(PARAMS_PROPS), "additionalProperties": False},
        "landmark": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": LANDMARK_KINDS},
            "label": {"type": "string"},
            "placement": {"type": "string", "enum": PLACEMENTS},
            "size_m": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3, "description": "[宽, 高, 深] 米"},
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
        "levels": LEVELS_SCHEMA,
    },
    "required": ["name", "one_liner", "archetype", "params", "landmark", "spawn", "regions", "palette", "lighting", "mood", "summary"],
    "additionalProperties": False,
}
DRAFT_SCHEMA = {"type": "object", "properties": {"cards": {"type": "array", "items": CARD_SCHEMA, "minItems": 3, "maxItems": 3}}, "required": ["cards"], "additionalProperties": False}

PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "params": {"type": "object", "properties": PARAMS_PROPS, "additionalProperties": False},
        "landmark": {"type": "object", "properties": {"kind": {"type": "string", "enum": LANDMARK_KINDS}, "label": {"type": "string"}, "placement": {"type": "string", "enum": PLACEMENTS}}, "additionalProperties": False},
        "spawn": {"type": "object", "properties": {"placement": {"type": "string", "enum": SPAWNS}}, "additionalProperties": False},
        "regions": {"type": "array", "items": {"type": "object", "properties": {"terrace": {"type": "integer"}, "kind": {"type": "string", "enum": REGION_KINDS}, "density": {"type": "number", "minimum": 0, "maximum": 1.6}, "label": {"type": "string"}}, "required": ["terrace"], "additionalProperties": False}},
        "density_scale": {"type": "number", "minimum": 0.4, "maximum": 1.8},
        "palette": {"type": "array", "items": PALETTE_ITEM},
        "palette_shift": {"type": "string", "enum": ["cool", "warm", "desaturate", "neutral"]},
        "lighting": {"type": "object", "properties": {"time_of_day": {"type": "string", "enum": TIMES}}, "additionalProperties": False},
        "mood": {"type": "array", "items": {"type": "string"}},
        "levels": dict(LEVELS_SCHEMA, description="改后的完整空间列表（整体替换）：加一个就把原有的连同新的一起给，去掉就只给剩下的，全去掉给 []；不动空间就不要出现"),
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
# levels 的两条示例（只在人提到地下 / 空中时才给）
EXAMPLE_LEVELS = [
    {"stratum": "underground", "kind": "cave", "anchor": "landmark", "depth_layers": 2, "size": "medium", "connect": "stairs", "label": "寺下溶洞"},
    {"stratum": "sky", "kind": "walkway", "anchor": "cliff_edge", "height_layers": 3, "size": "small", "connect": "ladder", "label": "崖顶栈道"},
]
LEVEL_WORDS = ("地下", "地宫", "溶洞", "地道", "地窖", "空中", "栈道", "浮岛", "天桥", "多层", "天上")

SYSTEM_PROMPT = """你是「场景对话」里的山地村落结构设计师。人用一句话或一个动作表达意图，你只做结构级决定，几何由程序算。

铁律：
1. 你永远不输出坐标、尺寸（地标 size_m 除外）、高度、角度。你只选：地形原型与参数、地标放在哪类位置、出生点放在哪类位置、每层台地的用途与密度、地下 / 空中空间挂在哪类位置、调色板（hex）、时段、文案。
2. 人明说的东西三张卡都必须照办，一张都不许改：地标种类与位置（"崖边"就是 cliff_edge、"村口 / 寨口"就是 entry、"围着广场"就是 ring_terrace + plaza、"两岸 / 桥"就是 valley_two_banks）、层数与规模、陡缓、入口方位、有没有溪、时段、地下 / 空中空间。
   三张卡的差异只放在人没说死的字段上：「原型 / 地标位置 / 台地层数 / 入口方位」里人没定的项尽量拉开，争取至少两项不同；人都定死了，就在层数 ±1、层高、平台宽窄、出生点、密度分布、调色上拉开。如果调用方给了每张卡的目标值（targets），严格按目标值填。
3. 山城的设计因果：先定地标在哪个顶，再定玩家从哪仰望它；主路之字形上山；上密下疏；溪在谷底；地标 placement=top 时层数 ≥ 4 才有仰望感。
4. 文案用简体中文，具体、短；name ≤ 8 字；one_liner 说清"玩家第一眼看到什么"。one_liner / summary 里提到的层数、地标、入口方位必须和字段一致（terraces=6 就别写"五层"，地标是寺就别写"寨门"；spawn=summit 就别写"入口在谷底"：valley_bottom 写山脚、side_slope 写半山、summit 写山顶，方向跟 entry_side）。句子以「。」收尾，后面不要再有字。
   词义对照：小村 / 很小 → terraces 3–4，大寨 / 大山城 → 5–7；很陡 → layer_height_m ≥ 4.5，缓 → ≤ 3；鼓楼 → pagoda，庙 → temple；清晨 → morning，傍晚 → dusk。
5. 调色板给 5 个角色 roof/wall/stone/foliage/mist，hex 要和题材、时段匹配，不要都给灰色。
6. 遇到 locked（人已确认锁住的字段）绝不改动。
7. 人「圈区域」的动作带 handled_by_program=true 时（林子 / 广场 / 梯田 / 农田），程序已按多边形处理，你只复述，patch 不要改 regions；只有密度类（更密 / 更稀）才返回 regions 的 density patch（按 facts.levels_touched 的层号）。
8. 人「画一笔」（stroke_path）与「拖图钉」（pin）的动作只复述程序给出的事实（折点、吸附、穿过哪几层、跨溪、可见性），patch 留空。
9. 多层空间 levels：只有人提到地下 / 地宫 / 溶洞 / 地道 / 地窖 / 井下 / 空中 / 栈道 / 浮岛 / 天桥 / 多层时才给，最多 3 项；没提就省略 levels。地下项给 depth_layers（1–3），空中项给 height_layers（1–4）。人提到的每一种空间三张卡都要有，人没提的种类不要自己加；三张之间在锚点、大小、层数、连接方式上不同。人说「从井下去」connect 就用 well。

原型词表：
- slope_zigzag：单面坡，台地从入口一侧往上一层层叠，之字形石阶上山。最经典的"山城"。
- ring_terrace：半山一块平台当广场，房子一圈圈往外、往上长，主路绕着平台上去。
- valley_two_banks：一条溪从山上下来，两岸各一片坡，一座桥把两边接起来。
placement：top 顶层台地中央 / ridge_end 顶层台地的尽头 / cliff_edge 顶层朝入口的崖边（最醒目） / plaza 中层广场 / entry 村口（最低一层靠入口，进村第一眼）。
spawn：valley_bottom 入口侧山脚 / side_slope 侧坡半山 / summit 山顶俯视全村 / S E W 指定边。
region kind：other 民居 / gathering 聚落（更密的民居） / plaza 广场（不放房） / forest 林子（只有树） / farmland 农田 / terrace 梯田。
levels：stratum underground 地下 / sky 空中；kind 地下 cave 溶洞 / tunnel 地道 / cellar 地窖 / crypt 地宫，空中 platform 平台 / walkway 栈道 / island 浮岛 / bridge 天桥；anchor landmark / village / top / plaza / ridge_end / cliff_edge / entry；size small / medium / large；connect stairs / ladder / well / shaft / elevator / rope_bridge / ramp。

取值范围（程序会校验，越界会被夹回）：terraces 3–7 的整数；layer_height_m 2.5–6；regions[].terrace 0–6 且 < terraces；density 0–1.6；palette 恰好 5 项、hex 形如 #RRGGBB；mood ≤ 4 条；levels ≤ 3 项。

一张完整的示例卡（口吻与完整度照它来；三张卡不要都抄它的结构）：
""" + json.dumps(EXAMPLE_CARD, ensure_ascii=False) + """
人提到地下 / 空中时 levels 的写法示例：
""" + json.dumps(EXAMPLE_LEVELS, ensure_ascii=False) + """

再说一遍最要紧的三条：人明说的三张都照办；人没说死的部分，三张在「原型 / 地标位置 / 台地层数 / 入口方位」里争取至少两项不同，不许只换名字和颜色；
你不写任何坐标、高度、角度，只写上面这些枚举、整数和颜色。"""


# ------------------------------------------------------------ 用户文本（各服务商共用）
def draft_user_text(intent: str, axis: str | None, targets: list[dict] | None, locked: dict | None) -> str:
    parts = [
        f"用户的一句话：「{intent}」",
        "请给出 3 张方案卡：这句话里明说的东西三张都照办；没说死的部分拉开（原型 / 地标位置 / 台地层数 / 入口方位里争取至少两项不同）。",
        "可选的词：原型 archetype ∈ slope_zigzag（单面坡之字叠落）/ ring_terrace（半山广场环台）/ valley_two_banks（溪谷双坡一桥）；"
        "地标 kind ∈ temple 寺 / pagoda 塔 / tree 大树 / wheel 水车 / gate 寨门；"
        "地标 placement ∈ top 顶层中央 / ridge_end 顶层尽头 / cliff_edge 顶层朝入口的崖边 / plaza 中层广场 / entry 村口；"
        "出生点 spawn.placement ∈ valley_bottom 入口侧山脚 / side_slope 侧坡半山 / summit 山顶 / S E W 指定边；"
        "region kind ∈ other 民居 / gathering 聚落（更密的民居） / plaza 广场 / forest 林子 / farmland 农田 / terrace 梯田；"
        "time_of_day ∈ dawn / morning / noon / afternoon / dusk / night / overcast。",
        "把这句话里的时段、有没有溪、地标是什么、在哪、规模（小村 3–4 层 / 大寨 5–7 层）、陡缓（陡 ≥ 4.5 / 缓 ≤ 3）、入口方位都落到三张卡的字段上；没说的你定。",
    ]
    if any(w in intent for w in LEVEL_WORDS) or "井" in intent:
        parts.append("这句话提到了地下或空中的空间：三张卡都要给 levels（不写坐标，只写 stratum / kind / anchor / 层数 / size / connect / label）。")
    else:
        parts.append("这句话没提地下或空中：不要给 levels。")
    if axis:
        parts.append(f"这批只在「{axis}」这一条轴上不同，其它结构尽量与下面的当前卡一致。")
    if targets:
        parts.append("每张卡的目标值（必须严格采用）：\n" + "\n".join(f"卡 {i + 1}: {json.dumps(t, ensure_ascii=False)}" for i, t in enumerate(targets)))
    if locked and locked.get("card"):
        parts.append("当前卡（变体的基准）：\n" + json.dumps(locked["card"], ensure_ascii=False))
    if locked and locked.get("fields"):
        parts.append("已锁定、不可改的字段：" + json.dumps(locked["fields"], ensure_ascii=False))
    return "\n\n".join(parts)


def revise_user_text(card: dict, action: dict, locked: dict | None) -> str:
    parts = [
        "当前卡：\n" + json.dumps(card, ensure_ascii=False),
        "人的动作（已由程序转成结构化事实，不是像素）：\n" + json.dumps(action, ensure_ascii=False),
        "请只输出对当前卡的结构 patch，一句复述，必要时一个带 2–4 个选项的追问。"
        "patch 只放真的要改的字段：能不改的字段不要出现在 patch 里（不要把整张卡抄回来，不要重复当前值）；"
        "动作已由程序处理（handled_by_program=true）或只是画一笔 / 拖图钉时，patch 留空对象 {}。"
        "加 / 去掉地下或空中空间时，patch.levels 给改后的完整列表（原有的照抄，加上新的或删掉要去的）。"
        "如果这个动作无法翻成结构级改动（例如模糊的形容词），understood=false、ask_to_point=true、patch={}，并在 restatement 里问清是位置、大小还是长相的事。",
    ]
    if locked and locked.get("fields"):
        parts.append("已锁定、不可改的字段：" + json.dumps(locked["fields"], ensure_ascii=False))
    return "\n\n".join(parts)


# ------------------------------------------------------------ 字段表（给没有 json_schema 结构化输出的服务商写进系统提示）
_TYPE_ZH = {"string": "文本", "integer": "整数", "number": "数", "boolean": "true/false", "array": "数组", "object": "对象"}


def field_table(schema: dict, prefix: str = "", seen: dict | None = None) -> list[str]:
    """把 schema 压成一行一个字段的简明说明：路径 · 类型 · 枚举 / 范围 · 必填。只描述，不含坐标字段（本来就没有）。
    seen：已经展开过的子 schema（按 id）→ 路径；再遇到同一个对象只写「每项字段同 …」，省 token。跨多次调用共用同一个 dict。"""
    seen = {} if seen is None else seen
    lines: list[str] = []
    req = set(schema.get("required", []))
    for name, sub in (schema.get("properties") or {}).items():
        path = f"{prefix}{name}"
        t = sub.get("type")
        bits = [_TYPE_ZH.get(t, str(t))]
        if "enum" in sub:
            bits.append("取 " + " | ".join(str(x) for x in sub["enum"]))
        if "minimum" in sub or "maximum" in sub:
            bits.append(f"{sub.get('minimum', '')}–{sub.get('maximum', '')}")
        if "pattern" in sub:
            bits.append("形如 #RRGGBB")
        if t == "array":
            n0, n1 = sub.get("minItems"), sub.get("maxItems")
            if n0 is not None and n0 == n1:
                bits.append(f"恰好 {n0} 项")
            elif n1 is not None:
                bits.append(f"{n0}–{n1} 项" if n0 else f"≤ {n1} 项")
        bits.append("必填" if name in req else "可选")
        desc = sub.get("description")
        lines.append(f"- {path}: " + "，".join(bits) + (f"。{desc}" if desc else ""))
        if t == "object" and sub.get("properties"):
            lines += field_table(sub, path + ".", seen)
        elif t == "array" and isinstance(sub.get("items"), dict):
            it = sub["items"]
            if it.get("type") == "object" and id(it) in seen:
                lines[-1] += f"（每项字段同 {seen[id(it)]}[]）"
            elif it.get("type") == "object":
                seen[id(it)] = path
                lines += field_table(it, path + "[].", seen)
            elif it.get("type"):
                lines[-1] += f"（每项 {_TYPE_ZH.get(it['type'], it['type'])}）"
    return lines


# ------------------------------------------------------------ 错误
class AIError(RuntimeError):
    """HTTP 200 回来了但结果不能用：kind ∈ refusal / truncated / empty / bad_json / schema。detail 原样透给前端做诊断。"""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail
