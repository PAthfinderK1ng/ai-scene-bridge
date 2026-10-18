// scene.js — 引擎适配层：一张卡 + 人的覆盖（手画的路 / 圈的区域 / 拖过的地标与入口 / 不重要的检查）→ 可渲染的 SID。
// LLM 只改卡（结构参数）；人的手势只改这里的 user 覆盖；几何全部由 engine/* 算。重算时覆盖永远保留。
import { newDoc, applyCard, resolve, applyPatch, snapshot, restore } from "./engine/sid.js";
import { layoutHouses } from "./engine/layout.js";
import { analyze } from "./engine/relations.js";
import { pathFacts } from "./engine/routing.js";
import { pointInPolygon, r2 } from "./engine/terrain.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const xz = (p) => [p[0], p[2]];
/** 从 a 朝向 b 的 rotation_y（朝向向量 (−sin θ, −cos θ)） */
export function rotationToward(a, b) { const dx = b[0] - a[0], dz = b[1] - a[1]; if (Math.hypot(dx, dz) < 1e-9) return 0; return r2(((Math.atan2(-dx, -dz) * 180) / Math.PI + 360) % 360); }
const KIND_REGIONS = new Set(["forest", "plaza", "gathering", "farmland", "terrace"]);

export class Scene {
  constructor(seed = 7) {
    this.seed = seed;
    this.sid = newDoc();
    this.T = null; this.checks = []; this.facts = {};
    this.user = { trail: null, regions: [], landmark: null, spawn: null };
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
  /** 用一张完整的卡重建（保留人的覆盖与手改过的区域标签） */
  setCard(card) { applyCard(this.sid, Object.assign({}, card, { seed: this.seed })); return this.rebuild(); }
  /** LLM / 面板给的结构 patch（Card 子集 + density_scale + palette_shift） */
  patch(p) { applyPatch(this.sid, p); return this.rebuild(); }
  /** 不改自己，返回打了 patch 的副本（已 rebuild） */
  preview(p) { const s = this.clone(); s.patch(p); return s; }

  /** 重算几何：覆盖 → resolve → 人画的路 → 人圈的区域 → 关系 */
  rebuild() {
    const sid = this.sid;
    sid.meta.ignored_checks = this.ignored.slice();
    const lm = this.landmark(), sp = this.spawn();
    if (lm && this.user.landmark) { lm.position[0] = this.user.landmark[0]; lm.position[2] = this.user.landmark[1]; }
    if (sp && this.user.spawn) { sp.position[0] = this.user.spawn[0]; sp.position[2] = this.user.spawn[1]; }
    if (lm && sp) { sp.rotation_y = rotationToward(xz(sp.position), xz(lm.position)); lm.rotation_y = rotationToward(xz(lm.position), xz(sp.position)); }
    // 人圈的「用途」区域参与布局（林子只出树、广场不放房）；「密度」区域只做标注，密度本身走卡的 regions
    sid.regions = (sid.regions || []).filter((r) => !r.user_set).concat(this.user.regions.filter((r) => KIND_REGIONS.has(r.kind)).map(clone));
    // resolve 自带：清旧的 generated 对象、A* 主路、够不到的台地自动补支路（auto_spur）、布房、关系与检查
    const r = resolve(sid, { seed: this.seed });
    this.T = r.T; this.checks = r.checks; this.facts = r.facts;
    if (this.user.trail) { this._applyUserTrail(); this._relayout(); }
    if (this.user.regions.length) this._applyUserRegions();
    if (this.user.trail || this.user.regions.length) this._reanalyze();
    return this;
  }

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
  /** 某栋房子人确认了：不再由布局重放 */
  lockVolume(id, on = true) { const v = this.sid.volumes.find((x) => x.id === id); if (!v) return this; if (on) { v.generated = false; v.locked = true; } else { v.generated = true; delete v.locked; } return this.rebuild(); }
  removeVolume(id) { this.sid.volumes = this.sid.volumes.filter((x) => x.id !== id); return this.rebuild(); }
  /** 读回「接受引擎版」：把对象挪到引擎实际位置并锁住 */
  acceptReadback(id, position, rotation_y) {
    if (id === "landmark" || (this.landmark() && this.landmark().id === id)) return this.setLandmark([position[0], position[2]]);
    if (id === "spawn" || (this.spawn() && this.spawn().id === id)) return this.setSpawn([position[0], position[2]]);
    const v = this.sid.volumes.find((x) => x.id === id);
    if (v) { v.position = [r2(position[0]), v.position[1], r2(position[2])]; if (rotation_y != null) v.rotation_y = r2(rotation_y); v.generated = false; v.locked = true; }
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
    if (this.sid.meta && this.sid.meta.relayout_requests) { this.seed += 1; delete this.sid.meta.relayout_requests; } // 「让 AI 重排」：换种子重放
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
