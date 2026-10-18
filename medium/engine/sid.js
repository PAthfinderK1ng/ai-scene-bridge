// sid.js — SID 组装：主题 → 空文档 → 落卡片（原型 / 地标 / 出生点 / 区域 / 风格）→ resolve（布局 → 路由 → 关系 → 校验）→ 结构 patch
// 约定见 SPEC.md 第 8 节。铁律：LLM 永远不写坐标——这里每一个坐标都来自 terrain / layout / routing 的确定性算法，
// 卡片（Card）里只有结构级选择（原型名、层数、入口方位、地标放在「哪类位置」、每层密度、调色板角色）和文案。
// 随机只来自 seed：applyCard 用 card.seed（默认 1）生成多边形，resolve 用 opts.seed 布局与路由。

import { buildTerrain, generateArchetype, ARCHETYPES, DEFAULT_BOUNDS, DEFAULT_LAYER_M, pointInPolygon, distToPolygon, clamp, r2 } from "./terrain.js";
import { layoutHouses, HOUSE_SIZES, boxCorners, facingToRotation } from "./layout.js";
import { routeTrail, zigzagTrail, pathFacts } from "./routing.js";
import { analyze, unreachedTerraces } from "./relations.js";
import { validate } from "./validate.js";
import { paletteShift, ROLES, SHIFT_MODES } from "./color.js";

// ------------------------------------------------------------ 主题
/**
 * 主题：一套默认的调色板、范围、层高、玩家高度、房屋尺寸与地标词表。
 * `landmarks` 的键是 Card.landmark.kind 的取值；label 是默认中文标签，size 是默认 [宽, 高, 深]。
 */
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
    landmarks: {
      temple: { label: "山顶寺", size: [8, 9, 8], kind: "building", shape: "box", color_role: "roof" },
      pagoda: { label: "石塔", size: [5, 14, 5], kind: "building", shape: "cylinder", color_role: "stone" },
      tree: { label: "神木", size: [7, 16, 7], kind: "prop", shape: "cylinder", color_role: "foliage" },
      wheel: { label: "水车", size: [6, 8, 6], kind: "building", shape: "cylinder", color_role: "wall" },
      gate: { label: "牌楼", size: [8, 7, 3], kind: "building", shape: "box", color_role: "roof" },
    },
    stream: { width: 4, label: "溪" },
    trail: { width: 2, label: "主路", surface: "stone" },
  },
});

/** Card 的默认值（applyCard 用它补齐 LLM 没给的字段） */
const CARD_DEFAULTS = Object.freeze({
  name: "", one_liner: "", archetype: "slope_zigzag", seed: 1,
  params: { entry_side: "S", terraces: 4, layer_height_m: DEFAULT_LAYER_M, plateau_width: "medium", stream: false },
  landmark: { kind: "temple", placement: "top" },
  spawn: { placement: "valley_bottom" },
  regions: [], palette: null, palette_shift: "neutral", density_scale: 1,
  lighting: {}, mood: [], summary: "",
});
const LANDMARK_PLACEMENTS = ["top", "ridge_end", "cliff_edge", "plaza"];
const SPAWN_PLACEMENTS = ["valley_bottom", "side_slope", "summit", "S", "E", "W"];
const MAIN_TRAIL_ID = "main_trail", STREAM_ID = "stream", LANDMARK_ID = "landmark", SPAWN_ID = "spawn", POI_ID = "landmark_poi";

// ------------------------------------------------------------ 小工具
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const xz = (pos) => [pos[0], pos[2]];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const themeOf = (sid) => THEME[(sid.meta && sid.meta.theme) || "mountain_village"] || THEME.mountain_village;
const DEG = Math.PI / 180;
/** 用户圈的区域：schema 的 user_set，或 id 不是引擎按台地生成的 r_<feature id>（applyCard 重建台地 region 时保留） */
const isUserRegion = (r) => r && (r.user_set === true || !String(r.id).startsWith("r_"));

/** 深合并：对象递归、数组替换（regions / palette 另有按键合并，见 mergeCard） */
function deepMerge(base, patch) {
  if (!isObj(patch)) return patch === undefined ? base : clone(patch);
  const out = isObj(base) ? clone(base) : {};
  for (const k of Object.keys(patch)) out[k] = isObj(patch[k]) && isObj(out[k]) ? deepMerge(out[k], patch[k]) : clone(patch[k]);
  return out;
}
/** 按键合并数组：同键条目字段覆盖，新键追加；顺序按键排序保证确定性 */
function mergeByKey(baseArr, patchArr, key) {
  const map = new Map();
  for (const it of baseArr || []) if (isObj(it)) map.set(String(it[key]), clone(it));
  for (const it of patchArr || []) if (isObj(it)) map.set(String(it[key]), Object.assign(map.get(String(it[key])) || {}, clone(it)));
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })).map((e) => e[1]);
}
/** 朝向 to 的 rotation_y；两点重合时 0 */
function rotationToward(from, to) {
  const d = dist2(from, to);
  return d < 1e-6 ? 0 : facingToRotation([(to[0] - from[0]) / d, (to[1] - from[1]) / d]);
}
/** 把 [x,z] 夹进 bounds（留 margin） */
function clampXZ(p, b, margin = 2) { return [r2(clamp(p[0], b.min[0] + margin, b.max[0] - margin)), r2(clamp(p[1], b.min[2] + margin, b.max[2] - margin))]; }

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
    volumes: [], regions: [], paths: [], markers: [], relations: [], constraints: [], views: [], asset_hints: {},
  };
}

/** 把 LLM 给的卡片补齐默认值、夹取非法枚举，返回规范化的新对象（不改入参） */
export function normalizeCard(card = {}) {
  const c = deepMerge(CARD_DEFAULTS, card || {});
  c.regions = mergeByKey([], card && card.regions, "terrace").filter((r) => Number.isFinite(Number(r.terrace)));
  c.palette = card && Array.isArray(card.palette) ? mergeByKey([], card.palette, "role") : null;
  if (!ARCHETYPES.includes(c.archetype)) c.archetype = CARD_DEFAULTS.archetype;
  if (!LANDMARK_PLACEMENTS.includes(c.landmark.placement)) c.landmark.placement = "top";
  if (!SPAWN_PLACEMENTS.includes(c.spawn.placement)) c.spawn.placement = "valley_bottom";
  if (!SHIFT_MODES.includes(c.palette_shift)) c.palette_shift = "neutral";
  c.density_scale = clamp(Number(c.density_scale) || 1, 0, 2);
  c.seed = (Number(c.seed) >>> 0) || 1;
  if (!Array.isArray(c.mood)) c.mood = c.mood ? [String(c.mood)] : [];
  return c;
}

/** 调色板：卡片给的按 role 覆盖主题默认，缺的角色用主题补齐，再按 palette_shift 偏移。顺序固定为 ROLES。 */
function resolvePalette(theme, card) {
  const byRole = new Map(theme.palette.map((p) => [p.role, p]));
  for (const p of card.palette || []) if (p && p.role && /^#[0-9a-fA-F]{6}$/.test(p.hex || "")) byRole.set(p.role, { role: p.role, hex: p.hex, note: p.note || (byRole.get(p.role) || {}).note || "" });
  const ordered = [...ROLES.filter((r) => byRole.has(r)), ...[...byRole.keys()].filter((r) => !ROLES.includes(r))].map((r) => clone(byRole.get(r)));
  return card.palette_shift && card.palette_shift !== "neutral" ? paletteShift(ordered, card.palette_shift) : ordered;
}

/** 「侧坡」出生点：从中间层台地质心朝东入口走出台地边缘再外推 4 m（没有台地时回退到东入口） */
function sideSlopePoint(g, T, bounds) {
  const ts = T.terraces;
  if (!ts.length) return g.entries.E;
  const t = ts[Math.floor(ts.length / 2)], c = t.centroid, e = g.entries.E;
  const L = dist2(c, e);
  if (L < 1e-6) return e;
  const u = [(e[0] - c[0]) / L, (e[1] - c[1]) / L];
  let d = 0;
  while (d < L && pointInPolygon([c[0] + u[0] * d, c[1] + u[1] * d], t.polygon)) d += 1;
  d = Math.min(L, d + 4);
  return clampXZ([c[0] + u[0] * d, c[1] + u[1] * d], bounds);
}

/**
 * placement = top 时保证地标真的落在最高层台地内：原型给的 spots.top 若不在顶层（环台原型的顶层是一条窄弧带），
 * 就在顶层多边形里挑一个最靠内的点（候选：质心、对边顶点中点、顶点向质心收 3 m），全部确定性。
 */
function snapToTopTerrace(spot, T, bounds) {
  const top = T.topTerrace();
  if (!top) return spot;
  const at = T.terraceAt(spot[0], spot[1]);
  if (at && at.id === top.id) return spot;
  const poly = top.polygon, n = poly.length, c = top.centroid;
  const cands = [c];
  for (let i = 0; i < n; i++) { const j = n - 1 - i; if (j !== i) cands.push([(poly[i][0] + poly[j][0]) / 2, (poly[i][1] + poly[j][1]) / 2]); }
  for (const v of poly) { const d = dist2(v, c) || 1; cands.push([v[0] + ((c[0] - v[0]) / d) * 3, v[1] + ((c[1] - v[1]) / d) * 3]); }
  let best = null, bd = -1;
  for (const q of cands) {
    if (!pointInPolygon(q, poly)) continue;
    const t = T.terraceAt(q[0], q[1]);
    if (!t || t.id !== top.id) continue;
    const d = distToPolygon(q, poly);
    if (d > bd) { bd = d; best = q; }
  }
  return best ? clampXZ(best, bounds) : spot;
}

/** 出生点候选 → [x,z] */
function spawnPoint(placement, g, T, bounds) {
  if (placement === "summit") return g.summit;
  if (placement === "side_slope") return sideSlopePoint(g, T, bounds);
  if (placement === "S" || placement === "E" || placement === "W") return g.entries[placement];
  return g.valley_bottom;
}

// ------------------------------------------------------------ applyCard
/**
 * 把 LLM 的卡片提案落成 SID：原型 → terrain.features；溪 → paths[stream]；地标 → volumes[landmark] + markers[poi]；
 * 出生点 → markers[spawn]；每个台地一个 region（卡片 regions 按 terrace 层号覆盖 kind / density / label）；
 * style.palette / lighting、intent.mood / summary；meta.archetype / card_params / card / seed。
 * 会清掉上一次的 generated 对象（房子、树、主路、关系）；用户手画的 paths（generated 不为 true）、用户圈的 regions（user_set 或 id 不以 r_ 开头）
 * 与手改的台地 regions kind/density 保留。
 * @param {object} sid 文档（原地修改并返回）
 * @param {object} card SPEC 第 8 节的 Card（可只给子集）
 * @returns {object} sid
 */
export function applyCard(sid, card) {
  const theme = themeOf(sid);
  const c = normalizeCard(card);
  sid.bounds = sid.bounds || clone(theme.bounds);
  sid.meta = sid.meta || {};
  sid.terrain = sid.terrain || { base: "flat", base_height: 0, features: [] };
  for (const k of ["volumes", "regions", "paths", "markers", "relations", "constraints"]) sid[k] = Array.isArray(sid[k]) ? sid[k] : [];

  // 1. 原型 → 地形
  const g = generateArchetype(c.archetype, c.params, sid.bounds, c.seed);
  sid.meta.layer_height_m = g.layer_height_m;
  sid.terrain.features = clone(g.features);
  const T = buildTerrain(sid, { res: 2 });

  // 2. 清掉上次生成的东西（保留用户的）
  sid.volumes = sid.volumes.filter((v) => v && !v.generated && v.id !== LANDMARK_ID && v.importance !== "landmark");
  sid.paths = sid.paths.filter((p) => p && !p.generated);
  sid.relations = sid.relations.filter((r) => r && !r.generated);
  sid.constraints = sid.constraints.filter((k) => k && !k.generated);
  sid.markers = sid.markers.filter((m) => m && m.id !== SPAWN_ID && m.id !== POI_ID && m.kind !== "player_spawn");

  // 3. 溪
  if (g.stream && g.stream.length >= 2) sid.paths.push({ id: STREAM_ID, kind: "river", width: theme.stream.width, points: clone(g.stream), surface: "water", label: theme.stream.label, generated: true });

  // 4. 地标与出生点（互相朝向）
  const lmDef = theme.landmarks[c.landmark.kind] || theme.landmarks.temple;
  let lmXZ = clampXZ(g.spots[c.landmark.placement] || g.spots.top, sid.bounds);
  if (c.landmark.placement === "top") lmXZ = snapToTopTerrace(lmXZ, T, sid.bounds);
  const spXZ = clampXZ(spawnPoint(c.spawn.placement, g, T, sid.bounds), sid.bounds);
  const size = Array.isArray(c.landmark.size_m) && c.landmark.size_m.length === 3 && c.landmark.size_m.every((n) => n > 0) ? c.landmark.size_m.map(r2) : lmDef.size.slice();
  const lmY = r2(T.heightAt(lmXZ[0], lmXZ[1]));
  sid.volumes.unshift({
    id: LANDMARK_ID, kind: lmDef.kind, shape: lmDef.shape, position: [lmXZ[0], lmY, lmXZ[1]], size, rotation_y: rotationToward(lmXZ, spXZ),
    label: c.landmark.label || lmDef.label, importance: "landmark", color_role: lmDef.color_role, notes: c.landmark.notes || "",
  });
  sid.markers.push({ id: SPAWN_ID, kind: "player_spawn", position: [spXZ[0], r2(T.heightAt(spXZ[0], spXZ[1])), spXZ[1]], rotation_y: rotationToward(spXZ, lmXZ), label: "入口" });
  sid.markers.push({ id: POI_ID, kind: "poi", position: [lmXZ[0], r2(lmY + size[1]), lmXZ[1]], rotation_y: 0, label: c.landmark.label || lmDef.label });

  // 5. 区域：每个台地一个（默认 other / 1.0 ← 现有同 id 区域的 kind/density/label（用户手改）← 卡片 regions（按层号））；
  //    用户圈的区域（user_set / 非 r_ id）原样保留，追加在台地区域之后
  const prev = new Map(sid.regions.map((r) => [r.id, r]));
  const userRegions = sid.regions.filter(isUserRegion);
  const overrides = new Map(c.regions.map((r) => [Math.round(Number(r.terrace)), r]));
  sid.regions = sid.terrain.features.filter((f) => Array.isArray(f.polygon) && f.polygon.length >= 3).map((f) => {
    const id = "r_" + f.id, old = prev.get(id) || {}, ov = overrides.get(f.level) || {};
    const kind = ov.kind || old.kind || "other";
    const density = clamp(Number(ov.density ?? old.density ?? 1), 0, 1.6);
    return { id, kind, polygon: clone(f.polygon), density, label: ov.label || old.label || f.label || "", terrace_level: f.level };
  }).concat(userRegions);

  // 6. 风格与意图
  sid.style = sid.style || {};
  sid.style.palette = resolvePalette(theme, c);
  sid.style.lighting = Object.assign({}, theme.lighting, sid.style.lighting || {}, c.lighting || {});
  sid.intent = Object.assign({ summary: "", mood: [] }, sid.intent || {}, { mood: c.mood.length ? c.mood.slice() : (sid.intent && sid.intent.mood) || [], summary: c.summary || c.one_liner || (sid.intent && sid.intent.summary) || "" });
  if (c.name) sid.meta.name = c.name;

  // 7. 约束与元数据
  sid.constraints.push({ type: "locked", targets: [LANDMARK_ID, SPAWN_ID], notes: "卡片指定的地标与入口", generated: true });
  sid.constraints.push({ type: "must_reach", from: SPAWN_ID, targets: [LANDMARK_ID], notes: "主路必须从入口到达地标", generated: true });
  sid.meta.archetype = g.archetype;
  sid.meta.card_params = clone(g.params);
  sid.meta.card = c;
  sid.meta.seed = c.seed;
  sid.meta.density_scale = c.density_scale;
  return sid;
}

// ------------------------------------------------------------ resolve
/**
 * 地标「门前」一点：从地标中心退 min(半径 + 1, 5) m，主路终点落在这里（距地标中心 < 6 m）。
 * 方向优先朝出生点；地标贴台地边缘时那一侧可能已经在坡裙 / 下一层，于是依次试 ±45°、±90°、±135°、180°，
 * 取第一个与地标中心同一台地（terraceAt 相同）且在 bounds 内的点；都不行就退回朝出生点的点。
 */
function landmarkDoor(lm, spXZ, T) {
  const L = xz(lm.position), d = dist2(L, spXZ);
  if (d < 1e-6) return L;
  const off = Math.min(Math.max(lm.size[0], lm.size[2]) / 2 + 1, 5), u = [(spXZ[0] - L[0]) / d, (spXZ[1] - L[1]) / d];
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
      const r = routeTrail(T, from, to, { maxSlope: 0.7, res: 2, avoidPolys: avoid, seed, maxPoints: 12 });
      const points = (r.points || [from, to]).map(([x, z]) => [r2(x), r2(z)]);
      points[0] = from; points[points.length - 1] = to;
      sid.paths.push({ id, kind: "trail", width: theme.trail.width, points, surface: theme.trail.surface, label: "支路", generated: true, auto_spur: true });
      added.push(id); any = true;
    }
    if (!any) break;
  }
  return added;
}
/** 体块底面四角外扩 margin 米（给 A* 当禁行区） */
function expandedFootprint(v, margin) { return boxCorners(v.position, [v.size[0] + 2 * margin, v.size[1], v.size[2] + 2 * margin], v.rotation_y || 0); }

/**
 * 解析：buildTerrain → 清掉 generated 的房 / 树 / 主路 / 自动支路 / 关系 → 地标与出生点贴地、互相朝向、poi 跟到地标顶
 * → 主路（A*，出生点 → 地标门前；不可达则退回之字构造）→ 自动支路（够不到的台地）→ layoutHouses（避开主路、支路与溪）
 * → relations.analyze 写回 relations 与 checks → validate。
 * 溪（stream）、用户手画的路、relations fix 补的支路（spur_*，无 auto_spur）都保留。
 * 确定性：同 (sid, seed) 两次调用的 sid / checks / facts 逐字节相同；耗时在返回值顶层 ms，不进 facts。
 * @param {object} sid 文档（原地修改并返回）
 * @param {{seed?: number, autoSpur?: boolean}} [opts] seed 默认 sid.meta.seed，再默认 1；autoSpur 默认 true
 * @returns {{sid: object, T: object, checks: object[], facts: object, ms: number}} facts 含 houses / trees / perTerrace / rejected / trail / spurs / validation
 */
export function resolve(sid, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const seed = (Number(opts.seed ?? (sid.meta && sid.meta.seed) ?? 1) >>> 0) || 1;
  const theme = themeOf(sid);
  for (const k of ["volumes", "regions", "paths", "markers", "relations", "constraints"]) sid[k] = Array.isArray(sid[k]) ? sid[k] : [];
  const T = buildTerrain(sid, { res: 2 });

  // 清掉上次 resolve 生成的对象（主路与自动支路；用户 fix 补的支路保留）
  sid.volumes = sid.volumes.filter((v) => v && !v.generated);
  sid.paths = sid.paths.filter((p) => p && !(p.generated && (p.id === MAIN_TRAIL_ID || p.auto_spur)));
  sid.relations = sid.relations.filter((r) => r && !r.generated);

  // 地标与出生点重新贴地、互相朝向，poi 跟到地标顶（fix「挪到顶层」「入口挪到路口」挪过位置后这些都要跟着变）
  const landmark = sid.volumes.find((v) => v.importance === "landmark") || sid.volumes.find((v) => v.id === LANDMARK_ID) || null;
  const spawn = sid.markers.find((m) => m.kind === "player_spawn") || null;
  for (const o of [landmark, spawn]) if (o && o.position) o.position[1] = r2(T.heightAt(o.position[0], o.position[2]));
  if (landmark && spawn) { landmark.rotation_y = rotationToward(xz(landmark.position), xz(spawn.position)); spawn.rotation_y = rotationToward(xz(spawn.position), xz(landmark.position)); }
  const poi = sid.markers.find((m) => m.id === POI_ID);
  if (poi && landmark) poi.position = [landmark.position[0], r2(landmark.position[1] + landmark.size[1]), landmark.position[2]];

  // 主路：A* 从出生点到地标门前，避开用户放的体块；不可达时退回之字构造
  let trailFacts = null, spurs = [];
  const avoid = landmark && spawn ? sid.volumes.filter((v) => v !== landmark && v.position && v.size && !v.generated && !pointInPolygon(xz(spawn.position), boxCorners(v.position, v.size, v.rotation_y || 0))).map((v) => expandedFootprint(v, 1)) : [];
  if (landmark && spawn) {
    const from = xz(spawn.position), to = landmarkDoor(landmark, from, T);
    let r = routeTrail(T, from, to, { maxSlope: 0.7, res: 2, avoidPolys: avoid, seed });
    let fallback = null;
    if (!r.points) { fallback = r.facts.reason || "不可达"; r = zigzagTrail(T, from, to, { folds: 3, maxSlope: 0.7 }); }
    const points = r.points.map(([x, z]) => [r2(x), r2(z)]);
    points[0] = [from[0], from[1]]; points[points.length - 1] = [to[0], to[1]];
    sid.paths.push({ id: MAIN_TRAIL_ID, kind: "trail", width: theme.trail.width, points, surface: theme.trail.surface, label: theme.trail.label, generated: true });
    trailFacts = Object.assign(pathFacts(points, T), { fallback, end_to_landmark_m: r2(dist2(to, xz(landmark.position))) });
    delete trailFacts.segments;
  }
  // 自动支路：主路够不到的台地（在布房之前补，房子才会避开它）
  if (opts.autoSpur !== false) spurs = addAutoSpurs(sid, T, theme, seed, avoid);

  // 房子与树（避开主路、溪、支路、地标与用户体块）
  const density = Number(sid.meta && sid.meta.density_scale) || 1;
  const L = layoutHouses(sid, T, { seed, density });
  for (const v of L.volumes) sid.volumes.push(v);

  // 关系与检查
  const A = analyze(sid, T);
  for (const rel of A.relations) if (facesConsistent(sid, rel)) sid.relations.push(rel);
  const validation = validate(sid, T);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const facts = {
    seed, archetype: (sid.meta && sid.meta.archetype) || null, terraces: T.terraces.length,
    houses: L.volumes.filter((v) => v.kind === "building").length, trees: L.volumes.filter((v) => v.kind === "prop").length,
    perTerrace: L.perTerrace, rejected: L.rejected, trail: trailFacts, spurs, has_stream: sid.paths.some((p) => p.kind === "river"),
    checks_ok: A.checks.filter((c) => c.ok).length, checks_total: A.checks.length,
    validation, errors: validation.filter((m) => m.level === "error").length,
  };
  return { sid, T, checks: A.checks, facts, ms: r2(now - t0) };
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

// ------------------------------------------------------------ applyPatch
/**
 * LLM 的 Revise 结构 patch：形状 = Card 的任意子集 + density_scale + palette_shift。
 * 深合并到 sid.meta.card（regions 按 terrace、palette 按 role 合并）后重新 applyCard；
 * 用户手画的 paths（generated 不为 true）、用户圈的 regions（user_set / 非 r_ id）与手改的台地 regions kind/density 由 applyCard 保留。改完需调用方再 resolve。
 * 只接受结构级字段（archetype / params / landmark / spawn / regions / palette / palette_shift / density_scale / lighting / mood / summary / name / one_liner / seed），其余忽略。
 * @param {object} sid 文档（原地修改并返回）
 * @param {object} patch
 * @returns {object} sid
 */
export function applyPatch(sid, patch = {}) {
  const base = (sid.meta && sid.meta.card) || {};
  const allowed = ["name", "one_liner", "archetype", "seed", "params", "landmark", "spawn", "palette_shift", "density_scale", "lighting", "mood", "summary"];
  const p = {};
  for (const k of allowed) if (patch && patch[k] !== undefined) p[k] = patch[k];
  const card = deepMerge(base, p);
  if (patch && Array.isArray(patch.regions)) card.regions = mergeByKey(base.regions, patch.regions, "terrace");
  if (patch && Array.isArray(patch.palette)) card.palette = mergeByKey(base.palette, patch.palette, "role");
  return applyCard(sid, card);
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
  for (const k of ["volumes", "regions", "paths", "markers", "relations", "constraints", "views"]) if (!Array.isArray(sid[k])) sid[k] = [];
  sid.terrain = sid.terrain || { base: "flat", base_height: 0, features: [] };
  if (!Array.isArray(sid.terrain.features)) sid.terrain.features = [];
  sid.meta = sid.meta || {};
  return sid;
}
