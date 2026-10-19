// shapes.fixture.js — 手工 SID 夹具：覆盖全部形体 / 屋顶 / kind / 悬空 / 每种 path style / 水面 / 传送门（v5 视图自测用，不依赖 plan.js）。
// 约定（docs/06 §4.8，视图按这个画）：volumes[].position = [x, 底面绝对高度, z]；size 按形体（box / wedge / pyramid / arch [w,h,d]；
// cylinder / cone / dome / sphere / torus [直径, 高, (直径 z)]；prism [直径, 高] + sides）；elev = 底面离地；roof 只给 building / tower。
import { buildTerrain } from "../terrain.js";

export const ALL_SHAPES = ["box", "cylinder", "cone", "dome", "pyramid", "wedge", "arch", "torus", "sphere", "prism"];
export const ALL_ROOFS = ["gable", "hip", "flat", "dome", "spire", "none"];
export const ALL_STYLES = ["path", "road", "stairs", "ramp", "bridge", "rope_bridge", "tunnel", "canal", "portal"];

const PALETTE = [["roof", "#5a4e6e", "青灰瓦"], ["wall", "#d8cdb8", "石墙"], ["stone", "#9a9890", "石"], ["foliage", "#4f6b3a", "树"], ["mist", "#dde6f0", "雾"], ["accent", "#3d6fb0", "魔法蓝"]].map(([role, hex, note]) => ({ role, hex, note }));

function base(name, half = 80) {
  return {
    sid_version: "0.2",
    meta: { name, units: "meters", up_axis: "+Y", handedness: "right", north: "-Z", player_height: 1.7, grid: 0.5, layer_height_m: 4, focus: "hall" },
    intent: { summary: "", mood: [] },
    style: { palette: PALETTE, references: [], lighting: { time_of_day: "afternoon", sun_azimuth_deg: 230, sun_elevation_deg: 35 }, material_intents: {} },
    bounds: { min: [-half, -10, -half], max: [half, 60, half] },
    terrain: { base: "flat", base_height: 0, features: [] },
    volumes: [], regions: [], paths: [], markers: [], relations: [], constraints: [], views: [], asset_hints: {},
  };
}
/** 体块：先写 elev（离地），position[1] 由 place() 按地形补成底面绝对高度 */
const vol = (id, shape, kind, at, size, extra = {}) => Object.assign({ id, plan_id: extra.plan_id || id, shape, kind, position: [at[0], 0, at[1]], size, rotation_y: 0 }, extra);
function place(sid) {
  const T = buildTerrain(sid);
  for (const v of sid.volumes) v.position[1] = Math.round((T.heightAt(v.position[0], v.position[2]) + (Number(v.elev) || 0)) * 100) / 100;
  for (const m of sid.markers) if (m.position[1] == null) m.position[1] = Math.round(T.heightAt(m.position[0], m.position[2]) * 100) / 100;
  return { sid, T };
}

/** 全形体夹具（160 m 见方）。返回 { sid, T }，并在 sid.meta.expect 里记每种形体的个数（给 3D 断言用） */
export function shapesScene() {
  const sid = base("形体夹具");
  sid.terrain.features = [
    { id: "hill", kind: "hill", center: [62, 0, 12], radius: 24, height: 10, plan_id: "hill", label: "小山" },
    { id: "lake", kind: "basin", polygon: [[-66, 30], [-14, 30], [-14, 52], [-66, 52]], height: -4, skirt: 3, plan_id: "lake", label: "湖" },
  ];
  const V = sid.volumes;
  // 第 1 排：十种形体
  const sz = { box: [8, 6, 6], cylinder: [7, 8], cone: [8, 9], dome: [9, 5], pyramid: [9, 7, 9], wedge: [7, 4, 9], arch: [9, 8, 3], torus: [9, 2], sphere: [7, 7], prism: [8, 6] };
  ALL_SHAPES.forEach((sh, i) => V.push(vol(`s_${sh}`, sh, "prop", [-70 + i * 14, -62], sz[sh], Object.assign({ label: sh, plan_id: `row_${sh}` }, sh === "prism" ? { sides: 6 } : sh === "arch" ? { thickness: 1.6 } : sh === "wedge" ? { rotation_y: 30 } : {}))));
  // 第 2 排：屋顶（building × 6）+ 塔（tower × 3）
  const bsz = { gable: [11, 6, 7], hip: [11, 6, 8], flat: [9, 5, 9], dome: [9, 6, 9], spire: [7, 8, 7], none: [8, 5, 8] };
  ALL_ROOFS.forEach((r, i) => V.push(vol(`b_${r}`, "box", "building", [-70 + i * 14, -44], bsz[r], { roof: r, label: `屋顶 ${r}`, plan_id: `roof_${r}`, rotation_y: r === "gable" ? 15 : 0 })));
  V.push(vol("t_round", "cylinder", "tower", [14, -44], [6, 16], { roof: "spire", label: "圆塔", color_role: "accent" }));
  V.push(vol("t_oct", "prism", "tower", [28, -44], [7, 14], { sides: 8, roof: "hip", label: "八角塔" }));
  V.push(vol("t_square", "box", "tower", [42, -44], [5, 12, 5], { roof: "flat", label: "方塔" }));
  // 第 3 排：各种 kind
  V.push(vol("k_wall", "box", "wall", [-62, -26], [22, 4, 1.5], { label: "城墙" }));
  V.push(vol("k_stairs", "wedge", "stairs", [-44, -26], [6, 3, 8], { label: "台阶" }));
  V.push(vol("k_platform", "box", "platform", [-30, -26], [10, 1, 10], { label: "平台" }));
  V.push(vol("k_column", "cylinder", "column", [-18, -26], [1.5, 8], { label: "柱" }));
  V.push(vol("k_gate", "arch", "gate", [-8, -26], [8, 7, 2], { thickness: 1.5, label: "拱门" }));
  V.push(vol("k_statue", "prism", "statue", [4, -26], [2.5, 5], { sides: 5, label: "雕像" }));
  V.push(vol("k_tree_c", "cone", "tree", [14, -26], [5, 10], { label: "杉" }));
  V.push(vol("k_tree_s", "sphere", "tree", [22, -26], [6, 8], { label: "橡" }));
  V.push(vol("k_rock", "sphere", "rock", [32, -26], [5, 3, 4], { label: "岩" }));
  V.push(vol("k_crystal", "prism", "crystal", [42, -26], [2, 7], { sides: 6, label: "晶柱" }));
  V.push(vol("k_crystal2", "pyramid", "crystal", [48, -26], [3, 6, 3], { label: "晶锥", rotation_y: 20 }));
  V.push(vol("k_pool", "box", "water", [58, -26], [8, 0.6, 6], { label: "水池" }));
  // 悬空：浮岛 + 岛上书库 + 浮球 + 悬空平台
  V.push(vol("isle", "cylinder", "island", [-30, 6], [16, 7], { elev: 18, label: "浮空岛" }));
  V.push(vol("isle_lib", "box", "building", [-30, 6], [8, 6, 6], { elev: 25, roof: "spire", label: "浮空书库", plan_id: "isle" }));
  V.push(vol("orb", "sphere", "prop", [-50, 4], [4, 4], { elev: 10, label: "浮球", color_role: "accent" }));
  V.push(vol("sky_deck", "box", "platform", [-10, -6], [8, 1, 8], { elev: 12, label: "悬空平台" }));
  // 地标 + 环形塔群（repeat radial × 6）
  V.push(vol("hall", "box", "building", [22, 14], [18, 10, 14], { roof: "dome", label: "主殿", importance: "landmark", color_role: "roof" }));
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; V.push(vol(`towers_${k}`, "cylinder", "tower", [22 + Math.cos(a) * 19, 14 + Math.sin(a) * 19], [4, 12], { roof: "spire", label: "法师塔", plan_id: "towers", instance_of: "towers" })); }
  // 水面
  sid.regions.push({ id: "lake_water", plan_id: "lake", kind: "water", polygon: [[-64, 32], [-16, 32], [-16, 50], [-64, 50]], surface_y: -1.2, label: "湖面" });
  // 路：每种 style
  const P = sid.paths;
  P.push({ id: "p_path", plan_id: "p_path", kind: "trail", style: "path", width: 2, points: [[4, 42], [30, 44]], label: "小径" });
  P.push({ id: "p_road", plan_id: "p_road", kind: "road", style: "road", width: 5, points: [[4, 52], [40, 52], [60, 60]], label: "大路" });
  P.push({ id: "p_stairs", plan_id: "p_stairs", kind: "trail", style: "stairs", width: 3, points: [[42, 34], [54, 18]], label: "石阶" });
  P.push({ id: "p_ramp", plan_id: "p_ramp", kind: "trail", style: "ramp", width: 3, points: [[72, 40], [70, 26]], label: "坡道" });
  P.push({ id: "p_bridge", plan_id: "p_bridge", kind: "road", style: "bridge", width: 4, deck_y: 2, piers: [[-52, 41], [-40, 41], [-28, 41]], points: [[-72, 41], [-8, 41]], label: "石桥" });
  P.push({ id: "p_rope", plan_id: "p_rope", kind: "trail", style: "rope_bridge", width: 1.6, deck_y: 21, points: [[-50, -10], [-36, 2]], label: "索桥" });
  P.push({ id: "p_tunnel", plan_id: "p_tunnel", kind: "trail", style: "tunnel", width: 3, points: [[4, 62], [44, 70]], label: "隧道" });
  P.push({ id: "p_canal", plan_id: "p_canal", kind: "canal", style: "canal", width: 3, points: [[4, 76], [70, 76]], label: "运河" });
  P.push({ id: "p_portal", plan_id: "p_portal", kind: "trail", style: "portal", width: 2, points: [[-72, -6], [-60, 18]], label: "传送门" });
  P.push({ id: "creek", plan_id: "creek", kind: "river", width: 3, points: [[-80, 60], [-64, 50]], label: "溪" });
  // 出生点 + 传送门标记
  sid.markers.push({ id: "spawn", plan_id: "spawn", kind: "player_spawn", position: [22, null, 64], rotation_y: 0, label: "出生点" });
  sid.markers.push({ id: "portal_m", plan_id: "portal_m", kind: "portal", position: [70, null, -8], label: "传送阵" });
  const out = place(sid);
  sid.meta.expect = Object.fromEntries(ALL_SHAPES.map((sh) => [sh, sid.volumes.filter((v) => v.shape === sh).length]));
  return out;
}

/** n 个形体的网格（性能：600 形体流畅）；形体 / kind / 屋顶轮换，少量悬空，1 个地标 */
export function manyShapesScene(n = 600) {
  const sid = base(`${n} 形体`, 100);
  sid.terrain.features = [{ id: "hill", kind: "hill", center: [0, 0, 0], radius: 70, height: 14, plan_id: "hill" }];
  const cols = Math.ceil(Math.sqrt(n)), step = 180 / cols;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols, x = -90 + step * (c + 0.5), z = -90 + step * (r + 0.5), sh = ALL_SHAPES[i % ALL_SHAPES.length];
    const kind = i % 3 === 0 ? "building" : i % 7 === 0 ? "tree" : "prop", s = step * 0.6;
    const size = ["cylinder", "cone", "dome", "sphere", "torus", "prism"].includes(sh) ? [s, s * (1 + (i % 4) * 0.4)] : [s, s * (1 + (i % 4) * 0.4), s * 0.8];
    sid.volumes.push(vol(`v${i}`, kind === "building" ? (i % 2 ? "box" : "cylinder") : sh, kind, [x, z], size, Object.assign({ plan_id: `g${i % 12}` }, kind === "building" ? { roof: ALL_ROOFS[i % ALL_ROOFS.length] } : {}, i % 17 === 0 ? { elev: 6 } : {}, sh === "prism" ? { sides: 3 + (i % 6) } : {})));
  }
  sid.volumes[0].importance = "landmark"; sid.volumes[0].label = "地标"; sid.meta.focus = sid.volumes[0].id;
  sid.markers.push({ id: "spawn", plan_id: "spawn", kind: "player_spawn", position: [0, null, 95], rotation_y: 0, label: "出生点" });
  return place(sid);
}
