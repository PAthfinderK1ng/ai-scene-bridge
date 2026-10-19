# -*- coding: utf-8 -*-
"""
test_app.py — 后端测试（进程内起服务；模拟 AI / 假 urllib / 假 anthropic client，不需要密钥、不联网、不花钱）

  python -X utf8 desktop/test_app.py            每条用例打印 PASS / FAIL，最后 DONE passed=… failed=…，退出码 0 = 全过

覆盖：plan v2 schema 与示例、语法表与片段库提示词、场景树 ops（嵌套路径 / 实例 / 加到组 / 删实例）、根节点锚点规则、本地锁定（draft / revise）、
模拟 AI（任意题材三个结构不同的程序、revise 常见说法）、两步流程（假 DeepSeek：构思 1 次 + 展开 3 次并行、回喂、同概念重试、模拟补位、调用上限、费用合计）、
DeepSeek 细节（请求体、JSON 修复、HTTP 错误）、Claude 假客户端、配置不泄露明文、HTTP 路由。
"""
from __future__ import annotations

import copy
import datetime as dt
import io
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
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
ACCEPT = ["我要生成魔法学院", "赛博朋克夜市一角", "海盗港口", "沙漠里的古神殿", "空中花园", "山城村庄"]


def check(name: str, cond, info: str = "") -> None:
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not info else f"  —  {str(info)[:400]}"))


def J(x) -> str:
    return json.dumps(x, ensure_ascii=False)


def valid(p) -> list:
    return ai.validate(ai.plan_schema(), p)


def labels(p) -> str:
    return "|".join(str(n.get("label") or "") for n in ai.all_nodes(p))


def mock_plans(intent: str, variant: int = 0) -> list:
    return ai.draft({"intent": intent, "force_mock": True, "variant": variant})["plans"]


def academy() -> dict:
    """塔环学院：崖台 + 组（主殿 + 6 座塔的环形重复）+ 石阶"""
    return copy.deepcopy(mock_plans("我要生成魔法学院")[0])


def mine_plan() -> dict:
    """有一个「普通矿洞」（galleries）的程序"""
    p = academy()
    p["nodes"].append({"id": "mine", "type": "space", "stratum": "underground", "label": "矿洞", "under": "hall", "depth_m": 12, "layout": "galleries",
                       "size_m": 44, "branching": "medium", "sublevels": 1, "connect": {"via": "shaft", "from": "hall"}})
    return p


# ============================================================ schema / 示例 / 提示词
def t_schema() -> None:
    root = ai.plan_schema()
    check("spec/plan.schema.json 是 v2：site / terrain / nodes / spawn / relations，节点定义带 x-ui，ops 在 definitions",
          root.get("x-version") == 2 and {"site", "terrain", "nodes"} <= set(root["properties"]) and ai.has_key(root, "x-ui") and {"op_set", "op_add", "op_remove", "ops"} <= set(ai._defs(root)))
    ex = {k: p for k, p in ai.example_plans().items() if "nodes" in p}
    bad = {k: valid(p)[:2] for k, p in ex.items() if valid(p)}
    check(f"示例里的 v2 程序都合 schema（{len(ex)} 个：{', '.join(ex)}）", not bad, bad)
    names: set = set()

    def walk(n):
        if isinstance(n, dict):
            names.update((n.get("properties") or {}).keys())
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(root)
    bad = names & {"position", "x", "z", "points", "coords", "world_m", "center_m"}
    check("schema 里没有全局坐标字段（只有局部 offset_m / path_m）", not bad, bad)
    plans = [p for t in ACCEPT for p in mock_plans(t)]
    try:
        import jsonschema
        broken = copy.deepcopy(plans[0])
        broken["site"]["size_m"] = 999
        broken["nodes"][0]["type"] = "volcano"
        broken["foo"] = 1
        agree = all(bool(list(jsonschema.Draft7Validator(root).iter_errors(p))) == bool(valid(p)) for p in plans + [broken])
        check("本地校验器与 jsonschema 结论一致（18 张模拟程序 + 一张坏的）", agree and len(valid(broken)) >= 3, valid(broken))
    except ImportError:
        check("本地校验器（跳过 jsonschema 对照：没装）", True)

    def all_closed(n):
        if isinstance(n, dict):
            if (n.get("type") == "object" or "properties" in n) and n.get("additionalProperties") is not False:
                return False
            return all(all_closed(v) for v in n.values())
        if isinstance(n, list):
            return all(all_closed(v) for v in n)
        return True
    s = ai.claude_schema(ai.plan_out_schema())
    check("发给 Claude 的展开 schema：剥掉 minimum / pattern / maxLength / x-ui / oneOf / definitions，每个对象都封口，不含 locks / skip / overrides / layout_seed",
          not any(ai.has_key(s, k) for k in ("minimum", "maximum", "maxLength", "x-ui", "oneOf", "definitions", "maxItems")) and '"pattern": "^' not in J(s) and "$defs" in s and all_closed(s)
          and not any(k in J(s) for k in ('"locks"', '"skip"', '"overrides"', '"layout_seed"')))
    rs = ai.claude_schema(ai.revise_schema(), True)
    check("Claude revise schema：add 的 value = 节点 / 地形操作 / 关系之一；set 的 value 可以是节点", "#/$defs/node" in J(rs["$defs"]["op_add"]["properties"]["value"])
          and "#/$defs/node" in J(rs["$defs"]["op_set"]["properties"]["value"]) and all_closed(rs))
    check("构思 schema：3 个概念 × {name, concept, key_structures ≤5, terrain_idea, why_different}",
          ai.CONCEPT_SCHEMA["properties"]["concepts"]["minItems"] == 3 and ai.CONCEPT_SCHEMA["properties"]["concepts"]["items"]["properties"]["key_structures"]["maxItems"] == 5
          and set(ai.CONCEPT_SCHEMA["properties"]["concepts"]["items"]["required"]) == {"name", "concept", "key_structures", "terrain_idea", "why_different"})

    g = ai.grammar()
    types = (root["definitions"]["node"]["properties"]["type"]["enum"])
    ops = root["definitions"]["terrain_op"]["properties"]["op"]["enum"]
    check("语法表由 schema 生成：每种节点 type、每种地形 op 都在；size_m 各分量含义来自 x-size；不含 locks / skip / overrides",
          all(re.search(r"(^|[ /：])" + t + r"( |：|/)", g, re.M) for t in types) and all(o in g for o in ops) and "size_m=[直径,高,南北直径]" in g
          and not any(k in g for k in ("locks", "skip", "overrides", "layout_seed")), [t for t in types if not re.search(r"(^|[ /：])" + t + r"( |：|/)", g, re.M)])
    lib = ai.fragment_lines()
    blocks = lib.split("【")[1:]
    check(f"片段库 10–14 个、每个 3–8 行以内（实际 {len(blocks)} 个），覆盖塔群 / 轴线 / 浮岛 / 峡谷 / 地下 / 港口 / 金字塔 / 窄巷 / 城墙 / 湖心岛 / 瀑布 / 台地 / 迷宫",
          10 <= len(blocks) <= 14 and all(3 <= b.strip().count("\n") + 1 <= 8 for b in blocks)
          and all(w in lib for w in ("环形塔群", "轴线院落", "悬浮群岛", "峡谷栈道", "地下大厅", "港口码头", "阶梯金字塔", "窄巷", "城墙", "湖心岛", "瀑布", "台地村落", "迷宫")))
    check("片段都合 schema（逐个实例化成一张程序验证）", all(not valid({"name": "t", "site": {"size_m": [200, 200]}, "terrain": ai.instantiate({}, f["key"], f["demo"])[0],
                                                              "nodes": ai.instantiate({"nodes": [{"id": "hall", "type": "building"}]}, f["key"], f["demo"])[1] + [{"id": "hall", "type": "building", "at": "site.center"}]})
                                                for f in ai.FRAGMENTS))
    sp = ai.program_system_prompt()
    check("展开系统提示：语法表 + 片段库，不给整张示例；明说不要默认台地 / 撒房子、名字随便起、组内可写米制尺寸与偏移、根节点只能用锚点",
          g in sp and lib in sp and "不要默认用台地 / 撒房子" in sp and "名字随便起" in sp and "根节点只能用 at 锚点" in sp and "组内可以写米制" in sp
          and '"spawn"' not in lib and '"palette"' not in sp)
    cp = ai.concept_system_prompt()
    check("构思系统提示：先想题材自己的空间逻辑、三个不同设计动机、空间组织明显不同、why_different 写设计动机、不要默认台地、短（< 1500 字）",
          "空间逻辑" in cp and "灵魂结构" in cp and "设计动机" in cp and "空间组织方式**必须明显不同" in cp and "why_different" in cp
          and "不要默认「坡上台地 + 撒小房子」" in cp and len(cp) < 1500)
    check("构思系统提示没有固定例句 / 固定维度清单（悬崖城堡 / 浮空群岛 / 地下巨穴、「往天上走」、ORG_DIMS），明说不套「上 / 水 / 地下」三分法",
          not any(w in cp for w in ("悬崖城堡", "浮空群岛", "地下巨穴", "往天上走", "两两至少在两个维度", "抬到云上的高台")) and not hasattr(ai, "ORG_DIMS")
          and "三分法" in cp and "可以借鉴，不必照用" in cp)
    draws = [tuple(ai.draw_lenses()) for _ in range(12)]
    check(f"视角提示：≥ 16 个空间组织原则，每次随机抽 2 个不重复的（不是 3 个：三张卡会 1:1 照抄三个视角），12 次里至少 6 种组合（实际 {len(set(draws))} 种）",
          len(ai.LENSES) >= 16 and len(set(ai.LENSES)) == len(ai.LENSES) and all(len(set(d)) == 2 and set(d) <= set(ai.LENSES) for d in draws) and len(set(draws)) >= 6)
    cu = ai.concept_user_text("海盗港口", ai.extract("海盗港口"), None, 0, list(draws[0]))
    check("构思 user 文本：那句话 + 三个不同设计动机 + 随机视角（可选参考；至少一个概念不用视角、从灵魂结构出发；why_different 不引用视角名）",
          "海盗港口" in cu and "设计动机" in cu and all(x in cu for x in draws[0]) and "不必照用" in cu and "至少一个概念不用视角" in cu and "不要引用视角名" in cu
          and "至少一个概念不用视角" in cp and "不要写「来自某某视角」" in cp
          and "视角" not in ai.concept_user_text("海盗港口", {}, None), cu)
    check("展开系统提示：环带 / 绕坑摊道写成空心圆柱（hollow + wall_m）或 radial 弧段、竖环 torus + orient upright、放射桥网 = radial 的 child 是 link；铁律不许实心圆柱当环形走道",
          '"hollow":true,"wall_m"' in sp and '"orient":"upright"' in sp and '"child":{"type":"link"' in sp and '"pattern":"radial"' in sp and "绕坑摊道" in sp
          and "环形的走道 / 回廊 / 摊带 / 环廊写成空心圆柱（hollow:true，wall_m = 带宽）或 radial 弧段，不要写实心圆柱" in sp)


# ============================================================ 场景树 ops / 根节点规则 / 后处理
def t_ops() -> None:
    p = academy()
    idx = ai.index(p)
    check("index：地形操作 id、组里的节点（任何深度）都能按 id 找；towers[2] 找到 repeat", {"crag", "core", "hall", "towers"} <= set(idx) and ai.resolve(p, "towers[2]")[1]["type"] == "repeat")
    ops = [{"op": "set", "id": "towers", "field": "count", "value": 8},
           {"op": "set", "id": "towers", "field": "child.roof", "value": "dome"},
           {"op": "set", "id": "hall", "field": "size_m.1", "value": 26},
           {"op": "set", "id": "towers[2]", "field": "size_m", "value": [10, 50]},
           {"op": "remove", "id": "towers[4]"},
           {"op": "add", "to": "core", "value": {"type": "statue", "label": "院长像", "offset_m": [0, 20]}},
           {"op": "add", "to": "nodes", "value": {"id": "hall", "type": "tree", "label": "古树", "at": "site.E"}},
           {"op": "add", "to": "terrain", "value": {"op": "lake", "label": "湖", "at": "site.N", "size_m": [60, 40], "depth_m": 4}},
           {"op": "set", "id": "site", "field": "size_m", "value": [999, 200]},
           {"op": "set", "id": "lighting", "field": "time_of_day", "value": "night"},
           {"op": "set", "id": "plan", "field": "name", "value": "新学院"},
           {"op": "set", "id": "crag", "field": "edge_m", "value": None}]
    good, errs, fixes = ai.check_ops(p, ops)
    check("合法 ops 全收：嵌套路径（child.roof、size_m.1）、实例 set / remove、加到组 / 根（nodes → root）/ 地形、单例组、null 删字段；越界夹回；重名 id 改名",
          len(good) == len(ops) and not errs and good[6]["to"] == "root" and good[6]["value"]["id"] != "hall" and good[8]["value"] == [400, 200] and any("999" in f for f in fixes), J([errs, fixes]))
    q = ai.apply_ops(p, good)
    core = q["nodes"][0]
    tw = next(n for n in core["children"] if n.get("id") == "towers")
    check("apply_ops：count 8、模板穹顶、实例 2 写进 overrides、实例 4 写进 skip、组里多了院长像、根上多了古树、地形多了湖，结果仍合 schema",
          tw["count"] == 8 and tw["child"]["roof"] == "dome" and tw["overrides"] == {"2": {"size_m": [10, 50]}} and tw["skip"] == [4]
          and "院长像" in labels(q) and "古树" in labels(q) and any(t.get("op") == "lake" for t in q["terrain"]) and q["name"] == "新学院" and not valid(q), valid(q)[:3])
    bad = [{"op": "set", "id": "nope", "field": "label", "value": "x"}, {"op": "set", "id": "hall", "field": "nonexist", "value": 1},
           {"op": "set", "id": "hall", "field": "roof", "value": "banana"}, {"op": "set", "id": "towers", "field": "skip", "value": [1]},
           {"op": "add", "to": "towers", "value": {"type": "box"}}, {"op": "add", "to": "root", "value": {"type": "volcano"}},
           {"op": "remove", "id": "ghost"}, {"op": "explode"}]
    good, errs, _ = ai.check_ops(p, bad)
    check("不合法 ops 全拒并给出具体错误（不存在的 id / 字段、枚举外、skip 不能直接写、repeat 不能 add 子节点、坏类型、未知 op）", not good and len(errs) >= 8, J(errs))
    good, errs, fixes = ai.check_ops(p, [{"op": "set", "id": "hall", "field": "label", "value": "x"}, {"op": "remove", "id": "towers[1]"}], {"hall", "towers"})
    check("锁住的 id（含它的实例）不改，记进修正清单", not good and not errs and len(fixes) == 2)

    raw = {"name": "x", "site": {"size_m": [200, 200]}, "nodes": [
        {"id": "a", "type": "tower", "label": "塔", "offset_m": [80, -40], "position": [3, 4]},
        {"id": "a", "type": "building", "at": "site.N"},
        {"id": "s", "type": "space", "stratum": "underground", "under": "a.top", "connect": {"via": "stairs", "from": "site.center"}, "layout": "maze", "size_m": 30},
        {"id": "r", "type": "repeat", "pattern": "radial", "count": 200, "radius_m": 30, "at": "site.center", "child": {"type": "repeat", "pattern": "linear", "count": 10, "child": {"type": "box"}}},
        {"type": "building", "at": "a", "role": "boss", "roof": "pagoda"}]}
    out, fixes, errs = ai.postprocess_plan({"plan": raw})
    pp = out["plan"]
    check("后处理：根节点没锚点 → site.center 并丢掉全局 offset、position 去掉、ref 字段去部位、id 去重、形体 ≤ 600、可选字段的枚举外值本地删掉（不回喂）",
          not errs and pp["nodes"][0]["at"] == "site.center" and "offset_m" not in pp["nodes"][0] and "position" not in pp["nodes"][0]
          and pp["nodes"][1]["id"] != "a" and pp["nodes"][2]["under"] == "a" and pp["nodes"][2]["connect"]["from"] == "site"
          and ai.shape_count(pp) <= ai.MAX_SHAPES and "role" not in pp["nodes"][4] and "roof" not in pp["nodes"][4], J([errs, fixes])[:600])
    out, fixes, errs = ai.postprocess_plan({"plan": {"name": "x", "site": {}, "nodes": [{"type": "box", "at": "hall.front"}]}})
    check("后处理：锚点写了不认识的部位（hall.front）→ 去掉部位", not errs and out["plan"]["nodes"][0]["at"] == "hall", J([errs, fixes]))
    out, fixes, errs = ai.postprocess_plan({"plans": [{"name": "x", "site": {}, "nodes": [{"type": "box", "at": "site.N", "size_m": [1, 2, 3, 4]}]}]})
    check("后处理：{plans:[…]} 也收；size_m 多一项截掉", not errs and len(out["plan"]["nodes"][0]["size_m"]) == 3, errs)
    out, fixes, errs = ai.postprocess_plan({"plan": {"name": "x", "site": {}, "nodes": []}})
    check("后处理：nodes 为空 → 错误（要回喂）", errs, errs)
    # 真机（deepseek-flash，build/eval/raw-v5.json）里出现过的两类：房间没 id、links 写房间名；锚在崖顶又写 elev_m = 崖高
    raw = {"name": "x", "site": {}, "terrain": [{"op": "raise", "id": "crag", "at": "site.center", "size_m": [80, 80], "height_m": 14}],
           "nodes": [{"id": "g", "type": "group", "at": "crag.top", "elev_m": 14, "children": [{"type": "tower", "size_m": [10, 40]}]},
                     {"id": "isle", "type": "island", "at": "crag.top", "elev_m": 30},
                     {"id": "vault", "type": "space", "stratum": "underground", "under": "g", "layout": "rooms",
                      "rooms": [{"label": "钟室", "size": "l"}, {"label": "刻文室"}], "links": [["入口", "钟室"], ["钟室", "刻文室"]]}]}
    out, fixes, errs = ai.postprocess_plan({"plan": raw})
    pp = out["plan"]
    check("后处理：房间补 id、links 里的房间名换成 id（入口 → entry）；锚在 crag.top 又写 elev_m = 崖高 → 去掉，真悬空的（30 m）保留",
          not errs and [r["id"] for r in pp["nodes"][2]["rooms"]] == ["r1", "r2"] and pp["nodes"][2]["links"] == [["entry", "r1"], ["r1", "r2"]]
          and "elev_m" not in pp["nodes"][0] and pp["nodes"][1]["elev_m"] == 30, J([errs, fixes]))


# ============================================================ 本地锁定
def t_locks() -> None:
    c = ai.extract("我要生成魔法学院，七座法师塔，湖边，地下有两层的迷宫，夜里，从东边进")
    st = {x["key"]: x for x in c.get("structures", [])}
    check("extract：塔 × 7、湖、地下迷宫 2 层、夜里、东边进", st.get("tower", {}).get("count") == 7 and any(x["key"] == "lake" for x in c["terrain"])
          and c["spaces"][0]["layout"] == "maze" and c["spaces"][0]["sublevels"] == 2 and c["time_of_day"] == "night" and c["entry_side"] == "E", J(c))
    c2 = ai.extract("海盗港口，码头边有座灯塔，还有一座吊桥")
    check("extract：海 / 港口、码头、灯塔、吊桥", {x["key"] for x in c2["structures"]} >= {"harbor", "tower", "bridge"} and any(x["key"] == "sea" for x in c2["terrain"]), J(c2))
    c3 = ai.extract("沙漠里的古神殿，前面一座金字塔，峡谷边有城墙")
    check("extract：沙漠、峡谷、神殿、金字塔、城墙", {x["key"] for x in c3["structures"]} >= {"temple", "pyramid", "wall"} and {x["key"] for x in c3["terrain"]} >= {"desert", "canyon"}, J(c3))
    check("extract：「我要生成魔法学院」没有硬条件（学院不是结构词）", not ai.extract("我要生成魔法学院").get("structures"), J(ai.extract("我要生成魔法学院")))

    bare = {"name": "空", "site": {"size_m": [200, 200], "ground": "flat"}, "nodes": [{"id": "hall", "type": "building", "label": "主楼", "at": "site.center", "role": "landmark"}]}
    for sent, want in (("七座法师塔", lambda p: sum(n.get("count", 0) for n in ai.all_nodes(p) if n.get("type") == "repeat" and (n.get("child") or {}).get("type") == "tower") == 7),
                       ("三座浮岛", lambda p: any(n.get("type") == "repeat" and n.get("count") == 3 and (n.get("child") or {}).get("type") == "island" for n in ai.all_nodes(p))),
                       ("码头", lambda p: "码头" in labels(p)),
                       ("金字塔", lambda p: "金字塔" in labels(p)),
                       ("神殿", lambda p: "神殿" in labels(p)),
                       ("城墙", lambda p: any(n.get("type") == "wall" for n in ai.all_nodes(p))),
                       ("一座石桥", lambda p: any(n.get("type") == "link" and "石桥" in (n.get("label") or "") for n in ai.all_nodes(p))),
                       ("地下有个迷宫", lambda p: any(n.get("type") == "space" and n.get("layout") == "maze" for n in ai.all_nodes(p))),
                       ("地宫", lambda p: any(n.get("type") == "space" and n.get("layout") == "halls" for n in ai.all_nodes(p))),
                       ("湖边", lambda p: any(t.get("op") == "lake" for t in p.get("terrain") or []) or p["site"]["ground"] == "lake"),
                       ("沙漠", lambda p: p["site"]["ground"] == "desert"),
                       ("海边", lambda p: p["site"]["ground"] == "coast"),
                       ("峡谷", lambda p: any(t.get("op") == "carve" for t in p.get("terrain") or [])),
                       ("小小的一角", lambda p: p["site"]["size_m"][0] <= 140),
                       ("黄昏", lambda p: p["lighting"]["time_of_day"] == "dusk"),
                       ("从北边进", lambda p: p["spawn"]["at"] == "site.N")):
        q, ch = ai.enforce(bare, ai.extract(sent))
        check(f"锁定补「{sent}」：按片段 / 模板补上、锚在主体旁或场地方位、合 schema", want(q) and ch and not valid(q) and not ai.ref_warnings(q), J([ch, valid(q)[:2], ai.ref_warnings(q), labels(q)])[:300])
    q, ch = ai.enforce(academy(), ai.extract("法师塔"))
    check("已经有塔 → 不重复补", not ch, ch)
    q, ch = ai.enforce(academy(), ai.extract("夜里的学院"), keep_ids={"lighting"})
    check("人锁住的项不动（lighting 锁住时不改时段）", q["lighting"] == academy()["lighting"])

    mp = mine_plan()
    ops, notes, say = ai.enforce_ops(mp, [], "矿洞是个迷宫")
    check("revise 锁：「矿洞是个迷宫」→ set layout=maze，复述「矿洞改成迷宫平面」", ops == [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}] and "矿洞改成迷宫平面" in say, J([ops, say]))
    ops, notes, say = ai.enforce_ops(academy(), [], "去掉法师塔")
    check("revise 锁：「去掉法师塔」→ 删掉那组重复（模板没 id 时删它的 repeat）", ops == [{"op": "remove", "id": "towers"}], J(ops))
    ops, notes, say = ai.enforce_ops(academy(), [], "加一座浮岛，夜里")
    q = ai.apply_ops(academy(), ops)
    check("revise 锁：「加一座浮岛，夜里」→ add 浮岛 + set 时段，结果合 schema", any(o["op"] == "add" for o in ops) and any(o.get("field") == "time_of_day" for o in ops)
          and any(n.get("type") == "island" for n in ai.all_nodes(q)) and not valid(q), J(ops)[:300])
    ops, notes, say = ai.enforce_ops(academy(), [{"op": "set", "id": "lighting", "field": "time_of_day", "value": "night"}], "夜里")
    check("revise 锁：模型已经做到了就不补", not ops)

    # v5 第 1 轮验收：角色词不往每张塞同一个盒子；「空中」按这张自己的组织抬主体；补位按概念搭，不套同一组浮岛
    ring = {"name": "沙环神殿", "concept": "一圈柱廊围出环形圣所", "site": {"size_m": [200, 200], "ground": "desert"},
            "nodes": [{"id": "ring", "type": "repeat", "pattern": "radial", "count": 12, "radius_m": 30, "at": "site.center", "role": "landmark", "child": {"type": "column", "label": "残柱"}}]}
    q, ch = ai.enforce(ring, ai.extract("沙漠里的古神殿"))
    check("「神殿」：程序名字里说到了 + 有地标 → 不补盒子（节点数不变）", not ch and len(ai.all_nodes(q)) == len(ai.all_nodes(ring)), J(ch))
    altar = {"name": "脊上祭所", "site": {"size_m": [200, 200], "ground": "desert"},
             "nodes": [{"id": "altar", "type": "platform", "label": "方形祭坛", "at": "site.center", "role": "landmark", "size_m": [20, 4, 20]}]}
    q, ch = ai.enforce(altar, ai.extract("沙漠里的古神殿"))
    check("「神殿」：哪儿都没说到 → 给现有地标改名，不新加盒子", len(q["nodes"]) == 1 and "神殿" in q["nodes"][0]["label"] and ch and "主体改名" in ch[0], J([ch, q["nodes"]]))
    flat = {"name": "园", "site": {"size_m": [200, 200], "ground": "flat"}, "terrain": [{"op": "lower", "id": "pit", "at": "site.center", "shape": "circle", "size_m": [80, 80], "depth_m": 12}],
            "nodes": [{"id": "g", "type": "group", "at": "pit.bottom", "children": [{"id": "hall", "type": "building", "label": "花厅", "role": "landmark"}]}]}
    q, ch = ai.enforce(flat, ai.extract("空中花园"))
    check("「空中」没满足：把主体所在的组抬成悬空（锚在坑底的先抬出坑口），出生点补登空石阶；不补浮岛",
          "sky" in ai.organization(q) and q["nodes"][0]["elev_m"] >= 24 + 12 and not any(n.get("type") == "island" for n in ai.all_nodes(q))
          and any(n.get("type") == "link" and n.get("from") == "spawn" for n in q["nodes"]) and not valid(q), J([ch, q["nodes"][0].get("elev_m")]))
    sky_cs = [{"name": "悬园台", "concept": "一座被整片抬到云上的高台，台上种满花", "key_structures": ["台顶中央的圆亭", "绕台外缘的螺旋石梯"], "terrain_idea": "从云海里抬起一座高台"},
              {"name": "浮洲链", "concept": "十几个浮空土洲沿一条线排开，藤桥相连", "key_structures": ["最大浮洲上的石砌水塔", "串起诸洲的藤编吊桥"], "terrain_idea": "没有地面，只有云海"},
              {"name": "穹坑园", "concept": "平地往下挖出一口圆坑，坑壁一圈圈花圃", "key_structures": ["坑壁上环绕的五层种植龛", "坑底中央的浅水镜池"], "terrain_idea": "往下挖一个大圆坑"}]
    rs = [ai.recipe_from_concept(c) for c in sky_cs]
    ps = [ai.compose(r) for r in rs]
    ops = [[t["op"] for t in p.get("terrain") or []] for p in ps]
    check("补位按概念雕地形：抬起的有 raise、挖坑的有 lower；三张结构钥匙两两不同、没有一张借浮岛片段",
          "raise" in ops[0] and "lower" in ops[2] and not any(ai.same_structure(ai.structure_key(a), ai.structure_key(b)) for i, a in enumerate(ps) for b in ps[i + 1:])
          and not any("sky_islands" in r["frags"] for r in rs)
          and not any(valid(p) for p in ps), J([ops, [r["frags"] for r in rs], [valid(p)[:2] for p in ps]])[:400])
    chain = next(n for n in ai.all_nodes(ps[1]) if n.get("type") == "repeat" and (n.get("child") or {}).get("type") == "island")
    check("补位按概念的排法：「沿一条线」的浮洲排成一线（linear），出生点站在悬空台面上", chain["pattern"] == "linear" and ps[1]["spawn"]["at"] == "deck", J([chain, ps[1]["spawn"]])[:300])
    res = {"plans": [ai.compose(rs[0]), ai.compose(rs[0]), ps[2]], "concepts": sky_cs, "sources": ["mock"] * 3,
           "fills": [{"plan": k, "reason": "x"} for k in range(3)]}
    out = ai.finish_draft(res, ai.extract("空中花园"))
    check("补位卡结构一样 → diversity.clones + 警告「雷同」", out["diversity"].get("clones") == [[0, 1]] and out["diversity"]["org_min"] == 0 and any("雷同" in w for w in out["warnings"]), J(out["diversity"])[:300])
    # v5 第 3 轮验收：补位按关键结构的数量词与形状词出真实结构，不退回「环台 + 中央高台 + 一座塔 + 浮岛」
    acad = [{"name": "星轨环院", "concept": "一座环形魔法学院，七段弧形塔楼依次首尾相接围成中庭，学生沿圆环走廊逐层上行。",
             "key_structures": ["七段首尾相接的弧形塔楼，每段是一门学派", "圆环内立面螺旋阶梯贯通各段", "中庭悬浮的巨型星象仪", "环外缘一圈独立的飞行扫帚停靠廊"],
             "terrain_idea": "在湖心抬起一座环形石岛，圆环内外皆是水面"},
            {"name": "千阶竖院", "concept": "整座学院塞进一座中空高塔，学派按层垂直排布，越往上越危险，学生靠中央升降井通勤。",
             "key_structures": ["一座中空主塔，层数自下而上排列学派", "塔中心贯穿的魔力升降井", "塔顶悬空的禁咒观测台", "塔基一圈附属见习生小屋"],
             "terrain_idea": "从平地拔起一根孤耸的崖柱，塔体就嵌在崖柱里"},
            {"name": "埋钟学窟", "concept": "学院整体下沉为地下迷宫，走廊随矿脉乱拐，教室凿在岩腔里，靠回声定位找路。",
             "key_structures": ["入口竖井与地下钟形大厅", "三条沿矿脉分岔的教室廊道", "岩腔中的魔药实验窟", "地下暗河上的考场栈桥", "封闭的回声禁书室"],
             "terrain_idea": "平地往下挖，把整片岩层掏成蜂窝状洞窟"}]
    aps = [ai.compose(ai.recipe_from_concept(c)) for c in acad]
    m0, m1 = (next(n for n in ai.all_nodes(q) if n.get("id") == "main") for q in aps[:2])
    check("补位「七段首尾相接的弧形塔楼」→ 主体 radial × 7 的弧形段（段宽贴着圆周），「中空主塔」→ stack 叠层空心圆柱 + 每层一圈 torus",
          m0["pattern"] == "radial" and m0["count"] == 7 and m0["child"]["type"] == "box" and m0["child"]["size_m"][0] > 25
          and m1["pattern"] == "stack" and m1["child"].get("hollow") and m1["child"]["children"][0]["type"] == "torus", J([m0, m1])[:400])
    terr = [[(t["op"], t.get("shape")) for t in q.get("terrain") or []] for q in aps]
    check("补位地形只看 terrain_idea：「环形石岛」才出环形抬起，「一圈停靠廊 / 一圈小屋」只是排法；崖柱出 raise cliff；学窟不挖坑",
          ("raise", "ring") in terr[0] and terr[1] == [("raise", "circle")] and not terr[2] and not any(n.get("pattern") == "radial" and n.get("count") == 1 for q in aps for n in ai.all_nodes(q)), J(terr))
    check("补位不默认抬起主体组（core 不带 elev_m），「悬浮的星象仪」只抬它自己",
          not any(n.get("id") == "core" and n.get("elev_m") for q in aps for n in ai.all_nodes(q))
          and any(n.get("type") == "sphere" and n.get("elev_m") for n in ai.all_nodes(aps[0])), J([n for n in ai.all_nodes(aps[0]) if n.get("type") == "sphere"]))
    sp = next((n for n in ai.all_nodes(aps[2]) if n.get("type") == "space"), {})
    check("地下学窟：地下的关键结构写成地下空间的房间（钟形大厅 / 廊道 / 实验窟 / 栈桥 / 禁书室），「栈桥」不借港口片段、不出海岸",
          aps[2]["site"]["ground"] != "coast" and len(sp.get("rooms") or []) == 5 and any("禁书室" in r["label"] for r in sp["rooms"])
          and not any(n.get("label") in ("码头", "防波堤") for n in ai.all_nodes(aps[2])), J([aps[2]["site"], sp])[:400])
    check("补位不再出 32 × 18 × 24 的默认主楼", not any(n.get("size_m") == [32, 18, 24] for q in aps for n in ai.all_nodes(q)))
    cyb = {"name": "铁笼接龙", "concept": "沿废弃高架桥悬空串起的一列铁笼摊档，脚下是车流和雾，往上和往外挂。",
           "key_structures": ["高架桥面主摊台", "桥侧外挂的吊笼摊", "跨桥的钢索串灯", "桥墩下的小吃摊"], "terrain_idea": "没有平地，只有一道断头高架桥横在半空"}
    cq = ai.compose(ai.recipe_from_concept(cyb))
    labs_links = [n.get("label") for n in ai.all_nodes(cq) if n.get("type") == "link"]
    mn = next(n for n in ai.all_nodes(cq) if n.get("id") == "main")
    check("「桥侧外挂的吊笼摊 / 桥墩下的小吃摊」是摊不是桥；高架桥面是悬空的长台面，两侧外挂、桥下有摊、有桥墩",
          not any("摊" in str(x) for x in labs_links) and mn["type"] == "platform" and mn.get("elev_m") and any(n.get("label") == "桥墩" for n in ai.all_nodes(cq))
          and sum(1 for n in ai.all_nodes(cq) if n.get("type") == "repeat") >= 3, J([labs_links, mn])[:300])
    old = [{"name": "a", "site": {"size_m": [200, 200], "ground": g}, "terrain": [{"op": "raise", "shape": "ring", "edge": "slope"}, {"op": "raise", "shape": "circle", "edge": "terraced"}],
            "nodes": [{"id": "core", "type": "group", "at": "site.center", "children": [{"id": "main", "type": "tower", "roof": "cone", "role": "landmark"}]},
                      {"id": "isl", "type": "repeat", "pattern": "radial", "count": 3, "at": "core", "child": {"type": "island"}}]} for g in ("lake", "flat")]
    out = ai.finish_draft({"plans": old + [aps[2]], "concepts": acad, "sources": ["mock"] * 3, "fills": [{"plan": k, "reason": "x"} for k in range(3)]}, ai.extract("我要生成魔法学院"))
    check("雷同按骨架比（地形操作序列 + 主体形体 + 重复签名），不比地面：湖上和平地上的同一副「环台 + 塔 + 浮岛」认成雷同；本轮三张补位两两不雷同",
          out["diversity"].get("clones") == [[0, 1]] and not any(ai.same_structure(ai.structure_key(a), ai.structure_key(b)) for i, a in enumerate(aps) for b in aps[i + 1:]),
          J(out["diversity"])[:300])
    lane = {"name": "雨巷", "site": {"size_m": [140, 140]}, "terrain": [{"op": "lower", "shape": "rect", "size_m": [26, 140], "depth_m": 1.6, "edge": "terraced", "steps": 2}], "nodes": [{"id": "x", "type": "box", "at": "site.center"}]}
    pit = {"name": "坑", "site": {"size_m": [200, 200], "layer_m": 4}, "terrain": [{"op": "lower", "shape": "circle", "size_m": [120, 120], "depth_m": 12, "edge": "terraced", "steps": 3}], "nodes": [{"id": "x", "type": "box", "at": "site.center"}]}
    mesa = {"name": "台", "site": {"size_m": [200, 200], "layer_m": 4}, "terrain": [{"op": "raise", "shape": "circle", "size_m": [120, 120], "height_m": 12, "edge": "terraced", "steps": 3}], "nodes": [{"id": "x", "type": "box", "at": "site.center"}]}
    shallow = {**pit, "terrain": [{**pit["terrain"][0], "depth_m": 5}]}
    check("「台地」标签：街巷下陷 1.6 m 的两级台阶不算；带台阶边的坑 / 下沉不算（是坑，打「地下」）；抬起的台阶化高差 ≥ 2 × layer_m 且面积 ≥ 场地 10% 才算",
          "terraced" not in ai.organization(lane) and "terraced" not in ai.organization(pit) and "underground" in ai.organization(pit)
          and "terraced" in ai.organization(mesa) and "underground" not in ai.organization(shallow), [sorted(ai.organization(x)) for x in (lane, pit, mesa, shallow)])
    vault = {"name": "窖", "site": {"size_m": [200, 200]}, "nodes": [{"id": "h", "type": "building", "at": "site.center", "role": "landmark"},
                                                                     {"id": "v", "type": "space", "stratum": "underground", "under": "h", "layout": "maze"}]}
    check("「地下」标签：有地下 space 就打（哪怕地面只有一栋楼）", "underground" in ai.organization(vault), sorted(ai.organization(vault)))
    busy = {"name": "杂", "site": {"size_m": [220, 220], "ground": "lake"}, "terrain": [{"op": "raise", "id": "rock", "at": "site.center", "shape": "circle", "size_m": [70, 70], "height_m": 30, "edge": "cliff"}],
            "nodes": [{"id": "core", "type": "group", "at": "rock.top", "children": [
                {"id": "hall", "type": "building", "size_m": [36, 22, 24], "role": "landmark"},
                {"id": "towers", "type": "repeat", "pattern": "radial", "count": 6, "radius_m": 26, "child": {"type": "tower", "size_m": [8, 34]}},
                {"id": "deco", "type": "group", "children": [{"type": "repeat", "pattern": "mirror", "axis": "x", "child": {"type": "statue", "offset_m": [4, 0]}},
                                                             {"type": "repeat", "pattern": "scatter", "count": 9, "child": {"type": "rock"}},
                                                             {"type": "repeat", "pattern": "linear", "count": 5, "child": {"type": "column"}},
                                                             {"type": "courtyard", "size_m": [10, 8]}]}]},
                      {"type": "link", "from": "site.S", "to": "hall"}, {"type": "link", "from": "hall", "to": "towers[0]"}, {"type": "link", "from": "hall", "to": "towers[3]"}]}
    ob = ai.organization(busy)
    check("组织标签只打主体结构的 2–4 个：湖 + 崖 + 塔环是主体；一对石像 / 散落的岩 / 一排柱 / 小院 / 三条路是细节，不打",
          2 <= len(ob) <= 4 and {"water", "vertical", "radial"} <= ob and not ob & {"axial", "scatter", "linear", "enclosed"}
          and {"axial", "scatter", "linear", "enclosed"} <= ai.organization(busy, full=True), [sorted(ob), ai.org_scores(busy)])
    vale = lambda **t: {"name": "x", "site": {"size_m": [200, 200]}, "terrain": [{"op": "lower", "id": "v", "at": "site.center", "shape": "ellipse", **t}], "nodes": []}  # noqa: E731
    check("压低 > 6 m：宽缓的谷（160 × 100 深 8、坡边）不算地下；崖边 / 台阶边、或深 ≥ 短边 15% 的坑才算",
          "underground" not in ai.organization(vale(size_m=[160, 100], depth_m=8, edge="slope"), full=True)
          and "underground" in ai.organization(vale(size_m=[60, 60], depth_m=12, edge="slope"), full=True)
          and "underground" in ai.organization(vale(size_m=[160, 100], depth_m=8, edge="terraced"), full=True),
          [sorted(ai.organization(vale(size_m=[160, 100], depth_m=8, edge="slope"), full=True))])
    S = {"size_m": [200, 200], "layer_m": 4}
    shaft = {"name": "井", "site": S, "terrain": [{"op": "lower", "id": "shaft", "at": "site.center", "shape": "circle", "size_m": [120, 120], "depth_m": 20, "edge": "cliff"}],
             "nodes": [{"id": "g", "type": "repeat", "pattern": "radial", "at": "shaft.center", "count": 7, "radius_m": 44, "child": {"type": "group", "elev_m": 26, "children": [{"type": "cylinder", "size_m": [24, 1.6]}]}}]}
    dug = {**shaft, "nodes": [{"id": "h", "type": "building", "at": "shaft.center", "size_m": [20, 10, 20]}]}
    cut = {"name": "槽", "site": S, "terrain": [{"op": "carve", "id": "c", "from": "site.S", "to": "site.N", "width_m": 6, "depth_m": 2}, {"op": "carve", "id": "c2", "at": "site.center", "shape": "circle", "size_m": [16, 16], "depth_m": 2}],
           "nodes": [{"id": "pool", "type": "water", "at": "site.center", "size_m": [22, 14], "role": "landmark"}, {"id": "ad", "type": "wall", "at": "site.N", "size_m": [34, 16, 1.2]}]}
    canals = {"name": "渠", "site": {"size_m": [140, 140]}, "terrain": [{"op": "lower", "id": f"c{i}", "at": "site.center", "shape": "line", "path_m": [[-80, z], [80, z]], "width_m": 8, "depth_m": 4} for i, z in enumerate((-34, 0, 36))],
              "nodes": [{"id": "w", "type": "water", "at": "c1", "size_m": [160, 10]}, {"id": "cells", "type": "repeat", "pattern": "grid", "rows": 3, "cols": 4, "at": "site.center", "child": {"type": "platform", "size_m": [30, 2, 30]}}]}
    slabs = {"name": "楼板", "site": {"size_m": [140, 120], "layer_m": 4}, "terrain": [{"op": "raise", "id": f"s{h}", "at": "site.center", "shape": "rect", "size_m": [w, d], "height_m": h, "edge": "terraced"} for w, d, h in ((40, 34, 4), (34, 30, 9), (28, 24, 14))],
             "nodes": [{"id": "x", "type": "box", "at": "site.center"}]}
    o = {k: ai.organization(v, full=True) for k, v in (("shaft", shaft), ("dug", dug), ("cut", cut), ("canals", canals), ("slabs", slabs))}
    check("组织标签按尺度称重：只有悬在坑上方的浮圃 → 地下只算细节，坑里放了东西才是地下；2 m 深的槽 / 浅池、小水池、广告墙不打峡谷 / 水上 / 围合；三条渠 + 网格重复 = 网格 + 水上；高低不同的叠台楼板 = 台地",
          ai.org_scores(shaft).get("underground") == 1 and "underground" not in ai.organization(shaft) and ai.org_scores(dug).get("underground") == 3
          and not {"canyon", "enclosed"} & ai.organization(cut) and ai.org_scores(cut).get("water") == 1 and "canyon" not in o["cut"]
          and {"grid", "water"} <= ai.organization(canals) and ai.org_scores(slabs).get("terraced") == 2 and ai.ORG_CN["grid"] == "网格",
          J({k: ai.org_scores(v) for k, v in (("shaft", shaft), ("dug", dug), ("cut", cut), ("canals", canals), ("slabs", slabs))}))
    sub = {"name": "x", "site": {"size_m": [200, 200]}, "nodes": [{"id": "axis", "type": "group", "at": "site.center", "children": [{"id": "obelisk", "type": "prism"}, {"id": "hall", "type": "building"}]},
                                                                {"id": "rock", "type": "rock", "at": "axis.obelisk"}, {"id": "lamp", "type": "box", "at": "axis.hall.top"}, {"id": "s", "type": "box", "at": "axis.N"}]}
    fx = ai.fix_sub_anchors(sub)
    check("「组.子节点」锚点 → 子节点自己的 id（axis.obelisk → obelisk，axis.hall.top → hall.top），真部位不动", [n.get("at") for n in sub["nodes"][1:]] == ["obelisk", "hall.top", "axis.N"] and len(fx) == 2, J(fx))


# ============================================================ 模拟 AI
def t_mock() -> None:
    for t in ACCEPT + ["地下有个矿洞，是个两层的迷宫", "未来感的科技园区"]:
        r = ai.draft({"intent": t, "force_mock": True})
        ps = r["plans"]
        bad = [valid(p)[:2] for p in ps if valid(p)]
        presets = [ai.preset_flags(p) for p in ps]
        old = sum(1 for x in presets if x)
        check(f"模拟「{t}」：3 张合 schema、空间组织两两差 ≥ 2（{r['diversity']['organization']}）、" + ("可以有台地" if "山城" in t else "没有台地 / 撒房子"),
              len(ps) == 3 and not bad and r["diversity"]["org_min"] >= 2 and (old <= 1 if "山城" in t else old == 0) and len({p["name"] for p in ps}) == 3
              and all(p.get("concept") for p in ps) and len(r["concepts"]) == 3 and not r["warnings"], J([bad, r["diversity"], presets, r["warnings"]])[:400])
    for v in range(4):  # 模拟配方轮换：每批最多一个往上（塔 / 崖 / 浮空）、最多一个往下，不是「上 / 浮空 / 地下」三分法
        rv = ai.draft({"intent": "我要生成魔法学院", "force_mock": True, "variant": v})
        kinds = [ai.organization(p) for p in rv["plans"]]
        dirs = [c.get("_recipe", {}).get("dir") for c in rv["concepts"]] if all("_recipe" in c for c in rv["concepts"]) else []
        triad = any("vertical" in k for k in kinds) and any("sky" in k for k in kinds) and any("underground" in k for k in kinds)
        check(f"学院第 {v + 1} 批：不是塔 / 浮空 / 地下三分法，往上 / 往下各最多一张（{[p['name'] for p in rv['plans']]}）",
              not triad and sum(1 for k in kinds if "underground" in k) <= 1 and all("terraces" not in labels(p) for p in rv["plans"]) and dirs.count("up") <= 1,
              J([[p["name"] for p in rv["plans"]], [sorted(k) for k in kinds]]))
    names = {n for v in range(4) for n in (r["name"] for r in ai.recipes_for("我要生成魔法学院", v))}
    check("学院的模拟配方有 ≥ 5 个组织轮换着出", len(names) >= 5, sorted(names))
    r = ai.draft({"intent": "我要生成魔法学院", "force_mock": True})
    check("模拟构思：每个概念有 name / concept / key_structures / terrain_idea / why_different，且合构思 schema", not ai.validate(ai.CONCEPT_SCHEMA, {"concepts": r["concepts"]}), J(r["concepts"])[:300])
    r2 = ai.draft({"intent": "我要生成魔法学院", "force_mock": True})
    check("确定性：同输入同结果", J(r["plans"]) == J(r2["plans"]))
    r3 = ai.draft({"intent": "我要生成魔法学院", "force_mock": True, "variant": 1})
    check("换一批（variant=1）：概念换了", [p["name"] for p in r3["plans"]] != [p["name"] for p in r["plans"]] and not any(valid(p) for p in r3["plans"]), [p["name"] for p in r3["plans"]])
    r = ai.draft({"intent": "我要生成魔法学院，七座法师塔，夜里", "force_mock": True})
    check("锁定在三张上都生效（七座法师塔、夜里）", all(p["lighting"]["time_of_day"] == "night" and "法师塔" in labels(p) for p in r["plans"]) and "7 个法师塔" in r["constraints"], J(r["constraints_fixed"]))
    p = academy()
    lk = ai.draft({"intent": "我要生成魔法学院", "force_mock": True, "variant": 1, "locked": {"plan": p, "ids": ["hall"]}})
    check("锁住主殿再换一批：三张都原样带着主殿（locks 记下）", all(any(n.get("id") == "hall" and {k: v for k, v in n.items() if k != "at"} == ai.index(p)["hall"][1] for n in ai.all_nodes(q)) and q.get("locks") == ["hall"] for q in lk["plans"])
          and not any(valid(q) for q in lk["plans"]), J([valid(q)[:2] for q in lk["plans"]]))
    for text, want in (("法师塔再高一点", lambda o: o[0]["field"] == "child.size_m"), ("多两座塔", lambda o: o[0]["value"] == 8), ("主殿大一点", lambda o: o[0]["id"] == "hall"),
                       ("主殿换成尖顶", lambda o: o[0]["value"] == "spire"), ("塔散开一点", lambda o: o[0]["field"] == "radius_m"), ("崖台更陡", lambda o: o[0]["id"] == "crag"),
                       ("主殿悬空", lambda o: o[0]["field"] == "elev_m"), ("去掉环崖石阶", lambda o: o[0] == {"op": "remove", "id": "crag_stair"}),
                       ("加一座城墙", lambda o: any(x["op"] == "add" and x["value"]["type"] == "wall" for x in o)), ("夜里", lambda o: o[0]["value"] == "night")):
        rv = ai.revise({"plan": p, "action": text, "force_mock": True})
        check(f"模拟 revise「{text}」→ 合法 ops + 复述", rv["ops"] and want(rv["ops"]) and rv["restatement"] and not valid(ai.apply_ops(p, rv["ops"])), J(rv)[:300])
    rv = ai.revise({"plan": p, "action": "让它更有感觉", "force_mock": True})
    check("模拟 revise 翻不了 → 请人在图上指", rv["ops"] == [] and rv["ask_to_point"] and rv["question"])


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
    """script：列表（按顺序回）或函数 body → 回包 / 异常（并行时按请求内容回）"""
    seq = list(script) if isinstance(script, list) else None
    lock = threading.Lock()

    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        with lock:
            log.append((req.full_url, dict(req.header_items()), body, timeout, threading.get_ident()))
            item = seq.pop(0) if seq is not None else None
        if seq is None:
            item = script(body)
        if isinstance(item, BaseException):
            raise item
        return FakeHTTPResp(item)
    d = ai.DeepSeekAI("sk-test-deepseek-0000000000abcd", kw.pop("model", "deepseek-flash"), urlopen=urlopen, **kw)
    d.retry_sleep = 0
    return d


MOCK_CONCEPTS = ai.MockAI().concepts("我要生成魔法学院", {}, None)["concepts"]
GOOD_CONCEPTS = J({"concepts": [{k: v for k, v in c.items() if not k.startswith("_")} for c in MOCK_CONCEPTS]})
GOOD_PLANS = [ai.MockAI().expand("我要生成魔法学院", {}, MOCK_CONCEPTS, k, None)["plan"] for k in range(3)]


def which(body) -> tuple[str, int]:
    """假服务器看请求：构思 / 展开第几张 / 改动；回喂的第二轮带 assistant"""
    sysmsg, user = body["messages"][0]["content"], body["messages"][1]["content"]
    if "空间构思师" in sysmsg:
        return "concepts", -1
    m = re.search(r"你写第 (\d) 张", user)
    if m:
        return "expand", int(m.group(1)) - 1
    return "revise", -1


def router(bad_k: dict | None = None, delay: float = 0.0):
    """bad_k：{k: 前几次回坏程序}；delay：展开时睡多久（测并行）"""
    bad_k = dict(bad_k or {})
    lock = threading.Lock()

    def f(body):
        kind, k = which(body)
        if kind == "concepts":
            return ds_resp(GOOD_CONCEPTS, prompt=900, hit=0, completion=400)
        if kind == "expand":
            time.sleep(delay)
            with lock:
                n = bad_k.get(k, 0)
                if n:
                    bad_k[k] = n - 1
            if n:
                return ds_resp(J({"plan": {"name": "坏", "site": {}, "nodes": []}}), prompt=5000, hit=4000, completion=300)
            return ds_resp(J({"plan": GOOD_PLANS[k]}), prompt=5000, hit=4000, completion=1500)
        return ds_resp(J({"understood": True, "restatement": "好", "ops": [], "ask_to_point": False}), completion=40)
    return f


def t_two_step() -> None:
    log: list = []
    d = make_ds(router(delay=0.3), log)
    t0 = time.time()
    r = ai.draft({"intent": "我要生成魔法学院"}, d)
    wall = time.time() - t0
    kinds = [which(x[2]) for x in log]
    check("两步：构思 1 次 + 展开 3 次（一张一次）", [k for k, _ in kinds].count("concepts") == 1 and sorted(k for kk, k in kinds if kk == "expand") == [0, 1, 2] and len(log) == 4, kinds)
    check(f"展开并行（3 × 0.3 s 只用了 {wall:.2f} s，3 个不同线程）", wall < 0.8 and len({x[4] for x in log[1:]}) == 3, wall)
    c_body = log[0][2]
    e_body = next(x[2] for x in log if which(x[2])[0] == "expand")
    check("构思请求：短系统提示 + json_object + 思考关 + max_tokens 1500；展开请求：语法表 + 片段库 + max_tokens 6000",
          c_body["response_format"] == {"type": "json_object"} and c_body["max_tokens"] == 1500 and c_body["thinking"] == {"type": "disabled"} and len(c_body["messages"][0]["content"]) < 1500
          and e_body["messages"][0]["content"] == ai.program_system_prompt() and e_body["max_tokens"] == 6000 and "环形塔群" in e_body["messages"][0]["content"])
    eu = e_body["messages"][1]["content"]
    check("展开的 user 文本：那句话 + 本张概念 + 另两张概念（不要撞）+ 输出 {plan}", "我要生成魔法学院" in eu and "另两张" in eu and '{"plan": {...}}' in eu and all(c["name"] in eu for c in MOCK_CONCEPTS))
    u = r["_usage"]
    check("_usage = 四次合计（calls 4、input 900 + 3×5000、output 400 + 3×1500），parts 分项，费用 = 分项之和",
          u["calls"] == 4 and u["input"] == 900 + 15000 and u["output"] == 400 + 4500 and len(u["parts"]["expand"]) == 3 and u["parts"]["concepts"]["calls"] == 1
          and abs(u["cost_cny"] - round(sum(x["cost_cny"] for x in [u["parts"]["concepts"]] + u["parts"]["expand"]), 6)) < 1e-9, J({k: v for k, v in u.items() if k != "parts"}))
    cu = c_body["messages"][1]["content"]
    lz = r["_steps"][0].get("lenses") or []
    check("构思请求带 2 个随机视角，抽到的视角写进 _steps[0].lenses（复盘用）", len(lz) == 2 and all(x in cu for x in lz) and "不必照用" in cu, [lz, cu[-200:]])
    check("draft 响应：plans × 3 + concepts × 3 + sources 全是 deepseek + 没有补位 + _steps 4 步 + diversity",
          len(r["plans"]) == 3 and len(r["concepts"]) == 3 and r["sources"] == ["deepseek"] * 3 and r["fills"] == [] and len(r["_steps"]) == 4 and r["diversity"]["org_min"] >= 2
          and not any(k.startswith("_") for c in r["concepts"] for k in c) and r["provider"] == "deepseek")

    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(router({1: 1}), log))
    exp1 = [x for x in log if which(x[2]) == ("expand", 1)]
    check("第 2 张第一次不合 schema → 把错误回喂一次（同一次对话）后成功，usage 累加", len(exp1) == 2 and exp1[1][2]["messages"][-1]["role"] == "user" and "问题" in exp1[1][2]["messages"][-1]["content"]
          and r["sources"][1] == "deepseek" and r["_steps"][2]["feedback"] and r["_steps"][2]["usage"]["calls"] == 2, J(r["_steps"])[:300])
    check("回喂前那一轮的 schema 错记进 _steps[k].first_errors（看模型反复错在哪个字段）", r["_steps"][2].get("first_errors") and all(isinstance(x, str) for x in r["_steps"][2]["first_errors"]),
          J(r["_steps"][2])[:300])
    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(router({2: 2}), log))
    exp2 = [x for x in log if which(x[2]) == ("expand", 2)]
    check("第 3 张回喂后仍不合格 → 用同一概念重新调一次（新对话）→ 成功，attempts=2", len(exp2) == 3 and len(exp2[2][2]["messages"]) == 2 and r["sources"][2] == "deepseek"
          and r["_steps"][3]["attempts"] == 2 and r["_steps"][3]["usage"]["calls"] == 3, J(r["_steps"][3])[:300])
    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(router({0: 9}), log))
    check("第 1 张两轮都不行 → 模拟 AI 用同一概念补那一张并标注（sources / fills / warnings），其余两张照常；花掉的钱照算",
          r["sources"] == ["mock", "deepseek", "deepseek"] and r["fills"][0]["plan"] == 0 and any("补位" in w for w in r["warnings"]) and not valid(r["plans"][0])
          and r["plans"][0]["name"] == MOCK_CONCEPTS[0]["name"] and r["_usage"]["calls"] == 1 + 4 + 2, J([r["fills"], r["_usage"]["calls"]]))
    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(router({0: 9, 1: 9, 2: 9}), log, max_calls=4))
    check("调用上限 4 次：构思 1 + 展开 3 后不再发请求，坏的那几张模拟补位", len(log) == 4 and r["sources"] == ["mock"] * 3 and len(r["fills"]) == 3, J([len(log), r["fills"]]))
    check("调用上限撞上时第一轮的 schema 错与回包开头照样带出来（_steps[k].first_errors / first_sample），不只是「budget」",
          all(st.get("first_errors") and st.get("first_sample") for st in r["_steps"][1:]) and any("$.nodes" in x for x in r["_steps"][1]["first_errors"]), J(r["_steps"][1])[:400])

    def nearly(body):  # 展开第一轮：好程序里混进一个写错的节点（type 不认识）——没有回喂预算时本地去掉它就能用
        kind, k = which(body)
        if kind == "concepts":
            return ds_resp(GOOD_CONCEPTS, prompt=900, hit=0, completion=400)
        pl = copy.deepcopy(GOOD_PLANS[k])
        pl["nodes"].append({"id": "oops", "type": "flying_castle", "at": "site.N", "size_m": [10, 10, 10]})
        pl["nodes"].append({"id": "oops_link", "type": "link", "style": "bridge", "from": "site.S", "to": "oops"})
        return ds_resp(J({"plan": pl}), prompt=5000, hit=4000, completion=1500)
    log = []
    logdir = tempfile.mkdtemp(prefix="ds-logs-")
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(nearly, log, max_calls=4, log_dir=logdir))
    check("没有回喂预算、只错一个节点 → 本地去掉它（连到它的桥一并去掉）后通过，不补位；_steps 标 salvaged 并留着第一轮的错",
          len(log) == 4 and r["sources"] == ["deepseek"] * 3 and not r["fills"] and all(st.get("salvaged") and st.get("first_errors") for st in r["_steps"][1:])
          and all("oops" not in J(pl) for pl in r["plans"]) and not any(valid(pl) for pl in r["plans"]), J([r["sources"], r["_steps"][1]])[:400])
    files = sorted(os.listdir(logdir))
    raw = "".join(open(os.path.join(logdir, f), encoding="utf-8").read() for f in files)
    check("每次 HTTP 的原样回包落盘（log_dir），不含密钥、不含系统提示全文（只记长度）",
          len(files) == 4 and "sk-test-deepseek" not in raw and "Bearer" not in raw and "flying_castle" in raw and '"system_chars"' in raw
          and ai.program_system_prompt()[:200] not in raw, [len(files), len(raw)])
    check("get_ai 给 DeepSeek 配上 %LOCALAPPDATA%/ai-scene-bridge/logs", ai.get_ai({"provider": "deepseek", "api_key": "sk-test"}).log_dir == os.path.join(ai.data_dir(), "logs"))
    big = copy.deepcopy(GOOD_PLANS[0])
    big["nodes"] += [{"id": f"bad{i}", "type": "flying_castle", "at": "site.N"} for i in range(4)]
    _, _, er = ai.postprocess_plan({"plan": big})
    _, _, er2 = ai.salvage_plan({"plan": big}, er)
    check("本地救：要去掉的节点 > 3 个就不救（整张写歪了，宁可补位）", er and er2, er2[-1:] if er2 else er)
    check("draft 的 payload.max_calls 夹到 1–8，没给默认 8（一次出卡最多 8 次 HTTP）",
          ai._max_calls(3) == 3 and ai._max_calls(50) == 8 and ai._max_calls(0) == 1 and ai._max_calls(None) == 8 and ai._max_calls("x") == 8
          and ai.get_ai({"provider": "deepseek", "api_key": "sk-test"}, max_calls=ai._max_calls(5)).max_calls == 5)

    def http_fail(body):
        kind, k = which(body)
        if kind == "expand" and k == 1:
            return http_error(500, "boom")
        return router()(body)
    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(http_fail, log))
    check("某张展开遇 HTTP 500（内部已重试一次）→ 同概念再来一次 → 还不行就模拟补位", r["sources"][1] == "mock" and len([x for x in log if which(x[2]) == ("expand", 1)]) == 4 and "500" in r["fills"][0]["reason"] + "500", J(r["fills"]))

    def bad_concepts(body):
        if which(body)[0] == "concepts":
            return ds_resp(J({"concepts": [{"name": "只有一个"}]}))
        return router()(body)
    log = []
    r = ai.draft({"intent": "我要生成魔法学院"}, make_ds(bad_concepts, log))
    check("构思两轮都不合格 → 概念改用模拟 AI 的，展开照样走模型（_concepts_fallback 标注）", r.get("_concepts_fallback") and r["sources"] == ["deepseek"] * 3
          and len([x for x in log if which(x[2])[0] == "concepts"]) == 2, J([r.get("_fixes"), r["sources"]])[:300])
    try:
        ai.draft({"intent": "我要生成魔法学院"}, make_ds(lambda b: http_error(401, "Authentication Fails"), []))
        check("构思遇 401 → 抛出（不悄悄用模拟）", False)
    except ai.DeepSeekAPIError as e:
        check("构思遇 401 → 抛出（不悄悄用模拟）", e.status_code == 401)
    log = []
    r = ai.draft({"intent": "我要生成魔法学院，七座法师塔，夜里"}, make_ds(router(), log))
    check("真模型路径也锁定：句子里说死的（七座法师塔、夜里）三张都补上", all(p["lighting"]["time_of_day"] == "night" for p in r["plans"])
          and all(sum(n.get("count", 0) for n in ai.all_nodes(p) if n.get("type") == "repeat" and "塔" in str((n.get("child") or {}).get("label"))) == 7 for p in r["plans"])
          and "七座法师塔" in log[0][2]["messages"][1]["content"], J(r["constraints_fixed"])[:300])


def t_deepseek() -> None:
    cons = ai.extract("黄昏的学院")
    cpt = MOCK_CONCEPTS
    log = []
    d = make_ds([ds_resp(J({"plan": GOOD_PLANS[0]}))], log)
    out = d.expand("黄昏的学院", cons, cpt, 0, None)
    url, headers, body, timeout, _ = log[-1]
    check("DeepSeek 请求：/chat/completions + Bearer + json_object + 不流式 + 超时 120 s", url == "https://api.deepseek.com/chat/completions" and headers.get("Authorization", "").startswith("Bearer ")
          and body["stream"] is False and timeout == ai.DeepSeekAI.TIMEOUT and out["plan"]["name"] == GOOD_PLANS[0]["name"])
    u = out["_usage"]
    want = round((3000 * (0.04 if u["peak"] else 0.02) + 1000 * (2 if u["peak"] else 1) + 2500 * (8 if u["peak"] else 4)) / 1e6, 6)
    check("usage：input / output / cache_read / request_id / cost_cny（按时段价目）", u["input"] == 4000 and u["output"] == 2500 and u["cache_read"] == 3000 and u["request_id"] == "ds-req-1" and u["cost_cny"] == want, J(u))
    check("费用：空闲 flash 2000 入（1500 命中）+ 1000 出 = 0.00453 元；未知模型 None",
          ai.estimate_cost_cny({"input": 2000, "cache_read": 1500, "output": 1000}, "deepseek-flash", peak=False) == 0.00453 and ai.estimate_cost_cny({"input": 1}, "x") is None)
    bj = dt.timezone(dt.timedelta(hours=8))
    check("高峰：北京周一 10 点是，13 点、周六不是", ai.is_peak(dt.datetime(2026, 10, 19, 10, tzinfo=bj)) and not ai.is_peak(dt.datetime(2026, 10, 19, 13, tzinfo=bj)) and not ai.is_peak(dt.datetime(2026, 10, 24, 10, tzinfo=bj)))
    extra = copy.deepcopy(GOOD_PLANS[1])
    extra["foo"] = 1
    extra["site"]["size_m"] = [999, 999]
    extra["lighting"] = None
    log = []
    out = make_ds([ds_resp("```json\n" + J({"plan": extra}) + "\n```")], log).expand("x", {}, cpt, 1, None)
    check("代码块围栏 / 多余字段 / 可选 null / 越界 → 本地修，不回喂", len(log) == 1 and "foo" not in out["plan"] and out["plan"]["site"]["size_m"] == [400, 400] and "lighting" not in out["plan"] and out.get("_fixes"), J(out.get("_fixes"))[:300])
    raw = json.dumps({"plan": GOOD_PLANS[0]}, ensure_ascii=False, indent=1).replace(GOOD_PLANS[0]["name"], '塔"环"院', 1)
    raw = raw[: raw.rfind("]")] + ",\n" + raw[raw.rfind("]"):]
    log = []
    out = make_ds([ds_resp(raw)], log).expand("x", {}, cpt, 0, None)
    check("坏 JSON（没转义的引号 + 尾逗号）本地修好 → 不回喂，usage.repaired", len(log) == 1 and out["_usage"].get("repaired") and out["plan"]["name"] == '塔"环"院', J(out.get("_fixes"))[:200])
    deep = J({"plan": GOOD_PLANS[0]})
    i = deep.index('"children"')
    j = deep.index("]", i)
    broken = deep[:j] + "}" + deep[j:]  # 深层嵌套里多一个 }（真机见过）
    log = []
    out = make_ds([ds_resp(broken)], log).expand("x", {}, cpt, 0, None)
    check("括号配错（深层多一个 }）→ 本地在出错处删 / 补括号修好，不回喂", len(log) == 1 and any("修括号" in f for f in out.get("_fixes") or []) and not valid(out["plan"]), J(out.get("_fixes"))[:200])
    nest = {"name": "悬台叠翠", "site": {"size_m": [200, 200]},
            "nodes": [{"id": "core", "type": "group", "label": "悬台", "role": "landmark", "at": "site.center",
                       "children": [{"type": "cylinder", "label": "芯柱", "size_m": [8, 40]},
                                    {"type": "repeat", "pattern": "stack", "levels": 4, "child": {"type": "platform", "label": "台", "size_m": [20, 1, 20]}}]},
                      {"id": "pav", "type": "building", "label": "亭", "at": "site.N", "size_m": [10, 6, 10]},
                      {"type": "link", "style": "path", "label": "绿径", "from": "spawn", "to": "core"}],
            "spawn": {"at": "site.S", "look_at": "core"}, "relations": [{"type": "visible_from", "a": "core", "b": "spawn"}]}
    raw = json.dumps({"plan": nest}, ensure_ascii=False)
    k = raw.index('}}]}, {"id": "pav"')
    log = []
    out = make_ds([ds_resp(raw[:k + 2] + raw[k + 4:])], log).expand("x", {}, cpt, 0, None)  # stack 后面少了 ]}（真机：悬台叠翠）
    p = out["plan"]
    check("括号少一截（修括号补在末尾）→ 落进 nodes[0] 的 spawn / relations 挪回根上，跟着进去的根节点挪回 plan.nodes",
          len(log) == 1 and p.get("spawn", {}).get("look_at") == "core" and len(p.get("relations") or []) == 1
          and [n.get("id") or n.get("label") for n in p["nodes"]] == ["core", "pav", "绿径"] and len(p["nodes"][0]["children"]) == 2
          and any("挪回根上" in f for f in out.get("_fixes") or []), J(out.get("_fixes"))[:300])
    log = []
    make_ds([ds_resp("这不是 json"), ds_resp(J({"plan": GOOD_PLANS[0]}))], log).expand("x", {}, cpt, 0, None)
    check("修不好的 JSON → 回喂一次", len(log) == 2 and "不是合法 JSON" in log[-1][2]["messages"][-1]["content"])
    try:
        make_ds([ds_resp('{"plan": {', finish="length")], []).expand("x", {}, cpt, 0, None)
        check("finish_reason=length → AIError(truncated)", False)
    except ai.AIError as e:
        check("finish_reason=length → AIError(truncated)", e.kind == "truncated" and e.detail["usage"]["calls"] == 1)
    c = make_ds([ds_resp(J({"ideas": [{"name": "甲", "concept": "一句话甲概念", "key_structures": "塔、桥、湖", "terrain_idea": "湖", "why_different": "水上"},
                                     {"name": "甲", "concept": "一句话乙概念", "key_structures": ["岛"], "terrain_idea": "无", "why_different": "悬空"},
                                     {"name": "丙", "concept": "一句话丙概念", "key_structures": ["厅"], "terrain_idea": "挖", "why_different": "地下"}]}))], []).concepts("x", {}, None)
    check("构思后处理：别名 ideas → concepts、key_structures 字符串拆成数组、重名改名", len(c["concepts"]) == 3 and c["concepts"][0]["key_structures"] == ["塔", "桥", "湖"] and c["concepts"][1]["name"] != "甲", J(c)[:300])

    mp = mine_plan()
    log = []
    r = make_ds([ds_resp(J({"understood": True, "restatement": "改成迷宫", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}]}), completion=80)], log).revise(mp, {"type": "text", "text": "矿洞是个迷宫"}, set())
    check("revise：漏了 ask_to_point → 由 understood 推出，不回喂；max_tokens 2000；系统提示与展开共用（缓存）", len(log) == 1 and r["ask_to_point"] is False and log[0][2]["max_tokens"] == 2000
          and log[0][2]["messages"][0]["content"] == ai.program_system_prompt() and "当前场景程序" in log[0][2]["messages"][1]["content"])
    r = ai.revise({"plan": mp, "action": "矿洞是个迷宫"}, make_ds([ds_resp(J({"understood": True, "restatement": "矿洞内部布局改成迷宫平面，其余不动。", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], "ask_to_point": False}))], []))
    check("revise 复述：模型已经说了「迷宫平面」就不再补一遍", r["restatement"].count("迷宫平面") == 1 and r["constraints_fixed"] == [], r["restatement"])
    r = ai.revise({"plan": mp, "action": "矿洞是个迷宫"}, make_ds([ds_resp(J({"understood": True, "restatement": "好的。", "ops": [], "ask_to_point": False}))], []))
    check("revise 锁（DeepSeek 路径）：模型漏了 → 本地补 set layout=maze，复述补「矿洞改成迷宫平面」", r["ops"] == [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}] and r["restatement"].startswith("矿洞改成迷宫平面"), J(r)[:300])
    log = []
    badops = {"understood": True, "restatement": "加像", "ops": [{"op": "set", "id": "ghost", "field": "label", "value": "x"}], "ask_to_point": False}
    okops = {"understood": True, "restatement": "加像", "ops": [{"op": "add", "to": "core", "value": {"type": "statue", "label": "院长像", "offset_m": [0, 24]}}, {"op": "set", "id": "towers[0]", "field": "roof", "value": "dome"}], "ask_to_point": False}
    r = make_ds([ds_resp(J(badops)), ds_resp(J(okops))], log).revise(mp, {"type": "text", "text": "主殿前加个院长像，第一座塔换穹顶"}, set())
    check("revise：ops 不合法（不存在的 id）→ 把具体错误回喂一次；第二次的加到组 / 改实例都收", len(log) == 2 and "ghost" in log[-1][2]["messages"][-1]["content"] and r["ops"][0]["to"] == "core" and r["ops"][1]["id"] == "towers[0]")
    log = []
    make_ds([ds_resp('{"understood": true, "restatement": "好", "ops": [], "ask_to_point": false}')], log, thinking=True).revise(mp, {"type": "text", "text": "x"}, set())
    check("thinking=true → thinking enabled，max_tokens 加思考余量", log[-1][2]["thinking"] == {"type": "enabled"} and log[-1][2]["max_tokens"] == 2000 + ai.DeepSeekAI.THINKING_EXTRA)

    for code, word in ((401, "密钥"), (402, "余额"), (422, "模型名")):
        log = []
        try:
            make_ds([http_error(code, "Model Not Exist" if code == 422 else "err")], log).concepts("x", {}, None)
            check(f"HTTP {code} → DeepSeekAPIError", False)
        except ai.DeepSeekAPIError as e:
            p = ai.error_payload(e)
            check(f"HTTP {code} → 不重试，提示含「{word}」", len(log) == 1 and p["status"] == code and word in p["hint"] and p["provider"] == "deepseek" and p["retryable"] is False, J(p))
    log = []
    c = make_ds([http_error(429, "rate"), ds_resp(GOOD_CONCEPTS)], log).concepts("x", {}, None)
    check("429 → 重试 1 次后成功", len(log) == 2 and len(c["concepts"]) == 3)
    log = []
    try:
        make_ds([urllib.error.URLError("refused"), urllib.error.URLError("refused")], log).concepts("x", {}, None)
    except ai.DeepSeekAPIError as e:
        check("断连 → 重试 1 次，APIConnectionError，可重试", len(log) == 2 and ai.error_payload(e)["type"] == "APIConnectionError" and ai.error_payload(e)["retryable"])
    log = []
    try:
        make_ds([socket.timeout("timed out")], log).concepts("x", {}, None)
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
    calls = []
    lock = threading.Lock()

    def rec(name):
        def f(**kw):
            with lock:
                calls.append((name, kw))
            sysmsg = kw["system"][0]["text"]
            user = kw["messages"][0]["content"]
            if "空间构思师" in sysmsg:
                return fake_resp(GOOD_CONCEPTS)
            m = re.search(r"你写第 (\d) 张", user)
            if m:
                return fake_resp(J({"plan": GOOD_PLANS[int(m.group(1)) - 1]}))
            return fake_resp(J({"understood": True, "restatement": "改成迷宫平面", "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}], "ask_to_point": False}))
        return f
    r = ai.draft({"intent": "黄昏的魔法学院"}, make_claude(rec("beta"), rec("plain")))
    kw = calls[0][1]
    check("Claude 两步：构思 1 + 展开 3，都走 beta.messages.create + server-side-fallback + fallbacks=default", len(calls) == 4 and all(n == "beta" for n, _ in calls)
          and kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default" and r["provider"] == "claude" and r["sources"] == ["claude"] * 3)
    ekw = next(k for n, k in calls if "你写第" in k["messages"][0]["content"])
    check("Claude：不传 thinking / temperature；effort=low；format=json_schema（已剥约束、展开带场景树定义）；系统提示带 cache_control",
          not any(k in ekw for k in ("thinking", "temperature", "top_p")) and ekw["output_config"]["effort"] == "low" and ekw["output_config"]["format"]["type"] == "json_schema"
          and not ai.has_key(ekw["output_config"]["format"]["schema"], "maximum") and "node" in ekw["output_config"]["format"]["schema"]["$defs"] and ekw["system"][0]["cache_control"] == {"type": "ephemeral"})
    one = round((5000 * 4 + 3000 * 20 + 4000 * 0.2) / 1e6, 6)
    check("Claude：usage 合计 + cost_usd（Opus 5.5 价 × 4 次）", abs(r["_usage"]["cost_usd"] - 4 * one) < 1e-9 and r["_usage"]["calls"] == 4, J({k: v for k, v in r["_usage"].items() if k != "parts"}))

    def beta_reject(**kw):
        calls.append(("beta", kw))
        raise FakeBadRequest("Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header")
    calls.clear()
    c = make_claude(beta_reject, rec("plain"))
    c.concepts("x", {}, None)
    c.concepts("x", {}, None)
    check("beta 被 400 → 退回普通调用，之后不再试 beta", [x[0] for x in calls] == ["beta", "plain", "plain"])
    ai.ClaudeAI.fallback_beta_ok = True
    for stop, kind in (("refusal", "refusal"), ("max_tokens", "truncated")):
        try:
            make_claude(lambda **kw: fake_resp(None if stop == "refusal" else '{"plan": {', stop_reason=stop, category="cyber"), None).expand("x", {}, MOCK_CONCEPTS, 0, None)
            check(f"stop_reason={stop} → AIError({kind})", False)
        except ai.AIError as e:
            check(f"stop_reason={stop} → AIError({kind})", e.kind == kind)
    calls.clear()
    r = make_claude(rec("beta"), None).revise(mine_plan(), {"type": "text", "text": "矿洞是个迷宫"}, set())
    check("Claude revise：effort=medium，ops 校验通过", calls[-1][1]["output_config"]["effort"] == "medium" and r["ops"][0]["value"] == "maze" and r["provider"] == "claude")
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
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "我要生成魔法学院"})
    check("POST /api/ai/draft（无密钥走模拟）→ plans×3 + concepts×3 + constraints + diversity + sources + _usage + _steps + _ms",
          st == 200 and len(d["plans"]) == 3 and len(d["concepts"]) == 3 and d["provider"] == "mock" and "_ms" in d and d["_usage"]["cost_cny"] == 0
          and d["diversity"]["org_min"] >= 2 and d["sources"] == ["mock"] * 3 and len(d["_steps"]) == 4, J(d)[:300])
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
    st, v = call(base, "POST", "/api/validate", {"doc": academy(), "schema": "plan"})
    check("POST /api/validate（plan）→ ok", st == 200 and v["ok"], J(v)[:200])
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

    key = "sk-test-deepseek-secret-9876wxyz"
    st, c = call(base, "POST", "/api/config", {"provider": "deepseek", "mock": False, "providers": {"deepseek": {"api_key": key, "thinking": True}, "anthropic": {"api_key": "sk-ant-test-1234567890abcdef"}}})
    blob = J(c)
    check("POST config → 只回 has_key / key_hint，不含明文", st == 200 and key not in blob and "sk-ant-test-1234567890abcdef" not in blob and c["providers"]["deepseek"]["key_hint"] == "sk-…wxyz" and c["mock"] is False and c["thinking"] is True)
    st, c = call(base, "GET", "/api/config")
    check("GET config 不含明文（两家都有密钥）", key not in J(c) and "api_key" not in J(c))
    st, h = call(base, "GET", "/api/health")
    check("health 带 provider / model / thinking", h["provider"] == "deepseek" and h["model"] == "deepseek-flash" and h["thinking"] is True and h["mock"] is False)
    st, d = call(base, "POST", "/api/ai/draft", {"intent": "海盗港口", "force_mock": True})
    check("有密钥也能 force_mock：provider=mock、不花钱", st == 200 and d["provider"] == "mock" and d["_usage"]["cost_cny"] == 0)

    orig = ai.DeepSeekClient._post_once
    sent = []
    lock = threading.Lock()

    def fake_post(self, body, timeout):
        with lock:
            sent.append(body)
        if body.get("max_tokens") == 8:
            return ds_resp("ok", prompt=10, hit=0, completion=1)
        return router()(body)
    ai.DeepSeekClient._post_once = fake_post
    try:
        st, d = call(base, "POST", "/api/ai/draft", {"intent": "我要生成魔法学院，湖边，地下有个两层的迷宫"})
        check("draft 走 DeepSeek（打桩）→ 4 次调用、思考开、cost_cny；锁定把湖 / 迷宫补进了三张",
              st == 200 and d["provider"] == "deepseek" and len(sent) == 4 and d["_usage"]["cost_cny"] is not None and sent[-1]["thinking"] == {"type": "enabled"}
              and all(any(n.get("type") == "space" and n.get("layout") == "maze" and n.get("sublevels") == 2 for n in ai.all_nodes(p)) for p in d["plans"])
              and d["constraints_fixed"], J(d.get("constraints_fixed"))[:300])
        st, t = call(base, "POST", "/api/config/test", {})
        check("config/test 按当前服务商发最短请求", st == 200 and t["ok"] and t["provider"] == "deepseek" and sent[-1]["max_tokens"] == 8)

        def fail_post(self, body, timeout):
            raise ai.DeepSeekAPIError("Authentication Fails", status_code=401, body={"error": {"message": "Authentication Fails", "type": "authentication_error"}})
        ai.DeepSeekClient._post_once = fail_post
        st, t = call(base, "POST", "/api/config/test", {"api_key": "sk-wrong-000000000000"})
        check("config/test 坏密钥 → ok=false + 中文提示，不回显密钥", st == 200 and t["ok"] is False and "密钥" in t["message"] and "sk-wrong" not in J(t))
        st, e = call(base, "POST", "/api/ai/draft", {"intent": "学院"})
        check("draft 构思遇 401 → 502 带 status / hint / provider", st == 502 and e["status"] == 401 and e["provider"] == "deepseek" and "密钥" in e["hint"])
    finally:
        ai.DeepSeekClient._post_once = orig
    with open(ai.config_path(), "w", encoding="utf-8") as f:
        json.dump({"api_key": "sk-ant-legacy-0000000000abcd", "model": "claude-opus-5-5", "mock": True}, f)
    st, c = call(base, "GET", "/api/config")
    check("旧的扁平配置 → 视为 anthropic，打码", c["provider"] == "anthropic" and c["key_hint"] == "sk-ant-…abcd")
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": "sk-zzzzzzzzzzzz1234"}}, "provider": "deepseek"})
    raw = json.load(open(ai.config_path(), encoding="utf-8"))
    check("保存后迁移：anthropic 密钥保留、扁平字段去掉", raw["providers"]["anthropic"]["api_key"] == "sk-ant-legacy-0000000000abcd" and "api_key" not in raw)
    st, c = call(base, "POST", "/api/config", {"providers": {"deepseek": {"api_key": ""}}})
    check("清除密钥 → has_key=false、mock=true", not c["providers"]["deepseek"]["has_key"] and c["mock"] is True)


MOCK_FIXTURE = os.path.join(ROOT, "build", "eval", "mock-drafts.json")


def t_engine_fixture() -> None:
    """模拟 AI 的 draft 输出 + 每个片段的最小 plan + revise 前后，存 build/eval/mock-drafts.json：
    medium/engine/tests/examples.test.html 读它交给 compilePlan 编译（后端写的东西前端引擎能编、validate 0 error、Python 与 JS 应用 ops 一致）。"""
    plans, revs = [], []
    for t in ACCEPT + ["地下有个矿洞，是个两层的迷宫", "湖心岛上的城堡"]:
        for variant in (0, 1):
            plans += ai.draft({"intent": t, "force_mock": True, "variant": variant})["plans"]
    frags = []
    for f in ai.FRAGMENTS:
        p = {"name": f["name"][:16], "site": {"size_m": [220, 220], "ground": f.get("ground", "flat")}, "terrain": [], "nodes": [], "spawn": {"at": "site.S"}}
        if f["demo"] == "hall":
            p["nodes"].append({"id": "hall", "type": "building", "label": "主殿", "at": "site.center", "size_m": [30, 18, 24], "roof": "hip", "role": "landmark"})
        terr, nodes, main_id = ai.instantiate(p, f["key"], f["demo"])
        p["terrain"] += terr
        p["nodes"] += nodes
        p["spawn"]["look_at"] = main_id
        frags.append(p)
    for p in plans[:4]:
        for text in ("塔再高一点", "加一座桥", "多加几座塔", "加一个地下迷宫", "加一圈城墙"):
            r = ai.revise({"plan": copy.deepcopy(p), "action": text, "force_mock": True})
            if r.get("ops"):
                revs.append({"text": text, "base": p, "ops": r["ops"], "plan": ai.apply_ops(copy.deepcopy(p), r["ops"])})
    bad = [(p["name"], valid(p)[:2]) for p in plans + frags + [r["plan"] for r in revs] if valid(p)]
    os.makedirs(os.path.dirname(MOCK_FIXTURE), exist_ok=True)
    with open(MOCK_FIXTURE, "w", encoding="utf-8") as fh:
        json.dump({"plans": plans + frags, "revisions": revs}, fh, ensure_ascii=False)
    check(f"模拟输出存给引擎编译：{len(plans)} 张 draft + {len(frags)} 个片段 + {len(revs)} 次 revise，全部合 schema（build/eval/mock-drafts.json）",
          not bad and len(frags) == len(ai.FRAGMENTS) and len(revs) >= 8, J(bad)[:400])


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    for fn in (t_schema, t_ops, t_locks, t_mock, t_two_step, t_deepseek, t_claude, t_engine_fixture):
        try:
            fn()
        except Exception:  # noqa: BLE001  一组炸了不影响别的组
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
