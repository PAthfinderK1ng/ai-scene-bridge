# -*- coding: utf-8 -*-
"""
rules.py — 本地锁定：从人的那句话里读出说死的条件，写死到三张 plan 上（不花钱、不靠模型自觉）

draft 与 revise 都锁；补上的元素只用相对放置，没有坐标。依赖 plans.py。
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)



from plans import (
    LIST_GROUPS,
    ONE_GROUPS,
    apply_ops,
    check_ops,
    clamp,
    field_schema,
    index,
    item_schema,
    new_id,
    plan_schema,
    strip_extra,
)  # noqa: F401

# ============================================================ 3. 本地锁定（不花钱、不靠模型自觉）
CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
CLAUSE = re.compile(r"[^，,。；;！!？?\n]+")
REMOVE_WORDS = ("去掉", "删掉", "删除", "拿掉", "不要", "取消", "拆掉", "移除")

TIME_WORDS = [
    (("黄昏", "傍晚", "日落", "夕阳"), "dusk"),
    (("夜里", "夜晚", "晚上", "深夜", "夜景", "亮灯", "灯火", "夜"), "night"),
    (("清晨", "早晨", "晨雾", "一早", "早上"), "morning"),
    (("正午", "中午"), "noon"),
    (("下午", "午后"), "afternoon"),
    (("黎明", "拂晓", "破晓"), "dawn"),
    (("阴天", "阴雨", "下雨", "雨天", "多云"), "overcast"),
]
TIME_CN = {"dusk": "黄昏", "night": "夜里", "morning": "清晨", "noon": "正午", "afternoon": "午后", "dawn": "黎明", "overcast": "阴天"}

# 地标词（开放：句子里点了名的都要有同名 landmark）。(词, form, id, size_m[宽, 高, 深])，长词在前
LANDMARK_LEX = [
    ("风雨桥", "bridge", "wind_bridge", [24, 8, 6]), ("廊桥", "bridge", "covered_bridge", [22, 7, 5]),
    ("寨门", "gate", "gate", [8, 7, 3]), ("牌坊", "gate", "paifang", [8, 8, 2]), ("牌楼", "gate", "pailou", [8, 8, 2]), ("山门", "gate", "shanmen", [10, 8, 4]),
    ("鼓楼", "tower", "drum_tower", [8, 16, 8]), ("钟楼", "tower", "bell_tower", [7, 14, 7]), ("宝塔", "tower", "pagoda", [7, 22, 7]),
    ("白塔", "tower", "white_pagoda", [7, 20, 7]), ("石塔", "tower", "stone_pagoda", [5, 14, 5]), ("塔", "tower", "pagoda", [7, 20, 7]),
    ("戏台", "stage", "stage", [10, 7, 8]), ("水车", "custom", "waterwheel", [7, 8, 3]),
    ("寺庙", "hall", "temple", [16, 10, 14]), ("古寺", "hall", "temple", [16, 10, 14]), ("寺", "hall", "temple", [16, 10, 14]),
    ("祠堂", "hall", "ancestral_hall", [14, 9, 12]), ("小庙", "hall", "shrine", [8, 7, 8]), ("庙", "hall", "shrine", [10, 8, 9]),
    ("大树", "tree", "big_tree", [12, 16, 12]), ("古树", "tree", "old_tree", [12, 16, 12]), ("老树", "tree", "old_tree", [12, 15, 12]),
    ("榕树", "tree", "banyan", [16, 14, 16]), ("银杏", "tree", "ginkgo", [10, 18, 10]), ("神木", "tree", "sacred_tree", [14, 20, 14]),
    ("凉亭", "pavilion", "pavilion", [6, 6, 6]), ("亭子", "pavilion", "pavilion", [6, 6, 6]),
    ("古井", "well", "old_well", [3, 2, 3]), ("水井", "well", "well", [3, 2, 3]),
    ("石像", "statue", "statue", [3, 6, 3]), ("雕像", "statue", "statue", [3, 6, 3]), ("城墙", "wall", "city_wall", [40, 8, 4]),
]
# 放置词 → 放置类（只认和地标同一小句里的）
PLACE_LEX = [
    (("崖边", "临崖", "悬崖边", "崖上", "崖顶", "崖头"), "cliff"),
    (("山顶", "顶上", "最顶", "最高处", "山尖", "顶层"), "top"),
    (("村口", "寨口", "入口处", "进村处", "路口"), "entry"),
    (("广场边", "广场上", "广场中", "广场中央", "广场"), "plaza"),
    (("溪上", "溪边", "河边", "河上", "跨溪", "水边", "溪谷上"), "water"),
    (("尽头",), "end"),
]
TERRAIN_LEX = [
    (("环台", "一圈圈", "一圈一圈", "环形", "围成一圈", "围着广场", "绕着广场"), "ring_terraces", "环台"),
    (("之字", "折返"), "slope_terraces", "之字"),
    (("层层叠叠", "叠落", "台地", "梯级"), "slope_terraces", "台地"),
    (("两岸", "溪谷", "峡谷", "河谷", "山谷", "谷底"), "valley", "谷"),
    (("悬崖", "崖边", "峭壁", "陡崖", "临崖", "崖上", "崖顶"), "cliff", "崖"),
    (("山脊", "山梁"), "ridge", "山脊"),
    (("盆地",), "basin", "盆地"),
    (("天坑",), "pit", "天坑"),
    (("孤岛", "岛上", "小岛", "湖心岛", "海岛"), "island", "岛"),
]
BUILDING_LEX = [
    (("吊脚木楼", "吊脚楼"), "stilt_house", "stilt", [6, 7, 5]),
    (("土楼", "圆楼", "围屋"), "round_house", "round_house", [26, 12, 26]),
    (("四合院", "合院", "院落"), "courtyard", "courtyard", [16, 6, 16]),
    (("木楼", "木屋", "石屋", "瓦房", "竹楼"), "house", "house", [7, 6, 6]),
]
ZONE_LEX = [
    (("梯田",), "terrace_farm"), (("农田", "菜地", "稻田"), "farm"), (("集市", "市场", "市集"), "market"),
    (("码头",), "dock"), (("竹林", "树林", "林子", "森林"), "forest"), (("废墟", "遗迹"), "ruins"), (("广场",), "plaza"),
]
# 空间词：(词, stratum, layout, 可接受的 layout, id)
SPACE_LEX = [
    (("矿洞", "矿井", "矿道", "矿坑"), "underground", "galleries", ("galleries",), "mine"),
    (("地宫", "墓室", "古墓", "陵墓"), "underground", "halls", ("halls", "rooms"), "crypt"),
    (("溶洞", "洞穴", "山洞"), "underground", "network", ("network",), "cave"),
    (("地道", "暗道", "隧道"), "underground", "corridor", ("corridor",), "tunnel"),
    (("地窖", "地下室"), "underground", "chamber", ("chamber", "rooms"), "cellar"),
    (("栈道",), "sky", "corridor", ("corridor", "network"), "walkway"),
    (("浮岛", "空岛", "浮空岛"), "sky", "network", ("network", "chamber"), "islands"),
    (("天桥", "飞桥", "空中走廊"), "sky", "corridor", ("corridor",), "skybridge"),
    (("空中平台", "悬空平台"), "sky", "chamber", ("chamber",), "platform"),
]
CONNECT_LEX = [(("竖井",), "shaft"), (("井",), "well"), (("梯子", "爬梯"), "ladder"), (("索桥", "吊桥"), "rope_bridge"),
               (("坡道",), "ramp"), (("升降", "电梯"), "elevator"), (("楼梯", "台阶", "石阶下"), "stairs")]
ENTRY_LEX = [
    (("东边进", "从东", "东侧进", "东边入口", "东侧入口", "东门", "东边上来"), "E"),
    (("西边进", "从西", "西侧进", "西边入口", "西侧入口", "西门", "西边上来"), "W"),
    (("南边进", "从南", "南侧进", "南边入口", "南侧入口", "南门", "南边上来"), "S"),
    (("北边进", "从北", "北侧进", "北边入口", "北侧入口", "北门", "北边上来"), "N"),
]
SIDE_CN = {"E": "东", "W": "西", "S": "南", "N": "北"}
LAYOUT_CN = {"chamber": "单室", "corridor": "地道", "maze": "迷宫", "galleries": "矿道", "halls": "厅堂", "network": "洞穴网", "rooms": "房间"}


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


def _is_entry_route(text: str, i: int, w: str) -> bool:
    """「从村口进 / 村口进去」说的是从哪进，不是地标放哪"""
    return text[max(0, i - 1):i] == "从" or text[i + len(w):i + len(w) + 1] == "进"


def extract(text: str) -> dict:
    """一句话 → 说死的条件（没提到的不出现）"""
    t = (text or "").strip()
    c: dict = {}
    tod = _first(t, TIME_WORDS)
    if tod:
        c["time_of_day"] = tod
    plain = re.sub("天桥|空中桥|飞桥|索桥|吊桥", "", t)
    if any(w in t for w in ("没有溪", "无溪", "不要溪", "没溪", "没有河")):
        c["stream"] = False
    elif any(w in t for w in ("溪", "河", "水车", "两岸")) or "桥" in plain:
        c["stream"] = True
    # 地标
    lms = []
    lm_words = [x[0] for x in LANDMARK_LEX]
    for i, w in _scan(t, lm_words):
        if w in ("塔",) and t[i:i + 2] in ("塔楼",):
            pass
        form, lid, size = next((f, d, s) for ww, f, d, s in LANDMARK_LEX if ww == w)
        cl = _clause_at(t, i)
        place = None
        for words, kind in PLACE_LEX:
            for pw in words:
                j = cl.find(pw)
                if j >= 0 and not (kind == "entry" and _is_entry_route(cl, j, pw)):
                    place = place or kind
        if not any(x["word"] == w for x in lms):
            lms.append({"word": w, "form": form, "id": lid, "size_m": size, "place": place})
    if lms:
        c["landmarks"] = lms
    # 地形
    terr = []
    no_cliff_words = re.sub("陡峭", "", t)
    for words, typ, cn in TERRAIN_LEX:
        if any(w in no_cliff_words for w in words) and typ not in [x["type"] for x in terr]:
            terr.append({"type": typ, "word": next(w for w in words if w in no_cliff_words), "cn": cn})
    if any(x.get("place") == "cliff" for x in lms) and "cliff" not in [x["type"] for x in terr]:
        terr.append({"type": "cliff", "word": "崖", "cn": "崖"})
    if terr:
        c["terrain"] = terr
    if any(w in t for w in ("之字", "折返")):
        c["zigzag"] = True
    # 建筑类型 / 区域
    bl = []
    for words, form, bid, size in BUILDING_LEX:
        hit = next((w for w in words if w in t), None)
        if hit and not any(b["form"] == form for b in bl) and not any(hit in b["word"] for b in bl):
            bl.append({"word": hit, "form": form, "id": bid, "size_m": size})
    if bl:
        c["buildings"] = bl
    zs = [{"word": next(w for w in words if w in t), "use": use} for words, use in ZONE_LEX if any(w in t for w in words)]
    if zs:
        c["zones"] = zs
    # 空间
    sp = []
    for words, stratum, layout, ok, sid in SPACE_LEX:
        for w in words:
            i = t.find(w)
            if i >= 0:
                sp.append({"word": w, "stratum": stratum, "layout": layout, "accept": list(ok), "id": sid, "at": i})
                break
    if "迷宫" in t:
        i = t.find("迷宫")
        under = [x for x in sp if x["stratum"] == "underground"]
        host = min(under, key=lambda x: abs(x["at"] - i)) if under else None
        if host:
            host.update(layout="maze", accept=["maze"])
        else:
            sky = "空中" in t or "天上" in t  # 天上没有迷宫布局（engine/interior.js）：用岔路多的平台群
            sp.append({"word": "迷宫", "stratum": "sky" if sky else "underground", "layout": "network" if sky else "maze", "accept": ["network"] if sky else ["maze"], "id": "maze", "at": i}
                      | ({"branching": "high"} if sky else {}))
    if not sp and any(w in t for w in ("地下", "地底")):
        sp.append({"word": "地下", "stratum": "underground", "layout": "chamber", "accept": list(LAYOUT_CN), "id": "underground", "at": t.find("地下")})
    elif not sp and any(w in t for w in ("空中", "天上")):
        sp.append({"word": "空中", "stratum": "sky", "layout": "chamber", "accept": list(LAYOUT_CN), "id": "sky", "at": t.find("空中")})
    space_words = [x["word"] for x in sp] + (["迷宫"] if "迷宫" in t else [])
    # 层数：和空间词同一小句 → 空间内部层数；后面跟着楼 / 房 → 建筑层数（不锁）；否则 → 场地总高差
    for m in re.finditer(r"([一二两三四五六七八九十]|\d{1,2})\s*层", t):
        n = _num(m.group(1))
        cl = _clause_at(t, m.start())
        tail = t[m.end():m.end() + 3]
        if any(w in cl for w in space_words) and sp:
            host = min(sp, key=lambda x: abs(x["at"] - m.start()))
            host["sublevels"] = n
        elif re.match(r"的?(吊脚|木楼|楼|房|屋|塔|阁)", tail):
            continue
        else:
            c["relief_layers"] = n
    if "relief_layers" not in c:
        if any(w in t for w in ("小村", "小山村", "小寨", "几户", "很小")):
            c["relief_range"] = (3, 4)
        elif any(w in t for w in ("大寨", "大山城", "大村", "很大的", "会迷路")):
            c["relief_range"] = (6, 9)
    for x in sp:
        cl = _clause_at(t, x["at"])
        if any(w in t for w in ("岔路多", "很绕", "绕来绕去", "复杂的迷宫", "岔路很多")):
            x["branching"] = "high"
        elif any(w in t for w in ("岔路少", "简单的迷宫")):
            x["branching"] = "low"
        conn = _first(re.sub("矿井", "", t), CONNECT_LEX)
        if conn:
            x["connect"] = conn
        m = re.search(r"([一-龥]{1,4}?)(下面|下方|底下|之下|下)(有|是|藏|藏着)", t)
        if m and x["stratum"] == "underground":
            lw = next((w for w in lm_words if w in m.group(1)), None)
            if lw:
                x["under_word"] = lw
        rooms = rooms_from_text(t)
        if rooms and x["layout"] in ("halls", "rooms", "chamber"):
            x["rooms"] = rooms
        x.pop("at", None)
    if sp:
        c["spaces"] = sp
    else:
        c["no_spaces"] = True
    # 坡度 / 入口
    s2 = re.sub("陡崖|陡峭的崖", "", t)
    if any(w in s2 for w in ("很陡", "陡峭", "非常陡", "特别陡")):
        c["layer_range"] = (4.5, 6.0)
    elif "陡" in s2:
        c["layer_range"] = (4.0, 6.0)
    elif any(w in t for w in ("很缓", "平缓", "缓坡", "不陡", "缓")):
        c["layer_range"] = (2.5, 3.0)
    ent = _first(t, ENTRY_LEX)
    if ent:
        c["entry_side"] = ent
    return c


def rooms_from_text(text: str) -> dict | None:
    """「前厅—甬道—主墓室，两侧耳室」→ {rooms, links}（给 rooms 布局；模拟 AI 与锁定都用）"""
    m = re.search(r"([一-龥]{1,5}(?:\s*[—\-→]+\s*[一-龥]{1,5})+)", text)
    if not m:
        return None
    names = [x for x in re.split(r"\s*[—\-→]+\s*", m.group(1)) if x]
    names[0] = re.sub(r"^.*?(有|是)", "", names[0]) or names[0]
    ids = {"前厅": "front", "甬道": "passage", "主墓室": "main_hall", "主厅": "main_hall", "后室": "back", "墓室": "tomb", "大厅": "hall", "耳室": "side"}
    rooms, links, prev = [], [], "entry"
    used: set = set()
    for k, nm in enumerate(names):
        rid = ids.get(nm, f"r{k + 1}")
        while rid in used:
            rid += "_b"
        used.add(rid)
        size = "l" if ("主" in nm or "大" in nm) else "s" if ("道" in nm or "耳" in nm) else "m"
        rooms.append({"id": rid, "label": nm, "size": size})
        links.append([prev, rid])
        prev = rid
    side = re.search(r"两侧([一-龥]{1,4})", text)
    if side:
        nm = side.group(1)
        hub = next((r["id"] for r in rooms if "主" in r["label"]), rooms[-1]["id"])
        for sfx, cn in (("l", "左"), ("r", "右")):
            rooms.append({"id": f"side_{sfx}", "label": cn + nm, "size": "s"})
            links.append([hub, f"side_{sfx}"])
    return {"rooms": rooms, "links": links}


def summary(c: dict) -> list[str]:
    """条件 → 给人看的短语（界面上「按你的话锁定了：…」）"""
    out = []
    for x in c.get("terrain", []):
        out.append(x["cn"])
    if "relief_layers" in c:
        out.append(f"{c['relief_layers']} 层高差")
    if "relief_range" in c:
        out.append(f"{c['relief_range'][0]}–{c['relief_range'][1]} 层")
    if "layer_range" in c:
        out.append("陡" if c["layer_range"][0] >= 4 else "缓")
    for b in c.get("buildings", []):
        out.append(b["word"])
    place_cn = {"cliff": "在崖边", "top": "在顶上", "entry": "在入口", "plaza": "在广场", "water": "在溪上", "end": "在尽头"}
    for x in c.get("landmarks", []):
        out.append(x["word"] + place_cn.get(x.get("place"), ""))
    for z in c.get("zones", []):
        if z["use"] != "plaza" or not any(x.get("place") == "plaza" for x in c.get("landmarks", [])):
            out.append(z["word"])
    if "entry_side" in c:
        out.append(SIDE_CN[c["entry_side"]] + "边进")
    if c.get("stream") is True:
        out.append("有溪")
    if c.get("stream") is False:
        out.append("无溪")
    if "time_of_day" in c:
        out.append(TIME_CN[c["time_of_day"]])
    for s in c.get("spaces", []):
        bits = [s["word"] if s["word"] != "迷宫" else ("空中迷宫" if s["stratum"] == "sky" else "地下迷宫")]
        if s["layout"] == "maze" and s["word"] != "迷宫":
            bits.append("迷宫")
        if s.get("sublevels"):
            bits.append(f"{s['sublevels']} 层")
        if s.get("rooms"):
            bits.append("—".join(r["label"] for r in s["rooms"]["rooms"] if not r["id"].startswith("side_")))
        out.append(" · ".join(bits))
    return out


def hint(c: dict) -> str:
    s = summary(c)
    return ("（程序从这句话里读出的硬条件，三张都必须有，差异放在别处：" + "、".join(s) + "）") if s else ""


# ---------- 默认元素（锁定补上 / 模拟 AI 用）。只有相对放置，没有坐标。
TERRAIN_DEFAULT = {
    "hill": {"label": "主山", "at": {"of": "site", "dir": "N", "dist": 0.2}, "size_m": [110, 90], "top_layer": 5},
    "ridge": {"label": "山脊", "at": {"of": "site", "dir": "N", "dist": 0.3}, "size_m": [120, 40], "top_layer": 5},
    "slope_terraces": {"label": "台地", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [100, 80], "steps": 5, "from_layer": 0},
    "ring_terraces": {"label": "环台", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [100, 100], "steps": 4, "from_layer": 1, "width_m": 9},
    "plateau": {"label": "平台", "at": {"of": "site", "dir": "C", "dist": 0.3}, "size_m": [26, 20], "layer": 2},
    "cliff": {"label": "崖", "at": {"of": "site", "dir": "E", "dist": 0.7}, "size_m": [60, 8], "layer": 4},
    "valley": {"label": "溪谷", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [140, 26], "depth_layers": 2},
    "basin": {"label": "盆地", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [80, 80], "depth_layers": 1},
    "pit": {"label": "天坑", "at": {"of": "site", "dir": "C", "dist": 0.3}, "size_m": [30, 30], "depth_layers": 3},
    "island": {"label": "岛", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [60, 60], "layer": 3},
}


def _fit(group: str, el: dict) -> dict:
    """默认元素按当前 schema 修一遍：去掉 schema 里没有的字段、夹取范围（schema 字段名有出入时不至于产出不合法的东西）"""
    sch = item_schema(group)
    el = copy.deepcopy(el)
    strip_extra(sch, el, "$", plan_schema())
    return clamp(sch, el, "$", plan_schema(), [])


def _terrain_of(plan: dict, *types: str) -> list:
    return [t for t in plan.get("terrain") or [] if t.get("type") in types]


def _highest(plan: dict) -> str:
    """最适合「顶上」的地形块：山 / 山脊 / 岛 / 平台 / 环台 / 台地；都没有就是场地"""
    for types in (("hill", "ridge"), ("island", "plateau"), ("ring_terraces", "slope_terraces"), ("cliff",)):
        hits = _terrain_of(plan, *types)
        if hits:
            return max(hits, key=lambda t: t.get("top_layer") or t.get("layer") or t.get("steps") or 0)["id"]
    return "site"


def _stream_id(plan: dict) -> str | None:
    """溪或河（人说「溪」时河也算）"""
    return next((w["id"] for w in plan.get("water") or [] if w.get("type") in ("stream", "river") and w.get("id")), None)


def _place_for(plan: dict, kind: str | None, form: str) -> dict:
    """放置类 → place（相对关系）。kind=None 时按 form 给默认位置。"""
    plaza = next((z["id"] for z in plan.get("zones") or [] if z.get("use") == "plaza"), None) or (_terrain_of(plan, "plateau") or [{}])[0].get("id")
    if kind is None:
        kind = {"gate": "entry", "bridge": "water", "custom": "water", "stage": "plaza", "tree": "entry", "well": "plaza", "statue": "plaza", "pavilion": "top"}.get(form, "top")
        if kind == "water" and not _stream_id(plan):
            kind = "top"
        if kind == "plaza" and not plaza:
            kind = "top"
    if kind == "cliff":
        cl = _terrain_of(plan, "cliff")
        return {"rel": "edge_of", "target": cl[0]["id"] if cl else _highest(plan), "facing": "spawn"}
    if kind == "entry":
        return {"rel": "at_entry", "target": "site"}
    if kind == "plaza" and plaza:
        return {"rel": "center_of", "target": plaza}
    if kind == "water" and _stream_id(plan):
        return {"rel": "along", "target": _stream_id(plan)}
    if kind == "end":
        main = (plan.get("paths") or [{}])[0].get("id")
        return {"rel": "end_of", "target": main or _highest(plan)}
    return {"rel": "top_of", "target": _highest(plan)}


def _place_ok(plan: dict, place: dict, kind: str) -> bool:
    """模型给的放置是否满足人说的位置"""
    if not isinstance(place, dict):
        return False
    rel, tgt = place.get("rel"), place.get("target")
    tgt_el = index(plan).get(tgt, (None, {}))[1] if isinstance(tgt, str) else {}
    ttype = (tgt_el or {}).get("type")
    if kind == "cliff":
        return rel in ("edge_of", "top_of") and ttype == "cliff"
    if kind == "top":
        return rel in ("top_of", "center_of") and ttype in ("hill", "ridge", "island", "plateau", "ring_terraces", "slope_terraces")
    if kind == "entry":
        return rel == "at_entry" or (rel in ("beside", "edge_of") and tgt == "spawn")
    if kind == "plaza":
        return rel in ("center_of", "edge_of", "beside") and ((tgt_el or {}).get("use") == "plaza" or ttype == "plateau")
    if kind == "water":
        return rel in ("along", "beside", "between", "center_of") and (tgt_el or {}).get("type") in ("stream", "river", "pond", "lake", "valley")
    if kind == "end":
        return rel == "end_of"
    return True


def default_space(plan: dict, spec: dict) -> dict:
    under = None
    if spec.get("under_word"):
        under = next((x["id"] for x in plan.get("landmarks") or [] if spec["under_word"] in (x.get("label") or "")), None)
    under = under or ((plan.get("landmarks") or [{}])[0].get("id") if spec["stratum"] == "underground" else None) or _highest(plan)
    label = spec["word"] if spec["layout"] != "maze" or spec["word"] == "迷宫" else spec["word"] + "迷宫"
    if spec["word"] == "迷宫":
        label = "地下迷宫" if spec["stratum"] == "underground" else "空中迷宫"
    sp = {"id": new_id(plan, spec.get("id") or "space"), "stratum": spec["stratum"], "label": label,
          "layout": spec["layout"], "size_m": 44 if spec["layout"] in ("maze", "galleries", "network") else 30,
          "branching": spec.get("branching") or ("high" if spec["layout"] == "maze" else "medium"), "sublevels": spec.get("sublevels") or 1,
          "corridor_m": 2.5 if spec["layout"] == "maze" else 3,
          "connect": {"via": spec.get("connect") or ("stairs" if spec["stratum"] == "underground" else "ladder"), "from": under}}
    if spec["stratum"] == "underground":
        sp.update(under=under, depth_layers=2 + (1 if (spec.get("sublevels") or 1) > 1 else 0))
    else:
        sp.update(over=under, height_layers=3)
    if spec.get("rooms") and spec["layout"] in ("halls", "rooms", "chamber"):
        sp.update(layout="rooms", rooms=spec["rooms"]["rooms"], links=spec["rooms"]["links"])
    return _fit("spaces", sp)


def default_landmark(plan: dict, spec: dict) -> dict:
    return _fit("landmarks", {"id": new_id(plan, spec["id"]), "label": spec["word"], "form": spec["form"], "size_m": list(spec["size_m"]),
                              "place": _place_for(plan, spec.get("place"), spec["form"])})


def default_terrain(plan: dict, typ: str, label: str | None = None) -> dict:
    xd = (plan_schema().get("x-defaults") or {}).get("terrain", {}).get(typ) or {}
    d = {**copy.deepcopy(TERRAIN_DEFAULT.get(typ) or TERRAIN_DEFAULT["plateau"]), **{k: v for k, v in xd.items() if k != "label"}}
    if typ == "cliff":
        d["at"] = {"of": _highest(plan) if _highest(plan) != "site" else "site", "dir": "E", "dist": 0.8}
    elif plan.get("terrain"):  # 场地上已经有地形块：挑一块空地放，不压在别人身上
        d["at"], d["size_m"] = _free_at(plan, typ, _size_of(plan, {"type": typ, "size_m": d.get("size_m")}))
    if label:
        d["label"] = label
    return _fit("terrain", {"id": new_id(plan, typ), "type": typ, **d})


_DIRV = {"C": (0.0, 0.0), "N": (0.0, -1.0), "NE": (0.7071, -0.7071), "E": (1.0, 0.0), "SE": (0.7071, 0.7071),
         "S": (0.0, 1.0), "SW": (-0.7071, 0.7071), "W": (-1.0, 0.0), "NW": (-0.7071, -0.7071)}


def _size_of(plan: dict, t: dict) -> list:
    S = float((plan.get("site") or {}).get("size_m") or 140)
    xd = ((plan_schema().get("x-defaults") or {}).get("terrain") or {}).get(t.get("type")) or {}
    sz = t.get("size_m") or xd.get("size_m") or (TERRAIN_DEFAULT.get(t.get("type")) or {}).get("size_m") or [S * 0.6, S * 0.6]
    return [min(float(sz[0]), S), min(float(sz[1]), S)]


def _blobs(plan: dict) -> dict:
    """地形块的粗略占地（圆：中心 + 等面积半径 + 外伸半径），只用来给锁定补的地形挑空地；和引擎一样按 at 链从场地中心推出去。"""
    S = float((plan.get("site") or {}).get("size_m") or 140)
    half = S / 2
    terr = {t["id"]: t for t in plan.get("terrain") or [] if isinstance(t, dict) and isinstance(t.get("id"), str)}
    out: dict = {}

    def get(tid: str, depth: int = 0):
        if tid in out:
            return out[tid]
        t = terr.get(tid)
        if not t or depth > 8:
            return (0.0, 0.0), half, half
        out[tid] = ((0.0, 0.0), 0.0, 0.0)  # 防环
        at = t.get("at") or {}
        of = at.get("of") or "site"
        oc, _, oreach = get(of, depth + 1) if of in terr else ((0.0, 0.0), half, half)
        d = at.get("dir") or "C"
        u = _DIRV.get(d, (0.0, 0.0))
        dist = float(at.get("dist", 0 if d == "C" else 0.5) or 0)
        c = (oc[0] + u[0] * dist * oreach, oc[1] + u[1] * dist * oreach)
        c = (max(-half, min(half, c[0])), max(-half, min(half, c[1])))
        a, b = (x / 2 for x in _size_of(plan, t))
        out[tid] = (c, (a * b) ** 0.5, (a + b) / 2)
        return out[tid]
    for tid in terr:
        get(tid)
    return out


def _free_at(plan: dict, typ: str, size: list) -> tuple[dict, list]:
    """锁定补的地形块放哪：场地上和已有地形块压得最少的方位（不行就缩到 0.65 倍）。返回 (at, size_m)。只有相对位置，没有坐标。"""
    S = float((plan.get("site") or {}).get("size_m") or 140)
    half = S / 2
    blobs = list(_blobs(plan).values())
    a, b = size[0] / 2, size[1] / 2
    best = None
    order = 0
    for scale in (1.0, 0.8, 0.65):
        r = (a * b) ** 0.5 * scale
        for d, dists in (("C", (0,)), *((k, (0.55, 0.7)) for k in ("N", "S", "E", "W", "NE", "NW", "SE", "SW"))):
            for dist in dists:
                order += 1
                u = _DIRV[d]
                c = (u[0] * dist * half, u[1] * dist * half)
                if max(abs(c[0]), abs(c[1])) + 0.8 * r > half:
                    continue
                hit = sum(max(0.0, r + br - ((c[0] - bc[0]) ** 2 + (c[1] - bc[1]) ** 2) ** 0.5) / max(1.0, min(r, br)) for bc, br, _ in blobs)
                score = hit + (1 - scale) * 0.6 + order * 1e-4
                if best is None or score < best[0]:
                    best = (score, {"of": "site", "dir": d, "dist": dist}, [round(size[0] * scale), round(size[1] * scale)])
    if best is None:
        return {"of": "site", "dir": "C", "dist": 0}, size
    return best[1], best[2]


TERRACE_TYPES = ("ring_terraces", "slope_terraces")


def _convert_terrace(p: dict, typ: str, keep_ids: set, prefer_building: str | None = None) -> dict | None:
    """要环台却只有坡上台地（或反过来）：把住人的那块台地换成要的那种（不另外叠一块）。返回换掉的那块。"""
    other = "slope_terraces" if typ == "ring_terraces" else "ring_terraces"
    cand = [t for t in _terrain_of(p, other) if t.get("id") not in keep_ids]
    if not cand:
        return None
    zones = [z for z in p.get("zones") or [] if z.get("use") == "housing"]
    on_with = {z.get("on") for z in zones if prefer_building and z.get("building") == prefer_building}
    on_any = {z.get("on") for z in zones}
    t = next((t for t in cand if t["id"] in on_with), None) or next((t for t in cand if t["id"] in on_any), None)
    if not t:
        return None
    t["type"] = typ
    for k in ("orient", "inverse", "width_m"):
        t.pop(k, None)
    lab = t.get("label") or ""
    want, drop = ("环台", ("坡上台地", "台地", "台阶", "梯级")) if typ == "ring_terraces" else ("台地", ("环台",))
    hit = next((w for w in drop if w in lab), None)
    t["label"] = (lab.replace(hit, want) if hit else (lab + want if lab else want))[:10]
    fitted = _fit("terrain", t)
    t.clear()
    t.update(fitted)
    return t


def default_stream(plan: dict) -> dict:
    v = _terrain_of(plan, "valley")
    if v:
        return _fit("water", {"id": new_id(plan, "stream"), "type": "stream", "label": "溪", "from": {"of": v[0]["id"], "dir": "N", "dist": 0.9}, "to": {"of": v[0]["id"], "dir": "S", "dist": 0.9}})
    return _fit("water", {"id": new_id(plan, "stream"), "type": "stream", "label": "溪", "from": {"of": "site", "dir": "N", "dist": 0.9}, "to": {"of": "site", "dir": "S", "dist": 0.9}})


def _range_of(group: str, field: str, lo: float, hi: float) -> tuple[float, float]:
    """锁定区间和 schema 范围取交集（schema 是准绳）"""
    s = field_schema(group, field) or {}
    return max(lo, s.get("minimum", lo)), min(hi, s.get("maximum", hi))


def enforce(plan: dict, c: dict, keep_ids: set | None = None) -> tuple[dict, list[str]]:
    """把条件写死到一张 plan 上；返回 (新 plan, 改了什么)。keep_ids 是人锁住的项（不动它们）。只改结构，不涉及坐标。"""
    p = copy.deepcopy(plan)
    ch: list[str] = []
    keep_ids = keep_ids or set()
    if "time_of_day" in c and (p.get("lighting") or {}).get("time_of_day") != c["time_of_day"]:
        p.setdefault("lighting", {})["time_of_day"] = c["time_of_day"]
        ch.append("时段")
    site = p.setdefault("site", {})
    if "relief_layers" in c:
        lo, hi = _range_of("site", "relief_layers", c["relief_layers"], c["relief_layers"])
        if site.get("relief_layers") != int(lo):
            site["relief_layers"] = int(lo)
            ch.append("层数")
    elif "relief_range" in c:
        lo, hi = _range_of("site", "relief_layers", *c["relief_range"])
        n = site.get("relief_layers") or lo
        if not lo <= n <= hi:
            site["relief_layers"] = int(max(lo, min(hi, n)))
            ch.append("层数")
    if "layer_range" in c:
        lo, hi = _range_of("site", "layer_m", *c["layer_range"])
        v = site.get("layer_m") or 3.5
        if not lo <= v <= hi:
            site["layer_m"] = round(max(lo, min(hi, v)), 1)
            ch.append("坡度")
    # 地形词：同类地形块已经有就算满足；环台 / 坡上台地互换住人的那块；都没有才找空地补一块
    lock_bld = next((x["id"] for b in c.get("buildings", []) for x in p.get("buildings") or [] if b["word"] in (x.get("label") or "")), None)
    added_terraces: list = []
    for x in c.get("terrain", []):
        if not _terrain_of(p, x["type"]):
            conv = _convert_terrace(p, x["type"], keep_ids, lock_bld) if x["type"] in TERRACE_TYPES else None
            if conv:
                ch.append(f"{conv['label']}改成{x['cn']}")
                continue
            t = default_terrain(p, x["type"], {"cliff": "崖", "valley": "溪谷"}.get(x["type"]))
            p.setdefault("terrain", []).append(t)
            if x["type"] in TERRACE_TYPES:
                added_terraces.append(t["id"])
            ch.append(f"地形·{x['cn']}")
    # 溪
    if c.get("stream") is True and not _stream_id(p):
        p.setdefault("water", []).append(default_stream(p))
        ch.append("溪")
    elif c.get("stream") is False and _stream_id(p):
        gone = {w["id"] for w in p.get("water") or [] if w.get("type") in ("stream", "river") and w.get("id") not in keep_ids}
        p["water"] = [w for w in p.get("water") or [] if w.get("id") not in gone]
        drop_refs(p, gone)
        ch.append("去掉溪")
    # 建筑类型（吊脚木楼 …）：要有、且至少一个住宅区在用它
    for b in c.get("buildings", []):
        have = next((x for x in p.get("buildings") or [] if b["word"] in (x.get("label") or "")), None)
        if not have:
            same = next((x for x in p.get("buildings") or [] if x.get("form") == b["form"] and x.get("id") not in keep_ids), None)
            if same:
                same["label"] = b["word"]
                have = same
            else:
                have = _fit("buildings", {"id": new_id(p, b["id"]), "label": b["word"], "form": b["form"], "size_m": list(b["size_m"]), "floors": 2, "roof": "gable"})
                p.setdefault("buildings", []).append(have)
            ch.append(f"建筑·{b['word']}")
        if not any(z.get("building") == have["id"] for z in p.get("zones") or []):
            z = next((z for z in p.get("zones") or [] if z.get("use") == "housing" and z.get("id") not in keep_ids), None)
            if z:
                z["building"] = have["id"]
            else:
                on = (_terrain_of(p, "ring_terraces", "slope_terraces") or p.get("terrain") or [{"id": "site"}])[0]["id"]
                p.setdefault("zones", []).append(_fit("zones", {"id": new_id(p, "z_housing"), "label": b["word"] + "群", "use": "housing", "on": on, "levels": "all", "building": have["id"], "density": 1.0}))
            ch.append(f"区域用{b['word']}")
    # 补出来的环台 / 台地上要有人住（「吊脚木楼一圈圈」：楼就在那圈台上）
    for tid in added_terraces:
        if any(z.get("on") == tid for z in p.get("zones") or []):
            continue
        bid = next((x["id"] for b in c.get("buildings", []) for x in p.get("buildings") or [] if b["word"] in (x.get("label") or "")), None) \
            or next((z.get("building") for z in p.get("zones") or [] if z.get("use") == "housing" and z.get("building")), None)
        t = next(x for x in p["terrain"] if x["id"] == tid)
        blab = next((x.get("label") for x in p.get("buildings") or [] if x.get("id") == bid), None) or "人家"
        p.setdefault("zones", []).append(_fit("zones", {"id": new_id(p, "z_" + tid), "label": (t.get("label", "") + blab)[:10], "use": "housing", "on": tid, "levels": "all",
                                                        **({"building": bid} if bid else {}), "density": 0.9}))
        ch.append(f"{t.get('label')}上住人")
    # 区域用途（梯田 / 集市 …）
    for z in c.get("zones", []):
        if not any(x.get("use") == z["use"] for x in p.get("zones") or []):
            if z["use"] == "plaza":
                pl = _terrain_of(p, "plateau")
                on = pl[0]["id"] if pl else None
                if not on:
                    t = _fit("terrain", {"id": new_id(p, "plaza_ground"), "type": "plateau", "label": "广场台", "at": {"of": _highest(p), "dir": "S", "dist": 0.4}, "size_m": [26, 20], "layer": 2})
                    p.setdefault("terrain", []).append(t)
                    on = t["id"]
            else:
                on = (_terrain_of(p, "slope_terraces", "ring_terraces", "valley", "hill") or p.get("terrain") or [{"id": "site"}])[0]["id"]
            p.setdefault("zones", []).append(_fit("zones", {"id": new_id(p, "z_" + z["use"]), "label": z["word"], "use": z["use"], "on": on, "levels": "all" if z["use"] != "plaza" else "all", "density": 0 if z["use"] == "plaza" else 0.8}))
            ch.append(f"区域·{z['word']}")
    # 地标：句子里点名的都要有同名 landmark，说了位置就锁位置
    for x in c.get("landmarks", []):
        lm = next((l for l in p.get("landmarks") or [] if x["word"] in (l.get("label") or "")), None)
        if not lm:
            lm = default_landmark(p, x)
            p.setdefault("landmarks", []).append(lm)
            ch.append(f"地标·{x['word']}")
        elif x.get("place") and lm.get("id") not in keep_ids and not _place_ok(p, lm.get("place"), x["place"]):
            lm["place"] = {**{k: v for k, v in (lm.get("place") or {}).items() if k in ("nudge_m",)}, **_place_for(p, x["place"], lm.get("form") or x["form"])}
            ch.append(f"{x['word']}位置")
    # 入口方向
    if "entry_side" in c:
        sp = p.setdefault("spawn", {})
        pl = sp.get("place") or {}
        if not (pl.get("side") == c["entry_side"] and pl.get("rel") in ("edge_of", "at_entry")):
            sp["place"] = {"rel": "edge_of", "target": "site", "side": c["entry_side"]}
            ch.append("入口方向")
    # 之字：主路走之字
    if c.get("zigzag"):
        paths = p.get("paths") or []
        if paths and paths[0].get("style") != "zigzag" and paths[0].get("id") not in keep_ids:
            paths[0]["style"] = "zigzag"
            ch.append("主路之字")
        elif not paths:
            to = (p.get("landmarks") or [{}])[0].get("id") or _highest(p)
            p["paths"] = [_fit("paths", {"id": "main", "label": "之字石阶", "from": "spawn", "to": to, "style": "zigzag", "width_m": 2.5})]
            ch.append("主路之字")
    # 空间
    if c.get("spaces"):
        claimed: set = set()
        for s in c["spaces"]:
            cand = [x for x in p.get("spaces") or [] if x.get("id") not in claimed]
            hit = next((x for x in cand if s["word"] in (x.get("label") or "")), None)
            if not hit and s["word"] in ("迷宫", "地下", "空中"):
                hit = next((x for x in cand if x.get("stratum") == s["stratum"]), None)
            if not hit:
                hit = default_space(p, s)
                p.setdefault("spaces", []).append(hit)
                ch.append(f"空间·{hit['label']}")
            claimed.add(hit["id"])
            if hit.get("id") in keep_ids:
                continue
            if hit.get("stratum") != s["stratum"]:
                hit["stratum"] = s["stratum"]
                ch.append(f"{hit['label']}·地下/空中")
            # 名字里写着「迷宫」的（模型起的「暗河溶洞迷宫」）：迷宫布局也算数，要改也改成迷宫，名字和平面对得上
            mazy = "迷宫" in (hit.get("label") or "") and hit.get("stratum") == "underground"
            if hit.get("layout") not in s["accept"] and not (mazy and hit.get("layout") == "maze"):
                want = "maze" if mazy else s["layout"]
                hit["layout"] = want
                if want == "rooms" and s.get("rooms"):
                    hit.update(rooms=s["rooms"]["rooms"], links=s["rooms"]["links"])
                ch.append(f"{hit['label']}·{LAYOUT_CN.get(want, want)}")
            if s["layout"] == "maze" and s["word"] not in (hit.get("label") or "") and "迷宫" not in (hit.get("label") or ""):
                hit["label"] = (hit.get("label") or "") + "迷宫"
            if s.get("sublevels") and hit.get("sublevels") != s["sublevels"]:
                hit["sublevels"] = int(_range_of("spaces", "sublevels", s["sublevels"], s["sublevels"])[0])
                ch.append(f"{hit['label']}·{hit['sublevels']} 层")
            if s.get("branching") and hit.get("branching") != s["branching"]:
                hit["branching"] = s["branching"]
                ch.append(f"{hit['label']}·岔路")
            if s.get("connect") and (hit.get("connect") or {}).get("via") != s["connect"]:
                hit.setdefault("connect", {})["via"] = s["connect"]
                ch.append(f"{hit['label']}·连接")
            if s.get("under_word") and s["stratum"] == "underground":
                want = next((l["id"] for l in p.get("landmarks") or [] if s["under_word"] in (l.get("label") or "")), None)
                if want and hit.get("under") != want:
                    hit["under"] = want
                    ch.append(f"{hit['label']}·在{s['under_word']}下")
            fitted = _fit("spaces", hit)
            hit.clear()
            hit.update(fitted)
    # 句子没提到的地下 / 空中空间去掉（人锁住的不动）：清单里出现的就是这句话里的东西
    if (c.get("spaces") or c.get("no_spaces")) and p.get("spaces"):
        wanted = claimed if c.get("spaces") else set()
        gone = {x["id"] for x in p["spaces"] if x.get("id") not in wanted and x.get("id") not in keep_ids}
        if gone:
            p["spaces"] = [x for x in p["spaces"] if x.get("id") not in gone]
            drop_refs(p, gone)
            ch.append("去掉没提到的地下 / 空中空间")
    return p, ch


def drop_refs(p: dict, gone: set) -> None:
    """删掉元素后清引用：关系整条去掉，via 里去掉，其它引用改指 site（和引擎 normalizePlan 的降级一致）"""
    if not gone:
        return
    p["relations"] = [r for r in p.get("relations") or [] if not ({r.get("a"), r.get("b"), r.get("c")} & gone)]

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in list(node.items()):
                if isinstance(v, str) and v in gone and k in ("of", "target", "on", "under", "over", "from", "to", "look_at", "building", "facing"):
                    node[k] = "site" if k != "building" else None
                    if node[k] is None:
                        del node[k]
                elif k == "via" and isinstance(v, list):
                    node[k] = [x for x in v if x not in gone]
                elif isinstance(v, (dict, list)):
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    for g in LIST_GROUPS + ONE_GROUPS:
        if g in p and g != "relations":
            walk(p[g])


def enforce_ops(plan: dict, ops: list, text: str, locked_ids: set | None = None) -> tuple[list, list[str], list[str]]:
    """revise 也锁：那句话里说死的词，ops 里没做到就本地补一条。返回 (ops, 补了什么, 复述要补的话)。"""
    c = extract(text)
    removing = any(w in text for w in REMOVE_WORDS)
    after = apply_ops(plan, ops)
    added: list = []
    notes: list[str] = []
    say: list[str] = []
    locked_ids = locked_ids or set()

    def push(op, note):
        good, errs, _ = check_ops(apply_ops(plan, ops + added), [op], locked_ids)
        if good:
            added.extend(good)
            notes.append(note)
            return True
        return False

    cur = lambda: apply_ops(plan, ops + added)  # noqa: E731
    if removing:
        for x in c.get("landmarks", []) + [{"word": s["word"]} for s in c.get("spaces", [])]:
            for g in ("landmarks", "spaces", "terrain", "buildings", "zones"):
                for el in cur().get(g) or []:
                    if x["word"] in (el.get("label") or "") and not any(o.get("op") == "remove" and o.get("id") == el.get("id") for o in ops + added):
                        push({"op": "remove", "id": el["id"]}, f"删{el.get('label')}")
        return added, notes, say
    if "time_of_day" in c and (after.get("lighting") or {}).get("time_of_day") != c["time_of_day"]:
        if push({"op": "set", "id": "lighting", "field": "time_of_day", "value": c["time_of_day"]}, "时段"):
            say.append(f"时段改成{TIME_CN[c['time_of_day']]}")
    # 「X改成Y」：说的是改已有的东西，不新增
    chg = re.search(r"改成|改为|变成|换成|做成|弄成", text)
    before = {x.get("id"): x for x in plan.get("spaces") or [] if isinstance(x, dict)}
    for s in c.get("spaces", []):
        now = cur()
        spaces = now.get("spaces") or []
        hit = next((x for x in spaces if s["word"] in (x.get("label") or "")), None)
        same = [x for x in spaces if x.get("stratum") == s["stratum"]]
        if not hit and s["word"] in ("迷宫", "地下", "空中"):
            hit = next((x for x in same if "迷宫" in (x.get("label") or "")), None) or (same[0] if same else None)
        if not hit:  # 模型已经把某个同层空间改成了要的布局 → 就是它
            hit = next((x for x in same if x.get("layout") in s["accept"] and (before.get(x.get("id")) or {}).get("layout") != x.get("layout")), None)
        if not hit and chg:
            if len(same) == 1:  # 只有一个同层空间：指的就是它
                hit = same[0]
            else:
                where = "地下" if s["stratum"] == "underground" else "空中"
                say.append(f"没找到「{s['word']}」，要改哪个{where}空间？" if same else f"现在没有{where}空间，要加一个{s['word']}吗？")
                continue
        if not hit:
            sp = default_space(now, s)
            if push({"op": "add", "group": "spaces", "value": sp}, f"加{sp['label']}"):
                say.append(f"加了{sp['label']}（{LAYOUT_CN.get(sp.get('layout'), '')}平面）" if sp.get("layout") != "maze" else f"加了{sp['label']}，迷宫平面")
            continue
        if hit.get("layout") not in s["accept"]:
            if push({"op": "set", "id": hit["id"], "field": "layout", "value": s["layout"]}, f"{hit.get('label')}布局"):
                say.append(f"{hit.get('label')}改成{LAYOUT_CN.get(s['layout'], s['layout'])}平面")
        if s.get("sublevels") and hit.get("sublevels") != s["sublevels"]:
            push({"op": "set", "id": hit["id"], "field": "sublevels", "value": s["sublevels"]}, f"{hit.get('label')}层数")
        if s.get("branching") and hit.get("branching") != s["branching"]:
            push({"op": "set", "id": hit["id"], "field": "branching", "value": s["branching"]}, f"{hit.get('label')}岔路")
        if s["layout"] == "maze":
            say.append(f"{hit.get('label')}改成迷宫平面")
    for x in c.get("landmarks", []):
        now = cur()
        lm = next((l for l in now.get("landmarks") or [] if x["word"] in (l.get("label") or "")), None)
        if not lm:
            v = default_landmark(now, x)
            if push({"op": "add", "group": "landmarks", "value": v}, f"加{x['word']}"):
                say.append(f"加了{x['word']}")
        elif x.get("place") and not _place_ok(now, lm.get("place"), x["place"]):
            push({"op": "set", "id": lm["id"], "field": "place", "value": _place_for(now, x["place"], lm.get("form") or x["form"])}, f"{x['word']}位置")
    if "relief_layers" in c and (after.get("site") or {}).get("relief_layers") != c["relief_layers"]:
        push({"op": "set", "id": "site", "field": "relief_layers", "value": c["relief_layers"]}, "层数")
    if "entry_side" in c:
        pl = ((after.get("spawn") or {}).get("place") or {})
        if pl.get("side") != c["entry_side"]:
            push({"op": "set", "id": "spawn", "field": "place", "value": {"rel": "edge_of", "target": "site", "side": c["entry_side"]}}, "入口方向")
    return added, notes, list(dict.fromkeys(say))
