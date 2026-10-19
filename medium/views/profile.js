// views/profile.js — 剖面（D19）：沿主路或一条直线、带宽度。数据全部来自 engine/section.js 的 sampleSection。
// 画：地面线、台地平台段（可拖）、带内体块投影、地下空间（地面下的暗色块）、空中空间（板）、连接点、每层高把手、地标顶边把手。
// 层号与俯视图统一：第 1 层 = 入口地面，第 k+1 层 = k × 每层高。纵向有夸张，标注一律写真实米数。
// 拖动只改 DOM 并调 onDragHint / onDragLive（节流 120 ms，给 3D 预览）；松手才调对应回调（app 重算后整张重画）。本文件不调 AI。
import { svgel, spawnOf } from "./map.js";
import { sampleSection, projectToPath, SECTION_WIDTH } from "../engine/section.js";
import { SPACE_LABEL, VIA_LABEL, STRATUM_LABEL } from "../engine/strata.js";

const fmt1 = (v) => Math.round(v * 10) / 10;
const snap = (v) => Math.round(v * 2) / 2;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v);
/** 坡度三档（设计 §4「拉」）：每层台地高度（米），取生成器常出的值 */
export const SLOPE_STEPS = [[3, "缓"], [4, "中"], [5, "陡"]];
/** 每层高的可调范围（与 terrain.js 的夹取一致） */
export const LAYER_RANGE = [2.5, 6];
/**
 * 坡度档位的显示规则（参数面板「每层高」与剖面坡度 chips 共用）：按区间高亮一档（≤ 3.4 缓，≤ 4.4 中，再高陡），
 * 永远有一档亮着，人一眼知道自己在哪；确切米数在按钮的悬停提示里。亮着的那档不是整米数时（如 4.3 m），点它回到整档（act）。
 * @returns {{ items: [{v, l, on, act, title}] }}
 */
export function slopeChoices(layer) {
  const cur = Number(layer), k = !Number.isFinite(cur) ? -1 : cur <= 3.4 ? 0 : cur <= 4.4 ? 1 : 2;
  return { items: SLOPE_STEPS.map(([v, l], i) => {
    const on = i === k, off = on && Math.abs(v - cur) > 1e-6; // 亮着但不是整档：点一下回到整档
    return { v, l, on, act: !on || off, title: off ? `现在每层 ${fmt1(cur)} m，点一下回到 ${v} m` : `每层 ${v} m` };
  }) };
}

/** 坡度（Δh/Δd）→ 「31°（59%）」 */
export function slopeLabel(s) { const v = Number(s) || 0; return `${Math.round((Math.atan(v) * 180) / Math.PI)}°（${Math.round(v * 100)}%）`; }
/** 地下空间在地面下几层（优先用生成时的 depth_layers；人调过高度后按地面反推） */
function spaceLayers(sp, full, T, layer) {
  const key = sp.stratum === "underground" ? "depth_layers" : "height_layers";
  if (full && !full.user_height && Number(full[key]) > 0) return full[key];
  if (!full || !full.polygon || !T) return null;
  const xs = full.polygon.map((p) => p[0]), zs = full.polygon.map((p) => p[1]);
  const g = T.heightAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2);
  const n = sp.stratum === "underground" ? (g - sp.floor_y - sp.height) / layer : (sp.floor_y - g) / layer;
  return Math.max(1, Math.round(n));
}
/** 空间的标注：「−2 层 · 净高 6 m」/「+3 层 · 上方 4 m」 */
export function spaceText(sp, n) {
  const lv = n ? `${sp.stratum === "underground" ? "−" : "+"}${n} 层 · ` : "";
  return sp.stratum === "underground" ? `${lv}净高 ${fmt1(sp.height)} m` : `${lv}上方 ${fmt1(sp.height)} m`;
}

/**
 * 画剖面。
 * @param {object} ctx { sid, T, facts?, section?（sampleSection 结果，省略时自己算）, stratum?: "ground"|"underground"|"sky" }
 * @param {object} opts 回调都可选，传了才出现对应的把手 / 控件：
 *   onTerraceHeight(id, h|null)  null = 恢复规则高度
 *   onLayerHeight(h) / onLandmarkHeight(h) / onSpaceFloor(id, y) / onSpaceHeight(id, h)
 *   onDragHint(text|null)  拖动中给提示条文案，松手给 null
 *   onDragLive({kind, id, value}|null)  拖动中节流 120 ms（kind ∈ terrace | layer | landmark | space_floor | space_height）；放弃时 null
 *   onSectionWidthLive(w|null)  宽度滑块拖动中（只给预览，不提交）
 *   onPick({type, id}, stratum?)  点一下平台段 / 空间 / 地标（没拖动）
 *   onSectionMode("trail"|"line") / onSectionWidth(w) / onSectionRotate(deg) / onSectionTool() / onSlope(layer_m)
 * @returns {{ node: HTMLElement, stats: object, scale: { sx, sy, hy } }}
 */
export function renderProfile(ctx, opts = {}) {
  const { sid, T } = ctx;
  const S = ctx.section || sampleSection(sid, T);
  const cfg = (sid.meta && sid.meta.section) || { mode: "trail" };
  const mode = cfg.mode === "line" ? "line" : "trail";
  const stratum = ctx.stratum || "ground";
  const layer = (sid.meta && sid.meta.layer_height_m) || 3;
  const total = Math.max(1, S.length_m || (S.ground.length ? S.ground[S.ground.length - 1].d : 1));
  const hint = (t) => { if (typeof opts.onDragHint === "function") opts.onDragHint(t); };
  const live = typeof opts.onDragLive === "function" ? opts.onDragLive : null;
  const pick = typeof opts.onPick === "function" ? opts.onPick : null; // 点一下（没拖）= 选中它

  // 纵向范围：地下空间 / 连接点下端到最高的体块 / 空中空间顶；上方留 18% 给往上拖
  const hs = S.ground.map((g) => g.h);
  let lo = Math.min(0, ...hs), hi = Math.max(layer, ...hs);
  for (const v of S.volumes) hi = Math.max(hi, v.y1);
  for (const sp of S.spaces) { if (sp.stratum === "underground") lo = Math.min(lo, sp.floor_y); else hi = Math.max(hi, sp.floor_y + sp.height); }
  for (const c of S.connectors) { lo = Math.min(lo, c.bottom_y); hi = Math.max(hi, c.top_y); }
  hi += (hi - lo) * 0.18; if (lo < 0) lo -= 1.5;

  const Wv = 320, Hv = 150, mL = 38, mR = 22, mT = 14, mB = 18;
  const pad = 4; // 两端留白：端点上的连接点 / 地标不压右侧米数
  const sx = (d) => mL + pad + (d / total) * (Wv - mL - mR - 2 * pad);
  const sy = (h) => Hv - mB - ((h - lo) / (hi - lo)) * (Hv - mT - mB);
  const hy = (y) => lo + ((Hv - mB - y) / (Hv - mT - mB)) * (hi - lo);
  const pxPerM = (Hv - mT - mB) / (hi - lo);
  const s = svgel("svg", { viewBox: `0 0 ${Wv} ${Hv}`, class: "profile", style: "touch-action:none" });
  s.append(svgel("rect", { width: Wv, height: Hv, fill: "#fbfaf6" }));
  const drag = makeDrag(s, hint, live);
  const fade = (st) => (stratum !== "ground" && st !== stratum ? 0.35 : 1);

  // 层线与层号（右侧真实米数）；地面以下只标米数
  const nT = Math.max(2, ((T.terraces || []).reduce((m, t) => Math.max(m, t.level), 0)) + 1);
  const layerLines = [];
  for (let k = 0; k < nT; k++) {
    const y = sy(k * layer);
    if (y < mT) break;
    const ln = svgel("line", { x1: mL, x2: Wv - mR, y1: y, y2: y, stroke: k === 0 ? "#a9b48f" : "#c9d2b6", "stroke-width": k === 0 ? 0.7 : 0.5, "stroke-dasharray": k === 0 ? null : "2 2" });
    const tl = svgel("text", { x: mL - 3, y: y + 2, "font-size": 5.5, "text-anchor": "end", fill: "#6b7a4b" }, `${k + 1} 层`);
    const tr = svgel("text", { x: Wv - mR + 2, y: y + 2, "font-size": 5, fill: "#999" }, `${k * layer ? "+" : ""}${fmt1(k * layer)} m`);
    s.append(ln, tl, tr);
    layerLines.push({ k, ln, tl, tr });
  }
  for (let h = -layer; h >= lo; h -= layer) s.append(svgel("text", { x: Wv - mR + 2, y: sy(h) + 2, "font-size": 5, fill: "#999" }, `${fmt1(h)} m`));
  if (lo < 0) s.append(svgel("text", { x: mL - 3, y: sy(lo / 2) + 2, "font-size": 5.5, "text-anchor": "end", fill: "#7a6a55" }, "地下"));

  // 地面：地面线以下填土色（地下层时淡一点，空间才显出来）
  if (S.ground.length > 1) {
    let d = `M${sx(S.ground[0].d)} ${sy(lo)}`;
    for (const g of S.ground) d += ` L${fmt1(sx(g.d))} ${fmt1(sy(g.h))}`;
    d += ` L${fmt1(sx(S.ground[S.ground.length - 1].d))} ${sy(lo)} Z`;
    s.append(svgel("path", { d, fill: "#e4dcc8", opacity: stratum === "underground" ? 0.55 : 0.9 }));
    for (let i = 1; i < S.ground.length; i++) {
      const a = S.ground[i - 1], b = S.ground[i];
      const slope = Math.abs(b.h - a.h) / Math.max(0.01, b.d - a.d);
      const col = mode === "trail" ? (slope > 0.7 ? "#c0392b" : slope > 0.45 ? "#d98a1a" : "#8b7d5b") : "#8b7d5b";
      s.append(svgel("line", { x1: fmt1(sx(a.d)), y1: fmt1(sy(a.h)), x2: fmt1(sx(b.d)), y2: fmt1(sy(b.h)), stroke: col, "stroke-width": mode === "trail" ? 2 : 1.2, "stroke-linecap": "round" }));
    }
  }
  // 距离刻度
  const step = total > 160 ? 40 : 20;
  for (let d = 0; d <= total; d += step) { s.append(svgel("line", { x1: sx(d), x2: sx(d), y1: Hv - mB, y2: Hv - mB + 3, stroke: "#999", "stroke-width": 0.5 })); s.append(svgel("text", { x: sx(d), y: Hv - mB + 9, "font-size": 5, "text-anchor": "middle", fill: "#777" }, `${Math.round(d)} m`)); }
  // 与剖切线相交的路 / 溪
  for (const p of S.paths) {
    const g = nearestGround(S.ground, p.d); if (!g) continue;
    s.append(svgel("circle", { cx: fmt1(sx(p.d)), cy: fmt1(sy(g.h)), r: 1.6, fill: p.kind === "river" ? "#4f86c6" : "#8b7d5b", stroke: "#fff", "stroke-width": 0.4 }, svgel("title", {}, p.kind === "river" ? "溪" : "路")));
  }

  // 带内体块（房子 / 树），地标单独画在后面
  for (const v of S.volumes) {
    if (v.importance === "landmark") continue;
    const x0 = sx(v.d0), x1 = Math.max(x0 + 1, sx(v.d1));
    const tree = v.kind === "prop";
    s.append(svgel(tree ? "ellipse" : "rect", tree ? { cx: (x0 + x1) / 2, cy: (sy(v.y0) + sy(v.y1)) / 2, rx: (x1 - x0) / 2, ry: Math.max(0.8, (sy(v.y0) - sy(v.y1)) / 2), fill: "#7d9a5f", opacity: 0.55 } : { x: x0, y: sy(v.y1), width: x1 - x0, height: Math.max(1, sy(v.y0) - sy(v.y1)), fill: "#d9c9a3", stroke: "#8a7a5a", "stroke-width": 0.4, opacity: 0.85 }));
  }

  // 台地平台段：上下拖 = 只改这一层高度
  const segs = new Map();
  for (const t of S.terraces) {
    const y = sy(t.height), x0 = sx(t.d0), x1 = sx(t.d1);
    const vis = svgel("line", { x1: x0, x2: x1, y1: y, y2: y, stroke: t.user_height ? "#b8452b" : "#6b7a4b", "stroke-width": 1.6, "stroke-linecap": "round", "pointer-events": "none" });
    const hit = svgel("rect", { x: x0, y: y - 3.5, width: Math.max(2, x1 - x0), height: 7, fill: "transparent", class: "h-terrace", "data-id": t.id, style: opts.onTerraceHeight ? "cursor:ns-resize" : null }, svgel("title", {}, `${t.level + 1} 层 · +${fmt1(t.height)} m${opts.onTerraceHeight ? "（上下拖）" : ""}`));
    s.append(vis, hit);
    if (!segs.has(t.id)) segs.set(t.id, []);
    segs.get(t.id).push({ vis, hit, t });
  }
  for (const [id, list] of segs) {
    const t = list[0].t;
    if (t.user_height) {
      const mid = list.reduce((a, b) => (b.t.d1 - b.t.d0 > a.t.d1 - a.t.d0 ? b : a));
      const tag = svgel("text", { x: fmt1((sx(mid.t.d0) + sx(mid.t.d1)) / 2), y: fmt1(sy(t.height) - 3), "font-size": 5, "text-anchor": "middle", fill: "#b8452b", class: "h-reset", "data-id": id, style: opts.onTerraceHeight ? "cursor:pointer" : null }, opts.onTerraceHeight ? "已单独调 · 恢复" : "已单独调");
      if (opts.onTerraceHeight) tag.addEventListener("click", (e) => { e.stopPropagation(); opts.onTerraceHeight(id, null); });
      s.append(tag);
    }
    if (typeof opts.onTerraceHeight !== "function") continue;
    for (const { hit } of list) drag(hit, {
      move: (dy) => { const h = clampN(snap(t.height - dy / pxPerM), -20, 80); for (const q of list) { q.vis.setAttribute("y1", sy(h)); q.vis.setAttribute("y2", sy(h)); q.hit.setAttribute("y", sy(h) - 3.5); } return { h, text: `第 ${t.level + 1} 层：${sgn(h)} m` }; },
      live: (r) => ({ kind: "terrace", id, value: r.h }),
      click: pick && (() => pick({ type: "terrace", id })),
      end: (r) => { if (r.h !== t.height) opts.onTerraceHeight(id, r.h); },
    });
  }

  // 地下 / 空中空间
  const byId = new Map((sid.spaces || []).map((x) => [x.id, x]));
  for (const sp of S.spaces) {
    const full = byId.get(sp.id), n = spaceLayers(sp, full, T, layer);
    const x0 = sx(sp.d0), x1 = Math.max(x0 + 2, sx(sp.d1)), name = sp.label || STRATUM_LABEL[sp.stratum] + SPACE_LABEL[sp.kind];
    const g = svgel("g", { class: "space", "data-id": sp.id, opacity: fade(sp.stratum) });
    const under = sp.stratum === "underground";
    // 地下：底面 floor_y 到顶板 floor_y + height 的暗色块；空中：板（floor_y 往下 1 m）+ 上方可用高度的虚线框
    const body = under
      ? svgel("rect", { x: x0, y: sy(sp.floor_y + sp.height), width: x1 - x0, height: Math.max(1.5, sy(sp.floor_y) - sy(sp.floor_y + sp.height)), fill: "#3b3a45", opacity: 0.85, rx: 1 })
      : svgel("rect", { x: x0, y: sy(sp.floor_y), width: x1 - x0, height: Math.max(1.5, sy(sp.floor_y - 1) - sy(sp.floor_y)), fill: "#8a7f6e", stroke: "#4d4539", "stroke-width": 0.4 });
    const room = under ? null : svgel("rect", { x: x0, y: sy(sp.floor_y + sp.height), width: x1 - x0, height: Math.max(1, sy(sp.floor_y) - sy(sp.floor_y + sp.height)), fill: "#8a7f6e", "fill-opacity": 0.08, stroke: "#8a7f6e", "stroke-width": 0.4, "stroke-dasharray": "2 1.5" });
    const topY = sy(sp.floor_y + sp.height);
    const topEdge = svgel("rect", { x: x0, y: topY - 2.5, width: x1 - x0, height: 5, fill: "transparent", class: "h-space-top", "data-id": sp.id, style: opts.onSpaceHeight ? "cursor:ns-resize" : null }, svgel("title", {}, `${name} · 上边：${under ? "净高" : "上方高度"}（上下拖）`));
    // 标注放块里；块太窄就放到块外侧（靠右的块放左边），不越出图
    const long = `${name} ${spaceText(sp, n)}`, room0 = x1 - x0 - 2, right = (x0 + x1) / 2 > Wv / 2;
    const label = textWidth(long, 5) <= room0 || textWidth(spaceText(sp, n), 5) > room0 ? long : spaceText(sp, n), fits = textWidth(label, 5) <= room0;
    const t1 = svgel("text", { x: fits ? (x0 + x1) / 2 : right ? x0 - 2 : x1 + 2, y: fmt1(under && !fits ? (sy(sp.floor_y) + topY) / 2 + 2 : sy(sp.floor_y) - 2.5), "font-size": 5, "text-anchor": fits ? "middle" : right ? "end" : "start", fill: under && fits ? "#fff" : under ? "#3b3a45" : "#4d4539", "pointer-events": "none" }, label);
    if (room) g.append(room);
    g.append(body, t1, topEdge);
    body.setAttribute("class", "h-space"); body.setAttribute("data-id", sp.id);
    if (opts.onSpaceFloor) body.setAttribute("style", "cursor:move");
    body.append(svgel("title", {}, `${name} · 底面 ${fmt1(sp.floor_y)} m（上下拖）`));
    s.append(g);
    const parts = [body, room, t1, topEdge].filter(Boolean);
    const y0s = parts.map((p) => Number(p.getAttribute("y")));
    if (typeof opts.onSpaceFloor === "function") drag(body, {
      move: (dy) => { const f = snap(sp.floor_y - dy / pxPerM), shift = (f - sp.floor_y) * pxPerM; parts.forEach((p, i) => p.setAttribute("y", fmt1(y0s[i] - shift))); return { f, text: `${name} 底面 ${sgn(f)} m` }; },
      live: (r) => ({ kind: "space_floor", id: sp.id, value: r.f }),
      click: pick && (() => pick({ type: "space", id: sp.id }, sp.stratum)),
      end: (r) => { if (r.f !== sp.floor_y) opts.onSpaceFloor(sp.id, r.f); },
    });
    if (typeof opts.onSpaceHeight === "function") drag(topEdge, {
      move: (dy) => {
        const h = clampN(snap(sp.height - dy / pxPerM), 2, 40), ty = sy(sp.floor_y + h);
        topEdge.setAttribute("y", ty - 2.5);
        const box = under ? body : room; box.setAttribute("y", ty); box.setAttribute("height", Math.max(1, sy(sp.floor_y) - ty));
        return { h, text: `${name} ${under ? "净高" : "上方"} ${h} m` };
      },
      live: (r) => ({ kind: "space_height", id: sp.id, value: r.h }),
      end: (r) => { if (r.h !== sp.height) opts.onSpaceHeight(sp.id, r.h); },
    });
  }

  // 连接点：竖线 + 方式符号
  for (const c of S.connectors) {
    const m = (sid.markers || []).find((x) => x.id === c.id);
    const st = m && m.to !== "ground" && byId.get(m.to) ? byId.get(m.to).stratum : m && byId.get(m.from) ? byId.get(m.from).stratum : "ground";
    const g = drawConnector(c, sx(c.d), sy(c.bottom_y), sy(c.top_y));
    g.setAttribute("opacity", fade(st));
    g.append(svgel("title", {}, `${(m && m.label) || VIA_LABEL[c.via] || "连接点"} · ${fmt1(c.bottom_y)} → ${fmt1(c.top_y)} m`));
    s.append(g);
  }

  // 入口小人（1.7 m）：入口投到剖切线、在带内才画
  const sp0 = spawnOf(sid);
  let eye = null;
  if (sp0 && S.path && S.path.length > 1) {
    const pr = projectToPath(S.path, [sp0.position[0], sp0.position[2]]);
    if (pr.off <= S.width_m / 2 + 2) {
      const g = nearestGround(S.ground, pr.d), h = g ? g.h : 0;
      const x0 = sx(pr.d), y0 = sy(h), yh = sy(h + 1.7);
      eye = { x: x0, y: yh };
      s.append(svgel("line", { x1: x0, x2: x0, y1: y0, y2: yh + 2, stroke: "#1f6feb", "stroke-width": 1.4 }), svgel("circle", { cx: x0, cy: yh + 1, r: 1.6, fill: "#1f6feb" }));
      s.append(svgel("text", { x: x0 + 3, y: yh - 1, "font-size": 5.5, fill: "#1f6feb" }, "入口"));
    }
  }

  // 地标：顶边上下拖 = 地标高度
  const lmv = S.volumes.find((v) => v.importance === "landmark");
  if (lmv) {
    const x0 = sx(lmv.d0), x1 = Math.max(x0 + 5, sx(lmv.d1)), h0 = lmv.y1 - lmv.y0;
    const body = svgel("rect", { x: x0, y: sy(lmv.y1), width: x1 - x0, height: Math.max(2, sy(lmv.y0) - sy(lmv.y1)), fill: "#b8452b", stroke: "#4a1a10", "stroke-width": 0.5 });
    const lab = svgel("text", { x: (x0 + x1) / 2, y: sy(lmv.y1) - 3, "font-size": 5.5, "text-anchor": "middle", fill: "#4a1a10" }, `${lmv.label || "地标"} ${fmt1(h0)} m`);
    const top = svgel("rect", { x: x0 - 1, y: sy(lmv.y1) - 2.5, width: x1 - x0 + 2, height: 5, fill: "transparent", class: "h-landmark", style: opts.onLandmarkHeight ? "cursor:ns-resize" : null }, svgel("title", {}, "地标顶边（上下拖改高度）"));
    let sight = null;
    if (eye) { sight = svgel("line", { x1: eye.x, y1: eye.y, x2: (x0 + x1) / 2, y2: sy(lmv.y1), stroke: "#1f6feb", "stroke-width": 0.5, "stroke-dasharray": "1.5 1.5", opacity: 0.8, "pointer-events": "none" }); s.append(sight); }
    s.append(body, lab, top);
    if (typeof opts.onLandmarkHeight === "function") drag(top, {
      move: (dy) => {
        const h = clampN(snap(h0 - dy / pxPerM), 1, 60), ty = sy(lmv.y0 + h);
        body.setAttribute("y", ty); body.setAttribute("height", Math.max(2, sy(lmv.y0) - ty)); top.setAttribute("y", ty - 2.5); lab.setAttribute("y", ty - 3); lab.textContent = `${lmv.label || "地标"} ${h} m`;
        if (sight) sight.setAttribute("y2", ty);
        return { h, text: `地标高 ${h} m` };
      },
      live: (r) => ({ kind: "landmark", id: null, value: r.h }),
      click: pick && (() => pick({ type: "landmark", id: lmv.id })),
      end: (r) => { if (r.h !== h0) opts.onLandmarkHeight(r.h); },
    });
  }

  // 每层高把手：顶部左上角的「每层高 3 m ↕」，上下拖等比缩放所有层线
  const topK = layerLines.length ? layerLines[layerLines.length - 1].k : 1;
  const knobY = mT - 4;
  const knob = svgel("text", { x: 2, y: knobY, "font-size": 5.5, fill: "#6b7a4b", class: "h-layer", style: opts.onLayerHeight ? "cursor:ns-resize" : null }, `每层高 ${layer} m${opts.onLayerHeight ? " ↕" : ""} · 纵向有夸张`);
  s.append(knob);
  if (typeof opts.onLayerHeight === "function") {
    const hitK = svgel("rect", { x: 0, y: 0, width: 70, height: mT, fill: "transparent", class: "h-layer-hit", style: "cursor:ns-resize" }, svgel("title", {}, "上下拖改每层高（等于坡度）"));
    s.append(hitK);
    drag(hitK, {
      move: (dy) => {
        const h = clampN(snap(layer - dy / pxPerM / Math.max(1, topK)), LAYER_RANGE[0], LAYER_RANGE[1]);
        for (const L of layerLines) { const y = sy(L.k * h); L.ln.setAttribute("y1", y); L.ln.setAttribute("y2", y); L.tl.setAttribute("y", y + 2); L.tr.setAttribute("y", y + 2); L.tr.textContent = `${L.k ? "+" : ""}${fmt1(L.k * h)} m`; }
        knob.textContent = `每层高 ${h} m ↕ · 纵向有夸张`;
        const on = slopeChoices(h).items.find((x) => x.on);
        return { h, text: `每层高 ${h} m${on ? `（${on.l}）` : ""}` };
      },
      live: (r) => ({ kind: "layer", id: null, value: r.h }),
      end: (r) => { if (r.h !== layer) opts.onLayerHeight(r.h); },
    });
  }

  // ---------- 说明与控件
  const f = (ctx.facts && ctx.facts.trail) || {};
  const climb = mode === "trail" && f.climb_m != null ? f.climb_m : hs.length ? Math.max(...hs) - Math.min(...hs) : 0;
  const stats = { mode, width_m: S.width_m, length_m: Math.round(total), climb_m: Math.round(climb), max_slope: mode === "trail" ? f.max_slope : undefined, steps: mode === "trail" ? f.steps_estimate : undefined, folds: mode === "trail" ? f.folds : undefined, spaces: S.spaces.length, connectors: S.connectors.length };
  const cap = document.createElement("div");
  cap.className = "caption";
  if (mode === "trail") {
    const local = f.max_local_slope != null && f.max_slope != null && f.max_local_slope > f.max_slope + 0.05 ? f.max_local_slope : null;
    // 一行写完：沿主路 84 m · 爬升 16 m（1→5 层）· 最陡 31°（台阶处 40°）· 约 60 级 · 之字 3 折
    const bits = [`沿主路 ${stats.length_m} m`, `爬升 ${stats.climb_m} m（1→${Math.round(climb / layer) + 1} 层）`];
    if (f.max_slope != null) bits.push(`最陡 ${slopeLabel(f.max_slope)}${local != null ? `（台阶处 ${Math.round((Math.atan(local) * 180) / Math.PI)}°）` : ""}`);
    if (f.steps_estimate != null) bits.push(`约 ${Math.round(f.steps_estimate)} 级`);
    if (f.folds != null) bits.push(f.folds === 0 ? "直上" : `之字 ${f.folds} 折`);
    cap.append(span(bits.join(" · ")));
  } else cap.append(span(`直线剖切 ${stats.length_m} m · 高差 ${stats.climb_m} m`));
  if (S.spaces.length) cap.append(span(`切到 ${S.spaces.length} 个空间${S.connectors.length ? ` · ${S.connectors.length} 个连接点` : ""}`));
  if (Object.keys(opts).some((k) => k.startsWith("on") && k !== "onDragHint" && k !== "onDragLive")) cap.append(span("上下拖平台 / 顶边 / 空间改高度"));
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.append(s, cap);
  const row = controls(mode, S.width_m, layer, opts);
  if (row) wrap.append(row);
  return { node: wrap, stats, scale: { sx, sy, hy, pxPerM } };
}

/** 粗估文字宽（SVG 单位）：中文 ≈ 1 个字号，其它 ≈ 0.55 个字号 */
function textWidth(t, size) { let w = 0; for (const ch of t) w += ch.charCodeAt(0) > 0x2e80 ? size : size * 0.55; return w; }
function nearestGround(ground, d) { let best = null; for (const g of ground) if (!best || Math.abs(g.d - d) < Math.abs(best.d - d)) best = g; return best; }

/** 控件行（一行）：沿主路 | 直线、宽度滑块、↺ ↻、在图上拉、坡度 缓 / 中 / 陡 */
function controls(mode, width, layer, opts) {
  const row = document.createElement("div");
  row.className = "caption section-ctl";
  let any = false;
  if (typeof opts.onSectionMode === "function") { row.append(segButtons([["trail", "沿主路"], ["line", "直线"]], mode, opts.onSectionMode)); any = true; }
  if (typeof opts.onSectionWidth === "function") {
    const lab = span(`宽 ${width} m`);
    const r = Object.assign(document.createElement("input"), { type: "range", min: SECTION_WIDTH.min, max: SECTION_WIDTH.max, step: 1, value: width, className: "sec-width", title: "剖切宽度：带内的东西都投到剖面上" });
    // 拖滑块时只动俯视图 / 3D 上的带（不重算），松手才正式提交
    r.addEventListener("input", () => { lab.textContent = `宽 ${r.value} m`; if (typeof opts.onSectionWidthLive === "function") opts.onSectionWidthLive(Number(r.value)); });
    r.addEventListener("change", () => { const w = Number(r.value); if (w !== width) opts.onSectionWidth(w); else if (typeof opts.onSectionWidthLive === "function") opts.onSectionWidthLive(null); });
    const box = document.createElement("span"); box.className = "sec-wbox"; box.append(r, lab);
    row.append(box); any = true;
  }
  if (typeof opts.onSectionRotate === "function") { row.append(button("↺15°", () => opts.onSectionRotate(15), "sec-rot-l", "逆时针转 15°"), button("↻15°", () => opts.onSectionRotate(-15), "sec-rot-r", "顺时针转 15°")); any = true; }
  if (typeof opts.onSectionTool === "function") { row.append(button("在图上拉", () => opts.onSectionTool(), "sec-tool", "在俯视图上拉一条剖切线")); any = true; }
  if (typeof opts.onSlope === "function") { row.append(slopeChips(layer, opts.onSlope)); any = true; }
  return any ? row : null;
}

/** 坡度 chips（缓 / 中 / 陡）：规则见 slopeChoices（按区间高亮一档） */
function slopeChips(layer, onSlope) {
  const box = document.createElement("span");
  box.className = "slope-chips";
  const { items } = slopeChoices(layer);
  box.append(span("坡度"));
  const seg = document.createElement("span"); seg.className = "seg";
  for (const it of items) {
    const b = button(it.l, () => { if (it.act) onSlope(it.v); }, it.on ? "on" : "", it.title);
    seg.append(b);
  }
  box.append(seg);
  return box;
}

// ---------- 小部件
/**
 * 拖动：pointerdown 记起点，pointermove 只改 DOM（move 返回 { text, ... }，text 进 onDragHint），pointerup 才 end。
 * 给了 live(r) → {kind, id, value} 时，拖动中节流 120 ms 调 onDragLive（3D 预览）；Esc / pointercancel 放弃时 onDragLive(null)。
 * 没动过（< 0.8 单位）不算拖，算点一下（给了 click 就调）。
 */
const LIVE_MS = 120;
function makeDrag(svg, hint, onLive) {
  const svgY = (e) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()).y : e.clientY; };
  return (el, { move, end, live, click }) => el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const y0 = svgY(e);
    let last = null, tLive = 0, timer = null;
    const sendLive = () => { timer = null; tLive = performance.now(); if (last && onLive && live) onLive(live(last)); };
    const queueLive = () => { if (!onLive || !live || timer) return; const wait = LIVE_MS - (performance.now() - tLive); if (wait <= 0) sendLive(); else timer = setTimeout(sendLive, wait); };
    const off = () => { if (timer) clearTimeout(timer); timer = null; window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", esc, true); };
    const mv = (ev) => { const dy = svgY(ev) - y0; if (!last && Math.abs(dy) < 0.8) return; last = move(dy) || {}; hint(last.text || null); queueLive(); };
    const up = () => { off(); hint(null); if (last) end(last); else if (click) click(); };
    const cancel = () => { off(); hint(null); if (last && onLive) onLive(null); last = null; };
    const esc = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", esc, true);
  });
}

/** 连接点符号：竖线 + 按方式画（楼梯 = 折线，梯子 = 双轨加横档，井 / 竖井 = 窄框，升降台 = 框加箭头，其余 = 粗竖线） */
function drawConnector(c, x, yb, yt) {
  const g = svgel("g", { class: "connector", "data-id": c.id });
  const col = "#6b4f2a", top = Math.min(yb, yt), bot = Math.max(yb, yt), H = bot - top;
  if (c.via === "stairs" || c.via === "ramp") {
    if (c.via === "ramp") g.append(svgel("line", { x1: x - 2, y1: bot, x2: x + 2, y2: top, stroke: col, "stroke-width": 1.2 }));
    else { let d = `M${fmt1(x - 2)} ${fmt1(bot)}`; const n = Math.max(2, Math.round(H / 3)); for (let i = 1; i <= n; i++) { const y = bot - (H * i) / n; d += ` L${fmt1(i % 2 ? x + 2 : x - 2)} ${fmt1(y)}`; } g.append(svgel("path", { d, fill: "none", stroke: col, "stroke-width": 0.8 })); }
  } else if (c.via === "ladder") {
    g.append(svgel("line", { x1: x - 1.2, x2: x - 1.2, y1: top, y2: bot, stroke: col, "stroke-width": 0.5 }), svgel("line", { x1: x + 1.2, x2: x + 1.2, y1: top, y2: bot, stroke: col, "stroke-width": 0.5 }));
    for (let y = bot - 1.5; y > top; y -= 2) g.append(svgel("line", { x1: x - 1.2, x2: x + 1.2, y1: fmt1(y), y2: fmt1(y), stroke: col, "stroke-width": 0.4 }));
  } else if (c.via === "well" || c.via === "shaft" || c.via === "elevator") {
    const w = c.via === "shaft" ? 3.2 : 2.4;
    g.append(svgel("rect", { x: x - w / 2, y: top, width: w, height: Math.max(1, H), fill: c.via === "elevator" ? "none" : "#2c3e50", "fill-opacity": 0.25, stroke: col, "stroke-width": 0.5 }));
    if (c.via === "elevator") g.append(svgel("path", { d: `M${x} ${fmt1(top + 1)} l-1 2 h2 Z M${x} ${fmt1(bot - 1)} l-1 -2 h2 Z`, fill: col }));
  } else g.append(svgel("line", { x1: x, x2: x, y1: top, y2: bot, stroke: col, "stroke-width": 1.4, "stroke-dasharray": c.via === "rope_bridge" ? "1.5 1" : null }));
  g.append(svgel("circle", { cx: x, cy: top, r: 1, fill: col }), svgel("circle", { cx: x, cy: bot, r: 1, fill: col }));
  return g;
}

/** 分段按钮（当前一段高亮；点另一段才回调） */
function segButtons(items, cur, on) {
  const box = document.createElement("span");
  box.className = "seg pill-seg";
  for (const [v, l] of items) box.append(button(l, () => { if (v !== cur) on(v); }, "seg-" + v + (v === cur ? " on" : "")));
  return box;
}
function button(text, on, cls, title) { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (cls) b.className = cls; if (title) b.title = title; b.addEventListener("click", on); return b; }
function span(t) { const e = document.createElement("span"); e.textContent = t; return e; }
