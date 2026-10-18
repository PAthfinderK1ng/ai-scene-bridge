// fixtures.js — 测试共用的 SID 样例（由原型生成，确定性）
import { generateArchetype, DEFAULT_BOUNDS } from "../terrain.js";

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
