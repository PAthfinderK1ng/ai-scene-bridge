# -*- coding: utf-8 -*-
"""
rules.py — 本地知识（不花钱、不靠模型自觉）：片段库、词表、本地锁定、按片段拼场景程序

1. 片段库 FRAGMENTS：10–14 个小结构（环形塔群、轴线院落、悬浮群岛 + 光桥、峡谷栈道、地下大厅、港口码头 + 防波堤、阶梯金字塔、
   窄巷层叠楼、城墙 + 门楼、湖心岛、瀑布台阶、台地村落、迷宫空间、崖顶城堡）。三处共用：提示词里给模型看（不给整张示例）、
   模拟 AI 按概念拼程序、锁定时补缺的结构。
2. 词表 + extract(句子)：时段、点了名的结构（塔 / 浮岛 / 码头 / 金字塔 / 神殿 / 城墙 / 桥 / 迷宫 / 地宫 …）、数量、规模、地形词、
   地下 / 空中空间、从哪边进。
3. enforce(plan, 条件)：说死的三张都要有，没有就按片段补一个、锚到合理位置；enforce_ops：revise 也锁。
补上的东西只用锚点与组内偏移，没有全局坐标。依赖 plans.py。
4. 空间组织标签 organization（只打主体结构的 2–4 个；v5 第 4 轮从 plans.py 挪来）与三张差异 diversity。
（概念 → 场景程序的拼装——模拟 AI 与补位——在 providers.py 下半，v5 第 1 轮验收时从本文件拆出去，免得单文件超过 1200 行；
 模拟 AI 的题材配方数据 THEMES / DEFAULT_RECIPES 在本文件末尾，和片段库放在一起。）
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any

from plans import (
    all_nodes,
    anchor_base,
    apply_ops,
    check_ops,
    clamp,
    field_schema,
    item_schema,
    new_id,
    normalize_refs,
    plan_schema,
    strip_extra,
    walk_nodes,
)  # noqa: F401

# ============================================================ 1. 片段库
# "@" = 片段挂在哪（锚点，由使用者给）；片段内部的 id 互相引用，实例化时整体改名。main = 片段的主体（别人锚它）。
FRAGMENTS: list[dict] = [
    {"key": "ring_towers", "name": "环形塔群", "org": ["radial", "vertical"], "main": "hall", "demo": "site.center",
     "nodes": [{"id": "core", "type": "group", "at": "@", "children": [
         {"id": "hall", "type": "building", "label": "主殿", "size_m": [30, 20, 24], "roof": "dome", "role": "landmark"},
         {"id": "towers", "type": "repeat", "pattern": "radial", "count": 6, "radius_m": 30, "face": "center",
          "child": {"type": "tower", "label": "塔", "size_m": [8, 30], "roof": "spire"}}]}]},
    {"key": "axial_court", "name": "轴线院落", "org": ["axial", "enclosed"], "main": "main_hall", "demo": "site.center",
     "nodes": [{"id": "axis", "type": "group", "at": "@", "children": [
         {"id": "front_gate", "type": "gate", "label": "门楼", "size_m": [14, 12, 6], "offset_m": [0, 42]},
         {"id": "court", "type": "courtyard", "label": "前院", "size_m": [44, 32], "wall_h_m": 4, "gate": "S", "offset_m": [0, 16]},
         {"id": "main_hall", "type": "building", "label": "正殿", "size_m": [32, 16, 20], "roof": "hip", "offset_m": [0, -16], "role": "landmark"},
         {"id": "wings", "type": "repeat", "pattern": "mirror", "axis": "x",
          "child": {"type": "building", "label": "配殿", "size_m": [12, 9, 26], "roof": "gable", "offset_m": [-28, 12]}}]}]},
    {"key": "sky_islands", "name": "悬浮群岛 + 光桥", "org": ["sky", "radial"], "main": "isles", "demo": "site.center",
     "nodes": [{"id": "isles", "type": "repeat", "pattern": "radial", "count": 4, "radius_m": 46, "at": "@",
                "child": {"type": "island", "label": "浮岛", "size_m": [24, 10, 24], "elev_m": 36,
                          "children": [{"type": "building", "label": "小殿", "size_m": [10, 8, 10], "roof": "dome"}]}},
               {"id": "isle_bridge", "type": "link", "style": "bridge", "label": "光桥", "from": "isles[0]", "to": "isles[1]", "width_m": 3}]},
    {"key": "canyon_walk", "name": "峡谷栈道", "org": ["canyon", "linear"], "main": "plank_way", "demo": "site.center",
     "terrain": [{"op": "carve", "id": "gorge", "label": "峡谷", "from": "site.N", "to": "site.S", "width_m": 30, "depth_m": 26, "edge": "cliff"}],
     "nodes": [{"id": "plank_way", "type": "link", "style": "path", "label": "崖壁栈道", "from": "gorge.N", "to": "gorge.S", "width_m": 2.5},
               {"id": "cliff_rooms", "type": "repeat", "pattern": "along", "along": "plank_way", "count": 5, "spacing_m": 20,
                "child": {"type": "building", "label": "崖屋", "size_m": [8, 7, 6], "roof": "flat"}},
               {"id": "gorge_bridge", "type": "link", "style": "rope_bridge", "label": "索桥", "from": "gorge.W", "to": "gorge.E", "width_m": 2}]},
    {"key": "underground_hall", "name": "地下大厅", "org": ["underground"], "main": "undercroft", "demo": "hall",
     "nodes": [{"id": "undercroft", "type": "space", "stratum": "underground", "label": "地下大厅", "under": "@", "depth_m": 14,
                "layout": "halls", "size_m": 40, "sublevels": 1, "connect": {"via": "stairs", "from": "@"}},
               {"id": "undercroft_door", "type": "arch", "label": "地下入口", "at": "@", "offset_m": [0, 18], "size_m": [6, 5, 2]}]},
    {"key": "harbor", "name": "港口码头 + 防波堤", "org": ["water", "linear"], "main": "quay", "demo": "site.S", "ground": "coast",
     "nodes": [{"id": "quay", "type": "platform", "label": "码头", "at": "@", "size_m": [60, 1.5, 12], "role": "landmark"},
               {"id": "piers", "type": "repeat", "pattern": "linear", "count": 3, "spacing_m": 18, "at": "quay",
                "child": {"type": "platform", "label": "栈桥", "size_m": [4, 1.2, 30], "offset_m": [0, 20]}},
               {"id": "breakwater", "type": "wall", "label": "防波堤", "at": "quay", "path_m": [[-60, 30], [-20, 62], [36, 62]], "wall_h_m": 3, "thickness_m": 5}]},
    {"key": "step_pyramid", "name": "阶梯金字塔", "org": ["axial", "vertical"], "main": "pyramid", "demo": "site.center",
     "nodes": [{"id": "ziggurat", "type": "group", "at": "@", "children": [
         {"id": "pyramid", "type": "repeat", "pattern": "stack", "levels": 5, "taper": 0.16, "child": {"type": "box", "label": "金字塔阶", "size_m": [56, 6, 56]}, "role": "landmark", "label": "阶梯金字塔"},
         {"id": "axis_stair", "type": "stairs", "label": "中轴大阶", "size_m": [8, 30, 34], "at": "pyramid.S"},
         {"id": "top_shrine", "type": "building", "label": "顶殿", "size_m": [12, 8, 12], "roof": "flat", "at": "pyramid.top"}]}]},
    {"key": "narrow_lane", "name": "窄巷层叠楼", "org": ["linear", "vertical"], "main": "row_w", "demo": "site.center",
     "nodes": [{"id": "lane", "type": "group", "at": "@", "children": [
         {"id": "row_w", "type": "repeat", "pattern": "linear", "axis": "z", "count": 6, "spacing_m": 10, "offset_m": [-9, 0],
          "child": {"type": "repeat", "pattern": "stack", "levels": 3, "child": {"type": "box", "label": "叠楼", "size_m": [9, 5, 8]}}},
         {"id": "row_e", "type": "repeat", "pattern": "linear", "axis": "z", "count": 6, "spacing_m": 10, "offset_m": [9, 0],
          "child": {"type": "repeat", "pattern": "stack", "levels": 4, "child": {"type": "box", "label": "叠楼", "size_m": [9, 4.5, 8]}}},
         {"id": "signs", "type": "repeat", "pattern": "linear", "axis": "z", "count": 8, "spacing_m": 7, "child": {"type": "box", "label": "招牌", "size_m": [3, 1.5, 0.4], "elev_m": 7}},
         {"id": "skybridge", "type": "link", "style": "bridge", "label": "天桥", "from": "row_w[2]", "to": "row_e[3]", "width_m": 3}]}]},
    {"key": "wall_gate", "name": "城墙 + 门楼", "org": ["enclosed"], "main": "rampart", "demo": "hall",
     "nodes": [{"id": "rampart", "type": "wall", "label": "城墙", "around": "@", "wall_h_m": 10, "thickness_m": 4, "gate": "S"},
               {"id": "gatehouse", "type": "gate", "label": "门楼", "size_m": [16, 14, 8], "at": "rampart.S"}]},
    {"key": "lake_isle", "name": "湖心岛", "org": ["water", "radial"], "main": "isle_hall", "demo": "site.center", "ground": "lake",
     "terrain": [{"op": "lake", "id": "lake", "at": "@", "shape": "circle", "size_m": [150, 150], "depth_m": 5},
                 {"op": "raise", "id": "isle", "at": "lake.center", "shape": "circle", "size_m": [42, 42], "height_m": 6, "edge": "slope"}],
     "nodes": [{"id": "isle_hall", "type": "building", "label": "湖心阁", "at": "isle.top", "size_m": [14, 12, 14], "roof": "hip", "role": "landmark"},
               {"id": "zigzag_bridge", "type": "link", "style": "bridge", "label": "曲桥", "from": "lake.S", "to": "isle", "width_m": 3}]},
    {"key": "waterfall_steps", "name": "瀑布台阶", "org": ["water", "vertical"], "main": "falls_terrace", "demo": "site.N",
     "terrain": [{"op": "raise", "id": "falls_cliff", "at": "@", "shape": "rect", "size_m": [90, 40], "height_m": 24, "edge": "cliff"},
                 {"op": "river", "id": "falls", "from": "falls_cliff.top", "to": "site.S", "width_m": 8}],
     "nodes": [{"id": "falls_terrace", "type": "platform", "label": "观瀑台", "at": "falls_cliff.top", "size_m": [20, 1, 14], "role": "landmark"},
               {"id": "falls_stair", "type": "link", "style": "stairs", "label": "瀑边石阶", "from": "site.S", "to": "falls_terrace", "width_m": 3}]},
    {"key": "terraced_village", "name": "台地村落（生成器）", "org": ["terraced", "scatter"], "main": "slope", "demo": "site.center",
     "nodes": [{"id": "slope", "type": "terraces", "label": "台地", "form": "slope", "at": "@", "size_m": [110, 90], "steps": 5, "step_h_m": 4, "orient": "N"},
               {"id": "village", "type": "scatter_houses", "label": "村落", "area": "slope", "size_m": [100, 80], "density": 0.8,
                "child": {"type": "building", "label": "木楼", "size_m": [7, 6, 6], "roof": "gable"}}]},
    {"key": "maze_space", "name": "迷宫空间", "org": ["underground"], "main": "maze", "demo": "hall",
     "nodes": [{"id": "maze", "type": "space", "stratum": "underground", "label": "地下迷宫", "under": "@", "depth_m": 12, "layout": "maze",
                "size_m": 44, "branching": "high", "sublevels": 2, "connect": {"via": "stairs", "from": "@"}},
               {"id": "maze_door", "type": "arch", "label": "迷宫入口", "at": "@", "offset_m": [0, 16], "size_m": [5, 4, 2]}]},
    {"key": "cliff_keep", "name": "崖顶城堡", "org": ["vertical"], "main": "keep", "demo": "site.N",
     "terrain": [{"op": "raise", "id": "crag", "at": "@", "shape": "circle", "size_m": [70, 60], "height_m": 32, "edge": "cliff"}],
     "nodes": [{"id": "keep", "type": "tower", "label": "主堡", "at": "crag.top", "size_m": [18, 36], "roof": "cone", "role": "landmark"},
               {"id": "crag_path", "type": "link", "style": "stairs", "label": "崖道", "from": "site.S", "to": "keep", "width_m": 3}]},
]
FRAG = {f["key"]: f for f in FRAGMENTS}


def _one(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def _subst(node: Any, mapping: dict, anchor: str) -> Any:
    """片段里的 "@" → anchor；内部 id（及其 [k] / .part 引用）→ 新 id"""
    if isinstance(node, list):
        return [_subst(x, mapping, anchor) for x in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for k, v in node.items():
        if isinstance(v, str) and k != "label":
            if v == "@":
                v = anchor
            elif k == "id" and v in mapping:
                v = mapping[v]
            else:
                b = anchor_base(v)
                if b in mapping:
                    v = mapping[b] + v[len(b):]
        out[k] = _subst(v, mapping, anchor) if isinstance(v, (dict, list)) else v
    return out


def instantiate(plan: dict, key: str, anchor: str, taken: set | None = None) -> tuple[list, list, str]:
    """片段 → (地形操作, 根节点, 主体新 id)。id 和 plan 已有的不重。"""
    f = FRAG[key]
    taken = set(taken or set())
    ids = [t["id"] for t in f.get("terrain") or []] + [n["id"] for n, *_ in walk_nodes(f.get("nodes") or []) if n.get("id")]
    mapping = {}
    for i in ids:
        mapping[i] = new_id(plan, i, taken)
        taken.add(mapping[i])
    terr = _subst(copy.deepcopy(f.get("terrain") or []), mapping, anchor)
    nodes = _subst(copy.deepcopy(f.get("nodes") or []), mapping, anchor)
    normalize_refs({"nodes": nodes})  # "@" 落到只收 ref 的字段（under / around / connect.from）时去掉部位
    return terr, nodes, mapping.get(f["main"], f["main"])


def fragment_lines(keys: list[str] | None = None) -> str:
    """提示词里的片段库：每个 3–8 行（标题 + 地形操作 + 各根节点一行）"""
    out = []
    for f in FRAGMENTS:
        if keys and f["key"] not in keys:
            continue
        terr, nodes = _subst(f.get("terrain") or [], {}, f["demo"]), _subst(f.get("nodes") or [], {}, f["demo"])
        normalize_refs({"nodes": nodes})
        lines = [f"【{f['name']}】" + (f"（site.ground 常配 {f['ground']}）" if f.get("ground") else "")]
        lines += ["terrain+= " + _one(t) for t in terr]
        for n in nodes:  # 组的子节点一行一个（还是合法 JSON），读得清层级
            kids = n.get("children")
            if isinstance(kids, list) and len(kids) > 1:
                head = _one({k: v for k, v in n.items() if k != "children"})[:-1] + ',"children":['
                lines += ["nodes+= " + head] + ["  " + _one(c) + ("," if i < len(kids) - 1 else "]}") for i, c in enumerate(kids)]
            else:
                lines.append("nodes+= " + _one(n))
        out.append("\n".join(lines))
    return "\n".join(out)


# ============================================================ 2. 词表与 extract
CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十二": 12}
CLAUSE = re.compile(r"[^，,。；;！!？?\n]+")
REMOVE_WORDS = ("去掉", "删掉", "删除", "拿掉", "不要", "取消", "拆掉", "移除")
ADD_WORDS = ("加", "添", "再来", "多一", "要有", "放一", "建一", "补一")

TIME_WORDS = [
    (("黄昏", "傍晚", "日落", "夕阳"), "dusk"),
    (("夜里", "夜晚", "晚上", "深夜", "夜景", "亮灯", "灯火", "夜市", "霓虹", "夜"), "night"),
    (("清晨", "早晨", "晨雾", "一早", "早上"), "morning"),
    (("正午", "中午"), "noon"),
    (("下午", "午后"), "afternoon"),
    (("黎明", "拂晓", "破晓"), "dawn"),
    (("阴天", "阴雨", "下雨", "雨天", "多云"), "overcast"),
]
TIME_CN = {"dusk": "黄昏", "night": "夜里", "morning": "清晨", "noon": "正午", "afternoon": "午后", "dawn": "黎明", "overcast": "阴天"}

# 点了名的结构：(词, 键, 认哪些节点 type（label 含词也算）, 用哪个片段补 / 或单个节点模板)。长词在前；同一个键只记一次。
STRUCT_LEX: list[tuple[tuple, str, tuple, Any]] = [
    (("金字塔",), "pyramid", ("pyramid",), "step_pyramid"),
    (("浮岛", "空岛", "浮空岛", "空中岛", "浮空"), "island", ("island",), "sky_islands"),
    (("码头", "港口", "港湾", "船坞", "栈桥"), "harbor", (), "harbor"),
    (("城墙", "城垣", "围墙", "防波堤"), "wall", ("wall",), "wall_gate"),
    (("城堡", "堡垒", "要塞", "主堡"), "castle", (), "cliff_keep"),
    (("法师塔", "魔法塔", "高塔", "钟楼", "灯塔", "鼓楼", "宝塔", "塔楼", "塔"), "tower", ("tower",),
     {"type": "tower", "size_m": [9, 30], "roof": "spire"}),
    (("神殿", "神庙", "寺庙", "古寺", "庙宇", "大殿", "主殿", "宫殿", "殿", "寺", "庙"), "temple", (),
     {"type": "building", "size_m": [30, 16, 22], "roof": "hip", "role": "landmark"}),
    (("风雨桥", "廊桥", "吊桥", "索桥", "石桥", "光桥", "天桥", "拱桥", "桥"), "bridge", (), "link_bridge"),
    (("栈道",), "walkway", (), "link_walk"),
    (("瀑布",), "waterfall", (), "waterfall_steps"),
    (("门楼", "城门", "寨门", "山门", "牌坊", "拱门", "大门"), "gate", ("gate", "arch"), {"type": "gate", "size_m": [14, 12, 6]}),
    (("雕像", "石像", "神像", "巨像"), "statue", ("statue",), {"type": "statue", "size_m": [4, 10, 4]}),
    (("世界树", "大树", "古树", "神木", "老树"), "tree", ("tree",), {"type": "tree", "size_m": [14, 20]}),
    (("水晶", "晶体", "魔晶"), "crystal", ("crystal",), {"type": "crystal", "size_m": [5, 12, 5]}),
    (("庭院", "院落", "内庭", "四合院", "回廊"), "courtyard", ("courtyard",), {"type": "courtyard", "size_m": [36, 28], "wall_h_m": 4, "gate": "S"}),
    (("广场",), "plaza", (), {"type": "platform", "size_m": [40, 0.6, 40]}),
    (("祭坛",), "altar", (), {"type": "platform", "size_m": [14, 2, 14]}),
    (("图书馆", "书库", "藏书楼"), "library", (), {"type": "building", "size_m": [22, 14, 16], "roof": "spire"}),
    (("招牌", "霓虹灯牌", "灯牌"), "signs", (), {"type": "repeat", "pattern": "linear", "count": 6, "spacing_m": 6,
                                             "child": {"type": "box", "size_m": [3, 1.5, 0.4], "elev_m": 6}}),
    (("海盗船", "帆船", "船"), "ship", (), {"type": "box", "size_m": [8, 6, 26]}),
    (("礁石", "巨石", "岩柱"), "rock", ("rock",), {"type": "repeat", "pattern": "scatter", "count": 6, "child": {"type": "rock", "size_m": [6, 5, 6]}}),
    (("花园", "园林", "花圃"), "garden", ("grove",), {"type": "grove", "size_m": [40, 30]}),
    (("森林", "树林", "竹林"), "forest", ("grove",), {"type": "grove", "size_m": [70, 50]}),
]
STRUCT_CN = {k: words[0] for words, k, *_ in STRUCT_LEX}

# 地形词：(词, 键, 认哪些 site.ground, 认哪些地形操作, 缺了怎么补：("ground", 值) 或 ("op", 操作))
TERRAIN_LEX: list[tuple[tuple, str, tuple, tuple, tuple]] = [
    (("湖心", "湖畔", "湖边", "湖上", "湖"), "lake", ("lake",), ("lake",),
     ("op", {"op": "lake", "label": "湖", "at": "site.center", "shape": "circle", "size_m": [120, 120], "depth_m": 5})),
    (("海边", "海岸", "海湾", "海港", "海盗", "港口", "海岛", "海"), "sea", ("coast", "island"), (),
     ("ground", "coast")),
    (("沙漠", "沙丘", "荒漠", "戈壁"), "desert", ("desert",), ("dune",),
     ("op", {"op": "dune", "label": "沙丘", "at": "site.center", "shape": "rect", "size_m": [200, 200], "amplitude_m": 4, "scale_m": 30})),
    (("峡谷", "裂谷", "深谷", "山谷", "河谷", "溪谷"), "canyon", ("canyon",), ("carve",),
     ("op", {"op": "carve", "label": "峡谷", "shape": "line", "from": "site.N", "to": "site.S", "width_m": 28, "depth_m": 22})),
    (("悬崖", "峭壁", "断崖", "崖边", "崖顶", "崖上", "崖"), "cliff", ("canyon",), ("cliff",),
     ("op", {"op": "raise", "label": "崖", "at": "site.N", "shape": "rect", "size_m": [100, 50], "height_m": 26, "edge": "cliff"})),
    (("山城", "山上", "山顶", "山坡", "高山", "雪山", "群山", "山间", "山里", "山村", "山寨", "半山"), "mountain", ("mountain", "hills"), (),
     ("op", {"op": "raise", "label": "山", "at": "site.N", "shape": "ellipse", "size_m": [140, 110], "height_m": 30, "edge": "slope"})),
    (("孤岛", "小岛", "岛上", "海岛"), "island", ("island",), (), ("ground", "island")),
    (("小溪", "河流", "运河", "河", "溪"), "river", (), ("river",),
     ("op", {"op": "river", "label": "河", "from": "site.N", "to": "site.S", "width_m": 8})),
]
TERRAIN_CN = {"lake": "湖", "sea": "海", "desert": "沙漠", "canyon": "峡谷", "cliff": "崖", "mountain": "山", "island": "岛", "river": "河"}

# 空间词：(词, stratum, layout, 可接受的 layout, id)
SPACE_LEX = [
    (("矿洞", "矿井", "矿道", "矿坑"), "underground", "galleries", ("galleries",), "mine"),
    (("地宫", "墓室", "古墓", "陵墓", "地下大厅", "地下殿"), "underground", "halls", ("halls", "rooms"), "crypt"),
    (("溶洞", "洞穴", "山洞", "海蚀洞"), "underground", "network", ("network",), "cave"),
    (("地道", "暗道", "隧道"), "underground", "corridor", ("corridor",), "tunnel"),
    (("地窖", "地下室", "禁书库"), "underground", "chamber", ("chamber", "rooms"), "cellar"),
    (("地下城",), "underground", "rooms", ("rooms", "halls", "network"), "undercity"),
]
LAYOUT_CN = {"chamber": "单室", "corridor": "地道", "maze": "迷宫", "galleries": "矿道", "halls": "厅堂", "network": "洞穴网", "rooms": "房间"}
CONNECT_LEX = [(("竖井",), "shaft"), (("井",), "well"), (("梯子", "爬梯"), "ladder"), (("坡道",), "ramp"),
               (("升降", "电梯"), "elevator"), (("楼梯", "台阶", "石阶下"), "stairs")]
ENTRY_LEX = [
    (("东边进", "从东", "东侧进", "东边入口", "东侧入口", "东门", "东边上来"), "E"),
    (("西边进", "从西", "西侧进", "西边入口", "西侧入口", "西门", "西边上来"), "W"),
    (("南边进", "从南", "南侧进", "南边入口", "南侧入口", "南门", "南边上来"), "S"),
    (("北边进", "从北", "北侧进", "北边入口", "北侧入口", "北门", "北边上来"), "N"),
]
SIDE_CN = {"E": "东", "W": "西", "S": "南", "N": "北"}
SCALE_LEX = [(("一角", "角落", "小小的", "小型", "很小", "小村", "几户", "小"), "small"), (("宏大", "巨大", "庞大", "广阔", "大型", "很大", "大"), "large")]
SCALE_RANGE = {"small": (80, 140), "large": (260, 400)}


def _scan(text: str, words) -> list[tuple[int, str]]:
    """词表里出现的词（长词优先、不重叠），按位置排序"""
    taken = [False] * len(text)
    out = []
    for w in sorted(words, key=len, reverse=True):
        for m in re.finditer(re.escape(w), text):
            if not any(taken[m.start():m.end()]):
                out.append((m.start(), w))
                for k in range(m.start(), m.end()):
                    taken[k] = True
    return sorted(out)


def _first(text: str, table) -> Any:
    hits = [(text.find(w), val) for words, val in table for w in words if w in text]
    return min(hits)[1] if hits else None


def _clause_at(text: str, i: int) -> str:
    for m in CLAUSE.finditer(text):
        if m.start() <= i < m.end():
            return m.group(0)
    return text


def _num(tok: str) -> int:
    return int(tok) if tok.isdigit() else CN_NUM.get(tok, 0)


def _count_before(text: str, i: int) -> int:
    """结构词前面的数量：「六座法师塔」「3 个浮岛」「两条天桥」"""
    m = re.search(r"([一二两三四五六七八九十]|十二|\d{1,2})\s*(?:座|个|栋|根|条|道|块|处|艘|间|尊)[一-龥]{0,3}$", text[max(0, i - 8):i])
    return _num(m.group(1)) if m else 0


def extract(text: str) -> dict:
    """一句话 → 说死的条件（没提到的不出现）"""
    t = (text or "").strip()
    c: dict = {}
    tod = _first(t, TIME_WORDS)
    if tod:
        c["time_of_day"] = tod
    # 结构
    words = {w: (k, acc, fill) for ws, k, acc, fill in STRUCT_LEX for w in ws}
    plain = t.replace("塔防", "")
    st = []
    for i, w in _scan(plain, list(words)):
        k, acc, fill = words[w]
        if k == "tower" and plain[i:i + 3] in ("塔楼区",):
            continue
        n = _count_before(plain, i)
        prev = next((x for x in st if x["key"] == k), None)
        if prev:
            prev["count"] = max(prev.get("count") or 0, n) or prev.get("count")
            continue
        st.append({"word": w, "key": k, "accept": list(acc), "count": n or None})
    if st:
        c["structures"] = st
    # 地形
    terr = []
    t_no_sky = re.sub("浮岛|空岛|浮空岛|空中岛|海盗船", "", t)
    for ws, k, grounds, ops, fill in TERRAIN_LEX:
        hit = next((w for w in ws if w in t_no_sky), None)
        if hit and k not in [x["key"] for x in terr]:
            if k == "mountain" and any(w in t for w in ("山门", "山洞")) and not any(w in t for w in ws if w not in ("山门", "山洞")):
                continue
            terr.append({"key": k, "word": hit, "grounds": list(grounds), "ops": list(ops)})
    if any(x["key"] == "sea" for x in terr) and any(x["key"] == "island" for x in terr) and "海岛" in t:
        terr = [x for x in terr if x["key"] != "sea"]
    if terr:
        c["terrain"] = terr
    if any(w in t for w in ("空中", "天空", "云端", "云上", "天上", "悬浮")) and not any(x["key"] == "island" for x in st):
        c["sky"] = True
    # 空间
    sp = []
    for ws, stratum, layout, ok, sid in SPACE_LEX:
        for w in ws:
            i = t.find(w)
            if i >= 0:
                sp.append({"word": w, "stratum": stratum, "layout": layout, "accept": list(ok), "id": sid, "at": i})
                break
    if "迷宫" in t:
        i = t.find("迷宫")
        host = min(sp, key=lambda x: abs(x["at"] - i)) if sp else None
        if host:
            host.update(layout="maze", accept=["maze"])
        else:
            sky = "空中" in t or "天上" in t
            sp.append({"word": "迷宫", "stratum": "sky" if sky else "underground", "layout": "network" if sky else "maze",
                       "accept": ["network"] if sky else ["maze"], "id": "maze", "at": i} | ({"branching": "high"} if sky else {}))
    if not sp and any(w in t for w in ("地下", "地底")):
        sp.append({"word": "地下", "stratum": "underground", "layout": "chamber", "accept": list(LAYOUT_CN), "id": "underground", "at": t.find("地下")})
    space_words = [x["word"] for x in sp] + (["迷宫"] if "迷宫" in t else [])
    for m in re.finditer(r"([一二两三四五六七八九十]|\d{1,2})\s*层", t):
        cl = _clause_at(t, m.start())
        if any(w in cl for w in space_words) and sp:
            host = min(sp, key=lambda x: abs(x["at"] - m.start()))
            host["sublevels"] = _num(m.group(1))
    for x in sp:
        if any(w in t for w in ("岔路多", "很绕", "绕来绕去", "复杂的迷宫", "岔路很多")):
            x["branching"] = "high"
        elif any(w in t for w in ("岔路少", "简单的迷宫")):
            x["branching"] = "low"
        conn = _first(re.sub("矿井", "", t), CONNECT_LEX)
        if conn:
            x["connect"] = conn
        x.pop("at", None)
    if sp:
        c["spaces"] = sp
    # 规模 / 入口
    s2 = re.sub("大殿|大门|大树|大厅|大阶|大桥|大寨|小岛|小殿|小溪|小庙|小屋|大海|大漠", "", t)
    for ws, k in SCALE_LEX:
        if any(w in s2 for w in ws):
            c["scale"] = k
            break
    ent = _first(t, ENTRY_LEX)
    if ent:
        c["entry_side"] = ent
    return c


def summary(c: dict) -> list[str]:
    """条件 → 给人看的短语（界面上「按你的话锁定了：…」）"""
    out = []
    for x in c.get("terrain", []):
        out.append(TERRAIN_CN.get(x["key"], x["word"]))
    if c.get("sky"):
        out.append("空中")
    for x in c.get("structures", []):
        out.append((f"{x['count']} 个" if x.get("count") else "") + x["word"])
    for s in c.get("spaces", []):
        bits = [s["word"] if s["word"] != "迷宫" else ("空中迷宫" if s["stratum"] == "sky" else "地下迷宫")]
        if s["layout"] == "maze" and s["word"] != "迷宫":
            bits.append("迷宫")
        if s.get("sublevels"):
            bits.append(f"{s['sublevels']} 层")
        out.append(" · ".join(bits))
    if "scale" in c:
        out.append("小场景" if c["scale"] == "small" else "大场景")
    if "entry_side" in c:
        out.append(SIDE_CN[c["entry_side"]] + "边进")
    if "time_of_day" in c:
        out.append(TIME_CN[c["time_of_day"]])
    return out


def hint(c: dict) -> str:
    s = summary(c)
    return ("（程序从这句话里读出的硬条件，三张都必须有，差异放在别处：" + "、".join(s) + "）") if s else ""


# ---------- 三张差在哪：空间组织方式（plans.py 满了，和片段库的 org 标签放在一起）
ORG_CN = {"sky": "悬空", "underground": "地下", "water": "水上", "radial": "环形", "axial": "轴线", "vertical": "垂直",
          "scatter": "散布", "terraced": "台地", "enclosed": "围合", "linear": "线性", "canyon": "峡谷", "grid": "网格"}
ORG_RANK = ("sky", "underground", "water", "canyon", "terraced", "grid", "radial", "axial", "vertical", "enclosed", "linear", "scatter")  # 同分时谁先
DETAIL_TYPES = ("column", "statue", "tree", "rock", "crystal", "gate")  # 一排柱子 / 一圈石像是细节，不是组织


def _f(v: Any, i: int = 0, d: float = 0.0) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, list) and len(v) > i and isinstance(v[i], (int, float)):
        return float(v[i])
    return d


def org_scores(plan: dict) -> dict[str, int]:
    """每种空间组织的证据强度：3 = 主体结构就是它，2 = 明显的一部分，1 = 细节（凑不够 2 个标签时才用）。
    「主体」= 根节点及其直接子节点 / 模板，或 role 是 landmark / primary 的节点。"""
    sc: dict[str, int] = {}

    def add(tag: str, v: int) -> None:
        sc[tag] = max(sc.get(tag, 0), v)
    site = plan.get("site") or {}
    ground = site.get("ground")
    ops = [t for t in plan.get("terrain") or [] if isinstance(t, dict)]
    walked = list(walk_nodes(plan.get("nodes") or []))
    nodes = [n for n, *_ in walked]
    types = [n.get("type") for n in nodes]
    major = {id(n) for n, path, *_ in walked if path.count(".") <= 1 or n.get("role") in ("landmark", "primary")}
    big = lambda n, hi=3, lo=2: hi if id(n) in major else lo  # noqa: E731
    cnt = lambda n: int(_f(n.get("count"), d=0) or _f(n.get("levels"), d=0) or _f(n.get("rows"), d=1) * _f(n.get("cols"), d=1))  # noqa: E731
    sw = _f(site.get("size_m"), 0, 200.0)
    sd, layer = _f(site.get("size_m"), -1, sw), float(site.get("layer_m") or 4)
    short_site = min(sw, sd)
    elev: dict[int, float] = {}  # 离地高度（组的 elev_m 往下传）；repeat 算上模板的
    for n, _, par, _ in walked:
        elev[id(n)] = _f(n.get("elev_m")) + (elev.get(id(par), 0.0) if par else 0.0)
    up = lambda n: elev[id(n)] + (_f(n["child"].get("elev_m")) if isinstance(n.get("child"), dict) else 0.0)  # noqa: E731

    # 悬空：能站人的东西离地 ≥ 12 m（桅顶瞭望斗、钟架横梁这类挂在塔 / 柱旁的不算）
    if ground == "sky":
        add("sky", 3)
    for n, _, par, _ in walked:
        t = n.get("type")
        if t == "island":
            add("sky", 3 if id(n) in major or (par or {}).get("type") == "repeat" else 2)
        elif t == "space" and n.get("stratum") == "sky":
            add("sky", 3)
        elif _f(n.get("elev_m")) >= 12 and t in ("platform", "building", "group", "repeat", "courtyard", "stairs", "water", "tree") \
                and not any(isinstance(x, dict) and x.get("type") in ("tower", "column") for x in (par or {}).get("children") or []):
            add("sky", big(n))
    # 地下：地下空间、洞穴地面、压低 > 6 m 的坑；隧道 / 嵌入地下的形体是细节
    if ground == "cavern" or any(n.get("type") == "space" and n.get("stratum", "underground") == "underground" for n in nodes):
        add("underground", 3)
    for t in ops:  # 压低 > 6 m：崖 / 台阶边、或深 ≥ 短边 15% 的才是坑 / 下沉；宽而缓的（160 × 100 深 8 的缓谷）是盆地 / 谷
        dep = max(_f(t.get("depth_m")), -_f(t.get("height_m")))
        if t.get("op") != "lower" or dep <= 6:
            continue
        sz = t.get("size_m") if isinstance(t.get("size_m"), list) else [t.get("size_m") or 40]
        short = min([float(v) for v in sz if isinstance(v, (int, float)) and v > 0] or [40.0])
        if t.get("edge") in ("cliff", "terraced") or dep / short >= 0.15:  # 坑里放了东西 = 3；只有悬在坑上方的（浮圃 / 环桥）= 坑是空中的底景，1
            users = [up(n) for n in nodes if t.get("id") and any(anchor_base(n.get(k)) == t["id"] for k in ("at", "under", "area"))]
            add("underground", 1 if users and min(users) >= 12 else 3 if any(e < 6 for e in users) else 2)
        else:
            add("canyon", 2)
    for n in nodes:
        if n.get("type") == "link" and n.get("style") == "tunnel":
            add("underground", 1)
        if n.get("ground") == "carve":
            add("underground", big(n, 2, 1))
    # 水上
    if ground in ("lake", "coast", "island") or any(t.get("op") == "lake" for t in ops):
        add("water", 3)
    if any(t.get("op") == "river" for t in ops):
        add("water", 2)
    for n in nodes:
        if n.get("type") == "water":  # 池子是细节；水面 ≥ 场地 4%、或长过场地短边一半（水道）才算
            w, d = _f(n.get("size_m"), 0, 10), _f(n.get("size_m"), -1, 10)
            add("water", 2 if w * d >= 0.04 * sw * sd or max(w, d) >= 0.5 * short_site else 1)
        if n.get("type") == "link" and n.get("style") == "canal":
            add("water", 1)
    # 峡谷 / 台地
    if ground == "canyon":
        add("canyon", 3)
    for t in ops:
        if t.get("op") == "carve" and _f(t.get("depth_m")) >= 3:  # < 3 m 的槽 / 浅池不算；窄于 8 m 的沟是细节
            w = _f(t.get("width_m")) or min(_f(t.get("size_m"), 0, 99), _f(t.get("size_m"), -1, 99))
            add("canyon", 1 if w < 8 else 3 if _f(t.get("depth_m")) >= 8 else 2)
    if "terraces" in types or any(_big_terrace(t, site) for t in ops):
        add("terraced", 3)
    steps = [t for t in ops if t.get("op") == "raise" and t.get("edge") in ("terraced", "cliff") and _f(t.get("height_m")) >= layer]
    if len({_f(t.get("height_m")) for t in steps}) >= 2 and max(_f(t.get("height_m")) for t in steps) >= 2 * layer \
            and sum(_f(t.get("size_m"), 0, 40) * _f(t.get("size_m"), -1, 40) for t in steps) >= 0.1 * sw * sd:
        add("terraced", 2)  # 几块高低不同的台叠在一起（塌落的楼板、叠台）
    cuts = [t for t in ops if t.get("op") == "river" or (t.get("op") in ("carve", "lower") and t.get("shape", "line" if t.get("op") == "carve" else None) == "line")]
    if len(cuts) >= 3:
        add("grid", 3)  # 三条以上的渠 / 沟 = 水网 / 沟网
    # 重复的排法：模板是细节（柱、像、树、岩）的只算 1
    for n in nodes:
        if n.get("type") != "repeat":
            continue
        pat, ch = n.get("pattern"), n.get("child") if isinstance(n.get("child"), dict) else {}
        detail = ch.get("type") in DETAIL_TYPES
        if pat == "radial":
            add("radial", 1 if detail else big(n))
        elif pat == "mirror":
            avenue = ch.get("type") == "repeat" and ch.get("pattern") in ("linear", "along")
            add("axial", big(n) if avenue else 1 if detail else big(n, 2, 1))
        elif pat == "stack":
            h = cnt(n) * _f(ch.get("size_m"), 1, 4)
            add("vertical", big(n) if h >= 20 else 1)
        elif pat == "grid":
            add("grid", 1 if detail or cnt(n) < 4 else big(n))
        elif pat in ("linear", "along"):
            add("linear", 1 if detail or cnt(n) < 4 else big(n) if cnt(n) >= 6 else 2)
        elif pat == "scatter":
            add("scatter", 1 if detail or ch.get("type") not in ("building", "group", "island", "tower", "platform") else big(n))
    if any(t.get("shape") == "ring" for t in ops):
        add("radial", 2)
    for n in nodes:  # 环带：空心圆柱 / 大环
        if n.get("type") in ("cylinder", "torus", "prism") and (n.get("hollow") or n.get("type") == "torus") and _f(n.get("size_m")) >= 40:
            add("radial", big(n, 3, 2))
    # 垂直
    for n in nodes:
        t, h = n.get("type"), _f(n.get("size_m"), 1)
        if t in ("tower", "cone", "column", "building", "cylinder", "prism", "pyramid") and h >= 40:
            add("vertical", 3)
        elif t in ("tower", "cone") and h >= 20:
            add("vertical", 2)
        elif t == "column" and h >= 20:
            add("vertical", 1)
    if any(t.get("op") in ("raise", "cliff") and _f(t.get("height_m")) >= 20 for t in ops):
        add("vertical", 3)
    if ground == "mountain":
        add("vertical", 2)
    # 散布 / 围合 / 线性的其它证据
    if "scatter_houses" in types:
        add("scatter", 3)
    if "grove" in types:
        add("scatter", 1)
    for n in nodes:
        if n.get("type") == "wall":  # 围起场地大半的墙才算围合；广告墙 / 井口护栏是细节
            tgt = anchor_base(n.get("around"))
            span = next((_f(x.get("size_m"), 0) for x in ops + nodes if tgt and x.get("id") == tgt and x.get("size_m")), None) if tgt else _f(n.get("size_m"), 0)
            add("enclosed", 1 if span is not None and span < 0.5 * short_site else big(n) if tgt else 2)
        elif n.get("type") == "courtyard":
            add("enclosed", big(n, 2, 1) if _f(n.get("size_m"), 0, 40) >= 0.3 * short_site else 1)
        elif n.get("type") in ("cylinder", "torus") and n.get("hollow") and _f(n.get("size_m")) >= 0.6 * short_site:
            add("enclosed", 2)
    if "courtyard" in types and "gate" in types:  # 有院有门不一定成轴线（岛上的练习场 + 外门），只算细节
        add("axial", 1)
    if sum(1 for n in nodes if n.get("type") == "link") >= 3:
        add("linear", 1)
    return sc


def organization(plan: dict, full: bool = False) -> set[str]:
    """一张程序的空间组织标签：只打主体结构的 2–4 个（证据 ≥ 2 的按强度取前 4，不够 2 个用细节补，围合不拿来凑）。full=True：所有有证据的标签"""
    sc = org_scores(plan)
    if full:
        return set(sc)
    ranked = sorted(sc, key=lambda t: (-sc[t], ORG_RANK.index(t)))
    out = [t for t in ranked if sc[t] >= 2][:4]
    if len(out) < 2:
        out += [t for t in ranked if sc[t] == 1 and t != "enclosed"][:2 - len(out)]  # 一面墙 / 一个小院不是组织，不拿来凑数
    return set(out)


def _big_terrace(t: dict, site: dict) -> bool:
    """台阶化的地形算不算「台地」：高差 ≥ 2 × layer_m、面积 ≥ 场地 10%（街巷下陷 1.6 m 带两级台阶的不算）；
    往下挖的坑 / 下沉（lower / lake / carve 带台阶边）是坑，不是台地"""
    if t.get("op") != "terrace" and t.get("edge") != "terraced":
        return False
    if t.get("op") in ("lower", "lake", "carve") or (t.get("op") == "terrace" and _f(t.get("depth_m")) > 0):
        return False
    num = lambda v, d: [float(v)] if isinstance(v, (int, float)) else [float(x) for x in v] if isinstance(v, list) and v and all(isinstance(x, (int, float)) for x in v) else d  # noqa: E731
    ts, ss, layer = num(t.get("size_m"), [60.0]), num(site.get("size_m"), [200.0]), float(site.get("layer_m") or 4)
    (w, d), (sw, sd) = (ts[0], ts[-1]), (ss[0], ss[-1])
    r = float(t.get("ring_m") or 12)
    area = 3.14159 * max(0.0, w * r - r * r) if t.get("shape") == "ring" else w * d * (0.785 if t.get("shape", "circle") in ("circle", "ellipse") else 1.0)
    dh = float(t.get("step_h_m") or layer) * float(t.get("steps") or 3) if t.get("op") == "terrace" else abs(float(t.get("height_m") or t.get("depth_m") or 0))
    return dh >= 2 * layer and area >= 0.1 * sw * sd


def preset_flags(plan: dict) -> list[str]:
    """v4 的老三样还在不在：台地生成器 / 撒房子 / 台阶化地形"""
    types = {n.get("type") for n in all_nodes(plan)}
    out = [x for x in ("terraces", "scatter_houses") if x in types]
    if any(isinstance(t, dict) and t.get("op") == "terrace" for t in plan.get("terrain") or []):
        out.append("terrace_op")
    return out


def signature(plan: dict) -> dict:
    """构成签名：三张之间比的就是这些"""
    nodes = all_nodes(plan)
    return {
        "ground": (plan.get("site") or {}).get("ground"),
        "organization": tuple(sorted(organization(plan))),
        "terrain": tuple(sorted(str(t.get("op")) for t in plan.get("terrain") or [] if isinstance(t, dict))),
        "types": tuple(sorted({str(n.get("type")) for n in nodes})),
        "patterns": tuple(sorted({str(n.get("pattern")) for n in nodes if n.get("type") == "repeat"})),
        "links": tuple(sorted({str(n.get("style")) for n in nodes if n.get("type") == "link"})),
    }


def diversity(plans: list) -> dict:
    """三张两两在几个构成维度上不同（min ≥ 2 算真的不同）；org_pairwise = 两两的空间组织标签差几个（对称差）"""
    good = [p for p in plans if isinstance(p, dict)]
    sigs = [signature(p) for p in good]
    orgs = [organization(p) for p in good]
    pairs, opairs = [], []
    for i in range(len(sigs)):
        for j in range(i + 1, len(sigs)):
            pairs.append(sum(sigs[i][k] != sigs[j][k] for k in sigs[i]))
            opairs.append(len(orgs[i] ^ orgs[j]))
    return {"pairwise": pairs, "min": min(pairs) if pairs else None, "dims": list(sigs[0]) if sigs else [],
            "org_pairwise": opairs, "org_min": min(opairs) if opairs else None,
            "organization": [[ORG_CN.get(t, t) for t in sorted(o)] for o in orgs], "presets": [preset_flags(p) for p in good]}


# ============================================================ 3. 锁定
DIRS = ("E", "W", "N", "S", "NE", "NW", "SE", "SW")


def _fit_node(el: dict) -> dict:
    """补出来的节点按当前 schema 修一遍：去掉 schema 里没有的字段、夹取范围"""
    el = copy.deepcopy(el)
    sch = item_schema("node", el)
    strip_extra(sch, el, "$", plan_schema())
    return clamp(sch, el, "$", plan_schema(), [])


def _fit_terrain(el: dict) -> dict:
    el = copy.deepcopy(el)
    sch = item_schema("terrain", el)
    strip_extra(sch, el, "$", plan_schema())
    return clamp(sch, el, "$", plan_schema(), [])


def owner_id(plan: dict, n: dict) -> str | None:
    """节点的 id；没有 id 的 repeat 模板 / 子节点 → 最近的有 id 的祖先（删它就删这一整组）"""
    if isinstance(n.get("id"), str):
        return n["id"]
    for x, _, parent, _ in walk_nodes(plan.get("nodes") or []):
        if x is n and parent is not None:
            return owner_id(plan, parent)
    for x in all_nodes(plan):
        if x.get("child") is n:
            return owner_id(plan, x)
    return None


def main_id(plan: dict) -> str | None:
    """主体：第一个 role=landmark 的节点；没有就第一个有 id 的根节点"""
    for n in all_nodes(plan):
        if n.get("role") == "landmark" and isinstance(n.get("id"), str):
            return n["id"]
    return next((n["id"] for n in plan.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("id"), str) and n.get("type") not in ("link", "space")), None)


def _free_dir(plan: dict) -> str:
    """根节点锚 site.X 还没用过的方位"""
    used = {str(n.get("at") or "").split(".")[-1] for n in plan.get("nodes") or [] if isinstance(n, dict) and str(n.get("at") or "").startswith("site.")}
    return next((d for d in DIRS if d not in used), "E")


def _anchor_near(plan: dict, k: int = 0) -> tuple[str, list | None]:
    """补件锚哪：主体的某一侧（组内偏移往外推）；没有主体就场地上一个空方位"""
    m = main_id(plan)
    if not m:
        return f"site.{_free_dir(plan)}", None
    d = DIRS[k % len(DIRS)]
    v = {"E": (1, 0), "W": (-1, 0), "N": (0, -1), "S": (0, 1), "NE": (1, -1), "NW": (-1, -1), "SE": (1, 1), "SW": (-1, 1)}[d]
    return f"{m}.{d}", [v[0] * 14, v[1] * 14]


# 「角色词」：神殿 / 城堡 / 书库 / 广场 / 祭坛 说的是这个地方的主体是什么，不是某种特定形体。
# 程序的名字、概念、关键结构里说到了，或者已经有 role=landmark 的主体，就算有；都没有才给主体改个名，不新加盒子。
ROLE_KEYS = ("temple", "castle", "library", "plaza", "altar")


def _words_of(x: dict) -> tuple:
    ws = next((w for w, k, *_ in STRUCT_LEX if k == x["key"]), (x["word"],))
    return tuple(ws) + (("港", "泊位", "船台") if x["key"] == "harbor" else ())


def named_in_text(plan: dict, x: dict) -> bool:
    """程序自己的名字 / 概念 / 关键结构里说到了这个结构（「沙环神殿」「坑底下沉主厅」）"""
    text = " ".join([str(plan.get("name") or ""), str(plan.get("concept") or "")] + [str(k) for k in plan.get("key_structures") or []])
    return any(w in text for w in _words_of(x) if len(w) > 1 or x["key"] in ("tower", "temple", "bridge"))


def has_structure(plan: dict, x: dict, loose: bool = False) -> list[dict]:
    """plan 里满足「点了名的结构 x」的节点：label 含这个词（或同键的别的词），或 type 在可接受类型里。
    loose（生成时的锁定）：角色词（神殿 / 城堡 …）在名字 / 概念 / 关键结构里说到了，或已有 landmark 主体，也算有（返回主体）。"""
    if loose and x["key"] in ROLE_KEYS:
        hit = has_structure(plan, x)
        if hit:
            return hit
        if named_in_text(plan, x):
            lm = [n for n in all_nodes(plan) if n.get("role") == "landmark"]
            return lm[:1] or [n for n in plan.get("nodes") or [] if isinstance(n, dict) and n.get("type") not in ("link", "space")][:1]
    ws = _words_of(x)
    out = []
    for n in all_nodes(plan):
        lab = str(n.get("label") or "")
        if any(w in lab for w in ws if len(w) > 1 or x["key"] in ("tower", "temple", "bridge")) or n.get("type") in x["accept"]:
            out.append(n)
        elif x["key"] == "bridge" and n.get("type") == "link" and n.get("style") in ("bridge", "rope_bridge"):
            out.append(n)
        elif x["key"] == "walkway" and n.get("type") == "link" and ("栈" in lab or n.get("style") in ("path", "bridge") and "道" in lab):
            out.append(n)
    if x["key"] in ("waterfall", "sea", "lake"):
        out += [t for t in plan.get("terrain") or [] if isinstance(t, dict) and x["word"] in str(t.get("label") or "")]
    return out


def _expanded(n: dict) -> int:
    if n.get("type") == "repeat":
        k = 2 if n.get("pattern") == "mirror" else int(n.get("count") or n.get("levels") or 1)
        return k * (_expanded(n["child"]) if isinstance(n.get("child"), dict) else 1)
    return 1


def add_structure(p: dict, x: dict, k: int = 0) -> str:
    """按片段 / 模板补一个点了名的结构，锚到合理位置。返回补了什么（中文）。"""
    fill = next(f for ws, kk, acc, f in STRUCT_LEX if kk == x["key"])
    word = x["word"]
    if fill in ("link_bridge", "link_walk"):
        roots = [n["id"] for n in p.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("id"), str) and n.get("type") not in ("link", "space")]
        a, b = (roots[0], roots[1]) if len(roots) >= 2 else ("site.S", roots[0] if roots else "site.N")
        style = "rope_bridge" if word in ("吊桥", "索桥") else "path" if fill == "link_walk" else "bridge"
        p.setdefault("nodes", []).append(_fit_node({"id": new_id(p, "bridge" if fill == "link_bridge" else "walkway"), "type": "link", "style": style,
                                                    "label": word, "from": a, "to": b, "width_m": 3}))
        return f"补{word}（{a} → {b}）"
    if isinstance(fill, str):  # 片段
        anchor = main_id(p) or "site.center"
        if fill not in ("maze_space", "underground_hall", "wall_gate", "sky_islands"):
            anchor = f"site.{_free_dir(p)}" if p.get("nodes") else "site.center"
        terr, nodes, mid = instantiate(p, fill, anchor)
        for t in terr:
            p.setdefault("terrain", []).append(_fit_terrain(t))
        for n in nodes:
            p.setdefault("nodes", []).append(_fit_node(n))
        hit = next((n for n in all_nodes(p) if n.get("id") == mid), None)
        if hit is not None and word not in str(hit.get("label") or ""):
            hit["label"] = word if len(word) > 1 else (hit.get("label") or "") + word
        rep = next((n for n in all_nodes(p) if n.get("id") == mid and n.get("type") == "repeat" and n.get("pattern") not in ("mirror", "stack")), None)
        if x.get("count") and rep is not None:  # 「三座浮岛」：数量照说的；连到不存在的实例的连接去掉
            rep["count"] = x["count"]
            bad = {f"{mid}[{i}]" for i in range(x["count"], 64)}
            p["nodes"] = [n for n in p["nodes"] if not (n.get("type") == "link" and (n.get("from") in bad or n.get("to") in bad))]
        return f"补{word}（{FRAG[fill]['name']}）"
    at, off = _anchor_near(p, k)
    n = dict(copy.deepcopy(fill))
    if x.get("count") and x["count"] > 1 and n.get("type") != "repeat":
        child = {**n, "label": word}
        n = {"type": "repeat", "pattern": "radial", "count": x["count"], "radius_m": 26, "face": "center", "child": child}
    n = {"id": new_id(p, x["key"]), "label": word, "at": at, **({"offset_m": off} if off else {}), **n}
    if n.get("type") == "repeat" and isinstance(n.get("child"), dict):
        n["child"].setdefault("label", word)
    p.setdefault("nodes", []).append(_fit_node(n))
    return f"补{word}"


def _root_of(p: dict, nid: str) -> tuple[dict | None, list]:
    """包含节点 nid 的根节点（及根节点数组）"""
    roots = p.get("nodes") or []
    for r in roots:
        if not isinstance(r, dict):
            continue
        if r.get("id") == nid or any(n.get("id") == nid for n in all_nodes({"nodes": [r]})):
            return r, roots
    return None, roots


def relabel_main(p: dict, x: dict, keep_ids: set | None = None) -> str | None:
    """角色词（神殿 / 城堡 …）没对上：把现有主体（第一个 landmark，没有就最大的根形体）的名字带上这个词"""
    m = main_id(p)
    n = next((q for q in all_nodes(p) if m and q.get("id") == m), None)
    if n is None or m in (keep_ids or set()) or n.get("type") in ("link", "space"):
        return None
    lab = str(n.get("label") or "")
    word = x["word"] if len(x["word"]) > 1 else STRUCT_CN.get(x["key"], x["word"])
    if word not in lab:
        n["label"] = (lab + word if lab and len(lab) + len(word) <= 12 else word)[:16]
    n.setdefault("role", "landmark")
    return f"{n['label']}（主体改名，不另加{word}）"


def lift_main(p: dict, keep_ids: set | None = None, elev: float = 24) -> str:
    """「空中」没满足：把主体所在的根节点整体抬成悬空（组直接写 elev_m；别的类型外面包一个悬空组），出生点补一段登空石阶。
    没有主体时退回补一组浮岛。"""
    m = main_id(p)
    root, roots = _root_of(p, m) if m else (None, [])
    if root is None or root.get("type") in ("link", "space") or root.get("id") in (keep_ids or set()):
        return add_structure(p, {"word": "浮岛", "key": "island", "accept": ["island"]})
    base = str(root.get("at") or "").split(".")[0]
    dug = next((t for t in p.get("terrain") or [] if isinstance(t, dict) and t.get("id") == base and t.get("op") in ("lower", "lake")), None)
    if dug is not None:  # 锚在坑底：先抬出坑口再悬空
        elev += float(dug.get("depth_m") or 0)
    if root.get("type") == "group":
        root["elev_m"] = max(float(root.get("elev_m") or 0), elev)
        target = root
    else:
        gid = new_id(p, "aloft")
        child = {k: v for k, v in root.items() if k not in ("at", "elev_m", "ground")}
        target = {"id": gid, "type": "group", "label": "悬空" + str(root.get("label") or "")[:10], "at": root.get("at") or "site.center",
                  "elev_m": elev, "children": [child]}
        roots[roots.index(root)] = target
    if not any(n.get("type") == "link" and "spawn" in (n.get("from"), n.get("to")) for n in all_nodes(p)):
        p["nodes"].append(_fit_node({"id": new_id(p, "sky_stair"), "type": "link", "style": "stairs", "label": "登空石阶", "from": "spawn", "to": m, "width_m": 3}))
    return f"主体悬空 {elev:g} m（{target.get('label') or target['id']}）"


def default_space(p: dict, s: dict) -> dict:
    under = main_id(p) or "site"
    label = s["word"] if s["layout"] != "maze" or s["word"] == "迷宫" else s["word"] + "迷宫"
    if s["word"] == "迷宫":
        label = "地下迷宫" if s["stratum"] == "underground" else "空中迷宫"
    sp = {"id": new_id(p, s.get("id") or "space"), "type": "space", "stratum": s["stratum"], "label": label, "layout": s["layout"],
          "size_m": 44 if s["layout"] in ("maze", "galleries", "network") else 32, "branching": s.get("branching") or ("high" if s["layout"] == "maze" else "medium"),
          "sublevels": s.get("sublevels") or 1, "connect": {"via": s.get("connect") or ("stairs" if s["stratum"] == "underground" else "ladder"), "from": under}}
    if s["stratum"] == "underground":
        sp.update(under=under, depth_m=12 + (6 if (s.get("sublevels") or 1) > 1 else 0))
    else:
        sp.update(over=under, elev_m=30)
    return _fit_node(sp)


def _range_of(group: str, field: str, lo: float, hi: float) -> tuple[float, float]:
    """锁定区间和 schema 范围取交集（schema 是准绳）"""
    s = field_schema(group, field) or {}
    for b in [s] + list(s.get("oneOf") or s.get("anyOf") or []):
        b = b.get("items") if isinstance(b.get("items"), dict) else b
        if isinstance(b, dict) and ("minimum" in b or "maximum" in b):
            return max(lo, b.get("minimum", lo)), min(hi, b.get("maximum", hi))
    return lo, hi


def _ground_ok(p: dict, x: dict) -> bool:
    g = (p.get("site") or {}).get("ground")
    if g in x["grounds"] or any(isinstance(t, dict) and (t.get("op") in x["ops"] or (x["key"] == "cliff" and t.get("edge") == "cliff")) for t in p.get("terrain") or []):
        return True
    if x["key"] == "mountain":
        return any(isinstance(t, dict) and t.get("op") == "raise" and (t.get("height_m") or 0) >= 15 for t in p.get("terrain") or [])
    if x["key"] == "river":
        return any(n.get("type") == "water" or (n.get("type") == "link" and n.get("style") == "canal") for n in all_nodes(p))
    if x["key"] == "sea":
        return any(isinstance(t, dict) and t.get("op") == "lake" and any(w in str(t.get("label") or "") for w in ("海", "湾", "港")) for t in p.get("terrain") or [])
    return False


SOFT_GROUNDS = (None, "flat", "rolling", "hills")


def enforce(plan: dict, c: dict, keep_ids: set | None = None) -> tuple[dict, list[str]]:
    """把条件写死到一张 plan 上；返回 (新 plan, 改了什么)。keep_ids 是人锁住的项（不动它们）。只改结构，不写全局坐标。"""
    p = copy.deepcopy(plan)
    ch: list[str] = []
    keep_ids = keep_ids or set()
    if "time_of_day" in c and (p.get("lighting") or {}).get("time_of_day") != c["time_of_day"] and "lighting" not in keep_ids:
        p.setdefault("lighting", {})["time_of_day"] = c["time_of_day"]
        ch.append("时段")
    site = p.setdefault("site", {})
    if "scale" in c and "site" not in keep_ids:
        lo, hi = _range_of("site", "size_m", *SCALE_RANGE[c["scale"]])
        sz = site.get("size_m") if isinstance(site.get("size_m"), list) else [site.get("size_m") or 200] * 2
        new = [round(max(lo, min(hi, float(v)))) for v in sz[:2]]
        if new != sz[:2]:
            site["size_m"] = new
            ch.append("规模")
    # 地形词：site.ground 或地形操作
    for x in c.get("terrain", []):
        if _ground_ok(p, x):
            continue
        how, val = next(f for ws, k, g, o, f in TERRAIN_LEX if k == x["key"])
        if how == "ground" or (x["key"] in ("desert", "mountain", "lake") and site.get("ground") in SOFT_GROUNDS and how == "op" and x["key"] != "lake"):
            site["ground"] = val if how == "ground" else {"desert": "desert", "mountain": "mountain"}[x["key"]]
            ch.append(f"地面·{TERRAIN_CN[x['key']]}")
        else:
            t = dict(copy.deepcopy(val))
            t["id"] = new_id(p, x["key"])
            if t.get("at") == "site.N" and x["key"] == "cliff" and main_id(p):
                t["at"] = "site.N"
            if x["key"] == "sea":
                t = {"op": "lake", "id": t["id"], "label": "海湾", "at": "site.S", "shape": "ellipse", "size_m": [220, 90], "depth_m": 8}
            p.setdefault("terrain", []).insert(0, _fit_terrain(t))
            ch.append(f"地形·{TERRAIN_CN[x['key']]}")
    if c.get("sky") and "sky" not in organization(p, full=True):  # 「空中」：按这张自己的组织把主体抬起来，不往每张塞同一组浮岛
        ch.append(lift_main(p, keep_ids))
    # 点了名的结构：三张都要有
    for k, x in enumerate(c.get("structures", [])):
        hits = has_structure(p, x, loose=True)
        if not hits and x["key"] in ROLE_KEYS:  # 角色词：给现有主体改名，不新加盒子
            m = relabel_main(p, x, keep_ids)
            if m:
                ch.append(m)
                continue
        if not hits:
            ch.append(add_structure(p, x, k))
            continue
        want = x.get("count")
        if want and want > 1 and x["key"] in ("tower", "island", "bridge", "statue", "crystal"):
            tmpl = [n.get("child") for n in all_nodes(p) if n.get("type") == "repeat"]
            have = sum(_expanded(n) for n in hits if n.get("type") != "repeat" and not any(n is t for t in tmpl)) + sum(_expanded(n) for n in all_nodes(p)
                                                                                         if n.get("type") == "repeat" and isinstance(n.get("child"), dict) and n["child"] in hits)
            rep = next((n for n in all_nodes(p) if n.get("type") == "repeat" and isinstance(n.get("child"), dict) and n["child"] in hits and n.get("id") not in keep_ids), None)
            if have != want and rep is not None and rep.get("pattern") not in ("mirror", "stack"):
                rep["count"] = want - (have - _expanded(rep))
                ch.append(f"{x['word']} × {want}")
            elif have < want and rep is None:  # 只有一座钟楼、说的是「七座法师塔」：补一组叫这个名字的（已有同名的只补差数）
                named = any(x["word"] in str(n.get("label") or "") for n in hits)
                ch.append(add_structure(p, {**x, "count": want - have if named else want}, k))
    # 空间
    claimed: set = set()
    for s in c.get("spaces", []):
        spaces = [n for n in all_nodes(p) if n.get("type") == "space" and id(n) not in claimed]
        hit = next((n for n in spaces if s["word"] in str(n.get("label") or "")), None)
        if not hit and s["word"] in ("迷宫", "地下"):
            hit = next((n for n in spaces if n.get("stratum", "underground") == s["stratum"]), None)
        if not hit:  # 同一层、布局已经对的空间（「地下迷宫」就是人说的「矿洞迷宫」）：改个名就是它
            hit = next((n for n in spaces if n.get("stratum", "underground") == s["stratum"] and n.get("layout") in s["accept"] and n.get("id") not in keep_ids), None)
            if hit is not None:
                hit["label"] = (s["word"] + ("迷宫" if s["layout"] == "maze" and "迷宫" not in s["word"] else ""))[:16]
                ch.append(f"{hit['label']}（改名）")
        if not hit:
            hit = default_space(p, s)
            p.setdefault("nodes", []).append(hit)
            ch.append(f"空间·{hit['label']}")
        claimed.add(id(hit))
        if hit.get("id") in keep_ids:
            continue
        if hit.get("stratum") != s["stratum"]:
            hit["stratum"] = s["stratum"]
        mazy = "迷宫" in str(hit.get("label") or "")
        if hit.get("layout") not in s["accept"] and not (mazy and hit.get("layout") == "maze"):
            hit["layout"] = s["layout"]
            ch.append(f"{hit.get('label')}·{LAYOUT_CN.get(s['layout'], s['layout'])}")
        if s["layout"] == "maze" and "迷宫" not in str(hit.get("label") or ""):
            hit["label"] = str(hit.get("label") or "") + "迷宫"
        if s.get("sublevels") and hit.get("sublevels") != s["sublevels"]:
            hit["sublevels"] = s["sublevels"]
            ch.append(f"{hit.get('label')}·{s['sublevels']} 层")
        if s.get("branching") and hit.get("branching") != s["branching"]:
            hit["branching"] = s["branching"]
            ch.append(f"{hit.get('label')}·岔路")
        if s.get("connect") and (hit.get("connect") or {}).get("via") != s["connect"]:
            hit.setdefault("connect", {})["via"] = s["connect"]
            ch.append(f"{hit.get('label')}·连接")
        fitted = _fit_node(hit)
        hit.clear()
        hit.update(fitted)
    if "entry_side" in c and "spawn" not in keep_ids:
        sp = p.setdefault("spawn", {})
        want = f"site.{c['entry_side']}"
        if sp.get("at") != want:
            sp["at"] = want
            ch.append("入口方向")
    return p, ch


def enforce_ops(plan: dict, ops: list, text: str, locked_ids: set | None = None) -> tuple[list, list[str], list[str]]:
    """revise 也锁：那句话里说死的词，ops 里没做到就本地补一条。返回 (补的 ops, 补了什么, 复述要补的话)。"""
    c = extract(text)
    removing = any(w in text for w in REMOVE_WORDS)
    added: list = []
    notes: list[str] = []
    say: list[str] = []
    locked_ids = locked_ids or set()

    def cur() -> dict:
        return apply_ops(plan, ops + added)

    def push(op, note) -> bool:
        good, errs, _ = check_ops(cur(), [op], locked_ids)
        if good:
            added.extend(good)
            notes.append(note)
            return True
        return False

    if removing:
        for x in c.get("structures", []) + [{"word": s["word"], "key": "space", "accept": ["space"]} for s in c.get("spaces", [])]:
            now = cur()
            for n in has_structure(now, x):
                rid = owner_id(now, n)
                if rid and not any(o.get("op") == "remove" and o.get("id") == rid for o in ops + added):
                    if push({"op": "remove", "id": rid}, f"删{n.get('label') or rid}"):
                        say.append(f"去掉了{n.get('label') or rid}")
        return added, notes, list(dict.fromkeys(say))
    after = cur()
    if "time_of_day" in c and (after.get("lighting") or {}).get("time_of_day") != c["time_of_day"]:
        if push({"op": "set", "id": "lighting", "field": "time_of_day", "value": c["time_of_day"]}, "时段"):
            say.append(f"时段改成{TIME_CN[c['time_of_day']]}")
    chg = re.search(r"改成|改为|变成|换成|做成|弄成|是个|是一个", text)
    for s in c.get("spaces", []):
        now = cur()
        spaces = [n for n in all_nodes(now) if n.get("type") == "space" and isinstance(n.get("id"), str)]
        hit = next((n for n in spaces if s["word"] in str(n.get("label") or "")), None)
        same = [n for n in spaces if n.get("stratum", "underground") == s["stratum"]]
        if not hit and (s["word"] in ("迷宫", "地下") or chg) and len(same) == 1:
            hit = same[0]
        if not hit and chg and len(same) > 1:
            say.append(f"没找到「{s['word']}」，要改哪个{'地下' if s['stratum'] == 'underground' else '空中'}空间？")
            continue
        if not hit:
            sp = default_space(now, s)
            if push({"op": "add", "to": "nodes", "value": sp}, f"加{sp['label']}"):
                say.append(f"加了{sp['label']}" + ("，迷宫平面" if sp.get("layout") == "maze" else ""))
            continue
        if hit.get("layout") not in s["accept"]:
            if push({"op": "set", "id": hit["id"], "field": "layout", "value": s["layout"]}, f"{hit.get('label')}布局"):
                say.append(f"{hit.get('label')}改成{LAYOUT_CN.get(s['layout'], s['layout'])}平面")
        if s.get("sublevels") and hit.get("sublevels") != s["sublevels"]:
            push({"op": "set", "id": hit["id"], "field": "sublevels", "value": s["sublevels"]}, f"{hit.get('label')}层数")
        if s.get("branching") and hit.get("branching") != s["branching"]:
            push({"op": "set", "id": hit["id"], "field": "branching", "value": s["branching"]}, f"{hit.get('label')}岔路")
    adding = any(w in text for w in ADD_WORDS) or not chg
    for k, x in enumerate(c.get("structures", [])):
        now = cur()
        if has_structure(now, x) or not adding:
            continue
        trial = copy.deepcopy(now)
        before = {id(n) for n in trial.get("nodes") or []}
        add_structure(trial, x, k)
        new_t = [t for t in trial.get("terrain") or [] if t not in (now.get("terrain") or [])]
        ok = True
        for t in new_t:
            ok &= push({"op": "add", "to": "terrain", "value": t}, f"加{x['word']}地形")
        for n in trial.get("nodes") or []:
            if id(n) not in before:
                ok &= push({"op": "add", "to": "nodes", "value": n}, f"加{x['word']}")
        if ok:
            say.append(f"加了{x['word']}")
    if "entry_side" in c and ((cur().get("spawn") or {}).get("at") != f"site.{c['entry_side']}"):
        if push({"op": "set", "id": "spawn", "field": "at", "value": f"site.{c['entry_side']}"}, "入口方向"):
            say.append(f"出生点改到{SIDE_CN[c['entry_side']]}边")
    return added, notes, list(dict.fromkeys(say))


# ---------- 模拟 AI 的题材配方（数据；providers.recipes_for 用，v5 第 3 轮从 providers.py 挪来，和片段库放在一起）
# 模拟 AI 的题材配方：关键词 → 三个（或更多）空间组织不同的概念。variant 轮换起点。
_CRAG = {"op": "raise", "id": "crag", "label": "崖台", "at": "site.center", "shape": "circle", "size_m": [90, 80], "height_m": 24, "edge": "cliff"}
_DUNES = {"op": "dune", "label": "沙丘", "at": "site.center", "shape": "rect", "size_m": [220, 220], "amplitude_m": 4, "scale_m": 30}
THEMES: list[tuple[tuple, list[dict]]] = [
    (("学院", "魔法", "法师", "书院", "学府", "巫师", "法术"), [
        {"dir": "up", "name": "塔环学院", "concept": "崖台顶上一座穹顶主殿，六座法师塔环成一圈，石阶绕崖上来", "terrain": [_CRAG], "at0": "crag.top",
         "frags": ["ring_towers"], "ground": "hills", "palette": "arcane", "mood": ["神秘", "高耸"], "rename": {"塔": "法师塔"},
         "extra_nodes": [{"id": "crag_stair", "type": "link", "style": "stairs", "label": "环崖石阶", "from": "site.S", "to": "crag.top", "width_m": 3}],
         "key": ["穹顶主殿", "六座法师塔", "崖台", "环崖石阶"], "terrain_idea": "平地中央抬起一座陡崖台", "org": "垂直 + 环形"},
        {"auto": True, "name": "水网书院", "concept": "学舍散在一片浅湖里，曲桥把各处串成一张网，中央一座钟楼", "key": ["中央钟楼", "五座学舍散布湖面", "曲桥", "临水讲亭"], "terrain_idea": "一片浅湖", "org": "水网 + 散布"},
        {"auto": True, "name": "中轴书院", "concept": "一条长中轴，门楼、讲堂、藏书楼依次排开，两列法师塔夹着中轴", "key": ["讲堂", "两列法师塔夹着中轴", "门楼", "藏书楼"], "terrain_idea": "平地", "org": "轴线 + 夹道"},
        {"dir": "up", "name": "浮空学院", "concept": "湖心岛上的讲堂，头顶四座浮空书岛用光桥相连", "frags": ["lake_isle", "sky_islands"], "palette": "arcane",
         "mood": ["空灵", "奇幻"], "rename": {"湖心阁": "讲堂", "小殿": "书库"}, "key": ["湖心讲堂", "浮空书岛", "光桥", "曲桥"],
         "terrain_idea": "整片湖，中央一座矮岛", "org": "水上 + 悬空"},
        {"auto": True, "name": "环廊学院", "concept": "一圈环形回廊围着草坪，回廊上开着一圈教室，草坪中央立星象台", "key": ["环形回廊", "一圈十二间教室", "中央星象台"], "terrain_idea": "平地", "org": "环形 + 围合"},
        {"dir": "down", "name": "地宫学院", "concept": "地面只是一条轴线院落，真正的学院藏在讲堂下面的地下大厅里", "frags": ["axial_court", "underground_hall"],
         "palette": "stone", "mood": ["幽深", "庄严"], "rename": {"正殿": "讲堂", "地下大厅": "地下藏书大厅"},
         "key": ["门楼", "前院", "讲堂", "地下藏书大厅"], "terrain_idea": "平地，往下挖", "org": "轴线 + 地下"},
    ]),
    (("港", "码头", "海盗", "渔村", "海湾", "船坞", "海边"), [
        {"dir": "up", "name": "炮台海港", "concept": "海湾北岸一排码头和栈桥，防波堤围出港池，崖顶炮台俯看全港", "frags": ["harbor", "cliff_keep"],
         "ground": "coast", "palette": "sea", "mood": ["喧闹", "粗犷"], "rename": {"主堡": "崖顶炮台"},
         "key": ["码头", "栈桥", "防波堤", "崖顶炮台"], "terrain_idea": "海岸线 + 北面一座孤崖", "org": "水上线性 + 垂直"},
        {"auto": True, "name": "残垣港", "concept": "旧要塞塌了，残墙断柱散在海岸上，海盗在废墟间搭起棚屋", "key": ["散布的残墙", "散落的棚屋", "栈桥", "搁浅的破船"], "terrain_idea": "海岸平地", "org": "残骸 + 散布"},
        {"auto": True, "name": "环湾泊地", "concept": "一圈船坞围着圆形港池，船坞上一圈仓房，港口只有一个缺口通海", "key": ["环形船坞", "一圈仓房", "港池中央的系船浮台"], "terrain_idea": "海岸，中间一片圆湖", "org": "环形 + 水上"},
        {"dir": "down", "name": "海蚀洞寨", "concept": "一条海蚀峡湾切进陆地，崖壁上挂着栈道与崖屋，洞里藏着海盗的溶洞网", "frags": ["canyon_walk"], "ground": "coast",
         "extra_nodes": [{"id": "sea_cave", "type": "space", "stratum": "underground", "label": "海盗溶洞", "under": "plank_way", "depth_m": 12,
                          "layout": "network", "size_m": 44, "branching": "medium", "sublevels": 1, "connect": {"via": "stairs", "from": "plank_way"}}],
         "palette": "sea", "mood": ["隐秘", "险峻"], "rename": {"崖屋": "海盗崖屋"}, "key": ["峡湾", "崖壁栈道", "索桥", "海盗溶洞"],
         "terrain_idea": "海岸被一条深峡湾切开", "org": "峡谷 + 地下"},
        {"name": "水上棚寨", "concept": "整座寨子立在水上：网格排开的棚屋平台，用栈桥串起来，中间停着大船", "ground": "coast",
         "extra_nodes": [{"id": "stilts", "type": "repeat", "pattern": "grid", "rows": 3, "cols": 4, "spacing_m": 24, "at": "site.S",
                          "child": {"type": "platform", "label": "棚屋台", "size_m": [14, 1, 14],
                                    "children": [{"type": "building", "label": "棚屋", "size_m": [8, 5, 7], "roof": "gable"}]}},
                         {"id": "flagship", "type": "box", "label": "海盗船", "size_m": [10, 8, 30], "at": "stilts", "offset_m": [0, -50], "role": "landmark"},
                         {"id": "boardwalk", "type": "link", "style": "bridge", "label": "栈桥", "from": "stilts[0]", "to": "stilts[11]", "width_m": 3}],
         "palette": "sea", "mood": ["杂乱", "热闹"], "key": ["棚屋平台网格", "栈桥", "海盗船"], "terrain_idea": "浅海，几乎全是水", "org": "水上网格"},
    ]),
    (("神殿", "金字塔", "沙漠", "古庙", "神庙", "法老", "遗迹"), [
        {"dir": "up", "name": "轴线金字塔", "concept": "沙丘中一条石像大道笔直通向阶梯金字塔，顶上一座小殿", "frags": ["step_pyramid"], "ground": "desert",
         "extra_terrain": [_DUNES], "extra_nodes": [{"id": "avenue", "type": "repeat", "pattern": "mirror", "axis": "x", "at": "site.S",
                                                     "child": {"type": "repeat", "pattern": "linear", "axis": "z", "count": 5, "spacing_m": 12, "offset_m": [-10, -30],
                                                               "child": {"type": "statue", "label": "石像", "size_m": [3, 7, 3]}}}],
         "palette": "desert", "mood": ["宏大", "炎热"], "key": ["阶梯金字塔", "中轴大阶", "石像大道", "沙丘"], "terrain_idea": "起伏沙丘，中央削平", "org": "轴线 + 垂直"},
        {"auto": True, "name": "绿洲神殿", "concept": "沙漠里一汪泉水，神殿正对泉水，棕榈树散在四周", "key": ["神殿", "一排列柱", "散布的棕榈"], "terrain_idea": "沙地中间一片湖", "org": "水上 + 散布"},
        {"auto": True, "name": "列柱长廊", "concept": "两列巨柱夹着一条长长的朝圣道，尽头是神殿", "key": ["神殿", "两列巨柱夹着朝圣道", "一排狮身像"], "terrain_idea": "平沙地", "org": "轴线 + 线性"},
        {"name": "峡谷崖庙", "concept": "神殿凿在峡谷崖壁里，沿崖栈道一路下到谷底", "frags": ["canyon_walk"], "ground": "canyon", "palette": "desert",
         "rename": {"崖屋": "崖凿神龛", "崖壁栈道": "朝圣栈道"}, "extra_nodes": [{"id": "rock_temple", "type": "building", "label": "崖凿神殿",
                                                                         "at": "plank_way", "size_m": [26, 18, 12], "roof": "flat", "role": "landmark"}],
         "mood": ["幽闭", "肃穆"], "key": ["崖凿神殿", "朝圣栈道", "索桥", "崖凿神龛"], "terrain_idea": "一条深峡谷", "org": "峡谷 + 线性"},
        {"dir": "down", "name": "沉沙地宫", "concept": "地面只剩一圈断柱，入口下去是层层迷宫通向神殿地宫", "ground": "desert", "extra_terrain": [_DUNES],
         "extra_nodes": [{"id": "ruin_ring", "type": "repeat", "pattern": "radial", "count": 10, "radius_m": 22, "at": "site.center", "role": "landmark", "label": "断柱环",
                          "child": {"type": "column", "label": "断柱", "size_m": [2.5, 9]}}],
         "frags": ["maze_space"], "palette": "desert", "mood": ["荒凉", "神秘"], "rename": {"地下迷宫": "神殿地宫迷宫"},
         "key": ["断柱环", "地宫入口", "神殿地宫迷宫"], "terrain_idea": "平沙地，往下挖两层", "org": "环形 + 地下"},
    ]),
    (("赛博", "夜市", "霓虹", "朋克", "都市", "街", "巷"), [
        {"dir": "up", "name": "霓虹窄巷", "concept": "一条窄巷两边层层叠叠的楼，招牌挂满半空，天桥横过巷子", "frags": ["narrow_lane"], "palette": "neon", "time": "night",
         "mood": ["拥挤", "迷幻"], "key": ["层叠楼", "招牌", "天桥"], "terrain_idea": "平地，全靠楼往上长", "org": "线性 + 垂直"},
        {"auto": True, "name": "环形夜市", "concept": "一圈环形廊棚围着中央广场，廊棚下一圈摊位，广场中间立着霓虹塔", "key": ["环形廊棚", "一圈摊位", "中央霓虹塔"], "terrain_idea": "平地", "org": "环形 + 围合", "time": "night"},
        {"dir": "up", "name": "高架市集", "concept": "市集架在半空的平台上，一节节用天桥连起来，脚下是车道", "palette": "neon", "time": "night",
         "extra_nodes": [{"id": "decks", "type": "repeat", "pattern": "linear", "count": 5, "spacing_m": 30, "at": "site.center", "role": "landmark", "label": "高架平台",
                          "child": {"type": "platform", "label": "高架摊台", "size_m": [20, 1, 16], "elev_m": 14,
                                    "children": [{"type": "repeat", "pattern": "grid", "rows": 2, "cols": 3, "spacing_m": 5,
                                                  "child": {"type": "box", "label": "摊位", "size_m": [3, 2.5, 3]}}]}},
                         {"id": "deck_bridge", "type": "link", "style": "bridge", "label": "天桥", "from": "decks[0]", "to": "decks[4]", "width_m": 4}],
         "mood": ["悬空", "喧闹"], "key": ["高架平台", "摊位", "天桥"], "terrain_idea": "平地", "org": "悬空 + 线性"},
        {"dir": "down", "name": "地下黑市", "concept": "地面一个小广场和下沉入口，真正的夜市在地下一层层的厅里", "palette": "neon", "time": "night",
         "extra_nodes": [{"id": "plaza", "type": "platform", "label": "下沉广场", "at": "site.center", "size_m": [36, 0.6, 36], "role": "landmark"}],
         "frags": ["underground_hall"], "rename": {"地下大厅": "地下黑市"}, "mood": ["隐秘", "嘈杂"], "key": ["下沉广场", "地下黑市"],
         "terrain_idea": "平地，往下挖", "org": "地下"},
    ]),
    (("空中", "花园", "天空", "云上", "云端", "仙境"), [
        {"name": "浮岛花园", "concept": "四座浮岛环成一圈，每座岛上一座花亭，光桥相连", "frags": ["sky_islands"], "ground": "sky", "palette": "garden",
         "rename": {"浮岛": "花岛", "小殿": "花亭"}, "extra_nodes": [{"id": "garden_core", "type": "island", "label": "中央花园岛", "at": "site.center", "elev_m": 30,
                                                                      "size_m": [36, 12, 36], "role": "landmark",
                                                                      "children": [{"type": "grove", "label": "花圃", "size_m": [24, 24], "density": 1.2}]}],
         "mood": ["轻盈", "梦幻"], "key": ["中央花园岛", "花岛", "花亭", "光桥"], "terrain_idea": "没有地面，远处云海", "org": "悬空 + 环形"},
        {"auto": True, "name": "云堤花径", "concept": "一条长长的悬空花堤横过云海，两侧一排排花池，尽头一座花亭", "key": ["悬空长堤", "两列花池", "尽头花亭"], "terrain_idea": "没有地面", "org": "悬空 + 线性"},
        {"name": "叠瀑天园", "concept": "三层浮岛上下叠起，一层比一层小，水从顶层一级级泻下", "ground": "sky", "palette": "garden",
         "extra_nodes": [{"id": "tiers", "type": "repeat", "pattern": "stack", "levels": 3, "spacing_m": 22, "taper": 0.25, "at": "site.center", "role": "landmark",
                          "label": "叠园", "child": {"type": "island", "label": "叠园岛", "size_m": [60, 10, 60], "elev_m": 24,
                                                     "children": [{"type": "grove", "label": "花圃", "size_m": [36, 36], "density": 1.0},
                                                                  {"type": "water", "label": "落水池", "size_m": [10, 10], "offset_m": [0, 22], "depth_m": 2}]}},
                         {"id": "tier_stair", "type": "link", "style": "stairs", "label": "绕岛石阶", "from": "tiers[0]", "to": "tiers[2]", "width_m": 2.5}],
         "mood": ["层叠", "清凉"], "key": ["三层叠园岛", "落水池", "绕岛石阶"], "terrain_idea": "没有地面", "org": "悬空 + 垂直"},
        {"name": "长桥园链", "concept": "一串浮岛排成一线，长桥一节节把花园串起来，走到尽头是观景台", "ground": "sky", "palette": "garden",
         "extra_nodes": [{"id": "chain", "type": "repeat", "pattern": "linear", "count": 5, "spacing_m": 42, "at": "site.center", "axis": "z",
                          "child": {"type": "island", "label": "园岛", "size_m": [26, 9, 26], "elev_m": 28,
                                    "children": [{"type": "grove", "label": "花圃", "size_m": [18, 18], "density": 1.0}]}},
                         {"id": "long_bridge", "type": "link", "style": "bridge", "label": "长桥", "from": "chain[0]", "to": "chain[4]", "width_m": 3},
                         {"id": "lookout", "type": "platform", "label": "观景台", "at": "chain[4]", "elev_m": 4, "size_m": [14, 1, 14], "role": "landmark"}],
         "mood": ["开阔", "悠长"], "key": ["园岛链", "长桥", "观景台"], "terrain_idea": "没有地面", "org": "悬空 + 线性"},
    ]),
    (("山城", "山村", "村庄", "村", "寨"), [
        {"name": "台地山寨", "concept": "山坡削成一层层台地，木楼顺着台地往上长", "frags": ["terraced_village"], "ground": "mountain", "palette": "village",
         "mood": ["层叠", "烟火"], "key": ["台地", "木楼"], "terrain_idea": "一面坡削成五层台", "org": "台地 + 散布"},
        {"auto": True, "name": "河湾村", "concept": "一条河绕村子半圈，人家沿河一排排展开，石桥过河", "key": ["一排临河人家", "石桥", "河边磨坊"], "terrain_idea": "一条河蜿蜒穿过", "org": "线性 + 水上"},
        {"auto": True, "name": "围寨", "concept": "一圈寨墙围着村子，人家散在寨子里，中央是祠堂", "key": ["祠堂", "散布的人家", "环形寨墙"], "terrain_idea": "平地", "org": "围合 + 散布"},
        {"name": "崖壁栈道寨", "concept": "人家挂在峡谷两侧崖壁上，栈道和索桥把两边连起来", "frags": ["canyon_walk"], "ground": "mountain", "palette": "village",
         "mood": ["险峻", "奇特"], "key": ["崖壁栈道", "崖屋", "索桥"], "terrain_idea": "山里一条深谷", "org": "峡谷 + 线性"},
        {"dir": "up", "name": "山顶城寨", "concept": "孤崖顶上一座主堡，城墙围着，崖道盘上去", "frags": ["cliff_keep", "wall_gate"], "ground": "mountain", "palette": "stone",
         "rename": {"主堡": "寨堡"}, "mood": ["坚固", "孤高"], "key": ["寨堡", "城墙", "门楼", "崖道"], "terrain_idea": "一座孤崖", "org": "垂直 + 围合"},
    ]),
    (("迷宫", "矿", "地宫", "地下", "洞"), [
        {"name": "矿山迷宫", "concept": "小矿场地面只有井架，下面是两层迷宫", "extra_nodes": [{"id": "headframe", "type": "tower", "label": "井架", "at": "site.center",
                                                                                 "size_m": [8, 18], "roof": "flat", "role": "landmark"}],
         "frags": ["maze_space"], "palette": "stone", "mood": ["压抑", "曲折"], "key": ["井架", "地下迷宫"], "terrain_idea": "平地", "org": "地下"},
        {"auto": True, "name": "露天矿坑", "concept": "露天矿坑一层层往下，坑边一圈矿车棚，坑底是矿井口", "key": ["一圈矿车棚", "坑底矿井口", "一排井架"], "terrain_idea": "往下挖一个层层台阶的坑", "org": "下沉 + 环形"},
        {"name": "峡谷矿道", "concept": "矿道开在峡谷崖壁上，栈道串着一个个矿口，崖里是矿洞", "frags": ["canyon_walk", "maze_space"], "palette": "stone", "rename": {"崖屋": "矿口", "地下迷宫": "崖里矿洞"},
         "mood": ["险峻", "劳碌"], "key": ["崖壁栈道", "矿口", "索桥"], "terrain_idea": "一条深峡谷", "org": "峡谷 + 线性"},
        {"name": "地宫院落", "concept": "地面是轴线院落，正殿下面压着迷宫般的地宫", "frags": ["axial_court", "maze_space"], "palette": "stone", "rename": {"地下迷宫": "地宫迷宫"},
         "mood": ["庄严", "幽深"], "key": ["门楼", "正殿", "地宫迷宫"], "terrain_idea": "平地", "org": "轴线 + 地下"},
    ]),
    (("城堡", "要塞", "堡"), [
        {"dir": "up", "name": "崖顶城堡", "concept": "孤崖顶上的主堡，城墙一圈，崖道盘上去", "frags": ["cliff_keep", "wall_gate"], "palette": "stone", "mood": ["坚固", "孤高"],
         "key": ["主堡", "城墙", "门楼"], "terrain_idea": "一座孤崖", "org": "垂直 + 围合"},
        {"auto": True, "name": "环堡", "concept": "一圈环形城墙围着中央主堡，四座角楼", "key": ["主堡", "环形城墙", "四座角楼"], "terrain_idea": "平地", "org": "环形 + 围合"},
        {"name": "湖心水城", "concept": "湖心岛上一座城，曲桥是唯一的路", "frags": ["lake_isle", "wall_gate"], "palette": "stone", "rename": {"湖心阁": "水城主楼"},
         "mood": ["静", "孤"], "key": ["湖", "水城主楼", "城墙", "曲桥"], "terrain_idea": "一片湖", "org": "水上 + 围合"},
        {"name": "轴线宫城", "concept": "门楼、前院、正殿排在一条中轴上，两侧配殿对称", "frags": ["axial_court"], "palette": "stone", "mood": ["庄严", "对称"],
         "key": ["门楼", "前院", "正殿", "配殿"], "terrain_idea": "平地", "org": "轴线 + 围合"},
    ]),
]
DEFAULT_RECIPES = [
    {"name": "轴线{s}", "concept": "{s}沿一条中轴展开：门楼、前院、正殿依次排开，两侧对称", "frags": ["axial_court"], "palette": "stone", "mood": ["庄严", "对称"],
     "key": ["门楼", "前院", "正殿", "配殿"], "terrain_idea": "平地", "org": "轴线 + 围合"},
    {"dir": "up", "name": "浮空{s}", "concept": "{s}散在几座浮岛上，光桥把它们连成一圈", "frags": ["sky_islands"], "palette": "garden", "mood": ["空灵", "奇幻"],
     "key": ["浮岛", "光桥"], "terrain_idea": "地面低平", "org": "悬空 + 环形"},
    {"name": "峡谷{s}", "concept": "{s}挂在一条峡谷的崖壁上，栈道和索桥串起来", "frags": ["canyon_walk"], "ground": "canyon", "palette": "stone", "mood": ["险峻", "幽深"],
     "key": ["峡谷", "崖壁栈道", "索桥"], "terrain_idea": "一条深峡谷", "org": "峡谷 + 线性"},
    {"name": "湖心{s}", "concept": "{s}立在湖心小岛上，曲桥连岸", "frags": ["lake_isle"], "palette": "garden", "mood": ["宁静"], "key": ["湖", "湖心阁", "曲桥"],
     "terrain_idea": "一片湖", "org": "水上 + 环形"},
]
