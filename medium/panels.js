// panels.js — 右栏的关系检查（✓/✗ + 修法，全 ✓ 折成一行）与参考 / 色板；人话化 id 的小工具。
// 参数面板在 params.js，空间层 / 选中在 sidepanels.js。所有文案都从「卡 + 引擎事实」生成，不写死几何。
import { el } from "./cards.js";

/** 引擎内部 id → 人话：terrace_3（第 4 层）→ 第 4 层台地，main_trail → 主路，house_2_1 → 第 3 层第 2 栋 */
export function humanize(s) {
  return String(s || "")
    .replace(/(\S+?)\s*terrace_(w_|e_)?(\d+)（第 (\d+) 层([^）]*)）/g, "$1第 $4 层台地$5")
    .replace(/terrace_(w_|e_)?(\d+)/g, (_, side, n) => `${side === "w_" ? "西坡" : side === "e_" ? "东坡" : ""}第 ${+n + 1} 层台地`)
    .replace(/main_trail/g, "主路")
    .replace(/house_(\d+)_(\d+)/g, (_, l, i) => `第 ${+l + 1} 层第 ${+i + 1} 栋`)
    .replace(/u_house_(\d+)/g, "你挪的第 $1 栋")
    .replace(/tree_\w+/g, "一棵树")
    .replace(/spur_\w+/g, "支路");
}

/** 主路步行时间（分钟）：平路 70 m/min，每爬 10 m 多一分钟，最少半分钟 */
export function walkMinutes(t) { if (!t) return 0; return Math.max(0.5, Math.round(((t.length_m || 0) / 70 + (t.climb_m || 0) / 10) * 10) / 10); }

// ------------------------------------------------------------ 关系检查
/**
 * 关系检查列表：✗ 永远展开在最前；全 ✓ 时折成一行「n 项关系都成立」+「展开」；有 ✗ 时其余 ✓ 合并成一行。
 * st = { ignored: Set, expanded: boolean }，cb = { fix, ignore, unignore, toggle }
 */
export function renderChecks(ul, checks, st, cb) {
  ul.replaceChildren();
  if (!checks || !checks.length) { ul.append(el("li", {}, el("div", { class: "t hint" }, "还没有可检查的关系"))); return; }
  const isIgnored = (c) => st.ignored.has(c.id);
  const row = (c) => {
    const ignored = isIgnored(c);
    return el("li", { class: ignored ? "ignored" : "" },
      el("span", { class: c.ok ? "ok" : c.severity === "warn" ? "warn" : "bad" }, c.ok ? "✓" : "✗"),
      el("div", { class: "t" }, humanize(c.text), c.detail ? el("span", { class: "d" }, humanize(c.detail)) : null,
        !c.ok && !ignored && c.fixes && c.fixes.length ? el("div", { class: "fixes" }, c.fixes.map((f, i) => el("button", { onclick: () => cb.fix(c, i) }, f.label)), el("button", { onclick: () => cb.ignore(c.id) }, "不重要")) : null,
        ignored ? el("span", { class: "d" }, "你说不重要 · ", el("button", { onclick: () => cb.unignore(c.id) }, "重新算")) : null));
  };
  const toggleBtn = (label) => el("button", { onclick: () => cb.toggle && cb.toggle(), title: label === "展开" ? "逐条看每项关系" : "收起成一行" }, label);
  const bad = checks.filter((c) => !c.ok && !isIgnored(c));
  const ignoredOnes = checks.filter((c) => !c.ok && isIgnored(c));
  const good = checks.filter((c) => c.ok);
  if (!bad.length && !ignoredOnes.length && !st.expanded) {
    ul.append(el("li", { class: "confirmed", title: good.map((c) => humanize(c.text)).join(" · ") }, el("span", { class: "ok" }, "✓"), el("div", { class: "t" }, `${checks.length} 项关系都成立`), toggleBtn("展开")));
    return;
  }
  for (const c of bad) ul.append(row(c));
  for (const c of ignoredOnes) ul.append(row(c));
  if (st.expanded) {
    for (const c of good) ul.append(row(c));
    ul.append(el("li", {}, el("div", { class: "t hint" }, "每条 ✓ / ✗ 都是程序按几何算的"), toggleBtn("收起")));
  } else if (good.length) {
    ul.append(el("li", { class: "confirmed", title: good.map((c) => humanize(c.text)).join(" · ") }, el("span", { class: "ok" }, "✓"), el("div", { class: "t" }, `其余 ${good.length} 项 ✓`), toggleBtn("展开")));
  }
}

// ------------------------------------------------------------ 参考与色板
export const STYLE_BOARDS = {
  default: { name: "默认 · 青瓦夯土", items: [["roof", "#4A4A4A", "青瓦"], ["wall", "#D9C9A3", "夯土墙"], ["stone", "#9A9890", "石阶"], ["foliage", "#4F6B3A", "树"], ["mist", "#DDE6F0", "雾"]] },
  hongya: { name: "洪崖洞夜景", items: [["roof", "#3B2A22", "深褐瓦"], ["wall", "#C98A3D", "暖木墙"], ["stone", "#6E6A66", "青石"], ["foliage", "#2F4A33", "深绿"], ["mist", "#F2B85C", "灯光雾"]], time_of_day: "night" },
  wulong: { name: "武隆山村", items: [["roof", "#5A5F63", "灰瓦"], ["wall", "#E8E0CF", "白灰墙"], ["stone", "#A8A49C", "浅石"], ["foliage", "#6E8B4E", "黄绿"], ["mist", "#E6ECEF", "晨雾"]], time_of_day: "morning" },
  huizhou: { name: "徽州村落", items: [["roof", "#2E3338", "黛瓦"], ["wall", "#F3F0E8", "粉墙"], ["stone", "#8C8A84", "青石板"], ["foliage", "#4C7A45", "翠绿"], ["mist", "#D8E0E6", "水汽"]], time_of_day: "overcast" },
};
export function boardPalette(key) { return STYLE_BOARDS[key].items.map(([role, hex, note]) => ({ role, hex, note })); }

export function renderPalette(palBox, refBox, st, cb) {
  palBox.replaceChildren();
  for (const c of st.palette || []) palBox.append(el("span", { class: "sw", title: c.note || "" }, el("i", { style: `background:${c.hex}` }), c.role, el("code", {}, c.hex)));
  palBox.append(el("div", { class: "shift" }, [["cool", "偏冷"], ["neutral", "中性"], ["warm", "偏暖"], ["desaturate", "灰一点"]].map(([m, l]) => el("button", { class: "ubtn sm", onclick: () => cb.shift(m) }, l))));

  refBox.replaceChildren();
  const input = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) cb.upload(f); ev.target.value = ""; } });
  refBox.append(el("div", { style: "display:flex;gap:6px;align-items:center" }, el("button", { class: "ubtn sm", onclick: () => input.click() }, st.reference ? "换参考图" : "给一张参考图"), st.reference ? el("span", { class: "hint" }, `取了 ${st.reference.k} 色`) : el("span", { class: "hint" }, "或从风格板里挑："), input));
  if (st.reference) refBox.append(el("img", { src: st.reference.url, alt: "参考图" }));
  const boards = el("div", { class: "boards" });
  for (const [k, b] of Object.entries(STYLE_BOARDS)) boards.append(el("div", { class: "board" + (st.board === k ? " on" : ""), onclick: () => cb.pickBoard(k) }, el("div", { class: "strip" }, b.items.map(([, hex]) => el("i", { style: `background:${hex}` }))), b.name));
  refBox.append(boards);
}
