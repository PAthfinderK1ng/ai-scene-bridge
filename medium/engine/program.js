// program.js — 场景程序解释器（docs/06 §4）：规范化后的 plan v2 → 高度场特征 + 体块 / 路 / 区域 / 标记 / 空间。
// AI 只写局部尺寸与偏移、锚点；这里负责：场地基础形态 + 雕刻 → 高度场；节点树展开（group / repeat）；锚点解析（按依赖顺序、环检测）；
// 局部 → 世界；落地（贴地取最高点并补基座 / 悬空 / 嵌入 / 立在别人顶上）；避让（后来者让，推 ≤ 半个尺寸；撞的是子孙里的一件就按那一件的尺寸）；圈选里的重复排不下就收（fitInArea）；连接路由；生成器。
// 确定性：随机只来自 seed（rng / valueNoise）。本文件不调 AI，也不做 schema 清洗（plan.js 的 normalizePlan 已做）。
// 人画的标记（plan.marks，docs/07 §1.1）：和地形操作一样当锚点——at = area 中心 / pin 点 / trace 中点，area = 散布 / 生成器 / 地形操作的范围，along = 沿线重复 / 连接 / 开沟；写进 sid.meta.marks，不出体块。（台地生成器的特征在 terrain.js terraceFeatures）
//
// 对外：runProgram、walkNodes、size3、effShape、parseAnchor、NODE_CLASS / SHAPES / PARTS / GENERATORS / SITE_GROUNDS / DIRV / SUN、rotM / mulM / apM / invM（局部 → 世界的 2×2 矩阵）。（程序检查 programChecks / nodeLabel / findNodeIn 在 plan.js）

import { rng, clamp, r2, pointInPolygon, distToPolygon, polygonCentroid, polygonArea, sculptHeight, buildTerrain, groundFeatures, meander, terraceFeatures } from "./terrain.js";
import { boxCorners, facingToRotation, rotM, mulM, apM, invM, attachOffset, mirrorFix, support, ellipsePoly, rectPoly, hull, bboxOf, bbHit, polyLen, alongLine, deepPoint, mtv, ringOf, ringPolyMtv, footRects, onFoot, lineBank, alongDeg, isSupport, hangsAbove, standsUp, deckOf, fitSupport, fitInArea } from "./layout.js";
import { obbOverlap } from "./validate.js";
import { routeTrail, zigzagTrail } from "./routing.js";
import { landVolume, waterRegions, footSamples } from "./sid.js";
import { compileSpaces } from "./interior.js";
import { planReach } from "./relations.js";

// ------------------------------------------------------------ 词表
export const SHAPES = Object.freeze(["box", "cylinder", "cone", "dome", "pyramid", "wedge", "arch", "torus", "sphere", "prism"]);
export const PARTS = Object.freeze(["building", "tower", "wall", "courtyard", "stairs", "platform", "column", "gate", "statue", "tree", "rock", "crystal", "island", "water"]);
export const GENERATORS = Object.freeze(["terraces", "scatter_houses", "space", "grove", "field"]);
/** 节点类别：solid（出体块）/ group / repeat / link / gen */
export function NODE_CLASS(type) { return SHAPES.includes(type) || PARTS.includes(type) ? "solid" : type === "group" || type === "repeat" || type === "link" ? type : GENERATORS.includes(type) ? "gen" : "solid"; }
export const SITE_GROUNDS = Object.freeze(["flat", "rolling", "hills", "mountain", "canyon", "lake", "island", "coast", "desert", "cavern", "sky"]);
const ROUND = new Set(["cylinder", "cone", "dome", "sphere", "torus", "prism"]);
const PART_SHAPE = { building: "box", tower: "cylinder", wall: "box", stairs: "wedge", platform: "box", column: "cylinder", gate: "arch", statue: "box", tree: "cone", rock: "dome", crystal: "prism", island: "cone", courtyard: "box", water: "box" };
const PART_KIND = { building: "building", tower: "tower", wall: "wall", courtyard: "wall", stairs: "stairs", platform: "platform", column: "column", gate: "gate", statue: "statue", tree: "tree", rock: "rock", crystal: "crystal", island: "island" };
const KIND_COLOR = { building: "wall", tower: "wall", wall: "stone", stairs: "stone", platform: "stone", column: "stone", gate: "stone", statue: "stone", tree: "foliage", rock: "stone", crystal: "mist", island: "stone", structure: "stone" };
const DETAIL = new Set(["column", "tree", "rock", "statue", "crystal"]);
const NO_PLINTH = new Set(["tree", "rock", "statue", "column", "crystal", "stairs"]);
const ROOF_SID = { gable: "gable", hip: "hip", flat: "flat", dome: "dome", spire: "spire", cone: "spire", pyramid: "spire", none: "none" };
const S2 = Math.SQRT1_2;
export const DIRV = Object.freeze({ C: [0, 0], N: [0, -1], NE: [S2, -S2], E: [1, 0], SE: [S2, S2], S: [0, 1], SW: [-S2, S2], W: [-1, 0], NW: [-S2, -S2] });
const STYLE_KIND = { path: "trail", road: "road", stairs: "trail", ramp: "trail", bridge: "bridge", rope_bridge: "bridge", tunnel: "other", canal: "river", portal: "other" };
const STYLE_SURFACE = { path: "dirt", road: "stone", stairs: "stone", ramp: "stone", bridge: "wood", rope_bridge: "rope", tunnel: "tunnel", canal: "water", portal: "light" };
const STYLE_SLOPE = { path: 0.7, road: 0.45, stairs: 1.2, ramp: 0.45, canal: 0.35 };
const SUN = { dawn: [90, 5], morning: [120, 30], noon: [180, 70], afternoon: [230, 40], dusk: [250, 12], night: [300, -8], overcast: [200, 45] };
export { SUN };

// ------------------------------------------------------------ 小工具
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? [0, 0] : [v[0] / L, v[1] / L]; };
const add = (a, u, k = 1) => [a[0] + u[0] * k, a[1] + u[1] * k];
const P2 = (p) => [r2(p[0]), r2(p[1])];
const DEG = Math.PI / 180;
/** rotation_y θ 的矩阵（局部 → 世界，同 boxCorners：局部 +x → (cos θ, −sin θ)，局部 +z → (sin θ, cos θ)） */
const ID_M = [1, 0, 0, 1];
/** 矩阵对应的 rotation_y（看局部朝向 (0, −1) 变到哪） */
const rotOf = (M) => facingToRotation(unit(apM(M, [0, -1])));
export { rotM, mulM, apM, invM };
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
// ------------------------------------------------------------ 尺寸与形体
/** 节点实际的形体（建筑件可用 shape 换） */
export function effShape(node) {
  if (SHAPES.includes(node.type)) return node.type;
  if (node.type === "stairs") return "wedge"; // 台阶不换形体（shape 写圆的 = 螺旋梯，在 emitSolid 里拆成中柱 + 一级级踏步）
  if (node.shape && SHAPES.includes(node.shape)) return node.shape;
  return PART_SHAPE[node.type] || "box";
}
/** size_m → [宽 x, 高 y, 深 z]（米）。圆的类：[直径, 高, (南北直径)]；院 / 水 / 生成器：[宽, 深] → [宽, 墙高, 深] */
export function size3(node) {
  const s0 = node.size_m, s = Array.isArray(s0) ? s0.filter((v) => Number.isFinite(v) && v > 0) : Number.isFinite(s0) && s0 > 0 ? [s0] : [];
  const t = node.type, sh = effShape(node);
  if (["courtyard", "water", "terraces", "scatter_houses", "grove", "field", "space"].includes(t)) {
    const w = s[0] || 20, d = s.length >= 2 ? s[s.length - 1] : w;
    return [w, t === "courtyard" ? node.wall_h_m || 4 : t === "water" ? node.depth_m || 1 : 1, d];
  }
  if (t === "island") return [s[0] || 20, s[1] || Math.max(2, (s[0] || 20) * 0.4), s[2] || s[0] || 20];
  if (t === "wall") return [s[0] || 20, s[1] || node.wall_h_m || 4, s[2] || node.thickness_m || 1];
  if (ROUND.has(sh) && t !== "stairs") {
    const d = s[0] || 6, h = s[1] || (sh === "dome" ? d / 2 : sh === "sphere" ? d : sh === "torus" ? Math.max(0.5, d * 0.15) : d);
    if (sh === "torus" && node.orient === "upright") return [d, d, h]; // 立起来的环：[直径, 直径（高）, 管粗（厚）]，环面按 rotate_deg 朝向（0 = 从南北方向穿过去）
    return [d, h, s[2] || d];
  }
  const w = s[0] || 6;
  return [w, s[1] || w, s[2] || w];
}

// ------------------------------------------------------------ 锚点
const ANCHOR_RE = /^([a-z][a-z0-9_]*)(?:\[(\d+)\])?(?:\.([A-Za-z]+))?$/;
/** "towers[2].top" → { base: "towers", k: 2, id: "towers[2]", suffix: "top" }；不合法 null */
export function parseAnchor(s) {
  const m = ANCHOR_RE.exec(String(s || ""));
  if (!m) return null;
  const k = m[2] !== undefined ? Number(m[2]) : null;
  return { base: m[1], k, id: k === null ? m[1] : `${m[1]}[${k}]`, suffix: m[3] || null };
}
const DIR_SUFFIX = new Set(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

// ============================================================ runProgram
/**
 * 解释一份规范化后的 plan v2。
 * @param {object} plan normalizePlan 的结果（id 已补、size_m 已有默认、引用已降级、无环）
 * @param {{seed?: number, warn?: (m: string) => void}} [opts]
 * @returns {{sid: object, T: object, info: object}} sid 还没 resolve（plan.js 再调 sid.resolve 布房 / 检查）；info = 给检查 / 事实 / 拖动用的中间结果
 */
export function runProgram(plan, opts = {}) {
  const seed = (Number(opts.seed ?? 1) >>> 0) || 1;
  const warn = opts.warn || (() => {});
  const site = plan.site, [W, D] = site.size_m, hw = W / 2, hd = D / 2, layer = site.layer_m || 3;
  const inset = clamp(0.1 * Math.min(W, D), 8, 20);
  // 人定的层表（site.layers，docs/07 §7）→ sid.terrain.layers（source = user；resolve 后换成完整层表）；site.layer_zero_m → meta.layer_zero（0 层在哪）
  const userLayers = Array.isArray(site.layers) ? site.layers.filter((l) => l && Number.isFinite(Number(l.height_m))).map((l, i) => Object.assign({ id: `L${i}`, height_m: r2(Number(l.height_m)), source: "user" }, l.label ? { label: String(l.label) } : {})) : [];
  const sid = {
    sid_version: "0.1",
    meta: { name: plan.name, units: "meters", up_axis: "+Y", handedness: "right", north: "-Z", player_height: 1.7, grid: 0.5, layer_height_m: layer, theme: "mountain_village", seed, plan_mode: true, plan_version: 2, ground: site.ground, ...(plan.marks && plan.marks.length ? { marks: clone(plan.marks) } : {}),
      ...(Number.isFinite(Number(site.layer_zero_m)) ? { layer_zero: r2(Number(site.layer_zero_m)), layer_zero_from: "user" } : {}) }, // marks：人画的标记（参考用，不出体块）
    intent: { summary: plan.concept || "", mood: (plan.mood || []).slice() },
    style: { palette: [], references: [], lighting: {}, material_intents: {} },
    bounds: { min: [-hw, -40, -hd], max: [hw, 120, hd] },
    terrain: { base: site.ground === "sky" ? "none" : "flat", base_height: 0, sculpt: true, features: [], ...(userLayers.length ? { layers: userLayers } : {}) },
    volumes: [], regions: [], paths: [], markers: [], spaces: [], relations: [], constraints: [], views: [], asset_hints: {},
  };
  // SID id：节点自己的主对象就用节点 id（own）；派生的（院墙、基座、水面…）加后缀，且不占用别的 plan id
  const used = new Set(["spawn", "main_trail", "landmark_poi"]), reserved = new Set();
  const sidId = (base, own = false) => {
    const b = String(base).toLowerCase().replace(/\[(\d+)\]/g, "_$1").replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "") || "obj";
    if (own && !used.has(b)) { used.add(b); return b; }
    let id = b, k = 2; while (used.has(id) || reserved.has(id)) id = `${b}_${k++}`; used.add(id); return id;
  };
  const info = { frames: {}, recs: null, pushed: [], clamped: [], overlaps: [], plinths: [], links: {}, warnings: [], instanceOverlaps: [], instanceCoincide: [], autofix: [], hanging: [] };
  const W_ = (m) => { info.warnings.push(m); warn(m); };
  // 所有 plan id（节点 + 地形）先占位，派生的 SID id 不和它们撞
  const allIds = new Set([...(plan.terrain || []).map((t) => t.id)]);
  walkNodes(plan.nodes, (n) => { if (n.id) allIds.add(n.id); });
  for (const id of allIds) reserved.add(id);

  // ---------------------------------------------------------- 1. 场地 + 地形雕刻
  const G0 = groundFeatures(site, seed, allIds);
  const feats = G0.feats.map((f) => { used.add(f.id); return f; });
  const waters = G0.waters.map((w) => Object.assign({}, w));
  const hAt = (x, z) => sculptHeight(feats, 0, x, z);
  const TR = new Map(); // 地形锚点：id → { id, kind: "terrain", op, center, poly, hole, line, top }
  if (G0.autoLake) TR.set(G0.autoLake.id, { id: G0.autoLake.id, kind: "terrain", op: "lake", center: [0, 0], poly: G0.autoLake.polygon, label: "湖" });
  for (const w of waters) if (w.id === "sea") TR.set("sea", { id: "sea", kind: "terrain", op: "sea", center: polygonCentroid(w.polygon), poly: w.polygon, hole: w.hole, label: "海" });
  const sitePoint = (dir) => { const u = DIRV[dir] || [0, 0]; return [u[0] === 0 ? 0 : Math.sign(u[0]) * (hw - inset), u[1] === 0 ? 0 : Math.sign(u[1]) * (hd - inset)]; };
  const sitePoly = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  // 人画的标记（docs/07 §1.1）：坐标是人给的（相对场地中心 = 世界坐标），当锚点 / 范围 / 线用；不出体块、不参与碰撞
  for (const mk of plan.marks || []) {
    const r = { id: mk.id, kind: "terrain", op: "mark", mark: mk.type, label: mk.label || mk.id, poly: null, line: null, half: 0, bank: 0 };
    if (mk.type === "area") { r.poly = mk.polygon_m.map(P2); const c = polygonCentroid(r.poly); r.center = P2(pointInPolygon(c, r.poly) ? c : deepPoint(r.poly)); }
    else if (mk.type === "trace") { r.line = mk.path_m.map(P2); r.center = P2(alongLine(r.line, 0.5).p); }
    else { r.center = P2(mk.point_m); r.pin = true; }
    TR.set(mk.id, r);
  }
  /** 节点（或最近一个写了 at / area 的祖先）锚在哪个圈选里：area 标记的记录，没有 = null（最近的锚点说了算） */
  const areaMarkOf = (node, path) => {
    const n = [node, ...(path || []).slice().reverse().map((id) => NI.get(id) && NI.get(id).node)].find((q) => q && (typeof q.area === "string" || typeof q.at === "string"));
    const A = n && parseAnchor(typeof n.area === "string" ? n.area : n.at), r = A && TR.get(A.base);
    return r && r.op === "mark" && r.mark === "area" && r.poly ? r : null;
  };
  /** 地形阶段的锚点（只认 site.*、前面的地形操作与标记） */
  const tAnchor = (s, who) => {
    const A = parseAnchor(s || "site.C");
    if (!A || A.base === "site") return { p: sitePoint(A && A.suffix && DIRV[A.suffix] ? A.suffix : "C") };
    const r = TR.get(A.base);
    if (!r) { W_(`${who} 的锚点「${s}」不是场地或前面的地形操作，改到场地中心`); return { p: [0, 0] }; }
    return terrainAnchorPoint(r, A.suffix);
  };
  const terrainAnchorPoint = (r, suf) => {
    if (r.line && (suf === "left" || suf === "right" || DIR_SUFFIX.has(suf))) { const q = lineBank(r.line, (r.half || 0) + (r.bank || 0) + 1.5, DIRV[suf], suf === "left" ? 1 : suf === "right" ? -1 : 0); if (q) return { p: P2(q) }; } // 沟 / 河的岸：线的法向里和方位同侧的那边（不塌回中线）
    if (suf && DIR_SUFFIX.has(suf) && (r.poly || r.line)) { const u = DIRV[suf], pts = r.poly || r.line; return { p: P2(add(r.center, u, Math.max(0, support(pts, r.center, u) - 1.5))) }; } // 边上往里 1.5 m（站在台面上，不在崖边）
    if (suf === "outer" && r.poly) { const u = unit([r.center[0], r.center[1]]); const v = u[0] || u[1] ? u : [0, 1]; return { p: P2(add(r.center, v, support(r.poly, r.center, v) + 2)) }; }
    if ((suf === "start" || suf === "end" || suf === "mid") && r.line) { const f = suf === "start" ? 0 : suf === "end" ? 1 : 0.5, q = alongLine(r.line, f); return { p: f === 0 ? r.line[0] : f === 1 ? r.line[r.line.length - 1] : q.p, tan: q.tan }; }
    if (suf === "top" && r.topPoint) return { p: r.topPoint };
    return { p: r.center.slice() };
  };
  const linePts = (op, c, rot, who) => {
    const LM = op.along && TR.get(op.along);
    if (LM && LM.line) return LM.line.map(P2); // 沿人画的一笔
    if (Array.isArray(op.path_m) && op.path_m.length >= 2) return op.path_m.map((q) => { const v = apM(rotM(rot), q); return P2([c[0] + v[0], c[1] + v[1]]); });
    const a = op.from ? tAnchor(op.from, who).p : sitePoint("N"), b = op.to ? tAnchor(op.to, who).p : sitePoint("S");
    return [P2(a), P2(b)];
  };
  for (const op of plan.terrain || []) {
    const who = `「${op.label || op.id}」`;
    const AM = op.area && TR.get(op.area), byArea = !!(AM && AM.poly) && !["ramp", "carve", "river"].includes(op.op); // area: <圈选> = 形状就是那一块
    const A = byArea ? { p: AM.center } : tAnchor(op.at, who), off = op.offset_m || [0, 0], c = [A.p[0] + off[0], A.p[1] + (off.length >= 3 ? off[2] : off[1])];
    const size = op.size_m || [40, 40], rot = op.rotate_deg ?? (A.tan && (op.shape === "rect" || op.shape === "ellipse" || op.op === "cliff" && !op.shape) ? alongDeg(A.tan, size) : 0); // 锚在沟 / 河 / 坡道上的方块、椭圆：缺省顺着线
    info.frames[op.id] = { base: P2(A.p), m: ID_M, origin: P2(c) };
    const LINE_OPS = ["ramp", "carve", "river"];
    let shape = op.shape || (LINE_OPS.includes(op.op) ? "line" : op.op === "lake" ? "ellipse" : op.op === "cliff" ? "rect" : (op.op === "dune" || op.op === "noise") && !op.size_m && !op.polygon_m ? "all" : "circle");
    if (LINE_OPS.includes(op.op)) shape = "line";
    if (byArea) shape = "mark";
    let poly = null, hole = null, line = null, half = 0;
    if (shape === "mark") poly = AM.poly.map((q) => P2([q[0] + c[0] - AM.center[0], q[1] + c[1] - AM.center[1]]));
    else if (shape === "circle") poly = ellipsePoly(c, Math.min(size[0], size[1]) / 2, Math.min(size[0], size[1]) / 2);
    else if (shape === "ellipse") poly = ellipsePoly(c, size[0] / 2, size[1] / 2, rot);
    else if (shape === "rect") poly = rectPoly(c, size[0], size[1], rot);
    else if (shape === "ring") { const rw = op.ring_m || Math.min(size[0], size[1]) * 0.2; poly = ellipsePoly(c, size[0] / 2, size[1] / 2, rot); hole = ellipsePoly(c, Math.max(1, size[0] / 2 - rw), Math.max(1, size[1] / 2 - rw), rot); }
    else if (shape === "polygon") { const src = Array.isArray(op.polygon_m) && op.polygon_m.length >= 3 ? op.polygon_m : null; poly = src ? src.map((q) => { const v = apM(rotM(rot), q); return P2([c[0] + v[0], c[1] + v[1]]); }) : rectPoly(c, size[0], size[1], rot); }
    else if (shape === "line") { line = linePts(op, c, rot, who); half = (op.width_m || 8) / 2; }
    const ref = hAt(c[0], c[1]);
    const f = { id: op.id, plan_id: op.id, kind: op.op, op: op.op, label: op.label || op.id, mask: shape === "all" ? "all" : line ? "line" : "poly", edge: op.edge || "slope" };
    if (poly) f.polygon = poly; if (hole) f.hole = hole; if (line) { f.line = line; f.half = half; }
    const H = op.height_m ?? 12, Dp = op.depth_m ?? 4;
    switch (op.op) {
      case "raise": case "cliff": {
        const edge = op.edge || (op.op === "cliff" ? "cliff" : "slope");
        f.edge = edge;
        if (edge === "round") Object.assign(f, { blend: "add", amount: H, skirt: op.edge_m || Math.max(4, Math.min(size[0], size[1]) * 0.3) });
        else {
          const steps = op.steps || Math.max(2, Math.round(H / layer));
          Object.assign(f, { blend: "max", target: r2(ref + H), skirt: op.edge_m || (edge === "cliff" ? 1.5 : edge === "terraced" ? steps * 6 : Math.max(4, H * 1.0)), steps, register: edge === "terraced" ? "quant" : "top" });
          if (edge === "terraced") Object.assign(f, { reg_step: H / steps, reg_base: ref });
        }
        f.height = r2(ref + H);
        break;
      }
      case "lower": Object.assign(f, { blend: "min", target: r2(ref - Dp), skirt: op.edge_m || (f.edge === "terraced" ? (op.steps || 3) * 6 : Math.max(3, Dp * 1.5)), steps: op.steps || 3, register: "top", height: r2(ref - Dp) }); break; // 台阶边的坑：坑壁一级级往上（每级 6 m 宽）
      case "flatten": { const t = r2((op.target === "at_point" ? hAt(A.p[0], A.p[1]) : ref) + (op.height_m || 0) - (op.depth_m || 0)); Object.assign(f, { blend: "set", target: t, skirt: op.edge_m || 4, register: "top", height: t }); break; } // at_point：削到锚点（图钉）那一点原来的高度
      case "terrace": Object.assign(f, { blend: "quant", step: op.step_h_m || layer, base: 0, edge: "cliff", skirt: 0.5, register: "quant", reg_step: op.step_h_m || layer, reg_base: 0, height: r2(ref) }); break;
      case "ramp": { const a = line[0], b = line[line.length - 1]; Object.assign(f, { blend: "set", ramp: { a, b, ya: r2(hAt(a[0], a[1])), yb: r2(hAt(b[0], b[1])) }, skirt: op.edge_m || 3, line: [a, b], height: r2(Math.max(hAt(a[0], a[1]), hAt(b[0], b[1]))) }); break; }
      case "carve": { const n = op.steps || 3; Object.assign(f, { blend: "add", amount: -Dp, steps: n, skirt: op.edge_m || (f.edge === "cliff" ? 1 : f.edge === "terraced" ? n * clamp((2 * Dp) / n, 2, 6) : Math.max(2, Dp)), height: -Dp }); break; } // 台阶边的沟：每级宽 2 × 级高（2–6 m）
      case "river": {
        if (!(Array.isArray(op.path_m) && op.path_m.length >= 2) && !(op.along && TR.has(op.along))) line = meander(line, hashStr(op.id)); // 人画的线不再加弯
        f.line = line; f.half = (op.width_m || 10) / 2;
        Object.assign(f, { blend: "add", amount: -Dp, skirt: op.edge_m || Math.max(3, Dp * 1.5), height: -Dp });
        break;
      }
      case "lake": {
        const sk = op.edge_m || Math.min(Math.max(4, Dp * 2.5), Math.min(size[0], size[1]) * 0.2);
        Object.assign(f, { blend: "min", target: r2(ref - Dp), edge: "round", skirt: sk, height: r2(ref - Dp) });
        if (poly) waters.push({ id: op.id, polygon: poly, hole, surface_y: r2(ref - 0.4), label: op.label || "湖" });
        break;
      }
      case "dune": Object.assign(f, { blend: "add", wave: { kind: "dune", amp: op.amplitude_m ?? 3, scale: op.scale_m || 30, seed: hashStr(op.id) >>> 0, dir: unit(apM(rotM(rot), [0.8, 0.6])) }, skirt: op.edge_m || 10, height: op.amplitude_m ?? 3 }); break;
      case "noise": Object.assign(f, { blend: "add", wave: { kind: "noise", amp: op.amplitude_m ?? 2, scale: op.scale_m || 40, seed: hashStr(op.id) >>> 0 }, skirt: op.edge_m || 10, height: op.amplitude_m ?? 2 }); break;
      default: break;
    }
    const pts = f.polygon || f.line;
    const cc = pts ? (f.polygon ? polygonCentroid(f.polygon) : alongLine(f.line, 0.5).p) : c;
    Object.assign(f, { center: [r2(cc[0]), 0, r2(cc[1])], radius: r2(pts ? Math.max(1, ...pts.map((q) => dist2(q, cc))) : Math.hypot(hw, hd)) });
    feats.push(f); used.add(f.id);
    if (op.op === "river") waters.push({ id: op.id, line, width: op.width_m || 10, river: true, label: op.label || "河" });
    TR.set(op.id, { id: op.id, kind: "terrain", op: op.op, center: P2(c), poly: poly || (line ? null : sitePoly), hole, line: f.line || line, half: f.half || 0, bank: f.skirt || 0, label: op.label || op.id, top: f.target });
  }

  // 台地生成器（v4 的坡上台地 / 环台算法）：只能锚到场地 / 地形操作，在地形阶段落成 override 平台
  const terraceGens = [];
  walkNodes(plan.nodes, (n, parent) => { if (n.type === "terraces") { terraceGens.push(n); if (parent) W_(`「${n.label || n.id}」是台地生成器，按自己的锚点放（不跟随父组）`); } });
  for (const n of terraceGens) {
    const who = `「${n.label || n.id}」`, A = tAnchor(n.at, who), off = n.offset_m || [0, 0];
    const c = [A.p[0] + off[0], A.p[1] + (off.length >= 3 ? off[2] : off[1])];
    info.frames[n.id] = { base: P2(A.p), m: ID_M, origin: P2(c) };
    const out = terraceFeatures(n, c, { hAt, layer, hw, hd, seed, siteCenter: [0, 0] });
    for (const f of out.feats) { f.id = sidId(f.id); feats.push(f); }
    TR.set(n.id, { id: n.id, kind: "terrain", op: "terraces", center: P2(c), poly: out.outline, label: n.label || n.id, terraceIds: out.feats.map((f) => f.id), topPoint: out.topPoint, top: out.top });
  }
  sid.terrain.features = feats;
  let T = buildTerrain(sid, { res: 2 });
  for (const r of TR.values()) {
    if (r.top === undefined) r.top = T.heightAt(r.center[0], r.center[1]);
    if (!r.topPoint) r.topPoint = r.center;
    const ts = T.terraces.filter((t) => t.plan_id === r.id);
    if (ts.length) { r.terraces = ts; if (r.op !== "terraces") { const hi = ts.reduce((m, t) => (t.height > m.height ? t : m)); r.topPoint = P2(pointInPolygon(r.center, hi.polygon) ? r.center : deepPoint(hi.polygon)); r.top = hi.height; } }
  }

  // ---------------------------------------------------------- 2. 节点：展开、锚点、落地、避让
  const waterList = () => waters.filter((w) => w.polygon).map((w) => ({ polygon: w.polygon, hole: w.hole, surface_y: w.surface_y }));
  let WR = waterList();
  const groundW = (x, z) => { let h = T.heightAt(x, z); for (const w of WR) if (w.surface_y > h && pointInPolygon([x, z], w.polygon) && !(w.hole && pointInPolygon([x, z], w.hole))) h = w.surface_y; return h; };
  const NI = new Map(); // 全局节点：id → { node, parent, cls }
  walkNodes(plan.nodes, (n, parent, inTemplate) => { if (!inTemplate) NI.set(n.id, { node: n, parent: parent ? parent.id : null, cls: linkRepeat(n) ? "link" : NODE_CLASS(n.type) }); }); // 一组连接（repeat 的模板是 link）跟连接一起最后路由
  const G = new Map(); // 几何记录：rec id → { id, kind, center, frame, vols, poly, base, top, topVol, line?, ends? }
  for (const [id, r] of TR) G.set(id, r);
  G.set("site", { id: "site", kind: "site", center: [0, 0], poly: sitePoly, label: "场地" });
  const frames = new Map(); // 全局组 / 带子节点的形体 → 子节点用的坐标系
  const state = new Map(); // id → 1 正在放 / 2 放好了
  const byVol = new Map(); // SID 体块 id → 体块
  const volRec = new Map(); // 体块 id → 所属 rec 路径（plan_path）
  const ROOT = { o: [0, 0], m: ID_M, y: null, restOn: null, sc: 1 };
  const spawnRec = { id: "spawn", kind: "spawn", center: null };
  let placingLinks = false;
  const deferredLinks = [], spaceNodes = [], genRegions = [];

  /** 一个 rec 的范围（体块底面并成凸包；底 / 顶高度；最高的体块） */
  const extent = (r) => {
    if (r._ext && r._extN === (r.vols || []).length) return r._ext;
    const pts = [], vs = r.vols || [];
    let base = Infinity, top = -Infinity, topVol = null;
    for (const v of vs) { for (const q of boxCorners(v.position, v.size, v.rotation_y || 0)) pts.push(q); base = Math.min(base, v.position[1]); const t = v.position[1] + v.size[1]; if (t > top) { top = t; topVol = v; } }
    const poly = pts.length >= 3 ? hull(pts) : r.poly || null;
    const e = { poly, base: Number.isFinite(base) ? base : null, top: Number.isFinite(top) ? top : null, topVol, bb: pts.length ? bboxOf(pts) : null };
    r._ext = e; r._extN = vs.length;
    return e;
  };
  const centerOf = (r) => { if (r.kind === "solid" || r.kind === "terrain" || r.kind === "site" || r.kind === "spawn" || r.kind === "link") return r.center; const e = extent(r); return r.center || (e.poly ? polygonCentroid(e.poly) : [0, 0]); };
  /** 一个 rec 的「台面」：底最低的那块体块（浮岛本身，而不是岛上的亭子） */
  const platformOf = (r) => (r.vols || []).filter((v) => !v.land || v.land.mode !== "plinth").reduce((m, v) => (!m || v.position[1] < m.position[1] - 1e-6 ? v : m), null);
  /** 立在 rec 的哪块上：点 p 落在它脚下、顶面最高的那块；没有就用 fallback */
  const restAt = (r, p, fallback) => { let best = null; for (const v of r.vols || []) { if (v.land && v.land.mode === "plinth") continue; if (onFoot(v, p) && (!best || v.position[1] + v.size[1] > best.position[1] + best.size[1])) best = v; } return best || fallback; };
  const isElevated = (r) => { const e = extent(r); if (e.base == null) return false; if (r.main && ringOf(r.main) && (r.vols || []).length === 1) return (r.main.elev || 0) > 2.5; const c = centerOf(r); return e.base - groundW(c[0], c[1]) > 2.5; }; // 环带量带子下面的地（孔里可能是坑底）

  /** 解析锚点 → { p, y, rest, u?, outside?, rec } */
  const anchor = (str, scope, self) => {
    const A = parseAnchor(str);
    if (!A) return { p: [0, 0], y: null, rest: null, rec: null };
    if (A.base === "site") return { p: sitePoint(A.suffix && DIRV[A.suffix] ? A.suffix : "C"), y: null, rest: null, rec: G.get("site") };
    if (A.base === "spawn") { ensureSpawn(); return { p: spawnRec.center.slice(), y: spawnRec.y ?? null, rest: null, rec: spawnRec }; }
    let r = scope && scope.local.get(A.id);
    if (!r) {
      if (!G.has(A.id)) { const ok = ensure(A.base, true); if (!ok && !G.has(A.id)) { W_(`「${self}」的锚点「${str}」解析不了（成环或不存在），放在父组原点`); return null; } }
      r = G.get(A.id);
      if (!r) { W_(`「${self}」的锚点「${str}」不存在，放在父组原点`); return null; }
    }
    if (r.kind === "terrain" || r.kind === "site") { const q = terrainAnchorPoint(r, A.suffix); return { p: q.p, y: null, rest: null, rec: r }; }
    if (r.kind === "link") { const L = r.line || [r.center, r.center]; const p = A.suffix === "start" ? L[0] : A.suffix === "end" ? L[L.length - 1] : alongLine(L, 0.5).p; return { p: p.slice(), y: null, rest: null, rec: r }; }
    if (r.kind === "spawn") return { p: r.center.slice(), y: null, rest: null, rec: r };
    const e = extent(r), c = centerOf(r);
    const suf = A.suffix;
    if (!suf && isElevated(r)) { const pv = platformOf(r); return { p: c.slice(), y: pv.position[1] + pv.size[1], rest: pv, rec: r, top: true, platform: true }; } // 悬空的东西：站到它的台面（最低那块）上
    if (suf === "top") {
      let tv = e.topVol;
      for (const v of r.vols || []) if (pointInPolygon(c, boxCorners(v.position, v.size, v.rotation_y || 0)) && (!tv || v.position[1] + v.size[1] >= tv.position[1] + tv.size[1] - 1e-6)) tv = v;
      return { p: c.slice(), y: e.top, rest: tv, rec: r, top: true };
    }
    if (suf === "bottom") return { p: c.slice(), y: e.base, rest: null, rec: r, bottom: true };
    if (suf === "center") return { p: c.slice(), y: e.base != null ? (e.base + e.top) / 2 : null, rest: null, rec: r, mid: true };
    if (suf && (DIR_SUFFIX.has(suf) || suf === "outer")) {
      let u = DIRV[suf];
      if (suf === "outer") { u = unit(c); if (!u[0] && !u[1]) u = [0, 1]; }
      const reach = e.poly ? support(e.poly, c, u) : 2;
      return { p: add(c, u, reach + 1), y: null, rest: null, rec: r, u, outside: true };
    }
    if ((suf === "start" || suf === "end" || suf === "mid") && r.line) return { p: (suf === "start" ? r.line[0] : suf === "end" ? r.line[r.line.length - 1] : alongLine(r.line, 0.5).p).slice(), y: null, rest: null, rec: r };
    return { p: c.slice(), y: null, rest: null, rec: r };
  };

  /** 保证某个全局节点（及其祖先坐标系）已放好；成环返回 false */
  function ensure(id, force = false) {
    if (id === "spawn") { ensureSpawn(); return true; }
    const ni = NI.get(id);
    if (!ni) return false;
    if (ni.cls === "link") {
      // 连接默认最后路由（要避开所有形体）；被别人引用（沿路排列、锚到它）时现在就路由
      if (G.has(id)) return true;
      if (!force && !placingLinks) { if (!deferredLinks.includes(id)) deferredLinks.push(id); return true; }
      if (state.get(id) === 1) return false;
      placeGlobal(id);
      return G.has(id);
    }
    if (state.get(id) === 2) return true;
    if (ni.parent && !frames.has(ni.parent)) { if (state.get(ni.parent) === 1) return false; ensure(ni.parent); if (state.get(id) === 2) return true; }
    if (state.get(id) === 1) return false;
    placeGlobal(id);
    return state.get(id) === 2;
  }
  function placeGlobal(id) {
    const ni = NI.get(id), node = ni.node;
    state.set(id, 1);
    const pf = ni.parent ? frames.get(ni.parent) || ROOT : ROOT;
    const path = ancestors(id);
    const before = sid.volumes.length;
    build(node, pf, null, id, node.id, path);
    // 避让：每个全局节点（形体 / 重复）放好后，和已经放好的、不在自己子树里的形体比
    if ((ni.cls === "solid" || ni.cls === "repeat") && sid.volumes.length > before) avoidUnit(id, sid.volumes.slice(before), path);
    state.set(id, 2);
  }
  const ancestors = (id) => { const out = []; let p = NI.get(id) && NI.get(id).parent; while (p) { out.unshift(p); p = NI.get(p) && NI.get(p).parent; } return out; };

  /** 放一个节点（全局或模板实例里的）：frame = 父坐标系；scope = 实例的局部 id 表；recId = 几何记录 id；planId = SID plan_id；path = 祖先 id */
  function build(node, frame, scope, recId, planId, path, inst) {
    const cls = NODE_CLASS(node.type), who = node.label || node.id || recId;
    if (cls === "link") { if (scope) { W_(`「${who}」：模板里的连接不展开`); return; } return placeLink(node, recId); }
    if (cls === "gen") return placeGen(node, frame, scope, recId, path);
    // 位置：锚点（+ 外侧贴邻时退开自己的半个尺寸）+ 父坐标系里的偏移
    const off = node.offset_m || [0, 0], off3 = off.length >= 3 ? off : [off[0], 0, off[1]];
    let A = null, p = frame.o.slice();
    if (node.at) { A = anchor(node.at, scope, who); if (A) p = A.p.slice(); }
    const M = mulM(frame.m, rotM(node.rotate_deg || 0));
    if (A && A.outside && cls === "solid") { const sz = size3(node).map((v) => v * (frame.sc || 1)); p = add(p, A.u, ownReach(sz, M, [-A.u[0], -A.u[1]])); }
    if (A && A.outside && cls !== "solid") p = add(p, A.u, estReach(node, frame));
    const dv = apM(frame.m, [off3[0], off3[2]]);
    p = [p[0] + dv[0], p[1] + dv[1]];
    // 竖向：锚点给了高度（X.top / X.center / 悬空目标）→ 立在它上面 / 绝对高度；父坐标系有高度（浮岛的子节点、叠层）→ 跟着它
    const elev = (node.elev_m || 0) + (off3[1] || 0);
    let land;
    const sup = !A && frame.lift > 2.5 && isSupport(node, frame.lift, size3, frame.sc || 1); // 高架组里的墩 / 柱：落到地面当支撑（组的 elev_m 只抬台面）
    const st = !A && !sup && frame.lift > 2.5 ? standsUp(node, frame.lift, size3, frame.sc || 1) : 0, onDeck = st && frame.deck && st < 0.6 * frame.lift; // 戳出台面的拱 / 门 / 柱：矮的立到台面上，高的（或组里没台面）落地
    if (sup || st) { land = onDeck ? { mode: "abs", abs: r2(frame.y + frame.deck) } : { mode: "snap", elev: 0 }; if (!scope) info.autofix.push({ id: recId, kind: "support", text: sup ? `「${who}」是高架组里的墩 / 柱，落到地面当支撑` : onDeck ? `「${who}」立到高架台面上（原来和台面一起悬着）` : frame.deck ? `「${who}」是高架组里的拱 / 柱，落到地面撑到台面底` : `「${who}」所在的组抬高了 ${r2(frame.lift)} m 却没有台面，落回地面` }); }
    else if (A && A.top && A.rest) land = { mode: "rest", on: (A.platform ? A.rest : restAt(A.rec, p, A.rest)).id, elev };
    else if (A && A.y != null) land = { mode: "abs", abs: r2(A.y + elev) };
    else if (!A && frame.y != null && frame.base != null && elev > 0 && elev < frame.h - 0.05) land = cls === "solid" ? { mode: "rest", on: frame.restOn, from: "base", elev } : { mode: "abs", abs: r2(frame.base + elev) }; // 形体的子节点写了 elev_m：离父体底面（= 离地）的高度，挂在立面上
    else if (!A && frame.y != null && frame.base != null && elev > 0) land = { mode: "rest", on: frame.restOn, elev: r2(elev - frame.h) }; // 高过父体：屋顶以上
    else if (!A && frame.y != null) land = frame.restOn ? { mode: "rest", on: frame.restOn, elev } : { mode: "abs", abs: r2(frame.y + elev) };
    else if (node.ground === "carve" || (!node.ground && !(node.elev_m > 0) && (node.type === "cone" || node.type === "dome" || node.type === "pyramid" || node.type === "rock"))) land = { mode: "carve", elev: node.elev_m || 0 }; // 堆 / 丘 / 岩默认嵌进地里
    else if (node.ground === "float" || (node.elev_m || 0) > 0 || node.type === "island") land = { mode: "float", elev: node.elev_m ?? (node.type === "island" ? 20 : 0) };
    else land = { mode: "snap", elev };
    if (!sup && !st && !A && frame.lift > 2.5 && cls === "solid" && hangsAbove(node, frame.lift, size3, frame.sc || 1) && !info.hanging.some((h) => h.id === planId)) info.hanging.push({ id: planId, lift: r2(frame.lift), h: r2(size3(node)[1]) }); // 没落地、又高到戳出台面
    if (cls === "group") {
      const fr = { o: p, m: M, y: landY(land, p), restOn: land.mode === "rest" && land.from !== "base" ? land.on : null, sc: frame.sc || 1 };
      fr.lift = fr.y != null ? fr.y - groundW(p[0], p[1]) : 0; fr.deck = fr.lift > 2.5 ? deckOf(node.children, size3, fr.sc) : 0;
      const rec = { id: recId, kind: "group", center: P2(p), frame: fr, vols: [], label: node.label || node.id };
      G.set(recId, rec); if (scope) scope.local.set(node.id, rec);
      if (!scope) { frames.set(node.id, fr); info.frames[node.id] = { base: P2(A ? A.p : frame.o), m: frame.m, origin: P2(p) }; }
      for (const ch of node.children || []) {
        if (scope) build(ch, fr, scope, `${recId}/${ch.id}`, ch.id, path.concat(recId), inst);
        else ensure(ch.id);
      }
      collect(rec, recId);
      return rec;
    }
    if (cls === "repeat") { const rr = placeRepeat(node, frame, p, M, land, scope, recId, path, A); if ((sup || (st && !onDeck && frame.deck)) && rr) fitSupport(rr.vols, frame.y); return rr; }
    // 形体
    if (!scope) info.frames[node.id] = { base: P2(A ? A.p : frame.o), m: frame.m, origin: P2(p) };
    if (land.from === "base" && frame.pv) p = attachOut(node, p, frame, recId);
    const vols = emitSolid(node, p, M, land, frame.sc || 1, recId, planId, path, inst, A ? A.p : frame.c || frame.o);
    if (sup || (st && !onDeck && frame.deck)) fitSupport(vols, frame.y);
    if (vols.moved) p = add(p, vols.moved);
    const main = vols[0];
    const rec = { id: recId, kind: "solid", center: P2(p), vols, label: node.label || node.id, type: node.type, main };
    G.set(recId, rec); if (scope) scope.local.set(node.id, rec);
    if (node.children && node.children.length && main) {
      // 子节点坐标系：不写 elev_m 的立在顶上；写了 elev_m 的按离父体底面（= 离地）算，挂在立面上（浮岛 / 倒置的除外：岛面就是子节点的地面）
      const facade = node.type !== "island" && !main.inverted;
      const fr = { o: P2(p), m: M, y: r2(main.position[1] + main.size[1]), restOn: main.id, sc: 1, base: facade ? main.position[1] : null, h: main.size[1], pv: facade ? main : null };
      if (!scope) frames.set(node.id, fr);
      for (const ch of node.children) {
        if (scope) build(ch, fr, scope, `${recId}/${ch.id}`, ch.id, path.concat(recId), inst);
        else ensure(ch.id);
      }
      collect(rec, recId);
    }
    return rec;
  }
  /** rec 的体块 = 自己的 + 子孙的（按 plan_path 收） */
  function collect(rec, recId) {
    const set = new Set(rec.vols);
    for (const v of sid.volumes) if (!set.has(v) && (v.plan_path || []).includes(recId)) { rec.vols.push(v); set.add(v); }
    rec._ext = null;
  }
  /** 落地方式 → 这一层的高度（给子坐标系 / 重复实例用；贴地 / 嵌入 = null） */
  const landY = (land, p) => {
    if (land.mode === "abs") return land.abs;
    if (land.mode === "float") return r2(groundW(p[0], p[1]) + land.elev);
    if (land.mode === "rest") { const b = byVol.get(land.on); return r2((land.from === "base" ? b.position[1] : b.position[1] + b.size[1]) + (land.elev || 0)); }
    return null;
  };
  /** 挂在立面上的子形体（elev_m 低于父体顶）：中心还在父体里面 → 沿偏移方向推到外墙外（只搭进去 ≤ 0.5 m），外挂平台 / 招牌 / 阳台才看得见 */
  function attachOut(node, p, frame, recId) {
    const dv = attachOffset(node.offset_m, size3(node), node.rotate_deg, p, frame);
    if (!dv) return p;
    info.autofix.push({ id: recId, kind: "attach", by: r2(Math.hypot(dv[0], dv[1])), text: `「${node.label || node.id || recId}」在父体里面，挂到外墙外（挪 ${r2(Math.hypot(dv[0], dv[1]))} m）` });
    return P2([p[0] + dv[0], p[1] + dv[1]]);
  }
  const ownReach = (sz, M, u) => { const loc = apM(invM(M), u); return Math.abs(loc[0]) * sz[0] / 2 + Math.abs(loc[1]) * sz[2] / 2; };
  const estReach = (node, frame) => {
    if (node.type === "repeat") { const ch = node.child ? size3(node.child) : [6, 6, 6]; return (node.pattern === "radial" ? node.radius_m || 20 : ((node.count || 1) * (Number(node.spacing_m) || ch[0])) / 2) + ch[0] / 2; }
    if (node.size_m) { const s = size3(node); return Math.max(s[0], s[2]) / 2; }
    return 0;
  };

  /** 形体节点 → SID 体块（院 / 墙会出多块；水出区域） */
  function emitSolid(node, p, M, land, sc, recId, planId, path, inst, toward) {
    const t = node.type, shape = effShape(node), kind = PART_KIND[t] || "structure";
    let sz = size3(node);
    if (sc !== 1) sz = [sz[0] * sc, sz[1], sz[2] * sc];
    const rot = rotOf(M), out = [];
    const imp = node.role === "landmark" ? "landmark" : node.role || (DETAIL.has(t) ? "detail" : path.length === 0 && !inst ? "primary" : "secondary");
    const base = (id, k, s, pos, extra = {}) => {
      const v = Object.assign({ id, kind: k, shape: s, position: [r2(pos[0]), 0, r2(pos[1])], size: sz.map(r2), rotation_y: rot, label: node.label || defaultLabel(t), plan_id: planId, plan_path: path.slice(), importance: imp, color_role: node.color || KIND_COLOR[k] || "stone", land: Object.assign({}, land) }, extra);
      if (inst) { v.instance_of = inst.rep; v.instance = inst.k; }
      if (land.mode === "rest" && land.from !== "base") v.rests_on = land.on;
      if (node.material) v.material_intent = node.material;
      return v;
    };
    const vid = sidId(recId, true);
    if (t === "water") {
      const poly = shape === "box" ? rectPoly(p, sz[0], sz[2], rot) : ellipsePoly(p, sz[0] / 2, sz[2] / 2, rot, 20);
      let lo = Infinity; for (const q of poly) lo = Math.min(lo, T.heightAt(q[0], q[1]));
      const g = Math.min(lo, T.heightAt(p[0], p[1]));
      const reg = { id: vid, kind: "water", polygon: poly, density: 0, label: node.label || "水", plan_id: planId, plan_path: path.slice(), surface_y: r2((land.mode === "abs" ? land.abs : g) + 0.1) };
      sid.regions.push(reg); waters.push({ id: vid, polygon: poly, surface_y: reg.surface_y }); WR = waterList();
      return out;
    }
    if (t === "courtyard") {
      const th = node.thickness_m || 0.8, wh = node.wall_h_m || 4, [w, , d] = sz, gate = node.gate || "S", gw = Math.min(6, Math.min(w, d) * 0.3);
      const sides = [["N", [0, -d / 2], w, 0], ["S", [0, d / 2], w, 0], ["W", [-w / 2, 0], d, 90], ["E", [w / 2, 0], d, 90]];
      for (const [nm, lp, len, r] of sides) {
        const segs = nm === gate ? [[-(len + gw) / 4 - gw / 4, (len - gw) / 2], [(len + gw) / 4 + gw / 4, (len - gw) / 2]] : [[0, len]];
        segs.forEach(([o, L], k) => {
          const lo = r ? [lp[0], lp[1] + o] : [lp[0] + o, lp[1]], q = apM(M, lo), wp = [p[0] + q[0], p[1] + q[1]];
          const v = base(sidId(`${recId}_${nm.toLowerCase()}${segs.length > 1 ? k + 1 : ""}`), "wall", "box", wp, { size: r ? [r2(th), r2(wh), r2(L)] : [r2(L), r2(wh), r2(th)], label: (node.label || "院") + "墙", color_role: node.color || "stone" });
          out.push(v);
        });
        if (nm === gate) { const q = apM(M, lp), gp = [p[0] + q[0], p[1] + q[1]]; out.push(base(sidId(`${recId}_gate`), "gate", "arch", gp, { size: r ? [r2(th + 0.4), r2(wh + 1.5), r2(gw)] : [r2(gw), r2(wh + 1.5), r2(th + 0.4)], label: (node.label || "院") + "门", color_role: node.color || "stone" })); }
      }
      sid.regions.push({ id: sidId(`${recId}_floor`), kind: "plaza", polygon: rectPoly(p, w - th, d - th, rot), density: 0, label: node.label || "院", plan_id: planId, plan_path: path.slice() });
      for (const v of out) pushVol(v);
      return out;
    }
    if (t === "wall" && (node.path_m || node.around)) {
      let pts;
      if (node.around) {
        const r = G.get(node.around) || (ensure(node.around) && G.get(node.around));
        const poly = r ? (r.kind === "terrain" ? r.poly : extent(r).poly) : null;
        if (poly) { const c = polygonCentroid(poly); pts = poly.map((q) => { const u = unit([q[0] - c[0], q[1] - c[1]]); return add(q, u, 3); }); pts.push(pts[0]); }
        else W_(`「${node.label || node.id}」要围着的「${node.around}」没有范围，改成一段直墙`);
      }
      if (!pts && node.path_m) pts = node.path_m.map((q) => { const v = apM(M, q); return [p[0] + v[0], p[1] + v[1]]; });
      if (pts && pts.length >= 2) {
        const th = node.thickness_m || sz[2] || 1, wh = sz[1];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1], L = dist2(a, b);
          if (L < 0.5) continue;
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir = unit([b[0] - a[0], b[1] - a[1]]);
          const segRot = facingToRotation([dir[1], -dir[0]]);
          out.push(base(sidId(`${recId}_${i + 1}`), "wall", "box", mid, { size: [r2(L + th * 0.5), r2(wh), r2(th)], rotation_y: segRot }));
        }
        for (const v of out) pushVol(v);
        return out;
      }
    }
    if (t === "stairs" && ROUND.has(node.shape)) {
      // 螺旋梯：中柱 + 绕着它一级级升起的踏步（每级 30°），直径 = size_m[0]、高 = size_m[1]
      const d = Math.max(3, sz[0]), h = Math.max(2, sz[1]), cd = Math.max(0.8, d * 0.2), tw = (d - cd) / 2, a0 = rotOf(M);
      const col = base(vid, "column", "cylinder", p, { size: [r2(cd), r2(h), r2(cd)], label: (node.label || "螺旋梯") + "中柱" });
      pushVol(col); out.push(col);
      const n = clamp(Math.round(h / 1.2), 4, 30), rise = h / n;
      for (let k = 0; k < n; k++) {
        const a = (a0 + k * 30) * DEG, u = [Math.sin(a), -Math.cos(a)], c = add(p, u, cd / 2 + tw / 2);
        const st = base(sidId(`${recId}_step${k + 1}`), "stairs", "box", c, { size: [r2(tw), r2(Math.max(0.25, Math.min(0.6, rise))), r2(Math.max(0.8, Math.min(2, (cd / 2 + tw / 2) * 0.55)))], rotation_y: r2(((Math.atan2(-u[1], u[0]) / DEG) % 360 + 360) % 360), label: node.label || "螺旋梯", importance: "detail", land: { mode: "rest", on: col.id, from: "base", elev: r2(k * rise) } });
        pushVol(st); out.push(st);
      }
      return out;
    }
    const v = base(vid, kind, shape, p);
    if (t === "building" || t === "tower") {
      const roof = ROOF_SID[node.roof || (t === "tower" ? "spire" : "gable")] || "gable";
      const rh = roof === "none" ? 0 : roof === "flat" ? Math.min(0.5, sz[1] * 0.1) : roof === "spire" ? Math.min(Math.max(sz[0], sz[2]) * 1.0, sz[1] * 0.45) : roof === "dome" ? Math.min(Math.min(sz[0], sz[2]) / 2, sz[1] * 0.45) : Math.min(Math.min(sz[0], sz[2]) * 0.35, sz[1] * 0.4);
      Object.assign(v, { roof, roof_h: r2(rh), floors: node.floors || Math.max(1, Math.round((sz[1] - rh) / 3.5)) });
      if (t === "building") v.form = "custom";
    }
    if (shape === "prism") v.sides = node.sides || 6;
    if (node.hollow) v.hollow = true;
    if (shape === "torus" && node.orient === "upright") v.orient = "upright";
    if (node.hollow && shape === "cylinder") v.wall = r2(ringOf(Object.assign({}, v, { wall: node.wall_m ? node.wall_m * sc : null })).wall); // 环带：带宽 / 壁厚写明（视图、剖面、检查都按它）
    if (t === "island") v.inverted = true;
    pushVol(v); out.push(v);
    // 贴地且脚下高差大：补一块基座（体块本身底面取覆盖范围的最高点）
    if (v.land.mode === "snap" && !NO_PLINTH.has(t) && Math.max(sz[0], sz[2]) >= 4) {
      let drop = plinthDrop(v);
      const ok = Math.max(4, sz[1] * 0.6);
      if (drop > Math.max(4, sz[1] * 2) && !node.hollow) { // 空心的（竖井筒壁）照旧垫到底
        // 基座要比形体本身高两倍以上（放到了崖外 / 坑边）：往锚点 / 重复中心方向收，找最近一处站得住的；找不到就不垫柱子，悬着并提醒
        const p0 = [v.position[0], v.position[2]], L = toward ? dist2(p0, toward) : 0, u = L > 1 ? unit([toward[0] - p0[0], toward[1] - p0[1]]) : null;
        let s = 0;
        if (u) for (let k = 2; k <= L + 1e-9 && !s; k += 2) { v.position[0] = r2(p0[0] + u[0] * k); v.position[2] = r2(p0[1] + u[1] * k); landVolume(v, T, byVol, WR); if (plinthDrop(v) <= ok) s = k; }
        if (s) { out.moved = [r2(u[0] * s), r2(u[1] * s)]; info.autofix.push({ id: planId, kind: "pull_in", by: s, text: `「${node.label || planId}」脚下是崖 / 坑（原本要垫 ${r2(drop)} m 高的基座），往里收了 ${s} m` }); drop = plinthDrop(v); }
        else {
          v.position[0] = p0[0]; v.position[2] = p0[1]; landVolume(v, T, byVol, WR);
          W_(`「${node.label || planId}」脚下高差 ${r2(drop)} m（比它自己高两倍多），没垫基座，悬在边上——挪近一点或改成 ground:"float"`);
          drop = 0;
        }
      }
      if (drop > 1.0) {
        const pv = Object.assign({}, v, { id: sidId(`${vid}_base`), kind: "platform", label: (v.label || "") + "基座", importance: "detail", color_role: "stone", land: { mode: "plinth" }, plinth_of: v.id });
        delete pv.roof; delete pv.roof_h; delete pv.floors; delete pv.form; delete pv.rests_on; delete pv.sides; delete pv.inverted; delete pv.orient;
        if (!ringOf(v)) { delete pv.hollow; delete pv.wall; } // 环带的基座也是一圈（中间不填实）
        pv.position = v.position.slice(); pv.size = [v.size[0], r2(drop), v.size[2]]; pv.plan_path = v.plan_path.slice(); pv.land = { mode: "plinth" };
        pushVol(pv); out.push(pv);
        info.plinths.push({ id: planId, sid_id: v.id, m: r2(drop) });
      }
    }
    return out;
  }
  const defaultLabel = (t) => ({ box: "方块", cylinder: "圆柱", cone: "圆锥", dome: "穹顶", pyramid: "金字塔", wedge: "楔", arch: "拱", torus: "环", sphere: "球", prism: "棱柱", building: "房子", tower: "塔", wall: "墙", stairs: "台阶", platform: "平台", column: "柱", gate: "门", statue: "像", tree: "树", rock: "岩", crystal: "晶体", island: "浮岛" })[t] || t;
  const plinthDrop = (v) => { let lo = Infinity; for (const q of footSamples(v)) { const h = T.heightAt(q[0], q[1]), g = groundW(q[0], q[1]); if (g > h + 0.05) continue; lo = Math.min(lo, h); } return Number.isFinite(lo) ? v.position[1] - lo : 0; };
  function pushVol(v) { landVolume(v, T, byVol, WR); sid.volumes.push(v); byVol.set(v.id, v); }

  /** 重复：按 pattern 算每个实例的坐标系，模板逐个放（skip 跳过、overrides 覆盖） */
  function placeRepeat(node, frame, p, M, land, scope, recId, path, A) {
    const rec = { id: recId, kind: "repeat", center: P2(p), vols: [], label: node.label || node.id, frame: { o: p, m: M } };
    G.set(recId, rec); if (scope) scope.local.set(node.id, rec);
    if (!scope) info.frames[node.id] = { base: P2(A ? A.p : frame.o), m: frame.m, origin: P2(p) };
    let tpl = node.child;
    if (!isObj(tpl)) { W_(`「${node.label || node.id}」没有模板（child），没生成`); return rec; }
    const pat = node.pattern || "linear", skip = new Set(node.skip || []), ov = isObj(node.overrides) ? node.overrides : {};
    let mirrorAxis = node.axis === "z" ? "z" : "x";
    if (pat === "mirror") { // 模板正好在翻转轴上（两份重合）：引擎直接修并记进 facts.plan.autofix（layout.js mirrorFix）
      const f = mirrorFix(node, tpl, frame.m, M, p, mirrorAxis, size3(tpl), NODE_CLASS(tpl.type) === "solid");
      if (f) { ({ tpl, mirrorAxis } = f); if (f.p) { p = f.p; rec.center = P2(p); rec.frame.o = p; } info.autofix.push({ id: recId, kind: "mirror", how: f.how, text: `「${node.label || node.id}」镜像：${f.text}` }); }
    }
    const baseY = landY(land, p);
    const restOn = land.mode === "rest" && land.from !== "base" ? land.on : null;
    const sp = node.spacing_m, spv = Array.isArray(sp) ? sp : [sp, sp];
    const tsz = size3(tpl);
    let stepX = Number.isFinite(spv[0]) && spv[0] > 0 ? spv[0] : tsz[0] + 2, stepZ = Number.isFinite(spv[1]) && spv[1] > 0 ? spv[1] : tsz[2] + 2;
    const frs = []; // [{ o, m, y, restOn, sc }]
    const mk = (lp, faceRot = 0, extra = {}) => { const q = apM(M, lp); return Object.assign({ o: [p[0] + q[0], p[1] + q[1]], m: mulM(M, rotM(faceRot)), y: baseY, restOn, sc: frame.sc || 1, c: p, lift: baseY != null ? frame.lift || 0 : 0 }, extra); };
    const faceFor = (lp, mode) => { if (!mode || mode === "none" || (!lp[0] && !lp[1])) return 0; const f = mode === "out" ? unit(lp) : unit([-lp[0], -lp[1]]); return facingToRotation(f); };
    let n = node.count || 1;
    // 锚在圈选（area 标记）里的直线 / 网格 / 放射重复：排出去了就缩间距（缩到挨着还放不下就少放几个）——圈的范围是人给的边界；记进 autofix
    const AM = scope ? null : areaMarkOf(node, path);
    if (AM && (pat === "linear" || pat === "grid" || pat === "radial")) {
      const fit = fitInArea(AM.poly, p, M, pat, { n, R: node.rows || 2, C: node.cols || 2, stepX, stepZ, radius: node.radius_m || 20, tsz, axis: node.axis === "z" ? "z" : "x" });
      if (fit) {
        ({ stepX, stepZ } = fit); if (fit.n != null) n = fit.n;
        node = Object.assign({}, node, fit.radius != null ? { radius_m: fit.radius } : {}, fit.R != null ? { rows: fit.R } : {}, fit.C != null ? { cols: fit.C } : {});
        info.autofix.push({ id: recId, kind: "fit_area", how: fit.how, text: `「${node.label || (tpl && tpl.label) || node.id}」放进「${AM.label}」：${fit.how}` });
      }
    }
    if (pat === "linear") { const ax = node.axis === "z" ? [0, 1] : [1, 0], st = node.axis === "z" ? stepZ : stepX; for (let k = 0; k < n; k++) { const s = (k - (n - 1) / 2) * st; frs.push(mk([ax[0] * s, ax[1] * s], 0)); } }
    else if (pat === "grid") { const R = node.rows || 2, C = node.cols || 2; for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { const lp = [(j - (C - 1) / 2) * stepX, (i - (R - 1) / 2) * stepZ]; frs.push(mk(lp, faceFor(lp, node.face))); } }
    else if (pat === "radial") {
      const R = node.radius_m || 20, sw = node.sweep_deg || 360, a0 = node.start_deg || 0;
      for (let k = 0; k < n; k++) { const a = (a0 + (sw >= 360 ? (k * 360) / n : n > 1 ? (k * sw) / (n - 1) : 0)) * DEG, lp = [R * Math.sin(a), -R * Math.cos(a)]; frs.push(mk(lp, faceFor(lp, node.face || "center"))); }
    } else if (pat === "mirror") { frs.push(mk([0, 0])); frs.push(Object.assign(mk([0, 0]), { m: mulM(M, mirrorAxis === "z" ? [1, 0, 0, -1] : [-1, 0, 0, 1]) })); }
    else if (pat === "stack") { const L = node.levels || 3; for (let k = 0; k < L; k++) frs.push(Object.assign(mk([0, 0]), { stackK: k, sc: (frame.sc || 1) * Math.pow(1 - (node.taper || 0), k) })); }
    else if (pat === "along") {
      const lid = node.along, ln = lid && NI.get(lid);
      if (ln) ensure(lid, true);
      const L = lid && G.get(lid) && G.get(lid).line;
      if (!L) W_(`「${node.label || node.id}」沿的「${lid || ""}」不是连接，没生成`);
      else {
        const len = polyLen(L), cnt = Number.isFinite(sp) && sp > 0 && !node.count ? Math.max(1, Math.floor(len / sp)) : n;
        for (let k = 0; k < cnt; k++) {
          const { p: q, tan } = alongLine(L, (k + 0.5) / cnt), right = [-tan[1], tan[0]];
          const Mi = [right[0], tan[0], right[1], tan[1]]; // 局部 x = 前进方向右侧，局部 z = 前进方向
          const off = tpl.offset_m || [0, 0], lat = off[0] || 0;
          const face = node.face === "path" || !node.face ? facingToRotation(lat > 0 ? [-right[0], -right[1]] : lat < 0 ? right : [-tan[0], -tan[1]]) : node.face === "out" ? facingToRotation(lat >= 0 ? right : [-right[0], -right[1]]) : null;
          frs.push({ o: q, m: face === null ? Mi : null, rotY: face, along: Mi, y: baseY, restOn, sc: frame.sc || 1, lift: baseY != null ? frame.lift || 0 : 0 });
        }
      }
    } else if (pat === "scatter") scatterFrames(node, tpl, p, M, frs, frame);
    if (NODE_CLASS(tpl.type) === "link") { placeLinkRepeat(node, tpl, frs, p, scope, recId, skip, ov); return rec; }
    // 逐个放
    let prevTop = null;
    frs.forEach((fr, k) => {
      if (skip.has(k)) return;
      const iid = `${recId}[${k}]`;
      let t = Object.assign({}, tpl, ov[String(k)] || {});
      t.id = tpl.id || `${node.id}_c`;
      let ifr = fr;
      if (fr.along) {
        // 沿路：模板偏移按路的局部系（x 右、z 前），朝向另算
        const off = t.offset_m || [0, 0], off3 = off.length >= 3 ? off : [off[0], 0, off[1]], q = apM(fr.along, [off3[0], off3[2]]);
        ifr = { o: [fr.o[0] + q[0], fr.o[1] + q[1]], m: fr.m || rotM(fr.rotY), y: fr.y, restOn: fr.restOn, sc: fr.sc };
        t = Object.assign({}, t, { offset_m: off3[1] ? [0, off3[1], 0] : undefined });
      }
      if (pat === "stack" && k > 0 && prevTop) ifr = Object.assign({}, ifr, { y: r2(prevTop.y + (Number(sp) || 0)), restOn: Number(sp) > 0 ? null : prevTop.vol });
      const instScope = { local: new Map(), prefix: iid };
      if (!scope) info.frames[iid] = { base: P2(ifr.o), m: ifr.m, origin: P2(ifr.o), instance: true };
      const before = sid.volumes.length;
      const r = build(Object.assign({}, t, { at: undefined }), ifr, instScope, iid, iid, path.concat(recId), { rep: recId, k });
      // 模板里的子节点 plan_id 用自己的 id；实例根 = id[k]
      const vs = sid.volumes.slice(before);
      for (const v of vs) { if (!v.plan_path.includes(iid) && v.plan_id !== iid) v.plan_path.push(iid); }
      if (r) { r.vols = vs; G.set(iid, r); r._ext = null; }
      if (pat === "stack") { const e = r ? extent(r) : null; prevTop = e && e.topVol ? { y: e.top, vol: e.topVol.id } : prevTop; }
    });
    collect(rec, recId);
    // 同一个重复里实例互相重叠：只报告（AI 的间距太小）
    if (pat !== "stack" && pat !== "mirror") {
      const inst = frs.map((_, k) => G.get(`${recId}[${k}]`)).filter((r) => r && r.vols && r.vols[0]).map((r) => ({ r, v: r.vols[0], F: footBB(r.vols[0]) }));
      let found = 0;
      for (let i = 0; i < inst.length && found < 1; i++) for (let j = i + 1; j < inst.length; j++) {
        const A = inst[i], B = inst[j];
        if (!bbHit(A.F.bb, B.F.bb, -0.1)) continue;
        if (A.v.position[1] + A.v.size[1] <= B.v.position[1] + 0.05 || B.v.position[1] + B.v.size[1] <= A.v.position[1] + 0.05) continue;
        if (mtv(A.F.c, B.F.c)) { info.instanceOverlaps.push({ id: node.id, a: A.r.id, b: B.r.id }); found++; break; }
      }
    }
    // 实例完全重合（镜像轴写反、间距 / 半径为 0）：两个实例的体块位置一一对上（< 0.1 m）→ 看起来只有一份
    if (pat !== "stack" && frs.length > 1 && !info.instanceCoincide.some((o) => o.id === node.id)) {
      const S = frs.map((_, k) => { const r = !skip.has(k) && G.get(`${recId}[${k}]`); return r && r.vols && r.vols.length ? r.vols.map((v) => [v.position[0], v.position[2], v.size[1]]) : null; });
      const same = (A, B) => A.length === B.length && A.every((a) => B.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.1 && Math.abs(a[2] - b[2]) < 0.1));
      let hit = null;
      for (let i = 0; i < S.length && !hit; i++) for (let j = i + 1; j < S.length; j++) if (S[i] && S[j] && same(S[i], S[j])) { hit = [i, j]; break; }
      if (hit) info.instanceCoincide.push({ id: node.id, pattern: pat, axis: node.axis || "x", a: hit[0], b: hit[1], n: frs.length });
    }
    return rec;
  }
  /**
   * 一组连接（repeat 的模板是 link）：每个实例一条。from / to / via 里写重复的 id（"pods"）或 "pods[k]" = 那个重复的第 k 个实例（个数不同时取余）；
   * "center" / "中心" = 这个重复的中心（写了 at 就是 at 那个东西）；不写 from = 中心，不写 to = 这个实例自己的位置（放射的辐条）。
   */
  function placeLinkRepeat(node, tpl, frs, p, scope, recId, skip, ov) {
    if (scope) { W_(`「${node.label || node.id}」：模板里的一组连接不展开`); return; }
    const pt = (q, tag) => { const id = `pt__${recId}_${tag}`; G.set(id, { id, kind: "terrain", center: P2(q), poly: null, label: node.label || node.id }); return id; };
    const insts = (base) => { ensure(base, true); const out = []; for (let j = 0; j < 400; j++) if (G.has(`${base}[${j}]`)) out.push(j); return out; };
    const ref = (s, k, dflt) => {
      if (s == null || s === "") return dflt();
      if (CENTER_WORDS.has(s) && !NI.has(s)) return node.at || pt(p, "c");
      const m = /^([a-z][a-z0-9_]*)\[(k|i|n|\*|)\](\.[A-Za-z]+)?$/.exec(s), A = parseAnchor(m ? m[1] + (m[3] || "") : s);
      if (!A || A.k !== null || !NI.has(A.base) || A.base === node.id || NI.get(A.base).node.type !== "repeat") return s;
      const js = insts(A.base);
      return js.length ? `${A.base}[${js[k % js.length]}]${A.suffix ? "." + A.suffix : ""}` : s;
    };
    frs.forEach((fr, k) => {
      if (skip.has(k)) return;
      const iid = `${recId}[${k}]`, t = Object.assign({}, tpl, ov[String(k)] || {});
      const ln = Object.assign({}, t, { id: iid, from: ref(t.from, k, () => node.at || pt(p, "c")), to: ref(t.to, k, () => pt(fr.o, k)) });
      if (Array.isArray(t.via)) ln.via = t.via.map((v) => ref(v, k, () => null)).filter(Boolean);
      placeLink(ln, iid, { rep: recId, k });
    });
  }
  /** 散布：在 area 的范围里种子化取点，避开已放的形体，最小间距 gap_m */
  function scatterFrames(node, tpl, p, M, frs, frame) {
    const rand = rng((seed * 7919 + hashStr(node.id)) >>> 0), tsz = size3(tpl);
    let polys = null, hole = null, onVol = null, wet = false;
    const aid = node.area;
    if (aid && aid !== "site") {
      if (!G.has(aid)) ensure(aid, true);
      const r = G.get(aid);
      if (r && r.kind === "terrain" && (r.op === "lake" || r.op === "sea")) wet = true; // 散在水里：只取水面下的点（湖中礁石不会爬上湖心岛）
      if (r && (r.kind === "terrain")) { polys = r.terraces && r.op === "terraces" ? r.terraces.map((t) => t.polygon) : r.poly ? [r.poly] : r.line ? lineBand(r.line, 6) : r.pin ? [rectPoly(r.center, node.size_m ? size3(node)[0] : 30, node.size_m ? size3(node)[2] : 30, 0)] : null; hole = r.hole || null; }
      else if (r && r.kind !== "site") { const e = extent(r); polys = e.poly ? [e.poly] : null; if (r.kind === "solid" && r.main) onVol = r.main; }
      if (!polys) W_(`「${node.label || node.id}」的范围「${aid}」没有面积，散在自己周围`);
    }
    if (!polys) { const s = node.size_m ? size3(node) : [Math.min(W, D) * 0.6, 1, Math.min(W, D) * 0.6]; polys = [aid === "site" ? [[-hw + 4, -hd + 4], [hw - 4, -hd + 4], [hw - 4, hd - 4], [-hw + 4, hd - 4]] : rectPoly(p, s[0], s[2], rotOf(M))]; }
    const bb = bboxOf(polys.flat()), gap = node.gap_m || Math.max(tsz[0], tsz[2]) * 1.2 + 1;
    const n = node.count || 8, pts = [];
    const placed = sid.volumes.filter((v) => (!onVol || v.id !== onVol.id) && (onVol || !(v.elev > 2.5))).flatMap((v) => footRects(v).map((poly) => ({ v, poly, bb: bboxOf(poly) }))); // 环带按一段段带子（孔里能撒）
    const clusters = node.seed_hint === "clustered" ? Array.from({ length: 3 }, () => [bb[0] + rand() * (bb[2] - bb[0]), bb[1] + rand() * (bb[3] - bb[1])]) : null;
    const mg = Math.hypot(tsz[0], tsz[2]) / 2 + 1;
    const inside = (q) => polys.some((poly) => pointInPolygon(q, poly)) && !(hole && pointInPolygon(q, hole)) && Math.abs(q[0]) < hw - mg && Math.abs(q[1]) < hd - mg && (!wet || groundW(q[0], q[1]) > T.heightAt(q[0], q[1]) + 0.3);
    const cand = [];
    if (node.seed_hint === "even") { const area = polys.reduce((s, q) => s + polygonArea(q), 0), st = Math.max(gap, Math.sqrt(area / n)); for (let z = bb[1] + st / 2; z < bb[3]; z += st) for (let x = bb[0] + st / 2; x < bb[2]; x += st) cand.push([x + (rand() - 0.5) * st * 0.4, z + (rand() - 0.5) * st * 0.4]); }
    for (let k = 0; k < n * 30; k++) {
      if (clusters) { const c = clusters[k % 3], a = rand() * 2 * Math.PI, r = Math.sqrt(rand()) * Math.max(gap * 2.5, Math.min(bb[2] - bb[0], bb[3] - bb[1]) * 0.18); cand.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
      else cand.push([bb[0] + rand() * (bb[2] - bb[0]), bb[1] + rand() * (bb[3] - bb[1])]);
    }
    for (const q of cand) {
      if (pts.length >= n) break;
      if (!inside(q) || pts.some((o) => dist2(o, q) < gap)) continue;
      const rect = boxCorners([q[0], 0, q[1]], [tsz[0] + 1, 1, tsz[2] + 1], 0), rb = bboxOf(rect);
      if (placed.some((o) => bbHit(rb, o.bb) && obbOverlap(rect, o.poly))) continue;
      pts.push(q);
    }
    if (pts.length < n) W_(`「${node.label || node.id}」只撒下 ${pts.length} / ${n} 个（范围不够或被挡住）`);
    for (const q of pts) {
      const ry = node.face === "center" ? facingToRotation(unit([p[0] - q[0], p[1] - q[1]])) : node.face && node.face !== "none" ? 0 : Math.round(rand() * 24) * 15;
      frs.push({ o: P2(q), m: rotM(ry), y: onVol ? r2(onVol.position[1] + onVol.size[1]) : frame.y, restOn: onVol ? onVol.id : frame.restOn, sc: frame.sc || 1 });
    }
  }
  const corridor = (line, w) => { const a = line[0], b = line[line.length - 1], u = unit([b[0] - a[0], b[1] - a[1]]), n = [-u[1] * w, u[0] * w]; return [add(a, n), add(b, n), add(b, n, -1), add(a, n, -1)]; };
  const lineBand = (line, w) => line.slice(1).map((q, i) => corridor([line[i], q], w)).filter((r) => dist2(r[0], r[1]) > 0.1); // 折线两侧 w 米的带（一段一个四边形：人画的弯线也贴着走）

  // ---------------------------------------------------------- 避让（后来者让）
  const footBB = (v) => { const c = boxCorners(v.position, v.size, v.rotation_y || 0); return { c, bb: bboxOf(c) }; };
  function volsOverlap(a, b) {
    if (a.position[1] + a.size[1] <= b.position[1] + 0.05 || b.position[1] + b.size[1] <= a.position[1] + 0.05) return false;
    const A = footBB(a), B = footBB(b);
    return bbHit(A.bb, B.bb) && obbOverlap(A.c, B.c);
  }
  /** 悬空：不贴地、离地 > 0.5 m（雨棚、吊笼、浮岛、挂墙的平台） */
  const isFloating = (v) => !!v.land && v.land.mode !== "snap" && v.land.mode !== "carve" && v.land.mode !== "plinth" && (v.elev || 0) > 0.5;
  /** 搭在 / 架在上面，不算撞（雨棚压在钢架和广告柱顶上）：两块都悬空、竖向只叠了一点（< 1 m 或 < 薄的那块的一半）；
   *  一块悬空一块贴地、贴地那块的顶只顶到悬空那块的底部一点（< 1 m 或 < 它厚度的一半）——从中间穿过去的仍算撞 */
  const attached = (a, b) => {
    const fa = isFloating(a), fb = isFloating(b);
    if (!fa && !fb) return false;
    if (fa && fb) { const o = Math.min(a.position[1] + a.size[1], b.position[1] + b.size[1]) - Math.max(a.position[1], b.position[1]); return o < 1 || o < 0.5 * Math.min(a.size[1], b.size[1]); }
    const f = fa ? a : b, g = fa ? b : a;
    return g.position[1] + g.size[1] - f.position[1] < Math.max(1, 0.5 * f.size[1]);
  };
  const ROUNDISH = new Set(["cylinder", "cone", "dome", "sphere", "torus", "prism"]);
  /** 圆形底面（直径两向相等）→ { c, r } */
  const circOf = (v) => ROUNDISH.has(v.shape) && Math.abs(v.size[0] - v.size[2]) < 0.05 ? { c: [v.position[0], v.position[2]], r: v.size[0] / 2 } : null;
  /** 环（torus / 空心圆柱）套住另一块：同心且比它大，或另一块整个在环的内孔里（塔身外的层环、坑里的东西在霓虹圈里）——不算撞。dv = a 这边的平移 */
  const encircles = (ring, o, dv) => {
    const g = circOf(ring), R = g && ringOf(ring);
    if (!R) return false;
    const c = dv ? [g.c[0] + dv[0], g.c[1] + dv[1]] : g.c, hole = g.r - R.wall;
    const pts = boxCorners(o.position, o.size, o.rotation_y || 0), reach = Math.max(...pts.map((q) => dist2(q, c)));
    const oc = circOf(o), oR = oc ? oc.r : reach;
    if (dist2([o.position[0], o.position[2]], c) < 0.5 && oR <= g.r + 0.05) return true;
    return (oc ? dist2(oc.c, c) + oc.r : reach) <= hole + 0.05;
  };
  function avoidUnit(id, mine, path) {
    const own = new Set(mine.map((v) => v.id)), anc = new Set(path);
    const ni = NI.get(id), node = ni.node;
    const anchoredTo = node.at ? parseAnchor(node.at) : null;
    const exempt = (o) => {
      if (own.has(o.id)) return true;
      if (anc.has(o.plan_id)) return true;
      if (o.land && o.land.mode === "plinth" && own.has(o.plinth_of)) return true;
      if (anchoredTo && (anchoredTo.suffix === "top" || anchoredTo.suffix === "center" || anchoredTo.suffix === "bottom") && (o.plan_id === anchoredTo.id || (o.plan_path || []).includes(anchoredTo.id))) return true;
      return false;
    };
    const others = sid.volumes.filter((o) => !exempt(o));
    const restsOnMine = (a, b) => a.land && a.land.on === b.id || b.land && b.land.on === a.id;
    const solids = mine.filter((v) => v.land && v.land.mode !== "plinth");
    if (!solids.length || !others.length) return clampUnit(id, mine);
    let bb = bboxOf(mine.flatMap((v) => boxCorners(v.position, v.size, v.rotation_y || 0)));
    // 最多推半个自己（沿推的方向量：34 × 150 的长雨棚往东西最多推 17 m，不是 75 m）
    // 重复（一圈柱子、一排摊位）：按单个实例的尺寸算，整组只许挪一个实例那么远
    const i0 = node.type === "repeat" && G.get(`${id}[0]`), ib = i0 && i0.vols && i0.vols.length ? bboxOf(i0.vols.flatMap((v) => boxCorners(v.position, v.size, v.rotation_y || 0))) : bb;
    let bw = ib[2] - ib[0], bd = ib[3] - ib[1], maxPush = Math.max(2, Math.max(bw, bd) / 2);
    const halfIn = (d) => Math.max(2, (Math.abs(d[0]) * bw + Math.abs(d[1]) * bd) / 2);
    // 悬空的形体：推完中心不能离开它锚着的那个东西的范围（雨棚得还在街上）——推不了就只报告
    const floatUnit = solids.every(isFloating), c0 = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    const aRec = floatUnit && anchoredTo && anchoredTo.base !== "site" && anchoredTo.base !== "spawn" ? G.get(anchoredTo.id) : null;
    const aPoly = aRec && aRec.kind !== "link" ? (aRec.kind === "terrain" ? aRec.poly : extent(aRec).poly) : null;
    const onAnchor = aPoly && pointInPolygon(c0, aPoly) ? (dv) => pointInPolygon([c0[0] + dv[0], c0[1] + dv[1]], aPoly) : () => true;
    let total = [0, 0];
    const pre = solids.map((a) => ({ a, F: footBB(a) }));
    const oth = others.map((b) => ({ b, F: footBB(b) }));
    /** 整体平移 dv 后最深的一处重叠（没有 = null） */
    const worstAt = (dv) => {
      let worst = null;
      for (const { a, F } of pre) {
        const c = dv ? F.c.map((q) => [q[0] + dv[0], q[1] + dv[1]]) : F.c, bb = dv ? [F.bb[0] + dv[0], F.bb[1] + dv[1], F.bb[2] + dv[0], F.bb[3] + dv[1]] : F.bb;
        for (const { b, F: B } of oth) {
          if (restsOnMine(a, b)) continue;
          if (a.position[1] + a.size[1] <= b.position[1] + 0.05 || b.position[1] + b.size[1] <= a.position[1] + 0.05) continue;
          if (attached(a, b)) continue;
          if (!bbHit(bb, B.bb)) continue;
          if (encircles(a, b, dv) || encircles(b, a, dv && [-dv[0], -dv[1]])) continue;
          const ca = circOf(a), cb = circOf(b), ra = ca && ringOf(a), rb = cb && ringOf(b);
          if (ca && cb) { // 两个圆的：按圆算（方盒近似会在斜角上误撞）
            const dx = ca.c[0] + (dv ? dv[0] : 0) - cb.c[0], dz = ca.c[1] + (dv ? dv[1] : 0) - cb.c[1], dd = Math.hypot(dx, dz), n = dd > 1e-6 ? [dx / dd, dz / dd] : [1, 0];
            const ring = ra ? [ca, cb, ra] : rb ? [cb, ca, rb] : null; // 环 = 圆环带（内孔不算）
            let m;
            if (ring) {
              const R = ring[0].r, hole = R - ring[2].wall, r = ring[1].r;
              if (dd - r >= R - 0.1 || dd + r <= hole + 0.1) continue;
              const oOut = R + r - dd, oIn = dd + r - hole;
              m = oOut <= oIn ? { o: oOut, d: n } : { o: oIn, d: [-n[0], -n[1]] };
            } else {
              const o = ca.r + cb.r - dd;
              if (o <= 0.1) continue;
              m = { o, d: n };
            }
            if (!worst || m.o > worst.m.o) worst = { a, b, m };
            continue;
          }
          if (ra || rb) { // 环带与方的：只有带子算（中间的孔可以放东西）
            const g = ra ? ca : cb, cc = ra && dv ? [g.c[0] + dv[0], g.c[1] + dv[1]] : g.c, m0 = ringPolyMtv(cc, g.r, g.r - (ra || rb).wall, ra ? B.c : c);
            if (!m0) continue;
            const m = ra ? { o: m0.o, d: [-m0.d[0], -m0.d[1]], shrink: m0.shrink } : m0;
            if (!worst || m.o > worst.m.o) worst = { a, b, m };
            continue;
          }
          const m = mtv(c, B.c);
          if (m && (!worst || m.o > worst.m.o)) worst = { a, b, m };
        }
      }
      return worst;
    };
    const w0 = worstAt(null);
    if (w0) {
      // 撞上的是自己子孙里的一小件（加多了的练功笼）：按那一件的尺寸推；撞上的是自己的环带（一圈环廊的带子压到别人的笼子）：按带宽推——
      // 都不把整个大件（整圈环廊，同心的一层层）推走，推不开就报告
      const pa = String(w0.a.plan_id || ""), sub = pa && pa !== id && !pa.startsWith(id + "[") ? mine.filter((v) => v.plan_id === pa || String(v.plan_id || "").startsWith(pa + "/")) : null;
      const band = !sub && circOf(w0.a) && ringOf(w0.a);
      if (sub && sub.length) { const sb = bboxOf(sub.flatMap((v) => boxCorners(v.position, v.size, v.rotation_y || 0))); bw = Math.min(bw, sb[2] - sb[0]); bd = Math.min(bd, sb[3] - sb[1]); }
      else if (band) { bw = Math.min(bw, band.wall); bd = Math.min(bd, band.wall); }
      maxPush = Math.max(2, Math.max(bw, bd) / 2);
      // 先沿最深那处的最小平移方向推；推完还压着别的，就在一圈圈的方向里找最近的空位（≤ 半个尺寸）
      let best = null;
      const k0 = w0.m.o + 0.6;
      const k0dv = [w0.m.d[0] * k0, w0.m.d[1] * k0];
      if (k0 <= halfIn(w0.m.d) && onAnchor(k0dv) && !worstAt(k0dv)) best = k0dv;
      const a0 = Math.atan2(w0.m.d[1], w0.m.d[0]);
      for (let r = 0.5; !best && r <= maxPush + 1e-9; r += Math.max(0.5, maxPush / 24)) {
        for (let j = 0; j < 16 && !best; j++) {
          const ang = a0 + ((j % 2 ? 1 : -1) * Math.ceil(j / 2) * Math.PI) / 8, u = [Math.cos(ang), Math.sin(ang)], dv = [u[0] * r, u[1] * r];
          if (r <= halfIn(u) + 1e-9 && onAnchor(dv) && !worstAt(dv)) best = dv;
        }
      }
      if (best) { shiftUnit(id, mine, best); total = best; }
      else info.overlaps.push({ id, a: w0.a.plan_id, b: w0.b.plan_id, a_sid: w0.a.id, b_sid: w0.b.id, depth: r2(w0.m.o), dir: P2(w0.m.d), shrink: w0.m.shrink });
    }
    if (Math.hypot(total[0], total[1]) > 0.05) info.pushed.push({ id, by: P2(total) });
    clampUnit(id, mine);
  }
  function shiftUnit(id, mine, dv) {
    for (const v of mine) { v.position[0] = r2(v.position[0] + dv[0]); v.position[2] = r2(v.position[2] + dv[1]); }
    for (const v of mine) landVolume(v, T, byVol, WR);
    for (const [rid, r] of G) if (rid === id || rid.startsWith(id + "[") || rid.startsWith(id + "/") || (r.vols && r.vols.length && r.vols.every((v) => mine.includes(v)))) {
      if (r.center && (r.kind === "solid" || r.kind === "group" || r.kind === "repeat")) r.center = P2(add(r.center, dv));
      if (r.frame && r.frame.o) r.frame.o = add(r.frame.o, dv);
      r._ext = null;
    }
    for (const [fid, fr] of frames) if (fid === id || (NI.get(fid) && ancestors(fid).includes(id))) fr.o = add(fr.o, dv);
  }
  function clampUnit(id, mine) {
    const bb = bboxOf(mine.flatMap((v) => boxCorners(v.position, v.size, v.rotation_y || 0))), m = 1;
    let dx = 0, dz = 0;
    if (bb[2] - bb[0] < W - 2 * m) { if (bb[0] < -hw + m) dx = -hw + m - bb[0]; else if (bb[2] > hw - m) dx = hw - m - bb[2]; }
    if (bb[3] - bb[1] < D - 2 * m) { if (bb[1] < -hd + m) dz = -hd + m - bb[1]; else if (bb[3] > hd - m) dz = hd - m - bb[3]; }
    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) { shiftUnit(id, mine, [dx, dz]); info.clamped.push({ id, by: P2([dx, dz]) }); }
  }

  // ---------------------------------------------------------- 出生点
  function ensureSpawn() {
    if (spawnRec.center || spawnRec._busy) return;
    spawnRec._busy = true;
    const s = plan.spawn || {}, A = anchor(s.at || "site.S", null, "出生点");
    let p = A ? A.p.slice() : sitePoint("S"), y = null, on = null;
    const off = s.offset_m || [0, 0];
    info.frames.spawn = { base: P2(p), m: ID_M, origin: null };
    p = [p[0] + off[0], p[1] + (off.length >= 3 ? off[2] : off[1])];
    if (A && A.rest) { const rv = A.platform ? A.rest : restAt(A.rec, p, A.rest); y = rv.position[1] + rv.size[1]; on = rv.id; }
    spawnRec.center = P2([clamp(p[0], -hw + 2, hw - 2), clamp(p[1], -hd + 2, hd - 2)]);
    spawnRec.y = y; spawnRec.on = on; spawnRec._busy = false;
  }
  function settleSpawn() {
    // 站在体块里面（地面层）→ 推到它外面 2 m
    if (spawnRec.on) return;
    // 站在水面上（海岸的南边、湖心）→ 就近找一块干地（由近到远一圈圈找，确定性）
    const wet = (q) => waters.some((w) => !w.river && w.polygon && pointInPolygon(q, w.polygon) && !(w.hole && pointInPolygon(q, w.hole)));
    if (site.ground !== "sky" && wet(spawnRec.center)) {
      const c0 = spawnRec.center;
      search: for (let r = 4; r <= Math.max(W, D); r += 4) for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8, q = [clamp(c0[0] + r * Math.sin(a + Math.PI), -hw + 2, hw - 2), clamp(c0[1] + r * Math.cos(a + Math.PI), -hd + 2, hd - 2)];
        if (!wet(q)) { spawnRec.center = P2(q); info.spawnMoved = { from: c0, by: r2(dist2(c0, q)), why: "水面" }; break search; }
      }
    }
    for (let it = 0; it < 4; it++) {
      const c = spawnRec.center, hit = sid.volumes.find((v) => v.position[1] < groundW(c[0], c[1]) + 1.7 && v.position[1] + v.size[1] > groundW(c[0], c[1]) && onFoot(v, c));
      if (!hit) break;
      const poly = boxCorners(hit.position, hit.size, hit.rotation_y || 0), hc = [hit.position[0], hit.position[2]];
      let u = unit([c[0] - hc[0], c[1] - hc[1]]); if (!u[0] && !u[1]) u = [0, 1];
      spawnRec.center = P2(add(hc, u, support(poly, hc, u) + 2));
    }
  }

  // ---------------------------------------------------------- 生成器
  function placeGen(node, frame, scope, recId, path) {
    const who = node.label || node.id;
    if (node.type === "terraces") { const r = TR.get(node.id); if (r) G.set(recId, r); return r; }
    const off = node.offset_m || [0, 0];
    let p = frame.o, A = null;
    if (node.at) { A = anchor(node.at, scope, who); if (A) p = A.p; }
    const dv = apM(frame.m, [off[0], off.length >= 3 ? off[2] : off[1]]);
    p = [p[0] + dv[0], p[1] + dv[1]];
    if (!scope) info.frames[node.id] = { base: P2(A ? A.p : frame.o), m: frame.m, origin: P2(p) };
    const rec = { id: recId, kind: "gen", type: node.type, center: P2(p), vols: [], label: who };
    G.set(recId, rec);
    if (node.type === "space") { spaceNodes.push({ node, p, recId }); return rec; }
    // 撒房子 / 树林 / 田 → 区域（layout.js 在 resolve 里布房 / 种树）
    const parts = [];
    const aid = node.area;
    if (aid && aid !== "site") {
      if (!G.has(aid)) ensure(aid, true);
      const r = G.get(aid);
      const ts = r && r.kind === "terrain" ? (r.terraces || []) : [];
      if (ts.length) for (const t of ts) parts.push({ polygon: t.polygon, terrace_id: t.id, level: t.level });
      else if (r && r.kind === "terrain" && r.poly) parts.push({ polygon: r.poly });
      else if (r && r.kind === "terrain" && (r.line || r.pin)) { const s = size3(node); if (r.line) for (const q of lineBand(r.line, Math.max(4, s[0] / 4))) parts.push({ polygon: q }); else parts.push({ polygon: rectPoly(r.center, s[0], s[2], 0) }); } // 沿手绘线一条带 / 图钉周围按自己的尺寸
      else if (r && r.kind !== "site") { const e = extent(r); if (e.poly) parts.push({ polygon: e.poly }); }
      if (!parts.length) W_(`「${who}」的范围「${aid}」没有面积，用自己的尺寸`);
    } else if (aid === "site") parts.push({ polygon: [[-hw + 6, -hd + 6], [hw - 6, -hd + 6], [hw - 6, hd - 6], [-hw + 6, hd - 6]] });
    if (!parts.length) { const s = size3(node); parts.push({ polygon: rectPoly(p, s[0], s[2], rotOf(mulM(frame.m, rotM(node.rotate_deg || 0)))) }); }
    const kind = node.type === "grove" ? "forest" : node.type === "field" ? "farmland" : "gathering";
    let B = null;
    if (node.type === "scatter_houses") {
      const t = isObj(node.child) ? node.child : { type: "building", size_m: [6, 4, 5], roof: "gable" };
      const s = size3(t);
      B = { form: t.type === "tower" ? "tower" : "house", size: s.map(r2), floors: t.floors || 1, roof: ROOF_SID[t.roof || "gable"] || "gable", label: t.label || "民居", plan_id: node.id };
    }
    parts.forEach((q, k) => {
      const reg = { id: sidId(`${recId}_${k + 1}`), kind, polygon: q.polygon.map((v) => P2([clamp(v[0], -hw + 1, hw - 1), clamp(v[1], -hd + 1, hd - 1)])), density: node.type === "field" ? 0 : node.density ?? 1, label: who, plan_id: node.id, plan_path: path.slice() };
      if (q.terrace_id) Object.assign(reg, { terrace_id: q.terrace_id, terrace_level: q.level });
      if (B) reg.building = B;
      sid.regions.push(reg); genRegions.push(reg);
    });
    rec.poly = hull(parts.flatMap((q) => q.polygon));
    return rec;
  }

  // ---------------------------------------------------------- 连接
  /** 连接一端：点、高度、是否高处、挂在哪个 rec 上 */
  function linkEnd(str, toward, style) {
    const A = parseAnchor(str);
    if (!A) return null;
    const g = (q) => groundW(q[0], q[1]);
    if (A.base === "spawn") { ensureSpawn(); const c = spawnRec.center; return { p: P2(c), y: r2(spawnRec.y != null ? spawnRec.y : g(c)), elevated: spawnRec.y != null && spawnRec.y - g(c) > 2.5, rec: "spawn", restVol: spawnRec.on }; }
    let r = null;
    if (A.base !== "site") { if (!G.has(A.id)) ensure(A.base, true); r = G.get(A.id) || null; }
    const volumeLike = r && (r.kind === "solid" || r.kind === "group" || r.kind === "repeat") && (r.vols || []).length;
    if (!volumeLike || A.suffix) {
      const a = anchor(str, null, "连接");
      if (!a) return null;
      if (a.top || a.mid || a.bottom) return { p: P2(a.p), y: r2(a.y), elevated: a.y - g(a.p) > 2.5, rec: r ? r.id : null, restVol: a.rest ? a.rest.id : null };
      return { p: P2(a.p), y: r2(g(a.p)), elevated: false, rec: r ? r.id : null };
    }
    // 没写后缀的体块：从它朝 toward 的那条边出发（地面：门前 1.5 m；高处：边上，高度取顶面；桥从建筑身上出发：0.6 层高）
    const e = extent(r), c = centerOf(r);
    const u = unit([toward[0] - c[0], toward[1] - c[1]]), dir = u[0] || u[1] ? u : [0, 1];
    const reach = e.poly ? support(e.poly, c, dir) : 1;
    if (isElevated(r)) { const pv = platformOf(r), pp = pv ? boxCorners(pv.position, pv.size, pv.rotation_y || 0) : e.poly, rr = pp ? support(pp, c, dir) : reach; return { p: P2(add(c, dir, Math.max(0, rr - 0.5))), y: r2(pv ? pv.position[1] + pv.size[1] : e.top), elevated: true, rec: r.id, restVol: pv ? pv.id : null }; }
    if (style === "bridge" || style === "rope_bridge") {
      // 桥从建筑身上出发：高度取 0.6 层高（3 m – 顶下 1 m）
      const h = e.top - e.base, y = e.base + clamp(0.6 * h, Math.min(3, h), Math.max(h - 1, Math.min(3, h)));
      return { p: P2(add(c, dir, reach)), y: r2(y), elevated: y - g(c) > 2.5, rec: r.id, restVol: e.topVol ? e.topVol.id : null };
    }
    return { p: P2(add(c, dir, reach + 1.5)), y: r2(g(add(c, dir, reach + 1.5))), elevated: false, rec: r.id };
  }
  /** 一端的粗略中心（给另一端定朝向） */
  function roughCenter(str) {
    const A = parseAnchor(str);
    if (!A) return null;
    if (A.base === "spawn") { ensureSpawn(); return spawnRec.center; }
    if (A.base !== "site" && !A.suffix) { if (!G.has(A.id)) ensure(A.base, true); const r = G.get(A.id); if (r && (r.kind === "solid" || r.kind === "group" || r.kind === "repeat") && (r.vols || []).length) return centerOf(r); }
    const a = anchor(str, null, "连接");
    return a ? a.p : null;
  }
  function placeLink(node, recId, inst) {
    const style = node.style || "path", who = node.label || node.id;
    state.set(node.id, 1);
    const TL = node.along && G.get(node.along) && G.get(node.along).line; // along: <手绘线> = 顺着人画的那一笔走（from / to 可省，写了就从它接到线头 / 线尾）
    const refs = TL ? [] : [node.from, ...(node.via || []), node.to].filter(Boolean);
    const width = node.width_m || (style === "road" ? 5 : style === "bridge" ? 4 : style === "rope_bridge" ? 1.6 : style === "canal" ? 4 : 2);
    let ends, line, fallback = null, straight = false, unrouted = false;
    if (TL) {
      const g = (q) => ({ p: P2(q), y: r2(groundW(q[0], q[1])), elevated: false, rec: null }), L0 = TL[0], L1 = TL[TL.length - 1];
      const e0 = node.from ? linkEnd(node.from, L0, style) : null, e1 = node.to ? linkEnd(node.to, L1, style) : null;
      ends = [e0 || g(L0), e1 || g(L1)];
      line = [...(e0 ? [e0.p] : []), ...TL.map(P2), ...(e1 ? [e1.p] : [])];
    } else {
      // 先粗算各端中心，再按「朝下一端」求真正的端点
      const rough = refs.map(roughCenter);
      if (rough.some((q) => !q) || refs.length < 2) { W_(`「${who}」的端点找不到，这条连接没生成`); state.set(node.id, 2); return null; }
      // 端点朝向：第一端朝第二端，其余朝前一端
      ends = refs.map((s, i) => linkEnd(s, i === 0 ? rough[1] : rough[i - 1], style));
      if (ends.some((e) => !e)) { W_(`「${who}」的端点找不到，这条连接没生成`); state.set(node.id, 2); return null; }
      line = [ends[0].p];
      const avoid = avoidPolysFor(ends);
      for (let i = 0; i < ends.length - 1; i++) {
        const a = ends[i], b = ends[i + 1];
        let seg;
        const walk = style === "path" || style === "road" || style === "stairs" || style === "ramp" || style === "canal";
        if (!walk || a.elevated || b.elevated || style === "portal") seg = [a.p, b.p];
        else {
          const maxSlope = STYLE_SLOPE[style] || 0.7;
          let r = routeTrail(T, a.p, b.p, { maxSlope, res: 2, avoidPolys: avoid, seed, maxPoints: 24 });
          if (!r.points && avoid.length) r = routeTrail(T, a.p, b.p, { maxSlope, res: 2, seed, maxPoints: 24 });
          if (r.points) seg = r.points;
          else if (style === "stairs" || style === "canal") { seg = [a.p, b.p]; if (style === "canal") fallback = "直渠"; else straight = true; } // 台阶绕不上去就直上（崖边石阶），不算退回
          else { seg = [a.p, b.p]; unrouted = true; fallback = `${r.facts.reason || "太陡"}，只画两端和虚线`; } // 走不通：不画实线路面（直线乱穿比没画还糟），检查里给修法
        }
        line.push(...seg.slice(1).map(P2));
      }
    }
    line = line.filter((q, k) => k === 0 || dist2(q, line[k - 1]) > 0.05);
    const span = dist2(ends[0].p, ends[ends.length - 1].p), degenerate = refs.length === 2 && span < 3 && style !== "portal";
    if (degenerate) fallback = `两端只隔 ${r2(span)} m（锚点重合）`; // 桥 / 路退化成一个点：检查里给修法
    if (line.length < 2) line.push(P2(add(line[0], [0, 1])));
    const first = ends[0], last = ends[ends.length - 1];
    const sidPathId = sidIdFor.get(node.id) || sidId(node.id, true);
    const P = { id: sidPathId, plan_id: node.id, kind: STYLE_KIND[style] || "trail", style, width, points: line, surface: STYLE_SURFACE[style] || "stone", label: who, generated: true, from_id: refBase(node.from), to_id: refBase(node.to), ends_y: [first.y, last.y], elevated: [!!first.elevated, !!last.elevated] };
    if (fallback) P.fallback = fallback;
    if (straight) P.straight = true;
    if (unrouted) P.unrouted = true;
    if (inst) { P.instance_of = inst.rep; P.instance = inst.k; }
    if (style === "tunnel") P.tunnel = true;
    if (style === "bridge" || style === "rope_bridge") {
      P.deck_y = r2(Math.max(first.y, last.y));
      if (style === "bridge") { const L = polyLen(line), piers = []; for (let d = 12; d < L - 6; d += 12) { const q = alongLine(line, d / L).p, y = first.y + (last.y - first.y) * (d / L); if (y - T.heightAt(q[0], q[1]) > 4) piers.push(P2(q)); } P.piers = piers; }
    }
    if (style === "portal") {
      for (const [k, e] of [[0, first], [1, last]]) sid.markers.push({ id: sidId(`${node.id}_${k ? "b" : "a"}`), kind: "portal", position: [e.p[0], r2(e.y), e.p[1]], rotation_y: 0, label: who, plan_id: node.id, pair: `${node.id}_${k ? "a" : "b"}`, link: sidPathId });
      P.portal = true;
    }
    if (style === "canal") { P.kind = "river"; canals.push({ node, line, width }); }
    sid.paths.push(P);
    const rec = { id: recId, kind: "link", center: P2(alongLine(line, 0.5).p), line, vols: [], label: who, ends: ends.map((e) => ({ rec: e.rec, elevated: e.elevated, p: e.p, y: e.y })) };
    G.set(recId, rec);
    info.links[node.id] = { sid_id: sidPathId, style, length_m: r2(polyLen(line)), fallback, unrouted, degenerate, ends: rec.ends };
    state.set(node.id, 2);
    return rec;
  }
  const sidIdFor = new Map();
  const refBase = (s) => { const A = parseAnchor(s); return A ? A.id : null; };
  const canals = [];
  function avoidPolysFor(ends) {
    const lo = [Math.min(...ends.map((e) => e.p[0])) - 40, Math.min(...ends.map((e) => e.p[1])) - 40, Math.max(...ends.map((e) => e.p[0])) + 40, Math.max(...ends.map((e) => e.p[1])) + 40];
    const out = [];
    for (const v of sid.volumes) {
      if (v.land && (v.land.mode === "abs" || v.land.mode === "rest") || v.elev > 2.5) continue;
      if (ringOf(v)) { // 环带：矮的（≤ 3.5 m 的台面 / 摊道）路可以跨上去；高的按一段段带子挡（孔里是空的）
        if (v.size[1] > 3.5) for (const poly of footRects(v)) if (bbHit(bboxOf(poly), lo) && !ends.some((e) => pointInPolygon(e.p, poly))) out.push({ poly, a: v.size[0] * v.size[2] });
        continue;
      }
      const poly = boxCorners(v.position, [v.size[0] + 2, v.size[1], v.size[2] + 2], v.rotation_y || 0), bb = bboxOf(poly);
      if (!bbHit(bb, lo)) continue;
      if (ends.some((e) => pointInPolygon(e.p, poly))) continue;
      out.push({ poly, a: v.size[0] * v.size[2] });
    }
    return out.sort((a, b) => b.a - a.a).slice(0, 120).map((o) => o.poly);
  }

  // ---------------------------------------------------------- 主循环
  for (const n of plan.nodes) ensure(n.id);
  ensureSpawn(); settleSpawn();
  // 碰到出生点的第一条连接 = 主路（SID id main_trail）
  const touchesSpawn = (n) => [n.from, n.to, ...(n.via || [])].some((s) => s && parseAnchor(s) && parseAnchor(s).base === "spawn");
  const linkNodes = []; walkNodes(plan.nodes, (n, p, inT) => { if (!inT && n.type === "link") linkNodes.push(n); });
  const firstSpawnLink = linkNodes.find(touchesSpawn);
  if (firstSpawnLink && !G.has(firstSpawnLink.id)) sidIdFor.set(firstSpawnLink.id, "main_trail");
  placingLinks = true;
  for (const id of deferredLinks.slice()) ensure(id, true);
  if (firstSpawnLink && G.has(firstSpawnLink.id) && sidIdFor.get(firstSpawnLink.id) !== "main_trail") {
    const p = sid.paths.find((q) => q.plan_id === firstSpawnLink.id);
    if (p) { p.id = "main_trail"; info.links[firstSpawnLink.id].sid_id = "main_trail"; }
  }
  // 看向谁：spawn.look_at → 否则第一个 landmark 角色的节点 → 否则最大的根节点
  const lookId = pickFocus(plan, G, extent);
  const focusRec = lookId ? G.get(lookId) : null;
  if (!firstSpawnLink && focusRec && spawnRec.on == null && !isElevated(focusRec) && focusRec.kind !== "terrain" && extent(focusRec).poly) {
    // 自动主路：没有连接碰到出生点、出生点在地面、看向的目标在地面 → 从出生点到它补一条小路
    const auto = { id: "__main", type: "link", style: "path", from: "spawn", to: lookId, label: "主路" };
    sidIdFor.set("__main", "main_trail");
    NI.set("__main", { node: auto, parent: null, cls: "link" });
    placeGlobal("__main");
    const p = sid.paths.find((q) => q.id === "main_trail"); if (p) { p.plan_id = null; p.auto = true; }
    info.autoTrail = true; delete info.links.__main; G.delete("__main");
  }
  // 空间（interior.js：外轮廓、内部布局、连接点）
  if (spaceNodes.length) {
    const specs = spaceNodes.map(({ node, p }) => {
      const s = { id: node.id, stratum: node.stratum || "underground", label: node.label, layout: node.layout || "chamber", size_m: Array.isArray(node.size_m) ? node.size_m.slice(0, 2) : node.size_m, branching: node.branching, sublevels: node.sublevels, corridor_m: node.corridor_m, height_m: node.height_m, rooms: node.rooms, links: node.links, layout_seed: node.layout_seed };
      const tgt = s.stratum === "sky" ? node.over : node.under;
      s[s.stratum === "sky" ? "over" : "under"] = tgt || `__pt_${node.id}`;
      if (!tgt) G.set(`__pt_${node.id}`, { id: `__pt_${node.id}`, kind: "terrain", center: P2(p), poly: null });
      if (s.stratum === "sky") s.height_layers = Math.max(1, Math.round((node.elev_m || node.depth_m || 12) / layer)); else s.depth_layers = Math.max(1, Math.round((node.depth_m || 8) / layer));
      if (node.connect) s.connect = { via: node.connect.via, from: node.connect.from && node.connect.from !== node.id ? node.connect.from : undefined };
      if (tgt && node.offset_m) s.offset_m = [node.offset_m[0], node.offset_m.length >= 3 ? node.offset_m[2] : node.offset_m[1]];
      return s;
    });
    const resolveT = (id) => {
      if (id === "spawn") return { point: spawnRec.center, polygon: null, top_y: spawnRec.y ?? T.heightAt(spawnRec.center[0], spawnRec.center[1]), kind: "spawn", label: "出生点" };
      const r = G.get(id) || (parseAnchor(id) && G.get(parseAnchor(id).id));
      if (!r) return null;
      if (r.kind === "terrain" || r.kind === "site") return { point: r.topPoint || r.center, polygon: r.poly || null, top_y: r.top ?? T.heightAt(r.center[0], r.center[1]), kind: "terrain", label: r.label };
      const e = extent(r);
      return { point: centerOf(r), polygon: e.poly, top_y: e.top ?? T.heightAt(centerOf(r)[0], centerOf(r)[1]), kind: r.kind === "gen" ? "zone" : "building", label: r.label };
    };
    const tmpMarkers = sid.markers;
    sid.markers = sid.markers.concat([{ id: "spawn", kind: "player_spawn", position: [spawnRec.center[0], 0, spawnRec.center[1]] }]);
    const out = compileSpaces(specs, sid, T, resolveT, { seed });
    sid.markers = tmpMarkers;
    for (const s of out.spaces) { s.id = sidId(s.id, true); sid.spaces.push(s); const nd = spaceNodes.find((q) => q.node.id === s.plan_id); if (nd) { const r = G.get(nd.recId); r.poly = s.polygon; r.center = P2(s.entrance ? s.entrance.slice(0, 2) : polygonCentroid(s.polygon)); } }
    for (const m of out.connectors) { m.id = sidId(m.id); sid.markers.push(m); }
    for (const w of out.warnings || []) W_(w);
  }
  // 水渠：开沟，重建高度场
  if (canals.length) {
    for (const c of canals) feats.push({ id: sidId(`${c.node.id}_cut`), plan_id: c.node.id, kind: "carve", op: "carve", label: c.node.label || "渠", blend: "add", amount: -2, mask: "line", line: c.line, half: c.width / 2, edge: "cliff", skirt: 1, center: [r2(c.line[0][0]), 0, r2(c.line[0][1])], radius: r2(polyLen(c.line) / 2 + 1), height: -2 });
    sid.terrain.features = feats;
    T = buildTerrain(sid, { res: 2 });
  }
  // 水面：区域（湖 / 海 / 池）与河
  for (const w of waters) {
    if (w.river) { sid.paths.push({ id: sidId(`${w.id}_water`), plan_id: w.id, kind: "river", width: w.width, points: w.line.map(P2), surface: "water", label: w.label, generated: true }); continue; }
    if (sid.regions.some((r) => r.id === w.id && r.kind === "water")) continue;
    const reg = { id: sidId(w.id === "sea" || allIds.has(w.id) || w.id.startsWith("ground_") || w.id === "lake" ? `${w.id}_water` : w.id), kind: "water", polygon: w.polygon.map(P2), density: 0, label: w.label, plan_id: allIds.has(w.id) ? w.id : w.id === "lake" || w.id === "sea" ? w.id : "site", surface_y: w.surface_y };
    if (w.hole) reg.hole = w.hole.map(P2);
    sid.regions.push(reg);
  }
  // 出生点标记
  const lookPt = focusRec ? centerOf(focusRec) : [0, 0];
  const sy = spawnRec.y != null ? spawnRec.y : groundW(spawnRec.center[0], spawnRec.center[1]);
  sid.markers.unshift({ id: "spawn", plan_id: "spawn", kind: "player_spawn", position: [spawnRec.center[0], r2(sy), spawnRec.center[1]], rotation_y: dist2(spawnRec.center, lookPt) > 1e-6 ? facingToRotation(unit([lookPt[0] - spawnRec.center[0], lookPt[1] - spawnRec.center[1]])) : 0, label: (plan.spawn && plan.spawn.label) || "出生点" });
  if (spawnRec.on) sid.markers[0].rests_on = spawnRec.on;
  G.set("spawn", Object.assign({}, spawnRec, { center: spawnRec.center }));
  // 主地标（出生点第一眼看的）：它最高的体块
  if (focusRec) {
    // 主地标体块 = 节点自己的主体块；组 / 重复取显式 landmark 的体块里最大的，没有就取最大的（不取最高的：平台上一根细柱不该成主地标）
    const e = extent(focusRec), cand = (focusRec.vols || []).filter((v) => !v.plinth_of), lm = cand.filter((v) => v.importance === "landmark"), vol3 = (v) => v.size[0] * v.size[1] * v.size[2];
    const big = cand.reduce((m, v) => (!m || vol3(v) > vol3(m) ? v : m), null), tv = e.topVol;
    const fv = (focusRec.main && !focusRec.main.plinth_of ? focusRec.main : null) || (lm.length ? lm.reduce((m, v) => (!m || vol3(v) > vol3(m) ? v : m), null) : null)
      || (tv && !tv.plinth_of && tv.importance !== "detail" && (!big || vol3(tv) >= 0.1 * vol3(big)) ? tv : big) || tv; // 叠层 / 塔群取最高的那块；最高的是细柱这类小件时取最大的
    if (fv) { sid.meta.focus = fv.id; if (fv.importance !== "landmark") fv.importance = "landmark"; }
    const mt = sid.paths.find((q) => q.id === "main_trail");
    if (mt && fv && (mt.to_id === lookId || info.autoTrail)) sid.meta.trail_target = fv.id;
  }
  // 最终落地（水渠改了地形；顺序 = 父在前）
  WR = waterRegions(sid);
  for (const v of sid.volumes) landVolume(v, T, byVol, WR);
  // 外观
  const ROLES0 = [{ role: "roof", hex: "#4A4A4A", note: "屋顶" }, { role: "wall", hex: "#D9C9A3", note: "墙" }, { role: "stone", hex: "#9A9890", note: "石" }, { role: "foliage", hex: "#4F6B3A", note: "植物" }, { role: "mist", hex: "#DDE6F0", note: "雾" }];
  const byRole = new Map(ROLES0.map((q) => [q.role, clone(q)]));
  for (const q of plan.palette || []) byRole.set(q.role, { role: q.role, hex: q.hex, note: q.note || (byRole.get(q.role) || {}).note || "" });
  sid.style.palette = [...byRole.values()];
  for (const v of sid.volumes) if (v.color_role && !byRole.has(v.color_role)) v.color_role = KIND_COLOR[v.kind] || "stone";
  const tod = (plan.lighting && plan.lighting.time_of_day) || (site.ground === "cavern" ? "night" : "dusk"), sun = SUN[tod] || SUN.dusk;
  sid.style.lighting = { time_of_day: tod, sun_azimuth_deg: sun[0], sun_elevation_deg: sun[1] };
  // 高度范围
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < T.grid.h.length; i++) { ymin = Math.min(ymin, T.grid.h[i]); ymax = Math.max(ymax, T.grid.h[i]); }
  for (const v of sid.volumes) ymax = Math.max(ymax, v.position[1] + v.size[1]);
  for (const s of sid.spaces) ymin = Math.min(ymin, s.floor_y);
  sid.bounds.min[1] = r2(Math.min(-5, ymin - 5)); sid.bounds.max[1] = r2(Math.max(40, ymax + 10));
  info.recs = G; info.focus = lookId; info.spawn = spawnRec; info.T = T; info.waters = waters;
  return { sid, T, info };
}

/** 看向谁：spawn.look_at → 第一个 landmark 角色的全局节点 → 体量最大的根节点 */
function pickFocus(plan, G, extent) {
  const la = plan.spawn && plan.spawn.look_at;
  if (la && G.has(la) && (G.get(la).vols || []).length) return la;
  let lm = null; walkNodes(plan.nodes, (n, p, inT) => { if (!inT && !lm && n.role === "landmark" && G.has(n.id) && (G.get(n.id).vols || []).length) lm = n.id; });
  if (lm) return lm;
  let best = null, bs = -1;
  for (const n of plan.nodes) { const r = G.get(n.id); if (!r || !(r.vols || []).length) continue; const e = extent(r); if (!e.bb) continue; const s = (e.bb[2] - e.bb[0]) * (e.bb[3] - e.bb[1]) * Math.max(1, e.top - e.base); if (s > bs) { bs = s; best = n.id; } }
  return best || (la && G.has(la) ? la : null);
}

const CENTER_WORDS = new Set(["center", "centre", "middle", "中心", "环心"]);
/** 一组连接：repeat 的模板是 link（每个实例一条连接） */
export const linkRepeat = (n) => !!n && n.type === "repeat" && isObj(n.child) && n.child.type === "link";
/** 遍历节点树：fn(node, parent, inTemplate)；repeat 的 child 也走（inTemplate = true），scatter_houses 的 child 不走 */
export function walkNodes(nodes, fn, parent = null, inTemplate = false) {
  for (const n of nodes || []) {
    if (!isObj(n)) continue;
    fn(n, parent, inTemplate);
    if (Array.isArray(n.children)) walkNodes(n.children, fn, n, inTemplate);
    if (n.type === "repeat" && isObj(n.child)) walkNodes([n.child], fn, n, true);
  }
}
