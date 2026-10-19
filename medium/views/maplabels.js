// views/maplabels.js — 俯视图标签避让：标签不压房子、地标、入口、连接点，也不互相叠。
// 在 renderMap 最后跑一遍（纯算术，不量 DOM）：按优先级逐个放，每个在锚点附近几个候选位置里挑「压得最少」的；
// 实在躲不开（房子太密）就在字下垫一块半透明底色。只挪文字的 x / y，不碰任何几何。
import { svgel, fmt1 } from "./map.js";

/** 估字宽（em）：中文 / 全角 1，其它 0.58 */
function textWidth(s, fs) {
  let w = 0;
  for (const ch of s) { const c = ch.codePointAt(0); w += c >= 0x2e80 || ch === "▾" || ch === "·" ? 1 : ch === " " ? 0.3 : 0.58; }
  return w * fs;
}
function boxOf(t, x, y) {
  const fs = Number(t.getAttribute("font-size")) || 2.5, w = textWidth(t.textContent || "", fs);
  const a = t.getAttribute("text-anchor"), x0 = a === "middle" ? x - w / 2 : a === "end" ? x - w : x;
  return [x0 - 0.15 * fs, y - 0.9 * fs, x0 + w + 0.15 * fs, y + 0.25 * fs];
}
const area = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** 要躲的东西（轴对齐包围盒，米）：房子、地标、入口、连接点 */
function obstacles(sid, u) {
  const out = [];
  for (const v of sid.volumes || []) {
    if (!v.position || !v.size || (v.kind !== "building" && v.importance !== "landmark")) continue;
    const r = ((v.rotation_y || 0) * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const hx = (v.size[0] * c + v.size[2] * s) / 2, hz = (v.size[0] * s + v.size[2] * c) / 2;
    out.push([v.position[0] - hx, v.position[2] - hz, v.position[0] + hx, v.position[2] + hz]);
  }
  for (const m of sid.markers || []) {
    if (!m || !Array.isArray(m.position)) continue;
    const [x, , z] = m.position;
    if (m.kind === "player_spawn") out.push([x - 3.5, z - 4.5, x + 3.5, z + 3.5]);
    else if (m.kind === "connector") out.push([x - 1.6 * u, z - 1.6 * u, x + 3.2 * u, z + 1.6 * u]);
  }
  return out;
}

/** 优先级（小的先放、先占位）：当前层的空间 / 连接点 > 地标 > 入口 > 其它 */
function rank(t, onGround) {
  const f = t.getAttribute("data-for") || "", faded = !onGround && t.closest("g[opacity]");
  const k = f.startsWith("landmark") ? 1 : f.startsWith("spawn") ? 2 : f.startsWith("space") ? (onGround ? 3 : 0) : f.startsWith("connector") ? (onGround ? 4 : 0.5) : t.hasAttribute("data-path-label") ? 6 : 5;
  return k + (faded ? 10 : 0);
}

/**
 * 摆标签。labels = 文字层 <g>；只挪带 data-for / data-region-label / data-path-label / data-lv 的字，其余文字（比例尺、北、A/B、读回差异）原地不动、当障碍。
 * @param {{min:number[], max:number[]}} bounds sid.bounds
 */
export function placeLabels(labels, { sid, u, onGround }) {
  const all = [...labels.querySelectorAll("text")];
  const movable = all.filter((t) => t.hasAttribute("data-for") || t.hasAttribute("data-region-label") || t.hasAttribute("data-path-label") || t.hasAttribute("data-lv"));
  const placed = all.filter((t) => !movable.includes(t)).map((t) => boxOf(t, +t.getAttribute("x"), +t.getAttribute("y")));
  const obs = obstacles(sid, u);
  const [x0, z0, x1, z1] = [sid.bounds.min[0], sid.bounds.min[2], sid.bounds.max[0], sid.bounds.max[2]];
  movable.sort((a, b) => rank(a, onGround) - rank(b, onGround));
  for (const t of movable) {
    const x = +t.getAttribute("x"), y = +t.getAttribute("y"), fs = Number(t.getAttribute("font-size")) || 2.5;
    const b0 = boxOf(t, x, y), w = b0[2] - b0[0], lh = 1.2 * fs;
    let best = null;
    for (const [dx, dy, cost] of CANDIDATES) {
      const nx = x + dx * w, ny = y + dy * lh, b = boxOf(t, nx, ny);
      if (b[0] < x0 - 2 * u || b[2] > x1 + 2 * u || b[1] < z0 - 2 * u || b[3] > z1 + 2 * u) continue;
      let hit = 0;
      for (const o of obs) hit += area(b, o);
      for (const o of placed) hit += 3 * area(b, o);
      const score = hit + cost * 0.02 * w * lh;
      if (!best || score < best.score) best = { nx, ny, b, hit, score };
      if (hit === 0) break; // 候选按离锚点由近到远排好，第一个不压的就要
    }
    if (!best) best = { nx: x, ny: y, b: b0, hit: 1 };
    t.setAttribute("x", fmt1(best.nx)); t.setAttribute("y", fmt1(best.ny));
    if (best.hit > 0.15 * w * lh) { // 躲不开：垫底色（跟着字走，拖动时一起平移）
      const [a, c, d, e] = best.b;
      t.before(svgel("rect", { x: fmt1(a), y: fmt1(c), width: fmt1(d - a), height: fmt1(e - c), rx: fmt1(0.4 * u), fill: "#fbfaf6", "fill-opacity": 0.82, "pointer-events": "none", "data-for": t.getAttribute("data-for"), class: "label-bg" }));
    }
    placed.push(best.b);
  }
}

/** 候选偏移（dx 以字宽计、dy 以行高计）与代价：先上下错一行，再左右挪半个字宽，再错两三行 */
const CANDIDATES = (() => {
  const out = [];
  for (const dy of [0, -1, 1, -2, 2, -3, 3]) for (const dx of [0, 0.4, -0.4]) out.push([dx, dy, Math.abs(dy) + Math.abs(dx) * 2.5]);
  return out.sort((a, b) => a[2] - b[2]);
})();
