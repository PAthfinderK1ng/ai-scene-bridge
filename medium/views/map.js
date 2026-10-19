// views/map.js — 俯视图：渲染 + 图层 + 标签避让 + 手势（v4，docs/05 §6；吸收原 maplayers / maplabels / mapgestures）。
// v5（docs/06 §5）：每种形体画真实轮廓（矩形 / 椭圆 / n 边形 / 环 / 拱的两腿），屋顶纹样，悬空虚线 + 「↑18 m」，路按 style 画；
// 形体约定（shapeOf / volDims / roofOf / volumeBase / footprintPolygon …）在 engine/layout.js，这里转出，剖面 / 第一眼 / 3D 共用。
// v6（docs/07）：标记（圈选 / 手绘线 / 图钉）、地形操作的中心 / 高度把手、「高度」工具（随意选点上下拖）、图钉手势（右键 / Ctrl+点）。
// 纯函数：数据进（ctx）、SVG 出、回调出；不 import app.js / ui.js，不调 AI。
// 坐标：viewBox 直接用米（x 向右 = 东，y 向下 = +z 南），北在上；字号按图宽缩放（u = 图宽 / 120）。
// 图上每个可点的东西带 data-type / data-plan-id / data-sid-id（空间内部另带 data-part / data-sublevel），
// 拖动预览按 data-for 平移一组节点。三层：地面 / 地下 / 空中，当前层画实、其它层淡显；地下 / 空中层画空间内部平面
// （通道按真实宽度、房间填色、入口 / 终点、层间连接），当前内部层实画、其它内部层淡画。
import { pointInPolygon, polygonCentroid, polygonArea, clamp, distToPolygon } from "../engine/terrain.js";
import { sectionPath, widthClamp } from "../engine/section.js";
// 高度笔刷 / 把手数值（heightBrush、heightStroke、drawHeightBrush、OP_RANGE、opValueText）在 profile.js：剖面和俯视图共用；这里只在函数里用（两文件互相引用，顶层不取值）
import { heightBrush, heightStroke, drawHeightBrush, brushStep, HEIGHT_M_PER_PX, OP_RANGE, opValueText } from "./profile.js";
import { ringOf, footRects } from "../engine/layout.js";
export { ringOf };
import { levelsOf, entryLevel, goalLevel, VIA_LABEL, ROLE_LABEL, LAYOUT_LABEL, SKY_LAYOUT_LABEL } from "../engine/interior.js";

// ============================================================ 共用小工具（profile / eye / view3d 也用）
const SVGNS = "http://www.w3.org/2000/svg";
/** 建 SVG 元素：属性为 null / undefined 的跳过，子节点可以是字符串 */
export function svgel(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export const fmt1 = (v) => Math.round(v * 10) / 10;
export const pts = (arr) => arr.map((p) => `${fmt1(p[0])},${fmt1(p[1])}`).join(" ");
const r2 = (v) => Math.round(v * 100) / 100;
const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const validPoly = (p) => Array.isArray(p) && p.length >= 3 && p.every(isPt);
const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&"));

/** 区域种类 → 文案与填色（null = 不填色，只描虚边） */
export const REGION_KINDS = {
  other: { label: "区域", color: null }, gathering: { label: "聚落", color: null }, plaza: { label: "广场", color: "#9a9890" },
  forest: { label: "林子", color: "#4f6b3a" }, farmland: { label: "农田", color: "#c8a951" }, terrace: { label: "梯田", color: "#8a7a3a" }, water: { label: "水面", color: "#6f9bc2" },
};
/** 建筑 / 地标的 form → 中文（清单与图例共用） */
export const FORM_LABEL = { house: "民居", stilt_house: "吊脚楼", courtyard: "院落", round_house: "圆楼", tower: "塔", hall: "殿堂", pavilion: "亭", gate: "门", bridge: "桥", stage: "戏台", wall: "墙", well: "井", tree: "树", statue: "像", custom: "体块" };
/** 第一眼的水平视野角（俯视图视锥与第一眼画幅共用） */
export const EYE_FOV_DEG = 80;
export const SECTION_COLOR = "#7a4fc9";
export const SELECT_COLOR = "#f08c00";
/** 空间配色：地下 = 暗色岩层 + 浅色通道；空中 = 浅蓝空域 + 木色栈道 / 平台 */
export const SPACE_STYLE = Object.freeze({
  underground: { fill: "#3b342d", fillOpacity: 0.32, stroke: "#2a241f", dash: "2 1", text: "#3b342d", arrow: "#3b342d", rock: "#4a4038", rockOpacity: 0.9, way: "#efe4cc", ghost: "#b9ab92" },
  sky: { fill: "#cfe6f7", fillOpacity: 0.55, stroke: "#3d8bd0", dash: null, text: "#2a6aa6", arrow: "#3d8bd0", rock: "#d6e9f7", rockOpacity: 0.55, way: "#a0784a", ghost: "#8fb3cf" },
});
/** 房间按角色填色 */
export const ROOM_FILL = { entry: "#9cc59a", goal: "#e9a23b", stope: "#c9a77a", hall: "#eadbb8", side: "#dccaa6", chamber: "#d6cab2", named: "#eadbb8" };

/** 层色：越高越绿 */
export function levelColor(level, maxLevel) {
  const t = maxLevel > 0 ? level / maxLevel : 0, a = [233, 226, 207], b = [185, 199, 163];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}
/** 色板角色 → hex（缺的用默认） */
export function paletteOf(sid) {
  const m = {};
  for (const p of (sid.style && sid.style.palette) || []) if (p && p.role) m[p.role] = p.hex;
  return Object.assign({ roof: "#4A4A4A", wall: "#D9C9A3", stone: "#9A9890", foliage: "#4F6B3A", mist: "#DDE6F0" }, m);
}
// 形体约定（shapeOf / volDims / roofOf / volumeBase / footprintPolygon …）在 engine/layout.js（纯几何），这里转出，剖面 / 第一眼 / 3D 照旧从 map.js 拿。
import { SHAPES, PATH_STYLES, ROOFS, ROUND_SHAPES, shapeOf, volDims, prismSides, archThickness, torusTube, isUpright, roofOf, elevOf, volumeBase, volumeTop, volToWorld, footprintPolygon } from "../engine/layout.js";
export { SHAPES, PATH_STYLES, ROOFS, ROUND_SHAPES, shapeOf, volDims, prismSides, archThickness, torusTube, isUpright, roofOf, elevOf, volumeBase, volumeTop, volToWorld, footprintPolygon };
/** 图上的点选类型：地标 → landmark；撒出来的房子（有 zone_id / generated / 没有 plan_id 的 building）→ house；其余形体 → shape */
export function volumeType(v) {
  if (v.importance === "landmark") return "landmark";
  if (v.kind === "building" && (v.zone_id || v.generated || !v.plan_id)) return "house";
  return "shape";
}
/** 体块的颜色（地标红；有 color_role 且色板里有就用它；否则按 kind） */
const KIND_FILL = { wall: "#7a6a55", stairs: "#a8a090", platform: "#c9bfa8", column: "#a3a097", gate: "#8a5a3a", statue: "#8d8a80", rock: "#8d867a", crystal: "#7fc8e0", island: "#9b8b6c", water: "#6f9bc2", prop: "#a08a6a", bridge: "#a0784a" };
export function volumeColor(v, pal, view = "top") {
  if (v.importance === "landmark") return view === "top" ? "#b8452b" : pal.roof;
  const role = v.color_role && v.color_role !== "mist" && pal[v.color_role] ? v.color_role : null;
  if (v.kind === "building" || v.kind === "tower") return view === "top" ? (role && role !== "wall" ? pal[role] : pal.roof) : role && role !== "roof" ? pal[role] : pal.wall;
  if (role) return pal[role];
  if (v.kind === "tree") return pal.foliage;
  return KIND_FILL[v.kind] || pal.stone;
}
export function landmarksOf(sid) { return (sid.volumes || []).filter((v) => v && v.importance === "landmark" && Array.isArray(v.position) && Array.isArray(v.size)); }
/** 主地标：meta.focus（入口看向的那个），否则第一个地标 */
export function landmarkOf(sid) { const all = landmarksOf(sid), f = sid.meta && sid.meta.focus; return all.find((v) => v.id === f || v.plan_id === f) || all[0] || null; }
/** 出生点脚下的高度：引擎给的 position[1]（站在浮岛 / 平台 / 桥上时高于地面）；没给或不高于地面就取地面 */
export function spawnY(sp, T) { const g = T ? T.heightAt(sp.position[0], sp.position[2]) : 0, y = Number(sp.position[1]); return Number.isFinite(y) && y > g + 0.3 ? y : g; }
export function spawnOf(sid) { return (sid.markers || []).find((m) => m && m.kind === "player_spawn" && Array.isArray(m.position)) || null; }
export function mainTrailOf(sid) { return (sid.paths || []).find((p) => p.id === "main_trail") || (sid.paths || []).find((p) => p.kind === "trail") || null; }
export function streamOf(sid) { return (sid.paths || []).find((p) => p.kind === "river") || null; }
export function terraceLevelAt(T, p) { const t = T && T.terraceAt(p[0], p[1]); return t ? t.level : null; }
export { pointInPolygon };

// 空间内部层换算（sublevelOf / interiorLevelName / spaceDepth …）在 engine/interior.js，这里转出
import { sublevelOf, interiorIndexOf, interiorLevelName, spaceDepth, spaceLevelTag } from "../engine/interior.js";
export { sublevelOf, interiorIndexOf, interiorLevelName, spaceDepth, spaceLevelTag };
const layoutName = (sp) => (sp.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[sp.layout] || "";

// SID 元素占地（featurePolygon / planCenter / sidIdsOf）在 engine/layout.js，这里转出
import { featurePolygon, planCenter, sidIdsOf, contentBox } from "../engine/layout.js";
export { featurePolygon, planCenter, sidIdsOf };
/** plan 里某个 id 的名字（构成清单里的 label）；没有 plan 时 null */
function planLabel(plan, id) {
  if (!plan || !id) return null;
  const t = Array.isArray(plan.terrain) && plan.terrain.find((x) => x && x.id === id);
  if (t) return t.label || null;
  // 场景树：nodes 递归（children / child）；v4 的构成图由 plan.js 的 migrateV4 先转成场景树
  const walk = (ns) => { for (const n of ns || []) { if (!n || typeof n !== "object") continue; if (n.id === id) return n; const r = walk(n.children) || (n.child ? walk([n.child]) : null); if (r) return r; } return null; };
  const n = walk(plan.nodes);
  return n ? n.label || null : null;
}

// ============================================================ 渲染
/**
 * 画俯视图。
 * @param {object} ctx { sid, T, facts?, checks?, plan?, index?, stratum?: "ground"|"underground"|"sky", interiorLevel?: 0|1|2（0 = 入口层）,
 *   section?: {mode, line, width_m}, selected?: {plan_id?, sid_id?, part?}, diffs?: [{id, from, to, err_m}], eye?: {landmark_visible}, tool?: 当前工具（非移动工具不画折点把手）}
 * @param {object} [opts] { small: 缩略图（不画文字 / 等高线 / 剖切 / 选中 / 把手）, footer: 图底一行统计（导出 PNG 用）, sectionHandles: false 不画剖切把手 }
 * @returns {SVGSVGElement}
 */
export function renderMap(ctx, opts = {}) {
  const { sid, T } = ctx, small = !!opts.small, b = sid.bounds;
  const [xmin, zmin] = [b.min[0], b.min[2]], W = b.max[0] - b.min[0], H = b.max[2] - b.min[2];
  const u = Math.max(W, H) / 120, PAD = 4 * u, footer = !small && !!opts.footer, vbH = H + 2 * PAD + (footer ? 3 * u : 0);
  const stratum = ["underground", "sky"].includes(ctx.stratum) ? ctx.stratum : "ground", onGround = stratum === "ground";
  const svg = svgel("svg", { viewBox: `${fmt1(xmin - PAD)} ${fmt1(zmin - PAD)} ${fmt1(W + 2 * PAD)} ${fmt1(vbH)}`, class: "map", "font-family": "inherit", "data-stratum": stratum, style: "touch-action:none" });
  svg.append(svgel("rect", { x: fmt1(xmin - PAD), y: fmt1(zmin - PAD), width: fmt1(W + 2 * PAD), height: fmt1(vbH), fill: "#fbfaf6" }));
  svg.append(svgel("rect", { x: xmin, y: zmin, width: W, height: H, fill: onGround ? "#efe9dc" : "#e9e6df" }));
  const ground = svgel("g", { class: "stratum-ground", opacity: onGround ? null : 0.35, "pointer-events": onGround ? null : "none", "data-inactive": onGround ? null : 1 });
  const labels = svgel("g", { class: "labels" });
  const groundLabels = onGround ? labels : svgel("g", { opacity: 0.45, "pointer-events": "none", "data-inactive": 1 });
  if (!onGround) labels.append(groundLabels);
  /** 文字：白描边；meta.rank 越小越先占位，meta.optional 躲不开就不画 */
  const label = (attrs, text, meta = {}) => svgel("text", Object.assign({ stroke: "#fff", "stroke-width": fmt1(0.6 * u), "paint-order": "stroke", "stroke-linejoin": "round", "data-rank": meta.rank, "data-optional": meta.optional ? 1 : null }, attrs), text);
  const R = { svg, sid, T, ctx, u, small, stratum, onGround, ground, labels, groundLabels, label, plan: ctx.plan || (sid.meta && sid.meta.plan) || null, obs: { ground: [], strata: [], interior: [] } };
  svg.append(ground);

  drawTerrain(R);
  drawZones(R);
  drawWaterAndPaths(R);
  if (!small && ctx.section) drawSectionBand(R, ctx.section);
  drawVolumes(R);
  drawSpawn(R);
  drawPortals(R);
  drawSpaces(R);
  drawConnectors(R);
  if (!small) drawMarks(R);
  if (!small && onGround) drawTrailHandles(R);
  if (!small) drawDiffs(R);
  if (!small && ctx.section) drawSectionHandles(R, ctx.section, opts.sectionHandles !== false);
  if (!small && ctx.selected) drawSelection(R, ctx.selected);
  if (!small && onGround && ctx.selected) drawOpHandles(R);
  if (!onGround) for (const t of groundLabels.querySelectorAll("text")) if (!["landmark", "spawn"].includes(t.getAttribute("data-type"))) t.remove();
  if (!small) { drawChrome(R, footer, PAD, W, H); placeLabels(R); }
  svg.append(labels);
  if (small) { const fb = contentBox(sid, b, u); if (fb) svg.setAttribute("viewBox", fb.map(fmt1).join(" ")); } // 缩略图：取景框贴着内容（形体 + 路 + 出生点），不画整块场地
  return svg;
}

/** 通用属性：可点、可拖的东西都带这些 */
const tag = (type, planId, sidId, forKey, extra = {}) => Object.assign({ "data-type": type, "data-plan-id": planId || null, "data-sid-id": sidId || null, "data-for": forKey }, extra);

// ------------------------------------------------------------ 地形：穹顶 / 谷（底）→ 台地（按层着色）→ 崖 → 等高线 → 名字与层号
function drawTerrain(R) {
  const { sid, T, u, small, ground: g, label, groundLabels } = R;
  const feats = ((sid.terrain && sid.terrain.features) || []).filter((f) => f && f.plan_id);
  const terraces = (T && T.terraces) || [], terraceIds = new Set(terraces.map((t) => t.id));
  const maxLevel = terraces.reduce((m, t) => Math.max(m, t.level), 0);
  const layer = (T && T.layer) || 3;
  const shape = (f, poly, style) => {
    const c = planCenter(sid, T, f.plan_id);
    return svgel("polygon", Object.assign(tag("feature", f.plan_id, f.id, `feature:${f.plan_id}`, { "data-center": c ? `${c[0]} ${c[1]}` : null }), { points: pts(poly), "stroke-linejoin": "round" }, style),
      svgel("title", {}, `${planLabel(R.plan, f.plan_id) || f.label || f.plan_id}${Number.isInteger(f.level) ? ` · ${f.level} 层` : ""}`));
  };
  const others = feats.filter((f) => !terraceIds.has(f.id));
  for (const f of others) {
    if (f.kind === "cliff") continue;
    const poly = featurePolygon(f); if (!poly) continue;
    const neg = (f.height || 0) < 0;
    g.append(shape(f, poly, neg ? { fill: "#cdbf9f", "fill-opacity": 0.45, stroke: "#a8997a", "stroke-width": 0.4, "stroke-dasharray": "1.2 1" }
      : { fill: "#fff", "fill-opacity": 0, stroke: "#a7b28a", "stroke-width": 0.35, "stroke-dasharray": "2 1.2" }));
  }
  for (const t of terraces) {
    const f = t.feature || {};
    if (!f.plan_id) { g.append(svgel("polygon", { points: pts(t.polygon), fill: levelColor(t.level, maxLevel), stroke: "#8c9a6b", "stroke-width": 0.45, "stroke-dasharray": "1.4 1", "pointer-events": "none" })); continue; }
    const n = shape(f, t.polygon, { fill: levelColor(t.level, maxLevel), stroke: "#8c9a6b", "stroke-width": 0.45, "stroke-dasharray": "1.4 1" });
    n.lastChild.textContent = `${planLabel(R.plan, f.plan_id) || f.label} · ${t.level} 层 · +${fmt1(t.height)} m`;
    g.append(n);
  }
  for (const f of others) if (f.kind === "cliff") { const poly = featurePolygon(f); if (poly) g.append(shape(f, poly, { fill: "#7d6a4f", "fill-opacity": 0.4, stroke: "#5a4a32", "stroke-width": 0.8 })); }
  if (T && !small) for (const c of T.contours()) { let d = ""; for (const [a, q] of c.segments) d += `M${fmt1(a[0])} ${fmt1(a[1])}L${fmt1(q[0])} ${fmt1(q[1])}`; if (d) g.append(svgel("path", { d, fill: "none", stroke: "#8c9a6b", "stroke-width": 0.3, opacity: 0.75, "pointer-events": "none" })); }
  if (small) return;
  // 地形块名字（每块一个，放在外接框中心偏上）与层号（每层一个，台地左缘）
  const seen = new Set();
  for (const f of feats) {
    if (seen.has(f.plan_id)) continue; seen.add(f.plan_id);
    if (f.plan_id === "site" || !f.plan_id) continue; // 场地基础形态（plan_id = site）不标名字：它是底，不是 AI 写的地形块
    const c = planCenter(sid, T, f.plan_id); if (!c) continue;
    groundLabels.append(label(Object.assign(tag("feature", f.plan_id, f.id, `feature:${f.plan_id}`), { x: fmt1(c[0]), y: fmt1(c[1] - 3 * u), "font-size": fmt1(2.4 * u), "text-anchor": "middle", fill: "#5f6e43", style: "cursor:pointer" }), planLabel(R.plan, f.plan_id) || String(f.label || "").replace(/\s*第.*$/, ""), { rank: 6, optional: true }));
  }
  const lv = new Set();
  for (const t of terraces) {
    if (lv.has(t.level)) continue; lv.add(t.level);
    const x = Math.min(...t.polygon.map((p) => p[0])) + 2.5 * u;
    groundLabels.append(label({ x: fmt1(x), y: fmt1(t.centroid[1] + u), "font-size": fmt1(2.2 * u), fill: "#6b7a4b", "pointer-events": "none", "data-lv": t.level }, `${t.level} 层 ${(Number.isFinite(t.height) ? t.height : t.level * layer) < 0 ? "−" : "+"}${fmt1(Math.abs(Number.isFinite(t.height) ? t.height : t.level * layer))} m`, { rank: 8, optional: true }));
  }
}

// ------------------------------------------------------------ 区域：有填色的画色块，民居类只描淡虚边（仍可点）；每个区域一个名字
function drawZones(R) {
  const { sid, u, small, ground: g, label, groundLabels } = R;
  const best = new Map();
  for (const r of sid.regions || []) {
    if (!validPoly(r.polygon)) continue;
    const kd = REGION_KINDS[r.kind] || REGION_KINDS.other, pid = r.plan_id || r.id, c = labelPoint(r.polygon, validPoly(r.hole) ? r.hole : null, r.kind === "water" && Number.isFinite(r.surface_y) && R.T ? (q) => R.T.heightAt(q[0], q[1]) < r.surface_y - 0.2 : null);
    const style = kd.color ? { fill: kd.color, "fill-opacity": r.kind === "forest" ? 0.18 : r.kind === "water" ? 0.55 : 0.3, stroke: kd.color, "stroke-width": 0.5, "stroke-dasharray": r.kind === "water" ? null : "1.5 1" }
      : { fill: "#fff", "fill-opacity": 0, stroke: "#8b6b3a", "stroke-width": 0.35, "stroke-dasharray": "1.5 1", "stroke-opacity": r.user_set ? 0.9 : 0.45 };
    g.append(svgel("polygon", Object.assign(tag("zone", pid, r.id, `zone:${pid}`), { points: pts(r.polygon), "stroke-linejoin": "round" }, style), svgel("title", {}, r.label || kd.label)));
    if (r.kind === "terrace" || r.kind === "farmland") for (let k = -4; k <= 4; k++) { const y = c[1] + k * 2.4; g.append(svgel("line", { x1: fmt1(c[0] - 8), x2: fmt1(c[0] + 8), y1: fmt1(y), y2: fmt1(y + (r.kind === "terrace" ? 1 : 0)), stroke: kd.color, "stroke-width": 0.35, opacity: 0.7, "pointer-events": "none" })); }
    const a = Math.abs(polygonArea(r.polygon));
    if (!best.has(pid) || best.get(pid).a < a) best.set(pid, { a, r, c });
  }
  if (small) return;
  for (const [pid, { r, c }] of best) {
    const kd = REGION_KINDS[r.kind] || REGION_KINDS.other;
    groundLabels.append(label(Object.assign(tag("zone", pid, r.id, `zone:${pid}`), { x: fmt1(c[0]), y: fmt1(c[1] + 1.2 * u), "font-size": fmt1(2.5 * u), "text-anchor": "middle", fill: kd.color && r.kind !== "water" ? kd.color : "#7a5a00", style: "cursor:pointer" }), r.label || planLabel(R.plan, pid) || kd.label, { rank: 4 }));
  }
}

// ------------------------------------------------------------ 水与路：溪按宽画蓝线；主路粗、陡段叠台阶纹；隧道虚线；桥木色；支路细虚线
function drawWaterAndPaths(R) {
  const { sid, T, u, small, ground: g, label, groundLabels, ctx } = R;
  for (const p of sid.paths || []) {
    if (p.kind !== "river" || !Array.isArray(p.points) || p.points.length < 2) continue;
    g.append(svgel("polyline", Object.assign(tag("water", p.plan_id || p.id, p.id, `water:${p.plan_id || p.id}`), { points: pts(p.points), fill: "none", stroke: "#6f9bc2", "stroke-width": Math.max(1.5, p.width || 3), "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.9 })));
  }
  const trailFacts = (ctx.facts && ctx.facts.trail) || null;
  for (const p of sid.paths || []) {
    if (p.kind === "river" || !Array.isArray(p.points) || p.points.length < 2) continue;
    const main = p.id === "main_trail", pid = p.plan_id || null, w = main ? 2.2 : pid ? Math.max(1.4, (p.width || 2) * 0.7) : 1;
    if (p.unrouted) { // 按样式走不通：只画两端标记 + 一条细虚线（不画路面）
      const a = p.points[0], b = p.points[p.points.length - 1], gg = svgel("g", tag("path", pid, p.id, `path:${p.id}`, { "data-style": "unrouted" }));
      gg.append(svgel("line", { x1: fmt1(a[0]), y1: fmt1(a[1]), x2: fmt1(b[0]), y2: fmt1(b[1]), stroke: "#b5523b", "stroke-width": 0.9, "stroke-dasharray": "3 2.5", opacity: 0.85 }));
      for (const q of [a, b]) gg.append(svgel("circle", { cx: fmt1(q[0]), cy: fmt1(q[1]), r: 1.8, fill: "#fff", stroke: "#b5523b", "stroke-width": 0.8 }));
      gg.append(svgel("title", {}, `${p.label || "连接"}：走不通（${p.fallback || "坡太陡"}）`));
      g.append(gg);
      continue;
    }
    const st = pathStyleOf(p);
    if (st !== "path") drawStyledPath(R, p, st, w);
    else {
      const style = { fill: "none", stroke: "#8b7d5b", "stroke-width": fmt1(w), "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": pid ? null : "2 1", opacity: pid ? 0.95 : 0.8 };
      g.append(svgel("polyline", Object.assign(tag("path", pid, p.id, `path:${p.id}`, { "data-style": st }), { points: pts(p.points) }, style)));
    }
    if (main && T && !small) {
      let d = "";
      const prof = T.sampleProfile(p.points, 1);
      for (let i = 1; i < prof.length; i++) {
        const a = prof[i - 1], q = prof[i], dd = q.d - a.d;
        if (dd < 0.2 || Math.abs(q.h - a.h) / dd <= 0.45) continue;
        const dx = q.x - a.x, dz = q.z - a.z, L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * 1.6, nz = (dx / L) * 1.6, mx = (a.x + q.x) / 2, mz = (a.z + q.z) / 2;
        d += `M${fmt1(mx - nx)} ${fmt1(mz - nz)}L${fmt1(mx + nx)} ${fmt1(mz + nz)}`;
      }
      if (d) g.append(svgel("path", { d, fill: "none", stroke: "#5a4a2a", "stroke-width": 0.35, "pointer-events": "none", class: "trail-steps" }));
    }
    if (!small && pid) {
      const mid = p.points[Math.floor(p.points.length / 2)], b = sid.bounds;
      const how = main && trailFacts ? (p.user_drawn ? " · 你画的" : trailFacts.folds === 0 ? " · 直上" : ` · 之字 ${trailFacts.folds} 折`) + (trailFacts.climb_m != null ? ` · 爬升 ${Math.round(trailFacts.climb_m)} m` : "") : "";
      groundLabels.append(label(Object.assign(tag("path", pid, p.id, `path:${p.id}`), { x: fmt1(clamp(mid[0] + 3 * u, b.min[0] + 2 * u, b.max[0] - 30 * u)), y: fmt1(clamp(mid[1] - 2 * u, b.min[2] + 6 * u, b.max[2] - 4 * u)), "font-size": fmt1(2.5 * u), fill: "#5a4a2a", class: main ? "trail-label" : null, style: "cursor:pointer" }), `${p.label || planLabel(R.plan, pid) || "路"}${how}`, { rank: 5, optional: !main }));
    }
  }
  for (const br of (ctx.facts && ctx.facts.bridges) || []) {
    if (br.landmark) continue; // 地标桥按自己的底面画
    const ang = (Math.atan2(br.dir[1], br.dir[0]) * 180) / Math.PI, L = (br.width || 4) + 2;
    g.append(svgel("rect", { x: fmt1(-L / 2), y: -1.6, width: fmt1(L), height: 3.2, rx: 0.4, fill: "#d9d2bf", stroke: "#5a4a2a", "stroke-width": 0.35, transform: `translate(${fmt1(br.at[0])} ${fmt1(br.at[1])}) rotate(${fmt1(ang)})`, "pointer-events": "none", class: "bridge" }));
  }
}

/** 路的样式：style（v5，PATH_STYLES 之一）；兼容 v4 的 tunnel 标记；不认识的当 path */
export function pathStyleOf(p) { const s = String((p && p.style) || (p && p.tunnel ? "tunnel" : "path")); return PATH_STYLES.includes(s) ? s : "path"; }
/** 沿折线每 step 米取点 [x, z, dx, dz]（dx / dz 单位切向；从 step / 2 起） */
function alongLine(points, step) {
  const out = [];
  let carry = step / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    let t = carry;
    for (; t <= L; t += step) out.push([a[0] + dx * t, a[1] + dz * t, dx, dz]);
    carry = t - L;
  }
  return out;
}
/** 折线向左（俯视）平移 o 米：每个顶点按相邻两段法线的平均挪 */
function offsetLine(P, o) {
  return P.map((q, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [q[0] - ((b[1] - a[1]) / L) * o, q[1] + ((b[0] - a[0]) / L) * o];
  });
}
/** 桥墩：[[x, z]] 或 [[x, y, z]] */
export const pierPoints = (p) => (Array.isArray(p.piers) ? p.piers : []).filter((q) => Array.isArray(q) && q.length >= 2).map((q) => (q.length >= 3 ? [q[0], q[2]] : [q[0], q[1]])).filter(isPt);
/** 传送门圆环（俯视） */
function portalRing(attrs, at, u) {
  return svgel("g", Object.assign({ class: "portal-ring", transform: `translate(${fmt1(at[0])} ${fmt1(at[1])})`, style: "cursor:pointer" }, attrs),
    svgel("circle", { r: fmt1(Math.max(2, 1.6 * u)), fill: "#b9a3e6", "fill-opacity": 0.35, stroke: SECTION_COLOR, "stroke-width": fmt1(0.35 * u) }),
    svgel("circle", { r: fmt1(Math.max(1, 0.8 * u)), fill: "none", stroke: SECTION_COLOR, "stroke-width": fmt1(0.2 * u) }));
}
/**
 * 有样式的路：road 宽灰 + 中线；stairs 台阶纹；ramp 坡向箭头；bridge 双线 + 桥墩点；rope_bridge 两条虚线 + 端桩；
 * tunnel 点线 + 洞口；canal 蓝双线；portal 两端圆环 + 淡虚线。可点的那条带 data-style。
 */
function drawStyledPath(R, p, st, w) {
  const { T, u, ground: g } = R, pid = p.plan_id || null, P = p.points, key = `path:${p.id}`, base = tag("path", pid, p.id, key, { "data-style": st });
  const W = Math.max(1, Number(p.width) || (st === "road" ? 4 : 2));
  const line = (attrs, pp = P) => svgel("polyline", Object.assign({ points: pts(pp), fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }, attrs));
  const quiet = { "pointer-events": "none", "data-for": key };
  const deco = svgel("g", Object.assign({ class: "path-deco" }, quiet));
  const ticks = (step, half, attrs) => { let d = ""; for (const [x, z, dx, dz] of alongLine(P, step)) d += `M${fmt1(x + dz * half)} ${fmt1(z - dx * half)}L${fmt1(x - dz * half)} ${fmt1(z + dx * half)}`; if (d) deco.append(svgel("path", Object.assign({ d, fill: "none" }, attrs))); };
  if (st === "road") {
    g.append(line(Object.assign({ stroke: "#6f675a", "stroke-width": fmt1(W * 0.85 + 0.6) }, quiet)), line(Object.assign({}, base, { stroke: "#b5ab98", "stroke-width": fmt1(W * 0.85) })));
    deco.append(line({ stroke: "#fff", "stroke-width": 0.25, "stroke-dasharray": "1.5 1.5", "stroke-linecap": "butt" }));
  } else if (st === "stairs") {
    g.append(line(Object.assign({}, base, { stroke: "#a8a090", "stroke-width": fmt1(Math.max(1.4, W * 0.8)) })));
    ticks(1.2, Math.max(0.7, W * 0.42), { stroke: "#5a4a2a", "stroke-width": 0.3, class: "path-steps" });
  } else if (st === "ramp") {
    g.append(line(Object.assign({}, base, { stroke: "#b8a77a", "stroke-width": fmt1(Math.max(1.4, W * 0.8)) })));
    const up = !T || T.heightAt(P[P.length - 1][0], P[P.length - 1][1]) >= T.heightAt(P[0][0], P[0][1]), all = alongLine(P, 1);
    const m = all[Math.floor(all.length / 2)];
    if (m) { const s = up ? 1 : -1, [x, z, dx, dz] = m, a = 1.2 * s, b = Math.max(0.7, W * 0.35); deco.append(svgel("path", { d: `M${fmt1(x - dx * a + dz * b)} ${fmt1(z - dz * a - dx * b)}L${fmt1(x + dx * a)} ${fmt1(z + dz * a)}L${fmt1(x - dx * a - dz * b)} ${fmt1(z - dz * a + dx * b)}`, fill: "none", stroke: "#5a4a2a", "stroke-width": 0.4, class: "ramp-arrow" })); }
  } else if (st === "bridge") {
    g.append(line(Object.assign({ stroke: "#5a4a2a", "stroke-width": fmt1(W + 0.9), "stroke-linecap": "butt" }, quiet)), line(Object.assign({}, base, { stroke: "#d9c3a0", "stroke-width": fmt1(W), "stroke-linecap": "butt" })));
    for (const q of pierPoints(p)) deco.append(svgel("circle", { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(clamp(W * 0.22, 0.45, 1.2)), fill: "#5a4a2a", class: "pier" }));
  } else if (st === "rope_bridge") {
    g.append(line(Object.assign({}, base, { stroke: "#000", "stroke-opacity": 0, "stroke-width": fmt1(W) })));
    for (const o of [-W / 2, W / 2]) deco.append(line({ stroke: "#8a6a44", "stroke-width": 0.35, "stroke-dasharray": "1.2 0.8", "stroke-linecap": "butt" }, offsetLine(P, o)));
    ticks(1.6, W / 2, { stroke: "#8a6a44", "stroke-width": 0.25, opacity: 0.7 });
    for (const q of [P[0], P[P.length - 1]]) for (const o of [-W / 2, W / 2]) { const [x, z] = offsetLine([q, q === P[0] ? P[1] : P[P.length - 2]], q === P[0] ? o : -o)[0]; deco.append(svgel("rect", { x: fmt1(x - 0.4), y: fmt1(z - 0.4), width: 0.8, height: 0.8, fill: "#5a4a2a", class: "rope-post" })); }
  } else if (st === "tunnel") {
    g.append(line(Object.assign({}, base, { stroke: "#5a4a3a", "stroke-width": fmt1(Math.max(1, W * 0.6)), "stroke-dasharray": `0.01 ${fmt1(Math.max(1.2, W * 0.9))}`, opacity: 0.9 })));
    for (const q of [P[0], P[P.length - 1]]) deco.append(svgel("circle", { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(Math.max(0.9, W * 0.5)), fill: "#3b342d", stroke: "#fff", "stroke-width": 0.25, class: "tunnel-mouth" }));
  } else if (st === "canal") {
    g.append(line(Object.assign({ stroke: "#4f7aa0", "stroke-width": fmt1(W + 0.8), "stroke-linecap": "butt" }, quiet)), line(Object.assign({}, base, { stroke: "#8fb7d8", "stroke-width": fmt1(W), "stroke-linecap": "butt" })));
  } else if (st === "portal") {
    g.append(line(Object.assign({}, base, { stroke: SECTION_COLOR, "stroke-opacity": 0.35, "stroke-width": 0.4, "stroke-dasharray": "1.5 1.2" })));
    for (const q of [P[0], P[P.length - 1]]) deco.append(portalRing({ "pointer-events": "none" }, q, u));
  }
  if (deco.childNodes.length) g.append(deco);
}
/** 传送门标记（markers kind portal） */
function drawPortals(R) {
  const { sid, u, ground: g } = R;
  for (const m of sid.markers || []) {
    if (!m || m.kind !== "portal" || !Array.isArray(m.position)) continue;
    const at = [m.position[0], m.position[2]];
    g.append(portalRing(Object.assign(tag("portal", m.plan_id || null, m.id, `portal:${m.id}`, { "data-pos": `${fmt1(at[0])} ${fmt1(at[1])}` }), { class: "portal-ring portal-marker" }), at, u));
    R.obs.ground.push([at[0] - 2.2, at[1] - 2.2, at[0] + 2.2, at[1] + 2.2, ICON_W]);
  }
}

// ------------------------------------------------------------ 房子 / 树 / 地标 / 形体
/** 地标俯视符号（原点在中心，按 9 m 宽设计） */
function landmarkGlyph(form) {
  const g = svgel("g", { "pointer-events": "none" }), fill = "#b8452b", stroke = "#4a1a10";
  if (form === "hall") g.append(svgel("path", { d: "M-4.5 1.5 L0 -4.5 L4.5 1.5 Z M-3.5 1.5 L3.5 1.5 L3.5 5 L-3.5 5 Z", fill, stroke, "stroke-width": 0.35 }));
  else if (form === "tower") g.append(svgel("rect", { x: -3, y: -3, width: 6, height: 6, fill, stroke, "stroke-width": 0.35 }), svgel("rect", { x: -1.6, y: -1.6, width: 3.2, height: 3.2, fill: "#fff", "fill-opacity": 0.6 }));
  else if (form === "gate") g.append(svgel("path", { d: "M-5 3 L-5 -2 L-3 -4 L3 -4 L5 -2 L5 3 M-2 3 L-2 -1 L2 -1 L2 3", fill: "none", stroke, "stroke-width": 0.9 }));
  else if (form === "pavilion") g.append(svgel("path", { d: "M0 -4.2 L3 -3 L4.2 0 L3 3 L0 4.2 L-3 3 L-4.2 0 L-3 -3 Z", fill, stroke, "stroke-width": 0.35 }), svgel("circle", { r: 1.2, fill: "#fff", "fill-opacity": 0.6 }));
  else if (form === "stage") g.append(svgel("rect", { x: -4.5, y: -3, width: 9, height: 6, fill, stroke, "stroke-width": 0.35 }), svgel("line", { x1: -4.5, x2: 4.5, y1: 3.6, y2: 3.6, stroke, "stroke-width": 0.9 }));
  else if (form === "bridge") g.append(svgel("rect", { x: -5, y: -1.5, width: 10, height: 3, fill: "#a0784a", stroke, "stroke-width": 0.35 }), svgel("path", { d: "M-3 -1.5 V1.5 M0 -1.5 V1.5 M3 -1.5 V1.5", stroke, "stroke-width": 0.3 }));
  else if (form === "wall") g.append(svgel("rect", { x: -5, y: -0.9, width: 10, height: 1.8, fill: "#7a6a55", stroke, "stroke-width": 0.35 }));
  else if (form === "well") g.append(svgel("circle", { r: 2.4, fill: "none", stroke, "stroke-width": 0.8 }), svgel("circle", { r: 1, fill: "#6f9bc2" }));
  else if (form === "tree") g.append(svgel("circle", { r: 4.2, fill: "#3f6b2a" }), svgel("circle", { r: 1, fill: "#5a3a1a" }));
  else if (form === "statue") g.append(svgel("path", { d: "M0 -3.5 L3 0 L0 3.5 L-3 0 Z", fill, stroke, "stroke-width": 0.35 }));
  else if (form === "round_house") g.append(svgel("circle", { r: 4, fill, stroke, "stroke-width": 0.35 }), svgel("circle", { r: 2, fill: "#fff", "fill-opacity": 0.6 }));
  else g.append(svgel("rect", { x: -3.5, y: -3.5, width: 7, height: 7, fill, stroke, "stroke-width": 0.35 }));
  return g;
}
/** 椭圆的 path 段（闭合，原点为心） */
const ellD = (rx, rz) => `M${fmt1(-rx)} 0A${fmt1(rx)} ${fmt1(rz)} 0 1 0 ${fmt1(rx)} 0A${fmt1(rx)} ${fmt1(rz)} 0 1 0 ${fmt1(-rx)} 0Z`;
/**
 * 形体俯视符号（局部坐标：原点在中心，x 向右、y = 局部 z 向下；外层 g 负责平移 + 旋转）。
 * box / wedge / pyramid 矩形（pyramid 加对角线、wedge 加坡向箭头，箭头指向高的一边 = 局部 −z）；cylinder / cone / dome / sphere 椭圆
 * （cone 中心点、dome 同心弧、sphere 高光）；torus 环；prism n 边形；arch 两腿 + 拱线；building / tower 按屋顶加纹样；island 加草顶。
 */
function shapeGlyph(v, fill, edge, small) {
  const sh = shapeOf(v), [w, , d] = volDims(v), rx = w / 2, rz = d / 2, out = [], body = Object.assign({ fill, class: "shape-body" }, edge);
  const mark = (tagName, attrs) => out.push(svgel(tagName, Object.assign({ fill: "none", stroke: "#fff", "stroke-opacity": 0.6, "stroke-width": 0.3, "pointer-events": "none", class: "shape-mark" }, attrs)));
  const rect = (x, y, ww, hh, extra = {}) => svgel("rect", Object.assign({ x: fmt1(x), y: fmt1(y), width: fmt1(ww), height: fmt1(hh) }, body, extra));
  const ell = () => svgel("ellipse", Object.assign({ rx: fmt1(rx), ry: fmt1(rz) }, body));
  const arcs = (cls) => { for (const k of [0.62, 0.32]) mark("path", { d: `M${fmt1(-rx * k)} 0A${fmt1(rx * k)} ${fmt1(rz * k)} 0 0 1 ${fmt1(rx * k)} 0`, class: cls }); };
  switch (sh) {
    case "cylinder": {
      const R = ringOf(v); // 空心圆柱 = 一圈带子：画环（中间是空的，孔里的东西看得见）
      if (R && !R.torus && R.ix > 0.2) { out.push(svgel("path", Object.assign({ d: ellD(rx, rz) + ellD(R.ix, R.iz), "fill-rule": "evenodd", class: "shape-body ring-band" }, body, { class: "shape-body ring-band" }))); mark("ellipse", { rx: fmt1((rx + R.ix) / 2), ry: fmt1((rz + R.iz) / 2), "stroke-dasharray": "1 1", class: "shape-mark ring-mid" }); }
      else out.push(ell());
      break;
    }
    case "cone": out.push(ell()); mark("circle", { r: fmt1(clamp(Math.min(rx, rz) * 0.14, 0.3, 1.2)), fill: "#222", "fill-opacity": 0.7, stroke: "none", class: "shape-mark cone-apex" }); break;
    case "dome": out.push(ell()); arcs("shape-mark dome-arc"); break;
    case "sphere": out.push(ell()); mark("ellipse", { cx: fmt1(-rx * 0.32), cy: fmt1(-rz * 0.32), rx: fmt1(rx * 0.22), ry: fmt1(rz * 0.22), fill: "#fff", "fill-opacity": 0.45, stroke: "none" }); break;
    case "torus": {
      if (isUpright(v)) { const t = Math.max(0.6, d); out.push(rect(-rx, -t / 2, w, t, { rx: fmt1(t / 2), class: "shape-body torus-upright" })); mark("line", { x1: fmt1(-rx + t / 2), x2: fmt1(rx - t / 2), y1: 0, y2: 0, "stroke-dasharray": "0.8 0.6", class: "shape-mark torus-upright-axis" }); break; } // 立起来的环：俯视是一条线段
      const t = torusTube(v), ix = Math.max(0.2, rx - t), iz = Math.max(0.2, rz - t * (rz / rx)); out.push(svgel("path", Object.assign({ d: ellD(rx, rz) + ellD(ix, iz), "fill-rule": "evenodd" }, body))); break; }
    case "prism": { const n = prismSides(v); out.push(svgel("polygon", Object.assign({ points: pts(Array.from({ length: n }, (_, k) => { const a = (2 * Math.PI * k) / n - Math.PI / 2; return [rx * Math.cos(a), rx * Math.sin(a)]; })) }, body))); break; }
    case "pyramid": out.push(rect(-rx, -rz, w, d)); mark("path", { d: `M${fmt1(-rx)} ${fmt1(-rz)}L${fmt1(rx)} ${fmt1(rz)}M${fmt1(rx)} ${fmt1(-rz)}L${fmt1(-rx)} ${fmt1(rz)}`, stroke: "#222", "stroke-opacity": 0.55, class: "shape-mark pyramid-diag" }); break;
    case "wedge": { out.push(rect(-rx, -rz, w, d)); const a = rz * 0.7, b = Math.min(rx, rz) * 0.35; mark("path", { d: `M0 ${fmt1(a)}L0 ${fmt1(-a)}M${fmt1(-b)} ${fmt1(-a + b)}L0 ${fmt1(-a)}L${fmt1(b)} ${fmt1(-a + b)}`, stroke: "#222", "stroke-opacity": 0.7, "stroke-width": 0.35, class: "shape-mark wedge-arrow" }); break; }
    case "arch": {
      const t = archThickness(v);
      out.push(rect(-rx + t, -rz, w - 2 * t, d, { "fill-opacity": 0.3, class: "shape-body arch-span" }), rect(-rx, -rz, t, d, { class: "shape-body arch-leg" }), rect(rx - t, -rz, t, d, { class: "shape-body arch-leg" }));
      mark("line", { x1: fmt1(-rx + t), x2: fmt1(rx - t), y1: 0, y2: 0, stroke: "#222", "stroke-opacity": 0.6, "stroke-dasharray": "0.8 0.5", class: "shape-mark arch-line" });
      break;
    }
    default: out.push(rect(-rx, -rz, w, d));
  }
  if (v.kind === "island") out.push(svgel(ROUND_SHAPES.has(sh) ? "ellipse" : "rect", Object.assign(ROUND_SHAPES.has(sh) ? { rx: fmt1(rx * 0.78), ry: fmt1(rz * 0.78) } : { x: fmt1(-rx * 0.78), y: fmt1(-rz * 0.78), width: fmt1(w * 0.78), height: fmt1(d * 0.78) }, { fill: "#7d9a5f", "fill-opacity": 0.75, "pointer-events": "none", class: "island-top" })));
  const r = roofOf(v);
  if (r && !small) {
    const round = ROUND_SHAPES.has(sh), mn = Math.min(rx, rz), m = (dd, extra = {}) => mark("path", Object.assign({ d: dd, class: "roof-mark" }, extra));
    if (r.type === "gable") m(round || rx >= rz ? `M${fmt1(-rx * (round ? 0.8 : 1) + (round ? 0 : 0.6))} 0L${fmt1(rx * (round ? 0.8 : 1) - (round ? 0 : 0.6))} 0` : `M0 ${fmt1(-rz + 0.6)}L0 ${fmt1(rz - 0.6)}`);
    else if (r.type === "hip") {
      if (round) m(`M${fmt1(-rx * 0.7)} 0L${fmt1(rx * 0.7)} 0M0 ${fmt1(-rz * 0.7)}L0 ${fmt1(rz * 0.7)}`);
      else if (rx >= rz) { const e = rx - rz; m(`M${fmt1(-e)} 0L${fmt1(e)} 0M${fmt1(-rx)} ${fmt1(-rz)}L${fmt1(-e)} 0L${fmt1(-rx)} ${fmt1(rz)}M${fmt1(rx)} ${fmt1(-rz)}L${fmt1(e)} 0L${fmt1(rx)} ${fmt1(rz)}`); }
      else { const e = rz - rx; m(`M0 ${fmt1(-e)}L0 ${fmt1(e)}M${fmt1(-rx)} ${fmt1(-rz)}L0 ${fmt1(-e)}L${fmt1(rx)} ${fmt1(-rz)}M${fmt1(-rx)} ${fmt1(rz)}L0 ${fmt1(e)}L${fmt1(rx)} ${fmt1(rz)}`); }
    } else if (r.type === "dome") arcs("roof-mark");
    else if (r.type === "spire") {
      const star = Array.from({ length: 8 }, (_, k) => { const a = (Math.PI * k) / 4 - Math.PI / 2, rr = k % 2 ? mn * 0.18 : mn * 0.5; return [rr * Math.cos(a), rr * Math.sin(a)]; });
      mark("polygon", { points: pts(star), fill: "#fff", "fill-opacity": 0.75, stroke: "#222", "stroke-opacity": 0.5, "stroke-width": 0.2, class: "roof-mark" });
    }
  }
  return out;
}
/** 带 v4 符号的地标 form（这些仍叠画旧符号） */
const GLYPH_FORMS = new Set(["hall", "tower", "gate", "pavilion", "stage", "bridge", "wall", "well", "tree", "statue", "round_house"]);
function drawVolumes(R) {
  const { sid, T, u, small, ground: g, label, groundLabels } = R, pal = paletteOf(sid), focus = landmarkOf(sid);
  const vols = (sid.volumes || []).filter((v) => v && Array.isArray(v.position) && Array.isArray(v.size));
  // 俯视的画家算法：低的先画、高的盖上去（悬空的在上面）；同高保持原顺序
  const tops = new Map(vols.map((v) => [v, volumeTop(v, T)]));
  const order = vols.map((v, i) => [v, i]).sort((a, b) => tops.get(a[0]) - tops.get(b[0]) || a[1] - b[1]).map((x) => x[0]);
  const groupLabel = new Map(), elevLabel = new Map();
  for (const v of order) {
    const [x, , z] = v.position, type = volumeType(v), sh = shapeOf(v), [w, , d] = volDims(v), e = elevOf(v), lm = type === "landmark";
    // v4 的树：只画一个绿点，不可点
    if (v.kind === "prop" && !v.plan_id && !lm) { g.append(svgel("circle", { cx: fmt1(x), cy: fmt1(z), r: fmt1(Math.max(1.2, (w / 2) * 0.6)), fill: pal.foliage, opacity: 0.85, "pointer-events": "none" })); continue; }
    const key = `${type}:${v.id}`, pid = v.plan_id || v.zone_id || (lm ? v.id : null), r = roofOf(v);
    const n = svgel("g", Object.assign(tag(type, pid, v.id, key, { "data-zone-id": v.zone_id || null, "data-pos": `${fmt1(x)} ${fmt1(z)}`, "data-shape": sh, "data-kind": v.kind || null, "data-roof": r ? r.type : null, "data-elev": e > 0.5 ? fmt1(e) : null, "data-instance-of": v.instance_of || null }),
      { class: lm ? "landmark volume" : "volume", transform: `translate(${fmt1(x)} ${fmt1(z)}) rotate(${fmt1(-(v.rotation_y || 0))})`, style: "cursor:pointer" }));
    const edge = { stroke: v.locked ? "#b8452b" : lm ? "#4a1a10" : "#222", "stroke-width": v.locked ? 0.5 : lm ? 0.35 : 0.25, "stroke-dasharray": e > 0.5 ? "1 0.6" : null, "fill-opacity": e > 0.5 ? 0.6 : null };
    const oldGlyph = lm && v.form && GLYPH_FORMS.has(v.form) && (sh === "box" || sh === "cylinder");
    if (oldGlyph) { if (!small) n.append(...shapeGlyph(v, "#b8452b", Object.assign({}, edge, { "fill-opacity": 0.25, "stroke-width": 0.3 }), true)); const gl = landmarkGlyph(v.form); gl.setAttribute("transform", `scale(${fmt1(clamp(Math.max(w, d) / 9, 0.45, 1.2))})`); n.append(gl); }
    else n.append(...shapeGlyph(v, volumeColor(v, pal, "top"), edge, small));
    if (type === "house" && sh === "box" && !small) {
      n.append(svgel("rect", { x: -0.9, y: fmt1(-d / 2 - 0.3), width: 1.8, height: 1, fill: "#fff", stroke: "#222", "stroke-width": 0.2, "pointer-events": "none" }));
      if (v.form === "stilt_house" || v.stilt_m > 0) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) n.append(svgel("circle", { cx: fmt1((sx * w) / 2), cy: fmt1((sz * d) / 2), r: 0.45, fill: "#6b4f2a", "pointer-events": "none" }));
    }
    g.append(n);
    const bb = aabb(v);
    if (ringOf(v)) for (const q of footRects(v, 8)) { const xs = q.map((p) => p[0]), zs = q.map((p) => p[1]); R.obs.ground.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]); }
    else R.obs.ground.push(bb);
    if (small) continue;
    if (lm) groundLabels.append(label(Object.assign(tag("landmark", pid, v.id, key), { x: fmt1(x), y: fmt1(bb[1] - 1.5 * u), "font-size": fmt1((v === focus ? 2.9 : 2.6) * u), "font-weight": v === focus ? 700 : null, "text-anchor": "middle", fill: "#4a1a10", style: "cursor:pointer" }), v.label || FORM_LABEL[v.form] || "地标", { rank: 1 }));
    // 名字与「↑N m」每组一个：同一模板的实例（instance_of / plan_id 去掉 [k]）算一组，不然环形 8 座宿舍就有 8 个名字
    const gk = String(v.instance_of || pid || "").replace(/\[\d+\]/g, "") || null; // 嵌套重复（signs[2]/stack）也归成一组
    if (!lm && type === "shape" && v.label && gk && !v.plinth_of && !groupLabel.has(gk)) groupLabel.set(gk, { v, key, bb, pid }); // 基座不出名字（名字给它垫着的那块）
    const ek = gk || v.id;
    if (e > 0.5 && (!elevLabel.has(ek) || elevLabel.get(ek).e < e)) elevLabel.set(ek, { v, e, key, bb, pid });
  }
  if (small) return;
  // 同心的几圈环（环墙、墙顶环道、外墙立面、环形花槽）只标最外一圈；孔里的东西（院地、水池）标在它自己中间，不标到环带上
  const rings = vols.map((v) => [v, ringOf(v)]).filter(([, q]) => q && !q.torus && q.ix > 0.2).map(([v, q]) => ({ v, c: [v.position[0], v.position[2]], r: (q.rx + q.rz) / 2, ri: (q.ix + q.iz) / 2 }));
  const ringOf_ = (v) => rings.find((q) => q.v === v);
  const outer = (q) => !rings.some((o) => o !== q && Math.hypot(o.c[0] - q.c[0], o.c[1] - q.c[1]) < 3 && (o.r > q.r + 0.3 || (Math.abs(o.r - q.r) <= 0.3 && rings.indexOf(o) < rings.indexOf(q))));
  for (const { v, key, bb, pid } of groupLabel.values()) {
    const rq = ringOf_(v);
    if (rq && !outer(rq)) continue;
    const inHole = !rq && rings.some((q) => Math.hypot(v.position[0] - q.c[0], v.position[2] - q.c[1]) < q.ri - 1);
    groundLabels.append(label(Object.assign(tag("shape", pid, v.id, key), { x: fmt1(v.position[0]), y: fmt1(inHole ? v.position[2] + 0.8 * u : bb[1] - 1.2 * u), "font-size": fmt1(2.3 * u), "text-anchor": "middle", fill: "#3d3a33", style: "cursor:pointer", "data-plan-root": (v.plan_path || [])[0] || null }), v.label, { rank: 6, optional: true }));
  }
  for (const { v, e, key, bb, pid } of elevLabel.values()) groundLabels.append(label({ x: fmt1(bb[2] + 0.6 * u), y: fmt1(bb[1] + 2 * u), "font-size": fmt1(2 * u), fill: "#2a6aa6", "pointer-events": "none", "data-for": key, "data-elev-label": pid || v.id }, `↑${Math.round(e)} m`, { rank: 7 }));
}
/** 区域名字放哪：形心在区域里（不在内孔里、水面真的盖着它）就用形心，否则取离边最远的格点（湖的名字在水上，不在湖心岛 / 岩柱上） */
function labelPoint(poly, hole, wet) {
  const c = polygonCentroid(poly), ok = (q) => pointInPolygon(q, poly) && !(hole && pointInPolygon(q, hole)) && (!wet || wet(q));
  if (ok(c)) return c;
  const xs = poly.map((q) => q[0]), zs = poly.map((q) => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), st = Math.max(1, Math.max(x1 - x0, z1 - z0) / 28);
  let best = c, bd = -1;
  for (let z = z0 + st / 2; z < z1; z += st) for (let x = x0 + st / 2; x < x1; x += st) {
    const q = [x, z];
    if (!ok(q)) continue;
    let dry = Infinity; // 水面：离露出水面的地（湖心岛、岩柱）也要远
    if (wet) for (const r of [3, 6, 12, 24]) { if ([0, 1, 2, 3, 4, 5, 6, 7].some((k) => { const a = (k * Math.PI) / 4, p = [x + r * Math.cos(a), z + r * Math.sin(a)]; return pointInPolygon(p, poly) && !wet(p); })) { dry = r; break; } }
    const d = Math.min(distToPolygon(q, poly), hole ? distToPolygon(q, hole) : Infinity, dry) + z * 1e-3; // 一样宽时偏南（靠近出生点那一侧）
    if (d > bd) { bd = d; best = q; }
  }
  return best;
}
/** 体块俯视外接框 [x0, z0, x1, z1] */
const aabb = (v) => {
  const P = footprintPolygon(v), xs = P.map((q) => q[0]), zs = P.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
};

// ------------------------------------------------------------ 出生点与第一眼视锥（看不见主地标时变红）
function drawSpawn(R) {
  const { sid, u, small, ground: g, label, groundLabels, ctx } = R, sp = spawnOf(sid);
  if (!sp) return;
  const [ex, , ez] = sp.position, lm = landmarkOf(sid), key = `spawn:${sp.id}`, b = sid.bounds;
  const th = ((sp.rotation_y || 0) * Math.PI) / 180, ang = Math.atan2(-Math.cos(th), -Math.sin(th));
  const L = lm ? Math.hypot(lm.position[0] - ex, lm.position[2] - ez) * 0.8 : 30;
  const col = ctx.eye && ctx.eye.landmark_visible === false ? "#c0392b" : "#1f6feb";
  for (const da of [-1, 1].map((k) => (k * (EYE_FOV_DEG / 2) * Math.PI) / 180)) g.append(svgel("line", { x1: fmt1(ex), y1: fmt1(ez), x2: fmt1(ex + Math.cos(ang + da) * L), y2: fmt1(ez + Math.sin(ang + da) * L), stroke: col, "stroke-width": 0.35, "stroke-dasharray": "1 1", opacity: 0.45, "pointer-events": "none", "data-for": key }));
  const n = svgel("g", Object.assign(tag("spawn", sp.plan_id || "spawn", sp.id, key, { "data-pos": `${fmt1(ex)} ${fmt1(ez)}` }), { class: "spawn", transform: `translate(${fmt1(ex)} ${fmt1(ez)}) rotate(${fmt1(-(sp.rotation_y || 0))})`, style: "cursor:pointer" }));
  n.append(svgel("path", { d: "M0 -4.5 L3.2 3 L-3.2 3 Z", fill: "#1f6feb", stroke: "#fff", "stroke-width": 0.5 }));
  g.append(n);
  R.obs.ground.push([ex - 3.5, ez - 4.5, ex + 3.5, ez + 3.5, ICON_W]);
  if (!small) { const right = ex < b.min[0] + (b.max[0] - b.min[0]) * 0.6; groundLabels.append(label(Object.assign(tag("spawn", sp.plan_id || "spawn", sp.id, key), { x: fmt1(right ? ex + 5 * u : ex - 5 * u), y: fmt1(ez + 1 * u), "text-anchor": right ? "start" : "end", "font-size": fmt1(2.7 * u), fill: "#1f6feb" }), `出生点 · 看向${lm ? lm.label || "地标" : "北"}`, { rank: 2 })); }
}

// ------------------------------------------------------------ 地下 / 空中空间
/** 空间：别的层只画淡轮廓；当前层画内部平面（岩层底 → 其它内部层淡画 → 当前内部层：通道按真实宽度、房间填色、入口 / 终点、层间连接） */
function drawSpaces(R) {
  const { sid, T, u, small, stratum, label, labels, ctx } = R;
  const spaces = (sid.spaces || []).filter((x) => x && validPoly(x.polygon) && SPACE_STYLE[x.stratum]);
  if (!spaces.length) return;
  const g = svgel("g", { class: "spaces" });
  R.svg.append(g); // 盖在地面层（与剖切带）之上
  for (const sp of spaces.slice().sort((a, b) => (a.stratum === stratum) - (b.stratum === stratum))) {
    const st = SPACE_STYLE[sp.stratum], active = sp.stratum === stratum, pid = sp.plan_id || sp.id, key = `space:${pid}`;
    const c = planCenter(sid, T, pid) || polygonCentroid(sp.polygon), base = tag("space", pid, sp.id, key, { "data-center": `${c[0]} ${c[1]}`, "data-stratum": sp.stratum });
    const xs = sp.polygon.map((p) => p[0]), zs = sp.polygon.map((p) => p[1]), top = [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...zs)];
    if (!active || small) {
      const onG = stratum === "ground";
      g.append(svgel("polygon", Object.assign({}, base, { points: pts(sp.polygon), fill: st.fill, "fill-opacity": st.fillOpacity, stroke: st.stroke, "stroke-width": fmt1(0.4 * u), "stroke-dasharray": st.dash, "stroke-linejoin": "round", opacity: onG ? 0.75 : 0.3,
        "pointer-events": onG && !small ? null : "none", "data-inactive": onG && !small ? null : 1, style: onG ? "cursor:move" : null })));
      if (onG && !small) labels.append(label(Object.assign({}, base, { x: fmt1(top[0]), y: fmt1(top[1] - 1 * u), "font-size": fmt1(2.3 * u), "text-anchor": "middle", fill: st.text, style: "cursor:pointer" }), `${sp.label || pid} · ${layoutName(sp)} · ${spaceLevelTag(sp, sid, T)}`, { rank: 3 }));
      continue;
    }
    const n = levelsOf(sp), cur = sublevelOf(sp, ctx.interiorLevel), gs = svgel("g", { class: "space-interior", "data-for": key });
    const dense = ["maze", "galleries"].includes(sp.layout);
    gs.append(svgel("polygon", Object.assign({}, base, { points: pts(sp.polygon), fill: st.rock, "fill-opacity": dense ? st.rockOpacity : st.rockOpacity * 0.5, stroke: st.stroke, "stroke-width": fmt1(0.5 * u), "stroke-dasharray": sp.stratum === "sky" ? "2 1" : null, "stroke-linejoin": "round", style: "cursor:move" })));
    const P = (sp.passages || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2 && p.points.every(isPt));
    const Rm = (sp.rooms || []).filter((r) => r && validPoly(r.polygon));
    const labelled = (r) => !small && !["entry", "goal", "chamber"].includes(r.role); // 房间名画不画
    const part = (type, o) => Object.assign(tag(type, pid, sp.id, key, { "data-part": o.id, "data-sublevel": o.sublevel | 0 }), { style: "cursor:pointer" });
    // 其它内部层：细虚线 / 虚边，不接手势
    if (n > 1) {
      const ghost = svgel("g", { class: "interior-ghost", opacity: 0.55, "pointer-events": "none" });
      for (const p of P) if ((p.sublevel | 0) !== cur) ghost.append(svgel("polyline", { points: pts(p.points), fill: "none", stroke: st.ghost, "stroke-width": fmt1(Math.max(0.5, (p.width || 2) * 0.35)), "stroke-dasharray": "1.2 0.8", "stroke-linejoin": "round" }));
      for (const r of Rm) if ((r.sublevel | 0) !== cur) ghost.append(svgel("polygon", { points: pts(r.polygon), fill: "none", stroke: st.ghost, "stroke-width": 0.4, "stroke-dasharray": "1 0.8" }));
      gs.append(ghost);
    }
    // 当前内部层：通道（真实宽度）→ 房间 → 入口 / 终点 / 层间连接
    if (!dense) for (const p of P) if ((p.sublevel | 0) === cur) gs.append(svgel("polyline", { points: pts(p.points), fill: "none", stroke: st.stroke, "stroke-width": fmt1((p.width || 2) + 0.7), "stroke-linecap": "square", "stroke-linejoin": "miter", "pointer-events": "none" }));
    for (const p of P) if ((p.sublevel | 0) === cur) gs.append(svgel("polyline", Object.assign(part("passage", p), { points: pts(p.points), fill: "none", stroke: st.way, "stroke-width": fmt1(p.width || 2), "stroke-linecap": "square", "stroke-linejoin": "miter", "stroke-miterlimit": 4, class: "passage" })));
    for (const r of Rm) {
      if ((r.sublevel | 0) !== cur) continue;
      gs.append(svgel("polygon", Object.assign(part("room", r), { points: pts(r.polygon), fill: ROOM_FILL[r.role] || ROOM_FILL.chamber, stroke: sp.stratum === "sky" ? "#6b4f2a" : "#2a241f", "stroke-width": 0.3, class: "room" }), svgel("title", {}, `${r.label || ROLE_LABEL[r.role] || "房间"} · ${interiorLevelName(sp, cur)}`)));
      if (labelled(r)) { const rc = polygonCentroid(r.polygon); labels.append(label(Object.assign(part("room", r), { x: fmt1(rc[0]), y: fmt1(rc[1] + 0.8 * u), "font-size": fmt1(2 * u), "text-anchor": "middle", fill: "#3b2f20" }), r.label || ROLE_LABEL[r.role] || "房间", { rank: 0.6, optional: r.role === "stope" })); }
    }
    // 地面标签在地下 / 空中视图要躲开当前内部层（房间、通道；迷宫 / 矿道整块）
    const ob = R.obs.interior, bb = (ps, e = 0) => { const xs = ps.map((q) => q[0]), zs = ps.map((q) => q[1]); return [Math.min(...xs) - e, Math.min(...zs) - e, Math.max(...xs) + e, Math.max(...zs) + e]; };
    if (dense) ob.push(bb(sp.polygon));
    else {
      for (const r of Rm) if ((r.sublevel | 0) === cur) ob.push(bb(r.polygon, 0.5));
      for (const p of P) if ((p.sublevel | 0) === cur) for (let k = 1; k < p.points.length; k++) ob.push(bb([p.points[k - 1], p.points[k]], (p.width || 2) / 2 + 0.5));
    }
    const mark = (p0, txt, fill, title, kind) => {
      // 落在一个有名字的房间中间时挪到名字左边（不盖住房间名）
      let p = p0;
      const room = Rm.find((r) => (r.sublevel | 0) === cur && labelled(r) && pointInPolygon(p0, r.polygon));
      if (room) {
        const rc = polygonCentroid(room.polygon), lw = textWidth(room.label || ROLE_LABEL[room.role] || "房间", 2 * u);
        if (Math.abs(p0[0] - rc[0]) < lw / 2 + 2 * u && Math.abs(p0[1] - rc[1]) < 2.5 * u) p = [rc[0] - lw / 2 - 2.1 * u, rc[1]];
      }
      const m = svgel("g", Object.assign(tag(kind, pid, sp.id, key, { "data-part": kind }), { transform: `translate(${fmt1(p[0])} ${fmt1(p[1])})`, class: kind, style: "cursor:pointer" }),
        svgel("circle", { r: fmt1(1.7 * u), fill, stroke: "#fff", "stroke-width": fmt1(0.35 * u) }),
        svgel("text", { y: fmt1(0.75 * u), "font-size": fmt1(2 * u), "text-anchor": "middle", fill: "#fff", "font-weight": 700, "pointer-events": "none" }, txt), svgel("title", {}, title));
      gs.append(m); R.obs.strata.push([p[0] - 1.8 * u, p[1] - 1.8 * u, p[0] + 1.8 * u, p[1] + 1.8 * u, ICON_W]);
    };
    const conn = (sid.markers || []).find((m) => m && m.kind === "connector" && (m.to === sp.id || m.from === sp.id));
    if (isPt(sp.entrance) && entryLevel(sp) === cur) mark(sp.entrance, "入", "#2f8f4e", `${sp.label || pid} 入口${conn ? `（${conn.label || VIA_LABEL[conn.via] || "连接点"}）` : ""}`, "entrance");
    if (isPt(sp.goal) && goalLevel(sp) === cur) mark(sp.goal, "终", "#c0392b", `${sp.label || pid} 终点`, "goal");
    for (const l of sp.links || []) {
      if (!l || !isPt(l.at) || ((l.from | 0) !== cur && (l.to | 0) !== cur)) continue;
      const other = (l.from | 0) === cur ? l.to | 0 : l.from | 0, k = interiorIndexOf(sp, other), deeper = interiorIndexOf(sp, other) > interiorIndexOf(sp, cur);
      const m = svgel("g", Object.assign(tag("link", pid, sp.id, key, { "data-part": l.id, "data-level": k }), { transform: `translate(${fmt1(l.at[0])} ${fmt1(l.at[1])})`, class: "link", style: "cursor:pointer" }),
        svgel("rect", { x: fmt1(-1.5 * u), y: fmt1(-1.5 * u), width: fmt1(3 * u), height: fmt1(3 * u), rx: fmt1(0.4 * u), fill: "#fff", stroke: "#6b4f2a", "stroke-width": fmt1(0.3 * u) }),
        svgel("text", { y: fmt1(0.75 * u), "font-size": fmt1(2.1 * u), "text-anchor": "middle", fill: "#6b4f2a", "font-weight": 700, "pointer-events": "none" }, `${deeper === (sp.stratum !== "sky") ? "↓" : "↑"}${k + 1}`),
        svgel("title", {}, `${VIA_LABEL[l.via] || "连接"}：通内部第 ${k + 1} 层`));
      gs.append(m); R.obs.strata.push([l.at[0] - 1.6 * u, l.at[1] - 1.6 * u, l.at[0] + 1.6 * u, l.at[1] + 1.6 * u, ICON_W]);
    }
    g.append(gs);
    if (!small) labels.append(label(Object.assign({}, base, { x: fmt1(top[0]), y: fmt1(top[1] - 1.2 * u), "font-size": fmt1(2.5 * u), "font-weight": 700, "text-anchor": "middle", fill: st.text, style: "cursor:pointer" }),
      `${sp.label || pid} · ${layoutName(sp)}${n > 1 ? ` · ${interiorLevelName(sp, cur)} / 共 ${n} 层` : ""} · ${spaceLevelTag(sp, sid, T)}`, { rank: 0 }));
  }
}

/** 连接点图标（单位框 ±1.6，按 u 缩放） */
const VIA_GLYPH = {
  stairs: "M-1 1 H-0.3 V0.3 H0.4 V-0.4 H1.1 V-1", ladder: "M-0.6 -1.1 V1.1 M0.6 -1.1 V1.1 M-0.6 -0.5 H0.6 M-0.6 0.1 H0.6 M-0.6 0.7 H0.6",
  well: "M-0.9 0 A0.9 0.9 0 1 0 0.9 0 A0.9 0.9 0 1 0 -0.9 0 M-0.35 0 A0.35 0.35 0 1 0 0.35 0 A0.35 0.35 0 1 0 -0.35 0",
  shaft: "M-0.9 -0.9 H0.9 V0.9 H-0.9 Z M-0.9 -0.9 L0.9 0.9 M0.9 -0.9 L-0.9 0.9", elevator: "M-0.9 -0.9 H0.9 V0.9 H-0.9 Z M0 -0.6 V0.6 M-0.4 -0.2 L0 -0.6 L0.4 -0.2",
  rope_bridge: "M-1.1 -0.4 Q0 0.8 1.1 -0.4 M-1.1 -0.4 V0.6 M1.1 -0.4 V0.6", ramp: "M-1.1 1 L1.1 -1 M-1.1 1 H1.1",
};
/** 地面 ↔ 空间的连接点：图标 + 竖向箭头（下行深色、上行浅蓝）；连到当前层的画实 */
function drawConnectors(R) {
  const { sid, u, small, stratum, label, labels } = R;
  const conns = (sid.markers || []).filter((m) => m && m.kind === "connector" && Array.isArray(m.position));
  if (!conns.length) return;
  const byId = new Map((sid.spaces || []).map((s) => [s.id, s])), g = svgel("g", { class: "connectors" });
  for (const m of conns) {
    const strata = [m.from, m.to].filter((e) => e !== "ground" && byId.has(e)).map((e) => byId.get(e).stratum);
    const down = strata.includes("underground"), up = strata.includes("sky"), active = stratum === "ground" || strata.includes(stratum);
    const [x, , z] = m.position, k = u * 0.9, key = `connector:${m.id}`, pid = m.plan_id || null;
    const to = byId.get(m.to) || byId.get(m.from);
    if (stratum !== "ground" && to && to.stratum === stratum && Array.isArray(to.entrance) && Math.hypot(to.entrance[0] - x, to.entrance[1] - z) < 3) continue;
    const n = svgel("g", Object.assign(tag("connector", pid, m.id, key, { "data-pos": `${fmt1(x)} ${fmt1(z)}` }), { class: "connector", transform: `translate(${fmt1(x)} ${fmt1(z)})`, opacity: active ? 1 : 0.35, "pointer-events": active ? null : "none", "data-inactive": active ? null : 1, style: active ? "cursor:move" : null }));
    const box = svgel("g", { transform: `scale(${fmt1(k * 100) / 100})` });
    box.append(svgel("rect", { x: -1.6, y: -1.6, width: 3.2, height: 3.2, rx: 0.6, fill: "#fff", stroke: "#333", "stroke-width": 0.28 }));
    box.append(svgel("path", { d: VIA_GLYPH[m.via] || VIA_GLYPH.stairs, fill: "none", stroke: "#333", "stroke-width": 0.28, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    let d = "M2.6 -1.5 V1.5";
    if (down || !up) d += " M1.9 0.8 L2.6 1.6 L3.3 0.8";
    if (up) d += " M1.9 -0.8 L2.6 -1.6 L3.3 -0.8";
    box.append(svgel("path", { d, fill: "none", stroke: down && !up ? SPACE_STYLE.underground.arrow : SPACE_STYLE.sky.arrow, "stroke-width": 0.42, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    n.append(box); g.append(n);
    const box4 = [x - 1.6 * u, z - 1.6 * u, x + 3.2 * u, z + 1.6 * u, ICON_W];
    R.obs.ground.push(box4); if (active) R.obs.strata.push(box4);
    if (!small) labels.append(label({ x: fmt1(x + 3.6 * k), y: fmt1(z + 0.8 * u), "font-size": fmt1(2.1 * u), fill: "#333", opacity: active ? 1 : 0.5, "pointer-events": "none", "data-for": key }, m.label || "连接点", { rank: active && stratum !== "ground" ? 0.5 : 3.5, optional: true }));
  }
  R.svg.append(g);
}

/** 主路折点把手（地面层、移动工具；首尾跟着入口 / 地标走，不给把手） */
function drawTrailHandles(R) {
  const { sid, u, ctx } = R, trail = mainTrailOf(sid);
  if (!trail || !trail.points || trail.points.length <= 2 || !(ctx.tool == null || ["move", "pin", "select"].includes(ctx.tool))) return;
  const hg = svgel("g", { class: "trail-handles" });
  trail.points.forEach((q, i) => { if (i > 0 && i < trail.points.length - 1) hg.append(svgel("circle", Object.assign(tag("trail_vertex", trail.plan_id, trail.id, `trail_vertex:${i}`, { "data-index": i, "data-pos": `${fmt1(q[0])} ${fmt1(q[1])}` }), { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(0.9 * u), fill: "#fff", stroke: "#8b7d5b", "stroke-width": fmt1(0.35 * u), style: "cursor:move" }))); });
  R.svg.append(hg);
}

/** 读回差异：红点（意图位置）→ 圈（引擎实际位置） */
function drawDiffs(R) {
  const { u, label, labels, ctx } = R, ds = svgel("g", { class: "diffs" });
  for (const d of ctx.diffs || []) {
    if (!d.from) continue;
    if (d.to) ds.append(svgel("line", { x1: d.from[0], y1: d.from[1], x2: d.to[0], y2: d.to[1], stroke: "#c0392b", "stroke-width": 0.5, "stroke-dasharray": "1 0.8" }));
    ds.append(svgel("circle", { cx: d.from[0], cy: d.from[1], r: 1.6, fill: "#c0392b", stroke: "#fff", "stroke-width": 0.4, "data-diff": d.id, style: "cursor:pointer" }));
    if (d.to) ds.append(svgel("circle", { cx: d.to[0], cy: d.to[1], r: 1.2, fill: "none", stroke: "#c0392b", "stroke-width": 0.5 }));
    labels.append(label({ x: fmt1(d.from[0] + 2.2 * u), y: fmt1(d.from[1] - 1.5 * u), "font-size": fmt1(2.3 * u), fill: "#c0392b" }, d.err_m != null ? `${d.id} 偏 ${fmt1(d.err_m)} m` : `${d.id} 缺`));
  }
  R.svg.append(ds);
}

// ------------------------------------------------------------ 标记（docs/07 §1.1）：人画的几何——圈选 area / 手绘线 trace / 图钉 pin，坐标相对场地中心（x 东 z 南，米）
/** 场地中心的世界坐标 [x, z]（v5 程序的 bounds 以场地中心为原点，所以通常是 [0, 0]） */
export function siteCenterOf(sid) { const b = sid && sid.bounds; return b ? [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0]; }
/** 世界 [x, z] → 场地坐标（米，保留 2 位） */
export const toSitePoint = (sid, p) => { const c = siteCenterOf(sid); return [r2(p[0] - c[0]), r2(p[1] - c[1])]; };
export const MARK_LABEL = { area: "圈选", trace: "手绘线", pin: "图钉" };
const MARK_COLOR = "#1f6feb";
/** 当前标记：ctx.marks（界面直接给）> plan.marks > sid.meta.marks；每个多一个 world（世界坐标点列，pin 是一个点） */
export function marksOf(ctx) {
  const sid = ctx.sid, plan = ctx.plan || (sid && sid.meta && sid.meta.plan) || null;
  const src = Array.isArray(ctx.marks) ? ctx.marks : plan && Array.isArray(plan.marks) ? plan.marks : (sid && sid.meta && sid.meta.marks) || [];
  const c = siteCenterOf(sid), W = (q) => [q[0] + c[0], q[1] + c[1]], out = [];
  for (const m of src) {
    if (!m || !m.id) continue;
    const g = m.type === "area" && validPoly(m.polygon_m) ? m.polygon_m : m.type === "trace" && Array.isArray(m.path_m) && m.path_m.length >= 2 && m.path_m.every(isPt) ? m.path_m : m.type === "pin" && isPt(m.point_m) ? [m.point_m] : null;
    if (g) out.push(Object.assign({}, m, { world: g.map(W) }));
  }
  return out;
}
const markSelected = (sel, id) => !!sel && (sel.mark_id === id || (sel.type === "mark" && sel.id === id));
/** 标记盖在最上层（不参与避让、不进导出几何）：圈选 = 虚线多边形，手绘线 = 虚线，图钉 = 水滴；选中的描橙色并给一个 × */
function drawMarks(R) {
  const { u, label, labels, ctx } = R, ms = marksOf(Object.assign({}, ctx, { plan: R.plan }));
  if (!ms.length) return;
  const g = svgel("g", { class: "marks" }), dash = `${fmt1(1.6 * u)} ${fmt1(0.9 * u)}`;
  for (const m of ms) {
    const on = markSelected(ctx.selected, m.id), col = on ? SELECT_COLOR : MARK_COLOR, P = m.world, xs = P.map((q) => q[0]), zs = P.map((q) => q[1]);
    const c = m.type === "area" ? polygonCentroid(P) : m.type === "trace" ? P[Math.floor(P.length / 2)] : P[0], cs = `${fmt1(c[0])} ${fmt1(c[1])}`;
    const base = { "data-type": "mark", "data-mark-id": m.id, "data-mark-type": m.type, "data-for": `mark:${m.id}`, style: "cursor:pointer" }, sw = fmt1((on ? 0.7 : 0.5) * u);
    if (m.type === "area") g.append(svgel("polygon", Object.assign({}, base, { points: pts(P), fill: col, "fill-opacity": on ? 0.12 : 0.06, stroke: col, "stroke-width": sw, "stroke-dasharray": dash, "stroke-linejoin": "round", "data-center": cs, class: "mark mark-area" })));
    else if (m.type === "trace") g.append(svgel("g", Object.assign({}, base, { "data-center": cs, class: "mark mark-trace" }),
      svgel("polyline", { points: pts(P), fill: "none", stroke: "#000", "stroke-opacity": 0, "stroke-width": fmt1(2.6 * u), "stroke-linecap": "round", "stroke-linejoin": "round" }),
      svgel("polyline", { points: pts(P), fill: "none", stroke: col, "stroke-width": sw, "stroke-dasharray": dash, "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none" })));
    else {
      const s = 0.9 * u, f = (v) => fmt1(v * s); // 水滴：尖端在点上，圆头在上
      g.append(svgel("g", Object.assign({}, base, { transform: `translate(${cs})`, "data-pos": cs, class: "mark mark-pin" }),
        svgel("path", { d: `M0 0L${f(-1.15)} ${f(-2.3)}A${f(1.45)} ${f(1.45)} 0 1 1 ${f(1.15)} ${f(-2.3)}Z`, fill: col, stroke: "#fff", "stroke-width": fmt1(0.3 * u) }),
        svgel("circle", { cy: f(-3.2), r: f(0.6), fill: "#fff", "pointer-events": "none" })));
      R.obs.ground.push([c[0] - 1.6 * u, c[1] - 4.6 * u, c[0] + 1.6 * u, c[1], ICON_W]); R.obs.strata.push([c[0] - 1.6 * u, c[1] - 4.6 * u, c[0] + 1.6 * u, c[1], ICON_W]);
    }
    const ly = m.type === "pin" ? c[1] - 5 * u : m.type === "area" ? Math.min(...zs) - 1 * u : c[1] - 1.6 * u;
    labels.append(label(Object.assign({}, base, { x: fmt1(c[0]), y: fmt1(ly), "font-size": fmt1(2.3 * u), "text-anchor": "middle", fill: col, "font-weight": on ? 700 : null }), m.label || MARK_LABEL[m.type], { rank: 1.5 }));
    if (!on) continue;
    const q = m.type === "area" ? [Math.max(...xs), Math.min(...zs)] : m.type === "pin" ? [c[0] + 2.6 * u, c[1] - 4.4 * u] : P[P.length - 1], k = fmt1(0.55 * u);
    g.append(svgel("g", { "data-type": "mark_remove", "data-mark-id": m.id, "data-for": `mark:${m.id}`, transform: `translate(${fmt1(q[0])} ${fmt1(q[1])})`, style: "cursor:pointer", class: "mark-remove" },
      svgel("circle", { r: fmt1(1.3 * u), fill: "#fff", stroke: col, "stroke-width": fmt1(0.3 * u) }),
      svgel("path", { d: `M-${k} -${k}L${k} ${k}M${k} -${k}L-${k} ${k}`, stroke: col, "stroke-width": fmt1(0.35 * u), "pointer-events": "none" }), svgel("title", {}, "删掉这个标记")));
  }
  R.svg.append(g);
}

// ------------------------------------------------------------ 地形操作的把手（docs/07 §4）：选中一个地形操作 → 中心把手（拖 = 挪位置）+ 高度把手（上下拖 = 改高 / 深）
/** 地形操作 → 高度字段 [字段, 缺省值]（ramp 之类没有单一高度的不给把手） */
const OP_FIELD = { raise: ["height_m", 12], cliff: ["height_m", 12], flatten: ["height_m", 0], lower: ["depth_m", 4], lake: ["depth_m", 4], carve: ["depth_m", 4], river: ["depth_m", 4], dune: ["amplitude_m", 3], noise: ["amplitude_m", 2], terrace: ["step_h_m", 3] };
/**
 * 一个地形操作的把手信息（俯视图与剖面共用）：{ id, op, label, center: [x, z]（世界）, top: 目标绝对高度 | null, field, value, text }；
 * 不是地形操作（plan.terrain 里没有、SID 也没有带 op 的 feature）→ null。field 为 null = 没有单一高度（不给高度把手）。
 */
export function opHeightInfo(plan, sid, id) {
  if (!id) return null;
  const op = plan && Array.isArray(plan.terrain) ? plan.terrain.find((t) => t && t.id === id) : null;
  const f = ((sid && sid.terrain && sid.terrain.features) || []).find((x) => x && x.plan_id === id && x.op);
  if (!f || !Array.isArray(f.center) || (plan && Array.isArray(plan.terrain) && !op)) return null;
  const kind = (op && op.op) || f.op, spec = OP_FIELD[kind] || null, field = spec ? spec[0] : null;
  const value = field ? (op && Number.isFinite(Number(op[field])) && op[field] != null ? Number(op[field]) : spec[1]) : null;
  return { id, op: kind, label: (op && op.label) || f.label || id, center: [f.center[0], f.center[2]], radius: Number(f.radius) || 0, top: Number.isFinite(f.height) ? f.height : null, field, value, text: field ? opValueText(field, value) : "" };
}
function drawOpHandles(R) {
  const { ctx, u } = R, id = ctx.selected.plan_id;
  if (!(ctx.tool == null || ["move", "select", "pin", "height"].includes(ctx.tool))) return;
  const I = opHeightInfo(R.plan, R.sid, id);
  if (!I) return;
  const [cx, cz] = I.center, key = `feature:${id}`, g = svgel("g", { class: "op-handles" }), k = fmt1(0.7 * u);
  g.append(svgel("g", { "data-type": "op_center", "data-plan-id": id, "data-for": key, "data-pos": `${fmt1(cx)} ${fmt1(cz)}`, transform: `translate(${fmt1(cx)} ${fmt1(cz)})`, style: "cursor:move", class: "op-center" },
    svgel("circle", { r: fmt1(1.5 * u), fill: "#fff", stroke: SELECT_COLOR, "stroke-width": fmt1(0.45 * u) }),
    svgel("path", { d: `M-${k} 0H${k}M0 -${k}V${k}`, stroke: SELECT_COLOR, "stroke-width": fmt1(0.3 * u), "pointer-events": "none" }), svgel("title", {}, `${I.label}：拖动 = 挪位置`)));
  if (I.field) {
    const a = fmt1(1.7 * u), b = fmt1(0.9 * u), w = fmt1(0.6 * u);
    g.append(svgel("g", { "data-type": "op_height", "data-plan-id": id, "data-for": key, "data-field": I.field, "data-value": I.value, transform: `translate(${fmt1(cx + 3.4 * u)} ${fmt1(cz)})`, style: "cursor:ns-resize", class: "op-height" },
      svgel("rect", { x: fmt1(-1.1 * u), y: fmt1(-2.7 * u), width: fmt1(2.2 * u), height: fmt1(5.4 * u), rx: fmt1(1.1 * u), fill: SELECT_COLOR, stroke: "#fff", "stroke-width": fmt1(0.25 * u) }),
      svgel("path", { d: `M-${w} -${b}L0 -${a}L${w} -${b}M-${w} ${b}L0 ${a}L${w} ${b}`, fill: "none", stroke: "#fff", "stroke-width": fmt1(0.3 * u), "pointer-events": "none" }),
      svgel("text", { x: fmt1(1.7 * u), y: fmt1(0.8 * u), "font-size": fmt1(2.4 * u), fill: SELECT_COLOR, "font-weight": 700, stroke: "#fff", "stroke-width": fmt1(0.6 * u), "paint-order": "stroke", "pointer-events": "none", class: "op-height-text" }, I.text),
      svgel("title", {}, `${I.label}：上下拖 = 改${I.field === "depth_m" ? "深度" : "高度"}`)));
  }
  R.svg.append(g);
}

// ------------------------------------------------------------ 剖切线：宽度带（盖在地面上、空间之下）+ 中心线与把手
function drawSectionBand(R, section) {
  const path = sectionPath(section, R.sid);
  R.svg.append(svgel("polyline", { points: pts(path), class: "sec-band", fill: "none", stroke: SECTION_COLOR, "stroke-opacity": section.mode === "line" ? 0.12 : 0.06, "stroke-width": widthClamp(section.width_m), "stroke-linejoin": "round", "stroke-linecap": "butt", "pointer-events": "none", "data-for": "section" }));
}
function drawSectionHandles(R, section, handles) {
  const { sid, u, label, labels } = R, path = sectionPath(section, sid), line = section.mode === "line";
  const g = svgel("g", { class: "section-layer" });
  g.append(svgel("polyline", { points: pts(path), class: "sec-line", fill: "none", stroke: SECTION_COLOR, "stroke-opacity": line ? 1 : 0.35, "stroke-width": fmt1((line ? 0.45 : 0.3) * u), "stroke-dasharray": `${fmt1(2 * u)} ${fmt1(1 * u)}`, "pointer-events": "none" }));
  if (line && handles && path.length === 2) {
    const [a, b] = path, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const [w, q] of [["a", a], ["b", b]]) g.append(svgel("circle", Object.assign(tag("section_" + w, null, "section", "section"), { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(1.5 * u), fill: "#fff", stroke: SECTION_COLOR, "stroke-width": fmt1(0.5 * u), class: "sec-handle", "data-pos": `${fmt1(q[0])} ${fmt1(q[1])}`, style: "cursor:grab" })));
    g.append(svgel("rect", Object.assign(tag("section_mid", null, "section", "section"), { x: fmt1(-1.1 * u), y: fmt1(-1.1 * u), width: fmt1(2.2 * u), height: fmt1(2.2 * u), fill: SECTION_COLOR, stroke: "#fff", "stroke-width": fmt1(0.3 * u), transform: `translate(${fmt1(m[0])} ${fmt1(m[1])}) rotate(45)`, class: "sec-handle", "data-pos": `${fmt1(m[0])} ${fmt1(m[1])}`, style: "cursor:move" })));
    for (const [w, q, o] of [["a", a, b], ["b", b, a]]) { const p = sectionLabelPos(q, o, u); labels.append(label({ x: fmt1(p[0]), y: fmt1(p[1]), "font-size": fmt1(2.6 * u), "font-weight": 700, "text-anchor": "middle", fill: SECTION_COLOR, "pointer-events": "none", "data-section-label": w }, w.toUpperCase())); }
  }
  R.svg.append(g);
}
/** A / B 字标位置：端点再往外 3.2u（远离另一端） */
export function sectionLabelPos(q, other, u) {
  const dx = q[0] - other[0], dz = q[1] - other[1], L = Math.hypot(dx, dz) || 1;
  return [q[0] + (dx / L) * 3.2 * u, q[1] + (dz / L) * 3.2 * u + 0.9 * u];
}

// ------------------------------------------------------------ 选中高亮（按 plan_id：它生成的全部东西；按 sid_id / part：单个）
function drawSelection(R, sel) {
  const { sid, u, ctx, svg } = R;
  if (!sel || (!sel.plan_id && !sel.sid_id)) return;
  const ids = sel.sid_id ? [sel.sid_id] : sidIdsOf(sid, ctx.index, sel.plan_id);
  const g = svgel("g", { class: "selection", "pointer-events": "none" });
  const st = (key, w = 0.6) => ({ fill: "none", stroke: SELECT_COLOR, "stroke-width": fmt1(w * u), "stroke-linejoin": "round", "data-for": key });
  const feats = (sid.terrain && sid.terrain.features) || [];
  for (const id of ids) {
    const sp = (sid.spaces || []).find((x) => x.id === id);
    if (sp) {
      const key = `space:${sp.plan_id || sp.id}`;
      const p = sel.part && (sp.passages || []).find((x) => x.id === sel.part), r = sel.part && (sp.rooms || []).find((x) => x.id === sel.part);
      if (p) g.append(svgel("polyline", Object.assign(st(key, 0.5), { points: pts(p.points), "stroke-width": fmt1((p.width || 2) + 1.2 * u), "stroke-opacity": 0.55 })));
      else if (r) g.append(svgel("polygon", Object.assign(st(key, 0.7), { points: pts(r.polygon) })));
      else if (sp.stratum === R.stratum || R.stratum === "ground") g.append(svgel("polygon", Object.assign(st(key, 0.8), { points: pts(sp.polygon) })));
      continue;
    }
    const f = feats.find((x) => x.id === id);
    if (f) { const poly = featurePolygon(f); if (poly) g.append(svgel("polygon", Object.assign(st(`feature:${f.plan_id}`, 0.8), { points: pts(poly) }))); continue; }
    const rg = (sid.regions || []).find((x) => x.id === id);
    if (rg && validPoly(rg.polygon)) { g.append(svgel("polygon", Object.assign(st(`zone:${rg.plan_id || rg.id}`, 0.8), { points: pts(rg.polygon) }))); continue; }
    const v = (sid.volumes || []).find((x) => x.id === id);
    if (v && v.position && v.size) { g.append(svgel("polygon", Object.assign(st(`${volumeType(v)}:${v.id}`, v.importance === "landmark" ? 0.6 : 0.45), { points: pts(footprintPolygon(v, 0.8)) }))); continue; }
    const pa = (sid.paths || []).find((x) => x.id === id);
    if (pa && pa.points) { g.append(svgel("polyline", Object.assign(st(`path:${pa.id}`, 1.2), { points: pts(pa.points), "stroke-opacity": 0.6 }))); continue; }
    const m = (sid.markers || []).find((x) => x.id === id);
    if (m && m.position) g.append(svgel("circle", Object.assign(st(`${m.kind === "player_spawn" ? "spawn" : m.kind === "portal" ? "portal" : "connector"}:${m.id}`), { cx: fmt1(m.position[0]), cy: fmt1(m.position[2]), r: fmt1(3.4 * u) })));
  }
  svg.append(g);
  const q = sel.sid_id ? `[data-sid-id="${esc(sel.sid_id)}"]` : `[data-plan-id="${esc(sel.plan_id)}"], [data-zone-id="${esc(sel.plan_id)}"]`;
  for (const n of svg.querySelectorAll(q)) if (!sel.part || n.getAttribute("data-part") === sel.part) n.setAttribute("data-selected", 1);
}

// ------------------------------------------------------------ 北 / 比例尺 / 内部层切换 / 导出页脚
function drawChrome(R, footer, PAD, W, H) {
  const { sid, T, u, label, labels, stratum, ctx } = R, b = sid.bounds, xmin = b.min[0], zmin = b.min[2];
  labels.append(label({ x: fmt1(xmin + W + PAD - 1.5 * u), y: fmt1(zmin - PAD + 3.8 * u), "font-size": fmt1(3.2 * u), "text-anchor": "end", fill: "#333" }, "N ↑"));
  const bar = W >= 100 ? 20 : 10, bx = xmin + 3 * u, by = zmin + H - 4 * u;
  labels.append(svgel("line", { x1: fmt1(bx), x2: fmt1(bx + bar), y1: fmt1(by), y2: fmt1(by), stroke: "#333", "stroke-width": fmt1(0.6 * u) }));
  for (const x of [bx, bx + bar]) labels.append(svgel("line", { x1: fmt1(x), x2: fmt1(x), y1: fmt1(by - 1 * u), y2: fmt1(by), stroke: "#333", "stroke-width": fmt1(0.6 * u) }));
  labels.append(label({ x: fmt1(bx + bar / 2), y: fmt1(by - 1.4 * u), "font-size": fmt1(2.4 * u), "text-anchor": "middle", fill: "#333" }, `${bar} m`));
  // 内部层切换（当前层有多层空间时）：左上角「内部 1 入口层 | 2 | 3」
  if (stratum !== "ground") {
    const sps = (sid.spaces || []).filter((s) => s && s.stratum === stratum && validPoly(s.polygon)), n = sps.reduce((m, s) => Math.max(m, levelsOf(s)), 0);
    const curK = clamp(Math.round(Number(ctx.interiorLevel) || 0), 0, Math.max(0, n - 1));
    let x = xmin + 2 * u; const y = zmin - PAD + 0.6 * u, h = 3 * u;
    const head = `${stratum === "sky" ? "空中" : "地下"} · 内部层`;
    labels.append(label({ x: fmt1(x), y: fmt1(y + 2.2 * u), "font-size": fmt1(2.3 * u), fill: "#333" }, head));
    x += textWidth(head, 2.3 * u) + 1.2 * u;
    if (n > 1) for (let k = 0; k < n; k++) {
      const txt = k === 0 ? "1 入口层" : String(k + 1), w = Math.max(3.6 * u, textWidth(txt, 2.1 * u) + 1.6 * u), on = k === curK;
      labels.append(svgel("g", { "data-type": "interior_level", "data-level": k, style: "cursor:pointer" },
        svgel("rect", { x: fmt1(x), y: fmt1(y), width: fmt1(w), height: fmt1(h), rx: fmt1(0.6 * u), fill: on ? "#3b342d" : "#fff", stroke: "#3b342d", "stroke-width": fmt1(0.25 * u) }),
        svgel("text", { x: fmt1(x + w / 2), y: fmt1(y + 2.15 * u), "font-size": fmt1(2.1 * u), "text-anchor": "middle", fill: on ? "#fff" : "#3b342d", "pointer-events": "none" }, txt)));
      x += w + 0.8 * u;
    } else labels.append(label({ x: fmt1(x), y: fmt1(y + 2.2 * u), "font-size": fmt1(2.1 * u), fill: "#777" }, n ? "只有 1 层" : "这一层没有空间"));
  }
  if (footer) {
    const layer = (sid.meta && sid.meta.layer_height_m) || 3, f = (ctx.facts && ctx.facts.trail) || null, terraces = (T && T.terraces) || [];
    const houses = (sid.volumes || []).filter((v) => v.kind === "building" && v.importance !== "landmark").length;
    const steps = f && f.steps_estimate ? ` · 主路 ${Math.round(f.length_m)} m / 约 ${Math.round(f.steps_estimate)} 级` : "";
    const sps = (sid.spaces || []).filter((x) => x && x.polygon), nu = sps.filter((x) => x.stratum === "underground").length, ns = sps.length - nu;
    labels.append(label({ x: fmt1(xmin + 2 * u), y: fmt1(zmin + H + PAD + 1.8 * u), "font-size": fmt1(2.4 * u), fill: "#555" }, `约 ${W} m 见方 · ${terraces.length} 块台地（1 层 ≈ ${layer} m）· ${houses} 栋 · ${landmarksOf(sid).length} 个地标${steps}${nu ? ` · 地下 ${nu} 处` : ""}${ns ? ` · 空中 ${ns} 处` : ""}`));
  }
}

// ============================================================ 标签避让（纯算术，不量 DOM）：按 rank 逐个放，在锚点附近候选里挑压得最少的；
// optional 的躲不开就删掉，其余躲不开垫底色。只挪文字的 x / y。
function textWidth(s, fs) { let w = 0; for (const ch of s) { const c = ch.codePointAt(0); w += c >= 0x2e80 || ch === "·" ? 1 : ch === " " ? 0.3 : 0.58; } return w * fs; }
function boxOf(t, x, y) {
  const fs = Number(t.getAttribute("font-size")) || 2.5, w = textWidth(t.textContent || "", fs), a = t.getAttribute("text-anchor"), x0 = a === "middle" ? x - w / 2 : a === "end" ? x - w : x;
  return [x0 - 0.15 * fs, y - 0.9 * fs, x0 + w + 0.15 * fs, y + 0.25 * fs];
}
const area = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const CANDIDATES = (() => { const out = []; for (const dy of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]) for (const dx of [0, 0.4, -0.4, 0.75, -0.75]) out.push([dx, dy, Math.abs(dy) + Math.abs(dx) * 2.5]); return out.sort((a, b) => a[2] - b[2]); })();
/** 图标类障碍（出生点、连接点、入口 / 终点、传送门）的权重：标签宁可压一点大块的形体，也别压住小图标 */
const ICON_W = 6;
/** 同名同组只标一次：文字一样、属于同一个 plan 元素（实例 / 子件归到根 id），或文字一样且离得近（< 24 m） */
function dedupeLabels(list) {
  const seen = [], out = [];
  const root = (t) => String(t.getAttribute("data-plan-id") || t.getAttribute("data-elev-label") || "").replace(/\[\d+\]/g, "").split(/[/.]/)[0];
  for (const t of list) {
    const text = (t.textContent || "").trim(), r = root(t), g = t.getAttribute("data-plan-root") || r, x = +t.getAttribute("x"), y = +t.getAttribute("y");
    const kin = (o) => (r && o.r === r) || (g && o.g === g); // 同一元素、或同一个根组（柱厅里的柱）
    if (text && seen.some((o) => (o.text === text && ((r && o.r === r) || Math.hypot(o.x - x, o.y - y) < 24)) || (kin(o) && ((o.text.length >= 2 && text.startsWith(o.text)) || o.text.startsWith(text))))) { t.remove(); continue; } // 「内庭」标过了，「内庭墙」不再标；「柱厅」标过了，「柱」不再标
    seen.push({ text, r, g, x, y }); out.push(t);
  }
  return out;
}
function placeLabels(R) {
  const { labels, sid, u, onGround } = R;
  const all = [...labels.querySelectorAll("text")].filter((t) => !t.closest("[data-type=interior_level]"));
  const movable = all.filter((t) => t.hasAttribute("data-rank"));
  const placed = all.filter((t) => !t.hasAttribute("data-rank")).map((t) => boxOf(t, +t.getAttribute("x"), +t.getAttribute("y")));
  const obs = onGround ? R.obs.ground : R.obs.strata;
  const [x0, z0, x1, z1] = [sid.bounds.min[0], sid.bounds.min[2], sid.bounds.max[0], sid.bounds.max[2]];
  const inactive = (t) => !!t.closest("[data-inactive]");
  const rank = (t) => Number(t.getAttribute("data-rank")) + (inactive(t) ? 10 : 0);
  movable.sort((a, b) => rank(a) - rank(b));
  for (const t of dedupeLabels(movable)) {
    const x = +t.getAttribute("x"), y = +t.getAttribute("y"), fs = Number(t.getAttribute("font-size")) || 2.5, b0 = boxOf(t, x, y), w = b0[2] - b0[0], lh = 1.2 * fs;
    let best = null;
    for (const [dx, dy, cost] of CANDIDATES) {
      const nx = x + dx * w, ny = y + dy * lh, b = boxOf(t, nx, ny);
      if (b[0] < x0 - 2 * u || b[2] > x1 + 2 * u || b[1] < z0 - 2 * u || b[3] > z1 + 2 * u) continue;
      let hit = 0;
      for (const o of obs) hit += area(b, o) * (o[4] || 1);
      if (!onGround && inactive(t)) for (const o of R.obs.interior) hit += area(b, o); // 淡画的地面标签躲开当前内部层
      for (const o of placed) hit += 3 * area(b, o);
      const score = hit + cost * 0.02 * w * lh;
      if (!best || score < best.score) best = { nx, ny, b, hit, score };
      if (hit === 0) break;
    }
    if (!best) best = { nx: x, ny: y, b: b0, hit: 1 };
    if ((t.hasAttribute("data-optional") || (!onGround && inactive(t))) && best.hit > 0.15 * w * lh) { t.remove(); continue; } // 淡画的地面标签只是参照：躲不开就不画
    t.setAttribute("x", fmt1(best.nx)); t.setAttribute("y", fmt1(best.ny));
    if (best.hit > 0.15 * w * lh) { const [a, c, d, e] = best.b; t.before(svgel("rect", { x: fmt1(a), y: fmt1(c), width: fmt1(d - a), height: fmt1(e - c), rx: fmt1(0.4 * u), fill: "#fbfaf6", "fill-opacity": 0.82, "pointer-events": "none", "data-for": t.getAttribute("data-for"), class: "label-bg" })); }
    placed.push([best.b[0] - 0.4 * lh, best.b[1] - 0.25 * lh, best.b[2] + 0.4 * lh, best.b[3] + 0.25 * lh]); // 留一点缝：两个名字别贴在一起读成一个
  }
}

// ============================================================ 手势
/** 屏幕坐标 → 世界坐标 [x, z]（夹在 bounds 内） */
export function svgPoint(svg, ev, sid) {
  const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse()), b = sid.bounds;
  return [clamp(p.x, b.min[0], b.max[0]), clamp(p.y, b.min[2], b.max[2])];
}
/** 方向角（度，0 = 东，90 = 北，俯视逆时针为正）；step > 0 时吸附到 step 的整数倍 */
export function snapAngle(from, to, step = 15) {
  const dx = to[0] - from[0], dz = to[1] - from[1], L = Math.hypot(dx, dz);
  let a = ((Math.atan2(-dz, dx) * 180) / Math.PI + 360) % 360;
  if (step > 0) a = (Math.round(a / step) * step) % 360;
  const t = (a * Math.PI) / 180;
  return { angle_deg: Math.round(a * 10) / 10, length_m: Math.round(L * 10) / 10, to: step > 0 ? [from[0] + Math.cos(t) * L, from[1] - Math.sin(t) * L] : [to[0], to[1]] };
}
const DRAG_TYPES = new Set(["landmark", "spawn", "house", "shape", "portal", "trail_vertex", "section_a", "section_b", "section_mid", "space", "connector", "feature", "mark", "op_center"]);
const POINT_TYPES = new Set(["landmark", "spawn", "shape", "portal", "connector", "trail_vertex", "section_a", "section_b", "section_mid", "entrance", "goal", "link", "mark", "op_center"]);
const parsePos = (s) => { const a = String(s || "").split(" ").map(Number); return a.length === 2 && a.every(Number.isFinite) ? a : null; };
/** DOM 节点 → 手势目标 {type, plan_id?, sid_id?, part?, sublevel?, index?, zone_id?, mark_id?, mark_type?}；淡显层里的不算 */
export function targetOf(n) {
  const el = n && n.closest && n.closest("[data-type]");
  if (!el || el.closest("[data-inactive]")) return null;
  const d = el.dataset, t = { type: d.type };
  if (d.planId) t.plan_id = d.planId;
  if (d.sidId) t.sid_id = d.sidId;
  if (d.part) t.part = d.part;
  if (d.sublevel != null) t.sublevel = Number(d.sublevel);
  if (d.index != null) t.index = Number(d.index);
  if (d.zoneId) t.zone_id = d.zoneId;
  if (d.level != null) t.level = Number(d.level);
  if (d.markId) { t.mark_id = t.id = d.markId; if (d.markType) t.mark_type = d.markType; }
  return t;
}
const keyOf = (t) => `${t.type}|${t.sid_id || ""}|${t.plan_id || ""}|${t.part || ""}|${t.index ?? ""}|${t.mark_id || ""}`;
/** 拖动这组节点用的 data-for 键：地形块 / 空间 / 地形操作中心按 plan_id 整组走，标记按 mark_id，其余按 sid_id */
const dragKey = (t) => (t.type === "trail_vertex" ? `trail_vertex:${t.index}` : t.type.startsWith("section_") ? "section" : t.type === "mark" ? `mark:${t.mark_id}` : t.type === "op_center" ? `feature:${t.plan_id}` : t.type === "feature" || t.type === "space" ? `${t.type}:${t.plan_id}` : `${t.type}:${t.sid_id}`);


/**
 * 绑定手势（全部本地，不调 AI）。handlers（都可选）：
 *  tool() → move | path | region | section | erase | height | pin；canDrag(target) → bool（没给时 DRAG_TYPES 都能拖）
 *  onDrag(target, p, info) 拖动中（图已移动预览，不要重建）；onDragEnd(target, p, info) 松手；onDragCancel() Esc / pointercancel
 *  onSelect(target, p, ev) 点一下：同一处再点一下轮到下面一层（区域 → 地形块 → …）；空白处 target = {type: "ground"}
 *  onPath(points, ev) / onRegion(points, ev) / onSection([a, b], info) / onErase(target, p) / onDiff(id, ev) / onInteriorLevel(k) / onGesture(on)
 *  —— docs/07：
 *  onPin(p, { target, point_m, ev })：右键 / Ctrl+点（任何工具）或 pin 工具下点一下；target = 指针下最上面的东西（{type:"ground"} = 空地），point_m = 场地坐标
 *  标记（target.type = "mark"，带 mark_id / mark_type）：点 → onSelect；拖 → onMarkMove(markId, p, info)（没给就走 onDrag / onDragEnd，受 canDrag 管）；
 *    onMarkMoveLive(markId, p, info) 拖动中；选中时的 × → onMarkRemove(markId)（没给走 onErase({type:"mark", mark_id})）；擦除工具点它 → onErase
 *  地形操作（选中后才有把手）：中心把手拖 → onOpMove(opId, p, info)（p = 新中心，info.delta）、拖动中 onOpMoveLive(opId, p, info)；
 *    高度把手上下拖 → onOpHeight(opId, value, { field })（value = 字段的新值：height_m / depth_m / amplitude_m / step_h_m）、拖动中 onOpHeightLive(opId, value, { field })
 *  高度工具 tool() = "height"：onHeightStart(p, { target, mark_id, point_m }) → false 表示不接；onHeightDrag(p, { delta_m, radius_m, mode, point_m, mark_id })（实时，只在数值变了时调）；
 *    onHeightEnd(p, 同上)（松手：|delta| ≥ 0.5 或 Shift 削平）；onHeightCancel()（Esc / 拖回 0 / pointercancel）。p = 按下的点（按在图钉上时吸到图钉）。
 *    上下拖 = 抬高 / 压低（每 px 0.1 m，吸附 0.5 m），Shift = flatten，Alt = 只压低；滚轮或 [ ] 调半径（heightBrush.radius_m，2–80 m）。
 * target = {type, plan_id?, sid_id?, part?, sublevel?, index?, zone_id?, mark_id?}；type ∈ landmark | spawn | house | trail_vertex | feature | zone | path | water |
 *   space | passage | room | entrance | goal | link | connector | section_a | section_b | section_mid | mark。按住通道 / 房间拖 = 拖整个空间。
 * p：拖动后的新位置 [x, z]（世界坐标）——点状的东西是它的新坐标，地形块 / 空间 / 圈选 / 手绘线是新中心（UI 用 atFromPoint 反算 at，或用 info.delta 改 offset_m / 平移标记）。
 * info：{ delta: [dx, dz], pos?, orig?, index?, line?, angle_deg?, length_m? }；剖切端点 15° 吸附，按住 Alt 不吸附。
 * @returns {() => void} 解绑
 */
export function bindMap(svg, ctx, handlers = {}) {
  const H = handlers, sid = ctx.sid, b = sid.bounds;
  let drawing = null, live = null, drag = null, lastClick = null, active = false, hd = null, hop = null, brushEl = null, hover = null;
  const rawTool = () => (H.tool ? H.tool() : "move");
  const toolNow = () => { const t = rawTool(); return t === "select" || t === "pin" ? "move" : t; };
  const q = (sel) => svg.querySelector(sel);
  const inB = (p) => [clamp(p[0], b.min[0], b.max[0]), clamp(p[1], b.min[2], b.max[2])];
  const u = () => Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 120;
  /** 指针下的目标栈（上层在前）；小符号没直接点中时就近 14 px 内补一个点状目标 */
  const stackAt = (ev, p) => {
    let els = [];
    try { els = document.elementsFromPoint(ev.clientX, ev.clientY).filter((n) => svg.contains(n)); } catch { /* 老浏览器 */ }
    if (!els.length && ev.target) els = [ev.target];
    const direct = els.map(targetOf).filter((t) => t && !["interior_level", "mark_remove", "op_height"].includes(t.type));
    let ppm = 1; try { ppm = Math.abs(svg.getScreenCTM().a) || 1; } catch { /* 没布局 */ }
    const Rr = Math.max(2, 14 / ppm);
    let near = null, bd = Infinity;
    for (const n of svg.querySelectorAll("[data-pos]")) {
      const t = targetOf(n); if (!t || !POINT_TYPES.has(t.type)) continue;
      const c = parsePos(n.getAttribute("data-pos")); if (!c) continue;
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]) + (t.type.startsWith("section") || t.type === "op_center" ? 0 : t.type === "trail_vertex" ? 0.01 : 0.02);
      if (d <= Rr && d < bd) { bd = d; near = t; }
    }
    const out = [], seen = new Set(), push = (t) => { const k = keyOf(t); if (!seen.has(k)) { seen.add(k); out.push(t); } };
    if (near && !(direct[0] && POINT_TYPES.has(direct[0].type))) push(near);
    direct.forEach(push);
    return out;
  };
  /** 标记 / 地形操作中心有专用回调时不问 canDrag（界面的 canDrag 只认节点） */
  const OWN = { mark: "onMarkMove", op_center: "onOpMove" };
  const canDrag = (t) => DRAG_TYPES.has(t.type) && ((OWN[t.type] && H[OWN[t.type]]) || !H.canDrag || !!H.canDrag(t.type === "op_center" ? { type: "feature", plan_id: t.plan_id } : t));
  const dragTargetOf = (stack) => {
    for (const t0 of stack) {
      const t = ["passage", "room", "entrance", "goal", "link"].includes(t0.type) ? { type: "space", plan_id: t0.plan_id, sid_id: t0.sid_id } : t0;
      if (canDrag(t)) return t;
    }
    return null;
  };
  const origOf = (t) => {
    if (t.type === "feature" || t.type === "space") { const n = q(`[data-for="${esc(dragKey(t))}"][data-center]`); return n ? parsePos(n.getAttribute("data-center")) : planCenter(sid, ctx.T, t.plan_id); }
    if (t.type === "mark") { const n = q(`[data-type="mark"][data-mark-id="${esc(t.mark_id)}"][data-pos], [data-type="mark"][data-mark-id="${esc(t.mark_id)}"][data-center]`); return n ? parsePos(n.getAttribute("data-pos") || n.getAttribute("data-center")) : null; }
    const n = t.type === "trail_vertex" ? q(`[data-type="trail_vertex"][data-index="${t.index}"]`) : t.type === "op_center" ? q(`[data-type="op_center"][data-pos]`) : q(`[data-type="${t.type}"][data-sid-id="${esc(t.sid_id)}"][data-pos]`);
    return n ? parsePos(n.getAttribute("data-pos")) : null;
  };
  /** 拖动回调：标记 / 地形操作中心有专用回调就走专用的，否则走 onDrag / onDragEnd（地形操作中心当成地形块） */
  const emit = (t, r, end) => {
    if (t.type === "op_center" && H.onOpMove) { const f = end ? H.onOpMove : H.onOpMoveLive; if (f) f(t.plan_id, r.p, r.info); return; }
    if (t.type === "mark" && H.onMarkMove) { const f = end ? H.onMarkMove : H.onMarkMoveLive; if (f) f(t.mark_id, r.p, r.info); return; }
    const f = end ? H.onDragEnd : H.onDrag; if (f) f(t.type === "op_center" ? { type: "feature", plan_id: t.plan_id } : t, r.p, r.info);
  };
  // ---------- DOM 预览（只改属性，结束 / 取消时还原，交给回调重建）
  const saved = [];
  const setAttr = (n, k, v) => { if (!n) return; saved.push([n, k, n.getAttribute(k)]); n.setAttribute(k, v); };
  const restoreAll = () => { for (let i = saved.length - 1; i >= 0; i--) { const [n, k, v] = saved[i]; if (v == null) n.removeAttribute(k); else n.setAttribute(k, v); } saved.length = 0; };
  const translate = (nodes, dx, dz) => { for (const n of nodes) { if (n.__orig == null) n.__orig = n.getAttribute("transform") || ""; n.setAttribute("transform", `translate(${fmt1(dx)} ${fmt1(dz)}) ${n.__orig}`); } };
  const untranslate = (nodes) => { for (const n of nodes) if (n.__orig != null) { if (n.__orig) n.setAttribute("transform", n.__orig); else n.removeAttribute("transform"); delete n.__orig; } };
  const sectionLine = () => { const a = q('[data-type="section_a"]'), bb = q('[data-type="section_b"]'); return a && bb ? [parsePos(a.getAttribute("data-pos")), parsePos(bb.getAttribute("data-pos"))] : null; };
  const showSection = (line) => {
    for (const sel of [".sec-band", ".sec-line"]) { const n = q(sel); if (n) setAttr(n, "points", pts(line)); }
    const [a, bb] = line, m = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2], U = u();
    const A = q('[data-type="section_a"]'), B = q('[data-type="section_b"]'), M = q('[data-type="section_mid"]');
    if (A) { setAttr(A, "cx", fmt1(a[0])); setAttr(A, "cy", fmt1(a[1])); }
    if (B) { setAttr(B, "cx", fmt1(bb[0])); setAttr(B, "cy", fmt1(bb[1])); }
    if (M) setAttr(M, "transform", `translate(${fmt1(m[0])} ${fmt1(m[1])}) rotate(45)`);
    for (const [w, p0, o] of [["a", a, bb], ["b", bb, a]]) { const t = q(`[data-section-label="${w}"]`); if (t) { const lp = sectionLabelPos(p0, o, U); setAttr(t, "x", fmt1(lp[0])); setAttr(t, "y", fmt1(lp[1])); } }
  };
  const preview = (d, p, ev) => {
    const t = d.target, dx = p[0] - d.start[0], dz = p[1] - d.start[1], info = { delta: [r2(dx), r2(dz)] };
    if (t.type === "trail_vertex") {
      const pos = inB([d.orig[0] + dx, d.orig[1] + dz]); Object.assign(info, { pos: pos.map(r2), index: t.index });
      const line = q('[data-type="path"][data-sid-id="main_trail"]');
      if (line && d.trailPts) { const arr = d.trailPts.slice(); arr[t.index] = pos; setAttr(line, "points", pts(arr)); }
      const h = q(`[data-type="trail_vertex"][data-index="${t.index}"]`); if (h) { setAttr(h, "cx", fmt1(pos[0])); setAttr(h, "cy", fmt1(pos[1])); }
      for (const n of svg.querySelectorAll(".trail-steps, .trail-label")) setAttr(n, "visibility", "hidden");
      return { p: info.pos, info };
    }
    if (t.type.startsWith("section_")) {
      let [a, bb] = d.line.map((x) => x.slice());
      if (t.type === "section_mid") { a = [a[0] + dx, a[1] + dz]; bb = [bb[0] + dx, bb[1] + dz]; }
      else {
        const fixed = t.type === "section_a" ? bb : a, moving = t.type === "section_a" ? a : bb, np = inB([moving[0] + dx, moving[1] + dz]);
        const s = snapAngle(fixed, np, ev && ev.altKey ? 0 : 15), end = s.length_m < 4 ? np : inB(s.to);
        if (t.type === "section_a") a = end; else bb = end;
      }
      const line = [a, bb].map((x) => [r2(x[0]), r2(x[1])]), s = snapAngle(line[0], line[1], 0);
      Object.assign(info, { line, angle_deg: s.angle_deg, length_m: s.length_m });
      showSection(line);
      return { p: t.type === "section_mid" ? [r2((line[0][0] + line[1][0]) / 2), r2((line[0][1] + line[1][1]) / 2)] : t.type === "section_a" ? line[0] : line[1], info };
    }
    translate(d.nodes, dx, dz);
    const pos = d.orig ? inB([d.orig[0] + dx, d.orig[1] + dz]) : p;
    Object.assign(info, { pos: pos.map(r2) }, d.orig ? { orig: d.orig } : {});
    return { p: info.pos, info };
  };
  // ---------- 高度笔刷（画法在 profile.js drawHeightBrush）
  const drawBrush = (p, st) => { brushEl = drawHeightBrush(svg, brushEl, p, st, u()); };
  const heightInfo = (st) => Object.assign({}, st, { point_m: hd.meta.point_m, mark_id: hd.meta.mark_id });
  const heightUpdate = (mods) => {
    if (!hd) return;
    const st = heightStroke(hd.dy, mods);
    if (!hd.moved && Math.abs(hd.dy) < 3 && st.mode !== "flatten") { drawBrush(hd.p0, st); return; }
    hd.moved = true; hd.st = st; drawBrush(hd.p0, st);
    const sig = `${st.delta_m}|${st.radius_m}|${st.mode}`;
    if (sig !== hd.sent) { hd.sent = sig; if (H.onHeightDrag) H.onHeightDrag(hd.p0, heightInfo(st)); }
  };
  const resizeBrush = (dir) => {
    heightBrush.radius_m = brushStep(heightBrush.radius_m, dir);
    if (hd) heightUpdate(hd.mods); else if (hover) drawBrush(hover, null);
  };
  // ---------- 地形操作的高度把手（竖拖）
  const opHeightAt = (dy) => { const [lo, hi] = OP_RANGE[hop.field] || [-60, 150], k = hop.field === "depth_m" ? 1 : -1; return clamp(Math.round((hop.v0 + k * dy * HEIGHT_M_PER_PX) * 2) / 2, lo, hi); };
  const endDrag = (cancel) => { const d = drag; drag = null; if (!d) return null; untranslate(d.nodes || []); restoreAll(); return cancel ? null : d; };
  const gesture = (on) => { if (on === active) return; active = on; if (H.onGesture) H.onGesture(on); if (on) window.addEventListener("keydown", onEsc, true); else window.removeEventListener("keydown", onEsc, true); };
  const cancelAll = () => {
    const moved = !!(drag && drag.moved), hadH = !!(hd && hd.moved), hadOp = !!(hop && hop.moved);
    drawing = null; if (live) live.remove(); live = null; endDrag(true);
    if (hop) { hop.txt && (hop.txt.textContent = hop.text0); hop = null; }
    hd = null; drawBrush(hover, null); gesture(false);
    if (hadH) { if (H.onHeightCancel) H.onHeightCancel(); else if (H.onDragCancel) H.onDragCancel(); }
    if ((moved || hadOp) && H.onDragCancel) H.onDragCancel();
  };
  function onEsc(ev) { if (ev.key !== "Escape" || (!drawing && !drag && !hd && !hop)) return; ev.preventDefault(); ev.stopPropagation(); cancelAll(); }
  /** [ ] 调笔刷半径；Shift / Alt 按下松开时刷新拖动中的数值（只在高度工具、焦点不在输入框时） */
  const onKey = (ev) => {
    if (!svg.isConnected) { unbind(); return; }
    if (toolNow() !== "height" || (ev.target && ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]"))) return;
    if (ev.type === "keydown" && (ev.key === "[" || ev.key === "]")) { ev.preventDefault(); resizeBrush(ev.key === "]" ? 1 : -1); return; }
    if (ev.key === "Alt") ev.preventDefault(); // 别让 Alt 去激活菜单栏
    if (hd && (ev.key === "Shift" || ev.key === "Alt")) { hd.mods = { shiftKey: ev.shiftKey, altKey: ev.altKey }; heightUpdate(hd.mods); }
  };
  const onWheel = (ev) => { if (toolNow() !== "height") return; ev.preventDefault(); resizeBrush(ev.deltaY < 0 ? 1 : -1); };
  const onMenu = (ev) => { if (H.onPin) ev.preventDefault(); };
  const onLeave = () => { hover = null; if (!hd) drawBrush(null); };
  const toSite = (p) => toSitePoint(sid, p);

  const down = (ev) => {
    const p = svgPoint(svg, ev, sid), n = ev.target, tool = toolNow();
    if (H.onPin && (ev.button === 2 || (ev.button === 0 && (ev.ctrlKey || ev.metaKey)))) { // 图钉：右键或 Ctrl+点
      ev.preventDefault();
      return H.onPin(p.map(r2), { target: stackAt(ev, p)[0] || { type: "ground" }, point_m: toSite(p), ev });
    }
    if (ev.button != null && ev.button > 0) return;
    if (n.dataset && n.dataset.diff !== undefined) return H.onDiff && H.onDiff(n.dataset.diff, ev);
    const lvl = n.closest && n.closest("[data-type=interior_level]");
    if (lvl) return H.onInteriorLevel && H.onInteriorLevel(Number(lvl.dataset.level));
    const rm = n.closest && n.closest("[data-type=mark_remove]");
    if (rm) { const id = rm.getAttribute("data-mark-id"); return H.onMarkRemove ? H.onMarkRemove(id) : H.onErase && H.onErase({ type: "mark", mark_id: id, id }, p); }
    try { svg.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    const oh = n.closest && n.closest("[data-type=op_height]");
    if (oh && H.onOpHeight) {
      const txt = oh.querySelector(".op-height-text");
      hop = { id: oh.getAttribute("data-plan-id"), field: oh.getAttribute("data-field"), v0: Number(oh.getAttribute("data-value")) || 0, y0: ev.clientY, txt, text0: txt ? txt.textContent : "", moved: false };
      hop.v = hop.v0;
      return;
    }
    if (tool === "path" || tool === "region") {
      drawing = { pts: [p], tool };
      live = svgel("polyline", { points: pts([p]), fill: tool === "region" ? "rgba(31,111,235,.12)" : "none", stroke: "#1f6feb", "stroke-width": 1, "stroke-dasharray": "1.5 1", "pointer-events": "none" });
      svg.append(live); gesture(true);
    } else if (tool === "section") {
      drawing = { pts: [p, p], tool, info: null };
      live = svgel("line", { x1: fmt1(p[0]), y1: fmt1(p[1]), x2: fmt1(p[0]), y2: fmt1(p[1]), stroke: SECTION_COLOR, "stroke-width": 0.6, "stroke-dasharray": "2 1", "pointer-events": "none" });
      svg.append(live); gesture(true);
    } else if (tool === "erase") {
      if (H.onErase) H.onErase(stackAt(ev, p)[0] || { type: "ground" }, p);
    } else if (tool === "height") {
      // 按在图钉上，或按在选中的地形操作的中心把手上（刚松手的手调高度就是它）= 接着改同一个操作：笔刷对准那一点（docs/07 §4）
      const top = stackAt(ev, p)[0] || { type: "ground" }, isPinT = top.type === "mark" && top.mark_type === "pin", c = isPinT || top.type === "op_center" ? origOf(top) : null, p0 = (c || p).map(r2);
      const meta = { target: top, mark_id: isPinT && c ? top.mark_id : null, op_id: top.type === "op_center" ? top.plan_id : null, point_m: toSite(p0) };
      if (H.onHeightStart && H.onHeightStart(p0, meta) === false) return;
      hd = { p0, y0: ev.clientY, dy: 0, meta, mods: { shiftKey: ev.shiftKey, altKey: ev.altKey }, st: null, moved: false, sent: null };
      gesture(true); heightUpdate(hd.mods);
    } else {
      const stack = stackAt(ev, p), t = dragTargetOf(stack);
      const d = { stack, target: t, start: p, client: [ev.clientX, ev.clientY], moved: false, can: !!t, nodes: [] };
      if (t) {
        if (t.type.startsWith("section_")) { d.line = sectionLine(); if (!d.line) d.can = false; }
        else if (t.type === "trail_vertex") { const line = q('[data-type="path"][data-sid-id="main_trail"]'); d.trailPts = line ? line.getAttribute("points").trim().split(/\s+/).map((s) => s.split(",").map(Number)) : null; d.orig = origOf(t); }
        else { d.nodes = [...svg.querySelectorAll(`[data-for="${esc(dragKey(t))}"]`)]; d.orig = origOf(t); }
      }
      drag = d;
    }
  };
  const move = (ev) => {
    if (hop) {
      const dy = ev.clientY - hop.y0;
      if (!hop.moved && Math.abs(dy) < 3) return;
      if (!hop.moved) gesture(true);
      hop.moved = true; const v = opHeightAt(dy);
      if (v !== hop.v) { hop.v = v; if (hop.txt) hop.txt.textContent = opValueText(hop.field, v); if (H.onOpHeightLive) H.onOpHeightLive(hop.id, v, { field: hop.field }); }
      return;
    }
    if (hd) { hd.dy = ev.clientY - hd.y0; hd.mods = { shiftKey: ev.shiftKey, altKey: ev.altKey }; heightUpdate(hd.mods); return; }
    if (!drawing && !drag && toolNow() === "height") { hover = svgPoint(svg, ev, sid); drawBrush(hover, null); return; }
    if (drawing && live) {
      const p = svgPoint(svg, ev, sid);
      if (drawing.tool === "section") {
        const s = snapAngle(drawing.pts[0], p, ev.altKey ? 0 : 15), end = s.length_m < 1 ? p : inB(s.to);
        drawing.pts[1] = end; drawing.info = { angle_deg: s.angle_deg, length_m: s.length_m };
        live.setAttribute("x2", fmt1(end[0])); live.setAttribute("y2", fmt1(end[1]));
        return;
      }
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1) { drawing.pts.push(p); live.setAttribute("points", pts(drawing.pts)); }
      return;
    }
    if (!drag || !drag.can) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.client[0], ev.clientY - drag.client[1]) < 3) return;
    if (!drag.moved) gesture(true);
    drag.moved = true;
    const r = preview(drag, svgPoint(svg, ev, sid), ev);
    drag.last = r;
    emit(drag.target, r, false);
  };
  const up = (ev) => {
    gesture(false);
    if (hop) { const o = hop; hop = null; if (o.moved && o.v !== o.v0) H.onOpHeight(o.id, o.v, { field: o.field }); else if (o.txt) o.txt.textContent = o.text0; return; }
    if (hd) {
      const d = hd; hd = null; drawBrush(hover, null);
      if (d.st && ((d.moved && d.st.delta_m !== 0) || d.st.mode === "flatten")) { if (H.onHeightEnd) H.onHeightEnd(d.p0, Object.assign({}, d.st, { point_m: d.meta.point_m, mark_id: d.meta.mark_id })); }
      else if (d.moved && H.onHeightCancel) H.onHeightCancel();
      return;
    }
    if (drawing) {
      const d = drawing; drawing = null; if (live) live.remove(); live = null;
      if (d.tool === "section") { const [a, b2] = d.pts; if (Math.hypot(b2[0] - a[0], b2[1] - a[1]) >= 4 && H.onSection) H.onSection([a, b2].map((x) => [r2(x[0]), r2(x[1])]), d.info || snapAngle(a, b2, 0)); return; }
      if (d.pts.length < 3) return;
      if (d.tool === "path") { if (H.onPath) H.onPath(d.pts, ev); } else if (H.onRegion) H.onRegion(d.pts, ev);
      return;
    }
    if (!drag) return;
    const d = drag;
    if (d.moved && d.can) { const r = preview(d, svgPoint(svg, ev, sid), ev); endDrag(false); emit(d.target, r, true); return; }
    endDrag(false);
    const p = svgPoint(svg, ev, sid);
    if (rawTool() === "pin" && H.onPin) return H.onPin(p.map(r2), { target: d.stack[0] || { type: "ground" }, point_m: toSite(p), ev });
    // 点一下：同一处（3 px 内、同一叠目标）再点轮到下一层
    const sig = d.stack.map(keyOf).join(";");
    let i = 0;
    if (lastClick && lastClick.sig === sig && Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < 3 && d.stack.length > 1) i = (lastClick.i + 1) % d.stack.length;
    lastClick = { sig, x: ev.clientX, y: ev.clientY, i };
    if (H.onSelect) H.onSelect(d.stack[i] || { type: "ground" }, p, ev);
  };
  const L = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", cancelAll], ["pointerleave", onLeave], ["contextmenu", onMenu]];
  for (const [k, f] of L) svg.addEventListener(k, f);
  svg.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey, true); window.addEventListener("keyup", onKey, true);
  if (toolNow() === "height") svg.style.cursor = "crosshair";
  function unbind() { cancelAll(); for (const [k, f] of L) svg.removeEventListener(k, f); svg.removeEventListener("wheel", onWheel); window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKey, true); }
  return unbind;
}
