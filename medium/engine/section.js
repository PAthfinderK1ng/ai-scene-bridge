// section.js — 自选剖切（D19）：沿主路或一条直线、带宽度，把带内的体块 / 空间 / 连接点 / 路投到剖面上。
// 规格见 docs/04 §5、SPEC.md §11。纯函数、确定性；不调 AI。
import { clamp, r2, pointInPolygon, distToPolygon, polygonCentroid, DEFAULT_BOUNDS } from "./terrain.js";
import { boxCorners, ringOf } from "./layout.js";

export const SECTION_WIDTH = Object.freeze({ min: 2, max: 60, default: 12 });
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** 宽度夹到 2–60 m（取整到 1 m）；非数字给默认 12 */
export function widthClamp(w) { const n = Number(w); return Number.isFinite(n) ? clamp(Math.round(n), SECTION_WIDTH.min, SECTION_WIDTH.max) : SECTION_WIDTH.default; }

function mainTrail(sid) {
  const ps = (sid.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  return ps.find((p) => p.id === "main_trail") || ps.find((p) => p.kind === "trail" || p.kind === "road") || null;
}
/** 南北中线（自南向北，和沿主路「入口 → 地标」同向） */
function centerLine(sid) {
  const b = sid.bounds || DEFAULT_BOUNDS, x = r2((b.min[0] + b.max[0]) / 2);
  return [[x, b.max[2] - 2], [x, b.min[2] + 2]];
}

/**
 * 默认剖切：沿主路，宽 12 m；line 预置为主路首尾两点（没有主路时为南北中线），切到直线模式时直接可用。
 * @returns {{mode: "trail", line: number[][], width_m: number}}
 */
export function defaultSection(sid, T) {
  const t = mainTrail(sid);
  const line = t ? [t.points[0].slice(0, 2), t.points[t.points.length - 1].slice(0, 2)].map((p) => p.map(r2)) : centerLine(sid);
  if (dist2(line[0], line[1]) < 1) return { mode: "trail", line: centerLine(sid), width_m: SECTION_WIDTH.default };
  return { mode: "trail", line, width_m: SECTION_WIDTH.default };
}

/**
 * 剖切折线：trail 模式取主路折线（没有主路退回南北中线）；line 模式取 section.line 两点（不合法退回南北中线）。
 * @returns {number[][]} [[x,z], ...]
 */
export function sectionPath(section, sid) {
  const s = section || {};
  if (s.mode === "line") return Array.isArray(s.line) && s.line.length >= 2 && isPt(s.line[0]) && isPt(s.line[1]) && dist2(s.line[0], s.line[1]) >= 1 ? [s.line[0].slice(0, 2), s.line[1].slice(0, 2)] : centerLine(sid);
  const t = mainTrail(sid);
  return t ? t.points.map((p) => [p[0], p[1]]) : centerLine(sid);
}

/**
 * 点到折线的投影：最近点给出弧长 d 与横向距离 off（米）。
 * @returns {{d: number, off: number, q: number[]}}
 */
export function projectToPath(path, p) {
  let best = { d: 0, off: Infinity, q: path[0] }, acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const t = L < 1e-9 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (L * L), 0, 1);
    const q = [a[0] + t * dx, a[1] + t * dz], off = dist2(p, q);
    if (off < best.off - 1e-9) best = { d: acc + t * L, off, q };
    acc += L;
  }
  return best;
}
function pathLength(path) { let L = 0; for (let i = 0; i < path.length - 1; i++) L += dist2(path[i], path[i + 1]); return L; }
/** 线段交点参数（t ∈ [0,1] 在 ab 上）；不相交 null */
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
/** 一组点投影后的 [d0, d1]；折线拐弯处投影会跳段，跨度超过形状本身尺寸 + 2 m 时改用中心投影 ± 半尺寸 */
function dRange(path, pts, center, extent) {
  const ds = pts.map((p) => projectToPath(path, p).d);
  let d0 = Math.min(...ds), d1 = Math.max(...ds);
  if (d1 - d0 > extent * 1.5 + 2) { const dc = projectToPath(path, center).d; d0 = dc - extent / 2; d1 = dc + extent / 2; }
  return [r2(d0), r2(d1)];
}

/**
 * 空间内部投到剖面（docs/04 §8.3）：带内的通道按连续段切成 [d0, d1]（两端各加半个宽），房间取多边形投影，层间连接给竖线位置。
 * @returns {{passages: object[], rooms: object[], links: object[]}}
 *   passages: [{ id, sublevel, d0, d1, floor_y, height, width }]；rooms: [{ id, sublevel, role, label, d0, d1, floor_y, height }]；
 *   links: [{ id, d, from, to, via, y0, y1 }]（y0 = 下层底面，y1 = 上层底面 + 净高）
 */
export function interiorBand(s, path, halfW) {
  const H = Number(s.height) || 3, step = H + (s.stratum === "sky" ? 1 : 2), fl = (k) => r2((Number(s.floor_y) || 0) + k * step);
  const passages = [], rooms = [], links = [];
  for (const p of s.passages || []) {
    if (!p || !Array.isArray(p.points) || p.points.length < 2 || !p.points.every(isPt)) continue;
    const w = Number(p.width) || 2, lim = halfW + w / 2;
    let run = null, k = 0;
    const flush = () => { if (run) passages.push({ id: p.id + (k++ ? "_" + k : ""), sublevel: p.sublevel | 0, d0: r2(run[0] - w / 2), d1: r2(run[1] + w / 2), floor_y: Number.isFinite(p.floor_y) ? p.floor_y : fl(p.sublevel | 0), height: Number(p.height) > 0 ? p.height : H, width: w }); run = null; };
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = p.points[i], b = p.points[i + 1], n = Math.max(1, Math.ceil(dist2(a, b) / 0.5));
      for (let j = i ? 1 : 0; j <= n; j++) {
        const q = [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n], pr = projectToPath(path, q);
        if (pr.off <= lim) { if (!run) run = [pr.d, pr.d]; else { if (Math.abs(pr.d - run[1]) > 3 + w && Math.abs(pr.d - run[0]) > 3 + w) { flush(); run = [pr.d, pr.d]; } else { run[0] = Math.min(run[0], pr.d); run[1] = Math.max(run[1], pr.d); } } }
        else flush();
      }
    }
    flush();
  }
  for (const r of s.rooms || []) {
    if (!r || !Array.isArray(r.polygon) || r.polygon.length < 3) continue;
    const c = polygonCentroid(r.polygon), offs = [c, ...r.polygon].map((q) => projectToPath(path, q).off);
    if (Math.min(...offs) > halfW && !path.some((q) => pointInPolygon(q, r.polygon))) continue;
    const xs = r.polygon.map((q) => q[0]), zs = r.polygon.map((q) => q[1]);
    const [d0, d1] = dRange(path, r.polygon, c, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)));
    rooms.push({ id: r.id, sublevel: r.sublevel | 0, role: r.role || "chamber", label: r.label || "", d0, d1, floor_y: Number.isFinite(r.floor_y) ? r.floor_y : fl(r.sublevel | 0), height: Number(r.height) > 0 ? r.height : H });
  }
  for (const l of s.links || []) {
    if (!l || !isPt(l.at)) continue;
    const pr = projectToPath(path, l.at);
    if (pr.off > halfW) continue;
    const lo = Math.min(l.from | 0, l.to | 0), hi = Math.max(l.from | 0, l.to | 0);
    links.push({ id: l.id, d: r2(pr.d), from: lo, to: hi, via: l.via || "ladder", y0: fl(lo), y1: r2(fl(hi) + H) });
  }
  return { passages, rooms, links };
}

/**
 * 沿剖切线采样（docs/04 §5）。
 * @param {object} sid
 * @param {object} T buildTerrain 结果
 * @param {{mode, line, width_m}} [section] 省略时用 sid.meta.section，再省略用 defaultSection
 * @returns {{path, length_m, width_m, ground, terraces, volumes, spaces, connectors, paths}}
 *   ground: [{ d, h, x, z, terrace_id, level }] 每 1 m；terraces: 剖切线穿过的台地平台段 [{ id, level, height, d0, d1, user_height }]；
 *   volumes: 带内体块 [{ id, kind, importance, d0, d1, y0, y1, label, segs? }]（segs = 环带在剖切线上的几段 [[d0, d1], …]，中间是孔）；spaces: [{ id, stratum, kind, layout, sublevels, d0, d1, floor_y, height, label, passages, rooms, links }]（内部见 interiorBand）；
 *   connectors: [{ id, via, d, top_y, bottom_y }]；paths: 与剖切线相交的路 / 溪 [{ id, kind, d }]
 */
export function sampleSection(sid, T, section) {
  const sec = section || (sid.meta && sid.meta.section) || defaultSection(sid, T);
  const width = widthClamp(sec.width_m), halfW = width / 2;
  const path = sectionPath(sec, sid), length_m = r2(pathLength(path));
  const raw = T.sampleProfile(path, 1);

  const ground = raw.map((s) => {
    const t = T.terraceAt(s.x, s.z);
    return { d: r2(s.d), h: r2(s.h), x: r2(s.x), z: r2(s.z), terrace_id: t ? t.id : null, level: t ? t.level : T.levelAt(s.x, s.z) };
  });
  const terraces = [];
  for (let i = 0; i < ground.length; i++) {
    const g = ground[i];
    if (!g.terrace_id) continue;
    const last = terraces[terraces.length - 1];
    if (last && last.id === g.terrace_id && last._i === i - 1) { last.d1 = g.d; last._i = i; continue; }
    const t = T.terraces.find((tt) => tt.id === g.terrace_id);
    terraces.push({ id: t.id, level: t.level, height: r2(t.height), d0: g.d, d1: g.d, user_height: !!(t.feature && t.feature.user_height), _i: i });
  }
  const terraceSegs = terraces.filter((t) => t.d1 > t.d0).map(({ _i, ...t }) => t);

  const volumes = [];
  for (const v of sid.volumes || []) {
    if (!v || !Array.isArray(v.position) || !Array.isArray(v.size)) continue;
    const size = [v.size[0], v.size[1], v.size[2] > 0 ? v.size[2] : v.size[0]]; // 圆形体 size = [直径, 高]（v5）
    const c = [v.position[0], v.position[2]], corners = boxCorners(v.position, size, v.rotation_y || 0);
    const offs = [c, ...corners].map((p) => projectToPath(path, p).off);
    if (Math.min(...offs) > halfW) continue;
    const [d0, d1] = dRange(path, corners, c, Math.hypot(size[0], size[2]));
    const y0 = Math.max(Number(v.position[1]) || 0, T.heightAt(c[0], c[1]));
    const sv = { id: v.id, kind: v.kind, importance: v.importance || null, d0, d1, y0: r2(y0), y1: r2(y0 + v.size[1]), label: v.label || "" };
    const R = ringOf(v);
    if (R && !R.torus && R.ix > 0.05) { // 空心圆柱 / 环带：剖切线在带子上的几段（穿过内孔 = 两段壁，中间是空的）；沿主路的折线绕着走也对
      const Ro = Math.max(R.rx, R.rz), Ri = Math.min(R.ix, R.iz), segs = [];
      let cur = null;
      for (const q of raw) { const dc = Math.hypot(q.x - c[0], q.z - c[1]); if (dc <= Ro && dc >= Ri) { if (cur && q.d - cur[1] <= 1.01) cur[1] = q.d; else segs.push((cur = [q.d, q.d])); } else cur = null; }
      if (segs.length) { sv.segs = segs.map(([a, b]) => [r2(Math.max(0, a - 0.5)), r2(Math.min(length_m, b + 0.5))]); sv.d0 = sv.segs[0][0]; sv.d1 = sv.segs[sv.segs.length - 1][1]; }
    }
    volumes.push(sv);
  }

  const spaces = [];
  for (const s of sid.spaces || []) {
    if (!s || !Array.isArray(s.polygon) || s.polygon.length < 3) continue;
    const near = s.polygon.some((p) => projectToPath(path, p).off <= halfW) || raw.some((r) => pointInPolygon([r.x, r.z], s.polygon) || distToPolygon([r.x, r.z], s.polygon) <= halfW);
    if (!near) continue;
    const xs = s.polygon.map((p) => p[0]), zs = s.polygon.map((p) => p[1]);
    const ext = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    const c = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2];
    const [d0, d1] = dRange(path, s.polygon, c, ext);
    spaces.push(Object.assign({ id: s.id, stratum: s.stratum, kind: s.kind, layout: s.layout || null, sublevels: Number(s.sublevels) || 1, d0, d1, floor_y: s.floor_y, height: s.height, label: s.label || "" }, interiorBand(s, path, halfW)));
  }

  const connectors = [];
  for (const m of sid.markers || []) {
    if (!m || m.kind !== "connector" || !Array.isArray(m.position)) continue;
    const pr = projectToPath(path, [m.position[0], m.position[2]]);
    if (pr.off > halfW) continue;
    connectors.push({ id: m.id, via: m.via, d: r2(pr.d), top_y: m.top_y, bottom_y: m.bottom_y });
  }

  const paths = [];
  const self = sec.mode === "line" ? null : mainTrail(sid);
  for (const p of sid.paths || []) {
    if (!p || p === self || p.unrouted || !Array.isArray(p.points) || p.points.length < 2) continue;
    let acc = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], L = dist2(a, b);
      for (let k = 0; k < p.points.length - 1; k++) { const t = segX(a, b, p.points[k], p.points[k + 1]); if (t !== null) paths.push({ id: p.id, kind: p.kind, d: r2(acc + t * L) }); }
      acc += L;
    }
  }
  paths.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  return { path, length_m, width_m: width, ground, terraces: terraceSegs, volumes, spaces, connectors, paths };
}

/**
 * 旋转剖切线（俯视逆时针为正，与 rotation_y 同向）。trail 模式先换成直线模式（用 section.line）。不改入参。
 * @param {{mode, line, width_m}} section
 * @param {number} deg
 * @param {number[]} [pivot] 默认直线中点
 * @returns {{mode: "line", line: number[][], width_m: number}}
 */
export function rotateSection(section, deg, pivot) {
  const line = section && Array.isArray(section.line) && section.line.length >= 2 ? section.line : [[0, 58], [0, -58]];
  const pv = isPt(pivot) ? pivot : [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  const t = (Number(deg) || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const rot = ([x, z]) => { const dx = x - pv[0], dz = z - pv[1]; return [r2(pv[0] + dx * c + dz * s), r2(pv[1] - dx * s + dz * c)]; };
  return { mode: "line", line: [rot(line[0]), rot(line[1])], width_m: widthClamp(section && section.width_m) };
}
