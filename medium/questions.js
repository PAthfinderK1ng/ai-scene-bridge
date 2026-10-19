// questions.js — 「答」：最多四个问题（坡度 → 规模 → 地标 → 入口 / 第一眼）。
// 每个选项都带算过的缩略图（坡度→剖面、规模→俯视、地标→俯视、入口→第一眼），标「现在」角标，都可以「你定」（写明保持什么）。
// 第三题把「放哪」和「换种类」合在同一条消息里；拖图钉也算答了第三题。
import { el, renderOptions } from "./cards.js";
import { renderMap, LANDMARK_LABEL, PLACEMENT_LABEL, SPAWN_LABEL } from "./views/map.js";
import { renderProfile } from "./views/profile.js";
import { renderEye } from "./views/eye.js";
import { walkMinutes } from "./panels.js";

let A = null;
/** 注入 app.js 的状态与工具：{ S, ai, msg, chips, withSkip, bump, applyPatch, setStep, setTool, renderPanels, confirmItem, openExport, setQuickChips, onText, budget } */
export function initQuestions(deps) { A = deps; }

/** 选卡后开始提问（计数清零） */
export function startQuestions() { const { S } = A; S.queue = [qSlope, qSize, qLandmark, qEntry]; S.asked = 0; S.pendingQ = null; A.budget(); askNext(); }
/** 下一题；队列空了就收尾 */
export function askNext() { const { S } = A; S.pendingQ = null; if (!S.queue.length) return finishQuestions(); const q = S.queue.shift(); S.asked++; A.budget(); q(); }

/** 用预览出的场景画一张缩略图（eye / profile / map） */
function thumbOf(t, kind) { try { const c = { sid: t.sid, T: t.T, facts: t.facts }; return kind === "eye" ? renderEye(c).node.querySelector("svg") : kind === "profile" ? renderProfile(c).node.querySelector("svg") : renderMap(c, { small: true }); } catch { return null; } }
/** 对当前场景打 patch 预览后的缩略图 */
function thumb(patch, kind) { try { return thumbOf(A.S.scene.preview(patch), kind); } catch { return null; } }
/** 记一次选择：用户消息 + patch + 记为用户定过 */
function answer(label, patch, key) { A.bump("choose"); A.msg("user", label); if (patch) A.applyPatch(patch); if (key) A.S.userSet.add(key); }

/** 第一题：坡度（每层高差），三张剖面 */
function qSlope() {
  const { S } = A;
  const cur = S.scene.card.params.layer_height_m;
  const opts = [[2.5, "缓", "每层 2.5 m，走着不累"], [3.5, "中", "每层 3.5 m，典型山城"], [5, "陡", "每层 5 m，仰头看"]].map(([v, l, sub]) => ({ label: l, cur: Math.abs(v - cur) < 0.3, sub, svg: thumb({ params: { layer_height_m: v } }, "profile"), patch: { params: { layer_height_m: v } } }));
  A.ai(`第一个：坡度。每层台地差多高？现在是每层 ${cur} m。三张小图是沿主路从侧面看的高差。`, A.withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "params.layer_height_m"); askNext(); }), askNext, `你定（保持每层 ${cur} m）`));
}
/** 第二题：规模（层数），三张俯视 + 真实步行分钟 */
function qSize() {
  const { S } = A;
  const cur = S.scene.card.params.terraces;
  const opts = [[3, "小"], [5, "中"], [7, "大"]].map(([n, l]) => {
    let pv = null; try { pv = S.scene.preview({ params: { terraces: n } }); } catch { /* 预览失败只少一张图 */ }
    const pf = pv && pv.facts ? pv.facts.trail : null;
    return { label: l, cur: n === cur, sub: `${n} 层${pf ? ` · 走约 ${walkMinutes(pf)} 分钟` : ""}`, svg: pv ? thumbOf(pv, "map") : null, patch: { params: { terraces: n } } };
  });
  A.ai("第二个：规模。多大的村子？小图是俯视，分钟是沿主路从入口走到地标的估计。", A.withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "params.terraces"); askNext(); }), askNext, `你定（保持 ${cur} 层）`));
}
/** 第三题：地标放哪（三张俯视）+ 种类不对就换（只重画本题，不算新问题）+ 可用图钉直接拖 */
function qLandmark() {
  const { S } = A;
  S.pendingQ = "landmark";
  const build = () => {
    const card = S.scene.card;
    const places = ["top", "ridge_end", "cliff_edge"].concat(card.archetype === "ring_terrace" ? ["plaza"] : []).slice(0, 3);
    const opts = places.map((p) => ({ label: PLACEMENT_LABEL[p], cur: p === card.landmark.placement, sub: p === "cliff_edge" ? "最醒目" : p === "top" ? "最经典" : "", svg: thumb({ landmark: { placement: p } }, "map"), patch: { landmark: { placement: p } } }));
    const others = Object.entries(LANDMARK_LABEL).filter(([k]) => k !== card.landmark.kind).map(([, l]) => l);
    return A.withSkip(el("div", {},
      renderOptions(opts, (o) => { S.pendingQ = null; answer(o.label, o.patch, "landmark.placement"); askNext(); }),
      el("div", { class: "hint", style: "margin-top:6px" }, `地标现在是「${card.landmark.label}」，不对就换：`),
      A.chips(others, (l) => { const k = Object.keys(LANDMARK_LABEL).find((x) => LANDMARK_LABEL[x] === l); A.applyPatch({ landmark: { kind: k, label: l } }); S.userSet.add("landmark.kind"); S.q3Node.replaceChildren(build()); }),
      el("button", { class: "chip", style: "margin-top:6px", onclick: () => { A.bump("choose"); A.setTool("pin"); } }, "或者点上面的「图钉」，在图上直接拖"),
    ), () => { S.pendingQ = null; askNext(); }, `你定（保持在${PLACEMENT_LABEL[card.landmark.placement] || card.landmark.placement}）`);
  };
  S.q3Node = el("div", {}, build());
  A.ai(`第三个：地标。${S.scene.card.landmark.label}放在哪？它决定玩家一路朝什么走。`, S.q3Node);
}
/** 第四题：入口 / 第一眼，三张从入口看过去的示意 */
function qEntry() {
  const { S } = A;
  const card = S.scene.card;
  const opts = ["valley_bottom", "side_slope", "summit"].map((p) => ({ label: SPAWN_LABEL[p], cur: p === card.spawn.placement, sub: p === "valley_bottom" ? "仰望全村" : p === "side_slope" ? "从半山切进来" : "俯视全村", svg: thumb({ spawn: { placement: p } }, "eye"), patch: { spawn: { placement: p } } }));
  A.ai("最后一个：入口 / 第一眼。玩家从哪进来？三张是从入口看过去的样子。", A.withSkip(renderOptions(opts, (o) => { answer(o.label, o.patch, "spawn.placement"); askNext(); }), askNext, `你定（保持从${SPAWN_LABEL[card.spawn.placement] || card.spawn.placement}进）`));
}
/** 问完了：两件事（核 / 改）+ 两个 chip；底部快捷 chip 改为本地执行的三个 */
function finishQuestions() {
  const { S } = A;
  A.setStep(4);
  A.renderPanels();
  A.ai("问完了。两件事：", el("div", {},
    el("ul", { class: "list" },
      el("li", {}, el("b", {}, "核："), "看右边「我理解为」，对的点「对」，全对就能「出」。"),
      el("li", {}, el("b", {}, "改："), "在图上动手——画一笔 = 主路，圈一块再说它是什么，拖红 / 蓝图钉挪地标和入口。")),
    A.chips(["都对，直接出", "我先画一笔"], (l) => {
      if (l.startsWith("都对")) { for (const it of S.items || []) A.confirmItem(it.key, true, true); A.setStep(5); A.renderPanels(); A.openExport(); }
      else A.setTool("path");
    })));
  // 每个快捷 chip：patch() 出结构 patch，say(before, after) 把改前后能核对的事实说出来（递增型的再点一次也有反应）
  const QUICK = {
    "再陡一点": { patch: () => ({ params: { layer_height_m: Math.min(6, S.scene.card.params.layer_height_m + 1.5) } }), say: (b, a) => `每层 ${b.layer} → ${a.layer} m，主路约 ${b.steps} → ${a.steps} 级台阶。` },
    "房子更密": { patch: () => ({ density_scale: Math.min(2, Math.round((S.scene.card.density_scale || 1) * 1.3 * 10) / 10) }), say: (b, a) => `密度 ${b.ds} → ${a.ds}，房子 ${b.houses} → ${a.houses} 栋${a.houses <= b.houses ? (a.ds >= 2 ? "（已到上限）" : "（这块地放不下更多，想更密先把林子 / 广场圈小）") : ""}。` },
    "换成夜里": { patch: () => ({ lighting: { time_of_day: "night" } }), say: (b, a) => (b.tod === a.tod ? "已经是夜里了。" : "换成夜里：色板压暗、窗口亮灯。") },
  };
  const snap = () => { const c = S.scene.card, f = S.scene.facts || {}, t = f.trail || {}; return { layer: c.params.layer_height_m, ds: c.density_scale || 1, houses: f.houses || 0, steps: Math.round(t.steps_estimate || 0), tod: (c.lighting || {}).time_of_day }; };
  A.setQuickChips(Object.keys(QUICK), (l) => {
    const q = QUICK[l]; if (!q) { A.onText(l); return; }
    const before = snap();
    if (q.patch().density_scale != null && before.ds >= 2) { A.ai("密度已经是上限 2，再密放不下了。"); return; }
    if (A.applyPatch(q.patch())) A.ai(`改了，图和关系重算了。${q.say(before, snap())}`);
  });
}
