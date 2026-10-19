// gestures.js — 俯视图手势与剖面拖动的回调：全部本地执行（A.edit：先入撤销栈、再改、再重画、提示条说一句），绝不调 AI，也不往聊天写东西。
import { el } from "./cards.js";
import { S, A } from "./state.js";
import { REGION_KINDS } from "./views/map.js";
import { classifyStroke, strokeToPath, strokeToPolygon } from "./engine/strokes.js";
import { rotateSection } from "./engine/section.js";
import { boxCorners } from "./engine/layout.js";
import { STRATA_KINDS, SPACE_LABEL, STRATUM_LABEL } from "./engine/strata.js";

const r1 = (v) => Math.round(v * 10) / 10;
const chip = (label, on) => el("button", { type: "button", class: "chip", onclick: on }, label);
const tip = (t) => el("span", { class: "hint" }, t);
/** 世界坐标在哪一层台地（文案用） */
function where(p) { const t = S.scene.T.terraceAt(p[0], p[1]); return t ? `第 ${t.level + 1} 层` : "台地外的坡上"; }
const spaceName = (id) => { const s = S.scene.space(id); return s ? s.label || SPACE_LABEL[s.kind] : "空间"; };

// ------------------------------------------------------------ 圈区域的用途
export const REGION_TAGS = { dense: "更密", sparse: "更稀", forest: "林子", plaza: "广场", terrace: "梯田", farmland: "农田" };
export function regionTagButtons(onPick) { return Object.entries(REGION_TAGS).map(([tag, label]) => chip(label, () => { A.bump("choose"); onPick(tag); })); }
const densityOf = (tag) => (tag === "dense" ? 1.4 : tag === "sparse" ? 0.6 : tag === "forest" ? 1 : 0);
/** 圈完选了用途：用途类挪走房子；密度类按重心所在那层台地生效 */
function addRegionWithTag(r, tag) {
  const isD = tag === "dense" || tag === "sparse", density = densityOf(tag);
  A.edit(`圈的这块：${REGION_TAGS[tag]}`, (sc) => {
    const mainT = sc.T.terraceAt(r.centroid[0], r.centroid[1]);
    const levels = mainT ? [mainT.level] : r.levels_touched;
    sc.addRegion({ kind: isD ? "other" : tag, polygon: r.polygon, density, label: REGION_TAGS[tag], levels });
    if (isD) A.applyPatch({ regions: levels.map((l) => ({ terrace: l, density })) });
  });
}
export function setRegionTag(r, tag) {
  const isD = tag === "dense" || tag === "sparse", dens = densityOf(tag);
  A.edit(`这块改成「${REGION_TAGS[tag]}」`, (sc) => {
    if (r.user_set) { sc.updateRegion(r.id, { kind: isD ? "other" : tag, density: dens, label: REGION_TAGS[tag] }); if (isD && r.levels) A.applyPatch({ regions: r.levels.map((l) => ({ terrace: l, density: dens })) }); }
    else A.applyPatch({ regions: [{ terrace: r.terrace_level, kind: isD ? "other" : tag, density: dens, label: REGION_TAGS[tag] }] });
  });
}

// ------------------------------------------------------------ 删除（擦除工具 / Delete 键 / 选中面板）
export function deleteTarget(t) {
  const sc = S.scene; if (!sc || !t) return;
  const clear = () => { if (S.sel && S.sel.type === t.type && S.sel.id === t.id) S.sel = null; };
  if (t.type === "house") {
    if (!sc.sid.volumes.some((x) => x.id === t.id)) return;
    return A.edit("删了一栋房子", (s) => { s.removeVolume(t.id); clear(); }); // 程序摆的也能删：重算后仍然不在（引擎记着）
  }
  if (t.type === "tree") {
    const v = sc.sid.volumes.find((x) => x.id === t.id); if (!v) return;
    if (v.generated) return A.note("树按林子的规则撒，删不掉单棵：把林子圈小一点");
    return A.edit("删了一棵树", (s) => { s.removeVolume(t.id); clear(); });
  }
  if (t.type === "space") return A.edit(`删了${spaceName(t.id)}（连同连接点）`, (s) => { s.removeSpace(t.id); clear(); });
  if (t.type === "region") {
    const r = (sc.sid.regions || []).find((x) => x.id === t.id); if (!r) return;
    if (r.user_set) return A.edit("去掉了你圈的这块", (s) => { s.removeRegion(r.id); clear(); });
    if (r.kind !== "other" || r.density !== 1) return A.edit(`第 ${(r.terrace_level ?? 0) + 1} 层恢复成普通民居`, () => { A.applyPatch({ regions: [{ terrace: r.terrace_level, kind: "other", density: 1 }] }); });
    return A.note("这层本来就是普通民居");
  }
  if (t.type === "path" || t.type === "trail_vertex") return sc.user.trail ? A.edit("主路恢复成算出来的", (s) => { s.resetTrail(); }) : A.note("主路本来就是算出来的，没什么可擦");
  if (t.type === "landmark" || t.type === "spawn") { const nm = t.type === "landmark" ? "地标" : "入口"; return sc.user[t.type] ? A.edit(`${nm}回到方案位置`, (s) => { s.clearPin(t.type); }) : A.note(`${nm}没被拖过`); }
  if (t.type === "connector") return A.note("连接点跟着空间走：删空间时一起删");
}
export function removeSelected() { if (S.sel) deleteTarget(S.sel); }

// ------------------------------------------------------------ 剖到这里：直线剖切过对象中心，保持当前角度，宽度至少盖住它
/** 对象的占地顶点（空间多边形 / 房子与地标的四角） */
function footprint(sc, t) {
  if (t.type === "space") { const s = sc.space(t.id); return s ? { pts: s.polygon, name: s.label || SPACE_LABEL[s.kind] } : null; }
  const v = t.type === "landmark" ? sc.landmark() : (sc.sid.volumes || []).find((x) => x.id === t.id);
  if (!v || !v.position || !v.size) return null;
  return { pts: boxCorners(v.position, v.size, v.rotation_y || 0), name: t.type === "landmark" ? v.label || "地标" : "这栋房子" };
}
/** 过 c、方向 d 的直线被 bounds（内缩 1 m）截出的两端 */
function chordThrough(c, d, b) {
  const lo = [b.min[0] + 1, b.min[2] + 1], hi = [b.max[0] - 1, b.max[2] - 1];
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-9) continue;
    const a = (lo[k] - c[k]) / d[k], e = (hi[k] - c[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, e)); t1 = Math.min(t1, Math.max(a, e));
  }
  return [[r1(c[0] + d[0] * t0), r1(c[1] + d[1] * t0)], [r1(c[0] + d[0] * t1), r1(c[1] + d[1] * t1)]];
}
export function sectionTo(t) {
  const sc = S.scene, f = sc && t && footprint(sc, t);
  if (!f || !f.pts || f.pts.length < 2) return;
  const b = sc.sid.bounds, xs = f.pts.map((p) => p[0]), zs = f.pts.map((p) => p[1]);
  const c = [Math.min(Math.max((Math.min(...xs) + Math.max(...xs)) / 2, b.min[0] + 1), b.max[0] - 1), Math.min(Math.max((Math.min(...zs) + Math.max(...zs)) / 2, b.min[2] + 1), b.max[2] - 1)];
  const cur = sc.section(), L = cur.line || [];
  let d = L.length >= 2 ? [L[1][0] - L[0][0], L[1][1] - L[0][1]] : [1, 0];
  const n = Math.hypot(d[0], d[1]); d = n > 1e-6 ? [d[0] / n, d[1] / n] : [1, 0];
  const line = chordThrough(c, d, b);
  const need = 2 * Math.max(...f.pts.map((p) => Math.abs((p[0] - c[0]) * -d[1] + (p[1] - c[1]) * d[0]))) + 2;
  const width = Math.ceil(Math.max(cur.width_m || 12, need));
  A.bump("choose");
  A.edit(`剖到${f.name}`, (s) => {
    if (cur.mode === "line" && JSON.stringify(cur.line) === JSON.stringify(line) && cur.width_m === width && S.view === "profile") return false;
    s.setSection({ mode: "line", line, width_m: width }); S.view = "profile";
  });
}

// ------------------------------------------------------------ 俯视图
export const mapHandlers = {
  tool: () => S.tool,
  canDrag: () => !!S.scene,
  /** 手势进行中：3D 浮窗淡到 15%、不接指针 */
  onGesture(on) { document.body.classList.toggle("gesturing", !!on); },
  /** Esc 取消拖动：图已还原，只收提示与 3D 剖切面 */
  onDragCancel() { A.hint(null); A.renderViews(); },
  /** 拖动中：剖切线实时给角度与长度，3D 小窗显示剖切面 */
  onDrag(t, p, info) {
    if (t.type.startsWith("section_") && info.line) {
      A.hint(`剖切线 ${info.length_m} m · ${info.angle_deg}°`);
      if (S.inset) S.inset.setSection({ mode: "line", line: info.line, width_m: S.scene.section().width_m });
    } else if (t.type === "house" || t.type === "landmark") A.hint(`→ ${where(p)}`);
  },
  onDragEnd(t, p, info) {
    A.hint(null); A.bump("point");
    switch (t.type) {
      case "house": return A.edit(() => `房子挪到${where(p)}，已锁住`, (sc) => { const id = sc.moveVolume(t.id, p); if (!id) return false; S.sel = { type: "house", id }; });
      case "landmark": return A.edit(() => `地标挪到${where(p)}，主路重接`, (sc) => { sc.setLandmark(p); });
      case "spawn": return A.edit("入口挪了，朝向重新对准地标", (sc) => { sc.setSpawn(p); });
      case "trail_vertex": return A.edit(`主路第 ${info.index} 个折点挪了`, (sc) => { sc.moveTrailVertex(info.index, p); });
      case "space": return A.edit(`${spaceName(t.id)}平移 ${Math.round(Math.hypot(info.delta[0], info.delta[1]))} m`, (sc) => { sc.moveSpace(t.id, info.delta); S.sel = { type: "space", id: t.id }; });
      case "connector": return A.edit("连接点挪了", (sc) => { sc.moveConnector(t.id, p); });
      default:
        if (t.type.startsWith("section_") && info.line) return A.edit(`剖切线 ${info.length_m} m · ${info.angle_deg}°`, (sc) => { sc.setSection({ mode: "line", line: info.line }); });
    }
  },
  onSelect(t, p) { A.bump("point"); A.select(t.type === "ground" ? { type: "ground", p } : t); },
  onSection(line, info) {
    A.bump("point");
    A.edit(`剖切线 ${info.length_m} m · ${info.angle_deg}°`, (sc) => { sc.setSection({ mode: "line", line }); }, { actions: S.view === "profile" ? [] : [{ label: "看剖面", fn: () => A.setView("profile") }] });
  },
  /** 画完一笔：本地算主路（吸附入口 / 地标），房子按新路重排 */
  onPath(points, ev) {
    if (!S.scene) return;
    const kind = classifyStroke(points);
    if (kind === "tap") return;
    if (kind === "loop") return mapHandlers.onRegion(points, ev);
    if (S.stratum !== "ground") { A.note("主路在地面层：先切到「地面」"); return; }
    A.bump("point");
    const r = strokeToPath(points, { T: S.scene.T, anchors: S.scene.anchors(), snap: 10, maxPoints: 12 }), f = r.facts;
    A.edit(`主路按你画的：${f.n_points} 个折点 · ${Math.round(f.length_m)} m${f.end_snapped_to === "landmark" ? "" : " · 没接到地标"}${f.crosses_stream ? " · 跨溪一次" : ""}`, (sc) => { sc.setTrail(r.points); });
  },
  /** 圈完：地面层选用途；地下 / 天上层 = 新建一个该层的空间（选种类） */
  onRegion(points, ev) {
    if (!S.scene) return;
    A.bump("point");
    const r = strokeToPolygon(points, { T: S.scene.T, maxPoints: 10 });
    if (!r.polygon || r.polygon.length < 3 || r.area_m2 < 20) { A.note("圈得太小了，再圈大一点"); return; }
    const area = Math.round(r.area_m2);
    if (S.stratum !== "ground") {
      const st = S.stratum;
      A.popup(ev, [tip(`圈了 ${area} m²，${STRATUM_LABEL[st]}的这块是：`), ...STRATA_KINDS[st].map((k) => chip(SPACE_LABEL[k], () => {
        A.hidePopup(); A.bump("choose");
        A.edit(`加了${STRATUM_LABEL[st]}${SPACE_LABEL[k]}`, (sc) => { const id = sc.addSpace({ stratum: st, kind: k, polygon: r.polygon }); if (!id) return false; S.sel = { type: "space", id }; });
      })), chip("算了", A.hidePopup)], r.centroid);
      return;
    }
    A.popup(ev, [tip(`圈了 ${area} m²，这块是：`), ...regionTagButtons((tag) => { A.hidePopup(); addRegionWithTag(r, tag); }), chip("算了", A.hidePopup)], r.centroid);
  },
  onErase(t) { A.bump("point"); deleteTarget(t); },
  /** 复述标签：主路 → 选中主路（右栏给走法）；区域 → 换用途 */
  onFlip(kind, id, ev) {
    A.bump("point");
    if (kind === "path") { A.select({ type: "path", id: "main_trail" }); return; }
    const r = (S.scene.sid.regions || []).find((x) => x.id === id); if (!r) return;
    A.popup(ev, [tip(`${(REGION_KINDS[r.kind] || {}).label || "这块"}改成：`), ...regionTagButtons((tag) => { A.hidePopup(); setRegionTag(r, tag); })]);
  },
  onDiff(id, ev) { const d = S.diffs.find((x) => x.id === id); if (d) import("./exportflow.js").then(({ diffButtons }) => A.popup(ev, diffButtons(d))); },
};

// ------------------------------------------------------------ 剖面
let liveHold = 0;
const LIVE = {
  terrace: (sc, id, v) => sc.setTerraceHeight(id, v),
  layer: (sc, id, v) => sc.patch({ params: { layer_height_m: v } }),
  landmark: (sc, id, v) => sc.setLandmarkHeight(v),
  space_floor: (sc, id, v) => sc.updateSpace(id, { floor_y: v }),
  space_height: (sc, id, v) => sc.updateSpace(id, { height: v }),
};
const featureOf = (id) => ((S.scene.sid.terrain || {}).features || []).find((f) => f.id === id);
const setLayer = (h) => { A.bump("point"); A.edit(`每层高 ${h} m`, () => { A.applyPatch({ params: { layer_height_m: h } }); S.userSet.add("layer"); }); };
export const profileHandlers = {
  onTerraceHeight(id, h) {
    A.bump("point");
    const f = featureOf(id), lv = f ? f.level + 1 : "?";
    A.edit(h == null ? `第 ${lv} 层台地恢复规则高度` : `第 ${lv} 层台地 +${r1(Math.round(h * 2) / 2)} m`, (sc) => { sc.setTerraceHeight(id, h); });
  },
  onLayerHeight: setLayer,
  onSlope: setLayer,
  onLandmarkHeight(h) { A.bump("point"); A.edit(`地标高 ${r1(Math.max(2, Math.min(40, Math.round(h * 2) / 2)))} m`, (sc) => { sc.setLandmarkHeight(h); }); },
  onSpaceFloor(id, y) { A.bump("point"); A.edit(`${spaceName(id)}底面 ${r1(y)} m`, (sc) => { sc.updateSpace(id, { floor_y: y }); }); },
  onSpaceHeight(id, h) { A.bump("point"); A.edit(`${spaceName(id)}净高 ${r1(h)} m`, (sc) => { sc.updateSpace(id, { height: h }); }); },
  onDragHint: (t) => A.hint(t),
  /** 剖面里点一下（没拖）：选中它，剖切不动（已经切到它了） */
  onPick(t, stratum) { A.bump("point"); A.select(t, stratum, { keepSection: true }); },
  /** 拖动中只更新 3D：在场景的副本上套这个值重算（不重画剖面、不入撤销栈）；null = 放弃，重画回原样 */
  onDragLive(p) {
    if (!p) { A.renderViews(); return; }
    if (!S.inset || !A.insetShown() || performance.now() < liveHold) return;
    if (!LIVE[p.kind]) return;
    let tmp;
    try {
      tmp = S.scene.previewState((s) => LIVE[p.kind](s, p.id, p.value)); // 副本上改、只重算一次
      S.inset.update({ sid: tmp.sid, T: tmp.T, stratum: S.stratum });
    } catch (e) { console.warn(e); return; }
    S.liveMs = Math.round(tmp.ms);
    if (tmp.ms > 60) liveHold = performance.now() + 130; // 慢机器：预览放宽到约 250 ms 一次
  },
  /** 宽度滑块拖动中：只动俯视图上的带与 3D 剖切面；null = 回到当前值 */
  onSectionWidthLive(w) {
    const sec = S.scene.section(); if (w != null) sec.width_m = w;
    const band = S.mapSvg && S.mapSvg.querySelector(".sec-band"); if (band) band.setAttribute("stroke-width", sec.width_m);
    if (S.inset && A.insetShown()) S.inset.setSection(sec);
  },
  onSectionMode(m) { A.bump("choose"); A.edit(m === "line" ? "剖切改成直线" : "剖切改回沿主路", (sc) => { sc.setSection({ mode: m }); }); },
  onSectionWidth(w) { A.bump("choose"); A.edit(`剖切宽 ${w} m`, (sc) => { sc.setSection({ width_m: w }); }); },
  onSectionRotate(deg) { A.bump("choose"); A.edit(`剖切线${deg > 0 ? "逆" : "顺"}时针转 ${Math.abs(deg)}°`, (sc) => { sc.setSection(rotateSection(sc.section(), deg)); }); },
  onSectionTool() { A.setView("map"); A.setTool("section"); },
};
