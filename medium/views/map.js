// views/map.js — 俯视语义图：从「已解析的 SID + 地形 T」画出来，全部数据驱动，没有一处写死的几何。
// 坐标：SVG viewBox 直接用米（x 向右 = 东，y 向下 = +z 南），北在上。
import { pointInPolygon, polygonCentroid, clamp } from "../engine/terrain.js";

const SVGNS = "http://www.w3.org/2000/svg";
export function svgel(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export const REGION_KINDS = {
  other: { label: "民居", color: null },
  gathering: { label: "聚集地", color: "#9a9890" },
  plaza: { label: "广场", color: "#9a9890" },
  forest: { label: "林子", color: "#4f6b3a" },
  farmland: { label: "农田", color: "#c8a951" },
  terrace: { label: "梯田", color: "#8a7a3a" },
};
export const LANDMARK_LABEL = { temple: "寺庙", pagoda: "塔楼", tree: "大树", wheel: "水车", gate: "寨门" };
export const PLACEMENT_LABEL = { top: "顶层中央", ridge_end: "山脊尽头", cliff_edge: "临崖", plaza: "中层广场" };
export const SPAWN_LABEL = { valley_bottom: "入口侧山脚", side_slope: "侧坡半山", summit: "山顶俯视", S: "南边山脚", E: "东侧", W: "西侧" };

const fmt1 = (v) => Math.round(v * 10) / 10;
const pts = (arr) => arr.map((p) => `${fmt1(p[0])},${fmt1(p[1])}`).join(" ");

/** 层色：越高越绿 */
export function levelColor(level, maxLevel) {
  const t = maxLevel > 0 ? level / maxLevel : 0;
  const a = [233, 226, 207], b = [185, 199, 163];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

export function paletteOf(sid) {
  const m = {};
  for (const p of (sid.style && sid.style.palette) || []) m[p.role] = p.hex;
  return Object.assign({ roof: "#4A4A4A", wall: "#D9C9A3", stone: "#9A9890", foliage: "#4F6B3A", mist: "#DDE6F0" }, m);
}

export function landmarkOf(sid) { return (sid.volumes || []).find((v) => v.importance === "landmark") || null; }
export function spawnOf(sid) { return (sid.markers || []).find((m) => m.kind === "player_spawn") || null; }
export function mainTrailOf(sid) { return (sid.paths || []).find((p) => p.id === "main_trail") || (sid.paths || []).find((p) => p.kind === "trail") || null; }
export function streamOf(sid) { return (sid.paths || []).find((p) => p.kind === "river") || null; }

/** 地标图形（俯视符号） */
function landmarkGlyph(kind, locked) {
  const g = svgel("g", { class: "landmark", style: "cursor:pointer" });
  const fill = "#b8452b", stroke = "#4a1a10";
  if (kind === "temple") g.append(svgel("path", { d: "M-4.5 1.5 L0 -4.5 L4.5 1.5 Z M-3.5 1.5 L3.5 1.5 L3.5 5 L-3.5 5 Z", fill, stroke, "stroke-width": 0.35 }));
  else if (kind === "pagoda") g.append(svgel("rect", { x: -3, y: -3, width: 6, height: 6, fill, stroke, "stroke-width": 0.35 }), svgel("rect", { x: -1.6, y: -1.6, width: 3.2, height: 3.2, fill: "#fff", "fill-opacity": 0.6 }));
  else if (kind === "wheel") { g.append(svgel("circle", { r: 4, fill: "none", stroke: "#6b3f2a", "stroke-width": 0.9 })); for (let a = 0; a < 6; a++) g.append(svgel("line", { x1: 0, y1: 0, x2: 4 * Math.cos((a * Math.PI) / 3), y2: 4 * Math.sin((a * Math.PI) / 3), stroke: "#6b3f2a", "stroke-width": 0.5 })); }
  else if (kind === "gate") g.append(svgel("path", { d: "M-5 3 L-5 -2 L-3 -4 L3 -4 L5 -2 L5 3 M-2 3 L-2 -1 L2 -1 L2 3", fill: "none", stroke, "stroke-width": 0.9 }));
  else g.append(svgel("circle", { r: 4.2, fill: "#3f6b2a" }), svgel("rect", { x: -0.7, y: 3, width: 1.4, height: 3, fill: "#5a3a1a" }));
  if (locked) g.append(svgel("text", { x: 5, y: -3.5, "font-size": 3.2 }, "🔒"));
  return g;
}

/**
 * 画俯视语义图。
 * @param {object} ctx { sid, T, facts?, checks?, locked?: Set, diffs?: [{id, from:[x,z], to:[x,z], err_m}], tool? }
 * @param {object} opts { small: 缩略图模式（不画文字 / 不绑交互） }
 */
export function renderMap(ctx, opts = {}) {
  const { sid, T } = ctx;
  const small = !!opts.small;
  const b = sid.bounds;
  const [xmin, zmin] = [b.min[0], b.min[2]], W = b.max[0] - b.min[0], H = b.max[2] - b.min[2];
  const s = svgel("svg", { viewBox: `${xmin} ${zmin} ${W} ${H}`, class: "map", "font-family": "inherit" });
  s.append(svgel("rect", { x: xmin, y: zmin, width: W, height: H, fill: "#e9e2cf" }));

  // 台地：按层着色（低→高）
  const terraces = (T && T.terraces) || [];
  const maxLevel = terraces.reduce((m, t) => Math.max(m, t.level), 0);
  for (const t of terraces) s.append(svgel("polygon", { points: pts(t.polygon), fill: levelColor(t.level, maxLevel), stroke: "#8c9a6b", "stroke-width": 0.45, "stroke-dasharray": "1.4 1", "data-terrace": t.id }));
  // 等高线（层间）
  if (T) for (const c of T.contours()) { let d = ""; for (const [a, q] of c.segments) d += `M${fmt1(a[0])} ${fmt1(a[1])}L${fmt1(q[0])} ${fmt1(q[1])}`; if (d) s.append(svgel("path", { d, fill: "none", stroke: "#8c9a6b", "stroke-width": 0.3, opacity: 0.75 })); }
  // 层号
  if (!small) for (const t of terraces) { const c = t.centroid; const xs = t.polygon.map((p) => p[0]); s.append(svgel("text", { x: Math.min(...xs) + 1.5, y: c[1] + 1, "font-size": 2.4, fill: "#6b7a4b" }, `${t.level + 1} 层`)); }

  // 区域（kind ≠ other 才有填色），标签可翻
  const regions = (sid.regions || []).filter((r) => r.polygon && r.polygon.length >= 3);
  for (const r of regions) {
    const kd = REGION_KINDS[r.kind] || REGION_KINDS.other;
    const c = polygonCentroid(r.polygon);
    if (kd.color) {
      s.append(svgel("polygon", { points: pts(r.polygon), fill: kd.color, "fill-opacity": r.kind === "forest" ? 0.18 : 0.3, stroke: kd.color, "stroke-width": 0.5, "stroke-dasharray": "1.5 1", "data-region": r.id }));
      if (r.kind === "terrace" || r.kind === "farmland") for (let k = -4; k <= 4; k++) { const y = c[1] + k * 2.4; s.append(svgel("line", { x1: c[0] - 8, x2: c[0] + 8, y1: y, y2: y + (r.kind === "terrace" ? 1 : 0), stroke: kd.color, "stroke-width": 0.35, opacity: 0.7 })); }
    } else if (r.user_set) {
      s.append(svgel("polygon", { points: pts(r.polygon), fill: "none", stroke: "#b8452b", "stroke-width": 0.5, "stroke-dasharray": "1.5 1", "data-region": r.id }));
    }
    if (!small && (kd.color || r.user_set || (r.density != null && Math.abs(r.density - 1) > 0.25))) {
      const dens = r.density == null ? "" : r.density === 0 ? "" : r.density > 1.25 ? " · 更密" : r.density < 0.75 ? " · 更稀" : "";
      s.append(svgel("text", { x: c[0], y: c[1] - 2, "font-size": 2.5, "text-anchor": "middle", fill: kd.color || "#b8452b", "data-region-label": r.id, style: "cursor:pointer" }, `${kd.label}${dens} ▾`));
    }
  }

  // 溪
  const stream = streamOf(sid);
  if (stream && stream.points && stream.points.length > 1) s.append(svgel("polyline", { points: pts(stream.points), fill: "none", stroke: "#6f9bc2", "stroke-width": Math.max(1.5, stream.width || 3), "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.9 }));

  // 其它路（用户手画的支路等）
  for (const p of sid.paths || []) if (p.kind !== "river" && p.id !== "main_trail" && p.points && p.points.length > 1) s.append(svgel("polyline", { points: pts(p.points), fill: "none", stroke: "#8b7d5b", "stroke-width": 1.4, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": "2 1", opacity: 0.9, "data-path": p.id }));

  // 主路
  const trail = mainTrailOf(sid);
  if (trail && trail.points && trail.points.length > 1) {
    s.append(svgel("polyline", { points: pts(trail.points), fill: "none", stroke: "#8b7d5b", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.95, "data-path": "main_trail" }));
    s.append(svgel("polyline", { points: pts(trail.points), fill: "none", stroke: "#fff", "stroke-width": 0.5, "stroke-dasharray": "0.8 1.2", opacity: 0.9, "pointer-events": "none" }));
  }

  // 树（kind prop / 圆柱）与房子（kind building，非地标）
  const pal = paletteOf(sid);
  let houseCount = 0;
  for (const v of sid.volumes || []) {
    if (!v.position || !v.size) continue;
    if (v.importance === "landmark") continue;
    const [x, , z] = v.position;
    if (v.kind === "prop" && v.shape === "cylinder") { s.append(svgel("circle", { cx: x, cy: z, r: Math.max(1.2, v.size[0] / 2 * 0.6), fill: pal.foliage, opacity: 0.85, "data-tree": v.id })); continue; }
    if (v.kind !== "building") continue;
    houseCount++;
    const w = v.size[0], d = v.size[2];
    const g = svgel("g", { transform: `translate(${fmt1(x)} ${fmt1(z)}) rotate(${fmt1(-(v.rotation_y || 0))})`, "data-house": v.id, style: "cursor:pointer" });
    g.append(svgel("rect", { x: -w / 2, y: -d / 2, width: w, height: d, fill: pal.roof, stroke: v.locked ? "#b8452b" : "#222", "stroke-width": v.locked ? 0.5 : 0.25 }));
    g.append(svgel("line", { x1: 0, y1: -d / 2, x2: 0, y2: -d / 2 - 1.2, stroke: "#222", "stroke-width": 0.35 })); // 门的朝向
    s.append(g);
  }

  // 地标
  const lm = landmarkOf(sid);
  if (lm) {
    const g = landmarkGlyph(lm.kind_hint || lm.landmark_kind || "temple", ctx.locked && ctx.locked.has("landmark"));
    g.setAttribute("transform", `translate(${fmt1(lm.position[0])} ${fmt1(lm.position[2])})`);
    g.dataset.landmark = lm.id;
    if (!small) g.append(svgel("text", { y: -6, "font-size": 2.8, "text-anchor": "middle", fill: "#4a1a10" }, `${lm.label || "地标"}（地标）`));
    s.append(g);
  }

  // 出生点与第一眼视锥
  const sp = spawnOf(sid);
  if (sp) {
    const [ex, , ez] = sp.position;
    const th = ((sp.rotation_y || 0) * Math.PI) / 180;
    const fx = -Math.sin(th), fz = -Math.cos(th);
    const L = lm ? Math.hypot(lm.position[0] - ex, lm.position[2] - ez) * 0.8 : 30;
    const ang = Math.atan2(fz, fx);
    for (const da of [-0.3, 0.3]) s.append(svgel("line", { x1: ex, y1: ez, x2: ex + Math.cos(ang + da) * L, y2: ez + Math.sin(ang + da) * L, stroke: "#1f6feb", "stroke-width": 0.4, "stroke-dasharray": "1 1", opacity: 0.8, "pointer-events": "none" }));
    const g = svgel("g", { class: "spawn", transform: `translate(${fmt1(ex)} ${fmt1(ez)}) rotate(${fmt1(-(sp.rotation_y || 0))})`, "data-spawn": sp.id, style: "cursor:pointer" });
    g.append(svgel("path", { d: "M0 -4.5 L3.2 3 L-3.2 3 Z", fill: "#1f6feb", stroke: "#fff", "stroke-width": 0.5 }));
    if (ctx.locked && ctx.locked.has("spawn")) g.append(svgel("text", { x: 4, y: -3, "font-size": 3.2, transform: `rotate(${fmt1(sp.rotation_y || 0)})` }, "🔒"));
    s.append(g);
    if (!small) s.append(svgel("text", { x: clamp(ex, xmin + 14, xmin + W - 14), y: clamp(ez + 7, zmin + 6, zmin + H - 2), "font-size": 2.8, fill: "#1f6feb", "text-anchor": "middle" }, `入口 · 第一眼朝${lm ? lm.label || "地标" : "北"}`));
  }

  // 读回差异（红点：意图位置 → 引擎实际位置）
  for (const d of ctx.diffs || []) {
    if (!d.from) continue;
    if (d.to) s.append(svgel("line", { x1: d.from[0], y1: d.from[1], x2: d.to[0], y2: d.to[1], stroke: "#c0392b", "stroke-width": 0.5, "stroke-dasharray": "1 0.8" }));
    s.append(svgel("circle", { cx: d.from[0], cy: d.from[1], r: 1.6, fill: "#c0392b", stroke: "#fff", "stroke-width": 0.4, "data-diff": d.id, style: "cursor:pointer" }));
    if (d.to) s.append(svgel("circle", { cx: d.to[0], cy: d.to[1], r: 1.2, fill: "none", stroke: "#c0392b", "stroke-width": 0.5 }));
    if (!small) s.append(svgel("text", { x: d.from[0] + 2.2, y: d.from[1] - 1.5, "font-size": 2.3, fill: "#c0392b" }, d.err_m != null ? `${d.id} 偏 ${fmt1(d.err_m)} m` : `${d.id} 缺`));
  }

  if (!small) {
    // 复述标签（可翻替代解释）
    const f = (ctx.facts && ctx.facts.trail) || null;
    if (trail && trail.points && trail.points.length > 1) {
      const mid = trail.points[Math.floor(trail.points.length / 2)];
      const how = trail.user_drawn ? "你画的" : f && f.folds === 0 ? "直上" : f ? `之字 ${f.folds} 折` : "算出来的";
      const climb = f ? ` · 爬升 ${Math.round(f.climb_m)} m` : "";
      s.append(svgel("text", { x: clamp(mid[0] + 3, xmin + 2, xmin + W - 40), y: clamp(mid[1] - 2, zmin + 6, zmin + H - 4), "font-size": 2.6, fill: "#5a4a2a", "data-path-label": 1, style: "cursor:pointer" }, `主路：${how}${climb} ▾`));
    }
    s.append(svgel("text", { x: xmin + W - 3, y: zmin + 4.5, "font-size": 3.2, "text-anchor": "end", fill: "#333" }, "N ↑"));
    const layer = (sid.meta && sid.meta.layer_height_m) || 3;
    const steps = f && f.steps_estimate ? ` · 主路 ${Math.round(f.length_m)} m / 约 ${Math.round(f.steps_estimate)} 级台阶` : "";
    s.append(svgel("text", { x: xmin + 2, y: zmin + H - 2, "font-size": 2.4, fill: "#555" }, `约 ${W} m 见方 · ${terraces.length} 层台地（1 层 ≈ ${layer} m）· ${houseCount} 栋${steps}`));
  }
  return s;
}

/** 屏幕坐标 → 世界坐标 [x, z]（夹在 bounds 内） */
export function svgPoint(svg, ev, sid) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const b = sid.bounds;
  return [clamp(p.x, b.min[0], b.max[0]), clamp(p.y, b.min[2], b.max[2])];
}

/**
 * 绑定手势。handlers:
 *  tool()                                  → 当前工具 select|path|region|pin|erase
 *  onSelect(target: {type, id}, p, ev)     点选房子 / 地标 / 入口 / 区域 / 空地
 *  onFlip(kind: "path"|"region", id, ev)   复述标签翻替代解释
 *  onPath(points)                          画完一笔（世界坐标，未简化）
 *  onRegion(points, ev)                    圈完一块
 *  canPin(kind)                            图钉开始拖前询问（锁住返回 false）
 *  onPinEnd(kind: "landmark"|"spawn", p)   拖完
 *  onErase(target)                         擦除
 *  onDiff(id, ev)                          点红点
 */
export function bindMapGestures(svg, sid, handlers) {
  let drawing = null, live = null, dragging = null;
  const target = (t) => {
    const g = (sel) => t.closest && t.closest(sel);
    let n;
    if ((n = g("[data-house]"))) return { type: "house", id: n.dataset.house };
    if ((n = g("[data-tree]"))) return { type: "tree", id: n.dataset.tree };
    if ((n = g("[data-landmark]"))) return { type: "landmark", id: n.dataset.landmark };
    if ((n = g("[data-spawn]"))) return { type: "spawn", id: n.dataset.spawn };
    if ((n = g("[data-region]"))) return { type: "region", id: n.dataset.region };
    if ((n = g("[data-path]"))) return { type: "path", id: n.dataset.path };
    if ((n = g("[data-terrace]"))) return { type: "terrace", id: n.dataset.terrace };
    return { type: "ground", id: null };
  };
  svg.addEventListener("pointerdown", (ev) => {
    const p = svgPoint(svg, ev, sid);
    const t = ev.target;
    const tool = handlers.tool();
    if (t.dataset && t.dataset.pathLabel) return handlers.onFlip("path", "main_trail", ev);
    if (t.dataset && t.dataset.regionLabel !== undefined) return handlers.onFlip("region", t.dataset.regionLabel, ev);
    if (t.dataset && t.dataset.diff !== undefined) return handlers.onDiff && handlers.onDiff(t.dataset.diff, ev);
    try { svg.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    if (tool === "path" || tool === "region") {
      drawing = { pts: [p], tool };
      live = svgel("polyline", { points: pts([p]), fill: tool === "region" ? "rgba(31,111,235,.12)" : "none", stroke: "#1f6feb", "stroke-width": 1, "stroke-dasharray": "1.5 1", "pointer-events": "none" });
      svg.append(live);
    } else if (tool === "pin") {
      const tg = target(t);
      let kind = tg.type === "landmark" || tg.type === "spawn" ? tg.type : null;
      if (!kind) { // 没点中符号：就近 10 m 内选一个
        const lm = landmarkOf(sid), sp = spawnOf(sid);
        const dl = lm ? Math.hypot(lm.position[0] - p[0], lm.position[2] - p[1]) : 1e9;
        const ds = sp ? Math.hypot(sp.position[0] - p[0], sp.position[2] - p[1]) : 1e9;
        if (Math.min(dl, ds) <= 10) kind = dl <= ds ? "landmark" : "spawn";
      }
      if (kind && handlers.canPin(kind)) {
        dragging = { kind, node: svg.querySelector(kind === "landmark" ? ".landmark" : ".spawn"), rot: kind === "spawn" ? -((spawnOf(sid) || {}).rotation_y || 0) : 0 };
      }
    } else if (tool === "erase") {
      handlers.onErase(target(t), p);
    } else {
      handlers.onSelect(target(t), p, ev);
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    const p = svgPoint(svg, ev, sid);
    if (drawing && live) { const last = drawing.pts[drawing.pts.length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1) { drawing.pts.push(p); live.setAttribute("points", pts(drawing.pts)); } }
    if (dragging && dragging.node) dragging.node.setAttribute("transform", `translate(${fmt1(p[0])} ${fmt1(p[1])}) rotate(${fmt1(dragging.rot)})`);
  });
  const finish = (ev) => {
    if (drawing) {
      const d = drawing; drawing = null; if (live) live.remove(); live = null;
      if (d.pts.length < 3) return;
      if (d.tool === "path") handlers.onPath(d.pts); else handlers.onRegion(d.pts, ev);
      return;
    }
    if (dragging) { const k = dragging.kind; dragging = null; handlers.onPinEnd(k, svgPoint(svg, ev, sid)); }
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", () => { drawing = null; if (live) live.remove(); live = null; dragging = null; });
}

/** 小工具：点在哪一层台地（给面板文案用） */
export function terraceLevelAt(T, p) { const t = T && T.terraceAt(p[0], p[1]); return t ? t.level : null; }
export { pointInPolygon };
