// relations.js — 关系与检查：自动生成 relations、固定顺序的 checks、视线（lineOfSight）与可达性（reachable）
// 约定见 SPEC.md 第 4 节。纯函数、确定性（没有随机）；LLM 不写坐标，fixes 的 patch 也只做几何推导后直接改 sid。
import { buildTerrain, pointInPolygon, distToPolyline, distToPolygon, distToSegment, polygonCentroid, r2 } from "./terrain.js";
import { boxCorners, obbOverlap, findObject } from "./validate.js";
import { houseFacing, rectToRectDist } from "./layout.js";

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
  const landmark = vols.find((v) => v.importance === "landmark") || vols.find((v) => v.id === "landmark") || null;
  const spawn = (sid.markers || []).find((m) => m.kind === "player_spawn") || null;
  const paths = (sid.paths || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
  const walkPaths = paths.filter((p) => WALK_KINDS.has(p.kind));
  const trail = paths.find((p) => p.id === "main_trail") || walkPaths[0] || null;
  const houses = vols.filter((v) => v.kind === "building" && v !== landmark);
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
 * @param {{eye?: number, targetHeight?: number, ignore?: string[]}} [opts]
 * @returns {{visible: boolean, blockedBy: "terrain"|string|null, at: number[]|null}} blockedBy 为 "volume:<id>" 或 "terrain"
 */
export function lineOfSight(T, volumes, from, to, opts = {}) {
  const eye = opts.eye ?? 1.7, th = opts.targetHeight ?? 1.7, ignore = new Set(opts.ignore || []);
  const h0 = T.heightAt(from[0], from[1]) + eye, h1 = T.heightAt(to[0], to[1]) + th;
  const boxes = (volumes || []).filter((v) => v && v.position && v.size && !ignore.has(v.id))
    .map((v) => ({ id: v.id, poly: footprint(v), top: volumeTop(T, v) }))
    .filter((b) => !pointInPolygon(from, b.poly) && !pointInPolygon(to, b.poly));
  const L = dist2(from, to), n = Math.max(1, Math.ceil(L));
  for (let k = 1; k < n; k++) { // 跳过两端本身
    const t = k / n, x = from[0] + (to[0] - from[0]) * t, z = from[1] + (to[1] - from[1]) * t, lh = h0 + (h1 - h0) * t;
    if (T.heightAt(x, z) + 0.3 > lh) return { visible: false, blockedBy: "terrain", at: [r2(x), r2(z)] };
    for (const b of boxes) if (lh < b.top && pointInPolygon([x, z], b.poly)) return { visible: false, blockedBy: "volume:" + b.id, at: [r2(x), r2(z)] };
  }
  return { visible: true, blockedBy: null, at: null };
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
  const corridors = (paths || []).filter((p) => p && WALK_KINDS.has(p.kind) && Array.isArray(p.points) && p.points.length >= 2).map((p) => ({ pts: p.points, r: (p.width || 2) / 2 + 1 }));
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
export function unreachedTerraces(sid, T, opts = {}) {
  const { landmark, spawn, trail, walkPaths } = findActors(sid);
  const origin = spawn ? xz(spawn.position) : trail ? trail.points[0] : null;
  if (!origin) return { origin: null, R: null, failing: [] };
  const R = opts.R || reachSet(T, sid.paths || [], origin, { walkPolys: landmarkWalk(landmark) });
  const roadPts = walkPaths.flatMap((p) => samplePolyline(p.points, 1));
  const failing = [];
  for (const t of T.terraces) {
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
  const lmName = landmark ? landmark.label || landmark.id : "地标";
  const lmXZ = landmark ? xz(landmark.position) : null, spXZ = spawn ? xz(spawn.position) : null;
  const relations = [];
  const rel = (type, a, b) => relations.push({ type, a, b, generated: true });

  // on_top_of：房 / 地标 → 所在台地
  for (const v of [...(landmark ? [landmark] : []), ...houses]) { const t = T.terraceAt(v.position[0], v.position[2]); if (t) rel("on_top_of", v.id, t.id); }
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
    los = lineOfSight(T, vols, spXZ, lmXZ, { eye: Number(sid.meta && sid.meta.player_height) || 1.7, targetHeight: volumeTop(T, landmark) - T.heightAt(lmXZ[0], lmXZ[1]), ignore: [landmark.id] });
    if (los.visible) rel("visible_from", landmark.id, spawn.id);
  }
  // connects：主路 → 它经过的台地（按高度升序）
  const trailPts = trail ? samplePolyline(trail.points, 1) : [];
  if (trail) {
    const seen = new Map();
    for (const p of trailPts) { const t = T.terraceAt(p[0], p[1]); if (t && !seen.has(t.id)) seen.set(t.id, t); }
    for (const t of [...seen.values()].sort((a, b) => a.height - b.height)) rel("connects", trail.id, t.id);
  }

  // 一次 BFS，多个目标复用；地标底面视为可走（走到门前就算到）
  const origin = spXZ || (trail ? trail.points[0] : null);
  const R = origin ? reachSet(T, sid.paths || [], origin, { walkPolys: landmarkWalk(landmark) }) : null;
  const ignored = new Set((sid.meta && sid.meta.ignored_checks) || []);
  const ignoreFix = (id) => ({ label: "不重要", patch(s) { s.meta = s.meta || {}; const arr = (s.meta.ignored_checks = s.meta.ignored_checks || []); if (!arr.includes(id)) arr.push(id); } });
  const mk = (id, text, ok, detail, severity, fixes) => Object.assign({ id, text, ok, detail, severity, fixes }, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {});
  const checks = [];

  // 1. spawn_sees_landmark
  if (!landmark || !spawn) checks.push(mk("spawn_sees_landmark", `入口 能看见 ${lmName}`, false, !landmark ? "缺少地标（importance: landmark）" : "缺少出生点（player_spawn）", "warn", []));
  else {
    const detail = los.visible ? "视线通畅" : los.blockedBy === "terrain" ? `被地形挡住（约 ${los.at} 处）` : `被 ${los.blockedBy.slice(7)} 挡住（约 ${los.at} 处）`;
    checks.push(mk("spawn_sees_landmark", `入口 能看见 ${lmName}`, los.visible, detail, "warn", [
      { label: "地标再高一层", patch(s) { const f = findObject(s, landmark.id); if (f) f.obj.size[1] = r2(f.obj.size[1] + T.layer); } },
      { label: "入口挪到路口", patch(s) { moveSpawnToVisiblePoint(s, T, landmark.id, spawn.id, trail ? trail.id : null); } },
      ignoreFix("spawn_sees_landmark"),
    ]));
  }
  // 2. trail_reaches_landmark
  if (!landmark || !trail) checks.push(mk("trail_reaches_landmark", `主路 能到达 ${lmName}`, false, !landmark ? "缺少地标" : "缺少主路（main_trail）", "error", []));
  else {
    // 可达目标 = 地标中心格或主路终点格（门前点）：地标贴台地边缘时中心格可能落在坡裙另一侧，不该算走不到
    const last = trail.points[trail.points.length - 1], dEnd = dist2(last, lmXZ);
    const reach = R ? R.at(lmXZ[0], lmXZ[1]) || R.at(last[0], last[1]) : false;
    const ok = dEnd < 6 && reach;
    const detail = ok ? `主路终点距地标 ${r2(dEnd)} m，可达` : dEnd >= 6 ? `主路终点距地标 ${r2(dEnd)} m（需 < 6 m）` : "主路终点在地标旁，但从出生点走不到（坡太陡且无路）";
    checks.push(mk("trail_reaches_landmark", `主路 能到达 ${lmName}`, ok, detail, "error", [
      { label: "把路接到地标", patch(s) { const p = findObject(s, trail.id), l = findObject(s, landmark.id); if (p && l) p.obj.points[p.obj.points.length - 1] = [r2(l.obj.position[0]), r2(l.obj.position[2])]; } },
      ignoreFix("trail_reaches_landmark"),
    ]));
  }
  // 3. landmark_on_top
  const top = T.topTerrace();
  if (!landmark || !top) checks.push(mk("landmark_on_top", `${lmName} 在 顶层台地`, false, !landmark ? "缺少地标" : "没有台地", "warn", []));
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
  if (T.terraces.length) for (const h of houses) { const why = offTerrace(T, footprint(h)); if (why) offT.push({ id: h.id, why }); }
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
/** 「入口挪到路口」：沿主路从起点走，挪到第一个看得见地标顶的路点；没有就挪到主路起点 */
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
