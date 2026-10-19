// stage.js — 中栏：首屏（示例句）、三张并排、四个视图（俯视 / 剖面 / 第一眼 / 3D）、图层切换、3D 小窗（俯视浮窗 / 剖面下方嵌入）、提示条与图上小弹窗。
// 只负责画和界面状态；改动走 A.edit（gestures.js / sidepanels.js / params.js）。
import { el, renderCompare } from "./cards.js";
import { $, S, A, clamp, store } from "./state.js";
import { aiTag } from "./chat.js";
import { canUndo, canRedo } from "./history.js";
import { renderMap, bindMapGestures, paletteOf } from "./views/map.js";
import { renderProfile } from "./views/profile.js";
import { renderEye } from "./views/eye.js";
import { mountPreview } from "./views/preview3d.js";
import { AXES } from "./engine/diversity.js";

export const EXAMPLES = ["我要生成山城村庄", "黄昏的山城村庄，有条溪", "夜里亮灯的山村，寺下面有地宫"];

// ------------------------------------------------------------ 上下文
/** 剖切线与宽度带在俯视图上常显（沿主路时淡色）；把手只在「移动 / 剖切」工具下出 */
const lineMode = () => ((S.scene.sid.meta.section || {}).mode === "line");
export function ctx() {
  const sc = S.scene;
  return { sid: sc.sid, T: sc.T, facts: sc.facts, checks: sc.checks, diffs: S.diffs, eye: S.eye, stratum: S.stratum, tool: S.tool,
    selected: S.sel && S.sel.type !== "ground" ? S.sel : null, section: sc.section(), sectionHandles: S.tool === "move" || S.tool === "section" };
}
const ctx3d = () => ({ sid: S.scene.sid, T: S.scene.T, stratum: S.stratum });

// ------------------------------------------------------------ 提示条（中栏顶部）
let noteTimer = null;
/** 一句改动说明，可带「撤销」与其它按钮；几秒后自己消失 */
export function note(text, { undo = false, actions = [] } = {}) {
  const n = $("#note"); clearTimeout(noteTimer);
  if (!text) { n.hidden = true; return; }
  const kids = [el("span", {}, text)];
  if (undo) kids.push(el("button", { type: "button", onclick: () => A.undo() }, "撤销"));
  for (const a of actions) kids.push(el("button", { type: "button", onclick: a.fn }, a.label));
  n.replaceChildren(...kids);
  n.hidden = false;
  if (!S.mock || !new URLSearchParams(location.search).get("demo")) noteTimer = setTimeout(() => { n.hidden = true; }, undo || actions.length ? 9000 : 5000); // 演示截图时常驻
}
/** 拖动中的实时提示（不自动消失，给 null 收起） */
export function hint(text) { const n = $("#note"); clearTimeout(noteTimer); if (!text) { n.hidden = true; return; } n.replaceChildren(el("span", {}, text)); n.hidden = false; }

// ------------------------------------------------------------ 图上小弹窗
/** 跟着鼠标；没有鼠标事件（演示里合成的）就投影世界坐标 at=[x,z] */
export function popup(ev, kids, at) {
  const pop = $("#popup"); pop.replaceChildren(...kids);
  const r = $("#views").getBoundingClientRect();
  let x = r.width / 2, y = r.height / 2;
  if (ev && ev.clientX != null) { x = ev.clientX - r.left; y = ev.clientY - r.top; }
  else if (S.mapSvg && at) { try { const pt = S.mapSvg.createSVGPoint(); pt.x = at[0]; pt.y = at[1]; const q = pt.matrixTransform(S.mapSvg.getScreenCTM()); x = q.x - r.left; y = q.y - r.top; } catch { /* 用中心 */ } }
  pop.style.left = clamp(x + 8, 8, Math.max(8, r.width - 290)) + "px"; pop.style.top = clamp(y + 8, 8, Math.max(8, r.height - 120)) + "px"; pop.hidden = false;
}
export function hidePopup() { $("#popup").hidden = true; }

// ------------------------------------------------------------ 界面状态（顶栏步骤、工具条、图层条、按钮）
export function syncChrome() {
  const has = !!S.scene, cmp = S.comparing;
  document.body.classList.toggle("has-scene", has);
  document.body.classList.toggle("comparing", cmp);
  document.querySelectorAll("#steps li").forEach((li) => { const k = +li.dataset.step; li.className = k < S.step ? "done" : k === S.step ? "now" : ""; });
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === S.view));
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + S.view));
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === S.tool));
  $("#view-map").dataset.tool = S.tool;
  $("#toolbar").dataset.view = $("#views").dataset.view = S.view; // 画路 / 圈区域 / 剖切 / 擦除只在俯视图出；剖面里提示条放到底下
  $("#toolbar").classList.toggle("disabled", !has || cmp);
  $("#btn-undo").disabled = !has || cmp || !canUndo(); $("#btn-redo").disabled = !has || cmp || !canRedo();
  const insetOk = has && !cmp && (S.view === "map" || S.view === "profile");
  $("#btn-inset").disabled = !insetOk; $("#btn-inset").setAttribute("aria-pressed", String(insetOk && !!S.insetOn));
  $("#btn-variants").disabled = !has || cmp; $("#btn-export").disabled = !has;
  const sw = $("#strata-switch");
  sw.hidden = !has || cmp || !(S.view === "map" || S.view === "profile");
  $("#views").classList.toggle("has-switch", !sw.hidden);
  if (has) {
    const sp = S.scene.sid.spaces || [], n = (st) => sp.filter((s) => s.stratum === st).length;
    sw.querySelectorAll("button").forEach((b) => { const st = b.dataset.stratum; b.classList.toggle("on", st === S.stratum); const k = st === "ground" ? 0 : n(st); b.querySelector("i").textContent = k ? String(k) : ""; });
  }
}

// ------------------------------------------------------------ 渲染
/** 俯视图下的图例 + 统计行 */
function mapCaption(c) {
  const f = c.facts || {}, t = f.trail || {}, b = c.sid.bounds, pal = paletteOf(c.sid);
  const W = Math.round(b.max[0] - b.min[0]), nT = new Set(((c.T && c.T.terraces) || []).map((t) => t.level)).size, layer = (c.sid.meta || {}).layer_height_m;
  const sw = (color, label) => el("span", {}, el("i", { class: "sw-dot", style: `background:${color}` }), label);
  const sp = c.sid.spaces || [], nu = sp.filter((s) => s.stratum === "underground").length, ns = sp.length - nu;
  return el("div", { class: "caption" }, sw("#b8452b", "地标"), sw("#1f6feb", "入口 · 视野"), sw("#8b7d5b", "主路"), sw(pal.roof, "民居"),
    el("span", { class: "stat" }, `${W} m 见方 · ${nT} 层 × ${layer} m · ${f.houses || 0} 栋${t.length_m ? ` · 主路 ${Math.round(t.length_m)} m` : ""}${nu ? ` · 地下 ${nu}` : ""}${ns ? ` · 天上 ${ns}` : ""}`));
}
/** 首屏：一句占位 + 三个示例句（点了就是「说」，会调 AI） */
function renderWelcome() {
  $("#view-map").replaceChildren(el("div", { class: "welcome" },
    el("div", { class: "w-title" }, "先说一句你想要的场景"),
    el("div", { class: "hint" }, "我出三张完整方案，你挑一张，之后全在图上改。"),
    el("div", { class: "w-ex" }, ...EXAMPLES.map((t) => el("button", { type: "button", class: "chip", onclick: () => A.say(t) }, t, aiTag())))));
}
/** 中栏当前视图重画（3D 小窗跟着） */
export function renderViews() {
  syncChrome();
  if (S.comparing) return;
  if (!S.scene) { renderWelcome(); return; }
  const c = ctx();
  const ey = renderEye(c); S.eye = ey.facts; c.eye = S.eye;
  if (S.view === "map") {
    const svg = renderMap(c);
    bindMapGestures(svg, c.sid, A.mapHandlers);
    $("#view-map").replaceChildren(el("div", { class: "wrap" }, svg, mapCaption(c))); S.mapSvg = svg;
  } else if (S.view === "profile") {
    const pr = renderProfile(Object.assign({}, c, { section: S.scene.sectionData() }), A.profileHandlers);
    $("#view-profile").replaceChildren(el("div", { class: "pcol" }, pr.node)); // 3D 小窗开着时嵌在剖面下方（updateInset 挂进来）
  } else if (S.view === "eye") $("#view-eye").replaceChildren(ey.node);
  else if (S.view === "three") { if (S.three) S.three.update(ctx3d()); else mountThree(); }
  updateInset();
}
/** 3D 整页只挂一次（并发调用共用同一个 Promise） */
async function mountThree() {
  if (!S.threeP) S.threeP = mountPreview($("#view-three"), ctx3d()).catch((e) => { S.threeP = null; note("3D 没加载成功：" + ((e && e.message) || e)); return null; });
  S.three = await S.threeP;
  if (S.three && S.view === "three") S.three.update(ctx3d());
}
// ------------------------------------------------------------ 3D 小窗
// 俯视图：可拖的浮窗（顶部细条拖、「—」收成「3D」小按钮、「×」关掉），位置记在本机；图上拖 / 画 / 圈 / 剖切时淡到 15% 且不挡指针（body.gesturing）。
// 剖面：不浮在上面，嵌在剖面下方（同一个 3D 实例挪进去）。第一眼 / 3D / 对比时不出。
const POS_KEY = "scene.inset.pos";
/** 小窗节点：剖面重画时它会跟着旧内容一起被摘下，所以留一个引用，不靠 querySelector 找 */
let INSET = null;
const insetEl = () => INSET || (INSET = $("#inset3d"));
export const insetMode = () => (!S.insetOn || !S.scene || S.comparing ? null : S.view === "map" ? "float" : S.view === "profile" ? "dock" : null);
/** 3D 小窗现在看得见（拖动预览只在看得见时才算） */
export const insetShown = () => { const m = insetMode(); return !!m && !(m === "float" && S.insetMin); };
/** 浮窗不许挡的东西：选中描边、剖切把手与 A/B 字标（权重高），地标、入口（权重低）；外扩一圈给它们的字 */
const KEEP_CLEAR = [[".selection", 10, 30], [".sec-handle", 10, 12], ["[data-section-label]", 10, 10], [".landmark", 3, 24], [".spawn", 3, 24]];
/** 人没拖过时自己挑角：左上 → 左下 → 右下 → 右上，挑挡得最少的；现在的角不挡就不动（不跳来跳去） */
let corner = 0;
function autoCorner(box, W, H, w, h) {
  const host = $("#views").getBoundingClientRect(), left = $("#views").classList.contains("has-switch") ? 64 : 12;
  const xs = [left, left, W - w - 12, W - w - 12], ys = [46, H - h - 12, H - h - 12, 46];
  const keep = [];
  if (S.mapSvg && S.mapSvg.isConnected) for (const [q, wt, pad] of KEEP_CLEAR) for (const n of S.mapSvg.querySelectorAll(q)) {
    const r = n.getBoundingClientRect(); if (!r.width && !r.height) continue;
    keep.push({ wt, x0: r.left - host.left - pad, y0: r.top - host.top - pad, x1: r.right - host.left + pad, y1: r.bottom - host.top + pad });
  }
  const cost = (i) => keep.reduce((a, k) => a + k.wt * Math.max(0, Math.min(k.x1, xs[i] + w) - Math.max(k.x0, xs[i])) * Math.max(0, Math.min(k.y1, ys[i] + h) - Math.max(k.y0, ys[i])), 0);
  if (cost(corner) > 0) { let best = corner, bc = cost(corner); for (let i = 0; i < 4; i++) { const c = cost(i); if (c < bc) { best = i; bc = c; } } corner = best; }
  return { x: xs[corner], y: ys[corner] };
}
function placeInset(box) {
  const host = $("#views"), W = host.clientWidth, H = host.clientHeight;
  const w = box.offsetWidth || 320, h = box.offsetHeight || 240;
  const mine = store(POS_KEY, null); // 人拖过就一直用人的位置
  const p = mine || (document.body.classList.contains("gesturing") ? { x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 } : autoCorner(box, W, H, w, h));
  box.style.left = clamp(Number(p.x) || 0, 0, Math.max(0, W - w)) + "px";
  box.style.top = clamp(Number(p.y) || 0, 0, Math.max(0, H - h)) + "px";
}
function updateInset() {
  const box = insetEl(), mode = insetMode();
  box.hidden = !mode;
  $("#views").classList.toggle("dock", mode === "dock");
  box.classList.toggle("docked", mode === "dock");
  box.classList.toggle("min", mode === "float" && !!S.insetMin);
  if (!mode) return;
  if (mode === "dock") { const host = $("#view-profile .pcol"); if (host && box.parentNode !== host) host.append(box); box.style.left = box.style.top = ""; }
  else { if (box.parentNode !== $("#views")) $("#views").insertBefore(box, $("#popup")); placeInset(box); }
  if (!S.inset) {
    if (!S.insetP) S.insetP = mountPreview(box.querySelector(".inset-body"), ctx3d(), { inset: true }).then((p) => { S.inset = p; updateInset(); return p; }).catch(() => { S.insetP = null; return null; });
    return;
  }
  S.inset.update(ctx3d());
  S.inset.setSection(mode === "dock" || S.tool === "section" || lineMode() ? S.scene.section() : null);
}
/** 3D 小窗的条：拖动挪位置（松手记住），「—」收起、「×」关掉；收起后点一下展开 */
export function bindInset({ onClose }) {
  const box = insetEl(), bar = box.querySelector(".inset-bar");
  box.querySelector(".inset-min").addEventListener("click", (e) => { e.stopPropagation(); S.insetMin = store("scene.inset.min", null, true); updateInset(); });
  box.querySelector(".inset-x").addEventListener("click", (e) => { e.stopPropagation(); onClose(); });
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button") || box.classList.contains("docked")) return;
    e.preventDefault();
    const r0 = box.getBoundingClientRect(), host = $("#views").getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const mv = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      box.style.left = clamp(r0.left - host.left + dx, 0, Math.max(0, host.width - r0.width)) + "px";
      box.style.top = clamp(r0.top - host.top + dy, 0, Math.max(0, host.height - r0.height)) + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      if (moved) store(POS_KEY, null, { x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 });
      else if (S.insetMin) { S.insetMin = store("scene.inset.min", null, false); updateInset(); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
}

/** 三张并排（第 2 步）：底部一行「重出 / 留现在这张」，换一批时多一行换别的轴 */
export function showCompare(cards, resolved, { axis = null, notDistinct = false } = {}) {
  const foot = el("div", { class: "cmp-foot" },
    el("button", { type: "button", class: "ubtn", onclick: () => A.redraft() }, "三张都不要，重出", aiTag()),
    S.scene ? el("button", { type: "button", class: "ubtn", onclick: () => A.keepCurrent() }, "都不要，回到现在这张") : null);
  if (axis) foot.append(el("span", { class: "hint" }, "换别的："), ...Object.keys(AXES).filter((k) => AXES[k] !== axis).map((k) => el("button", { type: "button", class: "ubtn sm", onclick: () => A.variants(k) }, AXES[k], aiTag())));
  S.comparing = true; S.view = "map";
  $("#view-map").replaceChildren(renderCompare(cards, resolved, { onPick: (i) => A.pick(i), axis, notDistinct, foot }));
  S.mapSvg = null; hidePopup(); syncChrome(); updateInset();
}
