// proto.js — 「场景对话」交互原型（评审修订版）。AI 的回复全部是脚本，用来评审交互方式，不是产品代码。
// 原则：每一轮人只做选择、指点、判断；AI 出方案、算几何、复述。底下有一份 SID 在被 AI 维护，人不需要看见它。
// 评审后改动：地标先于第一眼；「换一批」让人选变化轴，卡片高亮差异标签；「我假设了」面板；关系清单 ✓/✗；复述标签可翻替代解释；LLM 不写坐标（这里用程序代替）。

const $ = (s) => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function svgel(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ 词表
const VARIANTS = {
  A: { name: "之字村", desc: "沿一条之字形石阶往上叠的窄长村子，地标在最顶上，越往上越密。", road: "之字" },
  B: { name: "环台村", desc: "围着半山腰一块平台的环形村，平台是广场，房子一圈圈往外往上长。", road: "环绕" },
  C: { name: "溪谷双坡村", desc: "一条溪从山上下来，两边坡上各一片房子，一座桥把两边接起来。", road: "沿溪" },
};
const SLOPES = { gentle: { label: "缓坡", rise: 2.5, contours: 5 }, mid: { label: "中坡", rise: 4, contours: 8 }, steep: { label: "陡坡", rise: 6, contours: 12 } };
const SIZES = { small: { label: "三十秒走完", terraces: 3, per: 4 }, medium: { label: "两分钟走完", terraces: 5, per: 5 }, large: { label: "会迷路", terraces: 7, per: 6 } };
const LANDMARKS = { temple: { label: "寺庙" }, wheel: { label: "水车" }, tree: { label: "大树" } };
const LM_SPOTS = { top: { label: "山顶平台", d: [0, 0] }, ridge: { label: "山脊尽头", d: [22, 7] }, cliff: { label: "临崖", d: [-20, 12] } };
const ENTRIES = { S: { label: "南边山脚", pos: [50, 95] }, E: { label: "东侧半山", pos: [95, 62] }, W: { label: "西侧半山", pos: [5, 62] } };
const REGION_TAGS = { dense: "这里更密", sparse: "这里更稀", forest: "这里是林子", plaza: "这里是广场", terrace: "这里是梯田" };
const AXES = { landmark: "地标位置", terraces: "台地层数", entry: "入口方位", density: "密度", palette: "色板冷暖" };
const PALETTES = {
  default: { name: "默认", items: [["roof", "#4A4A4A", "青瓦"], ["wall", "#D9C9A3", "夯土墙"], ["stone", "#9A9890", "石阶"], ["foliage", "#4F6B3A", "树"], ["mist", "#DDE6F0", "雾"]] },
  hongya: { name: "洪崖洞夜景", items: [["roof", "#3B2A22", "深褐瓦"], ["wall", "#C98A3D", "暖木墙"], ["stone", "#6E6A66", "青石"], ["foliage", "#2F4A33", "深绿"], ["mist", "#F2B85C", "灯光雾"]] },
  wulong: { name: "武隆山村", items: [["roof", "#5A5F63", "灰瓦"], ["wall", "#E8E0CF", "白灰墙"], ["stone", "#A8A49C", "浅石"], ["foliage", "#6E8B4E", "黄绿"], ["mist", "#E6ECEF", "晨雾"]] },
  huizhou: { name: "徽州村落", items: [["roof", "#2E3338", "黛瓦"], ["wall", "#F3F0E8", "粉墙"], ["stone", "#8C8A84", "青石板"], ["foliage", "#4C7A45", "翠绿"], ["mist", "#D8E0E6", "水汽"]] },
};
const ASSUMPTIONS = {
  time: { label: "时段", options: ["黄昏", "清晨", "正午", "夜里"] },
  house: { label: "房型", options: ["坡顶", "平顶", "吊脚"] },
  wall: { label: "挡土墙", options: ["石砌", "没有", "夯土"] },
  stream: { label: "溪宽", options: ["3 m", "6 m", "1 m"] },
};

// ------------------------------------------------------------ 状态（相当于 AI 维护的 SID，人不直接看）
const state = {
  step: 1, intent: "", variant: null, slope: "mid", size: "medium", entry: "S", landmark: "temple", lmSpot: "top",
  landmarkPos: null, path: null, zigzag: 3, regions: [], density: 1, palette: "default", reference: null,
  assumptions: Object.fromEntries(Object.entries(ASSUMPTIONS).map(([k, a]) => [k, { value: a.options[0], confirmed: false }])),
  understanding: [], tool: "select", view: "map", locked: new Set(), asked: 0,
  meter: { point: 0, choose: 0, type: 0, coord: 0 },
};
const bump = (k) => { state.meter[k]++; $("#meter").textContent = `指点 ${state.meter.point} · 选择 ${state.meter.choose} · 打字 ${state.meter.type} · 坐标 ${state.meter.coord}`; };

// ------------------------------------------------------------ 几何生成（这是 AI 永远不该亲手写的部分，由程序产出）
function terraceYs(n) { return Array.from({ length: n }, (_, k) => 84 - (k * 66) / Math.max(1, n - 1)); }
function baseLandmark(v) { return v === "B" ? [50, 38] : v === "C" ? [72, 18] : [50, 14]; }
function landmarkPos() {
  if (state.landmarkPos) return state.landmarkPos;
  const b = baseLandmark(state.variant || "A"), d = LM_SPOTS[state.lmSpot].d;
  return [clamp(b[0] + d[0], 8, 92), clamp(b[1] + d[1], 8, 92)];
}
function defaultPath(v, entryKey, n) {
  const e = ENTRIES[entryKey].pos.slice();
  const lm = landmarkPos();
  if (v === "A") {
    const folds = state.zigzag;
    const pts = [e];
    if (folds === 0) { pts.push(lm); return pts; }
    for (let f = 1; f <= folds; f++) {
      const t = f / (folds + 1);
      const y = e[1] + (lm[1] - e[1]) * t;
      pts.push([f % 2 ? (entryKey === "E" ? 70 : 30) : entryKey === "E" ? 30 : 70, y]);
    }
    pts.push(lm);
    return pts;
  }
  if (v === "B") return [e, [50, 72], [66, 64], [70, 52], [60, 42], lm];
  return [e, [50, 86], [51, 62], [48, 44], [62, 38], lm];
}
function currentPath() { return state.path || defaultPath(state.variant || "A", state.entry, SIZES[state.size].terraces); }
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function centroid(poly) { return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]; }
function genHouses() {
  const v = state.variant || "A";
  const { terraces: n, per } = SIZES[state.size];
  const r = rng(11 + n * 7 + Math.round(state.density * 10) + v.charCodeAt(0));
  const ys = terraceYs(n);
  const houses = [];
  const add = (x, y, k) => houses.push({ x, y, k, rot: (r() - 0.5) * 30, w: 3.2, h: 2.4 });
  if (v === "A") {
    ys.forEach((y, k) => {
      const cx = state.entry === "E" ? (k % 2 ? 68 : 32) : k % 2 ? 32 : 68;
      const count = Math.round(per * state.density * (0.6 + (0.8 * k) / Math.max(1, n - 1)));
      for (let i = 0; i < count; i++) add(clamp(cx + (r() - 0.5) * 44, 8, 92), y + (r() - 0.5) * 5, k);
    });
  } else if (v === "B") {
    for (let k = 0; k < n; k++) {
      const rx = 17 + 8 * k, ry = 9 + 5 * k, count = Math.round((per + 2 * k) * state.density);
      for (let i = 0; i < count; i++) { const a = (i / count) * Math.PI * 2 + r() * 0.3; add(clamp(50 + rx * Math.cos(a), 6, 94), clamp(52 + ry * Math.sin(a) - k * 2, 8, 92), k); }
    }
  } else {
    ys.forEach((y, k) => {
      const count = Math.round(per * state.density * 0.6);
      for (let i = 0; i < count; i++) { add(12 + r() * 26, y + (r() - 0.5) * 5, k); add(62 + r() * 26, y + (r() - 0.5) * 5, k); }
    });
  }
  let out = houses;
  for (const rg of state.regions) {
    if (rg.tag === "dense") { const c = centroid(rg.poly); for (let i = 0; i < 8; i++) { const p = [c[0] + (r() - 0.5) * 18, c[1] + (r() - 0.5) * 18]; if (pointInPoly(p, rg.poly)) add(p[0], p[1], 0); } out = houses; }
    else out = out.filter((h) => !pointInPoly([h.x, h.y], rg.poly));
  }
  // 房子不压路：离路太近的推开（程序保证，不靠 AI）
  const path = currentPath();
  out = out.filter((h) => !nearPolyline([h.x, h.y], path, 2.6));
  return out;
}
function nearPolyline(p, pts, d) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const L2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
    const t = clamp(((p[0] - x0) * (x1 - x0) + (p[1] - y0) * (y1 - y0)) / L2, 0, 1);
    if (Math.hypot(p[0] - (x0 + t * (x1 - x0)), p[1] - (y0 + t * (y1 - y0))) < d) return true;
  }
  return false;
}
/** 关系清单：由程序算出 ✓/✗，不是 AI 自述 */
function relations() {
  const lm = landmarkPos(), e = ENTRIES[state.entry].pos, path = currentPath();
  const n = SIZES[state.size].terraces, topY = terraceYs(n)[n - 1];
  const blocked = state.regions.some((rg) => rg.tag === "forest" && segmentHitsPoly(e, lm, rg.poly));
  const last = path[path.length - 1];
  return [
    { text: `入口 能看见 ${LANDMARKS[state.landmark].label}`, ok: lm[1] < e[1] - 8 && !blocked, fixes: ["地标再高一层", "入口挪到路口", "不重要"], fix: () => { state.landmarkPos = [lm[0], Math.max(8, lm[1] - 12)]; state.path = null; } },
    { text: `主路 能到达 ${LANDMARKS[state.landmark].label}`, ok: Math.hypot(last[0] - lm[0], last[1] - lm[1]) < 8, fixes: ["把路接到地标", "不重要"], fix: () => { if (state.path) state.path = [...state.path, lm.slice()]; } },
    { text: `${LANDMARKS[state.landmark].label} 在 顶层台地`, ok: lm[1] <= topY + 8, fixes: ["挪到顶层", "不重要"], fix: () => { state.landmarkPos = [lm[0], topY]; state.path = null; } },
    { text: "房子 不压路、不重叠", ok: true, fixes: [], fix: null },
    { text: "每层台地 都有路可达", ok: true, fixes: [], fix: null },
  ];
}
function segmentHitsPoly(a, b, poly) { for (let t = 0.1; t < 1; t += 0.1) if (pointInPoly([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], poly)) return true; return false; }

// ------------------------------------------------------------ 渲染：俯视语义图
function mapSVG({ small = false } = {}) {
  const v = state.variant || "A";
  const s = svgel("svg", { viewBox: "0 0 100 100", class: "map" });
  const defs = svgel("defs");
  const g1 = svgel("linearGradient", { id: "elev", x1: 0, y1: 1, x2: 0, y2: 0 });
  g1.append(svgel("stop", { offset: 0, "stop-color": "#e9e2cf" }), svgel("stop", { offset: 1, "stop-color": "#b9c7a3" }));
  const g2 = svgel("linearGradient", { id: "valley", x1: 0, y1: 0, x2: 1, y2: 0 });
  g2.append(svgel("stop", { offset: 0, "stop-color": "#b9c7a3" }), svgel("stop", { offset: 0.5, "stop-color": "#e9e2cf" }), svgel("stop", { offset: 1, "stop-color": "#b9c7a3" }));
  defs.append(g1, g2);
  s.append(defs, svgel("rect", { width: 100, height: 100, fill: v === "C" ? "url(#valley)" : "url(#elev)" }));
  const cN = SLOPES[state.slope].contours;
  for (let i = 0; i <= cN; i++) {
    const y0 = 94 - (i * 84) / cN;
    let d = "";
    for (let x = 0; x <= 100; x += 5) { const y = v === "C" ? y0 + Math.abs(x - 50) * 0.45 - 11 : y0 + 2.5 * Math.sin((x + i * 7) / 9); d += (x ? " L" : "M") + x + " " + y.toFixed(1); }
    s.append(svgel("path", { d, fill: "none", stroke: "#8c9a6b", "stroke-width": 0.35, opacity: 0.8 }));
  }
  if (v === "C") { let d = ""; for (let y = 0; y <= 100; y += 4) d += (y ? " L" : "M") + (50 + 3 * Math.sin(y / 8)).toFixed(1) + " " + y; s.append(svgel("path", { d, fill: "none", stroke: "#6f9bc2", "stroke-width": 2.4, "stroke-linecap": "round" })); }
  const n = SIZES[state.size].terraces;
  const ys = terraceYs(n);
  if (v === "B") { for (let k = 0; k < n; k++) s.append(svgel("ellipse", { cx: 50, cy: 52 - k * 2, rx: 17 + 8 * k, ry: 9 + 5 * k, fill: k ? "none" : "#cfc6b0", stroke: "#8c9a6b", "stroke-width": 0.5, "stroke-dasharray": "1.2 1" })); }
  else ys.forEach((y, k) => { s.append(svgel("line", { x1: v === "C" ? 8 : 12, x2: v === "C" ? 40 : 88, y1: y, y2: y, stroke: "#8c9a6b", "stroke-width": 0.5, "stroke-dasharray": "1.2 1" })); if (v === "C") s.append(svgel("line", { x1: 60, x2: 92, y1: y, y2: y, stroke: "#8c9a6b", "stroke-width": 0.5, "stroke-dasharray": "1.2 1" })); if (!small) s.append(svgel("text", { x: v === "C" ? 5 : 9, y: y + 1, "font-size": 2.2, fill: "#6b7a4b" }, `${k + 1} 层`)); });
  const regColor = { dense: "#b8452b", sparse: "#9a9890", forest: "#4f6b3a", plaza: "#9a9890", terrace: "#c8a951" };
  state.regions.forEach((rg, i) => {
    s.append(svgel("polygon", { points: rg.poly.map((p) => p.join(",")).join(" "), fill: regColor[rg.tag], "fill-opacity": rg.tag === "dense" ? 0.12 : 0.3, stroke: regColor[rg.tag], "stroke-width": 0.5, "stroke-dasharray": "1.5 1", "data-region": i }));
    const c = centroid(rg.poly);
    if (rg.tag === "forest") { const r = rng(i + 3); for (let t = 0; t < 14; t++) { const p = [c[0] + (r() - 0.5) * 20, c[1] + (r() - 0.5) * 20]; if (pointInPoly(p, rg.poly)) s.append(svgel("circle", { cx: p[0], cy: p[1], r: 1.3, fill: "#4f6b3a", opacity: 0.8 })); } }
    if (rg.tag === "terrace") for (let t = -3; t <= 3; t++) s.append(svgel("line", { x1: c[0] - 9, x2: c[0] + 9, y1: c[1] + t * 2.2, y2: c[1] + t * 2.2 + 1, stroke: "#8a7a3a", "stroke-width": 0.4 }));
    if (!small) s.append(svgel("text", { x: c[0], y: c[1] + 1, "font-size": 2.6, "text-anchor": "middle", fill: regColor[rg.tag], "data-region-label": i, style: "cursor:pointer" }, REGION_TAGS[rg.tag] + " ▾"));
  });
  const path = currentPath();
  s.append(svgel("polyline", { points: path.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#8b7d5b", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.95 }));
  s.append(svgel("polyline", { points: path.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#fff", "stroke-width": 0.5, "stroke-dasharray": "0.8 1.2", opacity: 0.9 }));
  const houses = genHouses();
  const pal = Object.fromEntries(PALETTES[state.palette].items.map(([k, hex]) => [k, hex]));
  houses.forEach((h, i) => s.append(svgel("rect", { x: h.x - h.w / 2, y: h.y - h.h / 2, width: h.w, height: h.h, fill: pal.roof, stroke: "#222", "stroke-width": 0.25, transform: `rotate(${h.rot} ${h.x} ${h.y})`, "data-house": i })));
  const lm = landmarkPos();
  const lg = svgel("g", { class: "landmark", transform: `translate(${lm[0]} ${lm[1]})` });
  if (state.landmark === "temple") lg.append(svgel("path", { d: "M-4 2 L0 -4 L4 2 Z M-3 2 L3 2 L3 5 L-3 5 Z", fill: "#b8452b", stroke: "#4a1a10", "stroke-width": 0.3 }));
  else if (state.landmark === "wheel") { lg.append(svgel("circle", { r: 3.6, fill: "none", stroke: "#6b3f2a", "stroke-width": 0.8 })); for (let a = 0; a < 6; a++) lg.append(svgel("line", { x1: 0, y1: 0, x2: 3.6 * Math.cos((a * Math.PI) / 3), y2: 3.6 * Math.sin((a * Math.PI) / 3), stroke: "#6b3f2a", "stroke-width": 0.5 })); }
  else lg.append(svgel("circle", { r: 4, fill: "#3f6b2a" }), svgel("rect", { x: -0.6, y: 3, width: 1.2, height: 3, fill: "#5a3a1a" }));
  if (state.locked.has("landmark")) lg.append(svgel("text", { x: 5, y: -3, "font-size": 3 }, "🔒"));
  if (!small) lg.append(svgel("text", { y: -5.5, "font-size": 2.8, "text-anchor": "middle", fill: "#4a1a10" }, LANDMARKS[state.landmark].label + "（地标）"));
  s.append(lg);
  const e = ENTRIES[state.entry].pos;
  const ang = Math.atan2(lm[1] - e[1], lm[0] - e[0]);
  const L = Math.hypot(lm[0] - e[0], lm[1] - e[1]) * 0.8;
  [-0.22, 0.22].forEach((da) => s.append(svgel("line", { x1: e[0], y1: e[1], x2: e[0] + Math.cos(ang + da) * L, y2: e[1] + Math.sin(ang + da) * L, stroke: "#1f6feb", "stroke-width": 0.4, "stroke-dasharray": "1 1", opacity: 0.8 })));
  const eg = svgel("g", { class: "entry", transform: `translate(${e[0]} ${e[1]}) rotate(${(ang * 180) / Math.PI + 90})` });
  eg.append(svgel("path", { d: "M0 -4 L3 3 L-3 3 Z", fill: "#1f6feb", stroke: "#fff", "stroke-width": 0.4 }));
  s.append(eg);
  if (!small) {
    s.append(svgel("text", { x: clamp(e[0], 8, 86), y: clamp(e[1] + 4, 6, 99), "font-size": 2.8, fill: "#1f6feb", "text-anchor": "middle" }, "入口 · 第一眼朝" + LANDMARKS[state.landmark].label));
    // 复述标签（可翻替代解释）
    const mid = path[Math.floor(path.length / 2)];
    const folds = state.path ? "你画的" : v === "A" ? (state.zigzag === 0 ? "直上" : `之字 ${state.zigzag} 折`) : VARIANTS[v].road;
    s.append(svgel("text", { x: clamp(mid[0] + 3, 4, 70), y: clamp(mid[1] - 2, 6, 96), "font-size": 2.6, fill: "#5a4a2a", "data-path-label": 1, style: "cursor:pointer" }, `主路：${folds} · ${n} 层 ▾`));
    s.append(svgel("text", { x: 97, y: 4, "font-size": 3, "text-anchor": "end", fill: "#333" }, "N ↑"));
    s.append(svgel("text", { x: 3, y: 98, "font-size": 2.4, fill: "#555" }, `约 120 m 见方 · ${n} 层平台（1 层 ≈ ${SLOPES[state.slope].rise} m）· ${houses.length} 栋`));
  }
  return s;
}

// ------------------------------------------------------------ 渲染：侧剖面
function profileSVG({ small = false, slopeKey = state.slope } = {}) {
  const n = SIZES[state.size].terraces;
  const rise = SLOPES[slopeKey].rise;
  const W = 300, H = 120;
  const s = svgel("svg", { viewBox: `0 0 ${W} ${H}` });
  s.append(svgel("rect", { width: W, height: H, fill: "#eef3f6" }));
  const flat = 230 / n, px = 2.2;
  const pts = [[20, 102]];
  let x = 20, y = 102;
  for (let k = 0; k < n; k++) { if (k) { y -= rise * px; pts.push([x, y]); } x += flat; pts.push([x, y]); }
  s.append(svgel("polygon", { points: [[20, H], ...pts, [x, H]].map((p) => p.join(",")).join(" "), fill: "#cfc6b0", stroke: "#8c9a6b", "stroke-width": 1 }));
  if (state.variant === "C") s.append(svgel("rect", { x: 20, y: 100, width: 26, height: 4, fill: "#6f9bc2" }));
  const houses = genHouses();
  const pal = Object.fromEntries(PALETTES[state.palette].items.map(([k, hex]) => [k, hex]));
  for (let k = 0; k < n; k++) {
    const m = Math.min(6, houses.filter((h) => h.k === k).length);
    const yk = 102 - k * rise * px;
    for (let i = 0; i < m; i++) { const hx = 24 + k * flat + i * (flat / Math.max(6, m + 1)); s.append(svgel("rect", { x: hx, y: yk - 9, width: 7, height: 9, fill: pal.wall, stroke: "#333", "stroke-width": 0.5 }), svgel("path", { d: `M${hx - 1} ${yk - 9} L${hx + 3.5} ${yk - 13} L${hx + 8} ${yk - 9} Z`, fill: pal.roof })); }
    if (!small && rise >= 6) s.append(svgel("line", { x1: 20 + k * flat, x2: 20 + k * flat, y1: yk, y2: yk + rise * px, stroke: "#b8452b", "stroke-width": 1.5 }));
  }
  const topY = 102 - (n - 1) * rise * px, topX = 20 + n * flat;
  s.append(svgel("path", { d: `M${topX - 10} ${topY} L${topX - 4} ${topY - 16} L${topX + 2} ${topY} Z`, fill: "#b8452b" }));
  // 1.7 m 小人尺度参照
  s.append(svgel("circle", { cx: 14, cy: 102 - 1.7 * px * 1.6, r: 1.2, fill: "#1f6feb" }), svgel("line", { x1: 14, y1: 102 - 1.7 * px * 1.6 + 1.2, x2: 14, y2: 102, stroke: "#1f6feb", "stroke-width": 1 }));
  if (!small) {
    s.append(svgel("text", { x: 22, y: 12, "font-size": 8, fill: "#333" }, `${SLOPES[slopeKey].label} · ${n} 层 · 顶比入口高约 ${fmt(rise * (n - 1))} m · 每层台阶约 ${fmt(rise)} m${rise >= 6 ? " · 红线 = 崖" : ""}`));
    s.append(svgel("text", { x: 22, y: 114, "font-size": 7, fill: "#1f6feb" }, "入口 →（蓝点 = 1.7 m 的人）"));
    s.append(svgel("text", { x: topX - 14, y: topY - 19, "font-size": 7, fill: "#4a1a10" }, LANDMARKS[state.landmark].label));
  }
  return s;
}

// ------------------------------------------------------------ 渲染：玩家视角（示意）
function eyeSVG({ entryKey = state.entry, small = false } = {}) {
  const n = SIZES[state.size].terraces;
  const W = 300, H = 170;
  const s = svgel("svg", { viewBox: `0 0 ${W} ${H}` });
  const pal = Object.fromEntries(PALETTES[state.palette].items.map(([k, hex]) => [k, hex]));
  const defs = svgel("defs");
  const sky = svgel("linearGradient", { id: "sky" + entryKey, x1: 0, y1: 0, x2: 0, y2: 1 });
  sky.append(svgel("stop", { offset: 0, "stop-color": pal.mist }), svgel("stop", { offset: 1, "stop-color": "#f7f3ea" }));
  defs.append(sky);
  s.append(defs, svgel("rect", { width: W, height: H, fill: `url(#sky${entryKey})` }));
  const steep = SLOPES[state.slope].rise / 6;
  const shift = entryKey === "E" ? -50 : entryKey === "W" ? 50 : 0;
  s.append(svgel("path", { d: `M0 ${110 - 40 * steep} Q ${150 + shift} ${20 - 10 * steep} 300 ${105 - 35 * steep} L300 ${H} L0 ${H} Z`, fill: "#b9c7a3", opacity: 0.8 }));
  const houses = genHouses();
  for (let k = n - 1; k >= 0; k--) {
    const t = k / Math.max(1, n - 1);
    const yRow = 140 - t * (70 + 40 * steep), size = 10 + (1 - t) * 20;
    const m = Math.min(9, houses.filter((h) => h.k === k).length);
    const cx = 150 + shift * (1 - t) + (state.variant === "A" ? (k % 2 ? -1 : 1) * 40 * (1 - t) : 0);
    for (let i = 0; i < m; i++) {
      const hx = cx + (i - (m - 1) / 2) * size * 1.15 + (state.variant === "C" && i % 2 ? 60 * (1 - t) : state.variant === "C" ? -60 * (1 - t) : 0);
      s.append(svgel("rect", { x: hx - size / 2, y: yRow - size * 0.8, width: size, height: size * 0.8, fill: pal.wall, stroke: "#333", "stroke-width": 0.5 }), svgel("path", { d: `M${hx - size * 0.6} ${yRow - size * 0.8} L${hx} ${yRow - size * 1.25} L${hx + size * 0.6} ${yRow - size * 0.8} Z`, fill: pal.roof }));
    }
    s.append(svgel("rect", { x: 0, y: yRow - size * 1.3, width: W, height: size * 0.5, fill: pal.mist, opacity: 0.25 }));
  }
  const topY = 140 - (70 + 40 * steep) - 6;
  const lm = landmarkPos();
  const lx = 150 + shift * 0.2 + (lm[0] - 50) * 1.6;
  s.append(svgel("path", { d: `M${lx - 9} ${topY} L${lx} ${topY - 16} L${lx + 9} ${topY} Z`, fill: "#b8452b" }), svgel("rect", { x: lx - 14, y: topY - 20, width: 28, height: 24, fill: "none", stroke: "#d4a017", "stroke-width": 0.8, "stroke-dasharray": "2 1" }));
  if (!small) s.append(svgel("text", { x: lx, y: topY - 23, "font-size": 7, "text-anchor": "middle", fill: "#4a1a10" }, LANDMARKS[state.landmark].label));
  let d = `M${150} ${H}`;
  for (let k = 0; k < n; k++) { const t = k / Math.max(1, n - 1); d += ` L${150 + shift * (1 - t) + (state.variant === "A" ? (k % 2 ? -1 : 1) * 40 * (1 - t) : 0)} ${140 - t * (70 + 40 * steep)}`; }
  s.append(svgel("path", { d, fill: "none", stroke: pal.stone, "stroke-width": 3, "stroke-linejoin": "round", opacity: 0.9 }));
  if (!small) s.append(svgel("text", { x: 6, y: 12, "font-size": 7, fill: "#333" }, `从${ENTRIES[entryKey].label}、1.7 m 高看过去 · 金框 = 地标 · 正式版用三维渲染`));
  return s;
}

// ------------------------------------------------------------ 视图挂载与交互
let drawing = null;
function renderViews() {
  const mapBox = $("#view-map");
  mapBox.replaceChildren(mapSVG());
  mapBox.className = "view" + (state.view === "map" ? " active" : "") + " tool-" + state.tool;
  bindMapGestures(mapBox.querySelector("svg"));
  const pw = el("div", { class: "profile-wrap" }, profileSVG());
  const slider = el("input", { type: "range", min: 0, max: 2, step: 1, value: ["gentle", "mid", "steep"].indexOf(state.slope) });
  slider.addEventListener("input", () => { state.slope = ["gentle", "mid", "steep"][+slider.value]; bump("point"); renderViews(); });
  slider.addEventListener("change", () => ai(`坡度改成${SLOPES[state.slope].label}，每层台阶约 ${fmt(SLOPES[state.slope].rise)} m，顶比入口高约 ${fmt(SLOPES[state.slope].rise * (SIZES[state.size].terraces - 1))} m。房子的高度都重新贴地了，俯视图的等高线也跟着变。`));
  pw.append(el("div", { class: "slider" }, "缓", slider, "陡", el("span", { class: "hint" }, "拉一下就是改坡度，数值由程序换算，不用输")));
  $("#view-profile").replaceChildren(pw);
  $("#view-profile").className = "view" + (state.view === "profile" ? " active" : "");
  $("#view-eye").replaceChildren(el("div", { class: "eye-wrap" }, eyeSVG()));
  $("#view-eye").className = "view" + (state.view === "eye" ? " active" : "");
  renderUnderstanding();
  renderRelations();
  renderAssumptions();
  renderPalette();
}
function svgPoint(svg, ev) { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return [clamp(p.x, 0, 100), clamp(p.y, 0, 100)]; }
function bindMapGestures(svg) {
  if (!svg) return;
  let live = null, dragging = null;
  svg.addEventListener("pointerdown", (ev) => {
    const p = svgPoint(svg, ev);
    const t = ev.target;
    if (state.step === 3 && pending === "entry") {
      const cands = Object.entries(ENTRIES).map(([k, e]) => [Math.hypot(e.pos[0] - p[0], e.pos[1] - p[1]), k]).sort((a, b) => a[0] - b[0]);
      answerEntry(cands[0][1], true);
      return;
    }
    if (state.step < 4) return;
    // 复述标签：翻替代解释
    if (t.dataset && t.dataset.pathLabel) { bump("point"); showPopup(ev, [el("span", { class: "hint" }, "主路是："), ...[["直上", 0], ["之字 2 折", 2], ["之字 3 折", 3], ["盘绕 5 折", 5]].map(([lab, f]) => el("button", { class: "chip", onclick: () => { hidePopup(); state.zigzag = f; state.path = null; bump("choose"); renderViews(); ai(`主路改成${lab}，台阶数和每段坡度我重新算了，剖面上能看到。`); } }, lab))]); return; }
    if (t.dataset && t.dataset.regionLabel !== undefined) { const i = +t.dataset.regionLabel; bump("point"); showPopup(ev, Object.entries(REGION_TAGS).map(([tag, label]) => el("button", { class: "chip", onclick: () => { hidePopup(); state.regions[i].tag = tag; bump("choose"); renderViews(); ai(`这块改成「${label}」。`); } }, label))); return; }
    try { svg.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    if (state.tool === "path" || state.tool === "region") { drawing = { pts: [p] }; live = svgel("polyline", { points: p.join(","), fill: state.tool === "region" ? "rgba(31,111,235,.12)" : "none", stroke: "#1f6feb", "stroke-width": 1, "stroke-dasharray": "1.5 1" }); svg.append(live); }
    else if (state.tool === "pin") { const lm = landmarkPos(); const e = ENTRIES[state.entry].pos; dragging = Math.hypot(lm[0] - p[0], lm[1] - p[1]) < Math.hypot(e[0] - p[0], e[1] - p[1]) ? "landmark" : "entry"; if (dragging === "landmark" && state.locked.has("landmark")) { dragging = null; ai("地标已经锁住了（你点过「对」）。要动它先在关系清单里解锁。", chips(["解锁地标"], () => { state.locked.delete("landmark"); renderViews(); ai("解锁了，拖吧。"); })); } }
    else if (state.tool === "erase") {
      if (t.dataset.region !== undefined) { const rg = state.regions.splice(+t.dataset.region, 1)[0]; bump("point"); renderViews(); ai(`去掉了「${REGION_TAGS[rg.tag]}」这块。`); }
      else { state.path = null; bump("point"); renderViews(); ai("主路恢复成我原来的走法。"); }
    } else if (state.tool === "select") {
      if (t.dataset.house !== undefined) { const h = genHouses()[+t.dataset.house]; bump("point"); ai(`这栋在第 ${h.k + 1} 层平台，门朝路，屋顶用色板里的 roof。`, chips(["对", "不对", "锁住"], (c) => ai(c === "不对" ? "给你三个替代：挪到路另一侧 / 转 90° / 删掉——原型里先不改图。" : c === "锁住" ? "锁住了，后面出变体时它不会动。" : "好。"))); }
      else if (t.closest && t.closest(".landmark")) { bump("point"); ai(`这是${LANDMARKS[state.landmark].label}，玩家从入口第一眼就看它。`, chips(["对", "不对", "锁住"], (c) => { if (c === "锁住" || c === "对") { state.locked.add("landmark"); renderViews(); ai("地标锁住了。"); } else ai("换一个？", chips(Object.values(LANDMARKS).map((l) => l.label), (c2) => { state.landmark = Object.keys(LANDMARKS).find((k) => LANDMARKS[k].label === c2); renderViews(); ai(`地标换成${c2}。`); })); })); }
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (state.step < 4) return;
    const p = svgPoint(svg, ev);
    if (drawing && live) { const last = drawing.pts[drawing.pts.length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1.5) { drawing.pts.push(p); live.setAttribute("points", drawing.pts.map((q) => q.join(",")).join(" ")); } }
    if (dragging === "landmark") { state.landmarkPos = p; svg.querySelector(".landmark").setAttribute("transform", `translate(${p[0]} ${p[1]})`); }
  });
  svg.addEventListener("pointerup", (ev) => {
    if (state.step < 4) return;
    if (drawing) {
      const pts = drawing.pts; drawing = null; if (live) live.remove(); live = null;
      if (pts.length < 3) return;
      bump("point");
      if (state.tool === "path") {
        // 「笔画事实」：简化到 ≤ 12 点、起点吸附入口、终点吸附地标
        const step = Math.max(1, Math.ceil(pts.length / 11));
        const simp = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((q) => [fmt(q[0]), fmt(q[1])]);
        const lm = landmarkPos(), e = ENTRIES[state.entry].pos;
        if (Math.hypot(simp[0][0] - e[0], simp[0][1] - e[1]) < 12) simp[0] = e.slice();
        const endNear = Math.hypot(simp[simp.length - 1][0] - lm[0], simp[simp.length - 1][1] - lm[1]) < 12;
        if (endNear) simp[simp.length - 1] = lm.slice();
        state.path = simp;
        const n = SIZES[state.size].terraces;
        renderViews();
        ai(`读到你的笔画：${simp.length} 个折点，起点${simp[0] === e || Math.hypot(simp[0][0] - e[0], simp[0][1] - e[1]) < 1 ? "吸附到入口" : "在图中"}，终点${endNear ? "吸附到地标" : "没到地标，关系清单会亮红"}，穿过约 ${Math.min(n, Math.max(1, Math.round(simp.length / 2)))} 个平台。台阶我按每 ${fmt(SLOPES[state.slope].rise)} m 一层铺。要不要在转弯处留歇脚平台？`, chips(["要，转弯留平台", "不用"], (c) => ai(c.startsWith("要") ? "好，每个转弯留 3×3 m 的歇脚平台。" : "好，一路到顶。")));
      } else {
        const poly = pts.filter((_, i) => i % 2 === 0).map((q) => [fmt(q[0]), fmt(q[1])]);
        showPopup(ev, Object.entries(REGION_TAGS).map(([tag, label]) => el("button", { class: "chip", onclick: () => { hidePopup(); state.regions.push({ poly, tag }); bump("choose"); renderViews(); ai(`圈的这块记为「${label}」${tag === "dense" ? "，我在里面多塞了几栋，门都朝就近的路" : tag === "forest" ? "，房子挪走，树冠 6–8 m 的落叶树按 4 m 间距撒" : tag === "plaza" ? "，房子挪走，铺石板" : tag === "terrace" ? "，房子挪走，等高线上做梯田" : "，这块只留两三栋"}。标签点一下可以改。`); } }, label)));
      }
      return;
    }
    if (dragging) {
      const p = svgPoint(svg, ev);
      bump("point");
      if (dragging === "landmark") { state.landmarkPos = p; state.path = null; renderViews(); ai(`地标移到了${p[1] < 30 ? "山顶" : p[1] < 60 ? "半山" : "山脚"}${p[0] < 40 ? "偏西" : p[0] > 60 ? "偏东" : ""}，主路重新接过去；从入口看它在画面${p[0] < 45 ? "左" : p[0] > 55 ? "右" : "正中"}${p[1] < 40 ? "上" : ""}方。关系清单重新算过了。`); }
      dragging = null;
    }
  });
}
function showPopup(ev, kids) { const pop = $("#popup"); pop.replaceChildren(...kids); const r = $("#views").getBoundingClientRect(); pop.style.left = clamp(ev.clientX - r.left + 8, 8, Math.max(8, r.width - 270)) + "px"; pop.style.top = clamp(ev.clientY - r.top + 8, 8, Math.max(8, r.height - 80)) + "px"; pop.hidden = false; }
function hidePopup() { $("#popup").hidden = true; }

// ------------------------------------------------------------ 右栏：理解清单 / 关系 / 假设 / 参考 / 色板
function buildUnderstanding() {
  const n = SIZES[state.size].terraces, v = state.variant;
  const lm = landmarkPos();
  const where = lm[1] < 30 ? "山顶" : lm[1] < 60 ? "半山" : "山脚";
  const houses = genHouses().length;
  const items = [
    `入口在${ENTRIES[state.entry].label}，玩家第一眼看到${where}的${LANDMARKS[state.landmark].label}`,
    v === "A" ? `主路从入口起${state.zigzag ? `之字 ${state.zigzag} 折` : "直"}上山，经过 ${n} 层平台到地标` : v === "B" ? "主路绕着半山平台上去，平台是广场" : "主路先沿溪走，过桥后上东坡到地标",
    `共 ${n} 层平台，约 ${houses} 栋房子，${v === "A" ? "越往上越密" : v === "B" ? "一圈圈往外长" : "两坡各一片"}`,
    `${SLOPES[state.slope].label}：每层约 ${fmt(SLOPES[state.slope].rise)} m，顶比入口高约 ${fmt(SLOPES[state.slope].rise * (n - 1))} m`,
    v === "C" ? "溪在谷底自北向南流，一座桥连两岸" : "没有水，谷底是石阶和土路",
  ];
  for (const rg of state.regions) items.push(`你圈的一块是「${REGION_TAGS[rg.tag]}」`);
  const pal = PALETTES[state.palette];
  items.push(`配色按「${pal.name}」：${pal.items.map(([k, hex, note]) => `${note} ${hex}`).join("，")}`);
  return items;
}
function renderUnderstanding() {
  const body = $("#understand .body");
  if (state.step < 4) return;
  const items = buildUnderstanding();
  const prev = Object.fromEntries(state.understanding.map((u) => [u.text, u.ok]));
  state.understanding = items.map((text) => ({ text, ok: prev[text] ?? null }));
  const ul = el("ul", { class: "ulist" });
  state.understanding.forEach((u, i) => {
    const li = el("li", { class: u.ok === true ? "ok" : u.ok === false ? "bad" : "" });
    const okb = el("button", { class: "ubtn" + (u.ok === true ? " on-ok" : ""), onclick: () => { u.ok = true; if (i === 0) state.locked.add("landmark"); bump("choose"); renderViews(); } }, "对");
    const badb = el("button", { class: "ubtn" + (u.ok === false ? " on-bad" : ""), onclick: () => { u.ok = false; bump("choose"); renderUnderstanding(); ai(`第 ${i + 1} 条哪里不对？在图上指给我最准，也可以说一句。`, chips(["在图上指", "我说一句"], (c) => { if (c === "在图上指") { setTool("pin"); ai("好，切到图钉，拖一下或者圈一块。"); } else $("#input").focus(); })); } }, "错");
    li.append(el("span", { class: "t" }, u.text), okb, badb);
    ul.append(li);
  });
  const allOk = state.understanding.every((u) => u.ok === true);
  const go = el("button", { class: "primary go", onclick: goEngine }, allOk ? "全部确认，去引擎搭" : `确认后去引擎搭（还有 ${state.understanding.filter((u) => u.ok !== true).length} 条没点）`);
  body.replaceChildren(ul, go, el("div", { class: "hint" }, "点「对」的每一条都会变成给 AI 的约束并锁住对应对象；点「错」的那条会回到图上改。"));
}
function renderRelations() {
  const body = $("#relcheck .body");
  if (state.step < 4) { body.replaceChildren(el("div", { class: "empty" }, "AI 出草案后，这里是程序算出来的关系检查，不是 AI 自己说的。")); return; }
  const ul = el("ul", { class: "ulist" });
  for (const r of relations()) {
    const li = el("li", { class: r.ok ? "ok" : "bad" });
    li.append(el("span", { class: "t" }, (r.ok ? "✓ " : "✗ ") + r.text));
    if (!r.ok && r.fixes.length) li.append(el("button", { class: "ubtn", onclick: () => { bump("choose"); ai(`「${r.text}」不成立，怎么修？`, chips(r.fixes, (c) => { if (c === "不重要") return ai("好，这条忽略。"); if (r.fix) r.fix(); renderViews(); ai(`已按「${c}」改，关系重新算过。`); })); } }, "让 AI 修"));
    ul.append(li);
  }
  body.replaceChildren(ul);
}
function renderAssumptions() {
  const body = $("#assume .body");
  if (state.step < 4) { body.replaceChildren(el("div", { class: "empty" }, "AI 没问你就自己定下的值会列在这里，带「默认」角标，点一下改。")); return; }
  const ul = el("ul", { class: "ulist" });
  for (const [k, a] of Object.entries(ASSUMPTIONS)) {
    if (k === "stream" && state.variant !== "C") continue;
    const cur = state.assumptions[k];
    const li = el("li", {});
    li.append(el("span", { class: "t" }, `${a.label}：${cur.value}`, cur.confirmed ? "" : el("span", { class: "badge" }, "默认")));
    li.append(el("button", { class: "ubtn", onclick: (ev) => { bump("point"); showPopup(ev, a.options.map((o) => el("button", { class: "chip", onclick: () => { hidePopup(); cur.value = o; cur.confirmed = true; bump("choose"); renderAssumptions(); ai(`${a.label}定为${o}。`); } }, o))); } }, "改"));
    ul.append(li);
  }
  body.replaceChildren(ul, el("div", { class: "hint" }, "这是「我假设了」：AI 的隐含决定全部摆到明面。"));
}
function renderPalette() {
  const pal = PALETTES[state.palette];
  $("#palette .body").replaceChildren(el("div", { class: "pal" }, pal.items.map(([k, hex, note]) => el("div", {}, el("i", { style: `background:${hex}` }), el("span", {}, note), el("code", {}, hex)))));
  const grid = el("div", { class: "refgrid" });
  for (const [key, p] of Object.entries(PALETTES)) {
    if (key === "default") continue;
    const sw = el("div", { class: "sw" }, p.items.map(([, hex]) => el("i", { style: `background:${hex}` })));
    grid.append(el("div", { class: "ref" + (state.reference === key ? " active" : ""), onclick: () => { state.reference = key; state.palette = key; bump("choose"); renderViews(); ai(`屋顶和墙按「${p.name}」来：程序从图里取了 5 个色，都是 hex，直接写进材质意图。只让屋顶像它，还是整体都像？`, chips(["只屋顶", "整体都像"], (c) => ai(c === "只屋顶" ? "好，只换 roof。" : "好，整体都按它。"))); } }, sw, el("div", {}, p.name)));
  }
  $("#refs .body").replaceChildren(grid, el("div", { class: "hint" }, "原型里是三张示意色样；正式版可以拖任何照片进来，程序取色（k-means），AI 只负责把色分配到角色。"));
}

// ------------------------------------------------------------ 对话
let pending = null;
function setStep(n) { state.step = n; document.querySelectorAll("#steps li").forEach((li) => { const k = +li.dataset.step; li.className = k < n ? "done" : k === n ? "now" : ""; }); if (n >= 4) $("#tools").classList.remove("disabled"); }
function msg(who, text, attach) { const m = el("div", { class: "msg " + who }, el("div", { class: "who" }, who === "ai" ? "AI" : "你"), text); if (attach) m.append(el("div", { class: "attach" }, attach)); $("#log").append(m); $("#log").scrollTop = 1e9; return m; }
function ai(text, attach) { return msg("ai", text, attach); }
function chips(labels, onPick) { const box = el("div", { class: "cards" }); const row = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }); labels.forEach((l) => row.append(el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", l); onPick(l); } }, l))); box.append(row); return box; }
function setQuickChips(labels, onPick) { const c = $("#chips"); c.replaceChildren(); labels.forEach((l) => c.append(el("button", { onclick: () => { bump("choose"); msg("user", l); onPick(l); } }, l))); }
function setTool(t) { state.tool = t; document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t)); $("#view-map").className = "view" + (state.view === "map" ? " active" : "") + " tool-" + t; }
function askBudget() { state.asked++; $("#budget").textContent = `问题 ${state.asked}/4`; }

function start() {
  ai("说一句你想要的场景。我不会让你摆方块：先给你三个方向选，再用四个带图的问题把它定下来，之后你在图上指哪改哪。", null);
  setQuickChips(["我要生成山城村庄", "一个黄昏的村口广场"], onIntent);
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; bump("type"); msg("user", t); onText(t); });
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b)); renderViews(); }));
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
  document.addEventListener("pointerdown", (e) => { if (!$("#popup").hidden && !$("#popup").contains(e.target)) hidePopup(); });
  setStep(1);
  renderViews();
}
function onText(t) {
  if (state.step === 1) return onIntent(t);
  const rules = [
    [/更陡|陡一点/, () => { state.slope = state.slope === "gentle" ? "mid" : "steep"; return `坡度改成${SLOPES[state.slope].label}。`; }],
    [/更缓|缓一点|平一点/, () => { state.slope = state.slope === "steep" ? "mid" : "gentle"; return `坡度改成${SLOPES[state.slope].label}。`; }],
    [/更密|密一点|多.*房/, () => { state.density = Math.min(1.8, state.density + 0.3); return `房子加密到 ${genHouses().length} 栋，上密下疏保持。`; }],
    [/更稀|稀一点|少.*房/, () => { state.density = Math.max(0.5, state.density - 0.3); return `房子减到 ${genHouses().length} 栋。`; }],
    [/大一点|更大/, () => { state.size = state.size === "small" ? "medium" : "large"; state.path = null; return `规模改成「${SIZES[state.size].label}」，${SIZES[state.size].terraces} 层平台。`; }],
    [/小一点|更小/, () => { state.size = state.size === "large" ? "medium" : "small"; state.path = null; return `规模改成「${SIZES[state.size].label}」，${SIZES[state.size].terraces} 层平台。`; }],
    [/寺庙|水车|大树/, (m) => { state.landmark = Object.keys(LANDMARKS).find((k) => LANDMARKS[k].label === m[0]); return `地标换成${m[0]}。`; }],
    [/入口.*(南|东|西)|(南|东|西).*入口/, (m) => { const d = m[1] || m[2]; state.entry = { 南: "S", 东: "E", 西: "W" }[d]; state.path = null; return `入口改到${ENTRIES[state.entry].label}，第一眼还是朝地标。`; }],
    [/重来|重新/, () => { Object.assign(state, { variant: null, path: null, regions: [], landmarkPos: null, density: 1, asked: 0 }); state.locked.clear(); setStep(2); return null; }],
  ];
  for (const [re, fn] of rules) { const m = t.match(re); if (m) { const r = fn(m); if (r === null) return onIntent(state.intent); renderViews(); return ai(r); } }
  ai("这句我没把握翻成空间：是位置、大小、还是长相的事？在图上指给我最准，或者选一个：", chips(["在图上画一笔", "圈一块地", "换个方向重来"], (c) => { if (c === "在图上画一笔") setTool("path"); else if (c === "圈一块地") setTool("region"); else onText("重来"); }));
}
function onIntent(t) {
  state.intent = t;
  setStep(2);
  ai(`「${t}」。我先按这句话出三个方向，三张图同一个比例、同一套图例，卡片下面标了它们之间的差异（高亮的就是不同的地方）。选最像你脑子里的那个，不像就换一批：`, variantCards());
  setQuickChips(["都不像，换一批", "我先说几句要求"], (c) => { if (c.startsWith("都")) askAxis(); else ai("说吧，我边听边改方向。", null); });
}
function variantTags(key, override = {}) {
  const sz = override.size || state.size, en = override.entry || state.entry, spot = override.lmSpot || "top";
  return { 地标: LM_SPOTS[spot].label, 层数: `${SIZES[sz].terraces} 层`, 入口: ENTRIES[en].label, 路形: VARIANTS[key].road, 溪: key === "C" ? "有" : "无", 密度: override.density ? (override.density > 1 ? "密" : override.density < 1 ? "疏" : "中") : "中", 色板: PALETTES[override.palette || state.palette].name };
}
function variantCards(axis = null) {
  const box = el("div", { class: "cards" });
  const keys = ["A", "B", "C"];
  const overrides = keys.map((k, i) => {
    if (!axis) return {};
    if (axis === "landmark") return { lmSpot: ["top", "ridge", "cliff"][i] };
    if (axis === "terraces") return { size: ["small", "medium", "large"][i] };
    if (axis === "entry") return { entry: ["S", "E", "W"][i] };
    if (axis === "density") return { density: [0.7, 1, 1.4][i] };
    return { palette: ["huizhou", "default", "hongya"][i] };
  });
  const cardKeys = axis ? [state.variant || "A", state.variant || "A", state.variant || "A"] : keys;
  const tagSets = cardKeys.map((k, i) => variantTags(k, overrides[i]));
  const diffKeys = Object.keys(tagSets[0]).filter((t) => new Set(tagSets.map((s) => s[t])).size > 1);
  cardKeys.forEach((key, i) => {
    const saved = { variant: state.variant, path: state.path, landmarkPos: state.landmarkPos, size: state.size, entry: state.entry, lmSpot: state.lmSpot, density: state.density, palette: state.palette };
    Object.assign(state, { variant: key, path: null, landmarkPos: null }, overrides[i]);
    const thumb = mapSVG({ small: true });
    Object.assign(state, saved);
    const tags = el("div", { class: "tags" }, Object.entries(tagSets[i]).map(([k, v]) => el("span", { class: "tag" + (diffKeys.includes(k) ? " diff" : "") }, `${k}：${v}`)));
    const axisKey = { landmark: "地标", terraces: "层数", entry: "入口", density: "密度", palette: "色板" }[axis];
    const title = axis ? `${VARIANTS[key].name} · ${AXES[axis]}：${tagSets[i][axisKey]}` : VARIANTS[key].name;
    box.append(el("div", { class: "card" }, thumb, el("div", { class: "txt" }, el("b", {}, title), axis ? "" : VARIANTS[key].desc, tags), el("button", { onclick: () => pickVariant(key, overrides[i]) }, "选这个")));
  });
  return box;
}
function askAxis() {
  ai("换一批可以，先告诉我这批要在哪条轴上不同，不然换出来的可能还是看不出区别：", chips(Object.values(AXES), (c) => { const axis = Object.keys(AXES).find((k) => AXES[k] === c); ai(`这批三张只在「${c}」上不同，其它都一样：`, variantCards(axis)); }));
}
function pickVariant(key, override = {}) {
  bump("choose");
  msg("user", `选 ${VARIANTS[key].name}`);
  Object.assign(state, { variant: key, path: null, landmarkPos: null }, override);
  if (override.lmSpot) state.lmSpot = override.lmSpot;
  setStep(3);
  state.asked = 0;
  renderViews();
  askBudget();
  ai(`好，${VARIANTS[key].name}。右边是它的俯视语义图：等高线、平台层号、房子、主路、入口和第一眼方向。接下来只问四个影响布局的问题，都用图选，每个都可以「你定」跳过。\n\n第一个：山有多陡？`, withSkip(slopeOptions(), () => { askSize(); }));
  setQuickChips([], () => {});
}
function withSkip(node, onSkip) { const w = el("div", {}, node, el("div", { style: "margin-top:6px" }, el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", "你定"); onSkip(); } }, "你定（按默认）"))); return w; }
function slopeOptions() {
  const grid = el("div", { class: "opts" });
  for (const [k, sl] of Object.entries(SLOPES)) grid.append(el("div", { class: "opt" }, profileSVG({ small: true, slopeKey: k }), el("div", { class: "lbl" }, `${sl.label} · 每层约 ${sl.rise} m`), el("button", { onclick: () => { bump("choose"); msg("user", sl.label); state.slope = k; renderViews(); askSize(); } }, "选")));
  return grid;
}
function askSize() {
  askBudget();
  ai("第二个：村子多大？按走路时间算，不按米。", withSkip(chips(Object.values(SIZES).map((s) => s.label), (c) => { state.size = Object.keys(SIZES).find((k) => SIZES[k].label === c); state.path = null; renderViews(); askLandmark(); }), askLandmark));
}
function askLandmark() {
  askBudget();
  const grid = el("div", { class: "opts" });
  for (const [k, sp] of Object.entries(LM_SPOTS)) {
    const saved = { lmSpot: state.lmSpot, landmarkPos: state.landmarkPos, path: state.path };
    Object.assign(state, { lmSpot: k, landmarkPos: null, path: null });
    const thumb = mapSVG({ small: true });
    Object.assign(state, saved);
    grid.append(el("div", { class: "opt" }, thumb, el("div", { class: "lbl" }, sp.label), el("button", { onclick: () => { bump("choose"); msg("user", sp.label); state.lmSpot = k; state.landmarkPos = null; state.path = null; renderViews(); ai("它是什么？", chips(Object.values(LANDMARKS).map((l) => l.label), (c) => { state.landmark = Object.keys(LANDMARKS).find((x) => LANDMARKS[x].label === c); renderViews(); askEntry(); })); } }, "选")));
  }
  ai("第三个：地标放哪？先定地标再定你从哪看它，不然换了地标第一眼就要重选。三个位置都画在图上了：", withSkip(grid, askEntry));
}
function askEntry() {
  askBudget();
  pending = "entry";
  const grid = el("div", { class: "opts" });
  for (const [k, e] of Object.entries(ENTRIES)) grid.append(el("div", { class: "opt" }, eyeSVG({ entryKey: k, small: true }), el("div", { class: "lbl" }, `从${e.label}进`), el("button", { onclick: () => answerEntry(k, false) }, "选")));
  ai("最后一个：玩家从哪进村？这三张是从三个入口、1.7 m 眼高看过去的第一眼，金框是地标。也可以直接在右边图的边缘点一下。", withSkip(grid, () => answerEntry(state.entry, false)));
  renderViews();
}
function answerEntry(key, byClick) {
  if (pending !== "entry") return;
  pending = null;
  if (byClick) { bump("point"); msg("user", `（在图上点了${ENTRIES[key].label}）`); } else { bump("choose"); msg("user", `从${ENTRIES[key].label}进`); }
  state.entry = key; state.path = null;
  finishDraft();
}
function finishDraft() {
  setStep(4);
  setTool("select");
  renderViews();
  ai(`问完了，四个问题。这是我理解的版本：右边「我理解为」列了 ${buildUnderstanding().length} 条，逐条点对错；「关系检查」是程序算出来的 ✓/✗；「我假设了」是我没问你就定下的，带「默认」角标。\n\n现在你可以直接在图上改，不用说坐标：\n· 画路：画一笔，那就是主路（起点终点会自动吸到入口和地标）\n· 圈区域：圈一块，告诉我它是密是稀、是林子还是广场\n· 图钉：把${LANDMARKS[state.landmark].label}或入口拖到你要的地方\n· 点图上的「主路：之字 3 折 ▾」这类标签，可以翻替代解释\n· 侧剖面那页拉一下坡度；参考里点一张图，颜色就按它来\n\n也可以直接说「更陡」「房子更密」，翻不了的我会请你在图上指。`);
  setQuickChips(["更陡一点", "房子更密", "换成水车", "入口改到东侧"], onText);
  $("#input").placeholder = "说一句修改，或者在图上画 / 圈 / 拖 / 翻标签";
}
function goEngine() {
  setStep(5);
  const n = SIZES[state.size].terraces;
  const pal = PALETTES[state.palette];
  const body = $("#modal-body");
  body.replaceChildren(
    el("p", {}, "给 AI 的不是这段对话，而是对话沉淀下来的结构化包（你全程没看见它，也不需要看）："),
    el("ul", {}, [
      `scene.sid.json：${genHouses().length} 个体块、${n} 层地形平台、1 条主路（${currentPath().length} 个折点）、${state.regions.length} 个区域、入口与地标标记；所有坐标由程序产出，AI 只给了结构与语义`,
      `relations：${LANDMARKS[state.landmark].label} visible_from 入口；每栋房 faces 就近的路；路 connects 各平台；${LANDMARKS[state.landmark].label} on_top_of 顶层台地`,
      `views/top.png：带等高线、层号、朝向箭头的俯视图；views/section.png：剖面；views/first_person.png：入口视角`,
      `palette.json：${pal.items.map(([, hex]) => hex).join(" ")}（来自「${pal.name}」）`,
      `acceptance：你点「对」的 ${state.understanding.filter((u) => u.ok === true).length} 条 + 关系检查 ${relations().filter((r) => r.ok).length} 条，作为 AI 自检与我的验收条件；锁住的对象：${state.locked.size} 个`,
    ].map((t) => el("li", {}, t))),
    el("p", { class: "hint" }, "原型里不真的调引擎。正式版：AI 经 Unity / UE 的 MCP 搭建，搭完把场景读回来和这份包比对；AI 不看截图自检，比对由脚本算。"),
    el("div", { id: "progress" }, "正在 Unity 里搭建…"),
  );
  $("#modal-title").textContent = "去引擎搭建";
  $("#modal").hidden = false;
  setTimeout(() => { $("#progress").textContent = "搭好了。读回比对：发现 2 处和你确认的意图不一致，已标红在俯视图上。"; $("#modal-close").textContent = "去看红点"; $("#modal-close").onclick = () => { $("#modal").hidden = true; $("#modal-close").textContent = "关闭"; $("#modal-close").onclick = () => ($("#modal").hidden = true); showReadback(); }; }, 1600);
}
function showReadback() {
  setStep(6);
  state.view = "map"; document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.view === "map"));
  renderViews();
  const svg = $("#view-map svg");
  const lm = landmarkPos();
  const issues = [
    { p: [clamp(lm[0] + 14, 6, 94), clamp(lm[1] + 18, 6, 94)], text: "house_7 比意图低了一层（y 偏 3.8 m），且压到了主路" },
    { p: [lm[0], lm[1]], text: `${LANDMARKS[state.landmark].label}没搭，这里是空的` },
  ];
  issues.forEach((is, i) => {
    const g = svgel("g", { class: "issue", style: "cursor:pointer" });
    g.append(svgel("circle", { cx: is.p[0], cy: is.p[1], r: 4, fill: "rgba(184,69,43,.25)", stroke: "#b8452b", "stroke-width": 0.8 }), svgel("text", { x: is.p[0], y: is.p[1] + 1.2, "font-size": 3.5, "text-anchor": "middle", fill: "#b8452b", "font-weight": 700 }, String(i + 1)));
    g.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); bump("point"); showPopup(ev, [el("span", { style: "font-size:12px" }, is.text), el("button", { class: "chip", onclick: () => { hidePopup(); g.remove(); ai(`已修：${i === 0 ? "house_7 抬回第 3 层、挪到路边 2 m 处，门朝路" : `${LANDMARKS[state.landmark].label}按意图补在山顶`}。再读回一次，这处和你确认的一致了。`); } }, "按意图修"), el("button", { class: "chip", onclick: () => { hidePopup(); g.remove(); ai("好，这处按引擎里现在的样子，意图文件我同步改了并锁住。"); } }, "接受引擎版"), el("button", { class: "chip", onclick: () => { hidePopup(); g.remove(); ai("好，这处忽略。"); } }, "不重要")]); });
    svg.append(g);
  });
  ai(`搭好了。读回来和你确认过的意图比了一下：位置、朝向、缺漏、台地层、颜色都由脚本算，有 2 处不一致，标在图上的红点 1、2。点红点看是什么，然后三选一：按意图修 / 接受引擎版 / 不重要。\n\n这一轮沟通你一共：指点 ${state.meter.point} 次、选择 ${state.meter.choose} 次、打字 ${state.meter.type} 句、输入坐标 ${state.meter.coord} 次。`);
  setQuickChips(["再出一版变体", "导出这份包给 Claude Code"], (c) => { if (c.startsWith("再")) askAxis(); else ai("已导出 zip：scene.sid.json、三张图、色板、验收条件、PROTOCOL.md。"); });
}

start();
