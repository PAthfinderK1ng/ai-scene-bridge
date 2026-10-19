// strata.js — 多层空间（D18）：地下（溶洞 / 地道 / 地窖 / 地宫）与天上（平台 / 栈道 / 浮岛 / 天桥）的空间与连接点。
// 规格见 docs/04 §4、SPEC.md §10。铁律不变：AI 只给结构级的 levels（层、种类、锚点类、层数、大小、连接方式），
// 多边形、高度、连接点位置全部由这里的确定性算法算出（随机只来自 sid.meta.seed）。
import { rng, clamp, r2, pointInPolygon, distToPolygon, distToPolyline, polygonCentroid, polygonArea, generateArchetype, DEFAULT_BOUNDS } from "./terrain.js";
import { boxCorners } from "./layout.js";

// ------------------------------------------------------------ 词表
export const STRATA = ["underground", "sky"];
export const STRATA_KINDS = Object.freeze({ underground: ["cave", "tunnel", "cellar", "crypt"], sky: ["platform", "walkway", "island", "bridge"] });
export const STRATUM_LABEL = Object.freeze({ ground: "地面", underground: "地下", sky: "天上" });
export const SPACE_LABEL = Object.freeze({ cave: "溶洞", tunnel: "地道", cellar: "地窖", crypt: "地宫", platform: "平台", walkway: "栈道", island: "浮岛", bridge: "天桥" });
export const CONNECTOR_VIA = ["stairs", "ladder", "well", "shaft", "elevator", "rope_bridge", "ramp"];
export const VIA_LABEL = Object.freeze({ stairs: "楼梯", ladder: "梯子", well: "井", shaft: "竖井", elevator: "升降台", rope_bridge: "索桥", ramp: "坡道" });
export const ANCHORS = ["landmark", "village", "top", "plaza", "ridge_end", "cliff_edge", "entry"];
export const ANCHOR_LABEL = Object.freeze({ landmark: "地标", village: "村子", top: "顶层", plaza: "广场", ridge_end: "山脊尽头", cliff_edge: "崖边", entry: "入口" });
/** 圆角多边形直径（米） */
export const SIZES = Object.freeze({ small: 10, medium: 18, large: 28 });
/** 长条（地道 / 栈道 / 天桥）长度与宽度（米） */
export const STRIP = Object.freeze({ length: { small: 16, medium: 28, large: 40 }, width: { tunnel: 4, walkway: 3, bridge: 3 } });
/** 地下顶板到地面的最小岩层、空中板底到地面的最小净空、空中板厚（米） */
export const CLEARANCE = Object.freeze({ rock: 2, air: 3, slab: 1 });
/** 每种空间的默认净高（米） */
export const NET_HEIGHT = Object.freeze({ cave: 6, tunnel: 3, cellar: 3, crypt: 5, platform: 4, walkway: 3, island: 6, bridge: 3 });
/** 每种空间的默认连接方式 */
export const DEFAULT_VIA = Object.freeze({ cave: "stairs", tunnel: "ramp", cellar: "ladder", crypt: "stairs", platform: "stairs", walkway: "ladder", island: "elevator", bridge: "stairs" });
/** 默认层数：地下在地面下 2 层，空中在地面上 3 层 */
export const DEFAULT_LAYERS = Object.freeze({ underground: 2, sky: 3 });
export const MAX_LEVELS = 3;

const xz = (p) => [p[0], p[2]];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? null : [v[0] / L, v[1] / L]; };
const layersKey = (stratum) => (stratum === "underground" ? "depth_layers" : "height_layers");
const isSpace = (s) => s && typeof s.id === "string" && STRATA.includes(s.stratum) && Array.isArray(s.polygon) && s.polygon.length >= 3;
const half = (v) => Math.round(v * 2) / 2;

// ------------------------------------------------------------ levels（AI 卡片字段）
/**
 * 规范化卡片的 levels：最多 3 项；stratum / kind 不合法的项丢弃；其余字段非法时回退默认。
 * @param {object[]} levels
 * @returns {{stratum, kind, anchor, size, connect, label, depth_layers?, height_layers?}[]}
 */
export function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const l of levels) {
    if (out.length >= MAX_LEVELS) break;
    if (!l || typeof l !== "object") continue;
    const kinds = STRATA_KINDS[l.stratum];
    if (!kinds || !kinds.includes(l.kind)) continue;
    const key = layersKey(l.stratum), max = l.stratum === "underground" ? 5 : 6;
    out.push({
      stratum: l.stratum, kind: l.kind,
      anchor: ANCHORS.includes(l.anchor) ? l.anchor : "landmark",
      size: SIZES[l.size] ? l.size : "medium",
      connect: CONNECTOR_VIA.includes(l.connect) ? l.connect : DEFAULT_VIA[l.kind],
      label: typeof l.label === "string" && l.label.trim() ? l.label.trim().slice(0, 24) : STRATUM_LABEL[l.stratum] + SPACE_LABEL[l.kind],
      [key]: clamp(Math.round(Number(l[key]) || DEFAULT_LAYERS[l.stratum]), 1, max),
    });
  }
  return out;
}

// ------------------------------------------------------------ 地面高度与合格高度
/**
 * 多边形内（含边界，边每 1 m、内部 2 m 网格）地面的最低 / 最高点。
 * @returns {{min: number, max: number}}
 */
export function groundRange(poly, T) {
  let mn = Infinity, mx = -Infinity;
  const take = (x, z) => { const h = T.heightAt(x, z); if (h < mn) mn = h; if (h > mx) mx = h; };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(dist2(a, b)));
    for (let k = 0; k < n; k++) take(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  }
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  for (let x = Math.ceil(Math.min(...xs) / 2) * 2; x <= Math.max(...xs); x += 2) for (let z = Math.ceil(Math.min(...zs) / 2) * 2; z <= Math.max(...zs); z += 2) if (pointInPolygon([x, z], poly)) take(x, z);
  return { min: mn, max: mx };
}

/**
 * 合格高度的界：地下 = floor_y 最高可到（顶板离地 ≥ 2 m）；空中 = floor_y 最低可到（板底离地 ≥ 3 m，板厚 1 m）。
 * @returns {number}
 */
export function clearLimit(space, T) {
  const g = groundRange(space.polygon, T);
  return space.stratum === "underground" ? g.min - CLEARANCE.rock - space.height : g.max + CLEARANCE.air + CLEARANCE.slab;
}

/**
 * 按规则算底面高度（0.5 m 取整，保证合格）：
 * 地下 floor_y = 质心处地面 − depth_layers × 层高 − 净高，再压到 clearLimit 以下；
 * 空中 floor_y = 质心处地面 + height_layers × 层高，再抬到 clearLimit 以上。
 * @param {object} space 需有 stratum / polygon / height，可有 depth_layers / height_layers
 * @param {object} T buildTerrain 结果
 * @param {number} [layer=T.layer]
 * @returns {number}
 */
export function fitFloor(space, T, layer = T.layer) {
  const c = polygonCentroid(space.polygon), ref = T.heightAt(c[0], c[1]), lim = clearLimit(space, T);
  const n = Number(space[layersKey(space.stratum)]);
  const k = Number.isFinite(n) && n > 0 ? n : DEFAULT_LAYERS[space.stratum];
  if (space.stratum === "underground") return Math.floor(Math.min(ref - k * layer - space.height, lim) * 2) / 2;
  return Math.ceil(Math.max(ref + k * layer, lim) * 2) / 2;
}

/**
 * 空间与地形的净空：地下 gap = 地面最低 − 顶板；空中 gap = 板底 − 地面最高。
 * @returns {{ok: boolean, gap: number, need: number, limit: number}}
 */
export function spaceClearance(space, T) {
  const g = groundRange(space.polygon, T);
  if (space.stratum === "underground") {
    const gap = g.min - (space.floor_y + space.height);
    return { ok: gap >= CLEARANCE.rock - 1e-6, gap: r2(gap), need: CLEARANCE.rock, limit: Math.floor((g.min - CLEARANCE.rock - space.height) * 2) / 2 };
  }
  const gap = space.floor_y - CLEARANCE.slab - g.max;
  return { ok: gap >= CLEARANCE.air - 1e-6, gap: r2(gap), need: CLEARANCE.air, limit: Math.ceil((g.max + CLEARANCE.air + CLEARANCE.slab) * 2) / 2 };
}

// ------------------------------------------------------------ 锚点
function actors(sid) {
  const lm = (sid.volumes || []).find((v) => v && v.importance === "landmark" && v.position) || (sid.volumes || []).find((v) => v && v.id === "landmark" && v.position) || null;
  const spawn = (sid.markers || []).find((m) => m && m.kind === "player_spawn" && m.position) || null;
  const trail = (sid.paths || []).find((p) => p && p.id === "main_trail" && Array.isArray(p.points) && p.points.length >= 2) || null;
  return { lm, spawn, trail };
}
/** 多边形里离边最远的一个候选点（质心、对顶点中点、顶点向质心收 3 m） */
export function insidePoint(poly) {
  const c = polygonCentroid(poly), n = poly.length, cands = [c];
  for (let i = 0; i < n; i++) { const j = n - 1 - i; if (j !== i) cands.push([(poly[i][0] + poly[j][0]) / 2, (poly[i][1] + poly[j][1]) / 2]); }
  for (const v of poly) { const d = dist2(v, c) || 1; cands.push([v[0] + ((c[0] - v[0]) / d) * 3, v[1] + ((c[1] - v[1]) / d) * 3]); }
  let best = null, bd = -1;
  for (const q of cands) { if (!pointInPolygon(q, poly)) continue; const d = distToPolygon(q, poly); if (d > bd + 1e-9) { bd = d; best = q; } }
  return best || c;
}
/** 没给 g 时按 meta 里的原型 / 参数 / 种子重算一次（确定性，只取 spots / entries） */
function archetypeOf(sid) {
  const m = sid.meta || {};
  if (!m.archetype) return null;
  try { return generateArchetype(m.archetype, m.card_params || {}, sid.bounds || DEFAULT_BOUNDS, (Number(m.seed) >>> 0) || 1); } catch (e) { return null; }
}

/**
 * 锚点类 → [x, z]。landmark 地标中心 / village 民居区（面积最大的 other 区域）/ top 顶层台地内 / plaza 广场区域或原型广场点 /
 * ridge_end、cliff_edge 原型给的点 / entry 出生点。缺数据时依次回退到 top、bounds 中心。
 */
export function anchorPoint(anchor, sid, T, g) {
  if (!g && ["plaza", "ridge_end", "cliff_edge", "entry"].includes(anchor)) g = archetypeOf(sid);
  const { lm, spawn } = actors(sid);
  const b = sid.bounds || DEFAULT_BOUNDS, center = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
  const top = () => { const t = T.topTerrace(); return t ? insidePoint(t.polygon) : g ? g.spots.top : center; };
  const regionOf = (kind) => (sid.regions || []).filter((r) => r && r.kind === kind && Array.isArray(r.polygon) && r.polygon.length >= 3)
    .sort((a, c) => polygonArea(c.polygon) - polygonArea(a.polygon) || String(a.id).localeCompare(String(c.id)))[0] || null;
  switch (anchor) {
    case "landmark": return lm ? xz(lm.position) : top();
    case "top": return top();
    case "village": { const r = regionOf("other"); if (r) return insidePoint(r.polygon); const ts = T.terraces; return ts.length ? insidePoint(ts[Math.floor(ts.length / 2)].polygon) : center; }
    case "plaza": { const r = regionOf("plaza"); if (r) return insidePoint(r.polygon); if (g) return g.spots.plaza; const ts = T.terraces; return ts.length ? insidePoint(ts[Math.floor(ts.length / 2)].polygon) : center; }
    case "ridge_end": return g ? g.spots.ridge_end : top();
    case "cliff_edge": return g ? g.spots.cliff_edge : top();
    case "entry": return spawn ? xz(spawn.position) : g ? g.entries.S : center;
    default: return top();
  }
}

// ------------------------------------------------------------ 方向与多边形
/** 等高线方向（大半径梯度的垂线）；平地时取「入口 → 点」的垂线；符号固定（x 分量 ≥ 0） */
function contourDir(T, p, sid) {
  const R = 6, gx = T.heightAt(p[0] + R, p[1]) - T.heightAt(p[0] - R, p[1]), gz = T.heightAt(p[0], p[1] + R) - T.heightAt(p[0], p[1] - R);
  let u = Math.hypot(gx, gz) > 0.3 ? unit([-gz, gx]) : null;
  if (!u) { const { spawn } = actors(sid); const d = spawn ? unit([p[0] - spawn.position[0], p[1] - spawn.position[2]]) : null; u = d ? [-d[1], d[0]] : [1, 0]; }
  return u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0) ? [-u[0], -u[1]] : u;
}
/** 下坡方向；平地时朝入口；都没有就朝南 */
function downhillDir(T, p, sid) {
  const R = 6, gx = T.heightAt(p[0] + R, p[1]) - T.heightAt(p[0] - R, p[1]), gz = T.heightAt(p[0], p[1] + R) - T.heightAt(p[0], p[1] - R);
  if (Math.hypot(gx, gz) > 0.3) return unit([-gx, -gz]);
  const { spawn } = actors(sid);
  return (spawn && unit([spawn.position[0] - p[0], spawn.position[2] - p[1]])) || [0, 1];
}
function roundPoly(c, D, rand) {
  const R = D / 2, asp = 0.8 + 0.2 * rand(), rot = rand() * Math.PI, cs = Math.cos(rot), sn = Math.sin(rot), out = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, r = R * (1 + (rand() - 0.5) * 0.12), lx = r * Math.cos(a), lz = r * asp * Math.sin(a);
    out.push([c[0] + lx * cs - lz * sn, c[1] + lx * sn + lz * cs]);
  }
  return out;
}
function stripPoly(a, b, w) {
  const u = unit([b[0] - a[0], b[1] - a[1]]) || [1, 0], n = [-u[1] * (w / 2), u[0] * (w / 2)];
  return [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]];
}
/** 整体平移进 bounds（留 margin）；比 bounds 还大时逐点夹取 */
function fitInBounds(poly, b, margin = 2) {
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const lo = [b.min[0] + margin, b.min[2] + margin], hi = [b.max[0] - margin, b.max[2] - margin];
  const shift = (mn, mx, l, h) => (mx - mn > h - l ? 0 : mn < l ? l - mn : mx > h ? h - mx : 0);
  const dx = shift(Math.min(...xs), Math.max(...xs), lo[0], hi[0]), dz = shift(Math.min(...zs), Math.max(...zs), lo[1], hi[1]);
  return poly.map(([x, z]) => [r2(clamp(x + dx, lo[0], hi[0])), r2(clamp(z + dz, lo[1], hi[1]))]);
}
/** 空中空间贴着地标旁边放（不压在地标头顶）：沿「地标 → 入口」的垂线偏开 */
function besideLandmark(lm, spawn, extra, b) {
  const c = xz(lm.position), d = (spawn && unit([spawn.position[0] - c[0], spawn.position[2] - c[1]])) || [0, 1];
  const off = Math.hypot(lm.size[0], lm.size[2]) / 2 + extra;
  for (const s of [1, -1]) {
    const p = [c[0] - d[1] * off * s, c[1] + d[0] * off * s];
    if (p[0] > b.min[0] + extra && p[0] < b.max[0] - extra && p[1] > b.min[2] + extra && p[1] < b.max[2] - extra) return p;
  }
  return [c[0] - d[1] * off, c[1] + d[0] * off];
}
/**
 * 天桥另一端：从 A 出发 24 个方向 × 长度 10..min(60, 1.6×目标长) 搜，要求两端高差 ≤ 2 层，且中间有 ≥ 2 m 的谷或两端在不同台地；
 * 评分 = 谷深×2（封顶 10 m）+ 跨台地 3 − |长度 − 目标|×0.3。找不到返回 null。
 */
export function bridgeEnd(T, A, target, b) {
  const hA = T.heightAt(A[0], A[1]), tA = T.terraceAt(A[0], A[1]);
  let best = null, bs = -Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k * 15 * Math.PI) / 180, u = [Math.cos(a), Math.sin(a)];
    for (let L = 10; L <= Math.min(60, target * 1.6); L += 2) {
      const B = [A[0] + u[0] * L, A[1] + u[1] * L];
      if (B[0] < b.min[0] + 3 || B[0] > b.max[0] - 3 || B[1] < b.min[2] + 3 || B[1] > b.max[2] - 3) break;
      const hB = T.heightAt(B[0], B[1]);
      if (Math.abs(hA - hB) > 2 * T.layer + 1e-6) continue;
      let low = Infinity;
      for (let s = 1; s < L; s++) low = Math.min(low, T.heightAt(A[0] + u[0] * s, A[1] + u[1] * s));
      const dip = Math.min(hA, hB) - low, tB = T.terraceAt(B[0], B[1]), cross = !!(tA && tB && tA.id !== tB.id);
      if (dip < 2 && !cross) continue;
      const score = Math.min(dip, 10) * 2 + (cross ? 3 : 0) - Math.abs(L - target) * 0.3;
      if (score > bs + 1e-9) { bs = score; best = [r2(B[0]), r2(B[1])]; }
    }
  }
  return best;
}
function shapeFor(lv, p0, sid, T, rand) {
  const b = sid.bounds || DEFAULT_BOUNDS, { lm, spawn } = actors(sid), D = SIZES[lv.size], Ls = STRIP.length[lv.size];
  let c = p0;
  if (lv.stratum === "sky" && lv.anchor === "landmark" && lm) c = besideLandmark(lm, spawn, lv.kind === "bridge" ? 2 : lv.kind === "walkway" ? 3 : D / 2 + 1, b);
  let poly;
  if (lv.kind === "walkway") { const u = contourDir(T, c, sid); poly = stripPoly([c[0] - (u[0] * Ls) / 2, c[1] - (u[1] * Ls) / 2], [c[0] + (u[0] * Ls) / 2, c[1] + (u[1] * Ls) / 2], STRIP.width.walkway); }
  else if (lv.kind === "tunnel") { const u = downhillDir(T, c, sid); poly = stripPoly([c[0] - (u[0] * Ls) / 2, c[1] - (u[1] * Ls) / 2], [c[0] + (u[0] * Ls) / 2, c[1] + (u[1] * Ls) / 2], STRIP.width.tunnel); }
  else if (lv.kind === "bridge") { let B = bridgeEnd(T, c, Ls, b); if (!B) { const u = downhillDir(T, c, sid); B = [c[0] + u[0] * Ls, c[1] + u[1] * Ls]; } poly = stripPoly(c, B, STRIP.width.bridge); }
  else poly = roundPoly(c, D, rand);
  return fitInBounds(poly, b);
}

// ------------------------------------------------------------ 连接点
/** 连接点要避开的底面：非 generated 的体块（地标、人放的房子）外扩 1 m */
function blockers(sid) {
  return (sid.volumes || []).filter((v) => v && !v.generated && v.position && v.size).map((v) => boxCorners(v.position, [v.size[0] + 2, v.size[1], v.size[2] + 2], v.rotation_y || 0));
}
/** 参考线：主路；还没有主路（applyCard 时）用「入口 → 地标」直线；都没有返回 null */
function refLine(sid) {
  const { lm, spawn, trail } = actors(sid);
  if (trail) return trail.points;
  if (lm && spawn) return [xz(spawn.position), xz(lm.position)];
  if (spawn) return [xz(spawn.position), xz(spawn.position)];
  return null;
}
/** 天桥两端：4 点长条取两条短边中点，其它多边形取相距最远的两个顶点；都向质心收 1.5 m */
function bridgeEnds(poly) {
  const c = polygonCentroid(poly);
  let a, b;
  if (poly.length === 4) {
    const m01 = [(poly[0][0] + poly[1][0]) / 2, (poly[0][1] + poly[1][1]) / 2], m12 = [(poly[1][0] + poly[2][0]) / 2, (poly[1][1] + poly[2][1]) / 2];
    const m23 = [(poly[2][0] + poly[3][0]) / 2, (poly[2][1] + poly[3][1]) / 2], m30 = [(poly[3][0] + poly[0][0]) / 2, (poly[3][1] + poly[0][1]) / 2];
    [a, b] = dist2(poly[0], poly[1]) >= dist2(poly[1], poly[2]) ? [m30, m12] : [m01, m23];
  } else {
    let bd = -1;
    for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) { const d = dist2(poly[i], poly[j]); if (d > bd) { bd = d; a = poly[i]; b = poly[j]; } }
  }
  const pull = (p) => { const d = dist2(p, c) || 1; return [p[0] + ((c[0] - p[0]) / d) * 1.5, p[1] + ((c[1] - p[1]) / d) * 1.5]; };
  return [pull(a), pull(b)];
}
function candidates(space) {
  const poly = space.polygon, c = polygonCentroid(poly), out = [];
  const pull = (p, m) => { const d = dist2(p, c) || 1; return [p[0] + ((c[0] - p[0]) / d) * Math.min(m, d), p[1] + ((c[1] - p[1]) / d) * Math.min(m, d)]; };
  if (space.stratum === "sky") {
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; out.push(pull(a, 1), pull([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1)); }
    return out;
  }
  if (pointInPolygon(c, poly)) out.push(c);
  for (const v of poly) out.push(pull(v, 1.5));
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  for (let x = Math.ceil(Math.min(...xs) / 2) * 2; x <= Math.max(...xs); x += 2) for (let z = Math.ceil(Math.min(...zs) / 2) * 2; z <= Math.max(...zs); z += 2) if (pointInPolygon([x, z], poly) && distToPolygon([x, z], poly) >= 1) out.push([x, z]);
  return out.filter((p) => pointInPolygon(p, poly));
}

/**
 * 给一个空间生成连接点 marker（kind connector，from "ground"，to 空间 id，position 是下端）。
 * 地下：空间多边形内、离主路（没有主路时离「入口 → 地标」线）最近的点，向下；空中：多边形边上（向内 1 m）离主路最近的点，向上；
 * 天桥：end = 0 / 1 分别是两端。避开地标与人放的体块；via 取 space.connect，缺省按种类。
 * @param {object} space
 * @param {object} sid
 * @param {object} T
 * @param {number} [end=0] 天桥的第几端（0 / 1）；id 为 conn_<空间 id>，第二端加 _2
 * @returns {object} marker
 */
export function connectorFor(space, sid, T, end = 0) {
  const b = sid.bounds || DEFAULT_BOUNDS, via = CONNECTOR_VIA.includes(space.connect) ? space.connect : DEFAULT_VIA[space.kind] || "stairs";
  let p;
  if (space.kind === "bridge") p = bridgeEnds(space.polygon)[end ? 1 : 0];
  else {
    const blocks = blockers(sid), ref = refLine(sid), c = polygonCentroid(space.polygon);
    const ok = (q) => T.inside(q[0], q[1]) && !blocks.some((poly) => pointInPolygon(q, poly));
    const cs = candidates(space);
    const pool = cs.filter(ok).length ? cs.filter(ok) : cs.length ? cs : [c];
    const score = (q) => (ref ? distToPolyline(q, ref.length >= 2 ? ref : [ref[0], ref[0]]) : dist2(q, c));
    p = pool[0]; let bs = score(p);
    for (const q of pool) { const s = score(q); if (s < bs - 1e-9) { bs = s; p = q; } }
  }
  p = [r2(clamp(p[0], b.min[0] + 1, b.max[0] - 1)), r2(clamp(p[1], b.min[2] + 1, b.max[2] - 1))];
  const g = r2(T.heightAt(p[0], p[1])), under = space.stratum === "underground";
  const top_y = under ? g : r2(space.floor_y), bottom_y = under ? r2(space.floor_y) : g;
  return {
    id: "conn_" + space.id + (end ? "_2" : ""), kind: "connector", via, from: "ground", to: space.id,
    position: [p[0], bottom_y, p[1]], top_y, bottom_y, rotation_y: 0,
    label: (under ? "下行" : "上行") + VIA_LABEL[via], generated: true,
  };
}
/** 一个空间的全部默认连接点（天桥两端各一个） */
export function connectorsFor(space, sid, T) { return space.kind === "bridge" ? [connectorFor(space, sid, T, 0), connectorFor(space, sid, T, 1)] : [connectorFor(space, sid, T, 0)]; }

/** 连接点两端高度：端点是 "ground" 时取连接点处地面，是空间时取它的 floor_y；position.y = 下端 */
export function connectorHeights(m, sid, T) {
  const byId = new Map((sid.spaces || []).map((s) => [s.id, s]));
  const at = (e) => (e === "ground" || !byId.has(e) ? T.heightAt(m.position[0], m.position[2]) : byId.get(e).floor_y);
  const ys = [at(m.from), at(m.to)];
  m.top_y = r2(Math.max(...ys)); m.bottom_y = r2(Math.min(...ys)); m.position[1] = m.bottom_y;
  return m;
}

// ------------------------------------------------------------ 生成 / 新建
/**
 * 按卡片 levels 生成空间与连接点（applyCard 调用）。id = space_<kind>_<n>（避开 sid.spaces 里已有的 id）。
 * @param {object[]} levels Card.levels（会先 normalizeLevels）
 * @param {object} sid 读 bounds / volumes（地标）/ markers（出生点）/ regions / paths / meta.seed
 * @param {object} T buildTerrain 结果
 * @param {object} [g] generateArchetype 结果（取 spots / entries）；省略时按 meta 重算
 * @returns {{spaces: object[], connectors: object[]}}
 */
export function generateSpaces(levels, sid, T, g) {
  const L = normalizeLevels(levels);
  if (!L.length) return { spaces: [], connectors: [] };
  g = g || archetypeOf(sid);
  const seed = (Number(sid.meta && sid.meta.seed) >>> 0) || 1;
  const taken = new Set((sid.spaces || []).map((s) => s && s.id));
  const spaces = [], connectors = [];
  L.forEach((lv, i) => {
    const rand = rng((Math.imul(seed, 2654435761) + i * 977 + 13) >>> 0);
    let n = 1; while (taken.has(`space_${lv.kind}_${n}`)) n++;
    const id = `space_${lv.kind}_${n}`; taken.add(id);
    const polygon = shapeFor(lv, anchorPoint(lv.anchor, sid, T, g), sid, T, rand);
    const key = layersKey(lv.stratum);
    const space = { id, stratum: lv.stratum, kind: lv.kind, polygon, floor_y: 0, height: NET_HEIGHT[lv.kind], label: lv.label, anchor: lv.anchor, size: lv.size, [key]: lv[key], connect: lv.connect, generated: true };
    space.floor_y = fitFloor(space, T);
    spaces.push(space);
  });
  const ctx = Object.assign({}, sid, { spaces: [...(sid.spaces || []), ...spaces] });
  for (const s of spaces) connectors.push(...connectorsFor(s, ctx, T));
  return { spaces, connectors };
}

/**
 * 人在地下 / 天上层圈出来的多边形 → 空间（user_set: true）+ 一个连接点。不改 sid。
 * floor_y / height 没给时补：地下默认地面下 2 层、空中上 3 层，并按多边形内地面最高 / 最低点保证岩层 ≥ 2 m、板底离地 ≥ 3 m。
 * @param {{stratum: string, kind?: string, polygon: number[][], floor_y?: number, height?: number, label?: string, id?: string, connect?: string}} spec
 * @param {object} sid
 * @param {object} T
 * @returns {{space: object, connector: object}|null} 多边形或 stratum 不合法时 null
 */
export function makeSpace(spec, sid, T) {
  if (!spec || !STRATA.includes(spec.stratum) || !Array.isArray(spec.polygon) || spec.polygon.length < 3) return null;
  const kind = STRATA_KINDS[spec.stratum].includes(spec.kind) ? spec.kind : STRATA_KINDS[spec.stratum][0];
  const taken = new Set([...(sid.spaces || []).map((s) => s && s.id), ...(sid.markers || []).map((m) => m && m.id)]);
  let id = typeof spec.id === "string" && /^[a-z][a-z0-9_]*$/.test(spec.id) && !taken.has(spec.id) ? spec.id : null;
  for (let n = 1; !id; n++) if (!taken.has("u_space_" + n)) id = "u_space_" + n;
  const key = layersKey(spec.stratum);
  const space = {
    id, stratum: spec.stratum, kind, polygon: fitInBounds(spec.polygon, sid.bounds || DEFAULT_BOUNDS, 0), floor_y: 0,
    height: Number(spec.height) > 0 ? r2(Number(spec.height)) : NET_HEIGHT[kind],
    label: spec.label || STRATUM_LABEL[spec.stratum] + SPACE_LABEL[kind], [key]: DEFAULT_LAYERS[spec.stratum],
    connect: CONNECTOR_VIA.includes(spec.connect) ? spec.connect : DEFAULT_VIA[kind], user_set: true,
  };
  space.floor_y = Number.isFinite(Number(spec.floor_y)) && spec.floor_y !== null && spec.floor_y !== "" ? r2(Number(spec.floor_y)) : fitFloor(space, T);
  const ctx = Object.assign({}, sid, { spaces: [...(sid.spaces || []), space] });
  return { space, connector: connectorFor(space, ctx, T) };
}

/**
 * resolve 用：generated（且没被人调过高度 / 没被人接管）的空间按规则重算 floor_y；删掉引用了不存在空间的连接点；
 * generated 且没被拖过（user_moved）的连接点按当前主路重新选位置；其余连接点只重算两端高度。原地修改。
 * @returns {object} sid
 */
export function refreshSpaces(sid, T) {
  sid.spaces = (Array.isArray(sid.spaces) ? sid.spaces : []).filter(isSpace);
  for (const s of sid.spaces) if (s.generated && !s.user_set && !s.user_height) s.floor_y = fitFloor(s, T);
  const byId = new Map(sid.spaces.map((s) => [s.id, s]));
  const okEnd = (e) => e === "ground" || byId.has(e);
  sid.markers = (sid.markers || []).filter((m) => !m || m.kind !== "connector" || (okEnd(m.from) && okEnd(m.to) && m.from !== m.to));
  sid.markers = sid.markers.map((m) => {
    if (!m || m.kind !== "connector") return m;
    const sp = byId.get(m.to) || byId.get(m.from);
    if (m.generated && !m.user_moved && sp && (m.from === "ground" || m.to === "ground")) {
      const n = connectorFor(sp, sid, T, m.id === "conn_" + sp.id ? 0 : 1);
      return Object.assign({}, m, { position: n.position, top_y: n.top_y, bottom_y: n.bottom_y });
    }
    return connectorHeights(m, sid, T);
  });
  return sid;
}

// ------------------------------------------------------------ 检查
/**
 * 多层空间的检查（追加到关系检查之后；没有空间时返回 []）。格式同 relations.js 的 Check。
 * spaces_connected：从地面出发沿连接点（无向）能到达每个空间；fixes「补一个连接点」「不重要」。
 * spaces_clear_of_terrain：地下顶板在整个多边形内低于地面 ≥ 2 m、空中板底高于地面 ≥ 3 m；fixes「下移 / 上移到合格高度」「不重要」。
 * @returns {object[]} Check[]
 */
export function spaceChecks(sid, T) {
  const spaces = (sid.spaces || []).filter(isSpace);
  if (!spaces.length) return [];
  const ignored = new Set((sid.meta && sid.meta.ignored_checks) || []);
  const ignoreFix = (id) => ({ label: "不重要", patch(s) { s.meta = s.meta || {}; const arr = (s.meta.ignored_checks = s.meta.ignored_checks || []); if (!arr.includes(id)) arr.push(id); } });
  const mk = (id, text, ok, detail, severity, fixes) => Object.assign({ id, text, ok, detail, severity, fixes }, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {});
  const name = (s) => s.label || s.id;
  const out = [];

  const conns = (sid.markers || []).filter((m) => m && m.kind === "connector");
  const reached = new Set(["ground"]);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of conns) for (const [a, b] of [[c.from, c.to], [c.to, c.from]]) if (reached.has(a) && !reached.has(b)) { reached.add(b); changed = true; }
  }
  const lonely = spaces.filter((s) => !reached.has(s.id));
  out.push(mk("spaces_connected", "每个空间 都连到地面", !lonely.length, lonely.length ? lonely.map((s) => `${name(s)} 没有连接点通到地面`).join("、") : `${spaces.length} 个空间都连通`, "warn",
    lonely.length ? [{ label: "补一个连接点", patch(s) {
      s.markers = s.markers || [];
      for (const sp of lonely) {
        const o = (s.spaces || []).find((x) => x.id === sp.id);
        if (!o) continue;
        const c = connectorFor(o, s, T);
        for (let n = 2; s.markers.some((m) => m && m.id === c.id); n++) c.id = `conn_${o.id}_${n}`;
        s.markers.push(c);
      }
    } }, ignoreFix("spaces_connected")] : []));

  const bad = spaces.map((s) => ({ s, c: spaceClearance(s, T) })).filter((x) => !x.c.ok);
  const under = bad.filter((x) => x.s.stratum === "underground").length, sky = bad.length - under;
  out.push(mk("spaces_clear_of_terrain", "空间 不穿地形", !bad.length,
    bad.length ? bad.map(({ s, c }) => `${name(s)} ${s.stratum === "underground" ? "顶板离地面" : "板底离地面"} ${c.gap} m（需 ≥ ${c.need} m）`).join("、") : `${spaces.length} 个空间与地形都留够了距离`, "error",
    bad.length ? [{ label: !sky ? "下移到合格高度" : !under ? "上移到合格高度" : "移到合格高度", patch(s) {
      for (const { s: sp, c } of bad) { const o = (s.spaces || []).find((x) => x.id === sp.id); if (o) o.floor_y = c.limit; }
    } }, ignoreFix("spaces_clear_of_terrain")] : []));
  return out;
}

/** 每层空间数量（给 facts） */
export function spaceFacts(sid) {
  const spaces = (sid.spaces || []).filter(isSpace);
  return { total: spaces.length, underground: spaces.filter((s) => s.stratum === "underground").length, sky: spaces.filter((s) => s.stratum === "sky").length, connectors: (sid.markers || []).filter((m) => m && m.kind === "connector").length };
}
