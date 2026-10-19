// cards.js — 方案卡：三张完整的候选，带缩略图与「差异标签」（只有在三张之间不同的字段才高亮，且不同的字段不过半时才高亮）。
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
 * 渲染三张卡。
 * @param cards Card[]；resolved [{sid,T,facts}]（与 cards 对应，可为 null）
 * @param opts { onPick(i, btn), onLock(i)?, locked: Set<i>, axis?: string, notDistinct?: boolean }
 */
export function renderCards(cards, resolved, opts) {
  const box = el("div", { class: "cards" });
  if (opts.axis) box.append(el("div", { class: "hint" }, `这批只在「${opts.axis}」上不同，其它都按你已经定的。`));
  if (opts.notDistinct) box.append(el("div", { class: "hint" }, opts.axis ? `⚠ 算过几何后这三张差别很小：「${opts.axis}」这条轴在当前卡上影响不大，可以换一条轴。` : "⚠ 这三张差别不够大（算过几何后几乎一样），我已经让 AI 重出过一次；要不要换个说法？"));
  const tags = diffTags(cards);
  cards.forEach((card, i) => {
    const r = resolved && resolved[i];
    const thumb = r ? renderMap({ sid: r.sid, T: r.T }, { small: true }) : el("div", { class: "hint" }, "（几何未算出）");
    const stats = r && r.facts ? `${r.facts.houses || 0} 栋 · 主路 ${Math.round((r.facts.trail || {}).length_m || 0)} m · 爬升 ${Math.round((r.facts.trail || {}).climb_m || 0)} m` : "";
    const okCount = r && r.checks && r.checks.length ? `关系 ${r.checks.filter((c) => c.ok).length}/${r.checks.length} ✓` : "";
    const c = el("div", { class: "card" + (opts.locked && opts.locked.has(i) ? " locked" : "") },
      thumb,
      el("div", { class: "txt" },
        el("b", {}, card.name || `方案 ${i + 1}`),
        el("div", { class: "one" }, card.one_liner || card.summary || ""),
        el("div", { class: "tags" }, tags[i].map((t) => el("span", { class: "tag" + (t.diff ? " diff" : ""), title: t.diff ? "这张与其它两张不同的地方" : "" }, t.label))),
        el("div", { class: "hint" }, stats ? el("span", { class: "stat", style: "white-space:nowrap;margin-right:8px" }, stats) : null, okCount ? el("span", { class: "stat", style: "white-space:nowrap" }, okCount) : null),
        el("div", { class: "row" },
          el("button", { class: "primary", onclick: (ev) => opts.onPick(i, ev.currentTarget) }, "选这个"),
          opts.onLock ? el("button", { onclick: () => opts.onLock(i), title: "锁住这张：后面换一批时它留着不动" }, opts.locked && opts.locked.has(i) ? "已锁" : "锁住") : null,
        ),
      ),
    );
    box.append(c);
  });
  return box;
}

/** 三选项缩略图（答问题用）：每个选项一张小图 + 标签（o.cur 为真时带「现在」角标）；点过后整组失效 */
export function renderOptions(options, onPick) {
  const grid = el("div", { class: "opts" });
  options.forEach((o) => {
    const node = el("div", { class: "opt" });
    if (o.svg) node.append(o.svg);
    node.append(el("div", { class: "lbl" }, o.label, o.cur ? el("span", { class: "tag" }, "现在") : null));
    if (o.sub) node.append(el("div", { class: "sub" }, o.sub));
    node.append(el("button", { onclick: (ev) => { settle(ev.currentTarget); onPick(o); } }, o.button || "就这个"));
    grid.append(node);
  });
  return grid;
}
