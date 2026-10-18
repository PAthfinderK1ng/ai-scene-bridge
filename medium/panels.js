// panels.js — 右栏三面板 + 色板：我理解为（可确认 / 翻替代 / 锁）、关系检查（✓/✗ + 修法）、我假设了（默认值可改）、参考与色板。
// 所有文案都从「卡 + 引擎事实」生成，不写死几何。
import { el, ARCH_LABEL, TOD_LABEL, WIDTH_LABEL } from "./cards.js";
import { LANDMARK_LABEL, PLACEMENT_LABEL, SPAWN_LABEL } from "./views/map.js";

// ------------------------------------------------------------ 我理解为
/**
 * @param ctx { card, facts, eye, checks, sid }
 * @returns [{ key, text, detail, alternatives: [{label, patch}] | [], lockable }]
 */
export function understandingItems(ctx) {
  const { card, facts = {}, eye = {} } = ctx;
  if (!card) return [];
  const p = card.params || {};
  const lmLabel = card.landmark.label || LANDMARK_LABEL[card.landmark.kind] || "地标";
  const t = facts.trail || {};
  const items = [];
  items.push({ key: "archetype", text: `整体是「${ARCH_LABEL[card.archetype] || card.archetype}」`, detail: card.one_liner || "", lockable: true,
    alternatives: Object.entries(ARCH_LABEL).filter(([k]) => k !== card.archetype).map(([k, l]) => ({ label: `改成「${l}」`, patch: { archetype: k } })) });
  items.push({ key: "terraces", text: `${p.terraces} 层台地，每层约 ${p.layer_height_m} m，${WIDTH_LABEL[p.plateau_width] || ""}`, detail: `村子总高差约 ${Math.round((p.terraces - 1) * p.layer_height_m)} m`, lockable: true,
    alternatives: [
      p.terraces > 3 ? { label: `少一层（${p.terraces - 1} 层）`, patch: { params: { terraces: p.terraces - 1 } } } : null,
      p.terraces < 7 ? { label: `多一层（${p.terraces + 1} 层）`, patch: { params: { terraces: p.terraces + 1 } } } : null,
      p.layer_height_m < 5.5 ? { label: `更陡（每层 ${Math.min(6, p.layer_height_m + 1.5)} m）`, patch: { params: { layer_height_m: Math.min(6, p.layer_height_m + 1.5) } } } : null,
      p.layer_height_m > 3 ? { label: `更缓（每层 ${Math.max(2.5, p.layer_height_m - 1.5)} m）`, patch: { params: { layer_height_m: Math.max(2.5, p.layer_height_m - 1.5) } } } : null,
      { label: p.plateau_width === "wide" ? "台地窄一点" : "台地宽一点", patch: { params: { plateau_width: p.plateau_width === "wide" ? "medium" : p.plateau_width === "medium" ? "wide" : "medium" } } },
    ].filter(Boolean) });
  items.push({ key: "landmark", text: `${lmLabel}（${LANDMARK_LABEL[card.landmark.kind] || card.landmark.kind}）在${PLACEMENT_LABEL[card.landmark.placement] || card.landmark.placement}`, detail: facts.landmark_level != null ? `落在第 ${facts.landmark_level + 1} 层，高 ${card.landmark.size_m[1]} m` : "", lockable: true,
    alternatives: Object.entries(PLACEMENT_LABEL).filter(([k]) => k !== card.landmark.placement && (k !== "plaza" || card.archetype === "ring_terrace")).map(([k, l]) => ({ label: `放到${l}`, patch: { landmark: { placement: k } } }))
      .concat(Object.entries(LANDMARK_LABEL).filter(([k]) => k !== card.landmark.kind).map(([k, l]) => ({ label: `换成${l}`, patch: { landmark: { kind: k, label: l } } }))) });
  const vis = eye.landmark_visible == null ? "" : eye.landmark_visible ? `，第一眼就看见它（画面${eye.landmark_screen || "中"}，仰角 ${eye.landmark_elev_deg}°）` : "，但第一眼看不见它（被挡住）";
  items.push({ key: "spawn", text: `玩家从${SPAWN_LABEL[card.spawn.placement] || card.spawn.placement}进来${vis}`, detail: eye.landmark_dist_m != null ? `到${lmLabel}直线约 ${eye.landmark_dist_m} m` : "", lockable: true,
    alternatives: Object.entries(SPAWN_LABEL).filter(([k]) => k !== card.spawn.placement).map(([k, l]) => ({ label: `入口改到${l}`, patch: { spawn: { placement: k } } })) });
  if (t.length_m != null) items.push({ key: "trail", text: `主路${ctx.userTrail ? "按你画的走" : t.folds === 0 ? "直上" : `之字 ${t.folds} 折`}，${Math.round(t.length_m)} m，爬升 ${Math.round(t.climb_m)} m`, detail: `约 ${Math.round(t.steps_estimate || 0)} 级台阶，最大坡度 ${Math.round((t.max_slope || 0) * 100) / 100}${t.max_slope > 0.7 ? "（偏陡）" : ""}`, lockable: true,
    alternatives: [[0, "直上"], [2, "之字 2 折"], [3, "之字 3 折"], [5, "盘绕 5 折"]].filter(([f]) => f !== t.folds || ctx.userTrail).map(([f, l]) => ({ label: `主路改成${l}`, action: { trail_folds: f } })).concat(ctx.userTrail ? [{ label: "恢复算出来的路", action: { trail_reset: true } }] : []) });
  if (facts.perTerrace) {
    const levels = Object.keys(facts.perTerrace).map(Number).sort((a, b) => a - b);
    const desc = levels.map((l) => `${l + 1} 层 ${facts.perTerrace[l]} 栋`).join("，");
    items.push({ key: "density", text: `共 ${facts.houses || 0} 栋民居：${desc}`, detail: card.regions && card.regions.some((r) => r.kind !== "other") ? "特殊用途：" + card.regions.filter((r) => r.kind !== "other").map((r) => `${r.terrace + 1} 层${r.label || r.kind}`).join("、") : "上密下疏", lockable: false,
      alternatives: [{ label: "整体更密（×1.3）", patch: { density_scale: 1.3 } }, { label: "整体更稀（×0.7）", patch: { density_scale: 0.7 } }] });
  }
  if (p.stream) items.push({ key: "stream", text: "一条溪从山上下来走谷底", detail: "宽约 4 m，房子离溪 ≥ 5 m", lockable: false, alternatives: [{ label: "去掉溪", patch: { params: { stream: false } } }] });
  items.push({ key: "lighting", text: `时段：${TOD_LABEL[(card.lighting || {}).time_of_day] || "黄昏"}，气氛「${(card.mood || []).join("、") || "宁静"}」`, detail: `色板：${(card.palette || []).map((c) => c.note || c.role).join(" / ")}`, lockable: false,
    alternatives: Object.entries(TOD_LABEL).filter(([k]) => k !== (card.lighting || {}).time_of_day).map(([k, l]) => ({ label: `改成${l}`, patch: { lighting: { time_of_day: k } } })) });
  return items;
}

export function renderUnderstanding(ul, items, st, cb) {
  ul.replaceChildren();
  for (const it of items) {
    const confirmed = st.confirmed.has(it.key), locked = st.locked.has(it.key);
    const li = el("li", { class: confirmed ? "confirmed" : "" },
      el("span", { class: confirmed ? "ok" : "warn" }, confirmed ? "✓" : "?"),
      el("div", { class: "t" }, it.text, locked ? el("span", { class: "badge lock" }, "锁") : null, it.detail ? el("span", { class: "d" }, it.detail) : null),
      el("div", { style: "display:flex;gap:3px;flex:none;flex-wrap:wrap;justify-content:flex-end;max-width:92px" },
        el("button", { class: confirmed ? "on" : "", onclick: () => cb.confirm(it.key), title: "对，就是这样" }, "对"),
        it.alternatives.length ? el("button", { onclick: (ev) => cb.flip(it, ev), title: "不是这样，看替代解释" }, "▾") : null,
        it.lockable ? el("button", { class: locked ? "on" : "", onclick: () => cb.lock(it.key), title: "锁住：出变体时不动它" }, "🔒") : null,
      ));
    ul.append(li);
  }
}

// ------------------------------------------------------------ 关系检查
export function renderChecks(ul, checks, st, cb) {
  ul.replaceChildren();
  if (!checks || !checks.length) { ul.append(el("li", {}, el("div", { class: "t hint" }, "还没有可检查的关系"))); return; }
  for (const c of checks) {
    const ignored = st.ignored.has(c.id);
    const li = el("li", { class: ignored ? "ignored" : "" },
      el("span", { class: c.ok ? "ok" : c.severity === "warn" ? "warn" : "bad" }, c.ok ? "✓" : "✗"),
      el("div", { class: "t" }, c.text, c.detail ? el("span", { class: "d" }, c.detail) : null,
        !c.ok && !ignored && c.fixes && c.fixes.length ? el("div", { class: "fixes" }, c.fixes.map((f, i) => el("button", { onclick: () => cb.fix(c, i) }, f.label)), el("button", { onclick: () => cb.ignore(c.id) }, "不重要")) : null,
        ignored ? el("span", { class: "d" }, "你说不重要 · ", el("button", { onclick: () => cb.unignore(c.id) }, "重新算")) : null));
    ul.append(li);
  }
}

// ------------------------------------------------------------ 我假设了
export function assumptionItems(card, userSet) {
  if (!card) return [];
  const p = card.params || {};
  const all = [
    { key: "lighting.time_of_day", label: "时段", value: TOD_LABEL[(card.lighting || {}).time_of_day] || "黄昏", options: Object.entries(TOD_LABEL).map(([k, l]) => ({ label: l, patch: { lighting: { time_of_day: k } } })) },
    { key: "params.layer_height_m", label: "每层高差", value: `${p.layer_height_m} m`, options: [2.5, 3, 4, 5, 6].map((v) => ({ label: `${v} m`, patch: { params: { layer_height_m: v } } })) },
    { key: "params.plateau_width", label: "台地宽度", value: WIDTH_LABEL[p.plateau_width] || p.plateau_width, options: Object.entries(WIDTH_LABEL).map(([k, l]) => ({ label: l, patch: { params: { plateau_width: k } } })) },
    { key: "params.stream", label: "溪流", value: p.stream ? "有" : "没有", options: [{ label: "有", patch: { params: { stream: true } } }, { label: "没有", patch: { params: { stream: false } } }] },
    { key: "landmark.size", label: "地标尺寸", value: `${card.landmark.size_m[0]}×${card.landmark.size_m[1]} m（宽×高）`, options: [[6, 7], [8, 9], [8, 14], [10, 18]].map(([w, h]) => ({ label: `${w}×${h} m`, patch: { landmark: { size_m: [w, h, w] } } })) },
    { key: "house.style", label: "房型", value: "坡顶木屋 5–7 m 宽", options: [] },
    { key: "wall", label: "挡土墙", value: "石砌", options: [] },
  ];
  return all.filter((a) => !userSet.has(a.key));
}

export function renderAssumptions(ul, items, cb) {
  ul.replaceChildren();
  if (!items.length) { ul.append(el("li", {}, el("div", { class: "t hint" }, "你都定过了，没有我替你假设的。"))); return; }
  for (const a of items) {
    ul.append(el("li", {}, el("div", { class: "t" }, `${a.label}：${a.value}`, el("span", { class: "badge" }, "默认")),
      a.options.length ? el("button", { onclick: (ev) => cb.pick(a, ev) }, "改") : el("span", { class: "d" }, "v1 固定")));
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
