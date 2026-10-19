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
  density: 1,         // 全局密度倍率（sid.meta.density_scale）
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
    .flatMap((v) => footRects(v).map((rect) => ({ rect, clearance: v.importance === "landmark" ? o.landmarkClearance : 1 }))) // 环带按一段段带子（孔里能布房）
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
    // 区域带建筑类型（plan 的 buildings）时，按它的 form / 尺寸放；没有时是默认民居。plaza 等「不放房」的区域给了建筑类型也放。
    const B = normBuilding(rg.building);
    if ((!B && NO_HOUSE_KINDS.has(rg.kind)) || density <= 0) return;
    const rand = rng(seed);
    const centroid = polygonCentroid(rg.polygon);
    const foot = B ? Math.hypot(B.size[0], B.size[2]) : 0;
    const spacing = Math.max(spacingForDensity(density), foot * 1.05);
    // 窄台地（环带 / 溪谷两岸只有 8–10 m 宽）：内缩按宽度自适应，房子进深也跟着收，否则一栋都放不下。
    // 不跨崖仍由下面的「四角同一台地」保证（吊脚楼例外：它就是要跨坡）。
    const meanWidth = regionMeanWidth(rg.polygon);
    const inset = clamp(meanWidth * 0.15, 0.5, o.inset);
    const depthMax = Math.max(HOUSE_SIZES.depth[0] - 0.5, meanWidth - 2 * inset - 0.5);
    const R = { rg, rand, centroid, density, B, form: B ? B.form : "house", minCenterDist: spacing * o.minDistFactor, oo: Object.assign({}, o, { inset }), centers: [], n: 0 };
    houseRegions.push(R);
    const sizeOf = () => {
      if (!B) return [r2(lerpRange(HOUSE_SIZES.width, rand())), r2(lerpRange(HOUSE_SIZES.height, rand())), r2(lerpRange([Math.min(HOUSE_SIZES.depth[0], depthMax), Math.min(HOUSE_SIZES.depth[1], depthMax)], rand()))];
      const k = 0.92 + rand() * 0.16, kh = 0.95 + rand() * 0.1, round = B.shape === "cylinder";
      const w = r2(B.size[0] * k), d = round ? w : r2(B.form === "stilt_house" || B.form === "courtyard" ? B.size[2] * k : Math.min(B.size[2] * k, Math.max(depthMax, B.size[2] * 0.6)));
      return [w, r2(B.size[1] * kh), d];
    };
    // 吊脚楼：先沿区域朝下坡的边找位置（房子前半截悬在坡上、门朝坡下），再铺普通网格
    if (R.form === "stilt_house") for (const c of stiltEdgeSpots(rg.polygon, T, B.size[2], spacing / 2)) {
      if (R.centers.some(([cx, cz]) => Math.hypot(cx - c.p[0], cz - c.p[1]) < R.minCenterDist)) { reject("too_close"); continue; }
      const why = tryHouse(R, c.p[0], c.p[1], sizeOf(), { facing: c.n, faces: "downhill" });
      if (why) reject(why);
    }
    // 泊松盘近似：候选点铺到 spacing/2 的抖动网格并种子化打乱，再用「中心距 ≥ minCenterDist」筛，密度由此可控
    for (const [x, z] of shuffle(jitteredGrid(rg.polygon, spacing / 2, rand), rand)) {
      if (R.centers.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < R.minCenterDist)) { reject("too_close"); continue; }
      // 尺寸与朝向先定（它们决定 OBB），再逐条规则检查
      const why = tryHouse(R, x, z, sizeOf(), null);
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
  function tryHouse(R, x, z, size, facingIn, form = R.form) {
    const px = r2(x), pz = r2(z), rg = R.rg, B = R.B;
    const F = facingIn || houseFacing(T, px, pz, roads, R.centroid, o.faceRoadWithin);
    const rotation_y = facingToRotation(F.facing);
    const rect = boxCorners([px, 0, pz], size, rotation_y);
    const why = form === "stilt_house" ? checkStilt(rect, px, pz, rg, T, paths, obstacles, placed, treeRects, bounds)
      : checkHouse(rect, px, pz, rg, T, paths, obstacles, placed, treeRects, bounds, R.oo);
    if (why) return why;
    const level = rg.level;
    const base = { kind: "building", importance: "secondary", color_role: "wall", generated: true, terrace_level: level, region_id: rg.id, terrace_id: rg.terraceId, level, faces_toward: F.faces };
    const plan = B ? { form, roof: B.roof, floors: B.floors, plan_id: B.plan_id, label: B.label } : { label: "民居" };
    if (rg.zone_id) plan.zone_id = rg.zone_id;
    const push = (pos, sz, extra = {}) => {
      counters[level] = (counters[level] || 0) + 1;
      // terrace_level / region_id 是 schema 字段；level / terrace_id / faces_toward 是引擎附加（level 为 terrace_level 的别名）
      // 谷 / 盆地底的层号是负的：id 写成 house_m2_1（id 只能小写字母、数字、下划线）
      volumes.push(Object.assign({ id: `house_${levelTag(level)}_${counters[level]}` }, base, { shape: B ? B.shape : "box", position: pos, size: sz, rotation_y }, plan, extra));
      perTerrace[level] = (perTerrace[level] || 0) + 1;
    };
    if (form === "stilt_house") {
      // 底面取上坡角（四角地面最高处），柱脚高 = 上坡角 − 下坡角
      const hs = rect.map(([cx, cz]) => T.heightAt(cx, cz)), top = Math.max(...hs);
      push([px, r2(top), pz], size, { stilt_m: r2(top - Math.min(...hs)) });
    } else if (form === "courtyard") {
      // 院落：一组四栋围合（前后两进 + 左右厢房），共用朝向，组号 courtyard
      const k = r2(clamp(Math.min(size[0], size[2]) * 0.28, 3.5, 6)), t = (rotation_y * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const at = (lx, lz) => { const wx = px + lx * c + lz * s, wz = pz - lx * s + lz * c; return [r2(wx), r2(T.heightAt(wx, wz)), r2(wz)]; };
      const group = `court_${levelTag(level)}_${(counters[level] || 0) + 1}`;
      push(at(0, -size[2] / 2 + k / 2), [size[0], size[1], k], { courtyard: group, wing: "front" });
      push(at(0, size[2] / 2 - k / 2), [size[0], r2(size[1] * 1.1), k], { courtyard: group, wing: "back" });
      push(at(-size[0] / 2 + k / 2, 0), [k, r2(size[1] * 0.9), r2(size[2] - 2 * k - 0.3)], { courtyard: group, wing: "left" });
      push(at(size[0] / 2 - k / 2, 0), [k, r2(size[1] * 0.9), r2(size[2] - 2 * k - 0.3)], { courtyard: group, wing: "right" });
    } else {
      push([px, r2(T.heightAt(px, pz)), pz], size, form !== R.form ? { form } : {});
    }
    placed.push(rect); R.centers.push([px, pz]); R.n++;
    return null;
  }
  /** 兜底放房：区域内 1.5 m 网格点按「离边最远」排序（带的中线优先），房子取最小宽、进深按当地带宽收（≥ 3.5 m）；
   *  朝向先按规则，放不下再试朝下坡 / 朝外（门仍朝坡下或外侧，长边自然顺着带）。中心距放宽到 0.7 倍。确定性：无随机。 */
  function fillBand(R, target) {
    if (R.n >= target) return;
    const rg = R.rg, inset = 0.5;
    const pts = interiorPoints(rg.polygon, 1.5).filter((q) => q.d >= 2.2).sort((a, b) => b.d - a.d || a.p[0] - b.p[0] || a.p[1] - b.p[1]);
    const oo = R.oo; R.oo = Object.assign({}, oo, { inset });
    const h = R.B ? R.B.size[1] : r2((HOUSE_SIZES.height[0] + HOUSE_SIZES.height[1]) / 2);
    const form = R.form === "courtyard" ? "house" : R.form; // 院落放不下一整组时退成单栋
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
      for (const F of opts) if (!tryHouse(R, p[0], p[1], size, F, form)) { filled++; break; }
    }
    R.oo = oo;
  }
  return { volumes, perTerrace, rejected, filled };
}

function lerpRange([a, b], t) { return a + (b - a) * t; }
const levelTag = (lv) => (lv < 0 ? "m" + -lv : String(lv));

// ------------------------------------------------------------ 建筑形制（plan 的 buildings）
/** 形制 → 体块形状：圆楼 / 井 / 树是圆柱，其余是盒子 */
export const FORM_SHAPE = Object.freeze({ round_house: "cylinder", well: "cylinder", tree: "cylinder" });
/** 区域上的建筑类型规范化：{ form, size: [w,h,d], floors, roof, label, plan_id, shape }；没有或不合法返回 null */
function normBuilding(b) {
  if (!b || typeof b !== "object") return null;
  const size = Array.isArray(b.size) ? b.size : Array.isArray(b.size_m) ? b.size_m : null;
  if (!size || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0)) return null;
  const form = b.form || "house";
  return { form, size: size.map(Number), floors: b.floors || 1, roof: b.roof || "gable", label: b.label || "民居", plan_id: b.plan_id || b.id || null, shape: FORM_SHAPE[form] || "box" };
}
/**
 * 吊脚楼的落位：沿多边形的边每 step 米取一点，只留「外侧朝下坡」的边（外法线与下坡方向夹角 < 60°），
 * 中心从边往里退 0.2 × 进深（前 0.3 进深悬在坡上），门朝外法线。顺序固定（沿边），确定性。
 * @returns {{p: number[], n: number[]}[]}
 */
function stiltEdgeSpots(poly, T, depth, step) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    let n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInPolygon([mid[0] + n[0] * 0.3, mid[1] + n[1] * 0.3], poly)) n = [-n[0], -n[1]];
    for (let t = step / 2; t < L; t += step) {
      const q = [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
      const dh = downhillDir(T, q[0] + n[0] * 2, q[1] + n[1] * 2);
      if (!dh || dh[0] * n[0] + dh[1] * n[1] < 0.5) continue;
      const p = [q[0] - n[0] * depth * 0.2, q[1] - n[1] * depth * 0.2];
      if (pointInPolygon(p, poly)) out.push({ p, n });
    }
  }
  return out;
}
/** 吊脚楼检查：中心在区域内，上坡角在区域的台地上，四角高差 ≤ 1.3 层（柱脚不超过一层多），其余（路 / 溪 / 地标 / 房 / 树）同普通房子 */
function checkStilt(rect, px, pz, rg, T, paths, obstacles, placed, treeRects, bounds) {
  for (const [x, z] of rect) if (x < bounds.min[0] || x > bounds.max[0] || z < bounds.min[2] || z > bounds.max[2]) return "out_of_bounds";
  if (!pointInPolygon([px, pz], rg.polygon) || distToPolygon([px, pz], rg.polygon) < 0.3) return "outside_region";
  const hs = rect.map(([x, z]) => T.heightAt(x, z)), top = Math.max(...hs), k = hs.indexOf(top);
  if (top - Math.min(...hs) > 1.3 * T.layer) return "too_steep";
  if (rg.terraceId) { const t = T.terraceAt(rect[k][0], rect[k][1]); if (!t || t.id !== rg.terraceId) return "cross_level"; }
  else if (rg.floorOnly && rect.some(([x, z]) => T.terraceAt(x, z))) return "cross_level";
  for (const p of paths) {
    const need = (p.width || 2) / 2 + (p.kind === "river" ? DEFAULTS.streamClearance : DEFAULTS.pathClearance);
    if (rectToPolylineDist(rect, p.points) < need) return p.kind === "river" ? "near_stream" : "near_path";
  }
  for (const ob of obstacles) if (rectToRectDist(rect, ob.rect) < ob.clearance) return "near_landmark";
  for (const other of placed) if (rectToRectDist(rect, other) < DEFAULTS.houseGap) return "overlap";
  for (const tr of treeRects) if (rectToRectDist(rect, tr) < DEFAULTS.houseGap) return "near_tree";
  return null;
}
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
      // floor_of：谷 / 盆地底上的区域，不挂到任何台地上（按真实地面布房）
      const t = r.floor_of ? null : r.terrace_id ? T.terraces.find((tt) => tt.id === r.terrace_id) || null : typeof r.terrace_level === "number" ? T.terraces.find((tt) => tt.level === r.terrace_level && pointInPolygon(c, tt.polygon)) || T.terraces.find((tt) => tt.level === r.terrace_level) : T.terraceAt(c[0], c[1]);
      const level = t ? t.level : typeof r.terrace_level === "number" ? r.terrace_level : T.levelAt(c[0], c[1]);
      return { id: r.id, kind: r.kind || "other", polygon: r.polygon, density: typeof r.density === "number" ? r.density : 1, level, terraceId: t ? t.id : null, building: r.building || null, zone_id: r.plan_id || null, floorOnly: !!r.floor_of };
    });
  } else if (sid.meta && Number(sid.meta.plan_version) >= 2) {
    list = []; // plan v2：只在「撒房子」生成器给的区域里布房，不再默认铺满台地
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
    for (const id of ids) if (id !== ids[0] || (rg.floorOnly && id)) return "cross_level";
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

// ------------------------------------------------------------ 局部坐标系（2×2 矩阵，x 东 z 南）与程序的自动修（program.js 调用）
export const rotM = (deg) => { const t = ((deg || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [c, s, -s, c]; };
export const mulM = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
export const apM = (M, v) => [M[0] * v[0] + M[1] * v[1], M[2] * v[0] + M[3] * v[1]];
export const invM = (M) => { const d = M[0] * M[3] - M[1] * M[2] || 1; return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d]; };

/**
 * 挂在立面上的子形体（elev_m 低于父体顶）中心还在父体里面：沿偏移方向推到外墙外（只搭进去 ≤ 0.5 m）。
 * @returns {number[]|null} 世界坐标里要挪的 [dx, dz]；偏移为 0（套在柱子上的环）或已经在外面 → null
 */
export function attachOffset(off, sz, rotDeg, p, frame) {
  off = off || [0, 0];
  const lx = off[0] || 0, lz = (off.length >= 3 ? off[2] : off[1]) || 0;
  if (Math.hypot(lx, lz) < 0.05) return null;
  const pv = frame.pv, ph = [pv.size[0] / 2, pv.size[2] / 2], q = apM(invM(frame.m), [p[0] - frame.o[0], p[1] - frame.o[1]]);
  const ax = Math.abs(q[0]) / ph[0] >= Math.abs(q[1]) / ph[1] ? 0 : 1;
  if (Math.abs(q[ax]) >= ph[ax] - 0.05) return null;
  const loc = apM(invM(rotM(rotDeg || 0)), ax ? [0, 1] : [1, 0]), own = Math.abs(loc[0]) * sz[0] / 2 + Math.abs(loc[1]) * sz[2] / 2;
  const to = (Math.sign(q[ax]) || 1) * (ph[ax] + own - Math.min(0.5, own / 2));
  return apM(frame.m, ax ? [0, to - q[1]] : [to - q[0], 0]);
}

/**
 * 镜像的模板正好在翻转轴上（两份完全重合，只看得见一份）——模型最常见的写法错：
 * ① 重复自己写了沿翻转方向的偏移 → 当成对称半间距挪给模板；② 模板只在另一个方向偏 → 轴写反了，换轴；③ 单个形体 → 偏开半个宽 + 1 m。
 * @returns {{tpl: object, mirrorAxis: string, p?: number[], how: string, text: string}|null}
 */
export function mirrorFix(node, tpl, parentM, M, p, mirrorAxis, tplSize, tplSolid) {
  const to = tpl.offset_m || [0, 0], t3 = to.length >= 3 ? [to[0] || 0, to[2] || 0] : [to[0] || 0, to[1] || 0];
  const ai = mirrorAxis === "z" ? 1 : 0, bi = 1 - ai, ro = node.offset_m || [0, 0];
  if (Math.abs(t3[ai]) >= 0.05) return null;
  const rl = apM(invM(M), apM(parentM, [ro[0] || 0, (ro.length >= 3 ? ro[2] : ro[1]) || 0]));
  const setT = (k, val) => { const t2 = t3.slice(); t2[k] = r2(val); return to.length >= 3 ? [t2[0], to[1] || 0, t2[1]] : t2; };
  if (Math.abs(rl[ai]) > 0.5) {
    const back = apM(M, ai ? [0, rl[1]] : [rl[0], 0]);
    return { tpl: Object.assign({}, tpl, { offset_m: setT(ai, rl[ai]) }), mirrorAxis, p: [p[0] - back[0], p[1] - back[1]], how: "offset",
      text: `重复自己的偏移 ${r2(Math.abs(rl[ai]))} m 当成对称半间距，两份在 ${mirrorAxis === "x" ? "东西" : "南北"}两侧各一` };
  }
  if (Math.abs(t3[bi]) > 0.5) {
    const ax = mirrorAxis === "x" ? "z" : "x";
    return { tpl, mirrorAxis: ax, how: "axis", text: `模板偏在${ax === "x" ? "东西" : "南北"}方向，翻转轴改成 axis:${ax}` };
  }
  if (tplSolid) {
    const half = tplSize[ai ? 2 : 0] / 2 + 1;
    return { tpl: Object.assign({}, tpl, { offset_m: setT(ai, -half) }), mirrorAxis, how: "spread", text: `模板在翻转轴上，两份各偏开 ${r2(half)} m` };
  }
  return null;
}

// ------------------------------------------------------------ 程序用的平面几何（program.js / sid.js / section.js / relations.js 调用；从 program.js 挪来）
const P2_ = (p) => [r2(p[0]), r2(p[1])];
const d2_ = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit_ = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? [0, 0] : [v[0] / L, v[1] / L]; };
/** 多边形在方向 u 上离 c 最远多少 */
export function support(poly, c, u) { let m = 0; for (const p of poly) m = Math.max(m, (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1]); return m; }
export function ellipsePoly(c, rx, rz, deg = 0, n = 24) { const M = rotM(deg), out = []; for (let k = 0; k < n; k++) { const t = (2 * Math.PI * k) / n, q = apM(M, [rx * Math.cos(t), rz * Math.sin(t)]); out.push(P2_([c[0] + q[0], c[1] + q[1]])); } return out; }
export function rectPoly(c, w, d, deg = 0) { const M = rotM(deg); return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map((q) => { const r = apM(M, q); return P2_([c[0] + r[0], c[1] + r[1]]); }); }
export function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
export function bboxOf(pts) { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; }
export const bbHit = (a, b, m = 0) => a[0] - m < b[2] && b[0] - m < a[2] && a[1] - m < b[3] && b[1] - m < a[3];
export function polyLen(pts) { let L = 0; for (let i = 0; i < pts.length - 1; i++) L += d2_(pts[i], pts[i + 1]); return L; }
/** 折线上比例 f 处的点与切向 */
export function alongLine(pts, f) {
  const L = polyLen(pts); let want = clamp(f, 0, 1) * L;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = d2_(pts[i], pts[i + 1]);
    if (want <= d || i === pts.length - 2) { const t = d > 1e-9 ? clamp(want / d, 0, 1) : 0; return { p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t], tan: unit_([pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]) }; }
    want -= d;
  }
  return { p: pts[0].slice(), tan: [1, 0] };
}
/**
 * 线形地形（沟 / 河 / 坡道）的岸：方位后缀取线的法向里和该方位同侧的那一边（.left / .right 按 start → end 的走向），
 * 在线的中段离中线 off 米（= 半宽 + 边坡宽 + 1.5）。方位和线差不多平行（|cos| < 0.2）返回 null（交给调用方取端点）。
 * @param {number[][]} line @param {number} off @param {number[]|null} u 方位向量 @param {number} side 1 左 / -1 右 / 0 按 u
 */
export function lineBank(line, off, u, side = 0) {
  const m = alongLine(line, 0.5), nL = [m.tan[1], -m.tan[0]]; // 走向的左手法向（x 东、z 南：往东走，左手是北）
  let s = side;
  if (!s) { if (!u) return null; const dt = u[0] * nL[0] + u[1] * nL[1]; if (Math.abs(dt) < 0.2) return null; s = Math.sign(dt); }
  return [m.p[0] + nL[0] * s * off, m.p[1] + nL[1] * s * off];
}
/** 锚在线形地形上的矩形 / 椭圆的缺省转角：长边顺着线（rotM 约定：局部 x → [cos, -sin]） */
export function alongDeg(tan, size) {
  const t = (size && size[1] > size[0]) ? Math.atan2(tan[0], tan[1]) : Math.atan2(-tan[1], tan[0]);
  return Math.round((t * 180) / Math.PI * 10) / 10;
}
/**
 * 高架组（组离地 lift 米）里的子节点该不该落地当支撑：写了 ground:"snap" 的；或柱 / 方 / 圆柱 / 棱柱（重复看模板）没写 elev_m、
 * 高在 0.7–1.25 × lift 之间（从地面撑到台面的墩）。组里有浮岛的不算（岛上的尖塔不是墩）。
 * @param {object} node @param {number} lift @param {(n: object) => number[]} sizeOf size3 @param {number} [sc]
 */
export function isSupport(node, lift, sizeOf, sc = 1) {
  if (!(lift > 2.5) || !node || node.at || node.elev_m > 0) return false;
  if (node.ground === "snap") return true;
  let t = node; while (t && t.type === "repeat") t = t.child;
  if (!t || !SUPPORT_T.has(t.type) || t.elev_m > 0 || t.ground === "float" || t.at) return false;
  const h = sizeOf(t)[1] * sc;
  return h >= 0.7 * lift && h <= 1.25 * lift + 2;
}
const SUPPORT_T = new Set(["column", "box", "cylinder", "prism"]);
/** 高架组里没落地、又高到戳出台面的竖向件（拱、墙、墩）：给「支撑悬空」检查 */
export function hangsAbove(node, lift, sizeOf, sc = 1) {
  if (!(lift > 2.5) || !node || node.at || node.elev_m > 0 || !HANG_T.has(node.type)) return false;
  const s = sizeOf(node).map((v) => v * sc);
  return s[1] >= Math.max(4, 0.5 * lift) && s[1] > 1.2 * Math.min(s[0], s[2]);
}
const HANG_T = new Set(["column", "box", "cylinder", "prism", "arch", "wall", "gate"]);
/** 高架组里戳出台面的拱 / 门 / 柱（或它们的一排）：返回模板高度（米），不是返回 0。程序把它立到台面上（矮的）或落地（高的 / 组里没台面） */
export function standsUp(node, lift, sizeOf, sc = 1) {
  if (!(lift > 2.5) || !node || node.at || node.elev_m > 0 || node.ground) return 0;
  let t = node; while (t && t.type === "repeat") { t = t.child; if (t && (t.at || t.elev_m > 0 || t.ground)) return 0; }
  return t && STAND_T.has(t.type) && hangsAbove(t, lift, sizeOf, sc) ? sizeOf(t)[1] * sc : 0;
}
const STAND_T = new Set(["arch", "gate", "column"]);
/** 落地的墩 / 柱 / 拱：从脚下的地面撑到高架台面底（不戳出台面，也不悬在台面下） */
export function fitSupport(vols, deckY) { for (const v of vols || []) if (deckY != null) v.size[1] = r2(Math.max(0.5, deckY - v.position[1])); }
/** 组里的台面高度：扁平的 platform / box / cylinder（没自己的锚点、elev_m），没有 = 0 */
export const deckOf = (children, sizeOf, sc = 1) => Math.max(0, ...(children || []).filter((c) => c && !c.at && !(c.elev_m > 0) && (c.type === "platform" || ((c.type === "box" || c.type === "cylinder") && sizeOf(c)[1] <= 3))).map((c) => sizeOf(c)[1] * sc));
/** 多边形内离边最远的格点 */
export function deepPoint(poly, step = 2) {
  const [x0, z0, x1, z1] = bboxOf(poly);
  let best = null, bd = -1;
  for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) if (pointInPolygon([x, z], poly)) { const d = distToPolygon([x, z], poly); if (d > bd + 1e-9) { bd = d; best = [x, z]; } }
  return best || polygonCentroid(poly);
}
/** 两个凸多边形的最小平移（把 A 推出 B）：{ o 距离, d 方向 }；不重叠（贴着 ≤ 10 cm）= null */
export function mtv(A, B) {
  let best = null;
  for (const poly of [A, B]) for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i], p2 = poly[(i + 1) % poly.length], ax = unit_([-(p2[1] - p1[1]), p2[0] - p1[0]]);
    const pr = (pts) => { let mn = Infinity, mx = -Infinity; for (const q of pts) { const v = q[0] * ax[0] + q[1] * ax[1]; mn = Math.min(mn, v); mx = Math.max(mx, v); } return [mn, mx]; };
    const [a0, a1] = pr(A), [b0, b1] = pr(B);
    if (Math.min(a1, b1) - Math.max(a0, b0) <= 0.1) return null;
    const up = b1 - a0, down = a1 - b0, o = Math.min(up, down); // 往两边取近的；A 整个在 B 里面时也对
    if (!best || o < best.o) best = { o, d: up <= down ? ax : [-ax[0], -ax[1]] };
  }
  return best;
}

// ------------------------------------------------------------ 环带：空心圆柱（hollow，壁厚 / 带宽 wall）与平放的 torus（带宽 = 管粗）
/**
 * SID 体块是不是一圈「带子」：空心圆柱（v.hollow，带宽 v.wall，缺省短半径的 15%、至少 0.4 m）或平放的 torus（带宽 = 管粗 size[1]，≤ 半径一半）。
 * @returns {{rx: number, rz: number, wall: number, ix: number, iz: number, torus: boolean}|null} 外半径 / 带宽 / 内孔半径
 */
export function ringOf(v) {
  if (!v || !Array.isArray(v.size)) return null;
  const torus = v.shape === "torus" && v.orient !== "upright";
  if (!torus && !(v.hollow && v.shape === "cylinder")) return null;
  const w = Number(v.size[0]) || 1, d = Number(v.size[2]) > 0 ? Number(v.size[2]) : w, m = Math.min(w, d) / 2;
  const wall = torus ? Math.min(Math.max(0.1, Number(v.size[1]) || 0.5), m * 0.5) : Math.min(m * 0.9, Number(v.wall) > 0 ? Number(v.wall) : Math.max(0.4, m * 0.15));
  return { rx: w / 2, rz: d / 2, wall, ix: Math.max(0.05, w / 2 - wall), iz: Math.max(0.05, d / 2 - wall), torus };
}
/** 环带的局部 → 世界（同 boxCorners 的 rotation_y 约定） */
const ringPt = (v, lx, lz) => { const t = (v.rotation_y || 0) * DEG, c = Math.cos(t), s = Math.sin(t); return [v.position[0] + lx * c + lz * s, v.position[2] - lx * s + lz * c]; };
/** 落地采样点：只在带子上（外沿、中线、内沿各一圈），不采中间的空洞——环带底面按环上最高点 */
export function ringSamples(v) {
  const R = ringOf(v);
  if (!R) return null;
  const n = clamp(Math.ceil((Math.PI * 2 * Math.max(R.rx, R.rz)) / 6), 12, 32), out = [];
  for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n, ca = Math.cos(a), sa = Math.sin(a); for (const f of [0.98, 0.5, 0.02]) out.push(ringPt(v, (R.ix + (R.rx - R.ix) * f) * ca, (R.iz + (R.rz - R.iz) * f) * sa)); }
  return out;
}
/** 环带的「钥匙孔」多边形（外圈 + 一道缝 + 反向内圈）：pointInPolygon（奇偶规则）在带上为真、内孔里为假 */
export function ringPoly(v, n = 32) {
  const R = ringOf(v);
  if (!R) return null;
  const outer = [], inner = [];
  for (let k = 0; k <= n; k++) { const a = (2 * Math.PI * k) / n; outer.push(P2_(ringPt(v, R.rx * Math.cos(a), R.rz * Math.sin(a)))); inner.push(P2_(ringPt(v, R.ix * Math.cos(a), R.iz * Math.sin(a)))); }
  return outer.concat(inner.reverse());
}
/** 环带拆成 n 段四边形（避让 / 寻路 / 布房当障碍用；中间的孔是空的）；不是环 → [四角] */
export function footRects(v, n = 16) {
  const R = ringOf(v);
  if (!R) return [boxCorners(v.position, v.size, v.rotation_y || 0)];
  n = clamp(Math.round((Math.PI * 2 * R.rx) / 8), 8, n * 2);
  const out = [], pt = (r, a) => ringPt(v, r[0] * Math.cos(a), r[1] * Math.sin(a)), o = [R.rx / Math.cos(Math.PI / n), R.rz / Math.cos(Math.PI / n)], i = [R.ix, R.iz];
  for (let k = 0; k < n; k++) { const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n; out.push([pt(i, a0), pt(o, a0), pt(o, a1), pt(i, a1)]); }
  return out;
}
/** 点 q 落在体块脚下（环带只算带子，不算中间的孔） */
export function onFoot(v, q) {
  const R = ringOf(v);
  if (!R) return pointInPolygon(q, boxCorners(v.position, v.size, v.rotation_y || 0));
  const t = -(v.rotation_y || 0) * DEG, dx = q[0] - v.position[0], dz = q[1] - v.position[2], lx = dx * Math.cos(t) + dz * Math.sin(t), lz = -dx * Math.sin(t) + dz * Math.cos(t);
  return (lx / R.rx) ** 2 + (lz / R.rz) ** 2 <= 1 && (lx / R.ix) ** 2 + (lz / R.iz) ** 2 >= 1;
}
/**
 * 圆环带（圆心 c、外半径 R、内孔半径 h）与凸多边形 P 的重叠：null = 不重叠（P 整个在孔里或在环外）；
 * 否则 { o, d } = 把 P 推开的最小距离与方向（P 的中心在带子中线以内 → 往环心推进孔里，否则往外推）。
 */
export function ringPolyMtv(c, R, h, P) {
  const inside = pointInPolygon(c, P), near = inside ? 0 : distToPolygon(c, P);
  let far = 0; for (const q of P) far = Math.max(far, d2_(q, c));
  if (near >= R - 0.1 || far <= h + 0.1) return null;
  const pc = polygonCentroid(P), u0 = unit_([pc[0] - c[0], pc[1] - c[1]]), u = u0[0] || u0[1] ? u0 : [1, 0];
  if (!inside && d2_(pc, c) < (R + h) / 2 && far - h < R - near) return { o: far - h, d: [-u[0], -u[1]] };
  if (inside && far - h < R - near) return { o: far - h, d: u, shrink: r2(h) }; // 套在孔里、只是四角伸进带子：报伸进去的深度（缩到内径以内就好），不报「往外推一整圈」
  return { o: R - near, d: u };
}

// ============================================================ SID 体块形体约定（v5，docs/06 §4.8；原在 views/map.js，四个视图共用；纯几何，不碰 DOM）
/** 体块形体 */
export const SHAPES = Object.freeze(["box", "cylinder", "cone", "dome", "pyramid", "wedge", "arch", "torus", "sphere", "prism"]);
/** 路的样式 */
export const PATH_STYLES = Object.freeze(["path", "road", "stairs", "ramp", "bridge", "rope_bridge", "tunnel", "canal", "portal"]);
/** 屋顶（building / tower 才有） */
export const ROOFS = Object.freeze(["gable", "hip", "flat", "dome", "spire", "none"]);
const SHAPE_ALIAS = { cube: "box", block: "box", hemisphere: "dome", ring: "torus", ball: "sphere", ramp: "wedge", hex: "prism", polygon: "prism", cyl: "cylinder" };
const ROOF_ALIAS = { cone: "spire", pointed: "spire", conical: "spire", pyramid: "hip", hipped: "hip", gabled: "gable", onion: "dome", dome: "dome", flat: "flat", none: "none", gable: "gable", hip: "hip", spire: "spire" };
/** 俯视是圆的形体（占地按椭圆） */
export const ROUND_SHAPES = new Set(["cylinder", "cone", "dome", "sphere", "torus", "prism"]);
/** 规范化形体名（缺省 box） */
export function shapeOf(v) { const s = String((v && v.shape) || "box").toLowerCase(); return SHAPES.includes(s) ? s : SHAPE_ALIAS[s] || "box"; }
/** SID 原始尺寸 [宽, 总高（含屋顶）, 深] */
function rawDims(v) {
  const s = (v && Array.isArray(v.size)) ? v.size : [];
  const w = Math.max(0.1, Number(s[0]) || 1), h = Math.max(0.05, Number(s[1]) || 1), d = Number(s[2]) > 0 ? Number(s[2]) : w;
  return [w, h, d];
}
/**
 * 体块三维尺寸 [宽 x, 墙身高 y, 深 z]：圆形体 size = [直径, 高, (直径 z)]、prism = [直径, 高]，深缺省 = 宽。
 * SID v0.5：size[1] 是总高（含屋顶 roof_h），这里返回的 y 是去掉屋顶的墙身高——视图「墙身 + 屋顶」叠起来正好 = size[1]。
 */
export function volDims(v) {
  const [w, h, d] = rawDims(v), r = roofOf(v);
  return [w, r ? Math.max(0.05, h - r.h) : h, d];
}
/** prism 的边数（3–12，缺省 6） */
export const prismSides = (v) => clamp(Math.round(Number(v && v.sides) || 6), 3, 12);
/** 拱的腿厚（缺省宽的 18%，至少 0.6 m，最多宽的 45%） */
export function archThickness(v) { const [w] = volDims(v); return clamp(Number(v.thickness) > 0 ? Number(v.thickness) : Math.max(0.6, w * 0.18), 0.2, w * 0.45); }
/** 环的管径（平放 = 高；立起来 orient upright = 厚 size[2]；夹在直径的 6%–35%） */
export function torusTube(v) { const [w, h, d] = volDims(v); return clamp(v && v.orient === "upright" ? d : h, w * 0.06, w * 0.35); }
/** 立起来的环（torus + orient upright）：环面竖着，按 rotation_y 朝向 */
export const isUpright = (v) => !!v && v.orient === "upright" && shapeOf(v) === "torus";
/**
 * 屋顶：只有 kind building / tower 有。缺省 building = gable、tower = spire；别名 cone → spire、pyramid → hip。
 * SID v0.5：屋顶在 size[1]（总高）之内、顶部那一段，高 h = v.roof_h（引擎给）；没给时按引擎同一规则估：
 * spire min(长边, 0.45 总高)、dome min(短边 / 2, 0.45 总高)、gable / hip min(0.35 短边, 0.4 总高)、flat min(0.5, 0.1 总高)（压顶板）、none 0。
 * @returns {{type: string, h: number} | null}
 */
export function roofOf(v) {
  if (!v || (v.kind !== "building" && v.kind !== "tower")) return null;
  const raw = v.roof == null ? (v.kind === "tower" ? "spire" : "gable") : String(v.roof).toLowerCase(), type = ROOF_ALIAS[raw] || "gable";
  const [w, h, d] = rawDims(v), mn = Math.min(w, d), mx = Math.max(w, d);
  let rh = { gable: Math.min(mn * 0.35, h * 0.4), hip: Math.min(mn * 0.35, h * 0.4), dome: Math.min(mn / 2, h * 0.45), spire: Math.min(mx, h * 0.45), flat: Math.min(0.5, h * 0.1), none: 0 }[type];
  if (Number(v.roof_h) >= 0 && v.roof_h != null) rh = Number(v.roof_h);
  return { type, h: clamp(rh, 0, h * 0.9) };
}
/** 离地高度（米）：v.elev（底面离地，> 0 = 悬空） */
export const elevOf = (v) => Math.max(0, Number(v && v.elev) || 0);
/**
 * 体块底面的世界高度：position[1] 是底面绝对高度；悬空（elev > 0）时至少是中心地面 + elev（引擎只给 elev 没抬 position[1] 时也对）。
 * @param {object} v SID volume
 * @param {object} [T] buildTerrain 结果
 */
export function volumeBase(v, T) {
  const y = Number(v.position[1]), e = elevOf(v);
  if (!T) return Number.isFinite(y) ? y : e;
  const g = T.heightAt(v.position[0], v.position[2]);
  if (!Number.isFinite(y)) return g + e;
  return e > 0 ? Math.max(y, g + e) : y;
}
/** 体块最高点（墙身 + 屋顶） */
export function volumeTop(v, T) { const r = roofOf(v); return volumeBase(v, T) + volDims(v)[1] + (r ? r.h : 0); }
/** 局部 (lx, lz) → 世界 [x, z]（rotation_y 度，俯视逆时针为正；与 layout.boxCorners 同一约定） */
export function volToWorld(v, lx, lz) {
  const t = ((v.rotation_y || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [v.position[0] + lx * c + lz * s, v.position[2] - lx * s + lz * c];
}
/** 体块俯视占地多边形（世界坐标）：圆形体 = 椭圆 20 点、prism = n 边形、其它 = 旋转矩形；pad 向外扩 */
export function footprintPolygon(v, pad = 0) {
  const sh = shapeOf(v), [w, , d] = volDims(v), rx = w / 2 + pad, rz = d / 2 + pad;
  if (sh === "prism") { const n = prismSides(v); return Array.from({ length: n }, (_, k) => { const a = (2 * Math.PI * k) / n - Math.PI / 2; return volToWorld(v, rx * Math.cos(a), rx * Math.sin(a)); }); }
  if (ROUND_SHAPES.has(sh)) return Array.from({ length: 20 }, (_, k) => { const a = (2 * Math.PI * k) / 20; return volToWorld(v, rx * Math.cos(a), rz * Math.sin(a)); });
  return [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz]].map(([x, z]) => volToWorld(v, x, z));
}

// ------------------------------------------------------------ SID 元素占地（地形块多边形 / 构成元素中心 / plan_id → SID id；原在 views/map.js）
const validPoly_ = (p) => Array.isArray(p) && p.length >= 3 && p.every((q) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]));
/** 特征的俯视多边形：有 polygon 用它；穹顶（hill / ridge 带 rx / rz）按椭圆采 24 点；只有半径的用圆 */
export function featurePolygon(f) {
  if (validPoly_(f.polygon)) return f.polygon;
  const c = Array.isArray(f.center) ? [f.center[0], f.center[2]] : null;
  if (!c) return null;
  const rx = f.rx > 0 ? f.rx : f.radius, rz = f.rz > 0 ? f.rz : f.radius, A = f.angle || 0, ca = Math.cos(A), sa = Math.sin(A);
  if (!(rx > 0 && rz > 0)) return null;
  const out = [];
  for (let k = 0; k < 24; k++) { const t = (2 * Math.PI * k) / 24, u = rx * Math.cos(t), v = rz * Math.sin(t); out.push([r2(c[0] + u * ca - v * sa), r2(c[1] + u * sa + v * ca)]); }
  return out;
}
/** 构成图元素在地图上的中心（地形块 / 区域 / 空间等；拖动结果 = 它 + 平移量）：所有构件外接框的中心 */
export function planCenter(sid, T, planId) {
  const ps = [];
  for (const f of (sid.terrain && sid.terrain.features) || []) if (f.plan_id === planId) { const p = featurePolygon(f); if (p) ps.push(...p); }
  for (const r of sid.regions || []) if (r.plan_id === planId && validPoly_(r.polygon)) ps.push(...r.polygon);
  for (const s of sid.spaces || []) if ((s.plan_id || s.id) === planId && validPoly_(s.polygon)) ps.push(...s.polygon);
  for (const v of sid.volumes || []) if (v.plan_id === planId && v.importance === "landmark") ps.push([v.position[0], v.position[2]]);
  if (!ps.length) for (const v of sid.volumes || []) if (v.plan_id === planId && Array.isArray(v.position)) ps.push(...footprintPolygon(v)); // 形体组（v5）：整组占地
  if (!ps.length) return null;
  const xs = ps.map((p) => p[0]), zs = ps.map((p) => p[1]);
  return [r2((Math.min(...xs) + Math.max(...xs)) / 2), r2((Math.min(...zs) + Math.max(...zs)) / 2)];
}
/** 一个 plan_id 对应的全部 SID id（有 index 用 index，否则扫 SID） */
export function sidIdsOf(sid, index, planId) {
  if (index && index[planId] && Array.isArray(index[planId].sid_ids)) return index[planId].sid_ids;
  const out = [], hit = (o) => o && (o.plan_id === planId || o.zone_id === planId);
  for (const f of (sid.terrain && sid.terrain.features) || []) if (hit(f)) out.push(f.id);
  for (const k of ["regions", "volumes", "paths", "markers", "spaces"]) for (const o of sid[k] || []) if (hit(o)) out.push(o.id);
  return out;
}
/** 内容的取景框 [x, z, w, h]：形体底面 + 路 + 空间 + 出生点的包围盒，四周留 8% / 至少 6 m，不出场地边；内容太少（< 1/6 场地）时放大到 1/6，免得只剩一个点 */
export function contentBox(sid, b, u) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const put = (x, z) => { if (!Number.isFinite(x) || !Number.isFinite(z)) return; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const v of sid.volumes || []) {
    if (!v.position || !v.size) continue;
    const r = Math.hypot(v.size[0], v.size[2]) / 2;
    put(v.position[0] - r, v.position[2] - r); put(v.position[0] + r, v.position[2] + r);
  }
  for (const p of sid.paths || []) for (const q of p.points || []) put(q[0], q[q.length - 1]);
  for (const s of sid.spaces || []) for (const q of s.polygon || s.outline || []) put(q[0], q[1]);
  for (const m of sid.markers || []) if (m.position) put(m.position[0], m.position[2]);
  if (!Number.isFinite(x0)) return null;
  const BW = b.max[0] - b.min[0], BH = b.max[2] - b.min[2];
  let w = x1 - x0, h = z1 - z0;
  const pad = Math.max(6, 0.08 * Math.max(w, h)), minS = Math.max(BW, BH) / 6;
  let cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  w = Math.max(minS, w + 2 * pad); h = Math.max(minS, h + 2 * pad);
  const PAD = 4 * u;
  w = Math.min(w, BW + 2 * PAD); h = Math.min(h, BH + 2 * PAD);
  cx = clamp(cx, b.min[0] - PAD + w / 2, b.max[0] + PAD - w / 2); cz = clamp(cz, b.min[2] - PAD + h / 2, b.max[2] + PAD - h / 2);
  return [cx - w / 2, cz - h / 2, w, h];
}

/** 从 p 沿单位方向 u 走到多边形边上的距离（p 不在里面 = 0） */
function reachIn(poly, p, u) {
  if (!pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e = [b[0] - a[0], b[1] - a[1]], den = u[0] * e[1] - u[1] * e[0];
    if (Math.abs(den) < 1e-9) continue;
    const w = [a[0] - p[0], a[1] - p[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * u[1] - w[1] * u[0]) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0;
}
/**
 * 锚在圈选（area 标记）里的重复放不下时怎么收（docs/07 §1.1：圈的范围是人给的边界）：直线 / 网格先缩间距，缩到实例挨着还放不下就少放几个；放射缩半径。
 * 重复以 p 为中心对称排开，M = 它的坐标系（局部 x / z → 世界）；留 1 m 边。放得下返回 null。
 * @param {number[][]} poly 圈选多边形（世界坐标） @param {number[]} p 重复中心 @param {number[]} M 2×2
 * @param {"linear"|"grid"|"radial"} pat
 * @param {{n: number, R: number, C: number, stepX: number, stepZ: number, radius: number, tsz: number[], axis: "x"|"z"}} o
 * @returns {{stepX: number, stepZ: number, n?: number, R?: number, C?: number, radius?: number, how: string}|null}
 */
export function fitInArea(poly, p, M, pat, o) {
  if (!Array.isArray(poly) || poly.length < 3 || !pointInPolygon(p, poly)) return null;
  const dirOf = (lv) => { const v = apM(M, lv), L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  const halfAlong = (lv) => { const u = dirOf(lv); return Math.min(reachIn(poly, p, u), reachIn(poly, p, [-u[0], -u[1]])) - 1; };
  const r1 = (v) => Math.round(v * 10) / 10;
  /** 一条轴：k 个、间距 st、实例半宽 ch、可用半长 half → 新的 { st, k } 或 null（放得下） */
  const axisFit = (k, st, ch, half) => {
    if (k <= 1 || (k - 1) / 2 * st + ch <= half + 1e-6) return null;
    const st2 = (2 * (half - ch)) / (k - 1);
    if (st2 >= 2 * ch) return { st: r1(st2), k };
    const k2 = Math.max(1, Math.floor(half / Math.max(0.1, ch)));
    return { st: r1(2 * ch), k: Math.min(k, k2) };
  };
  const out = { stepX: o.stepX, stepZ: o.stepZ }, how = [];
  if (pat === "linear") {
    const z = o.axis === "z", st = z ? o.stepZ : o.stepX, f = axisFit(o.n, st, (z ? o.tsz[2] : o.tsz[0]) / 2, halfAlong(z ? [0, 1] : [1, 0]));
    if (!f) return null;
    out[z ? "stepZ" : "stepX"] = f.st; how.push(`间距 ${r1(st)} → ${f.st} m`);
    if (f.k !== o.n) { out.n = f.k; how.push(`放不下 ${o.n} 个，放了 ${f.k} 个`); }
  } else if (pat === "grid") {
    const fx = axisFit(o.C, o.stepX, o.tsz[0] / 2, halfAlong([1, 0])), fz = axisFit(o.R, o.stepZ, o.tsz[2] / 2, halfAlong([0, 1]));
    if (!fx && !fz) return null;
    if (fx) { out.stepX = fx.st; how.push(`列距 ${r1(o.stepX)} → ${fx.st} m`); if (fx.k !== o.C) { out.C = fx.k; how.push(`${o.C} 列 → ${fx.k} 列`); } }
    if (fz) { out.stepZ = fz.st; how.push(`行距 ${r1(o.stepZ)} → ${fz.st} m`); if (fz.k !== o.R) { out.R = fz.k; how.push(`${o.R} 行 → ${fz.k} 行`); } }
  } else if (pat === "radial") {
    let near = Infinity;
    for (let k = 0; k < 16; k++) { const a = (k / 16) * 2 * Math.PI; near = Math.min(near, reachIn(poly, p, [Math.cos(a), Math.sin(a)])); }
    const ch = Math.max(o.tsz[0], o.tsz[2]) / 2, R2 = r1(near - 1 - ch);
    if (o.radius + ch <= near - 1 + 1e-6 || R2 < ch) return null; // 放得下；或者圈太小、缩了也没意义（交给摘要报「超出了圈的范围」）
    out.radius = R2; how.push(`半径 ${r1(o.radius)} → ${R2} m`);
  } else return null;
  out.how = how.join("，");
  return out;
}
