// app.js — 「场景对话」控制器：说 → 选 → 答 → 画 → 核 → 出。
// 人只做选择 / 指点 / 判断；AI（经本地服务）只出结构级决定；几何由 engine/* 算；这里负责把三者串起来并渲染。
import { api } from "./api.js";
import { Scene } from "./scene.js";
import { renderMap, bindMapGestures, LANDMARK_LABEL, PLACEMENT_LABEL, SPAWN_LABEL, REGION_KINDS } from "./views/map.js";
import { renderProfile } from "./views/profile.js";
import { renderEye } from "./views/eye.js";
import { mountPreview } from "./views/preview3d.js";
import { el, renderCards, renderOptions, ARCH_LABEL } from "./cards.js";
import { understandingItems, renderUnderstanding, renderChecks, assumptionItems, renderAssumptions, renderPalette, STYLE_BOARDS, boardPalette } from "./panels.js";
import { buildPackage, download, fileStem, cleanSid, readbackDiffs } from "./exporter.js";
import { classifyStroke, strokeToPath, strokeToPolygon } from "./engine/strokes.js";
import { signature, distinctEnough, axisOverrides, AXES } from "./engine/diversity.js";
import { extractPalette, assignRoles } from "./engine/color.js";

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SEED = 7;

// ------------------------------------------------------------ 状态
const S = {
  step: 1, intent: "", cards: [], resolved: [], scene: null, axis: null,
  confirmed: new Set(), locked: new Set(), userSet: new Set(), itemTexts: {},
  asked: 0, queue: [], tool: "select", view: "map", board: "default", reference: null,
  meter: { point: 0, choose: 0, type: 0, coord: 0 }, ai: null, diffs: [], corrections: [], readback: null,
  three: null, busy: 0, mapSvg: null, profileSvg: null, eyeSvg: null, eye: {},
};

// ------------------------------------------------------------ 聊天栏小工具
function msg(who, text, attach) {
  const m = el("div", { class: "msg " + who }, who === "sys" ? null : el("div", { class: "who" }, who === "ai" ? "AI" : "你"), text);
  if (attach) m.append(el("div", { class: "attach" }, attach));
  $("#log").append(m); $("#log").scrollTop = 1e9;
  return m;
}
const ai = (t, a) => msg("ai", t, a);
const sys = (t) => msg("sys", t);
function thinking(t = "在想") { const m = ai(t); m.classList.add("thinking"); return { done(text, attach) { m.classList.remove("thinking"); m.replaceChildren(el("div", { class: "who" }, "AI"), text); if (attach) m.append(el("div", { class: "attach" }, attach)); $("#log").scrollTop = 1e9; return m; }, fail(e) { m.classList.remove("thinking"); m.classList.add("sys"); m.replaceChildren(`AI 调用失败：${e.message || e}`); } }; }
function chips(labels, onPick) { const row = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }); labels.forEach((l) => row.append(el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", l); onPick(l); } }, l))); return row; }
function setQuickChips(labels, onPick) { const c = $("#chips"); c.replaceChildren(); labels.forEach((l) => c.append(el("button", { onclick: () => { bump("choose"); msg("user", l); onPick(l); } }, l))); }
function withSkip(node, onSkip) { return el("div", {}, node, el("div", { style: "margin-top:6px" }, el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", "你定"); onSkip(); } }, "你定（按默认）"))); }
function bump(k) { S.meter[k]++; $("#meter").textContent = `指点 ${S.meter.point} · 选择 ${S.meter.choose} · 打字 ${S.meter.type} · 坐标 ${S.meter.coord}`; }
function setStep(n) { S.step = n; document.querySelectorAll("#steps li").forEach((li) => { const k = +li.dataset.step; li.className = k < n ? "done" : k === n ? "now" : ""; }); $("#tools").classList.toggle("disabled", n < 4); $("#btn-variants").disabled = !S.scene; }
function budget() { $("#budget").textContent = `问题 ${S.asked}/4`; }
function showPopup(ev, kids) { const pop = $("#popup"); pop.replaceChildren(...kids); const r = $("#views").getBoundingClientRect(); pop.style.left = clamp(ev.clientX - r.left + 8, 8, Math.max(8, r.width - 290)) + "px"; pop.style.top = clamp(ev.clientY - r.top + 8, 8, Math.max(8, r.height - 80)) + "px"; pop.hidden = false; }
function hidePopup() { $("#popup").hidden = true; }
function hint(t) { const h = $("#hint"); if (!t) { h.hidden = true; return; } h.textContent = t; h.hidden = false; }
function busy(on) { S.busy += on ? 1 : -1; $("#send").disabled = S.busy > 0; }
const lockedPayload = () => ({ card: S.scene ? S.scene.card : null, fields: [...S.locked] });

// ------------------------------------------------------------ 渲染
function ctx() { return { sid: S.scene.sid, T: S.scene.T, facts: S.scene.facts, checks: S.scene.checks, locked: new Set([...S.locked].filter((k) => k === "landmark" || k === "spawn")), diffs: S.diffs }; }
function renderViews() {
  if (!S.scene) return;
  const c = ctx();
  const svg = renderMap(c);
  bindMapGestures(svg, c.sid, gestures);
  $("#view-map").replaceChildren(svg); S.mapSvg = svg;
  const pr = renderProfile(c); $("#view-profile").replaceChildren(pr.node); S.profileSvg = pr.node.querySelector("svg");
  const ey = renderEye(c); $("#view-eye").replaceChildren(ey.node); S.eyeSvg = ey.node.querySelector("svg"); S.eye = ey.facts;
  if (S.three) S.three.update(c); else if (S.view === "three") mountThree();
  $("#view-map").className = "view" + (S.view === "map" ? " active" : "") + " tool-" + S.tool;
}
async function mountThree() { if (S.three || !S.scene) return; S.three = await mountPreview($("#view-three"), ctx()); }
function renderPanels() {
  if (!S.scene) return;
  const card = S.scene.card;
  const items = understandingItems({ card, facts: S.scene.facts, eye: S.eye, userTrail: !!S.scene.user.trail });
  for (const it of items) if (S.itemTexts[it.key] && S.itemTexts[it.key] !== it.text) S.confirmed.delete(it.key); // 内容变了要重新确认
  S.itemTexts = Object.fromEntries(items.map((i) => [i.key, i.text]));
  for (const k of [...S.confirmed]) if (!S.itemTexts[k]) S.confirmed.delete(k);
  S.items = items;
  renderUnderstanding($("#understanding"), items, S, { confirm: confirmItem, flip: flipItem, lock: lockItem });
  $("#understand-count").textContent = `${[...S.confirmed].filter((k) => S.itemTexts[k]).length}/${items.length}`;
  renderChecks($("#relations"), S.scene.checks, { ignored: new Set(S.scene.ignored) }, { fix: applyFix, ignore: (id) => { S.scene.ignore(id); afterChange(`「${id}」记为不重要。`); }, unignore: (id) => { S.scene.unignore(id); afterChange(); } });
  renderAssumptions($("#assumptions"), assumptionItems(card, S.userSet), { pick: pickAssumption });
  renderPalette($("#palette"), $("#reference"), { palette: S.scene.sid.style.palette, board: S.board, reference: S.reference }, { shift: (m) => { applyPatch({ palette_shift: m }); ai(`色板整体${{ cool: "偏冷", warm: "偏暖", desaturate: "灰一点", neutral: "回到中性" }[m]}。`); }, upload: onReference, pickBoard });
  const allOk = items.length > 0 && items.every((i) => S.confirmed.has(i.key));
  $("#btn-export").disabled = !(S.step >= 4 && allOk);
  if (allOk && S.step === 4) { setStep(5); ai("「我理解为」全部点对了。可以「出」了：导出给引擎的包，搭完再把读回导进来对一遍。", chips(["出 →"], openExport)); }
  if (!allOk && S.step === 5) setStep(4);
}
function afterChange(text) { renderViews(); renderPanels(); if (text) ai(text); }
/** 结构 patch（LLM / 面板 / 问题）→ 卡 → 几何 */
function applyPatch(patch, { silent = false } = {}) {
  if (!S.scene) return;
  for (const k of Object.keys(patch || {})) {
    if (typeof patch[k] === "object" && !Array.isArray(patch[k])) for (const kk of Object.keys(patch[k])) S.userSet.add(`${k}.${kk}`);
    else S.userSet.add(k);
  }
  if (patch.landmark && patch.landmark.placement) S.scene.user.landmark = null; // 换放置类后不再用拖过的位置
  if (patch.spawn && patch.spawn.placement) S.scene.user.spawn = null;
  if (patch.params && (patch.params.entry_side || patch.params.terraces) || patch.archetype) { S.scene.user.landmark = null; S.scene.user.spawn = null; S.scene.user.trail = null; }
  S.scene.patch(patch);
  if (!silent) { renderViews(); renderPanels(); }
}

// ------------------------------------------------------------ 我理解为 / 我假设了 / 关系检查 回调
function confirmItem(key) { if (S.confirmed.has(key)) S.confirmed.delete(key); else S.confirmed.add(key); bump("choose"); renderPanels(); }
function lockItem(key) { if (S.locked.has(key)) S.locked.delete(key); else { S.locked.add(key); S.confirmed.add(key); } bump("choose"); renderViews(); renderPanels(); }
function flipItem(item, ev) {
  bump("point");
  showPopup(ev, [el("span", { class: "hint" }, "不是这样？那是："), ...item.alternatives.map((a) => el("button", { class: "chip", onclick: () => { hidePopup(); bump("choose"); msg("user", a.label); if (a.patch) { applyPatch(a.patch); ai(`好，${a.label}。图和关系都重算了。`); } else if (a.action) doAction(a.action); } }, a.label))]);
}
function pickAssumption(a, ev) { bump("point"); showPopup(ev, [el("span", { class: "hint" }, `${a.label}：`), ...a.options.map((o) => el("button", { class: "chip", onclick: () => { hidePopup(); bump("choose"); msg("user", `${a.label}改成${o.label}`); applyPatch(o.patch); S.userSet.add(a.key); renderPanels(); ai(`${a.label}改成${o.label}，不再算我的假设。`); } }, o.label))]); }
function applyFix(check, i) { bump("choose"); const label = check.fixes[i].label; msg("user", label); S.scene.applyFix(check, i); afterChange(`按「${label}」改了，关系重新算过。`); }
function doAction(a) {
  if (a.trail_reset) { S.scene.resetTrail(); afterChange("主路恢复成算出来的走法。"); return; }
  if (a.trail_folds != null) {
    // 构造指定折数的路：用引擎的 zigzagTrail
    import("./engine/routing.js").then(({ zigzagTrail }) => {
      const sp = S.scene.spawn(), lm = S.scene.landmark();
      if (!sp || !lm) return;
      const r = zigzagTrail(S.scene.T, [sp.position[0], sp.position[2]], [lm.position[0], lm.position[2]], { folds: a.trail_folds, maxSlope: 0.7 });
      if (!r.points) { ai("这个折数在当前坡度上走不通，我没改。"); return; }
      S.scene.setTrail(r.points); S.scene.mainTrail().user_drawn = false;
      afterChange(`主路改成${a.trail_folds === 0 ? "直上" : `之字 ${a.trail_folds} 折`}，台阶数和每段坡度重算了，剖面上能看到。`);
    });
  }
}

// ------------------------------------------------------------ 色板
function pickBoard(k) { S.board = k; S.reference = null; const b = STYLE_BOARDS[k]; applyPatch({ palette: boardPalette(k), lighting: b.time_of_day ? { time_of_day: b.time_of_day } : undefined }); ai(`用「${b.name}」这组色：${b.items.map(([, hex, note]) => `${note} ${hex}`).join("、")}。引擎侧按 hex 用，不用猜。`); }
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
    applyPatch({ palette: pal });
    ai(`从参考图里取了 ${colors.length} 个主色，按角色分好了：${pal.map((p) => `${p.role} ${p.hex}`).join("、")}。右边色板可以继续冷暖微调。`);
  };
  img.src = url;
}

// ------------------------------------------------------------ 流程：说
async function onIntent(text) {
  S.intent = text; setStep(2);
  const th = thinking("在出三张完整方案（结构由 AI 定，房子 / 路 / 关系由程序算）");
  busy(true);
  try {
    const d = await api.draft(text);
    const cards = d.cards;
    const resolved = cards.map((c) => new Scene(SEED).setCard(c));
    let notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid)));
    if (notDistinct) { // 几何上太像：按地标轴再要一次
      const d2 = await api.draft(text, { axis: AXES.landmark, targets: axisOverrides("landmark", cards[0]), locked: { card: cards[0] } });
      const r2 = d2.cards.map((c) => new Scene(SEED).setCard(c));
      if (distinctEnough(r2.map((r) => signature(r.sid)))) { cards.splice(0, 3, ...d2.cards); resolved.splice(0, 3, ...r2); notDistinct = false; }
    }
    S.cards = cards; S.resolved = resolved; S.axis = null;
    th.done(`「${text}」我先给三张完整的方案，不问问题。每张都算过几何：房子、主路、第一眼看见什么都是真的，不是示意。挑一张，后面所有修改都在它上面做。`, renderCards(cards, resolved, { onPick: pickCard, notDistinct }));
    setQuickChips(["换一批", "换个说法"], (l) => { if (l === "换一批") askAxis(); else { setStep(1); ai("好，再说一句。"); } });
    sys(`AI：${d.provider === "mock" ? "模拟（无密钥）" : "Claude"} · ${d._ms} ms`);
  } catch (e) { th.fail(e); setStep(1); } finally { busy(false); }
}

// ------------------------------------------------------------ 流程：选
function pickCard(i) {
  bump("choose");
  const card = S.cards[i];
  msg("user", `选「${card.name}」`);
  S.scene = S.resolved[i];
  S.confirmed = new Set(); S.locked = new Set(); S.itemTexts = {}; S.diffs = [];
  setStep(3); renderViews(); renderPanels();
  if (S.axis) { // 变体回来：不再问问题
    setStep(S.step >= 5 ? 5 : 4);
    ai(`换成「${card.name}」。你锁住的地方没动，其它按这张卡重算了。`);
    renderPanels();
    return;
  }
  ai(`好，「${card.name}」。${card.one_liner}\n下面我最多问四个问题，每个都可以「你定」。右边随时能看我理解成了什么。`);
  S.queue = [qSlope, qSize, qLandmark, qEntry]; S.asked = 0; budget();
  askNext();
}
function askNext() { if (!S.queue.length) return finishQuestions(); const q = S.queue.shift(); S.asked++; budget(); q(); }
function thumb(patch, kind) { try { const t = S.scene.preview(patch); const c = { sid: t.sid, T: t.T, facts: t.facts }; return kind === "eye" ? renderEye(c).node.querySelector("svg") : kind === "profile" ? renderProfile(c).node.querySelector("svg") : renderMap(c, { small: true }); } catch { return null; } }
function answer(label, patch, key) { bump("choose"); msg("user", label); if (patch) { applyPatch(patch); } if (key) S.userSet.add(key); }
function qSlope() {
  const cur = S.scene.card.params.layer_height_m;
  const opts = [[2.5, "缓", "每层 2.5 m，走着不累"], [3.5, "中", "每层 3.5 m，典型山城"], [5, "陡", "每层 5 m，仰头看"]].map(([v, l, sub]) => ({ label: l + (Math.abs(v - cur) < 0.3 ? "（现在）" : ""), sub, svg: thumb({ params: { layer_height_m: v } }, "profile"), patch: { params: { layer_height_m: v } } }));
  ai("第一个：坡度。每层台地的高差多少？（剖面是按主路算的）", withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "params.layer_height_m"); askNext(); }), askNext));
}
function qSize() {
  const cur = S.scene.card.params.terraces;
  const opts = [[3, "三十秒走完", "3 层"], [5, "两分钟走完", "5 层"], [7, "会迷路", "7 层"]].map(([n, l, sub]) => ({ label: l + (n === cur ? "（现在）" : ""), sub, svg: thumb({ params: { terraces: n } }, "map"), patch: { params: { terraces: n } } }));
  ai("第二个：规模。走完要多久？", withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "params.terraces"); askNext(); }), askNext));
}
function qLandmark() {
  const card = S.scene.card;
  const places = ["top", "ridge_end", "cliff_edge"].concat(card.archetype === "ring_terrace" ? ["plaza"] : []).slice(0, 3);
  const opts = places.map((p) => ({ label: PLACEMENT_LABEL[p] + (p === card.landmark.placement ? "（现在）" : ""), sub: p === "cliff_edge" ? "最醒目" : p === "top" ? "最经典" : "", svg: thumb({ landmark: { placement: p } }, "map"), patch: { landmark: { placement: p } } }));
  ai(`第三个：地标。${card.landmark.label}放在哪？（它决定了玩家一路朝什么走）`, withSkip(el("div", {}, renderOptions(opts, (o) => { answer(o.label, o.patch, "landmark.placement"); askKind(); }), el("div", { class: "hint", style: "margin-top:4px" }, "也可以在图上用「图钉」直接拖。")), askKind));
}
function askKind() {
  const card = S.scene.card;
  const row = chips(Object.entries(LANDMARK_LABEL).filter(([k]) => k !== card.landmark.kind).map(([, l]) => l), (l) => { const k = Object.keys(LANDMARK_LABEL).find((x) => LANDMARK_LABEL[x] === l); applyPatch({ landmark: { kind: k, label: l } }); askNext(); });
  ai(`地标就是「${card.landmark.label}」吗？不是的话换一个：`, el("div", {}, row, el("div", { style: "margin-top:6px" }, el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", "就是它"); askNext(); } }, "就是它"))));
}
function qEntry() {
  const card = S.scene.card;
  const opts = ["valley_bottom", "side_slope", "summit"].map((p) => ({ label: SPAWN_LABEL[p] + (p === card.spawn.placement ? "（现在）" : ""), sub: p === "valley_bottom" ? "仰望全村" : p === "side_slope" ? "半山切入" : "俯视全村", svg: thumb({ spawn: { placement: p } }, "eye"), patch: { spawn: { placement: p } } }));
  ai("最后一个：入口 / 第一眼。玩家从哪进来？三张是从入口看过去的样子。", withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "spawn.placement"); askNext(); }), askNext));
}
function finishQuestions() {
  setStep(4);
  renderPanels();
  ai("问完了。现在图上可以直接改：\n· 画路：在图上画一笔，这就是主路，我按坡度铺台阶\n· 圈区域：圈一块地，说它是林子 / 广场 / 更密 / 更稀\n· 图钉：拖地标和入口\n· 选择：点一栋房子 / 地标，看我是怎么理解的\n右边「我理解为」逐条点「对」，全对了就能出。", chips(["都对，直接出", "我先在图上改改"], (l) => { if (l.startsWith("都对")) { for (const it of S.items) S.confirmed.add(it.key); renderPanels(); } else hint("选一个工具，然后在俯视图上操作"); }));
  setQuickChips(["换一批", "再陡一点", "房子更密", "换成夜里"], (l) => (l === "换一批" ? askAxis() : onText(l)));
}

// ------------------------------------------------------------ 自由文本 → AI revise
async function onText(t) {
  if (!S.scene) return onIntent(t);
  await reviseWith({ type: "text", text: t });
}
async function reviseWith(action, { dropRegions = false } = {}) {
  const th = thinking();
  busy(true);
  try {
    const r = await api.revise(S.scene.card, action, lockedPayload());
    if (dropRegions && r.patch) delete r.patch.regions; // 多边形级的用途已由程序处理，不让 AI 改整层
    if (r.understood && r.patch && Object.keys(r.patch).length) applyPatch(r.patch);
    const attach = r.question && r.question.options ? el("div", {}, el("div", { class: "hint" }, r.question.text), chips(r.question.options, (o) => onText(o))) : r.ask_to_point ? chips(["在图上画一笔", "圈一块地", "拖地标"], (o) => { setTool(o.includes("画") ? "path" : o.includes("圈") ? "region" : "pin"); hint(`工具已切到「${o}」，在俯视图上操作`); }) : null;
    th.done(r.restatement || "好。", attach);
    return r;
  } catch (e) { th.fail(e); return null; } finally { busy(false); }
}

// ------------------------------------------------------------ 图上手势
const gestures = {
  tool: () => S.tool,
  onSelect(target, p) {
    if (!S.scene) return;
    if (S.step < 3) return;
    bump("point");
    const sc = S.scene, lm = sc.landmark();
    if (target.type === "house") {
      const v = sc.sid.volumes.find((x) => x.id === target.id); if (!v) return;
      const t = sc.T.terraceAt(v.position[0], v.position[2]);
      const faces = (sc.sid.relations || []).find((r) => r.type === "faces" && r.a === v.id);
      ai(`这栋在第 ${(t ? t.level : 0) + 1} 层，${v.size[0]}×${v.size[2]} m，门朝${faces ? (faces.b === "main_trail" ? "主路" : faces.b === (lm || {}).id ? "地标" : "最近的路") : "下坡"}，屋顶用色板 roof。`, chips(["对，锁住它", "删掉它"], (c) => { if (c.startsWith("对")) { sc.lockVolume(v.id); afterChange("锁住了，重排时它不动。"); } else { sc.removeVolume(v.id); afterChange("删了。"); } }));
    } else if (target.type === "landmark") {
      ai(`这是${lm.label}（地标），在${PLACEMENT_LABEL[sc.card.landmark.placement]}，玩家从入口第一眼${S.eye.landmark_visible ? "就看它" : "看不见它"}。`, chips(["对，锁住", "换个位置", "换个种类"], (c) => { if (c.startsWith("对")) lockItem("landmark"); else if (c.includes("位置")) { setTool("pin"); hint("用图钉把地标拖到你要的地方"); } else ai("换成：", chips(Object.values(LANDMARK_LABEL), (l) => { const k = Object.keys(LANDMARK_LABEL).find((x) => LANDMARK_LABEL[x] === l); applyPatch({ landmark: { kind: k, label: l } }); ai(`地标换成${l}。`); })); }));
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
      ai(`主路：${Math.round(f.length_m || 0)} m，爬升 ${Math.round(f.climb_m || 0)} m，约 ${Math.round(f.steps_estimate || 0)} 级台阶，最大坡度 ${f.max_slope}。想改走法就用「画路」重画一笔。`);
    } else hint(`(${Math.round(p[0])}, ${Math.round(p[1])}) · 第 ${(sc.T.levelAt(p[0], p[1]) || 0) + 1} 层 · 高 ${Math.round(sc.T.heightAt(p[0], p[1]) * 10) / 10} m`);
  },
  onFlip(kind, id, ev) {
    bump("point");
    if (kind === "path") { const it = (S.items || []).find((i) => i.key === "trail"); if (it) flipItem(it, ev); return; }
    const r = S.scene.sid.regions.find((x) => x.id === id); if (!r) return;
    showPopup(ev, regionTagButtons((tag) => { hidePopup(); setRegionTag(r, tag); }));
  },
  async onPath(points) {
    if (!S.scene) return;
    bump("point");
    const kind = classifyStroke(points);
    if (kind === "tap") return;
    const r = strokeToPath(points, { T: S.scene.T, anchors: S.scene.anchors(), snap: 10, maxPoints: 12 });
    if (kind === "loop") { gestures.onRegion(points, null); return; }
    S.scene.setTrail(r.points);
    renderViews(); renderPanels();
    const f = r.facts;
    const local = `读到你的笔画：${f.n_points} 个折点，${Math.round(f.length_m)} m，起点${f.start_snapped_to === "spawn" ? "吸附到入口" : f.start_snapped_to ? `吸到${f.start_snapped_to}` : "在图中"}，终点${f.end_snapped_to === "landmark" ? "吸附到地标" : "没到地标（关系检查会亮红）"}，穿过第 ${f.levels_crossed.map((l) => l + 1).join("、")} 层${f.crosses_stream ? "，跨溪一次（要桥）" : ""}。房子按新路重排了，台阶按坡度铺。`;
    ai(local);
    await reviseWith({ type: "stroke_path", facts: f });
  },
  onRegion(points, ev) {
    if (!S.scene) return;
    bump("point");
    const r = strokeToPolygon(points, { T: S.scene.T, maxPoints: 10 });
    if (!r.polygon || r.polygon.length < 3 || r.area_m2 < 20) { hint("圈得太小了，再圈大一点"); return; }
    const fakeEv = ev || { clientX: 0, clientY: 0 };
    showPopup(fakeEv, [el("span", { class: "hint" }, `圈了 ${Math.round(r.area_m2)} m²，跨第 ${r.levels_touched.map((l) => l + 1).join("、")} 层。这块是：`), ...regionTagButtons((tag) => { hidePopup(); addRegionWithTag(r, tag); })]);
  },
  canPin(kind) {
    if (S.locked.has(kind)) { ai(`${kind === "landmark" ? "地标" : "入口"}已经锁住了。要动它先在「我理解为」里解锁。`, chips(["解锁"], () => { S.locked.delete(kind); renderViews(); renderPanels(); ai("解锁了，拖吧。"); })); return false; }
    return true;
  },
  async onPinEnd(kind, p) {
    bump("point");
    const sc = S.scene;
    if (kind === "landmark") sc.setLandmark(p); else sc.setSpawn(p);
    renderViews(); renderPanels();
    const t = sc.T.terraceAt(p[0], p[1]);
    const where = `${t ? `第 ${t.level + 1} 层` : "台地外的坡上"}${p[0] < -20 ? "偏西" : p[0] > 20 ? "偏东" : ""}`;
    ai(kind === "landmark" ? `地标挪到${where}，主路重新接过去；从入口看它在画面${S.eye.landmark_screen || "中"}${S.eye.landmark_visible ? "" : "，但被挡住了（关系检查里有修法）"}。` : `入口挪到${where}，朝向重新对准地标，主路重算。`);
    await reviseWith({ type: "pin", what: kind, facts: { level: t ? t.level : null, visible: S.eye.landmark_visible, screen: S.eye.landmark_screen } });
  },
  onErase(target) {
    bump("point");
    const sc = S.scene;
    if (target.type === "region") { const r = sc.sid.regions.find((x) => x.id === target.id); if (r && r.user_set) { sc.removeRegion(r.id); afterChange("去掉了你圈的这块。"); } else if (r) { applyPatch({ regions: [{ terrace: r.terrace_level, kind: "other", density: 1 }] }); ai("这层恢复成普通民居。"); } }
    else if (target.type === "path") { if (sc.user.trail) { sc.resetTrail(); afterChange("主路恢复成算出来的。"); } }
    else if (target.type === "house") { sc.removeVolume(target.id); afterChange("删了这栋。"); }
    else if (target.type === "landmark" || target.type === "spawn") { if (sc.user.landmark || sc.user.spawn) { sc.clearPins(); afterChange("地标 / 入口回到卡片指定的位置。"); } }
  },
  onDiff(id, ev) { const d = S.diffs.find((x) => x.id === id); if (d) showPopup(ev, diffButtons(d)); },
};
const REGION_TAGS = { dense: "这里更密", sparse: "这里更稀", forest: "这里是林子", plaza: "这里是广场", terrace: "这里是梯田", farmland: "这里是农田" };
function regionTagButtons(onPick) { return Object.entries(REGION_TAGS).map(([tag, label]) => el("button", { class: "chip", onclick: () => { bump("choose"); msg("user", label); onPick(tag); } }, label)); }
async function addRegionWithTag(r, tag) {
  const sc = S.scene;
  const isDensity = tag === "dense" || tag === "sparse";
  const kind = isDensity ? "other" : tag;
  const density = tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0;
  // 密度在台地层级生效：窄台地（环带 / 两岸）一圈容易跨好几层，只取圈的重心所在那一层；圈得大（跨层且重心不在任何台地）才全算
  const mainT = sc.T.terraceAt(r.centroid[0], r.centroid[1]);
  const levels = mainT ? [mainT.level] : r.levels_touched;
  sc.addRegion({ kind, polygon: r.polygon, density, label: REGION_TAGS[tag], levels });
  if (isDensity) applyPatch({ regions: levels.map((l) => ({ terrace: l, density })) }, { silent: true });
  renderViews(); renderPanels();
  ai(`圈的这块记为「${REGION_TAGS[tag]}」${tag === "dense" ? `，第 ${levels.map((l) => l + 1).join("、")} 层房子加密，门都朝就近的路` : tag === "sparse" ? `，第 ${levels.map((l) => l + 1).join("、")} 层只留稀疏几栋` : tag === "forest" ? "，房子挪走，按 4–6 m 间距撒树" : tag === "plaza" ? "，房子挪走，铺石板" : "，房子挪走，顺等高线做田"}。标签点一下可以改。`);
  await reviseWith({ type: "region", tag, tag_label: REGION_TAGS[tag], kind, density, handled_by_program: !isDensity, facts: { area_m2: Math.round(r.area_m2), levels_touched: isDensity ? levels : r.levels_touched } }, { dropRegions: !isDensity });
}
function setRegionTag(r, tag) {
  const sc = S.scene;
  if (r.user_set) { const isD = tag === "dense" || tag === "sparse"; sc.updateRegion(r.id, { kind: isD ? "other" : tag, density: tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0, label: REGION_TAGS[tag] }); if (isD && r.levels) applyPatch({ regions: r.levels.map((l) => ({ terrace: l, density: tag === "dense" ? 1.4 : 0.6 })) }, { silent: true }); }
  else applyPatch({ regions: [{ terrace: r.terrace_level, kind: tag === "dense" || tag === "sparse" ? "other" : tag, density: tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0, label: REGION_TAGS[tag] }] }, { silent: true });
  afterChange(`这块改成「${REGION_TAGS[tag]}」。`);
}

// ------------------------------------------------------------ 换一批（按变化轴）
function askAxis() {
  if (!S.scene) { ai("先挑一张卡，再换一批。"); return; }
  ai("想在哪一条上换？其它都按你已经定的。", chips(Object.values(AXES), (l) => { const k = Object.keys(AXES).find((x) => AXES[x] === l); variants(k); }));
}
async function variants(axisKey) {
  const base = S.scene.card;
  const conflict = { landmark: "landmark", terraces: "terraces", entry: "spawn" }[axisKey];
  if (conflict && S.locked.has(conflict)) { ai(`「${AXES[axisKey]}」被你锁住了，这条轴换不了。先解锁，或换别的轴。`); return; }
  const overrides = axisOverrides(axisKey, base);
  const th = thinking(`按「${AXES[axisKey]}」出三张变体`);
  busy(true);
  try {
    const d = await api.draft(S.intent, { axis: AXES[axisKey], targets: overrides, locked: lockedPayload() });
    const cards = d.cards.map((c, i) => enforce(c, base, overrides[i]));
    const resolved = cards.map((c) => S.scene.clone().setCard(c));
    const notDistinct = !distinctEnough(resolved.map((r) => signature(r.sid)), 0.6);
    S.cards = cards; S.resolved = resolved; S.axis = axisKey;
    th.done(`三张只在「${AXES[axisKey]}」上不同（黄标是差异）。你锁住的：${[...S.locked].map((k) => ({ archetype: "原型", terraces: "层数", landmark: "地标", spawn: "入口", trail: "主路" }[k] || k)).join("、") || "无"}。`, renderCards(cards, resolved, { onPick: pickCard, axis: AXES[axisKey], notDistinct }));
  } catch (e) { th.fail(e); } finally { busy(false); }
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

// ------------------------------------------------------------ 出：导出 / 读回
function openModal(kids) { $("#modal-card").replaceChildren(...kids); $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }
function openExport() {
  if (!S.scene) return;
  setStep(6);
  const sc = S.scene, f = sc.facts;
  const body = el("div", {});
  const status = el("div", { class: "hint" });
  const fileIn = el("input", { type: "file", accept: ".json,application/json", style: "display:none", onchange: (ev) => { const file = ev.target.files && ev.target.files[0]; if (file) onReadbackFile(file, body, status); ev.target.value = ""; } });
  openModal([
    el("h3", {}, "出：交给引擎"),
    el("div", {}, `「${sc.sid.meta.name || sc.card.name}」· ${f.houses} 栋 · ${f.terraces} 层 · 关系 ${f.checks_ok}/${f.checks_total} ✓ · ${[...S.confirmed].length}/${(S.items || []).length} 条理解已确认`),
    el("p", { class: "hint" }, "包里是意图（scene.sid.json）+ 三张图（俯视 / 剖面 / 第一眼）+ BRIEF.md（给人或 AI 的交代）+ PROTOCOL.md（引擎侧 AI 的操作协议）。引擎侧搭完，把对象位置导成读回 JSON 再导进来，这里会把差的地方点红。"),
    el("div", { class: "actions" },
      el("button", { class: "ubtn primary", onclick: async () => { status.textContent = "在渲染三张图并打包…"; try { const blob = await buildPackage({ sid: sc.sid, card: sc.card, facts: sc.facts, checks: sc.checks, understanding: (S.items || []).map((i) => ({ text: i.text, detail: i.detail, confirmed: S.confirmed.has(i.key) })), eye: S.eye, views: { map: renderMap(ctx()), profile: S.profileSvg, eye: S.eyeSvg, three: S.three && S.three.snapshot ? S.three.snapshot() : null }, corrections: S.corrections }); download(`${fileStem(sc.sid.meta.name || sc.card.name)}.scene-package.zip`, blob); status.textContent = `已下载 ${Math.round(blob.size / 1024)} KB 的包。`; } catch (e) { status.textContent = "打包失败：" + e.message; } } }, "导出引擎包（zip）"),
      el("button", { class: "ubtn", onclick: () => { download(`${fileStem(sc.sid.meta.name || sc.card.name)}.sid.json`, new Blob([JSON.stringify(cleanSid(sc.sid), null, 2)], { type: "application/json" })); status.textContent = "已下载 .sid.json"; } }, "只存 SID"),
      el("button", { class: "ubtn", onclick: () => fileIn.click() }, "导入读回 JSON 对比"), fileIn,
      el("span", { class: "spacer" }), el("button", { class: "ubtn", onclick: closeModal }, "关闭")),
    status, body,
  ]);
  if (S.readback) renderReadback(body, status);
}
async function onReadbackFile(file, body, status) {
  status.textContent = "在比对…";
  try {
    const json = JSON.parse(await file.text());
    const res = await api.score(cleanSid(S.scene.sid), json);
    S.readback = res; S.diffs = readbackDiffs(res, S.scene.sid);
    renderViews();
    renderReadback(body, status);
    const s = res.summary;
    ai(`读回对上了 ${s.matched}/${s.intent_objects} 个对象：位置偏差中位数 ${s.pos_err_median_m} m，${s.pos_ok_rate_pct}% 在容差内；缺 ${s.missing.length}，多 ${s.extra.length}。红点是差的地方，每个点都给你三个选择。`);
  } catch (e) { status.textContent = "读回解析 / 比对失败：" + e.message; }
}
function renderReadback(body, status) {
  const res = S.readback; if (!res) return;
  body.replaceChildren();
  const s = res.summary;
  const okMark = (v) => (v === true ? "✓" : v === false ? "✗" : "—");
  const pct = (v) => (v == null ? "—" : `${v}%`);
  const vis = s.visible_from_spawn || {}, con = s.trail_connected || {};
  status.textContent = `读回格式 ${res.format} · 匹配 ${s.matched}/${s.intent_objects} · 位置中位误差 ${s.pos_err_median_m} m · 位置合格 ${s.pos_ok_rate_pct}% · 尺寸合格 ${s.size_ok_rate_pct}% · 朝向合格 ${s.rot_ok_rate_pct}% · 层合格 ${pct(s.level_ok_rate_pct)} · 颜色合格 ${pct(s.color_ok_rate_pct)} · 出生点见地标 ${okMark(vis.readback)}${vis.readback === false && vis.blocked_by ? `（被 ${vis.blocked_by} 挡）` : ""} · 主路连通 ${okMark(con.readback)}`;
  // 层：意图层→读回层（显示为第 n 层，1 起）；颜色：读回色块 + ΔE
  const levelCell = (r) => (r.level_intent == null ? "—" : r.level_ok === false ? `${r.level_intent + 1}→${r.level_readback + 1} 层` : `${r.level_intent + 1} 层`);
  const colorCell = (r) => (r.delta_e == null ? "—" : el("span", {}, el("span", { class: "swatch", style: `background:${r.color_readback}`, title: `读回 ${r.color_readback} · 意图 ${r.color_intent}` }), ` ΔE ${r.delta_e}`));
  const table = el("table", {}, el("tr", {}, ...["对象", "匹配到", "位置误差 m", "高度差 m", "尺寸比", "朝向差°", "层", "颜色", "怎么办"].map((h) => el("th", {}, h))));
  for (const r of res.rows) {
    const d = S.diffs.find((x) => x.id === r.id);
    const bad = !!d;
    table.append(el("tr", { class: bad ? "bad" : "" }, el("td", {}, r.id), el("td", {}, r.matched || "—"), el("td", { class: "num" }, r.pos_err_m ?? "—"), el("td", { class: "num" }, r.dy_m ?? "—"), el("td", { class: "num" }, r.size_ratio ?? "—"), el("td", { class: "num" }, r.rot_err ?? "—"),
      el("td", { class: "num" }, levelCell(r)), el("td", { class: "num" }, colorCell(r)),
      el("td", {}, bad ? el("div", { class: "fixes" }, ...diffButtons(d, () => renderReadback(body, status))) : "✓")));
  }
  for (const d of S.diffs.filter((x) => x.missing)) table.append(el("tr", { class: "bad" }, el("td", {}, d.id), el("td", {}, "— 引擎里没有"), el("td", { class: "num" }, "—"), el("td", { class: "num" }, "—"), el("td", { class: "num" }, "—"), el("td", { class: "num" }, "—"), el("td", { class: "num" }, "—"), el("td", { class: "num" }, "—"), el("td", {}, el("div", { class: "fixes" }, ...diffButtons(d, () => renderReadback(body, status))))));
  body.append(table);
  if (vis.readback === false || con.readback === false) body.append(el("p", { class: "hint" }, `${vis.readback === false ? `引擎里从出生点看不见地标${vis.blocked_by ? `（被 ${vis.blocked_by} 挡）` : ""}${vis.intent ? "，意图里能看见" : ""}。` : ""}${con.readback === false ? `引擎里主路没有从出生点连到地标门前${con.intent ? "，意图里是连通的" : ""}。` : ""}`));
  if (S.corrections.length) body.append(el("div", { style: "margin-top:8px" }, el("b", {}, "下一轮修正要求（会写进 BRIEF.md）"), el("pre", {}, S.corrections.join("\n"))));
}
function diffButtons(d, after = () => {}) {
  const row = d.row || {};
  const done = () => { S.diffs = S.diffs.filter((x) => x.id !== d.id); renderViews(); after(); };
  return [
    el("button", { class: "chip", onclick: () => { bump("choose"); const txt = d.missing ? `${d.id}：引擎里没放，请按 SID 位置 (${d.from[0]}, ${d.from[1]}) 补上` : `${d.id}：意图位置 (${d.from[0]}, ${d.from[1]})，引擎放在 (${d.to ? d.to.map((v) => Math.round(v * 10) / 10).join(", ") : "?"})，偏 ${row.pos_err_m} m${row.rot_ok === false ? `，朝向差 ${row.rot_err}°` : ""}${row.size_ok === false ? `，尺寸比 ${row.size_ratio}` : ""}${row.level_ok === false ? `，落在第 ${row.level_readback + 1} 层而不是第 ${row.level_intent + 1} 层` : ""}${row.color_ok === false ? `，颜色 ${row.color_readback} 应为 ${row.color_intent}（ΔE ${row.delta_e}）` : ""}；请按意图重放`; if (!S.corrections.includes(txt)) S.corrections.push(txt); done(); ai(`记下了：${txt}`); } }, "按意图修"),
    d.to ? el("button", { class: "chip", onclick: () => { bump("choose"); S.scene.acceptReadback(d.id, row.readback_position || [d.to[0], 0, d.to[1]], row.readback_rotation_y); done(); renderPanels(); ai(`${d.id} 接受引擎的位置，意图跟着改了并锁住。`); } }, "接受引擎版") : null,
    el("button", { class: "chip", onclick: () => { bump("choose"); done(); } }, "不重要"),
  ].filter(Boolean);
}

// ------------------------------------------------------------ 设置
async function refreshAI() {
  const h = await api.health();
  S.ai = h;
  const pill = $("#ai-status");
  if (!h) { pill.textContent = "AI：服务未连接"; pill.className = "pill mock"; return; }
  if (h.mock) { pill.textContent = "AI：模拟（无密钥）"; pill.className = "pill mock"; } else { pill.textContent = `AI：${h.model}`; pill.className = "pill live"; }
}
async function openSettings() {
  const dlg = $("#settings");
  try { const c = await api.config(); $("#s-key").value = ""; $("#s-key").placeholder = c.has_key ? `已保存 ${c.key_hint}（留空不改）` : "sk-ant-…"; $("#s-model").value = c.model; $("#s-mock").checked = !!c.mock && c.has_key; $("#s-key-hint").textContent = c.key_source === "env" ? "当前密钥来自环境变量 ANTHROPIC_API_KEY" : ""; } catch { $("#s-key-hint").textContent = "本地服务未连接：请用 python desktop/sid_editor.py 启动"; }
  $("#s-test-result").textContent = "";
  dlg.showModal();
}
function bindSettings() {
  $("#ai-status").addEventListener("click", openSettings);
  $("#s-cancel").addEventListener("click", () => $("#settings").close());
  $("#s-test").addEventListener("click", async () => { $("#s-test-result").textContent = "测试中…"; try { const r = await api.testKey($("#s-key").value.trim() || undefined); $("#s-test-result").textContent = r.ok ? `可用 · ${r.model} · ${r.ms} ms` : `不可用：${r.message}`; } catch (e) { $("#s-test-result").textContent = "失败：" + (e.data && e.data.message || e.message); } });
  $("#settings-form").addEventListener("submit", async (ev) => { ev.preventDefault(); const patch = { model: $("#s-model").value.trim() || undefined, mock: $("#s-mock").checked }; const key = $("#s-key").value.trim(); if (key) patch.api_key = key; try { await api.setConfig(patch); $("#settings").close(); await refreshAI(); sys(`AI 设置已保存：${S.ai && S.ai.mock ? "模拟模式" : "使用 " + S.ai.model}`); } catch (e) { $("#s-test-result").textContent = "保存失败：" + e.message; } });
}

// ------------------------------------------------------------ 界面绑定
function setTool(t) { S.tool = t; document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t)); $("#view-map").className = "view" + (S.view === "map" ? " active" : "") + " tool-" + t; hint({ path: "在俯视图上画一笔：起点靠近入口、终点靠近地标会自动吸附", region: "圈一块地，松手后选它是什么", pin: "拖动地标（红）或入口（蓝）", erase: "点一个你圈的区域 / 你画的路 / 一栋房子", select: "" }[t]); }
function setView(v) { S.view = v; document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === v)); document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + v)); if (v === "three") mountThree(); hidePopup(); }
function bindUI() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#btn-variants").addEventListener("click", askAxis);
  $("#btn-export").addEventListener("click", openExport);
  $("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
  document.addEventListener("pointerdown", (ev) => { if (!$("#popup").hidden && !$("#popup").contains(ev.target)) hidePopup(); }, true);
  $("#composer").addEventListener("submit", (ev) => { ev.preventDefault(); const t = $("#input").value.trim(); if (!t || S.busy) return; $("#input").value = ""; bump("type"); msg("user", t); onText(t); });
  bindSettings();
}

// ------------------------------------------------------------ 启动
async function start() {
  bindUI(); setStep(1); budget();
  await refreshAI();
  if (!S.ai) ai("本地服务没连上（/api 不可用）。请用「python desktop/sid_editor.py」或 SIDEditor.exe 启动，这个页面要靠它调 AI。界面本身仍能看。");
  ai("说一句你想要的场景就行，不用描述细节——我先给三张完整方案，你挑一张，再最多问你四个问题。\n例如：「我要生成山城村庄」。");
  setQuickChips(["我要生成山城村庄", "黄昏的山城村庄，有条溪", "夜里亮灯的山村，寺在最顶上"], (l) => onIntent(l));
}
start();

// 调试 / 自动化测试用
window.__scene = { S, applyPatch, onIntent, pickCard, variants, openExport, setTool, setView, gestures, renderViews, renderPanels, onReadbackFile, reviseWith, askAxis, ctx };
