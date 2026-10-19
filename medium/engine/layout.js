// layout.js — 房屋布局：区域 → 种子化抖动网格采样 → 逐规则过滤 → 带朝向的体块
// 约定见 SPEC.md 第 0 节（坐标 / rotation_y）与第 2 节（规则）。纯函数，确定性：随机只来自 seed。
// 铁律：这里产出的每一个坐标都由算法算出，LLM 只决定 regions 的 kind / density。

import { rng, clamp, r2, pointInPolygon, distToSegment, distToPolygon, polygonCentroid, polygonArea } from "./terrain.js";

/** 房屋尺寸范围（米）：宽 x、高 y、深 z。宽是长边（平行等高线），门在局部 −z 面。 */
export const HOUSE_SIZES = Object.freeze({ width: [5, 7], height: [3.5, 4.5], depth: [4, 6] });

/** 树的尺寸基准 [直径, 高, 直径]，抖动 ±20% */
export const TREE_SIZE = Object.freeze([5, 7, 5]);

/** 不放房子的区域类型（forest 另行出树；其余只铺地）。gathering「聚落」= 密集民居，照常放房。 */
const NO_HOUSE_KINDS = new Set(["forest", "plaza", "farmland", "terrace", "water", "danger"]);

const DEG = Math.PI / 180;
const DEFAULTS = Object.freeze({
  seed: 1,            // 随机种子
  density: 1,         // 全局密度倍率（diversity 的 density 轴乘在这里）
  inset: 2,           // 台地多边形内缩（米）
  pathClearance: 2.5, // 到路：≥ 路宽/2 + 2.5
  streamClearance: 3, // 到溪：≥ 宽/2 + 3
  landmarkClearance: 4, // 到地标体块 ≥ 4
  houseGap: 0.8,      // 房与房最小净距（在「不重叠」之上再留一点缝）
  faceRoadWithin: 12, // 12 m 内有路则门朝路
  maxSlope: 0.35,     // 房子中心坡度上限（台地内部本应为 0）
  minDistFactor: 0.85, // 房子中心最小间距 = 间距 × 该系数（抖动网格的「泊松盘」半径）
});

// ------------------------------------------------------------ 几何小工具
/** 密度 → 中心间距的锚点（SPEC §2：1 → 9 m，0.5 → 14 m，1.5 → 6.5 m），之间线性插值、两端线性外推 */
const SPACING_ANCHORS = [[0.5, 14], [1, 9], [1.5, 6.5]];
/**
 * 密度 → 房子中心间距（米）：按 SPACING_ANCHORS 分段线性，夹在 5–40。
 * @param {number} density 0.05–1.6
 * @returns {number}
 */
export function spacingForDensity(density) {
  const d = clamp(Number(density) || 0, 0.05, 1.6), A = SPACING_ANCHORS;
  let i = 0;
  while (i < A.length - 2 && d > A[i + 1][0]) i++;
  const [d0, s0] = A[i], [d1, s1] = A[i + 1];
  return clamp(s0 + ((s1 - s0) * (d - d0)) / (d1 - d0), 5, 40);
}

/**
 * 体块俯视四角（世界坐标 [x,z]），与 SPEC 第 0 节一致：
 * 局部 +x → (cos θ, −sin θ)，局部 +z → (sin θ, cos θ)，门在局部 −z 面，朝向 (−sin θ, −cos θ)。
 */
export function boxCorners(position, size, rotationDeg = 0) {
  const t = rotationDeg * DEG, c = Math.cos(t), s = Math.sin(t);
  const cx = position[0], cz = position[2], w = size[0], d = size[2];
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => [cx + lx * c + lz * s, cz - lx * s + lz * c]);
}

/** 2D OBB 分离轴测试：两个四边形是否重叠（相切不算） */
export function obbOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const axis = [-(p2[1] - p1[1]), p2[0] - p1[0]];
      const proj = (pts) => { let mn = Infinity, mx = -Infinity; for (const p of pts) { const v = p[0] * axis[0] + p[1] * axis[1]; mn = Math.min(mn, v); mx = Math.max(mx, v); } return [mn, mx]; };
      const [a0, a1] = proj(a), [b0, b1] = proj(b);
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
  }
  return true;
}

function segsIntersect(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** 两线段最短距离（相交为 0） */
export function segSegDist(a, b, c, d) {
  if (segsIntersect(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}
/** 凸四边形到折线的最短距离（折线穿过四边形时为 0） */
export function rectToPolylineDist(rect, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    if (pointInPolygon(pts[i], rect)) return 0;
    for (let k = 0; k < rect.length; k++) best = Math.min(best, segSegDist(rect[k], rect[(k + 1) % rect.length], pts[i], pts[i + 1]));
  }
  if (pts.length && pointInPolygon(pts[pts.length - 1], rect)) return 0;
  return best;
}
/** 两个凸四边形的最短距离（重叠为 0） */
export function rectToRectDist(a, b) {
  if (obbOverlap(a, b)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < b.length; k++) best = Math.min(best, segSegDist(a[i], a[(i + 1) % a.length], b[k], b[(k + 1) % b.length]));
  return best;
}
/** 点到折线的最近点与距离 */
function nearestOnPolyline(p, pts) {
  let best = { d: Infinity, point: null };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0, 1);
    const q = [a[0] + t * dx, a[1] + t * dz];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { d, point: q };
  }
  return best;
}
/** 多边形是否完全包含四边形（四角在内且离边 ≥ inset） */
function rectInsidePolygon(rect, poly, inset) {
  for (const c of rect) { if (!pointInPolygon(c, poly)) return false; if (inset > 0 && distToPolygon(c, poly) < inset) return false; }
  return true;
}

/**
 * 种子化抖动网格采样：在多边形包围盒上铺间距 spacing 的网格，每格抖动 ±jitter×spacing，保留落在多边形内的点。
 * 顺序固定（行优先），因此结果确定。
 */
export function jitteredGrid(polygon, spacing, rand, jitter = 0.3) {
  let xmin = Infinity, zmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (const [x, z] of polygon) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  const ox = rand() * spacing, oz = rand() * spacing;
  const pts = [];
  for (let z = zmin + oz - spacing; z <= zmax + spacing; z += spacing) {
    for (let x = xmin + ox - spacing; x <= xmax + spacing; x += spacing) {
      const p = [x + (rand() - 0.5) * 2 * jitter * spacing, z + (rand() - 0.5) * 2 * jitter * spacing];
      if (pointInPolygon(p, polygon)) pts.push(p);
    }
  }
  return pts;
}

// ------------------------------------------------------------ 朝向
/**
 * 多尺度下坡方向：台地内部梯度为 0，所以逐级放大采样半径直到出现明显坡度。
 * 返回单位向量 [fx, fz]（指向下坡）或 null（四周全平）。
 */
export function downhillDir(T, x, z) {
  for (const R of [T.res, 4, 8, 12, 18, 26]) {
    const gx = (T.heightAt(x + R, z) - T.heightAt(x - R, z)) / (2 * R);
    const gz = (T.heightAt(x, z + R) - T.heightAt(x, z - R)) / (2 * R);
    const m = Math.hypot(gx, gz);
    if (m > 0.03) return [-gx / m, -gz / m];
  }
  return null;
}
/** 朝向向量 → rotation_y（度）：f = (−sin θ, −cos θ) ⇒ θ = atan2(−fx, −fz) */
export function facingToRotation(f) {
  let deg = Math.atan2(-f[0], -f[1]) / DEG;
  if (deg < 0) deg += 360;
  return r2(deg % 360);
}
/**
 * 决定一栋房的门朝向：12 m 内有路 → 朝最近路点；否则朝下坡；都没有 → 朝区域质心的反方向（朝外）。
 * roads 为非 river 的路折线数组。返回 { facing, faces: "path"|"downhill"|"outward" }。
 */
export function houseFacing(T, x, z, roads, centroid, within = DEFAULTS.faceRoadWithin) {
  let best = { d: Infinity, point: null };
  for (const pts of roads) { const n = nearestOnPolyline([x, z], pts); if (n.d < best.d) best = n; }
  if (best.point && best.d <= within && best.d > 1e-3) {
    const m = Math.hypot(best.point[0] - x, best.point[1] - z);
    return { facing: [(best.point[0] - x) / m, (best.point[1] - z) / m], faces: "path" };
  }
  const dh = downhillDir(T, x, z);
  if (dh) return { facing: dh, faces: "downhill" };
  const m = Math.hypot(x - centroid[0], z - centroid[1]);
  return { facing: m > 1e-6 ? [(x - centroid[0]) / m, (z - centroid[1]) / m] : [0, 1], faces: "outward" };
}

// ------------------------------------------------------------ 主函数
/**
 * 房屋布局。
 * @param {object} sid  场景文档（读 regions / paths / volumes / bounds）
 * @param {object} T    buildTerrain 的结果
 * @param {object} [opts] { seed, density（全局倍率）, inset, pathClearance, streamClearance, landmarkClearance, houseGap, faceRoadWithin, maxSlope }
 * @returns {{ volumes: object[], perTerrace: Object<number, number>, rejected: Object<string, number>, filled: number }}
 *   volumes 含房子（kind building）与 forest 区域的树（kind prop）；perTerrace 以层号为键；rejected 统计各规则淘汰的候选数。
 */
export function layoutHouses(sid, T, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const regions = resolveRegions(sid, T);
  const paths = (sid.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  const roads = paths.filter((p) => p.kind !== "river").map((p) => p.points);
  const obstacles = (sid.volumes || []).filter((v) => v && !v.generated && v.position && v.size)
    .map((v) => ({ rect: boxCorners(v.position, v.size, v.rotation_y || 0), clearance: v.importance === "landmark" ? o.landmarkClearance : 1 }))
    // 多层空间的连接点（楼梯口 / 井口 / 梯子）按 3×3 m 占地避让
    .concat((sid.markers || []).filter((m) => m && m.kind === "connector" && Array.isArray(m.position)).map((m) => ({ rect: boxCorners(m.position, [3, 1, 3], 0), clearance: 1.5 })));
  const bounds = sid.bounds || { min: [T.xmin, 0, T.zmin], max: [T.xmax, 40, T.zmax] };

  // placed：已放房子的底面；treeRects：已放树的底面（圆柱按外接正方形）。房与树互相避让，区域重叠（用户在台地上圈一块林子）时也不压。
  const volumes = [], placed = [], treeRects = [], perTerrace = {}, rejected = {};
  const reject = (why) => { rejected[why] = (rejected[why] || 0) + 1; };
  const counters = {};
  let filled = 0; // 兜底（fillBand）放下的房子数

  const houseRegions = [];
  regions.forEach((rg, ri) => {
    const density = clamp((Number(rg.density) || 0) * o.density, 0, 1.6);
    const seed = (o.seed * 7919 + ri * 131 + 17) >>> 0;
    if (rg.kind === "forest") {
      for (const t of scatterTrees(rg, T, density, seed, { paths, avoid: [...obstacles.map((ob) => ob.rect), ...placed, ...treeRects] })) { volumes.push(t); treeRects.push(boxCorners(t.position, t.size, 0)); }
      return;
    }
    if (NO_HOUSE_KINDS.has(rg.kind) || density <= 0) return;
    const rand = rng(seed);
    const centroid = polygonCentroid(rg.polygon);
    const spacing = spacingForDensity(density);
    // 窄台地（环带 / 溪谷两岸只有 8–10 m 宽）：内缩按宽度自适应，房子进深也跟着收，否则一栋都放不下。
    // 不跨崖仍由下面的「四角同一台地」保证。
    const meanWidth = regionMeanWidth(rg.polygon);
    const inset = clamp(meanWidth * 0.15, 0.5, o.inset);
    const depthMax = Math.max(HOUSE_SIZES.depth[0] - 0.5, meanWidth - 2 * inset - 0.5);
    const R = { rg, rand, centroid, density, minCenterDist: spacing * o.minDistFactor, oo: Object.assign({}, o, { inset }), centers: [], n: 0 };
    houseRegions.push(R);
    // 泊松盘近似：候选点铺到 spacing/2 的抖动网格并种子化打乱，再用「中心距 ≥ minCenterDist」筛，密度由此可控
    for (const [x, z] of shuffle(jitteredGrid(rg.polygon, spacing / 2, rand), rand)) {
      if (R.centers.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < R.minCenterDist)) { reject("too_close"); continue; }
      // 尺寸与朝向先定（它们决定 OBB），再逐条规则检查
      const size = [r2(lerpRange(HOUSE_SIZES.width, rand())), r2(lerpRange(HOUSE_SIZES.height, rand())), r2(lerpRange([Math.min(HOUSE_SIZES.depth[0], depthMax), Math.min(HOUSE_SIZES.depth[1], depthMax)], rand()))];
      const why = tryHouse(R, x, z, size, null);
      if (why) reject(why);
    }
    // 窄带兜底：这一块一栋都没放下（或不到 2 栋）时，沿带长方向找最宽处，用最小的房子再放
    if (density >= 0.3) fillBand(R, density >= 0.75 ? 2 : 1);
  });
  // 全图兜底：密度正常（≥ 0.75）却不到 6 栋时，按面积从大到小每块再多放一栋，直到够数或放不下
  if (o.density >= 0.75) {
    const byArea = houseRegions.filter((R) => R.density >= 0.75).sort((a, b) => polygonArea(b.rg.polygon) - polygonArea(a.rg.polygon) || String(a.rg.id).localeCompare(String(b.rg.id)));
    // 一轮每块多放一栋；某一轮一栋都没放下就停（只有一层住人时也能补够）
    for (let round = 0; round < 6 && placed.length < 6; round++) {
      const before = placed.length;
      for (const R of byArea) { if (placed.length >= 6) break; fillBand(R, R.n + 1); }
      if (placed.length === before) break;
    }
  }

  /** 放一栋：朝向按规则（12 m 内朝路 / 朝下坡 / 朝外）；facing 给定时用它。成功返回 null，否则返回淘汰原因 */
  function tryHouse(R, x, z, size, facingIn) {
    const px = r2(x), pz = r2(z), rg = R.rg;
    const F = facingIn || houseFacing(T, px, pz, roads, R.centroid, o.faceRoadWithin);
    const rotation_y = facingToRotation(F.facing);
    const rect = boxCorners([px, 0, pz], size, rotation_y);
    const why = checkHouse(rect, px, pz, rg, T, paths, obstacles, placed, treeRects, bounds, R.oo);
    if (why) return why;
    const level = rg.level;
    counters[level] = (counters[level] || 0) + 1;
    // terrace_level / region_id 是 schema 字段；level / terrace_id / faces_toward 是引擎附加（level 为 terrace_level 的别名）
    volumes.push({
      id: `house_${level}_${counters[level]}`, kind: "building", shape: "box",
      position: [px, r2(T.heightAt(px, pz)), pz], size, rotation_y,
      label: "民居", importance: "secondary", color_role: "wall", generated: true,
      terrace_level: level, region_id: rg.id, terrace_id: rg.terraceId, level, faces_toward: F.faces,
    });
    placed.push(rect); R.centers.push([px, pz]); R.n++;
    perTerrace[level] = (perTerrace[level] || 0) + 1;
    return null;
  }
  /** 兜底放房：区域内 1.5 m 网格点按「离边最远」排序（带的中线优先），房子取最小宽、进深按当地带宽收（≥ 3.5 m）；
   *  朝向先按规则，放不下再试朝下坡 / 朝外（门仍朝坡下或外侧，长边自然顺着带）。中心距放宽到 0.7 倍。确定性：无随机。 */
  function fillBand(R, target) {
    if (R.n >= target) return;
    const rg = R.rg, inset = 0.5;
    const pts = interiorPoints(rg.polygon, 1.5).filter((q) => q.d >= 2.2).sort((a, b) => b.d - a.d || a.p[0] - b.p[0] || a.p[1] - b.p[1]);
    const oo = R.oo; R.oo = Object.assign({}, oo, { inset });
    const h = r2((HOUSE_SIZES.height[0] + HOUSE_SIZES.height[1]) / 2);
    for (const { p, d } of pts) {
      if (R.n >= target) break;
      if (R.centers.some(([cx, cz]) => Math.hypot(cx - p[0], cz - p[1]) < R.minCenterDist * 0.7)) continue;
      const depth = r2(clamp(2 * (d - inset) - 0.4, HOUSE_SIZES.depth[0] - 0.5, HOUSE_SIZES.depth[0]));
      const size = [HOUSE_SIZES.width[0], h, depth];
      const rule = houseFacing(T, p[0], p[1], roads, R.centroid, o.faceRoadWithin);
      const dh = downhillDir(T, p[0], p[1]);
      const out = Math.hypot(p[0] - R.centroid[0], p[1] - R.centroid[1]) > 1e-6 ? [(p[0] - R.centroid[0]), (p[1] - R.centroid[1])] : null;
      const opts = [rule];
      if (dh && rule.faces !== "downhill") opts.push({ facing: dh, faces: "downhill" });
      if (out && rule.faces !== "outward") { const m = Math.hypot(out[0], out[1]); opts.push({ facing: [out[0] / m, out[1] / m], faces: "outward" }); }
      for (const F of opts) if (!tryHouse(R, p[0], p[1], size, F)) { filled++; break; }
    }
    R.oo = oo;
  }
  return { volumes, perTerrace, rejected, filled };
}

function lerpRange([a, b], t) { return a + (b - a) * t; }
/** 多边形的「平均宽度」= 2·面积 / 周长（长条形区域时就是它的宽） */
function regionMeanWidth(poly) { const A = Math.abs(polygonArea(poly)); let P = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; P += Math.hypot(a[0] - b[0], a[1] - b[1]); } return P > 0 ? (2 * A) / P : 0; }
/** 多边形内 step 网格点（行优先）及其离边距离 d */
function interiorPoints(poly, step) {
  let xmin = Infinity, zmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (const [x, z] of poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  const out = [];
  for (let z = zmin + step / 2; z < zmax; z += step) for (let x = xmin + step / 2; x < xmax; x += step) { const p = [r2(x), r2(z)]; if (pointInPolygon(p, poly)) out.push({ p, d: distToPolygon(p, poly) }); }
  return out;
}
/** 种子化 Fisher–Yates 打乱（原地），保证确定性 */
function shuffle(arr, rand) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }

/** 把 sid.regions 规范为 { id, kind, polygon, density, level, terraceId }；没有 regions 时按 T.terraces 全铺。按层号、id 排序保证确定性。 */
function resolveRegions(sid, T) {
  let list;
  if (Array.isArray(sid.regions) && sid.regions.length) {
    list = sid.regions.filter((r) => r && Array.isArray(r.polygon) && r.polygon.length >= 3).map((r) => {
      const c = polygonCentroid(r.polygon);
      const t = typeof r.terrace_level === "number" ? T.terraces.find((tt) => tt.level === r.terrace_level && pointInPolygon(c, tt.polygon)) || T.terraces.find((tt) => tt.level === r.terrace_level) : T.terraceAt(c[0], c[1]);
      const level = t ? t.level : typeof r.terrace_level === "number" ? r.terrace_level : T.levelAt(c[0], c[1]);
      return { id: r.id, kind: r.kind || "other", polygon: r.polygon, density: typeof r.density === "number" ? r.density : 1, level, terraceId: t ? t.id : null };
    });
  } else {
    list = T.terraces.map((t) => ({ id: "r_" + t.id, kind: "other", polygon: t.polygon, density: 1, level: t.level, terraceId: t.id }));
  }
  return list.sort((a, b) => a.level - b.level || String(a.id).localeCompare(String(b.id)));
}

/** 逐规则检查一个候选房子；返回淘汰原因或 null */
function checkHouse(rect, px, pz, rg, T, paths, obstacles, placed, treeRects, bounds, o) {
  for (const [x, z] of rect) if (x < bounds.min[0] || x > bounds.max[0] || z < bounds.min[2] || z > bounds.max[2]) return "out_of_bounds";
  if (!rectInsidePolygon(rect, rg.polygon, o.inset)) return "outside_region";
  // 四角同一台地（不跨崖）；区域有台地时必须就是它
  const ids = rect.map(([x, z]) => { const t = T.terraceAt(x, z); return t ? t.id : null; });
  if (rg.terraceId) { for (const id of ids) if (id !== rg.terraceId) return "cross_level"; }
  else {
    // 区域没有对应台地（基准面 / 用户随手圈的）：四角台地相同还不够——贴着台地脚时房角会落在坡裙上，再要求四角层号一致且四角都不陡
    const lv = T.levelAt(rect[0][0], rect[0][1]);
    for (const id of ids) if (id !== ids[0]) return "cross_level";
    for (const [x, z] of rect) { if (T.levelAt(x, z) !== lv) return "cross_level"; if (T.slopeAt(x, z) > o.maxSlope) return "too_steep"; }
  }
  if (T.slopeAt(px, pz) > o.maxSlope) return "too_steep";
  for (const p of paths) {
    const need = (p.width || 2) / 2 + (p.kind === "river" ? o.streamClearance : o.pathClearance);
    if (rectToPolylineDist(rect, p.points) < need) return p.kind === "river" ? "near_stream" : "near_path";
  }
  for (const ob of obstacles) if (rectToRectDist(rect, ob.rect) < ob.clearance) return "near_landmark";
  for (const other of placed) if (rectToRectDist(rect, other) < o.houseGap) return "overlap";
  for (const tr of treeRects) if (rectToRectDist(rect, tr) < o.houseGap) return "near_tree";
  return null;
}

// ------------------------------------------------------------ 树
/**
 * 在区域内散布树（圆柱体块）。
 * @param {object} region  { id, polygon }
 * @param {object} T       地形
 * @param {number} density 0–1.6：间距从 6 m（稀）到 4 m（密）
 * @param {number} seed
 * @param {object} [opts]  { paths: 要避开的路（含溪）, avoid: 要避开的四边形角点数组, inset = 1 }
 * @returns {object[]} Volume[]（kind prop, shape cylinder, label 树, generated true）
 */
export function scatterTrees(region, T, density, seed = 1, opts = {}) {
  if (!region || !Array.isArray(region.polygon) || region.polygon.length < 3) return [];
  const d = clamp(Number(density) || 0, 0, 1.6);
  if (d <= 0) return [];
  const spacing = clamp(6 - (d / 1.6) * 2, 4, 6);
  const inset = typeof opts.inset === "number" ? opts.inset : 1;
  const paths = (opts.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  const avoid = opts.avoid || [];
  const rand = rng((seed * 2654435761 + 97) >>> 0);
  const rid = String(region.id || "forest").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const out = [], centers = [];
  const minDist = Math.max(3, spacing * 0.6);
  let n = 0;
  for (const [x, z] of jitteredGrid(region.polygon, spacing, rand, 0.3)) {
    const px = r2(x), pz = r2(z);
    if (!T.inside(px, pz) || distToPolygon([px, pz], region.polygon) < inset) continue;
    if (centers.some(([cx, cz]) => Math.hypot(cx - px, cz - pz) < minDist)) continue;
    const k = 0.8 + rand() * 0.4, kh = 0.8 + rand() * 0.4;
    const size = [r2(TREE_SIZE[0] * k), r2(TREE_SIZE[1] * kh), r2(TREE_SIZE[2] * k)];
    const r = size[0] / 2;
    let blocked = false;
    for (const p of paths) if (nearestOnPolyline([px, pz], p.points).d < (p.width || 2) / 2 + r) { blocked = true; break; }
    if (!blocked) for (const rect of avoid) if (pointInPolygon([px, pz], rect) || distToPolygon([px, pz], rect) < r) { blocked = true; break; }
    if (blocked) continue;
    n++; centers.push([px, pz]);
    out.push({ id: `tree_${rid}_${n}`, kind: "prop", shape: "cylinder", position: [px, r2(T.heightAt(px, pz)), pz], size, rotation_y: 0, label: "树", color_role: "foliage", importance: "detail", generated: true, region_id: region.id });
  }
  return out;
}
