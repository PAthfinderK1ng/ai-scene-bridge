// views/mapgestures.js — 俯视图手势：移动工具下按下即可拖（地标 / 入口 / 房子 / 主路折点 / 剖切线端点与中段 / 空间 / 连接点），
// 拖动中只改 DOM 预览（不重建 SVG），松手才回调；剖切工具拉一条线；画路 / 圈区域 / 擦除同以前。全部本地，不调 AI。
import { svgel, fmt1, pts, landmarkOf, spawnOf } from "./map.js";
import { clamp } from "../engine/terrain.js";
import { sectionLabelPos } from "./maplayers.js";

/** 屏幕坐标 → 世界坐标 [x, z]（夹在 bounds 内） */
export function svgPoint(svg, ev, sid) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const b = sid.bounds;
  return [clamp(p.x, b.min[0], b.max[0]), clamp(p.y, b.min[2], b.max[2])];
}

/** 方向角（度，0 = 东，90 = 北，俯视逆时针为正）；step > 0 时吸附到 step 的整数倍 */
export function snapAngle(from, to, step = 15) {
  const dx = to[0] - from[0], dz = to[1] - from[1], L = Math.hypot(dx, dz);
  let a = ((Math.atan2(-dz, dx) * 180) / Math.PI + 360) % 360;
  if (step > 0) a = (Math.round(a / step) * step) % 360;
  const t = (a * Math.PI) / 180;
  return { angle_deg: Math.round(a * 10) / 10, length_m: Math.round(L * 10) / 10, to: step > 0 ? [from[0] + Math.cos(t) * L, from[1] - Math.sin(t) * L] : [to[0], to[1]] };
}
const r2 = (v) => Math.round(v * 100) / 100;
const DRAG_TYPES = new Set(["landmark", "spawn", "house", "trail_vertex", "section_a", "section_b", "section_mid", "space", "connector"]);
const parsePos = (n) => { const a = (n.getAttribute("data-pos") || "").split(" ").map(Number); return a.length === 2 && a.every(Number.isFinite) ? a : null; };

/**
 * 绑定手势。handlers（都可选）：
 *  tool()                         → move | path | region | section | erase（兼容旧的 select / pin = move）
 *  canDrag(target) → bool         开始拖之前问（锁住的返回 false；没给时只有地标 / 入口按 canPin 能拖）
 *  onDrag(target, p, info)        拖动中（实时；图已由这里移动预览，不要重建）
 *  onDragEnd(target, p, info)     松手：p = 目标的新位置 [x,z]（空间是指针位置，平移量看 info.delta）
 *  onSelect(target, p, ev)        没拖动，只是点了一下
 *  onSection([a, b], info)        剖切工具拉完一条线（≥ 4 m）
 *  onPath(points, ev) / onRegion(points, ev) / onErase(target, p) / onFlip(kind, id, ev) / onDiff(id, ev) 同以前
 *  onGesture(on)                  拖动 / 画路 / 圈 / 剖切开始（true）与结束或取消（false）：3D 小窗据此淡出、不挡指针
 *  onDragCancel()                 拖动中按 Esc（或 pointercancel）：DOM 已还原，不提交
 *  旧接口 canPin(kind) / onPinEnd(kind, p) 仍然认（没给 canDrag / onDragEnd 时）
 * target = {type, id, index?}；type ∈ house | tree | landmark | spawn | space | connector | trail_vertex | section_a | section_b | section_mid | region | path | terrace | ground
 * info：{ delta:[dx,dz], pos:[x,z]?, index?, line?:[[x,z],[x,z]], angle_deg?, length_m? }；剖切端点拖动 15° 吸附，按住 Alt 不吸附。
 */
export function bindMapGestures(svg, sid, handlers = {}) {
  const H = handlers;
  let drawing = null, live = null, drag = null;
  const toolNow = () => { const t = H.tool ? H.tool() : "move"; return t === "select" || t === "pin" ? "move" : t; };
  const q = (sel) => svg.querySelector(sel);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/"/g, '\\"'));
  const targetOf = (n) => {
    const g = (sel) => n && n.closest && n.closest(sel);
    let m;
    if ((m = g("[data-section]"))) return { type: "section_" + m.dataset.section, id: "section" };
    if ((m = g("[data-trail-vertex]"))) return { type: "trail_vertex", id: "main_trail", index: Number(m.dataset.trailVertex) };
    if ((m = g("[data-connector]"))) return { type: "connector", id: m.dataset.connector };
    if ((m = g("[data-space]"))) return { type: "space", id: m.dataset.space };
    if ((m = g("[data-house]"))) return { type: "house", id: m.dataset.house };
    if ((m = g("[data-tree]"))) return { type: "tree", id: m.dataset.tree };
    if ((m = g("[data-landmark]"))) return { type: "landmark", id: m.dataset.landmark };
    if ((m = g("[data-spawn]"))) return { type: "spawn", id: m.dataset.spawn };
    if ((m = g("[data-region]"))) return { type: "region", id: m.dataset.region };
    if ((m = g("[data-path]"))) return { type: "path", id: m.dataset.path };
    if ((m = g("[data-terrace]"))) return { type: "terrace", id: m.dataset.terrace };
    return { type: "ground", id: null };
  };
  /** 小符号难点中：没直接点中可拖的东西时，就近 14 px 内找一个（剖切把手 > 折点 > 连接点 > 地标 / 入口） */
  const nearest = (p) => {
    let ppm = 1; try { ppm = Math.abs(svg.getScreenCTM().a) || 1; } catch { /* 没布局 */ }
    const R = Math.max(2, 14 / ppm), rank = (n) => (n.dataset.section ? 0 : n.dataset.trailVertex !== undefined ? 1 : n.dataset.connector ? 2 : 3);
    let best = null, bd = Infinity;
    for (const n of svg.querySelectorAll("[data-pos]")) {
      if (n.closest("[data-inactive]") || n.dataset.house) continue;
      const c = parsePos(n); if (!c) continue;
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]) + rank(n) * 0.01;
      if (d <= R && d < bd) { bd = d; best = n; }
    }
    return best ? targetOf(best) : null;
  };
  const resolveTarget = (ev, p) => {
    const t = targetOf(ev.target);
    if (DRAG_TYPES.has(t.type)) return t;
    return nearest(p) || t;
  };
  const canDrag = (t) => {
    if (!DRAG_TYPES.has(t.type)) return false;
    if (H.canDrag) return !!H.canDrag(t);
    return (t.type === "landmark" || t.type === "spawn") && (!H.canPin || !!H.canPin(t.type));
  };

  // ---------- 拖动预览（只改 DOM，结束 / 取消时还原或交给回调重建）
  const nodesFor = (t) => {
    const key = t.type === "trail_vertex" ? `trail_vertex:${t.index}` : `${t.type}:${t.id}`;
    const main = t.type === "house" ? q(`[data-house="${esc(t.id)}"]`) : t.type === "landmark" ? q(`[data-landmark="${esc(t.id)}"]`) : t.type === "spawn" ? q(`[data-spawn="${esc(t.id)}"]`)
      : t.type === "connector" ? q(`[data-connector="${esc(t.id)}"]`) : t.type === "space" ? q(`polygon[data-space="${esc(t.id)}"]`) : null;
    return [main, ...svg.querySelectorAll(`[data-for="${esc(key)}"]`)].filter(Boolean);
  };
  const origPos = (t) => {
    if (t.type === "trail_vertex") { const n = q(`[data-trail-vertex="${t.index}"]`); return n ? parsePos(n) : null; }
    const n = nodesFor(t)[0];
    if (n && n.getAttribute("data-pos")) return parsePos(n);
    if (t.type === "landmark") { const v = landmarkOf(sid); return v ? [v.position[0], v.position[2]] : null; }
    if (t.type === "spawn") { const m = spawnOf(sid); return m ? [m.position[0], m.position[2]] : null; }
    return null;
  };
  const sectionLine = () => {
    const a = q('[data-section="a"]'), b = q('[data-section="b"]');
    return a && b ? [parsePos(a), parsePos(b)] : null;
  };
  const u = () => { const b = sid.bounds; return Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 120; };
  const saved = [];
  const setAttr = (n, k, v) => { if (!n) return; saved.push([n, k, n.getAttribute(k)]); n.setAttribute(k, v); };
  const restoreAll = () => { for (let i = saved.length - 1; i >= 0; i--) { const [n, k, v] = saved[i]; if (v == null) n.removeAttribute(k); else n.setAttribute(k, v); } saved.length = 0; };
  const translateNodes = (nodes, dx, dz) => { for (const n of nodes) { if (!n.__orig) n.__orig = n.getAttribute("transform") || ""; n.setAttribute("transform", `translate(${fmt1(dx)} ${fmt1(dz)}) ${n.__orig}`); } };
  const untranslate = (nodes) => { for (const n of nodes) if (n.__orig != null) { if (n.__orig) n.setAttribute("transform", n.__orig); else n.removeAttribute("transform"); delete n.__orig; } };
  const b = sid.bounds, inB = (p) => [clamp(p[0], b.min[0], b.max[0]), clamp(p[1], b.min[2], b.max[2])];
  /** 剖切线 DOM 预览 */
  const showSection = (line) => {
    for (const sel of [".sec-band", ".sec-line"]) { const n = q(sel); if (n) setAttr(n, "points", pts(line)); }
    const [a, bb] = line, m = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2], U = u();
    const A = q('[data-section="a"]'), B = q('[data-section="b"]'), M = q('[data-section="mid"]');
    if (A) { setAttr(A, "cx", fmt1(a[0])); setAttr(A, "cy", fmt1(a[1])); }
    if (B) { setAttr(B, "cx", fmt1(bb[0])); setAttr(B, "cy", fmt1(bb[1])); }
    if (M) setAttr(M, "transform", `translate(${fmt1(m[0])} ${fmt1(m[1])}) rotate(45)`);
    for (const [w, p0, o] of [["a", a, bb], ["b", bb, a]]) { const t = q(`[data-section-label="${w}"]`); if (t) { const lp = sectionLabelPos(p0, o, U); setAttr(t, "x", fmt1(lp[0])); setAttr(t, "y", fmt1(lp[1])); } }
  };
  /** 按当前指针算拖动结果并更新预览；返回 {p, info} */
  const preview = (d, p, ev) => {
    const t = d.target, dx = p[0] - d.start[0], dz = p[1] - d.start[1];
    const info = { delta: [r2(dx), r2(dz)] };
    if (t.type === "trail_vertex") {
      const pos = inB([d.orig[0] + dx, d.orig[1] + dz]); info.pos = [r2(pos[0]), r2(pos[1])]; info.index = t.index;
      const line = q('[data-path="main_trail"]');
      if (line && d.trailPts) { const arr = d.trailPts.slice(); arr[t.index] = pos; setAttr(line, "points", pts(arr)); }
      const h = q(`[data-trail-vertex="${t.index}"]`); if (h) { setAttr(h, "cx", fmt1(pos[0])); setAttr(h, "cy", fmt1(pos[1])); }
      for (const n of svg.querySelectorAll(".trail-steps, .trail-label")) setAttr(n, "visibility", "hidden");
      translateNodes(d.extra, dx, dz);
      return { p: info.pos, info };
    }
    if (t.type.startsWith("section_")) {
      let [a, bb] = d.line.map((x) => x.slice());
      if (t.type === "section_mid") { a = [a[0] + dx, a[1] + dz]; bb = [bb[0] + dx, bb[1] + dz]; }
      else {
        const fixed = t.type === "section_a" ? bb : a, moving = t.type === "section_a" ? a : bb;
        const np = inB([moving[0] + dx, moving[1] + dz]);
        const s = snapAngle(fixed, np, ev && ev.altKey ? 0 : 15);
        const end = s.length_m < 4 ? np : inB(s.to);
        if (t.type === "section_a") a = end; else bb = end;
      }
      const line = [a, bb].map((x) => [r2(x[0]), r2(x[1])]);
      const s = snapAngle(line[0], line[1], 0);
      Object.assign(info, { line, angle_deg: s.angle_deg, length_m: s.length_m });
      showSection(line);
      return { p: t.type === "section_mid" ? [r2((line[0][0] + line[1][0]) / 2), r2((line[0][1] + line[1][1]) / 2)] : t.type === "section_a" ? line[0] : line[1], info };
    }
    translateNodes(d.nodes, dx, dz);
    if (t.type === "space") return { p: [r2(p[0]), r2(p[1])], info };
    const pos = d.orig ? inB([d.orig[0] + dx, d.orig[1] + dz]) : p;
    info.pos = [r2(pos[0]), r2(pos[1])];
    return { p: info.pos, info };
  };
  const endDrag = (cancel) => { const d = drag; drag = null; if (!d) return null; untranslate(d.nodes || []); untranslate(d.extra || []); restoreAll(); return cancel ? null : d; };
  // 进行中的手势：开始 / 结束通知；Esc 取消（DOM 回原位、不提交、不入撤销栈），并且不再冒泡给全局快捷键
  let active = false;
  const gesture = (on) => { if (on === active) return; active = on; if (H.onGesture) H.onGesture(on); if (on) window.addEventListener("keydown", onEsc, true); else window.removeEventListener("keydown", onEsc, true); };
  const cancelAll = () => {
    const moved = !!(drag && drag.moved);
    drawing = null; if (live) live.remove(); live = null;
    endDrag(true); gesture(false);
    if (moved && H.onDragCancel) H.onDragCancel();
  };
  function onEsc(ev) { if (ev.key !== "Escape" || (!drawing && !drag)) return; ev.preventDefault(); ev.stopPropagation(); cancelAll(); }

  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button > 0) return;
    const p = svgPoint(svg, ev, sid);
    const n = ev.target, tool = toolNow();
    if (n.dataset && n.dataset.diff !== undefined) return H.onDiff && H.onDiff(n.dataset.diff, ev);
    if (n.dataset && n.dataset.pathLabel) return H.onFlip && H.onFlip("path", "main_trail", ev);
    if (n.dataset && n.dataset.regionLabel !== undefined) return H.onFlip && H.onFlip("region", n.dataset.regionLabel, ev);
    try { svg.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    if (tool === "path" || tool === "region") {
      drawing = { pts: [p], tool };
      live = svgel("polyline", { points: pts([p]), fill: tool === "region" ? "rgba(31,111,235,.12)" : "none", stroke: "#1f6feb", "stroke-width": 1, "stroke-dasharray": "1.5 1", "pointer-events": "none" });
      svg.append(live); gesture(true);
    } else if (tool === "section") {
      drawing = { pts: [p, p], tool, info: null };
      live = svgel("line", { x1: fmt1(p[0]), y1: fmt1(p[1]), x2: fmt1(p[0]), y2: fmt1(p[1]), stroke: "#7a4fc9", "stroke-width": 0.6, "stroke-dasharray": "2 1", "pointer-events": "none" });
      svg.append(live); gesture(true);
    } else if (tool === "erase") {
      H.onErase && H.onErase(resolveTarget(ev, p), p);
    } else {
      const t = resolveTarget(ev, p);
      const d = { target: t, start: p, client: [ev.clientX, ev.clientY], moved: false, can: canDrag(t), nodes: [], extra: [] };
      if (d.can) {
        if (t.type.startsWith("section_")) d.line = sectionLine();
        else if (t.type === "trail_vertex") { const line = q('[data-path="main_trail"]'); d.trailPts = line ? line.getAttribute("points").trim().split(/\s+/).map((s) => s.split(",").map(Number)) : null; d.orig = origPos(t); d.extra = [...svg.querySelectorAll(`[data-for="trail_vertex:${t.index}"]`)]; }
        else { d.nodes = nodesFor(t); d.orig = origPos(t); }
        if (t.type.startsWith("section_") && !d.line) d.can = false;
      }
      drag = d;
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (drawing && live) {
      const p = svgPoint(svg, ev, sid);
      if (drawing.tool === "section") {
        const s = snapAngle(drawing.pts[0], p, ev.altKey ? 0 : 15), end = s.length_m < 1 ? p : [clamp(s.to[0], sid.bounds.min[0], sid.bounds.max[0]), clamp(s.to[1], sid.bounds.min[2], sid.bounds.max[2])];
        drawing.pts[1] = end; drawing.info = { angle_deg: s.angle_deg, length_m: s.length_m };
        live.setAttribute("x2", fmt1(end[0])); live.setAttribute("y2", fmt1(end[1]));
        return;
      }
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1) { drawing.pts.push(p); live.setAttribute("points", pts(drawing.pts)); }
      return;
    }
    if (!drag || !drag.can) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.client[0], ev.clientY - drag.client[1]) < 3) return;
    if (!drag.moved) gesture(true);
    drag.moved = true;
    const r = preview(drag, svgPoint(svg, ev, sid), ev);
    drag.last = r;
    H.onDrag && H.onDrag(drag.target, r.p, r.info);
  });
  const finish = (ev) => {
    gesture(false);
    if (drawing) {
      const d = drawing; drawing = null; if (live) live.remove(); live = null;
      if (d.tool === "section") {
        const [a, b2] = d.pts;
        if (Math.hypot(b2[0] - a[0], b2[1] - a[1]) >= 4) H.onSection && H.onSection([a, b2].map((x) => [r2(x[0]), r2(x[1])]), d.info || snapAngle(a, b2, 0));
        return;
      }
      if (d.pts.length < 3) return;
      if (d.tool === "path") H.onPath && H.onPath(d.pts, ev); else H.onRegion && H.onRegion(d.pts, ev);
      return;
    }
    if (!drag) return;
    const d = drag;
    if (d.moved && d.can) {
      const r = preview(d, svgPoint(svg, ev, sid), ev);
      endDrag(false);
      if (H.onDragEnd) H.onDragEnd(d.target, r.p, r.info);
      else if ((d.target.type === "landmark" || d.target.type === "spawn") && H.onPinEnd) H.onPinEnd(d.target.type, r.p);
      return;
    }
    endDrag(false);
    H.onSelect && H.onSelect(d.target, svgPoint(svg, ev, sid), ev);
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", cancelAll);
}
