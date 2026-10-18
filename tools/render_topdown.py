#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_topdown.py — 从 SID（Scene Intent Document）渲染俯视图 / 等轴测图

用法:
  python tools/render_topdown.py spec/examples/village-square.sid.json \
      --out-dir experiments/week0-ab/B-sid --iso --emit-sid

输出:
  <out-dir>/views/top.png      俯视正交图：北朝上、网格、比例尺、id+label+尺寸、朝向箭头
  <out-dir>/views/iso.png      等轴测示意图（--iso）
  <out-dir>/scene.sid.json     带 views 字段的 SID 副本（--emit-sid）

约定（与 spec/sid.schema.json 一致）：单位米，+Y 上，右手系，北 = −Z，
position 为底面中心，rotation_y 0 = 朝北，俯视逆时针为正。
依赖：matplotlib, numpy（见 tools/requirements.txt）
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager, patches  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

CJK_FONTS = [
    "Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC",
    "Source Han Sans SC", "WenQuanYi Micro Hei",
]

DEFAULT_PALETTE = {
    "ground": "#B8A98A", "stone": "#A0A0A0", "wall": "#D9C9A3", "roof": "#7A4A33",
    "foliage": "#5E7B45", "accent": "#C0503A", "water": "#6F9BC2", "sky": "#DDE6F0",
}
# volumes.kind → 默认取色角色
KIND_ROLE = {
    "building": "wall", "wall": "roof", "platform": "stone", "rock": "stone", "prop": "stone",
    "water": "water", "cover": "roof", "blocker": "stone", "placeholder": "stone",
}
REGION_FALLBACK = {
    "gathering": "stone", "forest": "foliage", "farmland": "ground", "water": "water",
    "grass": "foliage", "sand": "ground", "danger": "accent", "encounter": "accent",
    "safe": "stone", "other": "ground",
}
MARKER_STYLE = {
    "player_spawn": ("^", "#1F6FEB"), "objective": ("P", "#D4A017"),
    "enemy_spawn": ("X", "#C8362B"), "light": ("*", "#F2B134"), "camera": ("s", "#555555"),
    "poi": ("D", "#7B4DB8"), "prop": ("o", "#444444"), "trigger": ("h", "#2A9D8F"),
    "other": ("o", "#444444"),
}


# ---------------------------------------------------------------- helpers
def setup_fonts() -> str | None:
    import logging
    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)  # 中文字体缺粗体时的噪音
    available = {f.name for f in font_manager.fontManager.ttflist}
    chosen = [f for f in CJK_FONTS if f in available]
    plt.rcParams["font.family"] = chosen + ["DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    return chosen[0] if chosen else None


def load_sid(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def palette_map(sid: dict) -> dict:
    pal = dict(DEFAULT_PALETTE)
    for p in sid.get("style", {}).get("palette", []):
        pal[p["role"]] = p["hex"]
    return pal


def color_for_volume(v: dict, pal: dict) -> str:
    role = v.get("color_role") or KIND_ROLE.get(v.get("kind", ""), "stone")
    return pal.get(role, pal["stone"])


def color_for_surface(surface: str | None, kind: str, pal: dict) -> str:
    if surface and surface in pal:
        return pal[surface]
    return pal.get(REGION_FALLBACK.get(kind, "ground"), pal["ground"])


def auto_bounds(sid: dict) -> dict:
    xs, ys, zs = [], [0.0], []
    for v in sid.get("volumes", []):
        x, y, z = v["position"]
        w, h, d = v["size"]
        r = math.hypot(w, d) / 2
        xs += [x - r, x + r]
        zs += [z - r, z + r]
        ys.append(y + h)
    for m in sid.get("markers", []):
        x, y, z = m["position"]
        xs.append(x)
        zs.append(z)
    for r in sid.get("regions", []):
        for x, z in r["polygon"]:
            xs.append(x)
            zs.append(z)
    for p in sid.get("paths", []):
        for x, z in p["points"]:
            xs.append(x)
            zs.append(z)
    for f in sid.get("terrain", {}).get("features", []):
        x, _, z = f["center"]
        xs += [x - f["radius"], x + f["radius"]]
        zs += [z - f["radius"], z + f["radius"]]
        ys.append(f["height"])
    if not xs:
        xs, zs = [-20, 20], [-20, 20]
    m = 5.0
    return {"min": [min(xs) - m, 0.0, min(zs) - m], "max": [max(xs) + m, max(ys) + m, max(zs) + m]}


def rot_xz(lx: float, lz: float, deg: float) -> tuple[float, float]:
    """绕 +Y 旋转（右手系）：deg 为正时俯视逆时针。"""
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return (lx * c + lz * s, -lx * s + lz * c)


def box_corners(pos, size, deg) -> list[tuple[float, float]]:
    cx, _, cz = pos
    w, _, d = size
    out = []
    for lx, lz in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        x, z = rot_xz(lx, lz, deg)
        out.append((cx + x, cz + z))
    return out


def facing(deg: float) -> tuple[float, float]:
    """rotation_y → 朝向单位向量 (x, z)。0 = 朝北(−Z)。"""
    t = math.radians(deg)
    return (-math.sin(t), -math.cos(t))


def centroid(pts) -> tuple[float, float]:
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return (sum(xs) / len(xs), sum(zs) / len(zs))


def fmt(v: float) -> str:
    return f"{v:g}"


# ---------------------------------------------------------------- top-down
def render_topdown(sid: dict, out_png: Path, dpi: int = 150, px_width: int = 2400) -> float:
    """渲染俯视图，返回 scale_m_per_px。"""
    pal = palette_map(sid)
    b = sid.get("bounds") or auto_bounds(sid)
    xmin, _, zmin = b["min"]
    xmax, ymax_b, zmax = b["max"]
    W, H = xmax - xmin, zmax - zmin

    # 轴占图宽 0.68、图高 0.86，保证等比且 px_per_m 可精确计算
    ax_w_frac, ax_h_frac = 0.68, 0.86
    fig_w_in = px_width / dpi
    fig_h_in = (ax_w_frac * fig_w_in * H / W) / ax_h_frac
    fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=dpi)
    ax = fig.add_axes([0.07, 0.07, ax_w_frac, ax_h_frac])
    px_per_m = ax_w_frac * fig_w_in * dpi / W
    pt_per_m = px_per_m * 72.0 / dpi

    ax.set_xlim(xmin, xmax)
    ax.set_ylim(-zmax, -zmin)  # 图上 y = −z，北朝上
    ax.set_aspect("equal")
    ax.set_facecolor("#F4F1EA")

    # 网格
    for step, col, lw in ((5, "#E2DED4", 0.5), (10, "#C9C3B6", 0.8)):
        for x in np.arange(math.floor(xmin / step) * step, xmax + step, step):
            ax.axvline(x, color=col, lw=lw, zorder=0)
        for z in np.arange(math.floor(zmin / step) * step, zmax + step, step):
            ax.axhline(-z, color=col, lw=lw, zorder=0)
    xt = np.arange(math.ceil(xmin / 10) * 10, xmax + 0.01, 10)
    zt = np.arange(math.ceil(zmin / 10) * 10, zmax + 0.01, 10)
    ax.set_xticks(xt)
    ax.set_xticklabels([fmt(v) for v in xt], fontsize=7)
    ax.set_yticks([-z for z in zt])
    ax.set_yticklabels([fmt(z) for z in zt], fontsize=7)
    ax.set_xlabel("x (m) → 东", fontsize=8)
    ax.set_ylabel("z (m)   北朝上 = −Z 方向", fontsize=8)
    ax.add_patch(patches.Rectangle((xmin, -zmax), W, H, fill=False, ec="#444444", lw=1.2, ls="-", zorder=1))

    handles: list = []

    # 地形特征
    for f in sid.get("terrain", {}).get("features", []):
        cx, _, cz = f["center"]
        R = f["radius"]
        for k in (1.0, 2 / 3, 1 / 3):
            ax.add_patch(patches.Circle((cx, -cz), R * k, fill=False, ec="#7F8F5F", ls="--", lw=0.9, zorder=2))
        ax.add_patch(patches.Circle((cx, -cz), R, fc="#9DAA7A", ec="none", alpha=0.18, zorder=1.5))
        ax.text(cx, -cz, f"{f['id']}\n{f.get('label', '')}\n{f['kind']} r={fmt(R)} h={fmt(f['height'])} m",
                ha="center", va="center", fontsize=6.5, color="#4F5F2F", zorder=3)
    if sid.get("terrain", {}).get("features"):
        handles.append(Line2D([0], [0], color="#7F8F5F", ls="--", label="terrain feature（等高线示意）"))

    # 区域
    seen_kind = set()
    for r in sid.get("regions", []):
        col = color_for_surface(r.get("surface"), r.get("kind", "other"), pal)
        pts = [(x, -z) for x, z in r["polygon"]]
        ax.add_patch(patches.Polygon(pts, closed=True, fc=col, ec="#333333", alpha=0.45, lw=0.8, ls=(0, (4, 3)), zorder=2))
        # 标签放在多边形包围盒的左上角内侧，避免被质心处的体块盖住
        rxs = [p[0] for p in r["polygon"]]
        rzs = [p[1] for p in r["polygon"]]
        lx = min(rxs) + 0.06 * (max(rxs) - min(rxs)) + 0.5
        lz = min(rzs) + 0.06 * (max(rzs) - min(rzs)) + 0.5
        ax.text(lx, -lz, f"{r['id']}\n{r.get('label', '')}\n[{r['kind']}]", ha="left", va="top",
                fontsize=6.5, color="#222222", zorder=3,
                bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.6))
        if r["kind"] not in seen_kind:
            seen_kind.add(r["kind"])
            handles.append(patches.Patch(fc=col, ec="#333333", alpha=0.45, label=f"region: {r['kind']}"))

    # 路径
    path_kinds_seen = set()
    for p in sid.get("paths", []):
        col = color_for_surface(p.get("surface"), "other", pal)
        xs = [q[0] for q in p["points"]]
        ys = [-q[1] for q in p["points"]]
        ax.plot(xs, ys, color=col, lw=max(p["width"] * pt_per_m, 1.0), alpha=0.85,
                solid_capstyle="round", solid_joinstyle="round", zorder=2.5)
        ax.plot(xs, ys, color="#5A4E3A", lw=0.6, ls=":", zorder=2.6)
        mx, my = (xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2
        ax.text(mx + 1.0, my, f"{p['id']} · {p.get('label', '')} (w={fmt(p['width'])} m)", fontsize=6.5,
                color="#3A2F1F", va="center", zorder=3,
                bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.7))
        if p["kind"] not in path_kinds_seen:
            path_kinds_seen.add(p["kind"])
            handles.append(Line2D([0], [0], color=col, lw=4, label=f"path: {p['kind']}"))

    # 体块
    vol_kinds = {}
    for v in sid.get("volumes", []):
        col = color_for_volume(v, pal)
        cx, _, cz = v["position"]
        w, h, d = v["size"]
        rot = v.get("rotation_y", 0.0)
        round_cyl = v.get("shape") == "cylinder" and abs(w - d) < 1e-6
        if v.get("shape") == "cylinder":
            # 椭圆柱也按 rotation_y 转（与编辑器 / glb / 引擎一致）；图上 y = −z，所以角度取负
            ax.add_patch(patches.Ellipse((cx, -cz), w, d, angle=-rot, fc=col, ec="#111111", lw=1.0, alpha=0.95, zorder=4))
            arrow_len = min(w, d) / 2 * 0.9
        else:
            pts = [(x, -z) for x, z in box_corners(v["position"], v["size"], rot)]
            ax.add_patch(patches.Polygon(pts, closed=True, fc=col, ec="#111111", lw=1.0, alpha=0.95, zorder=4))
            arrow_len = d / 2 * 0.9
        if not round_cyl:  # 正圆柱（w == d）没有朝向意义，不画箭头
            fx, fz = facing(rot)
            ax.annotate("", xy=(cx + fx * arrow_len, -(cz + fz * arrow_len)), xytext=(cx, -cz),
                        arrowprops=dict(arrowstyle="-|>", color="#111111", lw=1.0), zorder=5)
        ax.text(cx, -cz, f"{v['id']}\n{v.get('label', '')}\n{fmt(w)}×{fmt(h)}×{fmt(d)} m",
                ha="center", va="center", fontsize=6.3, color="#111111", zorder=6,
                bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.75))
        vol_kinds.setdefault(v["kind"], col)
    for k, col in vol_kinds.items():
        handles.append(patches.Patch(fc=col, ec="#111111", label=f"volume: {k}"))

    # 标记
    mk_seen = set()
    for m in sid.get("markers", []):
        mk, col = MARKER_STYLE.get(m["kind"], MARKER_STYLE["other"])
        x, _, z = m["position"]
        if m["kind"] == "player_spawn":
            ax.plot([x], [-z], marker=(3, 0, m.get("rotation_y", 0.0)), ms=16, color=col, mec="white", mew=1.2, zorder=7)
            fx, fz = facing(m.get("rotation_y", 0.0))
            ax.annotate("", xy=(x + fx * 4, -(z + fz * 4)), xytext=(x, -z),
                        arrowprops=dict(arrowstyle="-|>", color=col, lw=1.4), zorder=7)
        else:
            ax.plot([x], [-z], marker=mk, ms=10, color=col, mec="white", mew=1.0, zorder=7)
        ax.text(x + 1.2, -z + 1.2, f"{m['id']}\n{m.get('label', '')}", fontsize=6.3, color=col, zorder=8,
                bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.75))
        if m["kind"] not in mk_seen:
            mk_seen.add(m["kind"])
            handles.append(Line2D([0], [0], marker=mk, color="none", mec="white", mfc=col, ms=9, label=f"marker: {m['kind']}"))

    # 指北针 + 比例尺
    ax.annotate("N", xy=(xmax - 4, -zmin - 3), xytext=(xmax - 4, -zmin - 10),
                ha="center", va="bottom", fontsize=11, fontweight="bold",
                arrowprops=dict(arrowstyle="-|>", color="#222222", lw=1.6), zorder=9)
    bar_x0, bar_y = xmin + 3, -zmax + 3
    ax.plot([bar_x0, bar_x0 + 10], [bar_y, bar_y], color="#111111", lw=3, solid_capstyle="butt", zorder=9)
    ax.text(bar_x0 + 5, bar_y + 1.0, "10 m", ha="center", va="bottom", fontsize=8, zorder=9)

    # 图例与说明
    meta = sid.get("meta", {})
    fig.suptitle(f"{meta.get('name', 'scene')} — 俯视图 (top_down)", x=0.07, ha="left", fontsize=13, fontweight="bold")
    fig.text(0.07, 0.955,
             "单位 m · 北朝上(−Z) · position = 底面中心 · 尺寸 = 宽×高×深 · 箭头 = 朝向(rotation_y, 0=北, 逆时针为正)",
             fontsize=8, color="#444444")
    if handles:
        ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.02, 1.0), fontsize=7.5, frameon=False, title="图例", title_fontsize=8)
    pal_items = sid.get("style", {}).get("palette", [])
    if pal_items:
        y0 = 0.07 + ax_h_frac * 0.42
        fig.text(0.77, y0 + 0.02, "调色板 (style.palette)", fontsize=8, fontweight="bold")
        for i, p in enumerate(pal_items[:10]):
            yy = y0 - i * 0.022
            fig.add_artist(patches.Rectangle((0.77, yy - 0.006), 0.018, 0.016, transform=fig.transFigure, fc=p["hex"], ec="#333333", lw=0.5))
            fig.text(0.795, yy, f"{p['role']}  {p['hex']}  {p.get('note', '')}", fontsize=7, va="center")
    intent = sid.get("intent", {})
    if intent.get("summary"):
        import textwrap
        wrapped = "\n".join(textwrap.wrap(intent["summary"], 26))
        fig.text(0.77, 0.07 + ax_h_frac * 0.42 - 0.26, "intent.summary\n" + wrapped, fontsize=7, va="top", color="#333333")

    scale_m_per_px = 1.0 / px_per_m
    fig.text(0.07, 0.015, f"比例 {scale_m_per_px:.4f} m/px（{px_per_m:.1f} px/m）· 由 tools/render_topdown.py 生成", fontsize=7, color="#666666")

    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=dpi, facecolor="white")
    plt.close(fig)
    return scale_m_per_px


# ---------------------------------------------------------------- isometric
def _shade(hexcol: str, k: float) -> tuple:
    r, g, b = (int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return (min(1, r * k), min(1, g * k), min(1, b * k))


def render_iso(sid: dict, out_png: Path, dpi: int = 150) -> None:
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: WPS433

    pal = palette_map(sid)
    b = sid.get("bounds") or auto_bounds(sid)
    xmin, _, zmin = b["min"]
    xmax, ymax, zmax = b["max"]
    W, H = xmax - xmin, zmax - zmin
    zspan = max(ymax, 10.0)

    fig = plt.figure(figsize=(15, 10), dpi=dpi)
    ax = fig.add_subplot(111, projection="3d")
    ax.set_proj_type("ortho")  # 正交投影，名副其实的"等轴测"示意（编辑器导出的是透视鸟瞰，kind=perspective）
    # 绘图坐标：X = x（东）, Y = −z（北）, Z = y（上）
    P = lambda x, y, z: (x, -z, y)  # noqa: E731
    # mplot3d 不做跨 artist 的深度排序：关掉自动 zorder，自己按"离相机远→近"排
    ELEV, AZIM = 32, -120  # 相机在西南上空，看向东北
    ax.computed_zorder = False
    cam = (math.cos(math.radians(AZIM)), math.sin(math.radians(AZIM)))

    def depth(x, z):  # 越大越靠近相机
        return x * cam[0] + (-z) * cam[1]

    # 地面（最底层）
    ground = [P(xmin, 0, zmin), P(xmax, 0, zmin), P(xmax, 0, zmax), P(xmin, 0, zmax)]
    ax.add_collection3d(Poly3DCollection([ground], facecolors="#EDE8DC", edgecolors="#999999", linewidths=0.6, zorder=0))

    # 区域（贴地）
    for r in sid.get("regions", []):
        col = color_for_surface(r.get("surface"), r.get("kind", "other"), pal)
        poly = [P(x, 0.03, z) for x, z in r["polygon"]]
        ax.add_collection3d(Poly3DCollection([poly], facecolors=col, edgecolors="#444444", linewidths=0.5, alpha=0.6, zorder=1))
        cx, cz = centroid(r["polygon"])
        ax.text(cx, -cz, 0.2, r["id"], ha="center", fontsize=7, color="#333333", zorder=200)

    # 路径（贴地）
    for p in sid.get("paths", []):
        col = color_for_surface(p.get("surface"), "other", pal)
        xs = [q[0] for q in p["points"]]
        ys = [-q[1] for q in p["points"]]
        ax.plot(xs, ys, [0.06] * len(xs), color=col, lw=max(p["width"] * 1.2, 2), alpha=0.95, solid_capstyle="round", zorder=2)

    # 立体物：地形特征 + 体块，按深度排序后逐个加
    solids = []
    for f in sid.get("terrain", {}).get("features", []):
        cx, _, cz = f["center"]
        solids.append((depth(cx, cz) - f["radius"], "feature", f))
    for v in sid.get("volumes", []):
        cx, _, cz = v["position"]
        solids.append((depth(cx, cz), "volume", v))
    solids.sort(key=lambda t: t[0])
    for rank, (_, kind, obj) in enumerate(solids):
        zo = 10 + rank
        if kind == "feature":
            cx, _, cz = obj["center"]
            R, h = obj["radius"], obj["height"]
            g = np.linspace(-R, R, 41)
            X, Zc = np.meshgrid(cx + g, cz + g)
            r2 = ((X - cx) ** 2 + (Zc - cz) ** 2) / (R ** 2)
            Hs = h * np.clip(1 - r2, 0, None)
            Hs[r2 > 1.0] = np.nan  # 圆外不画，避免出现一块方形"底座"
            ax.plot_surface(X, -Zc, Hs, color="#9DAA7A", alpha=0.75, linewidth=0, antialiased=True, shade=True, zorder=zo)
            ax.text(cx, -cz, h + 1.5, obj["id"], ha="center", fontsize=7, color="#4F5F2F", zorder=200)
            continue
        v = obj
        col = color_for_volume(v, pal)
        cx, py, cz = v["position"]
        w, h, d = v["size"]
        rot = v.get("rotation_y", 0.0)
        if v.get("shape") == "cylinder":
            n = 24
            ring = []
            for a in np.linspace(0, 2 * math.pi, n, endpoint=False):
                rx, rz = rot_xz((w / 2) * math.cos(a), (d / 2) * math.sin(a), rot)
                ring.append((cx + rx, cz + rz))
        else:
            ring = box_corners(v["position"], v["size"], rot)
        bottom = [P(x, py, z) for x, z in ring]
        top = [P(x, py + h, z) for x, z in ring]
        faces = [bottom, top]
        cols = [_shade(col, 0.7), _shade(col, 1.05)]
        n = len(ring)
        for i in range(n):
            j = (i + 1) % n
            faces.append([bottom[i], bottom[j], top[j], top[i]])
            cols.append(_shade(col, 0.82 + 0.12 * ((i % 2))))
        ax.add_collection3d(Poly3DCollection(faces, facecolors=cols, edgecolors="#222222", linewidths=0.35, alpha=1.0, zorder=zo))
        ax.text(cx, -cz, py + h + 0.8, v["id"], ha="center", fontsize=7, color="#111111", zorder=200)

    # 标记（最上层）
    for m in sid.get("markers", []):
        mk, col = MARKER_STYLE.get(m["kind"], MARKER_STYLE["other"])
        x, y, z = m["position"]
        ax.scatter([x], [-z], [y + 0.15], marker=mk, s=70, color=col, edgecolors="white", linewidths=0.8, depthshade=False, zorder=150)
        ax.text(x, -z, y + 1.2, m["id"], ha="center", fontsize=7, color=col, zorder=200)
        if m["kind"] == "player_spawn":
            ph = float(sid.get("meta", {}).get("player_height", 1.8))
            ax.plot([x, x], [-z, -z], [0, ph], color=col, lw=2.5, zorder=150)

    ax.set_xlim(xmin, xmax)
    ax.set_ylim(-zmax, -zmin)
    ax.set_zlim(0, zspan)
    ax.set_box_aspect((W, H, zspan))
    ax.view_init(elev=ELEV, azim=AZIM)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.fill = False
        axis.pane.set_edgecolor("#DDDDDD")
    ax.grid(False)
    ax.set_xlabel("x 东 →", fontsize=8)
    ax.set_ylabel("北 ↑（−z）", fontsize=8)
    ax.set_zlabel("y 高度", fontsize=8)
    ax.tick_params(labelsize=6)
    meta = sid.get("meta", {})
    fig.suptitle(f"{meta.get('name', 'scene')} — 等轴测示意 (isometric)   单位 m · 从西南上空看向东北", fontsize=12, fontweight="bold")
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=dpi, facecolor="white", bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------- emit
def emit_sid(sid: dict, out_dir: Path, scale_m_per_px: float, iso: bool) -> Path:
    s = copy.deepcopy(sid)
    views = [v for v in s.get("views", []) if v.get("kind") not in ("top_down", "isometric")]
    views.append({
        "kind": "top_down", "image": "views/top.png", "scale_m_per_px": round(scale_m_per_px, 5),
        "north_up": True, "labels_drawn": True,
    })
    if iso:
        views.append({"kind": "isometric", "image": "views/iso.png", "labels_drawn": True})
    s["views"] = views
    out = out_dir / "scene.sid.json"
    with out.open("w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return out


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):  # Windows 下重定向 / 管道时默认是 GBK，中文会崩
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="从 SID 渲染俯视图 / 等轴测图")
    ap.add_argument("sid", type=Path, help="SID 文件路径")
    ap.add_argument("--out-dir", type=Path, default=None, help="输出目录（默认 = SID 所在目录）")
    ap.add_argument("--iso", action="store_true", help="同时输出等轴测图 views/iso.png")
    ap.add_argument("--emit-sid", action="store_true", help="在输出目录写入带 views 字段的 scene.sid.json")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--width", type=int, default=2400, help="俯视图像素宽度")
    args = ap.parse_args(argv)

    font = setup_fonts()
    if not font:
        print("警告：未找到中文字体，中文标签可能显示为方块", file=sys.stderr)
    sid = load_sid(args.sid)
    out_dir = args.out_dir or args.sid.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    top = out_dir / "views" / "top.png"
    scale = render_topdown(sid, top, dpi=args.dpi, px_width=args.width)
    print(f"俯视图 → {top}  ({scale:.4f} m/px)")
    if args.iso:
        iso = out_dir / "views" / "iso.png"
        render_iso(sid, iso, dpi=args.dpi)
        print(f"等轴测 → {iso}")
    if args.emit_sid:
        p = emit_sid(sid, out_dir, scale, args.iso)
        print(f"SID 副本 → {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
