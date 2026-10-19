// scene.js — 引擎适配层：一张卡 + 人的覆盖（手画的路 / 圈的区域 / 拖过的地标、入口、房子、连接点 / 调过的台地与空间 / 不重要的检查）→ 可渲染的 SID。
// LLM 只改卡（结构参数）；人的手势只改这里的 user 覆盖或 sid 里人的对象（u_house_* / u_space_* / user_height）；几何全部由 engine/* 算。
// 重算时覆盖永远保留。本文件的方法全部本地执行，绝不调 AI。
import { newDoc, applyCard, resolve, applyPatch, snapshot, restore, setTerraceHeight as engineTerraceHeight, resetTerraceHeight, THEME } from "./engine/sid.js";
import { defaultSection, sampleSection, widthClamp } from "./engine/section.js";
import { makeSpace, generateSpaces, fitFloor, STRATA, STRATA_KINDS, CONNECTOR_VIA, VIA_LABEL } from "./engine/strata.js";
import { layoutHouses } from "./engine/layout.js";
import { analyze } from "./engine/relations.js";
import { pathFacts } from "./engine/routing.js";
import { pointInPolygon, r2 } from "./engine/terrain.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const xz = (p) => [p[0], p[2]];
/** 从 a 朝向 b 的 rotation_y（朝向向量 (−sin θ, −cos θ)） */
export function rotationToward(a, b) { const dx = b[0] - a[0], dz = b[1] - a[1]; if (Math.hypot(dx, dz) < 1e-9) return 0; return r2(((Math.atan2(-dx, -dz) * 180) / Math.PI + 360) % 360); }
const KIND_REGIONS = new Set(["forest", "plaza", "gathering", "farmland", "terrace"]);
const half = (v) => Math.round(Number(v) * 2) / 2;
/** 人的覆盖：trail 手画主路；regions 圈的区域；landmark / spawn 拖过的位置；landmark_h 地标高度；
 *  spaces 对「AI 生成的空间」的改动（按 id：polygon / floor_y / height / kind / label）；connectors 拖过的连接点（按 id：[x,z]）；
 *  removed 删掉的程序生成房子 / 树（存位置不存 id——重排后 id 会变）：[x, z, "building" | "prop"] */
const emptyUser = () => ({ trail: null, regions: [], landmark: null, spawn: null, landmark_h: null, spaces: {}, connectors: {}, removed: [] });
/** 删掉的位置附近多少米内的生成物重算后也不要（房 3 m，树 1.5 m） */
const REMOVED_R = { building: 3, prop: 1.5 };

export class Scene {
  constructor(seed = 7) {
    this.seed = seed;
    this.sid = newDoc();
    this.T = null; this.checks = []; this.facts = {};
    this.user = emptyUser();
    this.ignored = [];
  }
  get card() { return (this.sid.meta && this.sid.meta.card) || null; }
  landmark() { return (this.sid.volumes || []).find((v) => v.importance === "landmark") || null; }
  spawn() { return (this.sid.markers || []).find((m) => m.kind === "player_spawn") || null; }
  mainTrail() { return (this.sid.paths || []).find((p) => p.id === "main_trail") || null; }
  stream() { return (this.sid.paths || []).find((p) => p.kind === "river") || null; }

  /** 复制一份（变体预览 / 问题缩略图用），人的覆盖一起带过去 */
  clone() {
    const s = new Scene(this.seed);
    s.sid = restore(snapshot(this.sid));
    s.user = clone(this.user); s.ignored = this.ignored.slice();
    s.T = this.T; s.checks = this.checks; s.facts = this.facts;
    return s;
  }
  /** 用一张完整的卡重建（保留人的覆盖与手改过的区域标签；换了原型时删房记录作废——位置对不上了） */
  setCard(card) {
    if (card && card.archetype && this.sid.meta && this.sid.meta.archetype && card.archetype !== this.sid.meta.archetype) this.user.removed = [];
    applyCard(this.sid, Object.assign({}, card, { seed: this.seed })); return this.rebuild();
  }
  /** LLM / 面板给的结构 patch（Card 子集 + density_scale + palette_shift） */
  patch(p) { applyPatch(this.sid, p); return this.rebuild(); }
  /** 不改自己，返回打了 patch 的副本（已 rebuild） */
  preview(p) { return this.previewState((s) => s.patch(p)); }
  /**
   * 3D 实时预览：克隆一份，对副本执行 mutator(scene)（任意本地方法，如 s => s.moveVolume(id, p)），只 rebuild 一次后返回副本；本体不变。
   * mutator 里各方法自带的 rebuild 被合并成最后一次（拖动中每帧一次 resolve）。
   * @param {(s: Scene) => any} mutator
   * @returns {Scene} 临时 Scene（ms 字段是这次耗时）
   */
  previewState(mutator) {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const s = this.clone();
    if (typeof mutator === "function") {
      s.rebuild = () => s; // 合并 mutator 里的多次 rebuild
      try { mutator(s); } finally { delete s.rebuild; }
    }
    s.rebuild();
    s.ms = r2((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
    return s;
  }

  /** 重算几何：覆盖 → resolve → 人画的路 → 人圈的区域 → 关系 */
  rebuild() {
    const sid = this.sid;
    sid.meta.ignored_checks = this.ignored.slice();
    const lm = this.landmark(), sp = this.spawn();
    if (lm && this.user.landmark) { lm.position[0] = this.user.landmark[0]; lm.position[2] = this.user.landmark[1]; }
    if (sp && this.user.spawn) { sp.position[0] = this.user.spawn[0]; sp.position[2] = this.user.spawn[1]; }
    if (lm && sp) { sp.rotation_y = rotationToward(xz(sp.position), xz(lm.position)); lm.rotation_y = rotationToward(xz(lm.position), xz(sp.position)); }
    if (lm && Array.isArray(lm.size)) lm.size[1] = this.user.landmark_h != null ? this.user.landmark_h : this._landmarkDefaultH(lm);
    this._applySpaceEdits();
    // 人圈的「用途」区域参与布局（林子只出树、广场不放房）；「密度」区域只做标注，密度本身走卡的 regions
    sid.regions = (sid.regions || []).filter((r) => !r.user_set).concat(this.user.regions.filter((r) => KIND_REGIONS.has(r.kind)).map(clone));
    // resolve 自带：清旧的 generated 对象、A* 主路、够不到的台地自动补支路（auto_spur）、布房、关系与检查
    const r = resolve(sid, { seed: this.seed });
    this.T = r.T; this.checks = r.checks; this.facts = r.facts;
    if (this.user.trail) { this._applyUserTrail(); this._relayout(); }
    if (this.user.regions.length) this._applyUserRegions();
    const dropped = this._applyRemoved();
    if (this.user.trail || this.user.regions.length || dropped) this._reanalyze();
    this._landmarkLevel();
    return this;
  }
  /** 人删过的程序生成房子 / 树：重算后同一位置附近（房 3 m、树 1.5 m）的生成物去掉。返回去掉了几个 */
  _applyRemoved() {
    const R = this.user.removed || [];
    if (!R.length) return 0;
    const n0 = this.sid.volumes.length;
    this.sid.volumes = this.sid.volumes.filter((v) => !(v.generated && v.position && R.some(([x, z, k]) => k === v.kind && Math.hypot(v.position[0] - x, v.position[2] - z) <= (REMOVED_R[k] || 3))));
    return n0 - this.sid.volumes.length;
  }
  /** 地标默认高度：卡片 size_m，再按地标种类取主题默认 */
  _landmarkDefaultH(lm) {
    const c = this.card, L = (c && c.landmark) || {};
    if (Array.isArray(L.size_m) && L.size_m[1] > 0) return L.size_m[1];
    const defs = THEME.mountain_village.landmarks, d = defs[L.kind] || null;
    return d ? d.size[1] : lm.size[1];
  }
  /** AI 生成的空间被人改过的字段（applyCard 会按卡重新生成它们，id 确定，所以按 id 叠回）；拖过的连接点同理 */
  _applySpaceEdits() {
    const U = this.user;
    for (const s of this.sid.spaces || []) {
      const e = U.spaces[s.id];
      if (!e || s.user_set) continue;
      for (const k of ["polygon", "kind", "label"]) if (e[k] != null) s[k] = clone(e[k]);
      if (e.floor_y != null) s.floor_y = e.floor_y;
      if (e.height != null) s.height = e.height;
      if (e.floor_y != null || e.height != null) s.user_height = true;
      s.user_edited = true;
    }
    for (const m of this.sid.markers || []) {
      const p = m && m.kind === "connector" && U.connectors[m.id];
      if (p) { m.position = [p[0], m.position[1], p[1]]; m.user_moved = true; }
    }
  }
  /** 事实：地标落在第几层台地（0 起；台地外为 null），面板 / 擦除文案用 */
  _landmarkLevel() { const L = this.landmark(); const tt = L && this.T && this.T.terraceAt(L.position[0], L.position[2]); this.facts.landmark_level = tt ? tt.level : null; }

  _applyUserTrail() {
    const mt = this.mainTrail();
    if (!mt) return;
    mt.points = clone(this.user.trail); mt.user_drawn = true;
    const f = pathFacts(mt.points, this.T); delete f.segments;
    this.facts.trail = Object.assign(f, { user_drawn: true });
  }
  /** 房子按当前所有路重排（避开主路 / 支路 / 溪） */
  _relayout() {
    this.sid.volumes = this.sid.volumes.filter((v) => !v.generated);
    const L = layoutHouses(this.sid, this.T, { seed: this.seed, density: Number(this.sid.meta.density_scale) || 1 });
    for (const v of L.volumes) this.sid.volumes.push(v);
    this.facts.perTerrace = L.perTerrace; this.facts.rejected = L.rejected;
  }
  _applyUserRegions() {
    // 用途区域里不留房子；标注区域（更密 / 更稀）加回 sid.regions 只为显示
    const kinds = this.user.regions.filter((r) => KIND_REGIONS.has(r.kind));
    if (kinds.length) this.sid.volumes = this.sid.volumes.filter((v) => !(v.generated && v.kind === "building" && kinds.some((r) => pointInPolygon(xz(v.position), r.polygon))));
    for (const r of this.user.regions) if (!KIND_REGIONS.has(r.kind)) this.sid.regions.push(clone(r));
  }
  _reanalyze() {
    this.sid.relations = (this.sid.relations || []).filter((x) => !x.generated);
    const A = analyze(this.sid, this.T);
    for (const rel of A.relations) this.sid.relations.push(rel);
    this.checks = A.checks;
    const houses = this.sid.volumes.filter((v) => v.kind === "building" && v.importance !== "landmark");
    this.facts.houses = houses.length;
    this.facts.trees = this.sid.volumes.filter((v) => v.kind === "prop" && v.shape === "cylinder").length;
    const per = {}; for (const h of houses) { const t = this.T.terraceAt(h.position[0], h.position[2]); const l = t ? t.level : (h.terrace_level ?? 0); per[l] = (per[l] || 0) + 1; }
    this.facts.perTerrace = per;
    this.facts.checks_ok = A.checks.filter((c) => c.ok).length; this.facts.checks_total = A.checks.length;
    this._landmarkLevel();
  }

  // ---------- 人的覆盖
  setTrail(points) { this.user.trail = points.map(([x, z]) => [r2(x), r2(z)]); return this.rebuild(); }
  resetTrail() { this.user.trail = null; return this.rebuild(); }
  addRegion(region) { const id = region.id || `u_${Date.now().toString(36)}_${this.user.regions.length + 1}`; this.user.regions.push(Object.assign({ id, user_set: true, density: 1, label: "" }, region)); return this.rebuild(); }
  updateRegion(id, patch) { const r = this.user.regions.find((x) => x.id === id); if (r) Object.assign(r, patch); return this.rebuild(); }
  removeRegion(id) { this.user.regions = this.user.regions.filter((r) => r.id !== id); return this.rebuild(); }
  setLandmark(p) { const old = this.landmark() && xz(this.landmark().position); this.user.landmark = [r2(p[0]), r2(p[1])]; this._followTrailEnd(old, this.user.landmark, "end"); return this.rebuild(); }
  setSpawn(p) { const old = this.spawn() && xz(this.spawn().position); this.user.spawn = [r2(p[0]), r2(p[1])]; this._followTrailEnd(old, this.user.spawn, "start"); return this.rebuild(); }
  /** 手画的路若端点吸附在旧位置（8 m 内），地标 / 入口挪动后端点跟着挪 */
  _followTrailEnd(oldXZ, newXZ, which) {
    const t = this.user.trail;
    if (!t || !oldXZ || t.length < 2) return;
    const i = which === "end" ? t.length - 1 : 0;
    if (Math.hypot(t[i][0] - oldXZ[0], t[i][1] - oldXZ[1]) <= 8) t[i] = [newXZ[0], newXZ[1]];
  }
  clearPins() { this.user.landmark = null; this.user.spawn = null; return this.rebuild(); }
  /** 只清一枚图钉（"landmark" | "spawn"），另一枚的覆盖保留 */
  clearPin(kind) { if (kind !== "landmark" && kind !== "spawn") return this; this.user[kind] = null; return this.rebuild(); }
  /** 某栋房子人确认了：不再由布局重放。解锁：拖过的房子（user_moved）只去掉锁、留在原地；其余交回程序排 */
  lockVolume(id, on = true) {
    const v = this.sid.volumes.find((x) => x.id === id);
    if (!v) return this;
    if (on) { v.generated = false; v.locked = true; }
    else if (v.user_moved) v.locked = false;
    else { v.generated = true; delete v.locked; }
    return this.rebuild();
  }
  /** 删体块。程序生成的房子 / 树记下位置（user.removed），重算后那里不再长出来；可撤销（在 snapshotState 里） */
  removeVolume(id) {
    const v = this.sid.volumes.find((x) => x.id === id);
    if (v && v.generated && v.position && (v.kind === "building" || v.kind === "prop")) (this.user.removed = this.user.removed || []).push([r2(v.position[0]), r2(v.position[2]), v.kind]);
    this.sid.volumes = this.sid.volumes.filter((x) => x.id !== id);
    return this.rebuild();
  }
  /** 读回「接受引擎版」：把对象挪到引擎实际位置并锁住 */
  acceptReadback(id, position, rotation_y) {
    if (id === "landmark" || (this.landmark() && this.landmark().id === id)) return this.setLandmark([position[0], position[2]]);
    if (id === "spawn" || (this.spawn() && this.spawn().id === id)) return this.setSpawn([position[0], position[2]]);
    const v = this.sid.volumes.find((x) => x.id === id);
    if (v) { v.position = [r2(position[0]), v.position[1], r2(position[2])]; if (rotation_y != null) v.rotation_y = r2(rotation_y); v.generated = false; v.locked = true; }
    return this.rebuild();
  }

  // ---------- 直接操作（俯视图拖动 / 剖面拖动 / 空间层）——全部本地、即时，改完 rebuild
  /** 拖房子：生成的房子改名 u_house_<n>、去掉 generated、锁住、user_moved（resolve 贴地）。地标走 setLandmark。@returns 新 id（找不到 null） */
  moveVolume(id, p) {
    const lm = this.landmark();
    if (lm && lm.id === id) { this.setLandmark(p); return id; }
    const v = (this.sid.volumes || []).find((x) => x.id === id);
    if (!v || !v.position) return null;
    if (v.generated || !String(v.id).startsWith("u_")) {
      const taken = new Set(this.sid.volumes.map((x) => x.id));
      let n = 1; while (taken.has("u_house_" + n)) n++;
      v.id = "u_house_" + n;
    }
    delete v.generated; v.locked = true; v.user_moved = true;
    const b = this.sid.bounds;
    v.position = [r2(Math.max(b.min[0], Math.min(b.max[0], p[0]))), v.position[1], r2(Math.max(b.min[2], Math.min(b.max[2], p[1])))];
    this.rebuild();
    return v.id;
  }
  /** 拖主路折点：没有手画路时先把当前主路转成手画路，只动第 i 个折点 */
  moveTrailVertex(i, p) {
    if (!this.user.trail) { const mt = this.mainTrail(); if (!mt) return this; this.user.trail = clone(mt.points); }
    const t = this.user.trail;
    if (!(i >= 0 && i < t.length)) return this;
    t[i] = [r2(p[0]), r2(p[1])];
    return this.rebuild();
  }
  /** 剖面拖台地平台段：h 米（0.5 m 吸附）；null = 恢复规则高度 */
  setTerraceHeight(featureId, h) {
    if (h == null) resetTerraceHeight(this.sid, featureId); else engineTerraceHeight(this.sid, featureId, h);
    return this.rebuild();
  }
  /** 剖面拖地标顶边：高度 2–40 m（0.5 m 吸附）；null = 恢复卡片 / 主题默认 */
  setLandmarkHeight(h) {
    this.user.landmark_h = h == null || !Number.isFinite(Number(h)) ? null : Math.max(2, Math.min(40, half(h)));
    return this.rebuild();
  }
  /** 当前剖切（sid.meta.section，没有时默认沿主路 12 m）；返回副本 */
  section() { return clone((this.sid.meta && this.sid.meta.section) || defaultSection(this.sid, this.T)); }
  /** 改剖切：{mode?, line?, width_m?} 合并到当前；line 模式缺 line 时用 defaultSection 的 line。剖切不改几何，所以不 rebuild */
  setSection(patch = {}) {
    const cur = this.section();
    const mode = patch.mode === "line" || patch.mode === "trail" ? patch.mode : cur.mode;
    let line = Array.isArray(patch.line) && patch.line.length >= 2 ? patch.line.map((q) => [r2(q[0]), r2(q[1])]) : cur.line;
    if (!Array.isArray(line) || line.length < 2) line = defaultSection(this.sid, this.T).line;
    this.sid.meta.section = { mode, line, width_m: widthClamp(patch.width_m != null ? patch.width_m : cur.width_m) };
    return this;
  }
  /** 剖面数据（engine.sampleSection 的结果） */
  sectionData() { return this.T ? sampleSection(this.sid, this.T, this.section()) : null; }

  /** ＋空间：给 polygon 就用它，否则按 anchor / size 由引擎生成形状。人加的空间 user_set，自动带一个连接点。@returns 空间 id（失败 null） */
  addSpace({ stratum, kind, polygon, anchor, size, label } = {}) {
    if (!STRATA.includes(stratum) || !this.T) return null;
    let poly = polygon;
    if (!Array.isArray(poly) || poly.length < 3) {
      const g = generateSpaces([{ stratum, kind: kind || STRATA_KINDS[stratum][0], anchor, size, label }], Object.assign({}, this.sid, { spaces: [] }), this.T);
      poly = g.spaces[0] && g.spaces[0].polygon;
    }
    const r = makeSpace({ stratum, kind, polygon: poly, label }, this.sid, this.T);
    if (!r) return null;
    this.sid.spaces.push(r.space); this.sid.markers.push(r.connector);
    this.rebuild();
    return r.space.id;
  }
  space(id) { return (this.sid.spaces || []).find((s) => s.id === id) || null; }
  /** 改空间：floor_y / height 记为人调过（user_height，0.5 m 吸附）；kind 只换同层的种类；polygon 换形状 */
  updateSpace(id, patch = {}) {
    const s = this.space(id);
    if (!s) return this;
    const p = {};
    if (patch.floor_y != null && Number.isFinite(Number(patch.floor_y))) p.floor_y = half(patch.floor_y);
    if (patch.height != null && Number(patch.height) > 0) p.height = Math.max(1, half(patch.height));
    if (patch.kind && STRATA_KINDS[s.stratum].includes(patch.kind)) p.kind = patch.kind;
    if (typeof patch.label === "string" && patch.label.trim()) p.label = patch.label.trim().slice(0, 24);
    if (Array.isArray(patch.polygon) && patch.polygon.length >= 3) p.polygon = patch.polygon.map((q) => [r2(q[0]), r2(q[1])]);
    if (s.user_set) {
      Object.assign(s, p);
      if (p.floor_y != null || p.height != null) s.user_height = true;
      else if (p.polygon && !s.user_height && this.T) s.floor_y = fitFloor(s, this.T); // 没单独调过高度：按新位置取合格高度
    } else this.user.spaces[id] = Object.assign(this.user.spaces[id] || {}, p);
    return this.rebuild();
  }
  /** 空间整体平移 [dx, dz]（夹在 bounds 内） */
  moveSpace(id, d) {
    const s = this.space(id);
    if (!s || !Array.isArray(d)) return this;
    const b = this.sid.bounds, xs = s.polygon.map((q) => q[0]), zs = s.polygon.map((q) => q[1]);
    const dx = Math.max(b.min[0] - Math.min(...xs), Math.min(b.max[0] - Math.max(...xs), Number(d[0]) || 0));
    const dz = Math.max(b.min[2] - Math.min(...zs), Math.min(b.max[2] - Math.max(...zs), Number(d[1]) || 0));
    return this.updateSpace(id, { polygon: s.polygon.map((q) => [q[0] + dx, q[1] + dz]) });
  }
  /** AI 生成的空间在卡片 levels 里的下标（id 是 space_<kind>_<第几个同类>）；找不到 -1 */
  _levelIndex(s) {
    const m = s && s.generated && !s.user_set && /^space_([a-z]+)_(\d+)$/.exec(s.id), card = this.sid.meta.card;
    if (!m || !card || !Array.isArray(card.levels)) return -1;
    let k = 0;
    return card.levels.findIndex((l) => l.kind === m[1] && ++k === Number(m[2]));
  }
  /** 改空间的连接方式（via ∈ stairs / ladder / well / shaft / elevator / rope_bridge / ramp）：
   *  人加的空间直接改它的连接点；AI 生成的改卡片 levels 里那一项的 connect 再重算（重算后仍生效）。@returns this；不合法 false */
  setSpaceConnect(id, via) {
    const s = this.space(id);
    if (!s || !CONNECTOR_VIA.includes(via)) return false;
    const idx = this._levelIndex(s);
    if (idx >= 0) {
      const levels = clone(this.sid.meta.card.levels);
      levels[idx].connect = via;
      return this.patch({ levels });
    }
    let n = 0;
    for (const m of this.sid.markers || []) if (m.kind === "connector" && (m.from === id || m.to === id)) { m.via = via; m.label = (s.stratum === "underground" ? "下行" : "上行") + VIA_LABEL[via]; n++; }
    s.connect = via;
    return n ? this.rebuild() : false;
  }
  /** 删空间（连到它的连接点一起删）；AI 生成的空间同时从卡片 levels 里拿掉，下次重算不再生成 */
  removeSpace(id) {
    const s = this.space(id);
    if (!s) return this;
    const idx = this._levelIndex(s);
    if (idx >= 0) this.sid.meta.card.levels.splice(idx, 1);
    delete this.user.spaces[id];
    this.sid.spaces = this.sid.spaces.filter((x) => x.id !== id);
    this.sid.markers = this.sid.markers.filter((x) => !(x.kind === "connector" && (x.from === id || x.to === id)));
    for (const k of Object.keys(this.user.connectors)) if (!this.sid.markers.some((x) => x.id === k)) delete this.user.connectors[k];
    return this.rebuild();
  }
  /** 拖连接点：平移，仍连接原来的两层（两端高度由引擎重算） */
  moveConnector(id, p) {
    const m = (this.sid.markers || []).find((x) => x.id === id && x.kind === "connector");
    if (!m) return this;
    const q = [r2(p[0]), r2(p[1])];
    this.user.connectors[id] = q; m.position = [q[0], m.position[1], q[1]]; m.user_moved = true;
    return this.rebuild();
  }

  // ---------- 撤销
  /** 整个可撤销状态（卡、人的覆盖、不重要、种子、剖切、台地单独调高都在里面） */
  snapshotState() { return { sid: snapshot(this.sid), user: clone(this.user), ignored: this.ignored.slice(), seed: this.seed }; }
  restoreState(snap) {
    if (!snap || !snap.sid) return this;
    this.sid = restore(snap.sid); this.user = Object.assign(emptyUser(), clone(snap.user || {})); this.ignored = (snap.ignored || []).slice(); this.seed = snap.seed ?? this.seed;
    return this.rebuild();
  }

  // ---------- 检查
  ignore(id) { if (!this.ignored.includes(id)) this.ignored.push(id); this.sid.meta.ignored_checks = this.ignored.slice(); this._reanalyze(); return this; }
  unignore(id) { this.ignored = this.ignored.filter((x) => x !== id); this.sid.meta.ignored_checks = this.ignored.slice(); this._reanalyze(); return this; }
  /** 应用某条 check 的第 i 个修法；修法改了地标 / 入口 / 主路的话记成人的覆盖，重算时才留得住 */
  applyFix(check, i) {
    const fix = check.fixes && check.fixes[i];
    if (!fix || typeof fix.patch !== "function") return this;
    const before = { lm: this.landmark() && xz(this.landmark().position), sp: this.spawn() && xz(this.spawn().position), trail: this.mainTrail() && clone(this.mainTrail().points) };
    fix.patch(this.sid);
    const lm = this.landmark(), sp = this.spawn(), mt = this.mainTrail();
    if (lm && before.lm && (lm.position[0] !== before.lm[0] || lm.position[2] !== before.lm[1])) this.user.landmark = xz(lm.position);
    if (sp && before.sp && (sp.position[0] !== before.sp[0] || sp.position[2] !== before.sp[1])) this.user.spawn = xz(sp.position);
    if (mt && before.trail && JSON.stringify(mt.points) !== JSON.stringify(before.trail)) this.user.trail = clone(mt.points);
    if (this.sid.meta && this.sid.meta.relayout_requests) { this.seed += 1; delete this.sid.meta.relayout_requests; } // 「重排房子」：换种子重放
    if ((this.sid.meta.ignored_checks || []).length !== this.ignored.length) this.ignored = this.sid.meta.ignored_checks.slice();
    return this.rebuild();
  }

  /** 笔画吸附用的锚点 */
  anchors() {
    const lm = this.landmark(), sp = this.spawn(), mt = this.mainTrail(), st = this.stream();
    return { spawn: sp ? xz(sp.position) : null, landmark: lm ? xz(lm.position) : null, pathPoints: mt ? mt.points : [], streamPoints: st ? st.points : [] };
  }
  toJSON() { return snapshot(this.sid); }
}
