# -*- coding: utf-8 -*-
"""
test_app.py — 后端测试（进程内起服务；模拟 AI / 假 urllib / 假 anthropic client，不需要密钥、不联网、不花钱）

  python -X utf8 desktop/test_app.py            每条用例打印 PASS / FAIL，最后 DONE passed=… failed=…，退出码 0 = 全过

覆盖：plan schema 与示例、提示词、ops 合法性、本地锁定（draft / revise）、模拟 draft / revise、
DeepSeek 假客户端（请求体、JSON 修复、回喂、费用、HTTP 错误）、Claude 假客户端、配置不泄露明文、HTTP 路由。
"""
from __future__ import annotations

import copy
import datetime as dt
import io
import json
import os
import socket
import sys
import tempfile
import urllib.error
import urllib.request
from types import SimpleNamespace as NS

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="scene-dialog-test-")  # 不碰真实 config.json
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("DEEPSEEK_API_KEY", None)

import ai  # noqa: E402
import app  # noqa: E402

results: list[tuple[str, bool]] = []
ACCEPT = ["我要生成山城村庄", "半山环台寨，吊脚木楼一圈圈往上长，崖边寨门", "地下有个矿洞，是个两层的迷宫",
          "寺下有地宫：前厅—甬道—主墓室，两侧耳室", "溪谷两岸，一座风雨桥，傍晚"]


def check(name: str, cond, info: str = "") -> None:
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not info else f"  —  {str(info)[:400]}"))


def J(x) -> str:
    return json.dumps(x, ensure_ascii=False)


def valid(p) -> list:
    return ai.validate(ai.plan_schema(), p)


def labels(p, group) -> str:
    return "|".join(x.get("label") or "" for x in p.get(group) or [])


def mine_plan() -> dict:
    """一张有「普通矿洞」（galleries）的 plan：拿示例里有空间的那张，没有就自己补"""
    ex = ai.example_plans()
    base = copy.deepcopy(next((p for p in ex.values() if p.get("spaces")), next(iter(ex.values()))))
    base["spaces"] = [{"id": "mine", "stratum": "underground", "label": "矿洞", "under": base["terrain"][0]["id"], "depth_layers": 2,
                       "layout": "galleries", "size_m": 44, "branching": "medium", "sublevels": 1, "connect": {"via": "shaft", "from": base["terrain"][0]["id"]}}]
    return base


# ============================================================ schema / 示例 / 提示词
def t_schema() -> None:
    root = ai.plan_schema()
    ex = ai.example_plans()
    check("spec/plan.schema.json 可读，有 x-ui 与 ops 定义", root.get("properties") and ai.has_key(root, "x-ui") and "ops" in ai._defs(root))
    check("示例 plan ≥ 6 个", len(ex) >= 6, list(ex))
    for name, p in ex.items():
        e = valid(p)
        check(f"示例 {name} 合 plan schema", not e, e[:3])
    names = set()

    def walk(n):
        if isinstance(n, dict):
            names.update((n.get("properties") or {}).keys())
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(root)
    bad = names & {"position", "x", "z", "points", "polygon", "coords", "floor_y", "top_y"}
    check("plan schema 里没有任何坐标字段（LLM 不写坐标）", not bad, bad)
    try:
        import jsonschema
        agree = True
        broken = copy.deepcopy(next(iter(ex.values())))
        broken["site"]["size_m"] = 999
        broken["terrain"][0]["type"] = "volcano"
        broken["foo"] = 1
        for p in list(ex.values()) + [broken]:
            js = list(jsonschema.Draft7Validator(root).iter_errors(p))
            agree &= bool(js) == bool(valid(p))
        check("本地校验器与 jsonschema 结论一致（示例 + 坏 plan）", agree and len(valid(broken)) >= 3, valid(broken))
    except ImportError:
        check("本地校验器（跳过 jsonschema 对照：没装）", True)

    s = ai.claude_schema(ai.draft_schema())
    blob = J(s)
    check("发给 Claude 的 draft schema：没有 minimum / maximum / pattern / maxLength / x-ui / oneOf / definitions",
          not any(ai.has_key(s, k) for k in ("minimum", "maximum", "pattern", "maxLength", "x-ui", "oneOf", "definitions", "maxItems")) and "$defs" in s)

    def all_closed(n):
        if isinstance(n, dict):
            if (n.get("type") == "object" or "properties" in n) and n.get("additionalProperties") is not False:
                return False
            return all(all_closed(v) for v in n.values())
        if isinstance(n, list):
            return all(all_closed(v) for v in n)
        return True
    check("Claude schema 每个对象 additionalProperties=false；范围折进 description；人写字段（locks / nudge_m）不给 AI", all_closed(s) and "minimum" in blob and "locks" not in blob and "nudge_m" not in blob)
    rs = ai.claude_schema(ai.revise_schema(), True)
    check("Claude revise schema：add 的 value = 各组元素之一，set 的 value 可以是 place", "anyOf" in J(rs["$defs"]["op_add"]["properties"]["value"]) and "#/$defs/place" in J(rs["$defs"]["op_set"]["properties"]["value"]) and all_closed(rs))
    sp = ai.system_prompt()
    ex2 = ai.prompt_examples(2)
    shortest = sorted(ex.values(), key=lambda p: len(ai._one_line(p)))[:2]
    check("系统提示：不写坐标、名字随便起、三张构成不同、说死的三张都有；附 2 个最短示例（单行）",
          "不写任何坐标" in sp and "名字随便起" in sp and "构成" in sp and "三张都必须有" in sp and ex2 == shortest and all(ai._one_line(p) in sp for p in ex2))
    check("系统提示里的词表来自 schema（地形 / 布局 / 放置 / 关系的枚举都在）", all(w in sp for w in ("ring_terraces", "galleries", "at_entry", "visible_from", "stilt_house")))
    b = ai.brief(root)
    check("DeepSeek 字段表：各组一行、定义只展开一次、带中文名、不含 locks / nudge_m", "plan = {" in b and "space = {" in b and b.count("place = {") == 1 and "/*布局*/" in b and "locks" not in b and "nudge_m" not in b, b[:300])


# ============================================================ ops
def t_ops() -> None:
    p = mine_plan()
    lm = (p.get("landmarks") or [{"id": None}])[0]["id"]
    ops = [{"op": "set", "id": "mine", "field": "layout", "value": "maze"},
           {"op": "set", "id": "site", "field": "size_m", "value": 999},
           {"op": "add", "group": "landmarks", "value": {"id": "stage", "label": "戏台", "form": "stage", "size_m": [10, 6, 8], "place": {"rel": "center_of", "target": "site"}}},
           {"op": "set", "id": "plan", "field": "name", "value": "新寨"},
           {"op": "set", "id": "lighting", "field": "time_of_day", "value": "night"}]
    good, errs, fixes = ai.check_ops(p, ops)
    check("合法 ops 全收：set（含 site / lighting / plan 根字段）、add；越界值夹回并记下", len(good) == 5 and not errs and good[1]["value"] == 240 and any("999" in f for f in fixes), J([errs, fixes]))
    q = ai.apply_ops(p, good)
    check("apply_ops：矿洞变迷宫、加了戏台、改名、夜里，结果仍合 schema", q["spaces"][0]["layout"] == "maze" and "戏台" in labels(q, "landmarks") and q["name"] == "新寨" and q["lighting"]["time_of_day"] == "night" and not valid(q), valid(q)[:3])
    bad = [{"op": "set", "id": "nope", "field": "label", "value": "x"}, {"op": "set", "id": "mine", "field": "nonexist", "value": 1},
           {"op": "set", "id": "mine", "field": "layout", "value": "pyramid"}, {"op": "add", "group": "landmarks", "value": {"id": "x", "label": "x"}},
           {"op": "remove", "id": "ghost"}, {"op": "fly"}, {"op": "set", "id": "mine", "field": "id", "value": "m2"},
           {"op": "set", "id": "mine", "field": "offset_m", "value": [1, 2]}]
    good, errs, _ = ai.check_ops(p, bad)
    check("不合法 ops 全拒，每条一个具体原因（没这个 id / 字段 / 枚举外 / add 缺必填 / 不能改 id 与人写字段）", not good and len(errs) >= 8, J(errs))
    p2 = dict(p, relations=[{"type": "visible_from", "a": lm or "site", "b": "spawn"}])
    good, errs, _ = ai.check_ops(p2, [{"op": "remove", "id": "rel:0"}, {"op": "remove", "id": "rel:5"}])
    check("关系按 rel:<序号> 删；序号越界拒绝", good == [{"op": "remove", "id": "rel:0"}] and len(errs) == 1 and ai.apply_ops(p2, good).get("relations") == [])
    good, errs, fixes = ai.check_ops(p, [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], {"mine"})
    check("锁住的 id 不改（ops 丢掉并记下）", not good and not errs and fixes)
    good, errs, fixes = ai.check_ops(p, [{"op": "add", "group": "spaces", "value": {"id": "mine", "stratum": "underground", "layout": "chamber", "label": "地窖"}}])
    check("add 的 id 重复 → 本地改名", good and good[0]["value"]["id"] != "mine" and any("id" in f for f in fixes))


# ============================================================ 本地锁定
def t_locks() -> None:
    c = ai.extract("半山环台寨，吊脚木楼一圈圈往上长，崖边寨门")
    check("提取：环台 + 崖 + 吊脚木楼 + 寨门在崖边、没提空间", [x["type"] for x in c["terrain"]] == ["ring_terraces", "cliff"] and c["buildings"][0]["form"] == "stilt_house"
          and c["landmarks"][0]["word"] == "寨门" and c["landmarks"][0]["place"] == "cliff" and c.get("no_spaces"), J(c))
    c = ai.extract("地下有个矿洞，是个两层的迷宫")
    check("提取：矿洞 = 迷宫、2 层（不是场地层数）", len(c["spaces"]) == 1 and c["spaces"][0]["word"] == "矿洞" and c["spaces"][0]["layout"] == "maze" and c["spaces"][0]["sublevels"] == 2 and "relief_layers" not in c, J(c))
    c = ai.extract("地下有个矿洞")
    check("提取：只说矿洞 → galleries", c["spaces"][0]["layout"] == "galleries")
    c = ai.extract("寺下有地宫：前厅—甬道—主墓室，两侧耳室")
    s = c["spaces"][0]
    check("提取：地宫在寺下，房间链 前厅—甬道—主墓室 + 左右耳室", s["layout"] == "halls" and s["under_word"] == "寺" and [r["label"] for r in s["rooms"]["rooms"]] == ["前厅", "甬道", "主墓室", "左耳室", "右耳室"]
          and ["entry", "front"] in s["rooms"]["links"], J(s))
    c = ai.extract("溪谷两岸，一座风雨桥，傍晚")
    check("提取：谷 + 溪 + 风雨桥 + 黄昏", c["terrain"][0]["type"] == "valley" and c["stream"] is True and c["landmarks"][0]["form"] == "bridge" and c["time_of_day"] == "dusk", J(c))
    c = ai.extract("七层的大山城，很陡，夜景，塔在崖边，从东边进")
    check("提取：7 层 / 很陡 / 夜 / 塔在崖边 / 东边进", c["relief_layers"] == 7 and c["layer_range"][0] >= 4.5 and c["time_of_day"] == "night" and c["landmarks"][0]["place"] == "cliff" and c["entry_side"] == "E", J(c))
    check("提取：「从村口进去」是入口路线，不是地标放村口", ai.extract("从村口进去，一路爬到山顶的寺")["landmarks"][0]["place"] == "top")
    check("提取：天桥不算溪；栈道 / 浮岛 = 空中空间", "stream" not in ai.extract("山顶有座天桥") and {x["stratum"] for x in ai.extract("崖顶有栈道和浮岛")["spaces"]} == {"sky"})
    check("提取：「我要生成山城村庄」什么也不锁（只有不加空间）", ai.extract("我要生成山城村庄") == {"no_spaces": True})
    s = ai.extract("天上有个迷宫")["spaces"][0]
    check("提取：天上的迷宫 → 空中、岔路多的平台群（引擎天上不做 maze）", s["stratum"] == "sky" and s["layout"] == "network" and s["accept"] == ["network"] and s["branching"] == "high", J(s))
    ls = ai.plan_schema()["definitions"]["space"]["properties"]
    check("plan schema 的空间：layout 7 种（同 engine/interior.js）、有 height_m、layout_seed 是人写字段", ls["layout"]["enum"] == ["chamber", "corridor", "maze", "galleries", "halls", "network", "rooms"]
          and "height_m" in ls and ls["layout_seed"]["x-ui"]["hidden"] and "layout_seed" in ai.NO_SET_FIELDS and "rooms" not in ls["sublevels"]["x-ui"]["when"]["layout"])

    base = copy.deepcopy(next(iter(ai.example_plans().values())))
    for text in ACCEPT[1:] + ["七层的大山城，很陡，夜景，塔在崖边，从东边进", "从东边进村，一路之字形石阶爬到山顶的寨门，阴天", "夜里亮灯的小山村，溪边有水车，没有地下"]:
        p, ch = ai.enforce(base, ai.extract(text))
        check(f"锁定后仍合 schema：{text}", not valid(p), valid(p)[:3])
    p, ch = ai.enforce(base, ai.extract("半山环台寨，吊脚木楼一圈圈往上长，崖边寨门"))
    gate = next((l for l in p["landmarks"] if "寨门" in l.get("label", "")), {})
    cliff = {t["id"] for t in p["terrain"] if t["type"] == "cliff"}
    stilt = next((b for b in p.get("buildings") or [] if "吊脚木楼" in b.get("label", "")), {})
    check("锁定：寨门在崖边（edge_of 一块 cliff）、有环台、吊脚木楼有区域在用", (gate.get("place") or {}).get("target") in cliff and gate["place"]["rel"] == "edge_of"
          and any(t["type"] == "ring_terraces" for t in p["terrain"]) and any(z.get("building") == stilt.get("id") for z in p.get("zones") or []), J([gate, ch]))
    p, ch = ai.enforce(base, ai.extract("地下有个矿洞，是个两层的迷宫"))
    sp = [s for s in p.get("spaces") or [] if "矿洞" in s.get("label", "")]
    check("锁定：有一个 label 含矿洞、layout maze、sublevels 2 的地下空间", len(sp) == 1 and sp[0]["layout"] == "maze" and sp[0]["sublevels"] == 2 and sp[0]["stratum"] == "underground", J(p.get("spaces")))
    p2, ch2 = ai.enforce(p, ai.extract("我要生成山城村庄"))
    check("锁定：没提空间 → 模型自己加的空间去掉", not p2.get("spaces") and ch2)
    p3, _ = ai.enforce(dict(p, locks=[sp[0]["id"]]), ai.extract("我要生成山城村庄"), {sp[0]["id"]})
    check("锁定：人锁住的空间不去掉", len(p3.get("spaces") or []) == 1)
    p, ch = ai.enforce(base, ai.extract("寺下有地宫：前厅—甬道—主墓室，两侧耳室"))
    tomb = next(s for s in p["spaces"] if "地宫" in s.get("label", ""))
    temple = next(l for l in p["landmarks"] if "寺" in l.get("label", ""))
    check("锁定：地宫在寺下，halls 或按房间排（房间清单 + 连线）", tomb["under"] == temple["id"] and tomb["layout"] in ("halls", "rooms") and (tomb["layout"] != "rooms" or len(tomb.get("rooms") or []) == 5), J(tomb))

    mp = mine_plan()
    ops, notes, say = ai.enforce_ops(mp, [], "矿洞是个迷宫")
    check("revise 锁：「矿洞是个迷宫」模型没给 → 本地补 set mine.layout=maze，复述「改成迷宫平面」", ops == [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}] and any("迷宫平面" in s for s in say), J([ops, say]))
    ops, notes, say = ai.enforce_ops(mp, [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], "矿洞是个迷宫")
    check("revise 锁：模型已经给了就不重复", ops == [] and any("迷宫平面" in s for s in say))
    ops, _, _ = ai.enforce_ops(mp, [], "矿洞改成三层的迷宫，岔路多")
    check("revise 锁：三层 + 岔路多 也补上", {(o["field"], J(o["value"])) for o in ops} >= {("layout", '"maze"'), ("sublevels", "3"), ("branching", '"high"')}, J(ops))
    ops, _, _ = ai.enforce_ops(mp, [], "加个戏台，夜里")
    check("revise 锁：「加个戏台，夜里」→ add 戏台 + set 时段", any(o["op"] == "add" and "戏台" in o["value"]["label"] for o in ops) and any(o.get("field") == "time_of_day" for o in ops), J(ops))
    ops, _, _ = ai.enforce_ops(mp, [], "去掉矿洞")
    check("revise 锁：「去掉矿洞」→ remove mine（不会反过来加一个）", ops == [{"op": "remove", "id": "mine"}], J(ops))
    cave = copy.deepcopy(mp)
    cave["spaces"] = [dict(cave["spaces"][0], id="cave", label="暗河溶洞", layout="network")]
    model = [{"op": "set", "id": "cave", "field": "layout", "value": "maze"}]
    ops, _, say = ai.enforce_ops(cave, model, "地宫改成迷宫")
    check("revise 锁：「地宫改成迷宫」模型已把唯一的地下空间改成迷宫 → 不再加一个地宫", ops == [] and not any("加了" in s for s in say), J([ops, say]))
    ops, _, _ = ai.enforce_ops(cave, [], "地宫改成迷宫")
    check("revise 锁：「地宫改成迷宫」模型没给 → 改唯一的地下空间，不新增", ops == model, J(ops))
    two = copy.deepcopy(cave)
    two["spaces"].append(dict(cave["spaces"][0], id="cellar", label="酒窖", layout="chamber"))
    ops, _, say = ai.enforce_ops(two, [], "地宫改成迷宫")
    check("revise 锁：两个地下空间都不叫地宫 → 问一句，不新增", ops == [] and any(s.endswith("？") for s in say), J([ops, say]))

    # 锁定不硬叠：河算溪；名字带「迷宫」就是迷宫；补的地形找空地
    rv = copy.deepcopy(base)
    rv["water"] = [{"id": "creek", "type": "river", "label": "深谷河"}]
    p, ch = ai.enforce(rv, ai.extract("溪谷两岸，一座风雨桥，傍晚"))
    check("锁定：已经有一条河 → 「溪」算满足，不再加一条溪", [w["id"] for w in p.get("water") or []] == ["creek"] and "溪" not in ch, J([p.get("water"), ch]))
    mz = copy.deepcopy(base)
    mz["spaces"] = [{"id": "mc", "stratum": "underground", "label": "暗河溶洞迷宫", "layout": "rooms", "rooms": [{"id": "a", "label": "暗河厅", "size": "m"}], "connect": {"via": "stairs", "from": "site"}}]
    p, ch = ai.enforce(mz, ai.extract("地下有溶洞"))
    check("锁定：名字叫「…迷宫」的溶洞改成迷宫布局（名字和平面对得上），不改成洞穴网", p["spaces"][0]["layout"] == "maze" and "迷宫" in p["spaces"][0]["label"], J([p["spaces"], ch]))
    mz["spaces"][0]["layout"] = "maze"
    p, ch = ai.enforce(mz, ai.extract("地下有溶洞"))
    check("锁定：名字叫「…迷宫」、已经是迷宫 → 不动", p["spaces"][0]["layout"] == "maze" and not any("暗河" in x for x in ch), J(ch))
    bs = copy.deepcopy(base)
    bs["terrain"] = [{"id": "basin", "type": "basin", "label": "盆", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [90, 80]}]
    p, ch = ai.enforce(bs, ai.extract("山上有座塔，旁边是悬崖和山脊"))
    rg = next((t for t in p["terrain"] if t["type"] == "ridge"), {})
    check("锁定：补的山脊不压在场地中央的盆地上（挑空地，只给相对位置）", rg.get("at", {}).get("dir") not in (None, "C") and rg["at"].get("of") == "site" and not valid(p), J([rg, valid(p)[:2]]))
    tt = copy.deepcopy(base)
    tt["terrain"] = [{"id": "steps", "type": "slope_terraces", "label": "坡上台地", "at": {"of": "site", "dir": "C", "dist": 0}, "size_m": [80, 90], "steps": 4}]
    tt["buildings"] = [{"id": "stilt", "label": "吊脚木楼", "form": "stilt_house", "size_m": [6, 7, 5]}]
    tt["zones"] = [{"id": "z1", "label": "寨子", "use": "housing", "on": "steps", "building": "stilt"}]
    p, ch = ai.enforce(tt, ai.extract("吊脚木楼一圈圈往上长"))
    check("锁定：要环台、住人的是坡上台地 → 这块改成环台（不再叠一块）", [t["type"] for t in p["terrain"]] == ["ring_terraces"] and p["zones"][0]["on"] == "steps" and not valid(p), J([p["terrain"], ch]))
    tt["terrain"][0]["type"] = "hill"
    tt["terrain"][0].pop("steps")
    p, ch = ai.enforce(tt, ai.extract("吊脚木楼一圈圈往上长"))
    ring = next((t for t in p["terrain"] if t["type"] == "ring_terraces"), {})
    check("锁定：补出来的环台上有人住（吊脚木楼一圈圈 → 楼在那圈台上）", ring and any(z.get("on") == ring["id"] and z.get("building") == "stilt" for z in p["zones"]) and not valid(p), J([p["terrain"], p["zones"], ch]))

    # 模型回来的 JSON 本地修：id 撞名、放置关系近义词
    dup = copy.deepcopy(base)
    dup["buildings"] = [{"id": "stage", "label": "桥头戏台", "form": "stage", "size_m": [10, 7, 8]}]
    dup["zones"] = [{"id": "z1", "label": "戏台区", "use": "housing", "on": "site", "building": "stage"}]
    dup["landmarks"] = [{"id": "stage", "label": "戏台", "form": "stage", "size_m": [10, 7, 8], "place": {"rel": "across", "target": "site"}}]
    dup["paths"] = [{"id": "main", "from": "spawn", "to": "site", "via": ["stage"]}]
    data, fixes, errs = ai.postprocess_plans({"plans": [dup]})
    q = data["plans"][0]
    check("id 撞名：建筑类型 stage 和地标 stage → 改建筑类型（区域跟着改），地标 id 和路的 via 不动",
          q["landmarks"][0]["id"] == "stage" and q["buildings"][0]["id"] != "stage" and q["zones"][0]["building"] == q["buildings"][0]["id"] and q["paths"][0]["via"] == ["stage"], J([fixes, q["buildings"], q["zones"]]))
    check("place.rel 近义词本地换：across（一个目标）→ center_of，记进 fixes，不回喂", q["landmarks"][0]["place"]["rel"] == "center_of" and any("across" in f for f in fixes), J(fixes))
    fx = ai.fix_rels({"landmarks": [{"place": {"rel": "across", "target": ["a", "b"]}}, {"place": {"rel": "on", "target": "a"}}, {"place": {"rel": "near", "target": "a"}}, {"place": {"rel": "flying", "target": "a"}}]})
    check("place.rel 近义词：across（两个目标）→ between、on → top_of、near → beside；认不出的不动", len(fx) == 3 and "between" in fx[0] and "top_of" in fx[1] and "beside" in fx[2], J(fx))
    data, fixes, errs = ai.postprocess_revise({"understood": True, "restatement": "挪", "ops": [{"op": "set", "id": "gate", "field": "place", "value": {"rel": "near", "target": "site"}}], "ask_to_point": False}, mine_plan(), set())
    check("revise 的 place 也换近义词", data["ops"] and data["ops"][0]["value"]["rel"] == "beside" and any("near" in f for f in fixes), J([data, fixes, errs]))


# ============================================================ 模拟 AI
def t_mock() -> None:
    m = ai.MockAI()
    for text in ACCEPT:
        r = ai.draft({"intent": text, "force_mock": True})
        ps = r["plans"]
        check(f"模拟 draft「{text}」：3 张、都合 schema、构成两两至少差 2 维", len(ps) == 3 and all(not valid(p) for p in ps) and r["diversity"]["min"] >= 2,
              J([r["diversity"], [valid(p)[:2] for p in ps]]))
    r = ai.draft({"intent": ACCEPT[1], "force_mock": True})
    check("「半山环台寨…」三张都有吊脚木楼、寨门（在崖边）、环台，清单就是这句话里的东西",
          all("吊脚木楼" in labels(p, "buildings") and "寨门" in labels(p, "landmarks") and any(t["type"] == "ring_terraces" for t in p["terrain"]) for p in r["plans"])
          and "吊脚木楼" in r["constraints"] and "寨门在崖边" in r["constraints"], J(r["constraints"]))
    def homes_on(p, typ):
        ids = {t["id"] for t in p["terrain"] if t["type"] == typ}
        return [z for z in p.get("zones") or [] if z.get("use") == "housing" and z.get("on") in ids]
    check("「半山环台寨…」每张只有一块环台、吊脚木楼就住在环台上（不另外叠一块没人住的环台）",
          all(sum(t["type"] == "ring_terraces" for t in p["terrain"]) == 1 and homes_on(p, "ring_terraces") for p in r["plans"]),
          J([[(t["id"], t["type"], t.get("label")) for t in p["terrain"]] for p in r["plans"]]))
    lab_of = lambda p, tid: next((t.get("label") for t in p["terrain"] if t["id"] == tid), "")  # noqa: E731
    check("「半山环台寨…」一句话里「X上长满」的 X 是房子真正所在的地形块",
          all(any(lab_of(p, z["on"]) + "、" in p["one_liner"] or lab_of(p, z["on"]) + "上长满" in p["one_liner"] for z in homes_on(p, "ring_terraces")) for p in r["plans"]),
          J([p["one_liner"] for p in r["plans"]]))
    r = ai.draft({"intent": ACCEPT[2], "force_mock": True})
    check("「地下有个矿洞，是个两层的迷宫」三张都有矿洞迷宫（maze、2 层）", all(any("矿洞" in s.get("label", "") and s["layout"] == "maze" and s.get("sublevels") == 2 for s in p.get("spaces") or []) for p in r["plans"]),
          J([p.get("spaces") for p in r["plans"]]))
    r = ai.draft({"intent": ACCEPT[3], "force_mock": True})
    check("「寺下有地宫…」三张都有寺 + 寺下地宫（halls / rooms）", all("寺" in labels(p, "landmarks") and any("地宫" in s.get("label", "") and s["layout"] in ("halls", "rooms") for s in p.get("spaces") or []) for p in r["plans"]))
    r = ai.draft({"intent": ACCEPT[4], "force_mock": True})
    check("「溪谷两岸，一座风雨桥，傍晚」三张都有谷、溪、风雨桥、黄昏", all(any(t["type"] == "valley" for t in p["terrain"]) and any(w["type"] == "stream" for w in p.get("water") or [])
                                                          and "风雨桥" in labels(p, "landmarks") and p["lighting"]["time_of_day"] == "dusk" for p in r["plans"]))
    r0 = ai.draft({"intent": "我要生成山城村庄", "force_mock": True})
    r1 = ai.draft({"intent": "我要生成山城村庄", "force_mock": True})
    r2 = ai.draft({"intent": "我要生成山城村庄", "force_mock": True, "variant": 1})
    check("模拟 draft 确定性：同输入同结果；variant 换一批", r0["plans"] == r1["plans"] and [p["name"] for p in r2["plans"]] != [p["name"] for p in r0["plans"]])
    p0 = r0["plans"][0]
    tid = p0["terrain"][0]["id"]
    r3 = ai.draft({"intent": "我要生成山城村庄", "force_mock": True, "variant": 2, "locked": {"plan": dict(p0, locks=[tid])}})
    check("换一批：plan.locks 里的项原样保留在三张里", all(next((t for t in p["terrain"] if t["id"] == tid), None) == p0["terrain"][0] for p in r3["plans"]), J(r3.get("constraints_fixed")))

    mp = mine_plan()

    def rv(text, plan=mp):
        return ai.revise({"plan": plan, "action": {"type": "text", "text": text}, "force_mock": True})
    r = rv("矿洞是个迷宫")
    check("模拟 revise「矿洞是个迷宫」→ set layout maze + 复述「改成迷宫平面」", {"op": "set", "id": "mine", "field": "layout", "value": "maze"} in r["ops"] and "迷宫平面" in r["restatement"], J(r))
    for text, want in (("加个戏台", lambda q: "戏台" in labels(q, "landmarks")), ("加一座风雨桥", lambda q: "风雨桥" in labels(q, "landmarks")),
                       ("下面再加个地宫", lambda q: any(s["layout"] in ("halls", "rooms") for s in q["spaces"])),
                       ("再陡一点", lambda q: q["site"]["layer_m"] > mp["site"].get("layer_m", 3)),
                       ("房子更密", lambda q: any(z.get("density", 0) > 1.0 for z in q.get("zones") or [])),
                       ("换成夜里", lambda q: q["lighting"]["time_of_day"] == "night"),
                       ("换个地标", lambda q: labels(q, "landmarks") != labels(mp, "landmarks")),
                       ("去掉矿洞", lambda q: not q.get("spaces")),
                       ("矿洞改成两层，岔路多", lambda q: q["spaces"][0]["sublevels"] == 2 and q["spaces"][0]["branching"] == "high")):
        r = rv(text)
        g, e, _ = ai.check_ops(mp, r["ops"])
        q = ai.apply_ops(mp, g)
        check(f"模拟 revise「{text}」→ ops 合法、效果对、结果合 schema、有复述", r["understood"] and not e and want(q) and not valid(q) and r["restatement"] and len(r["restatement"]) <= 60, J([r["ops"], r["restatement"], e]))
    if mp.get("landmarks"):
        src = mp["landmarks"][0]
        r = rv(f"把{src['label']}换成戏台")
        q = ai.apply_ops(mp, r["ops"])
        check(f"模拟 revise「把{src['label']}换成戏台」→ 同一个地标改名改形制（不是另加一个）", next(l for l in q["landmarks"] if l["id"] == src["id"])["form"] == "stage"
              and labels(q, "landmarks").count("戏台") == 1, J(r["ops"]))
    r = rv("更有感觉一点")
    check("模拟 revise 模糊形容词 → understood=false、请人在图上指、question 是一句话", r["understood"] is False and r["ask_to_point"] is True and isinstance(r.get("question"), str) and r["ops"] == [])


# ============================================================ DeepSeek（假 urllib）
class FakeHTTPResp:
    def __init__(self, obj):
        self.raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def ds_resp(content, finish="stop", prompt=4000, hit=3000, completion=2500, model="deepseek-flash"):
    return {"id": "ds-req-1", "model": model, "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "prompt_cache_hit_tokens": hit, "prompt_cache_miss_tokens": prompt - hit,
                      "completion_tokens_details": {"reasoning_tokens": 0}}}


def http_error(code, message):
    body = json.dumps({"error": {"message": message, "type": "invalid_request_error"}}).encode("utf-8")
    return urllib.error.HTTPError("https://api.deepseek.com/chat/completions", code, message, {}, io.BytesIO(body))


def make_ds(script, log, **kw):
    seq = list(script)

    def urlopen(req, timeout=None):
        log.append((req.full_url, dict(req.header_items()), json.loads(req.data.decode("utf-8")), timeout))
        item = seq.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeHTTPResp(item)
    d = ai.DeepSeekAI("sk-test-deepseek-0000000000abcd", kw.pop("model", "deepseek-flash"), urlopen=urlopen, **kw)
    d.retry_sleep = 0
    return d


def t_deepseek() -> None:
    ex = list(ai.example_plans().values())
    good = {"plans": copy.deepcopy(ex[:3])}
    gs = J(good)
    cons = ai.extract("黄昏山城")
    log = []
    d = make_ds([ds_resp(gs)], log).draft("黄昏山城", cons, None)
    url, headers, body, timeout = log[-1]
    check("DeepSeek 请求：/chat/completions + Bearer + json_object + 思考关 + max_tokens 8000 + 不流式",
          url == "https://api.deepseek.com/chat/completions" and headers.get("Authorization", "").startswith("Bearer ") and body["response_format"] == {"type": "json_object"}
          and body["thinking"] == {"type": "disabled"} and body["max_tokens"] == 8000 and body["stream"] is False and timeout == ai.DeepSeekAI.TIMEOUT, J({k: v for k, v in body.items() if k != "messages"}))
    sysmsg = body["messages"][0]["content"]
    check("DeepSeek 系统提示 = 共用提示 + 字段表 + 改动示例 + 「只输出一个 json」", sysmsg.startswith(ai.system_prompt()) and "plan = {" in sysmsg and "只输出一个 json" in sysmsg and '"op":"remove"' in sysmsg)
    check("user 里有那句话 + 本地读出的硬条件", "黄昏山城" in body["messages"][1]["content"] and "黄昏" in body["messages"][1]["content"])
    u = d["_usage"]
    want = round((3000 * (0.04 if u["peak"] else 0.02) + 1000 * (2 if u["peak"] else 1) + 2500 * (8 if u["peak"] else 4)) / 1e6, 6)
    check("usage：input / output / cache_read / request_id / cost_cny（按时段价目）", u["input"] == 4000 and u["output"] == 2500 and u["cache_read"] == 3000 and u["request_id"] == "ds-req-1" and u["cost_cny"] == want, J(u))
    check("费用：空闲 flash 2000 入（1500 命中）+ 1000 出 = 0.00453 元；未知模型 None",
          ai.estimate_cost_cny({"input": 2000, "cache_read": 1500, "output": 1000}, "deepseek-flash", peak=False) == 0.00453 and ai.estimate_cost_cny({"input": 1}, "x") is None)
    bj = dt.timezone(dt.timedelta(hours=8))
    check("高峰：北京周一 10 点是，13 点、周六不是", ai.is_peak(dt.datetime(2026, 10, 19, 10, tzinfo=bj)) and not ai.is_peak(dt.datetime(2026, 10, 19, 13, tzinfo=bj)) and not ai.is_peak(dt.datetime(2026, 10, 24, 10, tzinfo=bj)))

    bad = copy.deepcopy(good)
    bad["plans"][0]["terrain"][0]["type"] = "volcano"
    log = []
    d = make_ds([ds_resp(J(bad)), ds_resp(gs)], log).draft("山城", cons, None)
    msgs = log[-1][2]["messages"]
    check("不合 schema → 带错误清单回喂一次后成功，usage 累加", len(log) == 2 and [m["role"] for m in msgs] == ["system", "user", "assistant", "user"] and "volcano" in msgs[-1]["content"]
          and d.get("_retried") and d["_usage"]["calls"] == 2 and d["_usage"]["input"] == 8000)
    try:
        make_ds([ds_resp(J(bad)), ds_resp(J(bad))], []).draft("山城", cons, None)
        check("两次都不合格 → AIError(schema)", False)
    except ai.AIError as e:
        check("两次都不合格 → AIError(schema) 带累计 usage", e.kind == "schema" and e.detail["usage"]["calls"] == 2)
    extra = copy.deepcopy(good)
    extra["plans"][0]["foo"] = 1
    extra["plans"][1]["site"]["size_m"] = 999
    extra["plans"][2]["lighting"] = None
    log = []
    d = make_ds([ds_resp("```json\n" + J(extra) + "\n```")], log).draft("山城", cons, None)
    check("代码块围栏 / 多余字段 / 可选 null / 越界 → 本地修，不回喂", len(log) == 1 and "foo" not in d["plans"][0] and d["plans"][1]["site"]["size_m"] == 240 and "lighting" not in d["plans"][2] and d.get("_fixes"), J(d.get("_fixes")))
    raw = json.dumps(good, ensure_ascii=False, indent=1).replace(ex[0]["name"], '寨"中"寨', 1)
    raw = raw[: raw.rfind("]")] + ",\n" + raw[raw.rfind("]"):]
    log = []
    d = make_ds([ds_resp(raw)], log).draft("山城", cons, None)
    check("坏 JSON（没转义的引号 + 尾逗号）本地修好 → 不回喂，usage.repaired", len(log) == 1 and d["_usage"].get("repaired") and d["plans"][0]["name"] == '寨"中"寨', J(d.get("_fixes")))
    log = []
    d = make_ds([ds_resp("这不是 json"), ds_resp(gs)], log).draft("山城", cons, None)
    check("修不好的 JSON → 回喂一次", len(log) == 2 and "不是合法 JSON" in log[-1][2]["messages"][-1]["content"])
    d = make_ds([ds_resp(J(good["plans"]))], []).draft("山城", cons, None)
    check("直接给数组 → 包成 {plans}", len(d["plans"]) == 3)
    try:
        make_ds([ds_resp('{"plans": [', finish="length")], []).draft("山城", cons, None)
        check("finish_reason=length → AIError(truncated)", False)
    except ai.AIError as e:
        check("finish_reason=length → AIError(truncated)", e.kind == "truncated")

    mp = mine_plan()
    log = []
    r = make_ds([ds_resp(J({"understood": True, "restatement": "改成迷宫", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}]}), completion=80)], log).revise(mp, {"type": "text", "text": "矿洞是个迷宫"}, set())
    check("revise：漏了 ask_to_point → 由 understood 推出，不回喂；max_tokens 2000", len(log) == 1 and r["ask_to_point"] is False and log[0][2]["max_tokens"] == 2000 and "当前 plan" in log[0][2]["messages"][1]["content"])
    r = ai.revise({"plan": mp, "action": "矿洞是个迷宫"}, make_ds([ds_resp(J({"understood": True, "restatement": "矿洞内部布局改成迷宫平面，其余不动。", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], "ask_to_point": False}))], []))
    check("revise 复述：模型已经说了「迷宫平面」就不再补一遍", r["restatement"].count("迷宫平面") == 1 and r["constraints_fixed"] == [], r["restatement"])
    r = ai.revise({"plan": mp, "action": "矿洞是个迷宫"}, make_ds([ds_resp(J({"understood": True, "restatement": "好的。", "ops": [], "ask_to_point": False}))], []))
    check("revise 锁（DeepSeek 路径）：模型漏了 → 本地补 set layout=maze，复述补「矿洞改成迷宫平面」", r["ops"] == [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}] and r["restatement"].startswith("矿洞改成迷宫平面"), J(r))
    log = []
    badops = {"understood": True, "restatement": "加戏台", "ops": [{"op": "set", "id": "ghost", "field": "label", "value": "x"}], "ask_to_point": False}
    okops = {"understood": True, "restatement": "加戏台", "ops": [{"op": "add", "group": "landmarks", "value": {"id": "stage", "label": "戏台", "form": "stage", "place": {"rel": "center_of", "target": "site"}}}], "ask_to_point": False}
    r = make_ds([ds_resp(J(badops)), ds_resp(J(okops))], log).revise(mp, {"type": "text", "text": "加个戏台"}, set())
    check("revise：ops 不合法（引用不存在的 id）→ 把具体错误回喂一次", len(log) == 2 and "ghost" in log[-1][2]["messages"][-1]["content"] and r["ops"][0]["op"] == "add")
    log = []
    make_ds([ds_resp('{"understood": true, "restatement": "好", "ops": [], "ask_to_point": false}')], log, thinking=True).revise(mp, {"type": "text", "text": "x"}, set())
    check("thinking=true → thinking enabled，max_tokens 加思考余量", log[-1][2]["thinking"] == {"type": "enabled"} and log[-1][2]["max_tokens"] == 2000 + ai.DeepSeekAI.THINKING_EXTRA)

    for code, word in ((401, "密钥"), (402, "余额"), (422, "模型名")):
        log = []
        try:
            make_ds([http_error(code, "Model Not Exist" if code == 422 else "err")], log).draft("山城", cons, None)
            check(f"HTTP {code} → DeepSeekAPIError", False)
        except ai.DeepSeekAPIError as e:
            p = ai.error_payload(e)
            check(f"HTTP {code} → 不重试，提示含「{word}」", len(log) == 1 and p["status"] == code and word in p["hint"] and p["provider"] == "deepseek" and p["retryable"] is False, J(p))
    log = []
    d = make_ds([http_error(429, "rate"), ds_resp(gs)], log).draft("山城", cons, None)
    check("429 → 重试 1 次后成功", len(log) == 2 and len(d["plans"]) == 3)
    log = []
    try:
        make_ds([urllib.error.URLError("refused"), urllib.error.URLError("refused")], log).draft("山城", cons, None)
    except ai.DeepSeekAPIError as e:
        check("断连 → 重试 1 次，APIConnectionError，可重试", len(log) == 2 and ai.error_payload(e)["type"] == "APIConnectionError" and ai.error_payload(e)["retryable"])
    log = []
    try:
        make_ds([socket.timeout("timed out")], log).draft("山城", cons, None)
    except ai.DeepSeekAPIError as e:
        check("超时 → 不重试，APITimeoutError", len(log) == 1 and ai.error_payload(e)["type"] == "APITimeoutError")
    log = []
    r = make_ds([ds_resp("ok", prompt=10, hit=0, completion=1)], log).ping()
    check("ping：最短请求（不开 json 模式、关思考、max_tokens 8）", r["ok"] and "response_format" not in log[-1][2] and log[-1][2]["max_tokens"] == 8)


# ============================================================ Claude（假 client）
class FakeBadRequest(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message, self.status_code, self.request_id = message, status_code, "req_fake"
        self.body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}


def fake_resp(text, stop_reason="end_turn", category=None):
    usage = NS(input_tokens=5000, output_tokens=3000, cache_read_input_tokens=4000, cache_creation_input_tokens=0, iterations=None)
    sd = NS(category=category, explanation="测试用") if stop_reason == "refusal" else None
    content = [NS(type="thinking", thinking="")] + ([NS(type="text", text=text)] if text is not None else [])
    return NS(content=content, stop_reason=stop_reason, stop_details=sd, usage=usage, model="claude-opus-5-5", _request_id="req_ok")


def make_claude(beta_create, plain_create):
    c = object.__new__(ai.ClaudeAI)
    c.anthropic = NS(BadRequestError=FakeBadRequest)
    c.model = "claude-opus-5-5"
    c.client = NS(beta=NS(messages=NS(create=beta_create)), messages=NS(create=plain_create))
    ai.ClaudeAI.fallback_beta_ok = True
    return c


def t_claude() -> None:
    good = J({"plans": copy.deepcopy(list(ai.example_plans().values())[:3])})
    calls = []

    def rec(name, text=good):
        def f(**kw):
            calls.append((name, kw))
            return fake_resp(text)
        return f
    d = make_claude(rec("beta"), rec("plain")).draft("黄昏山城", ai.extract("黄昏山城"), None)
    name, kw = calls[-1]
    check("Claude：beta.messages.create + server-side-fallback-2026-07-01 + fallbacks=default", name == "beta" and kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default")
    check("Claude：不传 thinking / temperature；effort=low；format=json_schema（已剥约束）；系统提示带 cache_control",
          not any(k in kw for k in ("thinking", "temperature", "top_p")) and kw["output_config"]["effort"] == "low" and kw["output_config"]["format"]["type"] == "json_schema"
          and not ai.has_key(kw["output_config"]["format"]["schema"], "maximum") and kw["system"][0]["cache_control"] == {"type": "ephemeral"})
    check("Claude：usage + cost_usd（Opus 5.5 价）", d["_usage"]["cost_usd"] == round((5000 * 4 + 3000 * 20 + 4000 * 0.2) / 1e6, 6) and len(d["plans"]) == 3, J(d["_usage"]))

    def beta_reject(**kw):
        calls.append(("beta", kw))
        raise FakeBadRequest("Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header")
    calls.clear()
    c = make_claude(beta_reject, rec("plain"))
    c.draft("山城", {}, None)
    c.draft("山城", {}, None)
    check("beta 被 400 → 退回普通调用，之后不再试 beta", [x[0] for x in calls] == ["beta", "plain", "plain"])
    ai.ClaudeAI.fallback_beta_ok = True
    for stop, kind in (("refusal", "refusal"), ("max_tokens", "truncated")):
        try:
            make_claude(lambda **kw: fake_resp(None if stop == "refusal" else '{"plans": [', stop_reason=stop, category="cyber"), None).draft("山城", {}, None)
            check(f"stop_reason={stop} → AIError({kind})", False)
        except ai.AIError as e:
            check(f"stop_reason={stop} → AIError({kind})", e.kind == kind)
    mp = mine_plan()
    calls.clear()
    r = make_claude(rec("beta", J({"understood": True, "restatement": "改成迷宫平面", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], "ask_to_point": False})), None).revise(mp, {"type": "text", "text": "矿洞是个迷宫"}, set())
    kw = calls[-1][1]
    check("Claude revise：effort=medium，ops 校验通过", kw["output_config"]["effort"] == "medium" and r["ops"][0]["value"] == "maze" and r["provider"] == "claude")
    p = ai.error_payload(FakeBadRequest("invalid x-api-key", status_code=401))
    check("错误 payload：401 → 密钥提示、不可重试；529 → 可重试", "密钥" in p["hint"] and p["retryable"] is False and ai.error_payload(FakeBadRequest("o", 529))["retryable"])


# ============================================================ HTTP
def call(base, method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def t_http(base: str) -> None:
    st, h = call(base, "GET", "/api/health")
    check("health 200，无密钥 → mock", st == 200 and h["ok"] and h["mock"] is True)
    st, s = call(base, "GET", "/api/plan/schema")
    check("GET /api/plan/schema = spec/plan.schema.json", st == 200 and s == ai.plan_schema())
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "地下有个矿洞，是个两层的迷宫"})
    check("POST /api/ai/draft（无密钥走模拟）→ plans×3 + constraints + diversity + provider + _usage + _ms",
          st == 200 and len(d["plans"]) == 3 and d["provider"] == "mock" and "_ms" in d and d["_usage"]["cost_cny"] == 0 and d["constraints"] and d["diversity"]["min"] >= 2, J(d)[:300])
    st, r = call(base, "POST", "/api/ai/revise", {"plan": mine_plan(), "action": "矿洞是个迷宫"})
    check("POST /api/ai/revise（action 可以是字符串）→ ops + 复述", st == 200 and r["ops"] and "迷宫平面" in r["restatement"] and "_ms" in r, J(r)[:300])
    st, e = call(base, "POST", "/api/ai/revise", {"plan": mine_plan()})
    check("revise 缺 action → 400", st == 400 and e["error"] == "bad request")
    st, e = call(base, "POST", "/api/ai/draft", {"intent": ""})
    check("draft 空 intent → 400", st == 400)
    st, _ = call(base, "POST", "/api/ai/draft", {"intent": "x"}, headers={"Origin": "http://evil.example"})
    check("外部 Origin → 403", st == 403)
    st, _ = call(base, "GET", "/api/nope")
    check("未知路由 → 404", st == 404)
    sid = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "B-sid", "scene.sid.json"), encoding="utf-8"))
    rb = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "scoring", "readback.example-unity.json"), encoding="utf-8"))
    st, s = call(base, "POST", "/api/score", {"intent": sid, "readback": rb, "auto_map": True})
    check("POST /api/score → summary + rows", st == 200 and s["summary"]["matched"] > 0, J(s)[:200])
    st, w = call(base, "POST", "/api/save", {"name": "../测试.sid.json", "content": {"a": 1}})
    check("POST /api/save 写 exports，不许路径穿越", st == 200 and os.path.isfile(w["path"]) and os.path.dirname(w["path"]).endswith("exports"))
    try:
        loc = urllib.request.build_opener(_NoRedirect()).open(base + "/", timeout=10).headers.get("Location")
    except urllib.error.HTTPError as ex:
        loc = ex.headers.get("Location")
    check("根路径 → /medium/", loc == "/medium/", loc)
    with urllib.request.urlopen(base + "/spec/plan.schema.json", timeout=10) as r2:
        check("静态文件（spec/plan.schema.json）可读", r2.status == 200)

    # 配置：不泄露明文
    key = "sk-test-deepseek-secret-9876wxyz"
    st, c = call(base, "POST", "/api/config", {"provider": "deepseek", "mock": False, "providers": {"deepseek": {"api_key": key, "thinking": True}, "anthropic": {"api_key": "sk-ant-test-1234567890abcdef"}}})
    blob = J(c)
    check("POST config → 只回 has_key / key_hint，不含明文", st == 200 and key not in blob and "sk-ant-test-1234567890abcdef" not in blob and c["providers"]["deepseek"]["key_hint"] == "sk-…wxyz" and c["mock"] is False and c["thinking"] is True)
    st, c = call(base, "GET", "/api/config")
    check("GET config 不含明文（两家都有密钥）", key not in J(c) and "api_key" not in J(c))
    st, h = call(base, "GET", "/api/health")
    check("health 带 provider / model / thinking", h["provider"] == "deepseek" and h["model"] == "deepseek-flash" and h["thinking"] is True and h["mock"] is False)
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "溪谷两岸，一座风雨桥，傍晚", "force_mock": True})
    check("有密钥也能 force_mock：provider=mock、不花钱", st == 200 and d["provider"] == "mock" and d["_usage"]["cost_cny"] == 0)

    orig = ai.DeepSeekAI._post_once
    sent = []
    good = J({"plans": copy.deepcopy(list(ai.example_plans().values())[:3])})

    def fake_post(self, body, timeout):
        sent.append(body)
        if body.get("max_tokens") == 8:
            return ds_resp("ok", prompt=10, hit=0, completion=1)
        return ds_resp(good)
    ai.DeepSeekAI._post_once = fake_post
    try:
        st, d = call(base, "POST", "/api/ai/draft", {"intent": "半山环台寨，吊脚木楼一圈圈往上长，崖边寨门"})
        fixed = [f for f in d.get("constraints_fixed", [])]
        check("draft 走 DeepSeek（打桩）→ provider=deepseek、cost_cny、思考开；锁定把寨门 / 吊脚木楼补进了三张",
              st == 200 and d["provider"] == "deepseek" and d["_usage"]["cost_cny"] is not None and sent[-1]["thinking"] == {"type": "enabled"}
              and all("寨门" in labels(p, "landmarks") and "吊脚木楼" in labels(p, "buildings") for p in d["plans"]) and fixed, J(fixed)[:300])
        st, t = call(base, "POST", "/api/config/test", {})
        check("config/test 按当前服务商发最短请求", st == 200 and t["ok"] and t["provider"] == "deepseek" and sent[-1]["max_tokens"] == 8)

        def fail_post(self, body, timeout):
            raise ai.DeepSeekAPIError("Authentication Fails", status_code=401, body={"error": {"message": "Authentication Fails", "type": "authentication_error"}})
        ai.DeepSeekAI._post_once = fail_post
        st, t = call(base, "POST", "/api/config/test", {"api_key": "sk-wrong-000000000000"})
        check("config/test 坏密钥 → ok=false + 中文提示，不回显密钥", st == 200 and t["ok"] is False and "密钥" in t["message"] and "sk-wrong" not in J(t))
        st, e = call(base, "POST", "/api/ai/draft", {"intent": "山城"})
        check("draft 遇 401 → 502 带 status / hint / provider", st == 502 and e["status"] == 401 and e["provider"] == "deepseek" and "密钥" in e["hint"])
    finally:
        ai.DeepSeekAI._post_once = orig
    with open(ai.config_path(), "w", encoding="utf-8") as f:
        json.dump({"api_key": "sk-ant-legacy-0000000000abcd", "model": "claude-opus-5-5", "mock": True}, f)
    st, c = call(base, "GET", "/api/config")
    check("旧的扁平配置 → 视为 anthropic，打码", c["provider"] == "anthropic" and c["key_hint"] == "sk-ant-…abcd")
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": "sk-zzzzzzzzzzzz1234"}}, "provider": "deepseek"})
    raw = json.load(open(ai.config_path(), encoding="utf-8"))
    check("保存后迁移：anthropic 密钥保留、扁平字段去掉", raw["providers"]["anthropic"]["api_key"] == "sk-ant-legacy-0000000000abcd" and "api_key" not in raw)
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": ""}}})
    check("清除密钥 → has_key=false、mock=true", not c["providers"]["deepseek"]["has_key"] and c["mock"] is True)


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    for fn in (t_schema, t_ops, t_locks, t_mock, t_deepseek, t_claude):
        try:
            fn()
        except Exception as e:  # noqa: BLE001  一组炸了不影响别的组
            import traceback
            check(f"{fn.__name__} 没有异常", False, traceback.format_exc()[-1500:])
    srv, port = app.start_server(ROOT, 0)
    try:
        t_http(f"http://127.0.0.1:{port}")
    except Exception:  # noqa: BLE001
        import traceback
        check("t_http 没有异常", False, traceback.format_exc()[-1500:])
    finally:
        srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\nDONE passed={len(results) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
