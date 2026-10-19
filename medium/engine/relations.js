// relations.js — 关系与检查：自动生成 relations、固定顺序的 checks、视线（lineOfSight）与可达性（reachable）；v6：引用的事实 describeRef、改动摘要 diffCompiled（docs/07 §1）
// 约定见 SPEC.md 第 4 节。纯函数、确定性（没有随机）；LLM 不写坐标，fixes 的 patch 也只做几何推导后直接改 sid。
import { buildTerrain, pointInPolygon, distToPolyline, distToPolygon, distToSegment, polygonCentroid, r2 } from "./terrain.js";
import { boxCorners, obbOverlap, findObject } from "./validate.js";
import { houseFacing, rectToRectDist, ringOf, ringPoly } from "./layout.js";

/** 可以走的路类型（溪、墙线、围栏不是走廊） */
export const WALK_KINDS = new Set(["road", "trail", "bridge", "other"]);
/** checks 的固定顺序 */
export const CHECK_ORDER = ["spawn_sees_landmark", "trail_reaches_landmark", "landmark_on_top", "houses_no_overlap", "houses_clear_of_paths", "houses_on_terraces", "terraces_reachable"];

const xz = (pos) => [pos[0], pos[2]];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const footprint = (v) => boxCorners(v.position, v.size, v.rotation_y || 0);

// ------------------------------------------------------------ 体块与几何小工具
/**
 * 体块底面高度：取 position.y 与地面高度的较大者（兼容 y 还没贴地的样例，体块不会沉到地下）。
 * @param {object} T buildTerrain 结果
 * @param {object} v 体块
 * @returns {number}
 */
export function volumeBase(T, v) { return Math.max(Number(v.position[1]) || 0, T.heightAt(v.position[0], v.position[2])); }
/** 体块顶面高度 */
export function volumeTop(T, v) { return volumeBase(T, v) + (v.size ? v.size[1] : 0); }

function segIntersect(a, b, c, d) {
  const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segSegDist(a, b, c, d) {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}
/** 凸多边形（房子底面）到折线的最短距离；折线穿过或顶点落在多边形内为 0 */
export function polyToPolylineDist(poly, pts) {
  for (const p of pts) if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, segSegDist(poly[i], poly[(i + 1) % poly.length], pts[k], pts[k + 1]));
  return d;
}
/** 折线每 step 米采样（含终点） */
function samplePolyline(pts, step = 1) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]); }
  }
  if (pts.length) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// ------------------------------------------------------------ 角色识别
/**
 * 找出场景里的主要角色：地标、出生点、主路、房子、可走的路。
 * @param {object} sid
 * @returns {{landmark: object|null, spawn: object|null, trail: object|null, houses: object[], walkPaths: object[]}}
 */
export function findActors(sid) {
  const vols = (sid.volumes || []).filter((v) => v && v.position && v.size);
  // 多个地标（plan）时，主地标 = meta.focus（出生点第一眼看的那个），否则第一个
  const focus = sid.meta && sid.meta.focus;
  const landmark = (focus && vols.find((v) => v.id === focus && v.importance === "landmark")) || vols.find((v) => v.importance === "landmark") || vols.find((v) => v.id === "landmark") || null;
  const spawn = (sid.markers || []).find((m) => m.kind === "player_spawn") || null;
  const paths = (sid.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  const walkPaths = paths.filter((p) => WALK_KINDS.has(p.kind) && !p.unrouted);
  const v2 = !!(sid.meta && sid.meta.plan_mode && Number(sid.meta.plan_version) >= 2);
  const trail = paths.find((p) => p.id === "main_trail") || (v2 ? null : walkPaths[0]) || null; // v2：只认 main_trail（桥 / 索桥不是主路）
  // plan v2：plan 自己写的形体不算「房子」（它们有自己的检查），只有布房生成的 / 人放的才算
  const houses = vols.filter((v) => v.kind === "building" && v !== landmark && v.importance !== "landmark" && (!v2 || !v.plan_id || v.generated));
  return { landmark, spawn, trail, houses, walkPaths };
}

// ------------------------------------------------------------ 视线
/**
 * 视线：从 from 处 eye 米高看向 to 处 targetHeight 米高（两者都相对地面）。
 * 沿线每 1 m 采样：地面 + 0.3 高过视线 → 被地形挡；落在某体块 OBB 内且视线低于体块顶 → 被该体块挡。
 * 包含 from 或 to 的体块（观察者所在 / 目标本身）自动忽略；opts.ignore 可再给 id 列表。
 * @param {object} T
 * @param {object[]} volumes sid.volumes
 * @param {number[]} from [x, z]
 * @param {number[]} to [x, z]
 * @param {{eye?: number, targetHeight?: number, ignore?: string[], fromY?: number, toY?: number}} [opts] fromY / toY：绝对高度（站在浮岛上看、看悬空的东西），给了就不按地面 + eye 算
 * @returns {{visible: boolean, blockedBy: "terrain"|string|null, at: number[]|null}} blockedBy 为 "volume:<id>" 或 "terrain"
 */
export function lineOfSight(T, volumes, from, to, opts = {}) {
  const eye = opts.eye ?? 1.7, th = opts.targetHeight ?? 1.7, ignore = new Set(opts.ignore || []);
  const h0 = Number.isFinite(opts.fromY) ? opts.fromY : T.heightAt(from[0], from[1]) + eye, h1 = Number.isFinite(opts.toY) ? opts.toY : T.heightAt(to[0], to[1]) + th;
  const boxes = (volumes || []).filter((v) => v && v.position && v.size && !ignore.has(v.id))
    .map((v) => ({ id: v.id, poly: footprint(v), top: volumeTop(T, v), base: volumeBase(T, v), wedge: v.shape === "wedge" || v.kind === "stairs" ? v : null }))
    .filter((b) => !pointInPolygon(from, b.poly) && !pointInPolygon(to, b.poly));
  const L = dist2(from, to), n = Math.max(1, Math.ceil(L));
  for (let k = 1; k < n; k++) { // 跳过两端本身
    const t = k / n, x = from[0] + (to[0] - from[0]) * t, z = from[1] + (to[1] - from[1]) * t, lh = h0 + (h1 - h0) * t;
    if (T.heightAt(x, z) + 0.3 > lh) return { visible: false, blockedBy: "terrain", at: [r2(x), r2(z)] };
    for (const b of boxes) if (lh < (b.wedge ? wedgeTop(b, x, z) : b.top) && lh > b.base - 0.05 && pointInPolygon([x, z], b.poly)) return { visible: false, blockedBy: "volume:" + b.id, at: [r2(x), r2(z)] };
  }
  return { visible: true, blockedBy: null, at: null };
}

/** 楔 / 台阶在 (x, z) 处的顶面高度：前面（局部 −z，门的一侧）最高，后面落到底 */
function wedgeTop(b, x, z) {
  const v = b.wedge, t = ((v.rotation_y || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), dx = x - v.position[0], dz = z - v.position[2];
  const lz = dx * s + dz * c, d = v.size[2] || 1;
  return b.base + (b.top - b.base) * Math.max(0, Math.min(1, (d / 2 - lz) / d));
}

// ------------------------------------------------------------ 可达性（网格 BFS）
/**
 * 从 from 出发的可达集合（内部复用：analyze 只跑一次 BFS 检查多个目标）。
 * 可走格 = 坡度 ≤ maxSlope 或在任一可走路的走廊内（距折线 ≤ 宽/2 + 1）或在 opts.walkPolys 任一多边形内
 * （例如地标底面：站到门前就算到了地标，不要求再爬进地标中心格）。
 * 相邻两格之间的移动还要求台阶坡度 |Δh|/距离 ≤ maxSlope，除非其中一格在走廊内（路可以爬坡）。
 * @param {object} T
 * @param {object[]} paths sid.paths（自动排除 river / wall_line / fence）
 * @param {number[]} from [x, z]
 * @param {{maxSlope?: number, res?: number, walkPolys?: number[][][]}} [opts]
 * @returns {{at: (x: number, z: number) => boolean, reached: Uint8Array, nx: number, nz: number, res: number}}
 */
export function reachSet(T, paths, from, opts = {}) {
  const maxSlope = opts.maxSlope ?? 0.7, res = opts.res ?? 2, walkPolys = opts.walkPolys || [];
  const nx = Math.floor((T.xmax - T.xmin) / res) + 1, nz = Math.floor((T.zmax - T.zmin) / res) + 1;
  const corridors = (paths || []).filter((p) => p && WALK_KINDS.has(p.kind) && !p.unrouted && Array.isArray(p.points) && p.points.length >= 2).map((p) => ({ pts: p.points, r: (p.width || 2) / 2 + 1 }));
  const cellOf = (x, z) => [Math.round(Math.max(0, Math.min(nx - 1, (x - T.xmin) / res))), Math.round(Math.max(0, Math.min(nz - 1, (z - T.zmin) / res)))];
  const state = new Uint8Array(nx * nz); // 0 未算，1 可走（坡度），2 可走（走廊），3 不可走
  const hgt = new Float32Array(nx * nz);
  const info = (i, j) => {
    const k = j * nx + i;
    if (state[k]) return state[k];
    const x = T.xmin + i * res, z = T.zmin + j * res;
    hgt[k] = T.heightAt(x, z);
    let s = T.slopeAt(x, z) <= maxSlope ? 1 : 3;
    for (const c of corridors) if (distToPolyline([x, z], c.pts) <= c.r) { s = 2; break; }
    if (s !== 2) for (const poly of walkPolys) if (pointInPolygon([x, z], poly)) { s = 2; break; }
    state[k] = s;
    return s;
  };
  const reached = new Uint8Array(nx * nz);
  const [si, sj] = cellOf(from[0], from[1]);
  const queue = [si, sj];
  info(si, sj); if (state[sj * nx + si] === 3) state[sj * nx + si] = 1; // 起点总是可站
  reached[sj * nx + si] = 1;
  for (let q = 0; q < queue.length; q += 2) {
    const i = queue[q], j = queue[q + 1], k = j * nx + i, sc = state[k];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const nk = nj * nx + ni;
      if (reached[nk]) continue;
      const sn = info(ni, nj);
      if (sn === 3) continue;
      if (sc !== 2 && sn !== 2 && Math.abs(hgt[nk] - hgt[k]) / (res * Math.hypot(di, dj)) > maxSlope) continue;
      reached[nk] = 1; queue.push(ni, nj);
    }
  }
  return { reached, nx, nz, res, at(x, z) { const [i, j] = cellOf(x, z); return reached[j * nx + i] === 1; } };
}

/**
 * from 能否走到 to（SPEC §4）。
 * @param {object} T
 * @param {object[]} paths sid.paths
 * @param {number[]} from [x, z]
 * @param {number[]} to [x, z]
 * @param {{maxSlope?: number, res?: number}} [opts] 默认 maxSlope 0.7、res 2
 * @returns {boolean}
 */
export function reachable(T, paths, from, to, opts = {}) { return reachSet(T, paths, from, opts).at(to[0], to[1]); }

/** 地标底面外扩 1 m 的四边形：BFS 里视为可走（走到门前 = 到达地标） */
export function landmarkWalk(landmark) { return landmark ? [boxCorners(landmark.position, [landmark.size[0] + 2, landmark.size[1], landmark.size[2] + 2], landmark.rotation_y || 0)] : []; }

/**
 * 找出「没有路可达」的台地（terraces_reachable 的事实部分，sid.resolve 用它自动补支路）。
 * 判定：台地多边形 10 m 内有可走路的采样点，且从出生点（无出生点则主路起点）BFS 可达台地内的目标点。
 * 目标点 = 台地内离质心最近的路点；没有路点在台地内则取质心（质心不在多边形内时取第一个顶点）。
 * @param {object} sid
 * @param {object} T buildTerrain 结果
 * @param {{R?: object}} [opts] 可复用已算好的 reachSet
 * @returns {{origin: number[]|null, R: object|null, failing: {t: object, target: number[], nearPt: number[]|null, why: string}[]}}
 */
/**
 * 人在图上手调高度抬出来的小鼓包（地形操作 hand_* /「手调高度 N」）不算要连路的台地：
 * 只有高过一层、而且上面有东西（体块中心在台地里）时才当台地查可达、补支路。
 */
function handBump(sid, T, t) {
  const f = t.feature || {};
  if (!/^hand_\d+$/.test(t.plan_id || f.plan_id || "") && !/^手调高度/.test(f.label || "")) return false;
  if (Math.abs(t.height || 0) <= (T.layer || 4) + 1e-6) return true;
  return !(sid.volumes || []).some((v) => v && v.plan_id && !v.generated && v.position && pointInPolygon([v.position[0], v.position[2]], t.polygon));
}
export function unreachedTerraces(sid, T, opts = {}) {
  const { landmark, spawn, trail, walkPaths } = findActors(sid);
  const origin = spawn ? xz(spawn.position) : trail ? trail.points[0] : null;
  if (!origin) return { origin: null, R: null, failing: [] };
  const R = opts.R || reachSet(T, sid.paths || [], origin, { walkPolys: landmarkWalk(landmark) });
  const roadPts = walkPaths.flatMap((p) => samplePolyline(p.points, 1));
  const failing = [];
  for (const t of T.terraces) {
    if (handBump(sid, T, t)) continue;
    let nearPt = null, nd = Infinity, insidePt = null, idn = Infinity;
    for (const p of roadPts) {
      if (pointInPolygon(p, t.polygon)) { const d = dist2(p, t.centroid); if (d < idn) { idn = d; insidePt = p; } nd = 0; nearPt = nearPt || p; continue; }
      const d = distToPolygon(p, t.polygon); if (d < nd) { nd = d; nearPt = p; }
    }
    const target = insidePt || (pointInPolygon(t.centroid, t.polygon) ? t.centroid : t.polygon[0]);
    const near = nd <= 10, reach = R.at(target[0], target[1]);
    if (!(near && reach)) failing.push({ t, target, nearPt, why: !near ? "10 m 内没有主路" : "有路点但走不到" });
  }
  return { origin, R, failing };
}

// ------------------------------------------------------------ analyze
/**
 * 分析 sid：自动生成 relations（on_top_of / faces / adjacent / visible_from / connects）和固定顺序的 checks。
 * checks[].fixes[].patch(sid) 直接改传入的 sid（按 id 查对象），不重新布局，调用方再 resolve。
 * 把 check id 放进 sid.meta.ignored_checks 表示「不重要」：ok 仍按事实算，但 check.ignored = true。
 * @param {object} sid
 * @param {object} [T] buildTerrain(sid) 的结果；省略则内部构建
 * @returns {{relations: {type: string, a: string, b: string, generated: true}[], checks: object[]}}
 */
export function analyze(sid, T) {
  T = T || buildTerrain(sid, { res: 2 });
  const { landmark, spawn, trail, houses, walkPaths } = findActors(sid);
  const vols = (sid.volumes || []).filter((v) => v && v.position && v.size);
  const planMode = !!(sid.meta && sid.meta.plan_mode);
  const lmName = landmark ? landmark.label || landmark.id : "地标";
  const lmXZ = landmark ? xz(landmark.position) : null, spXZ = spawn ? xz(spawn.position) : null;
  const relations = [];
  const rel = (type, a, b) => relations.push({ type, a, b, generated: true });

  // 关系只引用 sid 里有的东西：雕刻出的台阶面（rise_1、rise_2 …）不是 sid 对象，归到它所属的地形操作（rise）上
  const terraceRef = (t) => !t ? null : findObject(sid, t.id) ? t.id : t.feature && findObject(sid, t.feature.id) ? t.feature.id : null;
  // on_top_of：房 / 地标 → 所在台地
  for (const v of [...(landmark ? [landmark] : []), ...houses]) { const t = terraceRef(T.terraceAt(v.position[0], v.position[2])); if (t) rel("on_top_of", v.id, t); }
  // faces：房 → 最近的路（走廊）或地标，40 m 内才算
  for (const h of houses) {
    const c = xz(h.position);
    let best = null, bd = 40;
    for (const p of walkPaths) { const d = distToPolyline(c, p.points); if (d < bd) { bd = d; best = p.id; } }
    if (landmark) { const d = dist2(c, lmXZ); if (d < bd) { bd = d; best = landmark.id; } }
    if (best) rel("faces", h.id, best);
  }
  // adjacent：房与房中心距 < 10 m
  for (let i = 0; i < houses.length; i++) for (let j = i + 1; j < houses.length; j++) if (dist2(xz(houses[i].position), xz(houses[j].position)) < 10) rel("adjacent", houses[i].id, houses[j].id);
  // visible_from：地标 ← 出生点
  let los = null;
  if (landmark && spawn) {
    const eye = Number(sid.meta && sid.meta.player_height) || 1.7, v2 = Number(sid.meta && sid.meta.plan_version) >= 2;
    los = lineOfSight(T, vols, spXZ, lmXZ, Object.assign({ eye, targetHeight: volumeTop(T, landmark) - T.heightAt(lmXZ[0], lmXZ[1]), ignore: [landmark.id] }, v2 ? { fromY: spawn.position[1] + eye, toY: volumeTop(T, landmark) - 0.3 } : {}));
    if (los.visible) rel("visible_from", landmark.id, spawn.id);
  }
  // connects：主路 → 它经过的台地（按高度升序）
  const trailPts = trail ? samplePolyline(trail.points, 1) : [];
  if (trail) {
    const seen = new Map();
    for (const p of trailPts) { const t = T.terraceAt(p[0], p[1]), id = terraceRef(t); if (id && !seen.has(id)) seen.set(id, t); }
    for (const [id] of [...seen.entries()].sort((a, b) => a[1].height - b[1].height)) rel("connects", trail.id, id);
  }

  // 一次 BFS，多个目标复用；地标底面视为可走（走到门前就算到）
  const origin = spXZ || (trail ? trail.points[0] : null);
  // plan 里有多个地标（寨门在崖边、风雨桥跨溪）：每个地标底面都算可走
  const walkPolys = planMode ? vols.filter((v) => v.importance === "landmark").flatMap(landmarkWalk) : landmarkWalk(landmark);
  const R = origin ? reachSet(T, sid.paths || [], origin, { walkPolys }) : null;
  const ignored = new Set((sid.meta && sid.meta.ignored_checks) || []);
  const ignoreFix = (id) => ({ label: "不重要", patch(s) { s.meta = s.meta || {}; const arr = (s.meta.ignored_checks = s.meta.ignored_checks || []); if (!arr.includes(id)) arr.push(id); } });
  const mk = (id, text, ok, detail, severity, fixes) => Object.assign({ id, text, ok, detail, severity, fixes }, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {});
  const checks = [];

  // 1. spawn_sees_landmark
  if (!landmark || !spawn) checks.push(mk("spawn_sees_landmark", `出生点 能看见 ${lmName}`, false, !landmark ? "缺少地标（importance: landmark）" : "缺少出生点（player_spawn）", "warn", []));
  else {
    const detail = los.visible ? "视线通畅" : los.blockedBy === "terrain" ? `被地形挡住（约 ${los.at} 处）` : `被 ${los.blockedBy.slice(7)} 挡住（约 ${los.at} 处）`;
    checks.push(mk("spawn_sees_landmark", `出生点 能看见 ${lmName}`, los.visible, detail, "warn", [
      { label: "地标再高一层", patch(s) { const f = findObject(s, landmark.id); if (f) f.obj.size[1] = r2(f.obj.size[1] + T.layer); } },
      { label: "出生点挪到路口", patch(s) { moveSpawnToVisiblePoint(s, T, landmark.id, spawn.id, trail ? trail.id : null); } },
      ignoreFix("spawn_sees_landmark"),
    ]));
  }
  // 2. trail_reaches_landmark（plan：主路到它自己的终点 meta.trail_target；终点不是地标时只看终点可达）
  const goalId = planMode && sid.meta.trail_target;
  const goal = goalId ? vols.find((v) => v.id === goalId) || null : planMode && Number(sid.meta.plan_version) >= 2 ? null : landmark;
  if (planMode && Number(sid.meta.plan_version) >= 2 && !trail) { /* v2 没有主路（天上 / 都走桥）：可达性由 program 的 reach_* 检查 */ }
  else if (planMode && trail && !goal) {
    const last = trail.points[trail.points.length - 1], ok = R ? R.at(last[0], last[1]) : false;
    checks.push(mk("trail_reaches_landmark", `主路 能走到头`, ok, ok ? "主路终点可达" : "主路终点从出生点走不到", "error", [ignoreFix("trail_reaches_landmark")]));
  } else if (!goal || !trail) checks.push(mk("trail_reaches_landmark", `主路 能到达 ${lmName}`, false, !goal ? "缺少地标" : "缺少主路（main_trail）", "error", []));
  else {
    const landmark = goal, lmXZ = xz(goal.position), lmName = goal.label || goal.id;
    // 可达目标 = 地标中心格或主路终点格（门前点）：地标贴台地边缘时中心格可能落在坡裙另一侧，不该算走不到
    // 距离按地标底面算（桥 / 长廊这种长条，路接在桥头而不是桥中间）
    const foot = boxCorners(goal.position, goal.size, goal.rotation_y || 0).map((p) => [p[0], p[1]]);
    const last = trail.points[trail.points.length - 1], dEnd = pointInPolygon(last, foot) ? 0 : distToPolygon(last, foot);
    const reach = R ? R.at(lmXZ[0], lmXZ[1]) || R.at(last[0], last[1]) : false;
    const ok = dEnd < 6 && reach;
    const detail = ok ? `主路终点离地标底面 ${r2(dEnd)} m，可达` : dEnd >= 6 ? `主路终点离地标底面 ${r2(dEnd)} m（需 < 6 m）` : "主路终点在地标旁，但从出生点走不到（坡太陡且无路）";
    checks.push(mk("trail_reaches_landmark", `主路 能到达 ${lmName}`, ok, detail, "error", [
      { label: "把路接到地标", patch(s) { const p = findObject(s, trail.id), l = findObject(s, landmark.id); if (p && l) p.obj.points[p.obj.points.length - 1] = [r2(l.obj.position[0]), r2(l.obj.position[2])]; } },
      ignoreFix("trail_reaches_landmark"),
    ]));
  }
  // 3. landmark_on_top（plan 里地标放在哪由 place 说了算，换成 plan.js 的「放置」检查）
  const top = T.topTerrace();
  if (planMode) { /* 跳过 */ } else if (!landmark || !top) checks.push(mk("landmark_on_top", `${lmName} 在 顶层台地`, false, !landmark ? "缺少地标" : "没有台地", "warn", []));
  else {
    const t = T.terraceAt(lmXZ[0], lmXZ[1]);
    const onTop = !!t && Math.abs(t.height - top.height) < 1e-6;
    // 环台原型把地标放在中层广场是设计本意：所在台地的区域是 plaza 就算对
    // 卡片说放中层广场（placement plaza）：落在中间那层（层数 / 2 取整）也算对
    const midLevel = Math.floor(new Set(T.terraces.map((x) => x.level)).size / 2);
    const plazaHere = !!t && !onTop && ((sid.regions || []).some((r) => r && r.kind === "plaza" && (r.terrace_level === t.level || (Array.isArray(r.polygon) && pointInPolygon(lmXZ, r.polygon)))) || (placementOf(sid) === "plaza" && t.level === midLevel));
    // 卡片说放村口（placement entry）：在最低一层（台地或同高的平地）就算对
    // 看地标所在的台地（人把最低一层调高后按高度算会错成第 2 层）；不在台地上时才按高度算层号
    const lowest = Math.min(...T.terraces.map((x) => x.level));
    const atEntry = !onTop && !plazaHere && placementOf(sid) === "entry" && (t ? t.level === lowest : T.levelAt(lmXZ[0], lmXZ[1]) === lowest);
    const ok = onTop || plazaHere || atEntry;
    const where = plazaHere ? "广场" : atEntry ? "村口" : "顶层台地";
    const detail = atEntry ? `地标在最低一层（${t ? t.id : "台地外平地"}），按卡放村口` : t ? `地标在 ${t.id}（第 ${t.level + 1} 层${plazaHere ? "广场，按卡放这里" : ""}）${ok ? "" : `，顶层是 ${top.id}（第 ${top.level + 1} 层）`}` : "地标不在任何台地上";
    checks.push(mk("landmark_on_top", `${lmName} 在 ${where}`, ok, detail, "warn", [
      { label: "挪到顶层", patch(s) { const l = findObject(s, landmark.id); if (!l) return; const c = top.centroid; l.obj.position = [r2(c[0]), r2(T.heightAt(c[0], c[1])), r2(c[1])]; } },
      ignoreFix("landmark_on_top"),
    ]));
  }
  // 4. houses_no_overlap（所有建筑含地标，y 区间相交且 OBB 相交）
  const bld = vols.filter((v) => v.kind === "building").map((v) => ({ v, poly: footprint(v), y0: volumeBase(T, v), y1: volumeTop(T, v) }));
  const overlaps = [];
  for (let i = 0; i < bld.length; i++) for (let j = i + 1; j < bld.length; j++) {
    const A = bld[i], B = bld[j];
    if (A.y1 <= B.y0 + 1e-6 || B.y1 <= A.y0 + 1e-6) continue;
    if (A.v.rests_on === B.v.id || B.v.rests_on === A.v.id) continue; // 立在它身上（桥心楼阁在风雨桥上）不算重叠
    if (A.v.land && B.v.land) continue; // plan v2 的两个形体之间：program 的「形体不重叠」管
    if (obbOverlap(A.poly, B.poly)) overlaps.push([A.v.id, B.v.id]);
  }
  // 修法：生成的房子换种子重排；两栋都是人放的（拖过 / 锁住）时把人后放的那栋挪到最近的空位
  const byId = new Map(vols.map((v) => [v.id, v]));
  const ovGen = [], ovMove = [];
  for (const [a, b] of overlaps) {
    const A = byId.get(a), B = byId.get(b);
    const gen = [B, A].find((v) => v.generated && v.importance !== "landmark");
    if (gen) ovGen.push(gen.id);
    else { const mv = [B, A].find((v) => v.importance !== "landmark" && v.user_moved) || [B, A].find((v) => v.importance !== "landmark"); if (mv) ovMove.push(mv.id); }
  }
  checks.push(mk("houses_no_overlap", "房子 不重叠", overlaps.length === 0, overlaps.length ? overlaps.map((p) => p.join(" × ")).join("、") : `${bld.length} 栋互不重叠`, "error",
    overlaps.length ? [houseFix(ovMove, ovGen, "houses_no_overlap", T)] : []));
  // 5. houses_clear_of_paths（中心距 ≥ 路宽/2 + 2.5，溪 + 3；且底面不进路面）
  const pressed = [];
  for (const h of houses) {
    const c = xz(h.position), poly = footprint(h);
    for (const p of sid.paths || []) {
      if (!Array.isArray(p.points) || p.points.length < 2) continue;
      const half = (p.width || 2) / 2, margin = p.kind === "river" ? 3 : 2.5;
      const dc = distToPolyline(c, p.points);
      if (dc < half + margin) { pressed.push(`${h.id} 距 ${p.id} ${r2(dc)} m（需 ≥ ${half + margin}）`); break; }
      if (polyToPolylineDist(poly, p.points) < half) { pressed.push(`${h.id} 的底面压到 ${p.id}`); break; }
    }
  }
  // 人放的房子（拖过 / 锁住）也查；主路为躲它绕了路时在文案里提一句
  const pressedIds = pressed.map((d) => d.split(" ")[0]);
  const pGen = pressedIds.filter((id) => byId.get(id).generated), pMove = pressedIds.filter((id) => !byId.get(id).generated);
  const detour = trail && Array.isArray(trail.detour_around) ? trail.detour_around.filter((id) => byId.has(id)) : [];
  const detourTxt = detour.length ? `；主路为躲开 ${detour.join("、")} 绕了一下` : "";
  checks.push(mk("houses_clear_of_paths", "房子 不压路", pressed.length === 0, (pressed.length ? pressed.join("、") : `${houses.length} 栋都不压路`) + detourTxt, "error",
    pressed.length ? [houseFix(pMove, pGen, "houses_clear_of_paths", T)] : []));
  // 6. houses_on_terraces（每栋非地标建筑——含人拖过的——四角落在同一层台地上；台地外同高的平地也算）
  const offT = [];
  if (T.terraces.length) for (const h of houses) { if (h.form === "stilt_house") continue; const why = offTerrace(T, footprint(h)); if (why) offT.push({ id: h.id, why }); } // 吊脚楼本来就跨坡
  checks.push(mk("houses_on_terraces", "房子 都在台地上", offT.length === 0, offT.length ? offT.map((f) => `${f.id} ${f.why}`).join("、") : T.terraces.length ? `${houses.length} 栋都在台地上` : "没有台地", "warn",
    offT.length ? [{ label: "挪回最近的台地", patch(s) { for (const f of offT) moveHouseToSpot(s, T, f.id); } }, ignoreFix("houses_on_terraces")] : []));
  // 7. terraces_reachable（每个台地 10 m 内有路点，且从出生点可达；支路也算，这样「补一段支路」才能修好它）
  const failing = R ? unreachedTerraces(sid, T, { R }).failing : [];
  checks.push(mk("terraces_reachable", "每层台地 都有路可达", failing.length === 0 && !!R, !R ? "缺少出生点和主路" : failing.length ? failing.map((f) => `${f.t.id}（${f.why}）`).join("、") : `${T.terraces.length} 层都可达`, "warn", [
    { label: "补一段支路", patch(s) { for (const f of failing) addSpur(s, f.t, f.target, f.nearPt || origin); } },
    ignoreFix("terraces_reachable"),
  ]));

  return { relations, checks };
}

// ------------------------------------------------------------ fixes 用的 patch 辅助
/** 「出生点挪到路口」：沿主路从起点走，挪到第一个看得见地标顶的路点；没有就挪到主路起点 */
function moveSpawnToVisiblePoint(s, T, landmarkId, spawnId, trailId) {
  const l = findObject(s, landmarkId), m = findObject(s, spawnId), p = trailId ? findObject(s, trailId) : null;
  if (!l || !m || !p) return;
  const lm = l.obj, lmXZ = xz(lm.position), th = volumeTop(T, lm) - T.heightAt(lmXZ[0], lmXZ[1]);
  const vols = (s.volumes || []).filter((v) => v && v.position && v.size);
  const polys = vols.map(footprint);
  let dest = p.obj.points[0];
  for (const q of samplePolyline(p.obj.points, 2)) {
    if (polys.some((poly) => pointInPolygon(q, poly))) continue; // 不能站在体块里面
    if (lineOfSight(T, vols, q, lmXZ, { targetHeight: th, ignore: [landmarkId] }).visible) { dest = q; break; }
  }
  m.obj.position = [r2(dest[0]), r2(T.heightAt(dest[0], dest[1])), r2(dest[1])];
}
/** 「重排房子」：删掉冲突里 generated 的房子，并在 meta 里记下重排请求，交给调用方 / LLM */
function requestRelayout(s, checkId, ids) {
  const drop = new Set(ids);
  s.volumes = (s.volumes || []).filter((v) => !(drop.has(v.id) && v.generated));
  s.meta = s.meta || {};
  s.meta.relayout_requests = [...new Set([...(s.meta.relayout_requests || []), checkId])];
}
/** 「补一段支路」：从最近的主路点到台地内目标点加一条 trail */
function addSpur(s, terrace, target, fromPt) {
  if (!fromPt) return;
  const id = "spur_" + terrace.id, pts = [[r2(fromPt[0]), r2(fromPt[1])], [r2(target[0]), r2(target[1])]];
  s.paths = s.paths || [];
  const old = s.paths.find((p) => p.id === id);
  if (old) old.points = pts; else s.paths.push({ id, kind: "trail", width: 2, points: pts, surface: "stone", label: "支路", generated: true });
}

/** 卡片里地标的 placement（没有卡时 null） */
function placementOf(sid) { const c = sid.meta && sid.meta.card; return (c && c.landmark && c.landmark.placement) || null; }

/**
 * 房子底面是否不在同一层台地上：四角 terraceAt 相同即可；四角都不在台地上时，四角同层且不陡（台地外同高的平地）也算。
 * @returns {string|null} 不合格的原因（「跨了台地边」「在坡上」），合格返回 null
 */
export function offTerrace(T, rect) {
  const ids = rect.map(([x, z]) => { const t = T.terraceAt(x, z); return t ? t.id : null; });
  if (ids.every((id) => id !== null && id === ids[0])) return null;
  if (ids.some((id) => id !== null)) return "跨了台地边";
  const lv = T.levelAt(rect[0][0], rect[0][1]);
  for (const [x, z] of rect) if (T.levelAt(x, z) !== lv || T.slopeAt(x, z) > 0.35) return "在坡上";
  return null;
}

/**
 * 给一栋房子找最近的合格位置（在当前位置周围按半径 1 m 一圈圈找，同半径按角度固定顺序，确定性）：
 * 四角同一台地且离台地边 ≥ 0.3 m、中心不陡、门朝向按布局规则（12 m 内朝路 / 朝下坡 / 朝外）、
 * 中心离路 ≥ 路宽/2 + 2.5（溪 + 3）且底面离路面 ≥ 0.5 m、离其它体块 ≥ 0.8 m（地标 4 m）、离连接点 ≥ 1.5 m。
 * @param {object} s sid
 * @param {object} T buildTerrain 结果
 * @param {object} h 房子（volumes 里的对象）
 * @param {number} [maxR=40] 最远找多远（米）
 * @returns {{position: number[], rotation_y: number}|null}
 */
export function nearestHouseSpot(s, T, h, maxR = 40) {
  const paths = (s.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  const roads = paths.filter((p) => WALK_KINDS.has(p.kind)).map((p) => p.points);
  const others = (s.volumes || []).filter((v) => v && v !== h && v.position && v.size).map((v) => ({ rect: footprint(v), gap: v.importance === "landmark" ? 4 : 0.8 }))
    .concat((s.markers || []).filter((m) => m && m.kind === "connector" && Array.isArray(m.position)).map((m) => ({ rect: boxCorners(m.position, [3, 1, 3], 0), gap: 1.5 })));
  const p0 = xz(h.position);
  const ok = (x, z) => {
    if (!T.inside(x, z)) return null;
    const t = T.terraceAt(x, z);
    if (!t || T.slopeAt(x, z) > 0.35) return null;
    const F = houseFacing(T, x, z, roads, t.centroid);
    const rot = r2(((Math.atan2(-F.facing[0], -F.facing[1]) * 180) / Math.PI + 360) % 360);
    const rect = boxCorners([x, 0, z], h.size, rot);
    for (const c of rect) { const tc = T.terraceAt(c[0], c[1]); if (!tc || tc.id !== t.id || distToPolygon(c, t.polygon) < 0.3) return null; }
    for (const p of paths) {
      const half = (p.width || 2) / 2;
      if (distToPolyline([x, z], p.points) < half + (p.kind === "river" ? 3 : 2.5)) return null;
      if (polyToPolylineDist(rect, p.points) < half + 0.5) return null;
    }
    for (const o of others) if (rectToRectDist(rect, o.rect) < o.gap) return null;
    return rot;
  };
  for (let r = 0; r <= maxR; r++) {
    const N = r === 0 ? 1 : Math.max(8, Math.ceil(2 * Math.PI * r));
    for (let k = 0; k < N; k++) {
      const a = (k / N) * 2 * Math.PI, x = r2(p0[0] + r * Math.cos(a)), z = r2(p0[1] + r * Math.sin(a));
      const rot = ok(x, z);
      if (rot != null) return { position: [x, r2(T.heightAt(x, z)), z], rotation_y: rot };
    }
  }
  return null;
}
/** 把房子挪到最近的合格位置；生成的房子挪过后算人放的（锁住、不再由布局重放） */
function moveHouseToSpot(s, T, id) {
  const f = findObject(s, id);
  if (!f || !f.obj || !Array.isArray(f.obj.size)) return false;
  const spot = nearestHouseSpot(s, T, f.obj);
  if (!spot) return false;
  Object.assign(f.obj, spot, { locked: true, user_moved: true });
  delete f.obj.generated;
  return true;
}
/** 房子冲突的修法：人放的挪开一点，生成的换种子重排（本地，不调 AI） */
function houseFix(moveIds, genIds, checkId, T) {
  return {
    label: moveIds.length ? "挪开一点" : "重排房子",
    patch(s) { for (const id of moveIds) moveHouseToSpot(s, T, id); if (genIds.length) requestRelayout(s, checkId, genIds); },
  };
}

// ------------------------------------------------------------ plan 的关系（docs/05 §3 第 10 步）
/** plan 关系的中文说法 */
export const REL_TEXT = Object.freeze({
  visible_from: (a, b) => `${a} 从 ${b} 看得见`, reachable: (a, b) => `${a} 从 ${b} 走得到`, faces: (a, b) => `${a} 朝着 ${b}`, adjacent: (a, b) => `${a} 挨着 ${b}`,
  behind: (a, b) => `${a} 在 ${b} 后面`, above: (a, b) => `${a} 在 ${b} 上方`, below: (a, b) => `${a} 在 ${b} 下方`,
  between: (a, b, c) => `${a} 在 ${b} 和 ${c} 之间`, far_from: (a, b) => `${a} 远离 ${b}`,
});

/** plan v2 的形体：plan_id / plan_path / instance_of 里有这个 id 的（布房生成的房子不算） */
function planVols(sid, id) {
  return (sid.volumes || []).filter((o) => o && o.position && o.size && o.land && !o.generated && (o.plan_id === id || o.instance_of === id || (o.plan_path || []).includes(id)));
}
function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * 编译后的 SID 里 plan 元素的几何（按 plan_id 找）：点、底 / 顶高度、朝向、底面、名字。找不到返回 null。
 * spawn → 出生点；plan v2 的节点（形体 / 组 / 重复 / 实例 id[k]）→ 它子树里所有形体并起来；生成器 / 院 / 水 → regions；
 * 地形操作 → features；空间 → spaces；连接 / 河 → paths。v4 的地标（importance landmark + plan_id）照旧。
 * @param {object} sid
 * @param {object} T
 * @param {string} id plan 元素 id（或 "spawn"）
 * @returns {{point: number[], base: number, top: number, rotation: number|null, rect: number[][]|null, polygon: number[][]|null, label: string, sid_ids: string[], elevated?: boolean}|null}
 */
export function planGeo(sid, T, id) {
  const by = (arr) => (arr || []).filter((o) => o && o.plan_id === id);
  if (id === "spawn") {
    const m = (sid.markers || []).find((k) => k.kind === "player_spawn");
    return m ? { point: xz(m.position), base: m.position[1], top: m.position[1] + 1.7, rotation: m.rotation_y ?? null, rect: null, polygon: null, label: m.label || "出生点", sid_ids: [m.id], elevated: m.position[1] - T.heightAt(m.position[0], m.position[2]) > 2.5, rests_on: m.rests_on || null } : null;
  }
  const pv = planVols(sid, id);
  if (pv.length) {
    const own = pv.find((v) => v.plan_id === id && v.land && v.land.mode !== "plinth") || pv[0];
    const single = pv.filter((v) => !(v.land && v.land.mode === "plinth")).length === 1;
    const poly = single ? footprint(own) : hull2(pv.flatMap(footprint));
    const point = single ? xz(own.position) : polygonCentroid(poly);
    let base = Infinity, top = -Infinity;
    for (const v of pv) { base = Math.min(base, v.position[1]); top = Math.max(top, v.position[1] + v.size[1]); }
    const lowest = pv.reduce((m, v) => (v.position[1] < m.position[1] ? v : m));
    return { point, base, top, rotation: single || own.plan_id === id ? own.rotation_y || 0 : null, rect: single ? footprint(own) : null, polygon: poly, label: own.plan_id === id ? own.label || id : id, sid_ids: pv.map((v) => v.id), rests_on: single ? own.rests_on || null : null, elevated: (lowest.elev ?? lowest.position[1] - T.heightAt(lowest.position[0], lowest.position[2])) > 2.5 };
  }
  const v = (sid.volumes || []).find((o) => o && o.importance === "landmark" && (o.plan_id === id || o.id === id));
  if (v) return { point: xz(v.position), base: volumeBase(T, v), top: volumeTop(T, v), rotation: v.rotation_y || 0, rect: footprint(v), polygon: footprint(v), label: v.label || id, sid_ids: [v.id], rests_on: v.rests_on || null };
  const sp = by(sid.spaces);
  if (sp.length) { const s = sp[0], n = s.sublevels || 1; return { point: polygonCentroid(s.polygon), base: s.floor_y, top: s.floor_y + s.height * n + 2 * (n - 1), rotation: null, rect: null, polygon: s.polygon, label: s.label || id, sid_ids: sp.map((o) => o.id) }; }
  const regs = by(sid.regions), feats = by(sid.terrain && sid.terrain.features).filter((f) => f.mask !== "all");
  // 穹顶（山 / 山脊）没有多边形：按 rx / rz / angle 补一个椭圆外轮廓
  const ellipse = (f) => { const c = Math.cos(f.angle || 0), s = Math.sin(f.angle || 0), out = []; for (let k = 0; k < 16; k++) { const t = (2 * Math.PI * k) / 16, u = f.rx * Math.cos(t), v = f.rz * Math.sin(t); out.push([f.center[0] + u * c - v * s, f.center[2] + u * s + v * c]); } return out; };
  const polys = [...regs.map((r) => r.polygon), ...feats.filter((f) => Array.isArray(f.polygon)).map((f) => f.polygon), ...feats.filter((f) => !f.polygon && f.rx > 0 && f.rz > 0).map(ellipse)];
  if (polys.length || feats.length) {
    // 面积加权质心；落不进任何多边形时取最大块里离边最远的格点
    let A = 0, cx = 0, cz = 0;
    for (const p of polys) { const a = Math.abs(polyArea(p)), c = polygonCentroid(p); A += a; cx += c[0] * a; cz += c[1] * a; }
    let point = A > 0 ? [cx / A, cz / A] : [feats[0].center[0], feats[0].center[2]];
    if (polys.length && !polys.some((p) => pointInPolygon(point, p))) point = deepPoint(polys.reduce((m, p) => (Math.abs(polyArea(p)) > Math.abs(polyArea(m)) ? p : m)));
    const hs = feats.map((f) => f.height).filter(Number.isFinite), g = T.heightAt(point[0], point[1]);
    return { point, base: regs.length ? g : Math.min(g, ...hs), top: Math.max(g, ...hs), rotation: null, rect: null, polygon: polys[0] || null, label: (regs[0] || feats[0]).label || id, sid_ids: [...regs, ...feats].map((o) => o.id) };
  }
  const pa = by(sid.paths);
  if (pa.length) { const pts = pa[0].points, m = pts[Math.floor(pts.length / 2)], h = T.heightAt(m[0], m[1]); return { point: m, base: h, top: h, rotation: null, rect: null, polygon: null, line: pts, label: pa[0].label || id, sid_ids: pa.map((o) => o.id) }; }
  return null;
}
function polyArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; }
function deepPoint(poly) {
  let xmin = Infinity, zmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (const [x, z] of poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  let best = poly[0], bd = -1;
  for (let z = zmin + 1; z < zmax; z += 2) for (let x = xmin + 1; x < xmax; x += 2) if (pointInPolygon([x, z], poly)) { const d = distToPolygon([x, z], poly); if (d > bd) { bd = d; best = [x, z]; } }
  return best;
}

// ------------------------------------------------------------ 可达（plan v2：地面走 + 桥 / 台阶 / 传送门连到高处）
/**
 * 从出生点（或某个 plan 元素）出发，哪些 plan 元素走得到：
 * 地面用 reachSet（坡度 ≤ 0.7 或在路上）；高处的东西（离地 > 2.5 m 的浮岛、台上的亭）只能经连接到达——
 * 连接一端已到达（地面那端在可达格里 / 高处那端的「宿主」已到达）则另一端也到达，迭代到不变。宿主 = 沿 rests_on 往下找到的最低那块体块。
 * @param {object} sid 编译后的 SID（paths 带 from_id / to_id / ends_y / elevated）
 * @param {object} T
 * @param {string} [from="spawn"]
 * @returns {{reach: (id: string) => {ok: boolean, detail: string, elevated: boolean}}}
 */
export function planReach(sid, T, from = "spawn") {
  const vols = (sid.volumes || []).filter((v) => v && v.position && v.size), byId = new Map(vols.map((v) => [v.id, v]));
  const waters = (sid.regions || []).filter((r) => r && r.kind === "water" && Number.isFinite(r.surface_y));
  const ground = (x, z) => { let h = T.heightAt(x, z); for (const w of waters) if (w.surface_y > h && pointInPolygon([x, z], w.polygon) && !(w.hole && pointInPolygon([x, z], w.hole))) h = w.surface_y; return h; };
  const elevated = (v) => (ringOf(v) ? (v.elev || 0) : v.position[1] - ground(v.position[0], v.position[2])) > 2.5; // 环带量带子下面的地（孔里可能是坑底）
  // 贴地的环带（环形回廊、绕坑摊道）是可走的台面：从它的边走得上去，带子上的格都算走得到
  const ringWalk = vols.filter((v) => ringOf(v) && !((v.elev || 0) > 2.5)).map((v) => ringPoly(v));
  const host = (v) => { let cur = v, k = 0; while (cur && k++ < 20) { const on = (cur.land && cur.land.on) || cur.rests_on; const b = on && byId.get(on); if (!b) break; cur = b; } return cur; };
  const paths = sid.paths || [];
  const links = paths.filter((p) => p && Array.isArray(p.points) && p.points.length >= 2 && Array.isArray(p.ends_y) && p.kind !== "river");
  /** 连接一端的宿主：高处时找端点下面 / 旁边、顶面高度对得上的体块 */
  const endHost = (p, y, id) => {
    let best = null, bd = Infinity;
    for (const v of vols) {
      const top = v.position[1] + v.size[1];
      if (Math.abs(top - y) > 2 && !(y >= v.position[1] - 0.5 && y <= top + 0.5)) continue;
      const poly = footprint(v), d = pointInPolygon(p, poly) ? 0 : distToPolygon(p, poly);
      if (d > 3) continue;
      const pref = id && (v.plan_id === id || (v.plan_path || []).includes(id)) ? -1 : 0;
      if (d + pref < bd) { bd = d + pref; best = v; }
    }
    return best ? host(best) : null;
  };
  const ends = links.map((p) => [0, 1].map((k) => { const pt = k ? p.points[p.points.length - 1] : p.points[0], y = p.ends_y[k], el = Array.isArray(p.elevated) ? !!p.elevated[k] : y - ground(pt[0], pt[1]) > 2.5; return { p: pt, y, el, h: el ? endHost(pt, y, k ? p.to_id : p.from_id) : null }; }));
  const sets = [], hosts = new Set();
  const markGround = (p) => { if (!sets.some((R) => R.at(p[0], p[1]))) sets.push(reachSet(T, paths, p, { walkPolys: ringWalk })); };
  // 起点
  const start = planGeo(sid, T, from);
  if (start) {
    const sv = from === "spawn" ? (start.rests_on && byId.get(start.rests_on)) : planVols(sid, from).find(elevated);
    if (sv && elevated(host(sv)) ) hosts.add(host(sv).id);
    else if (start.elevated && sv) hosts.add(host(sv).id);
    else markGround(start.point);
  }
  // 宿主在地面上（塔、金字塔底层）：走到它脚下就算到了（爬上去）
  const near = (v) => { const c = xz(v.position), poly = footprint(v); for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, u = [Math.sin(a), -Math.cos(a)]; let r = 0; for (const q of poly) r = Math.max(r, (q[0] - c[0]) * u[0] + (q[1] - c[1]) * u[1]); const q = [c[0] + u[0] * (r + 1.5), c[1] + u[1] * (r + 1.5)]; if (sets.some((R) => R.at(q[0], q[1]))) return true; } return false; };
  const hostReached = (h) => !!h && (hosts.has(h.id) || (!elevated(h) && near(h)));
  const reached = (e) => (e.el ? hostReached(e.h) : sets.some((R) => R.at(e.p[0], e.p[1])));
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [a, b] of ends) for (const [x, y] of [[a, b], [b, a]]) {
      if (!reached(x) || reached(y)) continue;
      if (y.el) { if (y.h) { hosts.add(y.h.id); changed = true; } } else { markGround(y.p); changed = true; }
    }
    if (!changed) break;
  }
  return {
    reach(id) {
      const g = planGeo(sid, T, id);
      if (!g) return { ok: false, detail: "还没生成出来", elevated: false };
      const pv = planVols(sid, id);
      const hi = pv.filter(elevated);
      if (pv.length && hi.length === pv.length) {
        const ok = hi.some((v) => hostReached(host(v)));
        return { ok, detail: ok ? "在高处，经桥 / 台阶走得到" : "在高处，没有桥 / 台阶连上", elevated: true };
      }
      const poly = g.polygon, c = g.point, pts = [c];
      if (poly) for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, u = [Math.sin(a), -Math.cos(a)]; let r = 0; for (const q of poly) r = Math.max(r, (q[0] - c[0]) * u[0] + (q[1] - c[1]) * u[1]); pts.push([c[0] + u[0] * (r + 1.5), c[1] + u[1] * (r + 1.5)]); }
      const ok = pts.some((q) => sets.some((R) => R.at(q[0], q[1])));
      return { ok, detail: ok ? "走得到" : sets.length ? "坡太陡又没有路" : `${from === "spawn" ? "出生点" : "起点"}在高处，没有连接下到地面`, elevated: false };
    },
  };
}

// ------------------------------------------------------------ 关系检查（plan v2）
/** plan 树里按 id 找节点（实例 id[k] → 它的 repeat；模板里的不算） */
function findPlanNode(plan, id) {
  const base = String(id).replace(/\[\d+\]$/, "");
  let hit = null;
  const walk = (arr) => { for (const n of arr || []) { if (hit || !n || typeof n !== "object") continue; if (n.id === base) { hit = n; return; } walk(n.children); } };
  walk(plan.nodes);
  return hit;
}
/**
 * plan.relations → 检查（成立 / 不成立 + 修法）。修法是 plan v2 的 ops（applyOps 直接用）：
 * 看不见 → 加高；走不到 → 补一条连接；挨着 / 在上方 / 在后面 / 远离 → 改 a 的锚点；朝向 → 改 rotate_deg；最后总有一个「不重要」。
 * 每条：{ id: "rel_<序号>", text, ok, detail, severity: "warn", relation: 序号, plan: true, fixes: [{ label, ops } | { label, ignore }] }。
 * @param {object} sid 编译后的 SID
 * @param {object} T
 * @param {object} plan 规范化后的 plan（v2）
 * @returns {object[]}
 */
export function relationChecks(sid, T, plan) {
  const out = [], site = (plan.site && plan.site.size_m) || [160, 160], S = Array.isArray(site) ? Math.min(site[0], site[1]) : site, layer = T.layer;
  const ignored = new Set((sid.meta && sid.meta.ignored_checks) || []);
  const spawn = planGeo(sid, T, "spawn");
  const vols = (sid.volumes || []).filter((v) => v && v.position && v.size);
  const node = (id) => (id === "spawn" ? null : findPlanNode(plan, id));
  const movable = (id) => { const n = node(id); return !!n && !String(id).includes("["); };
  const setAt = (id, at) => [{ op: "set", id, field: "at", value: at }, { op: "set", id, field: "offset_m", value: null }];
  let reachCache = null;
  (plan.relations || []).forEach((r, i) => {
    const A = planGeo(sid, T, r.a), B = planGeo(sid, T, r.b), C = r.c ? planGeo(sid, T, r.c) : null;
    const la = A ? A.label : r.a, lb = B ? B.label : r.b, lc = C ? C.label : r.c || "";
    const text = (REL_TEXT[r.type] || ((a, b) => `${a} ${r.type} ${b}`))(la, lb, lc);
    let ok = false, detail = "";
    const fixes = [];
    if (!A || !B || (r.type === "between" && !C)) detail = "有一端还没生成出来";
    else {
      const d = dist2(A.point, B.point);
      switch (r.type) {
        case "visible_from": {
          const los = lineOfSight(T, vols, B.point, A.point, { eye: 1.7, fromY: B.base + 1.7, toY: A.top - 0.3, ignore: A.sid_ids.concat(B.sid_ids) });
          ok = los.visible; detail = ok ? "视线通畅" : los.blockedBy === "terrain" ? `被地形挡住（约 ${los.at} 处）` : `被 ${los.blockedBy.slice(7)} 挡住`;
          const n = node(r.a);
          if (!ok && n && Array.isArray(n.size_m) && n.size_m.length >= 2) { const s = n.size_m.slice(); s[1] = r2(s[1] + 2 * layer); fixes.push({ label: "再高两层", ops: [{ op: "set", id: r.a, field: "size_m", value: s }] }); }
          if (!ok && movable(r.a)) fixes.push({ label: "离地抬高", ops: [{ op: "set", id: r.a, field: "elev_m", value: r2(((n && n.elev_m) || 0) + 2 * layer) }] });
          break;
        }
        case "reachable": {
          reachCache = reachCache || {};
          const R = (reachCache[r.b] = reachCache[r.b] || planReach(sid, T, r.b));
          const q = R.reach(r.a);
          ok = q.ok; detail = q.detail;
          if (!ok) fixes.push({ label: q.elevated ? "补一段台阶" : "补一条路", ops: [{ op: "add", to: "root", value: { type: "link", style: q.elevated ? "stairs" : "path", from: r.b, to: r.a } }] });
          break;
        }
        case "faces": {
          if (A.rotation == null) { ok = true; detail = "没有朝向，不用管"; break; }
          const t = (A.rotation * Math.PI) / 180, f = [-Math.sin(t), -Math.cos(t)], u = [B.point[0] - A.point[0], B.point[1] - A.point[1]], L = Math.hypot(u[0], u[1]) || 1;
          const ang = Math.round((Math.acos(Math.max(-1, Math.min(1, (f[0] * u[0] + f[1] * u[1]) / L))) * 180) / Math.PI);
          ok = ang <= 45; detail = `朝向偏 ${ang}°`;
          if (!ok && movable(r.a)) { let deg = (Math.atan2(-u[0], -u[1]) * 180) / Math.PI; if (deg < 0) deg += 360; fixes.push({ label: `转向 ${lb}`, ops: [{ op: "set", id: r.a, field: "rotate_deg", value: Math.round(deg / 15) * 15 }] }); }
          break;
        }
        case "adjacent": {
          const gap = A.rect && B.rect ? rectToRectDist(A.rect, B.rect) : B.polygon && !pointInPolygon(A.point, B.polygon) ? distToPolygon(A.point, B.polygon) : A.polygon && !pointInPolygon(B.point, A.polygon) ? distToPolygon(B.point, A.polygon) : B.polygon || A.polygon ? 0 : d;
          ok = gap <= 10; detail = `相距 ${r2(gap)} m（需 ≤ 10 m）`;
          if (!ok && movable(r.a) && r.b !== "spawn") fixes.push({ label: `挪到 ${lb} 旁边`, ops: setAt(r.a, `${r.b}.E`) });
          break;
        }
        case "behind": {
          if (!spawn) { detail = "没有出生点"; break; }
          const u = [B.point[0] - spawn.point[0], B.point[1] - spawn.point[1]], v = [A.point[0] - B.point[0], A.point[1] - B.point[1]], lu = Math.hypot(u[0], u[1]) || 1, lv = Math.hypot(v[0], v[1]) || 1;
          ok = (u[0] * v[0] + u[1] * v[1]) / (lu * lv) >= 0.5 && dist2(A.point, spawn.point) > dist2(B.point, spawn.point);
          detail = ok ? `从出生点看在 ${lb} 后面` : "从出生点看不在它后面";
          if (!ok && movable(r.a) && r.b !== "spawn") { const ang = (Math.atan2(u[0], -u[1]) * 180) / Math.PI, dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][((Math.round(ang / 45) % 8) + 8) % 8]; fixes.push({ label: `挪到 ${lb} 后面`, ops: setAt(r.a, `${r.b}.${dir}`) }); }
          break;
        }
        case "above": case "below": {
          const up = r.type === "above";
          const rest = up && A.rests_on && B.sid_ids.includes(A.rests_on);
          ok = rest || (up ? A.base >= B.top - 0.5 : A.top <= B.base + 0.5);
          detail = rest ? `${la} 立在 ${lb} 上（${r2(A.base)} m）` : `${la} ${r2(up ? A.base : A.top)} m，${lb} ${r2(up ? B.top : B.base)} m`;
          const n = node(r.a);
          if (!ok && n && n.type === "space") fixes.push({ label: up ? `挪到 ${lb} 上空` : `挪到 ${lb} 下面`, ops: up ? [{ op: "set", id: r.a, field: "stratum", value: "sky" }, { op: "set", id: r.a, field: "over", value: r.b }] : [{ op: "set", id: r.a, field: "stratum", value: "underground" }, { op: "set", id: r.a, field: "under", value: r.b }] });
          else if (!ok && up && movable(r.a) && r.b !== "spawn") fixes.push({ label: `放到 ${lb} 顶上`, ops: setAt(r.a, `${r.b}.top`) });
          break;
        }
        case "between": {
          const u = [C.point[0] - B.point[0], C.point[1] - B.point[1]], L2 = u[0] * u[0] + u[1] * u[1] || 1;
          const t = ((A.point[0] - B.point[0]) * u[0] + (A.point[1] - B.point[1]) * u[1]) / L2, lat = Math.abs((A.point[0] - B.point[0]) * u[1] - (A.point[1] - B.point[1]) * u[0]) / Math.sqrt(L2);
          ok = t >= 0.1 && t <= 0.9 && lat <= Math.max(10, 0.3 * Math.sqrt(L2)); detail = `沿连线 ${Math.round(t * 100)}%，偏开 ${r2(lat)} m`;
          break;
        }
        case "far_from": {
          ok = d >= 0.35 * S; detail = `相距 ${r2(d)} m（需 ≥ ${r2(0.35 * S)} m）`;
          if (!ok && movable(r.a)) {
            const ang = (Math.atan2(-B.point[0], B.point[1]) * 180) / Math.PI; // 从 B 指向场地中心再往外：0 = 北
            const side = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][((Math.round(ang / 45) % 8) + 8) % 8];
            fixes.push({ label: "挪到场地另一边", ops: setAt(r.a, `site.${side}`) });
          }
          break;
        }
        default: detail = `不认识的关系 ${r.type}`;
      }
    }
    const id = `rel_${i}`;
    fixes.push({ label: "不重要", ignore: id });
    out.push(Object.assign({ id, text, ok, detail, severity: "warn", relation: i, plan: true, fixes }, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {}));
  });
  return out;
}

// ============================================================ 加到对话：引用的事实（describeRef）与改动摘要（diffCompiled）（docs/07 §1）
// 纯函数、确定性、不调 AI。坐标都是场地坐标（plan 编译出的 SID 场地中心 = 原点）。
const DIR8 = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
/** plan 树的索引：全局节点（模板外）id → { node, parent, label, depth }，按树的顺序 */
function planIndex(plan) {
  const out = new Map();
  const walk = (arr, parent, depth) => {
    for (const n of arr || []) {
      if (!n || typeof n !== "object" || !n.id) continue;
      const child = n.type === "repeat" && n.child && typeof n.child === "object" ? n.child : null;
      const label = n.label || (child && child.label) || n.id;
      out.set(n.id, { node: n, parent, label, depth });
      walk(n.children, n.id, depth + 1);
    }
  };
  walk(plan && plan.nodes, null, 0);
  return out;
}
const bboxWD = (pts) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; };
const r1_ = (v) => Math.round(v * 10) / 10;
const lineLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist2(pts[i - 1], pts[i]); return L; };
/** 多边形里地面高度的范围（2 m 格采样；太小时取顶点与质心） */
function groundRange(T, poly) {
  const [x0, z0, x1, z1] = bboxWD(poly), st = Math.max(2, Math.sqrt(((x1 - x0) * (z1 - z0)) / 4000));
  let lo = Infinity, hi = -Infinity;
  const take = (x, z) => { const h = T.heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); };
  for (let z = z0 + st / 2; z < z1; z += st) for (let x = x0 + st / 2; x < x1; x += st) if (pointInPolygon([x, z], poly)) take(x, z);
  if (!Number.isFinite(lo)) { for (const q of poly) take(q[0], q[1]); const c = polygonCentroid(poly); take(c[0], c[1]); }
  return [r1_(lo), r1_(hi)];
}
/** 编译结果里每个全局节点的几何（按 sid 缓存） */
const GEO = new WeakMap();
function geoOf(sid, T, id) {
  let m = GEO.get(sid); if (!m) { m = new Map(); GEO.set(sid, m); }
  if (!m.has(id)) m.set(id, planGeo(sid, T, id));
  return m.get(id);
}
/** 中心落在 poly 里的节点（最上层的那个；它的子孙不再列）；不算连接 */
function nodesInside(sid, T, idx, poly) {
  const out = [], hit = new Set();
  for (const [id, e] of idx) {
    if (e.node.type === "link") continue;
    let a = e.parent, skip = false; while (a) { if (hit.has(a)) { skip = true; break; } a = idx.get(a) && idx.get(a).parent; }
    if (skip) continue;
    const g = geoOf(sid, T, id);
    if (g && g.point && pointInPolygon(g.point, poly)) { out.push(id); hit.add(id); }
  }
  return out;
}
/** 离 shape（点 / 多边形 / 折线）R 米以内、不在 exclude 里的节点，近的在前；只列根或没被父节点代表的 */
function nodesNear(sid, T, idx, shape, R, exclude = new Set()) {
  const out = [];
  for (const [id, e] of idx) {
    if (e.node.type === "link" || exclude.has(id) || (e.parent && (exclude.has(e.parent) || out.some((o) => o.id === e.parent)))) continue;
    const g = geoOf(sid, T, id);
    if (!g || !g.point) continue;
    const d = shape.point ? (g.polygon && pointInPolygon(shape.point, g.polygon) ? 0 : g.polygon ? distToPolygon(shape.point, g.polygon) : dist2(shape.point, g.point)) : shape.poly ? distToPolygon(g.point, shape.poly) : distToPolyline(g.point, shape.line);
    if (d <= R) out.push({ id, d });
  }
  return out.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1)).map((o) => o.id);
}
/** facts 压到 ≤ 300 字符的 JSON：先削最长的列表，再去可选字段 */
function fitFacts(f, max = 300) {
  const lists = ["near", "contains", "children"];
  for (let guard = 0; guard < 60 && JSON.stringify(f).length > max; guard++) {
    const k = lists.filter((q) => Array.isArray(f[q]) && f[q].length).sort((a, b) => f[b].length - f[a].length)[0];
    if (k) { f[k].pop(); if (!f[k].length) delete f[k]; continue; }
    const opt = ["material", "pattern", "at", "label_of", "extent_m"].find((q) => f[q] !== undefined);
    if (!opt) break;
    delete f[opt];
  }
  return f;
}
/** 点 c 相对主地标（role = landmark 的第一个节点，根节点优先；没有就是场地中心）：{fact: {id, dir, dist_m}, text: 「在中空圆塔西北 90 m」} */
function fromLandmark(sid, T, idx, c) {
  let L = null;
  for (const root of [true, false]) for (const [id, e] of idx) if (!L && !e.parent === root && e.node.role === "landmark") { const g = geoOf(sid, T, id); if (g && g.point) L = { id, label: e.label, p: g.point }; }
  if (!L) L = { id: "site", label: "场地中心", p: [0, 0] };
  const v = [c[0] - L.p[0], c[1] - L.p[1]], d = Math.round(Math.hypot(v[0], v[1]));
  if (d < 3) return { fact: { id: L.id, dir: "中", dist_m: 0 }, text: `在${L.label}正中` };
  const dir = DIR8[((Math.round(Math.atan2(v[0], -v[1]) / (Math.PI / 4)) % 8) + 8) % 8];
  return { fact: { id: L.id, dir, dist_m: d }, text: `在${L.label}${dir} ${d} m` };
}
const namesOf = (idx, ids, n = 3) => ids.slice(0, n).map((id) => (idx.get(id) || {}).label || id).join("、") + (ids.length > n ? ` 等 ${ids.length} 个` : "");
const yTxt = (g) => (g[0] === g[1] ? `${g[0] >= 0 ? "+" : ""}${g[0]} m` : `${g[0] >= 0 ? "+" : ""}${g[0]}–${g[1]} m`);
/**
 * 「加到对话」的引用卡片：一个东西的名字 + 一组事实（给 AI 看，也给卡片上那一句话）。
 * ref.kind：node（节点；instance = 重复里的第几个，从 0 数）/ mark（人画的标记）/ op（地形操作）/ link（连接）/ space（空间）/ spawn（出生点）。
 * facts（≤ 300 字符 JSON，只有有意义的才写）：type、size_m（plan 里写的尺寸；圈选 = 包围盒 [东西, 南北]）、area_m2、length_m、
 * ground_y（地面高度 [低, 高]，图钉是一个数）、top_y、extent_m（编译后的占地 [宽, 深, 高]）、count / pattern（重复）、at（锚点）、
 * contains（中心落在里面的节点 id）、near（附近的节点 id，近的在前）、on（图钉落在哪个节点上）、op / height_m / depth_m（地形操作）、
 * style / from / to / unrouted（连接）、stratum / layout / floor_y（空间）、hand_op（图钉上手调高度的操作 id）、elevated（悬空）、
 * from_landmark（标记：中心相对主地标 / 场地中心的 {id, dir 八方位, dist_m}）。
 * @param {{sid: object, T?: object}} compiled compilePlan 的结果
 * @param {object} plan 规范化后的 plan（省略时用 sid.meta.plan）
 * @param {{kind: string, id?: string, instance?: number}} ref
 * @returns {{label: string, facts: object, text: string}} text = 卡片上那一句（「81×48 m · 地面 +3–7 m · 含 主宅、谷仓」）
 */
export function describeRef(compiled, plan, ref) {
  const sid = compiled && compiled.sid;
  if (!sid || !ref) return { label: "", facts: {}, text: "" };
  const T = compiled.T || buildTerrain(sid, { res: 2 });
  plan = plan || (sid.meta && sid.meta.plan) || {};
  const idx = planIndex(plan), f = {}, txt = [];
  let label = ref.id || "";
  const kind = ref.kind === "op" ? "op" : ref.kind;
  if (kind === "mark") {
    const m = (plan.marks || []).find((q) => q && q.id === ref.id);
    if (!m) return { label: ref.id || "", facts: { missing: true }, text: "已经删掉了" };
    label = m.label || m.id; f.type = m.type;
    // 相对主地标（没有就相对场地中心）的方位和距离：AI 复述「在哪」时照这个说，不要猜
    const mc = m.type === "area" ? polygonCentroid(m.polygon_m) : m.type === "trace" ? m.path_m[Math.floor(m.path_m.length / 2)] : m.point_m;
    const fl = mc && fromLandmark(sid, T, idx, mc);
    if (fl) f.from_landmark = fl.fact;
    if (m.type === "area") {
      const poly = m.polygon_m, bb = bboxWD(poly), g = groundRange(T, poly), inside = nodesInside(sid, T, idx, poly);
      Object.assign(f, { size_m: [Math.round(bb[2] - bb[0]), Math.round(bb[3] - bb[1])], area_m2: Math.round(polyAreaAbs(poly)), ground_y: g });
      if (inside.length) f.contains = inside;
      const near = nodesNear(sid, T, idx, { poly }, 15, new Set(inside)); if (near.length) f.near = near;
      txt.push(`${f.size_m[0]}×${f.size_m[1]} m`, fl ? fl.text : "", `地面 ${yTxt(g)}`, inside.length ? `含 ${namesOf(idx, inside)}` : "里面是空的");
    } else if (m.type === "trace") {
      const L = m.path_m, hs = [];
      for (let i = 1; i < L.length; i++) { const n = Math.max(1, Math.ceil(dist2(L[i - 1], L[i]) / 2)); for (let k = 0; k <= n; k++) hs.push(T.heightAt(L[i - 1][0] + ((L[i][0] - L[i - 1][0]) * k) / n, L[i - 1][1] + ((L[i][1] - L[i - 1][1]) * k) / n)); }
      Object.assign(f, { length_m: Math.round(lineLen(L)), ground_y: [r1_(Math.min(...hs)), r1_(Math.max(...hs))] });
      const near = nodesNear(sid, T, idx, { line: L }, 10); if (near.length) f.near = near;
      txt.push(`长 ${f.length_m} m`, fl ? fl.text : "", `地面 ${yTxt(f.ground_y)}`, near.length ? `经过 ${namesOf(idx, near)}` : "沿途没有东西");
    } else {
      const p = m.point_m, h = r1_(T.heightAt(p[0], p[1]));
      f.ground_y = h;
      const near = nodesNear(sid, T, idx, { point: p }, 25), on = near.find((id) => { const g = geoOf(sid, T, id); return g && g.polygon && pointInPolygon(p, g.polygon); });
      if (on) f.on = on;
      const rest = near.filter((id) => id !== on); if (rest.length) f.near = rest;
      const op = (plan.terrain || []).find((t) => t && t.at === m.id);
      if (op) { f.hand_op = op.id; if (op.height_m) f.height_m = op.height_m; if (op.depth_m) f.depth_m = op.depth_m; }
      txt.push(fl ? fl.text : "", `地面 ${yTxt([h, h])}`, on ? `在 ${namesOf(idx, [on])} 上` : near.length ? `近 ${namesOf(idx, near)}` : "空地");
      if (op) txt.push(`${op.label || op.id} ${op.op === "lower" ? "−" + (op.depth_m || 0) : "+" + (op.height_m || 0)} m`);
    }
  } else if (kind === "op") {
    const t = (plan.terrain || []).find((q) => q && q.id === ref.id);
    if (!t) return { label: ref.id || "", facts: { missing: true }, text: "已经删掉了" };
    label = t.label || t.id; f.op = t.op;
    if (t.size_m) f.size_m = t.size_m.slice();
    for (const k of ["height_m", "depth_m", "width_m", "at", "area", "along", "target"]) if (t[k] !== undefined) f[k] = t[k];
    const g = geoOf(sid, T, t.id);
    if (g && g.polygon) { f.ground_y = groundRange(T, g.polygon); const inside = nodesInside(sid, T, idx, g.polygon); if (inside.length) f.contains = inside; }
    txt.push(t.op === "lower" || t.op === "lake" || t.op === "carve" || t.op === "river" ? `深 ${t.depth_m ?? "?"} m` : t.height_m != null ? `高 ${t.height_m} m` : t.op);
    if (f.ground_y) txt.push(`地面 ${yTxt(f.ground_y)}`);
    if (f.contains) txt.push(`上面有 ${namesOf(idx, f.contains)}`);
  } else if (kind === "spawn") {
    label = (plan.spawn && plan.spawn.label) || "出生点";
    const g = geoOf(sid, T, "spawn");
    if (plan.spawn && plan.spawn.at) f.at = plan.spawn.at;
    if (plan.spawn && plan.spawn.look_at) f.look_at = plan.spawn.look_at;
    if (g) { f.ground_y = r1_(g.base); if (g.elevated) f.elevated = true; const near = nodesNear(sid, T, idx, { point: g.point }, 30); if (near.length) f.near = near; txt.push(`高 ${yTxt([f.ground_y, f.ground_y])}`, near.length ? `近 ${namesOf(idx, near)}` : "四周空"); }
  } else {
    const e = idx.get(ref.id);
    if (!e) return { label: ref.id || "", facts: { missing: true }, text: "已经删掉了" };
    const n = e.node, inst = Number.isInteger(ref.instance) && n.type === "repeat" ? ref.instance : null;
    const tpl = n.type === "repeat" && n.child ? Object.assign({}, n.child, inst !== null && n.overrides && n.overrides[String(inst)] || {}) : null;
    label = inst !== null ? `${e.label}[${inst}]` : e.label;
    f.type = inst !== null && tpl ? tpl.type : n.type;
    const src = inst !== null && tpl ? tpl : n;
    if (src.size_m !== undefined) f.size_m = Array.isArray(src.size_m) ? src.size_m.slice() : src.size_m;
    else if (tpl && tpl.size_m !== undefined) f.size_m = Array.isArray(tpl.size_m) ? tpl.size_m.slice() : tpl.size_m;
    if (n.type === "repeat" && inst === null) { f.pattern = n.pattern || "linear"; f.count = sid.volumes.filter((v) => v.instance_of === n.id).reduce((s, v) => s.add(v.instance), new Set()).size || n.count || 0; if (n.radius_m) f.radius_m = n.radius_m; if (tpl) f.of = tpl.type; }
    if (n.at && inst === null) f.at = n.at;
    if (n.type === "link") {
      for (const k of ["style", "from", "to", "along"]) if (n[k] !== undefined) f[k] = n[k];
      const pa = (sid.paths || []).find((q) => q.plan_id === n.id);
      if (pa) { f.length_m = Math.round(lineLen(pa.points)); if (pa.unrouted) f.unrouted = true; }
      txt.push(`${f.style || "path"}`, f.length_m != null ? `长 ${f.length_m} m` : "没生成");
    } else if (n.type === "space" || kind === "space") {
      for (const k of ["stratum", "layout", "depth_m"]) if (n[k] !== undefined) f[k] = n[k];
      const sp = (sid.spaces || []).find((q) => q.plan_id === n.id);
      if (sp) { f.floor_y = r1_(sp.floor_y); if (sp.rooms) f.rooms = sp.rooms.length; }
      txt.push(n.stratum === "sky" ? "天上" : "地下", n.layout || "chamber", sp ? `地面 ${f.floor_y} m` : "");
    } else {
      const g = geoOf(sid, T, inst !== null ? `${n.id}[${inst}]` : n.id);
      if (g && g.polygon) {
        const bb = bboxWD(g.polygon);
        f.extent_m = [Math.round(bb[2] - bb[0]), Math.round(bb[3] - bb[1]), Math.round(g.top - g.base)];
        f.top_y = r1_(g.top);
        if (g.elevated) f.elevated = true;
        if (n.type === "group" && inst === null) { const ch = (n.children || []).map((c) => c.id).filter(Boolean); if (ch.length) f.children = ch; }
        const near = nodesNear(sid, T, idx, { poly: g.polygon }, 12, new Set([n.id, ...[...idx].filter(([, q]) => { let a = q.parent; while (a) { if (a === n.id) return true; a = idx.get(a) && idx.get(a).parent; } return false; }).map(([k]) => k)]));
        if (near.length) f.near = near;
        txt.push(`${f.extent_m[0]}×${f.extent_m[1]} m`, `高 ${f.extent_m[2]} m`);
        if (f.count) txt.push(`× ${f.count}`);
        if (g.elevated) txt.push("悬空");
      } else txt.push("没生成出来");
      if (n.material) f.material = n.material;
    }
  }
  return { label, facts: fitFacts(f), text: txt.filter(Boolean).join(" · ") };
}
function polyAreaAbs(p) { return Math.abs(polyArea(p)); }

/** 一份编译结果里每个 plan 元素（地形操作 + 全局节点）的几何摘要 */
function unitsOf(c, plan) {
  const sid = c.sid, T = c.T || buildTerrain(sid, { res: 2 }), out = new Map();
  for (const t of plan.terrain || []) {
    if (!t || !t.id) continue;
    const g = geoOf(sid, T, t.id), bb = g && g.polygon ? bboxWD(g.polygon) : null;
    out.set(t.id, { id: t.id, kind: "terrain", label: t.label || t.id, parent: null, c: g ? g.point : null, dims: bb ? [bb[2] - bb[0], bb[3] - bb[1], 0] : null, p: t });
  }
  const idx = planIndex(plan);
  for (const [id, e] of idx) {
    const n = e.node, g = geoOf(sid, T, id);
    const u = { id, kind: "node", type: n.type, label: e.label, parent: e.parent, p: n, c: g ? g.point : null, dims: null, n: null, look: "" };
    if (g && g.line) u.dims = [lineLen(g.line), 0, 0];
    else if (g && g.polygon) { const bb = bboxWD(g.polygon); u.dims = [bb[2] - bb[0], bb[3] - bb[1], Math.max(0, g.top - g.base)]; }
    if (n.type === "repeat") u.n = new Set([...sid.volumes.filter((v) => v.instance_of === id).map((v) => v.instance), ...(sid.paths || []).filter((q) => q.instance_of === id).map((q) => q.instance)]).size;
    u.look = [...new Set(planVols(sid, id).map((v) => `${v.shape}:${v.roof || ""}:${v.color_role || ""}:${v.hollow ? 1 : 0}`))].sort().join("|"); // 去重：个数变了不算「样子变了」
    out.set(id, u);
  }
  const sp = (sid.markers || []).find((m) => m.kind === "player_spawn");
  if (sp) out.set("spawn", { id: "spawn", kind: "spawn", label: (plan.spawn && plan.spawn.label) || "出生点", parent: null, c: [sp.position[0], sp.position[2]], dims: null, p: {} });
  return { units: out, T };
}
const dirWord = (v) => DIR8[((Math.round(Math.atan2(v[0], -v[1]) / (Math.PI / 4)) % 8) + 8) % 8];
const fmt = (v) => String(Math.round(v * 10) / 10);
/**
 * 改动前后对比（AI 改完 / 本地改完都能算）：新增 / 删除 / 挪动 > 1 m / 尺寸变化 > 10% / 数量变化 / 样子变了（形体、屋顶、颜色）/ 地形变了 / 色板、时段。
 * 子节点跟着父节点一起挪的只报父节点；组变大是因为里面加了东西的只报加的那个。
 * 没改定义、被避让推走的节点（prev / next 都带 facts 时看得出）记成 kind「bump」，摘要开头单列「顺带被挤动：…」。
 * @param {{sid: object, T?: object, facts?: object}|null} prev 改之前的编译结果（null = 新场景）
 * @param {{sid: object, T?: object, facts?: object}} next 改之后的编译结果
 * @param {object} [prevPlan] 省略时用 sid.meta.plan
 * @param {object} [nextPlan]
 * @param {{focus?: string[]}} [opts] focus = 这轮 / 上一轮引用的标记、节点 id：它们、锚在它们上面的和这些的子孙排在摘要最前面
 * @returns {{summary: string, items: {id: string, label: string, change: string, kind: string, visible: boolean}[], visible: boolean}}
 * 摘要按 id 合并后取前 4 处，「等 N 处」的 N 是合并后的处数；items 不合并，按摘要的顺序排。
 */
export function diffCompiled(prev, next, prevPlan, nextPlan, opts = {}) {
  if (!next || !next.sid) return { summary: "没有结果", items: [], visible: false };
  const np = nextPlan || (next.sid.meta && next.sid.meta.plan) || {};
  if (!prev || !prev.sid) return { summary: "新场景", items: [{ id: "plan", label: np.name || "场景", change: "新建", kind: "add", visible: true }], visible: true };
  const pp = prevPlan || (prev.sid.meta && prev.sid.meta.plan) || {};
  const { units: A, T: TA } = unitsOf(prev, pp), { units: B, T: TB } = unitsOf(next, np);
  const raw = [], J = (v) => JSON.stringify(v ?? null);
  const push = (u, kind, change, visible = true, extra = {}) => raw.push(Object.assign({ id: u.id, label: u.label, change, kind, visible, parent: u.parent }, extra));
  // 被挤动：自己的定义（不算子节点）没改、避让推它的量变了的节点挪了 → 是别人长大挤的，摘要单列在最前面（prev / next 带 facts 时才知道）
  const pushOf = (c) => new Map((((c.facts && c.facts.plan) || {}).pushed || []).map((q) => [q.id, q.by]));
  const PA = pushOf(prev), PB = pushOf(next), knowPush = !!(prev.facts && next.facts);
  const own = (n) => J(Object.fromEntries(Object.entries(n || {}).filter(([k]) => k !== "children")));
  const bumped = (a, b) => { if (!knowPush || b.kind !== "node" || own(a.p) !== own(b.p)) return false; const x = PA.get(b.id) || [0, 0], y = PB.get(b.id) || [0, 0]; return Math.hypot(y[0] - x[0], y[1] - x[1]) > 1; };
  const isMove = (k) => k === "move" || k === "bump";
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) { push(b, "add", b.n ? `新增 × ${b.n}` : "新增", !!b.c || b.kind === "terrain"); continue; }
    if (a.c && !b.c) { push(b, "gone", "没生成出来"); continue; }
    if (!a.c && b.c) { push(b, "add", "生成出来了"); continue; }
    const parts = [];
    const cnt = a.n != null && b.n != null && a.n !== b.n;
    if (cnt) parts.push(`× ${a.n} → × ${b.n}`);
    for (const [k, w] of [["radius_m", "半径"], ["spacing_m", "间距"], ["height_m", "高"], ["depth_m", "深"], ["elev_m", "离地"]]) {
      const va = a.p[k], vb = b.p[k];
      if (typeof va === "number" && typeof vb === "number" && Math.abs(va - vb) > 1e-6) parts.push(`${w} ${fmt(va)} → ${fmt(vb)} m`);
      else if ((typeof va === "number") !== (typeof vb === "number") && (typeof va === "number" || typeof vb === "number") && k !== "spacing_m") parts.push(`${w} ${typeof va === "number" ? fmt(va) : 0} → ${typeof vb === "number" ? fmt(vb) : 0} m`);
    }
    if (a.p.op && b.p.op && a.p.op !== b.p.op) parts.push(`${a.p.op} → ${b.p.op}`);
    if (b.kind === "terrain" && J(a.p.size_m) !== J(b.p.size_m) && a.p.size_m && b.p.size_m) parts.push(`大小 ${a.p.size_m.join("×")} → ${b.p.size_m.join("×")} m`);
    if (b.kind !== "terrain" && a.dims && b.dims && !parts.length) {
      const nm = b.p.type === "link" ? ["长", "", ""] : ["宽", "深", "高"];
      for (let i = 0; i < 3; i++) if (nm[i] && Math.abs(b.dims[i] - a.dims[i]) > 0.1 * Math.max(a.dims[i], 1)) parts.push(`${nm[i]} ${Math.round(a.dims[i])} → ${Math.round(b.dims[i])} m`);
      if (parts.length) { push(b, "size", parts.join("，")); parts.length = 0; }
    }
    const mv = a.c && b.c ? [b.c[0] - a.c[0], b.c[1] - a.c[1]] : [0, 0], d = Math.hypot(mv[0], mv[1]);
    if (parts.length) push(b, "param", parts.join("，"), true, cnt ? { counted: true } : {});
    if (d > 1) { const bp = bumped(a, b); push(b, bp ? "bump" : "move", `${bp ? "被挤动" : "挪了"} ${Math.round(d)} m（往${dirWord(mv)}）`, true, { dv: mv }); }
    if (b.kind === "node" && a.look !== b.look && b.look && a.look && !parts.length && d <= 1) push(b, "look", "样子变了（形体 / 屋顶 / 颜色）");
    if (a.label !== b.label && b.kind !== "spawn") push(b, "rename", `改名为「${b.label}」`, false);
  }
  for (const [id, a] of A) if (!B.has(id)) push(a, "remove", "删掉了");
  // 父子：一起挪的只报父；新增 / 删除的子孙不再报；组的尺寸变化如果有子孙的改动解释，就不报
  const byId = new Map(); for (const it of raw) { if (!byId.has(it.id)) byId.set(it.id, []); byId.get(it.id).push(it); }
  const parentOf = (id) => (B.get(id) || A.get(id) || {}).parent || null;
  const anc = (id) => { const out = []; let p = parentOf(id); while (p) { out.push(p); p = parentOf(p); } return out; };
  // 重复的个数变了：它和子孙的质心跟着偏，祖先组的质心也跟着偏——这些 < 5 m 的「挪了」不报
  const counted = new Set(raw.filter((it) => it.counted).map((it) => it.id));
  const below = (id, pred) => raw.some((o) => o.id !== id && anc(o.id).includes(id) && pred(o));
  const items = raw.filter((it) => {
    const up = anc(it.id).flatMap((p) => byId.get(p) || []);
    if ((it.kind === "add" || it.kind === "remove" || it.kind === "gone") && up.some((u) => u.kind === it.kind)) return false;
    if (isMove(it.kind) && up.some((u) => isMove(u.kind) && Math.hypot(u.dv[0] - it.dv[0], u.dv[1] - it.dv[1]) < 1.5)) return false;
    if (isMove(it.kind) && up.some((u) => u.kind === "add" || u.kind === "remove")) return false;
    if (it.kind === "move" && Math.hypot(it.dv[0], it.dv[1]) < 5 && (counted.has(it.id) || anc(it.id).some((a) => counted.has(a)) || below(it.id, (o) => o.counted || o.kind === "add" || o.kind === "remove"))) return false;
    if (it.kind === "size" && below(it.id, (o) => o.kind !== "rename")) return false;
    // 样子变了：子孙有新增 / 删除 / 参数 / 尺寸 / 样子的改动，是它们带出来的，不报父级
    if (it.kind === "look" && below(it.id, (o) => o.kind !== "rename" && !isMove(o.kind))) return false;
    return true;
  });
  // 根上的：色板、时段、场地
  if (J(pp.palette) !== J(np.palette)) items.push({ id: "palette", label: "色板", change: "换了颜色", kind: "look", visible: true });
  const ta = pp.lighting && pp.lighting.time_of_day, tb = np.lighting && np.lighting.time_of_day;
  if (ta !== tb) items.push({ id: "lighting", label: "时段", change: `${ta || "默认"} → ${tb || "默认"}`, kind: "look", visible: true });
  if (J(pp.site) !== J(np.site)) items.push({ id: "site", label: "场地", change: "基础地形 / 大小变了", kind: "param", visible: true });
  // 地形高度场：没有哪个地形操作的改动能解释时，报一句最大变化
  const ha = TA.grid.h, hb = TB.grid.h;
  if (ha.length === hb.length && !items.some((it) => it.id === "site" || (A.get(it.id) || B.get(it.id) || {}).kind === "terrain")) {
    let mx = 0; for (let i = 0; i < ha.length; i++) mx = Math.max(mx, Math.abs(ha[i] - hb[i]));
    if (mx > 0.3) items.push({ id: "terrain", label: "地形", change: `地面最多变了 ${fmt(mx)} m`, kind: "terrain", visible: true });
  }
  // 排序：这轮引用的（或上一轮引用的标记 / 节点，连锚在它上面的和它们的子孙）在前，再按 新增 / 删除 > 参数 > 尺寸 > 挪动 > 样子
  const focus = new Set((opts && opts.focus) || []);
  // 关注的范围：引用的 id → 锚在它们上面（at / area / along / around / target）或连到它们（from / to / via）的节点，再连一层；子孙跟着祖先
  const refersTo = (u, F) => { const p = (u && u.p) || {}; return ["at", "area", "along", "around", "target", "from", "to", "via"].some((k) => { const v = p[k]; const sv = typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : ""; return sv && [...F].some((f) => sv === f || sv.startsWith(f + ".") || sv.startsWith(f + "[") || ["\"", ".", "["].some((e) => sv.includes(`"${f}${e}`))); }); };
  for (let pass = 0; pass < 2 && focus.size; pass++) for (const [id, u] of B) if (!focus.has(id) && refersTo(u, focus)) focus.add(id);
  const focused = (id) => focus.size > 0 && [id, ...anc(id)].some((q) => focus.has(q));
  const RANK = { add: 0, remove: 0, gone: 1, param: 1, size: 2, terrain: 2, move: 3, look: 4, rename: 5 };
  const rank = (it) => (["lighting", "palette", "site"].includes(it.id) ? 1 : RANK[it.kind] ?? 3);
  items.forEach((it, i) => { it._k = it.kind === "bump" ? -1 : (focused(it.id) ? 0 : 10) + rank(it); it._i = i; });
  items.sort((x, y) => x._k - y._k || x._i - y._i);
  for (const it of items) { delete it.parent; delete it.dv; delete it.counted; delete it._k; delete it._i; }
  const vis = items.filter((it) => it.visible);
  // 按 id 合并（同一个东西的「参数 + 挪了」算一处）再数「等 N 处」
  const merge = (arr) => { const m = new Map(); for (const it of arr) { if (!m.has(it.id)) m.set(it.id, { label: it.label, ch: [] }); m.get(it.id).ch.push(it.change); } return [...m.values()]; };
  const say = (arr) => { const g = merge(arr); return g.slice(0, 4).map((q) => `${q.label} ${q.ch.join("，")}`).join("；") + (g.length > 4 ? ` 等 ${g.length} 处` : ""); };
  // 锚在圈选（at: area 标记）上、这轮改过的东西：体块中心落到圈外的个数（提示词也说了要放得下；放不下就在摘要里直说）
  const areas = new Map((np.marks || []).filter((m) => m && m.type === "area" && Array.isArray(m.polygon_m)).map((m) => [m.id, m]));
  const outside = [];
  if (areas.size) for (const [id, u] of B) {
    const m = u.kind === "node" && typeof u.p.at === "string" ? areas.get(u.p.at.split(/[.[]/)[0]) : null;
    if (!m || !items.some((it) => it.id === id || anc(it.id).includes(id))) continue;
    const vs = planVols(next.sid, id), n = vs.filter((v) => !pointInPolygon([v.position[0], v.position[2]], m.polygon_m)).length;
    if (n) outside.push({ id, label: u.label, mark: m.label || m.id, n, total: vs.length });
  }
  const outTxt = outside.length ? `（${outside.slice(0, 2).map((o) => `${o.label} 有 ${o.n}/${o.total} 块超出了圈的范围`).join("；")}${outside.length > 2 ? ` 等 ${outside.length} 组` : ""}）` : "";
  // 顺带被挤动的（没改它、被别人长大挤走的）单列在最前面，不混进「改了」里被「等 N 处」藏掉
  const bumps = vis.filter((it) => it.kind === "bump"), rest = vis.filter((it) => it.kind !== "bump");
  const bumpTxt = bumps.length ? `顺带被挤动：${bumps.slice(0, 3).map((it) => `${it.label} ${it.change.replace(/^被挤动 /, "")}`).join("、")}${bumps.length > 3 ? ` 等 ${bumps.length} 处` : ""}` : "";
  const main = rest.length ? `改了：${say(rest)}` : bumps.length ? "" : items.length ? `没有看得见的变化（${say(items)}）` : "没有看得见的变化";
  const summary = [bumpTxt, main].filter(Boolean).join("；") + outTxt;
  // 摘要里「等 N 处」藏掉的也要看得到（docs/07 §1.2）：all = 每处一行（被挤动的在前），cut = 摘要省略了一部分；界面点开看全部
  const listed = merge(rest.length ? rest : bumps.length ? [] : items);
  const all = [...bumps.map((it) => `被挤动：${it.label} ${it.change.replace(/^被挤动 /, "")}`), ...listed.map((q) => `${q.label} ${q.ch.join("，")}`)];
  const cut = bumps.length > 3 || listed.length > 4 || outside.length > 2;
  if (outside.length) all.push(...outside.map((o) => `${o.label} 有 ${o.n}/${o.total} 块超出了圈的范围`));
  return { summary, items, visible: vis.length > 0, outside, all, cut };
}
