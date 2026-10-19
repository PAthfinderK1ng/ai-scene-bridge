// params.js — 右栏「参数」：顶部一行 AI 的理解摘要，下面每个结构参数一行分段按钮（点了本地重算，可撤销）。
// 每行右侧一个锁：锁住的不参与「换一批」，AI 的改动也不碰它。人没动过的值带浅色「默认」（替代以前的「我假设了」）。
import { el, ARCH_LABEL, TOD_LABEL } from "./cards.js";
import { LANDMARK_LABEL, PLACEMENT_LABEL } from "./views/map.js";
import { slopeChoices, SLOPE_STEPS } from "./views/profile.js";
import { S, A } from "./state.js";

const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
/**
 * 参数表。fields = 这一行管的卡片字段（锁 / 剥离 AI patch / 变体强制都按它）。
 * opts(card) → [[值, 标签]]；patch(v) → 结构 patch。
 */
export const PARAMS = [
  { key: "archetype", label: "原型", fields: ["archetype"], opts: () => Object.entries(ARCH_LABEL).map(([k, l]) => [k, l.slice(0, 2)]), patch: (v) => ({ archetype: v }), full: (v) => ARCH_LABEL[v] },
  { key: "terraces", label: "层数", fields: ["params.terraces"], opts: () => [3, 4, 5, 6, 7].map((n) => [n, String(n)]), patch: (v) => ({ params: { terraces: v } }), full: (v) => `${v} 层` },
  { key: "layer", label: "每层高", fields: ["params.layer_height_m"], slope: true, opts: () => SLOPE_STEPS, patch: (v) => ({ params: { layer_height_m: v } }), full: (v) => `${v} m` },
  { key: "width", label: "台地宽", fields: ["params.plateau_width"], opts: () => [["narrow", "窄"], ["medium", "中"], ["wide", "宽"]], patch: (v) => ({ params: { plateau_width: v } }), full: (v) => ({ narrow: "窄", medium: "中", wide: "宽" }[v]) },
  { key: "lm_kind", label: "地标", fields: ["landmark.kind", "landmark.label"], opts: () => Object.entries(LANDMARK_LABEL), patch: (v) => ({ landmark: { kind: v, label: LANDMARK_LABEL[v] } }) },
  { key: "lm_place", label: "位置", fields: ["landmark.placement"], opts: (c) => [["top", "顶层"], ["ridge_end", "脊尽头"], ["cliff_edge", "临崖"], ["entry", "村口"]].concat(c.archetype === "ring_terrace" ? [["plaza", "广场"]] : []), patch: (v) => ({ landmark: { placement: v } }), full: (v) => PLACEMENT_LABEL[v] || v, note: "地标位置" },
  { key: "spawn", label: "入口", fields: ["spawn.placement", "params.entry_side"], opts: () => [["valley_bottom", "山脚"], ["side_slope", "半山"], ["summit", "山顶"]], patch: (v) => ({ spawn: { placement: v } }) },
  { key: "tod", label: "时段", fields: ["lighting.time_of_day"], opts: () => Object.entries(TOD_LABEL), patch: (v) => ({ lighting: { time_of_day: v } }) },
  { key: "stream", label: "溪", fields: ["params.stream"], opts: () => [[true, "有"], [false, "无"]], patch: (v) => ({ params: { stream: v } }) },
];
const valueOf = (def, card) => get(card, def.fields[0]);
/** 「换一批」的轴 → 它会改的参数行（锁住了就跳过这条轴） */
export const AXIS_PARAM = { landmark: "lm_place", terraces: "terraces", entry: "spawn", density: null, palette: null };

/** 一个 patch 碰到了哪些参数行（记「人动过」用） */
export function keysOfPatch(patch) {
  return PARAMS.filter((d) => d.fields.some((f) => get(patch, f) !== undefined)).map((d) => d.key);
}

/** 剥掉 AI patch 里锁住的字段，返回 { patch, stripped: [中文名] } */
export function stripLocked(patch, locked) {
  const p = JSON.parse(JSON.stringify(patch || {})), stripped = [];
  for (const d of PARAMS) {
    if (!locked.has(d.key)) continue;
    let hit = false;
    for (const f of d.fields) {
      const ks = f.split("."), last = ks.pop(), box = ks.reduce((x, k) => (x == null ? undefined : x[k]), p);
      if (box && last in box) { delete box[last]; hit = true; if (ks.length && !Object.keys(box).length) delete p[ks[0]]; }
    }
    if (hit) stripped.push(d.label);
  }
  return { patch: p, stripped };
}

/** 变体卡：先套目标值，再把锁住的字段改回当前卡 */
export function enforce(card, base, override, locked) {
  const c = JSON.parse(JSON.stringify(card));
  const merge = (dst, src) => { for (const [k, v] of Object.entries(src || {})) { if (v && typeof v === "object" && !Array.isArray(v)) { dst[k] = dst[k] || {}; merge(dst[k], v); } else dst[k] = v; } };
  merge(c, override || {});
  for (const d of PARAMS) {
    if (!locked.has(d.key)) continue;
    for (const f of d.fields) {
      const ks = f.split("."), last = ks.pop(), v = get(base, f);
      let dst = c; for (const k of ks) { dst[k] = dst[k] && typeof dst[k] === "object" ? dst[k] : {}; dst = dst[k]; }
      if (v === undefined) delete dst[last]; else dst[last] = JSON.parse(JSON.stringify(v));
    }
  }
  return c;
}

const LOCK_SVG = (on) => `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2"/><path d="M4 5.5V4a2 2 0 0 1 4 0${on ? "v1.5" : "V3.2"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

/** 画参数面板（box = #params） */
export function renderParams(box) {
  const card = S.scene && S.scene.card;
  box.replaceChildren();
  if (!card) return;
  box.append(el("div", { class: "psum", title: "AI 对这一句的理解" }, el("b", {}, card.name || "方案"), " ", card.one_liner || card.summary || ""));
  for (const d of PARAMS) {
    const cur = valueOf(d, card), locked = S.locked.has(d.key);
    // 坡度行与剖面的坡度 chips 同一规则（slopeChoices）：按区间高亮一档，确切米数在悬停提示里
    const sl = d.slope ? slopeChoices(cur) : null;
    const opts = sl ? sl.items.map((x) => [x.v, x.l]) : d.opts(card);
    const seg = el("span", { class: "seg" });
    for (const [v, l] of opts) {
      const it = sl && sl.items.find((x) => x.v === v), on = it ? it.on : v === cur, act = it ? it.act : !on;
      seg.append(el("button", { type: "button", class: on ? "on" : "", "aria-pressed": String(on), title: it ? it.title : d.full ? d.full(v) : l, onclick: () => { if (act) setParam(d, v, l); } }, l));
    }
    const lock = el("button", { type: "button", class: "lock" + (locked ? " on" : ""), "aria-pressed": String(locked), title: locked ? "已锁：换一批和 AI 都不改它（点了解锁）" : "锁住：换一批和 AI 都不改它", onclick: () => { if (locked) S.locked.delete(d.key); else S.locked.add(d.key); A.bump("choose"); renderParams(box); } });
    lock.innerHTML = LOCK_SVG(locked);
    box.append(el("div", { class: "prow" + (locked ? " locked" : "") },
      el("span", { class: "pl" }, d.label), seg,
      S.userSet.has(d.key) ? el("span", { class: "pdef" }) : el("span", { class: "pdef", title: "AI 定的，你还没动过" }, "默认"),
      lock));
  }
}

/** 点了某一档：本地 applyPatch（可撤销），记为人动过 */
export function setParam(d, v, l) {
  A.bump("choose");
  A.edit(`${d.note || d.label}：${d.full ? d.full(v) : l}`, () => { if (!A.applyPatch(d.patch(v))) return false; S.userSet.add(d.key); });
}
