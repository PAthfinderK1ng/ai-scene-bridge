// app.js — 「场景对话」控制器：说 → 选 → 答 → 画 → 核 → 出。
// 人只做选择 / 指点 / 判断；AI（经本地服务）只出结构级决定；几何由 engine/* 算；这里负责把三者串起来并渲染。
// 问题在 questions.js，出 / 读回在 exportflow.js，AI 设置在 settings.js。
import { api } from "./api.js";
import { Scene } from "./scene.js";
import { renderMap, bindMapGestures, paletteOf, LANDMARK_LABEL, PLACEMENT_LABEL, REGION_KINDS } from "./views/map.js";
import { renderProfile, slopeLabel } from "./views/profile.js";
import { renderEye } from "./views/eye.js";
import { mountPreview } from "./views/preview3d.js";
import { el, settle, renderCards } from "./cards.js";
import { understandingItems, renderUnderstanding, renderChecks, assumptionItems, renderAssumptions, renderPalette, STYLE_BOARDS, boardPalette } from "./panels.js";
import { classifyStroke, strokeToPath, strokeToPolygon } from "./engine/strokes.js";
import { signature, distinctEnough, axisOverrides, AXES } from "./engine/diversity.js";
import { extractPalette, assignRoles } from "./engine/color.js";
import { initQuestions, startQuestions, askNext } from "./questions.js";
import { initExport, openExport, closeModal, onReadbackFile } from "./exportflow.js";
import { initSettings, refreshAI, openSettings, bindSettings, markPill } from "./settings.js";

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SEED = 7;
const ERR_TEXT = { offline: "本地服务没响应（它关了？）", auth: "密钥无效或过期", model: "模型名不对", rate: "请求太频繁或额度用完", busy: "模型繁忙", timeout: "等太久了（超过时限没回来）", net: "本地服务连不上 Anthropic（网络 / 代理）", server: "服务出错" };
const LOCK_NAME = { archetype: "原型", terraces: "层数", landmark: "地标", spawn: "入口", trail: "主路", lighting: "时段" };

// ------------------------------------------------------------ 状态
const S = {
  step: 1, intent: "", cards: [], resolved: [], scene: null, axis: null, items: [],
  confirmed: new Set(), locked: new Set(), userSet: new Set(), itemTexts: {},
  asked: 0, queue: [], pendingQ: null, q3Node: null, tool: "select", view: "map", board: "default", reference: null,
  meter: { point: 0, choose: 0, type: 0, coord: 0 }, ai: null, diffs: [], corrections: [], readback: null,
  three: null, threeP: null, threeStale: false, busy: 0, pendingText: null, inflight: {}, refreshing: false, checksExpanded: false,
  mapSvg: null, profileSvg: null, eyeSvg: null, eye: {}, lastCentroid: null,
};

// ------------------------------------------------------------ 聊天栏小工具
/** 滚到一条消息：贴着底部时才动；消息比视口高就把它的顶端对齐，不让开头被顶出去 */
function scrollToMsg(m) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80 || log.lastElementChild === m;
  if (!nearBottom) return;
  m.style.contentVisibility = "visible"; const h = m.offsetHeight; m.style.contentVisibility = "";
  if (h > log.clientHeight - 40) log.scrollTop = m.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 8; else log.scrollTop = 1e9;
}
/** 一条消息（ai / user / sys），可带附件节点 */
function msg(who, text, attach) {
  const m = el("div", { class: "msg " + who }, who === "sys" ? null : el("div", { class: "who" }, who === "ai" ? "AI" : "你"), text);
  if (attach) m.append(el("div", { class: "attach" }, attach));
  $("#log").append(m); scrollToMsg(m);
  return m;
}
const ai = (t, a) => msg("ai", t, a);
const sys = (t) => msg("sys", t);
/** 等待气泡：原地替换成结果；3 s 起显示秒数；可取消；失败时给中文原因 + 重试 / 设置 / 改模拟 */
function thinking(t = "在看你的改动", { onCancel } = {}) {
  const txt = el("span", { class: "txt" }, t), sec = el("span", { class: "sec" });
  const m = el("div", { class: "msg ai thinking" }, el("div", { class: "who" }, "AI"), txt, sec);
  if (onCancel) m.append(el("button", { class: "chip", style: "margin-left:8px;padding:1px 8px;font-size:12px", onclick: (ev) => { settle(ev.currentTarget); onCancel(); } }, "取消"));
  $("#log").append(m); scrollToMsg(m);
  const t0 = Date.now(); let hinted = false;
  const tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); if (s >= 3) sec.textContent = ` ${s} s`; if (s >= 30 && !hinted && S.ai && !S.ai.mock) { hinted = true; m.append(el("div", { class: "hint" }, "真实 Claude 出三张卡一般 15–60 秒")); } }, 1000);
  const stop = () => { clearInterval(tick); m.classList.remove("thinking"); };
  return {
    done(text, attach) { stop(); m.replaceChildren(el("div", { class: "who" }, "AI"), text); if (attach) m.append(el("div", { class: "attach" }, attach)); scrollToMsg(m); return m; },
    update(text) { txt.textContent = text; },
    fail(e, retry) {
      stop();
      if (e && e.kind === "cancel") { m.className = "msg sys"; m.replaceChildren("已取消。"); return; }
      const kind = e && e.kind, data = (e && e.data) || {};
      const raw = [data.hint, e && e.message, data.request_id ? `request_id ${data.request_id}` : ""].filter(Boolean).join("\n");
      m.replaceChildren(el("div", { class: "who" }, "AI"), ERR_TEXT[kind] || "AI 调用失败", el("details", { style: "margin-top:4px;font-size:12px;color:var(--muted)" }, el("summary", {}, "原始信息"), raw || String(e)));
      const labels = ["重试", "打开 AI 设置"].concat(kind !== "offline" ? ["先用模拟 AI 走流程"] : []);
      m.append(el("div", { class: "attach" }, chips(labels, (l) => { if (l === "重试") { if (retry) retry(); } else if (l.startsWith("打开")) openSettings(); else api.setConfig({ mock: true }).then(refreshAI).then(() => retry && retry()).catch((err) => sys("切换模拟失败：" + err.message)); })));
      if (kind === "auth" || kind === "offline") markPill(kind);
      scrollToMsg(m);
    },
  };
}
/** 一排选项 chip：点一个后整组失效，并把选择记为用户消息 */
function chips(labels, onPick) { const row = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }); labels.forEach((l) => row.append(el("button", { class: "chip", onclick: (ev) => { settle(ev.currentTarget); bump("choose"); msg("user", l); onPick(l); } }, l))); return row; }
/** 输入框上方的常驻快捷 chip（不失效） */
function setQuickChips(labels, onPick) { const c = $("#chips"); c.replaceChildren(); labels.forEach((l) => c.append(el("button", { onclick: () => { bump("choose"); msg("user", l); onPick(l); } }, l))); }
/** 给一道题加「你定（保持…）」 */
function withSkip(node, onSkip, label = "你定（按默认）") { return el("div", {}, node, el("div", { style: "margin-top:6px" }, el("button", { class: "chip", onclick: (ev) => { settle(ev.currentTarget); bump("choose"); msg("user", "你定"); onSkip(); } }, label))); }
/** 计数器：这一轮人动了几次手（坐标永远 0） */
function bump(k) { S.meter[k]++; $("#meter").textContent = `你做的：指点 ${S.meter.point} · 选择 ${S.meter.choose} · 打字 ${S.meter.type} · 坐标 ${S.meter.coord}`; }
/** 顶栏步骤高亮；有场景就能用工具条；第 3 步起输入框提示改成「说一句要改的」 */
function setStep(n) {
  S.step = n;
  document.querySelectorAll("#steps li").forEach((li) => { const k = +li.dataset.step; li.className = k < n ? "done" : k === n ? "now" : ""; });
  $("#tools").classList.toggle("disabled", !S.scene); $("#btn-variants").disabled = !S.scene;
  $("#btn-export").disabled = !S.scene || n < 3; // 第 2 步三张卡并排时压暗；第 3 步起可点，点了会解释还差几条
  if (n >= 3) $("#input").placeholder = "说一句要改的，比如「再陡一点」；说不清就在图上指";
  budget();
}
/** 顶栏问题计数：第 3 步起显示，问完四个变灰「问完了」 */
function budget() { const b = $("#budget"); b.hidden = S.step < 3; const done = S.asked >= 4 && !S.queue.length && S.step >= 4; b.textContent = done ? "问完了" : `问题 ${S.asked}/4`; b.classList.toggle("done", done); }
/** 图上的小弹窗：跟着鼠标；没有鼠标事件（合成的闭环）就投影最近一次圈的重心 */
function showPopup(ev, kids) {
  const pop = $("#popup"); pop.replaceChildren(...kids);
  const r = $("#views").getBoundingClientRect();
  let x = r.width / 2, y = r.height / 2;
  if (ev && ev.clientX != null) { x = ev.clientX - r.left; y = ev.clientY - r.top; }
  else if (S.mapSvg && S.lastCentroid) { try { const pt = S.mapSvg.createSVGPoint(); pt.x = S.lastCentroid[0]; pt.y = S.lastCentroid[1]; const q = pt.matrixTransform(S.mapSvg.getScreenCTM()); x = q.x - r.left; y = q.y - r.top; } catch { /* 用中心 */ } }
  pop.style.left = clamp(x + 8, 8, Math.max(8, r.width - 290)) + "px"; pop.style.top = clamp(y + 8, 8, Math.max(8, r.height - 80)) + "px"; pop.hidden = false;
}
function hidePopup() { $("#popup").hidden = true; }
/** 图上方的一行提示条 */
function hint(t) { const h = $("#hint"); if (!t) { h.hidden = true; return; } h.textContent = t; h.hidden = false; }
/** 忙态计数：>0 时 body.busy（会再发请求的控件停一停）；发送键不禁用，输入会排队 */
function busy(on) { S.busy = Math.max(0, S.busy + (on ? 1 : -1)); document.body.classList.toggle("busy", S.busy > 0); $("#send").textContent = S.busy > 0 ? "排队" : "发送"; }
/** AI 忙时打的字，回来就发 */
function flushPending() { if (!S.busy && S.pendingText) { const q = S.pendingText; S.pendingText = null; bump("type"); msg("user", q); onText(q); } }
const lockedPayload = () => ({ card: S.scene ? S.scene.card : null, fields: [...S.locked] });
const fmtK = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** 真实 Claude 的一次调用：耗时与 token 用量（模拟不打） */
function usageLine(d) { if (!d || d.provider === "mock") return; const u = d._usage || {}; sys(`Claude · ${((d._ms || 0) / 1000).toFixed(1)} s · 输入 ${fmtK(u.input)} / 输出 ${fmtK(u.output)} tokens${u.cache_read ? ` · 缓存命中 ${fmtK(u.cache_read)}` : ""}`); }

// ------------------------------------------------------------ 渲染
function ctx() { return { sid: S.scene.sid, T: S.scene.T, facts: S.scene.facts, checks: S.scene.checks, locked: new Set([...S.locked].filter((k) => k === "landmark" || k === "spawn")), diffs: S.diffs, eye: S.eye }; }
/** 俯视图下的图例 + 统计行（数据来自 facts / meta） */
function mapCaption(c) {
  const f = c.facts || {}, t = f.trail || {}, b = c.sid.bounds, pal = paletteOf(c.sid);
  const W = Math.round(b.max[0] - b.min[0]), nT = f.terraces ?? ((c.T && c.T.terraces) || []).length, layer = (c.sid.meta || {}).layer_height_m;
  const sw = (color, label) => el("span", {}, el("i", { style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:4px;vertical-align:-1px` }), label);
  return el("div", { class: "caption" }, sw("#b8452b", "地标"), sw("#1f6feb", "入口 · 第一眼视野"), sw("#8b7d5b", "主路（横纹 = 台阶）"), sw(pal.roof, "民居"),
    el("span", { class: "stat" }, `约 ${W} m 见方 · ${nT} 层台地（1 层 ≈ ${layer} m）· ${f.houses || 0} 栋${t.length_m ? ` · 主路 ${Math.round(t.length_m)} m / 约 ${Math.round(t.steps_estimate || 0)} 级台阶` : ""}`));
}
/** 三个视图全部重画（3D 不在前台时只记脏） */
function renderViews() {
  $("#side").classList.toggle("empty", !S.scene);
  if (!S.scene) return;
  const c = ctx();
  const svg = renderMap(c);
  bindMapGestures(svg, c.sid, gestures);
  $("#view-map").replaceChildren(el("div", { class: "wrap" }, svg, mapCaption(c))); S.mapSvg = svg;
  const pr = renderProfile(c, { onSlope: (v) => {
    if (S.locked.has("terraces")) { ai("层数是你点过「对」的（已锁住）。要改每层高度先解锁。", chips(["解锁，改成这档"], () => { S.locked.delete("terraces"); S.confirmed.delete("terraces"); if (applyPatch({ params: { layer_height_m: v } })) { S.userSet.add("params.layer_height_m"); ai(`解锁了，每层改成 ${v} m，剖面和台阶数重算了。`); } })); return; }
    if (applyPatch({ params: { layer_height_m: v } })) { S.userSet.add("params.layer_height_m"); ai(`每层改成 ${v} m，剖面和台阶数重算了。`); }
  } });
  $("#view-profile").replaceChildren(pr.node); S.profileSvg = pr.node.querySelector("svg");
  const ey = renderEye(c); $("#view-eye").replaceChildren(ey.node); S.eyeSvg = ey.node.querySelector("svg"); S.eye = ey.facts;
  if (S.three) { if (S.view === "three") S.three.update(c); else S.threeStale = true; } else if (S.view === "three") mountThree();
  $("#view-map").className = "view" + (S.view === "map" ? " active" : "") + " tool-" + S.tool;
}
/** 3D 预览只挂一次（并发调用共用同一个 Promise） */
async function mountThree() { if (!S.scene) return; if (!S.threeP) S.threeP = mountPreview($("#view-three"), ctx()).catch((e) => { S.threeP = null; sys("3D 预览没加载成功（需要联网取 three.js）：" + (e && e.message || e)); return null; }); S.three = await S.threeP; }
/** 右栏三面板 + 色板；「我理解为」内容变了自动取消确认；全对才放行「出」 */
function renderPanels() {
  $("#side").classList.toggle("empty", !S.scene);
  if (!S.scene) return;
  const card = S.scene.card;
  const items = understandingItems({ card, facts: S.scene.facts, eye: S.eye, userTrail: !!S.scene.user.trail });
  for (const it of items) if (S.itemTexts[it.key] && S.itemTexts[it.key] !== it.text) { S.confirmed.delete(it.key); S.locked.delete(it.key); } // 内容变了要重新确认，锁也一起解（对 = 锁，两者同进退）
  S.itemTexts = Object.fromEntries(items.map((i) => [i.key, i.text]));
  for (const k of [...S.confirmed]) if (!S.itemTexts[k]) S.confirmed.delete(k);
  S.items = items;
  renderUnderstanding($("#understanding"), items, S, { confirm: confirmItem, flip: flipItem });
  const n = [...S.confirmed].filter((k) => S.itemTexts[k]).length;
  $("#understand-count").textContent = n < items.length ? `${n}/${items.length} · 全对才能出` : `${n}/${items.length} ✓`;
  renderChecks($("#relations"), S.scene.checks, { ignored: new Set(S.scene.ignored), expanded: !!S.checksExpanded }, { fix: applyFix, ignore: (id) => { S.scene.ignore(id); afterChange("这条记为不重要。"); }, unignore: (id) => { S.scene.unignore(id); afterChange(); }, toggle: () => { S.checksExpanded = !S.checksExpanded; renderPanels(); } });
  renderAssumptions($("#assumptions"), assumptionItems(card, S.userSet), { pick: pickAssumption });
  renderPalette($("#palette"), $("#reference"), { palette: S.scene.sid.style.palette, board: S.board, reference: S.reference }, { shift: (m) => { if (applyPatch({ palette_shift: m })) ai(`色板整体${{ cool: "偏冷", warm: "偏暖", desaturate: "灰一点", neutral: "回到中性" }[m]}。`); }, upload: onReference, pickBoard });
  const allOk = items.length > 0 && items.every((i) => S.confirmed.has(i.key));
  $("#btn-export").disabled = !S.scene || S.step < 4;
  $("#btn-export").textContent = allOk ? "出 →" : `出 (${n}/${items.length})`;
  if (allOk && S.step === 4) { setStep(5); ai("「我理解为」全部点对了。可以「出」了：导出给引擎的包，搭完再把读回导进来对一遍。", chips(["出 →"], openExport)); }
  if (!allOk && S.step === 5) setStep(4);
}
function afterChange(text) { renderViews(); renderPanels(); if (text) ai(text); }
/** 结构 patch（LLM / 面板 / 问题）→ 卡 → 几何；引擎抛错就说一声、图不变，返回是否成功 */
function applyPatch(patch, { silent = false } = {}) {
  if (!S.scene || !patch) return false;
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === "object" && !Array.isArray(patch[k])) for (const kk of Object.keys(patch[k])) S.userSet.add(`${k}.${kk}`);
    else S.userSet.add(k);
  }
  if (patch.landmark && patch.landmark.placement) S.scene.user.landmark = null; // 换放置类后不再用拖过的位置
  if (patch.spawn && patch.spawn.placement) S.scene.user.spawn = null;
  if (patch.params && (patch.params.entry_side || patch.params.terraces) || patch.archetype) { S.scene.user.landmark = null; S.scene.user.spawn = null; S.scene.user.trail = null; }
  try { S.scene.patch(patch); } catch (e) { console.error(e); sys(`这步没算出来（${e.message}），图没变。`); return false; }
  if (!silent) { renderViews(); renderPanels(); }
  return true;
}
/** 过滤掉 LLM 想改但人已锁住的字段，返回 { patch, stripped: [中文名] } */
function stripLocked(patch, locked) {
  const p = JSON.parse(JSON.stringify(patch || {})); const stripped = [];
  if (locked.has("archetype") && "archetype" in p) { delete p.archetype; stripped.push(LOCK_NAME.archetype); }
  if (locked.has("terraces") && p.params) { let hit = false; for (const k of ["terraces", "layer_height_m", "plateau_width"]) if (k in p.params) { delete p.params[k]; hit = true; } if (!Object.keys(p.params).length) delete p.params; if (hit) stripped.push(LOCK_NAME.terraces); }
  if (locked.has("landmark") && p.landmark) { delete p.landmark; stripped.push(LOCK_NAME.landmark); }
  if (locked.has("spawn") && p.spawn) { delete p.spawn; stripped.push(LOCK_NAME.spawn); }
  if (locked.has("lighting") && p.lighting) { delete p.lighting; stripped.push(LOCK_NAME.lighting); }
  return { patch: p, stripped };
}

// ------------------------------------------------------------ 我理解为 / 我假设了 / 关系检查 回调
/** 点「对」= 确认并锁住（可锁的）；再点取消两者。force=true 只开不关；quiet 不重画 */
function confirmItem(key, force, quiet = false) {
  const it = (S.items || []).find((i) => i.key === key);
  const on = force === true ? true : !S.confirmed.has(key);
  if (on) { S.confirmed.add(key); if (it && it.lockable) S.locked.add(key); } else { S.confirmed.delete(key); S.locked.delete(key); }
  if (quiet) return;
  bump("choose"); renderViews(); renderPanels();
}
function lockItem(key) { confirmItem(key, true); }
function flipItem(item, ev) {
  bump("point");
  showPopup(ev, [el("span", { class: "hint" }, "不是这样？那是："), ...item.alternatives.map((a) => el("button", { class: "chip", onclick: () => { hidePopup(); bump("choose"); msg("user", a.label); if (a.patch) { if (applyPatch(a.patch)) ai(`好，${a.label}。图和关系都重算了。`); } else if (a.action) doAction(a.action); } }, a.label))]);
}
function pickAssumption(a, ev) { bump("point"); showPopup(ev, [el("span", { class: "hint" }, `${a.label}：`), ...a.options.map((o) => el("button", { class: "chip", onclick: () => { hidePopup(); bump("choose"); msg("user", `${a.label}改成${o.label}`); if (applyPatch(o.patch)) { S.userSet.add(a.key); renderPanels(); ai(`${a.label}改成${o.label}，不再算我的假设。`); } } }, o.label))]); }
function applyFix(check, i) { bump("choose"); const label = check.fixes[i].label; msg("user", label); try { S.scene.applyFix(check, i); } catch (e) { sys(`这个修法没算出来（${e.message}）。`); return; } afterChange(`按「${label}」改了，关系重新算过。`); }
/** 替代解释里的非 patch 动作：恢复主路 / 指定折数 */
function doAction(a) {
  if (a.trail_reset) { S.scene.resetTrail(); afterChange("主路恢复成算出来的走法。"); return; }
  if (a.trail_folds != null) {
    import("./engine/routing.js").then(({ zigzagTrail }) => {
      const sp = S.scene.spawn(), lm = S.scene.landmark();
      if (!sp || !lm) return;
      const r = zigzagTrail(S.scene.T, [sp.position[0], sp.position[2]], [lm.position[0], lm.position[2]], { folds: a.trail_folds, maxSlope: 0.7 });
      if (!r.points) { ai("这个折数在当前坡度上走不通，我没改。"); return; }
      S.scene.setTrail(r.points); S.scene.mainTrail().user_drawn = false;
      afterChange(`主路改成${a.trail_folds === 0 ? "直上" : `之字 ${a.trail_folds} 折`}，台阶数和每段坡度重算了，剖面上能看到。`);
    }).catch((e) => sys(`这步没算出来（${e.message}），图没变。`));
  }
}

// ------------------------------------------------------------ 色板
function pickBoard(k) { S.board = k; S.reference = null; const b = STYLE_BOARDS[k]; if (applyPatch({ palette: boardPalette(k), lighting: b.time_of_day ? { time_of_day: b.time_of_day } : undefined })) ai(`用「${b.name}」这组色：${b.items.map(([, hex, note]) => `${note} ${hex}`).join("、")}。搭建时按 hex 用，不用猜。`); }
async function onReference(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); const sc = Math.min(1, 256 / Math.max(img.width, img.height));
    c.width = Math.max(8, Math.round(img.width * sc)); c.height = Math.max(8, Math.round(img.height * sc));
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
    const colors = extractPalette(g.getImageData(0, 0, c.width, c.height), { k: 6, seed: SEED });
    const pal = assignRoles(colors.map((x) => x.hex));
    S.reference = { url, k: colors.length }; S.board = null;
    if (applyPatch({ palette: pal })) ai(`从参考图里取了 ${colors.length} 个主色，按角色分好了：${pal.map((p) => `${p.role} ${p.hex}`).join("、")}。右边色板可以继续冷暖微调。`);
  };
  img.src = url;
}

// ------------------------------------------------------------ 流程：说
/** 中栏并排放大三张卡（点大图 = 选卡） */
function showCompare(cards, resolved) {
  const cmp = el("div", { class: "compare" }, ...cards.map((c, i) => {
    const svg = renderMap({ sid: resolved[i].sid, T: resolved[i].T }, { small: true }); svg.setAttribute("class", "cmp-map");
    const f = resolved[i].facts || {}, t = f.trail || {};
    return el("div", { class: "cmp", tabindex: 0, title: "点一下选这张", onclick: () => pickCardFrom(cards, resolved, i), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickCardFrom(cards, resolved, i); } } }, svg, el("b", {}, c.name), el("span", { class: "hint" }, `${f.houses || 0} 栋 · 主路 ${Math.round(t.length_m || 0)} m · 爬升 ${Math.round(t.climb_m || 0)} m`));
  }));
  // 已经有场景（换一批）时给一个出口：都不要，回到现在这张图
  if (S.scene) cmp.append(el("button", { class: "cmp keep", type: "button", onclick: () => { bump("choose"); msg("user", "都不要，留现在这张"); setStep(S.stepBefore >= 3 ? S.stepBefore : 4); S.axis = null; renderViews(); renderPanels(); ai("好，还是现在这张，什么都没动。"); } }, el("b", {}, "都不要"), el("span", { class: "hint" }, "留现在这张，回到图上")));
  $("#view-map").replaceChildren(cmp);
  S.mapSvg = null; setView("map");
}
/** 一句话 → 三张完整方案（太像就按地标轴再要一次） */
async function onIntent(text) {
  S.intent = text; if (S.scene) S.stepBefore = S.step; setStep(2);
  const ac = new AbortController();
  const th = thinking("在出三张完整方案（结构由 AI 定，房子 / 路 / 关系由程序算）", { onCancel: () => ac.abort() });
  busy(true);
  try {
    const d = await api.draft(text, {}, { signal: ac.signal });
    const cards = d.cards;
    const resolved = cards.map((c) => new Scene(SEED).setCard(c));
    let notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid))), d2 = null;
    if (notDistinct) { // 几何上太像：按地标轴再要一次
      th.update("这三张算出来太像，按「地标」再出一次（第 2 次调用）");
      d2 = await api.draft(text, { axis: AXES.landmark, targets: axisOverrides("landmark", cards[0]), locked: { card: cards[0] } }, { signal: ac.signal });
      const r2 = d2.cards.map((c) => new Scene(SEED).setCard(c));
      if (distinctEnough(r2.map((r) => signature(r.sid)))) { cards.splice(0, 3, ...d2.cards); resolved.splice(0, 3, ...r2); notDistinct = false; }
    }
    S.cards = cards; S.resolved = resolved; S.axis = null;
    th.done(`「${text}」——三种切法，房子、主路、第一眼都已经算好。挑一张，之后都在它上面改；不满意就「三张都不要，重出」。`, renderCards(cards, resolved, { onPick: (i, btn) => pickCardFrom(cards, resolved, i, btn), notDistinct }));
    showCompare(cards, resolved);
    setQuickChips(["三张都不要，重出", "换个说法"], (l) => { if (l.startsWith("三张")) onIntent(S.intent); else { setStep(1); ai("好，再说一句。"); } });
    usageLine(d); usageLine(d2);
  } catch (e) { th.fail(e, () => onIntent(text)); setStep(S.scene ? S.step : 1); } finally { busy(false); flushPending(); }
}

// ------------------------------------------------------------ 流程：选
/** 选某一批里的第 i 张：图上有手画的东西且不是换变体时先确认；变体保留锁 */
function pickCardFrom(cards, resolved, i, btn) {
  const card = cards && cards[i]; if (!card || !resolved[i]) return;
  if (resolved[i] === S.scene) { ai("还是这张，什么都没动。"); return; }
  const doPick = () => {
    // 只高亮被选的那张，不让整组失效：之后仍可在这三张里换（有手画内容时会先确认）
    let box = btn && btn.closest(".cards");
    if (!box) { const boxes = [...document.querySelectorAll("#log .cards")]; box = boxes[boxes.length - 1] || null; } // 从中栏大图选的：同步聊天里最后一批卡
    const btns = box ? [...box.querySelectorAll("button.primary")] : btn ? [btn] : [];
    btns.forEach((b, k) => { const on = btn ? b === btn : k === i; b.disabled = false; b.classList.toggle("on", on); b.textContent = on ? "已选 ✓" : "选这个"; });
    bump("choose"); msg("user", `选「${card.name}」`);
    const wasAxis = S.axis; S.axis = null; // 变体标记用完即弃，之后再选任何一批都按正常选卡处理
    S.scene = resolved[i]; S.cards = cards; S.resolved = resolved;
    if (!wasAxis) { S.confirmed = new Set(); S.locked = new Set(); } else { S.confirmed = new Set([...S.confirmed].filter((k) => S.locked.has(k))); }
    S.itemTexts = {}; S.readback = null; S.corrections = []; S.diffs = []; S.checksExpanded = false; S.pendingQ = null;
    if (wasAxis) { setStep(S.stepBefore >= 4 ? S.stepBefore : 4); renderViews(); renderPanels(); ai(`换成「${card.name}」。你锁住的地方没动，其它按这张卡重算了。`); return; }
    setStep(3); renderViews(); renderPanels();
    ai(`就「${card.name}」。下面最多问四个问题，每个都可以「你定」；右边「我理解为」随时能看我理解成了什么。`);
    startQuestions();
  };
  const u = S.scene && S.scene.user;
  if (u && !S.axis && (u.trail || (u.regions || []).length || u.landmark || u.spawn)) { ai("换这张会丢掉你在图上画的路、圈的地和挪过的图钉。", chips(["换，丢掉我画的", "不换"], (l) => { if (l.startsWith("换")) doPick(); })); return; }
  doPick();
}

// ------------------------------------------------------------ 自由文本 → AI revise
async function onText(t) {
  if (!S.scene) return onIntent(t);
  await reviseWith({ type: "text", text: t });
}
/**
 * 把一个动作交给 AI 复述 / 出 patch。quiet：手势之后用，不建等待气泡，只在 AI 有追问或 patch 时才说话（画布即复述）；
 * 同类动作连发时取消上一条；回来时场景已换就丢弃；锁住的字段从 patch 里剔掉。
 */
async function reviseWith(action, { dropRegions = false, quiet = false } = {}) {
  if (!S.scene) return null;
  const sc = S.scene, key = action.type;
  if (S.inflight[key]) S.inflight[key].abort();
  const ac = new AbortController(); S.inflight[key] = ac;
  const th = quiet ? null : thinking("在看你的改动", { onCancel: () => ac.abort() });
  if (!quiet) busy(true);
  try {
    const r = await api.revise(sc.card, action, lockedPayload(), { signal: ac.signal });
    if (sc !== S.scene) { if (th) th.done("这条回复来晚了，场景已经换过，忽略。"); return null; }
    let patch = r.patch || {};
    if (dropRegions) delete patch.regions; // 多边形级的用途已由程序处理，不让 AI 改整层
    if (["stroke_path", "pin", "region"].includes(key)) { // 这些动作 AI 只复述；万一它改了结构字段，会把人刚画 / 刚拖的东西冲掉，这里挡住
      delete patch.archetype; if (patch.params) { delete patch.params.terraces; delete patch.params.entry_side; if (!Object.keys(patch.params).length) delete patch.params; }
      if (patch.landmark) { delete patch.landmark.placement; if (!Object.keys(patch.landmark).length) delete patch.landmark; }
      if (patch.spawn) { delete patch.spawn.placement; if (!Object.keys(patch.spawn).length) delete patch.spawn; }
    }
    const st = stripLocked(patch, S.locked); patch = st.patch;
    const hasPatch = !!r.understood && Object.keys(patch).length > 0;
    const applied = hasPatch ? applyPatch(patch) : false;
    const attach = r.question && r.question.options ? el("div", {}, el("div", { class: "hint" }, r.question.text), chips(r.question.options, (o) => onText(o)))
      : r.ask_to_point ? chips(["在图上画一笔", "圈一块地", "拖地标"], (o) => { setTool(o.includes("画") ? "path" : o.includes("圈") ? "region" : "pin"); hint(`工具已切到「${o}」，在俯视图上操作`); }) : null;
    let text = r.restatement || "好。";
    if (st.stripped.length) text += `（你锁住的${st.stripped.join("、")}我没动）`;
    if (hasPatch && !applied) text += "（这步没算出来，图没变）";
    const needSay = r.understood === false || !!attach || hasPatch;
    if (th) th.done(text, attach); else if (needSay) ai(text, attach);
    usageLine(r);
    return r;
  } catch (e) {
    if (e && e.kind === "cancel") { if (th) th.fail(e); return null; }
    if (th) th.fail(e, () => reviseWith(action, { dropRegions, quiet })); else sys(`AI 没回话（${ERR_TEXT[e.kind] || e.message}），图已按本地结果更新。`);
    if (!th && (e.kind === "auth" || e.kind === "offline")) markPill(e.kind);
    return null;
  } finally { if (S.inflight[key] === ac) delete S.inflight[key]; if (!quiet) { busy(false); flushPending(); } }
}

// ------------------------------------------------------------ 图上手势
const gestures = {
  tool: () => S.tool,
  onSelect(target, p) {
    if (!S.scene || S.step < 3) return;
    bump("point");
    const sc = S.scene, lm = sc.landmark();
    if (target.type === "house") {
      const v = sc.sid.volumes.find((x) => x.id === target.id); if (!v) return;
      const t = sc.T.terraceAt(v.position[0], v.position[2]);
      const faces = (sc.sid.relations || []).find((r) => r.type === "faces" && r.a === v.id);
      ai(`这栋在第 ${(t ? t.level : 0) + 1} 层，${v.size[0]}×${v.size[2]} m，门朝${faces ? (faces.b === "main_trail" ? "主路" : faces.b === (lm || {}).id ? "地标" : "最近的路") : "下坡"}，屋顶用色板 roof。`, chips(["对，锁住它", "删掉它"], (c) => { if (c.startsWith("对")) { sc.lockVolume(v.id); afterChange("锁住了，重排时它不动。"); } else { sc.removeVolume(v.id); afterChange("删了。"); } }));
    } else if (target.type === "landmark") {
      ai(`这是${lm.label}（地标），在${PLACEMENT_LABEL[sc.card.landmark.placement]}，玩家从入口第一眼${S.eye.landmark_visible ? "就看它" : "看不见它"}。`, chips(["对，锁住", "换个位置", "换个种类"], (c) => { if (c.startsWith("对")) lockItem("landmark"); else if (c.includes("位置")) { setTool("pin"); hint("用图钉把地标拖到你要的地方"); } else ai("换成：", chips(Object.values(LANDMARK_LABEL), (l) => { const k = Object.keys(LANDMARK_LABEL).find((x) => LANDMARK_LABEL[x] === l); if (applyPatch({ landmark: { kind: k, label: l } })) ai(`地标换成${l}。`); })); }));
    } else if (target.type === "spawn") {
      ai(`入口。玩家在这里出生，朝${lm ? lm.label : "北"}看。${S.eye.landmark_dist_m ? `到地标 ${S.eye.landmark_dist_m} m。` : ""}`, chips(["对，锁住", "挪一下"], (c) => { if (c.startsWith("对")) lockItem("spawn"); else { setTool("pin"); hint("用图钉拖入口"); } }));
    } else if (target.type === "region") {
      const r = sc.sid.regions.find((x) => x.id === target.id);
      if (r) ai(`${r.user_set ? "你圈的" : `第 ${(r.terrace_level ?? 0) + 1} 层台地`}：${(REGION_KINDS[r.kind] || {}).label || r.kind}，密度 ${r.density}。点它的标签可以改。`);
    } else if (target.type === "terrace") {
      const t = sc.T.terraces.find((x) => x.id === target.id);
      if (t) ai(`第 ${t.level + 1} 层台地，高 ${t.height} m（${t.level} 层 × ${sc.sid.meta.layer_height_m} m），${(sc.facts.perTerrace || {})[t.level] || 0} 栋房。`);
    } else if (target.type === "path") {
      const f = sc.facts.trail || {};
      ai(`主路：${Math.round(f.length_m || 0)} m，爬升 ${Math.round(f.climb_m || 0)} m，约 ${Math.round(f.steps_estimate || 0)} 级台阶，最陡 ${slopeLabel(f.max_slope || 0)}。想改走法就用「画路」重画一笔。`);
    } else {
      const t = sc.T.terraceAt(p[0], p[1]), h = sc.T.heightAt(p[0], p[1]), sp = sc.spawn().position, lmv = lm && lm.position;
      hint(`${t ? `第 ${t.level + 1} 层台地` : "台地外的坡上"} · 比入口高约 ${Math.round(h - sc.T.heightAt(sp[0], sp[2]))} m · 离入口 ${Math.round(Math.hypot(p[0] - sp[0], p[1] - sp[2]))} m${lmv ? ` · 离${lm.label} ${Math.round(Math.hypot(p[0] - lmv[0], p[1] - lmv[2]))} m` : ""}`);
    }
  },
  onFlip(kind, id, ev) {
    bump("point");
    if (kind === "path") { const it = (S.items || []).find((i) => i.key === "trail"); if (it) flipItem(it, ev); return; }
    const r = S.scene.sid.regions.find((x) => x.id === id); if (!r) return;
    showPopup(ev, regionTagButtons((tag) => { hidePopup(); setRegionTag(r, tag); }));
  },
  /** 画完一笔：先本地算（主路 + 重排 + 复述事实），AI 静默看一眼 */
  async onPath(points, ev) {
    if (!S.scene) return;
    bump("point");
    const kind = classifyStroke(points);
    if (kind === "tap") return;
    if (kind === "loop") { gestures.onRegion(points, ev); return; }
    const r = strokeToPath(points, { T: S.scene.T, anchors: S.scene.anchors(), snap: 10, maxPoints: 12 });
    try { S.scene.setTrail(r.points); } catch (e) { sys(`这笔没算出来（${e.message}），图没变。`); return; }
    renderViews(); renderPanels();
    const f = r.facts;
    ai(`读到你的笔画：${f.n_points} 个折点，${Math.round(f.length_m)} m，起点${f.start_snapped_to === "spawn" ? "吸附到入口" : f.start_snapped_to ? `吸到${f.start_snapped_to}` : "在图中"}，终点${f.end_snapped_to === "landmark" ? "吸附到地标" : "没到地标（关系检查会亮红）"}，穿过第 ${f.levels_crossed.map((l) => l + 1).join("、")} 层${f.crosses_stream ? "，跨溪一次（要桥）" : ""}。房子按新路重排了，台阶按坡度铺。`);
    hint("主路已替换 · 擦除可恢复");
    setTimeout(() => { if (S.tool === "path") setTool("path"); }, 3000);
    await reviseWith({ type: "stroke_path", facts: f }, { quiet: true });
  },
  onRegion(points, ev) {
    if (!S.scene) return;
    bump("point");
    const r = strokeToPolygon(points, { T: S.scene.T, maxPoints: 10 });
    if (!r.polygon || r.polygon.length < 3 || r.area_m2 < 20) { hint("圈得太小了，再圈大一点"); return; }
    S.lastCentroid = r.centroid;
    showPopup(ev, [el("span", { class: "hint" }, `圈了 ${Math.round(r.area_m2)} m²，跨第 ${r.levels_touched.map((l) => l + 1).join("、")} 层。这块是：`), ...regionTagButtons((tag) => { hidePopup(); addRegionWithTag(r, tag); }), el("button", { class: "chip", onclick: hidePopup }, "算了")]);
  },
  canPin(kind) {
    if (S.locked.has(kind)) { ai(`${LOCK_NAME[kind]}是你点过「对」的（已锁住）。要动它先解锁。`, chips(["解锁，我来拖"], () => { S.locked.delete(kind); S.confirmed.delete(kind); renderViews(); renderPanels(); ai("解锁了，拖吧。"); })); return false; }
    return true;
  },
  /** 拖完图钉：先本地算，AI 静默看一眼；第三题还没答时拖地标就算答了 */
  async onPinEnd(kind, p) {
    bump("point");
    const sc = S.scene;
    try { if (kind === "landmark") sc.setLandmark(p); else sc.setSpawn(p); } catch (e) { sys(`这一下没算出来（${e.message}），图没变。`); return; }
    renderViews(); renderPanels();
    const t = sc.T.terraceAt(p[0], p[1]);
    const where = `${t ? `第 ${t.level + 1} 层` : "台地外的坡上"}${p[0] < -20 ? "偏西" : p[0] > 20 ? "偏东" : ""}`;
    ai(kind === "landmark" ? `地标挪到${where}，主路重新接过去；从入口看它在画面${S.eye.landmark_screen || "中"}${S.eye.landmark_visible ? "" : "，但被挡住了（关系检查里有修法）"}。` : `入口挪到${where}，朝向重新对准地标，主路重算。`);
    if (S.pendingQ === "landmark" && kind === "landmark") { S.pendingQ = null; S.userSet.add("landmark.placement"); if (S.q3Node) S.q3Node.querySelectorAll("button").forEach((b) => { b.disabled = true; }); askNext(); }
    await reviseWith({ type: "pin", what: kind, facts: { level: t ? t.level : null, visible: S.eye.landmark_visible, screen: S.eye.landmark_screen } }, { quiet: true });
  },
  onErase(target) {
    bump("point");
    const sc = S.scene;
    if (target.type === "region") { const r = sc.sid.regions.find((x) => x.id === target.id); if (r && r.user_set) { sc.removeRegion(r.id); afterChange("去掉了你圈的这块。"); } else if (r) { if (applyPatch({ regions: [{ terrace: r.terrace_level, kind: "other", density: 1 }] })) ai("这层恢复成普通民居。"); } }
    else if (target.type === "path") { if (sc.user.trail) { sc.resetTrail(); afterChange("主路恢复成算出来的。"); } else hint("这条路本来就是算出来的，没什么可擦"); }
    else if (target.type === "house") { sc.removeVolume(target.id); afterChange("删了这栋。"); }
    else if (target.type === "landmark" || target.type === "spawn") { if (sc.user[target.type]) { sc.clearPin(target.type); afterChange(`${LOCK_NAME[target.type]}回到卡片指定的位置。`); } else hint(`${LOCK_NAME[target.type]}没被拖过，已经在卡片指定的位置`); }
  },
  onDiff(id, ev) { const d = S.diffs.find((x) => x.id === id); if (d) import("./exportflow.js").then(({ diffButtons }) => showPopup(ev, diffButtons(d))); },
};
const REGION_TAGS = { dense: "这里更密", sparse: "这里更稀", forest: "这里是林子", plaza: "这里是广场", terrace: "这里是梯田", farmland: "这里是农田" };
function regionTagButtons(onPick) { return Object.entries(REGION_TAGS).map(([tag, label]) => el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", label); onPick(tag); } }, label)); }
/** 圈完选了用途：用途类程序直接处理（不叫 AI）；密度类按台地层生效并让 AI 静默看一眼 */
async function addRegionWithTag(r, tag) {
  const sc = S.scene;
  const isDensity = tag === "dense" || tag === "sparse";
  const kind = isDensity ? "other" : tag;
  const density = tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0;
  // 密度在台地层级生效：窄台地（环带 / 两岸）一圈容易跨好几层，只取圈的重心所在那一层；圈得大（跨层且重心不在任何台地）才全算
  const mainT = sc.T.terraceAt(r.centroid[0], r.centroid[1]);
  const levels = mainT ? [mainT.level] : r.levels_touched;
  try { sc.addRegion({ kind, polygon: r.polygon, density, label: REGION_TAGS[tag], levels }); } catch (e) { sys(`这块没算出来（${e.message}），图没变。`); return; }
  if (isDensity) applyPatch({ regions: levels.map((l) => ({ terrace: l, density })) }, { silent: true });
  renderViews(); renderPanels();
  ai(`圈的这块记为「${REGION_TAGS[tag]}」${tag === "dense" ? `，第 ${levels.map((l) => l + 1).join("、")} 层房子加密，门都朝就近的路` : tag === "sparse" ? `，第 ${levels.map((l) => l + 1).join("、")} 层只留稀疏几栋` : tag === "forest" ? "，房子挪走，按 4–6 m 间距撒树" : tag === "plaza" ? "，房子挪走，铺石板" : "，房子挪走，顺等高线做田"}。标签点一下可以改。`);
  if (isDensity) await reviseWith({ type: "region", tag, tag_label: REGION_TAGS[tag], kind, density, handled_by_program: false, facts: { area_m2: Math.round(r.area_m2), levels_touched: levels } }, { quiet: true, dropRegions: false });
}
function setRegionTag(r, tag) {
  const sc = S.scene;
  const isD = tag === "dense" || tag === "sparse", dens = tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0;
  if (r.user_set) { sc.updateRegion(r.id, { kind: isD ? "other" : tag, density: dens, label: REGION_TAGS[tag] }); if (isD && r.levels) applyPatch({ regions: r.levels.map((l) => ({ terrace: l, density: dens })) }, { silent: true }); }
  else applyPatch({ regions: [{ terrace: r.terrace_level, kind: isD ? "other" : tag, density: dens, label: REGION_TAGS[tag] }] }, { silent: true });
  afterChange(`这块改成「${REGION_TAGS[tag]}」。`);
}

// ------------------------------------------------------------ 换一批（按变化轴）
function askAxis() {
  if (!S.scene) { ai("先挑一张卡，再换一批。"); return; }
  ai("想在哪一条上换？其它都按你已经定的。", chips(Object.values(AXES), (l) => { const k = Object.keys(AXES).find((x) => AXES[x] === l); variants(k); }));
}
/** 按一条轴出三张变体：锁住的字段强制不变；轴与锁冲突时问要不要解锁 */
async function variants(axisKey) {
  if (S.scene) S.stepBefore = S.step;
  const base = S.scene.card;
  const conflict = { landmark: "landmark", terraces: "terraces", entry: "spawn" }[axisKey];
  if (conflict && S.locked.has(conflict)) { ai(`「${AXES[axisKey]}」是你点过「对」的。`, chips([`解锁${LOCK_NAME[conflict]}，换这批`, "算了"], (l) => { if (l.startsWith("解锁")) { S.locked.delete(conflict); S.confirmed.delete(conflict); renderPanels(); variants(axisKey); } })); return; }
  const overrides = axisOverrides(axisKey, base);
  const ac = new AbortController();
  const th = thinking(`按「${AXES[axisKey]}」出三张变体`, { onCancel: () => ac.abort() });
  busy(true);
  try {
    const d = await api.draft(S.intent, { axis: AXES[axisKey], targets: overrides, locked: lockedPayload() }, { signal: ac.signal });
    const cards = d.cards.map((c, i) => enforce(c, base, overrides[i]));
    const resolved = cards.map((c) => S.scene.clone().setCard(c));
    const notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid)), 0.6);
    S.cards = cards; S.resolved = resolved; S.axis = axisKey;
    th.done(`三张只在「${AXES[axisKey]}」上不同（黄标是差异）。你锁住的：${[...S.locked].map((k) => LOCK_NAME[k] || k).join("、") || "无"}。都不要就点图下的「都不要」，留现在这张。`, renderCards(cards, resolved, { onPick: (i, btn) => pickCardFrom(cards, resolved, i, btn), axis: AXES[axisKey], notDistinct }));
    showCompare(cards, resolved);
    usageLine(d);
  } catch (e) { th.fail(e, () => variants(axisKey)); } finally { busy(false); flushPending(); }
}
/** 变体卡：目标值必须生效，锁住的字段必须等于当前卡 */
function enforce(card, base, override) {
  const c = JSON.parse(JSON.stringify(card));
  const merge = (dst, src) => { for (const [k, v] of Object.entries(src || {})) { if (v && typeof v === "object" && !Array.isArray(v)) { dst[k] = dst[k] || {}; merge(dst[k], v); } else dst[k] = v; } };
  merge(c, override || {});
  if (S.locked.has("archetype")) c.archetype = base.archetype;
  if (S.locked.has("terraces")) { c.params = c.params || {}; Object.assign(c.params, { terraces: base.params.terraces, layer_height_m: base.params.layer_height_m, plateau_width: base.params.plateau_width }); }
  if (S.locked.has("landmark")) c.landmark = JSON.parse(JSON.stringify(base.landmark));
  if (S.locked.has("spawn")) c.spawn = JSON.parse(JSON.stringify(base.spawn));
  if (S.locked.has("lighting")) c.lighting = base.lighting;
  return c;
}

// ------------------------------------------------------------ 界面绑定
function setTool(t) { S.tool = t; document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t)); $("#view-map").className = "view" + (S.view === "map" ? " active" : "") + " tool-" + t; if (t !== "select" && S.view !== "map") setView("map"); hint({ path: "在俯视图上画一笔：起点靠近入口、终点靠近地标会自动吸附", region: "圈一块地，松手后选它是什么", pin: "拖动地标（红）或入口（蓝）", erase: "点一个你圈的区域 / 你画的路 / 一栋房子", select: "" }[t]); }
function setView(v) { S.view = v; document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === v)); document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + v)); if (v === "three") { if (S.three && S.threeStale && S.scene) { S.three.update(ctx()); S.threeStale = false; } else mountThree(); } hidePopup(); }
/** 「出」：没全对就不开弹窗，把右栏没点「对」的条目闪一下 */
function onExportClick() {
  if (!S.scene) return;
  const n = (S.items || []).filter((i) => S.confirmed.has(i.key)).length;
  if (n < (S.items || []).length) {
    $("#p-understand").scrollIntoView({ behavior: "smooth" });
    document.querySelectorAll("#understanding li:not(.confirmed)").forEach((li) => { li.classList.remove("pulse"); void li.offsetWidth; li.classList.add("pulse"); });
    hint(`还有 ${S.items.length - n} 条没点「对」`);
    return;
  }
  openExport();
}
function bindUI() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#btn-variants").addEventListener("click", askAxis);
  $("#btn-export").addEventListener("click", onExportClick);
  $("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
  document.addEventListener("pointerdown", (ev) => { if (!$("#popup").hidden && !$("#popup").contains(ev.target)) hidePopup(); }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hidePopup(); if (!$("#modal").hidden) closeModal(); else if (!$("#settings").open) setTool("select"); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || document.activeElement === $("#input") || $("#settings").open || /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName)) return;
    const k = { v: "select", p: "path", r: "region", g: "pin", e: "erase" }[e.key.toLowerCase()];
    if (k && S.scene) setTool(k);
  });
  $("#composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const t = $("#input").value.trim(); if (!t) return;
    $("#input").value = "";
    if (S.busy) { S.pendingText = t; sys("AI 还在想，这句排在后面，回来就发。"); return; }
    bump("type"); msg("user", t); onText(t);
  });
  bindSettings();
}

// ------------------------------------------------------------ 启动
async function start() {
  initQuestions({ S, ai, msg, chips, withSkip, bump, applyPatch, setStep, setTool, renderPanels, confirmItem, openExport, setQuickChips, onText, budget });
  initExport({ S, ai, bump, setStep, renderViews, renderPanels, ctx });
  initSettings({ S, sys });
  bindUI(); setStep(1); $("#side").classList.add("empty");
  await refreshAI();
  if (!S.ai) {
    ai("本地服务没连上（/api 不可用）。请用「python desktop/sid_editor.py」或 SIDEditor.exe 启动，这个页面要靠它调 AI。界面本身仍能看；连上后这里会说一声。");
    const t = setInterval(async () => { await refreshAI(); if (S.ai) { clearInterval(t); sys("本地服务已连上。"); } }, 10000);
  }
  window.addEventListener("focus", () => { refreshAI(); });
  ai("说一句你想要的场景就行，不用描述细节。我先给三张完整方案，你挑一张，再最多问四个问题。");
  setQuickChips(["我要生成山城村庄", "黄昏的山城村庄，有条溪", "夜里亮灯的山村，寺在最顶上"], (l) => onIntent(l));
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo) runDemo(demo).catch((e) => sys("演示失败：" + e.message));
}
/** 演示 / 截图模式：?demo=cards|pick|questions|draw|export[&variants=landmark|terraces|entry|…][&view=profile|eye|three]。走的是和用户一样的路径（点按钮、调手势）。 */
async function runDemo(stage) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const order = ["cards", "pick", "questions", "draw", "export"];
  const upto = order.indexOf(stage);
  if (upto < 0) return;
  await onIntent("我要生成山城村庄");
  if (upto >= 1) { const b = document.querySelector("#log .cards button.primary"); if (b) b.click(); else pickCardFrom(S.cards, S.resolved, 0); await sleep(50); } // 走真实点击路径
  if (upto >= 2) {
    for (let i = 0; i < 4; i++) {
      const lastMsg = [...document.querySelectorAll("#log .msg")].slice(-1)[0];
      const b = [...lastMsg.querySelectorAll("button")].find((x) => x.textContent.startsWith("你定")); if (b) b.click(); await sleep(30);
    }
  }
  if (upto >= 3) {
    const sc = S.scene, sp = sc.spawn().position, lm = sc.landmark().position, pts = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push([sp[0] + (lm[0] - sp[0]) * t + Math.sin(t * Math.PI * 2) * 10, sp[2] + (lm[2] - sp[2]) * t]); }
    await gestures.onPath(pts); await sleep(50);
    const t1 = sc.T.terraces[1], c = t1.centroid, loop = [];
    for (let i = 0; i <= 20; i++) { const a = (i / 20) * Math.PI * 2; loop.push([c[0] + Math.cos(a) * 9, c[1] + Math.sin(a) * 6]); }
    gestures.onRegion(loop, { clientX: 600, clientY: 400 }); await sleep(30);
    const fb = [...document.querySelectorAll("#popup button")].find((b) => b.textContent.includes("林子")); if (fb) fb.click(); await sleep(300);
  }
  if (upto >= 4) { for (const it of S.items) confirmItem(it.key, true, true); renderPanels(); await sleep(20); openExport(); }
  const axis = new URLSearchParams(location.search).get("variants");
  if (axis && S.scene && AXES[axis]) await variants(axis);
  const view = new URLSearchParams(location.search).get("view");
  if (view) setView(view);
}
start();

// 调试 / 自动化测试用
window.__scene = { S, applyPatch, onIntent, pickCard: (i) => pickCardFrom(S.cards, S.resolved, i), pickCardFrom, variants, openExport, setTool, setView, gestures, renderViews, renderPanels, onReadbackFile, reviseWith, askAxis, ctx, confirmItem, stripLocked };
