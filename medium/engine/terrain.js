// terrain.js — 地形：特征 → 高度函数、台地、等高线、谷线；三种原型生成器
// 约定见 SPEC.md 第 0–1 节。纯函数，确定性。

export const DEFAULT_LAYER_M = 3;
export const ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"];
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
export function rotateXZ([x, z], side) {
  if (side === "E") return [z, -x];
  if (side === "W") return [-z, x];
  return [x, z];
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
export function featureContribution(f, x, z) {
  const k = f.kind;
  if ((k === "plateau" || k === "ridge" || k === "cliff") && f.polygon) {
    if (pointInPolygon([x, z], f.polygon)) return f.height;
    const d = distToPolygon([x, z], f.polygon);
    return f.height * Math.max(0, 1 - d / f.skirt);
  }
  // 圆形穹顶（hill / pit / 无 polygon 的 plateau）
  const R = Math.max(f.radius || 1, 0.5);
  const r = Math.hypot(x - f.center[0], z - f.center[2]);
  if (k === "plateau") return r <= R ? f.height : f.height * Math.max(0, 1 - (r - R) / f.skirt);
  return f.height * Math.max(0, 1 - (r / R) ** 2);
}
export function heightFromFeatures(feats, base, x, z) {
  let pos = 0, neg = 0;
  for (const f of feats) {
    const c = featureContribution(f, x, z);
    if (c >= 0) pos = Math.max(pos, c); else neg += c;
  }
  return base + pos + neg;
}

// ------------------------------------------------------------ 地形对象
export function buildTerrain(sid, opts = {}) {
  const b = sid.bounds || DEFAULT_BOUNDS;
  const xmin = b.min[0], zmin = b.min[2], xmax = b.max[0], zmax = b.max[2];
  const res = opts.res || 2;
  const layer = Number(sid.meta && sid.meta.layer_height_m) || DEFAULT_LAYER_M;
  const base = (sid.terrain && sid.terrain.base_height) || 0;
  const feats = ((sid.terrain && sid.terrain.features) || []).map((f) => normalizeFeature(f, layer));
  const nx = Math.ceil((xmax - xmin) / res) + 1, nz = Math.ceil((zmax - zmin) / res) + 1;
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = heightFromFeatures(feats, base, xmin + i * res, zmin + j * res);

  const terraces = feats.filter((f) => (f.kind === "plateau" || f.kind === "ridge") && f.polygon)
    .map((f) => ({ id: f.id, level: typeof f.level === "number" ? f.level : Math.round((f.height - 0) / layer), height: f.height, polygon: f.polygon, centroid: polygonCentroid(f.polygon), feature: f }))
    .sort((a, b2) => a.height - b2.height || a.id.localeCompare(b2.id))
    .map((t, i) => Object.assign(t, { index: i }));

  const T = {
    xmin, zmin, xmax, zmax, res, nx, nz, base, layer, features: feats, terraces,
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
    levelAt(x, z) { return Math.round((T.heightAt(x, z) - base) / layer); },
    terraceAt(x, z) {
      let best = null;
      for (const t of terraces) if (pointInPolygon([x, z], t.polygon) && (!best || t.height > best.height)) best = t;
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

// ------------------------------------------------------------ 原型
const WIDTHS = { narrow: 22, medium: 32, wide: 42 };

function jitterPoly(poly, amt, rand) { return poly.map(([x, z]) => [r2(x + (rand() - 0.5) * 2 * amt), r2(z + (rand() - 0.5) * 2 * amt)]); }

export function generateArchetype(name, params = {}, bounds = DEFAULT_BOUNDS, seed = 1) {
  const p = Object.assign({ entry_side: "S", terraces: 4, layer_height_m: DEFAULT_LAYER_M, plateau_width: "medium", stream: false }, params);
  const n = clamp(Math.round(p.terraces), 3, 7);
  const layer = clamp(Number(p.layer_height_m) || DEFAULT_LAYER_M, 2.5, 6);
  const rand = rng(seed);
  const side = ["S", "E", "W"].includes(p.entry_side) ? p.entry_side : "S";
  const half = WIDTHS[p.plateau_width] || WIDTHS.medium;
  const zSouth = 42, zNorth = -46; // 局部坐标：入口在南(+z)，上坡朝北
  const features = [];
  let stream = null;
  const spots = {}, entries = {};
  let summit, valley_bottom;

  if (name === "ring_terrace") {
    const mid = Math.floor(n / 2), rp = half * 0.45, bw = (zSouth - zNorth) / 2 / (n - mid + 1.0); // 环带宽约 9–13 m，够放一排房
    const arc = (r0, r1, a0, a1, cz) => { const pts = []; const N = 7; for (let k = 0; k <= N; k++) { const a = a0 + ((a1 - a0) * k) / N; pts.push([r1 * Math.cos(a), cz + r1 * Math.sin(a)]); } for (let k = N; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / N; pts.push([r0 * Math.cos(a), cz + r0 * Math.sin(a)]); } return pts.map(([x, z]) => [r2(x), r2(z)]); };
    const cz = 2;
    // 广场（中层）
    const plaza = []; for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; plaza.push([r2(rp * Math.cos(a)), r2(cz + rp * 0.8 * Math.sin(a))]); }
    features.push({ id: "terrace_" + mid, kind: "plateau", level: mid, polygon: plaza, label: `第 ${mid + 1} 层 · 广场` });
    // 北半环（上坡）
    for (let k = mid + 1; k < n; k++) { const r0 = rp + (k - mid - 1) * bw, r1 = rp + (k - mid) * bw; features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: jitterPoly(arc(r0, r1, Math.PI, Math.PI * 2, cz), 1.2, rand), label: `第 ${k + 1} 层` }); }
    // 南半环（下坡，朝入口）
    for (let k = mid - 1; k >= 0; k--) { const r0 = rp + (mid - k - 1) * bw, r1 = rp + (mid - k) * bw; features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: jitterPoly(arc(r0, r1, 0, Math.PI, cz), 1.2, rand), label: `第 ${k + 1} 层` }); }
    const topR = rp + (n - 1 - mid) * bw;
    spots.top = [0, cz - topR * 0.55]; spots.ridge_end = [topR * 0.7, cz - topR * 0.5]; spots.cliff_edge = [0, cz - rp - bw * 0.3]; spots.plaza = [0, cz];
    summit = [0, cz - topR - 3]; valley_bottom = [0, zSouth + 8];
    entries.S = [0, zSouth + 12]; entries.E = [58, cz + 8]; entries.W = [-58, cz + 8];
  } else if (name === "valley_two_banks") {
    const gap = 7, bw = Math.min(half * 1.45, 52 - 7) / n; // 两岸各 n 条带，外缘不超过 x = ±52
    const sx = (z) => 4 * Math.sin(z / 15);
    const band = (sign, k) => { const inner = gap + k * bw, outer = gap + (k + 1) * bw; const pts = []; for (let z = zNorth; z <= zSouth; z += 11) pts.push([sign * (sx(z) + inner), z]); for (let z = zSouth; z >= zNorth; z -= 11) pts.push([sign * (sx(z) + outer), z]); return pts.map(([x, z]) => [r2(x), r2(z)]); };
    for (let k = 0; k < n; k++) {
      features.push({ id: `terrace_w_${k}`, kind: "plateau", level: k, polygon: jitterPoly(band(-1, k), 0.8, rand), label: `西坡第 ${k + 1} 层` });
      features.push({ id: `terrace_e_${k}`, kind: "plateau", level: k, polygon: jitterPoly(band(1, k), 0.8, rand), label: `东坡第 ${k + 1} 层` });
    }
    stream = []; for (let z = -60; z <= 60; z += 4) stream.push([r2(sx(z)), z]);
    const outer = gap + n * bw;
    spots.top = [outer - bw * 0.5, -30]; spots.ridge_end = [outer - bw * 0.5, -44]; spots.cliff_edge = [gap + bw * 0.4, -20]; spots.plaza = [gap + bw * 0.5 + 2, 10];
    summit = [outer - bw * 0.5, -44]; valley_bottom = [sx(zSouth + 8), zSouth + 8];
    entries.S = [sx(54), 54]; entries.E = [58, 0]; entries.W = [-58, 0];
  } else { // slope_zigzag（默认）
    const depth = (zSouth - zNorth) / n;
    for (let k = 0; k < n; k++) {
      const zb = zSouth - k * depth, zt = zb - depth;
      const w = half * (1 - (0.28 * k) / Math.max(1, n - 1));
      const poly = jitterPoly([[-w, zt], [w, zt], [w, zb], [-w, zb]], 1.5, rand);
      features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: poly, label: `第 ${k + 1} 层` });
    }
    const topW = half * (1 - 0.28), zTop = zNorth;
    spots.top = [0, zTop + depth * 0.5]; spots.ridge_end = [topW * 0.75, zTop + depth * 0.5]; spots.cliff_edge = [0, zSouth - (n - 1) * depth - 2]; spots.plaza = [0, zSouth - Math.floor(n / 2) * depth - depth / 2];
    summit = [0, zTop + 2]; valley_bottom = [0, zSouth + 8];
    entries.S = [0, zSouth + 12]; entries.E = [58, zSouth - depth * 1.2]; entries.W = [-58, zSouth - depth * 1.2];
  }
  if (p.stream && !stream) { stream = []; for (let z = -60; z <= 60; z += 4) stream.push([r2(-half - 6 + 3 * Math.sin(z / 12)), z]); }

  // 旋转到入口方位，回填 center / radius / height
  const rot = (pt) => rotateXZ(pt, side).map(r2);
  for (const f of features) { f.polygon = f.polygon.map(rot); const c = polygonCentroid(f.polygon); f.center = [r2(c[0]), 0, r2(c[1])]; f.radius = r2(polygonRadius(f.polygon, c)); f.height = r2(f.level * layer); f.skirt = clamp(f.height * 0.8, 2, 10); f.notes = f.notes || ""; }
  if (stream) stream = stream.map(rot);
  for (const k of Object.keys(spots)) spots[k] = rot(spots[k]);
  const E = {}; for (const k of Object.keys(entries)) E[k] = rot(entries[k]);
  // 入口的方位标签随旋转：S 永远表示「入口所在边」= side
  const entriesWorld = { S: E.S, E: E.E, W: E.W };
  if (side === "E") { entriesWorld.E = E.S; entriesWorld.S = E.E; entriesWorld.W = E.W; }
  if (side === "W") { entriesWorld.W = E.S; entriesWorld.S = E.W; entriesWorld.E = E.E; }
  // 保证入口在 bounds 内
  const b = bounds;
  for (const k of Object.keys(entriesWorld)) entriesWorld[k] = [clamp(entriesWorld[k][0], b.min[0] + 2, b.max[0] - 2), clamp(entriesWorld[k][1], b.min[2] + 2, b.max[2] - 2)];
  return { features, stream, spots, entries: entriesWorld, summit: rot(summit), valley_bottom: rot(valley_bottom).map((v, i) => clamp(v, b.min[i * 2] + 2, b.max[i * 2] - 2)), layer_height_m: layer, archetype: name, params: Object.assign({}, p, { terraces: n, layer_height_m: layer, entry_side: side }) };
}
