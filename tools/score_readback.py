#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
score_readback.py — 比较「意图 SID」与「引擎读回」，输出还原度指标

用法:
  python tools/score_readback.py intent.sid.json readback.json [--map map.json] [--out result.json]
                                 [--include-areas] [--auto-map]

readback.json 支持三种格式（自动识别）：
  1. SID 形态：含 volumes / markers，position 为底面中心、SID 坐标系（直接导入 scene.glb 时用这种）
  2. Unity 导出：{"engine":"unity","objects":[{"name","primitive","position":[x,y,z],"scale":[x,y,z],"euler_y":deg}]}
     position 为 transform.position（原生几何体的几何中心），scale 为 localScale；primitive ∈ cube/cylinder/plane/sphere/capsule/empty/mesh
  3. Unreal 导出：{"engine":"unreal","objects":[{"name","mesh","location":[X,Y,Z](cm),"scale":[x,y,z],"yaw":deg}]}
     BasicShapes 以 1 m 为基准；mesh ∈ cube/cylinder/plane/sphere/cone/empty

计分对象：volumes 与 markers（朝向只对 player_spawn/enemy_spawn/camera/poi/objective 这些有朝向的标记比）。
regions / paths / terrain.features 的读回（按 PROTOCOL 用薄片 / 半球 / aux_ 路段复现）默认既不计分也不算「多余」；
加 --include-areas 时按质心比较 regions 与 paths（路段取名 aux_<path_id>_* 或 <path_id> 的读回对象合并）。
名字以 sid_ / aux_ 开头，以及相机 / 灯 / 地面等默认对象，不算「多余」。

map.json：{"读回里的名字": "意图里的 id", ...}，用于 A 条件（AI 自己起的名字）。
--auto-map：对未匹配的对象按最近位置贪心配对（仅建议时也会打印）。

阈值（docs/02 第 8 节）：位置 < 1 m，尺寸比 0.8–1.25，朝向 < 20°。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

POS_T, SIZE_LO, SIZE_HI, ROT_T = 1.0, 0.8, 1.25, 20.0
IGNORE_NAMES = {"main_camera", "directional_light", "camera", "light", "ground", "plane", "floor", "sid_root", "sid_scene"}
ORIENTED_MARKER_KINDS = {"player_spawn", "enemy_spawn", "camera", "poi", "objective"}


def norm(name: str) -> str:
    s = str(name).strip().lower()
    s = re.sub(r"[\s\-]+", "_", s)
    s = re.sub(r"[^a-z0-9_]", "", s)
    return s


def ignored(raw_name: str) -> bool:
    n = norm(raw_name)
    return n in IGNORE_NAMES or n.startswith("sid_") or n.startswith("aux_")


def load(p: Path) -> dict:
    with p.open(encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- intent side
def intent_objects(sid: dict, include_areas: bool) -> dict[str, dict]:
    objs: dict[str, dict] = {}
    for v in sid.get("volumes", []):
        objs[v["id"]] = {"id": v["id"], "cat": "volume", "kind": v.get("kind"), "shape": v.get("shape"),
                         "position": v["position"], "size": v["size"], "rotation_y": v.get("rotation_y", 0.0)}
    for m in sid.get("markers", []):
        objs[m["id"]] = {"id": m["id"], "cat": "marker", "kind": m.get("kind"), "shape": None,
                         "position": m["position"], "size": m.get("size"),
                         "rotation_y": m.get("rotation_y") if m.get("kind") in ORIENTED_MARKER_KINDS else None}
    if include_areas:
        for r in sid.get("regions", []):
            xs = [p[0] for p in r["polygon"]]
            zs = [p[1] for p in r["polygon"]]
            objs[r["id"]] = {"id": r["id"], "cat": "region", "kind": r.get("kind"), "shape": "area",
                             "position": [sum(xs) / len(xs), 0.0, sum(zs) / len(zs)],
                             "size": [max(xs) - min(xs), 0.0, max(zs) - min(zs)], "rotation_y": None}
        for p in sid.get("paths", []):
            cx, cz = polyline_centroid(p["points"])
            objs[p["id"]] = {"id": p["id"], "cat": "path", "kind": p.get("kind"), "shape": "line",
                             "position": [cx, 0.0, cz], "size": None, "rotation_y": None}
    return objs


def unscored_ids(sid: dict) -> set[str]:
    """默认不计分、也不算多余的意图对象（regions / paths / features 的复现物）"""
    out = {r["id"] for r in sid.get("regions", [])} | {p["id"] for p in sid.get("paths", [])}
    out |= {f["id"] for f in sid.get("terrain", {}).get("features", [])}
    return {norm(i) for i in out}


def polyline_centroid(points) -> tuple[float, float]:
    """按线段长度加权的折线质心（点分布不均时比顶点平均更稳）"""
    if len(points) == 1:
        return points[0][0], points[0][1]
    total = 0.0
    sx = sz = 0.0
    for (x0, z0), (x1, z1) in zip(points, points[1:]):
        L = math.hypot(x1 - x0, z1 - z0)
        total += L
        sx += (x0 + x1) / 2 * L
        sz += (z0 + z1) / 2 * L
    if total < 1e-9:
        return points[0][0], points[0][1]
    return sx / total, sz / total


# ---------------------------------------------------------------- readback side
def unity_to_sid(o: dict) -> dict:
    prim = (o.get("primitive") or o.get("type") or "cube").lower()
    px, py, pz = o["position"]
    sx, sy, sz = o.get("scale", [1, 1, 1])
    if prim in ("empty", "none", "transform"):
        w, h, d = 0.0, 0.0, 0.0            # 空物体：position 本身就是底面中心
    elif prim == "cylinder":
        w, h, d = sx, sy * 2, sz           # Unity Cylinder 默认高 2、直径 1
    elif prim == "capsule":
        w, h, d = sx, sy * 2, sz
    elif prim == "plane":
        w, h, d = sx * 10, 0.0, sz * 10    # Unity Plane 默认 10×10
    elif prim == "quad":
        w, h, d = sx, sy, 0.0
    elif prim in ("mesh", "glb", "custom"):
        w, h, d = sx, sy, sz               # 直接导入的 glb 节点：translation 已是底面中心，scale 就是尺寸
        rot = -(o.get("euler_y", o.get("rotation_y", 0.0)) or 0.0)
        return {"id": norm(o["name"]), "raw_name": o["name"], "kind": o.get("kind"), "shape": prim,
                "position": [px, py, -pz], "size": [w, h, d], "rotation_y": rot}
    else:
        w, h, d = sx, sy, sz               # Cube / Sphere
    rot = -(o.get("euler_y", o.get("rotation_y", 0.0)) or 0.0)
    return {"id": norm(o["name"]), "raw_name": o["name"], "kind": o.get("kind"), "shape": prim,
            "position": [px, py - h / 2, -pz], "size": [w, h, d], "rotation_y": rot}


def unreal_to_sid(o: dict) -> dict:
    mesh = (o.get("mesh") or "cube").lower()
    X, Y, Z = o["location"]
    sx, sy, sz = o.get("scale", [1, 1, 1])
    if mesh in ("empty", "none", "actor", "transform"):
        w, h, d = 0.0, 0.0, 0.0
    else:
        w, d, h = sy, sx, sz               # UE Y ← SID x，UE X ← SID −z，UE Z ← SID y；BasicShapes 1 m 基准
        if mesh == "plane":
            h = 0.0
    rot = -(o.get("yaw", 0.0) or 0.0)
    return {"id": norm(o["name"]), "raw_name": o["name"], "kind": o.get("kind"), "shape": mesh,
            "position": [Y / 100.0, Z / 100.0 - h / 2, -X / 100.0], "size": [w, h, d], "rotation_y": rot}


def readback_objects(rb: dict) -> tuple[dict[str, dict], str]:
    if "objects" in rb:
        eng = (rb.get("engine") or "unity").lower()
        conv = unreal_to_sid if eng.startswith("unreal") or eng == "ue" else unity_to_sid
        objs = [conv(o) for o in rb["objects"]]
        fmt = f"engine:{eng}"
    else:
        objs = []
        for v in rb.get("volumes", []):
            objs.append({"id": norm(v["id"]), "raw_name": v["id"], "kind": v.get("kind"), "shape": v.get("shape"),
                         "position": v["position"], "size": v.get("size"), "rotation_y": v.get("rotation_y", 0.0)})
        for m in rb.get("markers", []):
            objs.append({"id": norm(m["id"]), "raw_name": m["id"], "kind": m.get("kind"), "shape": None,
                         "position": m["position"], "size": m.get("size"), "rotation_y": m.get("rotation_y")})
        fmt = "sid"
    out: dict[str, dict] = {}
    for o in objs:
        key = o["id"]
        i = 2
        while key in out:
            key = f"{o['id']}__{i}"
            i += 1
        out[key] = o
    return out, fmt


def merge_path_readbacks(rb: dict[str, dict], path_ids: list[str]) -> dict[str, dict]:
    """--include-areas：把 aux_<path_id>_* / <path_id> 的读回对象合并成一个按长度加权的质心"""
    merged: dict[str, dict] = {}
    for pid in path_ids:
        n = norm(pid)
        segs = [o for k, o in rb.items() if norm(o["raw_name"]) == n or norm(o["raw_name"]).startswith("aux_" + n)]
        if not segs:
            continue
        tot = 0.0
        sx = sz = 0.0
        for o in segs:
            L = max(o["size"][0], o["size"][2]) if o.get("size") else 1.0
            L = L or 1.0
            tot += L
            sx += o["position"][0] * L
            sz += o["position"][2] * L
        merged[n] = {"id": n, "raw_name": pid, "kind": "path", "shape": "line",
                     "position": [sx / tot, 0.0, sz / tot], "size": None, "rotation_y": None}
    return merged


# ---------------------------------------------------------------- compare
def ang_diff(a: float, b: float, period: float = 360.0) -> float:
    d = (a - b) % period
    return min(d, period - d)


def compare(intent: dict[str, dict], rb: dict[str, dict], mapping: dict[str, str], auto_map: bool, unscored: set[str]) -> dict:
    rb_to_intent: dict[str, str] = {}
    intent_norm = {norm(k): k for k in intent}
    for rk, ro in rb.items():
        tgt = mapping.get(ro["raw_name"]) or mapping.get(rk) or intent_norm.get(rk)
        if tgt and tgt in intent and tgt not in rb_to_intent.values():
            rb_to_intent[rk] = tgt

    def is_extra(rk: str) -> bool:
        o = rb[rk]
        n = norm(o["raw_name"])
        return rk not in rb_to_intent and not ignored(o["raw_name"]) and n not in unscored

    unmatched_intent = [k for k in intent if k not in rb_to_intent.values()]
    unmatched_rb = [k for k in rb if is_extra(k)]
    suggestions = []
    pairs = []
    for ik in unmatched_intent:
        ip = intent[ik]["position"]
        for rk in unmatched_rb:
            rp = rb[rk]["position"]
            pairs.append((math.hypot(ip[0] - rp[0], ip[2] - rp[2]), ik, rk))
    pairs.sort()
    used_i, used_r = set(), set()
    for dist, ik, rk in pairs:
        if ik in used_i or rk in used_r:
            continue
        used_i.add(ik)
        used_r.add(rk)
        suggestions.append({"intent": ik, "readback": rb[rk]["raw_name"], "dist_m": round(dist, 2)})
        if auto_map:
            rb_to_intent[rk] = ik
    if auto_map:
        unmatched_intent = [k for k in intent if k not in rb_to_intent.values()]
        unmatched_rb = [k for k in unmatched_rb if k not in rb_to_intent]

    rows = []
    for rk, ik in rb_to_intent.items():
        a, b = intent[ik], rb[rk]
        dx, dy, dz = (b["position"][i] - a["position"][i] for i in range(3))
        pos_err = math.hypot(dx, dz)
        row = {"id": ik, "matched": b["raw_name"], "pos_err_m": round(pos_err, 2), "dy_m": round(dy, 2),
               "size_ratio": None, "rot_err": None, "rot_err_180": None,
               "pos_ok": pos_err < POS_T, "size_ok": None, "rot_ok": None}
        if a.get("size") and b.get("size") and a["cat"] == "volume":
            ratios = []
            for i in (0, 1, 2):
                ai, bi = a["size"][i], b["size"][i]
                if ai and bi:
                    ratios.append(max(ai / bi, bi / ai))
            if ratios:
                row["size_ratio"] = round(max(ratios), 2)
                row["size_ok"] = max(ratios) <= SIZE_HI  # ratios 已取 max(a/b, b/a)，≤1.25 等价于 0.8–1.25
        round_cyl = a.get("shape") == "cylinder" and a.get("size") and abs(a["size"][0] - a["size"][2]) <= 0.05 * max(a["size"][0], 1e-9)
        if a.get("rotation_y") is not None and b.get("rotation_y") is not None and not round_cyl:
            if a.get("shape") == "cylinder":   # 椭圆柱：180° 对称
                err = ang_diff(a["rotation_y"], b["rotation_y"], 180.0)
                row["rot_err"] = row["rot_err_180"] = round(err, 1)
            else:
                row["rot_err"] = round(ang_diff(a["rotation_y"], b["rotation_y"]), 1)
                row["rot_err_180"] = round(ang_diff(a["rotation_y"], b["rotation_y"], 180.0), 1)
            row["rot_ok"] = row["rot_err"] < ROT_T
        rows.append(row)
    rows.sort(key=lambda r: r["id"])

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return round(sum(xs) / len(xs), 2) if xs else None

    def median(xs):
        xs = sorted(x for x in xs if x is not None)
        if not xs:
            return None
        n = len(xs)
        return round(xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2, 2)

    def rate(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return round(100 * sum(vals) / len(vals)) if vals else None

    summary = {
        "intent_objects": len(intent), "matched": len(rows),
        "missing": unmatched_intent, "extra": [rb[k]["raw_name"] for k in unmatched_rb],
        "pos_err_mean_m": mean([r["pos_err_m"] for r in rows]), "pos_err_median_m": median([r["pos_err_m"] for r in rows]),
        "pos_ok_rate_pct": rate("pos_ok"), "size_ok_rate_pct": rate("size_ok"), "rot_ok_rate_pct": rate("rot_ok"),
        "rot_err_mean_deg": mean([r["rot_err"] for r in rows]),
    }
    return {"rows": rows, "summary": summary, "suggestions": suggestions}


def tick(v):
    return "-" if v is None else ("OK" if v else "NG")


def print_report(res: dict, fmt: str) -> None:
    s = res["summary"]
    print(f"读回格式：{fmt}\n")
    print("| id | 匹配到 | 位置误差 m | 高度差 m | 尺寸比(max) | 朝向差° | 朝向差°(mod180) | 位置 | 尺寸 | 朝向 |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | :-: | :-: | :-: |")
    for r in res["rows"]:
        print(f"| {r['id']} | {r['matched']} | {r['pos_err_m']} | {r['dy_m']} | "
              f"{'-' if r['size_ratio'] is None else r['size_ratio']} | "
              f"{'-' if r['rot_err'] is None else r['rot_err']} | {'-' if r['rot_err_180'] is None else r['rot_err_180']} | "
              f"{tick(r['pos_ok'])} | {tick(r['size_ok'])} | {tick(r['rot_ok'])} |")
    print()
    print(f"意图对象 {s['intent_objects']}，匹配 {s['matched']}，缺漏 {len(s['missing'])}，多余 {len(s['extra'])}")
    print(f"位置误差：均值 {s['pos_err_mean_m']} m，中位数 {s['pos_err_median_m']} m，< {POS_T} m 的比例 {s['pos_ok_rate_pct']}%")
    print(f"尺寸比在 {SIZE_LO}–{SIZE_HI} 内的比例 {s['size_ok_rate_pct']}%；朝向差 < {ROT_T}° 的比例 {s['rot_ok_rate_pct']}%（均值 {s['rot_err_mean_deg']}°）")
    if s["missing"]:
        print("缺漏：" + ", ".join(s["missing"]))
    if s["extra"]:
        print("多余（未计入 sid_/aux_ 前缀、相机 / 灯 / 地面、区域 / 路径 / 地形复现物）：" + ", ".join(s["extra"]))
    if res["suggestions"]:
        print("\n未匹配对象的最近邻建议映射（可写进 map.json 或加 --auto-map）：")
        for g in res["suggestions"]:
            print(f"  {g['readback']!r} → {g['intent']}  (距 {g['dist_m']} m)")


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):  # Windows 下重定向 / 管道时默认是 GBK，中文会崩
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="比较意图 SID 与引擎读回")
    ap.add_argument("intent", type=Path)
    ap.add_argument("readback", type=Path)
    ap.add_argument("--map", type=Path, default=None, help="读回名字 → 意图 id 的 JSON 映射")
    ap.add_argument("--out", type=Path, default=None, help="把结果写成 JSON")
    ap.add_argument("--include-areas", action="store_true", help="把 regions / paths 的质心也纳入比较")
    ap.add_argument("--auto-map", action="store_true", help="未匹配对象按最近位置自动配对")
    args = ap.parse_args(argv)

    sid = load(args.intent)
    intent = intent_objects(sid, args.include_areas)
    rb, fmt = readback_objects(load(args.readback))
    unscored = set() if args.include_areas else unscored_ids(sid)
    if args.include_areas:
        rb.update(merge_path_readbacks(rb, [p["id"] for p in sid.get("paths", [])]))
        unscored = {norm(f["id"]) for f in sid.get("terrain", {}).get("features", [])}
    mapping = load(args.map) if args.map else {}
    mapping = {k: v for k, v in mapping.items() if not k.startswith("_")}
    res = compare(intent, rb, mapping, args.auto_map, unscored)
    if args.out:  # 先落盘，再打印：控制台编码问题不该丢结果
        with args.out.open("w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
    print_report(res, fmt)
    if args.out:
        print(f"\n结果 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
