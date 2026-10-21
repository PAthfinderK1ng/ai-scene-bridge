// plan.js — 场景程序（plan v2，docs/06）的工具与编译入口。
// AI 写一段场景程序：形体组成组、组可以嵌套和重复、相对彼此定位（锚点），地形用雕刻操作组合；局部尺寸与偏移可以写，全局摆放交给引擎。
// 这里：按 spec/plan.schema.json 规范化（丢未知 / 坐标字段、夹数值、补 id 与默认值、引用降级、断环、展开计数 ≤ 600）、
// 编译（program.js 解释 → sid.resolve 布房 / 检查 → 程序检查 + 关系检查 → 索引与事实）、ops（set / add / remove 作用在程序树上）、
// 旋钮（从 schema 的 x-ui 生成）、拖动反算偏移、三张卡的结构差异。确定性：同 plan + seed → 同结果。本文件不调 AI。
//
// 对外：PLAN_SCHEMA / PLAN_GROUPS / DIRV、normalizePlan、compilePlan、applyOps、resolveTarget、atFromPoint、offsetFromPoint、expand、
//       knobsFor、summarize、newElement、planDistance、distinctPlans、findNode；程序检查 programChecks / nodeLabel / findNodeIn（v5 第 1 轮从 program.js 挪来，program.js 超过 1200 行）；
//       v6（docs/07）：标记 addMark / updateMark / removeMark、手调高度 heightEdit、worldToSite / siteToWorld；引用事实 describeRef 与改动摘要 diffCompiled（在 relations.js，这里转出）。

import { clamp, r2 } from "./terrain.js";
import { resolve } from "./sid.js";
import { planGeo, relationChecks, planReach, describeRef, diffCompiled } from "./relations.js";
import { runProgram, walkNodes, NODE_CLASS, parseAnchor, size3, apM, invM, linkRepeat, DIRV as DIRV0 } from "./program.js";

// ------------------------------------------------------------ schema（单一事实来源：spec/plan.schema.json）
/** plan 的 JSON Schema（含 x-ui / x-groups / x-defaults / x-node-classes / x-size）。模块加载时从 spec/ 读一次。 */
export const PLAN_SCHEMA = await fetch(new URL("../../spec/plan.schema.json", import.meta.url)).then((r) => {
  if (!r.ok) throw new Error(`读不到 spec/plan.schema.json（HTTP ${r.status}）`);
  return r.json();
});
const DEFS = PLAN_SCHEMA.definitions, XD = PLAN_SCHEMA["x-defaults"];
/** 右栏分组：[{ key, label, def, min, max, type_field, tree? }]（外观组 key = "look"，def = null） */
export const PLAN_GROUPS = PLAN_SCHEMA["x-groups"];
/** 方向 → 单位向量 [x, z]（北 = −z） */
export const DIRV = DIRV0;
const MAX_SHAPES = 600, MAX_TERRAIN = PLAN_SCHEMA.properties.terrain.maxItems || 24, MAX_MARKS = PLAN_SCHEMA.properties.marks.maxItems || 32;
const RESERVED = new Set(["site", "spawn", "plan", "lighting", "root", "terrain", "relations", "look", "main_trail", "landmark_poi", "entry"]);
const COORD_KEYS = new Set(["position", "pos", "x", "y", "z", "xz", "points", "coords", "coordinates", "polygon", "center", "centre", "location", "world"]);
const DIR_LABEL = { C: "中", N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" };
const SUFFIX_LABEL = { top: "顶上", bottom: "底下", center: "中间", inner: "里面", outer: "外面", start: "起点", mid: "中段", end: "终点", left: "左岸", right: "右岸" };

// ------------------------------------------------------------ 小工具
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const r1 = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ schema 驱动的清洗
/** 解开 $ref，合并 x-ui（引用处的 x-ui 覆盖定义处的） */
function deref(s, schema = PLAN_SCHEMA) {
  let out = s, ui = s && s["x-ui"];
  const defs = schema.definitions;
  while (out && out.$ref) { const t = defs[out.$ref.split("/").pop()]; ui = Object.assign({}, (t && t["x-ui"]) || {}, ui || {}); out = t; }
  return ui ? Object.assign({}, out, { "x-ui": ui }) : out;
}
function sanitizeId(v) {
  const s = String(v).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "");
  return s.slice(0, 32) || null;
}
/** 按 schema 清洗一个值：丢未知字段（坐标字段报一句）、夹数值、校枚举、修 id。不合法返回 undefined。 */
function clean(v, sch, warn, path) {
  const s = deref(sch);
  if (v === undefined || v === null || !s) return undefined;
  if (s.oneOf) {
    for (const alt of s.oneOf) { const a = deref(alt), r = clean(v, a, () => {}, path); if (r !== undefined && (Array.isArray(r) === (a.type === "array"))) return r; }
    warn(`「${path}」的值不合法，已忽略`); return undefined;
  }
  if (s.const !== undefined) return v === s.const ? v : undefined;
  const type = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (type.includes("object") || s.properties) {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      if (!s.properties || !(k in s.properties)) {
        if (s.additionalProperties === false) { if (COORD_KEYS.has(k)) warn(`「${p}」是全局坐标，已丢掉（位置只用锚点 + 局部偏移）`); continue; }
        out[k] = clone(v[k]); continue;
      }
      const r = clean(v[k], s.properties[k], warn, p);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  if (type.includes("array")) {
    if (!Array.isArray(v)) return undefined;
    let arr = v.map((x, i) => clean(x, s.items || {}, warn, `${path}[${i}]`)).filter((x) => x !== undefined);
    if (s.maxItems != null && arr.length > s.maxItems) { if (s.maxItems !== s.minItems) warn(`「${path}」最多 ${s.maxItems} 项，多的去掉了`); arr = arr.slice(0, s.maxItems); }
    if (s.minItems != null && arr.length < s.minItems && (s.minItems === s.maxItems || (s.items && deref(s.items).type === "number"))) return undefined;
    return arr;
  }
  if (type.includes("number") || type.includes("integer")) {
    if (typeof v === "boolean") return undefined;
    let n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (!type.includes("number")) n = Math.round(n);
    if (s.minimum != null) n = Math.max(s.minimum, n);
    if (s.maximum != null) n = Math.min(s.maximum, n);
    return n;
  }
  if (type.includes("boolean")) return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
  if (type.includes("string")) {
    if (typeof v !== "string" && typeof v !== "number") return undefined;
    let str = String(v).trim();
    if (s.enum && !s.enum.includes(str)) {
      const alt = [str.toLowerCase(), str.toUpperCase()].find((x) => s.enum.includes(x));
      if (alt) str = alt; else { warn(`「${path}」的「${str}」不认识，用默认`); return undefined; }
    }
    if (s.pattern && s.pattern.startsWith("^[a-z][a-z0-9_]{0,31}$")) str = sanitizeId(str) || "";
    else if (s.pattern && s.pattern.startsWith("^[a-z][a-z0-9_]{0,31}(\\[")) {
      // 引用 / 锚点：基准名转小写，方位后缀转大写（Hall.s → hall.S）
      const m = /^([^.[]+)(\[\d+\])?(?:\.(\w+))?$/.exec(str);
      if (m) { const suf = m[3] ? (/^(c|n|ne|e|se|s|sw|w|nw)$/i.test(m[3]) ? m[3].toUpperCase() : m[3].toLowerCase()) : null; str = (sanitizeId(m[1]) || m[1]) + (m[2] || "") + (suf ? "." + suf : ""); }
    }
    if (s.maxLength) str = str.slice(0, s.maxLength);
    if (s.minLength && str.length < s.minLength) return undefined;
    if (s.pattern && !new RegExp(s.pattern).test(str)) { warn(`「${path}」的「${str}」格式不对，已忽略`); return undefined; }
    return str;
  }
  if (!type.length) return clone(v);
  return undefined;
}
function fillDefaults(el, d) {
  if (!isObj(d)) return el;
  for (const k of Object.keys(d)) {
    if (el[k] === undefined) el[k] = clone(d[k]);
    else if (isObj(el[k]) && isObj(d[k])) fillDefaults(el[k], d[k]);
  }
  return el;
}

// ------------------------------------------------------------ v4 → v2（旧的构成图也能编译）
const isV4 = (p) => isObj(p) && !Array.isArray(p.nodes) && (["landmarks", "zones", "buildings", "paths", "water", "spaces"].some((k) => Array.isArray(p[k])) || (Array.isArray(p.terrain) && p.terrain.some((t) => isObj(t) && t.type && !t.op)));
function migrateV4(p, warn) {
  warn("这是旧版（v4）构成图，已按 v2 场景程序改写");
  const S = Number(p.site && p.site.size_m) || 140, layer = (p.site && p.site.layer_m) || 3;
  const at4 = (a) => { if (!isObj(a)) return "site.C"; const of = a.of && a.of !== "site" ? a.of : "site", dir = a.dir || "C"; return dir === "C" ? (of === "site" ? "site.C" : of) : `${of}.${dir}`; };
  const out = { name: p.name, concept: p.one_liner || p.concept, site: { size_m: [S, S], ground: "flat", layer_m: layer }, terrain: [], nodes: [], relations: [], palette: p.palette, lighting: p.lighting, mood: p.mood };
  const sz2 = (t, d) => (Array.isArray(t.size_m) ? t.size_m.slice(0, 2) : d);
  for (const t of p.terrain || []) {
    if (!isObj(t)) continue;
    const base = { id: t.id, label: t.label, at: at4(t.at) };
    if (t.type === "slope_terraces" || t.type === "ring_terraces") out.nodes.push(Object.assign(base, { type: "terraces", form: t.type === "ring_terraces" ? "ring" : "slope", size_m: sz2(t, [80, 80]), steps: t.steps || 4, orient: t.orient, inverse: t.inverse, width_m: t.width_m }));
    else if (t.type === "hill" || t.type === "ridge") out.terrain.push(Object.assign(base, { op: "raise", shape: "ellipse", size_m: sz2(t, [100, 90]), height_m: (t.top_layer || 4) * layer, edge: "round" }));
    else if (t.type === "cliff") out.terrain.push(Object.assign(base, { op: "cliff", shape: "rect", size_m: sz2(t, [50, 8]), height_m: (t.layer ?? 4) * layer }));
    else if (["valley", "basin", "pit"].includes(t.type)) out.terrain.push(Object.assign(base, { op: "lower", shape: t.type === "valley" ? "rect" : "ellipse", size_m: sz2(t, [60, 50]), depth_m: (t.depth_layers || 1) * layer }));
    else out.terrain.push(Object.assign(base, { op: "raise", shape: "rect", size_m: sz2(t, [30, 30]), height_m: (t.layer ?? 2) * layer, edge: "slope" }));
  }
  const bmap = new Map((p.buildings || []).filter(isObj).map((b) => [b.id, b]));
  for (const z of p.zones || []) {
    if (!isObj(z)) continue;
    const type = z.use === "forest" ? "grove" : z.use === "farm" || z.use === "terrace_farm" || z.use === "plaza" ? "field" : "scatter_houses";
    const n = { id: z.id, type, label: z.label, area: z.on || "site", density: z.density };
    const b = bmap.get(z.building);
    if (type === "scatter_houses" && b) n.child = { type: b.form === "tower" ? "tower" : "building", size_m: b.size_m, roof: b.roof === "round" ? "dome" : b.roof, label: b.label };
    out.nodes.push(n);
  }
  const FORM = { tower: "tower", gate: "gate", tree: "tree", statue: "statue", wall: "wall", well: "cylinder" };
  for (const l of p.landmarks || []) {
    if (!isObj(l)) continue;
    const pl = l.place || {}, tg = Array.isArray(pl.target) ? pl.target[0] : pl.target || "site";
    const at = pl.rel === "top_of" ? `${tg}.top` : pl.rel === "edge_of" ? `${tg}.${pl.side && pl.side !== "C" ? pl.side : "S"}` : pl.rel === "beside" || pl.rel === "behind" ? `${tg}.${pl.side && pl.side !== "C" ? pl.side : "E"}` : tg === "site" ? "site.C" : tg;
    const type = FORM[l.form] || "building";
    const n = { id: l.id, type, label: l.label, role: "landmark", at, size_m: type === "tower" ? [l.size_m ? l.size_m[0] : 7, l.size_m ? l.size_m[1] : 14] : l.size_m };
    if (type === "building" || type === "tower") Object.assign(n, { roof: l.roof === "round" ? "dome" : l.roof === "pyramid" ? "spire" : l.roof, floors: l.floors });
    if (l.form === "round_house") n.shape = "cylinder";
    out.nodes.push(n);
  }
  const STY = { winding: "path", stairs: "stairs", zigzag: "path", straight: "road", bridge: "bridge", tunnel: "tunnel" };
  for (const w of p.water || []) {
    if (!isObj(w)) continue;
    if (w.type === "pond") out.terrain.push({ id: w.id, op: "lake", label: w.label, at: at4(w.at), size_m: w.size_m || [18, 14], depth_m: 2 });
    else out.terrain.push({ id: w.id, op: "river", label: w.label, from: at4(w.from), to: at4(w.to), width_m: w.width_m || 4, depth_m: 2 });
  }
  for (const q of p.paths || []) if (isObj(q)) out.nodes.push({ id: q.id, type: "link", label: q.label, style: STY[q.style] || "path", from: q.from || "spawn", to: q.to, via: q.via, width_m: q.width_m });
  for (const s of p.spaces || []) if (isObj(s)) out.nodes.push({ id: s.id, type: "space", label: s.label, stratum: s.stratum, under: s.under, over: s.over, layout: s.layout, size_m: s.size_m, branching: s.branching, sublevels: s.sublevels, corridor_m: s.corridor_m, height_m: s.height_m, rooms: s.rooms, links: s.links, connect: s.connect, depth_m: (s.depth_layers || 2) * layer, layout_seed: s.layout_seed });
  const sp = p.spawn || {}, spl = sp.place || {};
  out.spawn = { at: spl.target && spl.target !== "site" ? spl.target : `site.${spl.side && spl.side !== "C" ? spl.side : "S"}`, look_at: sp.look_at, label: sp.label };
  out.relations = (p.relations || []).filter((r) => isObj(r) && ["visible_from", "adjacent", "above", "below", "behind", "between", "far_from", "faces"].includes(r.type));
  return out;
}

// ------------------------------------------------------------ 展开（不编译，只数）
/** 一个 repeat 的实例个数（扣掉 skip；along 按 count，没写 count 时按 8 估） */
function instanceCount(n) {
  const p = n.pattern || "linear", skip = new Set(n.skip || []);
  const total = p === "grid" ? (n.rows || 2) * (n.cols || 2) : p === "mirror" ? 2 : p === "stack" ? n.levels || 3 : n.count || (p === "along" ? 8 : p === "scatter" ? 8 : 1);
  let c = 0; for (let k = 0; k < total; k++) if (!skip.has(k)) c++;
  return c;
}
/**
 * 把场景树展开成实例列表（给界面数节点、给规范化做 600 上限）。不编译、不算坐标。
 * @param {object} plan
 * @returns {{id: string, node_id: string, type: string, cls: string, label: string, depth: number, path: string[], instance_of: string|null, k: number|null}[]}
 */
export function expand(plan) {
  const out = [];
  const visit = (n, depth, path, inst, prefix) => {
    if (!isObj(n)) return;
    const cls = NODE_CLASS(n.type), id = prefix ? `${prefix}/${n.id}` : n.id;
    out.push({ id, node_id: n.id, type: n.type, cls, label: n.label || n.id, depth, path: path.slice(), instance_of: inst ? inst.rep : null, k: inst ? inst.k : null });
    for (const ch of n.children || []) visit(ch, depth + 1, path.concat(id), inst, prefix);
    if (n.type === "repeat" && isObj(n.child)) {
      const p = n.pattern || "linear", skip = new Set(n.skip || []);
      const total = p === "grid" ? (n.rows || 2) * (n.cols || 2) : p === "mirror" ? 2 : p === "stack" ? n.levels || 3 : n.count || 8;
      for (let k = 0; k < total; k++) if (!skip.has(k)) {
        const iid = `${id}[${k}]`, t = Object.assign({}, n.child, (isObj(n.overrides) && n.overrides[String(k)]) || {});
        out.push({ id: iid, node_id: t.id || `${n.id}_c`, type: t.type, cls: NODE_CLASS(t.type), label: t.label || t.id || n.id, depth: depth + 1, path: path.concat(id), instance_of: id, k });
        for (const ch of t.children || []) visit(ch, depth + 2, path.concat(id, iid), { rep: id, k }, iid);
        if (t.type === "repeat") visit(Object.assign({}, t, { id: `${iid}_r` }), depth + 2, path.concat(id, iid), { rep: id, k }, null);
      }
    }
  };
  for (const n of (plan && plan.nodes) || []) visit(n, 0, [], null, null);
  return out;
}
/** 形体个数（院算 5 块、沿折线的墙按段数，其余 1） */
function shapeCount(plan) {
  let c = 0;
  for (const e of expand(plan)) if (e.cls === "solid" && e.type !== "water") c += e.type === "courtyard" ? 5 : 1;
  return c;
}

// ------------------------------------------------------------ normalizePlan
// ------------------------------------------------------------ 锚点写法规范化（模型 / 后端常写 site.center、hall.north、towers[2].s）
const DIR_WORDS = { n: "N", s: "S", e: "E", w: "W", ne: "NE", nw: "NW", se: "SE", sw: "SW", north: "N", south: "S", east: "E", west: "W", northeast: "NE", northwest: "NW", southeast: "SE", southwest: "SW" };
const SITE_CENTER = new Set(["c", "center", "centre", "middle", "mid", "top"]);
const PART_WORDS = new Set(["top", "bottom", "center", "inner", "outer", "start", "mid", "end", "left", "right"]);
/** 一个锚点 / 引用的规范写法：site.center → site.C、x.north / x.n → x.N、x.Top → x.top；认不出原样返回 */
export function canonRef(s) {
  if (typeof s !== "string") return s;
  const t = s.trim(), m = /^([A-Za-z][A-Za-z0-9_]*)(\[\d+\])?(?:\.([A-Za-z]+))?$/.exec(t);
  if (!m) return t;
  const base = m[1].toLowerCase(), k = m[2] || "", raw = m[3], low = raw ? raw.toLowerCase() : null;
  if (!raw) return base + k;
  if (base === "site" && !k) return SITE_CENTER.has(low) ? "site.C" : DIR_WORDS[low] ? `site.${DIR_WORDS[low]}` : `site.${raw}`;
  if (low === "c") return `${base}${k}.center`;
  if (DIR_WORDS[low]) return `${base}${k}.${DIR_WORDS[low]}`;
  return `${base}${k}.${PART_WORDS.has(low) ? low : raw}`;
}
/** 整份 plan 里所有引用字段过一遍 canonRef（返回新对象，不改入参） */
function canonRefs(src) {
  const p = JSON.parse(JSON.stringify(src));
  const fix = (o, keys) => { if (!isObj(o)) return; for (const k of keys) if (typeof o[k] === "string") o[k] = canonRef(o[k]); };
  const NODE_REFS = ["at", "from", "to", "area", "along", "around", "under", "over"];
  const walk = (n) => {
    if (!isObj(n)) return;
    fix(n, NODE_REFS);
    if (Array.isArray(n.via)) n.via = n.via.map(canonRef);
    fix(n.connect, ["from"]);
    if (Array.isArray(n.children)) n.children.forEach(walk);
    walk(n.child);
  };
  if (Array.isArray(p.terrain)) p.terrain.forEach((t) => fix(t, ["at", "from", "to", "area", "along"]));
  if (Array.isArray(p.nodes)) p.nodes.forEach(walk);
  fix(p.spawn, ["at", "look_at"]);
  if (Array.isArray(p.relations)) p.relations.forEach((r) => fix(r, ["a", "b", "c"]));
  return p;
}

/**
 * 规范化 plan v2：按 schema 丢未知 / 坐标字段、夹数值、校枚举；旧版 v4 先改写；补 id（全树唯一、非保留字）与按 type / op 的默认值；
 * size_m 统一成数组；引用（锚点 / 连接两端 / area / along / around / look_at / 关系）不存在的降级并提一句；锚点依赖成环时断开；
 * 地形操作只能锚到场地与前面的地形操作；展开后形体 > 600 时按比例缩小最大的重复。不改入参。
 * @param {object} input AI 或界面给的 plan
 * @returns {{plan: object, warnings: string[]}}
 */
export function normalizePlan(input) {
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  let src = isObj(input) ? input : {};
  if (isV4(src)) src = migrateV4(src, warn);
  src = canonRefs(src);
  const plan = clean(src, PLAN_SCHEMA, warn, "") || {};
  plan.name = plan.name || "未命名场景";
  if (!plan.concept && plan.one_liner) plan.concept = plan.one_liner;
  delete plan.one_liner;
  // 场地
  const site = plan.site || {};
  const sz = site.size_m;
  site.size_m = Array.isArray(sz) ? [sz[0], sz[1] ?? sz[0]] : Number.isFinite(sz) ? [sz, sz] : [160, 160];
  site.ground = site.ground || "flat";
  site.layer_m = site.layer_m || 3;
  // 人定的层表（docs/07 §7）：按高度升序、0.05 m 内去重、最多 24 层；0 层高度不是数就去掉
  if (Array.isArray(site.layers)) {
    const ls = site.layers.filter((l) => isObj(l) && Number.isFinite(Number(l.height_m))).map((l) => Object.assign({ height_m: r2(clamp(Number(l.height_m), -200, 400)) }, l.label ? { label: String(l.label).slice(0, 16) } : {})).sort((a, b) => a.height_m - b.height_m);
    site.layers = ls.filter((l, i) => !i || l.height_m - ls[i - 1].height_m > 0.05).slice(0, 24);
    if (!site.layers.length) delete site.layers;
  } else delete site.layers;
  if (site.layer_zero_m != null && !Number.isFinite(Number(site.layer_zero_m))) delete site.layer_zero_m;
  plan.site = site;
  plan.marks = cleanMarks(plan.marks, site, warn);
  if (!plan.marks.length) delete plan.marks;
  plan.terrain = Array.isArray(plan.terrain) ? plan.terrain.filter(isObj).slice(0, MAX_TERRAIN) : [];
  plan.nodes = Array.isArray(plan.nodes) ? plan.nodes.filter(isObj) : [];
  plan.relations = Array.isArray(plan.relations) ? plan.relations.filter((r) => isObj(r) && r.type && r.a && r.b) : [];
  if (!plan.nodes.length) warn("场景里还没有任何节点");

  // id：全树唯一（地形操作与节点同一命名空间）
  const used = new Set(RESERVED);
  const claim = (want, base) => {
    let id = want && !used.has(want) ? want : null;
    if (!id) { const b = sanitizeId(base || want || "node") || "node"; id = b; for (let k = 2; used.has(id); k++) id = `${b}_${k}`; if (want && want !== id) warn(`id「${want}」重复，改成「${id}」`); }
    used.add(id);
    return id;
  };
  // 标记先占 id（人给的优先）：没写 id 的按 mark_N 编号
  const markType = new Map();
  for (const m of plan.marks || []) { if (!m.id || used.has(m.id)) { let k = 1; while (used.has(`mark_${k}`)) k++; m.id = `mark_${k}`; } used.add(m.id); markType.set(m.id, m.type); }
  for (const t of plan.terrain) { if (!t.op) t.op = "raise"; t.id = claim(t.id, t.op); fillDefaults(t, (XD.terrain || {})[t.op]); }
  const fixNode = (n, parent) => {
    if (!n.type) { n.type = n.children ? "group" : "box"; warn(`「${n.label || n.id || "节点"}」没写类型，按 ${n.type} 处理`); }
    n.id = claim(n.id, n.type === "repeat" && parent && parent.type === "repeat" ? `${parent.id}_c` : n.type);
    const dfl = (XD.nodes || {})[n.type];
    fillDefaults(n, isObj(dfl) && (n.type === "repeat" || n.type === "group") ? Object.fromEntries(Object.entries(dfl).filter(([k]) => k !== "label")) : dfl); // 组 / 重复不补「组」「重复」这种空名字（检查文案用模板名）
    if (n.type === "repeat") {
      if (!isObj(n.child)) { n.child = { type: "box", size_m: [4, 4, 4] }; warn(`「${n.label || n.id}」没有模板（child），补了一个方块`); }
      if (!n.child.id) n.child.id = `${n.id}_c`;
    }
    if (n.type === "scatter_houses" && isObj(n.child) && !n.child.type) n.child.type = "building";
    if (Array.isArray(n.children) && !n.children.length) delete n.children;
    if (n.children && NODE_CLASS(n.type) !== "solid" && n.type !== "group") { warn(`「${n.label || n.id}」（${n.type}）不能有子节点，去掉了`); delete n.children; }
  };
  const walkFix = (arr, parent) => { for (const n of arr) { fixNode(n, parent); if (n.children) walkFix(n.children, n); if (n.type === "repeat" && isObj(n.child)) walkFix([n.child], n); } };
  walkFix(plan.nodes, null);
  // 模板里的 id 在实例里各自一份：模板外不能直接引用它们
  const global = new Map(), tplIds = new Set(), parentOf = new Map();
  walkNodes(plan.nodes, (n, p, inT) => { if (inT) tplIds.add(n.id); else { global.set(n.id, n); if (p) parentOf.set(n.id, p.id); } });
  const terrainIds = new Set(plan.terrain.map((t) => t.id)), terrainIdx = new Map(plan.terrain.map((t, i) => [t.id, i]));
  // 基础形态自带的水面也能当锚点 / 范围：lake（ground = lake）、sea（ground = island / coast）
  const implicit = site.ground === "lake" ? "lake" : site.ground === "island" || site.ground === "coast" ? "sea" : null;
  if (implicit && !global.has(implicit) && !terrainIds.has(implicit)) { terrainIds.add(implicit); terrainIdx.set(implicit, -1); }
  const exists = (ref, { spawn = true, terrain = true, tpl = false, marks = true } = {}) => {
    const A = parseAnchor(ref);
    if (!A) return false;
    if (A.base === "site") return !A.suffix || ["C", "N", "NE", "E", "SE", "S", "SW", "W", "NW"].includes(A.suffix);
    if (A.base === "spawn") return spawn;
    if (markType.has(A.base)) return marks && A.k === null;
    if (terrain && terrainIds.has(A.base)) return A.k === null;
    if (global.has(A.base)) return A.k === null || global.get(A.base).type === "repeat";
    return tpl && tplIds.has(A.base);
  };
  const who = (n) => `「${n.label || n.id}」`;
  // 地形操作：只能锚到场地、前面的地形操作与标记；area 只认圈选、along 只认手绘线
  plan.terrain.forEach((t, i) => {
    for (const k of ["at", "from", "to"]) {
      if (t[k] === undefined) continue;
      const A = parseAnchor(t[k]);
      const ok = A && (A.base === "site" ? exists(t[k]) : markType.has(A.base) ? A.k === null : terrainIdx.has(A.base) && terrainIdx.get(A.base) < i);
      if (!ok) { warn(`地形${who(t)}的 ${k}「${t[k]}」只能是场地、前面的地形操作或标记，改到场地${k === "at" ? "中心" : ""}`); if (k === "at") t.at = "site.C"; else delete t[k]; }
    }
    for (const [k, ty, nm] of [["area", "area", "圈选"], ["along", "trace", "手绘线"]]) if (t[k] !== undefined && markType.get(t[k]) !== ty) { warn(`地形${who(t)}的 ${k}「${t[k]}」不是${nm}标记，去掉了`); delete t[k]; }
    if (!t.at) t.at = "site.C";
  });
  // 节点引用
  const fixRef = (n, k, opts, fallback) => {
    if (n[k] === undefined) return true;
    if (exists(n[k], opts)) return true;
    warn(`${who(n)}的 ${k}「${n[k]}」不存在，${fallback === undefined ? "去掉了" : `改成 ${fallback}`}`);
    if (fallback === undefined) delete n[k]; else n[k] = fallback;
    return false;
  };
  const dropLinks = new Set();
  walkNodes(plan.nodes, (n, p, inT) => {
    const cls = NODE_CLASS(n.type);
    fixRef(n, "at", { tpl: inT }, p ? undefined : "site.C");
    const free = n.type === "repeat" && (n.pattern === "scatter" || n.pattern === "along"); // 散布按范围、沿路按连接，不需要锚点
    if (!p && !inT && !n.at && !free && !linkRepeat(n) && (cls === "solid" || cls === "group" || cls === "repeat")) { n.at = "site.C"; warn(`根节点${who(n)}没写锚点，放在场地中心`); }
    if (cls === "link") {
      if (inT) { // 一组连接的模板：from / to / via 可以写重复的 id、"x[k]"（第 k 个实例）、"center"（重复的中心）；认不出的去掉（引擎按缺省连：中心 → 实例）
        const okT = (v) => typeof v === "string" && (/^(center|centre|middle|中心|环心)$/.test(v) || exists(v.replace(/\[(k|i|n|\*|)\]/, "")));
        for (const k of ["from", "to"]) if (n[k] !== undefined && !okT(n[k])) { warn(`连接${who(n)}的 ${k}「${n[k]}」不存在，去掉了（按缺省：从重复中心连到每个实例）`); delete n[k]; }
        if (Array.isArray(n.via)) n.via = n.via.filter(okT);
        return;
      }
      const byTrace = n.along && markType.get(n.along) === "trace"; // 顺着人画的一笔：from / to 可省
      for (const k of ["from", "to"]) if (byTrace ? n[k] !== undefined && !exists(n[k]) : !n[k] || !exists(n[k])) { if (byTrace) { warn(`连接${who(n)}的 ${k}「${n[k]}」不存在，去掉了（照样顺着手绘线走）`); delete n[k]; } else { warn(`连接${who(n)}的 ${k}「${n[k] || ""}」不存在，这条连接去掉了`); dropLinks.add(n.id); } }
      if (Array.isArray(n.via)) n.via = n.via.filter((v) => exists(v) || (warn(`连接${who(n)}经过的「${v}」不存在，跳过`), false));
    }
    for (const k of ["area", "along", "around", "under", "over"]) fixRef(n, k, { spawn: false });
    if (n.along && markType.get(n.along) !== "trace" && (n.type === "link" || (global.get(parseAnchor(n.along).base) || {}).type !== "link")) { warn(`${who(n)}沿的「${n.along}」不是${n.type === "link" ? "手绘线" : "连接或手绘线"}，去掉了`); delete n.along; }
    if (isObj(n.connect) && n.connect.from !== undefined && !exists(n.connect.from)) { warn(`${who(n)}的连接起点「${n.connect.from}」不存在，去掉了`); delete n.connect.from; }
  });
  if (dropLinks.size) { const strip = (arr) => arr.filter((n) => !dropLinks.has(n.id)).map((n) => { if (n.children) n.children = strip(n.children); return n; }); plan.nodes = strip(plan.nodes); for (const id of dropLinks) global.delete(id); }
  // 锚点依赖成环：frame(X) → done(锚点目标)，done(X) → frame(X) 与 done(子节点)，frame(子) → frame(父)；回边处断开（锚点改到父组原点 / 场地中心）
  breakCycles(plan, global, parentOf, warn);
  // 出生点
  plan.spawn = isObj(plan.spawn) ? plan.spawn : {};
  if (!plan.spawn.at) plan.spawn.at = "site.S";
  else if (!exists(plan.spawn.at, { spawn: false })) { warn(`出生点的锚点「${plan.spawn.at}」不存在，改到场地南边`); plan.spawn.at = "site.S"; }
  if (plan.spawn.look_at && !exists(plan.spawn.look_at, { spawn: false, marks: false })) { warn(`出生点要看的「${plan.spawn.look_at}」不存在，去掉了`); delete plan.spawn.look_at; }
  // 关系
  plan.relations = plan.relations.filter((r) => {
    for (const k of ["a", "b", "c"]) if (r[k] !== undefined && !exists(r[k], { marks: false })) { warn(`关系「${r.type}」引用的「${r[k]}」不存在，这条关系去掉了`); return false; }
    if (r.type === "between" && !r.c) { warn("「之间」关系少一个目标，去掉了"); return false; }
    return true;
  });
  if (Array.isArray(plan.locks)) plan.locks = plan.locks.filter((id) => global.has(id) || terrainIds.has(id));
  // 600 个形体上限：最大的重复按比例缩
  for (let round = 0; round < 12; round++) {
    const n = shapeCount(plan);
    if (n <= MAX_SHAPES) break;
    let big = null, bc = 0;
    walkNodes(plan.nodes, (q) => { if (q.type === "repeat") { const c = instanceCount(q); if (c > bc) { bc = c; big = q; } } });
    if (!big || bc <= 1) break;
    const k = Math.max(0.3, MAX_SHAPES / n);
    if (big.pattern === "grid") { big.rows = Math.max(1, Math.floor((big.rows || 2) * Math.sqrt(k))); big.cols = Math.max(1, Math.floor((big.cols || 2) * Math.sqrt(k))); }
    else if (big.pattern === "stack") big.levels = Math.max(1, Math.floor((big.levels || 3) * k));
    else big.count = Math.max(1, Math.floor((big.count || 8) * k));
    warn(`展开后形体超过 ${MAX_SHAPES} 个，「${big.label || big.id}」缩到 ${instanceCount(big)} 个`);
  }
  return { plan, warnings };
}

function breakCycles(plan, global, parentOf, warn) {
  const ancestorsOf = (id) => { const out = new Set(); let p = parentOf.get(id); while (p) { out.add(p); p = parentOf.get(p); } return out; };
  const edges = new Map(); // key → [{ to, cut }]
  const E = (from, to, cut) => { if (!edges.has(from)) edges.set(from, []); edges.get(from).push({ to, cut }); };
  for (const [id, n] of global) {
    const anc = ancestorsOf(id);
    E(`d:${id}`, `f:${id}`, null);
    if (parentOf.has(id)) E(`f:${id}`, `f:${parentOf.get(id)}`, null);
    for (const ch of n.children || []) E(`d:${id}`, `d:${ch.id}`, null);
    const dep = (ref, cut, kind = "f") => { const A = parseAnchor(ref); if (!A || A.base === "site" || A.base === "spawn" || !global.has(A.base) || anc.has(A.base) || A.base === id) return; E(`${kind}:${id}`, `d:${A.base}`, cut); };
    if (n.at) dep(n.at, () => { warn(`「${n.label || id}」的锚点「${n.at}」和别人互相引用（成环），改到${parentOf.has(id) ? "父组原点" : "场地中心"}`); if (parentOf.has(id)) delete n.at; else n.at = "site.C"; });
    for (const k of ["area", "along", "around"]) if (n[k]) dep(n[k], () => { warn(`「${n.label || id}」的 ${k}「${n[k]}」成环，去掉了`); delete n[k]; }, "d");
    if (n.type === "link") for (const k of ["from", "to"]) if (n[k]) dep(n[k], () => { warn(`连接「${n.label || id}」的 ${k} 成环，改到场地中心`); n[k] = "site.C"; }, "d");
  }
  const state = new Map();
  const visit = (k) => {
    state.set(k, 1);
    for (const e of edges.get(k) || []) {
      if (state.get(e.to) === 1) { if (e.cut) { e.cut(); e.dead = true; } continue; }
      if (!state.get(e.to) && !e.dead) visit(e.to);
    }
    state.set(k, 2);
  };
  for (const id of global.keys()) for (const k of [`f:${id}`, `d:${id}`]) if (!state.get(k)) visit(k);
}

// ------------------------------------------------------------ compilePlan
const FRAMES = new WeakMap();
let LAST = { key: null, frames: null, seed: 1 };
/**
 * 编译：plan → 程序解释（program.js）→ resolve（布房、支路、空间刷新、检查）→ 程序检查 + 关系检查 → 索引与事实。
 * @param {object} input plan（会先 normalizePlan）
 * @param {{seed?: number, ignored?: string[]}} [opts] seed 默认 1；ignored = 人标「不重要」的检查 id（写进 meta.ignored_checks）
 * @returns {{sid: object, T: object, checks: object[], facts: object, index: Object<string, {group: string, type: string|null, sid_ids: string[]}>, plan: object, warnings: string[], ms: number}}
 */
export function compilePlan(input, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { plan, warnings } = normalizePlan(input);
  const seed = (Number(opts.seed ?? 1) >>> 0) || 1;
  const { sid, info } = runProgram(plan, { seed, warn: (m) => { if (!warnings.includes(m)) warnings.push(m); } });
  if (Array.isArray(opts.ignored) && opts.ignored.length) sid.meta.ignored_checks = opts.ignored.slice();
  sid.meta.plan = clone(plan);
  if (warnings.length) sid.meta.plan_warnings = warnings.slice();
  const R = resolve(sid, { seed });
  const checks = R.checks.concat(programChecks(sid, R.T, plan, info, sid.meta.ignored_checks || []), relationChecks(sid, R.T, plan));
  // 索引：plan id（节点 / 实例 id[k] / 地形操作 / spawn）→ SID 对象
  const groups = new Map([["spawn", ["spawn", null]]]);
  for (const t of plan.terrain) groups.set(t.id, ["terrain", t.op]);
  walkNodes(plan.nodes, (n, p, inT) => { if (!inT) groups.set(n.id, ["nodes", n.type]); });
  const index = {};
  const put = (pid, sidObjId) => {
    if (!pid) return;
    let g = groups.get(pid);
    if (!g) { const A = parseAnchor(pid); if (A && A.k !== null && groups.has(A.base)) g = ["nodes", "instance"]; else if (A && pid.includes("/")) return; }
    if (!g) return;
    const e = (index[pid] = index[pid] || { group: g[0], type: g[1], sid_ids: [] });
    if (!e.sid_ids.includes(sidObjId)) e.sid_ids.push(sidObjId);
  };
  for (const f of sid.terrain.features) put(f.plan_id, f.id);
  for (const r of sid.regions) { put(r.plan_id, r.id); for (const q of r.plan_path || []) put(q, r.id); }
  for (const v of sid.volumes) { put(v.plan_id, v.id); for (const q of v.plan_path || []) put(q, v.id); if (v.instance_of) put(v.instance_of, v.id); if (v.zone_id) put(v.zone_id, v.id); }
  for (const p of sid.paths) { put(p.plan_id, p.id); if (p.instance_of) put(p.instance_of, p.id); }
  for (const m of sid.markers) put(m.plan_id, m.id);
  for (const s of sid.spaces) put(s.plan_id, s.id);
  // 事实
  const planVols = sid.volumes.filter((v) => v.land && !v.generated);
  const byKind = {}, byType = {};
  for (const v of planVols) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
  for (const e of expand(plan)) byType[e.type] = (byType[e.type] || 0) + 1;
  let hi = null; for (const v of sid.volumes) { const t = v.position[1] + v.size[1]; if (!hi || t > hi.y) hi = { y: r2(t), id: v.id }; }
  let tmax = -Infinity; for (const h of R.T.grid.h) tmax = Math.max(tmax, h);
  const area = (poly) => { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; return Math.abs(a) / 2; };
  const water = sid.regions.filter((r) => r.kind === "water").reduce((s, r) => s + area(r.polygon) - (r.hole ? area(r.hole) : 0), 0);
  const pathLen = sid.paths.filter((p) => p.kind !== "river").reduce((s, p) => { let L = 0; for (let i = 0; i < p.points.length - 1; i++) L += Math.hypot(p.points[i + 1][0] - p.points[i][0], p.points[i + 1][1] - p.points[i][1]); return s + L; }, 0);
  const facts = Object.assign({}, R.facts, {
    shapes: planVols.length, volumes: sid.volumes.length, generated: sid.volumes.length - planVols.length, by_kind: byKind, by_type: byType, instances: expand(plan).filter((e) => e.k !== null).length,
    highest: hi ? { y: Math.max(hi.y, r2(tmax)), id: hi.y >= tmax ? hi.id : "terrain" } : { y: r2(tmax), id: "terrain" },
    water_area_m2: Math.round(water), path_length_m: Math.round(pathLen), floating: planVols.filter((v) => v.elev > 2.5).length,
    plan: { terrain_ops: plan.terrain.length, terraces: R.T.terraces.length, links: info.links, pushed: info.pushed, clamped: info.clamped, overlaps: info.overlaps, plinths: info.plinths, autofix: info.autofix, auto_trail: !!info.autoTrail, focus: info.focus || null, warnings: warnings.slice() },
  });
  FRAMES.set(plan, info.frames);
  LAST = { key: JSON.stringify(plan), frames: info.frames, seed };
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { sid, T: R.T, checks, facts, index, plan, warnings, ms: r2(now - t0) };
}

// ------------------------------------------------------------ 查找
/**
 * 按 id 在 plan 里找：节点（树里任何深度，含模板）/ 地形操作 / 实例 id[k]。
 * @returns {{kind: "node"|"terrain"|"instance", node: object, list: object[], index: number, parent: object|null, rep?: object, k?: number}|null}
 */
export function findNode(plan, id) {
  if (!plan) return null;
  const ti = (plan.terrain || []).findIndex((t) => t && t.id === id);
  if (ti >= 0) return { kind: "terrain", node: plan.terrain[ti], list: plan.terrain, index: ti, parent: null };
  const A = parseAnchor(id);
  if (A && A.k !== null) { const f = findNode(plan, A.base); return f && f.node.type === "repeat" ? { kind: "instance", node: f.node, list: f.list, index: f.index, parent: f.parent, rep: f.node, k: A.k } : null; }
  let hit = null;
  const walk = (list, parent) => {
    for (let i = 0; i < list.length && !hit; i++) {
      const n = list[i];
      if (!isObj(n)) continue;
      if (n.id === id) { hit = { kind: "node", node: n, list, index: i, parent }; return; }
      if (Array.isArray(n.children)) walk(n.children, n);
      if (!hit && isObj(n.child) && n.child.id === id) hit = { kind: "node", node: n.child, list: null, index: -1, parent: n, template: true };
      if (!hit && isObj(n.child) && Array.isArray(n.child.children)) walk(n.child.children, n.child);
    }
  };
  walk(plan.nodes || [], null);
  return hit;
}

// ------------------------------------------------------------ resolveTarget / 拖动反算
/**
 * 编译后按 plan id 找几何：{ point, polygon, top_y, base_y, kind, label, sid_ids }；找不到 null。界面高亮、空间重算用。
 * kind：spawn / site / terrain / node / space / link / region。
 */
export function resolveTarget(sid, T, id) {
  if (id === "site") { const b = sid.bounds; return { point: [0, 0], polygon: [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]], top_y: 0, base_y: 0, kind: "site", label: "场地", sid_ids: [] }; }
  const g = planGeo(sid, T, id);
  if (!g) return null;
  const has = (arr) => (arr || []).some((o) => o && (o.plan_id === id || (o.plan_path || []).includes(id) || o.instance_of === id));
  const kind = id === "spawn" ? "spawn" : has(sid.volumes) ? "node" : has(sid.spaces) ? "space" : has(sid.paths) ? "link" : has(sid.regions) ? "region" : "terrain";
  return { point: g.point, polygon: g.polygon, top_y: g.top, base_y: g.base, kind, label: g.label, sid_ids: g.sid_ids };
}
function framesOf(plan) {
  if (FRAMES.has(plan)) return FRAMES.get(plan);
  const key = JSON.stringify(plan);
  if (key === LAST.key) return LAST.frames;
  compilePlan(plan, { seed: LAST.seed || 1 });
  return LAST.frames;
}
/**
 * 拖动用：把世界坐标反算成它在父组局部坐标里的偏移 offset_m（让它的原点落在 worldPoint；锚点不变）。
 * id 可以是节点、地形操作、实例 id[k]（结果写进 repeat 的 overrides）、spawn。用上一次编译的坐标系（没有就按 plan 编译一次）。
 * @param {object} plan
 * @param {string} id
 * @param {number[]} worldPoint [x, z]
 * @returns {number[]|null} [dx, dz]（原来写了 dy 的保留成 [dx, dy, dz]）
 */
export function offsetFromPoint(plan, id, worldPoint) {
  const fr = framesOf(plan)[id];
  if (!fr || !Array.isArray(worldPoint)) return null;
  const q = apM(invM(fr.m), [worldPoint[0] - fr.base[0], worldPoint[1] - fr.base[1]]);
  const f = id === "spawn" ? { node: plan.spawn || {} } : findNode(plan, id);
  const old = f ? (f.kind === "instance" ? ((f.rep.overrides || {})[String(f.k)] || {}).offset_m : f.node.offset_m) : null;
  return Array.isArray(old) && old.length >= 3 ? [r1(q[0]), old[1], r1(q[1])] : [r1(q[0]), r1(q[1])];
}
/**
 * 拖动后写回 plan 用：{ at, offset_m }（at 保持原来的锚点，offset_m 反算）。v2 语义：不再吸附到 8 个方位，直接给局部偏移。
 * @param {object} sid 编译结果（不用，保留签名）
 * @param {object} T
 * @param {object} plan
 * @param {string} id 地形操作 / 节点 / 实例 / spawn
 * @param {number[]} point 新位置 [x, z]
 * @returns {{at: string, offset_m: number[]}|null}
 */
export function atFromPoint(sid, T, plan, id, point) {
  const f = id === "spawn" ? { node: plan.spawn || {} } : findNode(plan, id);
  if (!f) return null;
  const offset_m = offsetFromPoint(plan, id, point);
  if (!offset_m) return null;
  return { at: f.kind === "instance" ? `${f.rep.id}[${f.k}]` : f.node.at || (id === "spawn" ? "site.S" : "site.C"), offset_m };
}

// ============================================================ 标记（人画的几何，docs/07 §1.1）与手调高度（§4）
// 圈的一块（area）/ 画的一笔（trace）/ 点的一个位置（pin）：坐标是人给的（相对场地中心，x 东、z 南，米），AI 只引用 id。
// 都是本地操作：不调 AI，返回新 plan（不改入参），最后过一遍 normalizePlan。
const MARK_WORD = { area: "圈选", trace: "手绘线", pin: "图钉" };
const HAND_LABEL = /^手调高度 (\d+)$/, HAND_ID = /^hand_\d+$/;
/** 点列去重（相邻 < 0.3 m 的并掉）、多了就均匀抽到 ≤ max 个（保留首尾） */
function thinPts(pts, max, closed) {
  let out = [];
  for (const q of pts) if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) >= 0.3) out.push(q);
  if (closed && out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.3) out.pop();
  if (out.length > max) { const step = (out.length - 1) / (max - 1); out = Array.from({ length: max }, (_, k) => out[Math.round(k * step)]); }
  return out;
}
const areaOf = (poly) => { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; return Math.abs(a) / 2; };
/** normalizePlan 用：标记的几何夹进场地、去重抽稀、几何不全的丢掉、补名字 */
function cleanMarks(list, site, warn) {
  const hw = site.size_m[0] / 2, hd = site.size_m[1] / 2, out = [];
  const cp = (q) => [r1(clamp(q[0], -hw, hw)), r1(clamp(q[1], -hd, hd))];
  const n = { area: 0, trace: 0, pin: 0 };
  for (const m of (Array.isArray(list) ? list : []).slice(0, MAX_MARKS)) {
    if (!isObj(m) || !MARK_WORD[m.type]) continue;
    const o = { id: m.id, type: m.type, label: m.label || `${MARK_WORD[m.type]} ${++n[m.type]}` };
    if (!m.id) delete o.id;
    if (m.type === "area") { const pts = thinPts((m.polygon_m || []).map(cp), 64, true); if (pts.length < 3 || areaOf(pts) < 4) { warn(`标记「${o.label}」圈的范围太小，去掉了`); continue; } o.polygon_m = pts; }
    else if (m.type === "trace") { const pts = thinPts((m.path_m || []).map(cp), 64, false); if (pts.length < 2) { warn(`标记「${o.label}」只有一个点，去掉了`); continue; } o.path_m = pts; }
    else { if (!Array.isArray(m.point_m)) { warn(`标记「${o.label}」没有位置，去掉了`); continue; } o.point_m = cp(m.point_m); }
    out.push(o);
  }
  return out;
}
/** plan 里已经用了的 id（节点 / 地形操作 / 标记 / 保留字） */
function takenIds(p) {
  const s = new Set([...RESERVED, ...(p.terrain || []).map((t) => t && t.id), ...(p.marks || []).map((m) => m && m.id)]);
  walkNodes(p.nodes || [], (n) => s.add(n.id));
  return s;
}
const nextId = (taken, base) => { let k = 1; while (taken.has(`${base}_${k}`)) k++; return `${base}_${k}`; };
/** 删标记：连同手调高度时在它上面加的地形操作（hand_*）一起删；别的引用交给 normalizePlan 降级 */
function dropMark(p, id) {
  const i = (p.marks || []).findIndex((m) => m && m.id === id);
  if (i < 0) return false;
  p.marks.splice(i, 1);
  p.terrain = (p.terrain || []).filter((t) => !(t && t.at === id && HAND_ID.test(t.id || "")));
  return true;
}
/**
 * 加一个标记（人在图上圈 / 画 / 点的）。坐标相对场地中心（x 东、z 南，米）；点多了抽稀到 ≤ 64 个。
 * @param {object} plan
 * @param {{type: "area"|"trace"|"pin", label?: string, polygon_m?: number[][], path_m?: number[][], point_m?: number[]}} mark
 * @returns {{plan: object, id: string|null, warnings: string[]}} id = 新标记的 id（mark_N）；几何不合法时 null
 */
export function addMark(plan, mark) {
  const p = clone(plan) || {};
  if (!isObj(mark) || !MARK_WORD[mark.type]) return { plan: normalizePlan(p).plan, id: null, warnings: ["标记类型只能是 area / trace / pin"] };
  p.marks = Array.isArray(p.marks) ? p.marks : [];
  const id = nextId(takenIds(p), "mark");
  const same = p.marks.filter((m) => m && m.type === mark.type).length;
  const m = { id, type: mark.type, label: (mark.label || `${MARK_WORD[mark.type]} ${same + 1}`).slice(0, 16) };
  if (mark.type === "area") m.polygon_m = thinPts((mark.polygon_m || []).map((q) => [r1(q[0]), r1(q[1])]), 64, true);
  else if (mark.type === "trace") m.path_m = thinPts((mark.path_m || []).map((q) => [r1(q[0]), r1(q[1])]), 64, false);
  else m.point_m = Array.isArray(mark.point_m) ? [r1(mark.point_m[0]), r1(mark.point_m[1])] : null;
  p.marks.push(m);
  const n = normalizePlan(p);
  return { plan: n.plan, id: (n.plan.marks || []).some((q) => q.id === id) ? id : null, warnings: n.warnings };
}
/**
 * 改一个标记：patch 可以有 label / polygon_m / path_m / point_m（类型不变）。拖图钉 = 改 point_m（锚在它上面的手调高度跟着走）。
 * @returns {object} 新 plan（找不到 id 时原样规范化返回）
 */
export function updateMark(plan, id, patch) {
  const p = clone(plan) || {}, m = (p.marks || []).find((q) => q && q.id === id);
  if (m && isObj(patch)) for (const k of ["label", "polygon_m", "path_m", "point_m"]) if (patch[k] !== undefined) m[k] = clone(patch[k]);
  if (m && Array.isArray(m.polygon_m)) m.polygon_m = thinPts(m.polygon_m, 64, true);
  if (m && Array.isArray(m.path_m)) m.path_m = thinPts(m.path_m, 64, false);
  return normalizePlan(p).plan;
}
/** 删一个标记（连同在它上面手调高度加的地形操作）；锚在它上面的别的东西由 normalizePlan 降级（改到场地中心并提一句） */
export function removeMark(plan, id) {
  const p = clone(plan) || {};
  dropMark(p, id);
  return normalizePlan(p).plan;
}
/**
 * 随意选点调高度（docs/07 §4）：在 point_m 放一个图钉，加一个人给的地形操作 { op: raise|lower|flatten, at: <图钉>, shape: circle, size_m: [2r, 2r], height_m|depth_m, edge: slope, edge_m: 0.4 r }。
 * 同一个图钉（pinId，或 opId）连续拖 = 改同一个操作，不堆新的：delta_m 加在这个操作原来的量上（界面拖动时一直传拖动开始时的 plan）。
 * mode：raise = 上下拖抬高 / 压低（量变成负的就换成 lower）；lower = 只压低（|delta|）；flatten = 削到图钉处原来的地面高（target at_point）再 ± delta。
 * @param {object} plan
 * @param {{point_m: number[], delta_m: number, radius_m?: number, mode?: "raise"|"lower"|"flatten", pinId?: string, opId?: string}} e
 * @returns {{plan: object, pinId: string, opId: string}}
 */
export function heightEdit(plan, e = {}) {
  const p = clone(plan) || {};
  p.terrain = Array.isArray(p.terrain) ? p.terrain : [];
  p.marks = Array.isArray(p.marks) ? p.marks : [];
  const mode = ["raise", "lower", "flatten"].includes(e.mode) ? e.mode : "raise";
  const R = clamp(Number(e.radius_m) || 12, 2, 100), dl = clamp(Number(e.delta_m) || 0, -80, 80);
  const isPin = (id) => p.marks.some((m) => m && m.type === "pin" && m.id === id);
  let op = e.opId ? p.terrain.find((t) => t && t.id === e.opId && (HAND_ID.test(t.id) || isPin(t.at))) : null; // 只改手调的（AI 的地形操作用 applyOps 改 height_m）
  let pin = p.marks.find((m) => m && m.type === "pin" && m.id === (e.pinId || (op && op.at)));
  if (!op && pin) op = p.terrain.find((t) => t && t.at === pin.id && HAND_ID.test(t.id || ""));
  const taken = takenIds(p);
  if (!pin) {
    pin = { id: nextId(taken, "mark"), type: "pin", point_m: Array.isArray(e.point_m) ? [r1(e.point_m[0]), r1(e.point_m[1])] : [0, 0] };
    taken.add(pin.id); p.marks.push(pin);
  }
  if (!op) {
    let n = 0; for (const t of p.terrain) { const m = HAND_LABEL.exec((t && t.label) || ""); if (m) n = Math.max(n, Number(m[1])); }
    op = { id: nextId(taken, "hand"), label: `手调高度 ${n + 1}` };
    p.terrain.push(op);
  }
  if (!pin.label) pin.label = op.label;
  const prev = op.op === "raise" ? op.height_m || 0 : op.op === "lower" ? -(op.depth_m || 0) : op.op === "flatten" ? (op.height_m || 0) - (op.depth_m || 0) : 0;
  const was = op.op;
  for (const k of ["height_m", "depth_m", "target", "offset_m", "polygon_m", "path_m", "rotate_deg", "area", "steps"]) delete op[k];
  Object.assign(op, { at: pin.id, shape: "circle", size_m: [r1(2 * R), r1(2 * R)], edge: "slope", edge_m: r1(Math.max(0.5, 0.4 * R)) });
  if (mode === "flatten") {
    const v = r1((was === "flatten" ? prev : 0) + dl);
    Object.assign(op, { op: "flatten", target: "at_point" });
    if (v > 0) op.height_m = v; else if (v < 0) op.depth_m = -v;
  } else {
    const v = r1((was === "raise" || was === "lower" ? prev : 0) + (mode === "lower" ? -Math.abs(dl) : dl));
    if (v >= 0) Object.assign(op, { op: "raise", height_m: v }); else Object.assign(op, { op: "lower", depth_m: -v });
  }
  const n = normalizePlan(p); // 新的手调操作排在最后（作用在 AI 的地形之上）；超过地形操作上限时被截掉，warnings 里有一句
  return { plan: n.plan, pinId: pin.id, opId: op.id, warnings: n.warnings };
}
/**
 * 世界坐标 → 场地坐标（场地中心为原点，x 东、z 南）。plan 编译出的 SID 场地中心就是原点（恒等）；导入的 SID 按 bounds 的中心平移。
 * @param {object} sid
 * @param {number[]} p [x, z]
 * @returns {number[]}
 */
export function worldToSite(sid, p) { const b = sid && sid.bounds, cx = b ? (b.min[0] + b.max[0]) / 2 : 0, cz = b ? (b.min[2] + b.max[2]) / 2 : 0; return [r2(p[0] - cx), r2(p[1] - cz)]; }
/** 场地坐标 → 世界坐标（worldToSite 的反） */
export function siteToWorld(sid, p) { const b = sid && sid.bounds, cx = b ? (b.min[0] + b.max[0]) / 2 : 0, cz = b ? (b.min[2] + b.max[2]) / 2 : 0; return [r2(p[0] + cx), r2(p[1] + cz)]; }

// ------------------------------------------------------------ applyOps
const SPECIAL = { site: () => DEFS.site, spawn: () => DEFS.spawn, lighting: () => DEFS.lighting, plan: () => ({ properties: Object.fromEntries(["name", "concept", "key_structures", "mood", "palette", "lighting", "locks"].map((k) => [k, PLAN_SCHEMA.properties[k]])) }) };
const IDX = /^\d+$/;
/** 按 field 路径（a.b.c；数字段 = 数组下标，如 size_m.1、child.size_m.0）在 schema 里找定义；找不到 / 下标越界返回 null */
function fieldDef(def, path) {
  let d = deref(def);
  for (const seg of path.split(".")) {
    if (!d) return null;
    if (IDX.test(seg)) {
      const arr = d.type === "array" ? d : (d.oneOf || []).map((a) => deref(a)).find((a) => a.type === "array");
      if (!arr || (arr.maxItems != null && Number(seg) >= arr.maxItems)) return null;
      d = deref(Array.isArray(arr.items) ? arr.items[Number(seg)] : arr.items) || {};
      continue;
    }
    if (d.oneOf) d = deref(d.oneOf.find((a) => deref(a).properties) || d.oneOf[0]);
    if (!d.properties || !(seg in d.properties)) return null;
    d = deref(d.properties[seg]);
  }
  return d;
}
const GEN2 = new Set(["courtyard", "water", "terraces", "scatter_houses", "grove", "field", "space"]);
/**
 * 改数组的一个分量（size_m.1）之前：把 holder[key] 展开成完整数组——原来是数组就保留、不够长按有效值补；
 * 原来是一个数 / 没写，按类型的有效尺寸（size3）或 x-defaults 补齐。base = 重复实例的模板（overrides 里没写时从模板取）。
 */
function arrayFor(holder, base, key, i) {
  const ctx = Object.assign({}, isObj(base) ? base : {}, holder), cur = ctx[key];
  let full;
  if (key === "size_m" && ctx.type && !ctx.op) { const s3 = size3(Object.assign({}, ctx, { orient: undefined })); full = GEN2.has(ctx.type) ? [s3[0], s3[2]] : s3; }
  else {
    const dflt = ctx.op ? (XD.terrain || {})[ctx.op] : ctx.type ? (XD.nodes || {})[ctx.type] : null;
    full = typeof cur === "number" ? [cur, cur, cur] : dflt && Array.isArray(dflt[key]) ? dflt[key] : [];
  }
  const xs = ctx.type && PLAN_SCHEMA["x-size"] ? (PLAN_SCHEMA["x-size"][ctx.type] || []).length : 0;
  const out = Array.isArray(cur) ? cur.slice() : [], L = Math.max(i + 1, out.length || (key === "size_m" && xs) || full.length || 2);
  for (let k = out.length; k < L; k++) out.push(Number.isFinite(full[k]) ? full[k] : out.length ? out[out.length - 1] : 0);
  return out;
}
/** 删掉一个节点后：指向它（或它子树里的节点）的锚点改到场地中心 / 父组原点；连接去掉；area / along / around / look_at 去掉——交给 normalizePlan 统一降级 */
/**
 * 应用 plan 的改动（AI revise 的 ops，或界面的本地改动），作用在程序树上：
 * - set { id, field, value }：id = 节点（任何深度）/ 地形操作 / 实例 id[k]（写进 repeat.overrides[k]）/ site / spawn / lighting / plan；field 可嵌套；value null = 删字段。
 * - add { to, value, index? }：to = root / terrain / relations / <节点 id>（加成它的子节点；repeat 的话替换模板）；旧写法 { group: nodes|terrain|relations } 也认。
 * - remove { id }：节点（连子树）/ 地形操作 / 实例 id[k]（写进 repeat.skip）/ "rel:<序号>" / spawn。引用它的东西在 normalizePlan 里降级。
 * 不合法的 op 跳过并提一句；最后整体 normalizePlan。不改入参。
 * @returns {{plan: object, warnings: string[]}}
 */
export function applyOps(plan, ops) {
  const p = clone(plan) || {}, warnings = [];
  p.nodes = Array.isArray(p.nodes) ? p.nodes : [];
  p.terrain = Array.isArray(p.terrain) ? p.terrain : [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isObj(op)) continue;
    if (op.op === "set") {
      const field = String(op.field || "");
      if (!field || field === "id") { warnings.push(`「${op.id}」不能改「${field}」`); continue; }
      let obj, def, base = null;
      if (SPECIAL[op.id]) { def = SPECIAL[op.id](); obj = op.id === "plan" ? p : (p[op.id] = isObj(p[op.id]) ? p[op.id] : {}); }
      else if ((p.marks || []).some((m) => m && m.id === op.id)) { def = DEFS.mark; obj = p.marks.find((m) => m.id === op.id); if (field === "type") { warnings.push("标记不能改类型"); continue; } }
      else {
        const f = findNode(p, op.id);
        if (!f) { warnings.push(`要改的「${op.id}」不存在，跳过`); continue; }
        def = f.kind === "terrain" ? DEFS.terrain_op : DEFS.node;
        if (f.kind === "instance") { const ov = (f.rep.overrides = isObj(f.rep.overrides) ? f.rep.overrides : {}); obj = ov[String(f.k)] = isObj(ov[String(f.k)]) ? ov[String(f.k)] : {}; base = f.rep.child; }
        else obj = f.node;
      }
      if (!fieldDef(def, field)) { warnings.push(`「${op.id}」没有「${field}」这个字段，跳过`); continue; }
      const segs = field.split("."), last = segs.pop();
      if (IDX.test(last) && (op.value === null || op.value === undefined)) { warnings.push(`「${op.id}」的「${field}」是数组的一个分量，不能删`); continue; }
      let o = obj, b = base;
      for (let si = 0; si < segs.length; si++) {
        const sg = segs[si], nextIdx = IDX.test(si + 1 < segs.length ? segs[si + 1] : last);
        if (IDX.test(sg)) { b = Array.isArray(b) ? b[Number(sg)] : null; if (!isObj(o[sg])) o[sg] = isObj(b) ? clone(b) : {}; o = o[sg]; continue; }
        if (nextIdx) { o[sg] = arrayFor(o, b, sg, Number(si + 1 < segs.length ? segs[si + 1] : last)); b = b && b[sg]; o = o[sg]; continue; }
        if (!isObj(o[sg])) o[sg] = {};
        b = isObj(b) ? b[sg] : null; o = o[sg];
      }
      if (op.value === null || op.value === undefined) delete o[last]; else o[last] = clone(op.value);
    } else if (op.op === "add") {
      if (!isObj(op.value)) { warnings.push("加的东西不是一个对象，跳过"); continue; }
      const to = op.to || (op.group === "terrain" ? "terrain" : op.group === "relations" ? "relations" : op.group ? "root" : null);
      const v = clone(op.value), at = Number.isInteger(op.index) ? op.index : null;
      const ins = (list) => { if (at === null || at >= list.length) list.push(v); else list.splice(Math.max(0, at), 0, v); };
      if (to === "root" || to === "nodes") ins(p.nodes);
      else if (to === "terrain") ins(p.terrain);
      else if (to === "marks") { p.marks = Array.isArray(p.marks) ? p.marks : []; if (!v.id || takenIds(p).has(v.id)) v.id = nextId(takenIds(p), "mark"); ins(p.marks); }
      else if (to === "relations") { p.relations = Array.isArray(p.relations) ? p.relations : []; ins(p.relations); }
      else {
        const f = to && findNode(p, to);
        if (!f || f.kind !== "node") { warnings.push(`不能往「${to}」里加`); continue; }
        if (f.node.type === "repeat" || f.node.type === "scatter_houses") { f.node.child = v; continue; }
        if (NODE_CLASS(f.node.type) !== "solid" && f.node.type !== "group") { warnings.push(`「${to}」（${f.node.type}）不能有子节点`); continue; }
        f.node.children = Array.isArray(f.node.children) ? f.node.children : [];
        ins(f.node.children);
      }
    } else if (op.op === "remove") {
      const m = /^rel:(\d+)$/.exec(String(op.id));
      if (m) { const i = Number(m[1]); if (p.relations && p.relations[i]) p.relations.splice(i, 1); else warnings.push(`没有第 ${i} 条关系`); continue; }
      if (op.id === "spawn") { delete p.spawn; continue; }
      if (dropMark(p, op.id)) continue;
      const f = findNode(p, op.id);
      if (!f) { warnings.push(`要删的「${op.id}」不存在`); continue; }
      if (f.kind === "instance") { const s = new Set(f.rep.skip || []); s.add(f.k); f.rep.skip = [...s].sort((a, b) => a - b); continue; }
      if (f.template) { warnings.push(`「${op.id}」是重复的模板，要删就删整个重复「${f.parent.id}」`); continue; }
      f.list.splice(f.index, 1);
      if (Array.isArray(p.locks)) p.locks = p.locks.filter((x) => x !== op.id);
    } else warnings.push(`不认识的操作「${op.op}」`);
  }
  const n = normalizePlan(p);
  return { plan: n.plan, warnings: warnings.concat(n.warnings) };
}

// ------------------------------------------------------------ 旋钮（从 schema + x-ui 生成）
const GROUP_DEF = { node: "node", nodes: "node", terrain: "terrain_op", relation: "relation", relations: "relation", site: "site", spawn: "spawn", mark: "mark", marks: "mark" };
const groupDefOf = (group, schema) => {
  if (group === "look") return { properties: { lighting: schema.properties.lighting, palette: schema.properties.palette, mood: schema.properties.mood } };
  if (group === "plan") return { properties: { name: schema.properties.name, concept: schema.properties.concept, key_structures: schema.properties.key_structures } };
  const d = GROUP_DEF[group];
  return d ? schema.definitions[d] : null;
};
const whenOk = (when, el) => !when || Object.keys(when).every((k) => when[k].includes(el && el[k]));
const getPath = (o, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
/** 引用的可选项：site（含 8 个方位）/ spawn / terrain / nodes（全局节点，组 / 重复也在） */
function refOptions(groups, plan, selfId, anchors) {
  const out = [];
  for (const g of groups || []) {
    if (g === "site") { out.push({ value: anchors ? "site.C" : "site", label: "场地中心", group: "site" }); if (anchors) for (const d of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) out.push({ value: `site.${d}`, label: `场地${DIR_LABEL[d]}边`, group: "site" }); }
    else if (g === "spawn") out.push({ value: "spawn", label: (plan && plan.spawn && plan.spawn.label) || "出生点", group: "spawn" });
    else if (g === "terrain") for (const t of (plan && plan.terrain) || []) { if (t.id !== selfId) out.push({ value: t.id, label: t.label || t.id, group: "terrain" }); }
    else if (g === "marks") for (const m of (plan && plan.marks) || []) out.push({ value: m.id, label: m.label || m.id, group: "marks", type: m.type });
    else if (g === "nodes") walkNodes((plan && plan.nodes) || [], (n, p, inT) => { if (!inT && n.id !== selfId) out.push({ value: n.id, label: n.label || n.id, group: "nodes", type: n.type }); });
  }
  return out;
}
/**
 * 某一项的旋钮定义（界面据此生成控件）。只出 schema 里带 x-ui 且没 hidden 的字段；x-ui.when 不满足的不出；嵌套对象（connect / lighting）展开成带前缀的路径。
 * size 旋钮按 type 给 parts（x-size）；anchor 旋钮给可选的基准（site 八方 / 地形 / 节点）与后缀（top / N / …）。
 * @param {string} group "node" | "terrain" | "relation" | "site" | "spawn" | "look" | "plan"（旧名 nodes / relations 也认）
 * @param {object} element 这一项（look / plan 组传整个 plan）
 * @param {object} [schema=PLAN_SCHEMA]
 * @param {object} [plan] 给了就填引用的可选项
 * @returns {{path: string, key: string, label: string, section: string|null, kind: string, value: any, default?: any, min?: number, max?: number, step?: number, unit?: string, parts?: string[], options?: object[], ref?: string[], suffixes?: object[], hint?: string, summary?: boolean, short?: string}[]}
 */
export function knobsFor(group, element, schema = PLAN_SCHEMA, plan = null) {
  const def = groupDefOf(group, schema), out = [];
  if (!def) return out;
  const el = element || {}, xs = schema["x-size"] || {};
  const walk = (d, path, section, holder) => {
    for (const [k, p0] of Object.entries(d.properties || {})) {
      const p = deref(p0, schema);
      let ui = p["x-ui"] || {};
      if (ui.hidden || !whenOk(ui.when, holder)) continue;
      for (const v of ui.variants || []) if (whenOk(v.when, holder)) { ui = Object.assign({}, ui, v, { when: ui.when }); break; } // 同一字段在不同条件下换标签 / 选项（repeat.axis：一排的方向 / 镜像轴）
      const fp = path ? `${path}.${k}` : k;
      if (!ui.kind && p.properties) { walk(p, fp, ui.label || k, getPath(el, fp) || {}); continue; }
      if (!ui.kind) continue;
      const knob = { path: fp, key: k, label: ui.label || k, section, kind: ui.kind, value: clone(getPath(el, fp)) };
      if (p.default !== undefined) knob.default = p.default;
      for (const key of ["step", "unit", "hint", "summary", "short", "parts"]) if (ui[key] !== undefined) knob[key] = ui[key];
      const num = p.oneOf ? deref(p.oneOf.find((a) => deref(a).type === "array") || p.oneOf[0], schema) : p;
      const numItem = num.type === "array" ? deref(num.items || {}, schema) : num;
      if (numItem && (numItem.type === "number" || numItem.type === "integer")) { knob.min = ui.min ?? numItem.minimum; knob.max = ui.max ?? numItem.maximum; if (numItem.type === "integer" && knob.step === undefined) knob.step = 1; }
      if (ui.kind === "size") knob.parts = xs[el.type] || ["宽", "高", "深"];
      if (ui.kind === "enum" || ui.kind === "dir") {
        const enumVals = ui.enum || p.enum || (p.oneOf ? deref(p.oneOf[0], schema).enum || [] : []); // x-ui.enum：同一字段按条件只给一部分选项（orient：台地的方位 / 环的平放立起）
        const labels = ui.options || {};
        knob.options = (enumVals.length ? enumVals : Object.keys(labels)).map((v) => ({ value: v, label: labels[v] || v }));
      }
      if (ui.kind === "ref" || ui.kind === "refs" || ui.kind === "anchor") {
        knob.ref = ui.ref || [];
        knob.options = refOptions(ui.ref, plan, el.id, ui.kind === "anchor");
        if (ui.kind === "anchor") knob.suffixes = [{ value: "", label: "中心" }, ...["top", "bottom", "center"].map((s) => ({ value: s, label: SUFFIX_LABEL[s] })), ...["N", "E", "S", "W", "NE", "SE", "SW", "NW"].map((d) => ({ value: d, label: `${DIR_LABEL[d]}侧` })), ...["inner", "outer", "start", "mid", "end", "left", "right"].map((s) => ({ value: s, label: SUFFIX_LABEL[s] }))];
      }
      out.push(knob);
    }
  };
  walk(def, "", null, el);
  return out;
}
/** 锚点 / 引用 → 人话（「主殿 顶上」「场地南边」） */
function refLabel(v, plan) {
  const A = parseAnchor(v);
  if (!A) return String(v);
  if (A.base === "site") return A.suffix && A.suffix !== "C" ? `场地${DIR_LABEL[A.suffix] || A.suffix}边` : "场地中心";
  if (A.base === "spawn") return (plan && plan.spawn && plan.spawn.label) || "出生点";
  const f = plan ? findNode(plan, A.base) : null, name = (f && (f.node.label || f.node.id)) || A.base;
  const k = A.k !== null ? `#${A.k + 1}` : "";
  return `${name}${k}${A.suffix ? " " + (SUFFIX_LABEL[A.suffix] || `${DIR_LABEL[A.suffix] || A.suffix}侧`) : ""}`;
}
/**
 * 场景树一行的关键值：「法师塔 · 环形 · × 6 · 半径 26 m」。只取 x-ui.summary 的字段，按 x-ui.short 格式化（{v} 值、{o} 枚举中文、{r} 引用的名字、{v0} {v1} {v2} 数组分量）。
 * @returns {string}
 */
export function summarize(group, element, plan = null, schema = PLAN_SCHEMA) {
  const el = element || {}, parts = [];
  if (el.label) parts.push(el.label);
  for (const k of knobsFor(group, el, schema, plan)) {
    if (!k.summary || k.value === undefined || k.value === null || k.value === "") continue;
    const v = k.value, lab = (x) => { if (k.kind === "anchor" || k.kind === "ref" || k.kind === "refs") return refLabel(x, plan); const o = (k.options || []).find((q) => q.value === x); return o ? o.label : x; };
    const named = Array.isArray(v) ? v.map(lab).join(" 和 ") : lab(v);
    const s = (k.short || "{v}").replace(/\{v(\d)\}/g, (_, i) => (Array.isArray(v) ? v[i] ?? "" : v)).replace("{v}", Array.isArray(v) ? v.join("/") : v).replace("{o}", named).replace("{r}", named);
    parts.push(s);
  }
  return parts.join(" · ");
}
/**
 * 「＋ 加一个」：按 op / type 的默认值造一项（id 唯一）。节点默认锚到场地中心（加成子节点时界面去掉 at 用 offset_m）；
 * 重复带一个方块模板；连接从出生点到第一个节点；撒房子带一个房子模板。
 * @param {string} group "terrain" | "node"（"nodes" 也认）| "relations"
 * @param {string} [type] op / type；省略用第一种
 * @param {object} [plan]
 * @returns {object|null}
 */
export function newElement(group, type, plan = {}) {
  const taken = new Set([...RESERVED, ...((plan.terrain || []).map((t) => t.id))]);
  walkNodes(plan.nodes || [], (n) => taken.add(n.id));
  const uid = (base) => { let id = sanitizeId(base) || "node"; const b = id; for (let k = 2; taken.has(id); k++) id = `${b}_${k}`; return id; };
  const firstNode = (plan.nodes || []).find((n) => n && n.type !== "link");
  if (group === "terrain") {
    const en = DEFS.terrain_op.properties.op.enum, t = en.includes(type) ? type : en[0];
    return Object.assign({ id: uid(t), op: t, at: "site.C" }, clone(XD.terrain[t]) || {});
  }
  if (group === "node" || group === "nodes") {
    const en = DEFS.node.properties.type.enum, t = en.includes(type) ? type : en[0];
    const el = Object.assign({ id: uid(t), type: t }, clone(XD.nodes[t]) || {});
    if (t === "link") Object.assign(el, { from: "spawn", to: firstNode ? firstNode.id : "site.C" });
    else if (t !== "space" && t !== "scatter_houses" && t !== "grove" && t !== "field") el.at = "site.C";
    if (t === "repeat") el.child = { type: "box", size_m: [4, 4, 4], label: "方块" };
    if (t === "scatter_houses") Object.assign(el, { at: "site.C", child: { type: "building", size_m: [6, 4, 5], roof: "gable", label: "民居" } });
    if (t === "grove" || t === "field") el.at = "site.C";
    if (t === "group") el.children = [];
    if (t === "space") Object.assign(el, { under: firstNode ? firstNode.id : "site", connect: { via: "stairs" } });
    return el;
  }
  if (group === "relations" || group === "relation") {
    const en = DEFS.relation.properties.type.enum, t = en.includes(type) ? type : en[0];
    return { type: t, a: firstNode ? firstNode.id : "spawn", b: "spawn" };
  }
  return null;
}

// ------------------------------------------------------------ 换一批：按程序结构算差异
function bag(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }
function bagDist(a, b) {
  const A = bag(a), B = bag(b);
  let inter = 0, uni = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) { inter += Math.min(A.get(k) || 0, B.get(k) || 0); uni += Math.max(A.get(k) || 0, B.get(k) || 0); }
  return uni ? 1 - inter / uni : 0;
}
/**
 * 两个 plan 的结构差异（不编译，只看程序）：基础地形、雕刻操作、节点类型、重复排法、连接样式、生成器、悬空的多少、场地大小、时段。
 * 同一个 plan 为 0；三张卡两两 ≥ 1 算「空间组织够不一样」。v4 的旧 plan 先改写再比。
 * @returns {number}
 */
export function planDistance(a, b) {
  const sig = (p0) => {
    const p = isV4(p0) ? migrateV4(p0, () => {}) : p0 || {};
    const types = [], pats = [], styles = [], gens = [];
    let float = 0;
    walkNodes(p.nodes || [], (n) => {
      if (!isObj(n)) return;
      types.push(n.type);
      if (n.type === "repeat") pats.push(n.pattern || "linear");
      if (n.type === "link") styles.push(n.style || "path");
      if (["terraces", "scatter_houses", "space", "grove", "field"].includes(n.type)) gens.push(n.type === "space" ? `space:${n.layout || "chamber"}` : n.type === "terraces" ? `terraces:${n.form || "slope"}` : n.type);
      if (n.type === "island" || (n.elev_m || 0) > 2 || n.ground === "float") float++;
    });
    const sz = p.site && p.site.size_m, size = Array.isArray(sz) ? (sz[0] + (sz[1] ?? sz[0])) / 2 : Number(sz) || 160;
    return { ground: (p.site && p.site.ground) || "flat", ops: (p.terrain || []).map((t) => `${t.op}${t.edge ? ":" + t.edge : ""}`), types, pats, styles, gens, float, size, tod: (p.lighting && p.lighting.time_of_day) || "dusk" };
  };
  const A = sig(a), B = sig(b);
  return r2((A.ground !== B.ground ? 0.8 : 0) + bagDist(A.ops, B.ops) * 0.6 + bagDist(A.types, B.types) * 1.0 + bagDist(A.pats, B.pats) * 0.5 + bagDist(A.styles, B.styles) * 0.3
    + bagDist(A.gens, B.gens) * 0.5 + Math.min(0.6, Math.abs(A.float - B.float) / 4) + Math.min(0.4, Math.abs(A.size - B.size) / 150) + (A.tod !== B.tod ? 0.2 : 0));
}
/** 一组 plan 是否两两都够不一样（planDistance ≥ threshold） */
export function distinctPlans(plans, threshold = 1) {
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) if (planDistance(plans[i], plans[j]) < threshold) return false;
  return true;
}
export { size3, describeRef, diffCompiled };

// ============================================================ 程序检查（v5 第 1 轮从 program.js 挪来：program.js 超过 1200 行；解释在 program.js，检查在这里）
/**
 * 程序检查（resolve 之后）：重叠（推不开的）、悬空 / 基座过高、可达（出生点 → 地标 / 关系 reachable）、连接退回、实例重叠、夹回场地。
 * 每条 { id, text, ok, detail, severity, plan: true, element?, fixes: [{ label, ops } | { label, ignore }] }。
 * @param {object} sid resolve 之后的 SID
 * @param {object} T
 * @param {object} plan 规范化后的 plan
 * @param {object} info runProgram 的 info
 * @param {string[]} [ignoredIds]
 * @returns {object[]}
 */
/** 套在环孔里、四角伸进环带的形体：把它（不是环）缩到内径以内——size_m 的两个水平分量按同一比例缩 */
function shrinkFix(plan, sid, o, label) {
  const ids = [o.a, o.b].filter(Boolean);
  for (const id of ids) {
    const n = findNodeIn(plan, id), v = sid.volumes.find((q) => q.plan_id === id);
    if (!n || !v || !Array.isArray(n.size_m) || v.shape === "cylinder" && v.hollow || v.shape === "torus") continue;
    const half = Math.hypot(v.size[0], v.size[2]) / 2, f = (o.shrink - 0.5) / Math.max(half, 1e-6);
    if (!(f > 0.2 && f < 1)) continue;
    const s = n.size_m.slice(), hz = s.length >= 3 ? [0, 2] : [0, 1];
    for (const i of hz) if (Number.isFinite(s[i])) s[i] = r2(s[i] * f);
    return { label: `「${label(id)}」缩到内径以内`, ops: [{ op: "set", id, field: "size_m", value: s }] };
  }
  return null;
}
export function programChecks(sid, T, plan, info, ignoredIds = []) {
  const ignored = new Set(ignoredIds), out = [];
  const mk = (id, text, ok, detail, severity, fixes = [], extra = {}) => { fixes = fixes.concat([{ label: "不重要", ignore: id }]); out.push(Object.assign({ id, text, ok, detail, severity, plan: true, fixes }, extra, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {})); };
  const label = (id) => nodeLabel(plan, id);
  // 重叠
  const ov = info.overlaps.filter((o, i, a) => a.findIndex((q) => q.id === o.id && q.b === o.b) === i);
  const ovFix = ov.slice(0, 3).map((o) => { const n = findNodeIn(plan, o.id), off = (n && n.offset_m) || [0, 0], k = o.depth + 2; if (o.shrink != null) return shrinkFix(plan, sid, o, label); return n ? { label: `把「${label(o.id)}」再挪开 ${r2(k)} m`, ops: [{ op: "set", id: o.id, field: "offset_m", value: [r2(off[0] + o.dir[0] * k), r2((off.length >= 3 ? off[2] : off[1]) + o.dir[1] * k)] }] } : null; }).filter(Boolean);
  mk("shapes_no_overlap", "形体 不重叠", ov.length === 0, ov.length ? ov.map((o) => o.shrink != null ? `${label(o.a)} 与 ${label(o.b)} 重叠（伸进环带 ${o.depth} m：缩到内径 ${r2(2 * o.shrink)} m 以内）` : `${label(o.a)} 与 ${label(o.b)} 重叠（压进 ${o.depth} m，推半个尺寸也推不开）`).join("、") : `${sid.volumes.filter((v) => v.plan_id && !v.generated).length} 个形体互不重叠（推开 ${info.pushed.length} 处）`, "warn", ovFix);
  // 实例重叠
  if (info.instanceOverlaps.length) mk("instances_no_overlap", "重复的实例 不互相压", false, info.instanceOverlaps.map((o) => `${label(o.id)}：${o.a} 和 ${o.b} 挤在一起`).join("、"), "warn",
    info.instanceOverlaps.slice(0, 2).map((o) => { const n = findNodeIn(plan, o.id); if (!n) return null; if (n.pattern === "radial") return { label: "半径放大", ops: [{ op: "set", id: o.id, field: "radius_m", value: r2((n.radius_m || 20) * 1.3) }] }; const sp = Number(n.spacing_m) || 0; return { label: "间距放大", ops: [{ op: "set", id: o.id, field: "spacing_m", value: r2(Math.max(sp * 1.4, sp + 4, 6)) }] }; }).filter(Boolean));
  // 实例重合
  if (info.instanceCoincide.length) mk("instances_distinct", "重复的实例 不重合", false, info.instanceCoincide.map((o) => `${label(o.id)}：第 ${o.a + 1} 个和第 ${o.b + 1} 个完全重合，看起来只有一份${o.pattern === "mirror" ? `（镜像 axis:${o.axis} 是${o.axis === "z" ? "前后" : "左右"}翻，模板正好在翻转轴上）` : ""}`).join("、"), "warn",
    info.instanceCoincide.slice(0, 2).flatMap((o) => {
      const n = findNodeIn(plan, o.id); if (!n) return [];
      if (o.pattern === "mirror") {
        const ch = isObj(n.child) ? n.child : {}, off = ch.offset_m || [0, 0], z = off.length >= 3 ? off[2] : off[1] || 0, out = [];
        const moved = o.axis === "z" ? [off[0] || 0, r2(z + 8)] : [r2((off[0] || 0) + 8), z];
        if (ch.type === "repeat" && (ch.pattern || "linear") === "linear" && (ch.axis || "x") === o.axis) out.push({ label: `里面那排改成沿 ${o.axis === "x" ? "z（南北）" : "x（东西）"}排，再偏开 8 m`, ops: [{ op: "set", id: o.id, field: "child.axis", value: o.axis === "x" ? "z" : "x" }, { op: "set", id: o.id, field: "child.offset_m", value: moved }] });
        out.push({ label: "模板偏开 8 m（离开翻转轴）", ops: [{ op: "set", id: o.id, field: "child.offset_m", value: moved }] });
        out.push({ label: `改成沿 ${o.axis === "x" ? "z" : "x"} 翻`, ops: [{ op: "set", id: o.id, field: "axis", value: o.axis === "x" ? "z" : "x" }] });
        return out.slice(0, 2);
      }
      if (o.pattern === "radial") return [{ label: "半径放大", ops: [{ op: "set", id: o.id, field: "radius_m", value: Math.max(10, r2((n.radius_m || 0) * 1.5)) }] }];
      const ch = isObj(n.child) ? size3(n.child) : [6, 6, 6];
      return [{ label: "间距放大", ops: [{ op: "set", id: o.id, field: "spacing_m", value: r2(Math.max(ch[0], ch[2]) + 4) }] }];
    }));
  // 悬空：贴地的形体脚下补了很高的基座（下面被挖空 / 跨在崖边）
  const high = info.plinths.filter((p) => { const v = sid.volumes.find((q) => q.id === p.sid_id); return v && p.m > Math.max(4, v.size[1] * 0.6); });
  mk("shapes_grounded", "形体 不悬空", high.length === 0, high.length ? high.map((p) => `${label(p.id)} 脚下高差 ${p.m} m（补了基座）`).join("、") : `贴地的形体都站稳了${info.plinths.length ? `（${info.plinths.length} 处补了矮基座）` : ""}`, "warn",
    high.slice(0, 2).map((p) => ({ label: `「${label(p.id)}」改成嵌入地面`, ops: [{ op: "set", id: p.id, field: "ground", value: "carve" }] })));
  // 支撑悬空：高架组的 elev_m 把墩 / 拱 / 墙一起抬了，竖向件底面离地、顶戳出台面
  const hang = info.hanging || [];
  if (hang.length) mk("supports_grounded", "墩 / 柱 落地", false, hang.map((h) => `${label(h.id)}（高 ${h.h} m）底面离地 ${h.lift} m、顶高过台面：支撑悬空`).join("、") + "。修法：高架 / 天桥只给桥面写 elev_m，墩、柱、拱写在组外，或加 ground:\"snap\" 落地", "warn",
    hang.filter((h) => findNodeIn(plan, h.id)).slice(0, 2).map((h) => ({ label: `「${label(h.id)}」落地`, ops: [{ op: "set", id: h.id, field: "ground", value: "snap" }] })));
  // 夹回场地
  if (info.clamped.length) mk("inside_site", "都在场地里", false, info.clamped.map((c) => `${label(c.id)} 出了场地，挪回 ${Math.hypot(...c.by).toFixed(1)} m`).join("、"), "warn");
  // 连接退回
  const fb = Object.entries(info.links).filter(([, l]) => l.fallback);
  if (fb.length) mk("links_routed", "连接 都按样式走通", false, fb.map(([id, l]) => `${label(id)}：${l.fallback}`).join("、") + (fb.some(([, l]) => l.unrouted) ? "。修法：改成台阶（stairs 能爬陡坡）/ 桥（直线跨过去），或在地形里加一段 ramp 坡道" : "") + (fb.some(([, l]) => l.degenerate) ? "。两端是同一个地方：from / to 写成两岸（沟.left / 沟.right、X.W / Y.E），或连到两个不同的东西" : ""), "warn",
    fb.filter(([id, l]) => !l.degenerate && findNodeIn(plan, id)).slice(0, 1).flatMap(([id]) => [{ label: "改成台阶", ops: [{ op: "set", id, field: "style", value: "stairs" }] }, { label: "改成桥", ops: [{ op: "set", id, field: "style", value: "bridge" }] }]));
  // 可达：出生点 → 每个 landmark 角色的节点（没有就看 look_at）+ 关系 reachable
  const R = planReach(sid, T);
  const targets = [];
  walkNodes(plan.nodes, (n, p, inT) => { if (!inT && n.role === "landmark") targets.push(n.id); });
  if (!targets.length && info.focus) targets.push(info.focus);
  for (const id of targets) {
    const r = R.reach(id);
    mk(`reach_${id}`, `出生点 走得到 ${label(id)}`, r.ok, r.detail, "warn", r.ok ? [] : [{ label: "补一条路", ops: [{ op: "add", to: "root", value: { type: "link", style: r.elevated ? "stairs" : "path", from: "spawn", to: id, label: "到" + label(id) } }] }], { element: id });
  }
  return out;
}
/** 检查文案里的名字：label → 重复没写 label 用「模板名 × N」→ id；实例 id[k] 写成「X 的第 k+1 个」 */
export function nodeLabel(plan, id) {
  let n = findNodeIn(plan, id);
  if (!n) { walkNodes(plan.nodes || [], (x) => { if (!n && x.id === id) n = x; }); if (!n) return id; } // 模板里的子节点
  let s = n.label;
  if (!s && n.type === "repeat") { const c = isObj(n.child) ? n.child.label || (isObj(n.child.child) && n.child.child.label) : null; s = c ? `${c} × ${n.pattern === "mirror" ? 2 : n.count || n.levels || ""}`.trim() : null; }
  if (!s) { let par = null; walkNodes(plan.nodes || [], (x, p) => { if (!par && x === n && p) par = p; }); s = n.id || (par && par.label ? `${par.label} 的重复` : id); }
  const A = parseAnchor(id);
  return A && A.k != null && A.base === n.id ? `${s} 的第 ${A.k + 1} 个` : s;
}
/** 在 plan 树里按 id 找节点（实例 id[k] → 它的 repeat） */
export function findNodeIn(plan, id) {
  const A = parseAnchor(id), want = A ? A.base : id;
  let hit = null;
  walkNodes(plan.nodes || [], (n, p, inT) => { if (!hit && !inT && n.id === want) hit = n; });
  return hit;
}
