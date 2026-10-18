// strokes.js — 笔画事实：把人手绘的一笔（像素 → 米的二维折线）变成结构化事实
// 约定见 SPEC.md 第 5 节。纯函数、确定性（无随机）。LLM 永远不看像素，只看这里产出的 facts。
//
// 依赖：terrain.js 的几何小工具（距离、面积、质心）。不修改 terrain。
import { r2, polygonArea, polygonCentroid, distToSegment, pointInPolygon } from "./terrain.js";

/** classifyStroke 的阈值（米 / 比例） */
export const TAP_MAX_LENGTH_M = 3;      // 长度 < 3 m 视为点选
export const LOOP_MIN_LENGTH_M = 20;    // 环至少 20 m 长
export const LOOP_CLOSE_RATIO = 0.08;   // 首尾距离 < 8% 长度视为闭合
const SAMPLE_STEP_M = 2;                // 沿折线采样层号 / 坡度的步长

// ------------------------------------------------------------ 基础几何
/** 折线总长度（米） */
export function polylineLength(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return L;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 两线段 ab、cd 是否相交（含端点相触） */
function segmentsIntersect(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  if (d1 === 0 && on(c, d, a)) return true;
  if (d2 === 0 && on(c, d, b)) return true;
  if (d3 === 0 && on(a, b, c)) return true;
  if (d4 === 0 && on(a, b, d)) return true;
  return false;
}

/** 两条折线是否相交 */
export function polylinesIntersect(A, B) {
  if (!A || !B || A.length < 2 || B.length < 2) return false;
  for (let i = 0; i < A.length - 1; i++) for (let j = 0; j < B.length - 1; j++) if (segmentsIntersect(A[i], A[i + 1], B[j], B[j + 1])) return true;
  return false;
}

/** 点到折线的最近点（投影）与距离；折线只有 1 点时退化为该点 */
function nearestOnPolyline(p, pts) {
  if (!pts || !pts.length) return null;
  if (pts.length === 1) return { point: [pts[0][0], pts[0][1]], d: dist(p, pts[0]) };
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
    const q = [a[0] + t * dx, a[1] + t * dz];
    const d = dist(p, q);
    if (!best || d < best.d) best = { point: q, d };
  }
  return best;
}

// ------------------------------------------------------------ 简化（Douglas–Peucker）
/**
 * 给每个点算 Douglas–Peucker「重要度」：该点被选中时到基线的距离；两端为 +∞。
 * 迭代实现（栈），避免长笔画递归过深。重要度单调：容差 t 保留的点集 = 重要度 > t 的点，因此
 * simplify(tolerance) 与 simplifyTo(maxPoints) 共用一套排序，结果一致且确定。
 */
function dpImportance(points) {
  const n = points.length;
  const imp = new Float64Array(n);
  if (n === 0) return imp;
  imp[0] = Infinity; imp[n - 1] = Infinity;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    let bi = -1, bd = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e]);
      if (d > bd) { bd = d; bi = i; }
    }
    // 子区间的重要度不超过父区间（保证按容差筛选时拓扑一致）
    imp[bi] = Math.min(bd, imp[s], imp[e]);
    stack.push([s, bi], [bi, e]);
  }
  return imp;
}

/**
 * Douglas–Peucker 折线简化。
 * @param {number[][]} points [[x,z],...]
 * @param {number} tolerance_m 容差（米），到基线距离 ≤ 容差的点被丢弃
 * @returns {number[][]} 简化后的折线（首尾保留；≤ 2 点原样返回拷贝）
 */
export function simplify(points, tolerance_m = 1) {
  if (!points || points.length <= 2) return (points || []).map((p) => [p[0], p[1]]);
  const imp = dpImportance(points);
  const out = [];
  for (let i = 0; i < points.length; i++) if (imp[i] > tolerance_m) out.push([points[i][0], points[i][1]]);
  return out;
}

/**
 * 自适应容差简化：保留重要度最高的点，使点数 ≤ maxPoints（首尾一定保留）。
 * @param {number[][]} points
 * @param {number} maxPoints 目标点数上限（≥ 2）
 * @returns {number[][]}
 */
export function simplifyTo(points, maxPoints = 12) {
  const n = (points || []).length;
  const cap = Math.max(2, Math.round(maxPoints));
  if (n <= cap) return (points || []).map((p) => [p[0], p[1]]);
  const imp = dpImportance(points);
  // 按重要度降序、同重要度按下标升序取前 cap 个，再按原顺序输出
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => imp[b] - imp[a] || a - b).slice(0, cap).sort((a, b) => a - b);
  return idx.map((i) => [points[i][0], points[i][1]]);
}

// ------------------------------------------------------------ 分类
/**
 * 笔画分类。
 * @param {number[][]} points 原始笔画 [[x,z],...]（米）
 * @returns {"tap"|"line"|"loop"} tap：长度 < 3 m；loop：长度 > 20 m 且首尾距离 < 8% 长度；其余 line
 */
export function classifyStroke(points) {
  if (!points || points.length < 2) return "tap";
  const L = polylineLength(points);
  if (L < TAP_MAX_LENGTH_M) return "tap";
  if (L > LOOP_MIN_LENGTH_M && dist(points[0], points[points.length - 1]) < LOOP_CLOSE_RATIO * L) return "loop";
  return "line";
}

// ------------------------------------------------------------ 吸附与采样
/** 在 anchors 中找距 p ≤ snap 的最近锚点；并列时按 spawn > landmark > path > stream 的顺序 */
function snapPoint(p, anchors, snap) {
  if (!anchors || !(snap > 0)) return null;
  const cands = [];
  if (anchors.spawn) cands.push({ kind: "spawn", point: [anchors.spawn[0], anchors.spawn[1]], d: dist(p, anchors.spawn) });
  if (anchors.landmark) cands.push({ kind: "landmark", point: [anchors.landmark[0], anchors.landmark[1]], d: dist(p, anchors.landmark) });
  const np = nearestOnPolyline(p, anchors.pathPoints); if (np) cands.push({ kind: "path", point: np.point, d: np.d });
  const ns = nearestOnPolyline(p, anchors.streamPoints); if (ns) cands.push({ kind: "stream", point: ns.point, d: ns.d });
  let best = null;
  for (const c of cands) if (c.d <= snap && (!best || c.d < best.d)) best = c;
  return best;
}

/** 沿折线每 step 米采样（含两端）→ [[x,z],...] */
function samplePolyline(points, step = SAMPLE_STEP_M) {
  const out = [];
  if (!points.length) return out;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i], [x1, z1] = points[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]); }
  }
  const last = points[points.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

/** 沿折线采样得到层号序列（相邻去重）与最大坡度；无 T 时返回空 / 0 */
function terrainFacts(points, T) {
  if (!T || points.length === 0) return { levels: [], max_slope: 0 };
  const levels = [];
  let maxSlope = 0;
  for (const [x, z] of samplePolyline(points)) {
    const lv = T.levelAt(x, z);
    if (!levels.length || levels[levels.length - 1] !== lv) levels.push(lv);
    maxSlope = Math.max(maxSlope, T.slopeAt(x, z));
  }
  return { levels, max_slope: r2(maxSlope) };
}

// ------------------------------------------------------------ 主接口
/**
 * 一笔 → 路径折线 + 事实。简化到 ≤ maxPoints，起 / 终点距锚点 ≤ snap 米则精确替换为锚点坐标。
 * @param {number[][]} points 原始笔画 [[x,z],...]
 * @param {object} opts
 * @param {object} [opts.T] buildTerrain 的地形对象（用于 levels_crossed / max_slope）
 * @param {{spawn?:number[], landmark?:number[], pathPoints?:number[][], streamPoints?:number[][]}} [opts.anchors]
 * @param {number} [opts.snap=10] 吸附半径（米）
 * @param {number} [opts.maxPoints=12] 简化后的点数上限
 * @returns {{ points: number[][], facts: { n_points:number, length_m:number, start_snapped_to:string|null, end_snapped_to:string|null, levels_crossed:number[], crosses_stream:boolean, max_slope:number } }}
 */
export function strokeToPath(points, { T, anchors = {}, snap = 10, maxPoints = 12 } = {}) {
  const raw = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  let pts = simplifyTo(raw, maxPoints).map(([x, z]) => [r2(x), r2(z)]);
  let start_snapped_to = null, end_snapped_to = null;
  if (pts.length) {
    const s = snapPoint(pts[0], anchors, snap);
    if (s) { pts[0] = s.point; start_snapped_to = s.kind; }
    const e = snapPoint(pts[pts.length - 1], anchors, snap);
    if (e && pts.length > 1) { pts[pts.length - 1] = e.point; end_snapped_to = e.kind; }
  }
  const { levels, max_slope } = terrainFacts(pts, T);
  return {
    points: pts,
    facts: {
      n_points: pts.length,
      length_m: r2(polylineLength(pts)),
      start_snapped_to, end_snapped_to,
      levels_crossed: levels,
      crosses_stream: polylinesIntersect(pts, anchors.streamPoints),
      max_slope,
    },
  };
}

/**
 * 一笔（环）→ 俯视多边形。去掉回到起点的重复尾点，简化到 ≤ maxPoints（≥ 3），算面积 / 质心 / 触及层号。
 * @param {number[][]} points 原始笔画 [[x,z],...]
 * @param {object} opts
 * @param {object} [opts.T] 地形对象；无则 levels_touched 为 []
 * @param {number} [opts.maxPoints=10]
 * @returns {{ polygon: number[][], area_m2: number, levels_touched: number[], centroid: number[] }}
 */
export function strokeToPolygon(points, { T, maxPoints = 10 } = {}) {
  let raw = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (raw.length < 3) return { polygon: raw.map(([x, z]) => [r2(x), r2(z)]), area_m2: 0, levels_touched: [], centroid: raw.length ? polygonCentroid(raw).map(r2) : [0, 0] };
  // 闭合：把起点补到末尾作为 DP 的固定端，简化后再去掉这个重复端点
  const ring = raw.concat([raw[0]]);
  let simp = simplifyTo(ring, Math.max(4, Math.round(maxPoints) + 1));
  simp.pop();
  // 若末点与起点几乎重合（手绘回到原处），去掉末点避免退化边
  while (simp.length > 3 && dist(simp[simp.length - 1], simp[0]) < 0.5) simp.pop();
  const polygon = simp.map(([x, z]) => [r2(x), r2(z)]);
  const area_m2 = r2(polygonArea(polygon));
  const centroid = polygonCentroid(polygon).map(r2);
  // 触及层号：边界每 2 m 采样 + 多边形内按地形网格采样，取唯一值升序
  const levels_touched = [];
  if (T) {
    const set = new Set();
    for (const [x, z] of samplePolyline(polygon.concat([polygon[0]]))) set.add(T.levelAt(x, z));
    const xs = polygon.map((p) => p[0]), zs = polygon.map((p) => p[1]);
    const step = Math.max(T.res || 2, 1);
    const x0 = Math.ceil(Math.min(...xs) / step) * step, x1 = Math.max(...xs), z0 = Math.ceil(Math.min(...zs) / step) * step, z1 = Math.max(...zs);
    for (let z = z0; z <= z1; z += step) for (let x = x0; x <= x1; x += step) if (pointInPolygon([x, z], polygon)) set.add(T.levelAt(x, z));
    levels_touched.push(...Array.from(set).sort((a, b) => a - b));
  }
  return { polygon, area_m2, levels_touched, centroid };
}
