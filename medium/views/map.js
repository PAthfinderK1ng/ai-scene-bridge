// views/map.js — 俯视语义图：从「已解析的 SID + 地形 T」画出来，全部数据驱动，没有一处写死的几何。
// 坐标：SVG viewBox 直接用米（x 向右 = 东，y 向下 = +z 南），北在上。文字层最后画、带白描边，字号按图宽缩放（u = 图宽 / 120）。
// 三层：地面（台地 / 路 / 房 / 地标 / 入口）、地下空间、天上空间；当前层画实，其它层淡显。剖切线、空间、连接点、选中高亮见 maplayers.js；手势见 mapgestures.js。
import { pointInPolygon, polygonCentroid, clamp } from "../engine/terrain.js";
import { drawSpaces, drawConnectors, drawSectionBand, drawSectionHandles, drawSelection } from "./maplayers.js";
import { placeLabels } from "./maplabels.js";
export { bindMapGestures, svgPoint, snapAngle } from "./mapgestures.js";
export { spaceLevelTag, SPACE_STYLE, SECTION_COLOR } from "./maplayers.js";

const SVGNS = "http://www.w3.org/2000/svg";
/** 建 SVG 元素：属性为 null 的跳过，子节点可以是字符串 */
export function svgel(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export const REGION_KINDS = {
  other: { label: "民居", color: null },
  gathering: { label: "聚落", color: null },
  plaza: { label: "广场", color: "#9a9890" },
  forest: { label: "林子", color: "#4f6b3a" },
  farmland: { label: "农田", color: "#c8a951" },
  terrace: { label: "梯田", color: "#8a7a3a" },
};
export const LANDMARK_LABEL = { temple: "寺庙", pagoda: "塔楼", tree: "大树", wheel: "水车", gate: "寨门" };
export const PLACEMENT_LABEL = { top: "顶层中央", ridge_end: "山脊尽头", cliff_edge: "临崖", plaza: "中层广场", entry: "村口" };
export const SPAWN_LABEL = { valley_bottom: "山脚", side_slope: "半山侧坡", summit: "山顶", S: "南边山脚", E: "东侧", W: "西侧" };
/** 第一眼的水平视野角（俯视图视锥与第一眼画幅共用） */
export const EYE_FOV_DEG = 80;

export const fmt1 = (v) => Math.round(v * 10) / 10;
export const pts = (arr) => arr.map((p) => `${fmt1(p[0])},${fmt1(p[1])}`).join(" ");

/** 层号文案（俯视图 / 剖面 / 面板共用）：第 1 层是入口地面 */
export function levelLabel(level, layer) { return level === 0 ? "1 层（入口地面）" : `${level + 1} 层 · +${Math.round(level * layer)} m`; }

/** 层色：越高越绿 */
export function levelColor(level, maxLevel) {
  const t = maxLevel > 0 ? level / maxLevel : 0;
  const a = [233, 226, 207], b = [185, 199, 163];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

/** 色板角色 → hex（缺的用默认） */
export function paletteOf(sid) {
  const m = {};
  for (const p of (sid.style && sid.style.palette) || []) m[p.role] = p.hex;
  return Object.assign({ roof: "#4A4A4A", wall: "#D9C9A3", stone: "#9A9890", foliage: "#4F6B3A", mist: "#DDE6F0" }, m);
}

export function landmarkOf(sid) { return (sid.volumes || []).find((v) => v.importance === "landmark") || null; }
export function spawnOf(sid) { return (sid.markers || []).find((m) => m.kind === "player_spawn") || null; }
export function mainTrailOf(sid) { return (sid.paths || []).find((p) => p.id === "main_trail") || (sid.paths || []).find((p) => p.kind === "trail") || null; }
export function streamOf(sid) { return (sid.paths || []).find((p) => p.kind === "river") || null; }

/** 地标图形（俯视符号，原点在地标中心，按 9 m 宽设计） */
function landmarkGlyph(kind) {
  const g = svgel("g");
  const fill = "#b8452b", stroke = "#4a1a10";
  if (kind === "temple") g.append(svgel("path", { d: "M-4.5 1.5 L0 -4.5 L4.5 1.5 Z M-3.5 1.5 L3.5 1.5 L3.5 5 L-3.5 5 Z", fill, stroke, "stroke-width": 0.35 }));
  else if (kind === "pagoda") g.append(svgel("rect", { x: -3, y: -3, width: 6, height: 6, fill, stroke, "stroke-width": 0.35 }), svgel("rect", { x: -1.6, y: -1.6, width: 3.2, height: 3.2, fill: "#fff", "fill-opacity": 0.6 }));
  else if (kind === "wheel") { g.append(svgel("circle", { r: 4, fill: "none", stroke: "#6b3f2a", "stroke-width": 0.9 })); for (let a = 0; a < 6; a++) g.append(svgel("line", { x1: 0, y1: 0, x2: 4 * Math.cos((a * Math.PI) / 3), y2: 4 * Math.sin((a * Math.PI) / 3), stroke: "#6b3f2a", "stroke-width": 0.5 })); }
  else if (kind === "gate") g.append(svgel("path", { d: "M-5 3 L-5 -2 L-3 -4 L3 -4 L5 -2 L5 3 M-2 3 L-2 -1 L2 -1 L2 3", fill: "none", stroke, "stroke-width": 0.9 }));
  else g.append(svgel("circle", { r: 4.2, fill: "#3f6b2a" }), svgel("rect", { x: -0.7, y: 3, width: 1.4, height: 3, fill: "#5a3a1a" }));
  return g;
}

/**
 * 画俯视语义图。
 * @param {object} ctx { sid, T, facts?, checks?, locked?: Set, diffs?: [{id, from:[x,z], to:[x,z], err_m}], eye?: 第一眼事实, tool?,
 *   stratum?: "ground"|"underground"|"sky"（当前层画实、其它层淡显，默认 ground），
 *   section?: {mode, line, width_m}（画剖切线 + 宽度带；直线模式有两端与中段把手）, sectionHandles?: false 时不画把手（画路 / 圈 / 擦除工具），
 *   selected?: {type, id}（选中高亮；type 同手势 target：house / landmark / spawn / space / connector / region / path / terrace / trail_vertex(id = 折点序号)） }
 * @param {object} opts { small: 缩略图模式（不画文字 / 纹理 / 比例尺 / 剖切 / 选中 / 把手，不绑交互）, footer: 在图底画一行统计（导出 PNG 用） }
 */
export function renderMap(ctx, opts = {}) {
  const { sid, T } = ctx;
  const small = !!opts.small;
  const b = sid.bounds;
  const [xmin, zmin] = [b.min[0], b.min[2]], W = b.max[0] - b.min[0], H = b.max[2] - b.min[2];
  const u = Math.max(W, H) / 120; // 字号 / 位移的米制缩放：120 m 的图 u = 1
  const PAD = 4 * u;
  const footer = !small && !!opts.footer;
  const vbH = H + 2 * PAD + (footer ? 3 * u : 0);
  const stratum = small ? "ground" : ["underground", "sky"].includes(ctx.stratum) ? ctx.stratum : "ground";
  const onGround = stratum === "ground";
  const svg = svgel("svg", { viewBox: `${fmt1(xmin - PAD)} ${fmt1(zmin - PAD)} ${fmt1(W + 2 * PAD)} ${fmt1(vbH)}`, class: "map", "font-family": "inherit", "data-stratum": stratum });
  svg.append(svgel("rect", { x: fmt1(xmin - PAD), y: fmt1(zmin - PAD), width: fmt1(W + 2 * PAD), height: fmt1(vbH), fill: "#fbfaf6" }));
  svg.append(svgel("rect", { x: xmin, y: zmin, width: W, height: H, fill: onGround ? "#efe9dc" : "#e9e6df" }));
  // 地面层：不是当前层时整组淡显、不接手势
  const s = svgel("g", { class: "stratum-ground", opacity: onGround ? null : 0.35, "pointer-events": onGround ? null : "none", "data-inactive": onGround ? null : 1 });
  svg.append(s);
  // 文字层：最后 append，白描边（内联属性，导出 PNG 也生效）；地面的文字在非地面层时也淡显
  const labels = svgel("g", { class: "labels" });
  const groundLabels = onGround ? labels : svgel("g", { opacity: 0.45, "pointer-events": "none" });
  if (!onGround) labels.append(groundLabels);
  const label = (attrs, text) => svgel("text", Object.assign({ stroke: "#fff", "stroke-width": fmt1(0.6 * u), "paint-order": "stroke", "stroke-linejoin": "round" }, attrs), text);

  // 台地：按层着色（低→高）；记下每层层号的落点（多边形左缘 + 质心高度）
  const terraces = (T && T.terraces) || [];
  const maxLevel = terraces.reduce((m, t) => Math.max(m, t.level), 0);
  const lvPos = {};
  const lm = landmarkOf(sid);
  for (const t of terraces) {
    s.append(svgel("polygon", { points: pts(t.polygon), fill: levelColor(t.level, maxLevel), stroke: "#8c9a6b", "stroke-width": 0.45, "stroke-dasharray": "1.4 1", "data-terrace": t.id }));
    if (!lvPos[t.level]) {
      // 地标和层号同一高度时（顶层常见），层号改放多边形下缘内侧，不压符号
      const nearLm = lm && pointInPolygon([lm.position[0], lm.position[2]], t.polygon) && Math.abs(lm.position[2] - t.centroid[1]) < 5 * u;
      lvPos[t.level] = { x: Math.min(...t.polygon.map((p) => p[0])) + 2.5 * u, y: nearLm ? Math.max(...t.polygon.map((p) => p[1])) - 1.5 * u : t.centroid[1] + 1 * u };
    }
  }
  // 层号落点挤在一起时（溪谷的条带质心同高）往下错开一行，字不叠
  const placedLv = [];
  for (const k of Object.keys(lvPos).map(Number).sort((a, b) => a - b)) {
    const q = lvPos[k];
    while (placedLv.some((o) => Math.abs(o.x - q.x) < 22 * u && Math.abs(o.y - q.y) < 3 * u)) q.y += 3.2 * u;
    placedLv.push(q);
  }
  // 等高线（层间）：缩略图不画
  if (T && !small) for (const c of T.contours()) { let d = ""; for (const [a, q] of c.segments) d += `M${fmt1(a[0])} ${fmt1(a[1])}L${fmt1(q[0])} ${fmt1(q[1])}`; if (d) s.append(svgel("path", { d, fill: "none", stroke: "#8c9a6b", "stroke-width": 0.3, opacity: 0.75 })); }

  // 区域（kind ≠ other 才有填色），标签可翻；台地级区域标签与层号合并成「n 层 · 民居 · 更密 ▾」
  const regions = (sid.regions || []).filter((r) => r.polygon && r.polygon.length >= 3);
  const labeledLevels = new Set();
  for (const r of regions) {
    const kd = REGION_KINDS[r.kind] || REGION_KINDS.other;
    const c = polygonCentroid(r.polygon);
    if (kd.color) {
      s.append(svgel("polygon", { points: pts(r.polygon), fill: kd.color, "fill-opacity": r.kind === "forest" ? 0.18 : 0.3, stroke: kd.color, "stroke-width": 0.5, "stroke-dasharray": "1.5 1", "data-region": r.id }));
      if (r.kind === "terrace" || r.kind === "farmland") for (let k = -4; k <= 4; k++) { const y = c[1] + k * 2.4; s.append(svgel("line", { x1: c[0] - 8, x2: c[0] + 8, y1: y, y2: y + (r.kind === "terrace" ? 1 : 0), stroke: kd.color, "stroke-width": 0.35, opacity: 0.7 })); }
    } else if (r.user_set) {
      s.append(svgel("polygon", { points: pts(r.polygon), fill: "none", stroke: "#8b6b3a", "stroke-width": 0.5, "stroke-dasharray": "1.5 1", "data-region": r.id }));
    }
    if (!small && (kd.color || r.user_set || (r.density != null && Math.abs(r.density - 1) > 0.25))) {
      const dens = r.density == null ? "" : r.density === 0 ? "" : r.density > 1.25 ? " · 更密" : r.density < 0.75 ? " · 更稀" : "";
      const base = { "font-size": fmt1(2.5 * u), fill: kd.color || "#7a5a00", "data-region-label": r.id, style: "cursor:pointer" };
      const lp = r.terrace_level != null ? lvPos[r.terrace_level] : null;
      if (!r.user_set && lp && !labeledLevels.has(r.terrace_level)) {
        labeledLevels.add(r.terrace_level);
        groundLabels.append(label(Object.assign(base, { x: fmt1(lp.x), y: fmt1(lp.y), "text-anchor": "start" }), `${r.terrace_level + 1} 层 · ${kd.label}${dens} ▾`));
      } else if (r.user_set) {
        const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]);
        groundLabels.append(label(Object.assign(base, { x: fmt1(Math.min(...xs) + 1.5 * u), y: fmt1(Math.min(...ys) - 1.2 * u), "text-anchor": "start" }), `${kd.label}${dens} ▾`));
      } else if (r.terrace_level == null || !labeledLevels.has(r.terrace_level)) { // 同一层的另一块（溪谷对岸）不再重复写
        groundLabels.append(label(Object.assign(base, { x: fmt1(c[0]), y: fmt1(c[1] - 2 * u), "text-anchor": "middle" }), `${kd.label}${dens} ▾`));
      }
    }
  }
  // 层号（没被区域标签带上的层）
  if (!small) for (const t of terraces) if (!labeledLevels.has(t.level)) { labeledLevels.add(t.level); const lp = lvPos[t.level]; groundLabels.append(label({ x: fmt1(lp.x), y: fmt1(lp.y), "font-size": fmt1(2.4 * u), fill: "#6b7a4b", "data-lv": t.level }, `${t.level + 1} 层`)); }

  // 溪
  const stream = streamOf(sid);
  if (stream && stream.points && stream.points.length > 1) s.append(svgel("polyline", { points: pts(stream.points), fill: "none", stroke: "#6f9bc2", "stroke-width": Math.max(1.5, stream.width || 3), "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.9 }));

  // 其它路（用户手画的支路等）
  for (const p of sid.paths || []) if (p.kind !== "river" && p.id !== "main_trail" && p.points && p.points.length > 1) s.append(svgel("polyline", { points: pts(p.points), fill: "none", stroke: "#8b7d5b", "stroke-width": 1.4, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": "2 1", opacity: 0.9, "data-path": p.id }));

  // 主路：棕线；陡段（局部坡度 > 0.45）叠垂直于路的 3.2 m 台阶纹，平段光秃
  const trail = mainTrailOf(sid);
  if (trail && trail.points && trail.points.length > 1) {
    s.append(svgel("polyline", { points: pts(trail.points), fill: "none", stroke: "#8b7d5b", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.95, "data-path": "main_trail" }));
    if (T && !small) {
      let d = "";
      const prof = T.sampleProfile(trail.points, 1);
      for (let i = 1; i < prof.length; i++) {
        const a = prof[i - 1], q = prof[i], dd = q.d - a.d;
        if (dd < 0.2 || Math.abs(q.h - a.h) / dd <= 0.45) continue;
        const dx = q.x - a.x, dz = q.z - a.z, L = Math.hypot(dx, dz) || 1;
        const nx = (-dz / L) * 1.6, nz = (dx / L) * 1.6, mx = (a.x + q.x) / 2, mz = (a.z + q.z) / 2;
        d += `M${fmt1(mx - nx)} ${fmt1(mz - nz)}L${fmt1(mx + nx)} ${fmt1(mz + nz)}`;
      }
      if (d) s.append(svgel("path", { d, fill: "none", stroke: "#5a4a2a", "stroke-width": 0.35, "pointer-events": "none", class: "trail-steps" }));
    }
  }

  // 桥：路过溪处（引擎 facts.bridges），顺着路的一块石板
  for (const br of (ctx.facts && ctx.facts.bridges) || []) {
    const ang = (Math.atan2(br.dir[1], br.dir[0]) * 180) / Math.PI, L = (br.width || 4) + 2;
    s.append(svgel("rect", { x: fmt1(-L / 2), y: -1.6, width: fmt1(L), height: 3.2, rx: 0.4, fill: "#d9d2bf", stroke: "#5a4a2a", "stroke-width": 0.35, transform: `translate(${fmt1(br.at[0])} ${fmt1(br.at[1])}) rotate(${fmt1(ang)})`, "pointer-events": "none", class: "bridge" }));
  }

  // 剖切宽度带（半透明，盖在地面层之上、空间之下；带内的东西会投到剖面上）
  if (!small && ctx.section) drawSectionBand(svg, ctx.section, sid, u);

  // 树（kind prop / 圆柱）与房子（kind building，非地标）：屋面 + 屋脊 + 门块
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
    const g = svgel("g", { transform: `translate(${fmt1(x)} ${fmt1(z)}) rotate(${fmt1(-(v.rotation_y || 0))})`, "data-house": v.id, "data-pos": `${fmt1(x)} ${fmt1(z)}`, style: "cursor:pointer" });
    g.append(svgel("rect", { x: -w / 2, y: -d / 2, width: w, height: d, fill: pal.roof, stroke: v.locked ? "#b8452b" : "#222", "stroke-width": v.locked ? 0.5 : 0.25 }));
    if (!small) {
      g.append(svgel("line", { x1: -w / 2 + 0.6, x2: w / 2 - 0.6, y1: 0, y2: 0, stroke: "#fff", "stroke-opacity": 0.35, "stroke-width": 0.3 })); // 屋脊
      g.append(svgel("rect", { x: -0.9, y: -d / 2 - 0.3, width: 1.8, height: 1, fill: "#fff", stroke: "#222", "stroke-width": 0.2 })); // 门（朝 -z 一侧）
    }
    s.append(g);
  }

  // 地标：半透明占地 + 符号（按 9 m 宽缩放）；标签走文字层
  if (lm) {
    const g = svgel("g", { class: "landmark", transform: `translate(${fmt1(lm.position[0])} ${fmt1(lm.position[2])})`, "data-landmark": lm.id, "data-pos": `${fmt1(lm.position[0])} ${fmt1(lm.position[2])}`, style: "cursor:pointer" });
    const sz = lm.size || [9, 9, 9];
    if (!small) g.append(lm.shape === "cylinder"
      ? svgel("circle", { r: fmt1(sz[0] / 2), fill: "#b8452b", "fill-opacity": 0.25, stroke: "#4a1a10", "stroke-width": 0.3 })
      : svgel("rect", { x: fmt1(-sz[0] / 2), y: fmt1(-sz[2] / 2), width: fmt1(sz[0]), height: fmt1(sz[2]), fill: "#b8452b", "fill-opacity": 0.25, stroke: "#4a1a10", "stroke-width": 0.3, transform: `rotate(${fmt1(-(lm.rotation_y || 0))})` }));
    const glyph = landmarkGlyph(lm.kind_hint || lm.landmark_kind || "temple");
    glyph.setAttribute("transform", `scale(${fmt1(Math.min(1, sz[0] / 9))})`);
    g.append(glyph);
    s.append(g);
    if (!small) groundLabels.append(label({ x: fmt1(lm.position[0]), y: fmt1(lm.position[2] - 6 * u), "font-size": fmt1(2.8 * u), "text-anchor": "middle", fill: "#4a1a10", "data-for": `landmark:${lm.id}` }, `${lm.label || "地标"}（地标）`));
  }

  // 出生点与第一眼视锥（夹角 = 第一眼的 FOV；看不见地标时视锥变红）
  const sp = spawnOf(sid);
  if (sp) {
    const [ex, , ez] = sp.position;
    const th = ((sp.rotation_y || 0) * Math.PI) / 180;
    const fx = -Math.sin(th), fz = -Math.cos(th);
    const L = lm ? Math.hypot(lm.position[0] - ex, lm.position[2] - ez) * 0.8 : 30;
    const ang = Math.atan2(fz, fx);
    const coneColor = ctx.eye && ctx.eye.landmark_visible === false ? "#c0392b" : "#1f6feb";
    for (const da of [-1, 1].map((k) => (k * (EYE_FOV_DEG / 2) * Math.PI) / 180)) s.append(svgel("line", { x1: ex, y1: ez, x2: fmt1(ex + Math.cos(ang + da) * L), y2: fmt1(ez + Math.sin(ang + da) * L), stroke: coneColor, "stroke-width": 0.35, "stroke-dasharray": "1 1", opacity: 0.45, "pointer-events": "none", "data-for": `spawn:${sp.id}` }));
    const g = svgel("g", { class: "spawn", transform: `translate(${fmt1(ex)} ${fmt1(ez)}) rotate(${fmt1(-(sp.rotation_y || 0))})`, "data-spawn": sp.id, "data-pos": `${fmt1(ex)} ${fmt1(ez)}`, style: "cursor:pointer" });
    g.append(svgel("path", { d: "M0 -4.5 L3.2 3 L-3.2 3 Z", fill: "#1f6feb", stroke: "#fff", "stroke-width": 0.5 }));
    s.append(g);
    if (!small) {
      const right = ex < xmin + W * 0.6;
      groundLabels.append(label({ x: fmt1(right ? ex + 5 * u : ex - 5 * u), y: fmt1(ez + 1 * u), "text-anchor": right ? "start" : "end", "font-size": fmt1(2.8 * u), fill: "#1f6feb", "data-for": `spawn:${sp.id}` }, `入口 · 第一眼朝${lm ? lm.label || "地标" : "北"}`));
    }
  }

  // 地下 / 天上空间与连接点（当前层画实、其它层淡显）
  drawSpaces(svg, labels, { sid, T, stratum, small, u, label });
  drawConnectors(svg, labels, { sid, stratum, small, u, label });
  // 主路折点把手（地面层、移动工具；首尾跟着入口 / 地标走，不给把手）
  if (!small && onGround && trail && trail.points && trail.points.length > 2 && (ctx.tool == null || ["move", "pin", "select"].includes(ctx.tool))) {
    const hg = svgel("g", { class: "trail-handles" });
    trail.points.forEach((q, i) => { if (i > 0 && i < trail.points.length - 1) hg.append(svgel("circle", { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(0.9 * u), fill: "#fff", stroke: "#8b7d5b", "stroke-width": fmt1(0.35 * u), "data-trail-vertex": i, "data-pos": `${fmt1(q[0])} ${fmt1(q[1])}`, style: "cursor:move" })); });
    svg.append(hg);
  }

  // 读回差异（红点：意图位置 → 引擎实际位置）
  const ds = svgel("g", { class: "diffs" });
  for (const d of ctx.diffs || []) {
    if (!d.from) continue;
    if (d.to) ds.append(svgel("line", { x1: d.from[0], y1: d.from[1], x2: d.to[0], y2: d.to[1], stroke: "#c0392b", "stroke-width": 0.5, "stroke-dasharray": "1 0.8" }));
    ds.append(svgel("circle", { cx: d.from[0], cy: d.from[1], r: 1.6, fill: "#c0392b", stroke: "#fff", "stroke-width": 0.4, "data-diff": d.id, style: "cursor:pointer" }));
    if (d.to) ds.append(svgel("circle", { cx: d.to[0], cy: d.to[1], r: 1.2, fill: "none", stroke: "#c0392b", "stroke-width": 0.5 }));
    if (!small) labels.append(label({ x: fmt1(d.from[0] + 2.2 * u), y: fmt1(d.from[1] - 1.5 * u), "font-size": fmt1(2.3 * u), fill: "#c0392b" }, d.err_m != null ? `${d.id} 偏 ${fmt1(d.err_m)} m` : `${d.id} 缺`));
  }

  svg.append(ds);
  // 剖切线与把手、选中高亮：在所有图形之上、文字之下
  if (!small && ctx.section) drawSectionHandles(svg, labels, ctx.section, sid, u, label, ctx.sectionHandles !== false);
  if (!small && ctx.selected) drawSelection(svg, ctx.selected, { sid, T, u });

  if (!small) {
    // 复述标签（可翻替代解释）
    const f = (ctx.facts && ctx.facts.trail) || null;
    if (trail && trail.points && trail.points.length > 1) {
      const mid = trail.points[Math.floor(trail.points.length / 2)];
      const how = trail.user_drawn ? "你画的" : f && f.folds === 0 ? "直上" : f ? `之字 ${f.folds} 折` : "算出来的";
      const climb = f ? ` · 爬升 ${Math.round(f.climb_m)} m` : "";
      groundLabels.append(label({ x: fmt1(clamp(mid[0] + 3 * u, xmin + 2 * u, xmin + W - 40 * u)), y: fmt1(clamp(mid[1] - 2 * u, zmin + 6 * u, zmin + H - 4 * u)), "font-size": fmt1(2.6 * u), fill: "#5a4a2a", "data-path-label": 1, class: "trail-label", style: "cursor:pointer" }, `主路：${how}${climb} ▾`));
    }
    labels.append(label({ x: fmt1(xmin + W + PAD - 1.5 * u), y: fmt1(zmin - PAD + 3.8 * u), "font-size": fmt1(3.2 * u), "text-anchor": "end", fill: "#333" }, "N ↑"));
    // 比例尺（左下角）
    const bar = W >= 100 ? 20 : 10, bx = xmin + 3 * u, by = zmin + H - 4 * u;
    labels.append(svgel("line", { x1: fmt1(bx), x2: fmt1(bx + bar), y1: fmt1(by), y2: fmt1(by), stroke: "#333", "stroke-width": fmt1(0.6 * u) }));
    for (const x of [bx, bx + bar]) labels.append(svgel("line", { x1: fmt1(x), x2: fmt1(x), y1: fmt1(by - 1 * u), y2: fmt1(by), stroke: "#333", "stroke-width": fmt1(0.6 * u) }));
    labels.append(label({ x: fmt1(bx + bar / 2), y: fmt1(by - 1.4 * u), "font-size": fmt1(2.4 * u), "text-anchor": "middle", fill: "#333" }, `${bar} m`));
    if (footer) {
      const layer = (sid.meta && sid.meta.layer_height_m) || 3;
      const steps = f && f.steps_estimate ? ` · 主路 ${Math.round(f.length_m)} m / 约 ${Math.round(f.steps_estimate)} 级台阶` : "";
      const sps = (sid.spaces || []).filter((x) => x && x.polygon), nu = sps.filter((x) => x.stratum === "underground").length, ns = sps.length - nu;
      const spaceTxt = `${nu ? ` · 地下 ${nu} 处` : ""}${ns ? ` · 天上 ${ns} 处` : ""}`;
      labels.append(label({ x: fmt1(xmin + 2 * u), y: fmt1(zmin + H + PAD + 1.8 * u), "font-size": fmt1(2.4 * u), fill: "#555" }, `约 ${W} m 见方 · ${terraces.length} 层台地（1 层 ≈ ${layer} m）· ${houseCount} 栋${steps}${spaceTxt}`));
    }
  }
  if (!small) placeLabels(labels, { sid, u, onGround }); // 标签避开房子 / 地标 / 彼此（maplabels.js）
  svg.append(labels);
  return svg;
}

/** 小工具：点在哪一层台地（给面板文案用） */
export function terraceLevelAt(T, p) { const t = T && T.terraceAt(p[0], p[1]); return t ? t.level : null; }
export { pointInPolygon };
