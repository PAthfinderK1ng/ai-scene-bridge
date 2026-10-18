// validate.js — 基础校验：id、引用、越界、体块重叠、faces 关系一致性
import { allObjects, collArray, find, centroid2 } from "./state.js";

const ID_RE = /^[a-z][a-z0-9_]*$/;
const DEG = Math.PI / 180;

function boxCorners(pos, size, deg) {
  const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
  const [cx, , cz] = pos, [w, , d] = size;
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => [cx + lx * c + lz * s, cz - lx * s + lz * c]);
}

/** 2D OBB 分离轴测试 */
function obbOverlap(a, b) {
  const polys = [a, b];
  for (const poly of polys) {
    for (let i = 0; i < 4; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % 4];
      const axis = [-(p2[1] - p1[1]), p2[0] - p1[0]];
      const proj = (pts) => { let mn = Infinity, mx = -Infinity; for (const p of pts) { const v = p[0] * axis[0] + p[1] * axis[1]; mn = Math.min(mn, v); mx = Math.max(mx, v); } return [mn, mx]; };
      const [a0, a1] = proj(a), [b0, b1] = proj(b);
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
  }
  return true;
}

function objCenter(coll, obj) {
  if (coll === "volumes" || coll === "markers") return [obj.position[0], obj.position[2]];
  if (coll === "features") return [obj.center[0], obj.center[2]];
  if (coll === "regions") return centroid2(obj.polygon);
  if (coll === "paths") return centroid2(obj.points);
  return [0, 0];
}

export function validate(doc) {
  const out = [];
  const push = (level, id, msg) => out.push({ level, id, msg });
  const ids = new Map();
  for (const { coll, obj } of allObjects(doc)) {
    if (!ID_RE.test(obj.id || "")) push("error", obj.id, `id「${obj.id}」不合法：只能小写字母、数字、下划线，字母开头`);
    if (ids.has(obj.id)) push("error", obj.id, `id「${obj.id}」重复（${ids.get(obj.id)} 与 ${coll}）`);
    ids.set(obj.id, coll);
  }
  const b = doc.bounds;
  const inside = (x, z) => x >= b.min[0] - 1e-6 && x <= b.max[0] + 1e-6 && z >= b.min[2] - 1e-6 && z <= b.max[2] + 1e-6;
  for (const v of doc.volumes) {
    for (const [x, z] of boxCorners(v.position, v.size, v.rotation_y || 0)) if (!inside(x, z)) { push("warn", v.id, `${v.id} 超出 bounds`); break; }
    if (v.size.some((s) => !(s > 0))) push("error", v.id, `${v.id} 的尺寸必须大于 0`);
    if (v.kind === "building" && v.size[1] < 2.5) push("warn", v.id, `${v.id} 是建筑但高度只有 ${v.size[1]} m（玩家 1.8 m）`);
    if (v.color_role && !(doc.style.palette || []).some((p) => p.role === v.color_role)) push("warn", v.id, `${v.id} 的 color_role「${v.color_role}」不在调色板里`);
  }
  for (const m of doc.markers) if (!inside(m.position[0], m.position[2])) push("warn", m.id, `${m.id} 超出 bounds`);
  for (const r of doc.regions) { if (r.polygon.length < 3) push("error", r.id, `${r.id} 的多边形少于 3 个点`); for (const [x, z] of r.polygon) if (!inside(x, z)) { push("warn", r.id, `${r.id} 超出 bounds`); break; } }
  for (const p of doc.paths) { if (p.points.length < 2) push("error", p.id, `${p.id} 的路径少于 2 个点`); if (!(p.width > 0)) push("error", p.id, `${p.id} 的宽度必须大于 0`); }

  // 光照范围（与 schema 一致）
  const L = doc.style.lighting || {};
  if (L.sun_azimuth_deg !== undefined && !(Number.isFinite(L.sun_azimuth_deg) && L.sun_azimuth_deg >= 0 && L.sun_azimuth_deg <= 360)) push("error", null, `太阳方位 ${L.sun_azimuth_deg} 不在 0–360`);
  if (L.sun_elevation_deg !== undefined && !(Number.isFinite(L.sun_elevation_deg) && L.sun_elevation_deg >= -10 && L.sun_elevation_deg <= 90)) push("error", null, `太阳高度 ${L.sun_elevation_deg} 不在 −10–90`);
  // asset_hints 悬空
  for (const k of Object.keys(doc.asset_hints || {})) if (!find(doc, k)) push("warn", null, `asset_hints 里的「${k}」不对应任何对象`);
  // 体块重叠（圆柱也按 rotation_y 转，椭圆柱才有意义；圆的转不转一样）
  const vols = doc.volumes.map((v) => ({ v, poly: boxCorners(v.position, v.size, v.rotation_y || 0) }));
  for (let i = 0; i < vols.length; i++) for (let j = i + 1; j < vols.length; j++) {
    const A = vols[i], B = vols[j];
    const ay = [A.v.position[1], A.v.position[1] + A.v.size[1]], by = [B.v.position[1], B.v.position[1] + B.v.size[1]];
    if (ay[1] <= by[0] + 1e-6 || by[1] <= ay[0] + 1e-6) continue;
    if (obbOverlap(A.poly, B.poly)) push("warn", A.v.id, `${A.v.id} 与 ${B.v.id} 重叠`);
  }
  // 标记在体块里
  for (const m of doc.markers) for (const { v, poly } of vols) {
    if (m.position[1] >= v.position[1] + v.size[1]) continue;
    if (obbOverlap(poly, boxCorners([m.position[0], 0, m.position[2]], [0.2, 1, 0.2], 0))) push("warn", m.id, `${m.id} 在 ${v.id} 内部`);
  }
  // 引用
  for (const r of doc.relations) {
    for (const k of ["a", "b"]) if (!find(doc, r[k])) push("error", r[k], `关系 ${r.type}(${r.a}, ${r.b}) 引用了不存在的 ${r[k]}`);
  }
  for (const c of doc.constraints) {
    for (const t of c.targets || []) if (t !== "*" && !find(doc, t)) push("error", t, `约束 ${c.type} 引用了不存在的 ${t}`);
    if (c.from && !find(doc, c.from)) push("error", c.from, `约束 ${c.type} 的 from 引用了不存在的 ${c.from}`);
  }
  // faces 一致性：a 的朝向向量应大致指向 b
  for (const r of doc.relations) {
    if (r.type !== "faces") continue;
    const fa = find(doc, r.a), fb = find(doc, r.b);
    if (!fa || !fb || !("rotation_y" in fa.obj)) continue;
    const [ax, az] = objCenter(fa.coll, fa.obj), [bx, bz] = objCenter(fb.coll, fb.obj);
    const t = (fa.obj.rotation_y || 0) * DEG;
    const fx = -Math.sin(t), fz = -Math.cos(t);
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    const cos = (fx * dx + fz * dz) / len;
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
    if (ang > 45) push("warn", r.a, `${r.a} 应朝向 ${r.b}，但朝向偏了 ${Math.round(ang)}°（改 rotation_y）`);
  }
  // adjacent 间距
  for (const r of doc.relations) {
    if (r.type !== "adjacent") continue;
    const fa = find(doc, r.a), fb = find(doc, r.b);
    if (!fa || !fb) continue;
    const [ax, az] = objCenter(fa.coll, fa.obj), [bx, bz] = objCenter(fb.coll, fb.obj);
    const sizeA = fa.coll === "volumes" ? Math.hypot(fa.obj.size[0], fa.obj.size[2]) / 2 : 0;
    const sizeB = fb.coll === "volumes" ? Math.hypot(fb.obj.size[0], fb.obj.size[2]) / 2 : fb.coll === "regions" ? Math.hypot(...extent(fb.obj.polygon)) / 2 : 0;
    const gap = Math.hypot(bx - ax, bz - az) - sizeA - sizeB;
    if (gap > 4) push("warn", r.a, `${r.a} 与 ${r.b} 标为 adjacent，但间距约 ${Math.round(gap)} m`);
  }
  // 出生点
  if (!doc.markers.some((m) => m.kind === "player_spawn")) push("warn", null, "没有 player_spawn 标记");
  if (!out.length) push("ok", null, "没有发现问题");
  return out;
}

function extent(pts) {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
}

export { collArray };
