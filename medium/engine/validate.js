// validate.js — SID 基础校验（ES module 版，移植自 app/validate.js）
// 检查 id、引用、越界、体块重叠、faces / adjacent 一致性，并支持 terrain.features 的 polygon 台地。
// 纯函数：validate(sid, T?) → [{ level: "error"|"warn"|"ok", id, msg }]。不依赖 app/state.js。
import { polygonCentroid, pointInPolygon } from "./terrain.js";

export const ID_RE = /^[a-z][a-z0-9_]*$/;
export const COLLS = ["volumes", "regions", "paths", "markers", "spaces", "features"];
const DEG = Math.PI / 180;
const FEATURE_KINDS = ["hill", "pit", "ridge", "cliff", "plateau", "valley", "basin", "raise", "lower", "flatten", "terrace", "ramp", "carve", "lake", "river", "dune", "noise"];
const SPACE_KINDS = { underground: ["cave", "tunnel", "cellar", "crypt", "mine", "maze", "chamber", "halls", "rooms"], sky: ["platform", "walkway", "island", "bridge", "chamber", "network", "rooms"] };
const VIAS = ["stairs", "ladder", "well", "shaft", "elevator", "rope_bridge", "ramp"];

/**
 * 取某个集合的数组（features 在 sid.terrain 下）。
 * @param {object} sid
 * @param {string} coll COLLS 之一
 * @returns {Array}
 */
export function collArray(sid, coll) {
  if (coll === "features") return (sid.terrain && sid.terrain.features) || [];
  return sid[coll] || [];
}

/**
 * 按 id 查找对象。
 * @param {object} sid
 * @param {string} id
 * @returns {{coll: string, obj: object}|null}
 */
export function findObject(sid, id) {
  for (const coll of COLLS) {
    const obj = collArray(sid, coll).find((o) => o && o.id === id);
    if (obj) return { coll, obj };
  }
  return null;
}

/**
 * 列出全部对象。
 * @param {object} sid
 * @returns {{coll: string, obj: object}[]}
 */
export function allObjects(sid) {
  const out = [];
  for (const coll of COLLS) for (const obj of collArray(sid, coll)) out.push({ coll, obj });
  return out;
}

/**
 * 体块的俯视 OBB 四角。rotation_y 约定：0 = 朝北(−z)，俯视逆时针为正。
 * @param {number[]} pos [x, y, z] 底面中心
 * @param {number[]} size [宽 x, 高 y, 深 z]
 * @param {number} deg rotation_y（度）
 * @returns {number[][]} 4 个 [x, z]
 */
export function boxCorners(pos, size, deg = 0) {
  const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
  const cx = pos[0], cz = pos[2], w = size[0], d = size[2];
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => [cx + lx * c + lz * s, cz - lx * s + lz * c]);
}

/**
 * 2D OBB 分离轴测试（两个凸四边形是否相交，相切不算）。
 * @param {number[][]} a 4 角
 * @param {number[][]} b 4 角
 * @returns {boolean}
 */
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

/**
 * 对象的俯视中心 [x, z]（features 优先用 polygon 质心）。
 * @param {string} coll
 * @param {object} obj
 * @returns {number[]}
 */
export function objCenter(coll, obj) {
  if (coll === "volumes" || coll === "markers") return [obj.position[0], obj.position[2]];
  if (coll === "features") return obj.polygon && obj.polygon.length >= 3 ? polygonCentroid(obj.polygon) : [obj.center[0], obj.center[2]];
  if (coll === "regions" || coll === "spaces") return polygonCentroid(obj.polygon);
  if (coll === "paths") return polygonCentroid(obj.points.length >= 3 ? obj.points : [...obj.points, obj.points[0]]);
  return [0, 0];
}

function extent(pts) {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
}
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

/**
 * 校验 SID，返回消息数组。给 T（buildTerrain 结果）时额外检查建筑是否贴地、是否跨越台地边缘。
 * @param {object} sid
 * @param {object} [T] buildTerrain(sid) 的结果，可选
 * @returns {{level: "error"|"warn"|"ok", id: string|null, msg: string}[]}
 */
export function validate(sid, T) {
  const out = [];
  const push = (level, id, msg) => out.push({ level, id: id == null ? null : id, msg });
  const ids = new Map();
  for (const { coll, obj } of allObjects(sid)) {
    if (!ID_RE.test(obj.id || "")) push("error", obj.id, `id「${obj.id}」不合法：只能小写字母、数字、下划线，字母开头`);
    if (ids.has(obj.id)) push("error", obj.id, `id「${obj.id}」重复（${ids.get(obj.id)} 与 ${coll}）`);
    ids.set(obj.id, coll);
  }
  const b = sid.bounds || { min: [-60, 0, -60], max: [60, 40, 60] };
  const inside = (x, z) => x >= b.min[0] - 1e-6 && x <= b.max[0] + 1e-6 && z >= b.min[2] - 1e-6 && z <= b.max[2] + 1e-6;
  const palette = (sid.style && sid.style.palette) || [];

  // 地形特征：有 polygon 的台地只要多边形合法；没有 polygon 的必须有 center / radius
  for (const f of collArray(sid, "features")) {
    if (f.kind && !FEATURE_KINDS.includes(f.kind)) push("warn", f.id, `${f.id} 的 kind「${f.kind}」不在 ${FEATURE_KINDS.join("/")}`);
    if (f.op && (f.mask === "all" || Array.isArray(f.line))) { if (Array.isArray(f.line) && f.line.length < 2) push("error", f.id, `${f.id} 的 line 少于 2 个点`); }
    else if (Array.isArray(f.polygon)) {
      if (f.polygon.length < 3) push("error", f.id, `${f.id} 的 polygon 少于 3 个点`);
      if (f.polygon.length > 32 && !f.op) push("warn", f.id, `${f.id} 的 polygon 有 ${f.polygon.length} 个点（建议 ≤ 32）`);
      if (!f.op) for (const [x, z] of f.polygon) if (!inside(x, z)) { push("warn", f.id, `${f.id} 的 polygon 超出 bounds`); break; } // 雕刻遮罩可以伸出场地
    } else {
      if (!isVec3(f.center)) push("error", f.id, `${f.id} 没有 polygon，必须给 center [x, y, z]`);
      else if (!inside(f.center[0], f.center[2])) push("warn", f.id, `${f.id} 的 center 超出 bounds`);
      if (!(f.radius > 0)) push("error", f.id, `${f.id} 没有 polygon，必须给 radius > 0`);
    }
    if (f.height !== undefined && !Number.isFinite(f.height)) push("error", f.id, `${f.id} 的 height 不是数字`);
    if (f.level !== undefined && !Number.isInteger(f.level)) push("error", f.id, `${f.id} 的 level 必须是整数层号`);
  }

  for (const v of sid.volumes || []) {
    if (!isVec3(v.position) || !isVec3(v.size)) { push("error", v.id, `${v.id} 的 position / size 必须是 [x, y, z]`); continue; }
    for (const [x, z] of boxCorners(v.position, v.size, v.rotation_y || 0)) if (!inside(x, z)) { push("warn", v.id, `${v.id} 超出 bounds`); break; }
    if (v.size.some((s) => !(s > 0))) push("error", v.id, `${v.id} 的尺寸必须大于 0`);
    if (v.kind === "building" && v.size[1] < 2.5) push("warn", v.id, `${v.id} 是建筑但高度只有 ${v.size[1]} m（玩家 1.8 m）`);
    if (v.color_role && !palette.some((p) => p.role === v.color_role)) push("warn", v.id, `${v.id} 的 color_role「${v.color_role}」不在调色板里`);
    if (T && v.kind === "building" && v.form !== "stilt_house" && v.form !== "bridge" && !v.rests_on && !v.land) { // plan v2 的形体（带 land）按自己的落地规则，不在这里查 // 吊脚楼底面取上坡角、桥跨谷：不按贴地 / 跨台地查
      const ground = T.heightAt(v.position[0], v.position[2]);
      if (Math.abs(v.position[1] - ground) > 1.5) push("warn", v.id, `${v.id} 未贴地：position.y=${v.position[1]}，地面 ${Math.round(ground * 10) / 10} m`);
      const levels = new Set(boxCorners(v.position, v.size, v.rotation_y || 0).map(([x, z]) => T.levelAt(x, z)));
      if (levels.size > 1) push("warn", v.id, `${v.id} 跨越台地边缘（底角落在 ${[...levels].sort().join("/")} 层）`);
    }
  }
  for (const m of sid.markers || []) { if (!isVec3(m.position)) push("error", m.id, `${m.id} 的 position 必须是 [x, y, z]`); else if (!inside(m.position[0], m.position[2])) push("warn", m.id, `${m.id} 超出 bounds`); }
  for (const r of sid.regions || []) {
    if (!Array.isArray(r.polygon) || r.polygon.length < 3) { push("error", r.id, `${r.id} 的多边形少于 3 个点`); continue; }
    for (const [x, z] of r.polygon) if (!inside(x, z)) { push("warn", r.id, `${r.id} 超出 bounds`); break; }
  }
  // 多层空间与连接点（docs/04 §4）
  const spaceById = new Map();
  for (const s of sid.spaces || []) {
    spaceById.set(s.id, s);
    if (!SPACE_KINDS[s.stratum]) push("error", s.id, `${s.id} 的 stratum「${s.stratum}」不是 underground / sky`);
    else if (!SPACE_KINDS[s.stratum].includes(s.kind)) push("warn", s.id, `${s.id} 的 kind「${s.kind}」不在 ${SPACE_KINDS[s.stratum].join("/")}`);
    if (!Array.isArray(s.polygon) || s.polygon.length < 3) { push("error", s.id, `${s.id} 的多边形少于 3 个点`); continue; }
    if (!Number.isFinite(s.floor_y)) push("error", s.id, `${s.id} 的 floor_y 不是数字`);
    if (!(s.height > 0)) push("error", s.id, `${s.id} 的 height 必须大于 0`);
    for (const [x, z] of s.polygon) if (!inside(x, z)) { push("warn", s.id, `${s.id} 超出 bounds`); break; }
  }
  for (const m of sid.markers || []) {
    if (m.kind !== "connector") continue;
    if (!VIAS.includes(m.via)) push("warn", m.id, `${m.id} 的 via「${m.via}」不在 ${VIAS.join("/")}`);
    for (const e of [m.from, m.to]) if (e !== "ground" && !spaceById.has(e)) push("error", m.id, `连接点 ${m.id} 引用了不存在的空间 ${e}`);
    if (m.from === m.to) push("error", m.id, `连接点 ${m.id} 两端相同`);
    if (Number.isFinite(m.top_y) && Number.isFinite(m.bottom_y) && m.top_y < m.bottom_y) push("error", m.id, `连接点 ${m.id} 的 top_y 低于 bottom_y`);
  }
  for (const p of sid.paths || []) {
    if (!Array.isArray(p.points) || p.points.length < 2) push("error", p.id, `${p.id} 的路径少于 2 个点`);
    if (!(p.width > 0)) push("error", p.id, `${p.id} 的宽度必须大于 0`);
  }

  // 光照范围（与 schema 一致）
  const L = (sid.style && sid.style.lighting) || {};
  if (L.sun_azimuth_deg !== undefined && !(Number.isFinite(L.sun_azimuth_deg) && L.sun_azimuth_deg >= 0 && L.sun_azimuth_deg <= 360)) push("error", null, `太阳方位 ${L.sun_azimuth_deg} 不在 0–360`);
  if (L.sun_elevation_deg !== undefined && !(Number.isFinite(L.sun_elevation_deg) && L.sun_elevation_deg >= -10 && L.sun_elevation_deg <= 90)) push("error", null, `太阳高度 ${L.sun_elevation_deg} 不在 −10–90`);
  for (const k of Object.keys(sid.asset_hints || {})) if (!findObject(sid, k)) push("warn", null, `asset_hints 里的「${k}」不对应任何对象`);

  // 体块重叠（y 区间相交且俯视 OBB 相交）
  const vols = (sid.volumes || []).filter((v) => isVec3(v.position) && isVec3(v.size)).map((v) => { const poly = boxCorners(v.position, v.size, v.rotation_y || 0); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return { v, poly, bb: [x0, z0, x1, z1] }; });
  for (let i = 0; i < vols.length; i++) for (let j = i + 1; j < vols.length; j++) {
    const A = vols[i], B = vols[j];
    if (A.bb[0] >= B.bb[2] || B.bb[0] >= A.bb[2] || A.bb[1] >= B.bb[3] || B.bb[1] >= A.bb[3]) continue;
    const ay = [A.v.position[1], A.v.position[1] + A.v.size[1]], by = [B.v.position[1], B.v.position[1] + B.v.size[1]];
    if (ay[1] <= by[0] + 1e-6 || by[1] <= ay[0] + 1e-6) continue;
    if (A.v.kind === "prop" && B.v.kind === "prop" && A.v.generated && B.v.generated) continue; // 林子里树冠挨着树冠是常态
    if (A.v.land && B.v.land) continue; // plan v2 的两个形体之间：编译时已推开，推不开的由 program 的「形体不重叠」检查报
    if (A.v.rests_on === B.v.id || B.v.rests_on === A.v.id || A.v.plinth_of === B.v.id || B.v.plinth_of === A.v.id) continue;
    if (obbOverlap(A.poly, B.poly)) push("warn", A.v.id, `${A.v.id} 与 ${B.v.id} 重叠`);
  }
  // 标记在体块里
  for (const m of sid.markers || []) {
    if (!isVec3(m.position)) continue;
    // 连接点看它在地面的那一端（地下的是上端，空中的是下端）；两端都是空间的不查
    let y = m.position[1];
    if (m.kind === "connector") {
      if (m.from !== "ground" && m.to !== "ground") continue;
      const sp = spaceById.get(m.from === "ground" ? m.to : m.from);
      y = sp && sp.stratum === "underground" && Number.isFinite(m.top_y) ? m.top_y : y;
    }
    for (const { v, poly } of vols) {
      if (y >= v.position[1] + v.size[1] - 0.05 || (m.kind === "connector" && y + 0.5 < v.position[1]) || (m.kind !== "connector" && y + 1.7 <= v.position[1])) continue; // 在它下面（浮空的东西底下）不算
      if (pointInPolygon([m.position[0], m.position[2]], poly)) push("warn", m.id, `${m.id} 在 ${v.id} 内部`);
    }
  }
  // 引用
  for (const r of sid.relations || []) for (const k of ["a", "b"]) if (!findObject(sid, r[k])) push("error", r[k], `关系 ${r.type}(${r.a}, ${r.b}) 引用了不存在的 ${r[k]}`);
  for (const c of sid.constraints || []) {
    for (const t of c.targets || []) if (t !== "*" && !findObject(sid, t)) push("error", t, `约束 ${c.type} 引用了不存在的 ${t}`);
    if (c.from && !findObject(sid, c.from)) push("error", c.from, `约束 ${c.type} 的 from 引用了不存在的 ${c.from}`);
  }
  // faces 一致性：a 的朝向向量应大致指向 b
  for (const r of sid.relations || []) {
    if (r.type !== "faces") continue;
    const fa = findObject(sid, r.a), fb = findObject(sid, r.b);
    if (!fa || !fb || !("rotation_y" in fa.obj)) continue;
    const [ax, az] = objCenter(fa.coll, fa.obj);
    // 朝向路时看最近的路点，而不是整条路的中心
    const [bx, bz] = fb.coll === "paths" ? nearestOnPolyline([ax, az], fb.obj.points) : objCenter(fb.coll, fb.obj);
    const t = (fa.obj.rotation_y || 0) * DEG, fx = -Math.sin(t), fz = -Math.cos(t);
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (fx * dx + fz * dz) / len))) / DEG;
    if (ang > 45) push("warn", r.a, `${r.a} 应朝向 ${r.b}，但朝向偏了 ${Math.round(ang)}°（改 rotation_y）`);
  }
  // adjacent 间距
  for (const r of sid.relations || []) {
    if (r.type !== "adjacent") continue;
    const fa = findObject(sid, r.a), fb = findObject(sid, r.b);
    if (!fa || !fb) continue;
    const [ax, az] = objCenter(fa.coll, fa.obj), [bx, bz] = objCenter(fb.coll, fb.obj);
    const half = (f) => (f.coll === "volumes" ? Math.hypot(f.obj.size[0], f.obj.size[2]) / 2 : f.coll === "regions" ? Math.hypot(...extent(f.obj.polygon)) / 2 : 0);
    const gap = Math.hypot(bx - ax, bz - az) - half(fa) - half(fb);
    if (gap > 4) push("warn", r.a, `${r.a} 与 ${r.b} 标为 adjacent，但间距约 ${Math.round(gap)} m`);
  }
  if (!(sid.markers || []).some((m) => m.kind === "player_spawn")) push("warn", null, "没有 player_spawn 标记");
  if (!out.length) push("ok", null, "没有发现问题");
  return out;
}

/** 折线上离 p 最近的点 */
function nearestOnPolyline(p, pts) {
  let best = pts[0], bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
    const q = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
