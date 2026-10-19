# -*- coding: utf-8 -*-
"""
intent_rules.py — 从用户那句话里读出「说死的条件」，在本地锁定到每张卡上（不花钱、不靠模型自觉）

DeepSeek 实测（build/eval/deepseek-findings.md）：为了让三张卡不同，模型会丢掉人明说的条件
（水车换成塔、塔挪出崖边、缓坡变陡、两岸变成环台），文案也会和字段对不上（写「五层」实际 6 层）。
这里做三件事：
1. extract(intent) → 条件字典（时段 / 溪 / 地标种类与位置 / 层数 / 坡度 / 入口 / 原型 / 多层空间）
2. hint(cons) → 一句中文，拼进给模型的话里（让模型少犯错）
3. enforce(card, cons, axis) → 把条件写死到卡上（axis 是「换一批」正在变的那条轴，不锁它），
   再把 one_liner / summary 里和字段矛盾的层数、地标名改成字段的值
只改结构字段（枚举 / 数值），不涉及任何坐标。
"""
from __future__ import annotations

import copy
import re

CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

TIME_WORDS = [  # 先匹配长词
    (("黄昏", "傍晚", "日落", "夕阳"), "dusk"),
    (("夜里", "夜晚", "晚上", "深夜", "夜景", "亮灯", "灯火", "夜"), "night"),
    (("清晨", "早晨", "晨雾", "一早", "早上"), "morning"),
    (("正午", "中午"), "noon"),
    (("下午", "午后"), "afternoon"),
    (("黎明", "拂晓", "破晓"), "dawn"),
    (("阴天", "阴雨", "下雨", "雨天", "多云"), "overcast"),
]
LANDMARK_WORDS = [
    (("水车",), "wheel", "水车"),
    (("鼓楼", "塔楼", "宝塔", "石塔", "塔"), "pagoda", None),
    (("寺庙", "寺院", "古寺", "小庙", "庙", "寺"), "temple", None),
    (("寨门", "牌楼", "门楼", "山门", "牌坊"), "gate", None),
    (("古树", "大树", "神木", "老树", "榕树", "银杏"), "tree", None),
]
PLACEMENT_WORDS = [
    (("村口", "寨口", "入口处", "进村处"), "entry"),
    (("崖边", "临崖", "悬崖边", "崖上"), "cliff_edge"),
    (("尽头", "山脊"), "ridge_end"),
    (("山顶", "顶上", "最顶", "顶层", "最高处"), "top"),
    (("广场边", "广场上", "广场中", "在广场"), "plaza"),
]
ARCHETYPE_WORDS = [
    (("两岸", "溪谷", "夹着溪", "隔溪"), "valley_two_banks"),
    (("围着广场", "环绕", "一圈圈", "环形", "围成一圈"), "ring_terrace"),
    (("之字", "折返", "石阶上山", "一层层往上"), "slope_zigzag"),
]
ENTRY_WORDS = [
    (("东边进", "从东", "东侧进", "东边入口", "东侧入口", "东门"), "E"),
    (("西边进", "从西", "西侧进", "西边入口", "西侧入口", "西门"), "W"),
    (("南边进", "从南", "南侧进", "南边入口", "南侧入口", "南门"), "S"),
]
LEVEL_WORDS = [  # (词, stratum, kind)
    (("地宫", "墓室"), "underground", "crypt"),
    (("溶洞", "洞穴", "山洞"), "underground", "cave"),
    (("地道", "隧道", "暗道"), "underground", "tunnel"),
    (("地窖", "地下室"), "underground", "cellar"),
    (("栈道", "悬空栈道"), "sky", "walkway"),
    (("浮岛", "空岛", "浮空岛"), "sky", "island"),
    (("天桥", "空中桥", "飞桥"), "sky", "bridge"),
    (("空中平台", "高台", "悬空平台"), "sky", "platform"),
]
CONNECT_WORDS = [
    (("井",), "well"), (("梯子", "爬梯"), "ladder"), (("电梯", "升降"), "elevator"),
    (("索桥", "吊桥"), "rope_bridge"), (("竖井",), "shaft"), (("坡道",), "ramp"), (("楼梯", "台阶", "石阶"), "stairs"),
]
LANDMARK_NAMES = ["山顶寺", "寺庙", "寺院", "小庙", "寺", "庙", "鼓楼", "塔楼", "宝塔", "石塔", "塔", "寨门", "牌楼", "门楼", "山门", "古树", "大树", "神木", "水车"]
AXIS_FIELDS = {"地标位置": {"landmark.placement"}, "台地层数": {"params.terraces"}, "入口方位": {"params.entry_side", "spawn.placement"}, "色板冷暖": set(), "密度": set()}


def _first(text: str, table):
    """表里第一个在 text 中出现的词对应的值（按表顺序，长词在前）"""
    best = None
    for words, *val in table:
        for w in words:
            i = text.find(w)
            if i >= 0 and (best is None or i < best[0]):
                best = (i, val[0] if len(val) == 1 else tuple(val))
    return best[1] if best else None


def _has(text: str, words) -> bool:
    return any(w in text for w in words)


def _is_entry_route(text: str, i: int, w: str) -> bool:
    """「从村口进 / 村口进去」说的是从哪进村，不是地标放哪"""
    return text[max(0, i - 1):i] == "从" or text[i + len(w):i + len(w) + 1] == "进"


def placement_near(text: str, at: int | None = None):
    """地标位置词：离地标词（位置 at）最近的那个；不给 at 时取最先出现的。跳过「从村口进」这类说入口路线的。"""
    best = None
    for words, val in PLACEMENT_WORDS:
        for w in words:
            for m in re.finditer(re.escape(w), text):
                i = m.start()
                if val == "entry" and _is_entry_route(text, i, w):
                    continue
                d = abs(i - at) if at is not None else i
                if best is None or d < best[0]:
                    best = (d, val)
    return best[1] if best else None


def entry_mentioned(text: str) -> bool:
    """一句话里有没有把东西放在村口（MockAI 用）"""
    return placement_near(text or "") == "entry"


def extract(intent: str) -> dict:
    """一句话 → 说死的条件。没提到的字段不出现。"""
    t = (intent or "").strip()
    c: dict = {}
    tod = _first(t, TIME_WORDS)
    if tod:
        c["time_of_day"] = tod
    if _has(t, ("没有溪", "无溪", "不要溪", "没溪")):
        c["stream"] = False
    elif _has(t, ("溪", "河", "水车", "两岸", "小河")):
        c["stream"] = True
    # 「桥」（不算天桥 / 索桥 / 吊桥这类空中连接）= 路过溪处有桥：要有溪，桥由引擎在路与溪的交点上算
    if "桥" in re.sub("天桥|空中桥|飞桥|索桥|吊桥", "", t) and c.get("stream") is not False:
        c["bridge"] = True
        c["stream"] = True
    lk = _first(t, [(words, kind) for words, kind, _ in LANDMARK_WORDS])
    if lk:
        c["landmark_kind"] = lk
        for words, kind, _ in LANDMARK_WORDS:
            if kind == lk:
                c["landmark_word"] = next(w for w in words if w in t)
    lk_at = min((t.find(w) for words, kind, _ in LANDMARK_WORDS if kind == lk for w in words if w in t), default=None) if lk else None
    pl = placement_near(t, lk_at)
    if pl and lk:  # 只有说了地标才锁位置；有好几个位置词时取离地标词最近的
        c["landmark_placement"] = pl
    m = re.search(r"([三四五六七]|[3-7])\s*层", t)
    if m:
        n = CN_NUM.get(m.group(1)) or int(m.group(1))
        c["terraces"] = max(3, min(7, n))
    elif _has(t, ("小村", "小山村", "几户", "小寨")):
        c["terraces_range"] = (3, 4)
    elif _has(t, ("大寨", "大村", "会迷路", "很大的")):
        c["terraces_range"] = (6, 7)
    if _has(t, ("很陡", "陡峭", "非常陡", "特别陡", "陡崖")):
        c["layer_range"] = (4.5, 6.0)
    elif _has(t, ("陡",)):
        c["layer_range"] = (4.0, 6.0)
    elif _has(t, ("很缓", "平缓", "缓坡", "不陡", "缓")):
        c["layer_range"] = (2.5, 3.0)
    ent = _first(t, ENTRY_WORDS)
    if ent:
        c["entry_side"] = ent
    arch = _first(t, ARCHETYPE_WORDS)
    if arch:
        c["archetype"] = arch
    lv = []
    for words, stratum, kind in LEVEL_WORDS:
        if _has(t, words) and not any(x["kind"] == kind for x in lv):
            lv.append({"stratum": stratum, "kind": kind, "word": next(w for w in words if w in t)})
    if lv:
        conn = _first(t, CONNECT_WORDS)
        for x in lv:
            x["connect"] = conn
        c["levels"] = lv[:3]
    elif not _has(t, ("地下", "空中", "天上", "多层", "上下层")):
        c["no_levels"] = True
    return c


TOD_CN = {"dusk": "黄昏", "night": "夜里", "morning": "清晨", "noon": "正午", "afternoon": "午后", "dawn": "黎明", "overcast": "阴天"}
KIND_CN = {"temple": "寺庙", "pagoda": "塔楼", "tree": "大树", "wheel": "水车", "gate": "寨门"}
PLACE_CN = {"top": "顶层中央", "ridge_end": "山脊尽头", "cliff_edge": "临崖", "plaza": "中层广场", "entry": "村口"}
ARCH_CN = {"slope_zigzag": "之字叠落", "ring_terrace": "环台广场", "valley_two_banks": "溪谷双坡"}
ARCH_LINE = {"slope_zigzag": "之字石阶一层层上山", "ring_terrace": "半山一块广场，房子一圈圈往上", "valley_two_banks": "一条溪穿过，两岸各一片坡"}
LEVEL_CN = {"cave": "溶洞", "tunnel": "地道", "cellar": "地窖", "crypt": "地宫", "platform": "空中平台", "walkway": "栈道", "island": "浮岛", "bridge": "天桥"}


def summary(c: dict) -> list[str]:
    """条件 → 给人看的短语列表（界面上「按你的话锁定了：…」）"""
    out = []
    if "archetype" in c: out.append(ARCH_CN[c["archetype"]])
    if "terraces" in c: out.append(f"{c['terraces']} 层")
    if "terraces_range" in c: out.append(f"{c['terraces_range'][0]}–{c['terraces_range'][1]} 层")
    if "layer_range" in c: out.append("陡" if c["layer_range"][0] >= 4 else "缓")
    if "landmark_kind" in c: out.append(c.get("landmark_word") or KIND_CN[c["landmark_kind"]])
    if "landmark_placement" in c: out.append(f"地标{PLACE_CN[c['landmark_placement']]}")
    if "entry_side" in c: out.append({"E": "东边进", "W": "西边进", "S": "南边进"}[c["entry_side"]])
    if c.get("stream") is True and not c.get("bridge"): out.append("有溪")
    if c.get("bridge"): out.append("桥：路过溪处")
    if c.get("stream") is False: out.append("无溪")
    if "time_of_day" in c: out.append(TOD_CN[c["time_of_day"]])
    for x in c.get("levels", []): out.append(LEVEL_CN[x["kind"]])
    return out


def hint(c: dict) -> str:
    """拼进给模型的话：这些是用户说死的，三张都要照办，差异放在别的字段"""
    s = summary(c)
    if not s:
        return ""
    return "（程序从这句话里读出的硬条件，三张卡都必须照办，差异只放在其它字段：" + "、".join(s) + "）"


def _set(card: dict, path: str, value, skip: set):
    if path in skip:
        return False
    a, b = path.split(".")
    card.setdefault(a, {})
    if card[a].get(b) == value:
        return False
    card[a][b] = value
    return True


def enforce(card: dict, c: dict, axis: str | None = None) -> tuple[dict, list[str]]:
    """把条件写死到卡上；返回 (新卡, 改了哪些)。axis 是「换一批」正在变的轴，不锁它。"""
    card = copy.deepcopy(card)
    skip = AXIS_FIELDS.get(axis or "", set())
    changed: list[str] = []
    p = card.setdefault("params", {})
    if "archetype" in c and card.get("archetype") != c["archetype"]:
        card["archetype"] = c["archetype"]; changed.append("archetype")
    if c.get("archetype") == "valley_two_banks" and _set(card, "params.stream", True, skip): changed.append("stream")
    if "stream" in c and _set(card, "params.stream", c["stream"], skip): changed.append("stream")
    if "terraces" in c and _set(card, "params.terraces", c["terraces"], skip): changed.append("terraces")
    if "terraces_range" in c and "params.terraces" not in skip:
        lo, hi = c["terraces_range"]; n = int(p.get("terraces") or lo)
        if not lo <= n <= hi: p["terraces"] = max(lo, min(hi, n)); changed.append("terraces")
    if "layer_range" in c:
        lo, hi = c["layer_range"]; v = float(p.get("layer_height_m") or 3)
        if not lo <= v <= hi: p["layer_height_m"] = round(max(lo, min(hi, v)), 1); changed.append("layer_height_m")
    if "entry_side" in c and _set(card, "params.entry_side", c["entry_side"], skip): changed.append("entry_side")
    if "time_of_day" in c and _set(card, "lighting.time_of_day", c["time_of_day"], skip): changed.append("time_of_day")
    lm = card.setdefault("landmark", {})
    if "landmark_kind" in c and lm.get("kind") != c["landmark_kind"]:
        lm["kind"] = c["landmark_kind"]; changed.append("landmark.kind")
        word = c.get("landmark_word") or KIND_CN[c["landmark_kind"]]
        if word not in (lm.get("label") or ""): lm["label"] = word
    if "landmark_placement" in c and _set(card, "landmark.placement", c["landmark_placement"], skip): changed.append("landmark.placement")
    if "levels" in c:
        want = {x["kind"]: x for x in c["levels"]}
        have = [x for x in (card.get("levels") or []) if x.get("kind") in want]
        kinds = {x.get("kind") for x in have}
        for kind, x in want.items():
            if kind not in kinds:
                lv = {"stratum": x["stratum"], "kind": kind, "anchor": "landmark" if x["stratum"] == "underground" else "top",
                      "size": "medium", "connect": x.get("connect") or ("stairs" if x["stratum"] == "underground" else "ladder"), "label": x["word"]}
                lv["depth_layers" if x["stratum"] == "underground" else "height_layers"] = 2 if x["stratum"] == "underground" else 3
                have.append(lv)
        for lv in have:
            conn = want[lv["kind"]].get("connect")
            if conn: lv["connect"] = conn
        if [x.get("kind") for x in have] != [x.get("kind") for x in (card.get("levels") or [])]: changed.append("levels")
        card["levels"] = have[:3]
    elif c.get("no_levels") and card.get("levels"):
        card["levels"] = []; changed.append("levels")
    if "archetype" in changed:  # 原型改回人说的：名字和一句话也换掉，免得文案还在说旧原型
        card["name"] = ARCH_CN[card["archetype"]] + "型"
        lm = card.get("landmark") or {}
        where = PLACE_CN.get(lm.get("placement"), "")
        card["one_liner"] = ARCH_LINE[card["archetype"]] + (f"，{lm.get('label') or KIND_CN.get(lm.get('kind'), '地标')}在{where}" if where else "") + "。"
        card["summary"] = card["one_liner"]
    _fix_text(card)
    return card, changed


def _layer_num(tok: str) -> int:
    return int(tok) if tok.isdigit() else CN_NUM.get(tok, 0)


SPAWN_HEIGHT = {"valley_bottom": "山脚", "side_slope": "半山", "summit": "山顶", "S": "山脚", "E": "山脚", "W": "山脚"}
SIDE_CN = {"S": "南", "E": "东", "W": "西"}
_HEIGHT_RE = re.compile("谷底|山脚|坡脚|半山腰|半山|侧坡|山腰|坡顶|山顶|最高处")
_SIDE_RE = re.compile("([东南西北])(侧|边|面|方)")
_ENTRY_KEY = re.compile("入口|出生点?")
_ENTRY_FROM = re.compile("从[^，。；]{0,8}?(?=进|上山|抬头|出发)")
_TAIL_JUNK = re.compile(r"。[^。！？…」』）)\"”’\s]{1,2}\s*$")


def _fix_entry(s: str, card: dict) -> str:
    """说入口 / 出生点的那半句，方位和高度词改成 spawn.placement / entry_side 的值（「入口在南侧谷底」但 spawn=summit → 「南侧山顶」）"""
    sp = (card.get("spawn") or {}).get("placement")
    if sp not in SPAWN_HEIGHT:
        return s
    side = SIDE_CN.get(sp) or SIDE_CN.get((card.get("params") or {}).get("entry_side"))
    want_h = SPAWN_HEIGHT[sp]
    ok_h = {"山脚", "谷底", "坡脚"} if want_h == "山脚" else {"山顶", "坡顶", "最高处"} if want_h == "山顶" else {"半山", "半山腰", "侧坡", "山腰"}

    def fix(part):  # 只改这一段里的方位词和第一个高度词
        part = _HEIGHT_RE.sub(lambda h: h.group(0) if h.group(0) in ok_h else want_h, part, count=1)
        return _SIDE_RE.sub(lambda d: side + d.group(2), part) if side else part

    def clause(m):
        c = m.group(0)
        f = _ENTRY_FROM.search(c)  # 「从南边山脚抬头」：只看「从…」到动词之间
        if f:
            return c[:f.start()] + fix(f.group(0)) + c[f.end():]
        k = _ENTRY_KEY.search(c)  # 「入口在南侧谷底」看后半；「南侧谷底的入口」看前半
        if not k:
            return c
        if c[k.end():].strip("在于是设位置的 "):
            return c[:k.end()] + fix(c[k.end():])
        return fix(c[:k.start()]) + c[k.start():]
    return re.sub("[^，。；！？,;]+", clause, s)


def _fix_text(card: dict) -> None:
    """one_liner / summary 里与字段矛盾的层数、地标名、入口方位改成字段值，去掉末尾句号后的孤立乱码字（读者看卡片时不被文案误导）"""
    n = (card.get("params") or {}).get("terraces")
    lm = card.get("landmark") or {}
    label = lm.get("label") or KIND_CN.get(lm.get("kind"), "")
    own = {w for words, kind, _ in LANDMARK_WORDS if kind == lm.get("kind") for w in words}
    for key in ("one_liner", "summary"):
        s = card.get(key)
        if not isinstance(s, str) or not s:
            continue
        if n:
            def fix_layers(m):
                tok = m.group(1)
                if _layer_num(tok) == n:
                    return m.group(0)
                return (str(n) if tok.isdigit() else "一二三四五六七八九"[n - 1]) + m.group(2) + "层"
            s = re.sub(r"([一二两三四五六七八九]|[1-9])(\s*)层", fix_layers, s)
        if label:
            for w in LANDMARK_NAMES:  # 长词在前；把所有别的地标名都换成这张卡的地标名
                if w in s and w not in own and w not in label:
                    s = s.replace(w, label)
        s = _TAIL_JUNK.sub("。", _fix_entry(s, card))
        card[key] = s


if __name__ == "__main__":  # 自测：python -X utf8 desktop/intent_rules.py
    import json
    ok = fail = 0

    def check(name, cond, info=""):
        global ok, fail
        if cond: ok += 1; print("PASS", name)
        else: fail += 1; print("FAIL", name, info)

    c = extract("夜里亮灯的小山村，溪边有水车")
    check("夜 + 溪 + 水车 + 小村", c.get("time_of_day") == "night" and c.get("stream") is True and c.get("landmark_kind") == "wheel" and c.get("terraces_range") == (3, 4), json.dumps(c, ensure_ascii=False))
    c = extract("七层，很陡，夜里，塔在崖边")
    check("七层 + 很陡 + 塔崖边", c.get("terraces") == 7 and c.get("layer_range") == (4.5, 6.0) and c.get("landmark_kind") == "pagoda" and c.get("landmark_placement") == "cliff_edge", json.dumps(c, ensure_ascii=False))
    c = extract("溪谷两岸，一座桥，傍晚")
    check("两岸 → 溪谷原型 + 溪 + 黄昏", c.get("archetype") == "valley_two_banks" and c.get("stream") is True and c.get("time_of_day") == "dusk", json.dumps(c, ensure_ascii=False))
    c = extract("半山一块广场，围着广场一圈圈的房子，广场边有鼓楼，中午")
    check("围着广场 → 环台 + 鼓楼在广场", c.get("archetype") == "ring_terrace" and c.get("landmark_kind") == "pagoda" and c.get("landmark_placement") == "plaza" and c.get("time_of_day") == "noon", json.dumps(c, ensure_ascii=False))
    c = extract("山城下面有个地宫，从井下去")
    check("地宫 + 井", c.get("levels") and c["levels"][0]["kind"] == "crypt" and c["levels"][0]["connect"] == "well", json.dumps(c, ensure_ascii=False))
    c = extract("我要生成山城村庄")
    check("没提多层 → no_levels，其余为空", c == {"no_levels": True}, json.dumps(c, ensure_ascii=False))
    c = extract("一个很缓的小村，没有溪，村口一棵大树")
    check("村口一棵大树 → 大树放村口（entry）", c.get("landmark_kind") == "tree" and c.get("landmark_placement") == "entry" and "地标村口" in summary(c), json.dumps(c, ensure_ascii=False))
    c = extract("从村口进去，一路爬到山顶的寺")
    check("「从村口进去」是入口路线，地标仍在山顶", c.get("landmark_placement") == "top", json.dumps(c, ensure_ascii=False))
    c = extract("寨口立一座牌楼，后面是层层叠叠的房子")
    check("寨口 + 牌楼 → gate + entry", c.get("landmark_kind") == "gate" and c.get("landmark_placement") == "entry", json.dumps(c, ensure_ascii=False))
    check("entry_mentioned：村口有 / 从村口进 没有", entry_mentioned("村口有棵大树") and not entry_mentioned("从村口进去"))
    c = extract("从东边进的之字石阶寨子，寨门，阴天")
    check("东边进 + 之字 + 寨门 + 阴天", c.get("entry_side") == "E" and c.get("archetype") == "slope_zigzag" and c.get("landmark_kind") == "gate" and c.get("time_of_day") == "overcast", json.dumps(c, ensure_ascii=False))

    card = {"name": "崖塔夜寨", "one_liner": "五层石阶通到山顶寺，寨门在最高处。", "archetype": "slope_zigzag",
            "params": {"entry_side": "S", "terraces": 6, "layer_height_m": 4.0, "plateau_width": "medium", "stream": False},
            "landmark": {"kind": "temple", "label": "山顶寺", "placement": "top", "size_m": [8, 9, 8]}, "spawn": {"placement": "valley_bottom"},
            "lighting": {"time_of_day": "dusk"}, "levels": [{"stratum": "underground", "kind": "cave", "anchor": "landmark", "depth_layers": 2, "size": "medium", "connect": "stairs", "label": "溶洞"}]}
    cons = extract("七层，很陡，夜里，塔在崖边")
    out, changed = enforce(card, cons)
    check("enforce：层数 / 陡 / 夜 / 塔 / 崖边 都写死", out["params"]["terraces"] == 7 and out["params"]["layer_height_m"] >= 4.5 and out["lighting"]["time_of_day"] == "night" and out["landmark"]["kind"] == "pagoda" and out["landmark"]["placement"] == "cliff_edge", json.dumps(out, ensure_ascii=False))
    check("enforce：没提多层 → 去掉模型自己加的溶洞", out["levels"] == [], json.dumps(out["levels"], ensure_ascii=False))
    check("文案层数改成 7，地标名改成塔", "七层" in out["one_liner"] and "寺" not in out["one_liner"] and "寨门" not in out["one_liner"], out["one_liner"])
    out2, _ = enforce(card, cons, axis="地标位置")
    check("换一批按地标位置变时，不锁 placement", out2["landmark"]["placement"] == "top", out2["landmark"]["placement"])
    out3, _ = enforce({**card, "levels": []}, extract("悬崖村，崖顶有栈道和浮岛"))
    check("提到栈道 + 浮岛 → 两种都补上", sorted(x["kind"] for x in out3["levels"]) == ["island", "walkway"], json.dumps(out3["levels"], ensure_ascii=False))
    out4, ch4 = enforce({**card, "levels": []}, {})
    check("没有条件时不改任何结构字段", ch4 == [] and out4["landmark"]["placement"] == "top" and out4["params"]["terraces"] == 6, json.dumps(ch4, ensure_ascii=False))
    ring = {**card, "name": "环潭叠落型", "one_liner": "房子围着潭一圈圈往上", "archetype": "ring_terrace", "levels": []}
    out5, ch5 = enforce(ring, extract("溪谷两岸各一片房子，傍晚"))
    check("原型改回溪谷：名字和一句话跟着换", "archetype" in ch5 and out5["name"] == "溪谷双坡型" and "圈" not in out5["one_liner"] and "两岸" in out5["one_liner"], json.dumps([out5["name"], out5["one_liner"]], ensure_ascii=False))
    c = extract("溪谷两岸各一片房子，一座桥连起来")
    check("桥 → 有溪 + 锁定行写「桥：路过溪处」", c.get("bridge") and c.get("stream") is True and "桥：路过溪处" in summary(c), json.dumps(c, ensure_ascii=False))
    check("天桥不算桥", not extract("山顶有座天桥").get("bridge"))
    sc = {**card, "levels": [], "spawn": {"placement": "summit"}, "params": {**card["params"], "terraces": 5},
          "summary": "缓坡五层大寨，入口在南侧谷底，傍晚溪雾。万", "one_liner": "从东边山脚抬头看见寺。"}
    out6, ch6 = enforce(sc, {})
    check("文案入口方位跟 spawn / entry_side 走，句号后的孤立字去掉", out6["summary"] == "缓坡五层大寨，入口在南侧山顶，傍晚溪雾。" and out6["one_liner"] == "从南边山顶抬头看见寺。" and ch6 == [], json.dumps([out6["summary"], out6["one_liner"]], ensure_ascii=False))
    out7, _ = enforce({**sc, "spawn": {"placement": "valley_bottom"}, "summary": "入口在谷底，顶上是寺。」"}, {})
    check("和字段一致的不改；句末引号不当乱码", out7["summary"] == "入口在谷底，顶上是寺。」", out7["summary"])
    out8, _ = enforce({**sc, "spawn": {"placement": "valley_bottom"}, "summary": "入口在山脚，从这里一路上山到山顶，进村就看见山顶寺。", "one_liner": "西侧半山的入口。"}, {})
    check("只改说入口的那几个字，山顶寺 / 上山到山顶不动", out8["summary"] == "入口在山脚，从这里一路上山到山顶，进村就看见山顶寺。" and out8["one_liner"] == "南侧山脚的入口。", json.dumps([out8["summary"], out8["one_liner"]], ensure_ascii=False))
    print(f"\nDONE passed={ok} failed={fail}")
    raise SystemExit(1 if fail else 0)
