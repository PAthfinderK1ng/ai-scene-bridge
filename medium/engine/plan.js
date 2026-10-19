// plan.js — 构成图（plan）编译器（docs/05 §2–3）。
// AI 输出开放的构成图：任意数量的地形块 / 区域 / 建筑类型 / 地标 / 路 / 水 / 空间 / 关系，名字随便起，尺寸用米，
// 位置只用相对关系（at / place），没有坐标。这里把它编译成 SID：相对关系解成坐标、地形块叠成高度、区域落成 regions、
// 地标与入口按候选点打分落位、路按 style 路由，再交给 sid.resolve 布房 / 算检查，最后把 plan.relations 也查一遍。
// 确定性：同 plan + seed → 同 SID（随机只来自 seed）。本文件不调 AI。
//
// 对外：PLAN_SCHEMA / PLAN_GROUPS / DIRV、normalizePlan、compilePlan、applyOps、resolveTarget、atFromPoint、knobsFor、summarize、newElement、planDistance、distinctPlans。

import { buildTerrain, rng, clamp, r2, pointInPolygon, distToPolygon, distToPolyline, polygonCentroid, polygonArea, MIN_BAND, MIN_BAND_HARD } from "./terrain.js";
import { boxCorners, facingToRotation, FORM_SHAPE, rectToRectDist, rectToPolylineDist } from "./layout.js";
import { routeTrail, zigzagTrail, routeWater, pathFacts } from "./routing.js";
import { lineOfSight, relationChecks, planGeo, REL_TEXT } from "./relations.js";
import { newDoc, resolve, landmarkDoor, rotationToward, riversOf, THEME } from "./sid.js";
import { ROLES } from "./color.js";
import { compileSpaces } from "./interior.js";

// ------------------------------------------------------------ schema（单一事实来源：spec/plan.schema.json）
/** plan 的 JSON Schema（含 x-ui / x-groups / x-defaults）。模块加载时从 spec/ 读一次。 */
export const PLAN_SCHEMA = await fetch(new URL("../../spec/plan.schema.json", import.meta.url)).then((r) => {
  if (!r.ok) throw new Error(`读不到 spec/plan.schema.json（HTTP ${r.status}）`);
  return r.json();
});
const DEFS = PLAN_SCHEMA.definitions, XD = PLAN_SCHEMA["x-defaults"];
/** 清单分组：[{ key, label, def, min, max, type_field }]（外观组 key = "look"，def = null） */
export const PLAN_GROUPS = PLAN_SCHEMA["x-groups"];
const ARRAY_GROUPS = PLAN_GROUPS.filter((g) => g.def).map((g) => g.key);
const ID_GROUPS = ARRAY_GROUPS.filter((k) => k !== "relations");
const TYPE_FIELD = Object.fromEntries(PLAN_GROUPS.filter((g) => g.def).map((g) => [g.key, g.type_field]));
const FALLBACK_TYPE = { terrain: "plateau", buildings: "house", landmarks: "custom", zones: "other", paths: "winding", water: "stream", spaces: "chamber" };
const ID_PREFIX = { terrain: "terrain", zones: "zone", buildings: "bld", landmarks: "lm", paths: "path", water: "water", spaces: "space" };
const RESERVED = new Set(["site", "spawn", "entry", "plan", "lighting", "ground", "main_trail", "landmark_poi", "look"]);
const BLOBS = ["plateau", "basin", "pit", "island"]; // 没有长轴含义的块：size_m 没给 orient 时 = [东西, 南北]
const SKY_LAYOUTS = ["chamber", "corridor", "network", "rooms"];
const COORD_KEYS = new Set(["position", "pos", "x", "y", "z", "xz", "points", "coords", "coordinates", "polygon", "center", "centre", "location"]);
const S2 = Math.SQRT1_2;
/** 方向 → 单位向量 [x, z]（北 = −z） */
export const DIRV = Object.freeze({ C: [0, 0], N: [0, -1], NE: [S2, -S2], E: [1, 0], SE: [S2, S2], S: [0, 1], SW: [-S2, S2], W: [-1, 0], NW: [-S2, -S2] });
const DIR_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const OPPOSITE = { N: "S", NE: "SW", E: "W", SE: "NW", S: "N", SW: "NE", W: "E", NW: "SE", C: "C" };
const DIR_LABEL = { C: "中", N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" };

// ------------------------------------------------------------ 小工具
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? [0, 0] : [v[0] / L, v[1] / L]; };
const add = (a, u, k = 1) => [a[0] + u[0] * k, a[1] + u[1] * k];
const perp = (u) => [-u[1], u[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const rot = (u, deg) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [u[0] * c - u[1] * s, u[0] * s + u[1] * c]; };
const P2 = (p) => [r2(p[0]), r2(p[1])];
/** 多边形在方向 u 上离 c 最远多少（支撑函数） */
function support(poly, c, u) { let m = 0; for (const p of poly) m = Math.max(m, (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1]); return m; }
/** 局部坐标系 (s 沿 u, t 沿 u 的左法线) → 世界 */
const frame = (c, u) => (s, t) => [c[0] + u[0] * s - u[1] * t, c[1] + u[1] * s + u[0] * t];
function ellipsePoly(c, u, a, b, n = 16) { const F = frame(c, u), out = []; for (let k = 0; k < n; k++) { const t = (2 * Math.PI * k) / n; out.push(P2(F(a * Math.cos(t), b * Math.sin(t)))); } return out; }
/** 圆角矩形（超椭圆，指数 4） */
function roundRectPoly(c, u, a, b, n = 16) { const F = frame(c, u), out = []; for (let k = 0; k < n; k++) { const t = (2 * Math.PI * k) / n, ct = Math.cos(t), st = Math.sin(t); out.push(P2(F(a * Math.sign(ct) * Math.sqrt(Math.abs(ct)), b * Math.sign(st) * Math.sqrt(Math.abs(st))))); } return out; }
function polyArea(p) { return Math.abs(polygonArea(p)); }
/** 折线上弧长比例 f 处的点与切向 */
function alongLine(pts, f) {
  let L = 0; for (let i = 0; i < pts.length - 1; i++) L += dist2(pts[i], pts[i + 1]);
  let want = clamp(f, 0, 1) * L;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = dist2(pts[i], pts[i + 1]);
    if (want <= d || i === pts.length - 2) { const t = d > 1e-9 ? clamp(want / d, 0, 1) : 0; return { p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t], tan: unit([pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]) }; }
    want -= d;
  }
  return { p: pts[0].slice(), tan: [1, 0] };
}
function nearestOnLine(p, pts) {
  let best = { d: Infinity, p: pts[0], tan: [1, 0] };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9;
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2, 0, 1), q = [a[0] + t * dx, a[1] + t * dz], d = dist2(p, q);
    if (d < best.d) best = { d, p: q, tan: unit([dx, dz]) };
  }
  return best;
}
/** 折线在 q（线上一点）附近 ±span 米的平均走向（避开路由折线上的小抖动） */
function smoothTan(pts, q, span = 8) {
  let L = 0, at = 0, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) { const d = distToPolyline(q, [pts[i], pts[i + 1]]); if (d < bd) { bd = d; at = L + dist2(pts[i], q); } L += dist2(pts[i], pts[i + 1]); }
  if (L < 1e-6) return [1, 0];
  const a = alongLine(pts, (at - span) / L).p, b = alongLine(pts, (at + span) / L).p, u = unit([b[0] - a[0], b[1] - a[1]]);
  return u[0] || u[1] ? u : [1, 0];
}
/** 多边形里离边最远的格点（step 米网格；落不进时退回质心） */
function deepPoint(poly, step = 2) {
  let xmin = Infinity, zmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (const [x, z] of poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  let best = null, bd = -1;
  for (let z = zmin + step / 2; z < zmax; z += step) for (let x = xmin + step / 2; x < xmax; x += step) if (pointInPolygon([x, z], poly)) { const d = distToPolygon([x, z], poly); if (d > bd + 1e-9) { bd = d; best = [x, z]; } }
  return best || polygonCentroid(poly);
}
/** 多边形内 step 网格点（行优先），带离边距离 */
function gridIn(poly, step) {
  let xmin = Infinity, zmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (const [x, z] of poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  const out = [];
  for (let z = zmin + step / 2; z < zmax; z += step) for (let x = xmin + step / 2; x < xmax; x += step) if (pointInPolygon([x, z], poly)) out.push({ p: [x, z], d: distToPolygon([x, z], poly) });
  return out;
}
/** 半平面裁剪（保留 dot(p − o, n) ≥ 0 的部分，Sutherland–Hodgman） */
function clipHalf(poly, o, n) {
  const out = [], f = (p) => (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push(P2([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])); }
  }
  return out;
}
function boundaryPoints(poly, step) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = dist2(a, b), n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
/** 稳定排序（分数小在前，同分保持原顺序） */
function stableSort(arr, key) { return arr.map((v, i) => ({ v, i, k: key(v) })).sort((a, b) => a.k - b.k || a.i - b.i).map((o) => o.v); }

// ------------------------------------------------------------ schema 驱动的清洗
/** 解开 $ref，合并 x-ui（引用处的 x-ui 覆盖定义处的） */
function deref(s, schema = PLAN_SCHEMA) {
  let out = s, ui = s && s["x-ui"];
  const defs = schema.definitions;
  while (out && out.$ref) { const t = defs[out.$ref.split("/").pop()]; ui = Object.assign({}, (t && t["x-ui"]) || {}, ui || {}); out = t; }
  return ui ? Object.assign({}, out, { "x-ui": ui }) : out;
}
function sanitizeId(v) {
  let s = String(v).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "");
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
        if (s.additionalProperties === false) { if (COORD_KEYS.has(k)) warn(`「${p}」是坐标，已丢掉（位置只用相对关系）`); continue; }
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
    if (s.minItems != null && arr.length < s.minItems && s.minItems === s.maxItems) return undefined;
    return arr;
  }
  if (type.includes("number") || type.includes("integer")) {
    if (typeof v === "boolean") return undefined;
    let n = Number(v);
    if (!Number.isFinite(n)) return type.includes("null") ? undefined : undefined;
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
    if (s.pattern && s.pattern.startsWith("^[a-z][a-z0-9_]") && !/^(C|N|NE|E|SE|S|SW|W|NW)$/.test(str)) str = sanitizeId(str) || "";
    if (s.maxLength) str = str.slice(0, s.maxLength);
    if (s.minLength && str.length < s.minLength) return undefined;
    if (s.pattern && !new RegExp(s.pattern).test(str)) return undefined;
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
const siteDefaults = () => Object.fromEntries(Object.entries(DEFS.site.properties).map(([k, p]) => [k, p.default]));

// ------------------------------------------------------------ normalizePlan
/**
 * 规范化 plan：按 schema 丢未知字段（坐标字段报一句）、夹数值、校枚举；补 id（唯一、非保留字）、按 type / form 补默认值；
 * 不存在的引用降级（位置类改指 site，可选引用去掉，关系删掉）并提一句；引用成环时断开（改指 site）。不改入参。
 * @param {object} input AI 或界面给的 plan
 * @returns {{plan: object, warnings: string[]}}
 */
export function normalizePlan(input) {
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const plan = clean(isObj(input) ? input : {}, PLAN_SCHEMA, warn, "") || {};
  plan.name = plan.name || "未命名场景";
  plan.site = Object.assign(siteDefaults(), plan.site || {});
  for (const g of ARRAY_GROUPS) plan[g] = Array.isArray(plan[g]) ? plan[g].filter(isObj) : [];

  // id：唯一、非保留字
  const used = new Set(RESERVED);
  for (const g of ID_GROUPS) plan[g].forEach((el, i) => {
    let id = el.id && !used.has(el.id) ? el.id : null;
    if (!id) { const base = el.id || `${ID_PREFIX[g]}_${i + 1}`; let nid = el.id ? `${base}_2` : base; for (let k = 3; used.has(nid); k++) nid = `${base}_${k}`; if (el.id) warn(`id「${el.id}」重复，改成「${nid}」`); id = nid; }
    el.id = id; used.add(id);
  });
  // 种类与默认值
  for (const g of ID_GROUPS) for (const el of plan[g]) {
    const tf = TYPE_FIELD[g];
    if (!el[tf]) { el[tf] = FALLBACK_TYPE[g]; warn(`「${el.label || el.id}」没写${tf === "use" ? "用途" : "种类"}，按 ${el[tf]} 处理`); }
    fillDefaults(el, (XD[g] || {})[el[tf]]);
  }
  plan.relations = plan.relations.filter((r) => r.type && r.a && r.b);
  if (!plan.terrain.length) { plan.terrain.push(fillDefaults({ id: used.has("hill") ? "terrain_1" : "hill", type: "hill" }, XD.terrain.hill)); warn("没有地形，补了一座山"); }
  for (const t of plan.terrain) { t.at = Object.assign({ of: "site", dir: "C" }, t.at || {}); if (t.at.dist === undefined) t.at.dist = t.at.dir === "C" ? 0 : 0.5; }
  for (const s of plan.spaces) {
    s.stratum = s.stratum || "underground";
    if (s.stratum === "underground" && s.depth_layers === undefined) s.depth_layers = 2;
    if (s.stratum === "sky" && s.height_layers === undefined) s.height_layers = 3;
    // 天上只有单室 / 栈道 / 平台群 / 按房间（docs/04 §8.1）
    if (s.stratum === "sky" && !SKY_LAYOUTS.includes(s.layout)) { warn(`「${s.label || s.id}」在天上不能是 ${s.layout}，改成平台群`); s.layout = "network"; }
  }
  for (const w of plan.water) if (w.type !== "pond") { w.from = w.from || { of: "site", dir: "N", dist: 1 }; w.to = w.to || { of: "site", dir: "S", dist: 1 }; for (const e of [w.from, w.to]) { e.of = e.of || "site"; e.dir = e.dir || "C"; if (e.dist === undefined) e.dist = 1; } } else { w.at = Object.assign({ of: "site", dir: "C", dist: 0 }, w.at || {}); }
  for (const z of plan.zones) if (z.levels === undefined) z.levels = "all";

  // 引用
  const ids = new Map();
  for (const g of ID_GROUPS) for (const el of plan[g]) ids.set(el.id, g);
  const ALL = ["site", "spawn", ...ID_GROUPS];
  const ok = (r, groups) => r === "site" ? groups.includes("site") : r === "spawn" ? groups.includes("spawn") : ids.has(r) && groups.includes(ids.get(r));
  const nameOf = (r) => (r === "site" ? "场地" : r === "spawn" ? "出生点" : r);
  const fix = (obj, key, groups, fallback, who, self) => {
    const r = obj[key];
    if (r === undefined) return;
    if (r !== self && ok(r, groups)) return;
    warn(`${who} 引用的「${r}」${r === self ? "是它自己" : "不存在"}，${fallback === undefined ? "已去掉" : "改为" + nameOf(fallback)}`);
    if (fallback === undefined) delete obj[key]; else obj[key] = fallback;
  };
  const who = (el) => `「${el.label || el.id}」`;
  for (const t of plan.terrain) fix(t.at, "of", ["site", "terrain"], "site", who(t), t.id);
  for (const z of plan.zones) {
    if (z.on === undefined) { z.on = plan.terrain[0].id; warn(`${who(z)} 没说在哪，放在 ${plan.terrain[0].label || plan.terrain[0].id}`); }
    fix(z, "on", ["site", "terrain", "spaces"], "site", who(z)); fix(z, "building", ["buildings"], undefined, who(z));
  }
  const fixPlace = (el, place, self) => {
    if (!place) return;
    place.rel = place.rel || "center_of";
    if (Array.isArray(place.target)) {
      place.target = place.target.map((r) => (r !== self && ok(r, ALL) ? r : (warn(`${who(el)} 引用的「${r}」不存在，改为场地`), "site")));
      if (place.rel !== "between") place.target = place.target[0];
    } else {
      if (place.target === undefined) place.target = "site";
      fix(place, "target", self === "spawn" ? ALL.filter((g) => g !== "spawn") : ALL, "site", who(el), self);
      if (place.rel === "between") { place.target = [place.target, "spawn"]; warn(`${who(el)} 放在「之间」要两个目标，补了入口`); }
    }
    if (place.facing !== undefined && !DIRV[place.facing]) fix(place, "facing", ALL, undefined, who(el), self);
  };
  for (const l of plan.landmarks) fixPlace(l, l.place, l.id);
  plan.spawn = isObj(plan.spawn) ? plan.spawn : {};
  plan.spawn.place = Object.assign({ rel: "edge_of", target: "site", side: "S" }, plan.spawn.place || {});
  if (plan.spawn.place.target === "site" && plan.spawn.place.rel === "edge_of" && !plan.spawn.place.side) plan.spawn.place.side = "S";
  fixPlace({ label: "出生点" }, plan.spawn.place, "spawn");
  if (plan.spawn.look_at) fix(plan.spawn, "look_at", ["landmarks", "terrain", "zones"], undefined, "出生点");
  if (!plan.spawn.look_at && plan.landmarks.length) plan.spawn.look_at = plan.landmarks[0].id;
  plan.paths = plan.paths.filter((p) => {
    fix(p, "from", ALL, "spawn", who(p), p.id);
    if (p.from === undefined) p.from = "spawn";
    if (p.to === undefined || (p.to !== "site" && p.to !== "spawn" && !ids.has(p.to)) || p.to === p.id) { warn(`${who(p)} 没有终点（「${p.to || ""}」不存在），这条路去掉了`); return false; }
    p.via = (p.via || []).filter((r) => (r !== p.id && ok(r, ALL)) || (warn(`${who(p)} 经过的「${r}」不存在，跳过`), false));
    return true;
  });
  for (const w of plan.water) for (const e of [w.from, w.to, w.at]) if (e) fix(e, "of", ["site", "terrain"], "site", who(w));
  for (const s of plan.spaces) {
    fix(s, "under", ["site", "terrain", "zones", "landmarks", "water"], "site", who(s), s.id);
    fix(s, "over", ["site", "terrain", "zones", "landmarks", "water"], "site", who(s), s.id);
    if (s.connect) fix(s.connect, "from", ALL, undefined, who(s), s.id);
    if (Array.isArray(s.rooms)) {
      const rid = new Set(["entry"]);
      s.rooms = s.rooms.filter((r) => { if (rid.has(r.id)) { warn(`${who(s)} 的房间「${r.id}」重复，去掉`); return false; } rid.add(r.id); return true; });
      s.links = (s.links || []).filter((l) => l[0] !== l[1] && rid.has(l[0]) && rid.has(l[1]) || (warn(`${who(s)} 的连接 ${l.join("—")} 指向不存在的房间，去掉`), false));
    }
  }
  plan.relations = plan.relations.filter((r) => {
    for (const k of ["a", "b", "c"]) if (r[k] !== undefined && !ok(r[k], ALL)) { warn(`关系「${r.type}」引用的「${r[k]}」不存在，这条关系去掉了`); return false; }
    if (r.type === "between" && !r.c) { warn("「之间」关系少一个目标，去掉了"); return false; }
    return true;
  });
  if (Array.isArray(plan.locks)) plan.locks = plan.locks.filter((id) => ids.has(id) || id === "spawn");

  breakCycles(plan, warn);
  return { plan, warnings };
}

/** 地形 at.of 与「地标 / 入口 / 路 / 空间」之间的位置依赖：找环并断开（成环的那一条改指 site） */
function breakCycles(plan, warn) {
  // 地形
  const tmap = new Map(plan.terrain.map((t) => [t.id, t]));
  const tstate = new Map();
  const tvisit = (t) => {
    tstate.set(t.id, 1);
    const of = tmap.get(t.at.of);
    if (of) { if (tstate.get(of.id) === 1) { warn(`「${t.label || t.id}」的位置引用成环，改为相对场地`); t.at.of = "site"; } else if (!tstate.get(of.id)) tvisit(of); }
    tstate.set(t.id, 2);
  };
  for (const t of plan.terrain) if (!tstate.get(t.id)) tvisit(t);
  // 地标 / 入口 / 路 / 空间
  const nodes = placementNodes(plan);
  const state = new Map();
  const visit = (id) => {
    state.set(id, 1);
    const n = nodes.get(id);
    for (const e of n.deps()) {
      if (!nodes.has(e)) continue;
      if (state.get(e) === 1) { warn(`「${n.label}」和「${nodes.get(e).label}」的位置互相引用，「${n.label}」改为相对场地`); n.cut(e); continue; }
      if (!state.get(e)) visit(e);
    }
    state.set(id, 2);
  };
  for (const id of nodes.keys()) if (!state.get(id)) visit(id);
}
/** 位置依赖图的节点：deps() 列出它依赖谁，cut(e) 断开对 e 的依赖 */
function placementNodes(plan) {
  const nodes = new Map();
  const tg = (place) => (place ? (Array.isArray(place.target) ? place.target : [place.target]) : []);
  const cutPlace = (place, e) => { if (Array.isArray(place.target)) place.target = place.target.map((r) => (r === e ? "site" : r)); else if (place.target === e) place.target = "site"; };
  for (const l of plan.landmarks) nodes.set(l.id, { label: l.label || l.id, deps: () => tg(l.place), cut: (e) => cutPlace(l.place, e) });
  if (plan.spawn) nodes.set("spawn", { label: "出生点", deps: () => tg(plan.spawn.place), cut: (e) => cutPlace(plan.spawn.place, e) });
  for (const p of plan.paths) nodes.set(p.id, { label: p.label || p.id, deps: () => [p.from, ...(p.via || []), p.to], cut: (e) => { p.via = (p.via || []).filter((r) => r !== e); if (p.from === e) p.from = "spawn"; if (p.to === e) p.to = "site"; } });
  for (const s of plan.spaces) nodes.set(s.id, { label: s.label || s.id, deps: () => [s.under, s.over, s.connect && s.connect.from].filter(Boolean), cut: (e) => { if (s.under === e) s.under = "site"; if (s.over === e) s.over = "site"; if (s.connect && s.connect.from === e) delete s.connect.from; } });
  return nodes;
}

// ------------------------------------------------------------ compilePlan
/** 形制 → 体块 kind / 色彩角色 */
const FORM_KIND = { tree: "prop", well: "prop", statue: "prop", wall: "wall" };
const FORM_COLOR = { tree: "foliage", well: "stone", statue: "stone", wall: "stone", bridge: "wall" };
/** 不要求平地的形制（吊脚楼、桥、树、像） */
const FLEX_FORMS = new Set(["stilt_house", "bridge", "tree", "statue", "well"]);
const USE_KIND = { housing: "gathering", market: "gathering", plaza: "plaza", farm: "farmland", terrace_farm: "farmland", forest: "forest", temple: "other", dock: "other", yard: "other", ruins: "other", other: "other" };
const USE_BUILDING = { temple: { form: "hall", size: [10, 7, 8], floors: 1, roof: "hip", label: "殿" } };
const SUN = { dawn: [90, 5], morning: [120, 30], noon: [180, 70], afternoon: [230, 40], dusk: [250, 12], night: [300, -8], overcast: [200, 45] };
const STYLE_KIND = { bridge: "bridge", tunnel: "other" };
const STYLE_SURFACE = { winding: "dirt", stairs: "stone", zigzag: "stone", straight: "stone", bridge: "wood", tunnel: "tunnel" };
const REL_LABEL = { top_of: "顶上", center_of: "中央", edge_of: "边上", end_of: "尽头", beside: "旁边", behind: "后面", between: "之间", under: "下面", above: "上面", along: "沿线", at_entry: "入口处" };

/**
 * 编译：plan → SID → resolve（布房、支路、空间刷新、检查）→ 放置检查 + 关系检查。
 * @param {object} input plan（会先 normalizePlan）
 * @param {{seed?: number, ignored?: string[]}} [opts] seed 默认 1；ignored = 人标「不重要」的检查 id（写进 meta.ignored_checks）
 * @returns {{sid: object, T: object, checks: object[], facts: object, index: Object<string, {group: string, sid_ids: string[]}>, plan: object, warnings: string[], ms: number}}
 */
export function compilePlan(input, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { plan, warnings } = normalizePlan(input);
  const seed = (Number(opts.seed ?? 1) >>> 0) || 1;
  const S = plan.site.size_m, layer = plan.site.layer_m, relief = plan.site.relief_layers, half = S / 2;
  const sid = newDoc();
  sid.bounds = { min: [-half, 0, -half], max: [half, Math.max(40, (relief + 4) * layer + 30), half] };
  Object.assign(sid.meta, { name: plan.name, layer_height_m: layer, seed, plan_mode: true });
  if (Array.isArray(opts.ignored) && opts.ignored.length) sid.meta.ignored_checks = opts.ignored.slice();
  const lv = (n) => clamp(Math.round(n), 0, relief); // 层号压在总高差以内（人把总高差调小时顶上几层并成一层）
  const inB = (p, m = 2) => [clamp(p[0], -half + m, half - m), clamp(p[1], -half + m, half - m)];
  const sitePoly = [[-half + 2, -half + 2], [half - 2, -half + 2], [half - 2, half - 2], [-half + 2, half - 2]];
  const G = new Map(); // plan id → 几何
  G.set("site", { id: "site", group: "site", kind: "site", label: "场地", point: [0, 0], polygon: sitePoly, radius: half, terraceIds: [] });
  const spawnSide = (plan.spawn.place.target === "site" && plan.spawn.place.side) || "S";
  const sidIds = new Set(["spawn", "main_trail", "landmark_poi"]);
  const sidId = (base) => { let id = base, k = 2; while (sidIds.has(id)) id = `${base}_${k++}`; sidIds.add(id); return id; };

  // ---------- 1. 地形
  const feats = [], tFacts = {};
  const tOrder = topoTerrain(plan.terrain);
  for (const t of tOrder) {
    const of = G.get(t.at.of) || G.get("site"), u = DIRV[t.at.dir] || [0, 0];
    const reach = t.at.dir === "C" ? 0 : of.id === "site" ? half : support(of.polygon, of.point, u);
    const c = inB(add(of.point, u, t.at.dist * reach), 4);
    const rand = rng((seed * 9973 + hashStr(t.id)) >>> 0), jit = (p, a) => P2([p[0] + (rand() - 0.5) * 2 * a, p[1] + (rand() - 0.5) * 2 * a]);
    let size = (t.size_m || XD.terrain[t.type].size_m || [S * 0.6, S * 0.6]).slice();
    // 没给朝向、又在别人的某一侧：长边沿切向（「谷西边的岸台」南北长，「主山东边的崖」南北走）
    const tangential = !t.orient && t.at.dir !== "C" && (t.type === "cliff" || BLOBS.includes(t.type));
    if (t.type === "cliff") { if (size[0] < size[1]) size = [size[1], size[0]]; size[1] = clamp(size[1], 4, 12); } // 崖 = [长, 厚]，厚 4–12 m
    else if ((tangential || ["valley", "ridge"].includes(t.type)) && size[0] < size[1]) size = [size[1], size[0]]; // 谷 / 山脊的「长」总是长边
    const ax = unit(DIRV[t.orient] || (t.type === "slope_terraces" ? DIRV[OPPOSITE[spawnSide]] : tangential ? perp(u) : DIRV[XD.terrain[t.type].orient || (BLOBS.includes(t.type) ? "E" : "N")]));
    const a = Math.min(size[0], S) / 2, b = Math.min(size[1], S) / 2;
    const mine = [], geo = { id: t.id, group: "terrain", kind: t.type, label: t.label, point: c, radius: Math.max(a, b), terraceIds: [] };
    const F = (k, o) => { const f = Object.assign({ id: sidId(`${t.id}_${k}`), plan_id: t.id, label: t.label, notes: "" }, o); mine.push(f); return f; };
    const flat = (k, poly, level, extra = {}) => { const h = r2(lv(level) * layer); const f = F(k, Object.assign({ kind: "plateau", polygon: poly, level: lv(level), height: h, skirt: clamp(h * 0.8, 2, 10), override: true }, extra)); geo.terraceIds.push(f.id); return f; };
    switch (t.type) {
      case "hill": case "ridge": {
        const h = r2(lv(t.top_layer || 4) * layer);
        F(0, { kind: t.type, center: [r2(c[0]), 0, r2(c[1])], radius: r2(Math.max(a, b)), rx: r2(a), rz: r2(b), angle: r2(Math.atan2(ax[1], ax[0])), height: h, skirt: 2 });
        Object.assign(geo, { polygon: ellipsePoly(c, ax, a, b), axis: [P2(add(c, ax, -a)), P2(add(c, ax, a))], top_y: h });
        break;
      }
      case "slope_terraces": {
        const n = t.steps || 4, from = t.from_layer ?? 1, F2 = frame(c, ax), depth = (2 * a) / n;
        for (let k = 0; k < n; k++) {
          const s0 = -a + k * depth, s1 = s0 + depth, w = b * (1 - (0.25 * k) / Math.max(1, n - 1));
          flat(k, [[s0, -w], [s0, 0], [s0, w], [s1, w], [s1, 0], [s1, -w]].map(([s, tt]) => jit(F2(s, tt), 0.8)), from + k, { step: k, label: `${t.label} 第 ${k + 1} 级` });
        }
        Object.assign(geo, { polygon: [F2(-a, -b), F2(a, -b), F2(a, b), F2(-a, b)].map(P2), axis: [P2(F2(-a, 0)), P2(F2(a, 0))], upslope: ax });
        break;
      }
      case "ring_terraces": {
        const n = t.steps || 4, from = t.from_layer ?? 1;
        const fitR = Math.min(half - Math.abs(c[0]), half - Math.abs(c[1])) - 2;
        let R = t.size_m ? Math.min(size[0], size[1]) / 2 : ["hill", "ridge", "plateau", "island", "basin"].includes(of.kind) && of.polygon ? 0.92 * Math.min(...DIR_NAMES.map((d) => support(of.polygon, c, DIRV[d]))) : S * 0.3;
        R = clamp(R, 12, Math.max(12, fitR));
        let bw = t.width_m || Math.max(MIN_BAND, R / n);
        if (R - (n - 1) * bw < 5) bw = Math.max(MIN_BAND_HARD, (R - 5) / Math.max(1, n - 1));
        if (R - (n - 1) * bw < 5) bw = Math.max(4, (R - 4) / Math.max(1, n - 1));
        const r0 = Math.max(3, R - (n - 1) * bw), N = 12, seam = Math.atan2(DIRV.N[1], DIRV.N[0]);
        const circ = (r, rev) => { const pts = []; for (let k = 0; k <= N; k++) { const ang = seam + ((rev ? -1 : 1) * 2 * Math.PI * k) / N; pts.push(P2([c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)])); } return pts; };
        for (let k = 0; k < n; k++) {
          const level = t.inverse ? from + n - 1 - k : from + k, ro = R - k * bw, ri = R - (k + 1) * bw;
          const poly = k === n - 1 ? circ(r0, false).slice(0, N).map((p) => jit(p, 0.4)) : [...circ(ro, false), ...circ(Math.max(ri, 2), true)].map((p, i) => (i % (N + 1) === 0 || i % (N + 1) === N ? p : jit(p, 0.4)));
          flat(k, poly, level, { step: k, ring: true, label: `${t.label} 第 ${k + 1} 圈` });
        }
        Object.assign(geo, { polygon: circ(R, false).slice(0, N), radius: R, band_m: r2(bw) });
        break;
      }
      case "plateau": {
        const poly = roundRectPoly(c, ax, a, b);
        flat(0, poly, t.layer ?? 2); geo.polygon = poly;
        break;
      }
      case "cliff": {
        const F2 = frame(c, ax), poly = [F2(-a, -b), F2(a, -b), F2(a, b), F2(-a, b)].map(P2);
        const h = r2(lv(t.layer ?? 4) * layer);
        F(0, { kind: "cliff", polygon: poly, level: lv(t.layer ?? 4), height: h, skirt: 1.5, override: true, cliff: true });
        Object.assign(geo, { polygon: poly, axis: [P2(F2(-a, 0)), P2(F2(a, 0))], top_y: h });
        break;
      }
      case "valley": case "basin": case "pit": {
        const poly = t.type === "valley" ? roundRectPoly(c, ax, a, b, 20) : ellipsePoly(c, ax, a, b);
        const h = -r2((t.depth_layers || 1) * layer), skirt = t.type === "pit" ? 1.5 : t.type === "valley" ? Math.max(4, b * 0.5) : Math.max(4, Math.min(a, b) * 0.4);
        F(0, { kind: t.type, polygon: poly, height: h, skirt: r2(skirt) });
        Object.assign(geo, { polygon: poly, axis: t.type === "valley" ? [P2(add(c, ax, -a)), P2(add(c, ax, a))] : null, top_y: 0, floor_y: h });
        break;
      }
      case "island": {
        F("moat", { kind: "basin", polygon: ellipsePoly(c, ax, a * 1.5, b * 1.5), height: -r2(layer), skirt: 3 });
        const poly = roundRectPoly(c, ax, a, b);
        flat(0, poly, t.layer ?? 3, { skirt: 2.5 }); geo.polygon = poly;
        break;
      }
      default: break;
    }
    feats.push(...mine);
    G.set(t.id, geo);
    tFacts[t.id] = { type: t.type, features: mine.map((f) => f.id), levels: mine.filter((f) => Number.isInteger(f.level)).map((f) => f.level) };
  }
  // 池塘：浅浅一个负特征（水面在 regions 里）
  for (const w of plan.water) if (w.type === "pond") {
    const of = G.get(w.at.of) || G.get("site"), u = DIRV[w.at.dir] || [0, 0], reach = w.at.dir === "C" ? 0 : of.id === "site" ? half : support(of.polygon, of.point, u);
    const c = inB(add(of.point, u, w.at.dist * reach), 6), sz = w.size_m || [18, 14], poly = ellipsePoly(c, [1, 0], sz[0] / 2, sz[1] / 2, 14);
    feats.push({ id: sidId(`${w.id}_bed`), plan_id: w.id, kind: "pit", polygon: poly, height: -1, skirt: 3, label: w.label, notes: "" });
    G.set(w.id, { id: w.id, group: "water", kind: "pond", label: w.label, point: c, polygon: poly, radius: Math.max(...sz) / 2, width: 0 });
  }
  for (const f of feats) if (f.polygon) { const c = polygonCentroid(f.polygon); f.center = [r2(c[0]), 0, r2(c[1])]; f.radius = r2(Math.max(...f.polygon.map((q) => dist2(q, c)))); }
  sid.terrain.features = feats;
  const T = buildTerrain(sid, { res: 2 });
  for (const g of G.values()) {
    g.terraces = T.terraces.filter((tt) => (g.terraceIds || []).includes(tt.id));
    if (g.group === "terrain" && g.top_y === undefined) g.top_y = g.terraces.length ? Math.max(...g.terraces.map((x) => x.height)) : T.heightAt(g.point[0], g.point[1]);
  }

  // ---------- 2. 水（溪 / 河沿低处走）
  for (const w of plan.water) {
    if (w.type === "pond") { sid.regions.push({ id: sidId(w.id), plan_id: w.id, kind: "water", polygon: G.get(w.id).polygon, density: 0, label: w.label }); continue; }
    const end = (e) => { const of = G.get(e.of) || G.get("site"), u = DIRV[e.dir] || [0, 0], reach = e.dir === "C" ? 0 : of.id === "site" ? half : support(of.polygon, of.point, u); return inB(add(of.point, u, e.dist * reach), 0.5); };
    let from = end(w.from), to = end(w.to);
    // 有谷而源头 / 流向都是场地默认：顺着第一条谷的轴线
    const valley = plan.terrain.find((t) => t.type === "valley");
    if (valley && w.from.of === "site" && w.to.of === "site") { const ax = G.get(valley.id).axis; const [p0, p1] = dist2(ax[0], from) <= dist2(ax[1], from) ? ax : [ax[1], ax[0]]; from = inB(add(p0, unit([p0[0] - p1[0], p0[1] - p1[1]]), S), 0.5); to = inB(add(p1, unit([p1[0] - p0[0], p1[1] - p0[1]]), S), 0.5); }
    // 风雨桥架在两岸之间：溪要从两岸之间的缝穿过去（不从外面绕）
    const gaps = plan.landmarks.filter((l) => l.form === "bridge" && l.place.rel === "between" && Array.isArray(l.place.target) && l.place.target.length === 2)
      .map((l) => l.place.target.map((x) => G.get(x))).filter(([A, B]) => A && B && A.group === "terrain" && B.group === "terrain")
      .map(([A, B]) => P2([(A.point[0] + B.point[0]) / 2, (A.point[1] + B.point[1]) / 2]))
      .filter((m) => plan.water.filter((x) => x.type !== "pond").length === 1 || distToPolyline(m, [from, to]) < S / 4);
    const along = (m) => dot([m[0] - from[0], m[1] - from[1]], unit([to[0] - from[0], to[1] - from[1]]));
    const stops = [from, ...stableSort(gaps, along), to];
    let points = [];
    for (let k = 0; k + 1 < stops.length; k++) { const seg = routeWater(T, stops[k], stops[k + 1]); points.push(...(k ? seg.slice(1) : seg)); }
    if (points.length > 40) points = points.filter((q, k) => k === 0 || k === points.length - 1 || k % 2 === 0);
    const width = w.width_m || XD.water[w.type].width_m || 4;
    sid.paths.push({ id: sidId(w.id), plan_id: w.id, kind: "river", width, points, surface: "water", label: w.label, generated: true });
    G.set(w.id, { id: w.id, group: "water", kind: w.type, label: w.label, point: alongLine(points, 0.5).p, line: points, width, radius: 4 });
  }
  const waters = sid.paths.filter((p) => p.kind === "river");

  // ---------- 3. 区域
  const buildingOf = (id) => { const b = plan.buildings.find((x) => x.id === id); return b ? { form: b.form, size: b.size_m.slice(), floors: b.floors, roof: b.roof, label: b.label, plan_id: b.id } : null; };
  for (const z of plan.zones) {
    const on = G.get(z.on) || G.get("site");
    let parts = [];
    if (on.terraces && on.terraces.length) {
      const levels = [...new Set(on.terraces.map((x) => x.level))].sort((p, q) => p - q), n = levels.length, third = Math.max(1, Math.ceil(n / 3));
      let pick;
      if (Array.isArray(z.levels)) { pick = levels.filter((l) => z.levels.includes(l)); if (!pick.length) pick = levels.filter((l, i) => z.levels.includes(i)); if (!pick.length) { warnings.push(`「${z.label}」要的层 ${z.levels.join("/")} 在「${on.label}」上没有，用全部`); pick = levels; } }
      else pick = z.levels === "low" ? levels.slice(0, third) : z.levels === "high" ? levels.slice(n - third) : z.levels === "mid" ? (n > 2 ? levels.slice(third, Math.max(third + 1, n - third)) : levels.slice(-1)) : levels;
      parts = on.terraces.filter((x) => pick.includes(x.level)).map((x) => ({ polygon: x.polygon, level: x.level, terrace_id: x.id }));
    } else if (on.polygon) parts = [{ polygon: on.group === "site" ? sitePoly.map((p) => p.map((v) => v * 0.9)) : on.polygon }];
    if (z.side && z.side !== "C") parts = parts.map((p) => Object.assign({}, p, { polygon: clipHalf(p.polygon, on.point, DIRV[z.side]) }));
    parts = parts.filter((p) => p.polygon.length >= 3 && polyArea(p.polygon) >= 20);
    const B = z.building ? buildingOf(z.building) : USE_BUILDING[z.use] ? Object.assign({ plan_id: null }, USE_BUILDING[z.use]) : null;
    const density = z.density ?? (XD.zones[z.use] || {}).density ?? 0.6;
    const regs = parts.map((p, k) => {
      const r = { id: sidId(`${z.id}_${k}`), plan_id: z.id, kind: USE_KIND[z.use] || "other", use: z.use, polygon: p.polygon, density, label: z.label };
      if (p.terrace_id) Object.assign(r, { terrace_level: p.level, terrace_id: p.terrace_id });
      else if (on.group === "terrain" && ["valley", "basin", "pit"].includes(on.kind)) r.floor_of = on.id; // 谷底：按真实地面布房，不挂到别的台地
      if (B) r.building = B;
      return r;
    });
    sid.regions.push(...regs);
    if (!regs.length) warnings.push(`「${z.label}」在「${on.label}」上没有地方，没生成`);
    const geo = { id: z.id, group: "zones", kind: "zone", label: z.label, polygons: regs.map((r) => r.polygon), terraceIds: regs.map((r) => r.terrace_id).filter(Boolean) };
    if (regs.length) {
      const big = regs.reduce((m, r) => (polyArea(r.polygon) > polyArea(m.polygon) ? r : m), regs[0]);
      let A = 0, cx = 0, cz = 0;
      for (const r of regs) { const ar = polyArea(r.polygon), cc = polygonCentroid(r.polygon); A += ar; cx += cc[0] * ar; cz += cc[1] * ar; }
      let pt = [cx / A, cz / A];
      if (!regs.some((r) => pointInPolygon(pt, r.polygon))) pt = deepPoint(big.polygon);
      Object.assign(geo, { point: pt, polygon: big.polygon, radius: Math.sqrt(A / Math.PI) });
    } else Object.assign(geo, { point: on.point, polygon: on.polygon, radius: on.radius });
    geo.terraces = T.terraces.filter((tt) => geo.terraceIds.includes(tt.id));
    G.set(z.id, geo);
  }
  for (const b of plan.buildings) if (!G.has(b.id)) { const z = plan.zones.find((x) => x.building === b.id); G.set(b.id, Object.assign({}, G.get(z ? z.id : "site"), { id: b.id, group: "buildings", label: b.label })); }

  // ---------- 4. 地标与入口（按依赖顺序；候选点 + 确定性打分）
  const ctx = { T, S, half, plan, G, waters, placed: [], spawnPt: null, layer, sitePoly };
  const lmById = new Map(plan.landmarks.map((l) => [l.id, l]));
  const solved = new Map(); // id → { point, ok, why, rel, target, nudged }
  const avoidOf = (skip) => ctx.placed.filter((o) => o.vol && !skip.includes(o.id)).map((o) => boxCorners(o.vol.position, [o.vol.size[0] + 2, o.vol.size[1], o.vol.size[2] + 2], o.vol.rotation_y));
  /** 一条路：节点 → 落点 → 按 style 一段段路由（过桥 / 穿门那一段走直线） */
  const routeOne = (p) => {
    const nodes = [p.from, ...(p.via || []), p.to], pts = [];
    let prev = null;
    nodes.forEach((n, k) => {
      const next = k < nodes.length - 1 ? (G.get(nodes[k + 1]) || G.get("site")).point : null;
      for (const q of nodePoints(n, prev, next, k === 0, k === nodes.length - 1, G, T, sid)) { if (prev && dist2(prev, q.p) < 0.5) continue; pts.push(q); prev = q.p; }
    });
    if (pts.length < 2) { const a = pts[0] ? pts[0].p : ctx.spawnPt || [0, 0]; pts.splice(0, pts.length, { p: a, id: p.from }, { p: add(a, [0, -4]), id: p.to }); }
    const style = p.style || "winding", width = p.width_m || (XD.paths[style] || {}).width_m || 2;
    let line = [pts[0].p.slice()], fallback = null;
    for (let k = 0; k < pts.length - 1; k++) {
      const A = pts[k], B = pts[k + 1], inner = A.inner && B.inner && A.id === B.id;
      const seg = inner ? { points: [A.p, B.p] } : routeSeg(T, A.p, B.p, style, avoidOf([A.id, B.id]), seed, riversOf(sid));
      if (seg.fallback) fallback = seg.fallback;
      line.push(...seg.points.slice(1).map(P2));
    }
    line = line.filter((q, k) => k === 0 || dist2(q, line[k - 1]) > 0.05);
    if (line.length < 2) line.push(P2(add(line[0], [0, -2])));
    return { line, style, width, fallback, nodes };
  };
  const routed = new Map();
  const targetedPaths = new Set([...plan.landmarks.map((l) => l.place), plan.spawn.place].flatMap((pl) => (Array.isArray(pl.target) ? pl.target : [pl.target])).filter((x) => plan.paths.some((p) => p.id === x)));
  ctx.provisionalSpawn = () => ctx.spawnPt || edgeCands(G.get("site"), { d: 2, r: 1 }, DIRV[spawnSide], ctx)[0];
  for (const id of placeOrder(plan)) {
    if (id === "spawn") {
      const res = solvePlace(ctx, "spawn", plan.spawn.place, { w: 2, h: 2, d: 2, form: "spawn" });
      ctx.spawnPt = res.point; solved.set("spawn", res);
      G.set("spawn", { id: "spawn", group: "spawn", kind: "spawn", label: plan.spawn.label || "出生点", point: res.point, polygon: null, radius: 1, top_y: T.heightAt(res.point[0], res.point[1]) + 1.7 });
      ctx.placed.push({ id: "spawn", rect: boxCorners([res.point[0], 0, res.point[1]], [3, 2, 3], 0) });
      continue;
    }
    const l = lmById.get(id);
    if (l) {
      const dims = { w: l.size_m[0], h: l.size_m[1], d: l.size_m[2], form: l.form };
      const res = solvePlace(ctx, l.id, l.place, dims);
      solved.set(l.id, res);
      const lm = makeLandmark(l, res, ctx, sidId);
      sid.volumes.push(lm);
      ctx.placed.push({ id: l.id, rect: boxCorners(lm.position, lm.size, lm.rotation_y), vol: lm });
      G.set(l.id, { id: l.id, group: "landmarks", kind: "landmark", label: l.label, point: [lm.position[0], lm.position[2]], polygon: boxCorners(lm.position, lm.size, lm.rotation_y).map(P2), radius: Math.hypot(lm.size[0], lm.size[2]) / 2, top_y: lm.position[1] + lm.size[1], vol: lm, form: l.form });
      continue;
    }
    // 路 / 空间的预备几何（给依赖它们的地标用）
    const p = plan.paths.find((x) => x.id === id);
    if (p) {
      // 有地标沿着它 / 放在它尽头：现在就路由（地标落位要用真路线）；否则先用节点落点连直线占位
      if (targetedPaths.has(p.id)) { const R = routeOne(p); routed.set(p.id, R); G.set(p.id, { id: p.id, group: "paths", kind: "path", label: p.label, point: alongLine(R.line, 0.5).p, line: R.line, width: R.width, radius: 2 }); continue; }
      const nodes = [p.from, ...(p.via || []), p.to], pts = [];
      nodes.forEach((n, k) => { const next = k < nodes.length - 1 ? (G.get(nodes[k + 1]) || G.get("site")).point : null; for (const q of nodePoints(n, pts[pts.length - 1] || null, next, k === 0, k === nodes.length - 1, G, T, sid)) pts.push(q.p); });
      G.set(p.id, { id: p.id, group: "paths", kind: "path", label: p.label, point: alongLine(pts, 0.5).p, line: pts, width: p.width_m || 2, radius: 2, prelim: true });
      continue;
    }
    const s = plan.spaces.find((x) => x.id === id);
    if (s) { const tg = G.get(s.stratum === "sky" ? s.over || "site" : s.under || "site") || G.get("site"), off = s.offset_m || [0, 0], c = add(tg.point, off), h = (s.size_m || 30) / 2; G.set(s.id, { id: s.id, group: "spaces", kind: "space", label: s.label, point: c, polygon: [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]], radius: h, prelim: true }); }
  }
  // 朝向：全部落位之后再定（facing 不产生位置依赖）
  const spawnPt = ctx.spawnPt;
  for (const l of plan.landmarks) {
    const v = sid.volumes.find((o) => o.plan_id === l.id);
    if (!v || v.form === "bridge" || v.rests_on) continue;
    const p = [v.position[0], v.position[2]], f = l.place.facing;
    const tgt = f && DIRV[f] ? add(p, DIRV[f], 10) : f && G.get(f) && f !== l.id ? G.get(f).point : spawnPt;
    if (v.form === "wall") { const tg = G.get(Array.isArray(l.place.target) ? l.place.target[0] : l.place.target); if (tg && tg.polygon) { const n = nearestOnLine(p, [...tg.polygon, tg.polygon[0]]); v.rotation_y = facingToRotation(perp(n.tan)); continue; } }
    if (tgt && dist2(p, tgt) > 1e-6) v.rotation_y = rotationToward(p, tgt);
    if (v.form === "stilt_house") { const hs = boxCorners(v.position, v.size, v.rotation_y).map(([x, z]) => T.heightAt(x, z)); v.position[1] = r2(Math.max(...hs)); v.stilt_m = r2(Math.max(...hs) - Math.min(...hs)); }
    G.get(l.id).polygon = boxCorners(v.position, v.size, v.rotation_y).map(P2);
  }
  const lookId = plan.spawn.look_at, look = lookId && G.get(lookId);
  const focusLm = (lookId && lmById.has(lookId) && lookId) || (plan.paths[0] && lmById.has(plan.paths[0].to) && plan.paths[0].to) || (plan.landmarks[0] && plan.landmarks[0].id) || null;
  const lookPt = look ? look.point : focusLm ? G.get(focusLm).point : [0, 0];
  sid.markers.push({ id: "spawn", plan_id: "spawn", kind: "player_spawn", position: [r2(spawnPt[0]), r2(T.heightAt(spawnPt[0], spawnPt[1])), r2(spawnPt[1])], rotation_y: rotationToward(spawnPt, lookPt), label: plan.spawn.label || "出生点" });
  if (focusLm) sid.meta.focus = sid.volumes.find((v) => v.plan_id === focusLm).id;

  // ---------- 5. 空间（interior.js：外轮廓、内部布局、高度、连接点）
  const resolveT = (id) => { const g = G.get(id) || G.get("site"); return { point: g.point, polygon: g.polygon || null, top_y: g.top_y, kind: g.kind, label: g.label }; };
  if (plan.spaces.length) {
    const out = compileSpaces(plan.spaces, sid, T, resolveT, { seed });
    for (const s of out.spaces) { sid.spaces.push(s); sidIds.add(s.id); G.set(s.plan_id || s.id, { id: s.plan_id || s.id, group: "spaces", kind: "space", label: s.label, point: s.entrance ? s.entrance.slice(0, 2) : polygonCentroid(s.polygon), polygon: s.polygon, radius: Math.sqrt(polyArea(s.polygon) / Math.PI), top_y: s.floor_y + s.height }); }
    for (const m of out.connectors) { if (!m.plan_id) m.plan_id = m.to !== "ground" ? (sid.spaces.find((s) => s.id === m.to) || {}).plan_id : null; sid.markers.push(m); sidIds.add(m.id); const sg = G.get(m.plan_id); if (sg && m.from === "ground") sg.point = [m.position[0], m.position[2]]; }
    for (const w of out.warnings || []) warnings.push(w);
  }

  // ---------- 6. 路（第一条是主路 main_trail；被地标引用的那几条在第 4 步已经路由过）
  const pFacts = {};
  const plans = plan.paths.length ? plan.paths : focusLm || plan.terrain.length ? [{ id: null, label: "主路", from: "spawn", to: focusLm || topTerrainId(plan, G), via: [], style: "winding", width_m: 2, auto: true }] : [];
  plans.forEach((p, i) => {
    const { line, style, width, fallback, nodes } = (p.id && routed.get(p.id)) || routeOne(p);
    const id = i === 0 ? "main_trail" : sidId(p.id);
    sid.paths.push(Object.assign({ id, plan_id: p.id, kind: STYLE_KIND[style] || "trail", style, width, points: line, surface: STYLE_SURFACE[style] || "stone", label: p.label || "主路", generated: true, nodes }, style === "tunnel" ? { tunnel: true } : {}, fallback ? { fallback } : {}));
    if (p.id) { G.set(p.id, { id: p.id, group: "paths", kind: "path", label: p.label, point: alongLine(line, 0.5).p, line, width, radius: 2 }); pFacts[p.id] = { sid_id: id, length_m: pathFacts(line, T).length_m, style, fallback }; }
    if (i === 0) { const tv = sid.volumes.find((v) => v.plan_id === p.to && v.importance === "landmark"); if (tv) sid.meta.trail_target = tv.id; }
  });

  // ---------- 7. 外观
  const theme = THEME.mountain_village;
  const byRole = new Map(theme.palette.map((q) => [q.role, clone(q)]));
  for (const q of plan.palette || []) byRole.set(q.role, { role: q.role, hex: q.hex, note: q.note || (byRole.get(q.role) || {}).note || "" });
  sid.style.palette = [...ROLES.filter((r) => byRole.has(r)), ...[...byRole.keys()].filter((r) => !ROLES.includes(r))].map((r) => byRole.get(r));
  const tod = (plan.lighting && plan.lighting.time_of_day) || "dusk", sun = SUN[tod];
  sid.style.lighting = { time_of_day: tod, sun_azimuth_deg: sun[0], sun_elevation_deg: sun[1] };
  sid.intent = { summary: plan.one_liner || "", mood: (plan.mood || []).slice() };
  sid.meta.plan = clone(plan);
  if (warnings.length) sid.meta.plan_warnings = warnings.slice();

  // ---------- 8. resolve（布房 / 支路 / 空间刷新 / 检查）+ 放置检查 + 关系检查
  const R = resolve(sid, { seed });
  const placeChecks = [];
  const ignored = new Set(sid.meta.ignored_checks || []);
  for (const [id, res] of solved) {
    const el = id === "spawn" ? plan.spawn : lmById.get(id), lab = id === "spawn" ? plan.spawn.label || "出生点" : el.label;
    const tg = Array.isArray(el.place.target) ? el.place.target.map((x) => (G.get(x) || {}).label || x).join(" 和 ") : (G.get(el.place.target) || {}).label || el.place.target;
    const cid = `place_${id}`, detail = (res.ok ? "放好了" : res.why || "没找到合适的位置") + (res.nudged ? `（人挪过 ${res.nudged.join(", ")} m）` : "");
    const fixes = res.nudged ? [{ label: "回到原位", ops: [{ op: "set", id, field: "place.nudge_m", value: null }] }] : [];
    fixes.push({ label: "不重要", ignore: cid });
    placeChecks.push(Object.assign({ id: cid, text: `${lab} 在 ${tg} ${REL_LABEL[el.place.rel] || el.place.rel}`, ok: res.ok, detail, severity: "warn", plan: true, element: id, fixes }, ignored.has(cid) ? { ignored: true, detail: "已标记不重要 · " + detail } : {}));
  }
  const checks = R.checks.concat(placeChecks, relationChecks(sid, R.T, plan));

  // ---------- 9. 索引（plan id → SID 对象）与事实
  const index = {};
  const groupOf = new Map([["spawn", "spawn"]]);
  for (const g of ID_GROUPS) for (const el of plan[g]) groupOf.set(el.id, g);
  const put = (pid, sidObjId) => { if (!pid || !groupOf.has(pid)) return; (index[pid] = index[pid] || { group: groupOf.get(pid), sid_ids: [] }).sid_ids.push(sidObjId); };
  for (const f of sid.terrain.features) put(f.plan_id, f.id);
  for (const r of sid.regions) put(r.plan_id, r.id);
  for (const v of sid.volumes) { put(v.plan_id, v.id); if (v.zone_id) put(v.zone_id, v.id); }
  for (const p of sid.paths) put(p.plan_id, p.id);
  for (const m of sid.markers) put(m.plan_id, m.id);
  for (const s of sid.spaces) put(s.plan_id, s.id);
  const lFacts = {};
  for (const [id, res] of solved) lFacts[id] = { ok: res.ok, rel: res.rel, target: res.target, rank: res.rank, nudged: res.nudged || null };
  const zFacts = {};
  for (const z of plan.zones) zFacts[z.id] = { regions: sid.regions.filter((r) => r.plan_id === z.id).length, houses: sid.volumes.filter((v) => v.zone_id === z.id && v.kind === "building").length };
  const facts = Object.assign({}, R.facts, { plan: { terrain: tFacts, landmarks: lFacts, zones: zFacts, paths: pFacts, warnings: warnings.slice() } });
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { sid, T: R.T, checks, facts, index, plan, warnings, ms: r2(now - t0) };
}

function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function topoTerrain(list) {
  const map = new Map(list.map((t) => [t.id, t])), out = [], seen = new Set();
  const visit = (t) => { if (seen.has(t.id)) return; seen.add(t.id); const of = map.get(t.at.of); if (of) visit(of); out.push(t); };
  for (const t of list) visit(t);
  return out;
}
/** 地标 / 入口 / 路 / 空间的落位顺序：依赖在前；同时可放时地标先于入口（入口要看得见地标），其余按 plan 顺序 */
function placeOrder(plan) {
  const nodes = placementNodes(plan), ids = [...nodes.keys()], out = [], done = new Set();
  const ready = (id) => nodes.get(id).deps().every((e) => !nodes.has(e) || done.has(e));
  while (out.length < ids.length) {
    const avail = ids.filter((id) => !done.has(id) && ready(id));
    if (!avail.length) { for (const id of ids) if (!done.has(id)) { out.push(id); done.add(id); } break; }
    const pick = avail.find((id) => plan.landmarks.some((l) => l.id === id) && !needsSpawn(plan, id)) || avail.find((id) => id === "spawn") || avail[0];
    out.push(pick); done.add(pick);
  }
  return out;
}
function needsSpawn(plan, id) { const l = plan.landmarks.find((x) => x.id === id); return !!l && (l.place.rel === "behind" || (l.place.rel === "at_entry" && l.place.target === "site")); }
function topTerrainId(plan, G) { let best = null, bh = -Infinity; for (const t of plan.terrain) { const g = G.get(t.id); if (g && g.top_y > bh) { bh = g.top_y; best = t.id; } } return best || "site"; }

// ------------------------------------------------------------ 放置求解
/**
 * 按 place.rel 求候选点，按「出不出场地 / 坡陡不陡 / 压不压水 / 挤不挤别的地标 / 关系成立多少」打分，挑第一名（确定性）。
 * 最后加人给的 nudge_m。
 * @returns {{point: number[], ok: boolean, why: string, rel: string, target: string|string[], rank: number, nudged?: number[], span?: object}}
 */
function solvePlace(ctx, owner, place, dims) {
  const { G, T } = ctx;
  const own = { w: dims.w, d: dims.d, h: dims.h, r: Math.hypot(dims.w, dims.d) / 2, form: dims.form };
  const targets = (Array.isArray(place.target) ? place.target : [place.target]).map((x) => G.get(x) || G.get("site"));
  const tg = targets[0], side = place.side && place.side !== "C" ? DIRV[place.side] : null, gap = place.gap_m ?? 2;
  // 「在某个地标上面」（桥心楼阁在风雨桥上）：立在它身上——xz 取它的中心，y 由 makeLandmark 取桥面 / 顶面，不和它比挤不挤
  const onTop = place.rel === "above" && tg.group === "landmarks" && tg.vol ? tg : null;
  const nud0 = place.nudge_m && (place.nudge_m[0] || place.nudge_m[1]) ? place.nudge_m.slice(0, 2) : null;
  if (onTop) return { point: nud0 ? P2([onTop.point[0] + nud0[0], onTop.point[1] + nud0[1]]) : P2(onTop.point), ok: true, why: "", rel: place.rel, target: place.target, rank: 0, nudged: nud0, rotation: onTop.vol.rotation_y || 0, size: [own.w, own.h, own.d], span: null, restsOn: onTop.vol };
  let cands = candidates(place.rel, tg, targets, own, side, gap, ctx, owner);
  // 桥：每个候选吸到最近的水线（或谷轴）上，横跨过去
  let water = null;
  if (own.form === "bridge") {
    const lines = tg.line ? [tg] : tg.kind === "valley" && tg.axis ? [{ line: tg.axis, width: 8 }] : ctx.waters.map((w) => ({ line: w.points, width: w.width }));
    if (lines.length) {
      const snapped = [];
      for (const p of cands.length ? cands : [tg.point]) { let best = null; for (const L of lines) { const n = nearestOnLine(p, L.line); if (!best || n.d < best.n.d) best = { n, L }; } if (!snapped.some((s) => dist2(s.p, best.n.p) < 2)) snapped.push({ p: best.n.p, tan: smoothTan(best.L.line, best.n.p), width: best.L.width || 4 }); }
      // 架在两岸之间：桥身垂直于溪，两头各搭上岸 1 m（岸 = between 的两个目标）
      const banks = place.rel === "between" ? targets.filter((x) => x && x.polygon && x.group !== "site").map((x) => x.polygon) : [];
      if (banks.length === 2) for (const s of snapped) {
        const cr = perp(s.tan), hit = (sg) => { for (let d = 0; d <= 90; d += 0.5) { const q = add(s.p, cr, sg * d); if (banks.some((poly) => pointInPolygon(q, poly))) return d; } return null; };
        const dA = hit(-1), dB = hit(1);
        if (dA !== null && dB !== null) { s.p = P2(add(s.p, cr, (dB - dA) / 2)); s.len = dA + dB + 2; }
      }
      water = snapped; cands = snapped.map((s) => s.p);
    }
  }
  if (!cands.length) cands = [tg.point];
  const facingPt = (p) => { const f = place.facing; if (f && DIRV[f]) return add(p, DIRV[f], 10); if (f && G.get(f) && f !== owner) return G.get(f).point; return owner === "spawn" ? null : ctx.spawnPt || ctx.provisionalSpawn(); };
  const scored = cands.slice(0, 48).map((p0, rank) => {
    const p = P2(p0), why = [];
    let s = rank * 0.05;
    let rotation = 0, size = [own.w, own.h, own.d];
    if (water) { const wd = water[rank] || water[0]; size = [Math.max(own.w, wd.width + 8, wd.len || 0), own.h, own.d]; const cr = perp(wd.tan); rotation = r2((((Math.atan2(-cr[1], cr[0]) * 180) / Math.PI) + 360) % 360); } // 局部 +x（桥长）沿横跨方向
    else { const fp = facingPt(p); if (fp && dist2(p, fp) > 1e-6) rotation = rotationToward(p, fp); }
    const rect = boxCorners([p[0], 0, p[1]], size, rotation);
    if (rect.some(([x, z]) => Math.abs(x) > ctx.half - 1 || Math.abs(z) > ctx.half - 1)) { s += 1000; why.push("出了场地"); }
    if (!FLEX_FORMS.has(own.form) && !water) {
      const hs = [...rect, p].map(([x, z]) => T.heightAt(x, z)), range = Math.max(...hs) - Math.min(...hs);
      if (range > (own.form === "spawn" ? 2 : 1.2)) { s += 2 + range; why.push(`地面不平（高差 ${r2(range)} m）`); }
    }
    for (const w of ctx.waters) if (!water && rectToPolylineDist(rect, w.points) < w.width / 2 + 1.5) { s += 50; why.push(`压到${w.label || "水"}`); }
    for (const o of ctx.placed) if (o.id !== owner && rectToRectDist(rect, o.rect) < 2) { s += 80; why.push(`和 ${(G.get(o.id) || {}).label || o.id} 挤在一起`); }
    for (const g of ctx.G.values()) if (g.group === "paths" && !g.prelim && !(place.rel === "end_of" && g.id === tg.id) && rectToPolylineDist(rect, g.line) < g.width / 2 + 0.5) { s += 30; why.push(`压到 ${g.label || "路"}`); }
    return { p, s, rank, why, rect, rotation, size };
  });
  // 关系：只对前 24 名算（视线较贵）
  const rels = (ctx.plan.relations || []).filter((r) => r.a === owner || r.b === owner);
  if (owner === "spawn" && ctx.plan.spawn.look_at && G.get(ctx.plan.spawn.look_at)) rels.push({ type: "visible_from", a: ctx.plan.spawn.look_at, b: "spawn", implicit: true });
  if (rels.length) {
    const top = stableSort(scored, (c) => c.s).slice(0, 24);
    for (const c of top) for (const r of rels) { const ok = relHolds(r, owner, c, own, ctx); if (ok === false) { c.s += r.implicit ? 1 : 2; c.why.push((REL_TEXT[r.type] || (() => r.type))((G.get(r.a) || {}).label || (r.a === owner ? "它" : r.a), (G.get(r.b) || {}).label || r.b, (G.get(r.c) || {}).label || "") + " 不成立"); } }
  }
  const best = stableSort(scored, (c) => c.s)[0];
  let point = best.p;
  const nud = place.nudge_m && (place.nudge_m[0] || place.nudge_m[1]) ? place.nudge_m.slice(0, 2) : null;
  if (nud) point = P2([clamp(point[0] + nud[0], -ctx.half + 1, ctx.half - 1), clamp(point[1] + nud[1], -ctx.half + 1, ctx.half - 1)]);
  const degraded = (Array.isArray(place.target) ? place.target : [place.target]).some((x) => !G.get(x));
  return { point, ok: best.s < 50 && !degraded, why: degraded ? "目标还没生成，放在场地上" : best.why.join("；"), rel: place.rel, target: place.target, rank: best.rank, nudged: nud, rotation: best.rotation, size: best.size, span: water ? { tan: (water[best.rank] || water[0]).tan, width: (water[best.rank] || water[0]).width } : null };
}

/** 关系在候选位置上是否成立（另一端还没落位时返回 null，不计） */
function relHolds(r, owner, c, own, ctx) {
  // 另一端是还没落位的入口时，用它的预定位置（入口随后会再挑一个看得见的点）
  const { G, T } = ctx, other = (k) => (r[k] === owner ? { point: c.p, top_y: T.heightAt(c.p[0], c.p[1]) + own.h, rect: c.rect } : G.get(r[k]) && !G.get(r[k]).prelim ? G.get(r[k]) : r[k] === "spawn" ? { point: ctx.provisionalSpawn(), top_y: 1.7 } : null);
  const A = other("a"), B = other("b");
  if (!A || !B) return null;
  switch (r.type) {
    case "visible_from": {
      const vols = ctx.placed.filter((o) => o.vol && o.id !== r.a && o.id !== r.b).map((o) => o.vol);
      const g = T.heightAt(A.point[0], A.point[1]);
      return lineOfSight(T, vols, B.point, A.point, { eye: 1.7, targetHeight: Math.max(1.7, (A.top_y ?? g) - g) }).visible;
    }
    case "adjacent": return dist2(A.point, B.point) <= (A.radius || own.r) + (B.radius || 2) + 10;
    case "far_from": return dist2(A.point, B.point) >= 0.35 * ctx.S;
    case "behind": { const s = ctx.spawnPt; if (!s) return null; const u = unit([B.point[0] - s[0], B.point[1] - s[1]]), v = unit([A.point[0] - B.point[0], A.point[1] - B.point[1]]); return dot(u, v) >= 0.5; }
    case "between": { const C = G.get(r.c); if (!C || r.a !== owner) return null; const u = [C.point[0] - B.point[0], C.point[1] - B.point[1]], L2 = dot(u, u) || 1, t = dot([A.point[0] - B.point[0], A.point[1] - B.point[1]], u) / L2; return t >= 0.1 && t <= 0.9; }
    case "above": return (A.top_y ?? 0) >= (B.top_y ?? 0) - 0.5 || null;
    default: return null;
  }
}

/** 各种 rel 的候选点（按偏好排好序） */
function candidates(rel, tg, targets, own, side, gap, ctx, owner) {
  // 没说哪一侧时朝入口那边（入口还没落位时用它的预定位置）
  const sp = owner !== "spawn" ? ctx.spawnPt || ctx.provisionalSpawn() : null;
  const pref = side || (sp ? unit([sp[0] - tg.point[0], sp[1] - tg.point[1]]) : null);
  switch (rel) {
    case "top_of": return topCands(tg, ctx, own);
    case "center_of": case "under": case "above": return centerCands(tg);
    case "edge_of": return edgeCands(tg, own, pref || DIRV.S, ctx, gap);
    case "end_of": {
      const line = tg.line || tg.axis;
      if (!line) return edgeCands(tg, own, pref || DIRV.N, ctx);
      const ends = [{ p: line[line.length - 1], into: line[line.length - 2] }, { p: line[0], into: line[1] }];
      if (side) ends.sort((a, b) => dot(unit([b.p[0] - tg.point[0], b.p[1] - tg.point[1]]), side) - dot(unit([a.p[0] - tg.point[0], a.p[1] - tg.point[1]]), side));
      const out = [];
      for (const e of ends) { const u = unit([e.into[0] - e.p[0], e.into[1] - e.p[1]]); for (let k = 0; k < 4; k++) out.push(add(e.p, u, own.r + 1 + k * 4)); }
      return out;
    }
    case "beside": case "behind": {
      let base;
      if (rel === "behind") { const s = ctx.spawnPt || ctx.provisionalSpawn(); base = unit([tg.point[0] - s[0], tg.point[1] - s[1]]); if (!base[0] && !base[1]) base = [0, -1]; }
      else base = side || pref || DIRV.S;
      const angs = rel === "behind" ? [0, 20, -20, 40, -40] : [0, 22.5, -22.5, 45, -45, 67.5, -67.5, 90, -90, 112.5, -112.5, 135, -135, 157.5, -157.5, 180];
      const out = [];
      for (const k of rel === "behind" ? [1, 1.3, 1.6, 2, 2.5] : [1, 1.6]) for (const a of angs) { const u = rot(base, a), R = tg.polygon ? support(tg.polygon, tg.point, u) : tg.radius || 2; out.push(add(tg.point, u, (R + gap + own.r) * k)); }
      return out;
    }
    case "between": {
      const A = targets[0].point, B = (targets[1] || ctx.G.get("site")).point, n = unit(perp([B[0] - A[0], B[1] - A[1]])), out = [];
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) for (const o of [0, 5, -5]) out.push(add([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], n, o));
      return out;
    }
    case "along": {
      const line = tg.line || tg.axis || (tg.polygon ? [...tg.polygon, tg.polygon[0]] : null);
      if (!line) return centerCands(tg);
      const off = (tg.width || 2) / 2 + gap + own.d / 2 + 0.5, out = [];
      for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
        const { p, tan } = alongLine(line, f), n = perp(tan), sides = side ? (dot(n, side) >= 0 ? [1, -1] : [-1, 1]) : [1, -1];
        for (const sg of sides) out.push(add(p, n, sg * off));
      }
      return out;
    }
    case "at_entry": {
      const s = ctx.spawnPt || ctx.provisionalSpawn();
      if (owner === "spawn") {
        // 入口在目标的入口处：目标边界上离场地边最近的点再往外 4 m
        const pts = tg.polygon ? boundaryPoints(tg.polygon, 3) : [tg.point];
        return stableSort(pts, (p) => ctx.half - Math.max(Math.abs(p[0]), Math.abs(p[1]))).slice(0, 24).map((p) => add(p, unit([p[0] - tg.point[0], p[1] - tg.point[1]]), 4));
      }
      if (tg.group === "site") { const u = unit([-s[0], -s[1]]), n = perp(u), out = []; for (const d of [10, 14, 18, 22, 26]) for (const o of [0, 4, -4]) out.push(add(add(s, u, d), n, o)); return out; }
      const b = tg.polygon ? boundaryPoints(tg.polygon, 2).reduce((m, p) => (dist2(p, s) < dist2(m, s) ? p : m)) : tg.point;
      const u = unit([s[0] - b[0], s[1] - b[1]]), n = perp(u), out = [];
      for (const d of [own.r + 2, own.r + 5, own.r + 8, -own.r - 1]) for (const o of [0, 4, -4]) out.push(add(add(b, u, d), n, o));
      return out;
    }
    default: return centerCands(tg);
  }
}
function centerCands(tg) {
  if (tg.line && !tg.polygon) { const out = []; for (const f of [0.5, 0.45, 0.55, 0.4, 0.6, 0.3, 0.7]) out.push(alongLine(tg.line, f).p); return out; }
  const poly = tg.polygon;
  let c = tg.point;
  if (poly && !pointInPolygon(c, poly)) c = deepPoint(poly);
  const out = [c];
  for (const r of [3, 6, 9, 12]) for (let k = 0; k < 8; k++) { const q = add(c, rot([0, -1], k * 45), r); if (!poly || pointInPolygon(q, poly)) out.push(q); }
  return out;
}
function topCands(tg, ctx, own) {
  const { T } = ctx;
  const terr = tg.terraces && tg.terraces.length ? tg.terraces : tg.group === "site" ? T.terraces : [];
  if (terr.length) {
    const hmax = Math.max(...terr.map((t) => t.height)), tops = terr.filter((t) => t.height >= hmax - 1e-6);
    const pts = [];
    for (const t of tops) for (const q of gridIn(t.polygon, 2.5)) { const at = T.terraceAt(q.p[0], q.p[1]); if (at && at.id === t.id && q.d >= Math.min(own.r * 0.5, 3)) pts.push(q); }
    if (pts.length) { const c = tg.point; return stableSort(pts, (q) => -Math.round(q.d * 2) / 2 + dist2(q.p, c) * 0.01).slice(0, 40).map((q) => q.p); } // 最靠里、同样靠里时离中心近
  }
  const poly = tg.polygon || (tg.group === "site" ? ctx.sitePoly : null);
  if (!poly) return [tg.point];
  return stableSort(gridIn(poly, 3).map((q) => q.p), (p) => -T.heightAt(p[0], p[1])).slice(0, 40);
}
function edgeCands(tg, own, pref, ctx, gap = 2) {
  // 沿每条「朝外」的边取点（环台内圈、缝都是朝里的，不算），往里收半个进深；按外法线与偏好方向的一致程度排序。
  // 目标是地标（一栋楼 / 一座桥）时放在它外面，隔 gap_m
  const poly = tg.polygon || ctx.sitePoly, c = tg.point, out = [];
  const inset = tg.group === "site" ? own.r + 4 : tg.group === "landmarks" ? -(own.r + Math.max(1, gap)) : own.d / 2 + 1.5;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = dist2(a, b);
    if (L < 1e-6) continue;
    let n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInPolygon(add(mid, n, 0.3), poly)) n = [-n[0], -n[1]];
    if (dot([mid[0] - c[0], mid[1] - c[1]], n) <= 1e-6) continue;
    const k = Math.max(1, Math.round(L / 2.5));
    for (let j = 0; j < k; j++) { const t = (j + 0.5) / k, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; out.push({ q: add(p, n, -inset), a: dot(n, pref) + 0.3 * dot(unit([p[0] - c[0], p[1] - c[1]]), pref) }); }
  }
  return stableSort(out, (o) => -o.a).slice(0, 40).map((o) => o.q);
}

/** 落位结果 → SID 体块（地标） */
function makeLandmark(l, res, ctx, sidId) {
  const { T } = ctx, p = res.point;
  const size = res.size ? res.size.map(r2) : l.size_m.map(r2);
  const v = { id: sidId(l.id), plan_id: l.id, kind: FORM_KIND[l.form] || "building", shape: FORM_SHAPE[l.form] || "box", position: [p[0], 0, p[1]], size, rotation_y: r2(res.rotation || 0), label: l.label, importance: "landmark", color_role: FORM_COLOR[l.form] || "roof", form: l.form, roof: l.roof, floors: l.floors };
  if (res.restsOn) {
    // 立在别的地标身上：桥 → 桥面，其它 → 顶面
    const b = res.restsOn;
    v.position[1] = r2(b.form === "bridge" ? b.position[1] : b.position[1] + b.size[1]);
    v.rests_on = b.id;
  } else if (l.form === "bridge" && res.span) {
    // 桥面高 = 两头地面的高者；两头 [x,z] 记在 _span 里给路用
    const ax = perp(res.span.tan), hl = size[0] / 2, e0 = P2(add(p, ax, -hl)), e1 = P2(add(p, ax, hl));
    v.position[1] = r2(Math.max(T.heightAt(e0[0], e0[1]), T.heightAt(e1[0], e1[1])));
    v.span_ends = [e0, e1];
  } else if (l.form === "stilt_house") {
    const hs = boxCorners(v.position, size, v.rotation_y).map(([x, z]) => T.heightAt(x, z));
    v.position[1] = r2(Math.max(...hs)); v.stilt_m = r2(Math.max(...hs) - Math.min(...hs));
  } else v.position[1] = r2(T.heightAt(p[0], p[1]));
  if (res.nudged) v.user_moved = true;
  return v;
}

/** 路的节点 → 一到两个点（桥：两头；中途的门：门前门后；地标：门前；区域 / 地形：里面离前一点近的地方；水 / 路：最近点） */
function nodePoints(n, prev, next, first, last, G, T, sid) {
  const g = G.get(n) || G.get("site"), ref = prev || next || [0, 0];
  if (g.kind === "landmark" && g.vol) {
    const v = g.vol, c = g.point;
    if (v.form === "bridge" && v.span_ends) {
      // 从近前一点的那头上桥、从靠下一点的那头下桥（两头都等距时看下一点）
      const [e0, e1] = v.span_ends, cost = (x, y) => (prev ? dist2(prev, x) : 0) + (next ? dist2(y, next) : 0);
      const a = cost(e0, e1) <= cost(e1, e0) ? [e0, e1] : [e1, e0];       return first ? [{ p: a[1], id: n }] : last ? [{ p: a[0], id: n }] : a.map((p) => ({ p, id: n, inner: true }));
    }
    if (v.form === "gate" && !first && !last) { const t = (v.rotation_y * Math.PI) / 180, f = [-Math.sin(t), -Math.cos(t)], k = v.size[2] / 2 + 1.5; return [{ p: P2(add(c, f, k)), id: n, inner: true }, { p: P2(add(c, f, -k)), id: n, inner: true }]; }
    return [{ p: landmarkDoor(v, first ? next || ref : ref, T), id: n }];
  }
  if (g.kind === "spawn") return [{ p: g.point.slice(), id: n }];
  if (g.line) return [{ p: P2(nearestOnLine(ref, g.line).p), id: n }];
  if (g.group === "zones" && g.polygons && g.polygons.length) {
    let best = null;
    for (const poly of g.polygons) { const q = deepPoint(poly, 3); if (!best || dist2(q, ref) < dist2(best, ref)) best = q; }
    return [{ p: P2(best), id: n }];
  }
  if (g.terraces && g.terraces.length) { const top = g.terraces.reduce((m, t) => (t.height > m.height ? t : m)); return [{ p: P2(deepPoint(top.polygon, 2.5)), id: n }]; }
  if (g.group === "terrain" && g.polygon && ["hill", "ridge"].includes(g.kind)) return [{ p: P2(g.point), id: n }];
  if (g.polygon && g.group !== "site") { const q = pointInPolygon(g.point, g.polygon) ? g.point : deepPoint(g.polygon); return [{ p: P2(q), id: n }]; }
  return [{ p: P2(g.point), id: n }];
}

/** 一段路按 style 路由 */
function routeSeg(T, a, b, style, avoid, seed, wet) {
  if (style === "straight" || style === "bridge" || style === "tunnel") return { points: [a, b] };
  if (style === "zigzag") { const climb = Math.abs(T.heightAt(b[0], b[1]) - T.heightAt(a[0], a[1])); return { points: zigzagTrail(T, a, b, { folds: Math.max(2, Math.round(climb / (2 * T.layer))), maxSlope: 0.7 }).points }; }
  const maxSlope = style === "stairs" ? 1.2 : 0.7;
  let r = routeTrail(T, a, b, { maxSlope, res: 2, avoidPolys: avoid, seed, wet, maxPoints: 24 });
  if (!r.points) r = routeTrail(T, a, b, { maxSlope, res: 2, seed, wet, maxPoints: 24 });
  // 石阶可以直上（崖边寨门那种）：绕不上去、或绕了两倍多远时直接凿一段
  if (style === "stairs" && (!r.points || r.facts.length_m > 2.2 * dist2(a, b) + 10)) return { points: [a, b], fallback: r.points ? null : "直上石阶" };
  if (r.points) return { points: r.points };
  return { points: zigzagTrail(T, a, b, { folds: 3, maxSlope }).points, fallback: r.facts.reason || "不可达" };
}

// ------------------------------------------------------------ resolveTarget（编译后按 plan id 找几何）
/**
 * 编译后按 plan id 找几何：{ point, polygon, top_y, base_y, kind, label, sid_ids }；找不到 null。界面高亮、空间重算用。
 * @param {object} sid
 * @param {object} T
 * @param {string} id plan 元素 id / "spawn" / "site"
 */
export function resolveTarget(sid, T, id) {
  if (id === "site") { const b = sid.bounds; return { point: [0, 0], polygon: [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]], top_y: 0, base_y: 0, kind: "site", label: "场地", sid_ids: [] }; }
  const g = planGeo(sid, T, id);
  if (!g) return null;
  const kind = id === "spawn" ? "spawn" : (sid.volumes || []).some((v) => v.importance === "landmark" && v.plan_id === id) ? "landmark" : (sid.spaces || []).some((s) => s.plan_id === id) ? "space" : (sid.regions || []).some((r) => r.plan_id === id) ? "zone" : (sid.paths || []).some((p) => p.plan_id === id) ? "path" : "terrain";
  return { point: g.point, polygon: g.polygon, top_y: g.top, base_y: g.base, kind, label: g.label, sid_ids: g.sid_ids };
}

/**
 * 地形块在图上拖到 point 之后，反算它的 at（方向吸附到 8 个方位，离中心不到 3 m 算「中」）：给界面写回 plan 用。
 * @param {object} sid 编译结果
 * @param {object} T
 * @param {object} plan
 * @param {string} id 地形块 id
 * @param {number[]} point 新中心 [x, z]
 * @returns {{of: string, dir: string, dist: number}|null}
 */
export function atFromPoint(sid, T, plan, id, point) {
  const t = (plan.terrain || []).find((x) => x.id === id);
  if (!t) return null;
  const of = (t.at && t.at.of) || "site", g = of === "site" ? null : resolveTarget(sid, T, of);
  const c = g ? g.point : [0, 0], v = [point[0] - c[0], point[1] - c[1]], L = Math.hypot(v[0], v[1]);
  if (L < 3) return { of, dir: "C", dist: 0 };
  const a = (Math.atan2(v[0], -v[1]) * 180) / Math.PI, dir = DIR_NAMES[((Math.round(a / 45) % 8) + 8) % 8];
  const reach = g && g.polygon ? support(g.polygon, c, DIRV[dir]) : ((plan.site && plan.site.size_m) || 140) / 2;
  return { of, dir, dist: r2(clamp(L / Math.max(reach, 1), 0, 1.5)) };
}

// ------------------------------------------------------------ applyOps
const GROUP_OF_DEF = Object.fromEntries(PLAN_GROUPS.filter((g) => g.def).map((g) => [g.key, g.def]));
/** 按 field 路径（a.b.c）在 schema 里找定义；找不到返回 null */
function fieldDef(def, path) {
  let d = deref(def);
  for (const seg of path.split(".")) {
    if (!d || !d.properties || !(seg in d.properties)) return null;
    d = deref(d.properties[seg]);
  }
  return d;
}
function findEl(plan, id) {
  if (id === "site") return { def: DEFS.site, obj: (plan.site = plan.site || {}) };
  if (id === "spawn") return { def: DEFS.spawn, obj: (plan.spawn = plan.spawn || {}) };
  if (id === "lighting") return { def: DEFS.lighting, obj: (plan.lighting = plan.lighting || {}) };
  if (id === "plan") return { def: { properties: Object.fromEntries(["name", "one_liner", "mood", "palette", "lighting", "locks"].map((k) => [k, PLAN_SCHEMA.properties[k]])) }, obj: plan };
  for (const g of ARRAY_GROUPS) { const i = (plan[g] || []).findIndex((e) => e && e.id === id); if (i >= 0) return { def: DEFS[GROUP_OF_DEF[g]], obj: plan[g][i], group: g, index: i }; }
  return null;
}
/**
 * 应用 plan 的改动（AI revise 的 ops，或界面的本地改动）：set（字段可嵌套，如 place.rel；value 为 null 表示删掉该字段）/ add（按组）/ remove（引用它的本地降级）。
 * 不合法的 op 跳过并提一句；最后整体 normalizePlan。不改入参。
 * @param {object} plan
 * @param {object[]} ops
 * @returns {{plan: object, warnings: string[]}}
 */
export function applyOps(plan, ops) {
  const p = clone(plan) || {}, warnings = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isObj(op)) continue;
    if (op.op === "set") {
      const f = findEl(p, op.id);
      if (!f) { warnings.push(`要改的「${op.id}」不存在，跳过`); continue; }
      const field = String(op.field || "");
      if (!field || field === "id" || !fieldDef(f.def, field)) { warnings.push(`「${op.id}」没有「${field}」这个字段，跳过`); continue; }
      const segs = field.split("."), last = segs.pop();
      let o = f.obj;
      for (const sg of segs) { if (!isObj(o[sg])) o[sg] = {}; o = o[sg]; }
      if (op.value === null || op.value === undefined) delete o[last]; else o[last] = clone(op.value);
      if (f.group && last === TYPE_FIELD[f.group]) fillDefaults(f.obj, (XD[f.group] || {})[op.value]); // 换种类时补上新种类的默认值
    } else if (op.op === "add") {
      if (!ARRAY_GROUPS.includes(op.group) || !isObj(op.value)) { warnings.push(`不能往「${op.group}」里加`); continue; }
      p[op.group] = Array.isArray(p[op.group]) ? p[op.group] : [];
      p[op.group].push(clone(op.value));
    } else if (op.op === "remove") {
      const m = /^rel:(\d+)$/.exec(String(op.id));
      if (m) { const i = Number(m[1]); if (p.relations && p.relations[i]) p.relations.splice(i, 1); else warnings.push(`没有第 ${i} 条关系`); continue; }
      if (op.id === "spawn") { delete p.spawn; continue; }
      const f = findEl(p, op.id);
      if (!f || !f.group) { warnings.push(`要删的「${op.id}」不存在`); continue; }
      p[f.group].splice(f.index, 1);
      if (Array.isArray(p.locks)) p.locks = p.locks.filter((x) => x !== op.id);
    } else warnings.push(`不认识的操作「${op.op}」`);
  }
  const n = normalizePlan(p);
  return { plan: n.plan, warnings: warnings.concat(n.warnings) };
}

// ------------------------------------------------------------ 旋钮（从 schema + x-ui 生成）
const groupDefOf = (group, schema) => {
  if (group === "site") return schema.definitions.site;
  if (group === "spawn") return schema.definitions.spawn;
  if (group === "look") return { properties: { lighting: schema.properties.lighting, palette: schema.properties.palette, mood: schema.properties.mood } };
  const g = (schema["x-groups"] || []).find((x) => x.key === group);
  return g && g.def ? schema.definitions[g.def] : null;
};
const whenOk = (when, el) => !when || Object.keys(when).every((k) => when[k].includes(el && el[k]));
const getPath = (o, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
function refOptions(groups, plan, selfId, dirs) {
  const out = [];
  for (const g of groups || []) {
    if (g === "site") out.push({ value: "site", label: "场地", group: "site" });
    else if (g === "spawn") out.push({ value: "spawn", label: (plan && plan.spawn && plan.spawn.label) || "出生点", group: "spawn" });
    else for (const e of (plan && plan[g]) || []) if (e.id !== selfId) out.push({ value: e.id, label: e.label || e.id, group: g });
  }
  if (dirs) for (const d of DIR_NAMES) out.push({ value: d, label: `朝${DIR_LABEL[d]}`, group: "dir" });
  return out;
}
/**
 * 某一项的旋钮定义（界面据此生成控件）。只出 schema 里带 x-ui 且没 hidden 的字段；x-ui.when 不满足的不出；嵌套对象（at / place / connect / lighting）展开成带前缀的路径。
 * @param {string} group "terrain" | "zones" | "buildings" | "landmarks" | "paths" | "water" | "spaces" | "relations" | "site" | "spawn" | "look"
 * @param {object} element 这一项（look 组传整个 plan）
 * @param {object} [schema=PLAN_SCHEMA]
 * @param {object} [plan] 给了就填引用的可选项
 * @returns {{path: string, key: string, label: string, section: string|null, kind: string, value: any, default?: any, min?: number, max?: number, step?: number, unit?: string, parts?: string[], options?: {value: any, label: string, group?: string}[], ref?: string[], hint?: string, summary?: boolean, short?: string}[]}
 */
export function knobsFor(group, element, schema = PLAN_SCHEMA, plan = null) {
  const def = groupDefOf(group, schema), out = [];
  if (!def) return out;
  const el = element || {};
  const walk = (d, path, section, holder) => {
    for (const [k, p0] of Object.entries(d.properties || {})) {
      const p = deref(p0, schema), ui = p["x-ui"] || {};
      if (ui.hidden || !whenOk(ui.when, holder)) continue;
      const fp = path ? `${path}.${k}` : k;
      if (!ui.kind && p.properties) { walk(p, fp, ui.label || k, getPath(el, fp) || {}); continue; }
      if (!ui.kind) continue;
      const knob = { path: fp, key: k, label: ui.label || k, section, kind: ui.kind, value: clone(getPath(el, fp)) };
      if (p.default !== undefined) knob.default = p.default;
      for (const key of ["step", "unit", "hint", "summary", "short", "parts"]) if (ui[key] !== undefined) knob[key] = ui[key];
      const num = p.oneOf ? null : p.type === "array" ? deref(p.items || {}, schema) : p;
      if (num && (num.type === "number" || num.type === "integer")) { knob.min = ui.min ?? num.minimum; knob.max = ui.max ?? num.maximum; if (num.type === "integer" && knob.step === undefined) knob.step = 1; }
      if (ui.kind === "enum" || ui.kind === "dir") {
        const enumVals = p.enum || (p.oneOf ? (deref(p.oneOf[0], schema).enum || []) : []) || [];
        const labels = ui.options || {};
        knob.options = (enumVals.length ? enumVals : Object.keys(labels)).map((v) => ({ value: v, label: labels[v] || v }));
      }
      if (ui.kind === "ref" || ui.kind === "refs") { knob.ref = ui.ref || []; knob.options = refOptions(ui.ref, plan, el.id, !!ui.dirs); }
      out.push(knob);
    }
  };
  walk(def, "", null, el);
  return out;
}
/**
 * 清单一行的关键值：「环台 · 5 级 · 从 1 层起」。只取 x-ui.summary 的字段，按 x-ui.short 格式化（{v} 值、{o} 枚举中文、{r} 引用的名字、{v0} {v1} {v2} 数组分量）。
 * @returns {string}
 */
export function summarize(group, element, plan = null, schema = PLAN_SCHEMA) {
  const el = element || {}, parts = [];
  if (el.label) parts.push(el.label);
  for (const k of knobsFor(group, el, schema, plan)) {
    if (!k.summary || k.value === undefined || k.value === null || k.value === "") continue;
    const v = k.value, lab = (x) => { const o = (k.options || []).find((q) => q.value === x); return o ? o.label : x; };
    const named = Array.isArray(v) ? v.map(lab).join(" 和 ") : lab(v); // between 的两个目标也显示名字，不显示 id
    const s = (k.short || "{v}").replace(/\{v(\d)\}/g, (_, i) => (Array.isArray(v) ? v[i] : v)).replace("{v}", Array.isArray(v) ? v.join("/") : v).replace("{o}", named).replace("{r}", named);
    parts.push(s);
  }
  return parts.join(" · ");
}
/**
 * 「＋ 加一个」：按 type 的默认值造一项（id 唯一、名字是默认名），引用指向 plan 里已有的东西。
 * @param {string} group
 * @param {string} [type] 该组的 type / form / use / style / layout；省略用组里第一种
 * @param {object} [plan]
 * @returns {object}
 */
export function newElement(group, type, plan = {}) {
  const g = PLAN_GROUPS.find((x) => x.key === group);
  if (!g || !g.def) return null;
  const tf = g.type_field, enums = deref(DEFS[g.def].properties[tf]).enum || [];
  const t = enums.includes(type) ? type : enums[0];
  const taken = new Set(ID_GROUPS.flatMap((k) => (plan[k] || []).map((e) => e.id)));
  const base = group === "relations" ? null : `${t}`.replace(/_.*/, "") || ID_PREFIX[group];
  let id = base; for (let k = 2; id && (taken.has(id) || RESERVED.has(id)); k++) id = `${base}_${k}`;
  const el = Object.assign(group === "relations" ? {} : { id }, { [tf]: t }, clone((XD[group] || {})[t]) || {});
  const firstLm = (plan.landmarks || [])[0], firstT = (plan.terrain || [])[0];
  if (group === "terrain") el.at = { of: "site", dir: "C", dist: 0 };
  if (group === "zones") Object.assign(el, { on: firstT ? firstT.id : "site", levels: "all" });
  if (group === "paths") Object.assign(el, { from: "spawn", to: firstLm ? firstLm.id : firstT ? firstT.id : "site" });
  if (group === "water" && t !== "pond") Object.assign(el, { from: { of: "site", dir: "N", dist: 1 }, to: { of: "site", dir: "S", dist: 1 } });
  if (group === "water" && t === "pond") el.at = { of: "site", dir: "C", dist: 0 };
  if (group === "spaces") Object.assign(el, { stratum: "underground", under: firstLm ? firstLm.id : "site", depth_layers: 2, connect: { via: "stairs" } });
  if (group === "relations") Object.assign(el, { a: firstLm ? firstLm.id : firstT ? firstT.id : "spawn", b: "spawn" });
  return el;
}

// ------------------------------------------------------------ 换一批：按 plan 结构算差异
function bag(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }
function bagDist(a, b) {
  const A = bag(a), B = bag(b);
  let inter = 0, uni = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) { inter += Math.min(A.get(k) || 0, B.get(k) || 0); uni += Math.max(A.get(k) || 0, B.get(k) || 0); }
  return uni ? 1 - inter / uni : 0;
}
/**
 * 两个 plan 的结构差异（不编译，只看构成）：地形种类、地标 / 建筑形制、空间布局、区域用途、路的走法、水、总高差、场地大小、时段、入口方向。
 * 同一个 plan 为 0；三张卡两两 ≥ 1 算「够不一样」。
 * @returns {number}
 */
export function planDistance(a, b) {
  const sig = (p) => ({
    terrain: (p.terrain || []).map((t) => t.type), forms: [...(p.landmarks || []).map((l) => "l:" + l.form), ...(p.buildings || []).map((x) => "b:" + x.form)],
    spaces: (p.spaces || []).map((s) => s.layout), zones: (p.zones || []).map((z) => z.use), styles: (p.paths || []).map((x) => x.style || "winding"), water: (p.water || []).map((w) => w.type),
    relief: (p.site && p.site.relief_layers) || 5, size: (p.site && p.site.size_m) || 140, tod: (p.lighting && p.lighting.time_of_day) || "dusk",
    side: (p.spawn && p.spawn.place && p.spawn.place.side) || "S",
  });
  const A = sig(a || {}), B = sig(b || {});
  return r2(bagDist(A.terrain, B.terrain) * 1.2 + bagDist(A.forms, B.forms) * 0.8 + bagDist(A.spaces, B.spaces) * 0.6 + bagDist(A.zones, B.zones) * 0.4 + bagDist(A.styles, B.styles) * 0.3 + bagDist(A.water, B.water) * 0.5
    + Math.abs(A.relief - B.relief) / 4 + Math.abs(A.size - B.size) / 80 + (A.tod !== B.tod ? 0.2 : 0) + (A.side !== B.side ? 0.2 : 0) + Math.abs(A.terrain.length - B.terrain.length) / 5);
}
/** 一组 plan 是否两两都够不一样（planDistance ≥ threshold） */
export function distinctPlans(plans, threshold = 1) {
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) if (planDistance(plans[i], plans[j]) < threshold) return false;
  return true;
}
