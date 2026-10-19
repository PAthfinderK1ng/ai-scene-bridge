// views/eye.js — 「第一眼」：从出生点 1.7 m 眼高朝地标看过去的示意透视。
// 不是渲染器：按方位角分列扫地形，得到远 / 中 / 近三层山脊轮廓；房子和地标按方位 / 仰角投成矩形。
// 目的是把最关键的一眼——玩家进场看到什么——先在沟通阶段摆出来。v4：所有地标都投、都标名字（主地标加粗），
// 空中空间的平台 / 栈道按各自高度当板画；每个体块带 data-type / data-plan-id。纯函数，不调 AI。
import { svgel, landmarkOf, spawnOf, paletteOf, mainTrailOf, EYE_FOV_DEG } from "./map.js";

const FOV = EYE_FOV_DEG, VFOV_UP = 28, VFOV_DOWN = 16, COLS = 112, MAXR = 180, EYE_M = 1.7;
const deg = (r) => (r * 180) / Math.PI;
const fmt1 = (v) => Math.round(v * 10) / 10;

/**
 * @param {object} ctx { sid, T, selected?: {plan_id?, sid_id?} }
 * @returns {{ node: HTMLElement, facts: { landmark_visible, landmark_screen, landmark_dist_m, landmark_elev_deg, time_of_day, sky_spaces, landmarks: [{id, plan_id, label, visible, screen, dist_m}] } }}
 */
export function renderEye(ctx) {
  const { sid, T } = ctx;
  const sp = spawnOf(sid), lm = landmarkOf(sid);
  const pal = paletteOf(sid);
  const Wv = 320, Hv = 180;
  const s = svgel("svg", { viewBox: `0 0 ${Wv} ${Hv}`, class: "eye" });
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  if (!sp) { s.append(svgel("text", { x: 10, y: 20, "font-size": 8 }, "还没有出生点")); wrap.append(s); return { node: wrap, facts: {} }; }

  const ex = sp.position[0], ez = sp.position[2];
  const eyeH = T.heightAt(ex, ez) + EYE_M;
  // 朝向：有地标就看地标，否则按 marker 的 rotation_y
  let a0;
  if (lm) a0 = Math.atan2(lm.position[2] - ez, lm.position[0] - ex);
  else { const th = ((sp.rotation_y || 0) * Math.PI) / 180; a0 = Math.atan2(-Math.cos(th), -Math.sin(th)); }
  const horizonY = Hv * (VFOV_UP / (VFOV_UP + VFOV_DOWN));
  const sx = (az) => ((deg(norm(az - a0)) + FOV / 2) / FOV) * Wv;
  const sy = (elevDeg) => horizonY - (elevDeg / VFOV_UP) * horizonY;

  // 天空
  const tod = (sid.style && sid.style.lighting && sid.style.lighting.time_of_day) || "dusk";
  const sky = { dawn: ["#f6d5c3", "#dfe6ee"], morning: ["#dfeaf3", "#f4f6f3"], noon: ["#c9ddf0", "#eef3f6"], afternoon: ["#d7e3ee", "#f6efe3"], dusk: ["#f0b27a", "#e8d6c0"], night: ["#1e2638", "#3a4256"], overcast: ["#c9cdd1", "#e3e5e6"] }[tod] || ["#dfe6ee", "#f4f6f3"];
  const defs = svgel("defs");
  const g = svgel("linearGradient", { id: "eye-sky", x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(svgel("stop", { offset: 0, "stop-color": sky[0] }), svgel("stop", { offset: 1, "stop-color": sky[1] }));
  defs.append(g);
  s.append(defs, svgel("rect", { width: Wv, height: Hv, fill: "url(#eye-sky)" }));

  // 地形：三段距离带，由远到近
  const bands = [[70, MAXR, mix(pal.mist, "#9aa89a", 0.5)], [28, 70, mix(pal.foliage, pal.mist, 0.45)], [0.5, 28, mix(pal.foliage, pal.stone, 0.25)]];
  const skyline = new Float32Array(COLS).fill(-90); // 每列地形最大仰角（全距离）
  const colDist = new Float32Array(COLS).fill(MAXR);
  for (const [r0, r1, color] of bands) {
    let d = `M0 ${Hv}`;
    for (let c = 0; c < COLS; c++) {
      const az = a0 + ((c / (COLS - 1)) * FOV - FOV / 2) * (Math.PI / 180);
      let best = -90;
      for (let r = Math.max(0.5, r0); r <= r1; r += 1) {
        const x = ex + Math.cos(az) * r, z = ez + Math.sin(az) * r;
        const h = T.inside(x, z) ? T.heightAt(x, z) : 0;
        const e = deg(Math.atan2(h - eyeH, r));
        if (e > best) best = e;
        if (e > skyline[c]) { skyline[c] = e; colDist[c] = r; }
      }
      const y = Math.min(Hv, sy(Math.max(best, -VFOV_DOWN)));
      d += ` L${fmt1((c / (COLS - 1)) * Wv)} ${fmt1(y)}`;
    }
    d += ` L${Wv} ${Hv} Z`;
    s.append(svgel("path", { d, fill: color, opacity: 0.95 }));
  }

  // 视平线（仰角 0° = 眼高）；文字类标注收进 anno，画在体块之后才不被房子盖住
  const anno = svgel("g", { class: "anno", "pointer-events": "none" });
  const ol = { stroke: "#000", "stroke-width": 1.2, "paint-order": "stroke", "stroke-opacity": 0.6 };
  s.append(svgel("line", { x1: 0, x2: Wv, y1: fmt1(horizonY), y2: fmt1(horizonY), stroke: "#fff", "stroke-dasharray": "3 2", opacity: 0.6, "pointer-events": "none" }));
  anno.append(svgel("text", Object.assign({ x: Wv - 3, y: fmt1(horizonY - 2), "font-size": 5, "text-anchor": "end", fill: "#fff" }, ol), `视平线 ${EYE_M} m`));

  // 主路投影：沿主路每 2 m 采样，投到画面；被更近的地形挡住 / 出视野处断开；越远越细
  const colOf = (az) => Math.round(((deg(norm(az - a0)) + FOV / 2) / FOV) * (COLS - 1));
  const trail = mainTrailOf(sid);
  if (trail && trail.points && trail.points.length > 1) {
    const proj = T.sampleProfile(trail.points, 2).map((p) => {
      const r = Math.hypot(p.x - ex, p.z - ez);
      if (r < 0.5 || r > MAXR) return null;
      const az = Math.atan2(p.z - ez, p.x - ex);
      if (Math.abs(deg(norm(az - a0))) >= FOV / 2) return null;
      const e = deg(Math.atan2(p.h + 0.05 - eyeH, r));
      const c = colOf(az);
      if (c >= 0 && c < COLS && colDist[c] < r - 1 && skyline[c] > e) return null; // 被前面的山脊挡住
      return { x: sx(az), y: Math.min(Hv, sy(Math.max(e, -VFOV_DOWN))), r };
    });
    const road = svgel("g", { class: "trail", "pointer-events": "none" });
    for (let i = 1; i < proj.length; i++) {
      const a = proj[i - 1], q = proj[i];
      if (!a || !q) continue;
      const w = 2 - (1.4 * Math.min(1, (a.r + q.r) / 2 / 60));
      road.append(svgel("line", { x1: fmt1(a.x), y1: fmt1(a.y), x2: fmt1(q.x), y2: fmt1(q.y), stroke: pal.stone, "stroke-width": fmt1(w), "stroke-linecap": "round", opacity: 0.95 }));
    }
    s.append(road);
  }

  // 距离刻度 10 / 20 / 40 / 80 m（画面中央列，按脚下地面仰角；5 m 在眼高 1.7 m 下仰角 −19°，出下边界，不画）与 10 m 处的 1.7 m 小人
  // 只画看得见的刻度：中线上 1 m 一采样，地面仰角的前缀最大值挡住的（被山脊挡住的远处地面）不画 → 刻度自下而上单调
  const groundAng = (r) => { const gx = ex + Math.cos(a0) * r, gz = ez + Math.sin(a0) * r; return deg(Math.atan2((T.inside(gx, gz) ? T.heightAt(gx, gz) : 0) - eyeH, r)); };
  let horizon = -90, scanned = 0;
  for (const r of [10, 20, 40, 80]) {
    for (; scanned < r - 0.5; scanned += 1) if (scanned >= 1) horizon = Math.max(horizon, groundAng(scanned));
    const gx = ex + Math.cos(a0) * r, gz = ez + Math.sin(a0) * r;
    const h = T.inside(gx, gz) ? T.heightAt(gx, gz) : 0;
    const e = deg(Math.atan2(h - eyeH, r));
    if (e < horizon - 0.05) continue;
    if (e < -VFOV_DOWN || e > VFOV_UP) continue;
    const y = sy(e);
    s.append(svgel("line", { x1: Wv / 2 - 4, x2: Wv / 2 + 4, y1: fmt1(y), y2: fmt1(y), stroke: "#fff", "stroke-width": 0.8, opacity: 0.9, "pointer-events": "none" }));
    anno.append(svgel("text", Object.assign({ x: Wv / 2 + 6, y: fmt1(y + 1.8), "font-size": 5, fill: "#fff" }, ol), `${r} m`));
    if (r === 10) {
      const yh = sy(Math.min(VFOV_UP, deg(Math.atan2(h + EYE_M - eyeH, r))));
      const px = Wv / 2 - 14;
      s.append(svgel("line", { x1: px, x2: px, y1: fmt1(y), y2: fmt1(yh + 1.5), stroke: "#fff", "stroke-width": 1, opacity: 0.9 }), svgel("circle", { cx: px, cy: fmt1(yh), r: 1.5, fill: "#fff", opacity: 0.9 }));
    }
  }

  // 体块：按距离远→近。空中空间（平台 / 栈道 / 浮岛 / 天桥）当一块板画（板面 floor_y，板厚 1 m）；地下空间看不见，不画
  const vols = (sid.volumes || []).filter((v) => v.position && v.size).map((v) => {
    const hw = v.size[0] / 2, hd = v.size[2] / 2, th = ((v.rotation_y || 0) * Math.PI) / 180;
    const cs = Math.cos(th), sn = Math.sin(th);
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [v.position[0] + lx * cs + lz * sn, v.position[2] - lx * sn + lz * cs]);
    return { v, corners, y0: v.position[1], y1: v.position[1] + v.size[1], dist: Math.hypot(v.position[0] - ex, v.position[2] - ez) };
  });
  for (const sk of skySpaces(sid)) vols.push(Object.assign(sk, { dist: centroidDist(sk.corners, ex, ez) }));
  vols.sort((a, b) => b.dist - a.dist);
  let landmarkVisible = null, landmarkScreen = null, skyDrawn = 0;
  const lmFacts = [], lmLabels = [], sel = ctx.selected || null;
  const isSel = (v) => !!sel && ((sel.sid_id && sel.sid_id === v.id) || (sel.plan_id && (sel.plan_id === v.plan_id || sel.plan_id === v.zone_id)));
  for (const { v, corners, y0, y1, dist } of vols.filter((o) => o.dist > 1 && o.dist < MAXR)) {
    const azs = corners.map(([x, z]) => norm(Math.atan2(z - ez, x - ex) - a0));
    const azMin = Math.min(...azs), azMax = Math.max(...azs);
    if (azMax - azMin > Math.PI) continue; // 跨越正后方
    if (deg(azMax) < -FOV / 2 || deg(azMin) > FOV / 2) continue;
    const eb = deg(Math.atan2(y0 - eyeH, dist)), et = deg(Math.atan2(y1 - eyeH, dist));
    // 地形遮挡：中心列上，比它近的地形仰角是否盖过它的顶
    const cc = Math.round(((deg(norm((azMin + azMax) / 2)) + FOV / 2) / FOV) * (COLS - 1));
    let blocked = false;
    if (cc >= 0 && cc < COLS) {
      const az = a0 + ((cc / (COLS - 1)) * FOV - FOV / 2) * (Math.PI / 180);
      for (let r = 1; r < dist - 1; r += 1) { const x = ex + Math.cos(az) * r, z = ez + Math.sin(az) * r; if (deg(Math.atan2((T.inside(x, z) ? T.heightAt(x, z) : 0) + 0.3 - eyeH, r)) >= et) { blocked = true; break; } }
    }
    const isLm = v.importance === "landmark", isFocus = isLm && lm && v.id === lm.id;
    if (isLm) {
      const scr = { x: (sx(a0 + azMin) + sx(a0 + azMax)) / 2, top: sy(et), bottom: sy(eb), dist, elev: et };
      lmFacts.push({ id: v.id, plan_id: v.plan_id || v.id, label: v.label || "", visible: !blocked, screen: scr.x < Wv / 3 ? "左" : scr.x > (Wv * 2) / 3 ? "右" : "正中", dist_m: Math.round(dist) });
      if (isFocus) { landmarkVisible = !blocked; landmarkScreen = scr; }
    }
    if (blocked && !isLm) continue;
    const x0 = Math.max(0, sx(a0 + azMin)), x1 = Math.min(Wv, sx(a0 + azMax));
    const yt = sy(Math.min(et, VFOV_UP)), yb = Math.min(Hv, sy(Math.max(eb, -VFOV_DOWN)));
    if (x1 - x0 < 0.6 || yb - yt < 0.6) continue;
    const far = Math.min(1, dist / MAXR), hot = isSel(v);
    const ids = { "data-type": v.kind === "sky_space" ? "space" : isLm ? "landmark" : v.kind === "prop" ? "tree" : "house", "data-sid-id": v.id, "data-plan-id": v.plan_id || null, "data-selected": hot ? 1 : null };
    const edge = (w, c) => (hot ? { stroke: "#f08c00", "stroke-width": 1.4 } : { stroke: c, "stroke-width": w });
    if (v.kind === "sky_space") { skyDrawn++; s.append(svgel("rect", Object.assign({ class: "sky-space", "data-id": v.id, x: x0, y: yt, width: x1 - x0, height: Math.max(1, yb - yt), fill: mix("#8a7f6e", pal.mist, far * 0.6), opacity: blocked ? 0.35 : 0.95 }, ids, edge(0.3, "rgba(0,0,0,.4)")))); continue; }
    if (v.kind === "prop" && !isLm) { s.append(svgel("ellipse", Object.assign({ cx: (x0 + x1) / 2, cy: (yt + yb) / 2, rx: (x1 - x0) / 2, ry: (yb - yt) / 2, fill: mix(pal.foliage, pal.mist, far * 0.7), opacity: 0.9 }, ids))); continue; }
    const wall = isLm ? pal.roof : pal.wall, roofH = Math.min((yb - yt) * 0.35, 6), g = svgel("g", ids);
    g.append(svgel("rect", Object.assign({ x: x0, y: yt + roofH, width: x1 - x0, height: Math.max(0.5, yb - yt - roofH), fill: mix(wall, pal.mist, far * 0.6), opacity: blocked ? 0.35 : 1, "stroke-dasharray": blocked ? "2 2" : null }, edge(isLm ? 1 : 0.3, isLm ? "#4a1a10" : "rgba(0,0,0,.35)"))));
    g.append(svgel("path", { d: `M${x0 - 0.5} ${yt + roofH} L${(x0 + x1) / 2} ${yt} L${x1 + 0.5} ${yt + roofH} Z`, fill: mix(isLm ? "#b8452b" : pal.roof, pal.mist, far * 0.6), opacity: blocked ? 0.35 : 1 }));
    s.append(g);
    if (isLm) lmLabels.push({ x: (x0 + x1) / 2, y: Math.max(8, yt - 3), text: `${v.label || "地标"}${blocked ? "（被挡住）" : ""}`, focus: !!isFocus, id: v.id, plan_id: v.plan_id });
  }

  // 地标名字：主地标先占位，其余挤在一起时往上错一行
  const taken = [];
  for (const L of lmLabels.sort((a, b) => b.focus - a.focus)) {
    const fs = L.focus ? 7 : 6, w = [...L.text].length * fs;
    let y = L.y;
    while (taken.some((t) => Math.abs(t.x - L.x) < (t.w + w) / 2 && Math.abs(t.y - y) < fs + 1) && y > 8) y -= fs + 1;
    taken.push({ x: L.x, y, w });
    anno.append(svgel("text", { x: fmt1(L.x), y: fmt1(Math.max(7, y)), "font-size": fs, "text-anchor": "middle", fill: "#4a1a10", "font-weight": L.focus ? 700 : 400, stroke: "#fff", "stroke-width": 1.4, "paint-order": "stroke", "data-type": "landmark", "data-sid-id": L.id, "data-plan-id": L.plan_id || null }, L.text));
  }
  s.append(anno);

  // 雾：越远越白（简单叠一层渐变）
  const fog = svgel("linearGradient", { id: "eye-fog", x1: 0, y1: 0, x2: 0, y2: 1 });
  fog.append(svgel("stop", { offset: 0, "stop-color": pal.mist, "stop-opacity": 0.35 }), svgel("stop", { offset: 0.6, "stop-color": pal.mist, "stop-opacity": 0 }));
  defs.append(fog);
  s.append(svgel("rect", { width: Wv, height: Hv, fill: "url(#eye-fog)", "pointer-events": "none" }));
  // 画幅三分线（左 / 中 / 右）
  for (const x of [Wv / 3, (Wv * 2) / 3]) s.append(svgel("line", { x1: x, x2: x, y1: 0, y2: Hv, stroke: "#fff", "stroke-width": 0.4, opacity: 0.5, "stroke-dasharray": "2 3" }));

  const where = landmarkScreen ? (landmarkScreen.x < Wv / 3 ? "左" : landmarkScreen.x > (Wv * 2) / 3 ? "右" : "正中") : null;
  const facts = { landmark_visible: landmarkVisible, landmark_screen: where, landmark_dist_m: landmarkScreen ? Math.round(landmarkScreen.dist) : null, landmark_elev_deg: landmarkScreen ? fmt1(landmarkScreen.elev) : null, time_of_day: tod, sky_spaces: skyDrawn, landmarks: lmFacts };
  const cap = document.createElement("div");
  cap.className = "caption";
  if (lm && landmarkScreen) cap.append(span(`第一眼：${lm.label || "地标"} 在画面${where}${landmarkScreen.top < 0 ? "（出框，太近或太高）" : ""}`), span(`距离约 ${facts.landmark_dist_m} m`), span(`仰角 ${facts.landmark_elev_deg}°`), span(landmarkVisible ? "可见 ✓" : "被地形 / 房子挡住 ✗"));
  else cap.append(span("地标不在视野里"));
  const others = lmFacts.filter((x) => !lm || x.id !== lm.id);
  if (others.length) cap.append(span(`还看得见：${others.filter((x) => x.visible).map((x) => x.label).join("、") || "无"}`));
  cap.append(span(`视野 ${FOV}° · 眼高 ${EYE_M} m · 中线刻度 10 / 20 / 40 / 80 m`));
  wrap.append(s, cap);
  return { node: wrap, facts };
}

/** 空中空间 → 当体块画的板：有平台（rooms）一块平台一块板，栈道（passages）按段画窄板；都没有时用外轮廓 */
export function skySpaces(sid) {
  const out = [];
  for (const x of sid.spaces || []) {
    if (!x || x.stratum !== "sky" || !Array.isArray(x.polygon) || x.polygon.length < 3 || !Number.isFinite(x.floor_y)) continue;
    const v = { id: x.id, kind: "sky_space", label: x.label || "", plan_id: x.plan_id || x.id };
    const rooms = (x.rooms || []).filter((r) => r && Array.isArray(r.polygon) && r.polygon.length >= 3);
    const walks = (x.passages || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2);
    for (const r of rooms) { const fy = Number.isFinite(r.floor_y) ? r.floor_y : x.floor_y; out.push({ v, corners: r.polygon.map((p) => [p[0], p[1]]), y0: fy - 1, y1: fy }); }
    for (const p of walks) {
      const fy = Number.isFinite(p.floor_y) ? p.floor_y : x.floor_y, hw = (Number(p.width) || 2) / 2;
      for (let i = 0; i + 1 < p.points.length; i++) {
        const a = p.points[i], b = p.points[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = (-(b[1] - a[1]) / L) * hw, nz = ((b[0] - a[0]) / L) * hw;
        out.push({ v, corners: [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]], y0: fy - 0.5, y1: fy });
      }
    }
    if (!rooms.length && !walks.length) out.push({ v, corners: x.polygon.map((p) => [p[0], p[1]]), y0: x.floor_y - 1, y1: x.floor_y });
  }
  return out;
}
function centroidDist(corners, ex, ez) {
  const cx = corners.reduce((a, p) => a + p[0], 0) / corners.length, cz = corners.reduce((a, p) => a + p[1], 0) / corners.length;
  return Math.hypot(cx - ex, cz - ez);
}
function norm(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function span(t) { const e = document.createElement("span"); e.textContent = t; return e; }
function hex2(hex) { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
export function mix(a, b, t) { const A = hex2(a), B = hex2(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
