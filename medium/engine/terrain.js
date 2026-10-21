// terrain.js — 地形：特征 → 高度函数、台地、等高线、谷线（v3 的三种原型生成器已挪到 tests/fixtures.js，只给测试造样例）
// plan v2（docs/06）：sid.terrain.sculpt = true 时特征按顺序雕刻（add / set / max / min / quant 合成 × 遮罩），平顶与台阶化的面登记成台地。
// 约定见 SPEC.md 第 0–1 节。纯函数，确定性。

export const DEFAULT_LAYER_M = 3;
export const DEFAULT_BOUNDS = { min: [-60, 0, -60], max: [60, 40, 60] };

// ------------------------------------------------------------ 小工具
export function rng(seed) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const r2 = (v) => Math.round(v * 100) / 100;

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}
export function distToPolygon(p, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]));
  return d;
}
export function distToPolyline(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distToSegment(p, pts[i], pts[i + 1]));
  return d;
}
export function polygonCentroid(poly) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cz += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [cx / (3 * a), cz / (3 * a)];
}
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}
export function polygonRadius(poly, c = polygonCentroid(poly)) { return Math.max(...poly.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))); }
/** 多边形内缩（按质心缩放的近似，适合凸或接近凸的台地） */
export function insetPolygon(poly, d) {
  const c = polygonCentroid(poly), R = polygonRadius(poly, c);
  const k = Math.max(0, 1 - d / Math.max(R, 1e-6));
  return poly.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
}

// ------------------------------------------------------------ 特征与高度
export function normalizeFeature(f, layer = DEFAULT_LAYER_M) {
  const out = Object.assign({}, f);
  if (out.polygon && out.polygon.length >= 3) {
    const c = polygonCentroid(out.polygon);
    out.center = [c[0], 0, c[1]];
    out.radius = r2(polygonRadius(out.polygon, c));
  }
  if (typeof out.level === "number" && !(typeof out.height === "number")) out.height = out.level * layer;
  if (!(typeof out.height === "number")) out.height = 0;
  if (!(typeof out.skirt === "number")) out.skirt = clamp(Math.abs(out.height) * 0.8, 2, 10);
  if (!out.kind) out.kind = out.polygon ? "plateau" : "hill";
  return out;
}
/** 有 polygon 时按「平顶 + 坡裙」算的特征种类（valley / basin / pit 是负的平底） */
const POLY_KINDS = new Set(["plateau", "ridge", "cliff", "valley", "basin", "pit"]);
export function featureContribution(f, x, z) {
  const k = f.kind;
  if (POLY_KINDS.has(k) && f.polygon) {
    if (pointInPolygon([x, z], f.polygon)) return f.height;
    const d = distToPolygon([x, z], f.polygon);
    return f.height * Math.max(0, 1 - d / f.skirt);
  }
  // 穹顶（hill / pit / 无 polygon 的 ridge / plateau）；带 rx / rz（+ angle 弧度，长轴方向）时是椭圆穹顶
  if (f.rx > 0 && f.rz > 0) {
    const dx = x - f.center[0], dz = z - f.center[2], c = Math.cos(f.angle || 0), s = Math.sin(f.angle || 0);
    const u = (dx * c + dz * s) / f.rx, v = (-dx * s + dz * c) / f.rz;
    return f.height * Math.max(0, 1 - (u * u + v * v));
  }
  const R = Math.max(f.radius || 1, 0.5);
  const r = Math.hypot(x - f.center[0], z - f.center[2]);
  if (k === "plateau") return r <= R ? f.height : f.height * Math.max(0, 1 - (r - R) / f.skirt);
  return f.height * Math.max(0, 1 - (r / R) ** 2);
}
/**
 * 叠加规则：正特征取最大、负特征相加。带 override 的平顶特征（plan 的台地 / 平台 / 崖）按顺序「压上去」：
 * 点落在它的多边形内时，之前的叠加作废、高度就是它的 height；之后的特征照常叠加（后面的谷可以再切进去）。
 */
export function heightFromFeatures(feats, base, x, z) {
  let pos = 0, neg = 0;
  for (const f of feats) {
    if (f.override && f.polygon && pointInPolygon([x, z], f.polygon)) { pos = Math.max(0, f.height); neg = Math.min(0, f.height); continue; }
    const c = featureContribution(f, x, z);
    if (c >= 0) pos = Math.max(pos, c); else neg += c;
  }
  return base + pos + neg;
}

// ------------------------------------------------------------ 雕刻（plan v2 的地形操作，docs/06 §2.2）
// sid.terrain.sculpt = true 时，features 按顺序作用在高度上（不再是「正取最大、负相加」）：
//   每个带 op 的特征 = 遮罩（mask: poly / line / all，edge: slope|cliff|terraced|round，skirt 边坡宽）× 合成（blend）：
//   add 相加（amount 或 wave 起伏）、set 覆盖（target 或 ramp 坡道）、max 抬到、min 压到、quant 台阶化（step / base）。
//   不带 op 的旧特征（生成器的台地 plateau override 等）照旧：落在多边形里 = 它的高度，外面按坡裙取较大者。
//   register: "top"（平顶 / 削平面）/ "quant"（台阶化的各级）→ 建好高度场后登记成台地（T.terraces，凸包多边形）。
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
function hash2(ix, iz, seed) { let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
/** 种子化值噪声（0..1），双线性 + smoothstep */
export function valueNoise(x, z, seed = 1) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth01(x - ix), fz = smooth01(z - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}
/** 起伏函数（noise：±amp；dune：0..amp 的沙丘脊，沿 dir 排列） */
function waveAt(w, x, z) {
  const s = w.scale || 30;
  if (w.kind === "dune") {
    const d = w.dir || [1, 0], u = (x * d[0] + z * d[1]) / s, warp = valueNoise(x / (s * 1.3), z / (s * 1.3), w.seed) * 2.2;
    const v = (Math.sin(2 * Math.PI * u + warp) + 1) / 2;
    return w.amp * Math.pow(v, 1.6) * (0.75 + 0.5 * valueNoise(x / (s * 2.5), z / (s * 2.5), w.seed + 7));
  }
  const n = valueNoise(x / s, z / s, w.seed) * 0.7 + valueNoise((x * 2.1) / s, (z * 2.1) / s, w.seed + 11) * 0.3;
  return w.amp * (n * 2 - 1);
}
const BBS = new WeakMap();
/** 一个雕刻特征在 (x, z) 的遮罩权重 0..1 */
export function maskWeight(f, x, z) {
  if (f.mask === "all" || (!f.polygon && !f.line)) return 1;
  let bb = BBS.get(f); if (!bb) { bb = sculptBBox(f); BBS.set(f, bb); }
  if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) return 0;
  let inside, d;
  if (f.line) { const dl = distToPolyline([x, z], f.line); inside = dl <= (f.half || 0); d = Math.abs(dl - (f.half || 0)); }
  else {
    inside = pointInPolygon([x, z], f.polygon) && !(f.hole && pointInPolygon([x, z], f.hole));
    d = distToPolygon([x, z], f.polygon);
    if (f.hole) d = Math.min(d, distToPolygon([x, z], f.hole));
  }
  const sk = Math.max(0.01, f.skirt || 0.01);
  if (inside) return f.edge === "round" ? smooth01(d / sk) : 1;
  if (f.edge === "round") return 0;
  const t = 1 - d / sk;
  if (t <= 0) return 0;
  if (f.edge === "cliff") return t;
  if (f.edge === "terraced") { const n = Math.max(1, f.steps || 3); return Math.floor(t * n + 1e-9) / n; }
  return smooth01(t);
}
function sculptBBox(f) {
  const pts = f.line || f.polygon, pad = (f.skirt || 0) + (f.half || 0) + 0.5;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}
/** 一个特征作用在高度 h 上（雕刻模式） */
export function applySculpt(f, h, x, z) {
  if (!f.op) {
    // 旧式特征：override 平顶（生成器的台地）落在多边形里就是它；外面 / 其它特征按贡献取大（负的相加）
    if (f.override && f.polygon && pointInPolygon([x, z], f.polygon)) return f.height;
    const c = featureContribution(f, x, z);
    return c >= 0 ? Math.max(h, c) : h + c;
  }
  const w = maskWeight(f, x, z);
  if (w <= 0) return h;
  let tgt = f.target;
  if (f.ramp) { const { a, b, ya, yb } = f.ramp, dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9; tgt = ya + (yb - ya) * clamp(((x - a[0]) * dx + (z - a[1]) * dz) / L2, 0, 1); }
  switch (f.blend) {
    case "add": return h + (f.wave ? waveAt(f.wave, x, z) : f.amount || 0) * w;
    case "set": return h + (tgt - h) * w;
    case "max": return Math.max(h, h + (tgt - h) * w);
    case "min": return Math.min(h, h + (tgt - h) * w);
    case "quant": { const st = f.step || 3, b0 = f.base || 0, q = b0 + Math.floor((h - b0) / st + 1e-6) * st; return h + (q - h) * w; }
    default: return h;
  }
}
/** 雕刻模式的高度：基准面 + 特征按顺序作用 */
export function sculptHeight(feats, base, x, z) { let h = base; for (const f of feats) h = applySculpt(f, h, x, z); return h; }
/** 平面点集的凸包（单调链），逆时针 */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** 雕刻特征登记的台地：按格点取遮罩内的平顶 / 各级，每组取凸包（外扩半格，≤ 32 点） */
function sculptTerraces(feats, grid, layer) {
  const { xmin, zmin, res, nx, nz, h } = grid, out = [];
  feats.forEach((f, order) => {
    if (!f.op || !f.register) return;
    const bb = f.mask === "all" || (!f.polygon && !f.line) ? [xmin, zmin, xmin + (nx - 1) * res, zmin + (nz - 1) * res] : sculptBBox(f);
    const i0 = clamp(Math.floor((bb[0] - xmin) / res), 0, nx - 1), i1 = clamp(Math.ceil((bb[2] - xmin) / res), 0, nx - 1);
    const j0 = clamp(Math.floor((bb[1] - zmin) / res), 0, nz - 1), j1 = clamp(Math.ceil((bb[3] - zmin) / res), 0, nz - 1);
    const groups = new Map(), st = f.reg_step || layer, b0 = f.reg_base ?? 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = xmin + i * res, z = zmin + j * res, w = maskWeight(f, x, z), hv = h[j * nx + i];
      let key;
      if (f.register === "top") { if (w < 0.999 || Math.abs(hv - f.target) > 0.35) continue; key = 0; }
      else { if (w <= 0) continue; key = Math.round((hv - b0) / st); if (Math.abs(hv - (b0 + key * st)) > 0.35) continue; }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([x, z]);
    }
    for (const [key, pts] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      if (pts.length < 6) continue;
      let poly = hull(pts);
      if (poly.length < 3) continue;
      const c = polygonCentroid(poly);
      poly = poly.map(([x, z]) => { const dx = x - c[0], dz = z - c[1], L = Math.hypot(dx, dz) || 1, k = (L + res * 0.5) / L; return [r2(c[0] + dx * k), r2(c[1] + dz * k)]; });
      if (poly.length > 32) { const step = poly.length / 32; poly = Array.from({ length: 32 }, (_, k) => poly[Math.floor(k * step)]); }
      if (polygonArea(poly) < 40) continue;
      const height = r2(f.register === "top" ? f.target : b0 + key * st);
      out.push({ id: f.register === "top" ? f.id : `${f.id}_${key < 0 ? "m" + -key : key}`, level: Math.round(height / layer), height, polygon: poly, centroid: polygonCentroid(poly), feature: { id: f.id, override: false, sculpt: true }, order, plan_id: f.plan_id || null, sculpt: true });
    }
  });
  return out;
}

// ------------------------------------------------------------ 层：按场景里实际的台地 / 平面分，不按 layer_height_m 切片（docs/07 §7；与 tools/score_readback.py Terrain._find_layers 同口径）
/** 层表的合并阈值（米）：高度差不到这个数的平面算同一层 */
export const LAYER_MERGE_M = 0.35;
/**
 * 高度场里的层（高度表，升序）：基准面 ∪ 旧式多边形特征（台地 / 谷 / 坑）质心处的实际高度 ∪ 真正平坦的面（四邻同高的格 ≥ 10 个 ≈ 40 m²，
 * 坡裙上整排同高的格不算），权重大的优先、LAYER_MERGE_M 内合并。
 * @param {{nx, nz, h}} grid 高度场 @param {number} base 基准面 @param {object[]} feats 特征 @param {(x, z) => number} heightAt
 * @returns {number[]}
 */
export function findLayers(grid, base, feats, heightAt) {
  const { nx, nz, h } = grid, counts = new Map(), key = (v) => Math.round(v * 100) / 100;
  for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i, v = h[k];
    if (Math.abs(h[k - 1] - v) < 0.01 && Math.abs(h[k + 1] - v) < 0.01 && Math.abs(h[k - nx] - v) < 0.01 && Math.abs(h[k + nx] - v) < 0.01) { const kk = key(v); counts.set(kk, (counts.get(kk) || 0) + 1); }
  }
  const big = h.length, cand = new Map([[key(base), big]]);
  for (const f of feats) if (!f.op && POLY_KINDS.has(f.kind) && Array.isArray(f.polygon) && f.polygon.length >= 3) { const c = polygonCentroid(f.polygon), hc = key(heightAt(c[0], c[1])); cand.set(hc, (cand.get(hc) || 0) + big); }
  for (const [k, n] of counts) if (n >= 10) cand.set(k, (cand.get(k) || 0) + n);
  const layers = [];
  for (const hgt of [...cand.keys()].sort((a, b) => cand.get(b) - cand.get(a) || a - b)) if (layers.every((L) => Math.abs(hgt - L) > LAYER_MERGE_M)) layers.push(hgt);
  return layers.sort((a, b) => a - b);
}
/** 人定的层表（sid.terrain.layers 里 source = "user" 的那些，升序、去重）；没有 → null（用引擎自动找的） */
export function userLayersOf(sid) {
  const src = sid && sid.terrain && Array.isArray(sid.terrain.layers) ? sid.terrain.layers : [];
  const ls = src.filter((l) => l && l.source === "user" && Number.isFinite(Number(l.height_m))).map((l) => ({ height_m: r2(Number(l.height_m)), label: l.label ? String(l.label) : undefined })).sort((a, b) => a.height_m - b.height_m);
  const out = ls.filter((l, i) => !i || l.height_m - ls[i - 1].height_m > 0.05);
  return out.length ? out : null;
}

// ------------------------------------------------------------ 地形对象
export function buildTerrain(sid, opts = {}) {
  const b = sid.bounds || DEFAULT_BOUNDS;
  const xmin = b.min[0], zmin = b.min[2], xmax = b.max[0], zmax = b.max[2];
  const res = opts.res || 2;
  const layer = Number(sid.meta && sid.meta.layer_height_m) || DEFAULT_LAYER_M;
  const base = (sid.terrain && sid.terrain.base_height) || 0;
  const sculpt = !!(sid.terrain && sid.terrain.sculpt);
  const feats = ((sid.terrain && sid.terrain.features) || []).map((f) => (sculpt && f.op ? Object.assign({}, f) : normalizeFeature(f, layer)));
  const nx = Math.ceil((xmax - xmin) / res) + 1, nz = Math.ceil((zmax - zmin) / res) + 1;
  const h = new Float32Array(nx * nz);
  const hf = sculpt ? sculptHeight : heightFromFeatures;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = hf(feats, base, xmin + i * res, zmin + j * res);

  const legacy = feats.map((f, order) => ({ f, order })).filter(({ f }) => !f.op && (f.kind === "plateau" || f.kind === "ridge") && f.polygon && (sculpt || f.height >= 0))
    .map(({ f, order }) => ({ id: f.id, level: typeof f.level === "number" ? f.level : Math.round((f.height - 0) / layer), height: f.height, polygon: f.polygon, centroid: polygonCentroid(f.polygon), feature: f, order, plan_id: f.plan_id || null }));
  const terraces = legacy.concat(sculpt ? sculptTerraces(feats, { xmin, zmin, res, nx, nz, h }, layer) : [])
    .sort((a, b2) => a.height - b2.height || a.id.localeCompare(b2.id))
    .map((t, i) => Object.assign(t, { index: i }));

  const T = {
    xmin, zmin, xmax, zmax, res, nx, nz, base, layer, features: feats, terraces, sculpt,
    grid: { xmin, zmin, res, nx, nz, h },
    inside(x, z) { return x >= xmin && x <= xmax && z >= zmin && z <= zmax; },
    heightAt(x, z) {
      const fx = clamp((x - xmin) / res, 0, nx - 1), fz = clamp((z - zmin) / res, 0, nz - 1);
      const i = Math.min(Math.floor(fx), nx - 2), j = Math.min(Math.floor(fz), nz - 2);
      const tx = fx - i, tz = fz - j;
      const h00 = h[j * nx + i], h10 = h[j * nx + i + 1], h01 = h[(j + 1) * nx + i], h11 = h[(j + 1) * nx + i + 1];
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    },
    gradientAt(x, z) {
      const d = res;
      return [(T.heightAt(x + d, z) - T.heightAt(x - d, z)) / (2 * d), (T.heightAt(x, z + d) - T.heightAt(x, z - d)) / (2 * d)];
    },
    slopeAt(x, z) { const g = T.gradientAt(x, z); return Math.hypot(g[0], g[1]); },
    /** 旧口径：round((h − base) / layer_height_m) 的切片号（布房 / 等高线 / 支路那类按米数分带的用途）；界面上的「层」用 layerAt */
    levelAt(x, z) { return Math.round((T.heightAt(x, z) - base) / layer); },
    // ---- 层（按实际台地分；出生点所在层为 0、往上 +1、往下 −1）：layers 高度表（升序）、layerTable 带 id / label / source、zero 出生点那层的下标
    layers: [], layerTable: [], zero: 0, zeroFrom: "base",
    /** 高度最近的层的下标（并列取低的那层） */
    layerIndexOf(h) { let bi = 0, bd = Infinity; for (let i = 0; i < T.layers.length; i++) { const d = Math.abs(h - T.layers[i]); if (d < bd) { bd = d; bi = i; } } return bi; },
    /** 高度 → 层号（相对出生点所在层） */
    layerNo(h) { return T.layerIndexOf(h) - T.zero; },
    /** (x, z) 处地面的层号 */
    layerAt(x, z) { return T.layerNo(T.heightAt(x, z)); },
    /** 层号 → 层表项（没有这一层 → null） */
    layerByNo(n) { return T.layerTable[n + T.zero] || null; },
    terraceAt(x, z) {
      // 重叠时：override 的（plan 里后压上去的）按顺序取最后一个，其余取最高
      let best = null, bk = -Infinity;
      for (const t of terraces) {
        if (!pointInPolygon([x, z], t.polygon)) continue;
        const k = t.feature.override ? 1e6 + t.order : t.height;
        if (k > bk) { bk = k; best = t; }
      }
      return best;
    },
    topTerrace() { return terraces.length ? terraces[terraces.length - 1] : null; },
    contours(step = layer) {
      const out = [];
      const maxH = Math.max(...h);
      for (let lv = 0; base + (lv + 0.5) * step <= maxH + 1e-6; lv++) out.push({ level: lv + 1, height: base + (lv + 0.5) * step, segments: marchingSquares(T, base + (lv + 0.5) * step) });
      return out;
    },
    valleyLine() {
      // 每行取最低点；多个并列最低（例如两侧都是基准面）时取离上一行最近的，起点取离中线最近的
      const pts = [];
      let prev = (nx - 1) / 2;
      for (let j = 0; j < nz; j++) {
        let bh = Infinity;
        for (let i = 0; i < nx; i++) bh = Math.min(bh, h[j * nx + i]);
        let bi = -1, bd = Infinity;
        for (let i = 0; i < nx; i++) if (h[j * nx + i] <= bh + 0.3) { const d = Math.abs(i - prev); if (d < bd) { bd = d; bi = i; } }
        prev = bi;
        pts.push([xmin + bi * res, zmin + j * res]);
      }
      // 平滑（3 点均值）
      return pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)]; return [(a[0] + p[0] + c[0]) / 3, p[1]]; });
    },
    sampleProfile(points, step = 1) {
      const out = [];
      let d = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const [x0, z0] = points[i], [x1, z1] = points[i + 1];
        const L = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.ceil(L / step));
        for (let k = 0; k < n; k++) { const t = k / n; const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t; out.push({ d: d + L * t, x, z, h: T.heightAt(x, z) }); }
        d += L;
      }
      const last = points[points.length - 1];
      if (last) out.push({ d, x: last[0], z: last[1], h: T.heightAt(last[0], last[1]) });
      return out;
    },
  };
  // 层表：人定的（plan.site.layers → sid.terrain.layers source = user）优先，否则从高度场找；0 层 = 人定（meta.layer_zero_from = user）> 出生点所在层 > 基准面
  const user = userLayersOf(sid);
  T.layers = user ? user.map((l) => l.height_m) : findLayers(T.grid, base, feats, T.heightAt);
  T.layerTable = T.layers.map((hgt, i) => Object.assign({ id: `L${i}`, height_m: r2(hgt), source: user ? "user" : "auto" }, user && user[i].label ? { label: user[i].label } : {}));
  const meta = sid.meta || {}, sp = (sid.markers || []).find((m) => m && m.kind === "player_spawn" && Array.isArray(m.position));
  if (meta.layer_zero_from === "user" && Number.isFinite(Number(meta.layer_zero))) { T.zero = T.layerIndexOf(Number(meta.layer_zero)); T.zeroFrom = "user"; }
  else if (sp) { T.zero = T.layerIndexOf(T.heightAt(sp.position[0], sp.position[2])); T.zeroFrom = "spawn"; }
  else { T.zero = T.layerIndexOf(base); T.zeroFrom = "base"; }
  for (let i = 0; i < T.layerTable.length; i++) T.layerTable[i].no = i - T.zero;
  return T;
}

function marchingSquares(T, iso) {
  const { nx, nz, xmin, zmin, res } = T;
  const h = T.grid.h;
  const segs = [];
  const lerp = (p1, p2, v1, v2) => { const t = (iso - v1) / ((v2 - v1) || 1e-9); return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]; };
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = h[j * nx + i], v1 = h[j * nx + i + 1], v2 = h[(j + 1) * nx + i + 1], v3 = h[(j + 1) * nx + i];
    const idx = (v0 >= iso ? 1 : 0) | (v1 >= iso ? 2 : 0) | (v2 >= iso ? 4 : 0) | (v3 >= iso ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const x0 = xmin + i * res, z0 = zmin + j * res, x1 = x0 + res, z1 = z0 + res;
    const p0 = [x0, z0], p1 = [x1, z0], p2 = [x1, z1], p3 = [x0, z1];
    const top = () => lerp(p0, p1, v0, v1), right = () => lerp(p1, p2, v1, v2), bottom = () => lerp(p3, p2, v3, v2), left = () => lerp(p0, p3, v0, v3);
    const add = (a, b) => segs.push([a, b]);
    switch (idx) {
      case 1: case 14: add(left(), top()); break;
      case 2: case 13: add(top(), right()); break;
      case 3: case 12: add(left(), right()); break;
      case 4: case 11: add(right(), bottom()); break;
      case 5: add(left(), top()); add(right(), bottom()); break;
      case 6: case 9: add(top(), bottom()); break;
      case 7: case 8: add(left(), bottom()); break;
      case 10: add(top(), right()); add(left(), bottom()); break;
      default: break;
    }
  }
  return segs;
}

// ------------------------------------------------------------ 台地带宽
/** 环台 / 溪谷的台地带宽下限（米）：8 m 够放一排房，bounds 放不下时退到 7 m */
export const MIN_BAND = 8, MIN_BAND_HARD = 7;

// ------------------------------------------------------------ plan v2 的场地基础形态与河道（runProgram 用）
const P2_ = (p) => [r2(p[0]), r2(p[1])];
function ellipsePoly(c, rx, rz, deg = 0, n = 24) { const t0 = deg * Math.PI / 180, cs = Math.cos(t0), sn = Math.sin(t0), out = []; for (let k = 0; k < n; k++) { const t = (2 * Math.PI * k) / n, x = rx * Math.cos(t), z = rz * Math.sin(t); out.push(P2_([c[0] + cs * x + sn * z, c[1] - sn * x + cs * z])); } return out; }
const GROUND_RELIEF = { flat: 0, rolling: 4, hills: 12, mountain: 28, canyon: 18, lake: 6, island: 6, coast: 5, desert: 3, cavern: 22, sky: 40 };
/**
 * 场地基础形态：返回特征（plan_id = "site"）、自动水面（海 / 湖）与是否「没有地面」。
 * @returns {{feats: object[], waters: object[], voidGround: boolean, autoLake: object|null}}
 */
export function groundFeatures(site, seed, taken) {
  const [W, D] = site.size_m, hw = W / 2, hd = D / 2, g = site.ground || "flat", R = site.relief_m ?? GROUND_RELIEF[g] ?? 0, m = Math.min(W, D);
  const feats = [], waters = [];
  const F = (id, o) => feats.push(Object.assign({ id, plan_id: "site", label: "基础地形", center: [0, 0, 0], radius: r2(Math.hypot(hw, hd)), height: 0 }, o));
  const all = { mask: "all" };
  const wave = (amp, scale, k) => ({ kind: "noise", amp, scale, seed: (131 + k) >>> 0 }); // 地形的起伏跟 plan 走，不跟布局种子走（换种子只换散布 / 布房）
  let autoLake = null;
  switch (g) {
    case "rolling": F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(R, 60, 1), height: R }, all)); break;
    case "hills": F("ground_hills", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(R, 48, 2), height: R }, all)); F("ground_bumps", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(R * 0.25, 16, 3), height: R * 0.25 }, all)); break;
    case "mountain": F("ground_mountain", { kind: "raise", op: "raise", blend: "add", amount: R, mask: "poly", polygon: ellipsePoly([0, 0], m * 0.46, m * 0.46), edge: "round", skirt: m * 0.4, radius: m * 0.46, height: R }); F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(1.5, 26, 4), height: 1.5 }, all)); break;
    case "canyon": F("ground_plateau", Object.assign({ kind: "raise", op: "raise", blend: "add", amount: R, height: R }, all)); F("ground_canyon", { kind: "carve", op: "carve", blend: "add", amount: -R, mask: "line", line: [[0, -hd - 4], [m * 0.04, -hd * 0.3], [-m * 0.04, hd * 0.3], [0, hd + 4]], half: m * 0.1, edge: "slope", skirt: 6, radius: hd, height: -R }); F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(1.2, 30, 5), height: 1.2 }, all)); break;
    case "lake": {
      const poly = ellipsePoly([0, 0], m * 0.34, m * 0.3);
      const id = taken.has("lake") ? "ground_lake" : "lake";
      F(id, { kind: "lake", op: "lake", blend: "min", target: -R, mask: "poly", polygon: poly, edge: "round", skirt: Math.min(m * 0.12, 14), radius: m * 0.34, height: -R });
      waters.push({ id, polygon: poly, surface_y: -0.4, label: "湖" });
      autoLake = { id, polygon: poly };
      break;
    }
    case "island": {
      F("ground_sea", Object.assign({ kind: "lower", op: "lower", blend: "add", amount: -R, height: -R }, all));
      const land = ellipsePoly([0, 0], m * 0.3, m * 0.27);
      F("ground_land", { kind: "raise", op: "raise", blend: "max", target: 2, mask: "poly", polygon: land, edge: "slope", skirt: 14, radius: m * 0.3, height: 2 });
      F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(0.8, 24, 6), height: 0.8 }, all));
      waters.push({ id: "sea", polygon: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]], hole: ellipsePoly([0, 0], m * 0.3 + 5, m * 0.27 + 5), surface_y: 0, label: "海" });
      break;
    }
    case "coast": {
      F("ground_sea", Object.assign({ kind: "lower", op: "lower", blend: "add", amount: -R, height: -R }, all));
      const z0 = hd * 0.15;
      F("ground_land", { kind: "raise", op: "raise", blend: "max", target: 3, mask: "poly", polygon: [[-hw - 10, -hd - 10], [hw + 10, -hd - 10], [hw + 10, z0], [-hw - 10, z0]], edge: "slope", skirt: 18, radius: hw, height: 3 });
      F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(0.8, 24, 7), height: 0.8 }, all));
      waters.push({ id: "sea", polygon: [[-hw, z0 + 9], [hw, z0 + 9], [hw, hd], [-hw, hd]], surface_y: 0, label: "海" });
      break;
    }
    case "desert": F("ground_dunes", Object.assign({ kind: "dune", op: "dune", blend: "add", wave: Object.assign(wave(R, 26, 8), { kind: "dune", dir: [0.8, 0.6] }), height: R }, all)); F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(1, 60, 9), height: 1 }, all)); break;
    case "cavern": {
      const outer = [[-hw - 6, -hd - 6], [hw + 6, -hd - 6], [hw + 6, hd + 6], [-hw - 6, hd + 6]], inner = ellipsePoly([0, 0], hw * 0.8, hd * 0.8, 0, 28);
      F("ground_walls", { kind: "raise", op: "raise", blend: "max", target: R, mask: "poly", polygon: outer, hole: inner, edge: "cliff", skirt: 3, radius: hw, height: R });
      F("ground_noise", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(1.2, 14, 10), height: 1.2 }, all));
      break;
    }
    case "sky": F("ground_void", Object.assign({ kind: "lower", op: "lower", blend: "add", amount: -R, height: -R }, all)); F("ground_clouds", Object.assign({ kind: "noise", op: "noise", blend: "add", wave: wave(3, 50, 11), height: 3 }, all)); break;
    default: break;
  }
  return { feats, waters, voidGround: g === "sky", autoLake };
}


/** 河：直线两端之间加种子化的蜿蜒 */
export function meander(line, seed) {
  const a = line[0], b = line[line.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n = Math.max(4, Math.round(L / 18)), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nn = [-u[1], u[0]];
  const rand = rng(seed >>> 0 || 1), ph = rand() * Math.PI * 2, amp = Math.min(14, L * 0.07), out = [];
  for (let k = 0; k <= n; k++) { const t = k / n, off = amp * Math.sin(t * Math.PI * 2 + ph) * Math.sin(t * Math.PI); out.push(P2_([a[0] + (b[0] - a[0]) * t + nn[0] * off, a[1] + (b[1] - a[1]) * t + nn[1] * off])); }
  return out;
}

// ============================================================ 台地生成器（v5f 第 3 轮从 program.js 挪来：program.js 超过 1200 行；v4 的坡上台地 / 环台算法）
const TS2 = Math.SQRT1_2;
const TDIRV = { C: [0, 0], N: [0, -1], NE: [TS2, -TS2], E: [1, 0], SE: [TS2, TS2], S: [0, 1], SW: [-TS2, TS2], W: [-1, 0], NW: [-TS2, -TS2] };
const tDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const tUnit = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? [0, 0] : [v[0] / L, v[1] / L]; };
const tAdd = (a, u, k = 1) => [a[0] + u[0] * k, a[1] + u[1] * k];
const tP2 = (p) => [r2(p[0]), r2(p[1])];
function tHash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
/** 多边形内离边最远的格点（同 layout.deepPoint；这里不 import layout，免得成环） */
function innerPoint(poly, step = 2) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  let best = null, bd = -1;
  for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) if (pointInPolygon([x, z], poly)) { const d = distToPolygon([x, z], poly); if (d > bd + 1e-9) { bd = d; best = [x, z]; } }
  return best || polygonCentroid(poly);
}
/** 台地生成器 → override 平台特征（坡上台地 / 环台，v4 算法；高度相对锚点处的地面，按级高取整） */
export function terraceFeatures(n, c, { hAt, layer, hw, hd, seed }) {
  const steps = n.steps || 4, st = n.step_h_m || layer, size = Array.isArray(n.size_m) ? n.size_m : [80, 80];
  const rand = rng(tHash(n.id) || 1), jit = (p, a) => tP2([p[0] + (rand() - 0.5) * 2 * a, p[1] + (rand() - 0.5) * 2 * a]);
  const feats = [];
  const flat = (k, poly, height, extra) => { const c = polygonCentroid(poly); feats.push(Object.assign({ id: `${n.id}_${k}`, plan_id: n.id, kind: "plateau", label: n.label || "台地", notes: "", polygon: poly, center: [r2(c[0]), 0, r2(c[1])], radius: r2(Math.max(...poly.map((q) => tDist(q, c)))), level: Math.round(height / layer), height: r2(height), skirt: clamp(st * 0.8, 2, 10), override: true, step: k }, extra || {})); };
  if (n.form === "ring") {
    const R = clamp(Math.min(size[0], size[1]) / 2, 12, Math.max(12, Math.min(hw - Math.abs(c[0]), hd - Math.abs(c[1])) - 2));
    let bw = n.width_m || Math.max(8, R / steps);
    if (R - (steps - 1) * bw < 5) bw = Math.max(4, (R - 5) / Math.max(1, steps - 1));
    const r0 = Math.max(3, R - (steps - 1) * bw), N = 12, base = Math.round(hAt(c[0] + R, c[1]) / st) * st;
    const circ = (r, rev) => { const pts = []; for (let k = 0; k <= N; k++) { const a = -Math.PI / 2 + ((rev ? -1 : 1) * 2 * Math.PI * k) / N; pts.push(tP2([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])); } return pts; };
    for (let k = 0; k < steps; k++) {
      const lv = n.inverse ? steps - k : k + 1, ro = R - k * bw, ri = R - (k + 1) * bw;
      const poly = k === steps - 1 ? circ(r0, false).slice(0, N).map((p) => jit(p, 0.4)) : [...circ(ro, false), ...circ(Math.max(ri, 2), true)].map((p, i) => (i % (N + 1) === 0 || i % (N + 1) === N ? p : jit(p, 0.4)));
      flat(k, poly, base + lv * st, { ring: true, label: `${n.label || "环台"} 第 ${k + 1} 圈` });
    }
    const outline = circ(R, false).slice(0, N), top = feats.reduce((m, f) => (f.height > m.height ? f : m));
    return { feats, outline, topPoint: tP2(n.inverse ? tAdd(c, [0, 1], R - bw / 2) : c), top: top.height };
  }
  // 坡上台地：上坡方向 = orient，否则沿地面上升的方向（平地时朝场地中心 / 朝北）
  let ax = n.orient && TDIRV[n.orient] && n.orient !== "C" ? TDIRV[n.orient] : null;
  if (!ax) { const g = [hAt(c[0] + 10, c[1]) - hAt(c[0] - 10, c[1]), hAt(c[0], c[1] + 10) - hAt(c[0], c[1] - 10)]; ax = Math.hypot(g[0], g[1]) > 0.5 ? tUnit(g) : Math.hypot(c[0], c[1]) > 5 ? tUnit([-c[0], -c[1]]) : [0, -1]; }
  ax = tUnit(ax);
  const a = size[1] / 2, b = size[0] / 2, F = (s, t) => [c[0] + ax[0] * s - ax[1] * t, c[1] + ax[1] * s + ax[0] * t];
  const lowPt = F(-a, 0), base = Math.round(hAt(lowPt[0], lowPt[1]) / st) * st, depth = (2 * a) / steps;
  for (let k = 0; k < steps; k++) {
    const s0 = -a + k * depth, s1 = s0 + depth, w = b * (1 - (0.25 * k) / Math.max(1, steps - 1));
    flat(k, [[s0, -w], [s0, 0], [s0, w], [s1, w], [s1, 0], [s1, -w]].map(([s, t]) => jit(F(s, t), 0.8)), base + (k + 1) * st, { label: `${n.label || "台地"} 第 ${k + 1} 级` });
  }
  const top = feats[feats.length - 1];
  return { feats, outline: [F(-a, -b), F(a, -b), F(a, b), F(-a, b)].map(tP2), topPoint: tP2(innerPoint(top.polygon, 2.5)), top: top.height };
}
