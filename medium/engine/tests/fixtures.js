// fixtures.js — 测试共用的 SID 样例（由原型生成，确定性）
import { DEFAULT_BOUNDS, rng, clamp, r2, polygonCentroid, polygonRadius, DEFAULT_LAYER_M, MIN_BAND, MIN_BAND_HARD } from "../terrain.js";

export function baseSid(name = "测试山村") {
  return {
    sid_version: "0.1",
    meta: { name, units: "meters", up_axis: "+Y", handedness: "right", north: "-Z", player_height: 1.7, grid: 0.5, layer_height_m: 3 },
    intent: { summary: "", mood: [] },
    style: { palette: [["roof", "#4A4A4A", "青瓦"], ["wall", "#D9C9A3", "夯土墙"], ["stone", "#9A9890", "石阶"], ["foliage", "#4F6B3A", "树"], ["mist", "#DDE6F0", "雾"]].map(([role, hex, note]) => ({ role, hex, note })), references: [], lighting: { time_of_day: "dusk", sun_azimuth_deg: 250, sun_elevation_deg: 12 }, material_intents: {} },
    bounds: JSON.parse(JSON.stringify(DEFAULT_BOUNDS)),
    terrain: { base: "flat", base_height: 0, features: [] },
    volumes: [], regions: [], paths: [], markers: [], relations: [], constraints: [], views: [], asset_hints: {},
  };
}

/** 之字坡，4 层，入口南，地标在顶，出生点在南边山脚 */
export function villageSid(seed = 7) {
  const sid = baseSid();
  const g = generateArchetype("slope_zigzag", { entry_side: "S", terraces: 4, layer_height_m: 3, plateau_width: "medium" }, sid.bounds, seed);
  sid.terrain.features = g.features;
  const [lx, lz] = g.spots.top;
  const h = 9; // 地标高度交给调用方用 terrain 贴地；这里 y 先置 0
  sid.volumes.push({ id: "landmark", kind: "building", shape: "box", position: [lx, 0, lz], size: [8, h, 8], rotation_y: 180, label: "山顶寺", importance: "landmark", color_role: "roof" });
  sid.markers.push({ id: "spawn", kind: "player_spawn", position: [g.entries.S[0], 0, g.entries.S[1]], rotation_y: 0, label: "入口" });
  sid.regions = g.features.map((f) => ({ id: "r_" + f.id, kind: "other", polygon: f.polygon, density: 1, label: f.label, terrace_level: f.level }));
  sid._archetype = g;
  return sid;
}

/** 溪谷双坡，3 层，入口南 */
export function valleySid(seed = 3) {
  const sid = baseSid("溪谷");
  const g = generateArchetype("valley_two_banks", { entry_side: "S", terraces: 3, layer_height_m: 3, plateau_width: "medium" }, sid.bounds, seed);
  sid.terrain.features = g.features;
  sid.paths.push({ id: "stream", kind: "river", width: 4, points: g.stream, surface: "water", label: "溪" });
  const [lx, lz] = g.spots.top;
  sid.volumes.push({ id: "landmark", kind: "building", shape: "box", position: [lx, 0, lz], size: [6, 8, 6], rotation_y: 180, label: "水车", importance: "landmark" });
  sid.markers.push({ id: "spawn", kind: "player_spawn", position: [g.entries.S[0], 0, g.entries.S[1]], rotation_y: 0, label: "入口" });
  sid.regions = g.features.map((f) => ({ id: "r_" + f.id, kind: "other", polygon: f.polygon, density: 0.8, label: f.label, terrace_level: f.level }));
  sid._archetype = g;
  return sid;
}

/** 入口在 E / W 时把局部坐标（入口在南）转过去 */
function rotateXZ([x, z], side) {
  if (side === "E") return [z, -x];
  if (side === "W") return [-z, x];
  return [x, z];
}
export const ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"];
// ------------------------------------------------------------ v3 原型生成器（只给测试造样例；产品里地形来自 plan.js）
const WIDTHS = { narrow: 22, medium: 32, wide: 42 };
/** 村口（spots.entry）：最低一层朝入口的边往里 3 m，夹在离入口山脚（valley_bottom）8–11 m；边太远时落在边外同高（第 1 层）的平地 */
const entryZ = (edgeZ, vbZ) => clamp(edgeZ - 3, vbZ - 11, vbZ - 8);

function jitterPoly(poly, amt, rand) { return poly.map(([x, z]) => [r2(x + (rand() - 0.5) * 2 * amt), r2(z + (rand() - 0.5) * 2 * amt)]); }

export function generateArchetype(name, params = {}, bounds = DEFAULT_BOUNDS, seed = 1) {
  const p = Object.assign({ entry_side: "S", terraces: 4, layer_height_m: DEFAULT_LAYER_M, plateau_width: "medium", stream: false }, params);
  const n = clamp(Math.round(p.terraces), 3, 7);
  const layer = clamp(Number(p.layer_height_m) || DEFAULT_LAYER_M, 2.5, 6);
  const rand = rng(seed);
  const side = ["S", "E", "W"].includes(p.entry_side) ? p.entry_side : "S";
  const half = WIDTHS[p.plateau_width] || WIDTHS.medium;
  const ext = Math.min(bounds.max[0], -bounds.min[0], bounds.max[2], -bounds.min[2]) - 1; // 局部坐标里离中心最远可用（米）
  const zSouth = 42, zNorth = -46; // 局部坐标：入口在南(+z)，上坡朝北
  const features = [];
  let stream = null;
  const spots = {}, entries = {};
  let summit, valley_bottom;

  if (name === "ring_terrace") {
    // 环带宽 ≥ 8 m（够放一排房）；最外一圈出 bounds 时先收带宽（不低于 7 m），再收广场半径
    const mid = Math.floor(n / 2), cz = 2, room = ext - cz - 1.5;
    let rp = half * 0.45, bw = Math.max(MIN_BAND, (zSouth - zNorth) / 2 / (n - mid + 1.0));
    const rings = Math.max(mid, n - 1 - mid) || 1;
    if (rp + rings * bw > room) bw = Math.max(MIN_BAND_HARD, (room - rp) / rings);
    if (rp + rings * bw > room) rp = Math.max(6, room - rings * bw);
    const arc = (r0, r1, a0, a1, cz) => { const pts = []; const N = 7; for (let k = 0; k <= N; k++) { const a = a0 + ((a1 - a0) * k) / N; pts.push([r1 * Math.cos(a), cz + r1 * Math.sin(a)]); } for (let k = N; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / N; pts.push([r0 * Math.cos(a), cz + r0 * Math.sin(a)]); } return pts.map(([x, z]) => [r2(x), r2(z)]); };
    // 广场（中层）
    const plaza = []; for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; plaza.push([r2(rp * Math.cos(a)), r2(cz + rp * 0.8 * Math.sin(a))]); }
    features.push({ id: "terrace_" + mid, kind: "plateau", level: mid, polygon: plaza, label: `第 ${mid + 1} 层 · 广场` });
    // 北半环（上坡）
    for (let k = mid + 1; k < n; k++) { const r0 = rp + (k - mid - 1) * bw, r1 = rp + (k - mid) * bw; features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: jitterPoly(arc(r0, r1, Math.PI, Math.PI * 2, cz), 1.2, rand), label: `第 ${k + 1} 层` }); }
    // 南半环（下坡，朝入口）
    for (let k = mid - 1; k >= 0; k--) { const r0 = rp + (mid - k - 1) * bw, r1 = rp + (mid - k) * bw; features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: jitterPoly(arc(r0, r1, 0, Math.PI, cz), 1.2, rand), label: `第 ${k + 1} 层` }); }
    const topR = rp + (n - 1 - mid) * bw;
    spots.top = [0, cz - topR * 0.55]; spots.ridge_end = [topR * 0.7, cz - topR * 0.5]; spots.plaza = [0, cz];
    spots.cliff_edge = [0, cz - topR + bw * 0.5]; // 顶层环带正中、朝广场与入口的那一侧
    summit = [0, cz - topR - 3]; valley_bottom = [0, zSouth + 8];
    spots.entry = [0, entryZ(cz + rp + mid * bw, valley_bottom[1])];
    entries.S = [0, zSouth + 12]; entries.E = [58, cz + 8]; entries.W = [-58, cz + 8];
  } else if (name === "valley_two_banks") {
    // 两岸各 n 条带，每条 ≥ 8 m（层多放不下时收到不低于 7 m）；外缘 + 溪的摆幅 + 抖动不出 bounds，放不下先收摆幅
    const gap = 7, want = Math.max(MIN_BAND, Math.min(half * 1.45, 45) / n);
    const fit = (amp) => (ext - 0.8 - amp - gap) / n;
    let amp = 4, bw = Math.min(want, fit(amp));
    if (bw < MIN_BAND) { amp = 2; bw = Math.max(MIN_BAND_HARD, Math.min(want, fit(amp))); }
    if (bw > fit(amp)) amp = Math.max(0, ext - 0.8 - gap - n * bw);
    const sx = (z) => amp * Math.sin(z / 15);
    const band = (sign, k) => { const inner = gap + k * bw, outer = gap + (k + 1) * bw; const pts = []; for (let z = zNorth; z <= zSouth; z += 11) pts.push([sign * (sx(z) + inner), z]); for (let z = zSouth; z >= zNorth; z -= 11) pts.push([sign * (sx(z) + outer), z]); return pts.map(([x, z]) => [r2(x), r2(z)]); };
    for (let k = 0; k < n; k++) {
      features.push({ id: `terrace_w_${k}`, kind: "plateau", level: k, polygon: jitterPoly(band(-1, k), 0.8, rand), label: `西坡第 ${k + 1} 层` });
      features.push({ id: `terrace_e_${k}`, kind: "plateau", level: k, polygon: jitterPoly(band(1, k), 0.8, rand), label: `东坡第 ${k + 1} 层` });
    }
    stream = []; for (let z = -60; z <= 60; z += 4) stream.push([r2(sx(z)), z]);
    const outer = gap + n * bw;
    spots.top = [outer - bw * 0.5, -30]; spots.ridge_end = [outer - bw * 0.5, -44];
    spots.cliff_edge = [sx(-12) + outer - bw * 0.5, -12]; // 东岸顶层、朝谷口一段：俯瞰溪谷
    const midK = Math.floor(n / 2); spots.plaza = [sx(10) + gap + midK * bw + bw * 0.5, 10]; // 「中层广场」= 东岸中间那层
    summit = [outer - bw * 0.5, -44]; valley_bottom = [sx(zSouth + 8), zSouth + 8];
    spots.entry = [sx(zSouth + 2) + gap + 0.5, zSouth + 2]; // 谷口东岸、溪边 7.5 m 的平地（与最低层同高）
    entries.S = [sx(54), 54]; entries.E = [58, 0]; entries.W = [-58, 0];
  } else { // slope_zigzag（默认）
    const depth = (zSouth - zNorth) / n;
    for (let k = 0; k < n; k++) {
      const zb = zSouth - k * depth, zt = zb - depth;
      const w = half * (1 - (0.28 * k) / Math.max(1, n - 1));
      const poly = jitterPoly([[-w, zt], [w, zt], [w, zb], [-w, zb]], 1.5, rand);
      features.push({ id: "terrace_" + k, kind: "plateau", level: k, polygon: poly, label: `第 ${k + 1} 层` });
    }
    const topW = half * (1 - 0.28), zTop = zNorth;
    spots.top = [0, zTop + depth * 0.5]; spots.ridge_end = [topW * 0.75, zTop + depth * 0.5]; spots.cliff_edge = [0, zSouth - (n - 1) * depth - 2]; spots.plaza = [0, zSouth - Math.floor(n / 2) * depth - depth / 2];
    summit = [0, zTop + 2]; valley_bottom = [0, zSouth + 8];
    spots.entry = [0, entryZ(zSouth, valley_bottom[1])];
    entries.S = [0, zSouth + 12]; entries.E = [58, zSouth - depth * 1.2]; entries.W = [-58, zSouth - depth * 1.2];
  }
  if (p.stream && !stream) { stream = []; for (let z = -60; z <= 60; z += 4) stream.push([r2(-half - 6 + 3 * Math.sin(z / 12)), z]); }

  // 旋转到入口方位，回填 center / radius / height
  const rot = (pt) => rotateXZ(pt, side).map(r2);
  for (const f of features) { f.polygon = f.polygon.map(rot); const c = polygonCentroid(f.polygon); f.center = [r2(c[0]), 0, r2(c[1])]; f.radius = r2(polygonRadius(f.polygon, c)); f.height = r2(f.level * layer); f.skirt = clamp(f.height * 0.8, 2, 10); f.notes = f.notes || ""; }
  if (stream) stream = stream.map(rot);
  for (const k of Object.keys(spots)) spots[k] = rot(spots[k]);
  const E = {}; for (const k of Object.keys(entries)) E[k] = rot(entries[k]);
  // 入口的方位标签随旋转：S 永远表示「入口所在边」= side
  const entriesWorld = { S: E.S, E: E.E, W: E.W };
  if (side === "E") { entriesWorld.E = E.S; entriesWorld.S = E.E; entriesWorld.W = E.W; }
  if (side === "W") { entriesWorld.W = E.S; entriesWorld.S = E.W; entriesWorld.E = E.E; }
  // 保证入口在 bounds 内
  const b = bounds;
  for (const k of Object.keys(entriesWorld)) entriesWorld[k] = [clamp(entriesWorld[k][0], b.min[0] + 2, b.max[0] - 2), clamp(entriesWorld[k][1], b.min[2] + 2, b.max[2] - 2)];
  return { features, stream, spots, entries: entriesWorld, summit: rot(summit), valley_bottom: rot(valley_bottom).map((v, i) => clamp(v, b.min[i * 2] + 2, b.max[i * 2] - 2)), layer_height_m: layer, archetype: name, params: Object.assign({}, p, { terraces: n, layer_height_m: layer, entry_side: side }) };
}
