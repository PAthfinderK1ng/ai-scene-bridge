// sid.js — SID 文档工具：主题 → 空文档 → resolve（布局 → 路由 → 关系 → 校验）→ 台地单独调高 → snapshot / restore。
// v4 起场景由 plan（构成图）编译而来（engine/plan.js 的 compilePlan 先落地形 / 区域 / 地标 / 路 / 水 / 空间，再调这里的 resolve）。
// 铁律：LLM 永远不写坐标——这里每一个坐标都来自 terrain / layout / routing 的确定性算法。随机只来自 seed。
//
// 两种模式：
// - plan 模式（sid.meta.plan_mode）：路、地标、出生点都是 plan 编译出来的，resolve 只重放房子 / 树、补支路、刷新空间、算检查；
// - 旧模式（测试夹具直接摆的 SID）：resolve 还会按「出生点 → 地标」算主路 main_trail。

import { buildTerrain, DEFAULT_BOUNDS, DEFAULT_LAYER_M, pointInPolygon, clamp, r2 } from "./terrain.js";
import { layoutHouses, HOUSE_SIZES, boxCorners, facingToRotation, ringSamples } from "./layout.js";
import { routeTrail, zigzagTrail, pathFacts, pathCrossings } from "./routing.js";
import { analyze, unreachedTerraces, polyToPolylineDist } from "./relations.js";
import { validate } from "./validate.js";
import { refreshSpaces, spaceChecks, spaceFacts } from "./interior.js";

// ------------------------------------------------------------ 主题
/** 主题：默认调色板、范围、层高、玩家高度、房屋尺寸、路与溪的默认值。 */
export const THEME = Object.freeze({
  mountain_village: {
    id: "mountain_village",
    name: "山村",
    bounds: DEFAULT_BOUNDS,
    layer_height_m: DEFAULT_LAYER_M,
    player_height: 1.7,
    house_sizes: HOUSE_SIZES,
    palette: [
      { role: "roof", hex: "#4A4A4A", note: "青瓦" },
      { role: "wall", hex: "#D9C9A3", note: "夯土墙" },
      { role: "stone", hex: "#9A9890", note: "石阶" },
      { role: "foliage", hex: "#4F6B3A", note: "树" },
      { role: "mist", hex: "#DDE6F0", note: "雾" },
    ],
    lighting: { time_of_day: "dusk", sun_azimuth_deg: 250, sun_elevation_deg: 12 },
    stream: { width: 4, label: "溪" },
    trail: { width: 2, label: "主路", surface: "stone" },
  },
});
const MAIN_TRAIL_ID = "main_trail", LANDMARK_ID = "landmark", POI_ID = "landmark_poi";

// ------------------------------------------------------------ 小工具
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const xz = (pos) => [pos[0], pos[2]];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const themeOf = (sid) => THEME[(sid.meta && sid.meta.theme) || "mountain_village"] || THEME.mountain_village;
const DEG = Math.PI / 180;
/** 朝向 to 的 rotation_y；两点重合时 0 */
export function rotationToward(from, to) {
  const d = dist2(from, to);
  return d < 1e-6 ? 0 : facingToRotation([(to[0] - from[0]) / d, (to[1] - from[1]) / d]);
}

// ------------------------------------------------------------ 文档
/**
 * 新建一份空的 SID 文档（含默认调色板、bounds、meta.layer_height_m / player_height / theme）。
 * @param {object} [theme=THEME.mountain_village] THEME 中的一项
 * @returns {object} sid
 */
export function newDoc(theme = THEME.mountain_village) {
  const t = theme || THEME.mountain_village;
  return {
    sid_version: "0.1",
    meta: { name: t.name, units: "meters", up_axis: "+Y", handedness: "right", north: "-Z", player_height: t.player_height, grid: 0.5, layer_height_m: t.layer_height_m, theme: t.id },
    intent: { summary: "", mood: [] },
    style: { palette: clone(t.palette), references: [], lighting: clone(t.lighting), material_intents: {} },
    bounds: clone(t.bounds),
    terrain: { base: "flat", base_height: 0, features: [] },
    volumes: [], regions: [], paths: [], markers: [], spaces: [], relations: [], constraints: [], views: [], asset_hints: {},
  };
}

// ------------------------------------------------------------ 落地（plan v2 的体块带 land：{ mode, elev, on, abs }）
/** 水面区域（kind water 且有 surface_y）：给「贴地」用（码头、船贴水面） */
export function waterRegions(sid) {
  return (sid.regions || []).filter((r) => r && r.kind === "water" && Number.isFinite(r.surface_y) && Array.isArray(r.polygon) && r.polygon.length >= 3).map((r) => ({ polygon: r.polygon, hole: r.hole || null, surface_y: r.surface_y }));
}
/** 地面高度 = 地形与水面取高者 */
export function groundAt(T, waters, x, z) {
  let h = T.heightAt(x, z);
  for (const w of waters || []) if (w.surface_y > h && pointInPolygon([x, z], w.polygon) && !(w.hole && pointInPolygon([x, z], w.hole))) h = w.surface_y;
  return h;
}
/** 体块底面采样点（四角、边中点、中心；大体块加密，最多 25 个）；环带（空心圆柱 / 平放的环）只采带子上的点 */
export function footSamples(v) {
  const ring = ringSamples(v);
  if (ring) return ring;
  const [w, , d] = v.size, t = ((v.rotation_y || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), cx = v.position[0], cz = v.position[2];
  const n = clamp(Math.ceil(Math.max(w, d) / 6), 2, 4), out = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const lx = (-0.5 + i / n) * w * 0.96, lz = (-0.5 + j / n) * d * 0.96; out.push([cx + lx * c + lz * s, cz - lx * s + lz * c]); }
  return out;
}
/**
 * 按 v.land 算一个体块的底面高度（原地改 position[1]，并写 elev = 离地高度）：
 * snap 贴地（大体块取覆盖范围的最高点；小于 4 m 的取中心）/ float 悬空（中心地面 + elev）/ carve 嵌入（覆盖范围最低点 + elev）/
 * rest 立在 land.on 那个体块顶上（+ elev；from:"base" 时从它的底面量，挂在立面上）/ abs 绝对高度（浮空组里的子节点、叠层）/ plinth 基座（从 plinth_of 的覆盖范围最低点垫到它的底面）。
 * @param {object} v 体块
 * @param {object} T
 * @param {Map<string, object>} byId 体块 id → 体块（rest / plinth 要找另一个体块）
 * @param {object[]} [waters] waterRegions(sid)
 */
export function landVolume(v, T, byId, waters) {
  const L = v.land;
  if (!L || !Array.isArray(v.position) || !Array.isArray(v.size)) return v;
  const cx = v.position[0], cz = v.position[2], g = (x, z) => groundAt(T, waters, x, z);
  let y;
  switch (L.mode) {
    case "rest": { const b = byId.get(L.on); y = b ? b.position[1] + (L.from === "base" ? 0 : b.size[1]) + (L.elev || 0) : g(cx, cz) + (L.elev || 0); break; } // from: "base" = 挂在父体立面上（离父体底面 elev）
    case "abs": y = Number(L.abs) || 0; break;
    case "float": { const ring = ringSamples(v); y = (ring ? Math.max(...ring.map(([x, z]) => g(x, z))) : g(cx, cz)) + (L.elev || 0); break; }
    case "carve": { let lo = Infinity; for (const [x, z] of footSamples(v)) lo = Math.min(lo, T.heightAt(x, z)); y = lo + (L.elev || 0); break; }
    case "plinth": {
      const b = byId.get(v.plinth_of);
      if (!b) { y = T.heightAt(cx, cz); break; }
      let lo = Infinity; for (const [x, z] of footSamples(b)) { const h = T.heightAt(x, z); if (g(x, z) > h + 0.05) continue; lo = Math.min(lo, h); }
      if (!Number.isFinite(lo)) lo = b.position[1] - 0.2;
      y = Math.min(lo, b.position[1] - 0.2); v.size[1] = r2(Math.max(0.2, b.position[1] - y));
      Object.assign(v.position, [b.position[0], 0, b.position[2]]); v.rotation_y = b.rotation_y;
      break;
    }
    default: {
      if (Math.max(v.size[0], v.size[2]) < 4) { y = g(cx, cz) + (L.elev || 0); break; }
      let hi = -Infinity; for (const [x, z] of footSamples(v)) hi = Math.max(hi, g(x, z));
      y = hi + (L.elev || 0);
    }
  }
  v.position[1] = r2(y);
  // 离地：环带量带子下面的地（中间的孔可能是坑底），其余量中心
  const ring = ringSamples(v);
  v.elev = r2(Math.max(0, y - (ring ? Math.max(...ring.map(([x, z]) => T.heightAt(x, z))) : T.heightAt(cx, cz))));
  return v;
}
/** 所有带 land 的体块按顺序重新落地（父在前；地形改了 / 台地调高后用） */
export function landVolumes(sid, T) {
  const byId = new Map((sid.volumes || []).map((v) => [v.id, v])), W = waterRegions(sid);
  for (const v of sid.volumes || []) if (v && v.land) landVolume(v, T, byId, W);
  return sid;
}

// ------------------------------------------------------------ resolve
/**
 * 地标「门前」一点：从地标中心退 min(半径 + 1, 5) m，朝 toward。
 * 地标贴台地边缘时那一侧可能已经在坡裙 / 下一层，于是依次试 ±45°、±90°、±135°、180°，
 * 取第一个与地标中心同一台地（terraceAt 相同）且在 bounds 内的点；都不行就退回朝 toward 的点。
 * @param {object} lm 体块
 * @param {number[]} toward [x,z]
 * @param {object} T
 * @returns {number[]} [x,z]
 */
export function landmarkDoor(lm, toward, T) {
  const L = xz(lm.position), d = dist2(L, toward);
  if (d < 1e-6) return L;
  const off = Math.min(Math.max(lm.size[0], lm.size[2]) / 2 + 1, 5), u = [(toward[0] - L[0]) / d, (toward[1] - L[1]) / d];
  const at = (p) => { const t = T.terraceAt(p[0], p[1]); return t ? t.id : null; };
  const home = at(L);
  for (const a of [0, 45, -45, 90, -90, 135, -135, 180]) {
    const c = Math.cos(a * DEG), sn = Math.sin(a * DEG), v = [u[0] * c - u[1] * sn, u[0] * sn + u[1] * c];
    const p = [r2(L[0] + v[0] * off), r2(L[1] + v[1] * off)];
    if (T.inside(p[0], p[1]) && at(p) === home) return p;
  }
  return [r2(L[0] + u[0] * off), r2(L[1] + u[1] * off)];
}

/**
 * 自动支路：主路（含已有支路）够不到的台地，从最近的路点 A*（到不了就直连）到台地内目标点补一条 spur_<台地 id>，
 * 让「每层台地都有路可达」默认成立而不用人点 fix。标 auto_spur，下次 resolve 先清掉再重算（幂等）；
 * relations fix「补一段支路」加的同 id 支路不带 auto_spur，保留且不重复补。check 被标「不重要」时不补。
 * 最多三轮（补一轮后更高的台地可能也变得可达，再查一次）。
 * @returns {string[]} 新补的支路 id
 */
function addAutoSpurs(sid, T, theme, seed, avoid) {
  if (new Set((sid.meta && sid.meta.ignored_checks) || []).has("terraces_reachable")) return [];
  const added = [];
  for (let round = 0; round < 3; round++) {
    const { origin, failing } = unreachedTerraces(sid, T);
    if (!origin) break;
    let any = false;
    for (const f of failing) {
      const id = "spur_" + f.t.id;
      if (sid.paths.some((p) => p.id === id)) continue;
      const from = f.nearPt ? [r2(f.nearPt[0]), r2(f.nearPt[1])] : origin, to = [r2(f.target[0]), r2(f.target[1])];
      const r = routeTrail(T, from, to, { maxSlope: 0.7, res: 2, avoidPolys: avoid, seed, maxPoints: 12, wet: riversOf(sid) });
      const points = (r.points || [from, to]).map(([x, z]) => [r2(x), r2(z)]);
      points[0] = from; points[points.length - 1] = to;
      sid.paths.push({ id, kind: "trail", width: theme.trail.width, points, surface: theme.trail.surface, label: "支路", generated: true, auto_spur: true });
      added.push(id); any = true;
    }
    if (!any) break;
  }
  return added;
}
/**
 * 主路是不是为躲开人放的房子绕了路：只看贴着主路（底面 6 m 内）的那几栋；把它们从禁行区拿掉再算一次 A*，
 * 新路穿过（外扩 1 m 的）底面的就是「为它绕行」。没有贴路的房子时不多算。
 * @returns {string[]} 房子 id（按 id 排序）
 */
function detourAround(T, from, to, points, houses, avoidVols, seed, wet) {
  const near = houses.filter((v) => polyToPolylineDist(expandedFootprint(v, 0), points) < 6);
  if (!near.length) return [];
  const keep = avoidVols.filter((v) => !near.includes(v)).map((v) => expandedFootprint(v, v.kind === "building" ? 2.5 : 1));
  const r = routeTrail(T, from, to, { maxSlope: 0.7, res: 2, avoidPolys: keep, seed, wet });
  if (!r.points) return [];
  return near.filter((v) => polyToPolylineDist(expandedFootprint(v, 1), r.points) === 0).map((v) => v.id).sort();
}
/** 溪（给 A* 加代价：过溪直着过，不顺着溪床走） */
export function riversOf(sid) { return (sid.paths || []).filter((p) => p && p.kind === "river"); }
/** 体块底面四角外扩 margin 米（给 A* 当禁行区） */
export function expandedFootprint(v, margin) { return boxCorners(v.position, [v.size[0] + 2 * margin, v.size[1], v.size[2] + 2 * margin], v.rotation_y || 0); }

/**
 * 解析：buildTerrain → 清掉 generated 的房 / 树 / 自动支路 / 关系（旧模式还清主路）→ 地标与出生点贴地
 * →（旧模式）主路 A* 出生点 → 地标门前，不可达退回之字 → 自动支路 → 刷新空间 → layoutHouses（regions[].building 决定形制与尺寸）
 * → relations.analyze 写回 relations 与 checks → 空间检查 → validate。
 * 溪、人画的路、plan 编译的路、relations fix 补的支路（spur_*，无 auto_spur）都保留。
 * 确定性：同 (sid, seed) 两次调用的 sid / checks / facts 逐字节相同；耗时在返回值顶层 ms，不进 facts。
 * @param {object} sid 文档（原地修改并返回）
 * @param {{seed?: number, autoSpur?: boolean}} [opts] seed 默认 sid.meta.seed，再默认 1；autoSpur 默认 true
 * @returns {{sid: object, T: object, checks: object[], facts: object, ms: number}}
 *   facts 含 houses / trees / forms / stilt_houses / perTerrace / rejected / trail / spurs / bridges / spaces / validation / errors
 */
export function resolve(sid, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const seed = (Number(opts.seed ?? (sid.meta && sid.meta.seed) ?? 1) >>> 0) || 1;
  const theme = themeOf(sid);
  const planMode = !!(sid.meta && sid.meta.plan_mode);
  for (const k of ["volumes", "regions", "paths", "markers", "spaces", "relations", "constraints"]) sid[k] = Array.isArray(sid[k]) ? sid[k] : [];
  const T = buildTerrain(sid, { res: 2 });
  // 层表写回文档（docs/07 §7）：terrain.layers = 引擎找的或人定的全表，meta.layer_zero = 0 层的高度（出生点所在层 / 人定 / 基准面）；导出 / 评分脚本直接读它
  sid.terrain.layers = T.layerTable.map((l) => Object.assign({}, l));
  sid.meta = sid.meta || {};
  sid.meta.layer_zero = r2(T.layers[T.zero]); sid.meta.layer_zero_from = T.zeroFrom;

  // 清掉上次 resolve 生成的对象（旧模式连主路一起；plan 模式的路是编译出来的，只清自动支路）
  sid.volumes = sid.volumes.filter((v) => v && !v.generated);
  sid.paths = sid.paths.filter((p) => p && !(p.generated && (p.auto_spur || (!planMode && p.id === MAIN_TRAIL_ID))));
  sid.relations = sid.relations.filter((r) => r && !r.generated);
  const v2 = planMode && Number(sid.meta.plan_version) >= 2;
  // 人拖过的房子（user_moved）贴到当前地面（台地单独调高后跟着走）
  for (const v of sid.volumes) if (v.user_moved && !v.rests_on && !v.land && Array.isArray(v.position)) v.position[1] = r2(T.heightAt(v.position[0], v.position[2]));

  const landmarks = sid.volumes.filter((v) => v.importance === "landmark");
  const landmark = (sid.meta && sid.meta.focus && landmarks.find((v) => v.id === sid.meta.focus)) || landmarks[0] || sid.volumes.find((v) => v.id === LANDMARK_ID) || null;
  const spawn = sid.markers.find((m) => m.kind === "player_spawn") || null;
  // 地标与出生点重新贴地（桥 / 吊脚楼的高度由编译决定，不动）；plan v2 的体块按各自的 land 规则重新落地，出生点站在体块上时跟着它
  if (v2) {
    landVolumes(sid, T);
    if (spawn && spawn.position) { const on = spawn.rests_on && sid.volumes.find((v) => v.id === spawn.rests_on); spawn.position[1] = r2(on ? on.position[1] + on.size[1] : groundAt(T, waterRegions(sid), spawn.position[0], spawn.position[2])); }
  } else for (const o of [...(planMode ? landmarks : [landmark]), spawn]) if (o && o.position && o.form !== "bridge" && o.form !== "stilt_house" && !o.rests_on) o.position[1] = r2(T.heightAt(o.position[0], o.position[2]));
  // 立在别的地标身上的（桥心楼阁）：跟着它的桥面 / 顶面走
  for (const o of sid.volumes) if (o && o.rests_on && !o.land && o.position) { const b = sid.volumes.find((x) => x.id === o.rests_on); if (b && b.position && b.size) o.position[1] = r2(b.form === "bridge" ? b.position[1] : b.position[1] + b.size[1]); }
  if (!planMode && landmark && spawn) { landmark.rotation_y = rotationToward(xz(landmark.position), xz(spawn.position)); spawn.rotation_y = rotationToward(xz(spawn.position), xz(landmark.position)); }
  const poi = sid.markers.find((m) => m.id === POI_ID);
  if (poi && landmark) poi.position = [landmark.position[0], r2(landmark.position[1] + landmark.size[1]), landmark.position[2]];

  // 人放的体块（地标除外）外扩：房子 2.5 m（路中心离房边 ≥ 2.5，「房子不压路」才成立），其它 1 m；plan 模式地标也避开 1 m
  const userHouse = (v) => v.kind === "building" && v.importance !== "landmark";
  const avoidVols = spawn ? sid.volumes.filter((v) => (planMode || v !== landmark) && v.position && v.size && !v.generated && !pointInPolygon(xz(spawn.position), boxCorners(v.position, v.size, v.rotation_y || 0))) : [];
  const avoid = avoidVols.map((v) => expandedFootprint(v, userHouse(v) ? 2.5 : 1));
  let trailFacts = null, spurs = [];
  if (!planMode && landmark && spawn) {
    const from = xz(spawn.position), to = landmarkDoor(landmark, from, T);
    let r = routeTrail(T, from, to, { maxSlope: 0.7, res: 2, avoidPolys: avoid, seed, wet: riversOf(sid) });
    let fallback = null;
    if (!r.points) { fallback = r.facts.reason || "不可达"; r = zigzagTrail(T, from, to, { folds: 3, maxSlope: 0.7 }); }
    const points = r.points.map(([x, z]) => [r2(x), r2(z)]);
    points[0] = [from[0], from[1]]; points[points.length - 1] = [to[0], to[1]];
    const detour = fallback ? [] : detourAround(T, from, to, points, avoidVols.filter(userHouse), avoidVols, seed, riversOf(sid));
    sid.paths.push(Object.assign({ id: MAIN_TRAIL_ID, kind: "trail", width: theme.trail.width, points, surface: theme.trail.surface, label: theme.trail.label, generated: true }, detour.length ? { detour_around: detour } : {}));
    trailFacts = Object.assign(pathFacts(points, T), { fallback, end_to_landmark_m: r2(dist2(to, xz(landmark.position))) }, detour.length ? { detour_around: detour } : {});
    delete trailFacts.segments;
  } else if (planMode) {
    const main = sid.paths.find((p) => p.id === MAIN_TRAIL_ID);
    if (main) { trailFacts = Object.assign(pathFacts(main.points, T), main.fallback ? { fallback: main.fallback } : {}); delete trailFacts.segments; }
  }
  // 自动支路：主路够不到的台地（在布房之前补，房子才会避开它）
  if (opts.autoSpur !== false) spurs = addAutoSpurs(sid, T, theme, seed, avoid);
  // 多层空间：按当前地形刷新（在布房之前，房子会避开连接点）
  refreshSpaces(sid, T);

  // 房子与树（避开路、溪、支路、地标与人放的体块；区域的 building 决定形制）
  const density = Number(sid.meta && sid.meta.density_scale) || 1;
  const L = layoutHouses(sid, T, { seed, density });
  for (const v of L.volumes) sid.volumes.push(v);

  // 关系与检查
  const A = analyze(sid, T);
  for (const rel of A.relations) if (facesConsistent(sid, rel)) sid.relations.push(rel);
  const checks = A.checks.concat(spaceChecks(sid, T));
  const validation = validate(sid, T);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const builds = L.volumes.filter((v) => v.kind === "building"), forms = {};
  for (const v of builds) forms[v.form || "house"] = (forms[v.form || "house"] || 0) + 1;
  const facts = {
    seed, archetype: (sid.meta && sid.meta.archetype) || null, terraces: T.terraces.length,
    houses: builds.length, trees: L.volumes.filter((v) => v.kind === "prop").length, forms,
    stilt_houses: builds.filter((v) => v.form === "stilt_house" && v.stilt_m > 0.5).length,
    perTerrace: L.perTerrace, rejected: L.rejected, filled: L.filled, trail: trailFacts, spurs, has_stream: sid.paths.some((p) => p.kind === "river"),
    bridges: bridgesOf(sid), // 地标桥 + 路过溪处 = 桥（BRIEF 与俯视图都按它画）
    spaces: spaceFacts(sid),
    checks_ok: checks.filter((c) => c.ok).length, checks_total: checks.length,
    validation, errors: validation.filter((m) => m.level === "error").length,
  };
  return { sid, T, checks, facts, ms: r2(now - t0) };
}

/** 桥：form = bridge 的地标（带 landmark id）+ 路过溪处（落在地标桥底面 4 m 内的不重复算） */
function bridgesOf(sid) {
  const out = [];
  for (const v of sid.volumes || []) {
    if (!v || v.form !== "bridge" || !Array.isArray(v.span_ends)) continue;
    const [a, b] = v.span_ends, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push({ path: null, landmark: v.id, at: [r2((a[0] + b[0]) / 2), r2((a[1] + b[1]) / 2)], dir: [r2((b[0] - a[0]) / L), r2((b[1] - a[1]) / L)], width: r2(L), ends: [a.slice(), b.slice()] });
  }
  const near = (p) => out.some((o) => { const v = (sid.volumes || []).find((x) => x.id === o.landmark); return v && polyToPolylineDist(boxCorners(v.position, v.size, v.rotation_y || 0), [p, p]) < 4; });
  for (const c of pathCrossings(sid.paths)) if (!near(c.at)) out.push(c);
  return out;
}

/**
 * 自动生成的 faces 关系必须与房子实际朝向一致（夹角 ≤ 45°）：relations 取 40 m 内最近的路，
 * 而 layout 只在 12 m 内才让门朝路，其余朝下坡，所以把说不通的 faces 丢掉，避免 validate 报朝向偏差。
 */
function facesConsistent(sid, rel) {
  if (rel.type !== "faces") return true;
  const a = sid.volumes.find((v) => v.id === rel.a);
  if (!a || !Number.isFinite(a.rotation_y)) return true;
  const c = xz(a.position);
  let target = null;
  const path = sid.paths.find((p) => p.id === rel.b);
  if (path) { let bd = Infinity; for (let i = 0; i < path.points.length - 1; i++) { const q = nearestOnSeg(c, path.points[i], path.points[i + 1]); const d = dist2(c, q); if (d < bd) { bd = d; target = q; } } }
  else { const o = sid.volumes.find((v) => v.id === rel.b) || sid.markers.find((m) => m.id === rel.b); if (o) target = xz(o.position); }
  if (!target) return true;
  const t = (a.rotation_y * Math.PI) / 180, f = [-Math.sin(t), -Math.cos(t)], d = dist2(c, target) || 1;
  return (f[0] * (target[0] - c[0]) + f[1] * (target[1] - c[1])) / d >= Math.cos((45 * Math.PI) / 180);
}
function nearestOnSeg(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0, 1);
  return [a[0] + t * dx, a[1] + t * dz];
}

// ------------------------------------------------------------ 台地单独调高（剖面拖平台段）
/**
 * 只改一层台地的高度：height 吸附 0.5 m，写 user_height: true，边缘坡面 skirt 跟着重算。改完调用方再 resolve。
 * （plan 模式下重编译会重放地形；要持久就把高度写回 plan 的 layer / from_layer。）
 * @param {object} sid 文档（原地修改并返回）
 * @param {string} id terrain.features 的 id
 * @param {number} height 米
 * @returns {object} sid
 */
export function setTerraceHeight(sid, id, height) {
  const f = ((sid.terrain && sid.terrain.features) || []).find((x) => x && x.id === id);
  const h = Math.round(Number(height) * 2) / 2;
  if (!f || !Number.isFinite(h)) return sid;
  Object.assign(f, { height: h, skirt: f.cliff ? f.skirt : clamp(Math.abs(h) * 0.8, 2, 10), user_height: true });
  return sid;
}
/**
 * 恢复一层台地的规则高度：height = level × 层高，去掉 user_height。
 * @returns {object} sid
 */
export function resetTerraceHeight(sid, id) {
  const f = ((sid.terrain && sid.terrain.features) || []).find((x) => x && x.id === id);
  if (!f || !f.user_height) return sid;
  const layer = Number(sid.meta && sid.meta.layer_height_m) || DEFAULT_LAYER_M;
  const h = r2((Number(f.level) || 0) * layer);
  Object.assign(f, { height: h, skirt: f.cliff ? f.skirt : clamp(h * 0.8, 2, 10) });
  delete f.user_height;
  return sid;
}

// ------------------------------------------------------------ snapshot / restore
/**
 * 序列化为 JSON 字符串（丢掉 `_` 开头的临时字段与函数）。
 * @param {object} sid
 * @returns {string}
 */
export function snapshot(sid) { return JSON.stringify(sid, (k, v) => (typeof k === "string" && k.startsWith("_") ? undefined : v)); }

/**
 * 从 snapshot 的 JSON（字符串或已解析对象）恢复文档；缺失的集合补成空数组。
 * @param {string|object} json
 * @returns {object} sid
 */
export function restore(json) {
  const sid = typeof json === "string" ? JSON.parse(json) : clone(json);
  for (const k of ["volumes", "regions", "paths", "markers", "spaces", "relations", "constraints", "views"]) if (!Array.isArray(sid[k])) sid[k] = [];
  sid.terrain = sid.terrain || { base: "flat", base_height: 0, features: [] };
  if (!Array.isArray(sid.terrain.features)) sid.terrain.features = [];
  sid.meta = sid.meta || {};
  return sid;
}

