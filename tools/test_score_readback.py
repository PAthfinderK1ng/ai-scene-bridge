#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_score_readback.py — score_readback.py 的自测（不需要浏览器 / 引擎）

用法：python -X utf8 tools/test_score_readback.py
退出码 0 = 全部通过。每条用例打印 PASS / FAIL。

覆盖：
  1. experiments/week0-ab 的 B-sid 意图 + 理想 Unity 读回：位置 / 尺寸 / 朝向 / 台地层全部合格，可见、连通，颜色不计分
  2. 构造的最小山地场景（3 层台地 + 2 栋房 + 地标 + 出生点 + 主路）→ 按 PROTOCOL 3.2 生成理想读回 → 全部合格；
     再逐项破坏：房子挪到下一层台地 → level_ok false；地标前放 20 m 高体块 → visible_from_spawn.readback false；
     删掉主路（台地墙坡度 > 0.7）→ trail_connected.readback false；颜色 ΔE > 10 → color_ok false
  3. desktop/app._score 把新字段透出
  4. 几何小函数：高度函数、CIE76、路段盒子 → 中心线
"""
from __future__ import annotations

import copy
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import score_readback as sr  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, info: str = "") -> None:
    results.append((name, bool(cond), info))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or not info else f"  —  {info}"))


# ---------------------------------------------------------------- 样例：最小山地场景
def terraced_sid() -> dict:
    """3 层台地（南低北高的三条横带）、地标在顶层、出生点在南边山脚、两栋房分别在 1 层与 2 层、主路笔直北上到地标门前"""
    return {
        "sid_version": "0.1",
        "meta": {"name": "自测山村", "units": "meters", "up_axis": "+Y", "handedness": "right", "north": "-Z",
                 "player_height": 1.7, "grid": 0.5, "layer_height_m": 3},
        "intent": {"summary": "自测用", "mood": []},
        "style": {"palette": [{"role": "roof", "hex": "#4A4A4A"}, {"role": "wall", "hex": "#D9C9A3"}, {"role": "stone", "hex": "#9A9890"},
                              {"role": "foliage", "hex": "#4F6B3A"}, {"role": "mist", "hex": "#DDE6F0"}],
                  "references": [], "lighting": {"time_of_day": "dusk", "sun_azimuth_deg": 250, "sun_elevation_deg": 12}, "material_intents": {}},
        "bounds": {"min": [-30, 0, -30], "max": [30, 20, 30]},
        "terrain": {"base": "flat", "base_height": 0, "features": [
            {"id": "terrace_0", "kind": "plateau", "level": 0, "polygon": [[-20, 0], [20, 0], [20, 24], [-20, 24]], "center": [0, 0, 12], "radius": 23.3, "height": 0},
            {"id": "terrace_1", "kind": "plateau", "level": 1, "polygon": [[-18, -12], [18, -12], [18, 0], [-18, 0]], "center": [0, 0, -6], "radius": 19, "height": 3},
            {"id": "terrace_2", "kind": "plateau", "level": 2, "polygon": [[-14, -24], [14, -24], [14, -12], [-14, -12]], "center": [0, 0, -18], "radius": 15.2, "height": 6},
        ]},
        "volumes": [
            {"id": "landmark", "kind": "building", "shape": "box", "position": [0, 6, -18], "size": [6, 8, 6], "rotation_y": 180, "label": "山顶寺", "importance": "landmark", "color_role": "roof"},
            {"id": "house_1_1", "kind": "building", "shape": "box", "position": [-8, 3, -6], "size": [6, 4, 5], "rotation_y": 180, "label": "民居", "importance": "secondary", "color_role": "wall", "generated": True},
            {"id": "house_2_1", "kind": "building", "shape": "box", "position": [8, 6, -18], "size": [6, 4, 5], "rotation_y": 180, "label": "民居", "importance": "secondary", "color_role": "wall", "generated": True},
        ],
        "regions": [{"id": "r_terrace_" + str(i), "kind": "other", "polygon": [[-20, 0], [20, 0], [20, 24], [-20, 24]], "density": 1, "label": "", "terrace_level": i} for i in range(1)],
        "paths": [{"id": "main_trail", "kind": "trail", "width": 2, "points": [[0, 28], [0, -13]], "surface": "stone", "label": "主路", "generated": True}],
        "markers": [{"id": "spawn", "kind": "player_spawn", "position": [0, 0, 28], "rotation_y": 0, "label": "入口"},
                    {"id": "poi_landmark", "kind": "poi", "position": [0, 14, -18], "rotation_y": 0, "label": "山顶寺"}],
        "relations": [], "constraints": [{"type": "must_reach", "from": "spawn", "targets": ["landmark"]}], "views": [], "asset_hints": {},
    }


def ideal_unity_readback(sid: dict, with_color: bool = True) -> dict:
    """按 PROTOCOL 3.1 / 3.2 把 SID 复现成 Unity 读回：体块几何中心、Cylinder 半高、标记 empty、路按段 aux_<id>_<k>、颜色按 color_role"""
    palette = {c["role"]: c["hex"] for c in sid["style"]["palette"]}
    objs = [{"name": "SID_scene", "primitive": "empty", "position": [0, 0, 0], "scale": [1, 1, 1], "euler_y": 0}]
    for v in sid["volumes"]:
        x, y, z = v["position"]
        w, h, d = v["size"]
        cyl = v.get("shape") == "cylinder"
        o = {"name": v["id"], "primitive": "cylinder" if cyl else "cube", "position": [x, y + h / 2, -z],
             "scale": [w, h / 2 if cyl else h, d], "euler_y": -(v.get("rotation_y") or 0)}
        role = v.get("color_role") or sr.KIND_COLOR_ROLE.get(v.get("kind"), "")
        if with_color and role in palette:
            o["color"] = palette[role]
        objs.append(o)
    for m in sid["markers"]:
        x, y, z = m["position"]
        objs.append({"name": m["id"], "primitive": "empty", "position": [x, y, -z], "scale": [1, 1, 1], "euler_y": -(m.get("rotation_y") or 0)})
    for p in sid["paths"]:
        pts = p["points"]
        for k in range(len(pts) - 1):
            (x0, z0), (x1, z1) = pts[k], pts[k + 1]
            L = math.hypot(x1 - x0, z1 - z0)
            rot = math.degrees(math.atan2(-(z1 - z0), x1 - x0))   # 盒子局部 x 轴 → SID (cos, −sin)
            objs.append({"name": f"aux_{p['id']}_{k + 1}", "primitive": "cube", "position": [(x0 + x1) / 2, 0.01, -(z0 + z1) / 2],
                         "scale": [L, 0.02, p.get("width", 2)], "euler_y": -rot})
    return {"engine": "unity", "objects": objs}


def score(sid: dict, rb_raw: dict, auto_map: bool = False) -> dict:
    intent = sr.intent_objects(sid, False)
    rb, _fmt = sr.readback_objects(rb_raw)
    return sr.compare(intent, rb, {}, auto_map, sr.unscored_ids(sid), sid=sid, rb_raw=rb_raw)


def row(res: dict, oid: str) -> dict:
    return next(r for r in res["rows"] if r["id"] == oid)


def find_obj(rb: dict, name: str) -> dict:
    return next(o for o in rb["objects"] if o["name"] == name)


def main() -> int:
    # ------------------------------------------------ 1. 第 0 周样例仍全部合格
    sid_b = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "B-sid", "scene.sid.json"), encoding="utf-8"))
    rb_b = json.load(open(os.path.join(ROOT, "experiments", "week0-ab", "scoring", "readback.example-unity.json"), encoding="utf-8"))
    res = score(sid_b, rb_b)
    s = res["summary"]
    check("B-sid 样例：9/9 匹配，无缺漏多余", s["matched"] == 9 and not s["missing"] and not s["extra"], json.dumps(s, ensure_ascii=False)[:300])
    check("B-sid 样例：位置 / 尺寸 / 朝向 / 台地层合格率 100%", all(s[k] == 100 for k in ("pos_ok_rate_pct", "size_ok_rate_pct", "rot_ok_rate_pct", "level_ok_rate_pct")), json.dumps(s, ensure_ascii=False)[:300])
    check("B-sid 样例：读回无 color 字段 → 颜色不计分", s["color_ok_rate_pct"] is None and all(r["color_ok"] is None for r in res["rows"]))
    check("B-sid 样例：出生点看得见井（意图与读回）", s["visible_from_spawn"]["intent"] is True and s["visible_from_spawn"]["readback"] is True, json.dumps(s["visible_from_spawn"]))
    check("B-sid 样例：平地上出生点走得到井（意图与读回）", s["trail_connected"] == {"intent": True, "readback": True}, json.dumps(s["trail_connected"]))
    check("B-sid 样例：标记不算台地层", row(res, "spawn")["level_ok"] is None and row(res, "house_1")["level_ok"] is True)

    # ------------------------------------------------ 2. 最小山地场景
    sid = terraced_sid()
    T = sr.Terrain(sid)
    check("高度函数：台地内等于 level × 层高", abs(T.height_at(0, -18) - 6) < 1e-6 and abs(T.height_at(-8, -6) - 3) < 1e-6 and abs(T.height_at(0, 20)) < 1e-6,
          f"{T.height_at(0, -18)} {T.height_at(-8, -6)} {T.height_at(0, 20)}")
    check("高度函数：坡裙外侧线性落到 0（terrace_1 南缘外 1.2 m ≈ 1.5 m 高）", abs(T.height_at(0, 1.2) - 1.5) < 0.3, str(T.height_at(0, 1.2)))
    check("层号：出生点 0 层、房 1 层 / 2 层、地标 2 层", (T.level_at(0, 28), T.level_at(-8, -6), T.level_at(8, -18), T.level_at(0, -18)) == (0, 1, 2, 2))
    check("层表：按实际台地分成 0 / 3 / 6 m 三层，出生点所在层为 0", T.layers == [0.0, 3.0, 6.0] and T.zero == 0 and T.zero_from == "spawn", f"{T.layers} zero={T.zero}")
    sid_up = copy.deepcopy(sid)
    sid_up["markers"][0]["position"] = [-14, 3, -6]   # 出生点挪到 1 层台地上
    T_up = sr.Terrain(sid_up)
    check("出生点在中间那层 → 它是 0，下面的台地 −1，上面的 +1", (T_up.level_at(0, 28), T_up.level_at(-8, -6), T_up.level_at(0, -18)) == (-1, 0, 1), f"{T_up.level_at(0, 28)} {T_up.level_at(-8, -6)} {T_up.level_at(0, -18)}")
    check("坡裙上的点归到高度最近的层（terrace_1 南缘外 1.6 m ≈ 1.0 m → 0 层；外 0.4 m ≈ 2.5 m → 1 层）", T.level_at(0, 1.6) == 0 and T.level_at(0, 0.4) == 1, f"{T.height_at(0, 1.6)} {T.height_at(0, 0.4)}")
    check("terraceAt：顶层多边形里取最高台地", T.terrace_at(0, -18)["id"] == "terrace_2" and T.terrace_at(0, 28) is None)

    rb = ideal_unity_readback(sid)
    res = score(sid, rb)
    s = res["summary"]
    check("理想读回：全部匹配、无多余（aux_ 路段不算多余）", s["matched"] == 5 and not s["missing"] and not s["extra"], json.dumps(s, ensure_ascii=False)[:300])
    check("理想读回：位置 / 尺寸 / 朝向 / 层 / 颜色合格率 100%", all(s[k] == 100 for k in ("pos_ok_rate_pct", "size_ok_rate_pct", "rot_ok_rate_pct", "level_ok_rate_pct", "color_ok_rate_pct")), json.dumps(s, ensure_ascii=False)[:300])
    check("理想读回：rows 带 level_intent / level_readback / delta_e", row(res, "house_1_1")["level_intent"] == 1 and row(res, "house_1_1")["level_readback"] == 1 and row(res, "house_2_1")["level_intent"] == 2 and row(res, "landmark")["delta_e"] == 0)
    check("理想读回：出生点看得见地标", s["visible_from_spawn"]["intent"] is True and s["visible_from_spawn"]["readback"] is True and s["visible_from_spawn"]["blocked_by"] is None, json.dumps(s["visible_from_spawn"]))
    check("理想读回：主路把出生点连到地标门前", s["trail_connected"] == {"intent": True, "readback": True}, json.dumps(s["trail_connected"]))

    # 2a. 房子挪到下一层台地 → level_ok false
    rb2 = copy.deepcopy(rb)
    find_obj(rb2, "house_1_1")["position"] = [-8, 6 + 2, 18]   # SID (-8, 6, -18)：terrace_2
    r = row(score(sid, rb2), "house_1_1")
    check("房子挪到下一层台地 → level_ok false（1 → 2）", r["level_ok"] is False and r["level_intent"] == 1 and r["level_readback"] == 2, json.dumps(r, ensure_ascii=False))
    rb2b = copy.deepcopy(rb)
    find_obj(rb2b, "house_1_1")["position"] = [-8.5, 3 + 2, 6.4]   # 同一层内挪 0.64 m
    r = row(score(sid, rb2b), "house_1_1")
    check("同层内小挪 → pos_ok 与 level_ok 都仍合格", r["pos_ok"] is True and r["level_ok"] is True, json.dumps(r, ensure_ascii=False))

    # 2b. 地标前放一个 20 m 高体块 → 读回看不见，意图照旧看得见
    rb3 = copy.deepcopy(rb)
    rb3["objects"].append({"name": "blocker", "primitive": "cube", "position": [0, 10, -10], "scale": [8, 20, 2], "euler_y": 0})  # SID (0, 0, 10)
    s3 = score(sid, rb3)["summary"]
    check("地标前 20 m 高体块 → visible_from_spawn.readback false，blocked_by 指向它", s3["visible_from_spawn"]["readback"] is False and s3["visible_from_spawn"]["blocked_by"] == "volume:blocker" and s3["visible_from_spawn"]["intent"] is True, json.dumps(s3["visible_from_spawn"]))
    check("多出的体块同时被列为「多余」", s3["extra"] == ["blocker"], json.dumps(s3["extra"]))
    rb3b = copy.deepcopy(rb)
    rb3b["objects"].append({"name": "low_wall", "primitive": "cube", "position": [0, 0.5, -10], "scale": [8, 1, 2], "euler_y": 0})  # 1 m 矮墙不挡
    check("1 m 矮墙不挡视线", score(sid, rb3b)["summary"]["visible_from_spawn"]["readback"] is True)

    # 2c. 删掉主路 → 台地墙（3 m / 2.4 m 坡裙，坡度 1.25）走不上去
    rb4 = {"engine": "unity", "objects": [o for o in rb["objects"] if not o["name"].startswith("aux_main_trail")]}
    s4 = score(sid, rb4)["summary"]
    check("读回里没有路段 → trail_connected.readback false，意图仍 true", s4["trail_connected"] == {"intent": True, "readback": False}, json.dumps(s4["trail_connected"]))
    sid4 = copy.deepcopy(sid)
    sid4["paths"] = []
    s4b = score(sid4, rb4)["summary"]
    check("意图里也删掉主路 → 两侧都不连通", s4b["trail_connected"] == {"intent": False, "readback": False}, json.dumps(s4b["trail_connected"]))
    sid4c = copy.deepcopy(sid)
    for f in sid4c["terrain"]["features"]:
        f["skirt"] = 12   # 坡裙放宽到 12 m：3 m / 12 m = 0.25 ≤ 0.7，不用路也能走上去
    s4c = score(sid4c, rb4)["summary"]
    check("坡裙放宽（坡度 0.25）→ 没有路也连通", s4c["trail_connected"] == {"intent": True, "readback": True}, json.dumps(s4c["trail_connected"]))
    rb4d = copy.deepcopy(rb)
    for o in rb4d["objects"]:
        if o["name"].startswith("aux_main_trail"):
            o["name"] = "aux_main_trail_1"
            o["position"] = [0, 0.01, -7]   # 路段只剩 (0, 28)→(0, −14) 的后半截 (0, 14)→(0, 0)：顶层够不到
            o["scale"] = [14, 0.02, 2]
    s4d = score(sid, rb4d)["summary"]
    check("路段只铺到 1 层 → 读回不连通", s4d["trail_connected"]["readback"] is False, json.dumps(s4d["trail_connected"]))

    # 2d. 颜色 ΔE > 10 → color_ok false；轻微偏差合格；没有 color 不计分
    rb5 = copy.deepcopy(rb)
    find_obj(rb5, "house_2_1")["color"] = "#8080FF"
    find_obj(rb5, "landmark")["color"] = "#4C4C4C"
    del find_obj(rb5, "house_1_1")["color"]
    res5 = score(sid, rb5)
    r_bad, r_near, r_none = row(res5, "house_2_1"), row(res5, "landmark"), row(res5, "house_1_1")
    check("颜色差很大 → color_ok false，ΔE > 10", r_bad["color_ok"] is False and r_bad["delta_e"] > 10 and r_bad["color_intent"] == "#D9C9A3" and r_bad["color_readback"] == "#8080ff", json.dumps(r_bad, ensure_ascii=False))
    check("颜色略偏（#4A4A4A vs #4C4C4C）→ 合格", r_near["color_ok"] is True and 0 < r_near["delta_e"] < 2, json.dumps(r_near, ensure_ascii=False))
    check("没有 color 字段 → None 不计分", r_none["color_ok"] is None and r_none["delta_e"] is None)
    check("颜色合格率按有 color 的对象算：1/2 = 50%", res5["summary"]["color_ok_rate_pct"] == 50, str(res5["summary"]["color_ok_rate_pct"]))
    sid5 = copy.deepcopy(sid)
    del sid5["volumes"][1]["color_role"]   # house_1_1 没有 color_role → 按 kind=building 用 wall
    r = row(score(sid5, rb), "house_1_1")
    check("没有 color_role 时按 kind 取 palette 角色（building → wall）", r["color_intent"] == "#D9C9A3" and r["color_ok"] is True, json.dumps(r, ensure_ascii=False))

    # 2e. SID 形态读回（带 paths / color）
    rb6 = {"volumes": [dict(v, color=("#D9C9A3" if v.get("color_role") == "wall" else "#4A4A4A")) for v in sid["volumes"]],
           "markers": copy.deepcopy(sid["markers"]), "paths": copy.deepcopy(sid["paths"])}
    s6 = score(sid, rb6)["summary"]
    check("SID 形态读回：paths 直接当走廊，颜色 / 层全合格", s6["trail_connected"]["readback"] is True and s6["visible_from_spawn"]["readback"] is True and s6["color_ok_rate_pct"] == 100 and s6["level_ok_rate_pct"] == 100, json.dumps(s6, ensure_ascii=False)[:300])

    # 2f. 缺地标 / 缺出生点时场景级指标为 None 而不是报错
    rb7 = {"engine": "unity", "objects": [o for o in rb["objects"] if o["name"] != "spawn"]}
    s7 = score(sid, rb7)["summary"]
    check("读回缺出生点 → 场景级指标 readback 为 None，blocked_by 标出缺谁", s7["visible_from_spawn"]["readback"] is None and s7["trail_connected"]["readback"] is None and s7["visible_from_spawn"]["blocked_by"] == "missing:spawn" and s7["visible_from_spawn"]["intent"] is True, json.dumps(s7, ensure_ascii=False)[:300])
    flat = copy.deepcopy(sid)
    flat["terrain"]["features"] = []
    r = row(score(flat, rb), "house_1_1")
    check("没有地形特征 → 台地层不计分", r["level_ok"] is None and score(flat, rb)["summary"]["level_ok_rate_pct"] is None)

    # ------------------------------------------------ 3. desktop/app._score 透出新字段
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    os.environ.setdefault("LOCALAPPDATA", os.environ.get("TEMP", HERE))
    import app  # noqa: E402
    out = app._score(ROOT, {"intent": sid, "readback": rb3, "auto_map": True})
    check("_score：summary 含 visible_from_spawn / trail_connected / level_ok_rate_pct / color_ok_rate_pct", all(k in out["summary"] for k in ("visible_from_spawn", "trail_connected", "level_ok_rate_pct", "color_ok_rate_pct")) and out["summary"]["visible_from_spawn"]["readback"] is False)
    check("_score：rows 含 level_ok / color_ok / delta_e 且可 JSON 序列化", all("level_ok" in r and "color_ok" in r and "delta_e" in r for r in out["rows"]) and json.dumps(out) is not None)

    # ------------------------------------------------ 4. 几何小函数
    check("CIE76：同色 0，黑白 100", sr.delta_e("#000000", "#000000") == 0 and abs(sr.delta_e("#000000", "#ffffff") - 100) < 0.01, str(sr.delta_e("#000000", "#ffffff")))
    check("CIE76：非法 hex → None", sr.delta_e("#zzz", "#000000") is None and sr.delta_e(None, "#000000") is None)
    seg, w = sr.box_axis_segment({"position": [0, 0, 23], "size": [30, 0.02, 4], "rotation_y": 90})
    pts = sorted([tuple(round(c, 6) for c in p) for p in seg])
    check("aux 路段盒子 → 中心线段（样例 main_road_s：(0,38)→(0,8)，宽 4）", pts == [(0.0, 8.0), (0.0, 38.0)] and w == 4, f"{pts} {w}")
    seg, w = sr.box_axis_segment({"position": [-4.5, 0, -12.5], "size": [12.727922061357855, 0.02, 4], "rotation_y": 135})
    pts = sorted([tuple(round(c, 3) for c in p) for p in seg])
    check("aux 路段盒子（斜段 main_road_n 第 1 段：(0,−8)→(−9,−17)）", pts == [(-9.0, -17.0), (0.0, -8.0)], f"{pts}")

    # ------------------------------------------------ 5. 雕刻模式地形（terrain.sculpt = true）与引擎逐点一致
    # 期望值来自浏览器里 medium/engine/terrain.js buildTerrain(mini, {res: 2}) 的 heightAt / slopeAt / levelAt（2026-10-19 采样），
    # 覆盖 raise(round 边) / noise / quant(terraced 边) / line 遮罩 set(cliff 边) / dune / 旧式 override 台地 / pit 负平底
    mini = {"meta": {"layer_height_m": 3, "player_height": 1.7}, "bounds": {"min": [-30, 0, -30], "max": [30, 30, 30]}, "terrain": {"base": "flat", "base_height": 0, "sculpt": True, "features": [
        {"id": "m_raise", "kind": "raise", "op": "raise", "mask": "poly", "blend": "add", "amount": 12, "edge": "round", "skirt": 20, "polygon": [[-24, -24], [24, -24], [24, 24], [-24, 24]]},
        {"id": "m_noise", "kind": "noise", "op": "noise", "mask": "all", "blend": "add", "wave": {"kind": "noise", "amp": 1.5, "scale": 15, "seed": 42}},
        {"id": "m_quant", "kind": "quant", "op": "quant", "mask": "poly", "blend": "quant", "step": 3, "base": 0, "edge": "terraced", "steps": 2, "skirt": 4, "polygon": [[-20, -20], [20, -20], [20, 0], [-20, 0]]},
        {"id": "m_cut", "kind": "cut", "op": "cut", "mask": "line", "blend": "set", "target": 2, "edge": "cliff", "skirt": 3, "half": 2, "line": [[-25, 10], [25, 14]]},
        {"id": "m_dune", "kind": "dune", "op": "dune", "mask": "all", "blend": "add", "wave": {"kind": "dune", "amp": 2, "scale": 12, "seed": 7, "dir": [0.6, 0.8]}},
        {"id": "m_top", "kind": "plateau", "level": 2, "override": True, "polygon": [[-8, 16], [8, 16], [8, 26], [-8, 26]]},
        {"id": "m_pit", "kind": "pit", "height": -3, "polygon": [[10, 16], [20, 16], [20, 26], [10, 26]]},
    ]}}
    # 高度 / 坡度 / 3 m 切片层号（slab_at = 引擎 levelAt）来自引擎；最后一列是按实际台地分的层号：
    # 层表 = 基准面 0、override 台地 6、pit 质心处实际高度 −0.58（雕刻模式里负特征是叠加的，坑底不是 −3）；没有出生点 → 基准面为 0，坑 −1、台地 +1
    expect = [(-3.3, 7.7, 8.445, 2.645, 3, 1), (12.1, -4.4, 6.318, 1.044, 2, 1), (0, 21, 6.0, 0.0, 2, 1), (15, 21, -0.581, 0.457, 0, -1), (-22, 12.5, 2.074, 0.234, 1, 0), (23, -23, 0.415, 0.22, 0, 0), (5.5, -15.2, 5.54, 0.541, 2, 1)]
    MT = sr.Terrain(mini)
    got = [(x, z, round(MT.height_at(x, z), 3), round(MT.slope_at(x, z), 3), MT.slab_at(x, z), MT.level_at(x, z)) for x, z, *_ in expect]
    okk = all(abs(g[2] - e[2]) <= 0.002 and abs(g[3] - e[3]) <= 0.002 and g[4] == e[4] and g[5] == e[5] for g, e in zip(got, expect))
    check("雕刻模式：raise / noise / quant / line-set / dune / override / pit 七个样本点的高度、坡度、切片层号与引擎一致（±2 mm），台地层号按层表", okk, f"got {got}")
    check("雕刻模式层表：基准面 0、override 台地 6、坑底 −0.58 → [−0.58, 0, 6]，没有出生点时基准面为 0", MT.layers == [-0.58, 0.0, 6.0] and MT.zero == 1 and MT.zero_from == "base", f"{MT.layers} zero={MT.zero}")
    check("雕刻模式：旧式 override 台地登记为 terrace，雕刻 op 不登记", [(t["id"], t["level"], t["height"]) for t in MT.terraces] == [("m_top", 2, 6.0)], str(MT.terraces))
    check("JS 取整：切片层号 .5 向上（13.5 m / 3 m → 5，不是银行家舍入的 4）", sr.js_round(4.5) == 5 and sr.js_round(2.5) == 3 and sr.js_round(-0.5) == 0 and sr.js_round(1.4) == 1)

    # ------------------------------------------------ 6. SID 自带层表（引擎写的 / 人定的 terrain.layers，docs/07 §5）→ 直接用，不自己找平面
    sid6 = copy.deepcopy(sid)
    sid6["terrain"]["layers"] = [{"id": "L0", "height_m": 0, "source": "user"}, {"id": "L1", "height_m": 3, "source": "user"}, {"id": "L2", "height_m": 6, "source": "user"}, {"id": "L3", "height_m": 12, "label": "塔顶", "source": "user"}]
    T6 = sr.Terrain(sid6)
    check("SID 带 terrain.layers → 层表直接用它（含人加的 12 m 层），没给 meta.layer_zero 时出生点所在层仍为 0",
          T6.layers == [0.0, 3.0, 6.0, 12.0] and T6.layers_from == "sid" and T6.zero == 0 and T6.zero_from == "spawn" and T6.level_at(0, -18) == 2 and T6.level_at(0, 28) == 0, f"{T6.layers} zero={T6.zero} {T6.zero_from}")
    sid6["meta"]["layer_zero"], sid6["meta"]["layer_zero_from"] = 6, "user"
    T6b = sr.Terrain(sid6)
    s6 = score(sid6, rb)["summary"]
    check("meta.layer_zero = 6 → 6 m 那层为 0：出生点 −2、12 m 层 +1；summary.layers 透出 source / zero_from",
          T6b.zero == 2 and T6b.zero_from == "user" and T6b.level_at(0, 28) == -2 and T6b.layer_index(12) - T6b.zero == 1
          and s6["layers"] == {"heights_m": [0.0, 3.0, 6.0, 12.0], "zero_m": 6.0, "zero_from": "user", "range": [-2, 1], "source": "sid"}, json.dumps(s6["layers"]))
    sid6["terrain"]["layers"] = []
    check("terrain.layers 为空 → 回到自己找平面（旧口径不变）", sr.Terrain(sid6).layers == [0.0, 3.0, 6.0] and sr.Terrain(sid6).layers_from == "auto")

    failed = [r for r in results if not r[1]]
    print(f"\nDONE passed={len(results) - len(failed)} failed={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    for st in (sys.stdout, sys.stderr):
        if st is not None and hasattr(st, "reconfigure"):
            st.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
