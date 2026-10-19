// app.js — 「场景对话」v5（docs/06 §5）：一个 store + 流程（说 → 选 → 改 → 出）+ 聊天 + 撤销 + 调 AI + 演示。
// 状态只有 store：plan（AI 写的场景程序：形体 / 组 / 重复 / 连接 / 生成器 + 地形雕刻，局部尺寸与偏移，没有全局坐标）+ 视图状态。
// plan 一变 → compilePlan → 渲染。人在图上拖 = 改节点的 offset_m（在父组坐标里反算），在剖面里拖 = 改 elev_m / 尺寸 / 深度；
// 画路 = 加一条连接（两头吸到最近的节点），圈区域 = 加一个生成器 / 空间。全部本地、可撤销；只有「发送 / 重出 / 换一批」调 AI。
import { compilePlan, applyOps, normalizePlan, resolveTarget, offsetFromPoint, findNode, expand, newElement, distinctPlans, PLAN_SCHEMA } from "./engine/plan.js";
import { levelsOf, LAYOUT_LABEL, SKY_LAYOUT_LABEL, STRATUM_LABEL, INTERIOR_LAYOUTS } from "./engine/interior.js";
import { defaultSection, sampleSection, widthClamp, rotateSection } from "./engine/section.js";
import { classifyStroke, strokeToPolygon } from "./engine/strokes.js";
import { polygonCentroid } from "./engine/terrain.js";
import * as MapView from "./views/map.js";
import * as ProfileView from "./views/profile.js";
import * as EyeView from "./views/eye.js";
import { el, renderSide, refreshAI, openSettings, markPill, bindSettings, openExport, closeModal, diffButtons, sectionTo, buildBrief, buildPackage, exportSid } from "./ui.js";

const $ = (s) => document.querySelector(s);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const short = (t, n = 24) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const local = (k, d, v) => { try { if (v !== undefined) { localStorage.setItem(k, JSON.stringify(v)); return v; } const s = localStorage.getItem(k); return s == null ? d : JSON.parse(s); } catch { return d; } };
export const DIR_LABEL = { C: "中", N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" };
/** schema 里某字段的中文选项（x-ui.options） */
export const OPT = (def, field) => ((((PLAN_SCHEMA.definitions[def] || {}).properties || {})[field] || {})["x-ui"] || {}).options || {};
export const EXAMPLES = ["我要生成魔法学院", "赛博朋克夜市一角", "海盗港口", "沙漠里的古神殿", "空中花园", "山城村庄"];
/** 本地示例程序（不调 AI）：?demo=<key> 与首屏「直接看示例」 */
export const SAMPLES = { academy: "magic-academy", harbor: "pirate-harbor", sky: "sky-garden", temple: "desert-temple", cyber: "cyber-market", village: "mountain-village", maze: "mine-maze" };

// ============================================================ store
export const store = {
  step: 1, intent: "", mock: false, ai: null, busy: 0, pending: null, inflight: null,
  plan: null, seed: 7, ignored: [], section: null,                         // 可撤销的部分
  sid: null, T: null, checks: [], facts: {}, index: {}, warnings: [], ms: 0, // 编译结果
  cards: null, comparing: false, variantN: 0,                              // 三张卡
  sel: null, open: new Set(), collapsed: new Set(), closed: new Set(), checksOpen: false, // 场景树展开 / 选中
  view: "map", tool: "move", stratum: "ground", interiorLevel: 0, eye: {},
  insetOn: local("scene.inset.on", false), insetMin: local("scene.inset.min", false), three: null, inset: null,
  diffs: [], readback: null, corrections: [], reference: null, board: null,
  undo: [], redo: [],
};

// ============================================================ 编译
function recompute() {
  const R = compilePlan(store.plan, { seed: store.seed, ignored: store.ignored });
  Object.assign(store, { plan: R.plan, sid: R.sid, T: R.T, checks: R.checks, facts: R.facts, index: R.index, warnings: R.warnings, ms: R.ms });
}
const compileCard = (p) => { try { return compilePlan(p, { seed: store.seed }); } catch (e) { console.error(e); return null; } };

// ============================================================ 场景树里的 id
const INST = /^([a-z][a-z0-9_]*)\[(\d+)\]$/;
/** SID 的 plan_id → 场景树里的那一项：实例 x[k] → 重复 x；节点 / 模板 / 地形操作原样；不在树里 → null */
export function treeIdOf(pid) {
  if (!pid || !store.plan) return null;
  if (pid === "spawn" || pid === "site") return pid;
  const m = INST.exec(pid), id = m ? m[1] : pid;
  return findNode(store.plan, id) ? id : null;
}
/** 一个体块属于哪个实例（x[k]）：plan_id 本身或 plan_path 里最近的一个；不在重复里 → null */
export function instanceIdOf(v) {
  if (!v) return null;
  if (INST.test(v.plan_id || "")) return v.plan_id;
  return (v.plan_path || []).slice().reverse().find((q) => INST.test(q)) || null;
}
/** 高亮用：模板 → 它的重复（模板自己没有几何，实例才有） */
export function hlId(id) { const f = id && store.plan && findNode(store.plan, id); return f && f.template && f.parent ? f.parent.id : id; }
/** 祖先链（根 → 父），给场景树自动展开用 */
export function ancestorsOf(id) {
  const out = [];
  let f = id && findNode(store.plan, id);
  while (f && f.parent) { out.unshift(f.parent.id); f = findNode(store.plan, f.parent.id); }
  return out;
}
const XDN = (PLAN_SCHEMA["x-defaults"] || {}).nodes || {};
/** 节点给人看的名字：重复 / 撒房子没起名（还是默认的「重复」）时用模板的名字 */
export function nodeName(n) {
  if (!n) return "";
  const dflt = !n.label || n.label === (XDN[n.type] || {}).label;
  return (n.type === "repeat" || n.type === "scatter_houses") && dflt && n.child && n.child.label ? n.child.label : n.label || n.id;
}
export function labelOf(id) {
  if (!id) return "";
  if (id === "spawn") return (store.plan.spawn && store.plan.spawn.label) || "出生点";
  if (id === "site") return "场地";
  const m = INST.exec(id), f = findNode(store.plan, m ? m[1] : id);
  if (!f) return id;
  const n = f.node, lab = (m && n.child && n.child.label) || nodeName(n);
  return m ? `${lab} #${+m[2] + 1}` : lab;
}
export const volOf = (sidId) => (store.sid && sidId ? store.sid.volumes.find((v) => v.id === sidId) : null) || null;
export const spaceOf = (t) => ((store.sid && store.sid.spaces) || []).find((s) => (t.sid_id && s.id === t.sid_id) || (t.plan_id && s.plan_id === t.plan_id)) || null;

// ============================================================ 剖切
export function sectionSpec() {
  const s = store.section, d = store.sid && store.T ? defaultSection(store.sid, store.T) : null;
  if (!s) return d && clone(d);
  return { mode: s.mode === "line" ? "line" : "trail", line: s.mode === "line" && Array.isArray(s.line) ? clone(s.line) : d && d.line, width_m: widthClamp(s.width_m != null ? s.width_m : d && d.width_m) };
}
export function sectionCtx() { const sp = sectionSpec(); return Object.assign(sampleSection(store.sid, store.T, sp), sp); }
const setSection = (s, patch) => { const cur = sectionSpec(); s.section = { mode: patch.mode || cur.mode, line: patch.line ? patch.line.map((q) => [r1(q[0]), r1(q[1])]) : cur.line, width_m: widthClamp(patch.width_m != null ? patch.width_m : cur.width_m) }; };

// ============================================================ 改动：先记、再改、再算、再画，提示条说一句（本地，绝不调 AI）
const snap = () => JSON.stringify({ plan: store.plan, ignored: store.ignored, section: store.section, seed: store.seed });
function put(s) { const o = JSON.parse(s); store.plan = o.plan; store.ignored = o.ignored || []; store.section = o.section || null; store.seed = o.seed; recompute(); }
/** fn(store) 改 plan / section / seed；返回 false = 没改。opts.geometry=false 时不重编译（只改剖切） */
export function edit(label, fn, { actions = [], geometry = true } = {}) {
  if (!store.plan) return false;
  const before = snap();
  let res;
  try {
    res = fn(store);
    if (res === false) { render(); return false; }
    if (geometry) recompute();
  } catch (e) { console.error(e); put(before); render(); note(`这步没算出来（${e.message}），图没变`); return false; }
  const text = typeof label === "function" ? label(res) : label;
  if (snap() === before) { render(); note(text); return false; }
  store.undo.push({ snap: before, label: text }); if (store.undo.length > 50) store.undo.shift(); store.redo = [];
  render(); note(text, { undo: true, actions });
  return true;
}
/** 场景程序的改动（set / add / remove，作用在树上），本地 */
export function planOps(label, ops, opts) {
  return edit(label, (s) => { const r = applyOps(s.plan, ops); s.plan = r.plan; if (r.warnings.length) s.opWarnings = r.warnings; }, opts);
}
export function undo() {
  const e = store.undo.pop(); if (!e) { note("没有可撤销的了"); return; }
  store.redo.push({ snap: snap(), label: e.label }); put(e.snap); store.comparing = false; if (store.step === 2) store.step = 3;
  render(); note(`撤销：${e.label}`, { actions: [{ label: "重做", fn: redo }] });
}
export function redo() { const e = store.redo.pop(); if (!e) { note("没有可重做的了"); return; } store.undo.push({ snap: snap(), label: e.label }); put(e.snap); render(); note(`重做：${e.label}`, { undo: true }); }
/** 检查的修法：ops 直接改程序；「不重要」记下；引擎修法（改 SID 的 patch）留不住 → 记下它要忽略的，否则换个种子重排 */
export function applyFix(c, i) {
  const f = c.fixes && c.fixes[i]; if (!f) return;
  if (f.ignore) return edit("这条记为不重要", (s) => { if (!s.ignored.includes(f.ignore)) s.ignored.push(f.ignore); });
  if (f.ops) return planOps(`按「${f.label}」改了`, f.ops);
  if (typeof f.patch === "function") {
    const sid = clone(store.sid); try { f.patch(sid); } catch (e) { console.warn(e); }
    const ig = ((sid.meta && sid.meta.ignored_checks) || []).filter((x) => !store.ignored.includes(x));
    if (ig.length) return edit("这条记为不重要", (s) => { s.ignored.push(...ig); });
    return edit(`按「${f.label}」重排了一次（换了种子）`, (s) => { s.seed += 1; });
  }
}
export const nextSeed = (v) => ((Math.imul((Number(v) || 7) >>> 0, 1103515245) + 12345) >>> 0) % 2147483647;

// ============================================================ 选中 / 视图状态
/** 不在场景树里单独成项的东西（点它出「选中」卡，树里只高亮所属的项） */
export const PARTS = new Set(["passage", "room", "entrance", "goal", "link", "connector", "trail_vertex", "ground"]);
/** 选中（null 取消）：树里的项展开（祖先也展开）；实例记下 inst；空间切到它那一层 */
export function select(t) {
  if (!t) { store.sel = null; render(); return; }
  const v = t.sid_id && volOf(t.sid_id), inst = (v && instanceIdOf(v)) || (INST.test(t.plan_id || "") ? t.plan_id : null);
  const tid = treeIdOf((v && v.plan_id) || t.plan_id) || treeIdOf(t.plan_id);
  store.sel = { type: t.type || null, plan_id: tid || t.plan_id || null, sid_id: t.sid_id || null, part: t.part || null, index: t.index ?? null, p: t.p || null, inst: PARTS.has(t.type) ? null : inst };
  if (tid && !PARTS.has(t.type)) { store.open.add(tid); for (const a of ancestorsOf(tid)) store.collapsed.delete(a); store.closed.delete(findNode(store.plan, tid) && findNode(store.plan, tid).kind === "terrain" ? "terrain" : tid === "spawn" ? "site" : "nodes"); }
  const sp = t && (t.type === "space" || t.type === "passage" || t.type === "room" || ((findNode(store.plan, tid || "") || {}).node || {}).type === "space") && store.sid && spaceOf({ sid_id: t.sid_id, plan_id: tid || t.plan_id });
  if (sp) {
    if (store.stratum !== sp.stratum || t.type === "space") { store.stratum = sp.stratum; if (t.type === "space" || store.interiorLevel >= levelsOf(sp)) store.interiorLevel = 0; }
    if (store.view !== "map" && store.view !== "profile") store.view = "map";
    if (store.view === "profile" && t.type === "space") { sectionTo(Object.assign({}, t, { sid_id: sp.id })); return; }
  }
  render();
}
export function setView(v) { if (v !== store.view) note(null); store.view = v; hidePopup(); renderViews(); }
const TOOL_TIP = { move: "拖形体 / 组 / 地形块 / 空间 / 出生点 = 改它的偏移（按住 Alt 拖重复里的一个 = 只挪这一个）", path: "画一笔 = 加一条连接：两头吸到最近的节点", region: "圈一块 = 加一个生成器（树林 / 田 / 撒房子 / 水池 / 平台）；在地下 / 天上层圈 = 新建一个空间", section: "在图上拉一条线做剖切（15° 吸附，按住 Alt 不吸附）", erase: "点掉一个节点 / 地形块 / 连接；点重复里的一个 = 只去掉这一个" };
export function setTool(t) { if (!TOOL_TIP[t]) t = "move"; store.tool = t; if (t !== "move" && store.view !== "map") store.view = "map"; renderViews(); if (t !== "move") note(TOOL_TIP[t]); }
export function setStratum(st) {
  store.stratum = st;
  const sp = store.sel && store.sid && spaceOf(store.sel);
  if (store.sel && sp && sp.stratum !== st) store.sel = null;
  if (store.interiorLevel >= maxLevels(st) || (st !== "ground" && !sp)) store.interiorLevel = 0;
  if (store.view !== "map" && store.view !== "profile") store.view = "map";
  render();
}
export function setInteriorLevel(s) { store.interiorLevel = clamp(s | 0, 0, 2); renderViews(); renderSide(); }
const maxLevels = (st) => Math.max(1, ...((store.sid && store.sid.spaces) || []).filter((s) => s.stratum === st).map(levelsOf));
export function levelName(s, n) { return n <= 1 ? "" : s === n - 1 ? "上层" : s === 0 ? "下层" : "中层"; }
export function sOf(space, k) { const n = levelsOf(space), kk = clamp(k | 0, 0, n - 1); return space.stratum === "sky" ? kk : n - 1 - kk; }
export const kName = (k) => (k === 0 ? "入口层" : `第 ${k + 1} 层`);
function setStep(n) { store.step = n; syncChrome(); if (n >= 3) $("#input").placeholder = "说一句要改的，如「法师塔多两座」「书库再飘高一点」「加一座钟楼」"; }

// ============================================================ 提示条 / 小弹窗
let noteTimer = null;
const isDemo = () => !!new URLSearchParams(location.search).get("demo");
export function note(text, { undo: u = false, actions = [] } = {}) {
  const n = $("#note"); clearTimeout(noteTimer);
  if (!text) { n.hidden = true; return; }
  n.replaceChildren(...[el("span", {}, text), u ? el("button", { type: "button", onclick: undo }, "撤销") : null, ...actions.map((a) => el("button", { type: "button", onclick: a.fn }, a.label))].filter(Boolean));
  n.hidden = false;
  if (!isDemo()) noteTimer = setTimeout(() => { n.hidden = true; }, u || actions.length ? 9000 : 5000);
}
export function hint(text) { const n = $("#note"); clearTimeout(noteTimer); if (!text) { n.hidden = true; return; } n.replaceChildren(el("span", {}, text)); n.hidden = false; }
let mapSvg = null;
export function popup(ev, kids, at) {
  const pop = $("#popup"), r = $("#views").getBoundingClientRect();
  pop.replaceChildren(...kids);
  let x = r.width / 2, y = r.height / 2;
  if (ev && ev.clientX != null) { x = ev.clientX - r.left; y = ev.clientY - r.top; }
  else if (mapSvg && at) { try { const pt = mapSvg.createSVGPoint(); pt.x = at[0]; pt.y = at[1]; const q = pt.matrixTransform(mapSvg.getScreenCTM()); x = q.x - r.left; y = q.y - r.top; } catch { /* 中心 */ } }
  pop.style.left = clamp(x + 8, 8, Math.max(8, r.width - 290)) + "px"; pop.style.top = clamp(y + 8, 8, Math.max(8, r.height - 120)) + "px"; pop.hidden = false;
}
export function hidePopup() { $("#popup").hidden = true; }
const chip = (label, on, cls = "chip") => el("button", { type: "button", class: cls, onclick: on }, label);

// ============================================================ 渲染（中栏）
export function render() { renderViews(); renderSide(); }
/** 视图共用的上下文（视图是纯函数：数据进、DOM 出、回调出）。选中按场景树的项高亮整组；空间内部的部件按 sid_id / part */
export function ctx(extra = {}) {
  const s = store.sel;
  let selected = null;
  if (s && (PARTS.has(s.type) || s.type === "space")) selected = { plan_id: s.plan_id || undefined, sid_id: s.sid_id || undefined, part: s.part || undefined, type: s.type || undefined };
  else if (s && s.plan_id) selected = { plan_id: hlId(s.plan_id), type: s.type || undefined };
  return Object.assign({ sid: store.sid, T: store.T, facts: store.facts, checks: store.checks, plan: store.plan, index: store.index, stratum: store.stratum, interiorLevel: store.interiorLevel,
    section: sectionSpec(), selected, diffs: store.diffs, tool: store.tool, eye: store.eye, sectionHandles: store.tool === "move" || store.tool === "section" }, extra);
}
function syncChrome() {
  const has = !!store.plan, cmp = store.comparing, B = document.body;
  B.classList.toggle("has-scene", has); B.classList.toggle("comparing", cmp);
  document.querySelectorAll("#steps li").forEach((li) => { const k = +li.dataset.step; li.className = k < store.step ? "done" : k === store.step ? "now" : ""; });
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === store.view));
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + store.view));
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === store.tool));
  $("#view-map").dataset.tool = store.tool;
  $("#toolbar").dataset.view = $("#views").dataset.view = store.view;
  $("#toolbar").classList.toggle("disabled", !has || cmp);
  $("#btn-undo").disabled = !has || cmp || !store.undo.length; $("#btn-redo").disabled = !has || cmp || !store.redo.length;
  const insetOk = has && !cmp && (store.view === "map" || store.view === "profile");
  $("#btn-inset").disabled = !insetOk; $("#btn-inset").setAttribute("aria-pressed", String(insetOk && !!store.insetOn));
  $("#btn-variants").disabled = !has || cmp; $("#btn-export").disabled = !has;
  const sw = $("#strata-switch");
  sw.hidden = !has || cmp || !(store.view === "map" || store.view === "profile");
  $("#views").classList.toggle("has-switch", !sw.hidden);
  if (!has) return;
  const sp = store.sid.spaces || [], n = (st) => sp.filter((s) => s.stratum === st).length;
  sw.querySelectorAll("[data-stratum]").forEach((b) => { const st = b.dataset.stratum; b.classList.toggle("on", st === store.stratum); b.querySelector("i").textContent = st === "ground" ? "" : n(st) || ""; });
  const N = store.stratum === "ground" ? 1 : maxLevels(store.stratum), lv = $("#level-switch");
  lv.hidden = N <= 1;
  const ks = [...Array(N).keys()]; if (store.stratum === "sky") ks.reverse();
  lv.replaceChildren(...ks.map((k) => el("button", { type: "button", class: k === store.interiorLevel ? "on" : "", "data-level": k, title: `空间内部${kName(k)}：实画这一层，其它层淡画`, onclick: () => setInteriorLevel(k) }, k === 0 ? "入口" : `${k + 1} 层`)));
}
const SAMPLE_NAMES = { academy: "星穹学院", harbor: "海盗港", sky: "空中花园", temple: "沙漠神殿", cyber: "赛博夜市", village: "山城村庄", maze: "矿洞迷宫" };
function welcome() {
  $("#view-map").replaceChildren(el("div", { class: "welcome" }, el("div", { class: "w-title" }, "先说一句你想要的场景"),
    el("div", { class: "hint" }, "AI 先想三个空间组织不同的概念，再各写成一段场景程序（形体、组、重复、地形雕刻、连接）；你挑一个，之后在图上拖、在右边的场景树里改。"),
    el("div", { class: "w-ex" }, ...EXAMPLES.map((t) => el("button", { type: "button", class: "chip", onclick: () => say(t) }, t, aiTag()))),
    el("div", { class: "hint" }, "或者直接打开一段示例程序（本地，不调 AI）："),
    el("div", { class: "w-samples" }, ...Object.keys(SAMPLES).map((k) => el("button", { type: "button", class: "chip sm", "data-sample": k, onclick: () => loadExample(k) }, SAMPLE_NAMES[k])))));
}
function mapCaption() {
  const f = store.facts || {}, sp = (f.spaces && f.spaces.items) || [], st = store.stratum, site = store.plan.site;
  const here = sp.filter((x) => x.stratum === st);
  const dot = (c, l, dash) => el("span", {}, el("i", { class: "sw-dot" + (dash ? " dash" : ""), style: `background:${c}` }), l);
  const G = OPT("site", "ground")[site.ground] || site.ground, hi = f.highest || {};
  const stat = st === "ground"
    ? `${site.size_m[0]}×${site.size_m[1]} m · ${G} · ${f.volumes ?? f.shapes ?? 0} 个形体${f.floating ? ` · 悬空 ${f.floating}` : ""}${hi.y != null ? ` · 最高 ${Math.round(hi.y)} m` : ""}${f.path_length_m ? ` · 路 ${f.path_length_m} m` : ""}`
    : here.length ? here.map((x) => `${x.label}：通道 ${Math.round(x.passage_m || 0)} m · 房间 ${x.rooms || 0}${x.dead_ends ? ` · 死路 ${x.dead_ends}` : ""}${x.longest_route_m ? ` · 入口到终点 ${Math.round(x.longest_route_m)} m` : ""}`).join("；") : `${STRATUM_LABEL[st]}还没有空间：用「圈区域」圈一块`;
  return el("div", { class: "caption" }, st === "ground" ? [dot("#b8452b", "地标"), dot("#1f6feb", "出生点 · 视野"), dot("#8b7d5b", "路 / 桥"), dot("#2a6aa6", "悬空", true)] : [dot("#6b5a8c", "通道"), dot("#c9a227", "终点"), dot("#1f6feb", "入口")], el("span", { class: "stat" }, stat));
}
export function renderViews() {
  syncChrome();
  if (store.comparing) return;
  if (!store.plan) { welcome(); return; }
  const c = ctx();
  let ey = null;
  try { ey = EyeView.renderEye(c); store.eye = ey.facts || {}; c.eye = store.eye; } catch (e) { console.warn(e); }
  if (store.view === "map") {
    const svg = MapView.renderMap(c, {});
    MapView.bindMap(svg, c, mapHandlers);
    $("#view-map").replaceChildren(el("div", { class: "wrap" }, svg, mapCaption())); mapSvg = svg;
  } else if (store.view === "profile") {
    const pr = ProfileView.renderProfile(Object.assign({}, c, { section: sectionCtx() }), profileHandlers);
    bindElevDrag(pr);
    $("#view-profile").replaceChildren(el("div", { class: "pcol" }, pr.node));
  } else if (store.view === "eye") $("#view-eye").replaceChildren(ey ? ey.node : el("div", { class: "hint" }, "第一眼没画出来"));
  else if (store.view === "three") mount3d($("#view-three"), false).then((v) => { if (v && store.view === "three") v.update(ctx()); });
  updateInset();
}
// ---------- 3D（整页与小窗各一个实例，按需加载 three.js）
const views3d = new Map();
function mount3d(host, inset) {
  const key = inset ? "inset" : "page";
  if (!views3d.has(key)) views3d.set(key, import("./views/view3d.js").then((m) => m.mountView3d(host, ctx(), { inset })).then((v) => { store[inset ? "inset" : "three"] = v; return v; }).catch((e) => { views3d.delete(key); note("3D 没加载成功：" + ((e && e.message) || e)); return null; }));
  return views3d.get(key);
}
let INSET = null, corner = 0;
const insetEl = () => INSET || (INSET = $("#inset3d"));
export const insetMode = () => (!store.insetOn || !store.plan || store.comparing ? null : store.view === "map" ? "float" : store.view === "profile" ? "dock" : null);
const insetShown = () => { const m = insetMode(); return !!m && !(m === "float" && store.insetMin); };
function placeInset(box) {
  const host = $("#views"), W = host.clientWidth, H = host.clientHeight, w = box.offsetWidth || 320, h = box.offsetHeight || 240;
  let p = local("scene.inset.pos", null);
  if (!p) { // 人没拖过：在四个角里挑挡住选中 / 地标 / 入口最少的那个
    const left = host.classList.contains("has-switch") ? 64 : 12, xs = [left, left, W - w - 12, W - w - 12], ys = [46, H - h - 12, H - h - 12, 46], hr = host.getBoundingClientRect();
    const keep = mapSvg && mapSvg.isConnected ? [...mapSvg.querySelectorAll(".selection, .landmark, .spawn, [data-section-label]")].map((n) => n.getBoundingClientRect()).filter((r) => r.width || r.height) : [];
    const cost = (i) => keep.reduce((a, r) => a + Math.max(0, Math.min(r.right - hr.left, xs[i] + w) - Math.max(r.left - hr.left, xs[i])) * Math.max(0, Math.min(r.bottom - hr.top, ys[i] + h) - Math.max(r.top - hr.top, ys[i])), 0);
    if (cost(corner) > 0) for (let i = 0; i < 4; i++) if (cost(i) < cost(corner)) corner = i;
    p = { x: xs[corner], y: ys[corner] };
  }
  box.style.left = clamp(Number(p.x) || 0, 0, Math.max(0, W - w)) + "px"; box.style.top = clamp(Number(p.y) || 0, 0, Math.max(0, H - h)) + "px";
}
function updateInset() {
  const box = insetEl(), mode = insetMode();
  box.hidden = !mode; $("#views").classList.toggle("dock", mode === "dock");
  box.classList.toggle("docked", mode === "dock"); box.classList.toggle("min", mode === "float" && !!store.insetMin);
  if (!mode) return;
  if (mode === "dock") { const host = $("#view-profile .pcol"); if (host && box.parentNode !== host) host.append(box); box.style.left = box.style.top = ""; }
  else { if (box.parentNode !== $("#views")) $("#views").insertBefore(box, $("#popup")); placeInset(box); }
  mount3d(box.querySelector(".inset-body"), true).then((v) => {
    if (!v || !insetMode()) return;
    v.update(ctx());
    if (v.setSection) v.setSection(mode === "dock" || store.tool === "section" || (store.section && store.section.mode === "line") ? sectionSpec() : null);
  });
}
function toggleInset() { store.insetOn = local("scene.inset.on", null, !store.insetOn); if (store.insetOn) store.insetMin = local("scene.inset.min", null, false); renderViews(); }
function bindInset() {
  const box = insetEl(), bar = box.querySelector(".inset-bar");
  box.querySelector(".inset-min").addEventListener("click", (e) => { e.stopPropagation(); store.insetMin = local("scene.inset.min", null, true); updateInset(); });
  box.querySelector(".inset-x").addEventListener("click", (e) => { e.stopPropagation(); toggleInset(); });
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button") || box.classList.contains("docked")) return;
    e.preventDefault();
    const r0 = box.getBoundingClientRect(), host = $("#views").getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const mv = (ev) => { const dx = ev.clientX - x0, dy = ev.clientY - y0; if (!moved && Math.hypot(dx, dy) < 3) return; moved = true; box.style.left = clamp(r0.left - host.left + dx, 0, Math.max(0, host.width - r0.width)) + "px"; box.style.top = clamp(r0.top - host.top + dy, 0, Math.max(0, host.height - r0.height)) + "px"; };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (moved) local("scene.inset.pos", null, { x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 }); else if (store.insetMin) { store.insetMin = local("scene.inset.min", null, false); updateInset(); } };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });
}

// ============================================================ 三张卡（第 2 步）：每张 = 一个空间概念（名字 + 一句话 + 关键结构），差异按结构比较
/** 一段程序的结构摘要：[{key, label}]（基础地形、雕刻、重复的排法、连接样式、生成器、悬空），key 用来比较三张的不同 */
export function structTokens(p) {
  const out = [], seen = new Set(), add = (key, label) => { if (label && !seen.has(key) && !out.some((t) => t.label === label)) { seen.add(key); out.push({ key, label }); } };
  const site = p.site || {}, TY = OPT("node", "type"), PAT = OPT("node", "pattern"), STY = OPT("node", "style"), OP = OPT("terrain_op", "op");
  add(`g:${site.ground || "flat"}`, OPT("site", "ground")[site.ground || "flat"] || site.ground);
  for (const t of (p.terrain || []).slice(0, 3)) add(`t:${t.op}${t.edge === "cliff" || t.edge === "terraced" ? ":" + t.edge : ""}`, t.label || OP[t.op] || t.op);
  let float = 0;
  const walk = (list) => { for (const n of list || []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "repeat") { const c = expand({ nodes: [n] }).filter((e) => e.instance_of === n.id && e.id === `${n.id}[${e.k}]`).length; add(`r:${n.pattern || "linear"}`, `${(n.child && n.child.label) || n.label || "重复"} ${PAT[n.pattern] || ""} × ${c}`); }
    else if (n.type === "link") add(`l:${n.style || "path"}`, STY[n.style || "path"] || n.style);
    else if (n.type === "space") add(`s:${n.stratum || "underground"}:${n.layout || "chamber"}`, `${n.stratum === "sky" ? "天上" : "地下"}${(n.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[n.layout || "chamber"] || ""}`);
    else if (["terraces", "scatter_houses", "grove", "field"].includes(n.type)) add(`gen:${n.type}`, TY[n.type] || n.type);
    else if (n.type === "courtyard" || n.type === "wall") add(`p:${n.type}`, TY[n.type]);
    if (n.type === "island" || (n.elev_m || 0) > 2) float++;
    walk(n.children); if (n.child) walk([n.child]);
  } };
  walk(p.nodes);
  if (float) add("float", `悬空 ${float} 处`);
  return out.slice(0, 9);
}
function showCompare() {
  const C = store.cards, n = C.plans.length;
  const toks = C.plans.map((p, i) => ((C.diversity && C.diversity.organization && C.diversity.organization[i]) || []).map((o) => ({ key: `o:${o}`, label: o, org: true })).concat(structTokens(p)));
  const cnt = new Map();
  toks.forEach((ts) => new Set(ts.map((t) => t.key)).forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1)));
  const grid = el("div", { class: "cmp-grid" }, ...C.plans.map((p, i) => {
    const r = C.compiled[i], f = (r && r.facts) || {}, c = (C.concepts && C.concepts[i]) || {};
    let thumb;
    try { thumb = MapView.renderMap({ sid: r.sid, T: r.T, plan: r.plan, index: r.index, facts: f, checks: r.checks, stratum: "ground", interiorLevel: 0, selected: null, diffs: [], section: null }, { small: true }); thumb.setAttribute("class", "cmp-map"); }
    catch (e) { thumb = el("div", { class: "hint" }, "（缩略图没画出来）"); }
    const pick_ = () => pick(i), keys = c.key_structures || p.key_structures || [];
    return el("div", { class: "cmp", tabindex: 0, role: "button", title: "选这个", "data-card": i, onclick: pick_, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick_(); } } },
      thumb, el("b", {}, c.name || p.name || `方案 ${i + 1}`), el("div", { class: "one" }, c.concept || p.concept || ""),
      keys.length ? el("div", { class: "keys" }, el("span", { class: "kk" }, "关键结构"), keys.slice(0, 6).map((k) => el("span", { class: "key" }, k))) : null,
      el("div", { class: "tags comp" }, toks[i].map((tk) => el("span", { class: "tag" + (tk.org ? " org" : "") + (cnt.get(tk.key) === 1 && n > 1 ? " diff" : ""), "data-key": tk.key }, tk.label))),
      c.why_different ? el("div", { class: "hint why" }, c.why_different) : null,
      el("div", { class: "hint stat" }, `${f.volumes ?? f.shapes ?? 0} 个形体${f.floating ? ` · 悬空 ${f.floating}` : ""} · 最高 ${Math.round((f.highest || {}).y || 0)} m${f.path_length_m ? ` · 路 ${f.path_length_m} m` : ""}${r && r.warnings && r.warnings.length ? ` · ${r.warnings.length} 处已就近处理` : ""}`));
  }));
  const dv = C.diversity, same = dv ? (dv.org_min != null ? dv.org_min < 1 : dv.min < 1) : !distinctPlans(C.plans, 1);
  const head = [C.locked ? `换一批：锁住的 ${C.locked} 项三张都保留。` : "", same ? "三张的空间组织差别不大，可以换个说法再出。" : "蓝色是空间组织，黄底是只有这一张才有的结构。"].filter(Boolean).join(" ");
  const foot = el("div", { class: "cmp-foot" }, el("button", { type: "button", class: "ubtn", onclick: redraft }, "三个都不要，重出", aiTag()),
    store.plan ? el("button", { type: "button", class: "ubtn", onclick: keepCurrent }, "都不要，回到现在这张") : null);
  store.comparing = true; store.view = "map";
  $("#view-map").replaceChildren(el("div", { class: "compare" }, el("div", { class: "cmp-head" + (same ? " warn" : "") }, head), grid, foot));
  mapSvg = null; hidePopup(); syncChrome(); updateInset(); renderSide();
}

// ============================================================ 聊天（只用来和 AI 说话；本地操作不写这里）
export const aiTag = () => el("span", { class: "ai-tag", title: "点了会调用 AI" }, "调 AI");
function scrollLog(m) { const log = $("#log"); if (log.scrollHeight - log.scrollTop - log.clientHeight < 80 || log.lastElementChild === m) log.scrollTop = 1e9; }
export function msg(who, text, attach) {
  const m = el("div", { class: "msg " + who }, who === "sys" ? null : el("div", { class: "who" }, who === "ai" ? "AI" : "你"), text);
  if (attach) m.append(el("div", { class: "attach" }, attach));
  $("#log").append(m); scrollLog(m); return m;
}
export const sys = (t) => msg("sys", t);
function settle(btn) { const box = btn && btn.closest(".attach, .msg"); if (box) box.querySelectorAll("button").forEach((b) => { b.disabled = true; }); if (btn) btn.classList.add("on"); }
function chips(labels, onPick, { tag } = {}) { return el("div", { class: "chiprow" }, ...labels.map((l) => el("button", { type: "button", class: "chip", onclick: (ev) => { settle(ev.currentTarget); onPick(l); } }, l, tag && tag(l) ? aiTag() : null))); }
const ERR_TEXT = { offline: "本地服务没响应（它关了？）", auth: "密钥无效或过期", model: "模型名不对", rate: "请求太频繁或余额不足", busy: "模型繁忙", timeout: "等太久了（超过时限没回来）", net: "连不上 AI 服务商（网络 / 代理）", server: "服务出错" };
function thinking(t, onCancel) {
  const txt = el("span", { class: "txt" }, t), sec = el("span", { class: "sec" });
  const m = el("div", { class: "msg ai thinking" }, el("div", { class: "who" }, "AI"), txt, sec, onCancel ? el("button", { type: "button", class: "chip mini", onclick: (ev) => { settle(ev.currentTarget); onCancel(); } }, "取消") : null);
  $("#log").append(m); scrollLog(m);
  const t0 = Date.now(), tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); if (s >= 3) sec.textContent = ` ${s} s`; }, 1000);
  const stop = () => { clearInterval(tick); m.classList.remove("thinking"); };
  return {
    done(text, attach) { stop(); m.replaceChildren(el("div", { class: "who" }, "AI"), text); if (attach) m.append(el("div", { class: "attach" }, attach)); scrollLog(m); },
    fail(e, retry) {
      stop();
      if (e && e.kind === "cancel") { m.className = "msg sys"; m.replaceChildren("已取消。"); return; }
      const kind = e && e.kind, d = (e && e.data) || {};
      m.replaceChildren(el("div", { class: "who" }, "AI"), ERR_TEXT[kind] || "AI 调用失败", el("details", { class: "raw" }, el("summary", {}, "原始信息"), [d.hint, e && e.message].filter(Boolean).join("\n") || String(e)));
      m.append(el("div", { class: "attach" }, chips(["重试", "打开 AI 设置"].concat(kind !== "offline" ? ["这次用模拟 AI"] : []), (l) => {
        if (l === "重试") retry && retry(); else if (l.startsWith("打开")) openSettings(); else { store.mock = true; sys("这一页之后都用模拟 AI（不花钱），刷新页面换回。"); retry && retry(); }
      }, { tag: (l) => l === "重试" })));
      if (kind === "auth" || kind === "offline") markPill(kind);
      scrollLog(m);
    },
  };
}
const PROV = { deepseek: "DeepSeek", claude: "Claude", anthropic: "Claude", mock: "模拟 AI" };
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
/** 一次 AI 动作一行（draft 是三步：构思 + 3 份展开，合计）：「DeepSeek flash · 构思 + 展开 ×3 · 21.4 s · 18.2k token · ¥0.012」；模拟写「不花钱」 */
export function usageLine(d) {
  if (!d) return;
  const u = d._usage || {}, ms = d._ms ?? u.ms ?? 0, steps = Array.isArray(d._steps) ? d._steps : [];
  const nEx = steps.filter((s) => s.step === "expand").length, how = steps.some((s) => s.step === "concepts") ? `构思 + 展开 ×${nEx || 3}` : "";
  const who = `${PROV[d.provider] || d.provider || "AI"}${d.provider !== "mock" && u.model ? " " + String(u.model).replace(/^deepseek-|^claude-/, "") : ""}`;
  if (d.provider === "mock") { sys([who, how, `${(ms / 1000).toFixed(1)} s`, "不花钱"].filter(Boolean).join(" · ")); return; }
  const cost = u.cost_cny != null ? (u.cost_cny < 0.001 ? "<¥0.001" : `¥${u.cost_cny.toFixed(3)}`) : u.cost_usd != null ? `$${u.cost_usd.toFixed(3)}` : "";
  sys([who, how, `${(ms / 1000).toFixed(1)} s`, `${fmtK((u.input || 0) + (u.output || 0))} token`, cost].filter(Boolean).join(" · "));
}
/** 服务端从这句话里读出的硬条件：「按你的话锁定：迷宫、浮岛（三张都照办）」 */
function lockedLine(d, three = true) {
  const c = (d && Array.isArray(d.constraints) ? d.constraints : []).filter(Boolean);
  if (!c.length) return;
  const n = (d.constraints_fixed || []).reduce((k, x) => k + (Array.isArray(x.fields) ? x.fields.length : 1), 0);
  sys(`按你的话锁定：${c.join("、")}${three ? "（三张都照办）" : ""}${n ? `（AI 有 ${n} 处没照办，已补上）` : ""}`);
}

// ============================================================ /api（本地 Python 服务；密钥不经过这里）
async function call(method, path, body, { timeoutMs = 30000, signal } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  if (signal) { if (signal.aborted) ac.abort("cancel"); else signal.addEventListener("abort", () => ac.abort("cancel"), { once: true }); }
  let res;
  try { res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal }); }
  catch (e) { const err = new Error((e && e.message) || String(e)); err.kind = ac.signal.aborted ? (ac.signal.reason === "cancel" ? "cancel" : "timeout") : "offline"; throw err; }
  finally { clearTimeout(t); }
  let data = null;
  try { data = await res.json(); } catch { data = { message: `HTTP ${res.status}` }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`), st = data.status || res.status, m = String(data.message || "");
    err.status = res.status; err.data = data;
    err.kind = st === 401 || st === 403 ? "auth" : (st === 404 || st === 400 || st === 422) && /model/i.test(m + (data.hint || "")) ? "model" : st === 429 || st === 402 ? "rate" : st === 529 || st === 503 || /overloaded/i.test(m) ? "busy" : /APIConnectionError|APITimeoutError/.test(m) ? "net" : "server";
    throw err;
  }
  return data;
}
/** 连不上（offline：请求没发出去）时等一下再试一次；超时 / 取消 / 服务端错误不重试（AI 调用可能已经花钱） */
async function once(fn) {
  try { return await fn(); } catch (e) { if (e.kind !== "offline") throw e; await new Promise((r) => setTimeout(r, 500)); return fn(); }
}
export const API = {
  async health() { try { return await call("GET", "/api/health", null, { timeoutMs: 5000 }); } catch { return null; } },
  config: () => call("GET", "/api/config", null, { timeoutMs: 10000 }),
  setConfig: (patch) => call("POST", "/api/config", patch),
  testKey: (api_key, opts = {}) => call("POST", "/api/config/test", Object.assign(api_key ? { api_key } : {}, opts), { timeoutMs: 45000 }),
  draft: (intent, { locked = null, variant = 0 } = {}, signal) => once(() => call("POST", "/api/ai/draft", Object.assign({ intent, variant }, locked ? { locked } : {}, store.mock ? { force_mock: true } : {}), { timeoutMs: 240000, signal })),
  revise: (plan, text, signal) => once(() => call("POST", "/api/ai/revise", Object.assign({ plan, action: { type: "text", text }, locked: { ids: plan.locks || [] } }, store.mock ? { force_mock: true } : {}), { timeoutMs: 90000, signal })),
  validate: (doc, schema = "sid") => call("POST", "/api/validate", { doc, schema }, { timeoutMs: 30000 }),
  score: (intent, readback) => call("POST", "/api/score", { intent, readback, auto_map: true }),
};

// ============================================================ 说 / 选 / 改（调 AI 的只有这三处：发送、重出、换一批）
function busy(on) { store.busy = Math.max(0, store.busy + (on ? 1 : -1)); document.body.classList.toggle("busy", store.busy > 0); $("#send-label").textContent = store.busy > 0 ? "排队" : "发送"; }
function flush() { if (!store.busy && store.pending) { const q = store.pending; store.pending = null; say(q); } }
export function say(t) {
  if (store.busy) { store.pending = t; sys("AI 还在想，这句排在后面。"); return; }
  msg("user", t);
  if (store.plan && !store.comparing) onText(t); else onIntent(t);
}
function setCards(d, locked = 0) {
  const plans = d.plans.map((p) => normalizePlan(p).plan);
  store.cards = { plans, concepts: d.concepts || [], diversity: d.diversity || null, compiled: plans.map(compileCard), locked };
}
export async function onIntent(text, variant = 0) {
  store.intent = text;
  const ac = new AbortController(), th = thinking("先想三个空间组织不同的概念，再各写成一段场景程序", () => ac.abort());
  busy(true);
  try {
    const d = await API.draft(text, { variant }, ac.signal);
    setCards(d);
    th.done(`三个概念：${store.cards.concepts.map((c, i) => c.name || store.cards.plans[i].name).join(" / ")}。点一个就开始改。`);
    lockedLine(d);
    if (d.warnings && d.warnings.length) sys(`有 ${d.warnings.length} 处引用对不上，已就近处理。`);
    if (d._concepts_fallback) sys("构思那一步没用上 AI 的回答，概念改用了本地的。");
    usageLine(d);
    setStep(2); showCompare();
  } catch (e) { th.fail(e, () => onIntent(text, variant)); } finally { busy(false); flush(); }
}
function redraft() { if (!store.intent) return; store.variantN += 1; msg("user", "三个都不要，重出"); onIntent(store.intent, store.variantN); }
function fresh(s) { s.comparing = false; s.sel = null; s.diffs = []; s.readback = null; s.corrections = []; s.step = 3; s.section = null; s.ignored = []; s.open = new Set(); s.collapsed = new Set(); s.stratum = "ground"; s.interiorLevel = 0; }
export function pick(i) {
  const C = store.cards, plan = C && C.plans[i];
  if (!plan) return;
  const name = (C.concepts[i] && C.concepts[i].name) || plan.name;
  setStep(3);
  if (!store.plan) {
    store.plan = clone(plan); fresh(store); store.undo = []; store.redo = [];
    const r = C.compiled[i]; if (r) Object.assign(store, { plan: r.plan, sid: r.sid, T: r.T, checks: r.checks, facts: r.facts, index: r.index, warnings: r.warnings }); else recompute();
    render(); note(`选了「${name}」`); return;
  }
  edit(`换成「${name}」`, (s) => { s.plan = clone(plan); fresh(s); });
}
function keepCurrent() { store.comparing = false; setStep(3); render(); }
/** 打开一段示例程序（本地，不调 AI；可撤销） */
export async function loadExample(key) {
  const file = SAMPLES[key] || key;
  let p;
  try { p = await fetch(`../spec/examples/plans/${file}.plan.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }); }
  catch (e) { note(`示例没读到（${e.message}）`); return false; }
  const plan = normalizePlan(p).plan;
  store.intent = plan.concept || plan.name; store.cards = null;
  if (!store.plan) { store.plan = plan; fresh(store); store.undo = []; store.redo = []; recompute(); setStep(3); render(); }
  else { setStep(3); edit(`打开示例「${plan.name}」`, (s) => { s.plan = plan; fresh(s); }); }
  sys(`打开了示例程序「${plan.name}」（本地，不调 AI）`);
  return true;
}

/** 改：一句话 → AI 回程序的 ops（set / add / remove）→ 本地应用（锁住的项不动、可撤销） */
async function onText(t) {
  const plan0 = store.plan, ac = new AbortController();
  if (store.inflight) store.inflight.abort();
  store.inflight = ac;
  const th = thinking("在想怎么改", () => ac.abort());
  busy(true);
  try {
    const r = await API.revise(plan0, t, ac.signal);
    const locks = new Set(store.plan.locks || []), kept = [];
    const base = (id) => { const m = INST.exec(String(id || "")); return m ? m[1] : id; };
    const ops = (r.ops || []).filter((o) => { const hit = o && (o.op === "set" || o.op === "remove") && locks.has(base(o.id)); if (hit) kept.push(base(o.id)); return !hit; });
    const has = r.understood !== false && ops.length > 0;
    const ok = has && planOps(`AI：${short(r.restatement || "改了")}`, ops);
    // 服务端已经把锁住的项的改动拿掉了（ops 空）：句子里点了锁住的项的名字时，直说没改它，别照念 AI 的复述
    const named = [...locks].filter((id) => { const n = (findNode(store.plan, id) || {}).node || {}; return [n.label, n.child && n.child.label].some((l) => l && l.length >= 2 && t.includes(l)); });
    let text = !has && named.length ? `「${named.map(labelOf).join("、")}」你锁住了，这句没改它（要改先在场景树里解锁）` : r.restatement || (has ? "好。" : "这句我没把握翻成程序上的改动。");
    if (kept.length) text += `（你锁住的${[...new Set(kept)].map(labelOf).join("、")}没动）`;
    if (has && !ok) text += "（算出来和原来一样，图没变）";
    if (store.opWarnings && store.opWarnings.length) { text += `（${store.opWarnings.length} 处没法照办，跳过了）`; store.opWarnings = null; }
    const onOpt = (o) => { const tl = { 画一笔: "path", 圈一块: "region", 拖一下: "move" }[o]; if (tl) setTool(tl); else say(o); };
    const pts = ["画一笔", "圈一块", "拖一下"];
    const attach = r.question ? el("div", {}, el("div", { class: "hint" }, r.question), r.ask_to_point ? chips(pts, onOpt) : null) : r.ask_to_point ? chips(pts, onOpt) : null;
    th.done(text, attach);
    lockedLine(r, false);
    usageLine(r);
  } catch (e) { th.fail(e, () => onText(t)); } finally { if (store.inflight === ac) store.inflight = null; busy(false); flush(); }
}

// ---------- 换一批：三个新概念；锁住的项（场景树里点了锁的）三张都保留（服务端按 locked 合进去）
export async function variants() {
  if (!store.plan) return;
  const base = store.plan, locks = base.locks || [];
  msg("user", locks.length ? `换一批（锁住的 ${locks.length} 项保留）` : "换一批");
  const ac = new AbortController(), th = thinking("换三个新的空间概念", () => ac.abort());
  busy(true);
  try {
    store.variantN += 1;
    const d = await API.draft(store.intent || base.concept || base.name, { locked: { plan: base, ids: locks }, variant: store.variantN }, ac.signal);
    setCards(d, locks.length);
    th.done(`三个新概念：${store.cards.concepts.map((c, i) => c.name || store.cards.plans[i].name).join(" / ")}。`);
    usageLine(d);
    setStep(2); showCompare();
  } catch (e) { th.fail(e, () => variants()); } finally { busy(false); flush(); }
}

// ============================================================ 俯视图手势（全部本地、可撤销、不写聊天）
// 按住 Alt：拖重复里的一个实例 = 只挪这一个（写进重复的 overrides[k]）；不按 = 整个重复一起挪（改重复的 offset_m）
let altHeld = false;
for (const ev of ["pointerdown", "pointermove", "pointerup", "keydown", "keyup"]) addEventListener(ev, (e) => { altHeld = !!e.altKey; }, true);
const DRAG = new Set(["landmark", "spawn", "house", "shape", "feature", "space", "section_a", "section_b", "section_mid"]);
/** 拖这个目标改的是哪一项的偏移：节点 / 实例（Alt）/ 重复 / 地形操作 / 空间 / spawn；不能拖 → null */
export function moveIdOf(t, alt = false) {
  if (!t || !store.plan) return null;
  if (t.type === "spawn") return "spawn";
  if (t.type === "feature" || t.type === "space") { const id = t.plan_id && t.plan_id !== "site" ? treeIdOf(t.plan_id) : null; return id && id !== "site" ? id : null; }
  const v = volOf(t.sid_id);
  if (!v) return treeIdOf(t.plan_id);
  const inst = instanceIdOf(v);
  if (inst) return alt ? inst : INST.exec(inst)[1];
  const f = v.plan_id && findNode(store.plan, v.plan_id);
  return f && !f.template ? v.plan_id : null;
}
/** 把「整体挪 delta」换算成新的 offset_m：offsetFromPoint 是仿射的，两点之差就是父坐标系里的偏移增量 */
export function offsetAfter(id, delta) {
  const plan = store.plan, o0 = offsetFromPoint(plan, id, [0, 0]), o1 = offsetFromPoint(plan, id, delta);
  if (!o0 || !o1) return null;
  const f = id === "spawn" ? { node: plan.spawn || {} } : findNode(plan, id);
  if (!f) return null;
  const cur = f.kind === "instance" ? ((f.rep.overrides || {})[String(f.k)] || {}).offset_m : f.node.offset_m, c = Array.isArray(cur) ? cur : [0, 0];
  const dx = o1[0] - o0[0], dz = o1[o1.length - 1] - o0[o0.length - 1], lim = (x) => r1(clamp(x, -500, 500));
  return c.length >= 3 ? [lim(c[0] + dx), c[1], lim(c[2] + dz)] : [lim(c[0] + dx), lim(c[1] + dz)];
}
function startOf(t) {
  if (t.type === "spawn") { const m = MapView.spawnOf(store.sid); return m && [m.position[0], m.position[2]]; }
  const v = volOf(t.sid_id); if (v) return [v.position[0], v.position[2]];
  const g = t.plan_id && resolveTarget(store.sid, store.T, t.plan_id); return g && g.point;
}
function dragEnd(t, p, info = {}) {
  if (/^section_/.test(t.type)) { if (info.line) edit(`剖切线 ${info.length_m ?? ""} m · ${info.angle_deg ?? ""}°`, (s) => setSection(s, { mode: "line", line: info.line }), { geometry: false }); return; }
  const alt = info.alt ?? altHeld, id = moveIdOf(t, alt);
  if (!id) { note(t.type === "portal" ? "传送门在连接的两头：改连接的「从 / 到」" : "这个不能拖：在右边的场景树里改"); renderViews(); return; }
  const a = startOf(t), d = Array.isArray(info.delta) ? info.delta : a ? [p[0] - a[0], p[1] - a[1]] : [0, 0], dist = Math.round(Math.hypot(d[0], d[1]));
  const off = offsetAfter(id, d);
  if (!off) { note("这个的坐标系没找到，没挪"); renderViews(); return; }
  const v = volOf(t.sid_id), inst = INST.exec(id), whole = !inst && v && instanceIdOf(v);
  const what = inst ? `${labelOf(id)}（只挪这一个）` : whole ? `${labelOf(id)}（整组 ${expand(store.plan).filter((e) => e.instance_of === id && e.id === `${id}[${e.k}]`).length} 个）` : labelOf(id);
  const ok = planOps(`${what}挪了 ${dist} m → 偏移 ${off.map(r1).join(", ")} m`, [{ op: "set", id, field: "offset_m", value: off }]);
  // 拖完选中它（树里展开）；空间不切图层（拖的时候人在看地面）
  if (ok && t.type !== "space") { const s = store.sel; if (!s || hlId(s.plan_id) !== treeIdOf(id)) select(Object.assign({}, t, { plan_id: id })); }
}
/** 擦掉图上的东西：实例 → 只去掉这一个（重复的 skip）；节点 / 地形 / 连接 / 空间 → 删整项 */
function removeTarget(t) {
  if (!t || !store.plan) return;
  if (t.type === "spawn") return note("出生点不能删，可以拖");
  if (PARTS.has(t.type)) return note("这是空间内部的一部分：在场景树里改布局，或「换一个」");
  const v = volOf(t.sid_id), inst = v && instanceIdOf(v);
  const id = inst || treeIdOf((v && v.plan_id) || t.plan_id);
  if (!id || id === "site") return note("这个没法单独删（基础地形在「场地」里换）");
  return removePlanItem(id);
}
export function removePlanItem(id) {
  if (id === "spawn" || id === "site") { note("出生点和场地不能删"); return false; }
  const f = findNode(store.plan, id);
  if (!f) { note("没找到这一项"); return false; }
  if (f.template) { note(`这是重复的模板：要删就删整个「${labelOf(f.parent.id)}」`); return false; }
  if (f.kind === "node" && !f.parent && (store.plan.nodes || []).length <= 1) { note("至少要留一个节点"); return false; }
  const name = labelOf(id), ok = planOps(f.kind === "instance" ? `去掉了${name}（只这一个）` : `删了${name}`, [{ op: "remove", id }]);
  if (ok && store.sel && (store.sel.plan_id === id || store.sel.inst === id)) { store.sel = null; render(); }
  return ok;
}
export function removeSelected() { const s = store.sel; if (!s) return; if (s.inst) return removePlanItem(s.inst); if (s.plan_id) return removePlanItem(s.plan_id); }
/** 画路：两头吸到最近的节点（体块中心 / 出生点 / 地形块），加一条连接 */
function nearestRef(p, not) {
  let best = null, bd = Infinity;
  const cand = (ref, q) => { if (!ref || ref === not || !q) return; const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = ref; } };
  const sp = MapView.spawnOf(store.sid); if (sp) cand("spawn", [sp.position[0], sp.position[2]]);
  for (const v of store.sid.volumes) { if (!v.plan_id || v.generated) continue; const inst = instanceIdOf(v), f = findNode(store.plan, v.plan_id); cand(inst || (f && !f.template && f.kind !== "instance" ? v.plan_id : null), [v.position[0], v.position[2]]); }
  for (const t of store.plan.terrain) { const g = resolveTarget(store.sid, store.T, t.id); if (g) cand(t.id, g.point); }
  return best;
}
const GEN_CHOICES = [["grove", "树林"], ["field", "田"], ["scatter_houses", "撒房子"], ["water", "水池"], ["platform", "平台"]];
/** 加一个根节点并把它的原点放在世界点 at（锚在场地中心，偏移反算）；extra 覆盖默认值 */
function addRootAt(s, type, point, extra) {
  const e = Object.assign(newElement("node", type, s.plan), extra);
  e.at = "site.C"; delete e.offset_m;
  let p = applyOps(s.plan, [{ op: "add", to: "root", value: e }]).plan;
  const off = offsetFromPoint(p, e.id, point);
  if (off) p = applyOps(p, [{ op: "set", id: e.id, field: "offset_m", value: off.map(r1) }]).plan;
  s.plan = p;
  s.sel = { type: type === "space" ? "space" : "node", plan_id: e.id, sid_id: null }; s.open.add(e.id);
  return e;
}
export const mapHandlers = {
  tool: () => store.tool,
  canDrag: (t) => !!store.plan && DRAG.has(t && t.type) && (/^section_/.test(t.type) || !!moveIdOf(t, false)),
  onGesture(on) { document.body.classList.toggle("gesturing", !!on); },
  onDragCancel() { hint(null); renderViews(); },
  onDrag(t, p, info = {}) {
    if (/^section_/.test(t.type) && info.line) { hint(`剖切线 ${info.length_m} m · ${info.angle_deg}°`); if (store.inset && store.inset.setSection) store.inset.setSection({ mode: "line", line: info.line, width_m: sectionSpec().width_m }); return; }
    const d = info.delta || [0, 0], id = moveIdOf(t, altHeld), inst = id && INST.test(id);
    hint(`→ 挪 ${Math.round(Math.hypot(d[0], d[1]))} m${inst ? "（只挪这一个）" : id && volOf(t.sid_id) && instanceIdOf(volOf(t.sid_id)) ? "（整组；按住 Alt 只挪这一个）" : ""}`);
  },
  onDragEnd(t, p, info) { hint(null); dragEnd(t, p, info || {}); },
  onSelect(t, p) { select(!t || t.type === "ground" ? { type: "ground", p } : t); },
  onSection(line, info = {}) { edit(`剖切线 ${info.length_m ?? Math.round(Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]))} m`, (s) => setSection(s, { mode: "line", line }), { geometry: false, actions: store.view === "profile" ? [] : [{ label: "看剖面", fn: () => setView("profile") }] }); },
  onPath(points, ev) {
    const kind = classifyStroke(points);
    if (kind === "tap") return;
    if (kind === "loop") return mapHandlers.onRegion(points, ev);
    if (store.stratum !== "ground") { note("地下 / 天上的通道由空间布局生成：在场景树里改布局、岔路，或「换一个」"); return; }
    const from = nearestRef(points[0]), to = nearestRef(points[points.length - 1], from);
    if (!from || !to) { note("两头没找到可以连的东西"); return; }
    let id = null;
    edit(() => `加了一条路：${labelOf(from)} → ${labelOf(to)}（样式在场景树里改）`, (s) => {
      const e = Object.assign(newElement("node", "link", s.plan), { from, to, style: "path", label: "小路" });
      id = e.id; s.plan = applyOps(s.plan, [{ op: "add", to: "root", value: e }]).plan;
      s.sel = { type: "node", plan_id: id }; s.open.add(id);
    });
  },
  onRegion(points, ev) {
    const r = strokeToPolygon(points, { T: store.T, maxPoints: 10 });
    if (!r.polygon || r.polygon.length < 3 || r.area_m2 < 20) { note("圈得太小了，再圈大一点"); return; }
    const c = r.centroid || polygonCentroid(r.polygon), xs = r.polygon.map((q) => q[0]), zs = r.polygon.map((q) => q[1]);
    const w = Math.max(6, Math.round(Math.max(...xs) - Math.min(...xs))), d = Math.max(6, Math.round(Math.max(...zs) - Math.min(...zs)));
    const st = store.stratum, tip = (t) => el("span", { class: "hint" }, t), area = Math.round(r.area_m2);
    if (st !== "ground") {
      const L = st === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL;
      popup(ev, [tip(`圈了 ${area} m²，${STRATUM_LABEL[st]}的这块是：`), ...INTERIOR_LAYOUTS[st].filter((k) => k !== "rooms").map((k) => chip(L[k], () => {
        hidePopup();
        edit(`加了${STRATUM_LABEL[st]}${L[k]}（${w}×${d} m）`, (s) => { addRootAt(s, "space", c, { stratum: st, layout: k, label: L[k], size_m: [w, d], under: undefined, over: undefined, connect: { via: st === "sky" ? "ladder" : "stairs" }, ...(st === "sky" ? { elev_m: 12 } : { depth_m: 8 }) }); });
      })), chip("算了", hidePopup)], c);
      return;
    }
    popup(ev, [tip(`圈了 ${area} m²（约 ${w}×${d} m），这块是：`), ...GEN_CHOICES.map(([type, l]) => chip(l, () => {
      hidePopup();
      const size = type === "platform" ? [w, 1, d] : [w, d];
      edit(`圈的这块：${l}（${w}×${d} m）`, (s) => { addRootAt(s, type, c, { label: l, size_m: size }); });
    })), chip("算了", hidePopup)], c);
  },
  onErase(t) { removeTarget(t); },
  onInteriorLevel(k) { setInteriorLevel(k); },
  onDiff(id, ev) { const d = store.diffs.find((x) => x.id === id); if (d) popup(ev, diffButtons(d)); },
};

// ============================================================ 剖面拖动（本地）：每种拖动 → 程序的 ops；拖动中套在副本上重算，只更新 3D 小窗
const featureOf = (id) => ((store.sid && store.sid.terrain.features) || []).find((x) => x.id === id) || null;
const spaceNode = (sidOrPlanId) => { const s = (store.sid.spaces || []).find((x) => x.id === sidOrPlanId || x.plan_id === sidOrPlanId); const f = s && s.plan_id && findNode(store.plan, s.plan_id); return s ? { s, n: f && f.node } : {}; };
/** 拖剖面里悬空的东西：改它（或带着它悬空的祖先）的 elev_m；重复里的实例按 Alt 只改这一个，否则改模板 / 重复 */
function elevTarget(v, alt) {
  const inst = instanceIdOf(v);
  for (const id of [v.plan_id, ...(v.plan_path || []).slice().reverse()]) {
    const m = INST.exec(id || "");
    if (m) {
      const rep = (findNode(store.plan, m[1]) || {}).node; if (!rep) continue;
      if (alt) return { id, field: "elev_m", cur: (((rep.overrides || {})[m[2]] || {}).elev_m) ?? (rep.child && rep.child.elev_m) ?? 0 };
      if (rep.child && rep.child.elev_m != null) return { id: rep.id, field: "child.elev_m", cur: rep.child.elev_m };
      if (rep.elev_m != null) return { id: rep.id, field: "elev_m", cur: rep.elev_m };
      continue;
    }
    const f = id && findNode(store.plan, id);
    if (f && !f.template && f.node.elev_m) return { id, field: "elev_m", cur: f.node.elev_m };
  }
  if (inst) { const m = INST.exec(inst); return alt ? { id: inst, field: "elev_m", cur: 0 } : { id: m[1], field: "elev_m", cur: (findNode(store.plan, m[1]).node.elev_m) || 0 }; }
  const f = findNode(store.plan, v.plan_id);
  return f && !f.template ? { id: v.plan_id, field: "elev_m", cur: f.node.elev_m || 0 } : null;
}
/** 剖面的一次拖动 → { label, ops }（没法改 → null） */
function profileOps(kind, a, b, c) {
  const L = store.plan.site.layer_m;
  if (kind === "layer") { const v = clamp(Math.round(a * 2) / 2, 2, 6); return { label: `每层高 ${v} m`, ops: [{ op: "set", id: "site", field: "layer_m", value: v }] }; }
  if (kind === "terrace") {
    const ft = featureOf(a), f = ft && ft.plan_id && findNode(store.plan, ft.plan_id); if (!f || b == null) return null;
    const n = f.node, name = n.label || n.id;
    if (n.type === "terraces") { const v = clamp(Math.round((b / Math.max(1, ft.level || 1)) * 2) / 2, 1, 12); return { label: `${name}每级高 ${v} m`, ops: [{ op: "set", id: n.id, field: "step_h_m", value: v }] }; }
    if (f.kind === "terrain") { const key = n.op === "lower" || n.op === "lake" || n.op === "carve" ? "depth_m" : "height_m", cur = Number(n[key]) || Math.abs(ft.height) || L; const v = clamp(Math.round((cur + (key === "depth_m" ? ft.height - b : b - ft.height)) * 2) / 2, 0, key === "depth_m" ? 80 : 150); return { label: `${name}${key === "depth_m" ? "深" : "高"} ${v} m`, ops: [{ op: "set", id: n.id, field: key, value: v }] }; }
    return null;
  }
  if (kind === "landmark") { // a = 总高（含屋顶，= SID size[1]），b = plan_id，c = sid_id
    const v = volOf(c) || store.sid.volumes.find((x) => x.plan_id === b); if (!v) return null;
    const inst = instanceIdOf(v), m = inst && INST.exec(inst), id = m ? m[1] : treeIdOf(v.plan_id), f = id && findNode(store.plan, id); if (!f) return null;
    const node = m ? f.node.child : f.node, field = m ? "child.size_m" : "size_m", sz = Array.isArray(node.size_m) ? node.size_m.slice() : [Number(node.size_m) || v.size[0], v.size[1], Number(node.size_m) || v.size[2]];
    sz[1] = clamp(Math.round(a * 2) / 2, 1, 400); return { label: `${labelOf(id)}高 ${sz[1]} m`, ops: [{ op: "set", id, field, value: sz }] };
  }
  if (kind === "space_floor") {
    const { s, n } = spaceNode(a); if (!s || !n) return null;
    if (s.stratum === "underground") { const v = clamp(Math.round(((Number(n.depth_m) || 8) + (s.floor_y - b)) * 2) / 2, 2, 80); return { label: `${s.label}深 ${v} m`, ops: [{ op: "set", id: n.id, field: "depth_m", value: v }] }; }
    const v = clamp(Math.round(((Number(n.elev_m) || 12) + (b - s.floor_y)) * 2) / 2, 0, 200); return { label: `${s.label}离地 ${v} m`, ops: [{ op: "set", id: n.id, field: "elev_m", value: v }] };
  }
  if (kind === "space_height") { const { s, n } = spaceNode(a); if (!s || !n) return null; const v = clamp(Math.round(b * 2) / 2, 2.2, 12); return { label: `${s.label}净高 ${v} m`, ops: [{ op: "set", id: n.id, field: "height_m", value: v }] }; }
  if (kind === "elev") { // a = sid_id，b = 新的离地高度，c = alt
    const v = volOf(a), t = v && elevTarget(v, c); if (!t) return null;
    const nv = clamp(Math.round((t.cur + (b - (v.elev || 0))) * 2) / 2, -60, 200);
    return { label: `${labelOf(t.id)}${t.field.startsWith("child") ? "（整组）" : ""}离地 ${nv} m`, ops: [{ op: "set", id: t.id, field: t.field, value: nv }] };
  }
  return null;
}
const runProfile = (kind, a, b, c) => { const r = profileOps(kind, a, b, c); if (!r) { note("这个没法从剖面改：在场景树里改"); renderViews(); return false; } return planOps(r.label, r.ops); };
let liveAt = 0;
function liveCompile(kind, id, v) { const r = profileOps(kind, ...(kind === "landmark" ? [v, id] : kind === "layer" ? [v] : [id, v])); return r ? compilePlan(applyOps(store.plan, r.ops).plan, { seed: store.seed, ignored: store.ignored }) : null; }
/** 剖面里悬空的形体（data-elev）可以上下拖：改 elev_m（profile.js 只画，不管这个手势） */
function bindElevDrag(pr) {
  const svg = pr.node && (pr.node.tagName === "svg" ? pr.node : pr.node.querySelector("svg.profile")), k = pr.scale && pr.scale.pxPerM;
  if (!svg || !k) return;
  for (const g of svg.querySelectorAll("g[data-elev][data-sid-id]")) {
    const sidId = g.getAttribute("data-sid-id"), e0 = Number(g.getAttribute("data-elev")) || 0;
    g.style.cursor = "ns-resize"; g.setAttribute("data-elev-drag", "");
    let dragged = false;
    g.addEventListener("click", (e) => { if (dragged) { dragged = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const m = svg.getScreenCTM(), sy = m ? m.d || 1 : 1, y0 = e.clientY;
      let dh = 0; dragged = false;
      const mv = (ev) => { const dy = (ev.clientY - y0) / sy; if (!dragged && Math.abs(ev.clientY - y0) < 3) return; dragged = true; dh = -dy / k; g.setAttribute("transform", `translate(0 ${r1(dy)})`); hint(`离地 ${r1(Math.max(0, e0 + dh))} m${altHeld ? "（只这一个）" : ""}`); };
      const up = () => { removeEventListener("pointermove", mv, true); removeEventListener("pointerup", up, true); hint(null); g.removeAttribute("transform"); if (dragged) runProfile("elev", sidId, Math.round((e0 + dh) * 2) / 2, altHeld); };
      addEventListener("pointermove", mv, true); addEventListener("pointerup", up, true);
    });
  }
}
export const profileHandlers = {
  onTerraceHeight(id, h) { if (h == null) { note("这一级按程序高度算：在场景树里改地形"); return; } runProfile("terrace", id, h); },
  onSlope(h) { profileHandlers.onLayerHeight(h); },
  onLayerHeight(h) { runProfile("layer", h); },
  onLandmarkHeight(h, planId, sidId) { if (typeof h === "string") [h, planId] = [planId, h]; runProfile("landmark", h, planId, sidId); },
  onElev(sidId, h, alt) { runProfile("elev", sidId, h, alt ?? altHeld); },
  onSpaceFloor(id, y) { runProfile("space_floor", id, y); },
  onSpaceHeight(id, h) { runProfile("space_height", id, h); },
  onDragHint: (t) => hint(t),
  onDragLive(p) {
    if (!p) { renderViews(); return; }
    if (!store.inset || !insetShown() || performance.now() < liveAt) return;
    const t0 = performance.now();
    try { const R = liveCompile(p.kind, p.id, p.value); if (R) store.inset.update(Object.assign(ctx(), { sid: R.sid, T: R.T })); } catch (e) { console.warn(e); }
    liveAt = performance.now() + Math.max(80, (performance.now() - t0) * 1.5);
  },
  onSectionWidthLive(w) { const sec = sectionSpec(); if (w != null) sec.width_m = w; const band = mapSvg && mapSvg.querySelector(".sec-band"); if (band) band.setAttribute("stroke-width", sec.width_m); if (store.inset && store.inset.setSection && insetShown()) store.inset.setSection(sec); },
  onSectionMode(m) { edit(m === "line" ? "剖切改成直线" : "剖切改回沿主路", (s) => setSection(s, { mode: m }), { geometry: false }); },
  onSectionWidth(w) { edit(`剖切宽 ${widthClamp(w)} m`, (s) => setSection(s, { width_m: w }), { geometry: false }); },
  onSectionRotate(deg) { edit(`剖切线${deg > 0 ? "逆" : "顺"}时针转 ${Math.abs(deg)}°`, (s) => { s.section = rotateSection(sectionSpec(), deg); }, { geometry: false }); },
  onSectionTool() { setView("map"); setTool("section"); },
  onSelect(t) { if (t) select(t); },
  onPick(t, stratum) { if (t) select(Object.assign({}, t, t.id && !t.sid_id ? { sid_id: t.id } : {})); if (stratum && stratum !== store.stratum) setStratum(stratum); },
};

// ============================================================ 演示 / 截图（一律模拟 AI 或本地示例，不花钱）
// ?demo=cards|pick|edit（模拟 draft「我要生成魔法学院」）| academy|harbor|sky|temple|cyber|village|maze（直接打开示例程序）| plan&plan=build/eval/<卡名> | export   [&view=…&level=k&inset=1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let v = null; try { v = fn(); } catch { v = null; } if (v) res(v); else if (Date.now() - t0 > ms) rej(new Error("等不到界面就绪")); else setTimeout(tick, 30); }; tick(); });
async function runDemo(stage, params) {
  const raw = params.get("plan") || "", file = /^[\w./-]+$/.test(raw) && !raw.includes("..") ? (raw.startsWith("build/") ? "../../../" + raw : raw) : null; // ?demo=plan&plan=<spec/examples/plans 下的文件名，或 build/eval/<卡名>（仓库根下的评测卡，都不带 .plan.json）>
  if (SAMPLES[stage] || stage === "export" || file) {
    await loadExample(file || SAMPLES[stage] || "academy");
    if (stage === "maze") {
      let sp = null; for (const e of expand(store.plan)) if (e.type === "space" && !sp) sp = e.node_id;
      if (sp) select({ type: "space", plan_id: sp, sid_id: (spaceOf({ plan_id: sp }) || {}).id });
      if (params.get("level") != null) setInteriorLevel(+params.get("level"));
    } else {
      const rep = expand(store.plan).find((e) => e.type === "repeat" && e.instance_of == null);
      if (rep) { store.open.add(rep.node_id); renderSide(); }
    }
    if (stage === "export") { await sleep(30); openExport(); return; }
  } else {
    const intent = params.get("intent") || EXAMPLES[0];
    msg("user", intent); await onIntent(intent);
    if (stage === "cards") return;
    (await until(() => document.querySelector('.cmp[data-card="0"]'))).click(); await sleep(30);
    if (stage === "edit") {
      const rep = expand(store.plan).find((e) => e.type === "repeat" && e.instance_of == null);
      if (rep) {
        store.open.add(rep.node_id); renderSide();
        const plus = document.querySelector(`#comp .item[data-ref="${rep.node_id}"] .krow[data-path="count"] .plus`); if (plus) plus.click();
        const v = store.sid.volumes.find((x) => x.instance_of === rep.node_id); if (v) select({ type: MapView.volumeType(v), plan_id: v.plan_id, sid_id: v.id });
      }
    }
  }
  const view = params.get("view");
  if (view === "profile") { const lm = MapView.landmarkOf(store.sid); if (lm) sectionTo({ type: "landmark", plan_id: lm.plan_id, sid_id: lm.id }); } // 剖面直接剖过主地标
  if (view) setView(view);
  if (params.get("inset") && !store.insetOn) toggleInset();
}

// ============================================================ 键盘 / 绑定 / 启动
function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName) || $("#settings").open;
  if (e.key === "Escape") {
    if (!$("#popup").hidden) hidePopup(); else if (!$("#modal").hidden) closeModal(); else if (typing) return;
    else if (store.comparing && store.plan) keepCurrent(); else if (store.tool !== "move") setTool("move"); else if (store.sel) select(null);
    return;
  }
  if (typing || !store.plan) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) { e.preventDefault(); if (k === "y" || e.shiftKey) redo(); else undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || !$("#modal").hidden) return;
  const tool = { v: "move", p: "path", r: "region", s: "section", e: "erase" }[k];
  if (tool) { setTool(tool); return; }
  const view = { 1: "map", 2: "profile", 3: "eye", 4: "three" }[e.key];
  if (view && !store.comparing) { setView(view); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && store.sel) { e.preventDefault(); removeSelected(); }
}
function bind() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("#strata-switch [data-stratum]").forEach((b) => b.addEventListener("click", () => setStratum(b.dataset.stratum)));
  $("#btn-undo").addEventListener("click", undo); $("#btn-redo").addEventListener("click", redo);
  $("#btn-inset").addEventListener("click", toggleInset); bindInset();
  $("#btn-variants").addEventListener("click", () => variants());
  $("#btn-export").addEventListener("click", () => openExport());
  $("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
  document.addEventListener("pointerdown", (ev) => { if (!$("#popup").hidden && !$("#popup").contains(ev.target)) hidePopup(); }, true);
  document.addEventListener("keydown", onKey);
  $("#composer").addEventListener("submit", (ev) => { ev.preventDefault(); const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; say(t); });
  bindSettings();
}
/** ui.js 用的动作（ui.js 只 import store 和它，不逐个 import app.js 的函数） */
export const actions = { edit, planOps, select, render, renderViews, note, setView, setInteriorLevel, levelName, kName, labelOf, removePlanItem, removeSelected,
  applyFix, nextSeed, API, sys, ctx, nodeName, sectionSpec, sectionCtx, structTokens, spaceOf, mapHandlers, hidePopup, PARTS, treeIdOf, instanceIdOf, hlId, volOf, OPT, aiTag };
async function start() {
  bind(); setStep(1); render();
  const params = new URLSearchParams(location.search), demo = params.get("demo");
  if (demo) store.mock = true; // 演示 / 截图一律走模拟 AI，不花钱
  await refreshAI();
  if (!store.ai) {
    msg("ai", "本地服务没连上：请用 SceneDialog.exe 或「python desktop/app.py」启动，这个页面要靠它调 AI。");
    const t = setInterval(async () => { await refreshAI(); if (store.ai) { clearInterval(t); sys("本地服务已连上。"); } }, 10000);
  }
  addEventListener("focus", () => { refreshAI(); });
  msg("ai", "说一句你想要的场景：我先想三个空间组织不同的概念，再各写成一段场景程序。之后在图上拖、在右边的场景树里改，只有说话、重出、换一批会调 AI。");
  if (demo) runDemo(demo, params).catch((e) => sys("演示失败：" + e.message));
}
start();

// 调试 / 自动化测试用（唯一的全局）
window.__scene = { store, edit, planOps, undo, redo, select, setView, setTool, setStratum, setInteriorLevel, say, pick, variants, loadExample, structTokens, moveIdOf, offsetAfter, profileOps, applyFix, removePlanItem, openExport, buildBrief, buildPackage, exportSid, render, ctx, sectionSpec, mapHandlers, profileHandlers, API, treeIdOf, instanceIdOf };
