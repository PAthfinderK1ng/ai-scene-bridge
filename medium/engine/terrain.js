// terrain.js — 地形：特征 → 高度函数、台地、等高线、谷线（v3 的三种原型生成器已挪到 tests/fixtures.js，只给测试造样例）
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

  const terraces = feats.map((f, order) => ({ f, order })).filter(({ f }) => (f.kind === "plateau" || f.kind === "ridge") && f.polygon && f.height >= 0)
    .map(({ f, order }) => ({ id: f.id, level: typeof f.level === "number" ? f.level : Math.round((f.height - 0) / layer), height: f.height, polygon: f.polygon, centroid: polygonCentroid(f.polygon), feature: f, order, plan_id: f.plan_id || null }))
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
