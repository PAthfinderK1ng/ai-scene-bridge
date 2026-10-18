// diversity.js — 候选差异与变化轴：给三张 Draft 卡片算「签名」、两两距离，判断是否够不一样；
// 以及沿某一条变化轴生成三个参数覆盖（override），由调用方合并进卡片参数再重算。
// 约定见 SPEC.md 第 6 节。纯函数、确定性，不写坐标，只读 resolve 后的 SID。

import { clamp } from "./terrain.js";
import { hexToLab } from "./color.js";

/** 变化轴及中文名 */
export const AXES = { landmark: "地标位置", terraces: "台地层数", entry: "入口方位", density: "密度", palette: "色板冷暖" };

/** 距离各项权重（见 SPEC：地标位移/30 + |levels 差| + |houses 差|/15 + bearing 差/90 + ΔE/30；原型不同额外 +1） */
export const WEIGHTS = { landmark_m: 30, houses: 15, bearing_deg: 90, deltaE: 30, archetype: 1 };

// ------------------------------------------------------------ 局部辅助
const isLandmark = (v) => v && v.importance === "landmark";
const isHouse = (v) => v && v.kind === "building" && !isLandmark(v);
const posXZ = (p) => (Array.isArray(p) && p.length >= 3 ? [p[0], p[2]] : null);

/** bounds 中心的 [x,z]；缺 bounds 时按默认 120 m 见方取原点 */
function boundsCenter(sid) {
  const b = sid && sid.bounds;
  if (!b || !b.min || !b.max) return [0, 0];
  return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
}

/**
 * 从中心看向点的方位角（度）：0 = 北（−z），顺时针为正，范围 [0, 360)。
 * 东 = 90、南 = 180、西 = 270。
 */
export function bearingDeg(center, point) {
  const dx = point[0] - center[0], dz = point[1] - center[1];
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

/** 两个方位角之差，折到 [0, 180] */
export function bearingDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

/** 层数：terrain.features 里 level 的最大值 + 1；没有 level 时按 height / layer_height_m 推算 */
function countLevels(sid) {
  const feats = (sid && sid.terrain && sid.terrain.features) || [];
  const layer = (sid && sid.meta && Number(sid.meta.layer_height_m)) || 3;
  let max = -1;
  for (const f of feats) {
    const lv = Number.isFinite(f.level) ? f.level : Number.isFinite(f.height) ? Math.round(f.height / layer) : null;
    if (lv !== null && lv > max) max = lv;
  }
  return max + 1;
}

/** 调色板平均 Lab；没有调色板时返回 null */
function paletteMeanLab(sid) {
  const pal = ((sid && sid.style && sid.style.palette) || []).filter((p) => p && p.hex);
  if (!pal.length) return null;
  const acc = [0, 0, 0];
  for (const p of pal) { const l = hexToLab(p.hex); acc[0] += l[0]; acc[1] += l[1]; acc[2] += l[2]; }
  return acc.map((v) => v / pal.length);
}

// ------------------------------------------------------------ 签名与距离
/**
 * 一个 resolve 后 SID 的结构签名，用于比较候选之间差多少。
 * @param {object} sid resolve 后的 SID（可带 fixtures 里的 `_archetype`）
 * @returns {{archetype: string|null, landmark: [number, number]|null, levels: number, houses: number, entry_bearing_deg: number|null, palette_lab: [number, number, number]|null}}
 */
export function signature(sid) {
  const archetype = (sid && sid._archetype && sid._archetype.archetype) || (sid && sid.meta && sid.meta.archetype) || null;
  const volumes = (sid && sid.volumes) || [];
  const lm = volumes.find(isLandmark);
  const spawn = ((sid && sid.markers) || []).find((m) => m && m.kind === "player_spawn");
  const spawnXZ = spawn ? posXZ(spawn.position) : null;
  return {
    archetype,
    landmark: lm ? posXZ(lm.position) : null,
    levels: countLevels(sid),
    houses: volumes.filter(isHouse).length,
    entry_bearing_deg: spawnXZ ? bearingDeg(boundsCenter(sid), spawnXZ) : null,
    palette_lab: paletteMeanLab(sid),
  };
}

/**
 * 两个签名的加权距离：地标位移/30 + |levels 差| + |houses 差|/15 + 方位差/90 + ΔE/30（+1 若原型不同）。
 * 缺失项（null）不计入。同一 SID 为 0。
 * @returns {number}
 */
export function distance(a, b) {
  let d = 0;
  if (a.archetype && b.archetype && a.archetype !== b.archetype) d += WEIGHTS.archetype;
  if (a.landmark && b.landmark) d += Math.hypot(a.landmark[0] - b.landmark[0], a.landmark[1] - b.landmark[1]) / WEIGHTS.landmark_m;
  d += Math.abs((a.levels || 0) - (b.levels || 0));
  d += Math.abs((a.houses || 0) - (b.houses || 0)) / WEIGHTS.houses;
  if (a.entry_bearing_deg !== null && a.entry_bearing_deg !== undefined && b.entry_bearing_deg !== null && b.entry_bearing_deg !== undefined) d += bearingDiff(a.entry_bearing_deg, b.entry_bearing_deg) / WEIGHTS.bearing_deg;
  if (a.palette_lab && b.palette_lab) d += Math.hypot(a.palette_lab[0] - b.palette_lab[0], a.palette_lab[1] - b.palette_lab[1], a.palette_lab[2] - b.palette_lab[2]) / WEIGHTS.deltaE;
  return d;
}

/**
 * 一组签名是否两两都够不一样（distance ≥ threshold）。少于 2 个视为 true。
 * @param {object[]} sigs
 * @param {number} [threshold=1.0]
 * @returns {boolean}
 */
export function distinctEnough(sigs, threshold = 1.0) {
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) if (distance(sigs[i], sigs[j]) < threshold) return false;
  return true;
}

// ------------------------------------------------------------ 变化轴
/** 层数三元组：以 n 为中心的 [n−1, n, n+1]，夹在 3..7 并保证三个互不相同 */
function terraceTriple(n) {
  let c = clamp(Math.round(Number(n) || 4), 3, 7);
  if (c === 3) c = 4;
  if (c === 7) c = 6;
  return [c - 1, c, c + 1];
}

/**
 * 沿某条变化轴给出三个参数覆盖，形状是 Draft 卡片参数的子集（第 8 节）：
 * - landmark → { landmark: { placement } } ∈ top / ridge_end / cliff_edge
 * - terraces → { params: { terraces } } 为 [n−1, n, n+1]（夹在 3..7，n 取 base.params.terraces，默认 4）
 * - entry → { params: { entry_side } } ∈ S / E / W
 * - density → { density_scale } ∈ 0.6 / 1 / 1.4（全局密度倍率）
 * - palette → { palette_shift } ∈ cool / neutral / warm
 * @param {keyof typeof AXES} axis
 * @param {object} [base] 当前卡片（只读 base.params.terraces）
 * @returns {object[]} 三个互不相同的 override；未知轴返回 []
 */
export function axisOverrides(axis, base = {}) {
  switch (axis) {
    case "landmark": return ["top", "ridge_end", "cliff_edge"].map((placement) => ({ landmark: { placement } }));
    case "terraces": return terraceTriple(base && base.params && base.params.terraces).map((terraces) => ({ params: { terraces } }));
    case "entry": return ["S", "E", "W"].map((entry_side) => ({ params: { entry_side } }));
    case "density": return [0.6, 1, 1.4].map((density_scale) => ({ density_scale }));
    case "palette": return ["cool", "neutral", "warm"].map((palette_shift) => ({ palette_shift }));
    default: return [];
  }
}
