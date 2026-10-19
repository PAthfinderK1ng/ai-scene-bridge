// routing.js — 路由：A* 山径、之字构造、溪流、路径事实、折线简化
// 约定见 SPEC.md 第 0 节与第 3 节。纯函数、确定性（随机只来自 opts.seed）。
// 依赖 terrain.js 的几何小工具（不修改它）。
import { pointInPolygon, distToPolygon, distToSegment, clamp, r2, rng } from "./terrain.js";

const SQRT2 = Math.SQRT2;
/** 8 邻域方向（先直后斜，顺序固定以保证确定性） */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/** 横向分量小于此值（米）的段不参与「折返」计数，避免栅格抖动被当成折 */
const FOLD_DEADZONE = 0.5;
/** 之字自动加折的上限 */
const MAX_AUTO_FOLDS = 12;

// ------------------------------------------------------------ 小工具
const dist2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const zero = () => ({ length_m: 0, climb_m: 0, descent_m: 0, folds: 0, max_slope: 0, max_local_slope: 0, steep_length_m: 0, steps_estimate: 0, segments: [] });
/** 「局部坡度」采样步长（米）与超坡阈值：台地墙 3 m 高 / 2.4 m 坡裙的真实坡度要在 1 m 口径下才看得见 */
const LOCAL_STEP = 1, STEEP_SLOPE = 0.7;

/** 点到线段 ab 的垂距（简化用） */
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-12) return dist2(p, a);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** 沿线段每 step 米采样是否有点落进任一多边形（含两端之间，不含端点本身） */
function segmentHitsPolys(a, b, polys, step = 1) {
  if (!polys || !polys.length) return false;
  const L = dist2(a, b), n = Math.max(1, Math.ceil(L / step));
  for (let k = 1; k < n; k++) {
    const t = k / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (const poly of polys) if (pointInPolygon(p, poly)) return true;
  }
  return false;
}

// ------------------------------------------------------------ 简化
/**
 * Douglas–Peucker 折线简化。首尾点原样保留。
 * @param {number[][]} points [[x,z],...]
 * @param {number} tolerance_m 允许的最大垂距（米）
 * @param {(a:number[], b:number[]) => boolean} [segOk] 可选：某段是否可接受（例如不穿过禁行区）；不可接受时强制在最远点处再分
 * @returns {number[][]} 简化后的折线（点对象与输入共享引用）
 */
export function simplify(points, tolerance_m = 1, segOk) {
  if (!points || points.length <= 2) return points ? points.slice() : [];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    let far = -1, dmax = -1;
    for (let i = i0 + 1; i < i1; i++) { const d = perpDist(points[i], points[i0], points[i1]); if (d > dmax) { dmax = d; far = i; } }
    const bad = segOk && !segOk(points[i0], points[i1]);
    if (dmax > tolerance_m || bad) {
      if (bad && dmax < 1e-9) far = (i0 + i1) >> 1; // 全部共线但段不可接受：从中点分
      keep[far] = 1;
      stack.push([i0, far], [far, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** 逐步放大容差直到点数 ≤ maxPts */
function simplifyToMax(points, maxPts, tol0 = 0.75, segOk) {
  let tol = tol0, out = simplify(points, tol, segOk);
  for (let k = 0; out.length > maxPts && k < 40; k++) { tol *= 1.4; out = simplify(points, tol, segOk); }
  return out;
}

// ------------------------------------------------------------ 路径事实
/**
 * 折线的事实：长度、爬升/下降、折返数、最大段坡度、局部坡度、台阶估算、逐段明细。
 * - max_slope 按「段」算：|两端高差| / 段长（与 A* 的可走判定同一口径，2 m 格点上 ≤ maxSlope 即达标）。
 * - max_local_slope 沿折线每 1 m 采样（T.sampleProfile）相邻样点的 |Δh| / Δd：这是脚下真实的陡度，
 *   台地墙（3 m 台阶 / 2.4 m 坡裙 ≈ 1.25）在这里才看得见；steep_length_m 为局部坡度 > 0.7 的累计长度（米）。
 *   没有 T 时两者为 0。
 * folds = 行进方向横向分量（相对首→尾主方向）变号的次数，横向分量 < 0.5 m 的段忽略。
 * @param {number[][]} points [[x,z],...]
 * @param {object} [T] buildTerrain 结果（缺省则高度全 0）
 * @returns {{length_m:number, climb_m:number, descent_m:number, folds:number, max_slope:number, max_local_slope:number, steep_length_m:number, steps_estimate:number, segments:{from:number[],to:number[],length:number,rise:number,slope:number}[]}}
 */
export function pathFacts(points, T) {
  if (!points || points.length < 2) return zero();
  const local = localSlopeFacts(points, T);
  const hAt = T ? (p) => T.heightAt(p[0], p[1]) : () => 0;
  const first = points[0], last = points[points.length - 1];
  const D = dist2(first, last);
  const u = D > 1e-9 ? [(last[0] - first[0]) / D, (last[1] - first[1]) / D] : [0, -1];
  let len = 0, climb = 0, desc = 0, maxS = 0, folds = 0, lastSign = 0;
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const L = dist2(a, b);
    if (L < 1e-9) continue;
    const rise = hAt(b) - hAt(a), slope = Math.abs(rise) / L;
    len += L; if (rise > 0) climb += rise; else desc -= rise; maxS = Math.max(maxS, slope);
    const lateral = u[0] * (b[1] - a[1]) - u[1] * (b[0] - a[0]);
    if (Math.abs(lateral) >= FOLD_DEADZONE) { const s = lateral > 0 ? 1 : -1; if (lastSign && s !== lastSign) folds++; lastSign = s; }
    segments.push({ from: a, to: b, length: r2(L), rise: r2(rise), slope: r2(slope) });
  }
  return { length_m: r2(len), climb_m: r2(climb), descent_m: r2(desc), folds, max_slope: r2(maxS), max_local_slope: local.max, steep_length_m: local.steep, steps_estimate: Math.round(climb / 0.17), segments };
}

/** 1 m 口径的局部坡度：{ max: 最大局部坡度, steep: 局部坡度 > STEEP_SLOPE 的累计长度（米）} */
function localSlopeFacts(points, T) {
  if (!T || typeof T.sampleProfile !== "function") return { max: 0, steep: 0 };
  const prof = T.sampleProfile(points, LOCAL_STEP);
  let max = 0, steep = 0;
  for (let i = 1; i < prof.length; i++) {
    const dd = prof[i].d - prof[i - 1].d;
    if (dd < 1e-9) continue;
    const s = Math.abs(prof[i].h - prof[i - 1].h) / dd;
    if (s > max) max = s;
    if (s > STEEP_SLOPE) steep += dd;
  }
  return { max: r2(max), steep: r2(steep) };
}

// ------------------------------------------------------------ A* 山径
/**
 * 构造 A* 格点：节点取 res 米网格的「单元中心」。双线性采样在单元中心对台阶做了一次平均，
 * 避免格点正好落在陡坎上造成 2 m 分辨率下的伪不可达；相邻中心高差 ≤ 台阶高的一半。
 */
function makeLattice(T, res) {
  const nx = Math.max(2, Math.round((T.xmax - T.xmin) / res)), nz = Math.max(2, Math.round((T.zmax - T.zmin) / res));
  const h = new Float64Array(nx * nz);
  const X = (i) => T.xmin + (i + 0.5) * res, Z = (j) => T.zmin + (j + 0.5) * res;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = T.heightAt(X(i), Z(j));
  const nearest = (p) => clamp(Math.round((p[1] - T.zmin) / res - 0.5), 0, nz - 1) * nx + clamp(Math.round((p[0] - T.xmin) / res - 0.5), 0, nx - 1);
  return { nx, nz, res, h, X, Z, nearest, world: (idx) => [X(idx % nx), Z((idx / nx) | 0)] };
}

/** 极简二叉堆（按 f 升序；f 相同按插入序，保证确定性） */
function makeHeap() {
  const f = [], v = [], seq = [];
  let n = 0, counter = 0;
  const less = (a, b) => f[a] < f[b] || (f[a] === f[b] && seq[a] < seq[b]);
  const swap = (a, b) => { [f[a], f[b]] = [f[b], f[a]]; [v[a], v[b]] = [v[b], v[a]]; [seq[a], seq[b]] = [seq[b], seq[a]]; };
  return {
    get size() { return n; },
    push(key, val) { f[n] = key; v[n] = val; seq[n] = counter++; let i = n++; while (i > 0) { const p = (i - 1) >> 1; if (less(i, p)) { swap(i, p); i = p; } else break; } },
    pop() { const out = v[0]; n--; if (n > 0) { f[0] = f[n]; v[0] = v[n]; seq[0] = seq[n]; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && less(l, m)) m = l; if (r < n && less(r, m)) m = r; if (m === i) break; swap(i, m); i = m; } } return out; },
  };
}

/** 在格点上跑 A*；返回节点索引路径或 null */
function astar(L, blocked, start, goal, maxSlope, noise) {
  const { nx, nz, res, h } = L, N = nx * nz;
  const g = new Float64Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const gx = goal % nx, gz = (goal / nx) | 0;
  const heur = (idx) => Math.hypot((idx % nx) - gx, ((idx / nx) | 0) - gz) * res;
  const heap = makeHeap();
  g[start] = 0; heap.push(heur(start), start);
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1; expanded++;
    if (cur === goal) break;
    const ci = cur % nx, cj = (cur / nx) | 0;
    for (const [di, dj] of DIRS) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const nidx = nj * nx + ni;
      if (closed[nidx] || blocked[nidx]) continue;
      const diag = di !== 0 && dj !== 0;
      if (diag && (blocked[cj * nx + ni] || blocked[nj * nx + ci])) continue; // 不许从禁行区夹角斜穿
      const len = res * (diag ? SQRT2 : 1), slope = Math.abs(h[nidx] - h[cur]) / len;
      if (slope > maxSlope) continue;
      const ng = g[cur] + len * (1 + 3 * slope) + (noise ? noise[nidx] : 0);
      if (ng < g[nidx] - 1e-12) { g[nidx] = ng; parent[nidx] = cur; heap.push(ng + heur(nidx), nidx); }
    }
  }
  if (!closed[goal]) return { path: null, expanded };
  const path = [];
  for (let c = goal; c !== -1; c = parent[c]) path.push(c);
  path.reverse();
  return { path, expanded };
}

/**
 * A* 山径：res 米格点、8 邻域；一步的坡度 = |高差| / 步长，> maxSlope 不可走；avoidPolys 内不可走；
 * 代价 = 距离 × (1 + 3 × 坡度)。结果简化到 ≤ 24 点，首尾精确等于 from / to。
 * @param {object} T buildTerrain 结果
 * @param {number[]} from [x,z]
 * @param {number[]} to [x,z]
 * @param {{maxSlope?:number, res?:number, avoidPolys?:number[][][], seed?:number, maxPoints?:number, wet?:object[]}} [opts]
 *   seed 只用于给节点代价加 ≤ 2% 步长的确定性抖动（打破平局、让不同 seed 的路略有差别）；
 *   wet 溪（paths kind=river）：溪面 + 1 m 内每个格点加 3 步长的代价——要过溪就直着过一次（一座桥），不顺着溪床走
 * @returns {{points:number[][]|null, facts:object, raw?:number[][]}} 不可达时 points 为 null、facts.reason 说明原因；raw 为未简化的格点路径
 */
export function routeTrail(T, from, to, opts = {}) {
  const maxSlope = opts.maxSlope ?? 0.7, res = opts.res || 2, avoid = opts.avoidPolys || [], maxPoints = opts.maxPoints || 24;
  const fail = (reason, extra = {}) => ({ points: null, facts: Object.assign(zero(), { reason }, extra) });
  if (!T || !from || !to) return fail("参数缺失");
  if (!T.inside(from[0], from[1]) || !T.inside(to[0], to[1])) return fail("起点或终点在场景范围外");
  for (const poly of avoid) if (pointInPolygon(to, poly)) return fail("终点在禁行区内");
  if (dist2(from, to) < 1e-9) return { points: [from.slice(), to.slice()], facts: pathFacts([from, to], T), raw: [from.slice()] };

  const L = makeLattice(T, res);
  const N = L.nx * L.nz;
  const blocked = new Uint8Array(N);
  if (avoid.length) for (let idx = 0; idx < N; idx++) { const p = L.world(idx); for (const poly of avoid) if (pointInPolygon(p, poly)) { blocked[idx] = 1; break; } }
  let noise = null;
  if (typeof opts.seed === "number") { const rand = rng(opts.seed); noise = new Float64Array(N); for (let i = 0; i < N; i++) noise[i] = rand() * 0.02 * res; }
  const wet = (opts.wet || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  if (wet.length) {
    noise = noise || new Float64Array(N);
    for (let idx = 0; idx < N; idx++) {
      const q = L.world(idx);
      for (const p of wet) { const w = (p.width || 4) / 2 + 1; let hit = false; for (let k = 0; k < p.points.length - 1 && !hit; k++) hit = distToSegment(q, p.points[k], p.points[k + 1]) <= w; if (hit) { noise[idx] += 3 * res; break; } }
    }
  }

  const start = L.nearest(from), goal = L.nearest(to);
  if (blocked[goal]) return fail("终点最近的格点在禁行区内");
  blocked[start] = 0; // 允许从禁行区边缘走出来（出生点贴着房子等情形）
  const { path, expanded } = astar(L, blocked, start, goal, maxSlope, noise);
  if (!path) return fail(`在坡度 ≤ ${maxSlope} 的限制下不可达`, { expanded });

  const raw = path.map(L.world);
  raw[0] = from.slice(); raw[raw.length - 1] = to.slice();
  const segOk = avoid.length ? (a, b) => !segmentHitsPolys(a, b, avoid, Math.min(1, res / 2)) : undefined;
  const points = simplifyToMax(raw, maxPoints, res * 0.4, segOk).map((p) => p.slice());
  const facts = pathFacts(points, T);
  facts.expanded = expanded; facts.raw_points = raw.length;
  return { points, facts, raw };
}

// ------------------------------------------------------------ 之字构造
/** 在横向 n 上，点 p 所在（或最近）台地的半宽与中心偏移；没有台地时回退 12 m */
function lateralSpan(T, p, n) {
  let terrace = T.terraceAt(p[0], p[1]);
  if (!terrace && T.terraces.length) { let bd = Infinity; for (const t of T.terraces) { const d = distToPolygon(p, t.polygon); if (d < bd && d <= 20) { bd = d; terrace = t; } } }
  if (!terrace) return { half: 12, centerOffset: 0 };
  let lo = Infinity, hi = -Infinity;
  for (const v of terrace.polygon) { const s = v[0] * n[0] + v[1] * n[1]; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const pProj = p[0] * n[0] + p[1] * n[1];
  return { half: (hi - lo) / 2, centerOffset: (lo + hi) / 2 - pProj };
}

/** 构造 folds 折的之字折线（不校验坡度） */
function buildZigzag(T, from, to, folds) {
  const D = dist2(from, to);
  if (D < 1e-9 || folds <= 0) return [from.slice(), to.slice()];
  const u = [(to[0] - from[0]) / D, (to[1] - from[1]) / D], n = [-u[1], u[0]];
  const pts = [from.slice()];
  for (let k = 1; k <= folds; k++) {
    const t = k / (folds + 1), base = [from[0] + u[0] * D * t, from[1] + u[1] * D * t];
    const { half, centerOffset } = lateralSpan(T, base, n);
    const off = centerOffset + (k % 2 ? 1 : -1) * 0.6 * half; // 横向摆幅 = 台地宽度 × 0.6，围绕台地中线
    const x = clamp(base[0] + n[0] * off, T.xmin + 1, T.xmax - 1), z = clamp(base[1] + n[1] * off, T.zmin + 1, T.zmax - 1);
    pts.push([r2(x), r2(z)]);
  }
  pts.push(to.slice());
  return pts;
}

/**
 * 之字山径（构造法）：沿 from→to 主方向分 folds+1 段，折点交替偏到横向两侧（摆幅 = 所在台地宽度 × 0.6），
 * 再按段校验坡度，超过 maxSlope 则自动加一折重建，最多加到 12 折。
 * @param {object} T buildTerrain 结果
 * @param {number[]} from [x,z]
 * @param {number[]} to [x,z]
 * @param {{folds?:number, maxSlope?:number}} [opts] folds = 0 为直上
 * @returns {{points:number[][], facts:object}} facts 另含 folds_requested / folds_added
 */
export function zigzagTrail(T, from, to, opts = {}) {
  const maxSlope = opts.maxSlope ?? 0.7;
  const requested = Math.max(0, Math.round(opts.folds ?? 0));
  let folds = requested;
  for (;;) {
    const points = buildZigzag(T, from, to, folds);
    const facts = pathFacts(points, T);
    if (facts.max_slope <= maxSlope + 1e-9 || folds >= MAX_AUTO_FOLDS) {
      facts.folds_requested = requested; facts.folds_added = folds - requested;
      return { points, facts };
    }
    folds++;
  }
}

// ------------------------------------------------------------ 溪流
/**
 * 把谷线上的一点挪到所在行「谷底平台」（高度 ≤ 行最低 + 0.3）的中央。
 * valleyLine 在平坦谷底里会贴着上一行不动，溪流就成了直线；居中后溪流能跟着谷底的蜿蜒走。
 */
function centerOnFloor(T, [x, z]) {
  const { xmin, zmin, res, nx, nz, h } = T.grid;
  const j = clamp(Math.round((z - zmin) / res), 0, nz - 1), i = clamp(Math.round((x - xmin) / res), 0, nx - 1);
  let rowMin = Infinity;
  for (let k = 0; k < nx; k++) rowMin = Math.min(rowMin, h[j * nx + k]);
  const th = rowMin + 0.3;
  if (h[j * nx + i] > th) return [x, z];
  let i0 = i, i1 = i;
  while (i0 > 0 && h[j * nx + i0 - 1] <= th) i0--;
  while (i1 < nx - 1 && h[j * nx + i1 + 1] <= th) i1++;
  return [xmin + ((i0 + i1) / 2) * res, z];
}

/**
 * 溪流中心线：沿 T.valleyLine() 自北向南（每点居中到该行谷底平台），简化到 ≤ 32 点，起终点推到 bounds 的北/南边缘。
 * @param {object} T buildTerrain 结果
 * @param {{min:number[], max:number[]}} [bounds] 缺省用 T 的范围
 * @returns {number[][]} [[x,z],...]
 */
export function routeStream(T, bounds) {
  const b = bounds || { min: [T.xmin, 0, T.zmin], max: [T.xmax, 0, T.zmax] };
  const v = T.valleyLine();
  if (!v || v.length < 2) return [];
  const centered = v.map((p) => centerOnFloor(T, p));
  // 3 点均值平滑一次，去掉栅格台阶感
  const smooth = centered.map((p, i) => { const a = centered[Math.max(0, i - 1)], c = centered[Math.min(centered.length - 1, i + 1)]; return [(a[0] + p[0] + c[0]) / 3, p[1]]; });
  const pts = simplifyToMax(smooth, 32, 1.0).map(([x, z]) => [r2(clamp(x, b.min[0], b.max[0])), r2(clamp(z, b.min[2], b.max[2]))]);
  pts[0] = [pts[0][0], b.min[2]];
  pts[pts.length - 1] = [pts[pts.length - 1][0], b.max[2]];
  return pts;
}

// ------------------------------------------------------------ 桥
/**
 * 路过溪的地方 = 桥：每条可走的路（非 river）与每条溪的线段交点。确定性：按路在 paths 里的顺序、沿路的先后。
 * @param {object[]} paths sid.paths
 * @returns {{path: string, at: number[], dir: number[], width: number}[]} at 交点 [x,z]；dir 路在那里的单位方向；width 溪宽
 */
export function pathCrossings(paths) {
  const ok = (p) => p && Array.isArray(p.points) && p.points.length >= 2;
  const rivers = (paths || []).filter((p) => ok(p) && p.kind === "river"), out = [];
  for (const p of (paths || []).filter((q) => ok(q) && q.kind !== "river")) for (let i = 0; i < p.points.length - 1; i++) {
    const a = p.points[i], b = p.points[i + 1];
    for (const rv of rivers) for (let j = 0; j < rv.points.length - 1; j++) {
      const c = rv.points[j], d = rv.points[j + 1];
      const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den, u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, at = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      if (out.some((o) => Math.hypot(o.at[0] - at[0], o.at[1] - at[1]) < 6)) continue; // 6 m 内算同一座桥（路沿溪走时会来回擦边）
      out.push({ path: p.id, at: [r2(at[0]), r2(at[1])], dir: [r2((b[0] - a[0]) / L), r2((b[1] - a[1]) / L)], width: rv.width || 4 });
    }
  }
  return out;
}
