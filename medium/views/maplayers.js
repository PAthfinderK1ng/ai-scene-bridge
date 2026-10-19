// views/maplayers.js — 俯视图的新图层：地下 / 天上空间、连接点、剖切线（宽度带 + 把手）、选中高亮。
// 全部从 SID 数据画出来；当前层画实、其它层淡显（opacity + 不接手势 + data-inactive）。被 map.js 的 renderMap 调用。
import { svgel, fmt1, pts } from "./map.js";
import { polygonCentroid } from "../engine/terrain.js";
import { sectionPath, widthClamp } from "../engine/section.js";
import { boxCorners } from "../engine/layout.js";

/** 空间配色：地下深色虚线、天上浅蓝描边 */
export const SPACE_STYLE = Object.freeze({
  underground: { fill: "#3b342d", fillOpacity: 0.32, stroke: "#2a241f", dash: "2 1", text: "#3b342d", arrow: "#3b342d" },
  sky: { fill: "#cfe6f7", fillOpacity: 0.55, stroke: "#3d8bd0", dash: null, text: "#2a6aa6", arrow: "#3d8bd0" },
});
export const SECTION_COLOR = "#7a4fc9";
const SELECT_COLOR = "#f08c00";

/**
 * 空间的标高标签：地下「−n 层」（顶板在地面下几层）、天上「+n 层」（底面在地面上几层），按质心处地面与层高现算（人调过高度也对）。
 * @returns {string}
 */
export function spaceLevelTag(space, sid, T) {
  const layer = Number(sid.meta && sid.meta.layer_height_m) || 3;
  const c = polygonCentroid(space.polygon), g = T ? T.heightAt(c[0], c[1]) : 0;
  if (space.stratum === "underground") return `−${Math.max(0, Math.round((g - (space.floor_y + space.height)) / layer))} 层`;
  return `+${Math.max(0, Math.round((space.floor_y - g) / layer))} 层`;
}

/** 地下 / 天上空间多边形 + 「名字 · −2 层」标签 */
export function drawSpaces(svg, labels, { sid, T, stratum, small, u, label }) {
  const spaces = (sid.spaces || []).filter((x) => x && Array.isArray(x.polygon) && x.polygon.length >= 3 && SPACE_STYLE[x.stratum]);
  if (!spaces.length) return;
  const g = svgel("g", { class: "spaces" });
  // 当前层的画在最上面
  const order = spaces.slice().sort((a, b) => (a.stratum === stratum) - (b.stratum === stratum));
  for (const sp of order) {
    const st = SPACE_STYLE[sp.stratum], active = sp.stratum === stratum;
    const node = svgel("polygon", {
      points: pts(sp.polygon), fill: st.fill, "fill-opacity": st.fillOpacity, stroke: st.stroke, "stroke-width": fmt1((active ? 0.6 : 0.4) * u),
      "stroke-dasharray": st.dash, "stroke-linejoin": "round", opacity: active ? 1 : 0.3, "data-space": sp.id, "data-stratum": sp.stratum,
      "pointer-events": active ? null : "none", "data-inactive": active ? null : 1, style: active ? "cursor:move" : null,
    });
    g.append(node);
    if (small || !active) continue; // 别的层只留淡显的形状，名字不写（连接点标签已说明上下）
    const xs = sp.polygon.map((p) => p[0]), zs = sp.polygon.map((p) => p[1]);
    const t = label({ x: fmt1((Math.min(...xs) + Math.max(...xs)) / 2), y: fmt1(Math.min(...zs) - 1 * u), "font-size": fmt1(2.4 * u), "text-anchor": "middle", fill: st.text,
      "data-space": sp.id, "data-for": `space:${sp.id}` }, `${sp.label || sp.id} · ${spaceLevelTag(sp, sid, T)}`);
    labels.append(t);
  }
  svg.append(g);
}

/** 连接点图标（单位框 ±1.6，按 u 缩放） */
const VIA_GLYPH = {
  stairs: "M-1 1 H-0.3 V0.3 H0.4 V-0.4 H1.1 V-1",
  ladder: "M-0.6 -1.1 V1.1 M0.6 -1.1 V1.1 M-0.6 -0.5 H0.6 M-0.6 0.1 H0.6 M-0.6 0.7 H0.6",
  well: "M-0.9 0 A0.9 0.9 0 1 0 0.9 0 A0.9 0.9 0 1 0 -0.9 0 M-0.35 0 A0.35 0.35 0 1 0 0.35 0 A0.35 0.35 0 1 0 -0.35 0",
  shaft: "M-0.9 -0.9 H0.9 V0.9 H-0.9 Z M-0.9 -0.9 L0.9 0.9 M0.9 -0.9 L-0.9 0.9",
  elevator: "M-0.9 -0.9 H0.9 V0.9 H-0.9 Z M0 -0.6 V0.6 M-0.4 -0.2 L0 -0.6 L0.4 -0.2",
  rope_bridge: "M-1.1 -0.4 Q0 0.8 1.1 -0.4 M-1.1 -0.4 V0.6 M1.1 -0.4 V0.6",
  ramp: "M-1.1 1 L1.1 -1 M-1.1 1 H1.1",
};

/** 连接点：小图标 + 竖向箭头（下行 ↓ 深色、上行 ↑ 浅蓝）；连到当前层的画实 */
export function drawConnectors(svg, labels, { sid, stratum, small, u, label }) {
  const conns = (sid.markers || []).filter((m) => m && m.kind === "connector" && Array.isArray(m.position));
  if (!conns.length) return;
  const byId = new Map((sid.spaces || []).map((s) => [s.id, s]));
  const g = svgel("g", { class: "connectors" });
  for (const m of conns) {
    const strata = [m.from, m.to].filter((e) => e !== "ground" && byId.has(e)).map((e) => byId.get(e).stratum);
    const down = strata.includes("underground"), up = strata.includes("sky");
    const active = stratum === "ground" || strata.includes(stratum);
    const [x, , z] = m.position;
    const k = u * 0.9;
    const n = svgel("g", { class: "connector", transform: `translate(${fmt1(x)} ${fmt1(z)})`, "data-connector": m.id, "data-pos": `${fmt1(x)} ${fmt1(z)}`,
      opacity: active ? 1 : 0.35, "pointer-events": active ? null : "none", "data-inactive": active ? null : 1, style: active ? "cursor:move" : null });
    const box = svgel("g", { transform: `scale(${fmt1(k * 100) / 100})` });
    box.append(svgel("rect", { x: -1.6, y: -1.6, width: 3.2, height: 3.2, rx: 0.6, fill: "#fff", stroke: "#333", "stroke-width": 0.28 }));
    box.append(svgel("path", { d: VIA_GLYPH[m.via] || VIA_GLYPH.stairs, fill: "none", stroke: "#333", "stroke-width": 0.28, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    // 竖向箭头（图标右侧）：下行朝下、上行朝上、两头都有就双向
    const col = down && !up ? SPACE_STYLE.underground.arrow : SPACE_STYLE.sky.arrow;
    let d = "M2.6 -1.5 V1.5";
    if (down || !up) d += " M1.9 0.8 L2.6 1.6 L3.3 0.8";
    if (up) d += " M1.9 -0.8 L2.6 -1.6 L3.3 -0.8";
    box.append(svgel("path", { d, fill: "none", stroke: col, "stroke-width": 0.42, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    n.append(box);
    g.append(n);
    if (!small) labels.append(label({ x: fmt1(x + 3.6 * k), y: fmt1(z + 0.8 * u), "font-size": fmt1(2.1 * u), fill: "#333", opacity: active ? 1 : 0.5, "pointer-events": "none", "data-for": `connector:${m.id}` }, m.label || "连接点"));
  }
  svg.append(g);
}

/** 剖切宽度带（常显：直线 12% 透明紫；沿主路 6%，不抢主路），盖在地面层之上；带内的东西会投到剖面上 */
export function drawSectionBand(svg, section, sid, u) {
  const path = sectionPath(section, sid), w = widthClamp(section.width_m);
  svg.append(svgel("polyline", { points: pts(path), class: "sec-band", fill: "none", stroke: SECTION_COLOR, "stroke-opacity": section.mode === "line" ? 0.12 : 0.06, "stroke-width": w, "stroke-linejoin": "round", "stroke-linecap": "butt", "pointer-events": "none", "data-for": "section" }));
}

/** 剖切线中心线（沿主路时淡色）；直线模式且 handles 为真（移动 / 剖切工具）时加两端（A / B）与中段把手。A/B 字标进文字层 */
export function drawSectionHandles(svg, labels, section, sid, u, label, handles = true) {
  const path = sectionPath(section, sid), line = section.mode === "line";
  const g = svgel("g", { class: "section-layer" });
  g.append(svgel("polyline", { points: pts(path), class: "sec-line", fill: "none", stroke: SECTION_COLOR, "stroke-opacity": line ? 1 : 0.35, "stroke-width": fmt1((line ? 0.45 : 0.3) * u), "stroke-dasharray": `${fmt1(2 * u)} ${fmt1(1 * u)}`, "pointer-events": "none" }));
  if (line && handles && path.length === 2) {
    const [a, b] = path, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const [which, q] of [["a", a], ["b", b]]) g.append(svgel("circle", { cx: fmt1(q[0]), cy: fmt1(q[1]), r: fmt1(1.5 * u), fill: "#fff", stroke: SECTION_COLOR, "stroke-width": fmt1(0.5 * u), class: "sec-handle", "data-section": which, "data-pos": `${fmt1(q[0])} ${fmt1(q[1])}`, style: "cursor:grab" }));
    g.append(svgel("rect", { x: fmt1(-1.1 * u), y: fmt1(-1.1 * u), width: fmt1(2.2 * u), height: fmt1(2.2 * u), fill: SECTION_COLOR, stroke: "#fff", "stroke-width": fmt1(0.3 * u), transform: `translate(${fmt1(m[0])} ${fmt1(m[1])}) rotate(45)`, class: "sec-handle", "data-section": "mid", "data-pos": `${fmt1(m[0])} ${fmt1(m[1])}`, style: "cursor:move" }));
    for (const [which, q, o] of [["a", a, b], ["b", b, a]]) {
      const p = sectionLabelPos(q, o, u);
      labels.append(label({ x: fmt1(p[0]), y: fmt1(p[1]), "font-size": fmt1(2.6 * u), "font-weight": 700, "text-anchor": "middle", fill: SECTION_COLOR, "pointer-events": "none", "data-section-label": which }, which.toUpperCase()));
    }
  }
  svg.append(g);
}
/** A / B 字标位置：端点再往外 3u（远离另一端），字基线下移 1u 让字居中 */
export function sectionLabelPos(q, other, u) {
  const dx = q[0] - other[0], dz = q[1] - other[1], L = Math.hypot(dx, dz) || 1;
  return [q[0] + (dx / L) * 3.2 * u, q[1] + (dz / L) * 3.2 * u + 0.9 * u];
}

/** 选中高亮（橙色描边）；节点带 data-for，拖动时跟着平移 */
export function drawSelection(svg, sel, { sid, T, u }) {
  if (!sel || !sel.type) return;
  const st = { fill: "none", stroke: SELECT_COLOR, "stroke-width": fmt1(0.6 * u), "pointer-events": "none", class: "selection" };
  const ring = (x, z, r, key) => svgel("circle", Object.assign({ cx: fmt1(x), cy: fmt1(z), r: fmt1(r), "data-for": key }, st));
  let n = null;
  const { type, id } = sel;
  if (type === "house" || type === "landmark") {
    const v = (sid.volumes || []).find((x) => x.id === id) || (type === "landmark" ? (sid.volumes || []).find((x) => x.importance === "landmark") : null);
    if (v && v.position && v.size) n = svgel("polygon", Object.assign({ points: pts(boxCorners(v.position, [v.size[0] + 1.6, v.size[1], v.size[2] + 1.6], v.rotation_y || 0)), "data-for": `${type}:${v.id}` }, st));
  } else if (type === "spawn" || type === "connector") {
    const m = (sid.markers || []).find((x) => x.id === id) || (type === "spawn" ? (sid.markers || []).find((x) => x.kind === "player_spawn") : null);
    if (m) n = ring(m.position[0], m.position[2], 3.4 * u, `${type}:${m.id}`);
  } else if (type === "space" || type === "region" || type === "terrace") {
    const o = type === "space" ? (sid.spaces || []).find((x) => x.id === id) : type === "region" ? (sid.regions || []).find((x) => x.id === id) : ((T && T.terraces) || []).find((x) => x.id === id);
    if (o && o.polygon) n = svgel("polygon", Object.assign({ points: pts(o.polygon), "stroke-linejoin": "round", "data-for": `${type}:${id}` }, st, { "stroke-width": fmt1(0.8 * u) }));
  } else if (type === "path") {
    const p = (sid.paths || []).find((x) => x.id === id);
    if (p && p.points) n = svgel("polyline", Object.assign({ points: pts(p.points), "stroke-linejoin": "round", "data-for": `path:${id}` }, st, { "stroke-width": fmt1(1.2 * u), "stroke-opacity": 0.6 }));
  } else if (type === "trail_vertex") {
    const t = (sid.paths || []).find((x) => x.id === "main_trail"), i = Number(sel.index ?? id);
    if (t && t.points[i]) n = ring(t.points[i][0], t.points[i][1], 2 * u, `trail_vertex:${i}`);
  }
  if (n) svg.append(n);
}
