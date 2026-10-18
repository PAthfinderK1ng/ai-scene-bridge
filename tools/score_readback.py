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

阈值（docs/02 第 8 节 / spec/PROTOCOL.md 4.2）：位置 < 1 m，尺寸比 0.8–1.25，朝向 < 20°。

除位置 / 尺寸 / 朝向 / 缺漏外，还比四件事（docs/03 第 11 节第 7 条）。地形用纯 Python 复刻 medium/engine/terrain.js 的高度函数：
  - 台地层：每个 volume 的意图位置与读回位置各算一次层号 round((h − base) / meta.layer_height_m)，rows 里 level_intent / level_readback / level_ok
  - 可见性：从读回的 player_spawn（眼高 meta.player_height）看读回地标（importance=landmark）顶部，沿线每 1 m 采样
    地形（+0.3 m 容差）与其它读回体块的 OBB → summary.visible_from_spawn {intent, readback, blocked_by}
  - 连通性：2 m 网格 BFS（可走 = 坡度 ≤ 0.7 或在任一可走路的走廊内；读回里的路取 aux_<path_id>_* / <path_id> 路段合并），
    出生点能否走到地标门前（距地标中心 ≤ 6 m）→ summary.trail_connected {intent, readback}
  - 颜色：读回对象带 color "#RRGGBB" 时，与意图 style.palette 中该对象 color_role 的 hex 比 CIE76 ΔE（≤ 10 合格），rows 里 color_ok / delta_e
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

POS_T, SIZE_LO, SIZE_HI, ROT_T = 1.0, 0.8, 1.25, 20.0
DELTA_E_T = 10.0            # 颜色：CIE76 ΔE 阈值
MAX_SLOPE, GRID_RES = 0.7, 2.0   # 连通性：可走坡度上限、BFS 网格（与 engine/relations.js reachSet 一致）
DOOR_R, LOS_TOL = 6.0, 0.3  # 地标门前半径；视线对地形的容差
DEFAULT_LAYER_M, DEFAULT_EYE_M = 3.0, 1.7
DEFAULT_BOUNDS = {"min": [-60, 0, -60], "max": [60, 40, 60]}
IGNORE_NAMES = {"main_camera", "directional_light", "camera", "light", "ground", "plane", "floor", "sid_root", "sid_scene"}
ORIENTED_MARKER_KINDS = {"player_spawn", "enemy_spawn", "camera", "poi", "objective"}
WALK_KINDS = {"road", "trail", "bridge", "other"}   # 可以走的路类型（溪、墙线、围栏不是走廊）
KIND_COLOR_ROLE = {"building": "wall", "wall": "roof", "rock": "stone", "prop": "stone", "water": "water"}  # PROTOCOL 3.1 第 6 条：没有 color_role 时按 kind


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
                         "position": v["position"], "size": v["size"], "rotation_y": v.get("rotation_y", 0.0),
                         "color_role": v.get("color_role"), "importance": v.get("importance")}
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
                "position": [px, py, -pz], "size": [w, h, d], "rotation_y": rot, "color": o.get("color")}
    else:
        w, h, d = sx, sy, sz               # Cube / Sphere
    rot = -(o.get("euler_y", o.get("rotation_y", 0.0)) or 0.0)
    return {"id": norm(o["name"]), "raw_name": o["name"], "kind": o.get("kind"), "shape": prim,
            "position": [px, py - h / 2, -pz], "size": [w, h, d], "rotation_y": rot, "color": o.get("color")}


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
            "position": [Y / 100.0, Z / 100.0 - h / 2, -X / 100.0], "size": [w, h, d], "rotation_y": rot, "color": o.get("color")}


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
                         "position": v["position"], "size": v.get("size"), "rotation_y": v.get("rotation_y", 0.0),
                         "color": v.get("color")})
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


# ---------------------------------------------------------------- terrain（纯 Python 复刻 medium/engine/terrain.js）
def clamp(v: float, a: float, b: float) -> float:
    return max(a, min(b, v))


def point_in_polygon(p, poly) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i][0], poly[i][1]
        xj, zj = poly[j][0], poly[j][1]
        if (zi > p[1]) != (zj > p[1]) and p[0] < (xj - xi) * (p[1] - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def dist_to_segment(p, a, b) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dz * dz or 1e-9
    t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0.0, 1.0)
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz))


def dist_to_polygon(p, poly) -> float:
    return min(dist_to_segment(p, poly[i - 1], poly[i]) for i in range(len(poly)))


def dist_to_polyline(p, pts) -> float:
    if len(pts) < 2:
        return math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) if pts else math.inf
    return min(dist_to_segment(p, pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def polygon_centroid(poly):
    a = cx = cz = 0.0
    j = len(poly) - 1
    for i in range(len(poly)):
        f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
        a += f
        cx += (poly[j][0] + poly[i][0]) * f
        cz += (poly[j][1] + poly[i][1]) * f
        j = i
    if abs(a) < 1e-9:
        return [sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)]
    return [cx / (3 * a), cz / (3 * a)]


def normalize_feature(f: dict, layer: float) -> dict:
    out = dict(f)
    poly = out.get("polygon")
    if poly and len(poly) >= 3:
        c = polygon_centroid(poly)
        out["center"] = [c[0], 0, c[1]]
        out["radius"] = max(math.hypot(p[0] - c[0], p[1] - c[1]) for p in poly)
    if isinstance(out.get("level"), (int, float)) and not isinstance(out.get("height"), (int, float)):
        out["height"] = out["level"] * layer
    if not isinstance(out.get("height"), (int, float)):
        out["height"] = 0.0
    if not isinstance(out.get("skirt"), (int, float)):
        out["skirt"] = clamp(abs(out["height"]) * 0.8, 2.0, 10.0)
    if not out.get("kind"):
        out["kind"] = "plateau" if poly else "hill"
    return out


def feature_contribution(f: dict, x: float, z: float) -> float:
    k = f.get("kind")
    poly = f.get("polygon")
    if k in ("plateau", "ridge", "cliff") and poly:
        if point_in_polygon([x, z], poly):
            return f["height"]
        d = dist_to_polygon([x, z], poly)
        return f["height"] * max(0.0, 1 - d / f["skirt"])
    R = max(f.get("radius") or 1.0, 0.5)   # 圆形穹顶（hill / pit / 无 polygon 的 plateau）
    c = f.get("center") or [0, 0, 0]
    r = math.hypot(x - c[0], z - c[2])
    if k == "plateau":
        return f["height"] if r <= R else f["height"] * max(0.0, 1 - (r - R) / f["skirt"])
    return f["height"] * max(0.0, 1 - (r / R) ** 2)


def height_from_features(feats, base: float, x: float, z: float) -> float:
    pos = neg = 0.0
    for f in feats:
        c = feature_contribution(f, x, z)
        if c >= 0:
            pos = max(pos, c)
        else:
            neg += c
    return base + pos + neg


class Terrain:
    """buildTerrain 的 Python 版：2 m 网格 + 双线性插值；heightAt / slopeAt / levelAt / terraceAt 与前端同口径"""

    def __init__(self, sid: dict, res: float = GRID_RES):
        b = sid.get("bounds") or DEFAULT_BOUNDS
        self.xmin, self.zmin, self.xmax, self.zmax = b["min"][0], b["min"][2], b["max"][0], b["max"][2]
        self.res = res
        meta = sid.get("meta") or {}
        try:
            self.layer = float(meta.get("layer_height_m") or 0) or DEFAULT_LAYER_M
        except (TypeError, ValueError):
            self.layer = DEFAULT_LAYER_M
        terr = sid.get("terrain") or {}
        self.base = float(terr.get("base_height") or 0)
        self.features = [normalize_feature(f, self.layer) for f in (terr.get("features") or []) if isinstance(f, dict)]
        self.nx = math.ceil((self.xmax - self.xmin) / res) + 1
        self.nz = math.ceil((self.zmax - self.zmin) / res) + 1
        self.h = [height_from_features(self.features, self.base, self.xmin + i * res, self.zmin + j * res)
                  for j in range(self.nz) for i in range(self.nx)]
        self.terraces = sorted(
            [{"id": f.get("id"), "level": f["level"] if isinstance(f.get("level"), (int, float)) else round(f["height"] / self.layer),
              "height": f["height"], "polygon": f["polygon"]}
             for f in self.features if f.get("kind") in ("plateau", "ridge") and f.get("polygon")],
            key=lambda t: (t["height"], str(t["id"])))

    def inside(self, x: float, z: float) -> bool:
        return self.xmin <= x <= self.xmax and self.zmin <= z <= self.zmax

    def height_at(self, x: float, z: float) -> float:
        nx, nz, h = self.nx, self.nz, self.h
        fx = clamp((x - self.xmin) / self.res, 0, nx - 1)
        fz = clamp((z - self.zmin) / self.res, 0, nz - 1)
        i = min(int(math.floor(fx)), nx - 2)
        j = min(int(math.floor(fz)), nz - 2)
        tx, tz = fx - i, fz - j
        h00, h10, h01, h11 = h[j * nx + i], h[j * nx + i + 1], h[(j + 1) * nx + i], h[(j + 1) * nx + i + 1]
        return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz

    def slope_at(self, x: float, z: float) -> float:
        d = self.res
        gx = (self.height_at(x + d, z) - self.height_at(x - d, z)) / (2 * d)
        gz = (self.height_at(x, z + d) - self.height_at(x, z - d)) / (2 * d)
        return math.hypot(gx, gz)

    def level_at(self, x: float, z: float) -> int:
        return int(round((self.height_at(x, z) - self.base) / self.layer))

    def terrace_at(self, x: float, z: float):
        best = None
        for t in self.terraces:
            if point_in_polygon([x, z], t["polygon"]) and (best is None or t["height"] > best["height"]):
                best = t
        return best


# ---------------------------------------------------------------- 视线 / 连通性（复刻 engine/relations.js lineOfSight / reachSet）
def box_corners(pos, size, deg: float = 0.0):
    """体块底面四角（俯视 [x, z]），与 engine/validate.js boxCorners 同一公式"""
    t = math.radians(deg or 0.0)
    c, s = math.cos(t), math.sin(t)
    cx, cz, w, d = pos[0], pos[2], size[0], size[2]
    return [[cx + lx * c + lz * s, cz - lx * s + lz * c] for lx, lz in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]


def volume_top(T: Terrain, o: dict) -> float:
    """体块顶面高度：底面取 position.y 与地面的较大者（体块不会沉到地下），再加高"""
    base = max(float(o["position"][1] or 0), T.height_at(o["position"][0], o["position"][2]))
    return base + (o["size"][1] if o.get("size") else 0.0)


def line_of_sight(T: Terrain, volumes, frm, to, eye: float = DEFAULT_EYE_M, target_height: float = DEFAULT_EYE_M, ignore=()) -> dict:
    """从 frm 处 eye 米高看 to 处 target_height 米高（都相对地面）。沿线每 1 m：地面 + 0.3 高过视线 → 被地形挡；
    落在某体块 OBB 内且视线低于体块顶 → 被该体块挡。含 frm / to 的体块（观察者所在、目标本身）自动忽略。
    blocked_by 为 "terrain" / "volume:<名字>" / None。"""
    ignore = set(ignore)
    h0 = T.height_at(frm[0], frm[1]) + eye
    h1 = T.height_at(to[0], to[1]) + target_height
    boxes = []
    for v in volumes or []:
        if not v or not v.get("position") or not v.get("size") or v["id"] in ignore:
            continue
        poly = box_corners(v["position"], v["size"], v.get("rotation_y") or 0.0)
        if point_in_polygon(frm, poly) or point_in_polygon(to, poly):
            continue
        boxes.append((v.get("raw_name") or v["id"], poly, volume_top(T, v)))
    L = math.hypot(to[0] - frm[0], to[1] - frm[1])
    n = max(1, math.ceil(L))
    for k in range(1, n):   # 跳过两端本身
        t = k / n
        x, z = frm[0] + (to[0] - frm[0]) * t, frm[1] + (to[1] - frm[1]) * t
        lh = h0 + (h1 - h0) * t
        if T.height_at(x, z) + LOS_TOL > lh:
            return {"visible": False, "blocked_by": "terrain", "at": [round(x, 2), round(z, 2)]}
        for name, poly, top in boxes:
            if lh < top and point_in_polygon([x, z], poly):
                return {"visible": False, "blocked_by": f"volume:{name}", "at": [round(x, 2), round(z, 2)]}
    return {"visible": True, "blocked_by": None, "at": None}


def polyline_segments(pts):
    return [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]


def reach_set(T: Terrain, corridors, frm, walk_polys=(), max_slope: float = MAX_SLOPE, res: float = GRID_RES) -> dict:
    """从 frm 出发的可达格集合。corridors = [(segments, r)]：到任一线段距离 ≤ r 的格在走廊内。
    可走格 = 坡度 ≤ max_slope 或在走廊内或在任一 walk_polys 内；相邻两格还要求台阶坡度 |Δh| / 距离 ≤ max_slope，
    除非其中一格在走廊内（路可以爬坡）。起点总是可站。"""
    nx = int(math.floor((T.xmax - T.xmin) / res)) + 1
    nz = int(math.floor((T.zmax - T.zmin) / res)) + 1

    def cell_of(x, z):
        return (int(round(clamp((x - T.xmin) / res, 0, nx - 1))), int(round(clamp((z - T.zmin) / res, 0, nz - 1))))

    state = bytearray(nx * nz)   # 0 未算，1 可走（坡度），2 可走（走廊），3 不可走
    hgt = [0.0] * (nx * nz)

    def info(i, j):
        k = j * nx + i
        if state[k]:
            return state[k]
        x, z = T.xmin + i * res, T.zmin + j * res
        hgt[k] = T.height_at(x, z)
        s = 1 if T.slope_at(x, z) <= max_slope else 3
        for segs, r in corridors:
            if any(dist_to_segment([x, z], a, b) <= r for a, b in segs):
                s = 2
                break
        if s != 2:
            for poly in walk_polys:
                if point_in_polygon([x, z], poly):
                    s = 2
                    break
        state[k] = s
        return s

    reached = bytearray(nx * nz)
    si, sj = cell_of(frm[0], frm[1])
    info(si, sj)
    if state[sj * nx + si] == 3:
        state[sj * nx + si] = 1
    reached[sj * nx + si] = 1
    queue = [(si, sj)]
    q = 0
    while q < len(queue):
        i, j = queue[q]
        q += 1
        k = j * nx + i
        sc = state[k]
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if not di and not dj:
                    continue
                ni, nj = i + di, j + dj
                if ni < 0 or nj < 0 or ni >= nx or nj >= nz:
                    continue
                nk = nj * nx + ni
                if reached[nk]:
                    continue
                sn = info(ni, nj)
                if sn == 3:
                    continue
                if sc != 2 and sn != 2 and abs(hgt[nk] - hgt[k]) / (res * math.hypot(di, dj)) > max_slope:
                    continue
                reached[nk] = 1
                queue.append((ni, nj))
    cells = [(T.xmin + i * res, T.zmin + j * res) for j in range(nz) for i in range(nx) if reached[j * nx + i]]
    return {"reached": reached, "nx": nx, "nz": nz, "res": res, "cells": cells,
            "at": lambda x, z: reached[cell_of(x, z)[1] * nx + cell_of(x, z)[0]] == 1}


def trail_connected(T: Terrain, corridors, frm, landmark: dict) -> bool:
    """出生点能否走到地标门前：地标底面外扩 1 m 视为可走（站到门前就算到），任一可达格距地标中心 ≤ DOOR_R 即连通"""
    lm = landmark["position"]
    walk = [box_corners(lm, [landmark["size"][0] + 2, landmark["size"][1], landmark["size"][2] + 2], landmark.get("rotation_y") or 0.0)] if landmark.get("size") else []
    R = reach_set(T, corridors, frm, walk_polys=walk)
    return any(math.hypot(x - lm[0], z - lm[2]) <= DOOR_R for x, z in R["cells"])


def intent_corridors(sid: dict):
    """意图里可走的路 → [(线段列表, 走廊半径 = 宽/2 + 1)]"""
    out = []
    for p in sid.get("paths", []) or []:
        if p and p.get("kind") in WALK_KINDS and isinstance(p.get("points"), list) and len(p["points"]) >= 2:
            out.append((polyline_segments(p["points"]), (p.get("width") or 2) / 2 + 1))
    return out


def box_axis_segment(o: dict):
    """一个细长盒子（aux 路段）→ 沿长边的中心线段 [(a, b)] 与宽度；没有尺寸时退化为一点"""
    pos, size = o["position"], o.get("size") or [0, 0, 0]
    t = math.radians(o.get("rotation_y") or 0.0)
    c, s = math.cos(t), math.sin(t)
    if size[0] >= size[2]:
        L, w, ux, uz = size[0], size[2], c, -s      # 局部 x 轴 → 世界 (cos, −sin)（见 box_corners）
    else:
        L, w, ux, uz = size[2], size[0], s, c       # 局部 z 轴 → 世界 (sin, cos)
    a = [pos[0] - ux * L / 2, pos[2] - uz * L / 2]
    b = [pos[0] + ux * L / 2, pos[2] + uz * L / 2]
    return (a, b), w


def readback_corridors(rb: dict[str, dict], rb_raw: dict | None, sid: dict):
    """读回里的路：SID 形态直接用 paths[]；引擎格式按 merge_path_readbacks 的命名规则（aux_<path_id>_* / <path_id>）
    把每段盒子化成中心线段，宽度取盒子短边（没有就用意图宽度）。只收可走类型的路（按意图 kind）。"""
    out = []
    if rb_raw and isinstance(rb_raw.get("paths"), list):
        kinds = {norm(p["id"]): p.get("kind") for p in sid.get("paths", []) or [] if p.get("id")}
        for p in rb_raw["paths"]:
            kind = p.get("kind") or kinds.get(norm(p.get("id", "")))
            if kind in WALK_KINDS and isinstance(p.get("points"), list) and len(p["points"]) >= 2:
                out.append((polyline_segments(p["points"]), (p.get("width") or 2) / 2 + 1))
    for p in sid.get("paths", []) or []:
        if not p or p.get("kind") not in WALK_KINDS:
            continue
        n = norm(p["id"])
        segs = []
        for o in rb.values():
            rn = norm(o.get("raw_name", ""))
            if (rn == n or rn.startswith("aux_" + n + "_") or rn.startswith("aux_" + n)) and o.get("size") and o.get("position"):
                seg, w = box_axis_segment(o)
                segs.append((seg, w))
        if segs:
            width = min((w for _, w in segs if w > 0), default=None) or (p.get("width") or 2)
            out.append(([seg for seg, _ in segs], width / 2 + 1))
    return out


# ---------------------------------------------------------------- 颜色（复刻 engine/color.js：sRGB → Lab(D65)，CIE76）
def hex_to_rgb(hx) -> tuple[int, int, int] | None:
    s = str(hx or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return None
    n = int(s, 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def rgb_to_lab(rgb) -> tuple[float, float, float]:
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    R, G, B = (lin(c) for c in rgb)
    X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047
    Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / 1.0
    Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883
    fx, fy, fz = f(X), f(Y), f(Z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(hex_a, hex_b) -> float | None:
    """CIE76 色差；任一 hex 非法返回 None"""
    a, b = hex_to_rgb(hex_a), hex_to_rgb(hex_b)
    if a is None or b is None:
        return None
    p, q = rgb_to_lab(a), rgb_to_lab(b)
    return math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])


def intent_hex(sid: dict, obj: dict) -> str | None:
    """意图对象该用的 hex：color_role → palette；没有 color_role 时按 kind（PROTOCOL 3.1 第 6 条）"""
    role = obj.get("color_role") or KIND_COLOR_ROLE.get(obj.get("kind") or "")
    if not role:
        return None
    for c in ((sid.get("style") or {}).get("palette") or []):
        if isinstance(c, dict) and c.get("role") == role and hex_to_rgb(c.get("hex")):
            return c["hex"]
    return None


# ---------------------------------------------------------------- compare
def ang_diff(a: float, b: float, period: float = 360.0) -> float:
    d = (a - b) % period
    return min(d, period - d)


def compare(intent: dict[str, dict], rb: dict[str, dict], mapping: dict[str, str], auto_map: bool, unscored: set[str],
            sid: dict | None = None, rb_raw: dict | None = None) -> dict:
    """意图对象 vs 读回对象。给了 sid 才算台地层 / 颜色 / 可见性 / 连通性（需要地形、色板、路与 meta）。"""
    T = Terrain(sid) if sid is not None else None
    has_terrain = bool(T and T.features)
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
               "pos_ok": pos_err < POS_T, "size_ok": None, "rot_ok": None,
               "level_intent": None, "level_readback": None, "level_ok": None,
               "color_intent": None, "color_readback": None, "delta_e": None, "color_ok": None}
        if a["cat"] == "volume" and has_terrain:   # 台地层：意图位置与读回位置各算一次层号
            row["level_intent"] = T.level_at(a["position"][0], a["position"][2])
            row["level_readback"] = T.level_at(b["position"][0], b["position"][2])
            row["level_ok"] = row["level_intent"] == row["level_readback"]
        if a["cat"] == "volume" and sid is not None and b.get("color"):   # 颜色：读回带 color 才计分
            want = intent_hex(sid, a)
            de = delta_e(want, b["color"]) if want else None
            if de is not None:
                row["color_intent"], row["color_readback"] = want, "#" + str(b["color"]).strip().lstrip("#").lower()
                row["delta_e"], row["color_ok"] = round(de, 1), de <= DELTA_E_T
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
        "level_ok_rate_pct": rate("level_ok"), "color_ok_rate_pct": rate("color_ok"),
        "delta_e_mean": mean([r["delta_e"] for r in rows]),
        "visible_from_spawn": {"intent": None, "readback": None, "blocked_by": None, "blocked_by_intent": None},
        "trail_connected": {"intent": None, "readback": None},
    }
    if sid is not None:
        scene_checks(sid, T, intent, rb, rb_to_intent, rb_raw, unscored, summary)
    return {"rows": rows, "summary": summary, "suggestions": suggestions}


def scene_checks(sid: dict, T: Terrain, intent: dict[str, dict], rb: dict[str, dict], rb_to_intent: dict[str, str],
                 rb_raw: dict | None, unscored: set[str], summary: dict) -> None:
    """场景级两项：出生点能否看见地标、主路是否从出生点连到地标门前。意图侧与读回侧各算一遍，写进 summary。
    读回侧用读回的出生点 / 地标 / 体块 / 路段，地形仍用意图的高度函数（引擎的地形读不回来）。"""
    lm_id = next((k for k, o in intent.items() if o["cat"] == "volume" and o.get("importance") == "landmark"), None) \
        or next((k for k, o in intent.items() if o["cat"] == "volume" and k == "landmark"), None)
    sp_id = next((k for k, o in intent.items() if o["cat"] == "marker" and o.get("kind") == "player_spawn"), None)
    if not lm_id or not sp_id:
        return
    eye = float((sid.get("meta") or {}).get("player_height") or 0) or DEFAULT_EYE_M
    vis, con = summary["visible_from_spawn"], summary["trail_connected"]

    # 意图侧
    lm, sp = intent[lm_id], intent[sp_id]
    sp_xz, lm_xz = [sp["position"][0], sp["position"][2]], [lm["position"][0], lm["position"][2]]
    vols = [o for o in intent.values() if o["cat"] == "volume"]
    los = line_of_sight(T, vols, sp_xz, lm_xz, eye=eye, target_height=volume_top(T, lm) - T.height_at(*lm_xz), ignore=[lm_id])
    vis["intent"], vis["blocked_by_intent"] = los["visible"], los["blocked_by"]
    con["intent"] = trail_connected(T, intent_corridors(sid), sp_xz, lm)

    # 读回侧：按匹配找到读回的地标与出生点
    inv = {ik: rk for rk, ik in rb_to_intent.items()}
    if lm_id not in inv or sp_id not in inv:
        vis["blocked_by"] = "missing:" + ",".join(i for i in (lm_id, sp_id) if i not in inv)
        return
    rlm, rsp = rb[inv[lm_id]], rb[inv[sp_id]]
    rsp_xz, rlm_xz = [rsp["position"][0], rsp["position"][2]], [rlm["position"][0], rlm["position"][2]]
    # 挡视线的读回体块：有尺寸、不是标记 / 相机 / 灯 / 地面 / aux_ 辅助物、也不是区域 / 路 / 地形的复现物
    blockers = [o for k, o in rb.items() if o.get("size") and o["size"][1] > 0 and k != inv[lm_id]
                and not ignored(o["raw_name"]) and norm(o["raw_name"]) not in unscored]
    los = line_of_sight(T, blockers, rsp_xz, rlm_xz, eye=eye, target_height=volume_top(T, rlm) - T.height_at(*rlm_xz)) if rlm.get("size") else {"visible": None, "blocked_by": None}
    vis["readback"], vis["blocked_by"] = los["visible"], los["blocked_by"]
    con["readback"] = trail_connected(T, readback_corridors(rb, rb_raw, sid), rsp_xz, rlm) if rlm.get("size") else None


def tick(v):
    return "-" if v is None else ("OK" if v else "NG")


def print_report(res: dict, fmt: str) -> None:
    s = res["summary"]
    print(f"读回格式：{fmt}\n")
    print("| id | 匹配到 | 位置误差 m | 高度差 m | 尺寸比(max) | 朝向差° | 朝向差°(mod180) | 层(意图→读回) | ΔE | 位置 | 尺寸 | 朝向 | 层 | 颜色 |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | :-: | ---: | :-: | :-: | :-: | :-: | :-: |")
    for r in res["rows"]:
        lvl = "-" if r.get("level_intent") is None else f"{r['level_intent']}→{r['level_readback']}"
        print(f"| {r['id']} | {r['matched']} | {r['pos_err_m']} | {r['dy_m']} | "
              f"{'-' if r['size_ratio'] is None else r['size_ratio']} | "
              f"{'-' if r['rot_err'] is None else r['rot_err']} | {'-' if r['rot_err_180'] is None else r['rot_err_180']} | "
              f"{lvl} | {'-' if r.get('delta_e') is None else r['delta_e']} | "
              f"{tick(r['pos_ok'])} | {tick(r['size_ok'])} | {tick(r['rot_ok'])} | {tick(r.get('level_ok'))} | {tick(r.get('color_ok'))} |")
    print()
    print(f"意图对象 {s['intent_objects']}，匹配 {s['matched']}，缺漏 {len(s['missing'])}，多余 {len(s['extra'])}")
    print(f"位置误差：均值 {s['pos_err_mean_m']} m，中位数 {s['pos_err_median_m']} m，< {POS_T} m 的比例 {s['pos_ok_rate_pct']}%")
    print(f"尺寸比在 {SIZE_LO}–{SIZE_HI} 内的比例 {s['size_ok_rate_pct']}%；朝向差 < {ROT_T}° 的比例 {s['rot_ok_rate_pct']}%（均值 {s['rot_err_mean_deg']}°）")
    def pct(v):
        return "-（不计分）" if v is None else f"{v}%"

    de_mean = s.get("delta_e_mean")
    print(f"台地层一致的比例 {pct(s.get('level_ok_rate_pct'))}；颜色 ΔE ≤ {DELTA_E_T:g} 的比例 {pct(s.get('color_ok_rate_pct'))}"
          + ("" if de_mean is None else f"（ΔE 均值 {de_mean}）"))
    vis, con = s.get("visible_from_spawn") or {}, s.get("trail_connected") or {}

    def why(b):
        return f"（被 {b} 挡）" if b else ""

    print(f"出生点看见地标：意图 {tick(vis.get('intent'))}{why(vis.get('blocked_by_intent'))}，读回 {tick(vis.get('readback'))}{why(vis.get('blocked_by'))}")
    print(f"主路连通（出生点 → 地标门前 ≤ {DOOR_R:g} m，坡度 ≤ {MAX_SLOPE} 或沿路）：意图 {tick(con.get('intent'))}，读回 {tick(con.get('readback'))}")
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
    rb_raw = load(args.readback)
    rb, fmt = readback_objects(rb_raw)
    unscored = set() if args.include_areas else unscored_ids(sid)
    if args.include_areas:
        rb.update(merge_path_readbacks(rb, [p["id"] for p in sid.get("paths", [])]))
        unscored = {norm(f["id"]) for f in sid.get("terrain", {}).get("features", [])}
    mapping = load(args.map) if args.map else {}
    mapping = {k: v for k, v in mapping.items() if not k.startswith("_")}
    res = compare(intent, rb, mapping, args.auto_map, unscored, sid=sid, rb_raw=rb_raw)
    if args.out:  # 先落盘，再打印：控制台编码问题不该丢结果
        with args.out.open("w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
    print_report(res, fmt)
    if args.out:
        print(f"\n结果 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
