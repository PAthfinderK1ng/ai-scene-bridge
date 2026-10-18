// color.js — 颜色：参考图取色（Lab 空间 k-means）、角色启发式分配、色板冷暖偏移、CIE76 色差
// 约定见 SPEC.md 第 7 节。纯函数、确定性（k-means 的随机初始化只来自传入的 seed）。
// 调色板条目形状：{ role, hex, note }；取色结果形状：{ hex, weight }。

import { rng, clamp } from "./terrain.js";

/** 五个调色板角色及默认说明（assignRoles 的输出顺序固定如此） */
export const ROLES = ["roof", "wall", "stone", "foliage", "mist"];
const ROLE_NOTES = { roof: "屋顶：最暗且饱和度低", wall: "墙面：最亮", stone: "石材：中灰", foliage: "植被：最绿", mist: "雾/天：最亮且最不饱和" };

// ------------------------------------------------------------ 基础换算
/** 解析 "#rgb" / "#rrggbb" / "rrggbb" 为 [r,g,b]（0–255）；非法输入返回 [0,0,0] */
export function hexToRgb(hex) {
  let s = String(hex || "").trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r,g,b]（0–255，自动夹取并四舍五入）→ "#rrggbb"（小写） */
export function rgbToHex([r, g, b]) {
  const c = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}

// sRGB → 线性 → XYZ(D65) → Lab。白点 D65。
const WHITE = [0.95047, 1.0, 1.08883];
const srgbToLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linearToSrgb = (c) => { c = clamp(c, 0, 1); return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
const fInv = (t) => (t > 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));

/** [r,g,b]（0–255）→ [L,a,b]（CIE Lab，D65） */
export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0];
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / WHITE[1];
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2];
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** [L,a,b] → [r,g,b]（0–255，已夹取到可显示范围） */
export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fInv(fx) * WHITE[0], Y = fInv(fy) * WHITE[1], Z = fInv(fz) * WHITE[2];
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
}

/** "#rrggbb" → [L,a,b] */
export function hexToLab(hex) { return rgbToLab(hexToRgb(hex)); }
/** [L,a,b] → "#rrggbb"（超出 sRGB 色域的分量被夹取） */
export function labToHex(lab) { return rgbToHex(labToRgb(lab)); }

/** CIE76 色差：两个 hex 的 Lab 欧氏距离。同色为 0。 */
export function deltaE(hexA, hexB) { return labDist(hexToLab(hexA), hexToLab(hexB)); }
function labDist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
/** 彩度 C* = sqrt(a² + b²)，用作「饱和度」 */
const chroma = (lab) => Math.hypot(lab[1], lab[2]);

// ------------------------------------------------------------ 取色
/**
 * 参考图取主色：在 Lab 空间做 k-means（k-means++ 种子化初始化 + 固定迭代上限）。
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} imageData 与 canvas ImageData 同形（RGBA）
 * @param {{k?: number, seed?: number, maxSamples?: number, iterations?: number}} [opts]
 * @returns {{hex: string, weight: number}[]} 按占比降序；weight 之和为 1（像素全透明时返回 []）
 */
export function extractPalette(imageData, opts = {}) {
  const k = clamp(Math.round(opts.k ?? 6), 1, 32);
  const seed = opts.seed ?? 1;
  const maxSamples = opts.maxSamples ?? 4096;
  const iterations = opts.iterations ?? 30;
  const { data, width, height } = imageData || {};
  if (!data || !width || !height) return [];
  const total = Math.min(width * height, (data.length / 4) | 0);
  // 等步长抽样（确定性），跳过基本透明的像素
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const pts = [];
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    if (data[o + 3] < 16) continue;
    pts.push(rgbToLab([data[o], data[o + 1], data[o + 2]]));
  }
  if (!pts.length) return [];
  const kk = Math.min(k, pts.length);
  const rand = rng(seed);
  // k-means++ 初始化
  const centers = [pts[Math.floor(rand() * pts.length)].slice()];
  const d2 = new Float64Array(pts.length).fill(Infinity);
  while (centers.length < kk) {
    let sum = 0;
    const c = centers[centers.length - 1];
    for (let i = 0; i < pts.length; i++) { const d = labDist(pts[i], c); d2[i] = Math.min(d2[i], d * d); sum += d2[i]; }
    let r = rand() * sum, pick = pts.length - 1;
    for (let i = 0; i < pts.length; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    centers.push(pts[pick].slice());
  }
  // Lloyd 迭代
  const label = new Int32Array(pts.length);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < centers.length; j++) { const d = labDist(pts[i], centers[j]); if (d < bd) { bd = d; best = j; } }
      if (label[i] !== best) { label[i] = best; moved = true; }
    }
    if (!moved && it > 0) break;
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { const a = acc[label[i]], p = pts[i]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++; }
    for (let j = 0; j < centers.length; j++) if (acc[j][3]) centers[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
  }
  const counts = centers.map(() => 0);
  for (let i = 0; i < pts.length; i++) counts[label[i]]++;
  // 空簇丢弃；同 hex 合并；按占比降序（相同占比按 hex 字典序，保证确定性）
  const merged = new Map();
  centers.forEach((c, j) => { if (!counts[j]) return; const hex = labToHex(c); merged.set(hex, (merged.get(hex) || 0) + counts[j]); });
  return [...merged.entries()].map(([hex, n]) => ({ hex, weight: n / pts.length })).sort((p, q) => q.weight - p.weight || (p.hex < q.hex ? -1 : 1));
}

// ------------------------------------------------------------ 角色分配
/**
 * 把一组颜色启发式地分到 roof/wall/stone/foliage/mist 五个角色。
 * foliage = 最绿（a* 最负）；wall = 最亮；roof = 最暗且饱和度低；stone = 中灰；
 * mist = 最亮且饱和度最低（若与 wall 相同则取次亮）。颜色不够时允许复用。
 * @param {(string|{hex: string, weight?: number})[]} colors
 * @returns {{role: string, hex: string, note: string}[]} 顺序固定为 ROLES
 */
export function assignRoles(colors) {
  const items = (colors || []).map((c) => (typeof c === "string" ? c : c && c.hex)).filter(Boolean).map((hex) => ({ hex: rgbToHex(hexToRgb(hex)), lab: hexToLab(hex) }));
  if (!items.length) return ROLES.map((role) => ({ role, hex: "#808080", note: ROLE_NOTES[role] + "（无输入，占位）" }));
  const pick = (score, exclude = new Set()) => {
    let best = null, bs = Infinity;
    for (const it of items) { if (exclude.has(it.hex)) continue; const s = score(it.lab); if (s < bs) { bs = s; best = it; } }
    return best || items[0];
  };
  const used = new Set();
  const take = (score, allowReuse = false) => { const it = pick(score, allowReuse ? new Set() : used); used.add(it.hex); return it.hex; };
  // 候选少于 5 时允许复用，避免 pick 退化成随意的剩余项
  const reuse = items.length < ROLES.length;
  const foliage = take((l) => l[1], reuse);                                 // a* 最负
  const wall = take((l) => -l[0], reuse);                                   // 最亮
  const roof = take((l) => l[0] + 0.5 * chroma(l), reuse);                  // 最暗且低饱和
  const stone = take((l) => Math.abs(l[0] - 55) + 0.8 * chroma(l), reuse);  // 中灰
  // mist：最亮且最不饱和；允许与 wall 相同时退到次亮
  const mist = items.length > 1 ? pick((l) => -l[0] + 0.4 * chroma(l), new Set([wall])).hex : wall;
  const out = { roof, wall, stone, foliage, mist };
  return ROLES.map((role) => ({ role, hex: out[role], note: ROLE_NOTES[role] }));
}

// ------------------------------------------------------------ 冷暖偏移
/** 各模式在 Lab 上的变换 */
const SHIFTS = {
  cool: ([L, a, b]) => [L, a - 4, b - 12],
  warm: ([L, a, b]) => [L, a + 4, b + 12],
  desaturate: ([L, a, b]) => [L, a * 0.5, b * 0.5],
  neutral: (lab) => lab.slice(),
};
export const SHIFT_MODES = Object.keys(SHIFTS);

/**
 * 整体偏移调色板：cool（b* −12、a* −4）、warm（b* +12、a* +4）、desaturate（a/b × 0.5）、neutral（原样）。
 * @param {{role: string, hex: string, note?: string}[]} palette
 * @param {"cool"|"warm"|"desaturate"|"neutral"} mode 未知模式按 neutral 处理
 * @returns {{role: string, hex: string, note: string}[]} 新数组（不改入参）
 */
export function paletteShift(palette, mode = "neutral") {
  const f = SHIFTS[mode] || SHIFTS.neutral;
  return (palette || []).map((p) => ({ ...p, role: p.role, hex: labToHex(f(hexToLab(p.hex))), note: p.note ?? "" }));
}
