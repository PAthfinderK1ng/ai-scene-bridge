// ui.js — 右栏与弹窗（docs/06 §5）：「构成」= 场景树（场地与出生点 / 地形操作 / 节点按树展开：组 → 子节点，重复 →「× 6 · 环形」+ 模板 /
// 关系 / 外观），每项一行摘要、展开是从 schema 生成的旋钮（尺寸、数量、半径、间距、偏移、旋转、离地、屋顶、标签、锚点下拉…）、＋加形体 / 组 / 重复 /
// 连接 / 生成器 / 地形操作、删除、锁；选中卡（重复里的单个实例、空间内部的部件、连接点、一个点）；检查；AI 设置；导出（引擎包 + 读回对比）。
// 所有改动走 app.js 的 edit / planOps（本地、可撤销、不调 AI）。只从 app.js 拿 store 和一个 actions 对象。
import { store, actions as A } from "./app.js";
import { PLAN_SCHEMA, knobsFor, summarize, newElement, normalizePlan, findNode, expand, resolveTarget } from "./engine/plan.js";
import { levelsOf, LAYOUT_LABEL, SKY_LAYOUT_LABEL, VIA_LABEL, STRATUM_LABEL, ROLE_LABEL, CONNECTOR_VIA } from "./engine/interior.js";
import { extractPalette, assignRoles, paletteShift } from "./engine/color.js";
import { polygonArea } from "./engine/terrain.js";
import * as MapView from "./views/map.js";
import * as ProfileView from "./views/profile.js";
import * as EyeView from "./views/eye.js";

const $ = (s) => document.querySelector(s);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const r1 = (v) => Math.round(Number(v) * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 建 DOM：class / on* / 其它属性；子节点可为字符串、节点、数组，null 跳过 */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); }
  for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const btn = (label, on, cls = "", title = null) => el("button", { type: "button", class: cls, title, onclick: on }, label);
const LOCK_SVG = (on) => `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2"/><path d="M4 5.5V4a2 2 0 0 1 4 0${on ? "v1.5" : "V3.2"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const INST = /^([a-z][a-z0-9_]*)\[(\d+)\]$/;
const instCount = (id) => expand(store.plan).filter((e) => e.instance_of === id && e.id === `${id}[${e.k}]`).length; // 只数直接实例（实例里的子形体也带 instance_of）

// ============================================================ 右栏
export function renderSide() {
  const side = $("#side"), on = !!store.plan && !store.comparing;
  side.classList.toggle("empty", !on);
  if (!on) return;
  renderComp($("#comp"));
  const shown = renderSel($("#selection"));
  $("#p-sel").hidden = !shown;
  renderChecks($("#checks"));
}

// ============================================================ 构成：场景树
const GROUPS = [
  { key: "site", label: "场地与出生点", hint: "基础地形、场地大小、出生点在哪、第一眼看什么" },
  { key: "terrain", label: "地形", hint: "雕刻操作按顺序作用在高度场上（抬起 / 压低 / 削平 / 台阶化 / 开沟 / 成湖 / 立崖 …）；拖图上的地形块 = 改它的偏移" },
  { key: "nodes", label: "场景", hint: "场景程序：形体组成组、组可以嵌套和重复，位置是锚点 + 局部偏移；拖图上的东西 = 改它的偏移" },
  { key: "relations", label: "关系", hint: "要成立的关系：引擎按几何检查" },
  { key: "look", label: "外观", hint: "时段、色板、气氛" },
];
const NODE_MAX = ((PLAN_SCHEMA["x-groups"] || []).find((g) => g.key === "nodes") || {}).max || 40;
const TERRAIN_MAX = ((PLAN_SCHEMA["x-groups"] || []).find((g) => g.key === "terrain") || {}).max || 16;
/** 一组里的行：{ ref, kind: site|spawn|terrain|node|template|rel|look, kg（knobsFor 的组名）, el, name, depth, hasKids } */
function itemsOf(g) {
  const p = store.plan, out = [];
  if (g === "site") return [{ ref: "site", kind: "site", kg: "site", el: p.site, name: "场地" }, { ref: "spawn", kind: "spawn", kg: "spawn", el: p.spawn, name: p.spawn.label || "出生点" }];
  if (g === "look") return [{ ref: "look", kind: "look", kg: "look", el: p, name: "外观" }];
  if (g === "terrain") return p.terrain.map((t) => ({ ref: t.id, kind: "terrain", kg: "terrain", el: t, name: t.label || t.id }));
  if (g === "relations") return (p.relations || []).map((r, i) => ({ ref: `rel:${i}`, kind: "rel", kg: "relation", el: r, name: relName(r) }));
  const visit = (n, depth, template) => {
    if (!n || typeof n !== "object") return;
    const tpl = (n.type === "repeat" || n.type === "scatter_houses") && n.child && typeof n.child === "object" ? n.child : null;
    out.push({ ref: n.id, kind: template ? "template" : "node", kg: "node", el: n, name: A.nodeName(n), depth, hasKids: !!((n.children && n.children.length) || tpl), template });
    if (store.collapsed.has(n.id)) return;
    for (const c of n.children || []) visit(c, depth + 1, template);
    if (tpl) visit(tpl, depth + 1, true);
  };
  for (const n of p.nodes) visit(n, 0, false);
  return out;
}
/** 「主殿 从 出生点 看得见」 */
function relName(r) {
  const k = knobsFor("relation", r, PLAN_SCHEMA, store.plan).find((x) => x.path === "type"), o = k && (k.options || []).find((x) => x.value === r.type), l = o ? o.label : r.type;
  const B = A.labelOf(r.b) + (r.c ? ` 和 ${A.labelOf(r.c)}` : "");
  return l.includes("…") ? `${A.labelOf(r.a)} ${l.replace("…", B)}` : `${A.labelOf(r.a)} ${l} ${B}`;
}
const groupOpen = (g, items) => !store.closed.has(g) && (g !== "relations" || store.open.has("g:relations") || items.length <= 4 || items.some((i) => store.open.has(i.ref)));
function renderComp(box) {
  const p = store.plan, keep = box.scrollTop;
  const name = el("input", { class: "pname", value: p.name || "", maxlength: 16, title: "场景名（点了可改）", onchange: (e) => { const v = e.target.value.trim(); if (v && v !== p.name) A.planOps(`场景改名「${v}」`, [{ op: "set", id: "plan", field: "name", value: v }]); } });
  const ks = p.key_structures || [];
  box.replaceChildren(el("div", { class: "psum" }, name, el("div", { class: "one" }, p.concept || ""), ks.length ? el("div", { class: "keys" }, el("span", { class: "kk" }, "关键结构"), ks.map((k) => el("span", { class: "key" }, k))) : null),
    el("div", { class: "comp-tokens" }, A.structTokens(p).map((t) => el("span", { class: "tag" }, t.label))));
  for (const g of GROUPS) box.append(groupBlock(g));
  box.scrollTop = keep;
  if (store.sel && store.sel._scroll !== false) {
    const cur = box.querySelector(".item.sel");
    if (cur) cur.scrollIntoView({ block: "nearest" }); else if (A.PARTS.has(store.sel.type) || store.sel.inst) $("#side").scrollTop = 0;
    store.sel._scroll = false;
  }
}
function groupBlock(g) {
  const items = itemsOf(g.key), open = groupOpen(g.key, items);
  const n = g.key === "nodes" ? `${store.plan.nodes.length} · 展开 ${expand(store.plan).length}` : g.key === "terrain" || g.key === "relations" ? String(items.length) : "";
  const head = el("button", { type: "button", class: "ghead", "aria-expanded": String(open), title: g.hint, onclick: () => { if (open) { store.closed.add(g.key); store.open.delete("g:" + g.key); } else { store.closed.delete(g.key); store.open.add("g:" + g.key); } renderSide(); } },
    el("span", { class: "caret" }, open ? "▾" : "▸"), g.label, n ? el("span", { class: "count" }, n) : null);
  const box = el("section", { class: "group", "data-group": g.key }, head);
  if (!open) return box;
  for (const it of items) box.append(itemBlock(it));
  if (g.key === "nodes") box.append(el("div", { class: "addrow" }, addNodeSelect(null)));
  if (g.key === "terrain") box.append(el("div", { class: "addrow" }, addTerrainSelect()));
  if (g.key === "relations") box.append(el("div", { class: "addrow" }, addRelSelect()));
  return box;
}
/** 一行的关键值：重复写「× 6 · 环形 · 半径 33 m」，组写「4 项 · @锚点」 */
function summaryOf(it) {
  const p = store.plan, e = it.el;
  if (it.kind === "look") return summarize("look", p);
  if (it.kind === "rel") return "";
  const s = summarize(it.kg, Object.assign({}, e, { label: undefined }), p).replace(/(\d)\/(?=\d)/g, "$1×");
  if (it.kind === "node" && e.type === "repeat") {
    const pat = A.OPT("node", "pattern")[e.pattern || "linear"] || e.pattern;
    const rest = s.split(" · ").filter((x) => x && x !== pat && !/^× /.test(x));
    return [`× ${instCount(e.id)}`, pat, ...rest].join(" · ");
  }
  if (e.type === "group") return [`${(e.children || []).length} 项`, s].filter(Boolean).join(" · ");
  return (it.kind === "template" ? "模板 · " : "") + s;
}
function itemBlock(it) {
  const open = store.open.has(it.ref), s = store.sel, sel = s && s.plan_id === it.ref && !A.PARTS.has(s.type);
  const lockable = it.kind === "terrain" || it.kind === "node", locked = lockable && (store.plan.locks || []).includes(it.ref);
  const relCheck = it.kind === "rel" ? store.checks.find((c) => c.id === `rel_${it.ref.slice(4)}`) : null;
  const lock = lockable ? el("button", { type: "button", class: "lock" + (locked ? " on" : ""), title: locked ? "已锁：换一批和 AI 都不改它（点了解锁）" : "锁住：换一批和 AI 都不改它", "aria-pressed": String(locked), onclick: (e) => { e.stopPropagation(); toggleLock(it.ref); } }) : el("span", { class: "lock-sp" });
  if (lockable) lock.innerHTML = LOCK_SVG(locked);
  const caret = it.hasKids ? el("button", { type: "button", class: "tcaret", title: "收起 / 展开子节点", onclick: (e) => { e.stopPropagation(); if (store.collapsed.has(it.ref)) store.collapsed.delete(it.ref); else store.collapsed.add(it.ref); renderSide(); } }, store.collapsed.has(it.ref) ? "▸" : "▾") : el("span", { class: "tcaret-sp" });
  const instTag = s && s.inst && INST.exec(s.inst) && INST.exec(s.inst)[1] === it.ref ? el("span", { class: "inst-tag", title: "图上选中的是这一个实例" }, `#${+INST.exec(s.inst)[2] + 1}`) : null;
  const deletable = it.kind === "terrain" || it.kind === "rel" || (it.kind === "node") || (it.kind === "template" && !(findNode(store.plan, it.ref) || {}).template);
  const row = el("div", { class: "irow", tabindex: 0, title: "点开看旋钮；图上会高亮它生成的东西", onclick: () => toggleItem(it), onkeydown: (e) => { if (e.key === "Enter") toggleItem(it); } },
    it.depth != null ? caret : null, lock, relCheck ? el("span", { class: relCheck.ok ? "ok" : "bad" }, relCheck.ok ? "✓" : "✗") : null,
    el("span", { class: "nm" }, it.name), instTag, el("span", { class: "sum" }, summaryOf(it)),
    deletable ? el("button", { type: "button", class: "x", title: "删除（可撤销）", onclick: (e) => { e.stopPropagation(); removeItem(it); } }, "×") : null);
  const box = el("div", { class: "item" + (open ? " open" : "") + (sel ? " sel" : "") + (locked ? " locked" : "") + (it.kind === "template" ? " tpl" : ""), "data-ref": it.ref, "data-kind": it.kind, "data-type": it.el && it.el.type ? it.el.type : null, style: it.depth ? `--d:${it.depth}` : null }, row);
  if (open) box.append(knobsBlock(it));
  return box;
}
function toggleItem(it) {
  if (store.open.has(it.ref)) { store.open.delete(it.ref); if (store.sel && store.sel.plan_id === it.ref) { store.sel = null; A.render(); return; } renderSide(); return; }
  store.open.add(it.ref);
  if (it.kind === "site" || it.kind === "look" || it.kind === "rel") { renderSide(); return; }
  if (it.kind === "spawn") return A.select({ type: "spawn", plan_id: "spawn" });
  if (it.kind === "terrain") return A.select({ type: "feature", plan_id: it.ref });
  if (it.el.type === "space") { const s = A.spaceOf({ plan_id: it.ref }); return A.select({ type: "space", plan_id: it.ref, sid_id: s ? s.id : null }); }
  A.select({ type: "node", plan_id: it.ref });
}
function toggleLock(ref) {
  const L = new Set(store.plan.locks || []);
  if (L.has(ref)) L.delete(ref); else L.add(ref);
  store.plan.locks = [...L];
  A.note(L.has(ref) ? `锁住了${A.labelOf(ref)}：换一批和 AI 都不改它` : `${A.labelOf(ref)}解锁了`);
  renderSide();
}
function removeItem(it) {
  if (it.kind === "rel") return A.planOps(`删了关系「${it.name}」`, [{ op: "remove", id: it.ref }]);
  A.removePlanItem(it.ref);
}
// ---------- ＋ 加：形体 / 建筑件 / 组合 / 连接 / 生成器（按 x-node-classes 分组）、地形操作、关系
function addNodeSelect(parent) {
  const TY = A.OPT("node", "type"), classes = PLAN_SCHEMA["x-node-classes"] || [];
  const full = !parent && store.plan.nodes.length >= NODE_MAX;
  const s = el("select", { class: "add", "data-add": "node", "data-parent": parent || null, disabled: full || null, title: full ? `根节点最多 ${NODE_MAX} 个` : parent ? `加到「${A.labelOf(parent)}」里（局部偏移，之后可拖）` : "按这种的默认值加一个（可撤销）", onchange: (e) => { const v = e.target.value; e.target.value = ""; if (v) addNode(v, parent); } },
    el("option", { value: "" }, full ? `已满 ${NODE_MAX} 个` : parent ? "＋ 加子节点…" : "＋ 加一个节点…"),
    ...classes.filter((c) => !parent || (c.key !== "link" && c.key !== "generator")).map((c) => el("optgroup", { label: c.label }, ...c.types.map((t) => el("option", { value: t }, TY[t] || t)))));
  return s;
}
export function addNode(type, parent = null) {
  const e = newElement("node", type, store.plan); if (!e) return false;
  const lab = A.OPT("node", "type")[type] || type;
  if (parent) delete e.at;
  if (!e.label) e.label = lab;
  const ok = A.planOps(`加了${lab}${parent ? `（在${A.labelOf(parent)}里）` : ""}`, [{ op: "add", to: parent || "root", value: e }]);
  if (ok && findNode(store.plan, e.id)) {
    store.open.add(e.id);
    const s = type === "space" && A.spaceOf({ plan_id: e.id });
    A.select({ type: type === "space" ? "space" : "node", plan_id: e.id, sid_id: s ? s.id : null });
  }
  return ok;
}
function addTerrainSelect() {
  const OP = A.OPT("terrain_op", "op"), full = store.plan.terrain.length >= TERRAIN_MAX;
  return el("select", { class: "add", "data-add": "terrain", disabled: full || null, title: full ? `最多 ${TERRAIN_MAX} 个` : "加一个雕刻操作（可撤销）", onchange: (e) => { const v = e.target.value; e.target.value = ""; if (v) addTerrain(v); } },
    el("option", { value: "" }, full ? `已满 ${TERRAIN_MAX} 个` : "＋ 加地形操作…"), ...Object.entries(OP).map(([v, l]) => el("option", { value: v }, l)));
}
export function addTerrain(op) {
  const e = newElement("terrain", op, store.plan); if (!e) return false;
  const lab = A.OPT("terrain_op", "op")[op] || op;
  if (!e.label) e.label = lab;
  const ok = A.planOps(`加了地形：${lab}`, [{ op: "add", to: "terrain", value: e }]);
  if (ok) { store.open.add(e.id); A.select({ type: "feature", plan_id: e.id }); }
  return ok;
}
function addRelSelect() {
  const k = knobsFor("relation", { type: "visible_from" }, PLAN_SCHEMA, store.plan).find((x) => x.path === "type");
  return el("select", { class: "add", "data-add": "relation", onchange: (e) => { const v = e.target.value; e.target.value = ""; if (!v) return; const r = newElement("relations", v, store.plan); if (A.planOps("加了一条关系", [{ op: "add", to: "relations", value: r }])) { store.open.add(`rel:${store.plan.relations.length - 1}`); renderSide(); } } },
    el("option", { value: "" }, "＋ 加一条关系…"), ...((k && k.options) || []).map((o) => el("option", { value: o.value }, o.label)));
}

// ---------- 旋钮（从 schema 生成）
function knobsBlock(it) {
  const ks = knobsFor(it.kg, it.el, PLAN_SCHEMA, store.plan);
  const box = el("div", { class: "knobs" });
  let sec = null;
  for (const k of ks) {
    if (k.kind === "node" || k.kind === "palette") continue; // 模板在树里单独成行；色板在外观下面单独画
    if (k.section !== sec) { sec = k.section; if (sec && it.kind !== "look") box.append(el("div", { class: "ksec" }, sec)); }
    box.append(el("div", { class: "krow", "data-path": k.path, "data-kind": k.kind }, numLabel(it, k), ctlFor(it, k)));
  }
  const n = it.el || {};
  if (it.kind === "node" || it.kind === "template") {
    if (n.type === "repeat" && it.kind === "node") {
      const sk = (n.skip || []).length, ov = Object.keys(n.overrides || {}).length;
      box.append(el("div", { class: "hint" }, `实例 ${instCount(n.id)} 个。图上点一个 = 选中它；拖 = 整组一起挪，按住 Alt 拖 = 只挪这一个。`));
      if (sk || ov) box.append(el("div", { class: "selact" }, sk ? btn(`恢复去掉的 ${sk} 个`, () => A.planOps(`${it.name}恢复全部实例`, [{ op: "set", id: n.id, field: "skip", value: null }])) : null, ov ? btn(`清掉 ${ov} 个实例的单独改动`, () => A.planOps(`${it.name}的实例都回到模板`, [{ op: "set", id: n.id, field: "overrides", value: null }])) : null));
    }
    if (n.type === "group") box.append(el("div", { class: "addrow in" }, addNodeSelect(n.id)));
    if (n.type === "space") box.append(spaceExtras(it));
    const solid = !["group", "repeat", "link", "space"].includes(n.type);
    if (it.kind === "node" && (solid || n.type === "group" || n.type === "repeat")) box.append(el("div", { class: "selact" }, btn("剖到这里", () => sectionTo({ type: "node", plan_id: A.hlId(it.ref) })), n.role === "landmark" ? btn("看第一眼", () => A.setView("eye")) : null));
  }
  if (it.kind === "look") box.append(lookExtras());
  return box;
}
/** 数字旋钮的名字可以左右拖（每 8 px 一步），松手才改 */
function numLabel(it, k) {
  const l = el("span", { class: "kl" + (k.kind === "number" ? " drag" : ""), title: k.hint || (k.kind === "number" ? "左右拖改数值" : "") }, k.label);
  if (k.kind !== "number") return l;
  l.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const x0 = e.clientX, v0 = Number(k.value ?? k.default ?? k.min ?? 0), step = k.step || 1, val = l.parentNode.querySelector(".val");
    let v = v0;
    const mv = (ev) => { v = clampK(k, v0 + Math.round((ev.clientX - x0) / 8) * step); if (val) val.value = fmtNum(v); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (v !== v0) setKnob(it, k, v); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });
  return l;
}
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const clampK = (k, v) => { let x = Math.round(v / (k.step || 1)) * (k.step || 1); x = Math.round(x * 100) / 100; if (k.min != null) x = Math.max(k.min, x); if (k.max != null) x = Math.min(k.max, x); return x; };
function stepper(k, value, on, cls = "") {
  const v = value ?? k.default, inp = el("input", { class: "val", type: "text", inputmode: "decimal", value: v == null ? "" : fmtNum(v), placeholder: "—", onchange: (e) => { const n = Number(e.target.value); if (e.target.value === "") on(null); else if (Number.isFinite(n)) on(clampK(k, n)); } });
  const base = () => Number(v ?? k.min ?? 0);
  return el("span", { class: "stepper " + cls }, btn("−", () => on(clampK(k, base() - (k.step || 1))), "minus"), inp, k.unit ? el("span", { class: "unit" }, k.unit) : null, btn("+", () => on(clampK(k, base() + (k.step || 1))), "plus"));
}
function optLabel(k, v) { const o = (k.options || []).find((x) => x.value === v); return o ? o.label : v; }
/** 一组数字输入（尺寸 / 偏移 / 场地）：parts 是每格的名字；空着的尾巴不写 */
function numParts(k, arr, parts, set, step = 0.5) {
  return el("span", { class: "parts" }, parts.map((pl, i) => el("label", { class: "part" }, el("span", {}, pl), el("input", { class: "val", type: "text", inputmode: "decimal", "data-i": i, value: arr[i] != null ? fmtNum(arr[i]) : "", placeholder: "—", onchange: (e) => {
    const raw = e.target.value.trim(), n = Number(raw), a = parts.map((_, j) => (arr[j] != null ? Number(arr[j]) : undefined));
    if (raw === "") { if (i === 0) return; a[i] = undefined; } else { if (!Number.isFinite(n)) return; a[i] = clampK(Object.assign({}, k, { step: k.step || step }), n); }
    for (let j = 0; j < a.length; j++) if (a[j] === undefined && a.slice(j + 1).some((x) => x !== undefined)) a[j] = a[0] ?? 0;
    while (a.length && a[a.length - 1] === undefined) a.pop();
    set(a);
  } }))), k.unit ? el("span", { class: "unit" }, k.unit) : null);
}
function anchorCtl(it, k, v, set) {
  const opts = (k.options || []).slice();
  let base = "", suf = "";
  if (typeof v === "string" && v) { if (/^site\./.test(v) || v === "spawn") base = v; else { const m = /^([a-z][a-z0-9_]*(?:\[\d+\])?)(?:\.(\w+))?$/.exec(v); base = m ? m[1] : v; suf = (m && m[2]) || ""; } }
  if (base && !opts.some((o) => o.value === base)) opts.push({ value: base, label: A.labelOf(base) });
  const blank = it.kind === "template" || !!(findNode(store.plan, it.ref) || {}).parent || it.kind === "rel";
  const sb = pick(opts, base || null, (nb) => set(nb ? (/^site\./.test(nb) || nb === "spawn" || !suf ? nb : `${nb}.${suf}`) : null), blank || !base);
  const ss = pick(k.suffixes || [], suf, (ns) => set(ns ? `${base}.${ns}` : base), false);
  if (!base || /^site\./.test(base) || base === "spawn") ss.hidden = true;
  return el("span", { class: "sctl anchor" }, sb, ss);
}
function ctlFor(it, k) {
  const set = (v) => setKnob(it, k, v), v = k.value;
  switch (k.kind) {
    case "text": return el("input", { class: "txt", type: "text", value: v || "", maxlength: k.path === "label" ? 16 : 60, onchange: (e) => set(e.target.value.trim() || null) });
    case "number": return stepper(k, v, set);
    case "bool": return seg([[true, "是"], [false, "否"]], !!v, set);
    case "enum": case "dir": {
      const opts = k.options || [];
      if (opts.length <= 7 && k.kind === "enum") return seg(opts.map((o) => [o.value, o.label]), v ?? k.default, set);
      return pick(opts, v, set, v == null);
    }
    case "anchor": return anchorCtl(it, k, v, set);
    case "offset": { const arr = Array.isArray(v) ? v : [0, 0]; return numParts(Object.assign({}, k, { min: -500, max: 500 }), arr, arr.length >= 3 ? ["东", "上", "南"] : ["东", "南"], set, k.step || 1); }
    case "size": { const arr = Array.isArray(v) ? v : typeof v === "number" ? [v] : []; return numParts(k, arr, k.parts && k.parts.length ? k.parts : ["宽", "高", "深"], (a) => set(a.length ? a : null), k.step || 0.5); }
    case "ref": {
      if (Array.isArray(v)) return el("span", { class: "sctl" }, v.map((x, i) => pick(k.options, x, (nv) => { const a = v.slice(); a[i] = nv; set(a); }, false)));
      return pick(k.options || [], v, set, v == null || !["a", "b"].includes(k.key));
    }
    case "refs": { const cur = new Set(v || []); return el("span", { class: "seg wrap" }, (k.options || []).map((o) => el("button", { type: "button", class: cur.has(o.value) ? "on" : "", onclick: () => { if (cur.has(o.value)) cur.delete(o.value); else cur.add(o.value); set([...cur]); } }, o.label))); }
    case "pair": case "triple": {
      const arr = Array.isArray(v) ? v : Array.isArray(k.default) ? k.default : typeof v === "number" ? [v, v] : [];
      return numParts(k, arr, k.parts || (k.kind === "pair" ? ["长", "宽"] : ["宽", "高", "深"]), (a) => set(a.length ? a : null), k.step || 0.5);
    }
    case "color": return el("input", { type: "color", value: v || "#888888", onchange: (e) => set(e.target.value.toUpperCase()) });
    case "tags": return el("input", { class: "txt", type: "text", value: (v || []).join("、"), placeholder: "用顿号隔开", onchange: (e) => set(e.target.value.split(/[、,，\s]+/).map((s) => s.trim().slice(0, 12)).filter(Boolean).slice(0, 8)) });
    case "rooms": return roomsCtl(v || [], set);
    case "links": return linksCtl(it, v || [], set);
    default: return el("span", { class: "hint" }, v == null ? "—" : JSON.stringify(v));
  }
}
function seg(items, cur, on) { return el("span", { class: "seg" }, items.map(([v, l]) => el("button", { type: "button", class: v === cur ? "on" : "", "data-v": String(v), "aria-pressed": String(v === cur), onclick: () => { if (v !== cur) on(v); } }, l))); }
function pick(options, cur, on, blank) {
  const s = el("select", { class: "ref", onchange: (e) => on(e.target.value === "" ? null : e.target.value) }, blank ? el("option", { value: "" }, "—") : null, (options || []).map((o) => el("option", { value: o.value }, o.label)));
  s.value = cur == null ? "" : cur;
  return s;
}
function roomsCtl(rooms, set) {
  const upd = (i, patch) => set(rooms.map((r, j) => (j === i ? Object.assign({}, r, patch) : r)));
  const add = () => { let n = rooms.length + 1; while (rooms.some((r) => r.id === "r" + n)) n++; set(rooms.concat({ id: "r" + n, label: `房间 ${n}`, size: "m" })); };
  return el("div", { class: "rooms" }, rooms.map((r, i) => el("div", { class: "room" },
    el("input", { class: "txt", type: "text", value: r.label || r.id, maxlength: 12, onchange: (e) => upd(i, { label: e.target.value.trim() || r.id }) }),
    seg([["s", "小"], ["m", "中"], ["l", "大"]], r.size || "m", (v) => upd(i, { size: v })),
    btn("×", () => set(rooms.filter((_, j) => j !== i)), "x", "去掉这个房间"))), btn("＋ 房间", add, "sm"));
}
function linksCtl(it, links, set) {
  const opts = [{ value: "entry", label: "入口" }].concat((it.el.rooms || []).map((r) => ({ value: r.id, label: r.label || r.id })));
  const upd = (i, j, v) => set(links.map((l, k) => (k === i ? (j === 0 ? [v, l[1]] : [l[0], v]) : l)));
  return el("div", { class: "links" }, links.map((l, i) => el("div", { class: "link" }, pick(opts, l[0], (v) => upd(i, 0, v), false), el("span", {}, "—"), pick(opts, l[1], (v) => upd(i, 1, v), false), btn("×", () => set(links.filter((_, k) => k !== i)), "x"))),
    opts.length > 1 ? btn("＋ 连接", () => set(links.concat([[opts[0].value, opts[opts.length - 1].value]])), "sm") : null);
}
function setKnob(it, k, v) {
  const shown = v == null ? "（清空）" : k.kind === "number" ? ` ${fmtNum(v)}${k.unit ? " " + k.unit : ""}` : ["enum", "dir", "ref", "bool"].includes(k.kind) ? ` ${k.kind === "bool" ? (v ? "是" : "否") : optLabel(k, v)}` : k.kind === "anchor" ? ` ${A.labelOf(String(v).replace(/\.\w+$/, ""))}${/\./.test(v) && !/^site\./.test(v) ? "·" + String(v).split(".").pop() : ""}` : Array.isArray(v) ? ` ${v.map(fmtNum).join(" / ")}${k.unit ? " " + k.unit : ""}` : k.kind === "text" ? `「${v}」` : "";
  const text = k.path === "label" ? `${it.name}改名${shown}` : `${it.name}：${k.label}${shown}`;
  if (it.kind === "rel") { const i = +it.ref.slice(4); return A.edit(text, (s) => { const p = clone(s.plan), o = p.relations[i]; if (!o) return false; setPath(o, k.path, v); s.plan = normalizePlan(p).plan; }); }
  let id = it.ref, field = k.path;
  if (it.kind === "look") { if (field.startsWith("lighting.")) { id = "lighting"; field = field.slice(9); } else id = "plan"; }
  return A.planOps(text, [{ op: "set", id, field, value: v }]);
}
function setPath(o, path, v) { const ks = path.split("."), last = ks.pop(); for (const k of ks) o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; if (v == null) delete o[last]; else o[last] = v; }

// ---------- 空间：「换一个」（换 layout_seed）+ 内部层切换 + 看那一层 + 事实
function spaceExtras(it) {
  const s = A.spaceOf({ plan_id: it.ref }), f = ((store.facts.spaces && store.facts.spaces.items) || []).find((x) => x.plan_id === it.ref || (s && x.id === s.id));
  const L = (it.el.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[it.el.layout] || "布局";
  const box = el("div", { class: "space-x" });
  const again = btn("换一个", () => A.planOps(`${it.name}换了一个${L}`, [{ op: "set", id: it.ref, field: "layout_seed", value: A.nextSeed(it.el.layout_seed ?? (store.seed * 31 + it.ref.length)) }]), "again", "同样的参数，换一种内部布局（本地，不调 AI）");
  const n = s ? levelsOf(s) : 1, here = s && store.stratum === s.stratum && store.sel && store.sel.plan_id === it.ref;
  const levels = n > 1 ? el("span", { class: "seg lv" }, [...Array(n).keys()].map((k) => el("button", { type: "button", class: here && store.interiorLevel === k ? "on" : "", "data-level": k, title: `看内部${A.kName(k)}`, onclick: () => { if (!here) A.select({ type: "space", plan_id: it.ref, sid_id: s.id }); A.setInteriorLevel(k); } }, k === 0 ? "入口" : `${k + 1} 层`))) : null;
  box.append(el("div", { class: "selact" }, again, levels ? el("span", { class: "hint" }, "内部层") : null, levels,
    s ? btn(`看${STRATUM_LABEL[s.stratum]}层`, () => { A.select({ type: "space", plan_id: it.ref, sid_id: s.id }); A.setView("map"); }) : null, s ? btn("剖到这里", () => sectionTo({ type: "space", plan_id: it.ref, sid_id: s.id })) : null));
  if (f) box.append(el("div", { class: "hint facts" }, [`通道 ${Math.round(f.passage_m || 0)} m`, `房间 ${f.rooms || 0}`, f.dead_ends ? `死路 ${f.dead_ends}` : null, f.loops ? `回环 ${f.loops}` : null, f.longest_route_m ? `入口到终点 ${Math.round(f.longest_route_m)} m` : null].filter(Boolean).join(" · ")));
  return box;
}

// ---------- 外观：色板 / 偏冷偏暖 / 风格板 / 参考图取色
export const STYLE_BOARDS = {
  default: { name: "青瓦夯土", items: [["roof", "#4A4A4A", "青瓦"], ["wall", "#D9C9A3", "夯土墙"], ["stone", "#9A9890", "石阶"], ["foliage", "#4F6B3A", "树"], ["mist", "#DDE6F0", "雾"]] },
  arcane: { name: "星夜法塔", items: [["roof", "#2E3A6B", "靛蓝瓦"], ["wall", "#D8D2C4", "白石"], ["stone", "#7D7A85", "岩"], ["foliage", "#3F5E4A", "苔"], ["mist", "#C9D6F2", "星雾"]], tod: "night" },
  desert: { name: "砂岩烈日", items: [["roof", "#9C5B32", "赭顶"], ["wall", "#E2C48E", "砂岩"], ["stone", "#B89A6A", "沙石"], ["foliage", "#7A8B4A", "棕榈"], ["mist", "#F3E3C0", "热霾"]], tod: "noon" },
  neon: { name: "霓虹雨夜", items: [["roof", "#1E2230", "黑铁"], ["wall", "#3A3F55", "混凝土"], ["stone", "#55596B", "湿路面"], ["foliage", "#2F4A3A", "暗绿"], ["mist", "#FF4FA3", "霓虹雾"]], tod: "night" },
};
const curPalette = () => (store.sid && store.sid.style && store.sid.style.palette) || store.plan.palette || [];
const setPalette = (label, pal, extra = []) => A.planOps(label, [{ op: "set", id: "plan", field: "palette", value: pal.map((c) => ({ role: c.role, hex: String(c.hex).toUpperCase(), note: (c.note || "").slice(0, 12) || undefined })) }].concat(extra));
function lookExtras() {
  const pal = curPalette(), box = el("div", { class: "look" });
  box.append(el("div", { class: "ksec" }, "色板"), el("div", { class: "palette" }, pal.map((c, i) => el("label", { class: "sw", title: c.note || c.role },
    el("input", { type: "color", value: c.hex, onchange: (e) => setPalette(`${c.note || c.role}改成 ${e.target.value.toUpperCase()}`, pal.map((x, j) => (j === i ? Object.assign({}, x, { hex: e.target.value }) : x))) }), el("span", {}, c.note || c.role)))));
  box.append(el("div", { class: "shift" }, [["cool", "偏冷"], ["neutral", "中性"], ["warm", "偏暖"], ["desaturate", "灰一点"]].map(([m, l]) => btn(l, () => setPalette(`色板${l}`, paletteShift(pal, m)), "sm"))));
  const input = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) onReference(f); ev.target.value = ""; } });
  box.append(el("div", { class: "refrow" }, btn(store.reference ? "换参考图" : "给一张参考图取色", () => input.click(), "sm"), store.reference ? el("span", { class: "hint" }, `取了 ${store.reference.k} 色`) : el("span", { class: "hint" }, "或挑一个风格板："), input));
  if (store.reference) box.append(el("img", { class: "refimg", src: store.reference.url, alt: "参考图" }));
  box.append(el("div", { class: "boards" }, Object.entries(STYLE_BOARDS).map(([k, b]) => el("div", { class: "board" + (store.board === k ? " on" : ""), onclick: () => { store.board = k; store.reference = null; setPalette(`色板：${b.name}`, b.items.map(([role, hex, note]) => ({ role, hex, note })), b.tod ? [{ op: "set", id: "lighting", field: "time_of_day", value: b.tod }] : []); } },
    el("div", { class: "strip" }, b.items.map(([, hex]) => el("i", { style: `background:${hex}` }))), b.name))));
  return box;
}
function onReference(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"), sc = Math.min(1, 256 / Math.max(img.width, img.height));
    c.width = Math.max(8, Math.round(img.width * sc)); c.height = Math.max(8, Math.round(img.height * sc));
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
    const colors = extractPalette(g.getImageData(0, 0, c.width, c.height), { k: 6, seed: store.seed });
    store.reference = { url, k: colors.length }; store.board = null;
    setPalette(`从参考图取了 ${colors.length} 个主色`, assignRoles(colors.map((x) => x.hex)));
  };
  img.src = url;
}

// ============================================================ 选中卡：场景树里没有单独一行的东西（重复里的单个实例 / 空间内部的部件 / 连接点 / 一个点）
function renderSel(box) {
  box.replaceChildren();
  const s = store.sel; if (!s || !store.sid) return false;
  const sid = store.sid, head = (t, d) => box.append(el("div", { class: "selhead" }, el("b", {}, t), d ? el("span", { class: "d" }, d) : null));
  const acts = (...b) => box.append(el("div", { class: "selact" }, ...b.filter(Boolean)));
  const tip = (t) => box.append(el("div", { class: "hint" }, t));
  if (s.inst && INST.test(s.inst)) {
    const m = INST.exec(s.inst), f = findNode(store.plan, m[1]); if (!f) return false;
    const k = +m[2], rep = f.node, v = A.volOf(s.sid_id), ov = (rep.overrides || {})[String(k)];
    head(A.labelOf(s.inst), `「${A.labelOf(m[1])}」× ${instCount(m[1])} 的第 ${k + 1} 个${v ? ` · ${r1(v.size[0])}×${r1(v.size[2])} m · 高 ${r1(v.size[1])} m${v.elev > 0.5 ? ` · 离地 ${r1(v.elev)} m` : ""}` : ""}`);
    acts(btn("只去掉这一个", () => A.removePlanItem(s.inst), "", "写进重复的 skip（可撤销）"),
      ov ? btn("回到模板", () => { const o = Object.assign({}, rep.overrides); delete o[String(k)]; A.planOps(`${A.labelOf(s.inst)}回到模板`, [{ op: "set", id: rep.id, field: "overrides", value: Object.keys(o).length ? o : null }]); }) : null,
      btn("剖到这里", () => sectionTo(s)));
    tip(ov ? `它有单独的改动：${Object.keys(ov).join("、")}。` : "拖它 = 整组一起挪；按住 Alt 拖 = 只挪这一个（记在重复的 overrides 里）。");
    return true;
  }
  if (s.type === "connector") {
    const m = sid.markers.find((x) => x.id === s.sid_id); if (!m) return false;
    const sp = sid.spaces.find((x) => x.id === m.to || x.id === m.from || x.plan_id === m.plan_id), pn = sp && sp.plan_id && findNode(store.plan, sp.plan_id);
    head(`连接点 · ${VIA_LABEL[m.via] || m.via}`, `地面 ↔ ${sp ? sp.label : "空间"} · 下端 ${r1(m.bottom_y ?? m.position[1])} m · 上端 ${r1(m.top_y ?? m.position[1])} m`);
    if (pn) box.append(el("div", { class: "krow" }, el("span", { class: "kl" }, "怎么连"), seg(CONNECTOR_VIA.filter((v) => (sp.stratum === "sky" ? v !== "well" && v !== "shaft" : v !== "rope_bridge")).map((v) => [v, VIA_LABEL[v]]), m.via, (v) => A.planOps(`${sp.label}改用${VIA_LABEL[v]}连接`, [{ op: "set", id: pn.node.id, field: "connect.via", value: v }]))));
    tip("连接点的位置跟着空间与它连到的节点走：改空间的「连到」或拖空间。");
    return true;
  }
  if (["entrance", "goal", "link"].includes(s.type)) {
    const sp = A.spaceOf(s); if (!sp) return false;
    head(`${sp.label} · ${{ entrance: "入口", goal: "终点", link: "层间连接" }[s.type]}`, `${STRATUM_LABEL[sp.stratum]} · ${(sp.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[sp.layout] || ""}${levelsOf(sp) > 1 ? ` · 共 ${levelsOf(sp)} 层` : ""}`);
    tip(s.type === "goal" ? "终点放在离入口最远的地方（按通道走的距离）。" : s.type === "link" ? "上下层在这里连通。" : "从地面下来的连接点落在这里。");
    return true;
  }
  if (s.type === "passage" || s.type === "room") {
    const sp = A.spaceOf(s); if (!sp) return false;
    const n = levelsOf(sp);
    if (s.type === "passage") {
      const p = (sp.passages || []).find((x) => x.id === s.part); if (!p) return false;
      let L = 0; for (let i = 1; i < p.points.length; i++) L += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]);
      head(`${sp.label} · 通道`, `${A.levelName(p.sublevel | 0, n) || "单层"} · 宽 ${r1(p.width)} m · 长 ${Math.round(L)} m · 底面 ${r1(p.floor_y)} m`);
      acts(btn("剖到这里", () => sectionTo(s)));
    } else {
      const r = (sp.rooms || []).find((x) => x.id === s.part); if (!r) return false;
      head(`${sp.label} · ${r.label || ROLE_LABEL[r.role] || "房间"}`, `${A.levelName(r.sublevel | 0, n) || "单层"} · ${Math.round(Math.abs(polygonArea(r.polygon)))} m² · 净高 ${r1(r.height)} m`);
    }
    tip("内部是按布局生成的：在场景树里改布局、岔路、层数，或「换一个」。");
    return true;
  }
  if (s.type === "trail_vertex" || s.sid_id === "main_trail") {
    const f = store.facts.trail || {};
    head("主路（引擎补的）", `${Math.round(f.length_m || 0)} m · 爬升 ${Math.round(f.climb_m || 0)} m`);
    tip("程序里没有从出生点出发的连接时，引擎自动补一条主路。要改就「画路」加一条连接。");
    return true;
  }
  if (s.type === "ground" && s.p) {
    const p = s.p, sp = MapView.spawnOf(sid), h = store.T.heightAt(p[0], p[1]);
    head(store.stratum === "ground" ? "这一点" : `${STRATUM_LABEL[store.stratum]}层`, `地面 ${r1(h)} m${sp ? ` · 比出生点高 ${Math.round(h - store.T.heightAt(sp.position[0], sp.position[2]))} m · 离出生点 ${Math.round(Math.hypot(p[0] - sp.position[0], p[1] - sp.position[2]))} m` : ""}`);
    tip(store.stratum === "ground" ? "「画路」从一个东西画到另一个 = 加一条连接；「圈区域」= 加树林 / 田 / 撒房子 / 水池 / 平台。" : `用「圈区域」在这一层圈一块，就是一个新的${STRATUM_LABEL[store.stratum]}空间。`);
    return true;
  }
  return false;
}

// ============================================================ 剖到这里：直线剖切过对象中心，保持当前角度，宽度至少盖住它
export function sectionTo(t) {
  const sid = store.sid; if (!sid || !t) return;
  let pts = null, name = "这里";
  const sp = (t.type === "space" || t.type === "passage" || t.type === "room") && A.spaceOf(t);
  if (sp) { pts = sp.polygon; name = sp.label; }
  else {
    const v = A.volOf(t.sid_id);
    if (v) { pts = MapView.footprintPolygon(v); name = v.label || "这里"; }
    else if (t.plan_id) { const g = resolveTarget(sid, store.T, t.plan_id); if (g) { pts = g.polygon && g.polygon.length >= 2 ? g.polygon : g.point ? [[g.point[0] - 4, g.point[1] - 4], [g.point[0] + 4, g.point[1] + 4]] : null; name = g.label || A.labelOf(t.plan_id); } }
  }
  if (!pts || pts.length < 2) return;
  const b = sid.bounds, xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const c = [clamp((Math.min(...xs) + Math.max(...xs)) / 2, b.min[0] + 1, b.max[0] - 1), clamp((Math.min(...zs) + Math.max(...zs)) / 2, b.min[2] + 1, b.max[2] - 1)];
  const cur = A.sectionSpec(), L = cur.line || [];
  let d = L.length >= 2 ? [L[1][0] - L[0][0], L[1][1] - L[0][1]] : [1, 0];
  const n = Math.hypot(d[0], d[1]); d = n > 1e-6 ? [d[0] / n, d[1] / n] : [1, 0];
  let t0 = -Infinity, t1 = Infinity;
  const lo = [b.min[0] + 1, b.min[2] + 1], hi = [b.max[0] - 1, b.max[2] - 1];
  for (let k = 0; k < 2; k++) { if (Math.abs(d[k]) < 1e-9) continue; const a = (lo[k] - c[k]) / d[k], e = (hi[k] - c[k]) / d[k]; t0 = Math.max(t0, Math.min(a, e)); t1 = Math.min(t1, Math.max(a, e)); }
  const line = [[r1(c[0] + d[0] * t0), r1(c[1] + d[1] * t0)], [r1(c[0] + d[0] * t1), r1(c[1] + d[1] * t1)]];
  const need = 2 * Math.max(...pts.map((p) => Math.abs((p[0] - c[0]) * -d[1] + (p[1] - c[1]) * d[0]))) + 2;
  const width = Math.ceil(Math.max(cur.width_m || 12, need));
  A.edit(`剖到${name}`, (s) => { s.section = { mode: "line", line, width_m: Math.min(60, width) }; s.view = "profile"; }, { geometry: false });
  if (store.view !== "profile") A.setView("profile");
}

// ============================================================ 检查（✗ 在前；全 ✓ 折成一行）
export function humanize(s) {
  const p = store.plan;
  return String(s || "").replace(/main_trail/g, "主路")
    .replace(/\b([a-z][a-z0-9_]*)\[(\d+)\]/g, (m) => (p && findNode(p, m.replace(/\[\d+\]$/, "")) ? A.labelOf(m) : m))
    .replace(/\b([a-z][a-z0-9_]*)_(\d+)\b/g, (m, id, k) => { const f = p && findNode(p, id); return f && f.node.type === "repeat" ? A.labelOf(`${id}[${k}]`) : m; });
}
function renderChecks(ul) {
  ul.replaceChildren();
  const checks = store.checks || [], ig = new Set(store.ignored);
  if (!checks.length) { ul.append(el("li", {}, el("div", { class: "t hint" }, "还没有可检查的东西"))); return; }
  const row = (c) => {
    const ignored = ig.has(c.id) || c.ignored;
    return el("li", { class: ignored ? "ignored" : "", "data-check": c.id }, el("span", { class: c.ok ? "ok" : c.severity === "warn" ? "warn" : "bad" }, c.ok ? "✓" : "✗"),
      el("div", { class: "t" }, humanize(c.text), c.detail ? el("span", { class: "d" }, humanize(c.detail)) : null,
        !c.ok && !ignored && c.fixes && c.fixes.length ? el("div", { class: "fixes" }, c.fixes.map((f, i) => btn(f.label, () => A.applyFix(c, i)))) : null,
        ignored ? el("span", { class: "d" }, "你说不重要 · ", btn("重新算", () => A.edit("这条重新算", (s) => { s.ignored = s.ignored.filter((x) => x !== c.id); }))) : null));
  };
  const toggle = (l) => btn(l, () => { store.checksOpen = !store.checksOpen; renderSide(); });
  const bad = checks.filter((c) => !c.ok && !(ig.has(c.id) || c.ignored)), igd = checks.filter((c) => !c.ok && (ig.has(c.id) || c.ignored)), good = checks.filter((c) => c.ok);
  $("#p-checks h3 .count").textContent = bad.length ? `${bad.length} 项不成立` : `${good.length}/${checks.length} ✓`;
  if (!bad.length && !igd.length && !store.checksOpen) { ul.append(el("li", { class: "confirmed" }, el("span", { class: "ok" }, "✓"), el("div", { class: "t" }, `${checks.length} 项都成立（看得见、走得到、不压、不悬空、关系）`), toggle("展开"))); return; }
  for (const c of bad.concat(igd)) ul.append(row(c));
  if (store.checksOpen) { for (const c of good) ul.append(row(c)); ul.append(el("li", {}, el("div", { class: "t hint" }, "每条 ✓ / ✗ 都是引擎按几何算的"), toggle("收起"))); }
  else if (good.length) ul.append(el("li", { class: "confirmed" }, el("span", { class: "ok" }, "✓"), el("div", { class: "t" }, `其余 ${good.length} 项 ✓`), toggle("展开")));
}

// ============================================================ AI 设置（服务商 / 密钥 / 模型 / 思考；密钥只进输入框和 /api/config，不回显）
const KEY_LABEL = { anthropic: "Anthropic API Key", deepseek: "DeepSeek API Key" }, KEY_PH = { anthropic: "sk-ant-…", deepseek: "sk-…" };
const MODELS = { anthropic: ["claude-opus-5-5", "claude-sonnet-4-5"], deepseek: ["deepseek-flash", "deepseek-v4-pro"] };
let CFG = null, prov = "deepseek", refreshing = false;
const typed = {};
export function aiLabel(h) { if (!h) return ""; const m = String(h.model || "").replace(/^deepseek-|^claude-/, ""); return `${h.provider_label || (h.provider === "anthropic" ? "Claude" : "DeepSeek")} ${m}`.trim() + (h.thinking ? " · 思考" : ""); }
export async function refreshAI() {
  if (refreshing) return; refreshing = true;
  try {
    const h = await A.API.health(), pill = $("#ai-status");
    store.ai = h;
    if (!h) { pill.textContent = "AI：服务未连接"; pill.title = "本地服务没响应：用 python desktop/app.py 启动"; pill.className = "pill mock"; }
    else if (h.mock || store.mock) { pill.textContent = "AI：模拟 · 点我设置"; pill.title = "没有密钥或勾了模拟：用脚本模拟，不花钱"; pill.className = "pill mock"; }
    else { pill.textContent = `AI：${aiLabel(h)}`; pill.title = "只有打字、重出、换一批才调 AI；点我改设置"; pill.className = "pill live"; }
  } finally { refreshing = false; }
}
export function markPill(kind) { const p = $("#ai-status"); if (kind === "auth") { p.textContent = "AI：密钥无效，点此设置"; p.className = "pill bad"; } else if (kind === "offline") { p.textContent = "AI：服务未连接"; p.className = "pill mock"; refreshAI(); } }
function stash() { typed[prov] = { key: $("#s-key").value, model: $("#s-model").value, think: $("#s-think").checked }; }
function fillSettings() {
  const pc = (CFG && CFG.providers && CFG.providers[prov]) || {}, t = typed[prov] || {};
  document.querySelectorAll("#s-prov button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === prov)));
  $("#s-key-label").textContent = KEY_LABEL[prov];
  $("#s-key").value = t.key || ""; $("#s-key").type = "password"; $("#s-show").textContent = "显示";
  $("#s-key").placeholder = pc.has_key ? `已保存 ${pc.key_hint}（留空不改）` : KEY_PH[prov];
  $("#s-model").value = t.model || pc.model || MODELS[prov][0];
  $("#s-models").replaceChildren(...[...(pc.models || []), ...MODELS[prov]].filter((v, i, a) => v && a.indexOf(v) === i).map((v) => el("option", { value: v })));
  $("#s-think-row").hidden = prov !== "deepseek"; $("#s-think").checked = t.think ?? !!pc.thinking;
  $("#s-mock").checked = !!(CFG && CFG.mock_forced); $("#s-mock").disabled = !pc.has_key && !t.key;
  $("#s-clear").hidden = !pc.has_key || pc.key_source === "env";
  $("#s-key-hint").textContent = pc.key_source === "env" ? "当前密钥来自环境变量（这里清不掉）" : pc.has_key ? "" : `没有 ${KEY_LABEL[prov]}：会用模拟 AI。填上后保存前会先测一次。`;
  $("#s-test-result").textContent = "";
}
export async function openSettings() {
  CFG = null;
  try { CFG = await A.API.config(); } catch { /* 服务未连接 */ }
  for (const k of Object.keys(typed)) delete typed[k];
  if (CFG) { prov = CFG.provider || "deepseek"; fillSettings(); } else { $("#s-key-hint").textContent = "本地服务未连接：请用 python desktop/app.py 启动"; $("#s-mock").disabled = true; $("#s-clear").hidden = true; }
  if (!$("#settings").open) $("#settings").showModal();
}
const TEST_ERR = { auth: "密钥无效或过期", net: "连不上服务商（网络 / 代理）", offline: "本地服务没响应", timeout: "等太久没回来", model: "模型名不对", rate: "请求太频繁或余额不足", busy: "模型繁忙" };
async function testKeySafe(key, opts) { try { return await A.API.testKey(key, opts); } catch (e) { const d = (e && e.data) || {}; return { ok: false, message: (d.hint && !/Error code|\{/.test(d.hint) ? d.hint : null) || TEST_ERR[e && e.kind] || "服务出错" }; } }
export function bindSettings() {
  $("#ai-status").addEventListener("click", openSettings);
  document.querySelectorAll("#s-prov button").forEach((b) => b.addEventListener("click", () => { stash(); prov = b.dataset.p; fillSettings(); }));
  $("#s-cancel").addEventListener("click", () => $("#settings").close());
  $("#s-show").addEventListener("click", () => { const k = $("#s-key"); k.type = k.type === "password" ? "text" : "password"; $("#s-show").textContent = k.type === "password" ? "显示" : "隐藏"; });
  $("#s-key").addEventListener("input", () => { $("#s-mock").disabled = !$("#s-key").value.trim() && !(CFG && CFG.providers && CFG.providers[prov] && CFG.providers[prov].has_key); });
  const lockB = (on) => ["#s-save", "#s-test", "#s-clear"].forEach((s) => { $(s).disabled = on; });
  $("#s-clear").addEventListener("click", async () => {
    if (!confirm(`清除本机保存的 ${KEY_LABEL[prov]}？`)) return;
    try { await A.API.setConfig({ providers: { [prov]: { api_key: "" } } }); await refreshAI(); A.sys("密钥已清除。"); openSettings(); } catch (e) { $("#s-test-result").textContent = "清除失败：" + e.message; }
  });
  const model = () => $("#s-model").value.trim() || undefined;
  $("#s-test").addEventListener("click", async () => {
    const key = $("#s-key").value.trim(), who = key ? "刚输入的密钥" : "已保存的密钥";
    $("#s-test-result").textContent = `${who}：测试中…`; lockB(true);
    try { const r = await testKeySafe(key || undefined, { provider: prov, model: model() }); $("#s-test-result").textContent = `${who}：${r.ok ? `可用 · ${r.model} · ${r.ms} ms` : `不可用：${r.message}`}`; } finally { lockB(false); }
  });
  $("#settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pc = { model: model() }, key = $("#s-key").value.trim();
    if (prov === "deepseek") pc.thinking = $("#s-think").checked;
    lockB(true);
    try {
      if (key) { $("#s-test-result").textContent = "先测一下…"; const r = await testKeySafe(key, { provider: prov, model: pc.model }); if (!r.ok) { $("#s-test-result").textContent = `不可用：${r.message}，没有保存。`; return; } pc.api_key = key; }
      await A.API.setConfig({ provider: prov, mock: $("#s-mock").checked, providers: { [prov]: pc } });
      $("#settings").close(); await refreshAI();
      A.sys(`AI 设置已保存：${store.ai && store.ai.mock ? "模拟（不花钱）" : aiLabel(store.ai)}`);
    } catch (e) { $("#s-test-result").textContent = "保存失败：" + ((e.data && e.data.message) || e.message); } finally { lockB(false); }
  });
}

// ============================================================ 出：导出引擎包（zip：SID + 场景程序 + 图 + BRIEF + PROTOCOL）与读回对比
function openModal(kids) { A.note(null); $("#modal-card").replaceChildren(...kids); $("#modal").hidden = false; const b = $("#modal-card button"); if (b) b.focus(); }
export function closeModal() { $("#modal").hidden = true; if (store.step === 4) { store.step = 3; A.renderViews(); } }
const fileStem = (n) => String(n || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().replace(/^[. _]+|[. _]+$/g, "") || "scene";
function download(name, blob) { const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
export const cleanSid = (sid) => JSON.parse(JSON.stringify(sid, (k, v) => (k.startsWith("_") || typeof v === "function" ? undefined : v)));
export function exportSid() { const doc = cleanSid(store.sid); doc.meta.section = A.sectionSpec(); doc.meta.plan = clone(store.plan); return doc; }
export function openExport() {
  if (!store.plan) return;
  store.step = 4; A.renderViews();
  const f = store.facts, sp = (f.spaces && f.spaces.items) || [], name = store.plan.name;
  const body = el("div", {}), status = el("div", { class: "hint", id: "export-status" });
  const fileIn = el("input", { type: "file", accept: ".json,application/json", style: "display:none", onchange: (ev) => { const file = ev.target.files && ev.target.files[0]; if (file) onReadback(file, body, status); ev.target.value = ""; } });
  openModal([
    el("h3", {}, "出：交给引擎"),
    el("div", {}, `「${name}」· ${f.volumes ?? f.shapes ?? 0} 个形体 · 地形操作 ${store.plan.terrain.length} 个${sp.length ? ` · 空间 ${sp.length} 处（通道共 ${Math.round(sp.reduce((a, x) => a + (x.passage_m || 0), 0))} m）` : ""} · 检查 ${store.checks.filter((c) => c.ok).length}/${store.checks.length} ✓`),
    el("div", { class: "hint" }, "zip 里：scene.sid.json（意图，带坐标）、scene.plan.json（场景程序）、俯视 / 剖面 / 第一眼图、给搭建者的 BRIEF.md。搭完把引擎的 readback.json 拖回下面，差的地方在俯视图上标红。"),
    el("div", { class: "actions" },
      btn("导出引擎包（zip）", async () => { status.textContent = "在渲染图并打包…"; try { const blob = await buildPackage(); download(`${fileStem(name)}.scene-package.zip`, blob); status.textContent = `已下载 ${Math.round(blob.size / 1024)} KB 的包。`; } catch (e) { status.textContent = "打包失败：" + e.message; } }, "ubtn primary"),
      btn("只要 JSON", () => { download(`${fileStem(name)}.sid.json`, new Blob([JSON.stringify(exportSid(), null, 2)], { type: "application/json" })); status.textContent = "已下载 .sid.json（只有意图，没有图和交代）"; }, "ubtn"),
      btn("看 BRIEF", () => { const pre = body.querySelector("pre.brief"); if (pre) { pre.remove(); return; } body.prepend(el("pre", { class: "brief" }, buildBrief())); }, "ubtn"),
      el("span", { class: "spacer" }), btn("关闭", closeModal, "ubtn")),
    el("div", { class: "filebox", ondragover: (e) => { e.preventDefault(); }, ondrop: (e) => { e.preventDefault(); const file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) onReadback(file, body, status); }, onclick: () => fileIn.click() }, "引擎搭完后：把 readback.json 拖到这里，或点一下选文件"), fileIn, status, body,
  ]);
  if (store.readback) renderReadback(body, status);
}
const sectionText = (s) => (s && s.mode === "line" && s.line ? `直线 (${s.line[0].map(r1).join(", ")}) → (${s.line[1].map(r1).join(", ")})，宽 ${s.width_m} m` : `沿主路，宽 ${(s && s.width_m) || 12} m`);
/** 给引擎侧（人或 AI）的交代：概念 + 场景树（每项落到 SID 的哪些对象）+ 空间内部 + 外观 + 检查 */
export function buildBrief() {
  const p = store.plan, sid = store.sid, f = store.facts, idx = store.index, L = [];
  const ids = (id) => { const e = idx[id]; if (!e || !e.sid_ids.length) return ""; const s = e.sid_ids; return ` → SID：${s.slice(0, 6).map((x) => "`" + x + "`").join(" ")}${s.length > 6 ? ` …共 ${s.length} 个` : ""}`; };
  L.push(`# ${p.name} — 搭建交代（由「场景对话」生成）`, "", "`scene.sid.json` 是**意图**（有坐标）；`scene.plan.json` 是 AI 与人一起定的**场景程序**：形体组成组、组可以嵌套和重复，位置是锚点 + 组内的局部偏移（米），地形是一串雕刻操作——没有全局坐标，全局摆放由引擎落地 / 避让 / 路由 / 检查。先读 SID，再看 views/，按坐标摆出 volumes / paths / markers / spaces，对照「检查」逐条核，最后把实际摆放读回成 readback JSON 交回。", "");
  L.push("## 概念", p.concept || "", "");
  if ((p.key_structures || []).length) L.push(`关键结构：${p.key_structures.join("、")}`, "");
  L.push("## 场地与地形", `- 场地：${summarize("site", p.site)}`);
  for (const t of p.terrain) L.push(`- **${t.label || t.id}**（\`${t.id}\`，${A.OPT("terrain_op", "op")[t.op] || t.op}）：${summarize("terrain", Object.assign({}, t, { label: undefined }), p)}${ids(t.id)}${(p.locks || []).includes(t.id) ? "（已锁）" : ""}`);
  L.push("", "## 场景树（名字就是给人看的名字；SID 里每个对象带 plan_id / plan_path / instance_of）");
  const TY = A.OPT("node", "type");
  const walk = (n, d, tpl) => {
    if (!n || typeof n !== "object") return;
    const it = { kind: tpl ? "template" : "node", kg: "node", el: n };
    L.push(`${"  ".repeat(d)}- ${tpl ? "模板 " : ""}**${n.label || n.id}**（\`${n.id}\`，${TY[n.type] || n.type}）：${summaryOf(it)}${tpl ? "" : ids(n.id)}${(p.locks || []).includes(n.id) ? "（已锁）" : ""}`);
    for (const c of n.children || []) walk(c, d + 1, tpl);
    if (n.child && (n.type === "repeat" || n.type === "scatter_houses")) walk(n.child, d + 1, true);
  };
  for (const n of p.nodes) walk(n, 0, false);
  L.push("", `出生点：${summarize("spawn", p.spawn, p)}${ids("spawn")}`);
  if ((p.relations || []).length) { L.push("", "## 关系"); (p.relations || []).forEach((r, i) => { const c = store.checks.find((x) => x.id === `rel_${i}`); L.push(`- ${c ? (c.ok ? "✓ " : "✗ ") : ""}${relName(r)}`); }); }
  L.push("", `形体 ${f.volumes ?? f.shapes ?? 0} 个（悬空 ${f.floating || 0}），最高点 ${r1((f.highest || {}).y || 0)} m，路 ${f.path_length_m || 0} m，水面 ${f.water_area_m2 || 0} m²。`);
  const spaces = (sid.spaces || []).filter((x) => x && x.polygon);
  if (spaces.length) {
    L.push("", "## 空间内部（spaces；每层的 passages 是带宽度的折线，rooms 是多边形，links 是层间连接）");
    L.push("地下空间挖进山体：floor_y 是第 0 层（最下层）底面的绝对高度，height 是每层净高，层间留 2 m 岩层；空中空间是悬空的板（板厚 1 m）。");
    for (const s of spaces) {
      const fi = ((f.spaces && f.spaces.items) || []).find((x) => x.id === s.id) || {}, n = levelsOf(s);
      const lay = (s.stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[s.layout] || s.kind;
      L.push(`### ${s.label}（${STRATUM_LABEL[s.stratum]} · ${lay}${n > 1 ? ` · ${n} 层` : ""}，id \`${s.id}\`）`);
      L.push(`- 底面 ${r1(s.floor_y)} m，每层净高 ${r1(s.height)} m，约 ${(s.size_m || []).map(Math.round).join("×") || "?"} m，走廊宽 ${r1(s.corridor_m || 0)} m。`);
      L.push(`- 通道共 ${Math.round(fi.passage_m || 0)} m，房间 ${fi.rooms || (s.rooms || []).length} 个，死路 ${fi.dead_ends || 0} 条，回环 ${fi.loops || 0} 个${fi.longest_route_m ? `，入口到终点最长路线 ${Math.round(fi.longest_route_m)} m` : ""}。`);
      for (let k = n - 1; k >= 0; k--) {
        const ps = (s.passages || []).filter((x) => (x.sublevel | 0) === k), rs = (s.rooms || []).filter((x) => (x.sublevel | 0) === k);
        L.push(`- ${A.levelName(k, n) || "这一层"}（底面 ${r1((ps[0] || rs[0] || {}).floor_y ?? s.floor_y)} m）：通道 ${ps.length} 段${rs.length ? `；房间：${rs.map((r) => r.label || ROLE_LABEL[r.role] || r.id).join("、")}` : ""}`);
      }
      if (s.entrance) L.push(`- 入口 (${s.entrance.map(r1).join(", ")})${s.goal ? `，终点 (${s.goal.map(r1).join(", ")})` : ""}。`);
    }
    for (const m of (sid.markers || []).filter((x) => x.kind === "connector")) L.push(`- 连接点 \`${m.id}\`：${VIA_LABEL[m.via] || m.via}，(${r1(m.position[0])}, ${r1(m.position[2])})，下端 ${r1(m.bottom_y ?? m.position[1])} m、上端 ${r1(m.top_y ?? m.position[1])} m。`);
  }
  L.push("", "## 外观（按 hex 用，不要自己猜色）");
  for (const c of sid.style.palette || []) L.push(`- ${c.role}: \`${c.hex}\` ${c.note || ""}`);
  L.push(`- 时段：${summarize("look", p) || (sid.style.lighting || {}).time_of_day}；气氛：${(p.mood || []).join("、") || "—"}`);
  L.push("", "## 剖切", `views/profile.png：${sectionText(A.sectionSpec())}（meta.section）。纵向有夸张，标注是真实米数。`);
  L.push("", "## 检查（引擎里搭完请再核一遍）");
  for (const c of store.checks) L.push(`- ${c.ok ? "✓" : "✗"} ${humanize(c.text)}${c.detail ? ` — ${humanize(c.detail)}` : ""}`);
  if (store.corrections.length) { L.push("", "## 上一轮读回后的修正要求"); for (const c of store.corrections) L.push(`- ${c}`); }
  L.push("", "## 读回", "把场景里每个对象的 name / position / scale / rotation 导成 readback JSON（格式见 PROTOCOL.md「读回」一节），导入「场景对话」即可逐个比对。", "");
  return L.join("\n");
}
function svgToPng(svg, px = 1600) {
  return new Promise((res, rej) => {
    const c0 = svg.cloneNode(true), vb = (svg.getAttribute("viewBox") || "0 0 100 100").split(/\s+/).map(Number), w = px, h = Math.round((px * vb[3]) / vb[2]);
    c0.setAttribute("xmlns", "http://www.w3.org/2000/svg"); c0.setAttribute("width", w); c0.setAttribute("height", h);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(c0)], { type: "image/svg+xml;charset=utf-8" })), img = new Image();
    img.onload = () => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); c.toBlob((b) => (b ? res({ blob: b, m_per_px: vb[2] / w }) : rej(new Error("toBlob 失败"))), "image/png"); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("SVG 转图失败")); };
    img.src = url;
  });
}
export async function buildPackage() {
  if (!window.JSZip) throw new Error("JSZip 没有加载（需要联网访问 cdn.jsdelivr.net）");
  const doc = exportSid(), zip = new window.JSZip(), imgs = [], base = A.ctx({ stratum: "ground", selected: null, diffs: [] });
  const add = async (file, svg, px, meta) => { if (!svg) return; const r = await svgToPng(svg, px); zip.file(file, r.blob); imgs.push(Object.assign({ image: file, labels_drawn: true }, meta, meta.kind === "top_down" ? { scale_m_per_px: Math.round(r.m_per_px * 1e5) / 1e5, north_up: true } : {})); };
  try { await add("views/top.png", MapView.renderMap(base, { footer: true }), 2048, { kind: "top_down" }); } catch (e) { console.warn(e); }
  for (const sp of doc.spaces || []) { try { await add(`views/${sp.id}.png`, MapView.renderMap(A.ctx({ stratum: sp.stratum, interiorLevel: 0, selected: { plan_id: sp.plan_id, sid_id: sp.id }, diffs: [] }), { footer: true }), 1600, { kind: "top_down", note: `${sp.label} 的平面（入口层）` }); } catch (e) { console.warn(e); } }
  try { const n = ProfileView.renderProfile(Object.assign({}, base, { section: A.sectionCtx() }), {}).node; await add("views/profile.png", n.querySelector ? n.querySelector("svg") || n : n, 1600, { kind: "section", note: `剖面：${sectionText(A.sectionSpec())}` }); } catch (e) { console.warn(e); }
  try { const n = EyeView.renderEye(base).node; await add("views/first-sight.png", n.querySelector("svg"), 1600, { kind: "perspective", note: "从出生点 1.7 m 眼高的示意" }); } catch (e) { console.warn(e); }
  const v3 = (store.three || store.inset), shot = v3 && v3.snapshot && v3.snapshot();
  if (shot) { const [head, b64] = shot.split(","), bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); zip.file("views/preview-3d.png", new Blob([arr], { type: (/data:(.*?);/.exec(head) || [])[1] || "image/png" })); imgs.push({ kind: "perspective", image: "views/preview-3d.png", labels_drawn: false, note: "3D 预览截图" }); }
  doc.views = (doc.views || []).filter((v) => !String(v.image || "").startsWith("views/")).concat(imgs);
  zip.file("scene.sid.json", JSON.stringify(doc, null, 2));
  zip.file("scene.plan.json", JSON.stringify(store.plan, null, 2));
  zip.file("BRIEF.md", buildBrief());
  for (const [src, dst] of [["../spec/PROTOCOL.md", "PROTOCOL.md"], ["../spec/sid.schema.json", "sid.schema.json"], ["../spec/plan.schema.json", "plan.schema.json"]]) { try { const r = await fetch(src); if (r.ok) zip.file(dst, await r.text()); } catch { /* 离线时跳过 */ } }
  return zip.generateAsync({ type: "blob" });
}
async function onReadback(file, body, status) {
  if (file.size > 20 * 1024 * 1024) { status.textContent = "文件太大（> 20 MB），不是读回 JSON 吧？"; return; }
  status.textContent = "在比对…";
  try {
    let json; try { json = JSON.parse(await file.text()); } catch (e) { throw new Error("不是合法 JSON"); }
    if (!json || typeof json !== "object" || Array.isArray(json) || (!json.objects && !json.volumes)) throw new Error("读回应是一个 JSON 对象：{objects:[{name, position, …}]}，或带 volumes 的 SID");
    const res = await A.API.score(cleanSid(store.sid), json);
    store.readback = res; store.diffs = readbackDiffs(res, store.sid);
    A.render(); renderReadback(body, status);
    const s = res.summary;
    A.note(s.matched === 0 ? "一个都没对上：导出时请保留 id 作为对象名" : `读回对上了 ${s.matched}/${s.intent_objects} 个：位置偏差中位数 ${s.pos_err_median_m} m；缺 ${s.missing.length}，多 ${s.extra.length}。红点是差的地方`);
  } catch (e) { status.textContent = `读回没比成：${e.kind === "offline" ? "本地服务没响应，比对要靠它。" : e.message}`; }
}
function readbackDiffs(result, sid) {
  const byId = {}; for (const v of sid.volumes || []) byId[v.id] = v.position; for (const m of sid.markers || []) byId[m.id] = m.position;
  const diffs = [];
  for (const r of result.rows || []) {
    const from = byId[r.id]; if (!from) continue;
    if (!(r.pos_ok === false || r.size_ok === false || r.rot_ok === false || r.level_ok === false || r.color_ok === false || !r.matched)) continue;
    diffs.push({ id: r.id, from: [from[0], from[2]], to: r.readback_position ? [r.readback_position[0], r.readback_position[2]] : null, err_m: r.pos_err_m, row: r });
  }
  for (const id of (result.summary && result.summary.missing) || []) if (byId[id] && !diffs.some((d) => d.id === id)) diffs.push({ id, from: [byId[id][0], byId[id][2]], to: null, row: null, missing: true });
  return diffs;
}
function renderReadback(body, status) {
  const res = store.readback; if (!res) return;
  const s = res.summary, again = () => renderReadback(body, status);
  status.textContent = `读回格式 ${res.format} · 匹配 ${s.matched}/${s.intent_objects} · 位置中位误差 ${s.pos_err_median_m} m · 位置合格 ${s.pos_ok_rate_pct}% · 尺寸合格 ${s.size_ok_rate_pct}% · 朝向合格 ${s.rot_ok_rate_pct}%`;
  const table = el("table", {}, el("tr", {}, ["对象", "匹配到", "位置误差 m", "高度差 m", "尺寸比", "朝向差°", "怎么办"].map((h) => el("th", {}, h))));
  for (const r of res.rows) { const d = store.diffs.find((x) => x.id === r.id); table.append(el("tr", { class: d ? "bad" : "" }, el("td", { title: r.id }, humanize(r.id)), el("td", {}, r.matched || "—"), ...[r.pos_err_m, r.dy_m, r.size_ratio, r.rot_err].map((v) => el("td", { class: "num" }, v ?? "—")), el("td", {}, d ? el("div", { class: "fixes" }, diffButtons(d, again)) : "✓"))); }
  for (const d of store.diffs.filter((x) => x.missing)) table.append(el("tr", { class: "bad" }, el("td", {}, humanize(d.id)), el("td", {}, "— 引擎里没有"), ...[0, 1, 2, 3].map(() => el("td", { class: "num" }, "—")), el("td", {}, el("div", { class: "fixes" }, diffButtons(d, again)))));
  body.replaceChildren(table);
  if (store.corrections.length) body.append(el("div", {}, el("b", {}, "下一轮修正要求（会写进 BRIEF.md）"), el("pre", {}, store.corrections.join("\n"))));
}
/** 一个红点的三选一：按意图修（记进修正要求）/ 接受引擎版（当成人在图上拖了一下：改偏移）/ 不重要 */
export function diffButtons(d, after = () => {}) {
  const done = () => { store.diffs = store.diffs.filter((x) => x.id !== d.id); A.hidePopup(); A.render(); after(); };
  const row = d.row || {};
  const v = store.sid.volumes.find((x) => x.id === d.id), m = store.sid.markers.find((x) => x.id === d.id);
  const target = v ? { type: MapView.volumeType(v), plan_id: v.plan_id, sid_id: v.id } : m && m.kind === "player_spawn" ? { type: "spawn", plan_id: "spawn", sid_id: m.id } : null;
  return [
    btn("按意图修", () => { const txt = d.missing ? `${d.id}：引擎里没放，请按 SID 位置 (${d.from.map(r1).join(", ")}) 补上` : `${d.id}：意图位置 (${d.from.map(r1).join(", ")})，引擎放在 (${d.to ? d.to.map(r1).join(", ") : "?"})，偏 ${row.pos_err_m} m；请按意图重放`; if (!store.corrections.includes(txt)) store.corrections.push(txt); done(); A.note(`记下了：${humanize(d.id)}按意图重放（写进 BRIEF）`); }, "chip"),
    d.to && target ? btn("接受引擎版", () => { A.mapHandlers.onDragEnd(target, d.to, {}); done(); }, "chip") : null,
    btn("不重要", done, "chip"),
  ].filter(Boolean);
}
