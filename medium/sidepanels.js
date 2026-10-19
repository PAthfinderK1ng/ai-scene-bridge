// sidepanels.js — 右栏「空间层」（天上 / 地面 / 地下 的空间与连接点、＋地下空间 / ＋空中平台）与「选中」（点了什么就显示它的事实与可改项）。
// 所有按钮都是本地操作（A.edit：可撤销、不调 AI）。
import { el } from "./cards.js";
import { S, A } from "./state.js";
import { LANDMARK_LABEL, REGION_KINDS, spaceLevelTag } from "./views/map.js";
import { slopeLabel } from "./views/profile.js";
import { STRATA_KINDS, SPACE_LABEL, VIA_LABEL, STRATUM_LABEL } from "./engine/strata.js";
import { zigzagTrail } from "./engine/routing.js";

const r1 = (v) => Math.round(v * 10) / 10;
const conns = (sc, id) => (sc.sid.markers || []).filter((m) => m.kind === "connector" && (m.to === id || m.from === id));
const btn = (label, on, cls = "", title = null) => el("button", { type: "button", class: cls, title, onclick: on }, label);
/** 一行：标题 + 控件 */
const row = (label, ...kids) => el("div", { class: "srow" }, el("span", { class: "pl" }, label), el("span", { class: "sctl" }, ...kids));
/** 分段按钮 */
function seg(items, cur, on) { return el("span", { class: "seg" }, ...items.map(([v, l]) => el("button", { type: "button", class: v === cur ? "on" : "", onclick: () => { if (v !== cur) on(v, l); } }, l))); }
/** − 值 + */
function stepper(text, minus, plus) { return el("span", { class: "stepper" }, btn("−", minus), el("span", { class: "val" }, text), btn("+", plus)); }

// ------------------------------------------------------------ 空间层
/** 空间连接方式：走引擎的 scene.setSpaceConnect（重算后仍然生效）；旧引擎没有时退回：AI 生成的改卡片 levels，人加的直接改连接点 */
export function setSpaceVia(sc, id, via) {
  if (typeof sc.setSpaceConnect === "function") { const r = sc.setSpaceConnect(id, via); return r !== false && r != null; }
  const s = sc.space(id); if (!s) return false;
  if (s.user_set) {
    s.connect = via;
    for (const m of conns(sc, id)) { m.via = via; m.label = (s.stratum === "underground" ? "下行" : "上行") + VIA_LABEL[via]; }
    sc.rebuild(); return true;
  }
  const m = /^space_([a-z]+)_(\d+)$/.exec(s.id), card = sc.card;
  if (!m || !card || !Array.isArray(card.levels)) return false;
  let k = 0; const idx = card.levels.findIndex((l) => l.kind === m[1] && ++k === Number(m[2]));
  if (idx < 0) return false;
  const levels = JSON.parse(JSON.stringify(card.levels)); levels[idx].connect = via;
  sc.patch({ levels }); return true;
}
const VIAS = { underground: ["stairs", "ladder", "well", "shaft", "elevator", "ramp"], sky: ["stairs", "ladder", "elevator", "rope_bridge"] };

/** 加一个空间（anchor 默认地标），选中它并切到它那一层 */
export function addSpace(stratum) {
  const kind = stratum === "underground" ? "cave" : "platform";
  A.bump("choose");
  A.edit(`加了${STRATUM_LABEL[stratum]}${SPACE_LABEL[kind]}`, (sc) => {
    const id = sc.addSpace({ stratum, kind, anchor: "landmark" });
    if (!id) return false;
    S.stratum = stratum; S.sel = { type: "space", id };
    if (S.view !== "map" && S.view !== "profile") S.view = "map";
  });
}

export function renderStrata(box) {
  const sc = S.scene; box.replaceChildren(); if (!sc) return;
  const item = (s) => {
    const c = conns(sc, s.id)[0], on = S.sel && S.sel.type === "space" && S.sel.id === s.id;
    return el("li", { class: "sitem" + (on ? " on" : ""), tabindex: 0, title: "选中并切到这一层", onclick: () => A.select({ type: "space", id: s.id }, s.stratum) },
      el("span", { class: "nm" }, s.label || SPACE_LABEL[s.kind]), el("span", { class: "d" }, `${spaceLevelTag(s, sc.sid, sc.T)} · ${s.stratum === "underground" ? "净高" : "上方"} ${r1(s.height)} m${c ? ` · ${s.stratum === "underground" ? "↓" : "↑"}${VIA_LABEL[c.via] || c.via}` : ""}`));
  };
  const group = (st, title, sub, add) => {
    const list = (sc.sid.spaces || []).filter((s) => s.stratum === st);
    return el("div", { class: "sgroup" + (S.stratum === st ? " now" : "") },
      el("div", { class: "sghead" }, el("button", { type: "button", class: "sgname", title: `切到${title}层`, onclick: () => A.setStratum(st) }, title), el("span", { class: "d" }, sub || (list.length ? `${list.length} 处` : "还没有")), add ? btn(add, () => addSpace(st), "add") : null),
      list.length ? el("ul", {}, ...list.map(item)) : null);
  };
  box.append(group("sky", "天上", null, "＋空中平台"),
    group("ground", "地面", `${new Set(sc.T.terraces.map((t) => t.level)).size} 层台地`), // 溪谷两岸同层算一层
    group("underground", "地下", null, "＋地下空间"));
}

// ------------------------------------------------------------ 选中
/** 选中对象的事实与可改项；没选中返回 false（面板隐藏） */
export function renderSelection(box) {
  const sc = S.scene, sel = S.sel; box.replaceChildren();
  if (!sc || !sel) return false;
  const E = A.edit, sid = sc.sid, T = sc.T, lm = sc.landmark(), layer = sid.meta.layer_height_m;
  const lvAt = (x, z) => { const t = T.terraceAt(x, z); return t ? `第 ${t.level + 1} 层` : "台地外的坡上"; };
  const head = (title, facts) => box.append(el("div", { class: "selhead" }, el("b", {}, title), facts ? el("span", { class: "d" }, facts) : null));
  const actions = (...b) => box.append(el("div", { class: "selact" }, ...b.filter(Boolean)));
  if (sel.type === "house" || sel.type === "tree") {
    const v = sid.volumes.find((x) => x.id === sel.id); if (!v) return false;
    if (sel.type === "tree") { head("一棵树", lvAt(v.position[0], v.position[2])); if (!v.generated) actions(btn("删除", () => A.removeSelected())); return true; }
    const faces = (sid.relations || []).find((r) => r.type === "faces" && r.a === v.id);
    head("房子", `${lvAt(v.position[0], v.position[2])} · ${r1(v.size[0])} × ${r1(v.size[2])} m · 门朝${faces ? (faces.b === "main_trail" ? "主路" : lm && faces.b === lm.id ? "地标" : "最近的路") : "下坡"}`);
    // 锁住 / 解锁（引擎 lockVolume）：拖过的房子解锁后留在原地、不会消失；程序摆的解锁 = 交回程序排
    const pinned = !!v.locked, moved = !!v.user_moved;
    const unlockLabel = moved ? "这栋解锁（留在原地）" : "这栋交回程序排";
    actions(btn(pinned ? "解锁" : "锁住", () => E(pinned ? unlockLabel : "锁住这栋", (s) => { s.lockVolume(v.id, !pinned); if (pinned && !moved) S.sel = null; }), "", pinned ? (moved ? "去掉锁，留在原地" : "交回程序排：重排时按规则摆") : "重排时不动它"),
      btn("删除", () => A.removeSelected(), "", "Delete 键同"), btn("剖到这里", () => A.sectionTo(sel)));
    box.append(el("div", { class: "hint" }, moved ? (pinned ? "你挪过的，已锁住；可以再拖。" : "你挪过的，没锁；可以再拖。") : pinned ? "已锁住：重排时不动它。" : "程序摆的：拖它就锁在新位置。"));
    return true;
  }
  if (sel.type === "landmark") {
    if (!lm) return false;
    const h = lm.size[1];
    head(`${lm.label || "地标"}（${LANDMARK_LABEL[sc.card.landmark.kind] || "地标"}）`, `${lvAt(lm.position[0], lm.position[2])} · 第一眼${S.eye.landmark_visible ? "看得见" : "看不见"}`);
    box.append(row("高度", stepper(`${r1(h)} m`, () => E(`地标高 ${Math.max(2, h - 1)} m`, (s) => { s.setLandmarkHeight(h - 1); }), () => E(`地标高 ${Math.min(40, h + 1)} m`, (s) => { s.setLandmarkHeight(h + 1); })), sc.user.landmark_h != null ? btn("恢复", () => E("地标恢复默认高度", (s) => { s.setLandmarkHeight(null); })) : null));
    actions(sc.user.landmark ? btn("回到方案位置", () => E("地标回到方案位置", (s) => { s.clearPin("landmark"); })) : null, btn("剖到这里", () => A.sectionTo(sel)));
    box.append(el("div", { class: "hint" }, "拖它换位置；种类和位置在「参数」里换。"));
    return true;
  }
  if (sel.type === "spawn") {
    head("入口", `${S.eye.landmark_dist_m != null ? `到地标 ${S.eye.landmark_dist_m} m · ` : ""}第一眼${S.eye.landmark_visible ? `看见地标（画面${S.eye.landmark_screen || "中"}）` : "看不见地标"}`);
    actions(sc.user.spawn ? btn("回到方案位置", () => E("入口回到方案位置", (s) => { s.clearPin("spawn"); })) : null, btn("看第一眼", () => A.setView("eye")));
    return true;
  }
  if (sel.type === "terrace") {
    const t = T.terraces.find((x) => x.id === sel.id), fe = (sid.terrain.features || []).find((x) => x.id === sel.id); if (!t) return false;
    const h = t.height;
    head(`第 ${t.level + 1} 层台地`, `+${r1(h)} m · ${(sc.facts.perTerrace || {})[t.level] || 0} 栋`);
    const setH = (v) => E(`第 ${t.level + 1} 层台地 +${v} m`, (s) => { s.setTerraceHeight(t.id, v); });
    box.append(row("高度", stepper(`+${r1(h)} m`, () => setH(h - 0.5), () => setH(h + 0.5)), fe && fe.user_height ? btn("恢复", () => E(`第 ${t.level + 1} 层台地恢复 +${r1(t.level * layer)} m`, (s) => { s.setTerraceHeight(t.id, null); })) : null));
    box.append(el("div", { class: "hint" }, "剖面里上下拖平台段也能改。"));
    return true;
  }
  if (sel.type === "path" || sel.type === "trail_vertex") {
    const fct = sc.facts.trail || {};
    head(sel.type === "path" ? "主路" : `主路第 ${sel.index} 个折点`, `${Math.round(fct.length_m || 0)} m · 爬升 ${Math.round(fct.climb_m || 0)} m · 约 ${Math.round(fct.steps_estimate || 0)} 级 · 最陡 ${slopeLabel(fct.max_slope || 0)}`);
    const cur = sc.user.trail ? null : fct.folds;
    box.append(row("走法", seg([[0, "直上"], [2, "2 折"], [3, "3 折"], [5, "5 折"]], cur, (n, l) => E(`主路改成${l}`, (s) => {
      const sp = s.spawn(), L = s.landmark(); if (!sp || !L) return false;
      const r = zigzagTrail(s.T, [sp.position[0], sp.position[2]], [L.position[0], L.position[2]], { folds: n, maxSlope: 0.7 });
      if (!r.points) { A.note("这个折数在当前坡度上走不通，没改"); return false; }
      s.setTrail(r.points);
    }))));
    actions(sc.user.trail ? btn("恢复算出来的路", () => E("主路恢复成算出来的", (s) => { s.resetTrail(); })) : null);
    box.append(el("div", { class: "hint" }, sc.user.trail ? "现在按你画 / 拖的走。" : "拖白色折点、或用「画路」重画一笔。"));
    return true;
  }
  if (sel.type === "region") {
    const r = (sid.regions || []).find((x) => x.id === sel.id); if (!r) return false;
    head(r.user_set ? "你圈的地" : `第 ${(r.terrace_level ?? 0) + 1} 层台地`, `${(REGION_KINDS[r.kind] || {}).label || r.kind}${r.density != null && r.density !== 1 ? ` · 密度 ${r.density}` : ""}`);
    box.append(el("div", { class: "selact" }, ...A.regionTagButtons((tag) => A.setRegionTag(r, tag))));
    if (r.user_set) actions(btn("删除", () => A.removeSelected()));
    return true;
  }
  if (sel.type === "space") {
    const s = sc.space(sel.id); if (!s) return false;
    const c = conns(sc, s.id)[0], name = s.label || SPACE_LABEL[s.kind];
    head(name, `${STRATUM_LABEL[s.stratum]} · ${spaceLevelTag(s, sid, T)} · 底面 ${r1(s.floor_y)} m`);
    box.append(row("种类", seg(STRATA_KINDS[s.stratum].map((k) => [k, SPACE_LABEL[k]]), s.kind, (k, l) => E(`${name}改成${l}`, (x) => { x.updateSpace(s.id, { kind: k }); }))));
    const hl = s.stratum === "underground" ? "净高" : "上方";
    box.append(row(hl, stepper(`${r1(s.height)} m`, () => E(`${name}${hl} ${Math.max(2, s.height - 1)} m`, (x) => { x.updateSpace(s.id, { height: Math.max(2, s.height - 1) }); }), () => E(`${name}${hl} ${s.height + 1} m`, (x) => { x.updateSpace(s.id, { height: s.height + 1 }); }))));
    box.append(row("底面", stepper(`${r1(s.floor_y)} m`, () => E(`${name}底面 ${r1(s.floor_y - 1)} m`, (x) => { x.updateSpace(s.id, { floor_y: s.floor_y - 1 }); }), () => E(`${name}底面 ${r1(s.floor_y + 1)} m`, (x) => { x.updateSpace(s.id, { floor_y: s.floor_y + 1 }); }))));
    if (c) box.append(row("连接", seg(VIAS[s.stratum].map((v) => [v, VIA_LABEL[v]]), c.via, (v, l) => E(`${name}改用${l}连接`, (x) => setSpaceVia(x, s.id, v)))));
    actions(btn("剖到这里", () => A.sectionTo(sel)), btn("删除", () => A.removeSelected()));
    box.append(el("div", { class: "hint" }, "俯视图里整体拖；剖面里上下拖改高度。"));
    return true;
  }
  if (sel.type === "connector") {
    const m = (sid.markers || []).find((x) => x.id === sel.id); if (!m) return false;
    const s = sc.space(m.to) || sc.space(m.from);
    head(`连接点 · ${VIA_LABEL[m.via] || m.via}`, `地面 ↔ ${s ? s.label : "空间"} · 下端 ${r1(m.bottom_y ?? m.position[1])} m · 上端 ${r1(m.top_y ?? m.position[1])} m`);
    if (s) box.append(row("方式", seg(VIAS[s.stratum].map((v) => [v, VIA_LABEL[v]]), m.via, (v, l) => E(`改用${l}`, (x) => setSpaceVia(x, s.id, v)))));
    box.append(el("div", { class: "hint" }, "拖它换位置，仍连着原来的两层。"));
    return true;
  }
  if (sel.type === "ground" && sel.p) {
    const p = sel.p, h = T.heightAt(p[0], p[1]), sp = sc.spawn().position, lmv = lm && lm.position;
    head(S.stratum === "ground" ? "这一点" : `${STRATUM_LABEL[S.stratum]}层`, `${lvAt(p[0], p[1])} · 比入口高 ${Math.round(h - T.heightAt(sp[0], sp[2]))} m · 离入口 ${Math.round(Math.hypot(p[0] - sp[0], p[1] - sp[2]))} m${lmv ? ` · 离地标 ${Math.round(Math.hypot(p[0] - lmv[0], p[1] - lmv[2]))} m` : ""}`);
    if (S.stratum !== "ground") box.append(el("div", { class: "hint" }, `用「圈区域」在这一层圈一块，就是一个新的${STRATUM_LABEL[S.stratum]}空间。`));
    return true;
  }
  return false;
}
