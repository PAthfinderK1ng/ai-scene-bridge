// state.js — SID 文档的唯一数据源：默认值、查找、撤销/重做、选择、事件

export const DEFAULT_PALETTE = [
  { role: "ground", hex: "#B8A98A", note: "地面" },
  { role: "stone", hex: "#A0A0A0", note: "石材" },
  { role: "wall", hex: "#D9C9A3", note: "墙体" },
  { role: "roof", hex: "#7A4A33", note: "屋顶" },
  { role: "foliage", hex: "#5E7B45", note: "植被" },
  { role: "accent", hex: "#C0503A", note: "点缀" },
  { role: "water", hex: "#6F9BC2", note: "水" },
  { role: "sky", hex: "#DDE6F0", note: "天光" },
];

export const KIND_ROLE = {
  building: "wall", wall: "roof", platform: "stone", rock: "stone", prop: "stone",
  water: "water", cover: "roof", blocker: "stone", placeholder: "stone",
};
export const REGION_ROLE = {
  gathering: "stone", forest: "foliage", farmland: "ground", water: "water", grass: "foliage",
  sand: "ground", danger: "accent", encounter: "accent", safe: "stone", other: "ground",
};
export const VOLUME_KINDS = ["building", "wall", "platform", "rock", "prop", "water", "cover", "blocker", "placeholder"];
export const REGION_KINDS = ["gathering", "forest", "farmland", "water", "grass", "sand", "danger", "encounter", "safe", "other"];
export const PATH_KINDS = ["road", "trail", "river", "wall_line", "fence", "bridge", "other"];
export const MARKER_KINDS = ["player_spawn", "objective", "enemy_spawn", "light", "camera", "poi", "prop", "trigger", "other"];
export const FEATURE_KINDS = ["hill", "pit", "plateau", "cliff", "ridge"];
export const RELATION_TYPES = ["faces", "adjacent", "on_top_of", "inside", "visible_from", "connects", "blocks", "aligned_with", "far_from"];
export const IMPORTANCE = ["landmark", "primary", "secondary", "detail"];
export const TIMES = ["dawn", "morning", "noon", "afternoon", "dusk", "night", "overcast"];
/** 朝向有意义的标记种类；灯 / 道具 / 触发器等不比较朝向 */
export const ORIENTED_MARKER_KINDS = ["player_spawn", "enemy_spawn", "camera", "poi", "objective"];
export const MARKER_COLORS = {
  player_spawn: "#1F6FEB", objective: "#D4A017", enemy_spawn: "#C8362B", light: "#F2B134",
  camera: "#555555", poi: "#7B4DB8", prop: "#444444", trigger: "#2A9D8F", other: "#444444",
};

export const COLLS = ["volumes", "regions", "paths", "markers", "features"];
export const COLL_LABEL = { volumes: "体块", regions: "区域", paths: "路径", markers: "标记", features: "地形" };

const today = () => new Date().toISOString().slice(0, 10);

export function newDoc() {
  return {
    sid_version: "0.1",
    meta: {
      name: "新场景", author: "", created: today(), units: "meters", up_axis: "+Y",
      handedness: "right", north: "-Z", player_height: 1.8, grid: 0.5, description: "",
    },
    intent: { summary: "", mood: [], gameplay: "", scale_reference: "玩家 1.8 m" },
    style: {
      palette: JSON.parse(JSON.stringify(DEFAULT_PALETTE)),
      references: [],
      lighting: { time_of_day: "noon", sun_azimuth_deg: 200, sun_elevation_deg: 45 },
      material_intents: {},
    },
    bounds: { min: [-40, 0, -40], max: [40, 25, 40] },
    terrain: { base: "flat", base_height: 0, features: [] },
    volumes: [], regions: [], paths: [], markers: [],
    relations: [], constraints: [], views: [], asset_hints: {},
  };
}

/** 补齐旧文件缺的字段，保证编辑器不崩 */
export function normalizeDoc(doc) {
  const d = Object.assign(newDoc(), doc);
  d.meta = Object.assign(newDoc().meta, doc.meta || {});
  d.intent = Object.assign(newDoc().intent, doc.intent || {});
  d.style = Object.assign(newDoc().style, doc.style || {});
  if (!Array.isArray(d.style.palette) || !d.style.palette.length) d.style.palette = JSON.parse(JSON.stringify(DEFAULT_PALETTE));
  d.style.lighting = Object.assign(newDoc().style.lighting, d.style.lighting || {});
  d.terrain = Object.assign({ base: "flat", base_height: 0, features: [] }, doc.terrain || {});
  if (!Array.isArray(d.terrain.features)) d.terrain.features = [];
  for (const k of ["volumes", "regions", "paths", "markers", "relations", "constraints", "views"]) if (!Array.isArray(d[k])) d[k] = [];
  if (!d.asset_hints || typeof d.asset_hints !== "object") d.asset_hints = {};
  if (!d.bounds || !d.bounds.min || !d.bounds.max) d.bounds = { min: [-40, 0, -40], max: [40, 25, 40] };
  for (const v of d.volumes) { v.rotation_y = v.rotation_y || 0; v.shape = v.shape || "box"; }
  // markers 不强行补 rotation_y：灯 / 道具没有朝向，补 0 会让评分脚本去比它的朝向
  const L = d.style.lighting;
  if (!Number.isFinite(L.sun_azimuth_deg)) L.sun_azimuth_deg = 200;
  if (!Number.isFinite(L.sun_elevation_deg)) L.sun_elevation_deg = 45;
  return d;
}

export function collArray(doc, coll) {
  return coll === "features" ? doc.terrain.features : doc[coll];
}

export function find(doc, id) {
  for (const coll of COLLS) {
    const arr = collArray(doc, coll);
    const obj = arr.find((o) => o.id === id);
    if (obj) return { coll, obj };
  }
  return null;
}

export function allObjects(doc) {
  const out = [];
  for (const coll of COLLS) for (const obj of collArray(doc, coll)) out.push({ coll, obj });
  return out;
}

export function slug(s, fallback = "obj") {
  const t = String(s || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]/, "o$&");
  return t || fallback;
}

export function uniqueId(doc, base) {
  const b = slug(base);
  if (!find(doc, b) && !/_\d+$/.test(b)) return b;
  const stem = b.replace(/_\d+$/, "");
  let i = 1;
  while (find(doc, `${stem}_${i}`)) i++;
  return `${stem}_${i}`;
}

export function renameId(doc, oldId, newId) {
  if (oldId === newId) return;
  for (const r of doc.relations) { if (r.a === oldId) r.a = newId; if (r.b === oldId) r.b = newId; }
  for (const c of doc.constraints) {
    if (Array.isArray(c.targets)) c.targets = c.targets.map((t) => (t === oldId ? newId : t));
    if (c.from === oldId) c.from = newId;
  }
  if (doc.asset_hints[oldId]) { doc.asset_hints[newId] = doc.asset_hints[oldId]; delete doc.asset_hints[oldId]; }
  for (const ref of doc.style.references || []) if (Array.isArray(ref.applies_to)) ref.applies_to = ref.applies_to.map((t) => (t === oldId ? newId : t));
}

export function removeById(doc, id) {
  for (const coll of COLLS) {
    const arr = collArray(doc, coll);
    const i = arr.findIndex((o) => o.id === id);
    if (i >= 0) arr.splice(i, 1);
  }
  doc.relations = doc.relations.filter((r) => r.a !== id && r.b !== id);
  for (const c of doc.constraints) if (Array.isArray(c.targets)) c.targets = c.targets.filter((t) => t !== id);
  doc.constraints = doc.constraints.filter((c) => c.from !== id && (!Array.isArray(c.targets) || c.targets.length || c.type === "keep_inside"));
  delete doc.asset_hints[id];
}

export function paletteMap(doc) {
  const m = {};
  for (const p of DEFAULT_PALETTE) m[p.role] = p.hex;
  for (const p of doc.style?.palette || []) if (p.role && p.hex) m[p.role] = p.hex;
  return m;
}

export function colorFor(doc, obj, coll) {
  const pal = paletteMap(doc);
  if (coll === "volumes") return pal[obj.color_role] || pal[KIND_ROLE[obj.kind] || "stone"] || "#A0A0A0";
  if (coll === "regions") return pal[obj.surface] || pal[REGION_ROLE[obj.kind] || "ground"] || "#B8A98A";
  if (coll === "paths") return pal[obj.surface] || pal.ground || "#B8A98A";
  if (coll === "markers") return MARKER_COLORS[obj.kind] || "#444444";
  if (coll === "features") return "#9DAA7A";
  return "#A0A0A0";
}

export const snap = (v, g = 0.5) => Math.round(v / g) * g;
export const r2 = (v) => Math.round(v * 100) / 100;
export const normDeg = (d) => ((Math.round(d) % 360) + 360) % 360;

export function centroid2(pts) {
  const n = pts.length || 1;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

export class Store {
  constructor() {
    this.doc = newDoc();
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.listeners = { doc: [], selection: [], status: [] };
  }
  on(evt, fn) { this.listeners[evt].push(fn); }
  emit(evt, payload) { for (const fn of this.listeners[evt]) fn(payload); }
  status(msg) { this.emit("status", msg); }
  snapshot() { return JSON.stringify(this.doc); }

  setDoc(doc) {
    this.doc = normalizeDoc(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.emit("doc");
    this.emit("selection", null);
  }

  /** 所有修改都走这里：fn(doc) 就地改；真有变化才进撤销栈；无论如何都广播（视口要重建吸回原值）。返回是否有变化 */
  mutate(fn, label = "") {
    const before = this.snapshot();
    fn(this.doc);
    const changed = this.snapshot() !== before;
    if (changed) {
      this.undoStack.push(before);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    if (this.selection && !find(this.doc, this.selection)) this.selection = null;
    this.emit("doc");
    this.emit("selection", this.selection);
    if (label && changed) this.status(label);
    return changed;
  }

  undo() {
    if (!this.undoStack.length) return this.status("没有可撤销的操作");
    this.redoStack.push(this.snapshot());
    this.doc = JSON.parse(this.undoStack.pop());
    if (this.selection && !find(this.doc, this.selection)) this.selection = null;
    this.emit("doc");
    this.emit("selection", this.selection);
    this.status("已撤销");
  }

  redo() {
    if (!this.redoStack.length) return this.status("没有可重做的操作");
    this.undoStack.push(this.snapshot());
    this.doc = JSON.parse(this.redoStack.pop());
    if (this.selection && !find(this.doc, this.selection)) this.selection = null;
    this.emit("doc");
    this.emit("selection", this.selection);
    this.status("已重做");
  }

  select(id) {
    this.selection = id && find(this.doc, id) ? id : null;
    this.emit("selection", this.selection);
  }
}
