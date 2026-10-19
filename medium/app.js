// app.js — 「场景对话」v4（docs/05 §7）：一个 store + 流程（说 → 选 → 改 → 出）+ 聊天 + 撤销 + 调 AI + 演示。
// 状态只有 store：plan（AI 的构成图，没有坐标）+ user（人在图上的覆盖：拖过 / 删掉的房子、手画的路与通道、圈的地、拖过的连接点、调过的台地）
// + 视图状态。plan 或覆盖一变 → compilePlan → 套覆盖 → 渲染。只有「发送 / 重出 / 换一批」调 AI；其它一切本地、可撤销。
import { compilePlan, applyOps, normalizePlan, resolveTarget, atFromPoint, planDistance, newElement, DIRV } from "./engine/plan.js";
import { resolve, setTerraceHeight } from "./engine/sid.js";
import { relationChecks } from "./engine/relations.js";
import { makeSpace, levelsOf, levelFloor, LAYOUT_LABEL, SKY_LAYOUT_LABEL, STRATUM_LABEL, INTERIOR_LAYOUTS } from "./engine/interior.js";
import { defaultSection, sampleSection, widthClamp, rotateSection } from "./engine/section.js";
import { classifyStroke, strokeToPath, strokeToPolygon, polylineLength } from "./engine/strokes.js";
import { polygonCentroid, pointInPolygon } from "./engine/terrain.js";
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
export const GROUP_KEYS = ["terrain", "zones", "buildings", "landmarks", "paths", "water", "spaces"];
export const EXAMPLES = ["我要生成山城村庄", "半山环台寨，吊脚木楼一圈圈往上长，崖边寨门", "地下有个矿洞，是个两层的迷宫", "寺下有地宫：前厅—甬道—主墓室，两侧耳室", "溪谷两岸，一座风雨桥，傍晚"];

// ============================================================ store
const emptyUser = () => ({ houses: [], removed: [], trail: null, paths: [], regions: [], spaces: [], passages: [], connectors: {}, terraceH: {} });
export const store = {
  step: 1, intent: "", mock: false, ai: null, busy: 0, pending: null, inflight: null,
  plan: null, seed: 7, user: emptyUser(), ignored: [], section: null,       // 可撤销的部分
  sid: null, T: null, checks: [], facts: {}, index: {}, warnings: [], ms: 0, // 编译结果
  cards: null, comparing: false, variantN: 0, axisCursor: 0,               // 三张卡
  sel: null, open: new Set(), closed: new Set(), checksOpen: false,         // 清单展开 / 选中
  view: "map", tool: "move", stratum: "ground", interiorLevel: 0, eye: {},
  insetOn: local("scene.inset.on", false), insetMin: local("scene.inset.min", false), three: null, inset: null,
  diffs: [], readback: null, corrections: [], reference: null, board: null,
  undo: [], redo: [],
};

// ============================================================ 编译：plan + 人的覆盖 → SID
const hasUser = (u) => !!u && (u.houses.length || u.removed.length || u.trail || u.paths.length || u.regions.length || u.spaces.length || u.passages.length || Object.keys(u.connectors).length || Object.keys(u.terraceH).length);
const REMOVED_R = { building: 3, prop: 1.5 };
/** 编译一份 plan 并套上人的覆盖（纯函数：不碰 store）。返回 compilePlan 的形状 */
export function compileWith(plan, user, { seed = 7, ignored = [] } = {}) {
  const C = compilePlan(plan, { seed, ignored });
  if (!hasUser(user)) return C;
  const sid = C.sid;
  for (const [id, h] of Object.entries(user.terraceH)) setTerraceHeight(sid, id, h);
  const mt = sid.paths.find((p) => p.id === "main_trail");
  if (user.trail && mt) { mt.points = clone(user.trail); mt.user_drawn = true; }
  const ids = new Set(sid.paths.map((p) => p.id));
  for (const p of user.paths) if (!ids.has(p.id)) sid.paths.push(clone(p));
  const vids = new Set(sid.volumes.map((v) => v.id));
  for (const h of user.houses) if (!vids.has(h.id)) sid.volumes.push(clone(h));
  for (const r of user.regions) sid.regions.push(clone(r));
  for (const m of sid.markers) { const q = m.kind === "connector" && user.connectors[m.id]; if (q) { m.position = [q[0], m.position[1], q[1]]; m.user_moved = true; } }
  for (const s of user.spaces) { if (sid.spaces.some((x) => x.id === s.id)) continue; const r = makeSpace(s, sid, C.T); if (r) { sid.spaces.push(r.space); sid.markers.push(r.connector); } }
  const R = resolve(sid, { seed });
  if (user.removed.length) sid.volumes = sid.volumes.filter((v) => !(v.generated && v.position && user.removed.some(([x, z, k]) => k === v.kind && Math.hypot(v.position[0] - x, v.position[2] - z) <= (REMOVED_R[k] || 3))));
  for (const p of user.passages) {
    const s = sid.spaces.find((x) => x.id === p.space);
    if (s) (s.passages = s.passages || []).push(Object.assign({}, clone(p), { floor_y: levelFloor(s, p.sublevel | 0), height: s.height }));
  }
  const facts = Object.assign({}, R.facts, { plan: C.facts.plan });
  facts.houses = sid.volumes.filter((v) => v.kind === "building" && v.importance !== "landmark").length;
  facts.trees = sid.volumes.filter((v) => v.kind === "prop").length;
  const checks = R.checks.concat(C.checks.filter((c) => /^place_/.test(c.id)), relationChecks(sid, R.T, C.plan));
  // 索引里的房子按新一轮布房重算（id 可能变了）
  const index = {};
  for (const [pid, e] of Object.entries(C.index)) index[pid] = { group: e.group, sid_ids: e.sid_ids.filter((x) => !C.sid.volumes.some((v) => v.id === x && v.generated)) };
  for (const v of sid.volumes) for (const pid of [v.plan_id, v.zone_id]) if (pid && index[pid] && !index[pid].sid_ids.includes(v.id)) index[pid].sid_ids.push(v.id);
  return Object.assign({}, C, { sid, T: R.T, checks, facts, index });
}
function recompute() {
  const R = compileWith(store.plan, store.user, { seed: store.seed, ignored: store.ignored });
  Object.assign(store, { plan: R.plan, sid: R.sid, T: R.T, checks: R.checks, facts: R.facts, index: R.index, warnings: R.warnings, ms: R.ms });
}

// ============================================================ 剖切
export function sectionSpec() {
  const s = store.section, d = store.sid && store.T ? defaultSection(store.sid, store.T) : null;
  if (!s) return d && clone(d);
  return { mode: s.mode === "line" ? "line" : "trail", line: s.mode === "line" && Array.isArray(s.line) ? clone(s.line) : d && d.line, width_m: widthClamp(s.width_m != null ? s.width_m : d && d.width_m) };
}
/** 剖面用：采样结果 + 剖切本身（mode / line / width_m） */
export function sectionCtx() { const sp = sectionSpec(); return Object.assign(sampleSection(store.sid, store.T, sp), sp); }
const setSection = (s, patch) => { const cur = sectionSpec(); s.section = { mode: patch.mode || cur.mode, line: patch.line ? patch.line.map((q) => [r1(q[0]), r1(q[1])]) : cur.line, width_m: widthClamp(patch.width_m != null ? patch.width_m : cur.width_m) }; };

// ============================================================ 改动：先记、再改、再算、再画，提示条说一句（本地，绝不调 AI）
const snap = () => JSON.stringify({ plan: store.plan, user: store.user, ignored: store.ignored, section: store.section, seed: store.seed });
function put(s) { const o = JSON.parse(s); store.plan = o.plan; store.user = Object.assign(emptyUser(), o.user); store.ignored = o.ignored || []; store.section = o.section || null; store.seed = o.seed; recompute(); }
/** fn(store) 改 plan / user / section；返回 false = 没改。opts.geometry=false 时不重编译（只改剖切） */
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
/** plan 的改动（set / add / remove），本地 */
export function planOps(label, ops, opts) {
  return edit(label, (s) => { const r = applyOps(s.plan, ops); s.plan = r.plan; if (r.warnings.length) s.opWarnings = r.warnings; }, opts);
}
export function undo() {
  const e = store.undo.pop(); if (!e) { note("没有可撤销的了"); return; }
  store.redo.push({ snap: snap(), label: e.label }); put(e.snap); store.comparing = false; if (store.step === 2) store.step = 3;
  render(); note(`撤销：${e.label}`, { actions: [{ label: "重做", fn: redo }] });
}
export function redo() { const e = store.redo.pop(); if (!e) { note("没有可重做的了"); return; } store.undo.push({ snap: snap(), label: e.label }); put(e.snap); render(); note(`重做：${e.label}`, { undo: true }); }
/** 关系检查的修法：plan 修法走 ops；「不重要」记下；引擎修法改的是 SID → 折回 plan / 覆盖（重编译后才留得住） */
export function applyFix(c, i) {
  const f = c.fixes && c.fixes[i]; if (!f) return;
  if (f.ignore) return edit("这条记为不重要", (s) => { if (!s.ignored.includes(f.ignore)) s.ignored.push(f.ignore); });
  if (f.ops) return planOps(`按「${f.label}」改了`, f.ops);
  if (typeof f.patch === "function") return edit(`按「${f.label}」改了`, (s) => absorbPatch(s, f));
}
function absorbPatch(s, f) {
  const old = s.sid, sid = clone(old), ops = [];
  f.patch(sid);
  const moved = (a, b) => a && b && (Math.abs(a[0] - b[0]) > 0.05 || Math.abs(a[2] - b[2]) > 0.05);
  const nudge = (id, place, a, b) => { const n = (place && place.nudge_m) || [0, 0]; ops.push({ op: "set", id, field: "place.nudge_m", value: [r1(clamp(n[0] + b[0] - a[0], -60, 60)), r1(clamp(n[1] + b[2] - a[2], -60, 60))] }); };
  for (const v of sid.volumes) {
    const o = old.volumes.find((x) => x.id === v.id);
    if (!o) { if (!v.generated) s.user.houses.push(Object.assign(clone(v), { locked: true })); continue; }
    if (v.importance === "landmark" && v.plan_id) {
      const l = s.plan.landmarks.find((x) => x.id === v.plan_id);
      if (l && moved(o.position, v.position)) nudge(l.id, l.place, o.position, v.position);
      if (l && o.size[1] !== v.size[1]) ops.push({ op: "set", id: l.id, field: "size_m", value: [v.size[0], v.size[1], v.size[2]] });
    } else if (v.kind === "building" && moved(o.position, v.position)) {
      if (o.generated) s.user.removed.push([r1(o.position[0]), r1(o.position[2]), "building"]);
      s.user.houses = s.user.houses.filter((h) => h.id !== v.id).concat(Object.assign(clone(v), { generated: undefined, locked: true, user_moved: true }));
    }
  }
  const sp0 = old.markers.find((m) => m.kind === "player_spawn"), sp1 = sid.markers.find((m) => m.kind === "player_spawn");
  if (sp0 && sp1 && moved(sp0.position, sp1.position)) nudge("spawn", s.plan.spawn.place, sp0.position, sp1.position);
  const t0 = old.paths.find((p) => p.id === "main_trail"), t1 = sid.paths.find((p) => p.id === "main_trail");
  if (t0 && t1 && JSON.stringify(t0.points) !== JSON.stringify(t1.points)) s.user.trail = clone(t1.points);
  for (const p of sid.paths) if (!old.paths.some((x) => x.id === p.id)) s.user.paths.push(Object.assign(clone(p), { generated: undefined }));
  for (const sp of sid.spaces) { const o = old.spaces.find((x) => x.id === sp.id); if (o && sp.plan_id && JSON.stringify(o.passages) !== JSON.stringify(sp.passages)) ops.push({ op: "set", id: sp.plan_id, field: "layout_seed", value: nextSeed(sp.layout_seed) }); }
  const ig = (sid.meta && sid.meta.ignored_checks) || [];
  for (const id of ig) if (!s.ignored.includes(id)) s.ignored.push(id);
  if (sid.meta && sid.meta.relayout_requests) s.seed += 1;
  if (ops.length) s.plan = applyOps(s.plan, ops).plan;
}
export const nextSeed = (v) => ((Math.imul((Number(v) || 7) >>> 0, 1103515245) + 12345) >>> 0) % 2147483647;

// ============================================================ 选中 / 视图状态
/** 不在构成清单里单独成项的东西（点它出「选中」卡，清单只高亮所属的项） */
export const PARTS = new Set(["house", "passage", "room", "entrance", "goal", "link", "connector", "trail_vertex", "ground"]);
export const planHas = (id) => !!id && (id === "spawn" || id === "site" || GROUP_KEYS.some((g) => (store.plan[g] || []).some((e) => e.id === id)));
export const spaceOf = (t) => (store.sid.spaces || []).find((s) => (t.sid_id && s.id === t.sid_id) || (t.plan_id && s.plan_id === t.plan_id)) || null;
/** 选中（null 取消）：plan 里的东西在清单里展开；空间切到它那一层、它的入口层 */
export function select(t) {
  store.sel = t ? { type: t.type || null, plan_id: t.plan_id || null, sid_id: t.sid_id || null, part: t.part || null, index: t.index ?? null, p: t.p || null } : null;
  if (t && t.plan_id && planHas(t.plan_id) && !PARTS.has(t.type)) { store.open.add(t.plan_id); store.closed.delete(groupOfId(t.plan_id)); }
  const sp = t && (t.type === "space" || t.type === "passage" || t.type === "room" || (t.plan_id && groupOfId(t.plan_id) === "spaces")) && store.sid && spaceOf(t);
  if (sp) {
    if (store.stratum !== sp.stratum || t.type === "space") { store.stratum = sp.stratum; if (t.type === "space" || store.interiorLevel >= levelsOf(sp)) store.interiorLevel = 0; }
    if (store.view !== "map" && store.view !== "profile") store.view = "map";
    if (store.view === "profile" && t.type === "space") { sectionTo(Object.assign({}, t, { sid_id: sp.id })); return; }
  }
  render();
}
export function groupOfId(id) { if (id === "spawn") return "landmarks"; if (id === "site") return "terrain"; return GROUP_KEYS.find((g) => (store.plan[g] || []).some((e) => e.id === id)) || null; }
export function setView(v) { if (v !== store.view) note(null); store.view = v; hidePopup(); renderViews(); }
const TOOL_TIP = { move: "拖地标、入口、地形块、空间、房子、路的折点；点一下看它是什么", path: "画一笔就是主路；在地下 / 天上层画 = 给空间加一条通道", region: "圈一块地；在地下 / 天上层圈 = 新建一个空间", section: "在图上拉一条线做剖切（15° 吸附，按住 Alt 不吸附）", erase: "点掉一栋房子、你圈的地、你画的路或通道、一个构成项" };
export function setTool(t) { if (!TOOL_TIP[t]) t = "move"; store.tool = t; if (t !== "move" && store.view !== "map") store.view = "map"; renderViews(); if (t !== "move") note(TOOL_TIP[t]); }
export function setStratum(st) {
  store.stratum = st;
  const sp = store.sel && store.sid && spaceOf(store.sel);
  if (store.sel && (sp ? sp.stratum !== st : store.sel.type !== "connector" && st !== "ground")) store.sel = null;
  if (store.interiorLevel >= maxLevels(st) || (st !== "ground" && !sp)) store.interiorLevel = 0;
  if (store.view !== "map" && store.view !== "profile") store.view = "map";
  render();
}
export function setInteriorLevel(s) { store.interiorLevel = clamp(s | 0, 0, 2); renderViews(); renderSide(); }
const maxLevels = (st) => Math.max(1, ...((store.sid && store.sid.spaces) || []).filter((s) => s.stratum === st).map(levelsOf));
/** 内部层的名字：按上下位置叫（s 是 SID 里的 sublevel，0 = 最下面；最上面那层 = 上层） */
export function levelName(s, n) { return n <= 1 ? "" : s === n - 1 ? "上层" : s === 0 ? "下层" : "中层"; }
/** 界面的内部层 k（0 = 入口层，往里数）→ SID 的 sublevel s。地下入口在最上层，空中入口在最下层 */
export function sOf(space, k) { const n = levelsOf(space), kk = clamp(k | 0, 0, n - 1); return space.stratum === "sky" ? kk : n - 1 - kk; }
export const kName = (k) => (k === 0 ? "入口层" : `第 ${k + 1} 层`);
function setStep(n) { store.step = n; syncChrome(); if (n >= 3) $("#input").placeholder = "说一句要改的，如「矿洞改成三层」「加一座戏台」"; }

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
/** 视图共用的上下文（视图是纯函数：数据进、DOM 出、回调出） */
export function ctx(extra = {}) {
  const s = store.sel;
  return Object.assign({ sid: store.sid, T: store.T, facts: store.facts, checks: store.checks, plan: store.plan, index: store.index, stratum: store.stratum, interiorLevel: store.interiorLevel,
    section: sectionSpec(), selected: s && (s.plan_id || s.sid_id) ? { plan_id: s.plan_id || undefined, sid_id: s.sid_id || undefined, part: s.part || undefined, type: s.type || undefined } : null, diffs: store.diffs, tool: store.tool, eye: store.eye,
    sectionHandles: store.tool === "move" || store.tool === "section" }, extra);
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
  const ks = [...Array(N).keys()]; if (store.stratum === "sky") ks.reverse(); // 按上下摆：地下入口层在最上，空中入口层在最下
  lv.replaceChildren(...ks.map((k) => el("button", { type: "button", class: k === store.interiorLevel ? "on" : "", "data-level": k, title: `空间内部${kName(k)}：实画这一层，其它层淡画`, onclick: () => setInteriorLevel(k) }, k === 0 ? "入口" : `${k + 1} 层`)));
}
function welcome() {
  $("#view-map").replaceChildren(el("div", { class: "welcome" }, el("div", { class: "w-title" }, "先说一句你想要的场景"),
    el("div", { class: "hint" }, "AI 出三张构成不同的方案，你挑一张；之后全在图上和右边的构成清单里改。"),
    el("div", { class: "w-ex" }, ...EXAMPLES.map((t) => el("button", { type: "button", class: "chip", onclick: () => say(t) }, t, aiTag())))));
}
function mapCaption() {
  const f = store.facts || {}, t = f.trail || {}, sp = (f.spaces && f.spaces.items) || [], st = store.stratum;
  const here = sp.filter((x) => x.stratum === st);
  const pal = (MapView.paletteOf ? MapView.paletteOf(store.sid) : null) || { roof: "#4a4a4a" };
  const dot = (c, l) => el("span", {}, el("i", { class: "sw-dot", style: `background:${c}` }), l);
  const W = Math.round(store.plan.site.size_m), relief = store.plan.site.relief_layers, layer = store.plan.site.layer_m;
  const stat = st === "ground"
    ? `${W} m 见方 · 高差 ${relief} 层 × ${layer} m · ${f.houses || 0} 栋${t.length_m ? ` · 主路 ${Math.round(t.length_m)} m` : ""}`
    : here.length ? here.map((x) => `${x.label}：通道 ${Math.round(x.passage_m || 0)} m · 房间 ${x.rooms || 0}${x.dead_ends ? ` · 死路 ${x.dead_ends}` : ""}${x.longest_route_m ? ` · 入口到终点 ${Math.round(x.longest_route_m)} m` : ""}`).join("；") : `${STRATUM_LABEL[st]}还没有空间：用「圈区域」圈一块`;
  return el("div", { class: "caption" }, st === "ground" ? [dot("#b8452b", "地标"), dot("#1f6feb", "出生点 · 视野"), dot("#8b7d5b", "路"), dot(pal.roof, "房子")] : [dot("#6b5a8c", "通道"), dot("#c9a227", "终点"), dot("#1f6feb", "入口")], el("span", { class: "stat" }, stat));
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
    (MapView.bindMap || MapView.bindMapGestures)(svg, MapView.bindMap ? c : c.sid, mapHandlers);
    $("#view-map").replaceChildren(el("div", { class: "wrap" }, svg, mapCaption())); mapSvg = svg;
  } else if (store.view === "profile") {
    const pr = ProfileView.renderProfile(Object.assign({}, c, { section: sectionCtx() }), profileHandlers);
    $("#view-profile").replaceChildren(el("div", { class: "pcol" }, pr.node));
  } else if (store.view === "eye") $("#view-eye").replaceChildren(ey ? ey.node : el("div", { class: "hint" }, "第一眼没画出来"));
  else if (store.view === "three") mount3d($("#view-three"), false).then((v) => { if (v && store.view === "three") v.update(ctx()); });
  updateInset();
}
// ---------- 3D（整页与小窗各一个实例，按需加载 three.js）
const views3d = new Map();
function mount3d(host, inset) {
  const key = inset ? "inset" : "page";
  if (!views3d.has(key)) views3d.set(key, import("./views/view3d.js").then((m) => (m.mountView3d || m.mountPreview)(host, ctx(), { inset })).then((v) => { store[inset ? "inset" : "three"] = v; return v; }).catch((e) => { views3d.delete(key); note("3D 没加载成功：" + ((e && e.message) || e)); return null; }));
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

// ============================================================ 三张卡（第 2 步）：每张一句话 + 构成摘要，差异按构成比较
const AXES = { terrain: { label: "地形组合", groups: ["terrain", "zones"] }, spaces: { label: "空间布局", groups: ["spaces"] }, landmarks: { label: "地标关系", groups: ["landmarks", "relations"] } };
const REL_SHORT = { top_of: "顶上", center_of: "中央", edge_of: "边上", end_of: "尽头", beside: "旁边", behind: "后面", between: "之间", under: "下面", above: "上面", along: "沿线", at_entry: "入口处" };
/** 一张 plan 的构成摘要：[{key, label}]，key 用来比较三张之间的差异 */
export function compTokens(p) {
  const lab = (id) => (id === "site" ? "场地" : id === "spawn" ? "出生点" : (GROUP_KEYS.map((g) => (p[g] || []).find((e) => e.id === id)).find(Boolean) || {}).label || id);
  const out = [];
  const homes = new Set((p.zones || []).filter((z) => z.use === "housing").map((z) => z.on)); // 有人住的地形块排前面（标签只放两块）
  for (const t of (p.terrain || []).slice().sort((a, b) => homes.has(b.id) - homes.has(a.id)).slice(0, 2)) out.push({ key: `t:${t.type}:${t.steps || ""}`, label: `${t.label || t.type}${t.steps ? ` ${t.steps} 级` : ""}` });
  const used = (p.zones || []).filter((z) => z.use === "housing").map((z) => z.building);
  const b = (p.buildings || []).find((x) => used.includes(x.id)) || (p.buildings || [])[0];
  if (b) out.push({ key: `b:${b.form}`, label: b.label || b.form });
  for (const l of (p.landmarks || []).slice(0, 2)) { const tg = Array.isArray(l.place.target) ? l.place.target.map(lab).join("和") : lab(l.place.target); out.push({ key: `l:${l.form}:${l.place.rel}`, label: `${l.label}在${tg === "场地" ? "场地" : tg}${REL_SHORT[l.place.rel] || ""}` }); }
  for (const w of (p.water || []).slice(0, 1)) out.push({ key: `w:${w.type}`, label: w.label || "水" });
  for (const s of (p.spaces || []).slice(0, 2)) { const L = (s.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[s.layout] || ""; const n = s.sublevels || 1; out.push({ key: `s:${s.layout}:${n}`, label: `${s.label || ""}${String(s.label || "").includes(L) ? "" : L}${n > 1 ? ` ${n} 层` : ""}` }); }
  return out;
}
function showCompare() {
  const C = store.cards, toks = C.plans.map(compTokens), cnt = new Map();
  toks.forEach((ts) => new Set(ts.map((t) => t.key)).forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1)));
  const mark = [...cnt.values()].some((n) => n === C.plans.length); // 三张有共同的构成时才标差异；全都不同就不标（标了也没信息量）
  const grid = el("div", { class: "cmp-grid" }, ...C.plans.map((p, i) => {
    const r = C.compiled[i], f = (r && r.facts) || {}, t = f.trail || {}, sp = (f.spaces && f.spaces.items) || [];
    let thumb;
    try { thumb = MapView.renderMap({ sid: r.sid, T: r.T, plan: r.plan, index: r.index, facts: f, checks: r.checks, stratum: "ground", interiorLevel: 0, selected: null, diffs: [], section: null }, { small: true }); thumb.setAttribute("class", "cmp-map"); }
    catch (e) { thumb = el("div", { class: "hint" }, "（缩略图没画出来）"); }
    const pick_ = () => pick(i);
    return el("div", { class: "cmp", tabindex: 0, role: "button", title: "选这张", "data-card": i, onclick: pick_, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick_(); } } },
      thumb, el("b", {}, p.name || `方案 ${i + 1}`), el("div", { class: "one" }, p.one_liner || ""),
      el("div", { class: "tags comp" }, toks[i].map((tk) => el("span", { class: "tag" + (mark && cnt.get(tk.key) < C.plans.length ? " diff" : "") }, tk.label))),
      el("div", { class: "hint stat" }, `${f.houses || 0} 栋 · 主路 ${Math.round(t.length_m || 0)} m${sp.length ? ` · 通道 ${Math.round(sp.reduce((a, x) => a + (x.passage_m || 0), 0))} m` : ""}`));
  }));
  const axis = C.axis && AXES[C.axis];
  const head = axis ? `这批只换「${axis.label}」，锁住的没动。` : "";
  const warn = C.distinct === false ? "三张的构成差别不大，可以换个说法。" : "";
  const foot = el("div", { class: "cmp-foot" }, el("button", { type: "button", class: "ubtn", onclick: redraft }, "三张都不要，重出", aiTag()),
    store.plan ? el("button", { type: "button", class: "ubtn", onclick: keepCurrent }, "都不要，回到现在这张") : null,
    axis ? [el("span", { class: "hint" }, "换别的："), ...Object.keys(AXES).filter((k) => k !== C.axis).map((k) => el("button", { type: "button", class: "ubtn sm", onclick: () => variants(k) }, AXES[k].label, aiTag()))] : null);
  store.comparing = true; store.view = "map";
  $("#view-map").replaceChildren(el("div", { class: "compare" }, head || warn ? el("div", { class: "cmp-head" }, head, warn ? el("span", { class: "warn" }, " " + warn) : null) : null, grid, foot));
  mapSvg = null; hidePopup(); syncChrome(); updateInset(); renderSide();
}

// ============================================================ 聊天（只用来和 AI 说话；本地操作不写这里）
export const aiTag = () => el("span", { class: "ai-tag", title: "点了会调用一次 AI" }, "调 AI");
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
    update(text) { txt.textContent = text; },
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
/** 一次 AI 调用一行：「DeepSeek flash · 1.8 s · 2.1k token · ¥0.002」；模拟写「不花钱」 */
function usageLine(d) {
  if (!d) return;
  const u = d._usage || {}, ms = d._ms ?? u.ms ?? 0, who = `${PROV[d.provider] || d.provider || "AI"}${d.provider !== "mock" && u.model ? " " + String(u.model).replace(/^deepseek-|^claude-/, "") : ""}`;
  if (d.provider === "mock") { sys(`${who} · ${(ms / 1000).toFixed(1)} s · 不花钱`); return; }
  const cost = u.cost_cny != null ? (u.cost_cny < 0.001 ? "<¥0.001" : `¥${u.cost_cny.toFixed(3)}`) : u.cost_usd != null ? `$${u.cost_usd.toFixed(3)}` : "";
  sys([who, `${(ms / 1000).toFixed(1)} s`, `${fmtK((u.input || 0) + (u.output || 0))} token`, cost].filter(Boolean).join(" · "));
}
/** 服务端从这句话里读出的硬条件：「按你的话锁定：傍晚、风雨桥（三张都照办）」 */
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
  draft: (intent, { locked = null, variant = 0 } = {}, signal) => once(() => call("POST", "/api/ai/draft", Object.assign({ intent, variant }, locked ? { locked } : {}, store.mock ? { force_mock: true } : {}), { timeoutMs: 150000, signal })),
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
const compileCards = (plans) => plans.map((p) => { try { return compileWith(p, emptyUser(), { seed: store.seed }); } catch (e) { console.error(e); return null; } });
export async function onIntent(text, variant = 0) {
  store.intent = text;
  const ac = new AbortController(), th = thinking("在出三张构成不同的方案", () => ac.abort());
  busy(true);
  try {
    const d = await API.draft(text, { variant }, ac.signal);
    const plans = d.plans.map((p) => normalizePlan(p).plan);
    store.cards = { plans, compiled: compileCards(plans), axis: null, distinct: d.diversity ? d.diversity.min >= 1 : null };
    th.done("三张方案在中间，点一张就开始改。");
    lockedLine(d);
    if (d.warnings && d.warnings.length) sys(`有 ${d.warnings.length} 处引用对不上，已就近放在场地上。`);
    usageLine(d);
    setStep(2); showCompare();
  } catch (e) { th.fail(e, () => onIntent(text, variant)); } finally { busy(false); flush(); }
}
function redraft() { if (!store.intent) return; store.variantN += 1; msg("user", "三张都不要，重出"); onIntent(store.intent, store.variantN); }
export function pick(i) {
  const C = store.cards, plan = C && C.plans[i];
  if (!plan) return;
  const fresh = !C.axis, after = (s) => { s.comparing = false; s.sel = null; s.diffs = []; s.readback = null; s.corrections = []; s.step = 3; if (fresh || C.axis === "terrain") { s.user = emptyUser(); s.section = null; s.ignored = []; } };
  $("#input").placeholder = "说一句要改的，如「矿洞改成三层」「加一座戏台」";
  if (!store.plan) {
    store.plan = clone(plan); after(store); store.undo = []; store.redo = [];
    const r = C.compiled[i]; if (r) Object.assign(store, { plan: r.plan, sid: r.sid, T: r.T, checks: r.checks, facts: r.facts, index: r.index, warnings: r.warnings }); else recompute();
    store.open = new Set(); store.stratum = "ground"; store.interiorLevel = 0;
    render(); note(`选了「${plan.name}」`); return;
  }
  edit(`换成「${plan.name}」`, (s) => { s.plan = clone(plan); after(s); if (s.stratum !== "ground" && !(plan.spaces || []).some((x) => x.stratum === s.stratum)) s.stratum = "ground"; });
}
function keepCurrent() { store.comparing = false; setStep(3); render(); }

/** 改：一句话 → AI 回 plan 的 ops（set / add / remove）→ 本地应用（锁住的项不动、可撤销） */
async function onText(t) {
  const plan0 = store.plan, ac = new AbortController();
  if (store.inflight) store.inflight.abort();
  store.inflight = ac;
  const th = thinking("在想怎么改", () => ac.abort());
  busy(true);
  try {
    const r = await API.revise(plan0, t, ac.signal);
    const locks = new Set(store.plan.locks || []), kept = [];
    const ops = (r.ops || []).filter((o) => { const hit = o && (o.op === "set" || o.op === "remove") && locks.has(o.id); if (hit) kept.push(o.id); return !hit; });
    const has = r.understood !== false && ops.length > 0;
    const ok = has && planOps(`AI：${short(r.restatement || "改了")}`, ops);
    let text = r.restatement || (has ? "好。" : "这句我没把握翻成构成上的改动。");
    if (kept.length) text += `（你锁住的${[...new Set(kept)].map(labelOf).join("、")}没动）`;
    if (has && !ok) text += "（算出来和原来一样，图没变）";
    if (store.opWarnings && store.opWarnings.length) { text += `（${store.opWarnings.length} 处没法照办，跳过了）`; store.opWarnings = null; }
    const onOpt = (o) => { const tl = { 画一笔: "path", 圈一块: "region", 拖一下: "move" }[o]; if (tl) setTool(tl); else say(o); };
    const attach = r.question ? el("div", {}, el("div", { class: "hint" }, r.question), r.ask_to_point ? chips(["画一笔", "圈一块", "拖一下"], onOpt) : null) : r.ask_to_point ? chips(["画一笔", "圈一块", "拖一下"], onOpt) : null;
    th.done(text, attach);
    lockedLine(r, false);
    usageLine(r);
  } catch (e) { th.fail(e, () => onText(t)); } finally { if (store.inflight === ac) store.inflight = null; busy(false); flush(); }
}
export function labelOf(id) { if (id === "spawn") return (store.plan.spawn && store.plan.spawn.label) || "出生点"; if (id === "site") return "场地"; for (const g of GROUP_KEYS) { const e = (store.plan[g] || []).find((x) => x.id === id); if (e) return e.label || e.id; } return id; }

// ---------- 换一批：按 plan 结构挑一条轴（地形组合 / 空间布局 / 地标关系），只换这条轴上的构成，锁住的项不动
const AXIS_ORDER = ["terrain", "spaces", "landmarks"];
function axisLocked(a) { const locks = new Set(store.plan.locks || []); const els = AXES[a].groups.flatMap((g) => store.plan[g] || []).filter((e) => e.id); return els.length > 0 && els.every((e) => locks.has(e.id)); }
function nextAxis() { for (let k = 0; k < 3; k++) { const a = AXIS_ORDER[(store.axisCursor + k) % 3]; if (!axisLocked(a)) { store.axisCursor = (store.axisCursor + k + 1) % 3; return a; } } return null; }
/** 新 plan 里引用了不存在的 id：按「原来那个 id 在哪组第几个」对到这组同位置的元素，没有就落到场地 */
function remapRefs(out, ...srcs) {
  const has = new Set(["site", "spawn"]); for (const g of GROUP_KEYS) for (const e of out[g] || []) if (e.id) has.add(e.id);
  const where = new Map(); for (const src of srcs) for (const g of GROUP_KEYS) (src[g] || []).forEach((e, i) => { if (e.id && !where.has(e.id)) where.set(e.id, [g, i]); });
  const map = (r) => { if (typeof r !== "string" || has.has(r) || DIRV[r]) return r; const w = where.get(r), arr = w && out[w[0]]; return arr && arr.length ? arr[Math.min(w[1], arr.length - 1)].id : "site"; };
  const fix = (o, k) => { if (o && o[k] !== undefined) o[k] = Array.isArray(o[k]) ? o[k].map(map) : map(o[k]); };
  for (const t of out.terrain || []) fix(t.at, "of");
  for (const z of out.zones || []) { fix(z, "on"); fix(z, "building"); }
  for (const l of [...(out.landmarks || []), out.spawn || {}]) { fix(l.place, "target"); fix(l.place, "facing"); }
  fix(out.spawn, "look_at");
  for (const p of out.paths || []) { fix(p, "from"); fix(p, "to"); fix(p, "via"); }
  for (const w of out.water || []) for (const e of [w.from, w.to, w.at]) fix(e, "of");
  for (const s of out.spaces || []) { fix(s, "under"); fix(s, "over"); fix(s.connect, "from"); }
  for (const r of out.relations || []) { fix(r, "a"); fix(r, "b"); fix(r, "c"); }
}
const CYCLE = { terrain: ["ring_terraces", "slope_terraces", "ridge", "plateau", "hill", "island"], spaces: ["maze", "galleries", "halls", "network", "rooms", "corridor"], rel: ["edge_of", "top_of", "center_of", "beside", "end_of"] };
/** 兜底：AI 那一份在这条轴上和现在几乎一样时，本地按轴挪一步（确定性） */
function nudgeAxis(p, axis, k) {
  const locks = new Set(p.locks || []), free = (arr) => (arr || []).find((e) => !locks.has(e.id));
  const step = (list, v) => list[(Math.max(0, list.indexOf(v)) + k + 1) % list.length];
  if (axis === "terrain") { const t = free(p.terrain); if (t) { t.type = step(CYCLE.terrain, t.type); if (/terraces/.test(t.type)) t.steps = 3 + ((k + (t.steps || 3)) % 4); } }
  else if (axis === "spaces") { const s = free(p.spaces); if (s && s.stratum !== "sky") { s.layout = step(CYCLE.spaces, s.layout); if (s.layout === "maze") s.sublevels = 1 + (k % 3); } else if (!s) p.spaces = (p.spaces || []).concat(Object.assign(newElement("spaces", CYCLE.spaces[k % 3], p), { label: ["迷宫", "矿洞", "地宫"][k % 3] })); }
  else { const l = free(p.landmarks); if (l) l.place = Object.assign({}, l.place, { rel: step(CYCLE.rel, l.place.rel), nudge_m: undefined }); }
}
function mergeAxis(cur, neu, axis, k) {
  const out = clone(cur), locks = new Set(cur.locks || []);
  for (const g of AXES[axis].groups) {
    const kept = (cur[g] || []).filter((e) => e.id && locks.has(e.id));
    out[g] = kept.concat(clone(neu[g] || []).filter((e) => !e.id || !kept.some((x) => x.id === e.id)));
  }
  if (axis === "landmarks" && neu.spawn && !locks.has("spawn")) out.spawn = Object.assign(clone(neu.spawn), { label: (cur.spawn || {}).label });
  remapRefs(out, neu, cur);
  if (planDistance(cur, out) < 0.3) nudgeAxis(out, axis, k);
  return normalizePlan(out).plan;
}
export async function variants(axis) {
  if (!store.plan) return;
  axis = axis || nextAxis();
  if (!axis || axisLocked(axis)) { note("这条轴上的项都锁住了：先在构成清单里解锁"); return; }
  const base = store.plan;
  msg("user", `换一批（${AXES[axis].label}）`);
  const ac = new AbortController(), th = thinking(`按「${AXES[axis].label}」出三张`, () => ac.abort());
  busy(true);
  try {
    store.variantN += 1;
    const d = await API.draft(store.intent || base.one_liner || base.name, { locked: { plan: base, ids: base.locks || [] }, variant: store.variantN }, ac.signal);
    const plans = d.plans.map((p, k) => mergeAxis(base, p, axis, k));
    store.cards = { plans, compiled: compileCards(plans), axis, distinct: plans.every((p, i) => plans.every((q, j) => i >= j || planDistance(p, q) >= 0.3)) };
    th.done(`三张只换「${AXES[axis].label}」，在中间。`);
    usageLine(d);
    setStep(2); showCompare();
  } catch (e) { th.fail(e, () => variants(axis)); } finally { busy(false); flush(); }
}

// ============================================================ 俯视图手势（全部本地、可撤销、不写聊天）
const DRAG = new Set(["landmark", "spawn", "house", "trail_vertex", "feature", "space", "connector", "section_a", "section_b", "section_mid"]);
const volOf = (t) => (store.sid.volumes || []).find((v) => v.id === t.sid_id) || (t.plan_id ? store.sid.volumes.find((v) => v.plan_id === t.plan_id && v.importance === "landmark") : null);
function startOf(t) {
  if (t.type === "spawn") { const m = store.sid.markers.find((x) => x.kind === "player_spawn"); return m && [m.position[0], m.position[2]]; }
  if (t.type === "landmark" || t.type === "house") { const v = volOf(t); return v && [v.position[0], v.position[2]]; }
  if (t.type === "feature") { const g = resolveTarget(store.sid, store.T, t.plan_id); return g && g.point; }
  if (t.type === "space") { const s = spaceOf(t); return s && polygonCentroid(s.polygon); }
  return null;
}
const where = (p) => { const t = store.T && store.T.terraceAt(p[0], p[1]); return t ? `第 ${t.level} 层台地` : "坡上"; };
const uid = (pre, list) => { let n = 1; const ids = new Set(list.map((x) => x.id)); while (ids.has(pre + n)) n++; return pre + n; };
function dragEnd(t, p, info) {
  const a = startOf(t), d = Array.isArray(info.delta) ? info.delta : a ? [p[0] - a[0], p[1] - a[1]] : [0, 0], dist = Math.round(Math.hypot(d[0], d[1]));
  const addN = (n) => [r1(clamp(((n || [0, 0])[0] || 0) + d[0], -60, 60)), r1(clamp(((n || [0, 0])[1] || 0) + d[1], -60, 60))];
  switch (t.type) {
    case "landmark": { const l = store.plan.landmarks.find((x) => x.id === t.plan_id); if (!l) return; return planOps(`${l.label}挪了 ${dist} m（记成人挪过）`, [{ op: "set", id: l.id, field: "place.nudge_m", value: addN(l.place.nudge_m) }]); }
    case "spawn": return planOps(`入口挪了 ${dist} m，朝向重新对准`, [{ op: "set", id: "spawn", field: "place.nudge_m", value: addN(store.plan.spawn.place.nudge_m) }]);
    case "feature": {
      const id = t.plan_id, g = id && resolveTarget(store.sid, store.T, id); if (!g) return;
      const at = atFromPoint(store.sid, store.T, store.plan, id, [g.point[0] + d[0], g.point[1] + d[1]]); if (!at) return;
      return planOps(`${labelOf(id)}挪到${at.of === "site" ? "场地" : labelOf(at.of)}的${DIR_LABEL[at.dir]}边`, [{ op: "set", id, field: "at", value: at }]);
    }
    case "space": {
      const s = spaceOf(t); if (!s) return;
      const us = store.user.spaces.find((x) => x.id === s.id);
      if (us) return edit(`${s.label}平移 ${dist} m`, (st) => { const u = st.user.spaces.find((x) => x.id === s.id); u.polygon = u.polygon.map((q) => [r1(q[0] + d[0]), r1(q[1] + d[1])]); });
      const ps = store.plan.spaces.find((x) => x.id === s.plan_id); if (!ps) return;
      return planOps(`${s.label}平移 ${dist} m`, [{ op: "set", id: ps.id, field: "offset_m", value: addN(ps.offset_m) }]);
    }
    case "house": {
      const v = volOf(t); if (!v) return;
      let nid = v.id;
      return edit(() => `房子挪到${where(p)}，已锁住`, (s) => {
        const mine = s.user.houses.find((h) => h.id === v.id);
        if (mine) mine.position = [r1(p[0]), mine.position[1], r1(p[1])];
        else {
          if (v.generated) s.user.removed.push([r1(v.position[0]), r1(v.position[2]), "building"]);
          nid = uid("u_house_", s.user.houses);
          s.user.houses.push(Object.assign(clone(v), { id: nid, generated: undefined, locked: true, user_moved: true, position: [r1(p[0]), v.position[1], r1(p[1])] }, v.generated ? { orig: [r1(v.position[0]), r1(v.position[2])] } : {}));
        }
        s.sel = { type: "house", sid_id: nid, plan_id: v.zone_id || v.plan_id || null };
      });
    }
    case "trail_vertex": return edit(`主路第 ${(t.index ?? info.index ?? 0) + 1} 个折点挪了`, (s) => { const mt = s.sid.paths.find((x) => x.id === "main_trail"); const pts = clone(s.user.trail || (mt && mt.points) || []); const i = t.index ?? info.index; if (!(i >= 0 && i < pts.length)) return false; pts[i] = [r1(p[0]), r1(p[1])]; s.user.trail = pts; });
    case "connector": return edit("连接点挪了，仍连着原来的两层", (s) => { s.user.connectors[t.sid_id] = [r1(p[0]), r1(p[1])]; });
    default:
      if (/^section_/.test(t.type) && info.line) return edit(`剖切线 ${info.length_m ?? ""} m · ${info.angle_deg ?? ""}°`, (s) => setSection(s, { mode: "line", line: info.line }), { geometry: false });
      note("这个不能拖：在右边的构成清单里改");
  }
}
function removeTarget(t) {
  if (!t || !store.plan) return;
  const sid = t.sid_id || "";
  if (t.type === "house") {
    const v = volOf(t); if (!v) return;
    return edit("删了一栋房子", (s) => { if (s.user.houses.some((h) => h.id === v.id)) s.user.houses = s.user.houses.filter((h) => h.id !== v.id); else s.user.removed.push([r1(v.position[0]), r1(v.position[2]), v.kind]); s.sel = null; });
  }
  if (t.type === "passage" && store.user.passages.some((x) => x.id === t.part)) return edit("删了你画的通道", (s) => { s.user.passages = s.user.passages.filter((x) => x.id !== t.part); s.sel = null; });
  if (store.user.regions.some((x) => x.id === sid)) return edit("去掉了你圈的地", (s) => { s.user.regions = s.user.regions.filter((x) => x.id !== sid); s.sel = null; });
  if (t.type === "space" && store.user.spaces.some((x) => x.id === sid)) return edit("删了你圈的空间", (s) => { s.user.spaces = s.user.spaces.filter((x) => x.id !== sid); s.user.passages = s.user.passages.filter((x) => x.space !== sid); s.sel = null; });
  if (store.user.paths.some((x) => x.id === sid)) return edit("删了这段支路", (s) => { s.user.paths = s.user.paths.filter((x) => x.id !== sid); });
  if (t.type === "trail_vertex" || sid === "main_trail") return store.user.trail ? edit("主路恢复成算出来的", (s) => { s.user.trail = null; }) : note("主路是算出来的：在构成清单的「路」里改");
  if (t.type === "spawn") return note("入口不能删，可以拖");
  if (t.type === "connector" || t.type === "passage" || t.type === "room") return note("这是空间内部的一部分：在清单里改布局，或「换一个」");
  if (t.plan_id && planHas(t.plan_id) && t.plan_id !== "site") return removePlanItem(t.plan_id);
  note("这个没法单独删");
}
export function removePlanItem(id) {
  const g = groupOfId(id), name = labelOf(id), min = { terrain: 1 }[g] || 0;
  if (g && (store.plan[g] || []).length <= min) { note(`至少要留一个${name}`); return; }
  const ok = planOps(`删了${name}`, [{ op: "remove", id }]);
  if (ok && store.sel && store.sel.plan_id === id) { store.sel = null; render(); }
  return ok;
}
export function removeSelected() { if (store.sel) removeTarget(store.sel); }
const REGION_USE = { forest: "林子", plaza: "广场", terrace: "梯田", farmland: "农田" };
export const mapHandlers = {
  tool: () => store.tool,
  canDrag: (t) => !!store.plan && DRAG.has(t && t.type) && (t.type !== "landmark" || !!t.plan_id),
  onGesture(on) { document.body.classList.toggle("gesturing", !!on); },
  onDragCancel() { hint(null); renderViews(); },
  onDrag(t, p, info = {}) {
    if (/^section_/.test(t.type) && info.line) { hint(`剖切线 ${info.length_m} m · ${info.angle_deg}°`); if (store.inset && store.inset.setSection) store.inset.setSection({ mode: "line", line: info.line, width_m: sectionSpec().width_m }); }
    else if (t.type === "house" || t.type === "landmark" || t.type === "spawn") hint(`→ ${where(p)}`);
    else if (t.type === "feature" || t.type === "space") { const a = startOf(t); if (a) hint(`→ 挪 ${Math.round(Math.hypot(p[0] - a[0], p[1] - a[1]))} m`); }
  },
  onDragEnd(t, p, info) { hint(null); dragEnd(t, p, info || {}); },
  onSelect(t, p) { select(!t || t.type === "ground" ? { type: "ground", p } : t); },
  onSection(line, info = {}) { edit(`剖切线 ${info.length_m ?? Math.round(Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]))} m`, (s) => setSection(s, { mode: "line", line }), { geometry: false, actions: store.view === "profile" ? [] : [{ label: "看剖面", fn: () => setView("profile") }] }); },
  onPath(points, ev) {
    const kind = classifyStroke(points);
    if (kind === "tap") return;
    if (kind === "loop") return mapHandlers.onRegion(points, ev);
    if (store.stratum !== "ground") {
      const s = (store.sel && spaceOf(store.sel)) || store.sid.spaces.find((x) => x.stratum === store.stratum && points.some((q) => pointInPolygon(q, x.polygon)));
      if (!s || s.stratum !== store.stratum) { note("通道要画在这一层的空间里：先圈一个空间，或选中一个"); return; }
      const pts = strokeToPath(points, { T: store.T, anchors: {}, snap: 0, maxPoints: 10 }).points, lvl = sOf(s, store.interiorLevel);
      return edit(`${s.label}${kName(clamp(store.interiorLevel, 0, levelsOf(s) - 1))}加了一条通道 ${Math.round(polylineLength(pts))} m`, (st) => { st.user.passages.push({ id: uid("u_p", st.user.passages), space: s.id, sublevel: lvl, points: pts.map((q) => [r1(q[0]), r1(q[1])]), width: s.corridor_m || 2.5, user: true }); });
    }
    const sp = store.sid.markers.find((m) => m.kind === "player_spawn"), lm = store.sid.volumes.find((v) => v.id === store.sid.meta.focus);
    const r = strokeToPath(points, { T: store.T, anchors: { spawn: sp && [sp.position[0], sp.position[2]], landmark: lm && [lm.position[0], lm.position[2]] }, snap: 10, maxPoints: 12 }), f = r.facts;
    edit(`主路按你画的：${f.n_points} 个折点 · ${Math.round(f.length_m)} m${f.end_snapped_to === "landmark" ? "" : " · 没接到地标"}`, (s) => { s.user.trail = r.points.map((q) => [r1(q[0]), r1(q[1])]); });
  },
  onRegion(points, ev) {
    const r = strokeToPolygon(points, { T: store.T, maxPoints: 10 });
    if (!r.polygon || r.polygon.length < 3 || r.area_m2 < 20) { note("圈得太小了，再圈大一点"); return; }
    const area = Math.round(r.area_m2), st = store.stratum, tip = (t) => el("span", { class: "hint" }, t);
    if (st !== "ground") {
      const L = st === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL;
      popup(ev, [tip(`圈了 ${area} m²，${STRATUM_LABEL[st]}的这块是：`), ...INTERIOR_LAYOUTS[st].filter((k) => k !== "rooms").map((k) => chip(L[k], () => {
        hidePopup();
        edit(`加了${STRATUM_LABEL[st]}${L[k]}`, (s) => { const id = uid("u_space_", s.user.spaces); s.user.spaces.push({ id, stratum: st, layout: k, polygon: r.polygon, label: L[k] }); s.sel = { type: "space", sid_id: id, plan_id: null }; });
      })), chip("算了", hidePopup)], r.centroid);
      return;
    }
    popup(ev, [tip(`圈了 ${area} m²，这块是：`), ...Object.entries(REGION_USE).map(([k, l]) => chip(l, () => { hidePopup(); edit(`圈的这块：${l}`, (s) => { s.user.regions.push({ id: uid("u_r", s.user.regions), kind: k, polygon: r.polygon, label: l, user_set: true, density: 1 }); }); })), chip("算了", hidePopup)], r.centroid);
  },
  onErase(t) { removeTarget(t); },
  onInteriorLevel(k) { setInteriorLevel(k); },
  onDiff(id, ev) { const d = store.diffs.find((x) => x.id === id); if (d) popup(ev, diffButtons(d)); },
};

// ============================================================ 剖面拖动（本地）
const spaceIdToPlan = (id) => { const s = (store.sid.spaces || []).find((x) => x.id === id || x.plan_id === id); return s ? { s, ps: store.plan.spaces.find((x) => x.id === s.plan_id) } : {}; };
let liveAt = 0;
function liveCompile(kind, id, v) { // 拖动中：在副本上套这个值重算，只更新 3D 小窗（不入撤销栈）
  const plan = clone(store.plan), user = clone(store.user);
  if (kind === "terrace") user.terraceH[id] = v;
  else if (kind === "layer") plan.site.layer_m = v;
  else if (kind === "landmark") { const l = plan.landmarks.find((x) => x.id === id) || plan.landmarks[0]; if (l && l.size_m) l.size_m[1] = v; }
  else if (kind === "space_height") { const { ps } = spaceIdToPlan(id); const q = ps && plan.spaces.find((x) => x.id === ps.id); if (q) q.height_m = v; }
  else return null;
  return compileWith(plan, user, { seed: store.seed, ignored: store.ignored });
}
/** onLandmarkHeight(h, plan_id?, sid_id?)；也认 (plan_id, h) */
function landmarkArgs(a, b) { if (typeof a === "string") return [a, b]; const f = store.sid.volumes.find((v) => v.id === store.sid.meta.focus); return [b || (f && f.plan_id) || (store.plan.landmarks[0] || {}).id, a]; }
export const profileHandlers = {
  onTerraceHeight(id, h) { const f = store.sid.terrain.features.find((x) => x.id === id); edit(h == null ? `${(f && f.label) || "台地"}恢复规则高度` : `${(f && f.label) || "台地"} +${r1(Math.round(h * 2) / 2)} m`, (s) => { if (h == null) delete s.user.terraceH[id]; else s.user.terraceH[id] = Math.round(h * 2) / 2; }); },
  onSlope(h) { profileHandlers.onLayerHeight(h); },
  onLayerHeight(h) { planOps(`每层高 ${r1(h)} m`, [{ op: "set", id: "site", field: "layer_m", value: clamp(Math.round(h * 2) / 2, 2, 6) }]); },
  onLandmarkHeight(a, b) {
    const [id, h] = landmarkArgs(a, b), l = store.plan.landmarks.find((x) => x.id === id); if (!l) return;
    const sz = l.size_m || [8, 10, 8], v = clamp(Math.round(h * 2) / 2, 2, 60);
    planOps(`${l.label}高 ${v} m`, [{ op: "set", id, field: "size_m", value: [sz[0], v, sz[2]] }]);
  },
  onSpaceFloor(id, y) {
    const { s, ps } = spaceIdToPlan(id); if (!s) return;
    if (!ps) return edit(`${s.label}底面 ${r1(y)} m`, (st) => { const u = st.user.spaces.find((x) => x.id === s.id); if (!u) return false; u.floor_y = r1(y); });
    const L = store.plan.site.layer_m, k = s.stratum === "underground" ? "depth_layers" : "height_layers", cur = ps[k] || (s.stratum === "underground" ? 2 : 3);
    const nv = clamp(cur + Math.round((s.stratum === "underground" ? s.floor_y - y : y - s.floor_y) / L), 1, s.stratum === "underground" ? 6 : 8);
    if (nv === cur) { note(`差不到一层（每层 ${L} m），没变`); renderViews(); return; }
    planOps(`${s.label}${s.stratum === "underground" ? "深" : "高"} ${nv} 层`, [{ op: "set", id: ps.id, field: k, value: nv }]);
  },
  onSpaceHeight(id, h) { const { s, ps } = spaceIdToPlan(id); if (!s || !ps) return; const v = clamp(Math.round(h * 2) / 2, 2.2, 12); planOps(`${s.label}净高 ${v} m`, [{ op: "set", id: ps.id, field: "height_m", value: v }]); },
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

// ============================================================ 演示 / 截图：?demo=cards|pick|edit|maze|tomb|section|export|variants[&view=…&level=k&inset=1]（一律模拟 AI）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let v = null; try { v = fn(); } catch { v = null; } if (v) res(v); else if (Date.now() - t0 > ms) rej(new Error("等不到界面就绪")); else setTimeout(tick, 30); }; tick(); });
const DEMO_INTENT = { maze: "半山矿工村，地下有个矿洞，是个两层的迷宫", tomb: "山寺，寺下有地宫：前厅—甬道—主墓室，两侧耳室" };
async function runDemo(stage, params) {
  const intent = DEMO_INTENT[stage] || EXAMPLES[1];
  msg("user", intent); await onIntent(intent);
  if (stage === "cards") return;
  const want = stage === "maze" ? (p) => (p.spaces || []).some((s) => s.layout === "maze") : stage === "tomb" ? (p) => (p.spaces || []).some((s) => s.layout === "rooms") : () => true;
  const i = Math.max(0, store.cards.plans.findIndex(want));
  (await until(() => document.querySelector(`.cmp[data-card="${i}"]`))).click(); await sleep(30);
  if (stage === "edit") {
    const t = store.plan.terrain.find((x) => x.steps) || store.plan.terrain[0];
    store.open.add(t.id); renderSide();
    const plus = document.querySelector(`[data-ref="${t.id}"] [data-path="steps"] .plus, [data-ref="${t.id}"] [data-path="top_layer"] .plus`); if (plus) plus.click();
    store.open.add("look"); renderSide();
    const tod = (store.plan.lighting || {}).time_of_day === "dawn" ? "dusk" : "dawn";
    const b = document.querySelector(`[data-ref="look"] [data-path="lighting.time_of_day"] button[data-v="${tod}"]`); if (b) b.click();
    const h = store.sid.volumes.find((v) => v.kind === "building" && v.importance !== "landmark");
    if (h) select({ type: "house", sid_id: h.id, plan_id: h.zone_id || h.plan_id });
  }
  if (stage === "maze" || stage === "tomb") {
    const s = store.plan.spaces.find((x) => x.layout === (stage === "maze" ? "maze" : "rooms")) || store.plan.spaces[0];
    const t = s && { type: "space", plan_id: s.id, sid_id: (spaceOf({ plan_id: s.id }) || {}).id };
    if (t) select(t);
    if (params.get("level") != null) setInteriorLevel(+params.get("level"));
    if (t && params.get("view") === "profile") sectionTo(t); // 剖面直接剖过这个空间
  }
  if (stage === "section") { const lm = store.sid.volumes.find((v) => v.id === store.sid.meta.focus); if (lm) sectionTo({ type: "landmark", plan_id: lm.plan_id, sid_id: lm.id }); if (!store.insetOn) toggleInset(); }
  if (stage === "export") { await sleep(30); openExport(); }
  if (stage === "variants") { await variants(); return; }
  const view = params.get("view");
  if (view) setView(view);
  if (params.get("inset") && !store.insetOn) toggleInset();
}

// ============================================================ 键盘 / 绑定 / 启动
function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName) || $("#settings").open;
  if (e.key === "Escape") {
    if (!$("#popup").hidden) hidePopup(); else if (!$("#modal").hidden) closeModal(); else if (typing) return;
    else if (store.tool !== "move") setTool("move"); else if (store.sel) select(null); else if (store.comparing && store.plan) keepCurrent();
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
export const actions = { edit, planOps, select, render, renderViews, note, setView, setInteriorLevel, levelName, kName, labelOf, groupOfId, removePlanItem, removeSelected,
  applyFix, nextSeed, API, sys, ctx, sectionSpec, sectionCtx, compTokens, spaceOf, mapHandlers, hidePopup, GROUP_KEYS, PARTS };
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
  msg("ai", "说一句你想要的场景，我出三张构成不同的方案。之后在图上拖、在右边的构成清单里改，只有说话、重出、换一批会调 AI。");
  if (demo) runDemo(demo, params).catch((e) => sys("演示失败：" + e.message));
}
start();

// 调试 / 自动化测试用（唯一的全局）
window.__scene = { store, edit, planOps, undo, redo, select, setView, setTool, setStratum, setInteriorLevel, say, pick, variants, mergeAxis, compTokens, compileWith, applyFix, removePlanItem, openExport, buildBrief, buildPackage, exportSid, render, ctx, sectionSpec, mapHandlers, profileHandlers, API };
