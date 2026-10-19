// cards.js — 小工具 el / settle、中文标签、方案卡的差异标签与中栏三张并排（renderCompare）。
import { renderMap, LANDMARK_LABEL, PLACEMENT_LABEL, SPAWN_LABEL } from "./views/map.js";

export const ARCH_LABEL = { slope_zigzag: "之字叠落", ring_terrace: "环台广场", valley_two_banks: "溪谷双坡" };
export const TOD_LABEL = { dawn: "黎明", morning: "清晨", noon: "正午", afternoon: "午后", dusk: "黄昏", night: "夜里", overcast: "阴天" };
export const WIDTH_LABEL = { narrow: "窄台地", medium: "中等台地", wide: "宽台地" };

/** 建 DOM 元素：class / on* / 其它属性；子节点可为字符串、节点、数组，null 跳过 */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

/** 聊天里的按钮用过一次就失效：同一条消息 / 附件里的按钮全部 disabled，被点的那个标 .on */
export function settle(btn) {
  if (!btn) return;
  const box = btn.closest(".attach, .msg");
  if (box) box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  btn.classList.add("on");
}

/** 一张卡的可比较字段 → 标签 */
export function cardFacets(card) {
  const p = card.params || {};
  return {
    archetype: ARCH_LABEL[card.archetype] || card.archetype,
    terraces: `${p.terraces} 层`,
    layer: `${p.layer_height_m} m/层`,
    landmark: `${LANDMARK_LABEL[card.landmark.kind] || card.landmark.kind}·${PLACEMENT_LABEL[card.landmark.placement] || card.landmark.placement}`,
    spawn: `入口·${SPAWN_LABEL[card.spawn.placement] || card.spawn.placement}`,
    width: WIDTH_LABEL[p.plateau_width] || p.plateau_width,
    stream: p.stream ? "有溪" : "无溪",
    tod: TOD_LABEL[(card.lighting || {}).time_of_day] || "",
  };
}

/** 三张卡逐字段比较：不全相同的字段标 diff；若不同的字段过半（第一批常见），高亮就没有信息量，全部不标 */
export function diffTags(cards) {
  const facets = cards.map(cardFacets);
  const keys = Object.keys(facets[0] || {});
  const differs = (k) => new Set(facets.map((g) => g[k])).size > 1;
  const nDiff = keys.filter(differs).length;
  const use = nDiff <= Math.ceil(keys.length / 2);
  return facets.map((f) => keys.filter((k) => f[k]).map((k) => ({ key: k, label: f[k], diff: use && differs(k) })));
}

/**
 * 中栏并排放三张方案（点大图 = 选）：缩略图、名字、一句话、差异标签、统计。
 * @param cards Card[]；resolved [{sid,T,facts}]
 * @param opts { onPick(i), axis?: string, notDistinct?: boolean, foot?: Node（底部一行按钮） }
 */
export function renderCompare(cards, resolved, opts) {
  const tags = diffTags(cards);
  const head = opts.axis ? `这批只换「${opts.axis}」，其它都按你现在的。` : ""; // 第一批不再重复聊天里那句「点一张就开始改」
  const warn = opts.notDistinct ? (opts.axis ? "算过几何后差别很小：这条在当前方案上影响不大。" : "算过几何后三张差别不大，可以换个说法。") : null;
  const grid = el("div", { class: "cmp-grid" }, ...cards.map((c, i) => {
    const r = resolved[i], f = (r && r.facts) || {}, t = f.trail || {};
    const thumb = r ? renderMap({ sid: r.sid, T: r.T }, { small: true }) : el("div", { class: "hint" }, "（几何未算出）");
    if (thumb.setAttribute) thumb.setAttribute("class", "cmp-map");
    const pick = () => opts.onPick(i);
    return el("div", { class: "cmp", tabindex: 0, role: "button", title: "选这张", onclick: pick, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } } },
      thumb, el("b", {}, c.name || `方案 ${i + 1}`), el("div", { class: "one" }, c.one_liner || c.summary || ""),
      el("div", { class: "tags" }, tags[i].map((g) => el("span", { class: "tag" + (g.diff ? " diff" : "") }, g.label))),
      el("div", { class: "hint stat" }, `${f.houses || 0} 栋 · 主路 ${Math.round(t.length_m || 0)} m · 爬升 ${Math.round(t.climb_m || 0)} m`));
  }));
  return el("div", { class: "compare" }, head || warn ? el("div", { class: "cmp-head" }, head, warn ? el("span", { class: "warn" }, (head ? " " : "") + warn) : null) : null, grid, opts.foot || null);
}
