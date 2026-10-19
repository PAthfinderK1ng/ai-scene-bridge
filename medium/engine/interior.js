// interior.js — 地下 / 空中空间（v4，docs/05 §4、docs/04 §8）：把构成图的 spaces 编译成外轮廓、高度、
// 内部布局（迷宫 / 矿道 / 厅堂 / 洞穴网 / 房间图 / 单室 / 地道）、连接点，并给出检查与剖面要用的事实。吸收原 strata.js。
// 铁律：plan 里没有坐标——位置只来自 under / over 目标（resolveTarget）+ 人拖过的 offset_m；随机只来自 seed / layout_seed。
// 纯函数、确定性；不调 AI。
import { rng, clamp, r2, pointInPolygon, distToPolygon, distToSegment, polygonCentroid, polygonRadius, DEFAULT_BOUNDS } from "./terrain.js";

// ============================================================ 词表
export const STRATA = Object.freeze(["underground", "sky"]);
export const STRATUM_LABEL = Object.freeze({ ground: "地面", underground: "地下", sky: "空中" });
/** 每层允许的内部布局（空中没有迷宫 / 矿道 / 厅堂） */
export const INTERIOR_LAYOUTS = Object.freeze({
  underground: Object.freeze(["chamber", "corridor", "maze", "galleries", "halls", "network", "rooms"]),
  sky: Object.freeze(["chamber", "corridor", "network", "rooms"]),
});
export const LAYOUT_LABEL = Object.freeze({ chamber: "单室", corridor: "地道", maze: "迷宫", galleries: "矿道", halls: "厅堂", network: "洞穴网", rooms: "房间图" });
export const SKY_LAYOUT_LABEL = Object.freeze({ chamber: "平台", corridor: "栈道", network: "平台群", rooms: "房间图" });
/** SID 的 space.kind 由布局推出（给旧视图 / 导出用的种类名） */
export const LAYOUT_KIND = Object.freeze({
  underground: Object.freeze({ chamber: "cellar", corridor: "tunnel", maze: "maze", galleries: "mine", halls: "crypt", network: "cave", rooms: "crypt" }),
  sky: Object.freeze({ chamber: "platform", corridor: "walkway", network: "platform", rooms: "platform" }),
});
export const SPACE_LABEL = Object.freeze({ cave: "溶洞", tunnel: "地道", cellar: "地窖", crypt: "地宫", maze: "迷宫", mine: "矿洞", platform: "平台", walkway: "栈道", island: "浮岛", bridge: "天桥" });
/** 地面 ↔ 空间的连接方式 */
export const CONNECTOR_VIA = Object.freeze(["stairs", "ladder", "well", "shaft", "elevator", "rope_bridge", "ramp"]);
/** 空间内部层间的连接方式 */
export const LINK_VIA = Object.freeze(["ladder", "ramp", "winze", "stairs"]);
export const VIA_LABEL = Object.freeze({ stairs: "楼梯", ladder: "梯子", well: "井", shaft: "竖井", elevator: "升降台", rope_bridge: "索桥", ramp: "坡道", winze: "暗井", walkway: "栈道" });
export const BRANCHING = Object.freeze(["low", "medium", "high"]);
export const BRANCHING_LABEL = Object.freeze({ low: "少", medium: "中", high: "多" });
/** 迷宫按 branching 打通的死路比例 */
export const MAZE_OPEN = Object.freeze({ low: 0, medium: 0.15, high: 0.35 });
/** rooms 布局的房间边长（米） */
export const ROOM_SIZES = Object.freeze({ s: 6, m: 10, l: 16 });
export const ROOM_ROLES = Object.freeze(["entry", "goal", "stope", "hall", "side", "chamber", "named"]);
export const ROLE_LABEL = Object.freeze({ entry: "入口", goal: "终点室", stope: "采场", hall: "厅", side: "耳室", chamber: "小室", named: "房间" });
/** 地下顶板到地面的最小岩层、空中板底到地面的最小净空、空中板厚、地下层间岩层（米） */
export const CLEARANCE = Object.freeze({ rock: 2, air: 3, slab: 1 });
export const LIMITS = Object.freeze({ size_m: [6, 200], corridor_m: [1.5, 6], sublevels: [1, 3], layers: [1, 8], height_m: [2.2, 12], rooms: 16 });
export const DEFAULTS = Object.freeze({
  size_m: Object.freeze({ chamber: 14, corridor: 28, maze: 36, galleries: 40, halls: 34, network: 36, rooms: 30 }),
  corridor_m: Object.freeze({ maze: 2.5, rooms: 2.5, chamber: 3, corridor: 3, galleries: 3, halls: 3, network: 3 }),
  height_m: Object.freeze({ chamber: 5, corridor: 3, maze: 3, galleries: 3, halls: 5, network: 5, rooms: 4, sky: 4 }),
  via: Object.freeze({ chamber: "ladder", corridor: "ramp", maze: "stairs", galleries: "shaft", halls: "stairs", network: "stairs", rooms: "stairs", sky: "stairs" }),
  link_via: Object.freeze({ chamber: "stairs", corridor: "ramp", maze: "ladder", galleries: "winze", halls: "stairs", network: "ramp", rooms: "stairs" }),
  depth_layers: 2, height_layers: 3, branching: "medium", sublevels: 1,
});
/** 词表合集（界面 / 后端一次拿全） */
export const SPACE = Object.freeze({ STRATA, STRATUM_LABEL, LAYOUTS: INTERIOR_LAYOUTS, LAYOUT_LABEL, SKY_LAYOUT_LABEL, LAYOUT_KIND, SPACE_LABEL, CONNECTOR_VIA, LINK_VIA, VIA_LABEL, BRANCHING, BRANCHING_LABEL, ROOM_SIZES, ROOM_ROLES, ROLE_LABEL, CLEARANCE, LIMITS, DEFAULTS });

// ============================================================ 小工具
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const validPoly = (p) => Array.isArray(p) && p.length >= 3 && p.every(isPt);
const r1 = (v) => Math.round(v * 10) / 10;
const num = (v, d) => (v === null || v === undefined || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d);
const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L < 1e-9 ? null : [v[0] / L, v[1] / L]; };
const rect = (c, w, d) => [[c[0] - w / 2, c[1] - d / 2], [c[0] + w / 2, c[1] - d / 2], [c[0] + w / 2, c[1] + d / 2], [c[0] - w / 2, c[1] + d / 2]];
const polyLen = (pts) => { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += d2(pts[i], pts[i + 1]); return L; };
const boundsCenter = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
const VOLUME_KINDS = new Set(["volume", "landmark", "building", "house"]);
/** 字符串 → 32 位种子（FNV-1a） */
function hashStr(s) { let h = 2166136261; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const sub = (seed, salt) => hashStr((seed >>> 0) + "|" + salt) || 1;
function shuffle(a, rand) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** 空间的内部层数 / 每层净高 / 层距 / 第 s 层底面 / 入口层 / 终点层 */
export function levelsOf(space) { return clamp(Math.round(num(space && space.sublevels, 1)), 1, 3); }
export function levelStep(space) { return (Number(space.height) || 3) + (space.stratum === "sky" ? CLEARANCE.slab : CLEARANCE.rock); }
export function levelFloor(space, s) { return r2((Number(space.floor_y) || 0) + s * levelStep(space)); }
export function entryLevel(space) { return space.stratum === "sky" ? 0 : levelsOf(space) - 1; }
export function goalLevel(space) { return space.stratum === "sky" ? levelsOf(space) - 1 : 0; }

/** 地面范围：多边形内（边每 1 m、内部 2 m 网格）地面的最低 / 最高点 */
export function groundRange(poly, T) {
  let mn = Infinity, mx = -Infinity;
  const take = (x, z) => { const h = T.heightAt(x, z); if (h < mn) mn = h; if (h > mx) mx = h; };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(d2(a, b)));
    for (let k = 0; k < n; k++) take(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  }
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  for (let x = Math.ceil(Math.min(...xs) / 2) * 2; x <= Math.max(...xs); x += 2) for (let z = Math.ceil(Math.min(...zs) / 2) * 2; z <= Math.max(...zs); z += 2) if (pointInPolygon([x, z], poly)) take(x, z);
  return { min: mn, max: mx };
}
/** 通道（折线 + 宽）下的地面最低 / 最高：沿中线每 1 m，中线与两侧边各一个采样 */
function passageGround(p, T) {
  let mn = Infinity, mx = -Infinity;
  const pts = p.points, hw = (Number(p.width) || 2) / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = d2(a, b), n = Math.max(1, Math.ceil(L)), u = unit([b[0] - a[0], b[1] - a[1]]) || [1, 0], nx = -u[1] * hw, nz = u[0] * hw;
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
      for (const [sx, sz] of [[0, 0], [nx, nz], [-nx, -nz]]) { const h = T.heightAt(x + sx, z + sz); if (h < mn) mn = h; if (h > mx) mx = h; }
    }
  }
  if (pts.length === 1) { const h = T.heightAt(pts[0][0], pts[0][1]); mn = mx = h; }
  return { min: mn, max: mx };
}
/** 空间的全部构件（通道 / 房间；老数据没有内部时用外轮廓当一个构件） */
function elementsOf(space) {
  const H = Number(space.height) || 3, out = [];
  for (const p of space.passages || []) if (p && Array.isArray(p.points) && p.points.length >= 2 && p.points.every(isPt)) out.push({ kind: "passage", id: p.id, s: clamp(p.sublevel | 0, 0, 2), h: Number(p.height) > 0 ? p.height : H, ground: (T) => passageGround(p, T) });
  for (const r of space.rooms || []) if (r && validPoly(r.polygon)) out.push({ kind: "room", id: r.id, s: clamp(r.sublevel | 0, 0, 2), h: Number(r.height) > 0 ? r.height : H, ground: (T) => groundRange(r.polygon, T) });
  if (!out.length && validPoly(space.polygon)) for (let s = 0; s < levelsOf(space); s++) out.push({ kind: "outline", id: space.id, s, h: H, ground: (T) => groundRange(space.polygon, T) });
  return out;
}

// ============================================================ 高度：拟合与净空
/**
 * 合格的第 0 层底面：地下 = 顶板离每个构件上方地面 ≥ 2 m 的最高值；空中 = 板底离每个构件下方地面 ≥ 3 m 的最低值。
 * @returns {number} 0.5 m 取整
 */
export function clearLimit(space, T) {
  const under = space.stratum !== "sky", step = levelStep(space);
  let lim = under ? Infinity : -Infinity;
  for (const e of elementsOf(space)) {
    const g = e.ground(T);
    if (under) lim = Math.min(lim, g.min - CLEARANCE.rock - e.h - e.s * step);
    else lim = Math.max(lim, g.max + CLEARANCE.air + CLEARANCE.slab - e.s * step);
  }
  if (!Number.isFinite(lim)) lim = 0;
  return under ? Math.floor(lim * 2 + 1e-9) / 2 : Math.ceil(lim * 2 - 1e-9) / 2;
}
/**
 * 按规则算第 0 层底面：地下 = 质心处地面 − depth_layers × 层高 − 净高 − (层数 − 1) × 层距（最上层顶板在地面下 depth_layers 层），
 * 再压到 clearLimit 以下（不够就整体下沉）；空中 = 质心处地面 + height_layers × 层高，再抬到 clearLimit 以上。
 */
export function fitFloor(space, T, layer = T.layer) {
  const under = space.stratum !== "sky", c = validPoly(space.polygon) ? polygonCentroid(space.polygon) : [0, 0], ref = T.heightAt(c[0], c[1]);
  const k = clamp(Math.round(num(under ? space.depth_layers : space.height_layers, under ? DEFAULTS.depth_layers : DEFAULTS.height_layers)), 1, 8);
  const lim = clearLimit(space, T), H = Number(space.height) || 3, n = levelsOf(space);
  if (under) return Math.floor(Math.min(ref - k * layer - H - (n - 1) * levelStep(space), lim) * 2 + 1e-9) / 2;
  return Math.ceil(Math.max(ref + k * layer, lim) * 2 - 1e-9) / 2;
}
/** 把空间（含每条通道 / 每个房间）的第 0 层底面设到 floor0。原地修改，返回 space */
export function setSpaceFloor(space, floor0) {
  space.floor_y = r2(floor0);
  for (const p of space.passages || []) if (p) p.floor_y = levelFloor(space, p.sublevel | 0);
  for (const r of space.rooms || []) if (r) r.floor_y = levelFloor(space, r.sublevel | 0);
  return space;
}
/**
 * 空间与地形的净空（覆盖每层每条通道、每个房间）：地下 gap = 构件上方地面最低 − 顶板；空中 gap = 板底 − 构件下方地面最高。
 * @returns {{ok: boolean, gap: number, need: number, limit: number, worst: {kind, id, sublevel}|null}} limit = 合格的第 0 层底面
 */
export function spaceClearance(space, T) {
  const under = space.stratum !== "sky", need = under ? CLEARANCE.rock : CLEARANCE.air;
  let gap = Infinity, worst = null;
  for (const e of elementsOf(space)) {
    const g = e.ground(T), f = levelFloor(space, e.s);
    const v = under ? g.min - (f + e.h) : f - CLEARANCE.slab - g.max;
    if (v < gap) { gap = v; worst = { kind: e.kind, id: e.id, sublevel: e.s }; }
  }
  if (!Number.isFinite(gap)) gap = need;
  return { ok: gap >= need - 1e-6, gap: r2(gap), need, limit: clearLimit(space, T), worst };
}

// ============================================================ 规格（plan 空间 / SID 空间 → 生成参数）
function normRoomGraph(src, warnings, label) {
  const rooms = [], seen = new Set(["entry"]);
  for (const r of Array.isArray(src && src.rooms) ? src.rooms : []) {
    if (rooms.length >= LIMITS.rooms) { warnings.push(`${label}：房间最多 ${LIMITS.rooms} 个，多的丢掉`); break; }
    if (!r || typeof r !== "object") continue;
    let id = String(r.id || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!id || seen.has(id)) id = "room_" + (rooms.length + 1);
    seen.add(id);
    const o = { id, label: typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 16) : id, size: ROOM_SIZES[r.size] ? r.size : "m" };
    if (Number(r.size_m) > 0) o.size_m = clamp(Number(r.size_m), 3, 30);
    rooms.push(o);
  }
  if (!rooms.length) rooms.push({ id: "hall", label: "厅", size: "m" });
  const ids = new Set(["entry", ...rooms.map((r) => r.id)]), links = [], has = new Set();
  for (const l of Array.isArray(src && src.links) ? src.links : []) {
    const a = Array.isArray(l) ? l[0] : l && l.from, b = Array.isArray(l) ? l[1] : l && l.to;
    if (!ids.has(a) || !ids.has(b) || a === b) { if (a || b) warnings.push(`${label}：连线 ${a}—${b} 引用了不存在的房间，丢掉`); continue; }
    const k = a < b ? a + "|" + b : b + "|" + a;
    if (!has.has(k)) { has.add(k); links.push([a, b]); }
  }
  if (!links.some((l) => l.includes("entry"))) links.unshift(["entry", rooms[0].id]);
  // 保证连通：到不了的房间接到前一个房间上
  for (let changed = true; changed;) {
    changed = false;
    const reach = new Set(["entry"]);
    for (let grow = true; grow;) { grow = false; for (const [a, b] of links) { if (reach.has(a) && !reach.has(b)) { reach.add(b); grow = true; } if (reach.has(b) && !reach.has(a)) { reach.add(a); grow = true; } } }
    const lost = rooms.findIndex((r) => !reach.has(r.id));
    if (lost >= 0) { const prev = lost > 0 ? rooms[lost - 1].id : "entry"; links.push([prev, rooms[lost].id]); warnings.push(`${label}：${rooms[lost].label} 没连上，接到 ${prev === "entry" ? "入口" : rooms[lost - 1].label}`); changed = true; }
  }
  return { rooms, links };
}

/** plan 的空间或 SID 的空间 → 生成参数（字段同名：layout / size_m / branching / sublevels / corridor_m …） */
function specOf(src, warnings = []) {
  const stratum = src.stratum === "sky" ? "sky" : "underground";
  const label0 = typeof src.label === "string" && src.label.trim() ? src.label.trim().slice(0, 24) : "";
  const planRooms = Array.isArray(src.rooms) && src.rooms.length && src.rooms.every((r) => r && !Array.isArray(r.polygon)) ? { rooms: src.rooms, links: src.links } : null;
  const graphIn = src.room_graph && Array.isArray(src.room_graph.rooms) ? src.room_graph : planRooms;
  let layout = src.layout;
  if (!INTERIOR_LAYOUTS[stratum].includes(layout)) {
    const fb = graphIn ? "rooms" : stratum === "sky" && ["maze", "galleries", "halls"].includes(layout) ? "network" : "chamber";
    if (layout) warnings.push(`${label0 || src.id}：${STRATUM_LABEL[stratum]}不做「${LAYOUT_LABEL[layout] || layout}」，改成${(stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[fb]}`);
    layout = fb;
  }
  const label = label0 || STRATUM_LABEL[stratum] + (stratum === "sky" ? SKY_LAYOUT_LABEL : LAYOUT_LABEL)[layout];
  const def = DEFAULTS.size_m[layout], sz = src.size_m;
  let W, D;
  if (Array.isArray(sz)) { W = num(sz[0], def); D = num(sz[1], W); }
  else { D = num(sz, def); W = layout === "galleries" ? Math.max(16, Math.round(D * 0.6)) : layout === "corridor" ? 6 : D; }
  if (layout === "corridor" && W > D) [W, D] = [D, W];
  W = clamp(W, LIMITS.size_m[0], LIMITS.size_m[1]); D = clamp(D, LIMITS.size_m[0], LIMITS.size_m[1]);
  if (layout === "galleries") W = Math.max(W, 12);
  let cw = clamp(num(src.corridor_m, DEFAULTS.corridor_m[layout]), LIMITS.corridor_m[0], LIMITS.corridor_m[1]);
  if (layout === "maze" && Math.min(W, D) < cw * 4) cw = Math.max(LIMITS.corridor_m[0], Math.min(W, D) / 4);
  const n = layout === "rooms" ? 1 : clamp(Math.round(num(src.sublevels, 1)), 1, 3);
  if (layout === "rooms" && num(src.sublevels, 1) > 1) warnings.push(`${label}：房间图只排一层`);
  const H = clamp(num(src.height_m, num(src.height, stratum === "sky" ? DEFAULTS.height_m.sky : DEFAULTS.height_m[layout])), LIMITS.height_m[0], LIMITS.height_m[1]);
  const conn = src.connect && typeof src.connect === "object" ? src.connect : { via: src.connect, from: src.connect_from };
  const via = CONNECTOR_VIA.includes(conn.via) ? conn.via : stratum === "sky" ? DEFAULTS.via.sky : DEFAULTS.via[layout];
  const layersKey = stratum === "sky" ? "height_layers" : "depth_layers";
  return {
    stratum, layout, label, W, D, cw, n, H, via, layersKey,
    layers: clamp(Math.round(num(src[layersKey], stratum === "sky" ? DEFAULTS.height_layers : DEFAULTS.depth_layers)), 1, 8),
    branching: BRANCHING.includes(src.branching) ? src.branching : DEFAULTS.branching,
    from: typeof conn.from === "string" && conn.from ? conn.from : null,
    room_graph: layout === "rooms" ? normRoomGraph(graphIn, warnings, label) : null,
    sky: stratum === "sky",
  };
}

// ============================================================ 局部图（生成器的公共结构，局部坐标：入口在 −z 一侧）
function newGraph() { return { nodes: [], edges: [], rooms: [], links: [], entrance: -1, goal: -1, cells: 0, outline: null }; }
const addNode = (g, s, p) => (g.nodes.push({ s, p: [p[0], p[1]] }), g.nodes.length - 1);
const addEdge = (g, a, b, w, mid = [], extra = null) => { g.edges.push(Object.assign({ a, b, w, mid }, extra || {})); };
const addRoom = (g, node, poly, role, label, id) => { g.rooms.push({ node, s: g.nodes[node].s, poly, role, label, id }); };
const edgeLen = (g, e) => polyLen([g.nodes[e.a].p, ...e.mid, g.nodes[e.b].p]);
function edgeDegree(g) { const deg = new Array(g.nodes.length).fill(0); for (const e of g.edges) { deg[e.a]++; deg[e.b]++; } return deg; }
/** Dijkstra（节点 ≤ 几百，O(n²) 足够）；层间连接的代价 = linkCost */
function shortest(g, src, linkCost = 0, scale = 1) {
  const n = g.nodes.length, adj = g.nodes.map(() => []);
  for (const e of g.edges) { const w = edgeLen(g, e) * scale; adj[e.a].push([e.b, w]); adj[e.b].push([e.a, w]); }
  for (const l of g.links) { adj[l.a].push([l.b, linkCost]); adj[l.b].push([l.a, linkCost]); }
  return dijkstra(adj, src);
}
function dijkstra(adj, src) {
  const n = adj.length, dist = new Array(n).fill(Infinity), done = new Uint8Array(n);
  if (src < 0 || src >= n) return dist;
  dist[src] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const [v, w] of adj[u]) if (best + w < dist[v] - 1e-9) dist[v] = best + w;
  }
  return dist;
}
/** 第 s 层离 src 最远的节点（并列取编号小的） */
function farthest(g, src, s) {
  const d = shortest(g, src);
  let best = src, bd = -1;
  g.nodes.forEach((nd, i) => { if (nd.s === s && Number.isFinite(d[i]) && d[i] > bd + 1e-9) { bd = d[i]; best = i; } });
  return best;
}
const roomAt = (g, node) => g.rooms.find((r) => r.node === node) || null;
const lvlId = (sp, base, s) => (sp.n > 1 ? `${base}_${s}` : base);
/** 层的顺序：从入口层到终点层（地下自上而下：n−1 … 0；空中自下而上：0 … n−1） */
const levelSeq = (sp) => { const a = []; for (let s = 0; s < sp.n; s++) a.push(s); return sp.sky ? a : a.reverse(); };

// ------------------------------------------------------------ maze：网格 + 种子化 DFS 生成树 + 按 branching 打通死路
function genMaze(sp, ctx) {
  const g = newGraph(), cs = sp.cw * 2;
  const nx = Math.max(2, Math.floor(sp.W / cs + 1e-9)), nz = Math.max(2, Math.floor(sp.D / cs + 1e-9));
  const at = (k) => [((k % nx) - (nx - 1) / 2) * cs, (Math.floor(k / nx) - (nz - 1) / 2) * cs];
  let ok = []; for (let k = 0; k < nx * nz; k++) ok.push(!ctx.mask || ctx.mask(at(k)));
  const nbAll = (k) => { const i = k % nx, j = Math.floor(k / nx), o = []; if (i > 0) o.push(k - 1); if (i < nx - 1) o.push(k + 1); if (j > 0) o.push(k - nx); if (j < nz - 1) o.push(k + nx); return o; };
  // 只留最大的一块连通格（人拖过外轮廓时可能被切开）
  { const comp = new Array(nx * nz).fill(-1); let best = -1, bestN = 0;
    for (let k = 0; k < nx * nz; k++) { if (!ok[k] || comp[k] >= 0) continue; const st = [k]; comp[k] = k; let c = 0; while (st.length) { const u = st.pop(); c++; for (const v of nbAll(u)) if (ok[v] && comp[v] < 0) { comp[v] = k; st.push(v); } } if (c > bestN) { bestN = c; best = k; } }
    ok = ok.map((v, k) => v && comp[k] === best); }
  const nb = (k) => nbAll(k).filter((q) => ok[q]);
  const cells = []; for (let k = 0; k < nx * nz; k++) if (ok[k]) cells.push(k);
  if (!cells.length) return genChamberFallback(sp, ctx);
  const id = [], cellOf = [];
  for (let s = 0; s < sp.n; s++) { id[s] = new Map(); for (const k of cells) { const n = addNode(g, s, at(k)); id[s].set(k, n); cellOf[n] = k; } }
  g.cells = cells.length * sp.n;
  for (let s = 0; s < sp.n; s++) {
    // 生成树与打通各用自己的随机流：branching 变了，树不变；打通按同一顺序取前 k 个 → 死路数随 branching 单调不增
    const rt = rng(sub(ctx.seed, "maze-tree-" + s)), ro = rng(sub(ctx.seed, "maze-open-" + s));
    const set = new Set(), deg = new Map(cells.map((k) => [k, 0]));
    const key = (a, b) => (a < b ? a + "," + b : b + "," + a);
    const link = (a, b) => { set.add(key(a, b)); deg.set(a, deg.get(a) + 1); deg.set(b, deg.get(b) + 1); };
    const root = cells[Math.floor(rt() * cells.length)], seen = new Set([root]), stack = [root];
    while (stack.length) {
      const cur = stack[stack.length - 1], fr = nb(cur).filter((q) => !seen.has(q));
      if (!fr.length) { stack.pop(); continue; }
      const nxt = fr[Math.floor(rt() * fr.length)];
      link(cur, nxt); seen.add(nxt); stack.push(nxt);
    }
    const dead = shuffle(cells.filter((k) => deg.get(k) === 1), ro);
    const p = MAZE_OPEN[sp.branching], cnt = p > 0 ? Math.ceil(p * dead.length) : 0;
    for (let t = 0; t < cnt; t++) {
      const c = dead[t], cand = nb(c).filter((q) => !set.has(key(c, q)));
      const pick = cand.length ? cand[Math.floor(ro() * cand.length)] : -1;
      if (deg.get(c) === 1 && pick >= 0) link(c, pick);
    }
    for (const k2 of set) { const [a, b] = k2.split(",").map(Number); addEdge(g, id[s].get(a), id[s].get(b), sp.cw); }
  }
  // 入口格：离连接点最近（没给 connect.from 时只在边上的格里挑）；每层走到最远格往下（上）一层，最后一层的最远格是终点室
  const seq = levelSeq(sp), E = seq[0];
  const edge = (k) => nb(k).length < 4 || nbAll(k).length < 4;
  const cand = cells.filter((k) => !ctx.preferBoundary || edge(k));
  let ent = cand[0], bd = Infinity;
  for (const k of cand) { const dd = d2(at(k), ctx.approach); if (dd < bd - 1e-9) { bd = dd; ent = k; } }
  let entNode = id[E].get(ent);
  g.entrance = entNode;
  const linkNodes = new Set();
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i], far = farthest(g, entNode, s);
    if (i + 1 < seq.length) { const nxt = id[seq[i + 1]].get(cellOf[far]); g.links.push({ a: nxt, b: far, via: DEFAULTS.link_via.maze }); linkNodes.add(nxt); linkNodes.add(far); entNode = nxt; }
    else g.goal = far;
  }
  const square = (n, f = 0.9) => rect(g.nodes[n].p, cs * f, cs * f);
  addRoom(g, g.entrance, square(g.entrance), "entry", "入口室", "entry");
  if (g.goal !== g.entrance) addRoom(g, g.goal, square(g.goal), "goal", "终点室", "goal");
  const deg = edgeDegree(g), per = Math.max(1, Math.floor(cells.length / 24));
  let ci = 0;
  for (const s of seq) {
    const rc = rng(sub(ctx.seed, "maze-room-" + s));
    const dead = shuffle([...id[s].values()].filter((n) => deg[n] === 1 && n !== g.entrance && n !== g.goal && !linkNodes.has(n)), rc);
    for (const n of dead.slice(0, per)) addRoom(g, n, square(n, 0.86), "chamber", "小室", `c${s}_${ci++}`);
  }
  if (!ctx.mask) g.outline = rect([0, 0], nx * cs, nz * cs);
  return g;
}
function genChamberFallback(sp, ctx) { return stacked(chamberLevel)(Object.assign({}, sp, { layout: "chamber" }), ctx); }

// ------------------------------------------------------------ galleries（矿道）：主巷沿长轴 + 两侧横巷 + 采场；多层，暗井在主巷端部
function genGalleries(sp, ctx) {
  const g = newGraph(), m = Math.max(2, sp.cw), z0 = -sp.D / 2 + m, z1 = sp.D / 2 - m, reach = Math.max(4, sp.W / 2 - m);
  const cw2 = Math.max(1.5, sp.cw - 0.5), prob = { low: 0.45, medium: 0.7, high: 0.95 }[sp.branching];
  const ends = [];
  let stope = 0;
  for (let s = 0; s < sp.n; s++) {
    const r = rng(sub(ctx.seed, "gal-" + s));
    const zs = [z0];
    for (let z = z0 + 6 + r() * 3; z < z1 - 3; z += 8 + r() * 2) zs.push(z);
    zs.push(z1);
    const main = zs.map((z) => addNode(g, s, [0, z]));
    for (let i = 0; i + 1 < main.length; i++) addEdge(g, main[i], main[i + 1], sp.cw);
    let crosses = 0;
    const cross = (i, side) => {
      const L = Math.max(4, reach * (0.45 + 0.55 * r())), end = addNode(g, s, [side * Math.min(L, reach), zs[i]]);
      addEdge(g, main[i], end, cw2); crosses++;
      if (r() < 0.45) addRoom(g, end, rect(g.nodes[end].p, 6, 5), "stope", "采场", `st${s}_${stope++}`);
    };
    for (let i = 1; i + 1 < zs.length; i++) for (const side of [-1, 1]) if (r() < prob) cross(i, side);
    if (!crosses) cross(Math.max(1, Math.floor(zs.length / 2)), 1);
    ends.push([main[0], main[main.length - 1]]);
  }
  const seq = levelSeq(sp);
  g.entrance = ends[seq[0]][0];
  addRoom(g, g.entrance, rect(g.nodes[g.entrance].p, 5, 5), "entry", "入口", "entry");
  let ent = g.entrance;
  for (let i = 0; i + 1 < seq.length; i++) { const e = i % 2 === 0 ? 1 : 0; g.links.push({ a: ends[seq[i + 1]][e], b: ends[seq[i]][e], via: DEFAULTS.link_via.galleries }); ent = ends[seq[i + 1]][e]; }
  g.goal = farthest(g, ent, seq[seq.length - 1]);
  return g;
}

// ------------------------------------------------------------ 逐层生成 + 层间连接（chamber / corridor / halls / network）
function stacked(levelFn) {
  return (sp, ctx) => {
    const g = newGraph(), seq = levelSeq(sp);
    let target = ctx.approach, upFar = -1;
    for (let i = 0; i < seq.length; i++) {
      const s = seq[i], r = rng(sub(ctx.seed, sp.layout + "-" + s));
      let ent = levelFn(g, sp, s, r, i === 0, target, ctx);
      if (i > 0) { let bd = Infinity; g.nodes.forEach((nd, k) => { if (nd.s === s) { const dd = d2(nd.p, target); if (dd < bd - 1e-9) { bd = dd; ent = k; } } }); }
      let levelEnt = ent;
      if (i === 0) g.entrance = ent;
      else {
        const up = g.nodes[upFar].p;
        if (d2(g.nodes[ent].p, up) > 0.3) { levelEnt = addNode(g, s, up); addEdge(g, levelEnt, ent, sp.cw, [], sp.sky ? { style: "walkway" } : null); }
        g.links.push({ a: levelEnt, b: upFar, via: DEFAULTS.link_via[sp.layout] || "stairs" });
      }
      const far = farthest(g, levelEnt, s);
      if (i + 1 < seq.length) { upFar = far; target = g.nodes[far].p; } else g.goal = far;
    }
    return g;
  };
}
function roundPoly(c, W, D, rand) {
  const out = [];
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2, f = 1 + (rand() - 0.5) * 0.12; out.push([c[0] + (W / 2) * f * Math.cos(a), c[1] + (D / 2) * f * Math.sin(a)]); }
  return out;
}
function chamberLevel(g, sp, s, r, top) {
  const c = addNode(g, s, [0, 0]);
  addRoom(g, c, roundPoly([0, 0], sp.W, sp.D, r), "chamber", top ? sp.label : "下层室", lvlId(sp, "room", s));
  if (top) g.outline = g.rooms[g.rooms.length - 1].poly;
  return c;
}
function corridorLevel(g, sp, s, r, top, target) {
  const za = -sp.D / 2 + 2.5, zb = sp.D / 2 - 2.5, a = addNode(g, s, [0, za]), b = addNode(g, s, [0, zb]);
  addEdge(g, a, b, sp.cw, [], sp.sky ? { style: "walkway" } : null);
  const ent = d2([0, za], target) <= d2([0, zb], target) ? a : b, far = ent === a ? b : a;
  addRoom(g, ent, rect(g.nodes[ent].p, 5, 5), top ? "entry" : "chamber", top ? "入口" : "下层口", lvlId(sp, "end_a", s));
  addRoom(g, far, rect(g.nodes[far].p, 5, 5), "chamber", "尽头室", lvlId(sp, "end_b", s));
  return ent;
}
function hallsLevel(g, sp, s, r, top) {
  const k = clamp((sp.D - 10) / 32, 0.5, 2), side = Math.max(1.5, sp.cw - 0.5);
  let z = -sp.D / 2;
  const put = (depth, width, role, label, rid) => { const c = [0, z + depth / 2]; z += depth; const n = addNode(g, s, c); addRoom(g, n, rect(c, width, depth), role, label, rid); return { n, width, c }; };
  const entry = top ? put(4, 4, "entry", "入口", "entry") : null;
  if (top) z += 3;
  const front = put(7 * k, 10 * k, "hall", "前厅", lvlId(sp, "front", s));
  z += 8 * k; // 甬道
  const main = put(11 * k, 14 * k, "hall", "主厅", lvlId(sp, "main", s));
  let rear = null;
  if (sp.branching !== "low" || r() < 0.5) { z += 3; rear = put(6 * k, 7 * k, "chamber", "后室", lvlId(sp, "rear", s)); }
  if (entry) addEdge(g, entry.n, front.n, sp.cw);
  addEdge(g, front.n, main.n, sp.cw);
  if (rear) addEdge(g, main.n, rear.n, sp.cw);
  const pairs = sp.branching === "low" ? [main] : sp.branching === "medium" ? [main, front] : rear ? [main, front, rear] : [main, front];
  let si = 0;
  for (const h of pairs) {
    const sw = 5 * k, x = h.width / 2 + 3 * k + sw / 2;
    for (const sg of [1, -1]) { // 面朝里（+z）时左手是 +x
      const n = addNode(g, s, [sg * x, h.c[1]]);
      addRoom(g, n, rect(g.nodes[n].p, sw, sw), "side", sg > 0 ? "左耳室" : "右耳室", lvlId(sp, `side${si++}`, s));
      addEdge(g, h.n, n, side);
    }
  }
  return entry ? entry.n : front.n;
}
function blob(c, rad, rand) {
  const out = [], asp = 0.75 + 0.25 * rand(), rot = rand() * Math.PI, cs = Math.cos(rot), sn = Math.sin(rot);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2, rr = rad * (0.78 + 0.4 * rand()), lx = rr * Math.cos(a), lz = rr * asp * Math.sin(a);
    out.push([c[0] + lx * cs - lz * sn, c[1] + lx * sn + lz * cs]);
  }
  return out;
}
function networkLevel(g, sp, s, r, top, target, ctx) {
  const want = { low: [3, 4], medium: [5, 6], high: [7, 9] }[sp.branching];
  const N = want[0] + Math.floor(r() * (want[1] - want[0] + 1)), sc = clamp(Math.min(sp.W, sp.D) / 36, 0.5, 2.2);
  const caves = [];
  for (let t = 0; t < 800 && caves.length < N; t++) {
    const rad = (3 + r() * 2.5) * sc, p = [(r() - 0.5) * Math.max(0, sp.W - 2.4 * rad), (r() - 0.5) * Math.max(0, sp.D - 2.4 * rad)];
    if (ctx.mask && !ctx.mask(p)) continue;
    if (caves.every((c) => d2(c.p, p) >= 1.2 * (c.rad + rad) + 2.5)) caves.push({ p, rad });
  }
  if (caves.length < 2) { caves.length = 0; const rad = Math.max(2.5, Math.min(sp.W, sp.D) / 6); caves.push({ p: [0, -sp.D / 4], rad }, { p: [0, sp.D / 4], rad }); }
  const ids = caves.map((c) => addNode(g, s, c.p)), first = g.rooms.length;
  caves.forEach((c, i) => addRoom(g, ids[i], blob(c.p, c.rad, r), "chamber", (sp.sky ? "平台 " : "洞室 ") + (i + 1), lvlId(sp, (sp.sky ? "pf" : "cave") + i, s)));
  // 最小生成树（Prim，并列取编号小的）+ 回环
  const inT = new Set([0]), tree = [], tk = new Set();
  while (inT.size < caves.length) {
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of inT) for (let j = 0; j < caves.length; j++) if (!inT.has(j)) { const dd = d2(caves[i].p, caves[j].p); if (dd < bd - 1e-9) { bd = dd; bi = i; bj = j; } }
    tree.push([bi, bj]); inT.add(bj); tk.add(Math.min(bi, bj) + "," + Math.max(bi, bj));
  }
  const maxE = Math.max(...tree.map(([i, j]) => d2(caves[i].p, caves[j].p)));
  const nLoops = { low: 0, medium: 1, high: 2 + (r() < 0.5 ? 1 : 0) }[sp.branching], extra = [];
  const pairs = [];
  for (let i = 0; i < caves.length; i++) for (let j = i + 1; j < caves.length; j++) if (!tk.has(i + "," + j)) pairs.push([i, j, d2(caves[i].p, caves[j].p)]);
  pairs.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  for (const [i, j, L] of pairs) {
    if (extra.length >= nLoops || L > 1.9 * maxE) break;
    if (caves.some((c, k) => k !== i && k !== j && distToSegment(c.p, caves[i].p, caves[j].p) < c.rad * 1.2 + 1)) continue;
    extra.push([i, j]);
  }
  for (const [i, j] of [...tree, ...extra]) {
    const a = caves[i].p, b = caves[j].p, L = d2(a, b), u = unit([b[0] - a[0], b[1] - a[1]]) || [1, 0], n = [-u[1], u[0]];
    const amp = sp.sky ? 0 : (r() - 0.5) * 0.4 * L;
    const mid = sp.sky ? [] : [0.25, 0.5, 0.75].map((t) => [a[0] + (b[0] - a[0]) * t + n[0] * amp * Math.sin(Math.PI * t), a[1] + (b[1] - a[1]) * t + n[1] * amp * Math.sin(Math.PI * t)]);
    addEdge(g, ids[i], ids[j], sp.cw, mid, sp.sky ? { style: L > 14 ? "rope_bridge" : "walkway" } : null);
  }
  let ent = 0, bd = Infinity;
  caves.forEach((c, i) => { const dd = d2(c.p, target); if (dd < bd - 1e-9) { bd = dd; ent = i; } });
  if (top) Object.assign(g.rooms[first + ent], { role: "entry", label: sp.sky ? "入口平台" : "入口洞" });
  return ids[ent];
}
function genNetwork(sp, ctx) {
  const g = stacked(networkLevel)(sp, ctx), gr = roomAt(g, g.goal);
  if (gr && gr.role === "chamber" && g.goal !== g.entrance) Object.assign(gr, { role: "goal", label: sp.sky ? "最远平台" : "最深洞室" });
  return g;
}

// ------------------------------------------------------------ rooms：房间 + 连线图 → 网格排布（BFS 分层、冲突换格）→ 走廊
function genRooms(sp, ctx) {
  const g = newGraph(), s = 0, RG = sp.room_graph, byId = new Map(RG.rooms.map((r) => [r.id, r]));
  const S = (id) => (id === "entry" ? 4 : byId.get(id).size_m || ROOM_SIZES[byId.get(id).size]);
  const ids = ["entry", ...RG.rooms.map((r) => r.id)], adj = new Map(ids.map((i) => [i, []]));
  for (const [a, b] of RG.links) { adj.get(a).push(b); adj.get(b).push(a); }
  const cell = new Map([["entry", [0, 0]]]), heading = new Map([["entry", [0, 1]]]), used = new Set(["0,0"]), key = (c) => c[0] + "," + c[1];
  const queue = ["entry"], placed = new Set(["entry"]);
  while (queue.length) {
    const u = queue.shift(), cu = cell.get(u), h = heading.get(u), left = [h[1], -h[0]], right = [-h[1], h[0]], back = [-h[0], -h[1]];
    const kids = adj.get(u).filter((v) => !placed.has(v));
    const leaf = (v) => adj.get(v).every((w) => w === u || placed.has(w));
    for (const v of [...kids.filter((v) => !leaf(v)), ...kids.filter(leaf)]) {
      if (placed.has(v)) continue;
      const lab = ((byId.get(v) && byId.get(v).label) || "") + " " + v;
      const pref = /左|_l$|left/i.test(lab) ? "L" : /右|_r$|right/i.test(lab) ? "R" : "";
      let dirs = leaf(v) ? [left, right, h] : [h, left, right];
      if (pref === "L") dirs = [left, right, h]; else if (pref === "R") dirs = [right, left, h];
      const add = (...vs) => vs.reduce((acc, d) => [acc[0] + d[0], acc[1] + d[1]], cu);
      const cands = [...dirs.map((d) => add(d)), add(h, left), add(h, right), add(back, left), add(back, right)];
      let c = cands.find((q) => !used.has(key(q)));
      for (let ring = 2; !c && ring < 12; ring++) {
        const ring_ = [];
        for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) ring_.push([cu[0] + dx, cu[1] + dz]);
        ring_.sort((a, b) => Math.hypot(a[0] - cu[0], a[1] - cu[1]) - Math.hypot(b[0] - cu[0], b[1] - cu[1]) || a[0] - b[0] || a[1] - b[1]);
        c = ring_.find((q) => !used.has(key(q)));
      }
      cell.set(v, c); used.add(key(c)); placed.add(v); queue.push(v);
      const dv = [c[0] - cu[0], c[1] - cu[1]];
      heading.set(v, Math.abs(dv[0]) + Math.abs(dv[1]) === 1 ? dv : h);
    }
  }
  // 步距按行 / 列算：相邻两列（行）的中心距 = 两边最大房间的半宽之和 + 一段走廊（4–6 m）；再整体缩到 size_m 以内
  const GAP = clamp(sp.cw + 2.5, 4, 6);
  const axisPos = (k) => {
    const vals = ids.map((id) => cell.get(id)[k]), lo = Math.min(...vals), hi = Math.max(...vals), out = new Map();
    const span = (v) => Math.max(0, ...ids.filter((id) => cell.get(id)[k] === v).map(S));
    let at = 0;
    for (let v = lo; v <= hi; v++) { if (v > lo) at += (span(v - 1) + span(v)) / 2 + GAP; out.set(v, at); }
    return out;
  };
  const XP = axisPos(0), ZP = axisPos(1);
  const raw = (id) => [XP.get(cell.get(id)[0]), ZP.get(cell.get(id)[1])];
  const ext = (k) => { const lo = Math.min(...ids.map((id) => raw(id)[k] - S(id) / 2)), hi = Math.max(...ids.map((id) => raw(id)[k] + S(id) / 2)); return hi - lo; };
  const k = clamp(Math.min(1, sp.W / Math.max(1e-6, ext(0)), sp.D / Math.max(1e-6, ext(1))), 0.4, 1);
  // 平移：给了连接目标（且不远）时入口落在连接点上；否则最大的房间（主室）落在原点 = under 目标的投影
  const mainId = RG.rooms.reduce((best, r) => (S(r.id) > S(best) + 1e-9 ? r.id : best), RG.rooms[0].id);
  const ap = ctx.approach && Math.hypot(ctx.approach[0], ctx.approach[1]) <= Math.max(sp.W, sp.D) ? ctx.approach : null;
  const anchor = ctx.anchorEntry && ap ? [ap, raw("entry")] : [[0, 0], raw(mainId)];
  const pos = (id) => { const p = raw(id); return [anchor[0][0] + (p[0] - anchor[1][0]) * k, anchor[0][1] + (p[1] - anchor[1][1]) * k]; };
  const Sk = (id) => Math.max(id === "entry" ? 3 : 3.5, S(id) * k);
  // 名字像走廊的房间（甬道 / 廊）画成窄长条，方向顺着它连的房间
  const narrow = (id) => id !== "entry" && /甬道|走廊|廊道|通道|墓道/.test((byId.get(id) && byId.get(id).label) || "");
  const dims = (id) => {
    if (!narrow(id)) return [Sk(id), Sk(id)];
    const c = cell.get(id), nb = adj.get(id).map((v) => cell.get(v)), vert = nb.filter((q) => q[0] === c[0]).length >= nb.filter((q) => q[1] === c[1]).length;
    const w = Math.min(Sk(id), sp.cw + 1.5);
    return vert ? [w, Sk(id)] : [Sk(id), w];
  };
  const node = new Map();
  for (const id of ids) {
    const n = addNode(g, s, pos(id)), [w, d] = dims(id);
    node.set(id, n);
    if (id === "entry") addRoom(g, n, rect(pos(id), w, d), "entry", "入口", "entry");
    else addRoom(g, n, rect(pos(id), w, d), "named", byId.get(id).label, id);
  }
  const blocked = (a, b, ex) => ids.some((id) => !ex.includes(id) && distToSegment(pos(id), a, b) < Sk(id) / 2 + sp.cw / 2);
  for (const [a, b] of RG.links) {
    const pa = pos(a), pb = pos(b);
    let mid = [];
    if (Math.abs(pa[0] - pb[0]) > 1e-6 && Math.abs(pa[1] - pb[1]) > 1e-6) {
      const c1 = [pb[0], pa[1]], c2 = [pa[0], pb[1]];
      mid = [!blocked(pa, c1, [a, b]) && !blocked(c1, pb, [a, b]) ? c1 : !blocked(pa, c2, [a, b]) && !blocked(c2, pb, [a, b]) ? c2 : c1];
    }
    addEdge(g, node.get(a), node.get(b), sp.cw, mid, { between: [a, b] });
  }
  g.entrance = node.get("entry");
  const d = shortest(g, g.entrance);
  let best = node.get(RG.rooms[0].id), bd = -1;
  for (const r of RG.rooms) { const n = node.get(r.id); if (Number.isFinite(d[n]) && d[n] > bd + 1e-9) { bd = d[n]; best = n; } }
  g.goal = best;
  return g;
}

const GEN = { maze: genMaze, galleries: genGalleries, halls: stacked(hallsLevel), network: genNetwork, rooms: genRooms, chamber: stacked(chamberLevel), corridor: stacked(corridorLevel) };

// ============================================================ 局部图 → 世界坐标
/** 局部坐标框架：world = c + R(axis) · (p × scale)；局部 −z 是入口一侧 */
function frame(c, axisDeg, scale = 1) {
  const t = (axisDeg * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
  return {
    c, axisDeg, scale,
    toWorld: (p) => [c[0] + (p[0] * cs - p[1] * sn) * scale, c[1] + (p[0] * sn + p[1] * cs) * scale],
    toLocal: (q) => { const dx = (q[0] - c[0]) / scale, dz = (q[1] - c[1]) / scale; return [dx * cs + dz * sn, -dx * sn + dz * cs]; },
  };
}
/** 让局部 −z 指向 approach，取最近的 90° */
function snapAxis(c, a) {
  const u = a && unit([a[0] - c[0], a[1] - c[1]]);
  if (!u) return 0;
  const deg = (Math.atan2(u[0], -u[1]) * 180) / Math.PI;
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}
function localPoints(g) {
  const pts = [];
  const wmax = g.edges.reduce((m, e) => Math.max(m, e.w), 0) / 2;
  for (const n of g.nodes) for (const [dx, dz] of [[wmax, 0], [-wmax, 0], [0, wmax], [0, -wmax]]) pts.push([n.p[0] + dx, n.p[1] + dz]);
  for (const e of g.edges) for (const m of e.mid) for (const [dx, dz] of [[wmax, 0], [-wmax, 0], [0, wmax], [0, -wmax]]) pts.push([m[0] + dx, m[1] + dz]);
  for (const r of g.rooms) pts.push(...r.poly);
  if (g.outline) pts.push(...g.outline);
  return pts;
}
/** 局部图整体平移 d（节点、走廊拐点、房间、外轮廓） */
function shiftGraph(g, d) {
  const mv = (p) => [p[0] + d[0], p[1] + d[1]];
  for (const n of g.nodes) n.p = mv(n.p);
  for (const e of g.edges) e.mid = e.mid.map(mv);
  for (const r of g.rooms) r.poly = r.poly.map(mv);
  if (g.outline) g.outline = g.outline.map(mv);
}
/** 整体平移进 bounds（留 2 m）；比 bounds 还大时整体缩小 */
function placeFrame(g, center, axisDeg, b, keep) {
  if (keep) return frame(center, axisDeg, 1);
  const f0 = frame([0, 0], axisDeg, 1), pts = localPoints(g).map(f0.toWorld);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const mnx = Math.min(...xs), mxx = Math.max(...xs), mnz = Math.min(...zs), mxz = Math.max(...zs), m = 2;
  const ax = b.max[0] - b.min[0] - 2 * m, az = b.max[2] - b.min[2] - 2 * m;
  const scale = Math.min(1, ax / Math.max(1e-6, mxx - mnx), az / Math.max(1e-6, mxz - mnz));
  const cx = clamp(center[0], b.min[0] + m - mnx * scale, b.max[0] - m - mxx * scale), cz = clamp(center[1], b.min[2] + m - mnz * scale, b.max[2] - m - mxz * scale);
  return frame([cx, cz], axisDeg, scale);
}
/**
 * 外轮廓 = 房间多边形与通道缓冲带（半宽 + pad）的并集（局部坐标）：栅格化后描外边界，再按栅格精度化简。
 * 不用凸包——凸包会把 T 形 / 长链的空间画成一大块三角。
 */
function unionOutline(g, pad = 0.75) {
  const segs = [];
  for (const e of g.edges) { const pts = [g.nodes[e.a].p, ...e.mid, g.nodes[e.b].p]; for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1], e.w / 2 + pad]); }
  const polys = g.rooms.map((r) => r.poly);
  const pts = [...polys.flat(), ...segs.flatMap((s) => [s[0], s[1]])];
  if (!pts.length) return rect([0, 0], 6, 6);
  const m = Math.max(2, ...segs.map((s) => s[2])) + pad + 1;
  const x0 = Math.min(...pts.map((p) => p[0])) - m, z0 = Math.min(...pts.map((p) => p[1])) - m;
  const x1 = Math.max(...pts.map((p) => p[0])) + m, z1 = Math.max(...pts.map((p) => p[1])) + m;
  const res = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 220), nx = Math.ceil((x1 - x0) / res), nz = Math.ceil((z1 - z0) / res);
  const occ = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const p = [x0 + (i + 0.5) * res, z0 + (j + 0.5) * res];
    if (polys.some((q) => pointInPolygon(p, q) || distToPolygon(p, q) <= pad) || segs.some((s) => distToSegment(p, s[0], s[1]) <= s[2])) occ[j * nx + i] = 1;
  }
  const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && occ[j * nx + i] === 1;
  // 有向边界边（实格在左手边）：起点 → [终点]；顶点用格点编号
  const out = new Map(), vk = (i, j) => j * (nx + 1) + i;
  const push = (a, b) => { if (!out.has(a)) out.set(a, []); out.get(a).push(b); };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) push(vk(i + 1, j), vk(i, j));
    if (!on(i, j + 1)) push(vk(i, j + 1), vk(i + 1, j + 1));
    if (!on(i - 1, j)) push(vk(i, j), vk(i, j + 1));
    if (!on(i + 1, j)) push(vk(i + 1, j + 1), vk(i + 1, j));
  }
  const xy = (v) => [x0 + (v % (nx + 1)) * res, z0 + Math.floor(v / (nx + 1)) * res];
  let best = null, bestA = 0;
  for (const start of [...out.keys()].sort((a, b) => a - b)) {
    while (out.get(start) && out.get(start).length) {
      const loop = [start];
      let cur = out.get(start).shift(), prev = start;
      for (let guard = 0; cur !== start && guard < 1e6; guard++) {
        loop.push(cur);
        const nxt = out.get(cur);
        if (!nxt || !nxt.length) break;
        // 对角相接时优先左转（同一块实格的边界连在一起）
        let pick = 0;
        if (nxt.length > 1) { const a = xy(prev), b = xy(cur); pick = nxt.findIndex((v) => { const c = xy(v); return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 0; }); if (pick < 0) pick = 0; }
        prev = cur; cur = nxt.splice(pick, 1)[0];
      }
      const P = loop.map(xy);
      let A = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; A += p[0] * q[1] - q[0] * p[1]; }
      if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = P; }
    }
  }
  if (!best || best.length < 3) return rect([0, 0], 6, 6);
  const simp = simplifyRing(best, res * 0.75);
  return simp.length >= 3 ? simp : best;
}
/** 闭合折线的 Douglas–Peucker 化简（从离第 0 点最远的点切成两段） */
function simplifyRing(P, tol) {
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    let k = -1, dm = tol;
    for (let i = 1; i + 1 < pts.length; i++) { const d = distToSegment(pts[i], pts[0], pts[pts.length - 1]); if (d > dm) { dm = d; k = i; } }
    return k < 0 ? [pts[0], pts[pts.length - 1]] : [...dp(pts.slice(0, k + 1)).slice(0, -1), ...dp(pts.slice(k))];
  };
  let far = 0; P.forEach((p, i) => { if (d2(p, P[0]) > d2(P[far], P[0])) far = i; });
  const a = dp(P.slice(0, far + 1)), b = dp([...P.slice(far), P[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
/** 去掉共线的中间点 */
function dropCollinear(pts) {
  const out = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cr) < 1e-6 && dot > 0) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
/**
 * 图的边 → 折线：经过度为 2 的节点（拐角）连成一条，经过岔口时沿直线穿过去（主巷 / 迷宫的直走廊是一条）；
 * 房间、宽度 / 样式变化、房间图的走廊处断开。之后再去掉共线的中间点。
 */
function chainsOf(g) {
  const adj = g.nodes.map(() => []), roomNodes = new Set(g.rooms.map((r) => r.node));
  g.edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  const same = (e, f) => e.w === f.w && e.style === f.style && !e.between && !f.between;
  /** 从 n 端离开边 e 的方向（第一个中间点或另一端） */
  const dirFrom = (n, ei) => { const E = g.edges[ei], q = E.a === n ? (E.mid[0] || g.nodes[E.b].p) : (E.mid[E.mid.length - 1] || g.nodes[E.a].p), p = g.nodes[n].p; return unit([q[0] - p[0], q[1] - p[1]]); };
  /** 沿边 ei 走到 n 之后接着走哪条边（没有就 -1） */
  const cont = (n, ei) => {
    if (roomNodes.has(n)) return -1;
    const others = adj[n].filter((k) => k !== ei && same(g.edges[k], g.edges[ei]));
    if (adj[n].length === 2) return others.length ? others[0] : -1;
    const din = dirFrom(n, ei);
    for (const k of others) { const d = dirFrom(n, k); if (din && d && din[0] * d[0] + din[1] * d[1] < -0.999) return k; }
    return -1;
  };
  const used = new Uint8Array(g.edges.length), out = [];
  const walk = (start, ei) => {
    const pts = [g.nodes[start].p], e0 = g.edges[ei];
    let cur = start, e = ei;
    for (;;) {
      used[e] = 1;
      const E = g.edges[e], nxt = E.a === cur ? E.b : E.a;
      pts.push(...(E.a === cur ? E.mid : [...E.mid].reverse()), g.nodes[nxt].p);
      const ne = cont(nxt, e);
      if (ne < 0 || used[ne]) break;
      cur = nxt; e = ne;
    }
    out.push({ s: g.nodes[start].s, pts, w: e0.w, style: e0.style, between: e0.between });
  };
  g.nodes.forEach((_, n) => { for (const ei of adj[n]) if (!used[ei] && cont(n, ei) < 0) walk(n, ei); });
  g.edges.forEach((e, i) => { if (!used[i]) walk(e.a, i); });
  return out;
}

/**
 * 局部图 → SID 构件（世界坐标；floor_y 先按 floor0 = 0 写，之后 setSpaceFloor 统一移）。
 */
function emit(g, sp, fr, userPoly, b) {
  const W = (p) => { const q = fr.toWorld(p); return [r2(q[0]), r2(q[1])]; };
  const passH = ["maze", "galleries", "corridor"].includes(sp.layout) ? sp.H : Math.min(sp.H, 3.5);
  const counter = {};
  const passages = chainsOf(g).map((c) => {
    const k = (counter[c.s] = (counter[c.s] || 0) + 1) - 1;
    const p = { id: `p${c.s}_${k}`, sublevel: c.s, points: dropCollinear(c.pts.map(W)), width: r2(c.w * Math.min(1, fr.scale)), floor_y: 0, height: r2(passH) };
    if (c.style) p.style = c.style;
    if (c.between) p.between = c.between.slice();
    return p;
  });
  const rooms = g.rooms.map((r) => ({ id: r.id, sublevel: r.s, polygon: r.poly.map(W), floor_y: 0, height: r2(sp.H), role: r.role, label: r.label }));
  const links = g.links.map((l) => {
    const sa = g.nodes[l.a].s, sb = g.nodes[l.b].s;
    return { id: `lk_${Math.min(sa, sb)}_${Math.max(sa, sb)}`, at: W(g.nodes[l.a].p), from: Math.min(sa, sb), to: Math.max(sa, sb), via: l.via };
  });
  let polygon;
  if (userPoly) polygon = userPoly.map((p) => [r2(p[0]), r2(p[1])]);
  else if (g.outline) polygon = g.outline.map(W);
  else polygon = unionOutline(g).map(W);
  polygon = polygon.map(([x, z]) => [r2(clamp(x, b.min[0], b.max[0])), r2(clamp(z, b.min[2], b.max[2]))]);
  return { passages, rooms, links, polygon, entrance: W(g.nodes[g.entrance].p), goal: g.goal >= 0 ? W(g.nodes[g.goal].p) : null };
}
function factsOf(g, sp, passages, step, scale) {
  const deg = edgeDegree(g);
  const parent = g.nodes.map((_, i) => i), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of g.edges) parent[find(e.a)] = find(e.b);
  for (const l of g.links) parent[find(l.a)] = find(l.b);
  const comps = new Set(g.nodes.map((_, i) => find(i))).size;
  const d = shortest(g, g.entrance, step, scale);
  return {
    passage_m: r1(passages.reduce((s, p) => s + polyLen(p.points), 0)),
    rooms: g.rooms.length,
    dead_ends: deg.filter((x) => x === 1).length,
    loops: Math.max(0, g.edges.length + g.links.length - g.nodes.length + comps),
    longest_route_m: g.goal >= 0 && Number.isFinite(d[g.goal]) ? r1(d[g.goal]) : 0,
    cells: g.cells,
    sublevels: sp.n,
  };
}

// ============================================================ 目标解析（resolveTarget 缺省时直接查 SID）
function footprint(v) {
  const t = ((v.rotation_y || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), hx = v.size[0] / 2, hz = v.size[2] / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => [v.position[0] + x * c + z * s, v.position[2] - x * s + z * c]);
}
/**
 * 在 SID 里找 id（或 plan_id）对应的东西 → { point, polygon?, top_y?, kind }；找不到 null。
 * kind：site / spawn / space / terrain / zone / volume / path / marker
 */
export function sidTarget(sid, T, id) {
  if (!id) return null;
  const b = sid.bounds || DEFAULT_BOUNDS;
  if (id === "site") return { point: boundsCenter(b), polygon: [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]], kind: "site" };
  const hit = (o) => o && (o.id === id || o.plan_id === id);
  if (id === "spawn") { const m = (sid.markers || []).find((x) => x && x.kind === "player_spawn" && Array.isArray(x.position)); return m ? { point: [m.position[0], m.position[2]], kind: "spawn" } : null; }
  const sp = (sid.spaces || []).find((s) => hit(s) && validPoly(s.polygon));
  if (sp) return { point: polygonCentroid(sp.polygon), polygon: sp.polygon, kind: "space", space_id: sp.id };
  const feats = ((sid.terrain && sid.terrain.features) || []).filter((f) => hit(f) && validPoly(f.polygon));
  if (feats.length) { const big = feats.slice().sort((a, c) => polygonRadius(c.polygon) - polygonRadius(a.polygon))[0], top = feats.slice().sort((a, c) => (c.height || 0) - (a.height || 0))[0]; return { point: polygonCentroid(big.polygon), polygon: big.polygon, top_y: T ? T.heightAt(...polygonCentroid(top.polygon)) : undefined, kind: "terrain" }; }
  const rg = (sid.regions || []).find((r) => hit(r) && validPoly(r.polygon));
  if (rg) return { point: polygonCentroid(rg.polygon), polygon: rg.polygon, kind: "zone" };
  const v = (sid.volumes || []).find((x) => hit(x) && Array.isArray(x.position) && Array.isArray(x.size));
  if (v) { const base = T ? Math.max(Number(v.position[1]) || 0, T.heightAt(v.position[0], v.position[2])) : Number(v.position[1]) || 0; return { point: [v.position[0], v.position[2]], polygon: footprint(v), top_y: base + v.size[1], kind: "volume" }; }
  const p = (sid.paths || []).find((x) => hit(x) && Array.isArray(x.points) && x.points.length);
  if (p) { const q = p.points[p.points.length - 1]; return { point: [q[0], q[1]], kind: "path" }; }
  const m = (sid.markers || []).find((x) => hit(x) && Array.isArray(x.position));
  if (m) return { point: [m.position[0], m.position[2]], kind: "marker" };
  return null;
}
const DIRS = { C: [0, 0], N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [Math.SQRT1_2, -Math.SQRT1_2], NW: [-Math.SQRT1_2, -Math.SQRT1_2], SE: [Math.SQRT1_2, Math.SQRT1_2], SW: [-Math.SQRT1_2, Math.SQRT1_2] };
function spawnPoint(sid, res) {
  const m = (sid.markers || []).find((x) => x && x.kind === "player_spawn" && Array.isArray(x.position));
  if (m) return [m.position[0], m.position[2]];
  const t = res("spawn");
  return t && isPt(t.point) ? t.point : null;
}

// ============================================================ 内部布局（对外）
/**
 * 按空间（SID 空间或 plan 空间字段）生成内部布局与外轮廓，并按规则定高度。不改入参。
 * 外轮廓中心：opts.center，否则 space.polygon 的质心；入口朝向：opts.approach，否则已有连接点 / space.entrance / 出生点。
 * space.user_polygon 为真时保留人给的外轮廓，只在轮廓里铺内部；space.user_height 为真时保留 floor_y。
 * @param {object} space
 * @param {object} sid 读 bounds / markers（出生点、连接点）
 * @param {object} T buildTerrain 结果
 * @param {{seed?: number, center?: number[], approach?: number[], preferBoundary?: boolean, axis_deg?: number}} [opts]
 * @returns {{polygon, floor_y, height, axis_deg, size_m, corridor_m, sublevels, passages, rooms, links, entrance, goal, facts, warnings}}
 */
export function buildInterior(space, sid, T, opts = {}) {
  const warnings = [], sp = specOf(space, warnings), b = sid.bounds || DEFAULT_BOUNDS;
  const seed = (Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : Number(space.layout_seed) || 1) >>> 0;
  const userPoly = space.user_polygon && validPoly(space.polygon) ? space.polygon : null;
  let center = isPt(opts.center) ? opts.center.slice() : validPoly(space.polygon) ? polygonCentroid(space.polygon) : boundsCenter(b);
  let approach = isPt(opts.approach) ? opts.approach : null;
  if (!approach) { const m = (sid.markers || []).find((x) => x && x.kind === "connector" && x.to === space.id && Array.isArray(x.position)); approach = m ? [m.position[0], m.position[2]] : isPt(space.entrance) ? space.entrance : spawnPoint(sid, () => null) || [center[0], center[1] + 1000]; }
  const axis = Number.isFinite(opts.axis_deg) ? opts.axis_deg : Number.isFinite(space.axis_deg) ? space.axis_deg : snapAxis(center, approach);
  if (userPoly) {
    // 人给的外轮廓：中心与尺寸取它在局部框架里的外接矩形
    const f0 = frame(center, axis), L = userPoly.map(f0.toLocal), xs = L.map((p) => p[0]), zs = L.map((p) => p[1]);
    center = f0.toWorld([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]);
    sp.W = Math.max(6, Math.max(...xs) - Math.min(...xs)); sp.D = Math.max(6, Math.max(...zs) - Math.min(...zs));
  }
  const pre = frame(center, axis);
  const ctx = {
    seed, sky: sp.sky, approach: pre.toLocal(approach),
    preferBoundary: opts.preferBoundary !== undefined ? !!opts.preferBoundary : !sp.from,
    anchorEntry: !!sp.from && isPt(opts.approach),
    mask: userPoly ? (p) => pointInPolygon(pre.toWorld(p), userPoly) : null,
  };
  const g = GEN[sp.layout](sp, ctx);
  // 有连接目标时入口格对准连接点（井架 / 寺旁边）：整张图平移，最多挪半个空间（再远就说明连接目标离 under 目标太远，不硬拉）
  if (ctx.anchorEntry && !userPoly && g.entrance >= 0 && sp.layout !== "rooms") {
    const e = g.nodes[g.entrance].p, d = [ctx.approach[0] - e[0], ctx.approach[1] - e[1]];
    if (Math.hypot(d[0], d[1]) <= Math.max(6, sp.cw * 3, Math.min(sp.W, sp.D) / 2)) shiftGraph(g, d);
  }
  const fr = placeFrame(g, center, axis, b, !!userPoly);
  const out = emit(g, sp, fr, userPoly, b);
  const step = sp.H + (sp.sky ? CLEARANCE.slab : CLEARANCE.rock);
  const tmp = { id: space.id, stratum: sp.stratum, polygon: out.polygon, height: sp.H, sublevels: sp.n, [sp.layersKey]: sp.layers, floor_y: 0, passages: out.passages, rooms: out.rooms };
  const floor0 = space.user_height && Number.isFinite(Number(space.floor_y)) ? Number(space.floor_y) : fitFloor(tmp, T);
  setSpaceFloor(tmp, floor0);
  return {
    polygon: out.polygon, floor_y: tmp.floor_y, height: r2(sp.H), axis_deg: axis, size_m: [r2(sp.W), r2(sp.D)], corridor_m: r2(sp.cw), sublevels: sp.n,
    passages: out.passages, rooms: out.rooms, links: out.links, entrance: out.entrance, goal: out.goal,
    facts: factsOf(g, sp, out.passages, step, fr.scale), warnings,
  };
}

/**
 * 构成图的 spaces → SID 空间 + 连接点。位置 = under / over 目标（resolveTarget）+ offset_m；入口靠近 connect.from 目标。
 * @param {object[]} planSpaces plan.spaces（字段见 docs/05 §2；另认 over / height_layers / height_m / offset_m / layout_seed）
 * @param {object} sid 已有地形 / 地标 / 出生点的 SID（读 bounds / markers / meta.seed；不改）
 * @param {object} T buildTerrain 结果
 * @param {(id: string) => ({point: number[], polygon?: number[][], top_y?: number, kind: string}|null)} [resolveTarget] plan.js 提供；省略时直接查 SID
 * @param {{seed?: number}} [opts]
 * @returns {{spaces: object[], connectors: object[], warnings: string[]}}
 */
export function compileSpaces(planSpaces, sid, T, resolveTarget, opts = {}) {
  const seed = (Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : Number(sid.meta && sid.meta.seed) || 1) >>> 0;
  const b = sid.bounds || DEFAULT_BOUNDS, warnings = [];
  const res = (id) => { if (!id) return null; let t = null; try { t = typeof resolveTarget === "function" ? resolveTarget(id) : null; } catch (e) { t = null; } return t && isPt(t.point) ? t : sidTarget(sid, T, id); };
  const taken = new Set();
  for (const k of ["volumes", "regions", "paths", "markers", "spaces"]) for (const o of sid[k] || []) if (o && o.id) taken.add(o.id);
  for (const f of (sid.terrain && sid.terrain.features) || []) if (f && f.id) taken.add(f.id);
  const list = (Array.isArray(planSpaces) ? planSpaces : []).filter((p) => p && typeof p === "object");
  const planIds = new Map(), spaces = [];
  list.forEach((ps, i) => {
    const sp = specOf(ps, warnings);
    let id = typeof ps.id === "string" && /^[a-z][a-z0-9_]*$/.test(ps.id) && !taken.has(ps.id) ? ps.id : null;
    for (let n = 1; !id; n++) if (!taken.has("space_" + n)) id = "space_" + n;
    taken.add(id);
    if (ps.id) planIds.set(ps.id, id);
    // 位置：目标的投影（空中压在建筑上方时挪到旁边）+ 人拖过的 offset_m
    const tid = ps.under || ps.over || ps.above || ps.target || null;
    let tgt = tid ? res(tid) : null;
    if (tid && !tgt) warnings.push(`${sp.label}：找不到「${tid}」，放在场地中央`);
    let c = tgt ? tgt.point.slice() : boundsCenter(b);
    if (!tgt && ps.at && typeof ps.at === "object") {
      const of = ps.at.of && ps.at.of !== "site" ? res(ps.at.of) : null, base = of ? of.point : boundsCenter(b);
      const R = of && validPoly(of.polygon) ? polygonRadius(of.polygon) : (b.max[0] - b.min[0]) / 2, u = DIRS[ps.at.dir] || DIRS.C;
      c = [base[0] + u[0] * clamp(num(ps.at.dist, 0), 0, 1) * R, base[1] + u[1] * clamp(num(ps.at.dist, 0), 0, 1) * R];
    }
    const spawn = spawnPoint(sid, res);
    if (sp.sky && tgt && VOLUME_KINDS.has(tgt.kind)) {
      const R = validPoly(tgt.polygon) ? polygonRadius(tgt.polygon) : 4, d = (spawn && unit([spawn[0] - c[0], spawn[1] - c[1]])) || [0, 1], off = R + Math.min(sp.W, sp.D) / 2 + 2;
      const cand = [1, -1].map((sg) => [c[0] - d[1] * off * sg, c[1] + d[0] * off * sg]);
      c = cand.find((p) => p[0] > b.min[0] + off / 2 && p[0] < b.max[0] - off / 2 && p[1] > b.min[2] + off / 2 && p[1] < b.max[2] - off / 2) || cand[0];
    }
    if (Array.isArray(ps.offset_m) && ps.offset_m.length >= 2) c = [c[0] + num(ps.offset_m[0], 0), c[1] + num(ps.offset_m[1], 0)];
    // 入口朝向：connect.from 目标（建筑就落在它旁边），否则出生点，否则南边
    let from = sp.from ? res(sp.from) : null;
    if (sp.from && !from) warnings.push(`${sp.label}：连接目标「${sp.from}」不存在，改从地面最近处下去`);
    let approach = from ? from.point.slice() : spawn || [c[0], c[1] + 1000];
    if (from && VOLUME_KINDS.has(from.kind)) {
      const R = validPoly(from.polygon) ? polygonRadius(from.polygon) : 3;
      const u = unit([c[0] - from.point[0], c[1] - from.point[1]]) || (spawn && unit([spawn[0] - from.point[0], spawn[1] - from.point[1]])) || [0, 1];
      approach = [from.point[0] + u[0] * (R + 2), from.point[1] + u[1] * (R + 2)];
    }
    const layout_seed = Number.isInteger(ps.layout_seed) ? ps.layout_seed >>> 0 : sub(seed, "space:" + (ps.id || i));
    const space = {
      id, plan_id: ps.id || id, stratum: sp.stratum, kind: LAYOUT_KIND[sp.stratum][sp.layout], layout: sp.layout, label: sp.label,
      branching: sp.branching, sublevels: sp.n, corridor_m: r2(sp.cw), size_m: [r2(sp.W), r2(sp.D)], height: r2(sp.H), layout_seed,
      [sp.layersKey]: sp.layers, connect: sp.via, polygon: rect(c, sp.W, sp.D), floor_y: 0, generated: true,
    };
    if (sp.from) space.connect_from = sp.from;
    if (sp.room_graph) space.room_graph = sp.room_graph;
    if (Array.isArray(ps.offset_m)) space.offset_m = ps.offset_m.slice(0, 2).map((v) => num(v, 0));
    const built = buildInterior(space, sid, T, { seed: layout_seed, center: c, approach, preferBoundary: !from });
    for (const w of built.warnings) if (!warnings.includes(w)) warnings.push(w);
    delete built.warnings;
    Object.assign(space, built);
    spaces.push(space);
  });
  // 连接点：connect.from 指向另一个空间时，两个空间相连；否则从地面
  spaces.forEach((s) => { if (s.connect_from && planIds.has(s.connect_from) && planIds.get(s.connect_from) !== s.id) s.connect_space = planIds.get(s.connect_from); });
  const ctx = Object.assign({}, sid, { spaces: [...(sid.spaces || []), ...spaces] });
  const connectors = spaces.map((s) => connectorFor(s, ctx, T));
  return { spaces, connectors, warnings };
}

// ============================================================ 连接点
/** 空间入口层的底面 */
export function entryFloor(space) { return levelFloor(space, entryLevel(space)); }
/** 连接点两端高度：端点是 "ground" 时取连接点处地面，是空间时取它入口层的底面；position.y = 下端。原地修改 */
export function connectorHeights(m, sid, T) {
  const byId = new Map((sid.spaces || []).map((s) => [s.id, s]));
  const at = (e) => (e === "ground" || !byId.has(e) ? T.heightAt(m.position[0], m.position[2]) : entryFloor(byId.get(e)));
  const ys = [at(m.from), at(m.to)];
  m.top_y = r2(Math.max(...ys)); m.bottom_y = r2(Math.min(...ys)); m.position[1] = m.bottom_y;
  return m;
}
/**
 * 空间的连接点 marker：落在 entrance 正上方的地面（夹在 bounds 内）；from = "ground"（或 connect_space），to = 空间 id。
 * @returns {object} marker（kind connector、via、from、to、position=下端、top_y、bottom_y、plan_id）
 */
export function connectorFor(space, sid, T) {
  const b = sid.bounds || DEFAULT_BOUNDS, via = CONNECTOR_VIA.includes(space.connect) ? space.connect : DEFAULTS.via[space.layout] || "stairs";
  let p = isPt(space.entrance) ? space.entrance : validPoly(space.polygon) ? polygonCentroid(space.polygon) : boundsCenter(b);
  p = [r2(clamp(p[0], b.min[0] + 1, b.max[0] - 1)), r2(clamp(p[1], b.min[2] + 1, b.max[2] - 1))];
  const other = space.connect_space && (sid.spaces || []).some((s) => s && s.id === space.connect_space) ? space.connect_space : "ground";
  const m = { id: "conn_" + space.id, kind: "connector", via, from: other, to: space.id, position: [p[0], 0, p[1]], top_y: 0, bottom_y: 0, rotation_y: 0, label: (space.stratum === "sky" ? "上行" : "下行") + VIA_LABEL[via], generated: true };
  if (space.plan_id) m.plan_id = space.plan_id;
  return connectorHeights(m, sid, T);
}

// ============================================================ 刷新（resolve 调用）
const isSpace = (s) => s && typeof s.id === "string" && STRATA.includes(s.stratum) && validPoly(s.polygon);
/**
 * resolve 用：有 layout 却没有内部的空间生成内部；generated（没被人调过高度）的空间按规则重定高度（地形改了也保证岩层 / 净空）；
 * 删掉引用了不存在空间的连接点；generated 且没被拖过的连接点回到入口正上方；其余连接点只重算两端高度。原地修改。
 * @returns {object} sid
 */
export function refreshSpaces(sid, T) {
  sid.spaces = (Array.isArray(sid.spaces) ? sid.spaces : []).filter(isSpace);
  for (const s of sid.spaces) {
    if (s.layout && !Array.isArray(s.passages) && !Array.isArray(s.rooms)) { const r = buildInterior(s, sid, T, { seed: s.layout_seed }); delete r.warnings; Object.assign(s, r); }
    else if (s.generated && !s.user_set && !s.user_height) setSpaceFloor(s, fitFloor(s, T));
  }
  const byId = new Map(sid.spaces.map((s) => [s.id, s]));
  const okEnd = (e) => e === "ground" || byId.has(e);
  sid.markers = (sid.markers || []).filter((m) => !m || m.kind !== "connector" || (okEnd(m.from) && okEnd(m.to) && m.from !== m.to));
  sid.markers = sid.markers.map((m) => {
    if (!m || m.kind !== "connector") return m;
    const sp = byId.get(m.to) || byId.get(m.from);
    if (m.generated && !m.user_moved && sp && m.id === "conn_" + sp.id) { const n = connectorFor(sp, sid, T); return Object.assign({}, m, { position: n.position, top_y: n.top_y, bottom_y: n.bottom_y }); }
    return connectorHeights(m, sid, T);
  });
  return sid;
}

/**
 * 人在地下 / 空中层圈的多边形 → 空间（user_set、user_polygon：外轮廓保留）+ 一个连接点。不改 sid。
 * @param {{stratum, polygon, layout?, label?, id?, connect?, branching?, sublevels?, corridor_m?, floor_y?, height?}} spec
 * @returns {{space: object, connector: object}|null}
 */
export function makeSpace(spec, sid, T) {
  if (!spec || !STRATA.includes(spec.stratum) || !validPoly(spec.polygon)) return null;
  const taken = new Set([...(sid.spaces || []).map((s) => s && s.id), ...(sid.markers || []).map((m) => m && m.id)]);
  let id = typeof spec.id === "string" && /^[a-z][a-z0-9_]*$/.test(spec.id) && !taken.has(spec.id) ? spec.id : null;
  for (let n = 1; !id; n++) if (!taken.has("u_space_" + n)) id = "u_space_" + n;
  const b = sid.bounds || DEFAULT_BOUNDS, warnings = [];
  const sp = specOf(Object.assign({}, spec, { size_m: undefined }), warnings);
  const polygon = spec.polygon.map(([x, z]) => [r2(clamp(x, b.min[0], b.max[0])), r2(clamp(z, b.min[2], b.max[2]))]);
  const space = {
    id, plan_id: spec.plan_id || id, stratum: sp.stratum, kind: LAYOUT_KIND[sp.stratum][sp.layout], layout: sp.layout, label: sp.label, branching: sp.branching,
    sublevels: sp.n, corridor_m: r2(sp.cw), height: r2(Number(spec.height) > 0 ? Number(spec.height) : sp.H), layout_seed: sub(Number(sid.meta && sid.meta.seed) || 1, id),
    [sp.layersKey]: sp.layers, connect: sp.via, polygon, floor_y: num(spec.floor_y, 0), user_set: true, user_polygon: true,
  };
  if (Number.isFinite(Number(spec.floor_y)) && spec.floor_y !== null && spec.floor_y !== "") space.user_height = true;
  const r = buildInterior(space, sid, T, { seed: space.layout_seed });
  delete r.warnings;
  Object.assign(space, r);
  const ctx = Object.assign({}, sid, { spaces: [...(sid.spaces || []), space] });
  return { space, connector: connectorFor(space, ctx, T) };
}

// ============================================================ 内部连通图（从 SID 几何重建，检查与测试用）
/**
 * 从空间的 passages / rooms / links / entrance / goal 重建可走图：通道顶点、入口、终点、层间连接点是节点，
 * 通道段在落在它上面的节点处切开；房间连到落在它里面（或贴边 0.3 m 内）的节点；层间连接按两层底面高差计长。
 * @returns {{nodes: {s, p, kind}[], adj: [number, number][][], entrance: number, goal: number, dist: number[], passageNodes: number[], roomNodes: number[]}}
 */
export function interiorGraph(space) {
  const nodes = [], adj = [], index = new Map();
  const key = (s, p) => s + ":" + Math.round(p[0] * 20) + ":" + Math.round(p[1] * 20);
  const node = (s, p, kind) => { const k = key(s, p); if (index.has(k)) return index.get(k); nodes.push({ s, p: [p[0], p[1]], kind }); adj.push([]); index.set(k, nodes.length - 1); return nodes.length - 1; };
  const join = (a, b, w) => { if (a !== b && a >= 0 && b >= 0) { adj[a].push([b, w]); adj[b].push([a, w]); } };
  const P = (space.passages || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2 && p.points.every(isPt));
  const R = (space.rooms || []).filter((r) => r && validPoly(r.polygon));
  for (const p of P) for (const q of p.points) node(p.sublevel | 0, q, "v");
  const ent = isPt(space.entrance) ? node(entryLevel(space), space.entrance, "entrance") : -1;
  const goal = isPt(space.goal) ? node(goalLevel(space), space.goal, "goal") : -1;
  for (const l of space.links || []) if (l && isPt(l.at)) { node(l.from | 0, l.at, "link"); node(l.to | 0, l.at, "link"); }
  // 同层通道交叉处（直走廊穿过岔口时两条折线都没有那个顶点）也是节点
  const segs = [];
  for (const p of P) for (let i = 0; i + 1 < p.points.length; i++) segs.push([p.sublevel | 0, p.points[i], p.points[i + 1]]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [s, a, b] = segs[i], [t, c, d] = segs[j];
    if (s !== t) continue;
    const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-12) continue;
    const u = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, v = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
    if (u > -1e-9 && u < 1 + 1e-9 && v > -1e-9 && v < 1 + 1e-9) node(s, [a[0] + u * rx, a[1] + u * rz], "x");
  }
  const base = nodes.length;
  for (const p of P) {
    const s = p.sublevel | 0;
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = p.points[i], b = p.points[i + 1], L = d2(a, b) || 1e-9, on = [];
      for (let j = 0; j < base; j++) if (nodes[j].s === s && distToSegment(nodes[j].p, a, b) <= 0.05) on.push([((nodes[j].p[0] - a[0]) * (b[0] - a[0]) + (nodes[j].p[1] - a[1]) * (b[1] - a[1])) / (L * L), j]);
      on.sort((x, y) => x[0] - y[0]);
      for (let k = 0; k + 1 < on.length; k++) join(on[k][1], on[k + 1][1], d2(nodes[on[k][1]].p, nodes[on[k + 1][1]].p));
    }
  }
  const roomNodes = R.map((r) => {
    const s = r.sublevel | 0, c = node(s, polygonCentroid(r.polygon), "room");
    for (let j = 0; j < nodes.length; j++) if (j !== c && nodes[j].s === s && (pointInPolygon(nodes[j].p, r.polygon) || distToPolygon(nodes[j].p, r.polygon) <= 0.3)) join(c, j, d2(nodes[j].p, nodes[c].p));
    return c;
  });
  R.forEach((r, i) => R.forEach((q, k) => { if (k > i && (r.sublevel | 0) === (q.sublevel | 0) && (r.polygon.some((p) => pointInPolygon(p, q.polygon)) || q.polygon.some((p) => pointInPolygon(p, r.polygon)))) join(roomNodes[i], roomNodes[k], d2(nodes[roomNodes[i]].p, nodes[roomNodes[k]].p)); }));
  for (const l of space.links || []) if (l && isPt(l.at)) join(index.get(key(l.from | 0, l.at)), index.get(key(l.to | 0, l.at)), Math.abs(levelFloor(space, l.to | 0) - levelFloor(space, l.from | 0)));
  return { nodes, adj, entrance: ent, goal, dist: dijkstra(adj, ent), passageNodes: P.map((p) => index.get(key(p.sublevel | 0, p.points[0]))), roomNodes };
}

// ============================================================ 检查
/**
 * 空间的检查（追加到关系检查之后；没有空间时返回 []）。格式同 relations.js 的 Check：{ id, text, ok, detail, severity, fixes[, ignored] }。
 * spaces_connected：从地面沿连接点能到每个空间；fixes「补一个连接点」「不重要」。
 * interior_connected：每个空间内部的通道 / 房间从入口都走得到；fixes「重新生成内部」「不重要」。
 * spaces_clear_of_terrain：每层每条通道、每个房间——地下顶板离地面 ≥ 2 m、空中板底离地面 ≥ 3 m；fixes「下移 / 上移到合格高度」「不重要」。
 * @returns {object[]}
 */
export function spaceChecks(sid, T) {
  const spaces = (sid.spaces || []).filter(isSpace);
  if (!spaces.length) return [];
  const ignored = new Set((sid.meta && sid.meta.ignored_checks) || []);
  const ignoreFix = (id) => ({ label: "不重要", patch(s) { s.meta = s.meta || {}; const arr = (s.meta.ignored_checks = s.meta.ignored_checks || []); if (!arr.includes(id)) arr.push(id); } });
  const mk = (id, text, ok, detail, severity, fixes) => Object.assign({ id, text, ok, detail, severity, fixes }, ignored.has(id) ? { ignored: true, detail: "已标记不重要 · " + detail } : {});
  const name = (s) => s.label || s.id, out = [];

  const conns = (sid.markers || []).filter((m) => m && m.kind === "connector");
  const reached = new Set(["ground"]);
  for (let changed = true; changed;) { changed = false; for (const c of conns) for (const [a, b] of [[c.from, c.to], [c.to, c.from]]) if (reached.has(a) && !reached.has(b)) { reached.add(b); changed = true; } }
  const lonely = spaces.filter((s) => !reached.has(s.id));
  out.push(mk("spaces_connected", "每个空间 都连到地面", !lonely.length, lonely.length ? lonely.map((s) => `${name(s)} 没有连接点通到地面`).join("、") : `${spaces.length} 个空间都连通`, "warn",
    lonely.length ? [{ label: "补一个连接点", patch(s) {
      s.markers = s.markers || [];
      for (const sp of lonely) {
        const o = (s.spaces || []).find((x) => x.id === sp.id);
        if (!o) continue;
        const c = connectorFor(Object.assign({}, o, { connect_space: null }), s, T);
        for (let n = 2; s.markers.some((m) => m && m.id === c.id); n++) c.id = `conn_${o.id}_${n}`;
        s.markers.push(c);
      }
    } }, ignoreFix("spaces_connected")] : []));

  const inner = spaces.filter((s) => (s.passages && s.passages.length) || (s.rooms && s.rooms.length));
  if (inner.length) {
    const bad = [];
    let pm = 0, rm = 0;
    for (const s of inner) {
      const G = interiorGraph(s), lostP = G.passageNodes.filter((n) => n === undefined || !Number.isFinite(G.dist[n])).length, lostR = G.roomNodes.filter((n) => !Number.isFinite(G.dist[n])).length;
      pm += (s.passages || []).reduce((a, p) => a + polyLen(p.points || []), 0); rm += (s.rooms || []).length;
      if (G.entrance < 0) bad.push({ s, text: `${name(s)} 没有入口` });
      else if (lostP || lostR) bad.push({ s, text: `${name(s)} 有 ${[lostP ? lostP + " 段通道" : "", lostR ? lostR + " 个房间" : ""].filter(Boolean).join("、")}从入口走不到` });
    }
    out.push(mk("interior_connected", "空间内部 全部走得到", !bad.length, bad.length ? bad.map((x) => x.text).join("；") : `${inner.length} 个空间内部全连通（通道 ${Math.round(pm)} m、房间 ${rm} 间）`, "warn",
      bad.length ? [{ label: "重新生成内部", patch(s) {
        for (const { s: sp } of bad) { const o = (s.spaces || []).find((x) => x.id === sp.id); if (!o) continue; const r = buildInterior(Object.assign({}, o, { user_height: true }), s, T, { seed: o.layout_seed }); delete r.warnings; Object.assign(o, r); }
      } }, ignoreFix("interior_connected")] : []));
  }

  const bad = spaces.map((s) => ({ s, c: spaceClearance(s, T) })).filter((x) => !x.c.ok);
  const under = bad.filter((x) => x.s.stratum !== "sky").length, sky = bad.length - under;
  const where = (s, c) => (c.worst && c.worst.kind !== "outline" ? `（第 ${c.worst.sublevel + 1} 层${c.worst.kind === "room" ? "房间" : "通道"} ${c.worst.id}）` : "");
  out.push(mk("spaces_clear_of_terrain", "空间 不穿地形", !bad.length,
    bad.length ? bad.map(({ s, c }) => `${name(s)}${where(s, c)} ${s.stratum === "sky" ? "板底离地面" : "顶板离地面"} ${c.gap} m（需 ≥ ${c.need} m）`).join("、") : `${spaces.length} 个空间每层都和地形留够了距离`, "error",
    bad.length ? [{ label: !sky ? "下移到合格高度" : !under ? "上移到合格高度" : "移到合格高度", patch(s) {
      for (const { s: sp, c } of bad) {
        const o = (s.spaces || []).find((x) => x.id === sp.id);
        if (!o) continue;
        setSpaceFloor(o, c.limit);
        for (const m of s.markers || []) if (m && m.kind === "connector" && (m.to === o.id || m.from === o.id)) connectorHeights(m, s, T);
      }
    } }, ignoreFix("spaces_clear_of_terrain")] : []));
  return out;
}

/** 空间汇总（给 facts / 构成清单的关键值） */
export function spaceFacts(sid) {
  const spaces = (sid.spaces || []).filter(isSpace);
  const items = spaces.map((s) => Object.assign({ id: s.id, plan_id: s.plan_id || s.id, label: s.label || s.id, stratum: s.stratum, layout: s.layout || null, sublevels: levelsOf(s) }, s.facts || {}));
  return {
    total: spaces.length, underground: spaces.filter((s) => s.stratum === "underground").length, sky: spaces.filter((s) => s.stratum === "sky").length,
    connectors: (sid.markers || []).filter((m) => m && m.kind === "connector").length,
    passage_m: r1(items.reduce((a, x) => a + (x.passage_m || 0), 0)), rooms: items.reduce((a, x) => a + (x.rooms || 0), 0), items,
  };
}
