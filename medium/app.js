// app.js — 「场景对话」控制器：说 → 选 → 改 → 出（docs/04）。
// 只有三种动作调 AI：发送输入框的一句话、「三张都不要，重出」、「换一批」。其它一切点 / 拖 / 圈 / 面板都在本地执行（A.edit），
// 先入撤销栈再改，改完在中栏顶部提示条说一句、给「撤销」，不往聊天写东西。几何全部由 engine/* 算，LLM 永远不写坐标。
import { api } from "./api.js";
import { Scene } from "./scene.js";
import { el } from "./cards.js";
import { $, S, A, store } from "./state.js";
import { msg, ai, sys, chips, thinking, usageLine } from "./chat.js";
import { record, commit, rollback, undo, redo, clearHistory } from "./history.js";
import { renderViews, syncChrome, note, hint, popup, hidePopup, showCompare, ctx, bindInset, insetShown } from "./stage.js";
import { mapHandlers, profileHandlers, removeSelected, regionTagButtons, setRegionTag, sectionTo } from "./gestures.js";
import { renderParams, stripLocked, enforce, keysOfPatch, PARAMS, AXIS_PARAM } from "./params.js";
import { renderStrata, renderSelection } from "./sidepanels.js";
import { renderChecks, renderPalette, STYLE_BOARDS, boardPalette } from "./panels.js";
import { signature, distinctEnough, axisOverrides, AXES } from "./engine/diversity.js";
import { extractPalette, assignRoles } from "./engine/color.js";
import { initExport, openExport, closeModal } from "./exportflow.js";
import { initSettings, refreshAI, bindSettings } from "./settings.js";

const SEED = 7;
const short = (t, n = 22) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// ------------------------------------------------------------ 本地改动：先记、再改、再画、提示条说一句
/**
 * label：字符串或 (fn 的返回值) => 字符串；fn(scene) 返回 false 表示没改（不入栈）。
 * 引擎抛错就还原、图不变。opts.actions：提示条上额外的按钮。
 */
function edit(label, fn, { actions = [] } = {}) {
  if (!S.scene) return false;
  const e = record();
  let res;
  try { res = fn(S.scene); }
  catch (err) { console.error(err); rollback(e); renderAll(); note(`这步没算出来（${err.message}），图没变`); return false; }
  if (res === false) { renderAll(); return false; }
  e.label = typeof label === "function" ? label(res) : label;
  commit(e); renderAll();
  note(e.label, { undo: true, actions });
  return true;
}
/** 结构 patch → 卡 → 几何。换了放置类 / 层数 / 原型时，拖过的地标 / 入口 / 手画的路让位（可撤销） */
function clearOverridesFor(sc, p) {
  if (p.landmark && p.landmark.placement) sc.user.landmark = null;
  if (p.spawn && p.spawn.placement) sc.user.spawn = null;
  if ((p.params && (p.params.entry_side || p.params.terraces)) || p.archetype) { sc.user.landmark = null; sc.user.spawn = null; sc.user.trail = null; }
}
function applyPatch(p) { clearOverridesFor(S.scene, p || {}); S.scene.patch(p || {}); return true; }
function doUndo() { const l = undo(); if (l == null) { note("没有可撤销的了"); return; } S.comparing = false; if (S.step === 2) S.step = 3; renderAll(); note(`撤销：${l}`, { actions: [{ label: "重做", fn: doRedo }] }); }
function doRedo() { const l = redo(); if (l == null) { note("没有可重做的了"); return; } renderAll(); note(`重做：${l}`, { undo: true }); }

// ------------------------------------------------------------ 渲染
function renderSide() {
  $("#side").classList.toggle("empty", !S.scene || S.comparing);
  if (!S.scene) return;
  renderParams($("#params"));
  renderStrata($("#strata"));
  const shown = renderSelection($("#selection"));
  if (!shown) S.sel = null;
  $("#p-sel").hidden = !shown;
  renderChecks($("#relations"), S.scene.checks, { ignored: new Set(S.scene.ignored), expanded: !!S.checksExpanded }, {
    fix: (c, i) => { bump("choose"); edit(`按「${c.fixes[i].label}」改了`, (sc) => { sc.applyFix(c, i); }); },
    ignore: (id) => { bump("choose"); edit("这条记为不重要", (sc) => { sc.ignore(id); }); },
    unignore: (id) => edit("这条重新算", (sc) => { sc.unignore(id); }),
    toggle: () => { S.checksExpanded = !S.checksExpanded; renderSide(); },
  });
  renderPalette($("#palette"), $("#reference"), { palette: S.scene.sid.style.palette, board: S.board, reference: S.reference }, {
    shift: (m) => { bump("choose"); edit(`色板${{ cool: "偏冷", warm: "偏暖", desaturate: "灰一点", neutral: "回到中性" }[m]}`, () => applyPatch({ palette_shift: m })); },
    upload: onReference, pickBoard,
  });
}
function renderAll() { renderViews(); renderSide(); }
/** 选中（null 取消）；给了 stratum 就切到那一层。在剖面里选中一个空间：剖切直接过它（可撤销） */
function select(target, stratum, { keepSection = false } = {}) {
  S.sel = target || null;
  if (stratum) S.stratum = stratum;
  if (target && target.type === "space" && S.view !== "map" && S.view !== "profile") S.view = "map";
  if (target && target.type === "space" && S.view === "profile" && !keepSection) { sectionTo(target); return; }
  renderAll();
}

// ------------------------------------------------------------ 界面状态
/** 内部计数（指点 / 选择 / 打字 / 坐标），界面不显示 */
function bump(k) { S.meter[k]++; }
function setStep(n) { S.step = n; syncChrome(); if (n >= 3) $("#input").placeholder = "说一句要改的，如「再陡一点」「加一个地宫」"; }
const TOOL_TIP = { move: "拖地标、入口、房子、路的白色折点；点一下看它是什么", path: "画一笔就是主路：起点靠近入口、终点靠近地标会自动吸附", region: "圈一块地，松手后选它是什么", section: "在图上拉一条线做剖切（15° 吸附，按住 Alt 不吸附）", erase: "点掉一栋房子、你圈的地、你画的路或一个空间" };
function setTool(t) {
  if (!TOOL_TIP[t]) t = "move";
  S.tool = t; if (t !== "move" && S.view !== "map") S.view = "map";
  renderViews();
  if (t !== "move") note(TOOL_TIP[t] + (S.stratum !== "ground" && t === "region" ? "（这一层圈 = 新建空间）" : ""));
}
function setView(v) { if (v !== S.view) note(null); S.view = v; hidePopup(); renderViews(); } // 换视图收起提示条（撤销仍在工具栏）
function setStratum(st) {
  S.stratum = st;
  const sp = S.sel && S.sel.type === "space" && S.scene && S.scene.space(S.sel.id);
  if (S.sel && (sp ? sp.stratum !== st : S.sel.type !== "connector" && st !== "ground")) S.sel = null; // 选中的东西不在这一层就放下
  if (S.view !== "map" && S.view !== "profile") S.view = "map";
  renderAll();
}
function toggleInset() { S.insetOn = store("scene.inset.on", null, !S.insetOn); if (S.insetOn) S.insetMin = store("scene.inset.min", null, false); renderViews(); }
/** 忙态：>0 时会再发请求的控件停一停；发送键不禁用，输入排队 */
function busy(on) { S.busy = Math.max(0, S.busy + (on ? 1 : -1)); document.body.classList.toggle("busy", S.busy > 0); $("#send-label").textContent = S.busy > 0 ? "排队" : "发送"; }
function flushPending() { if (!S.busy && S.pendingText) { const q = S.pendingText; S.pendingText = null; say(q); } }
const lockedPayload = () => ({ card: S.scene ? S.scene.card : null, fields: PARAMS.filter((d) => S.locked.has(d.key)).flatMap((d) => d.fields) });

// ------------------------------------------------------------ 说：一句话 → 三张完整方案（调 AI）
function say(t) {
  if (S.busy) { S.pendingText = t; sys("AI 还在想，这句排在后面。"); return; }
  bump("type"); msg("user", t);
  if (S.scene && !S.comparing) onText(t); else onIntent(t);
}
async function onIntent(text) {
  S.intent = text;
  const ac = new AbortController();
  const th = thinking("在出三张完整方案", { onCancel: () => ac.abort() });
  busy(true);
  try {
    const d = await api.draft(text, { mock: S.mock }, { signal: ac.signal });
    const cards = d.cards, resolved = cards.map((c) => new Scene(SEED).setCard(c));
    let notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid))), d2 = null;
    if (notDistinct) { // 几何上太像：按地标轴再要一次
      th.update("三张算出来太像，按地标再出一次");
      d2 = await api.draft(text, { axis: AXES.landmark, targets: axisOverrides("landmark", cards[0]), locked: { card: cards[0] }, mock: S.mock }, { signal: ac.signal });
      const r2 = d2.cards.map((c) => new Scene(SEED).setCard(c));
      if (distinctEnough(r2.map((r) => signature(r.sid)))) { cards.splice(0, 3, ...d2.cards); resolved.splice(0, 3, ...r2); notDistinct = false; }
    }
    S.cards = cards; S.resolved = resolved; S.axis = null;
    th.done("三张方案在中间，点一张就开始改。");
    lockedLine(d);
    usageLine(d); usageLine(d2);
    setStep(2); showCompare(cards, resolved, { notDistinct }); renderSide();
  } catch (e) { th.fail(e, () => onIntent(text)); } finally { busy(false); flushPending(); }
}
/** 服务端从这句话里读出的硬条件（三张都照办）：「按你的话锁定：夜里、水车、有溪（三张都照办）」；空就不显示 */
function lockedLine(d) {
  const c = (d && Array.isArray(d.constraints) ? d.constraints : []).filter(Boolean);
  if (!c.length) return;
  const n = (d.constraints_fixed || []).reduce((k, x) => k + (Array.isArray(x.fields) ? x.fields.length : 1), 0);
  sys(`按你的话锁定：${c.join("、")}（三张都照办）${n ? `（AI 有 ${n} 处没照办，已改回）` : ""}`);
}
function redraft() { bump("choose"); if (S.intent) { msg("user", "三张都不要，重出"); onIntent(S.intent); } }

// ------------------------------------------------------------ 选：点一张直接进「改」
function pick(i) {
  const card = S.cards[i], r = S.resolved[i];
  if (!card || !r) return;
  bump("choose");
  const axis = S.axis, fresh = !axis;
  const after = () => {
    S.comparing = false; S.axis = null; S.sel = null; S.diffs = []; S.readback = null; S.corrections = [];
    if (fresh) { S.userSet = new Set(); S.locked = new Set(); } else if (AXIS_PARAM[axis]) S.userSet.add(AXIS_PARAM[axis]);
    S.step = 3; $("#input").placeholder = "说一句要改的，如「再陡一点」「加一个地宫」";
  };
  if (!S.scene) { S.scene = r; clearHistory(); after(); renderAll(); note(`选了「${card.name}」`); return; }
  edit(`换成「${card.name}」`, (sc) => { sc.restoreState(r.snapshotState()); after(); });
}
function keepCurrent() { bump("choose"); S.comparing = false; S.axis = null; setStep(3); renderAll(); }

// ------------------------------------------------------------ 改：自由文字 → AI patch（调 AI）
const TOOL_WORDS = [["画", "path"], ["圈", "region"], ["拖", "move"]];
const toolFor = (o) => (TOOL_WORDS.find(([w]) => String(o).includes(w)) || [])[1] || null;
async function onText(t) {
  const sc = S.scene, ac = new AbortController();
  if (S.inflight) S.inflight.abort();
  S.inflight = ac;
  const th = thinking("在想怎么改", { onCancel: () => ac.abort() });
  busy(true);
  try {
    const r = await api.revise(sc.card, { type: "text", text: t }, lockedPayload(), { signal: ac.signal, mock: S.mock });
    if (sc !== S.scene) { th.done("这条回复来晚了，场景已经换过，忽略。"); return; }
    const st = stripLocked(r.patch || {}, S.locked);
    const has = r.understood !== false && Object.keys(st.patch).length > 0;
    const ok = has && edit(`AI：${short(r.restatement || "改了")}`, () => { applyPatch(st.patch); keysOfPatch(st.patch).forEach((k) => S.userSet.add(k)); });
    let text = r.restatement || "好。";
    if (st.stripped.length) text += `（你锁住的${st.stripped.join("、")}没动）`;
    if (has && !ok) text += "（这步没算出来，图没变）";
    const onOpt = (o) => { const tl = toolFor(o); if (tl) setTool(tl); else say(o); };
    const attach = r.question && r.question.options ? el("div", {}, el("div", { class: "hint" }, r.question.text), chips(r.question.options, onOpt, { tag: (o) => !toolFor(o) }))
      : r.ask_to_point ? chips(["画一笔", "圈一块", "拖一下"], onOpt) : null;
    th.done(text, attach);
    usageLine(r);
  } catch (e) { th.fail(e, () => onText(t)); } finally { if (S.inflight === ac) S.inflight = null; busy(false); flushPending(); }
}

// ------------------------------------------------------------ 换一批（调 AI）：默认自动轮换一条没锁的轴，对比页上可以换别的轴
const AXIS_ORDER = ["landmark", "terraces", "entry", "density", "palette"];
function nextAxis() {
  for (let k = 0; k < AXIS_ORDER.length; k++) {
    const a = AXIS_ORDER[(S.axisCursor + k) % AXIS_ORDER.length];
    if (!AXIS_PARAM[a] || !S.locked.has(AXIS_PARAM[a])) { S.axisCursor = (S.axisCursor + k + 1) % AXIS_ORDER.length; return a; }
  }
  return null;
}
async function variants(axisKey) {
  if (!S.scene) return;
  bump("choose");
  axisKey = axisKey || nextAxis();
  if (!axisKey || (AXIS_PARAM[axisKey] && S.locked.has(AXIS_PARAM[axisKey]))) { note("这一条锁住了：先在参数里解锁"); return; }
  const base = S.scene.card, overrides = axisOverrides(axisKey, base);
  msg("user", `换一批（${AXES[axisKey]}）`);
  const ac = new AbortController();
  const th = thinking(`按「${AXES[axisKey]}」出三张`, { onCancel: () => ac.abort() });
  busy(true);
  try {
    const d = await api.draft(S.intent || base.name || "山地村落", { axis: AXES[axisKey], targets: overrides, locked: lockedPayload(), mock: S.mock }, { signal: ac.signal });
    const cards = d.cards.map((c, i) => enforce(c, base, overrides[i], S.locked));
    const resolved = cards.map((c, i) => { const s = S.scene.clone(); clearOverridesFor(s, overrides[i] || {}); return s.setCard(c); });
    const notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid)), 0.6);
    S.cards = cards; S.resolved = resolved; S.axis = axisKey;
    th.done(`三张只换「${AXES[axisKey]}」，在中间。`);
    usageLine(d);
    setStep(2); showCompare(cards, resolved, { axis: AXES[axisKey], notDistinct }); renderSide();
  } catch (e) { th.fail(e, () => variants(axisKey)); } finally { busy(false); flushPending(); }
}

// ------------------------------------------------------------ 色板（本地）
function pickBoard(k) {
  bump("choose");
  const b = STYLE_BOARDS[k];
  edit(`色板：${b.name}`, () => { applyPatch({ palette: boardPalette(k), lighting: b.time_of_day ? { time_of_day: b.time_of_day } : undefined }); S.board = k; S.reference = null; });
}
function onReference(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"), sc = Math.min(1, 256 / Math.max(img.width, img.height));
    c.width = Math.max(8, Math.round(img.width * sc)); c.height = Math.max(8, Math.round(img.height * sc));
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
    const colors = extractPalette(g.getImageData(0, 0, c.width, c.height), { k: 6, seed: SEED });
    const pal = assignRoles(colors.map((x) => x.hex));
    edit(`从参考图取了 ${colors.length} 个主色`, () => { applyPatch({ palette: pal }); S.reference = { url, k: colors.length }; S.board = null; });
  };
  img.src = url;
}

// ------------------------------------------------------------ 界面绑定
function bindUI() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("#strata-switch button").forEach((b) => b.addEventListener("click", () => setStratum(b.dataset.stratum)));
  $("#btn-undo").addEventListener("click", doUndo);
  $("#btn-redo").addEventListener("click", doRedo);
  $("#btn-inset").addEventListener("click", toggleInset);
  bindInset({ onClose: toggleInset });
  $("#btn-variants").addEventListener("click", () => variants());
  $("#btn-export").addEventListener("click", () => openExport());
  $("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
  document.addEventListener("pointerdown", (ev) => { if (!$("#popup").hidden && !$("#popup").contains(ev.target)) hidePopup(); }, true);
  document.addEventListener("keydown", onKey);
  $("#composer").addEventListener("submit", (ev) => { ev.preventDefault(); const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; say(t); });
  bindSettings();
}
function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName) || $("#settings").open;
  if (e.key === "Escape") {
    if (!$("#popup").hidden) hidePopup();
    else if (!$("#modal").hidden) closeModal();
    else if (typing) return;
    else if (S.tool !== "move") setTool("move");
    else if (S.sel) select(null);
    else if (S.comparing && S.scene) keepCurrent();
    return;
  }
  if (typing || !S.scene) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) { e.preventDefault(); if (k === "y" || e.shiftKey) doRedo(); else doUndo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || !$("#modal").hidden) return;
  const tool = { v: "move", p: "path", r: "region", s: "section", e: "erase" }[k];
  if (tool) { setTool(tool); return; }
  const view = { 1: "map", 2: "profile", 3: "eye", 4: "three" }[e.key];
  if (view && !S.comparing) { setView(view); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && S.sel) { e.preventDefault(); removeSelected(); }
}

// ------------------------------------------------------------ 启动
async function start() {
  Object.assign(A, { edit, applyPatch, renderAll, renderViews, renderSide, note, hint, popup, hidePopup, setTool, setView, setStratum, select, bump, ai, sys, say, intent: onIntent,
    pick, redraft, keepCurrent, variants, undo: doUndo, redo: doRedo, setStep, ctx, openExport, mapHandlers, profileHandlers, removeSelected, regionTagButtons, setRegionTag, sectionTo, insetShown });
  initExport(); initSettings({ S, sys });
  bindUI(); setStep(1); renderAll();
  const params = new URLSearchParams(location.search), demo = params.get("demo");
  if (demo) S.mock = true; // 演示 / 截图一律走模拟 AI，不花钱
  await refreshAI();
  if (!S.ai) {
    ai("本地服务没连上：请用 SIDEditor.exe 或「python desktop/sid_editor.py」启动，这个页面要靠它调 AI。");
    const t = setInterval(async () => { await refreshAI(); if (S.ai) { clearInterval(t); sys("本地服务已连上。"); } }, 10000);
  }
  window.addEventListener("focus", () => { refreshAI(); });
  ai("说一句你想要的场景，我出三张完整方案。之后都在图上改，只有说话、重出、换一批会调 AI。");
  if (demo) import("./demo.js").then(({ runDemo }) => runDemo(demo, params)).catch((e) => sys("演示失败：" + e.message));
}
start();

// 调试 / 自动化测试用
window.__scene = { S, A, edit, applyPatch, onIntent, pick, variants, openExport, setTool, setView, setStratum, select, renderAll, doUndo, doRedo, ctx, stripLocked };
