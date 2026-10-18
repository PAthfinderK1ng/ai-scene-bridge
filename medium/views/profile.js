// views/profile.js — 侧剖面：沿主路（没有主路就沿南北中线）采样地形高度，画层带、路线坡度、入口与地标。
import { svgel, landmarkOf, spawnOf, mainTrailOf } from "./map.js";

const fmt1 = (v) => Math.round(v * 10) / 10;

/** @returns {{ node: HTMLElement, stats: object }} */
export function renderProfile(ctx) {
  const { sid, T } = ctx;
  const trail = mainTrailOf(sid);
  const lm = landmarkOf(sid), sp = spawnOf(sid);
  const line = trail && trail.points && trail.points.length > 1 ? trail.points : [[0, sid.bounds.max[2] - 4], [0, sid.bounds.min[2] + 4]];
  const prof = T.sampleProfile(line, 1);
  const layer = (sid.meta && sid.meta.layer_height_m) || 3;
  const total = prof.length ? prof[prof.length - 1].d : 1;
  const hmax = Math.max(layer, ...prof.map((p) => p.h), lm ? lm.position[1] + lm.size[1] : 0);

  const Wv = 320, Hv = 150, mL = 26, mR = 14, mT = 14, mB = 22;
  const sx = (d) => mL + (d / total) * (Wv - mL - mR);
  const sy = (h) => Hv - mB - (h / (hmax * 1.15)) * (Hv - mT - mB);
  const s = svgel("svg", { viewBox: `0 0 ${Wv} ${Hv}`, class: "profile" });
  s.append(svgel("rect", { width: Wv, height: Hv, fill: "#fbfaf6" }));

  // 层带与层号
  const levels = Math.round(hmax / layer);
  for (let k = 0; k <= levels; k++) {
    const y = sy(k * layer);
    if (y < mT) break;
    s.append(svgel("line", { x1: mL, x2: Wv - mR, y1: y, y2: y, stroke: "#c9d2b6", "stroke-width": 0.5, "stroke-dasharray": "2 2" }));
    s.append(svgel("text", { x: mL - 3, y: y + 2.5, "font-size": 6, "text-anchor": "end", fill: "#6b7a4b" }, k === 0 ? "地面" : `${k} 层`));
  }
  s.append(svgel("text", { x: mL - 3, y: mT - 3, "font-size": 5.5, "text-anchor": "end", fill: "#999" }, `1 层 = ${layer} m`));

  // 地形面
  if (prof.length > 1) {
    let d = `M${sx(0)} ${sy(0)}`;
    for (const p of prof) d += ` L${fmt1(sx(p.d))} ${fmt1(sy(p.h))}`;
    d += ` L${sx(total)} ${sy(0)} Z`;
    s.append(svgel("path", { d, fill: "#dfe6cf", stroke: "none" }));
    // 路线：按坡度分段上色（> 0.7 红、> 0.45 橙）
    for (let i = 1; i < prof.length; i++) {
      const a = prof[i - 1], b = prof[i];
      const slope = Math.abs(b.h - a.h) / Math.max(0.01, b.d - a.d);
      s.append(svgel("line", { x1: sx(a.d), y1: sy(a.h), x2: sx(b.d), y2: sy(b.h), stroke: slope > 0.7 ? "#c0392b" : slope > 0.45 ? "#d98a1a" : "#8b7d5b", "stroke-width": 2, "stroke-linecap": "round" }));
    }
  }
  // 距离刻度
  for (let d = 0; d <= total; d += 20) { s.append(svgel("line", { x1: sx(d), x2: sx(d), y1: Hv - mB, y2: Hv - mB + 3, stroke: "#999", "stroke-width": 0.5 })); s.append(svgel("text", { x: sx(d), y: Hv - mB + 10, "font-size": 5.5, "text-anchor": "middle", fill: "#777" }, `${Math.round(d)} m`)); }

  // 入口小人（1.7 m）与地标体块
  if (prof.length) {
    const p0 = prof[0];
    const x0 = sx(p0.d), y0 = sy(p0.h), yh = sy(p0.h + 1.7);
    s.append(svgel("line", { x1: x0, x2: x0, y1: y0, y2: yh + 2, stroke: "#1f6feb", "stroke-width": 1.4 }), svgel("circle", { cx: x0, cy: yh + 1, r: 1.6, fill: "#1f6feb" }));
    s.append(svgel("text", { x: x0 + 3, y: yh - 1, "font-size": 6, fill: "#1f6feb" }, sp ? "入口" : "起点"));
  }
  if (lm && prof.length) {
    const pe = prof[prof.length - 1];
    const w = Math.max(6, (lm.size[0] / total) * (Wv - mL - mR));
    const yb = sy(lm.position[1]), yt = sy(lm.position[1] + lm.size[1]);
    s.append(svgel("rect", { x: sx(pe.d) - w / 2, y: yt, width: w, height: Math.max(2, yb - yt), fill: "#b8452b", stroke: "#4a1a10", "stroke-width": 0.5 }));
    s.append(svgel("text", { x: sx(pe.d), y: yt - 2.5, "font-size": 6, "text-anchor": "middle", fill: "#4a1a10" }, lm.label || "地标"));
    // 从入口眼高到地标顶的视线
    const p0 = prof[0];
    s.append(svgel("line", { x1: sx(p0.d), y1: sy(p0.h + 1.7), x2: sx(pe.d), y2: yt, stroke: "#1f6feb", "stroke-width": 0.5, "stroke-dasharray": "1.5 1.5", opacity: 0.8 }));
  }

  const f = (ctx.facts && ctx.facts.trail) || {};
  const climb = f.climb_m != null ? f.climb_m : prof.length ? Math.max(0, prof[prof.length - 1].h - prof[0].h) : 0;
  const stats = { length_m: Math.round(total), climb_m: Math.round(climb), max_slope: f.max_slope, steps: f.steps_estimate, folds: f.folds };
  const cap = document.createElement("div");
  cap.className = "caption";
  cap.append(
    span(`沿${trail ? "主路" : "南北中线"} ${stats.length_m} m`),
    span(`爬升 ${stats.climb_m} m（约 ${Math.round(climb / layer)} 层）`),
    f.max_slope != null ? span(`段级最大坡度 ${fmt1(f.max_slope)}${f.max_slope > 0.7 ? "（偏陡）" : ""}`) : null,
    f.max_local_slope != null ? span(`局部最陡 ${fmt1(f.max_local_slope)}${f.steep_length_m ? `，> 0.7 的共 ${Math.round(f.steep_length_m)} m（红段，引擎侧做台阶）` : ""}`) : null,
    f.steps_estimate != null ? span(`约 ${Math.round(f.steps_estimate)} 级台阶`) : null,
    f.folds != null ? span(f.folds === 0 ? "直上" : `之字 ${f.folds} 折`) : null,
  );
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.append(s, cap);
  return { node: wrap, stats };
}

function span(t) { const e = document.createElement("span"); e.textContent = t; return e; }
