// views/profile.js — 剖面：沿主路或一条直线、带宽度（数据来自 engine/section.js 的 sampleSection）。
// 画：地面线、台地平台段（可拖）、带内体块、全部地标（顶边可拖）、地下 / 空中空间的内部切面（每个内部层的通道段、房间、层间连接）、
// 连接点、每层高把手。v5：带内形体按真实高度画轮廓（锥 / 尖顶三角、穹顶半圆、拱两腿 + 弧、环两截管、浮岛倒三角），悬空的画在空中。
// 层号与俯视图统一：第 1 层 = 入口地面。纵向有夸张，标注一律写真实米数。
// 拖动只改 DOM，节流 120 ms 调 onDragLive（给 3D 预览）；松手才回调。纯函数，不 import app.js / ui.js，不调 AI。
import { svgel, spawnOf, spawnY, landmarkOf, SELECT_COLOR, SECTION_COLOR, ROOM_FILL, sublevelOf, interiorLevelName, spaceDepth, shapeOf, volDims, roofOf, volumeBase, elevOf, volumeType, volumeColor, paletteOf, archThickness, torusTube, volToWorld, isUpright, opHeightInfo } from "./map.js";
import { sampleSection, projectToPath, SECTION_WIDTH } from "../engine/section.js";
import { SPACE_LABEL, VIA_LABEL, STRATUM_LABEL, LAYOUT_LABEL, SKY_LAYOUT_LABEL, ROLE_LABEL, levelsOf, levelStep } from "../engine/interior.js";

const fmt1 = (v) => Math.round(v * 10) / 10;
const snap = (v) => Math.round(v * 2) / 2;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v);
/** 坡度三档：每层台地高度（米） */
export const SLOPE_STEPS = [[3, "缓"], [4, "中"], [5, "陡"]];
/** 每层高的可调范围（与 terrain.js 的夹取一致） */
export const LAYER_RANGE = [2.5, 6];

// ------------------------------------------------------------ 高度笔刷与地形操作把手的数值（俯视图 bindMap 与剖面共用；docs/07 §4）
/** 每个字段的可调范围（米） */
export const OP_RANGE = { height_m: [-60, 150], depth_m: [0, 80], amplitude_m: [0, 30], step_h_m: [1, 12] };
/** 「+12 m」/「深 4 m」/「起伏 3 m」/「每级 3 m」 */
export const opValueText = (field, v) => (field === "depth_m" ? `深 ${fmt1(v)} m` : field === "amplitude_m" ? `起伏 ${fmt1(v)} m` : field === "step_h_m" ? `每级 ${fmt1(v)} m` : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt1(Math.abs(v))} m`);
/** 「高度」笔刷（跨重绘保留）：半径（米，默认 12）与范围；滚轮 / [ ] 调 */
export const heightBrush = { radius_m: 12, min: 2, max: 80 };
/** 高度工具：屏幕上每拖 1 px = 0.1 m（100 px = 10 m），吸附 0.5 m */
export const HEIGHT_M_PER_PX = 0.1;
export const brushStep = (r, dir) => clampN(Math.round((r + dir * (r < 10 ? 1 : r < 30 ? 2 : 5)) * 2) / 2, heightBrush.min, heightBrush.max);
const sgnM = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt1(Math.abs(v))} m`;
/** 竖向拖动 dyPx（向下为正；mPerPx = 每单位多少米）+ 修饰键 → { delta_m（有符号，+ 抬高 / − 压低）, radius_m, mode }：Shift = flatten（纯削平到按下点高度，竖拖不叠加），Alt = 只压低 */
export function heightStroke(dyPx, mods = {}, mPerPx = HEIGHT_M_PER_PX) {
  // Shift = 纯削平到按下点的高度（docs/07 §4）：竖拖不叠加偏移
  if (mods.shiftKey) return { delta_m: 0, radius_m: heightBrush.radius_m, mode: "flatten" };
  const raw = Math.round(-dyPx * mPerPx * 2) / 2 || 0, delta_m = mods.altKey ? -Math.abs(raw) : raw;
  return { delta_m, radius_m: heightBrush.radius_m, mode: delta_m < 0 || mods.altKey ? "lower" : "raise" };
}
/**
 * 俯视图上的高度笔刷：圈（外圈 = 半径，内圈 = 60%：边上 40% 是平滑过渡）+ 数值。p = null 时藏起来。
 * @param {SVGSVGElement} svg @param {SVGGElement|null} node 上次画的（没有就新建并挂到 svg 上） @param {number[]|null} p 世界 [x, z]
 * @param {{mode: string, delta_m: number}|null} st 拖动中的数值（null = 只是悬停） @param {number} U 图上 1 单位字号
 * @returns {SVGGElement|null} 笔刷节点（下次传回来）
 */
export function drawHeightBrush(svg, node, p, st, U) {
  if (!p) { if (node) node.setAttribute("visibility", "hidden"); return node; }
  const r = heightBrush.radius_m, col = !st ? "#555" : st.mode === "flatten" ? SECTION_COLOR : st.delta_m < 0 ? "#2a6aa6" : "#c0392b";
  if (!node) {
    node = svgel("g", { class: "height-brush", "pointer-events": "none" }, svgel("circle", { class: "brush-ring", fill: "none" }), svgel("circle", { class: "brush-core", fill: "none" }), svgel("circle", { class: "brush-dot" }),
      svgel("text", { class: "brush-text", stroke: "#fff", "paint-order": "stroke", "font-weight": 700 }));
    svg.append(node);
  }
  const [ring, core, dot, txt] = node.childNodes;
  node.removeAttribute("visibility"); node.setAttribute("transform", `translate(${fmt1(p[0])} ${fmt1(p[1])})`); node.setAttribute("data-mode", st ? st.mode : "hover");
  ring.setAttribute("r", fmt1(r)); ring.setAttribute("stroke", col); ring.setAttribute("stroke-width", fmt1(0.4 * U)); ring.setAttribute("fill", col); ring.setAttribute("fill-opacity", st ? 0.1 : 0.04);
  core.setAttribute("r", fmt1(r * 0.6)); core.setAttribute("stroke", col); core.setAttribute("stroke-width", fmt1(0.25 * U)); core.setAttribute("stroke-dasharray", `${fmt1(U)} ${fmt1(0.7 * U)}`);
  dot.setAttribute("r", fmt1(0.6 * U)); dot.setAttribute("fill", col);
  txt.setAttribute("x", fmt1(r * 0.72 + 0.8 * U)); txt.setAttribute("y", fmt1(-r * 0.72)); txt.setAttribute("font-size", fmt1((st ? 3 : 2.3) * U)); txt.setAttribute("fill", col); txt.setAttribute("stroke-width", fmt1(0.7 * U));
  txt.textContent = st ? `${st.mode === "flatten" ? `削平${st.delta_m ? " " + sgnM(st.delta_m) : ""}` : sgnM(st.delta_m)} · 半径 ${fmt1(r)} m` : `高度 · 半径 ${fmt1(r)} m`;
  return node;
}
/** 坡度档位：按区间高亮一档（≤ 3.4 缓，≤ 4.4 中，再高陡）；亮着的不是整档时点它回到整档（act） */
export function slopeChoices(layer) {
  const cur = Number(layer), k = !Number.isFinite(cur) ? -1 : cur <= 3.4 ? 0 : cur <= 4.4 ? 1 : 2;
  return { items: SLOPE_STEPS.map(([v, l], i) => { const on = i === k, off = on && Math.abs(v - cur) > 1e-6; return { v, l, on, act: !on || off, title: off ? `现在每层 ${fmt1(cur)} m，点一下回到 ${v} m` : `每层 ${v} m` }; }) };
}
/** 坡度（Δh/Δd）→ 「31°（59%）」 */
export function slopeLabel(s) { const v = Number(s) || 0; return `${Math.round((Math.atan(v) * 180) / Math.PI)}°（${Math.round(v * 100)}%）`; }
/** 空间标注：「深 2 层 · 净高 3 m」/「高 3 层 · 上方 4 m」（同构成清单与俯视图） */
export function spaceText(sp, n) {
  const lv = n != null ? `${sp.stratum === "underground" ? "深" : "高"} ${n} 层 · ` : "";
  return sp.stratum === "underground" ? `${lv}净高 ${fmt1(sp.height)} m` : `${lv}上方 ${fmt1(sp.height)} m`;
}

/**
 * 画剖面。
 * @param {object} ctx { sid, T, facts?, plan?, stratum?, interiorLevel?: 0|1|2（0 = 入口层）, selected?: {plan_id?, sid_id?, part?},
 *   section?: {mode, line, width_m}（剖切设置）或 sampleSection 的结果；省略时用 sid.meta.section / 默认沿主路 }
 * @param {object} opts 回调都可选，给了才出现对应把手 / 控件：
 *   onTerraceHeight(id, h|null) · onLayerHeight(h) · onLandmarkHeight(h, plan_id, sid_id) · onSpaceFloor(id, y, plan_id) · onSpaceHeight(id, h, plan_id)
 *   onDragHint(text|null) · onDragLive({kind, id, value}|null)（kind ∈ terrace | layer | landmark | space_floor | space_height）
 *   onSelect(target) 点一下（没拖）：target 同俯视图 {type, plan_id?, sid_id?, part?, sublevel?}
 *   onSectionMode("trail"|"line") · onSectionWidth(w) · onSectionWidthLive(w|null) · onSectionRotate(deg) · onSectionTool() · onSlope(layer_m)
 *   onGroundDrag({d, x, z}, delta_m, { live, mode, radius_m })：地面线任意一点上下拖（x, z = 世界坐标；live = true 拖动中节流 120 ms、false 松手）；
 *     Shift = flatten（削平到这点 + delta）、Alt = 只压低，半径 = 俯视图笔刷 heightBrush.radius_m；放弃（Esc / 拖回 0）调 onDragLive(null)
 *   onOpHeight(opId, value, { field })：选中的地形操作的高度把手（value = field 的新值）；拖动中 onDragLive({kind: "op_height", id, value, field})
 * @returns {{ node: HTMLElement, stats: object, scale: { sx, sy, hy, pxPerM } }}
 */
export function renderProfile(ctx, opts = {}) {
  const { sid, T } = ctx;
  const cfg = ctx.section && !Array.isArray(ctx.section.ground) ? ctx.section : (sid.meta && sid.meta.section) || null;
  const S = ctx.section && Array.isArray(ctx.section.ground) ? ctx.section : sampleSection(sid, T, cfg || undefined);
  const mode = ((cfg && cfg.mode) || (ctx.section && ctx.section.mode)) === "line" ? "line" : "trail";
  const stratum = ctx.stratum || "ground", layer = (sid.meta && sid.meta.layer_height_m) || 3;
  const total = Math.max(1, S.length_m || (S.ground.length ? S.ground[S.ground.length - 1].d : 1));
  const hint = (t) => { if (typeof opts.onDragHint === "function") opts.onDragHint(t); };
  const live = typeof opts.onDragLive === "function" ? opts.onDragLive : null;
  const select = typeof opts.onSelect === "function" ? opts.onSelect : null;
  const byId = new Map((sid.spaces || []).map((x) => [x.id, x]));
  const planOf = new Map();
  for (const f of (sid.terrain && sid.terrain.features) || []) if (f.plan_id) planOf.set(f.id, f.plan_id);
  for (const k of ["volumes", "markers", "spaces", "paths", "regions"]) for (const o of sid[k] || []) if (o && o.plan_id) planOf.set(o.id, o.plan_id);
  const envTop = (sp) => { const full = byId.get(sp.id) || sp; return sp.floor_y + (levelsOf(full) - 1) * levelStep(full) + sp.height; };

  // 纵向范围：最深的空间底到最高的体块 / 空中空间顶；上方留 18% 给往上拖
  const hs = S.ground.map((g) => g.h);
  const PV = profileVolumes(sid, T, S);
  let lo = Math.min(0, ...hs), hi = Math.max(layer, ...hs);
  for (const v of PV) hi = Math.max(hi, v.top);
  for (const sp of S.spaces) { if (sp.stratum === "underground") lo = Math.min(lo, sp.floor_y); else hi = Math.max(hi, envTop(sp)); }
  for (const c of S.connectors) { lo = Math.min(lo, c.bottom_y); hi = Math.max(hi, c.top_y); }
  hi += (hi - lo) * 0.18; if (lo < 0) lo -= 1.5;

  const Wv = 320, Hv = 150, mL = 38, mR = 22, mT = 14, mB = 18, pad = 4;
  const sx = (d) => mL + pad + (d / total) * (Wv - mL - mR - 2 * pad);
  const sy = (h) => Hv - mB - ((h - lo) / (hi - lo)) * (Hv - mT - mB);
  const hy = (y) => lo + ((Hv - mB - y) / (Hv - mT - mB)) * (hi - lo);
  const pxPerM = (Hv - mT - mB) / (hi - lo);
  const s = svgel("svg", { viewBox: `0 0 ${Wv} ${Hv}`, class: "profile", style: "touch-action:none" });
  s.append(svgel("rect", { width: Wv, height: Hv, fill: "#fbfaf6" }));
  const drag = makeDrag(s, hint, live);
  const fade = (st) => (stratum !== "ground" && st !== stratum ? 0.35 : 1);
  const grp = (type, sidId, extra = {}) => svgel("g", Object.assign({ "data-type": type, "data-sid-id": sidId, "data-plan-id": planOf.get(sidId) || null }, extra));
  const clickSelect = (node, target) => { if (!select) return; node.style.cursor = node.style.cursor || "pointer"; node.addEventListener("click", (e) => { e.stopPropagation(); select(target(e)); }); };

  // 层线与层号（右侧真实米数）；地面以下只标米数
  const nT = Math.max(2, ((T.terraces || []).reduce((m, t) => Math.max(m, t.level), 0)) + 1), layerLines = [];
  for (let k = 0; k < nT; k++) {
    const y = sy(k * layer); if (y < mT) break;
    const ln = svgel("line", { x1: mL, x2: Wv - mR, y1: y, y2: y, stroke: k === 0 ? "#a9b48f" : "#c9d2b6", "stroke-width": k === 0 ? 0.7 : 0.5, "stroke-dasharray": k === 0 ? null : "2 2" });
    const tl = svgel("text", { x: mL - 3, y: y + 2, "font-size": 5.5, "text-anchor": "end", fill: "#6b7a4b" }, `${k} 层`);
    const tr = svgel("text", { x: Wv - mR + 2, y: y + 2, "font-size": 5, fill: "#999" }, `${k * layer ? "+" : ""}${fmt1(k * layer)} m`);
    s.append(ln, tl, tr); layerLines.push({ k, ln, tl, tr });
  }
  for (let h = -layer; h >= lo; h -= layer) s.append(svgel("text", { x: Wv - mR + 2, y: sy(h) + 2, "font-size": 5, fill: "#999" }, `${fmt1(h)} m`));
  if (lo < 0) s.append(svgel("text", { x: mL - 3, y: sy(lo / 2) + 2, "font-size": 5.5, "text-anchor": "end", fill: "#7a6a55" }, "地下"));

  // 地面（地下层时淡一点，空间才显出来）；沿主路时按坡度着色
  if (S.ground.length > 1) {
    let d = `M${sx(S.ground[0].d)} ${sy(lo)}`;
    for (const g of S.ground) d += ` L${fmt1(sx(g.d))} ${fmt1(sy(g.h))}`;
    d += ` L${fmt1(sx(S.ground[S.ground.length - 1].d))} ${sy(lo)} Z`;
    s.append(svgel("path", { d, fill: "#e4dcc8", opacity: stratum === "underground" ? 0.55 : 0.9 }));
    for (let i = 1; i < S.ground.length; i++) {
      const a = S.ground[i - 1], b = S.ground[i], slope = Math.abs(b.h - a.h) / Math.max(0.01, b.d - a.d);
      s.append(svgel("line", { x1: fmt1(sx(a.d)), y1: fmt1(sy(a.h)), x2: fmt1(sx(b.d)), y2: fmt1(sy(b.h)), stroke: mode === "trail" ? (slope > 0.7 ? "#c0392b" : slope > 0.45 ? "#d98a1a" : "#8b7d5b") : "#8b7d5b", "stroke-width": mode === "trail" ? 2 : 1.2, "stroke-linecap": "round" }));
    }
  }
  const step = total > 160 ? 40 : 20;
  for (let d = 0; d <= total; d += step) { s.append(svgel("line", { x1: sx(d), x2: sx(d), y1: Hv - mB, y2: Hv - mB + 3, stroke: "#999", "stroke-width": 0.5 })); s.append(svgel("text", { x: sx(d), y: Hv - mB + 9, "font-size": 5, "text-anchor": "middle", fill: "#777" }, `${Math.round(d)} m`)); }
  for (const p of S.paths) {
    const g = nearestGround(S.ground, p.d); if (!g) continue;
    s.append(svgel("circle", { cx: fmt1(sx(p.d)), cy: fmt1(sy(g.h)), r: 1.6, fill: p.kind === "river" ? "#4f86c6" : "#8b7d5b", stroke: "#fff", "stroke-width": 0.4 }, svgel("title", {}, p.kind === "river" ? "溪" : "路")));
  }

  // 地面线任意一点可抓（docs/07 §4）：悬停出把手 + 当前高度；上下拖 = 在剖切线上这一点做「高度」操作（盖在体块下面，体块 / 平台照旧先接手势）
  if (typeof opts.onGroundDrag === "function" && S.ground.length > 1) groundGrab(s, S, sx, sy, pxPerM, hint, opts);

  // 带内体块（房子 / 树 / 形体）：按形体画轮廓、按真实高度；悬空的画在空中（虚线吊到地面 + 「↑18 m」）。地标单独画
  const pal = paletteOf(sid), elevSeen = new Set(); // 「↑N m」每组一个（同一模板的实例算一组）
  for (const v of PV) {
    if (v.importance === "landmark") continue;
    const x0 = sx(v.d0), x1 = Math.max(x0 + 1, sx(v.d1)), legacyTree = v.kind === "prop" && !(v.v && v.v.plan_id), tree = legacyTree || v.kind === "tree";
    const type = legacyTree ? "tree" : v.v ? volumeType(v.v) : "house";
    const g = grp(type, v.id, { "data-shape": v.sh, "data-elev": v.elev > 0.5 ? fmt1(v.elev) : null });
    if (legacyTree && v.sh === "box") g.append(svgel("ellipse", { cx: (x0 + x1) / 2, cy: (sy(v.y0) + sy(v.y1)) / 2, rx: (x1 - x0) / 2, ry: Math.max(0.8, (sy(v.y0) - sy(v.y1)) / 2), fill: "#7d9a5f", opacity: 0.55, "data-vis": 1 }));
    else {
      const o = volumeOutline(v, x0, x1, sy, v.y0, v.y1, v.roof ? v.roof.h : 0);
      const fill = tree ? "#7d9a5f" : v.kind === "building" || v.kind === "tower" || !v.v ? "#d9c9a3" : volumeColor(v.v, pal, "side");
      g.append(svgel("path", { d: o.body, fill, stroke: tree ? "none" : "#6f6250", "stroke-width": 0.4, "fill-rule": "evenodd", opacity: tree ? 0.6 : 0.85, "stroke-dasharray": v.elev > 0.5 ? "1.5 1" : null, "data-vis": 1, class: "vol-body" }));
      if (o.roof) g.append(svgel("path", { d: o.roof, fill: "#8a5a4a", stroke: "#4a3a2a", "stroke-width": 0.4, opacity: 0.85, class: "vol-roof", "data-vis": 1 }));
      if (o.extra) g.append(svgel("path", { d: o.extra, fill: "none", stroke: "#7d9a5f", "stroke-width": 1.2, "pointer-events": "none" }));
    }
    if (v.elev > 0.5) {
      const gd = nearestGround(S.ground, (v.d0 + v.d1) / 2), xm = (x0 + x1) / 2;
      if (gd) g.append(svgel("line", { x1: xm, x2: xm, y1: sy(gd.h), y2: sy(v.y0), stroke: "#2a6aa6", "stroke-width": 0.4, "stroke-dasharray": "1.2 1", "pointer-events": "none", class: "elev-line" }));
      const ek = String((v.v && (v.v.instance_of || v.v.plan_id)) || v.id).replace(/\[\d+\]/g, "");
      if (!elevSeen.has(ek)) { elevSeen.add(ek); g.append(svgel("text", { x: x1 + 1.5, y: sy(v.y0) + 2, "font-size": 4.5, fill: "#2a6aa6", "pointer-events": "none", class: "elev-label" }, `↑${Math.round(v.elev)} m`)); }
    }
    if (!legacyTree) clickSelect(g, () => ({ type, sid_id: v.id, plan_id: planOf.get(v.id) }));
    s.append(g);
  }

  // 台地平台段：上下拖 = 只改这一层高度
  const segs = new Map();
  for (const t of S.terraces) {
    const y = sy(t.height), x0 = sx(t.d0), x1 = sx(t.d1), g = grp("feature", t.id);
    const vis = svgel("line", { x1: x0, x2: x1, y1: y, y2: y, stroke: t.user_height ? "#b8452b" : "#6b7a4b", "stroke-width": 1.6, "stroke-linecap": "round", "pointer-events": "none", "data-vis": 1 });
    const hit = svgel("rect", { x: x0, y: y - 3.5, width: Math.max(2, x1 - x0), height: 7, fill: "transparent", class: "h-terrace", "data-id": t.id, style: opts.onTerraceHeight ? "cursor:ns-resize" : null }, svgel("title", {}, `${t.level} 层 · +${fmt1(t.height)} m${opts.onTerraceHeight ? "（上下拖）" : ""}`));
    g.append(vis, hit); s.append(g);
    if (!segs.has(t.id)) segs.set(t.id, []);
    segs.get(t.id).push({ vis, hit, t });
  }
  for (const [id, list] of segs) {
    const t = list[0].t, target = () => ({ type: "feature", sid_id: id, plan_id: planOf.get(id) });
    if (t.user_height) {
      const mid = list.reduce((a, b) => (b.t.d1 - b.t.d0 > a.t.d1 - a.t.d0 ? b : a));
      const tag = svgel("text", { x: fmt1((sx(mid.t.d0) + sx(mid.t.d1)) / 2), y: fmt1(sy(t.height) - 3), "font-size": 5, "text-anchor": "middle", fill: "#b8452b", class: "h-reset", "data-id": id, style: opts.onTerraceHeight ? "cursor:pointer" : null }, opts.onTerraceHeight ? "已单独调 · 恢复" : "已单独调");
      if (opts.onTerraceHeight) tag.addEventListener("click", (e) => { e.stopPropagation(); opts.onTerraceHeight(id, null); });
      s.append(tag);
    }
    if (typeof opts.onTerraceHeight !== "function") { for (const { hit } of list) clickSelect(hit, target); continue; }
    for (const { hit } of list) drag(hit, {
      move: (dy) => { const h = clampN(snap(t.height - dy / pxPerM), -20, 80); for (const q of list) { q.vis.setAttribute("y1", sy(h)); q.vis.setAttribute("y2", sy(h)); q.hit.setAttribute("y", sy(h) - 3.5); } return { h, text: `第 ${t.level} 层：${sgn(h)} m` }; },
      live: (r) => ({ kind: "terrace", id, value: r.h }),
      click: select && (() => select(target())),
      end: (r) => { if (r.h !== t.height) opts.onTerraceHeight(id, r.h); },
    });
  }

  // 地下 / 空中空间：外框（岩层 / 空域）里画每个内部层的切面——通道段、房间、层间连接；当前内部层实画，其它淡画
  for (const sp of S.spaces) {
    const full = byId.get(sp.id) || sp, n = levelsOf(full), stepY = levelStep(full), under = sp.stratum === "underground", top = envTop(sp);
    const nL = full && full.polygon && T ? spaceDepth(full, { meta: { layer_height_m: layer } }, T) : null, pid = full.plan_id || sp.id;
    const name = sp.label || STRATUM_LABEL[sp.stratum] + (SPACE_LABEL[sp.kind] || "空间"), lay = (under ? LAYOUT_LABEL : SKY_LAYOUT_LABEL)[sp.layout] || "";
    const x0 = sx(sp.d0), x1 = Math.max(x0 + 2, sx(sp.d1));
    const g = svgel("g", { class: "space", "data-type": "space", "data-sid-id": sp.id, "data-plan-id": pid, "data-id": sp.id, opacity: fade(sp.stratum) });
    const cur = stratum === sp.stratum ? sublevelOf(full, ctx.interiorLevel) : null;
    const body = svgel("rect", { x: x0, y: sy(top), width: x1 - x0, height: Math.max(1.5, sy(sp.floor_y) - sy(top)), rx: 1, class: "h-space", "data-id": sp.id, "data-vis": 1,
      fill: under ? "#4a4038" : "#d6e9f7", "fill-opacity": under ? 0.75 : 0.5, stroke: under ? "#2a241f" : "#3d8bd0", "stroke-width": 0.4, "stroke-dasharray": under ? null : "2 1.5" }, svgel("title", {}, `${name} · 底面 ${fmt1(sp.floor_y)} m${opts.onSpaceFloor ? "（上下拖）" : ""}`));
    const parts = svgel("g", { class: "interior", "pointer-events": "visiblePainted" });
    const partAttrs = (type, o) => ({ "data-type": type, "data-sid-id": sp.id, "data-plan-id": pid, "data-part": o.id, "data-sublevel": o.sublevel | 0, opacity: cur == null || (o.sublevel | 0) === cur ? 1 : 0.45 });
    const hasInterior = (full.passages && full.passages.length) || (full.rooms && full.rooms.length);
    for (const p of sp.passages || []) parts.append(svgel("rect", Object.assign(partAttrs("passage", p), { x: fmt1(sx(p.d0)), y: fmt1(sy(p.floor_y + p.height)), width: fmt1(Math.max(0.8, sx(p.d1) - sx(p.d0))), height: fmt1(Math.max(0.8, sy(p.floor_y) - sy(p.floor_y + p.height))), fill: under ? "#efe4cc" : "#a0784a", stroke: under ? "#2a241f" : "#6b4f2a", "stroke-width": 0.25, "data-vis": 1 }), svgel("title", {}, `通道 · ${interiorLevelName(full, p.sublevel | 0)} · 宽 ${fmt1(p.width)} m`)));
    for (const r of sp.rooms || []) {
      const rx0 = sx(r.d0), rw = Math.max(1, sx(r.d1) - rx0), ry = sy(r.floor_y + r.height), rh = Math.max(1, sy(r.floor_y) - ry), nm = r.label || ROLE_LABEL[r.role] || "房间";
      parts.append(svgel("rect", Object.assign(partAttrs("room", r), { x: fmt1(rx0), y: fmt1(ry), width: fmt1(rw), height: fmt1(rh), fill: ROOM_FILL[r.role] || ROOM_FILL.chamber, stroke: "#2a241f", "stroke-width": 0.3, "data-vis": 1 }), svgel("title", {}, `${nm} · ${interiorLevelName(full, r.sublevel | 0)}`)));
      if (r.role !== "chamber" && textWidth(nm, 4) <= rw - 1 && rh >= 5) parts.append(svgel("text", Object.assign(partAttrs("room", r), { x: fmt1(rx0 + rw / 2), y: fmt1(ry + rh / 2 + 1.5), "font-size": 4, "text-anchor": "middle", fill: "#3b2f20", "pointer-events": "none" }), nm));
    }
    for (const l of sp.links || []) {
      const x = sx(l.d), yb = sy(l.y0), yt = sy(l.y1), lk = svgel("g", { "data-type": "link", "data-sid-id": sp.id, "data-plan-id": pid, "data-part": l.id });
      lk.append(svgel("line", { x1: x - 1, x2: x - 1, y1: yt, y2: yb, stroke: "#6b4f2a", "stroke-width": 0.5 }), svgel("line", { x1: x + 1, x2: x + 1, y1: yt, y2: yb, stroke: "#6b4f2a", "stroke-width": 0.5 }));
      for (let y = yb - 1.5; y > yt; y -= 2) lk.append(svgel("line", { x1: x - 1, x2: x + 1, y1: fmt1(y), y2: fmt1(y), stroke: "#6b4f2a", "stroke-width": 0.4 }));
      lk.append(svgel("title", {}, `${VIA_LABEL[l.via] || "连接"} · 内部层之间`));
      parts.append(lk);
    }
    // 多层时每层底面一条细线（看得出层次）
    if (n > 1) for (let k = 0; k < n; k++) { const y = sy(sp.floor_y + k * stepY); parts.append(svgel("line", { x1: x0, x2: x1, y1: fmt1(y), y2: fmt1(y), stroke: under ? "#d8cbb0" : "#3d8bd0", "stroke-width": 0.3, "stroke-dasharray": "1 1.5", opacity: 0.6, "pointer-events": "none" })); }
    const topEdge = svgel("rect", { x: x0, y: sy(top) - 2.5, width: x1 - x0, height: 5, fill: "transparent", class: "h-space-top", "data-id": sp.id, style: opts.onSpaceHeight ? "cursor:ns-resize" : null }, svgel("title", {}, `${name} · 上边：每层${under ? "净高" : "上方高度"}（上下拖）`));
    // 标注：块上方一行「名字 · 布局 · −2 层 · 净高 3 m」；切线没碰到通道 / 房间时补一句
    const txt = `${name}${lay ? ` · ${lay}` : ""}${n > 1 ? ` · ${n} 层` : ""} · ${spaceText(sp, nL)}${hasInterior && !(sp.passages || []).length && !(sp.rooms || []).length ? "（这里切到岩层）" : ""}`;
    const right = (x0 + x1) / 2 > Wv / 2, fits = textWidth(txt, 5) <= x1 - x0;
    const ty = sy(top) - 2.5;
    const t1 = svgel("text", { x: fits ? (x0 + x1) / 2 : right ? x1 : x0, y: fmt1(ty), "font-size": 5, "text-anchor": fits ? "middle" : right ? "end" : "start", fill: under ? "#3b342d" : "#2a6aa6", stroke: "#fff", "stroke-width": 1.2, "paint-order": "stroke", "pointer-events": "none" }, txt);
    g.append(body, parts, t1, topEdge);
    s.append(g);
    const y0s = [body, t1, topEdge].map((p) => Number(p.getAttribute("y")));
    const target = (e) => { const el = e && e.target && e.target.closest && e.target.closest("[data-part]"); return el ? { type: el.getAttribute("data-type"), plan_id: pid, sid_id: sp.id, part: el.getAttribute("data-part"), sublevel: el.hasAttribute("data-sublevel") ? Number(el.getAttribute("data-sublevel")) : undefined } : { type: "space", plan_id: pid, sid_id: sp.id }; };
    if (typeof opts.onSpaceFloor === "function") {
      body.style.cursor = "move"; parts.style.cursor = "move";
      for (const el of [body, parts]) drag(el, {
        move: (dy) => { const f = snap(sp.floor_y - dy / pxPerM), shift = (f - sp.floor_y) * pxPerM; [body, t1, topEdge].forEach((p, i) => p.setAttribute("y", fmt1(y0s[i] - shift))); parts.setAttribute("transform", `translate(0 ${fmt1(-shift)})`); return { f, text: `${name} 底面 ${sgn(f)} m` }; },
        live: (r) => ({ kind: "space_floor", id: sp.id, value: r.f }),
        click: select && ((e) => select(target(e))),
        end: (r) => { if (r.f !== sp.floor_y) opts.onSpaceFloor(sp.id, r.f, pid); },
      });
    } else { clickSelect(body, target); clickSelect(parts, target); }
    if (typeof opts.onSpaceHeight === "function") drag(topEdge, {
      move: (dy) => {
        const h = clampN(snap(sp.height - dy / pxPerM / n), 2.2, 12), ty2 = sy(sp.floor_y + (n - 1) * (h + (under ? 2 : 1)) + h);
        topEdge.setAttribute("y", ty2 - 2.5); body.setAttribute("y", ty2); body.setAttribute("height", Math.max(1, sy(sp.floor_y) - ty2));
        return { h, text: `${name} 每层${under ? "净高" : "上方"} ${h} m` };
      },
      live: (r) => ({ kind: "space_height", id: sp.id, value: r.h }),
      end: (r) => { if (r.h !== sp.height) opts.onSpaceHeight(sp.id, r.h, pid); },
    });
  }

  // 连接点：竖线 + 方式符号
  for (const c of S.connectors) {
    const m = (sid.markers || []).find((x) => x.id === c.id);
    const st = m && m.to !== "ground" && byId.get(m.to) ? byId.get(m.to).stratum : m && byId.get(m.from) ? byId.get(m.from).stratum : "ground";
    const g = drawConnector(c, sx(c.d), sy(c.bottom_y), sy(c.top_y));
    g.setAttribute("opacity", fade(st)); g.setAttribute("data-type", "connector"); g.setAttribute("data-sid-id", c.id); if (planOf.get(c.id)) g.setAttribute("data-plan-id", planOf.get(c.id));
    g.append(svgel("title", {}, `${(m && m.label) || VIA_LABEL[c.via] || "连接点"} · ${fmt1(c.bottom_y)} → ${fmt1(c.top_y)} m`));
    clickSelect(g, () => ({ type: "connector", sid_id: c.id, plan_id: planOf.get(c.id) }));
    s.append(g);
  }

  // 入口小人（1.7 m）：投到剖切线、在带内才画
  const sp0 = spawnOf(sid);
  let eye = null;
  if (sp0 && S.path && S.path.length > 1) {
    const pr = projectToPath(S.path, [sp0.position[0], sp0.position[2]]);
    if (pr.off <= S.width_m / 2 + 2) {
      const g = nearestGround(S.ground, pr.d), h = Math.max(g ? g.h : 0, spawnY(sp0, T)), x0 = sx(pr.d), y0 = sy(h), yh = sy(h + 1.7);
      eye = { x: x0, y: yh };
      s.append(svgel("line", { x1: x0, x2: x0, y1: y0, y2: yh + 2, stroke: "#1f6feb", "stroke-width": 1.4 }), svgel("circle", { cx: x0, cy: yh + 1, r: 1.6, fill: "#1f6feb" }));
      s.append(svgel("text", { x: x0 + 3, y: yh - 1, "font-size": 5.5, fill: "#1f6feb" }, "出生点"));
    }
  }

  // 地标（全部）：顶边上下拖 = 这个地标的高度；入口到主地标画视线
  const focus = landmarkOf(sid);
  for (const lmv of PV.filter((v) => v.importance === "landmark")) {
    const x0 = sx(lmv.d0), x1 = Math.max(x0 + 5, sx(lmv.d1)), h0 = lmv.y1 - lmv.y0, rh = lmv.roof ? lmv.roof.h : 0, pid = planOf.get(lmv.id) || lmv.id;
    const g = grp("landmark", lmv.id, { "data-shape": lmv.sh, "data-elev": lmv.elev > 0.5 ? fmt1(lmv.elev) : null });
    const shapeD = (h) => { const o = volumeOutline(lmv, x0, x1, sy, lmv.y0, lmv.y0 + h, rh); return o.body + (o.roof || ""); };
    const body = svgel("path", { d: shapeD(h0), fill: "#b8452b", stroke: "#4a1a10", "stroke-width": 0.5, "fill-rule": "evenodd", "stroke-dasharray": lmv.elev > 0.5 ? "1.5 1" : null, "data-vis": 1, class: "vol-body" });
    const lab = svgel("text", { x: (x0 + x1) / 2, y: sy(lmv.y1 + rh) - 3, "font-size": 5.5, "text-anchor": "middle", fill: "#4a1a10", stroke: "#fff", "stroke-width": 1.2, "paint-order": "stroke" }, `${lmv.label || "地标"} ${fmt1(h0 + rh)} m`);
    const top = svgel("rect", { x: x0 - 1, y: sy(lmv.y1 + rh) - 2.5, width: x1 - x0 + 2, height: 5, fill: "transparent", class: "h-landmark", "data-id": lmv.id, style: opts.onLandmarkHeight ? "cursor:ns-resize" : null }, svgel("title", {}, `${lmv.label || "地标"} 顶边（上下拖改高度）`));
    let sight = null;
    if (eye && focus && focus.id === lmv.id) { sight = svgel("line", { x1: eye.x, y1: eye.y, x2: (x0 + x1) / 2, y2: sy(lmv.y1 + rh), stroke: "#1f6feb", "stroke-width": 0.5, "stroke-dasharray": "1.5 1.5", opacity: 0.8, "pointer-events": "none" }); s.append(sight); }
    g.append(body, lab, top); s.append(g);
    const target = () => ({ type: "landmark", plan_id: pid, sid_id: lmv.id });
    clickSelect(body, target);
    if (typeof opts.onLandmarkHeight === "function") drag(top, {
      move: (dy) => {
        const h = clampN(snap(h0 - dy / pxPerM), 1, 60), ty = sy(lmv.y0 + h + rh);
        body.setAttribute("d", shapeD(h)); top.setAttribute("y", ty - 2.5); lab.setAttribute("y", ty - 3); lab.textContent = `${lmv.label || "地标"} ${fmt1(h + rh)} m`;
        if (sight) sight.setAttribute("y2", ty);
        return { h, text: `${lmv.label || "地标"}高 ${fmt1(h + rh)} m` };
      },
      live: (r) => ({ kind: "landmark", id: lmv.id, value: fmt1(r.h + rh) }),
      click: select ? () => select(target()) : null,
      end: (r) => { if (r.h !== h0) opts.onLandmarkHeight(fmt1(r.h + rh), pid, lmv.id); }, // 报总高（SID size[1] 含屋顶）
    });
  }

  // 选中的地形操作：高度把手（上下拖改 height_m / depth_m …；投到剖切线上它中心的位置，横线 = 它的影响范围）
  const opI = ctx.selected && ctx.selected.plan_id && typeof opts.onOpHeight === "function" ? opHeightInfo(ctx.plan || (sid.meta && sid.meta.plan), sid, ctx.selected.plan_id) : null;
  if (opI && opI.field && S.path && S.path.length > 1) opHandle(s, S, opI, { sx, sy, pxPerM, total, drag, opts });

  // 每层高把手：左上角「每层高 3 m ↕」，上下拖等比缩放所有层线
  const topK = layerLines.length ? layerLines[layerLines.length - 1].k : 1, knobY = mT - 4;
  const knob = svgel("text", { x: 2, y: knobY, "font-size": 5.5, fill: "#6b7a4b", class: "h-layer", style: opts.onLayerHeight ? "cursor:ns-resize" : null }, `每层高 ${layer} m${opts.onLayerHeight ? " ↕" : ""} · 纵向有夸张`);
  s.append(knob);
  if (typeof opts.onLayerHeight === "function") {
    const hitK = svgel("rect", { x: 0, y: 0, width: 70, height: mT, fill: "transparent", class: "h-layer-hit", style: "cursor:ns-resize" }, svgel("title", {}, "上下拖改每层高（等于坡度）"));
    s.append(hitK);
    drag(hitK, {
      move: (dy) => {
        const h = clampN(snap(layer - dy / pxPerM / Math.max(1, topK)), LAYER_RANGE[0], LAYER_RANGE[1]);
        for (const L of layerLines) { const y = sy(L.k * h); L.ln.setAttribute("y1", y); L.ln.setAttribute("y2", y); L.tl.setAttribute("y", y + 2); L.tr.setAttribute("y", y + 2); L.tr.textContent = `${L.k ? "+" : ""}${fmt1(L.k * h)} m`; }
        knob.textContent = `每层高 ${h} m ↕ · 纵向有夸张`;
        const on = slopeChoices(h).items.find((x) => x.on);
        return { h, text: `每层高 ${h} m${on ? `（${on.l}）` : ""}` };
      },
      live: (r) => ({ kind: "layer", id: null, value: r.h }),
      end: (r) => { if (r.h !== layer) opts.onLayerHeight(r.h); },
    });
  }

  // 选中高亮：按 plan_id（它生成的全部）或 sid_id / part（单个）描橙边
  const sel = ctx.selected;
  if (sel && (sel.plan_id || sel.sid_id)) for (const g of s.querySelectorAll("[data-type]")) {
    const hit = sel.sid_id ? g.getAttribute("data-sid-id") === sel.sid_id && (!sel.part || g.getAttribute("data-part") === sel.part) : g.getAttribute("data-plan-id") === sel.plan_id && (!sel.part || g.getAttribute("data-part") === sel.part);
    if (!hit) continue;
    g.setAttribute("data-selected", 1);
    for (const v of g.hasAttribute("data-vis") ? [g] : g.querySelectorAll("[data-vis]")) { if (sel.part && !v.closest(`[data-part="${sel.part}"]`) && !v.hasAttribute("data-part")) continue; v.setAttribute("stroke", SELECT_COLOR); v.setAttribute("stroke-width", v.tagName === "line" ? 2.4 : 1); }
  }

  // ---------- 说明与控件
  const f = (ctx.facts && ctx.facts.trail) || {};
  const climb = mode === "trail" && f.climb_m != null ? f.climb_m : hs.length ? Math.max(...hs) - Math.min(...hs) : 0;
  const interior = S.spaces.reduce((a, x) => a + (x.passages || []).length + (x.rooms || []).length, 0);
  const stats = { mode, width_m: S.width_m, length_m: Math.round(total), climb_m: Math.round(climb), max_slope: mode === "trail" ? f.max_slope : undefined, steps: mode === "trail" ? f.steps_estimate : undefined, folds: mode === "trail" ? f.folds : undefined, spaces: S.spaces.length, interior_parts: interior, connectors: S.connectors.length, landmarks: S.volumes.filter((v) => v.importance === "landmark").length, shapes: PV.length };
  const cap = document.createElement("div");
  cap.className = "caption";
  if (mode === "trail") {
    const local = f.max_local_slope != null && f.max_slope != null && f.max_local_slope > f.max_slope + 0.05 ? f.max_local_slope : null;
    const bits = [`沿主路 ${stats.length_m} m`, `爬升 ${stats.climb_m} m（0→${Math.round(climb / layer)} 层）`];
    if (f.max_slope != null) bits.push(`最陡 ${slopeLabel(f.max_slope)}${local != null ? `（台阶处 ${Math.round((Math.atan(local) * 180) / Math.PI)}°）` : ""}`);
    if (f.steps_estimate != null) bits.push(`约 ${Math.round(f.steps_estimate)} 级`);
    if (f.folds != null) bits.push(f.folds === 0 ? "直上" : `之字 ${f.folds} 折`);
    cap.append(span(bits.join(" · ")));
  } else cap.append(span(`直线剖切 ${stats.length_m} m · 高差 ${stats.climb_m} m`));
  if (S.spaces.length) cap.append(span(`切到 ${S.spaces.length} 个空间${interior ? `（${interior} 段通道 / 房间）` : ""}${S.connectors.length ? ` · ${S.connectors.length} 个连接点` : ""}`));
  if (Object.keys(opts).some((k) => k.startsWith("on") && !["onDragHint", "onDragLive", "onSelect"].includes(k))) cap.append(span(opts.onGroundDrag ? "上下拖地面线任意一点 / 平台 / 顶边 / 空间改高度（Shift 削平 · Alt 只压低）" : "上下拖平台 / 顶边 / 空间改高度"));
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.append(s, cap);
  const row = controls(mode, S.width_m, layer, opts);
  if (row) wrap.append(row);
  return { node: wrap, stats, scale: { sx, sy, hy, pxPerM } };
}

/** 粗估文字宽（SVG 单位）：中文 ≈ 1 个字号，其它 ≈ 0.55 个字号 */
// ------------------------------------------------------------ 形体轮廓（v5）
/**
 * 剖面带内体块 + 真实形体信息：{...sampleSection 的体块, v, sh, roof, elev, y0 底, y1 墙顶, top 最高点}。
 * 底：悬空的按 volumeBase（地面 + elev），其余沿用 sampleSection（不低于中心地面）。
 */
export function profileVolumes(sid, T, S) {
  const byId = new Map((sid.volumes || []).filter((v) => v && Array.isArray(v.position)).map((v) => [v.id, v]));
  return S.volumes.map((sv) => {
    const v = byId.get(sv.id);
    if (!v) return Object.assign({}, sv, { v: null, sh: "box", roof: null, elev: 0, top: sv.y1 });
    const e = elevOf(v), y0 = e > 0 ? volumeBase(v, T) : sv.y0, h = volDims(v)[1], roof = roofOf(v);
    let hiRight = true;
    if (shapeOf(v) === "wedge") { const [, , d] = volDims(v); hiRight = projectToPath(S.path, volToWorld(v, 0, -d / 2)).d >= projectToPath(S.path, volToWorld(v, 0, d / 2)).d; }
    return Object.assign({}, sv, { v, sh: shapeOf(v), roof, elev: e, y0, y1: y0 + h, top: y0 + h + (roof ? roof.h : 0), plan_id: v.plan_id || null, hiRight });
  });
}
/**
 * 一个体块在剖面上的轮廓（屏幕坐标 path d）：x0..x1 横向，sy 把米换成屏幕 y；y0 底、y1 墙顶（米），rh 屋顶高。
 * box / cylinder / prism 矩形；cone / pyramid 三角；dome 半椭圆；sphere 椭圆；wedge 直角三角（高边朝剖面上它真实的那一侧）；
 * arch 两腿 + 拱弧；torus 两截管（立起来的 = 一个圈）；空心圆柱（剖面带 segs）= 带子上的几段壁；island 倒三角（顶面另给草线 extra）。屋顶：gable / hip 三角、spire 尖三角、dome 半椭圆、flat 薄板。
 * @returns {{body: string, roof: string|null, extra: string|null}}
 */
export function volumeOutline(pv, x0, x1, sy, y0, y1, rh = 0) {
  const f = (n) => fmt1(n), yb = sy(y0), yw = sy(y1), xm = (x0 + x1) / 2, hw = (x1 - x0) / 2, sh = pv.sh || "box";
  const rect = (a, b, t, bt) => `M${f(a)} ${f(bt)}L${f(b)} ${f(bt)}L${f(b)} ${f(t)}L${f(a)} ${f(t)}Z`;
  const halfEll = (a, b, base, top) => `M${f(a)} ${f(base)}A${f((b - a) / 2)} ${f(Math.max(0.5, base - top))} 0 0 1 ${f(b)} ${f(base)}Z`;
  let body, extra = null;
  if (pv.kind === "island") { body = `M${f(x0)} ${f(yw)}L${f(x1)} ${f(yw)}L${f(xm + hw * 0.15)} ${f(yb)}L${f(xm - hw * 0.15)} ${f(yb)}Z`; extra = `M${f(x0)} ${f(yw)}L${f(x1)} ${f(yw)}`; }
  else if (sh === "cone" || sh === "pyramid") body = `M${f(x0)} ${f(yb)}L${f(xm)} ${f(yw)}L${f(x1)} ${f(yb)}Z`;
  else if (sh === "dome") body = halfEll(x0, x1, yb, yw);
  else if (sh === "sphere") { const ry = Math.max(0.5, (yb - yw) / 2), cy = (yb + yw) / 2; body = `M${f(x0)} ${f(cy)}A${f(hw)} ${f(ry)} 0 1 0 ${f(x1)} ${f(cy)}A${f(hw)} ${f(ry)} 0 1 0 ${f(x0)} ${f(cy)}Z`; }
  else if (sh === "wedge") body = pv.hiRight === false ? `M${f(x0)} ${f(yb)}L${f(x1)} ${f(yb)}L${f(x0)} ${f(yw)}Z` : `M${f(x0)} ${f(yb)}L${f(x1)} ${f(yb)}L${f(x1)} ${f(yw)}Z`;
  else if (sh === "torus" && pv.v && isUpright(pv.v)) { // 立起来的环：外圈 + 内圈（侧着看只剩一道竖的椭圆）
    const [w, hh] = volDims(pv.v), t = torusTube(pv.v), ry = Math.max(0.5, (yb - yw) / 2), cy = (yb + yw) / 2, tx = ((x1 - x0) * t) / w, ty = (2 * ry * t) / Math.max(0.1, hh);
    const ell = (rx, r2y) => `M${f(xm - rx)} ${f(cy)}A${f(rx)} ${f(r2y)} 0 1 0 ${f(xm + rx)} ${f(cy)}A${f(rx)} ${f(r2y)} 0 1 0 ${f(xm - rx)} ${f(cy)}Z`;
    body = ell(Math.max(0.4, hw), ry) + (hw - tx > 0.4 && ry - ty > 0.4 ? ell(hw - tx, ry - ty) : "");
  } else if (sh === "torus" && pv.v) {
    const [w] = volDims(pv.v), tw = Math.max(0.8, ((x1 - x0) * torusTube(pv.v)) / w) / 2, ry = Math.max(0.5, (yb - yw) / 2), cy = (yb + yw) / 2;
    body = [x0 + tw, x1 - tw].map((cx) => `M${f(cx - tw)} ${f(cy)}A${f(tw)} ${f(ry)} 0 1 0 ${f(cx + tw)} ${f(cy)}A${f(tw)} ${f(ry)} 0 1 0 ${f(cx - tw)} ${f(cy)}Z`).join("");
  } else if (Array.isArray(pv.segs) && pv.segs.length && pv.d1 > pv.d0) { // 空心圆柱 / 环带：剖切线在带子上的几段（穿过内孔 = 两段壁，中间是空的）
    const k = (x1 - x0) / (pv.d1 - pv.d0);
    body = pv.segs.map(([a, b]) => { const xa = x0 + (a - pv.d0) * k, xb = Math.max(xa + 0.6, x0 + (b - pv.d0) * k); return rect(xa, xb, yw, yb); }).join("");
  } else if (sh === "arch" && pv.v) {
    const [w] = volDims(pv.v), tpx = Math.max(0.8, ((x1 - x0) * archThickness(pv.v)) / w), mpx = (yb - yw) / Math.max(0.1, y1 - y0);
    const ryo = Math.min(yb - yw, (w / 2) * mpx), yc = yw + ryo, ri = Math.max(0.3, hw - tpx), ryi = Math.max(0.3, ryo * (ri / hw));
    body = `M${f(x0)} ${f(yb)}L${f(x0)} ${f(yc)}A${f(hw)} ${f(ryo)} 0 0 1 ${f(x1)} ${f(yc)}L${f(x1)} ${f(yb)}L${f(x1 - tpx)} ${f(yb)}L${f(x1 - tpx)} ${f(yc)}A${f(ri)} ${f(ryi)} 0 0 0 ${f(x0 + tpx)} ${f(yc)}L${f(x0 + tpx)} ${f(yb)}Z`;
  } else body = rect(x0, x1, yw, yb);
  let roof = null;
  if (pv.roof && rh > 0.05) {
    const yt = sy(y1 + rh), o = Math.min(1.2, hw * 0.08), t = pv.roof.type;
    if (t === "dome") roof = halfEll(x0, x1, yw, yt);
    else if (t === "spire") roof = `M${f(xm - hw * 0.8)} ${f(yw)}L${f(xm)} ${f(yt)}L${f(xm + hw * 0.8)} ${f(yw)}Z`;
    else if (t === "flat") roof = rect(x0 - o, x1 + o, yt, yw);
    else roof = `M${f(x0 - o)} ${f(yw)}L${f(xm)} ${f(yt)}L${f(x1 + o)} ${f(yw)}Z`;
  }
  return { body, roof, extra };
}
function textWidth(t, size) { let w = 0; for (const ch of t) w += ch.charCodeAt(0) > 0x2e80 ? size : size * 0.55; return w; }
function nearestGround(ground, d) { let best = null; for (const g of ground) if (!best || Math.abs(g.d - d) < Math.abs(best.d - d)) best = g; return best; }

/** 控件行：沿主路 | 直线、宽度滑块、↺ ↻、在图上拉、坡度 缓 / 中 / 陡 */
function controls(mode, width, layer, opts) {
  const row = document.createElement("div");
  row.className = "caption section-ctl";
  let any = false;
  if (typeof opts.onSectionMode === "function") { row.append(segButtons([["trail", "沿主路"], ["line", "直线"]], mode, opts.onSectionMode)); any = true; }
  if (typeof opts.onSectionWidth === "function") {
    const lab = span(`宽 ${width} m`);
    const r = Object.assign(document.createElement("input"), { type: "range", min: SECTION_WIDTH.min, max: SECTION_WIDTH.max, step: 1, value: width, className: "sec-width", title: "剖切宽度：带内的东西都投到剖面上" });
    r.addEventListener("input", () => { lab.textContent = `宽 ${r.value} m`; if (typeof opts.onSectionWidthLive === "function") opts.onSectionWidthLive(Number(r.value)); });
    r.addEventListener("change", () => { const w = Number(r.value); if (w !== width) opts.onSectionWidth(w); else if (typeof opts.onSectionWidthLive === "function") opts.onSectionWidthLive(null); });
    const box = document.createElement("span"); box.className = "sec-wbox"; box.append(r, lab);
    row.append(box); any = true;
  }
  if (typeof opts.onSectionRotate === "function") { row.append(button("↺15°", () => opts.onSectionRotate(15), "sec-rot-l", "逆时针转 15°"), button("↻15°", () => opts.onSectionRotate(-15), "sec-rot-r", "顺时针转 15°")); any = true; }
  if (typeof opts.onSectionTool === "function") { row.append(button("在图上拉", () => opts.onSectionTool(), "sec-tool", "在俯视图上拉一条剖切线")); any = true; }
  if (typeof opts.onSlope === "function") {
    const box = document.createElement("span"); box.className = "slope-chips"; box.append(span("坡度"));
    const seg = document.createElement("span"); seg.className = "seg";
    for (const it of slopeChoices(layer).items) seg.append(button(it.l, () => { if (it.act) opts.onSlope(it.v); }, it.on ? "on" : "", it.title));
    box.append(seg); row.append(box); any = true;
  }
  return any ? row : null;
}

// ---------- 小部件
/**
 * 拖动：pointerdown 记起点，pointermove 只改 DOM（move 返回 { text, ... }），pointerup 才 end。
 * live(r) → {kind, id, value} 时拖动中节流 120 ms 调 onDragLive；Esc / pointercancel 放弃时 onDragLive(null)。没动过（< 0.8）算点一下（click(downEvent)）。
 */
const LIVE_MS = 120;
function makeDrag(svg, hint, onLive) {
  const svgY = (e) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()).y : e.clientY; };
  return (el, { move, end, live, click }) => el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const y0 = svgY(e);
    let last = null, tLive = 0, timer = null;
    const sendLive = () => { timer = null; tLive = performance.now(); if (last && onLive && live) onLive(live(last)); };
    const queueLive = () => { if (!onLive || !live || timer) return; const wait = LIVE_MS - (performance.now() - tLive); if (wait <= 0) sendLive(); else timer = setTimeout(sendLive, wait); };
    const off = () => { if (timer) clearTimeout(timer); timer = null; window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", esc, true); };
    const mv = (ev) => { const dy = svgY(ev) - y0; if (!last && Math.abs(dy) < 0.8) return; last = move(dy) || {}; hint(last.text || null); queueLive(); };
    const up = () => { off(); hint(null); if (last) end(last); else if (click) click(e); };
    const cancel = () => { off(); hint(null); if (last && onLive) onLive(null); last = null; };
    const esc = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", esc, true);
  });
}

/** 连接点符号：楼梯 = 折线，梯子 = 双轨加横档，井 / 竖井 = 窄框，升降台 = 框加箭头，其余 = 粗竖线 */
function drawConnector(c, x, yb, yt) {
  const g = svgel("g", { class: "connector", "data-id": c.id });
  const col = "#6b4f2a", top = Math.min(yb, yt), bot = Math.max(yb, yt), H = bot - top;
  if (c.via === "stairs" || c.via === "ramp") {
    if (c.via === "ramp") g.append(svgel("line", { x1: x - 2, y1: bot, x2: x + 2, y2: top, stroke: col, "stroke-width": 1.2, "data-vis": 1 }));
    else { let d = `M${fmt1(x - 2)} ${fmt1(bot)}`; const n = Math.max(2, Math.round(H / 3)); for (let i = 1; i <= n; i++) d += ` L${fmt1(i % 2 ? x + 2 : x - 2)} ${fmt1(bot - (H * i) / n)}`; g.append(svgel("path", { d, fill: "none", stroke: col, "stroke-width": 0.8, "data-vis": 1 })); }
  } else if (c.via === "ladder") {
    g.append(svgel("line", { x1: x - 1.2, x2: x - 1.2, y1: top, y2: bot, stroke: col, "stroke-width": 0.5, "data-vis": 1 }), svgel("line", { x1: x + 1.2, x2: x + 1.2, y1: top, y2: bot, stroke: col, "stroke-width": 0.5 }));
    for (let y = bot - 1.5; y > top; y -= 2) g.append(svgel("line", { x1: x - 1.2, x2: x + 1.2, y1: fmt1(y), y2: fmt1(y), stroke: col, "stroke-width": 0.4 }));
  } else if (c.via === "well" || c.via === "shaft" || c.via === "elevator") {
    const w = c.via === "shaft" ? 3.2 : 2.4;
    g.append(svgel("rect", { x: x - w / 2, y: top, width: w, height: Math.max(1, H), fill: c.via === "elevator" ? "none" : "#2c3e50", "fill-opacity": 0.25, stroke: col, "stroke-width": 0.5, "data-vis": 1 }));
    if (c.via === "elevator") g.append(svgel("path", { d: `M${x} ${fmt1(top + 1)} l-1 2 h2 Z M${x} ${fmt1(bot - 1)} l-1 -2 h2 Z`, fill: col }));
  } else g.append(svgel("line", { x1: x, x2: x, y1: top, y2: bot, stroke: col, "stroke-width": 1.4, "stroke-dasharray": c.via === "rope_bridge" ? "1.5 1" : null, "data-vis": 1 }));
  g.append(svgel("circle", { cx: x, cy: top, r: 1, fill: col }), svgel("circle", { cx: x, cy: bot, r: 1, fill: col }));
  return g;
}
function segButtons(items, cur, on) {
  const box = document.createElement("span");
  box.className = "seg pill-seg";
  for (const [v, l] of items) box.append(button(l, () => { if (v !== cur) on(v); }, "seg-" + v + (v === cur ? " on" : "")));
  return box;
}
function button(text, on, cls, title) { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (cls) b.className = cls; if (title) b.title = title; b.addEventListener("click", on); return b; }
function span(t) { const e = document.createElement("span"); e.textContent = t; return e; }

// ---------- 随意选点调高度（docs/07 §4）
const r2p = (v) => Math.round(v * 100) / 100;
/** 笔刷权重：中心 60% 全量，外 40% 平滑过渡到 0（与引擎 edge slope 同一口径） */
const brushW = (dist, r) => { if (dist >= r) return 0; if (dist <= r * 0.6) return 1; const t = (r - dist) / (r * 0.4); return t * t * (3 - 2 * t); };
/** 一次高度操作后的地面（近似预览，真结果等引擎重算）：raise 只抬、lower 只压、flatten 拉向目标 */
function brushGround(G, pt, ref, st) {
  const tgt = ref + st.delta_m;
  return G.map((g) => {
    const w = brushW(Math.hypot(g.x - pt.x, g.z - pt.z), st.radius_m), h = g.h + (tgt - g.h) * w;
    return { d: g.d, h: st.mode === "flatten" ? h : st.mode === "lower" ? Math.min(g.h, h) : Math.max(g.h, h), w };
  }).filter((g, i, A) => g.w > 0 || (A[i - 1] && A[i - 1].w > 0) || (A[i + 1] && A[i + 1].w > 0)); // 只画变了的那一段（两头各多一点接上原地面）
}
/**
 * 地面线抓取：透明粗线接手势；悬停显示把手与当前高度；按下 → 上下拖（纵向按剖面比例，吸附 0.5 m）→ 虚线预览改后的地面 + 「+4.5 m」；
 * 拖动中节流调 onGroundDrag(pt, delta, {live: true})，松手调 {live: false}；Esc / 没拖出数值 → onDragLive(null)。
 */
function groundGrab(s, S, sx, sy, pxPerM, hint, opts) {
  const G = S.ground.filter((g) => Number.isFinite(g.x) && Number.isFinite(g.z));
  if (G.length < 2) return;
  const line = (arr) => arr.map((g, i) => `${i ? "L" : "M"}${fmt1(sx(g.d))} ${fmt1(sy(g.h))}`).join("");
  const hit = svgel("path", { d: line(G), fill: "none", stroke: "#000", "stroke-opacity": 0, "stroke-width": 7, "stroke-linecap": "round", class: "h-ground", "data-type": "ground_line", style: "cursor:ns-resize" }, svgel("title", {}, "地面：任意一点上下拖 = 抬高 / 压低（Shift 削平，Alt 只压低）"));
  const ghost = svgel("path", { fill: "none", stroke: "#c0392b", "stroke-width": 1.1, "stroke-dasharray": "2 1.2", "pointer-events": "none", class: "ground-ghost", visibility: "hidden" });
  const knob = svgel("g", { class: "ground-knob", "pointer-events": "none", visibility: "hidden" }, svgel("circle", { r: 2.2, fill: "#fff", stroke: "#c0392b", "stroke-width": 0.8 }),
    svgel("text", { x: 3.4, y: -2.6, "font-size": 5, fill: "#c0392b", stroke: "#fff", "stroke-width": 1.2, "paint-order": "stroke", class: "ground-knob-text" }));
  // 拖动中跟着指针的大号数值：剖面纵向有夸张（拖 1 px 比俯视图多出好几倍米数），旁边直接写出放大倍数
  const tag = svgel("g", { class: "ground-live", "pointer-events": "none", visibility: "hidden" },
    svgel("text", { "font-size": 8, "font-weight": 700, fill: "#c0392b", stroke: "#fff", "stroke-width": 1.6, "paint-order": "stroke", class: "ground-live-v" }),
    svgel("text", { "font-size": 4.6, fill: "#7a3b2e", stroke: "#fff", "stroke-width": 1.2, "paint-order": "stroke", class: "ground-live-n" }));
  const G1 = G[G.length - 1], hpm = (sx(G1.d) - sx(G[0].d)) / Math.max(0.01, G1.d - G[0].d), ex = pxPerM / Math.max(1e-6, hpm), VW = (s.viewBox && s.viewBox.baseVal && s.viewBox.baseVal.width) || 320;
  const showTag = (c, big, small) => {
    const right = c.x > VW - 110, x = right ? c.x - 5 : c.x + 6, y = Math.max(12, c.y - 4), [tv, tn] = tag.children;
    for (const t of [tv, tn]) { t.setAttribute("x", fmt1(x)); t.setAttribute("text-anchor", right ? "end" : "start"); }
    tv.setAttribute("y", fmt1(y)); tn.setAttribute("y", fmt1(y + 6)); tv.textContent = big; tn.textContent = small;
    tag.removeAttribute("visibility");
  };
  s.append(hit, ghost, knob, tag);
  const toSvg = (e) => { const m = s.getScreenCTM(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : { x: e.clientX, y: e.clientY }; };
  const at = (e) => { const x = toSvg(e).x; let best = G[0]; for (const g of G) if (Math.abs(sx(g.d) - x) < Math.abs(sx(best.d) - x)) best = g; return best; };
  const show = (d, h, text) => { knob.removeAttribute("visibility"); knob.setAttribute("transform", `translate(${fmt1(sx(d))} ${fmt1(sy(h))})`); knob.lastChild.textContent = text; };
  let busy = false;
  hit.addEventListener("pointermove", (e) => { if (!busy) { const g = at(e); show(g.d, g.h, `${fmt1(g.h)} m`); } });
  hit.addEventListener("pointerleave", () => { if (!busy) knob.setAttribute("visibility", "hidden"); });
  hit.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const g = at(e), y0 = toSvg(e).y, pt = { d: r2p(g.d), x: r2p(g.x), z: r2p(g.z) };
    let st = null, sent = null, tLive = 0, timer = null, mods = { shiftKey: e.shiftKey, altKey: e.altKey }, dy = 0, cur = toSvg(e);
    busy = true;
    const extra = () => ({ mode: st.mode, radius_m: st.radius_m });
    const sendLive = () => { timer = null; tLive = performance.now(); const sig = `${st.delta_m}|${st.mode}|${st.radius_m}`; if (sig !== sent) { sent = sig; opts.onGroundDrag(pt, st.delta_m, Object.assign({ live: true }, extra())); } };
    const update = () => {
      st = heightStroke(dy, mods, 1 / pxPerM);
      const txt = st.mode === "flatten" ? `削平${st.delta_m ? ` ${sgn(st.delta_m)} m` : ""}` : `${st.delta_m >= 0 ? "+" : "−"}${Math.abs(st.delta_m)} m`;
      show(g.d, g.h + st.delta_m, "");
      const mpx = 1 / (pxPerM * (((s.getScreenCTM() || {}).d) || 1)), exTxt = ex > 1.3 ? `纵向放大 ×${fmt1(ex)}` : "";
      showTag(cur, txt, [`半径 ${st.radius_m} m`, exTxt, `1 px ≈ ${Math.round(mpx * 100) / 100} m`].filter(Boolean).join(" · "));
      ghost.removeAttribute("visibility"); ghost.setAttribute("d", line(brushGround(G, pt, g.h, st)));
      hint(`地面 ${fmt1(g.h)} m → ${txt}${exTxt ? `（剖面${exTxt}：拖 1 px ≈ ${Math.round(mpx * 100) / 100} m，俯视图是 0.1 m）` : ""}`);
      if (!timer) { const wait = LIVE_MS - (performance.now() - tLive); if (wait <= 0) sendLive(); else timer = setTimeout(sendLive, wait); }
    };
    const off = () => { busy = false; if (timer) clearTimeout(timer); timer = null; knob.setAttribute("visibility", "hidden"); ghost.setAttribute("visibility", "hidden"); tag.setAttribute("visibility", "hidden"); hint(null); for (const [k, f] of L) window.removeEventListener(k, f, true); };
    const cancel = () => { off(); if (sent && typeof opts.onDragLive === "function") opts.onDragLive(null); };
    const mv = (ev) => { cur = toSvg(ev); dy = cur.y - y0; mods = { shiftKey: ev.shiftKey, altKey: ev.altKey }; if (st || Math.abs(dy) >= 0.8 || mods.shiftKey) update(); };
    const up = () => { const done = st && (st.delta_m !== 0 || st.mode === "flatten"); if (!done) return cancel(); off(); opts.onGroundDrag(pt, st.delta_m, Object.assign({ live: false }, extra())); };
    const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } else if ((ev.key === "Shift" || ev.key === "Alt") && st) { if (ev.key === "Alt") ev.preventDefault(); mods = { shiftKey: ev.shiftKey, altKey: ev.altKey }; update(); } };
    const L = [["pointermove", mv], ["pointerup", up], ["pointercancel", cancel], ["keydown", key], ["keyup", key]];
    for (const [k, f] of L) window.addEventListener(k, f, true);
    if (mods.shiftKey) update();
  });
}
/** 选中的地形操作在剖面上的高度把手：投到剖切线（夹在两端），横虚线 = 影响半径，橙色 ↕ 竖拖 */
function opHandle(s, S, I, { sx, sy, pxPerM, total, drag, opts }) {
  const pr = projectToPath(S.path, I.center), d = clampN(pr.d, 0, total), g = nearestGround(S.ground, d);
  const yAbs = (v) => (I.field === "height_m" || I.field === "depth_m") && I.top != null ? I.top + (I.field === "depth_m" ? I.value - v : v - I.value) : (g ? g.h : 0) + (I.field === "amplitude_m" || I.field === "step_h_m" ? v : 0);
  const x = sx(d), r = Math.max(2, I.radius || 0), xa = sx(clampN(d - r, 0, total)), xb = sx(clampN(d + r, 0, total)), far = pr.off > S.width_m / 2 + r;
  const lineEl = svgel("line", { x1: fmt1(xa), x2: fmt1(xb), y1: fmt1(sy(yAbs(I.value))), y2: fmt1(sy(yAbs(I.value))), stroke: SELECT_COLOR, "stroke-width": 0.8, "stroke-dasharray": "2 1.2", "pointer-events": "none", class: "op-level" });
  const knob = svgel("g", { "data-type": "op_height", "data-plan-id": I.id, "data-field": I.field, class: "op-height", style: "cursor:ns-resize", transform: `translate(${fmt1(x)} ${fmt1(sy(yAbs(I.value)))})`, opacity: far ? 0.6 : 1 },
    svgel("rect", { x: -2.2, y: -4.5, width: 4.4, height: 9, rx: 2.2, fill: SELECT_COLOR, stroke: "#fff", "stroke-width": 0.5 }),
    svgel("path", { d: "M-1.2 -1.4L0 -3.2L1.2 -1.4M-1.2 1.4L0 3.2L1.2 1.4", fill: "none", stroke: "#fff", "stroke-width": 0.6, "pointer-events": "none" }),
    svgel("text", { x: 3.6, y: 1.8, "font-size": 5, "font-weight": 700, fill: SELECT_COLOR, stroke: "#fff", "stroke-width": 1.2, "paint-order": "stroke", "pointer-events": "none", class: "op-height-text" }, `${I.label} ${I.text}${far ? "（不在剖切带里）" : ""}`),
    svgel("title", {}, `${I.label}：上下拖改${I.field === "depth_m" ? "深度" : "高度"}`));
  s.append(lineEl, knob);
  const [lo, hi] = OP_RANGE[I.field] || [-60, 150];
  drag(knob, {
    move: (dy) => {
      const v = clampN(snap(I.value + (I.field === "depth_m" ? 1 : -1) * (dy / pxPerM)), lo, hi), y = fmt1(sy(yAbs(v)));
      knob.setAttribute("transform", `translate(${fmt1(x)} ${y})`); lineEl.setAttribute("y1", y); lineEl.setAttribute("y2", y); knob.querySelector("text").textContent = `${I.label} ${opValueText(I.field, v)}`;
      return { v, text: `${I.label}：${opValueText(I.field, v)}` };
    },
    live: (r) => ({ kind: "op_height", id: I.id, value: r.v, field: I.field }),
    end: (r) => { if (r.v !== I.value) opts.onOpHeight(I.id, r.v, { field: I.field }); else if (typeof opts.onDragLive === "function") opts.onDragLive(null); },
  });
}
