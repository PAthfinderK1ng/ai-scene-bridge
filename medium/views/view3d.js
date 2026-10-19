// views/view3d.js — 3D 预览（只看，不编辑；原 preview3d.js）。three.js 走 importmap（jsdelivr），离线 / 没有 WebGL 时给一行字而不是报错。
// 两种用法：中栏「3D」整页，和俯视图 / 剖面右下角的「3D 小窗」（inset：不出提示文字，仍可转视角）。
// 画：地形（可调透明度，地下层自动 35%）、全部体块（v5：按 shape 出 Box / Cylinder / Cone / 半球 / Sphere / Torus / n 边柱 / 四棱锥 / 楔 / 拱，
// 屋顶按 roof 叠上，浮岛 = 倒锥 + 草顶，悬空按 elev；同几何 ≥ 3 件合成 InstancedMesh）、路（按 style：带子 / 台阶 / 桥面 + 桥墩 / 索桥 / 隧道 / 运河 / 传送门）、水面、出生点、
// 空间内部实体（通道 = 沿折线的盒子、房间 = 多边形挤出、层间连接 = 竖梯；当前内部层实、其它层半透明）、连接点、剖切面。
// 纯函数式挂载：数据进（ctx），回调没有；不调 AI。
import { paletteOf, spawnY, sublevelOf, SELECT_COLOR, ROOM_FILL, shapeOf, volDims, roofOf, volumeBase, volumeTop, volumeColor, volumeType, ROUND_SHAPES, prismSides, archThickness, torusTube, pathStyleOf, pierPoints, ringOf, marksOf } from "./map.js";
import { SKY_TOD, LIGHT_TOD } from "./eye.js";
import { sectionPath } from "../engine/section.js";
import { CLEARANCE, levelsOf } from "../engine/interior.js";
import { pathCrossings } from "../engine/routing.js";

let THREE = null, OrbitControls = null, loadErr = null;
async function lib() {
  if (THREE || loadErr) return !loadErr;
  try { THREE = await import("three"); ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js")); return true; }
  catch (e) { loadErr = e; return false; }
}
/** 地下层时地面自动透明度 */
export const UNDERGROUND_OPACITY = 0.35;
const SKY_OPACITY = 0.28;
/** 地面渐变两端色 [低处, 高处]：色板的 ground / 地面 / 沙 / 土 角色优先，否则按 site.ground */
const GROUND_TINT = { desert: ["#f0dcae", "#c79f62"], lake: ["#dccfa8", "#8fae7a"], coast: ["#e8dab2", "#93ae7c"], island: ["#e8dab2", "#8fae7a"], canyon: ["#d6b38a", "#94694a"], mountain: ["#d2cab6", "#857f6e"], cavern: ["#706759", "#47413a"], sky: ["#f6f9fd", "#e2eaf4"], hills: ["#e6dfc8", "#93ad80"], rolling: ["#e8e1cc", "#9fb38a"] };
export function groundTint(sid) {
  const g = (sid.meta && sid.meta.ground) || "flat", pal = (sid.style && sid.style.palette) || [];
  const own = g === "sky" ? null : pal.find((q) => q && /^(ground|地面|地|沙|沙地|土|草地)$/.test(String(q.role || "")) && /^#[0-9a-f]{6}$/i.test(q.hex || ""));
  if (own) { const c = new THREE.Color(own.hex), l = c.clone().lerp(new THREE.Color("#ffffff"), 0.35); return ["#" + l.getHexString(), "#" + c.getHexString()]; }
  return GROUND_TINT[g] || ["#e9e2cf", "#9fb38a"];
}
/** 重建节流（毫秒） */
export const THROTTLE_MS = 150;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const UG_COLOR = "#3b3a52", WAY_COLOR = "#cdb894", SKY_WAY = "#a0784a", SLAB_COLOR = "#a39a88", CONN_COLOR = "#6b4f2a", SEC_COLOR = "#7a4fc9";

/**
 * 挂载到 container，立即返回句柄（three.js 在后台加载；加载前的调用会记住，加载后按最后一次画）。
 * @param {HTMLElement} container
 * @param {object} ctx { sid, T, stratum?, interiorLevel?: 0|1|2, section?: {mode, line, width_m}, selected?: {plan_id?, sid_id?} }
 * @param {{inset?: boolean}} [o] inset = 3D 小窗（不出提示文字）
 * @returns {{ ready: Promise<boolean>, offline: boolean, update(ctx), setGroundOpacity(o: number|null), setSection(section|null), setBrush(brush|null), snapshot(): string|null, debug(): object, dispose() }}
 *   setBrush({ point: [x, z]（世界）, radius_m, delta_m?, mode? }) 画高度笔刷圈（null 收起）；ctx.marks / plan.marks 画成贴地虚线与图钉（名字 mark:<id>）。
 *   debug() = { names, groundOpacity, section, builds, volumes: { volumes, shapes: {shape: 个数}, meshes, instanced, instances }, calls }
 *   update 节流 150 ms；setGroundOpacity(null) 回到自动（地下层 35%，其它 100%）；setSection 接受 {mode, line, width_m} 或有 path 的采样结果，null 收起；
 *   ctx.section 在 update 时也会同步剖切面（显式 setSection 优先）。
 */
export function mountView3d(container, ctx, o = {}) {
  const inset = !!o.inset;
  container.replaceChildren();
  let impl = null, alive = true, cur = ctx, opacity = null, section, sectionSet = false, brush = null;
  const handle = {
    offline: false,
    ready: null,
    update(c) { if (!alive || !c) return; cur = c; if (impl) impl.update(c); },
    setGroundOpacity(op) { opacity = op == null ? null : Math.max(0.05, Math.min(1, Number(op))); if (impl) impl.setGroundOpacity(opacity); },
    setSection(sec) { section = sec || null; sectionSet = true; if (impl) impl.setSection(section); },
    setBrush(b) { brush = b || null; if (impl) impl.setBrush(brush); },
    snapshot() { return impl ? impl.snapshot() : null; },
    debug() { return impl ? impl.debug() : { names: [], loading: !handle.offline }; },
    dispose() { alive = false; if (impl) impl.dispose(); else container.replaceChildren(); },
  };
  handle.ready = (async () => {
    const note = (text) => { const n = document.createElement("div"); n.className = "hint three-offline"; n.style.cssText = inset ? "padding:8px;font-size:12px;line-height:1.4" : "padding:20px"; n.textContent = inset ? text[0] : text[1]; container.replaceChildren(n); handle.offline = true; return false; };
    if (!(await lib())) return note(["3D 需要联网（three.js）", "3D 预览需要联网加载 three.js（cdn.jsdelivr.net）。离线时请看俯视图 / 剖面 / 第一眼。"]);
    if (!alive) return false;
    try { impl = create(container, cur, inset); }
    catch (e) { return note(["3D 不可用（没有 WebGL）", "这台机器的浏览器没有 WebGL，3D 预览不可用。请看俯视图 / 剖面 / 第一眼。"]); }
    if (opacity != null) impl.setGroundOpacity(opacity);
    if (sectionSet) impl.setSection(section);
    if (brush) impl.setBrush(brush);
    return true;
  })();
  return handle;
}

function create(container, ctx, inset) {
  const renderer = new THREE.WebGLRenderer({ antialias: !inset, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  container.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#eef1f2");
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  /** 天色与光照按 sid.style.lighting.time_of_day（与第一眼同一张配色表）；没写时段 = 原来的浅灰白天 */
  const applySky = (sid) => {
    const tod = sid && sid.style && sid.style.lighting && sid.style.lighting.time_of_day, sk = tod && SKY_TOD[tod], L = (tod && LIGHT_TOD[tod]) || [0xffffff, 0x8a8a7a, 0.9, 0xffffff, 1.1];
    scene.background = sk ? new THREE.Color(sk[0]).lerp(new THREE.Color(sk[1]), 0.55) : new THREE.Color("#eef1f2");
    hemi.color.setHex(L[0]); hemi.groundColor.setHex(L[1]); hemi.intensity = L[2]; sun.color.setHex(L[3]); sun.intensity = L[4];
    // 小窗只有 320×240，夜里按原光照几乎全黑、地形起伏看不出：小窗夜里提亮（天色、灯照旧，仍是夜景）
    if (inset && tod === "night") { hemi.groundColor.setHex(0x4a5274); hemi.intensity = 0.95; sun.intensity = 0.85; }
    container.dataset.tod = tod || "";
  };
  sun.position.set(-60, 80, 40); scene.add(sun);
  if (!inset) { const n = document.createElement("div"); n.className = "three-note"; n.textContent = "拖动旋转 · 滚轮缩放 · 右键平移"; container.append(n); }

  let volStats = null, group = new THREE.Group(), secMesh = null, brushMesh = null, brushCfg = null, groundMat = null, nBuilds = 0, alive = true, dirty = true, cur = ctx, secCfg, secExplicit = false, manualOpacity = null, lastBuild = 0, timer = null, pending = null, placed = false;
  scene.add(group);
  const resize = () => { const w = container.clientWidth || (inset ? 320 : 600), h = container.clientHeight || (inset ? 220 : 400); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  controls.addEventListener("change", () => { dirty = true; });
  const disposeTree = (obj) => obj.traverse((x) => { if (x.geometry && !x.geometry.userData.shared) x.geometry.dispose(); if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach((m) => m.dispose()); });
  const skyGround = (c) => !!(c && c.sid && c.sid.meta && c.sid.meta.ground === "sky");
  const opacityFor = (c) => (manualOpacity != null ? manualOpacity : c.stratum === "underground" ? UNDERGROUND_OPACITY : skyGround(c) ? SKY_OPACITY : 1);
  function applyOpacity() { if (!groundMat) return; const op = opacityFor(cur); groundMat.opacity = op; groundMat.transparent = op < 1; groundMat.depthWrite = op >= 1; groundMat.needsUpdate = true; dirty = true; }
  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial(Object.assign({ color }, extra));

  /** 镜头对准村子（房子 / 地标 / 空间 / 入口的包围球），不对整块地形 */
  function fitCamera(sid) {
    const pts = [];
    for (const v of sid.volumes || []) if (v.position && v.size) { const [w, , d] = volDims(v), r = Math.max(w, d) / 2, y0 = volumeBase(v, cur.T), y1 = volumeTop(v, cur.T); for (const [dx, dz] of [[-r, -r], [r, r]]) pts.push([v.position[0] + dx, y0, v.position[2] + dz], [v.position[0] + dx, y1, v.position[2] + dz]); }
    for (const sp of sid.spaces || []) if (sp.polygon) for (const q of sp.polygon) pts.push([q[0], sp.floor_y || 0, q[1]]);
    for (const m of sid.markers || []) if (m.kind === "player_spawn" && m.position) pts.push(m.position);
    const b = sid.bounds;
    if (!pts.length) pts.push([b.min[0], 0, b.min[2]], [b.max[0], 0, b.max[2]]);
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])));
    const c = lo.map((v, k) => (v + hi[k]) / 2), r = Math.max(12, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const d = (r / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * (inset ? 0.92 : 1), dir = new THREE.Vector3(0.12, 0.62, 0.78).normalize();
    controls.target.set(c[0], c[1], c[2]);
    camera.position.set(c[0] + dir.x * d, c[1] + dir.y * d, c[2] + dir.z * d);
    controls.update();
  }

  function build(c) {
    cur = c; lastBuild = performance.now(); nBuilds++;
    scene.remove(group); disposeTree(group);
    group = new THREE.Group();
    const { sid, T } = c, pal = paletteOf(sid), b = sid.bounds, sel = c.selected || null;
    applySky(sid);
    const isSel = (o) => !!sel && ((sel.sid_id && sel.sid_id === o.id && !sel.part) || (!sel.sid_id && sel.plan_id && (o.plan_id === sel.plan_id || o.zone_id === sel.plan_id)));
    const W = b.max[0] - b.min[0], D = b.max[2] - b.min[2], seg = inset ? 40 : 60;
    // 地形：PlaneGeometry 转到 XZ，按 heightAt 抬高；顶点色按层
    const geo = new THREE.PlaneGeometry(W, D, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), layer = (sid.meta && sid.meta.layer_height_m) || 3;
    // 地面色按题材：色板里有 ground / 地面 角色就用它，否则按 site.ground 选一组（沙漠沙色、湖海岸色、峡谷岩色、云上半透明云层）；低处 → 高处渐变
    const tint = groundTint(sid), lo = new THREE.Color(tint[0]), hi = new THREE.Color(tint[1]), tmp = new THREE.Color(), hs = new Float32Array(pos.count);
    let h0 = Infinity, h1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (b.min[0] + b.max[0]) / 2, z = pos.getZ(i) + (b.min[2] + b.max[2]) / 2, h = T.heightAt(x, z);
      pos.setX(i, x); pos.setZ(i, z); pos.setY(i, h); hs[i] = h; h0 = Math.min(h0, h); h1 = Math.max(h1, h);
    }
    const span = Math.max(layer * 2, h1 - h0);
    for (let i = 0; i < pos.count; i++) {
      tmp.copy(lo).lerp(hi, Math.min(1, Math.max(0, (hs[i] - h0) / span)));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    if (skyGround(c)) { const op = opacityFor(c); groundMat.transparent = op < 1; groundMat.opacity = op; groundMat.depthWrite = op >= 1; } // 没有地面：只是一层薄云
    const ground = new THREE.Mesh(geo, groundMat);
    ground.name = "ground"; ground.renderOrder = 2;
    group.add(ground);

    // 体块（按形体）、路（按 style）、水面
    const vm = volumeMeshes(c, pal, isSel);
    volStats = vm.stats; group.add(vm.group, pathMeshes(c, isSel), waterMeshes(c));
    const matBridge = mat("#cfc6ae");
    for (const br of pathCrossings(sid.paths || [])) { const L = (br.width || 4) + 2, m = new THREE.Mesh(new THREE.BoxGeometry(L, 0.5, 3), matBridge); m.position.set(br.at[0], T.heightAt(br.at[0], br.at[1]) + 0.6, br.at[1]); m.rotation.y = -Math.atan2(br.dir[1], br.dir[0]); group.add(m); }
    const sp = (sid.markers || []).find((m) => m.kind === "player_spawn");
    if (sp) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.2, 8), mat("#1f6feb"));
      cone.position.set(sp.position[0], spawnY(sp, T) + 1.1, sp.position[2]); cone.name = "spawn";
      group.add(cone);
      const th = ((sp.rotation_y || 0) * Math.PI) / 180;
      group.add(new THREE.ArrowHelper(new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th)), cone.position.clone(), 8, 0x1f6feb, 2, 1));
    }
    for (const s of sid.spaces || []) { const m = spaceGroup(s, c, sel); if (m) group.add(m); }
    for (const m of sid.markers || []) if (m.kind === "connector" && Array.isArray(m.position)) group.add(connectorMesh(m));
    group.add(markMeshes(c));
    scene.add(group);
    applyOpacity();
    if (!secExplicit) secCfg = c.section || null;
    drawSection(); drawBrush();
    if (!placed) { fitCamera(sid); placed = true; }
    dirty = true;
  }

  /** 多边形挤出：(x, z) → 形状 (x, −z)，转到世界后挤出方向 = +y */
  const extrude = (poly, depth) => { const g = new THREE.ExtrudeGeometry(new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z))), { depth, bevelEnabled: false }); g.rotateX(-Math.PI / 2); return g; };
  /**
   * 空间：有内部时画内部实体（通道盒子 / 房间挤出 / 层间竖梯）+ 外轮廓线框；没有内部时画整块（地下半透明暗色体、空中 1 m 板）。
   * 当前层（stratum 相同）里只有当前内部层实画，其它内部层半透明；别的层整体淡。
   */
  function spaceGroup(s, c, sel) {
    if (!Array.isArray(s.polygon) || s.polygon.length < 3) return null;
    const g = new THREE.Group(), under = s.stratum === "underground", n = levelsOf(s), step = (Number(s.height) || 3) + (under ? CLEARANCE.rock : CLEARANCE.slab);
    g.name = "space:" + s.id;
    const faded = c.stratum && c.stratum !== "ground" && c.stratum !== s.stratum, cur = c.stratum === s.stratum ? sublevelOf(s, c.interiorLevel) : null;
    const hotAll = !!sel && ((sel.plan_id && (s.plan_id || s.id) === sel.plan_id && !sel.part) || (sel.sid_id === s.id && !sel.part));
    const P = (s.passages || []).filter((p) => p && Array.isArray(p.points) && p.points.length >= 2), R = (s.rooms || []).filter((r) => r && Array.isArray(r.polygon) && r.polygon.length >= 3);
    const top = s.floor_y + (n - 1) * step + s.height;
    // 外轮廓线框（从最下层底面到最上层顶）
    const env = extrude(s.polygon, Math.max(0.5, top - s.floor_y + (under ? 0 : 0)));
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(env), new THREE.LineBasicMaterial({ color: under ? "#1d1c28" : "#3d8bd0", transparent: true, opacity: faded ? 0.25 : 0.7 }));
    frame.position.y = s.floor_y; frame.name = "space_frame:" + s.id; g.add(frame); env.dispose();
    if (!P.length && !R.length) {
      const mesh = new THREE.Mesh(extrude(s.polygon, under ? Math.max(0.5, s.height) : CLEARANCE.slab), under ? mat(hotAll ? SELECT_COLOR : UG_COLOR, { transparent: true, opacity: faded ? 0.25 : 0.6, depthWrite: false }) : mat(hotAll ? SELECT_COLOR : SLAB_COLOR, { transparent: faded, opacity: faded ? 0.35 : 1 }));
      mesh.position.y = under ? s.floor_y : s.floor_y - CLEARANCE.slab; mesh.renderOrder = under ? 1 : 0; mesh.name = "space_body:" + s.id; g.add(mesh);
      return g;
    }
    const alpha = (lvl) => (faded ? 0.22 : cur == null || lvl === cur ? 0.95 : 0.3);
    const mats = new Map(), M = (color, a) => { const k = color + a; if (!mats.has(k)) mats.set(k, mat(color, { transparent: a < 1, opacity: a, depthWrite: a >= 0.9 })); return mats.get(k); };
    const hotPart = (id) => hotAll || (!!sel && sel.part === id && (sel.sid_id === s.id || sel.plan_id === (s.plan_id || s.id)));
    for (const p of P) {
      const lvl = p.sublevel | 0, fy = Number.isFinite(p.floor_y) ? p.floor_y : s.floor_y + lvl * step, H = under ? Number(p.height) || s.height : 0.4, w = Number(p.width) || 2;
      const m = M(hotPart(p.id) ? SELECT_COLOR : under ? WAY_COLOR : SKY_WAY, alpha(lvl));
      for (let i = 0; i + 1 < p.points.length; i++) {
        const a = p.points[i], q = p.points[i + 1], L = Math.hypot(q[0] - a[0], q[1] - a[1]);
        if (L < 0.05) continue;
        const box = new THREE.Mesh(new THREE.BoxGeometry(L + w, H, w), m);
        box.position.set((a[0] + q[0]) / 2, fy + H / 2 - (under ? 0 : 0.4), (a[1] + q[1]) / 2);
        box.rotation.y = -Math.atan2(q[1] - a[1], q[0] - a[0]);
        box.name = `passage:${s.id}/${p.id}`; box.renderOrder = 1;
        g.add(box);
      }
    }
    for (const r of R) {
      const lvl = r.sublevel | 0, fy = Number.isFinite(r.floor_y) ? r.floor_y : s.floor_y + lvl * step, H = under ? Number(r.height) || s.height : CLEARANCE.slab;
      const mesh = new THREE.Mesh(extrude(r.polygon, H), M(hotPart(r.id) ? SELECT_COLOR : ROOM_FILL[r.role] || ROOM_FILL.chamber, alpha(lvl)));
      mesh.position.y = under ? fy : fy - CLEARANCE.slab; mesh.name = `room:${s.id}/${r.id}`; mesh.renderOrder = 1;
      g.add(mesh);
    }
    for (const l of s.links || []) {
      if (!l || !Array.isArray(l.at)) continue;
      const y0 = s.floor_y + Math.min(l.from | 0, l.to | 0) * step, y1 = s.floor_y + Math.max(l.from | 0, l.to | 0) * step + s.height, lad = new THREE.Mesh(new THREE.BoxGeometry(0.5, y1 - y0, 0.5), M(CONN_COLOR, faded ? 0.3 : 1));
      lad.position.set(l.at[0], (y0 + y1) / 2, l.at[1]); lad.name = `link:${s.id}/${l.id}`; g.add(lad);
    }
    for (const [pt, color, nm] of [[s.entrance, "#2f8f4e", "entrance"], [s.goal, "#c0392b", "goal"]]) {
      if (!Array.isArray(pt)) continue;
      const lvl = nm === "entrance" ? (under ? n - 1 : 0) : under ? 0 : n - 1, fy = s.floor_y + lvl * step;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 12), M(color, faded ? 0.3 : 1));
      m.position.set(pt[0], fy + 0.2, pt[1]); m.name = `${nm}:${s.id}`; g.add(m);
    }
    return g;
  }

  /** 连接点：竖向符号（下端 bottom_y，上端 top_y） */
  function connectorMesh(m) {
    const g = new THREE.Group(), x = m.position[0], z = m.position[2];
    g.name = "connector:" + m.id;
    const y0 = Number.isFinite(m.bottom_y) ? m.bottom_y : m.position[1], y1 = Number.isFinite(m.top_y) ? m.top_y : y0 + 3, H = Math.max(0.5, y1 - y0), mm = mat(CONN_COLOR);
    const box = (w, h, d, px, py, pz, ry = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mm); b.position.set(px, py, pz); b.rotation.y = ry; g.add(b); };
    if (m.via === "stairs") { const n = Math.min(80, Math.max(3, Math.round(H / 0.5))); for (let i = 0; i < n; i++) { const a = (i / 8) * Math.PI * 2; box(1.4, 0.15, 0.5, x + Math.cos(a) * 0.8, y0 + (H * (i + 0.5)) / n, z + Math.sin(a) * 0.8, -a); } box(0.2, H, 0.2, x, y0 + H / 2, z); }
    else if (m.via === "ladder") { box(0.12, H, 0.12, x - 0.4, y0 + H / 2, z); box(0.12, H, 0.12, x + 0.4, y0 + H / 2, z); for (let y = y0 + 0.3; y < y1; y += 0.6) box(0.8, 0.06, 0.06, x, y, z); }
    else if (m.via === "well" || m.via === "shaft") { const r = m.via === "shaft" ? 1.6 : 1.1, cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 16, 1, true), mat(CONN_COLOR, { transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })); cyl.position.set(x, y0 + H / 2, z); g.add(cyl); }
    else if (m.via === "elevator") { const fr = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, H, 2)), new THREE.LineBasicMaterial({ color: CONN_COLOR })); fr.position.set(x, y0 + H / 2, z); g.add(fr); box(1.8, 0.15, 1.8, x, y0 + H / 2, z); }
    else box(0.35, H, 0.35, x, y0 + H / 2, z);
    for (const y of [y0, y1]) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 12), mm); d.position.set(x, y + 0.05, z); g.add(d); }
    return g;
  }

  /** 剖切面：沿剖切折线的半透明竖面（上下各留余量）+ 贴地的宽度带 */
  function drawSection() {
    if (secMesh) { scene.remove(secMesh); disposeTree(secMesh); secMesh = null; }
    if (!secCfg || !cur) return;
    const path = Array.isArray(secCfg.path) && secCfg.path.length > 1 ? secCfg.path : sectionPath(secCfg, cur.sid);
    if (!path || path.length < 2) return;
    let lo = 0, hi = 10;
    for (const p of path) { const h = cur.T.heightAt(p[0], p[1]); hi = Math.max(hi, h); lo = Math.min(lo, h); }
    for (const s of cur.sid.spaces || []) { lo = Math.min(lo, s.floor_y - CLEARANCE.slab); hi = Math.max(hi, s.floor_y + (levelsOf(s) - 1) * ((s.height || 3) + 2) + s.height); }
    lo -= 2; hi += 10;
    const pos = [], idx = [];
    path.forEach((p, i) => { pos.push(p[0], lo, p[1], p[0], hi, p[1]); if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    secMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SEC_COLOR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    secMesh.name = "section"; secMesh.renderOrder = 3;
    secMesh.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p[0], cur.T.heightAt(p[0], p[1]) + 0.3, p[1]))), new THREE.LineBasicMaterial({ color: SEC_COLOR })));
    const band = widthBand(path, Number(secCfg.width_m) || 0);
    if (band) secMesh.add(band);
    scene.add(secMesh);
    dirty = true;
  }
  /** 宽度带：贴地的半透明网格带（沿线每 2 m、横向 4 格），和俯视图的紫带对应 */
  function widthBand(path, w) {
    if (!(w > 0)) return null;
    const S = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = S.length ? 1 : 0; k <= n; k++) S.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, (b[0] - a[0]) / L, (b[1] - a[1]) / L]);
    }
    if (S.length < 2) return null;
    const C = 4, pos = [], idx = [];
    S.forEach(([x, z, dx, dz], i) => {
      for (let c = 0; c <= C; c++) { const o = (c / C - 0.5) * w, px = x - dz * o, pz = z + dx * o; pos.push(px, cur.T.heightAt(px, pz) + 0.3, pz); }
      if (i) for (let c = 0; c < C; c++) { const a = (i - 1) * (C + 1) + c, b = i * (C + 1) + c; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SEC_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    m.name = "section_band"; m.renderOrder = 4;
    return m;
  }

  /** 高度笔刷圈（docs/07 §4）：外圈 = 半径、内圈 = 60%，贴地；界面在拖动高度工具时调 setBrush */
  function drawBrush() {
    if (brushMesh) { scene.remove(brushMesh); disposeTree(brushMesh); brushMesh = null; }
    const B = brushCfg;
    if (!B || !cur || !Array.isArray(B.point) || !(B.radius_m > 0)) { dirty = true; return; }
    const color = B.mode === "flatten" ? SEC_COLOR : (B.delta_m || 0) < 0 ? "#2a6aa6" : "#c0392b", y0 = cur.T.heightAt(B.point[0], B.point[1]);
    brushMesh = new THREE.Group(); brushMesh.name = "height_brush";
    for (const k of [1, 0.6]) {
      const pts = [];
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2, x = B.point[0] + Math.cos(a) * B.radius_m * k, z = B.point[1] + Math.sin(a) * B.radius_m * k; pts.push(new THREE.Vector3(x, cur.T.heightAt(x, z) + 0.5, z)); }
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: k === 1 ? 1 : 0.6 }));
      l.renderOrder = 7; brushMesh.add(l);
    }
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(B.point[0], y0, B.point[1]), new THREE.Vector3(B.point[0], y0 + Math.max(1, Math.abs(B.delta_m || 0)) * Math.sign(B.delta_m || 1), B.point[1])]), new THREE.LineBasicMaterial({ color, depthTest: false }));
    pole.renderOrder = 7; brushMesh.add(pole);
    // 笔刷范围铺一层半透明的色（贴着地形起伏）：夜景、远看时也看得出鼓起 / 压低的那一块
    const disc = new THREE.RingGeometry(0.001, B.radius_m, 48, 8), pos = disc.attributes.position;
    for (let i = 0; i < pos.count; i++) { const x = B.point[0] + pos.getX(i), z = B.point[1] + pos.getY(i); pos.setXYZ(i, x, cur.T.heightAt(x, z) + 0.35, z); }
    disc.computeVertexNormals();
    const fill = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    fill.renderOrder = 6; brushMesh.add(fill);
    scene.add(brushMesh); dirty = true;
  }

  function loop() { if (!alive) return; controls.update(); if (dirty && renderer.domElement.clientWidth) { renderer.render(scene, camera); dirty = false; } requestAnimationFrame(loop); }
  resize(); build(ctx); loop();
  return {
    update(c) {
      if (!alive || !c) return;
      pending = c;
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (alive && pending) { const p = pending; pending = null; build(p); } }, Math.max(0, THROTTLE_MS - (performance.now() - lastBuild)));
    },
    setGroundOpacity(op) { manualOpacity = op; applyOpacity(); },
    setSection(sec) { secCfg = sec || null; secExplicit = true; drawSection(); },
    setBrush(b) { brushCfg = b || null; drawBrush(); },
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    debug() { const names = []; scene.traverse((x) => { if (x.name) names.push(x.name); }); return { names, groundOpacity: groundMat ? groundMat.opacity : null, section: !!secMesh, builds: nBuilds, volumes: volStats, calls: renderer.info.render.calls }; },
    dispose() { alive = false; if (timer) clearTimeout(timer); if (ro) ro.disconnect(); controls.dispose(); if (secMesh) disposeTree(secMesh); if (brushMesh) disposeTree(brushMesh); disposeTree(group); renderer.dispose(); container.replaceChildren(); },
  };
}

// ============================================================ 形体（v5）：单位几何 + 实例矩阵（缩放在矩阵里），同几何的件合进一个 InstancedMesh
/** 同一几何的件 ≥ 这个数就合批（InstancedMesh）；地标与选中的不合批（保留名字、单独着色） */
export const INSTANCE_MIN = 3;
const GEO = new Map();
/** 三角面几何（每面独立顶点 → 平面法线）；verts [[x,y,z]]，tris [[a,b,c]] 外侧逆时针 */
function triGeo(verts, tris) {
  const pos = [];
  for (const t of tris) for (const k of t) pos.push(...verts[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/**
 * 单位几何（底面在 y = 0，占地 1 × 1，高 1；按 key 缓存、不随重建释放）。
 * box · cyl:n（圆柱 / n 边柱）· cone:n · pyr（四棱锥）· dome（半球）· sphere · wedge（高边在 −z）· gable（屋脊沿 x）· icone:n（倒锥）·
 * torus:tr（平放的环，外径 1、管半径 tr，高 2·tr）· utorus:tr（立起来的环，环面在 xy 面，外径 1）· ring:k（空心圆柱：外径 1、带宽 k、高 1）· arch:t:h（宽 1、腿厚 t、高 h、深 1）
 */
function unitGeo(key) {
  if (GEO.has(key)) return GEO.get(key);
  const [kind, a1, a2] = key.split(":"), n1 = Number(a1), n2 = Number(a2);
  let g;
  if (kind === "box") { g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); }
  else if (kind === "cyl") { g = new THREE.CylinderGeometry(0.5, 0.5, 1, n1 || 20); g.translate(0, 0.5, 0); }
  else if (kind === "cone") { g = new THREE.ConeGeometry(0.5, 1, n1 || 20); g.translate(0, 0.5, 0); }
  else if (kind === "icone") { g = new THREE.ConeGeometry(0.5, 1, n1 || 7); g.rotateX(Math.PI); g.translate(0, 0.5, 0); }
  else if (kind === "pyr") { g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4); g.rotateY(Math.PI / 4); g.translate(0, 0.5, 0); }
  else if (kind === "dome") { g = new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, 2, 1); }
  else if (kind === "sphere") { g = new THREE.SphereGeometry(0.5, 20, 14); g.translate(0, 0.5, 0); }
  else if (kind === "wedge") g = triGeo([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]], [[0, 3, 2], [0, 2, 1], [3, 4, 5], [3, 5, 2], [0, 1, 5], [0, 5, 4], [0, 4, 3], [1, 2, 5]]);
  else if (kind === "gable") g = triGeo([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0]], [[0, 3, 2], [0, 2, 1], [0, 1, 5], [0, 5, 4], [3, 4, 5], [3, 5, 2], [0, 4, 3], [1, 2, 5]]);
  else if (kind === "torus") { const tr = n1 || 0.1; g = new THREE.TorusGeometry(0.5 - tr, tr, 10, 28); g.rotateX(Math.PI / 2); g.translate(0, tr, 0); }
  else if (kind === "utorus") { const tr = n1 || 0.1; g = new THREE.TorusGeometry(0.5 - tr, tr, 10, 28); g.translate(0, 0.5, 0); }
  else if (kind === "ring") { // 环形截面拉伸（中间是空的）：外圆 0.5，内圆 0.5 − k
    const k = Math.min(0.49, n1 || 0.08), s = new THREE.Shape(), hole = new THREE.Path();
    s.absarc(0, 0, 0.5, 0, Math.PI * 2, false); hole.absarc(0, 0, 0.5 - k, 0, Math.PI * 2, true); s.holes.push(hole);
    g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 40 }); g.rotateX(-Math.PI / 2);
  }
  else if (kind === "arch") {
    const t = n1 || 0.18, H = n2 || 1, yc = Math.max(0, H - 0.5), s = new THREE.Shape();
    s.moveTo(-0.5, 0); s.lineTo(-0.5, yc); s.absarc(0, yc, 0.5, Math.PI, 0, true); s.lineTo(0.5, 0); s.lineTo(0.5 - t, 0); s.lineTo(0.5 - t, yc);
    s.absarc(0, yc, 0.5 - t, 0, Math.PI, false); s.lineTo(-0.5 + t, 0); s.lineTo(-0.5, 0);
    g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 14 }); g.translate(0, 0, -0.5);
  } else { g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); }
  g.userData.shared = true;
  GEO.set(key, g);
  return g;
}
const q2 = (v) => Math.round(v * 50) / 50;
/** 形体的主体件：{geo, s: [sx, sy, sz], p?: [lx, ly, lz], ry?} */
function bodyPart(v) {
  const sh = shapeOf(v), [w, h, d] = volDims(v);
  if (sh === "cylinder") { const R = ringOf(v); return R && !R.torus && R.ix > 0.05 ? { geo: `ring:${q2(Math.max(0.02, R.wall / w))}`, s: [w, h, d] } : { geo: "cyl:20", s: [w, h, d] }; }
  if (sh === "prism") return { geo: `cyl:${prismSides(v)}`, s: [w, h, w] };
  if (sh === "cone") return { geo: "cone:20", s: [w, h, d] };
  if (sh === "pyramid") return { geo: "pyr", s: [w, h, d] };
  if (sh === "dome") return { geo: "dome", s: [w, h, d] };
  if (sh === "sphere") return { geo: "sphere", s: [w, h, d] };
  if (sh === "wedge") return { geo: "wedge", s: [w, h, d] };
  if (sh === "torus" && v.orient === "upright") return { geo: `utorus:${q2(Math.min(0.24, torusTube(v) / (2 * w)))}`, s: [w, w, w] };
  if (sh === "torus") return { geo: `torus:${q2(Math.min(0.24, torusTube(v) / (2 * w)))}`, s: [w, w, d] };
  if (sh === "arch") return { geo: `arch:${q2(archThickness(v) / w)}:${q2(h / w)}`, s: [w, w, d] };
  return { geo: "box", s: [w, h, d] };
}
/** 屋顶件（叠在墙身顶 y = h） */
function roofPart(v, r) {
  if (!r || r.type === "none" || !(r.h > 0.05)) return null;
  const sh = shapeOf(v), [w, h, d] = volDims(v), round = ROUND_SHAPES.has(sh), rh = r.h;
  const cone = sh === "prism" ? `cone:${prismSides(v)}` : "cone:20";
  if (r.type === "flat") return { geo: round ? "cyl:20" : "box", s: [w * 1.04, rh, d * 1.04], p: [0, h, 0] };
  if (r.type === "dome") return { geo: "dome", s: round ? [w, rh, d] : [Math.min(w, d), rh, Math.min(w, d)], p: [0, h, 0] };
  if (round) return { geo: cone, s: [w * 1.08, rh, d * 1.08], p: [0, h, 0] };
  if (r.type === "gable") return w >= d ? { geo: "gable", s: [w * 1.04, rh, d * 1.1], p: [0, h, 0] } : { geo: "gable", s: [d * 1.04, rh, w * 1.1], p: [0, h, 0], ry: Math.PI / 2 };
  return { geo: "pyr", s: [w * (r.type === "spire" ? 1.02 : 1.08), rh, d * (r.type === "spire" ? 1.02 : 1.08)], p: [0, h, 0] };
}

// ---------- 夜里发光的小件
const GLOW = "#ffd27a";
const LIGHT_RE = /灯|烛|火|焰|萤|炬|lantern|lamp|torch|candle|fire|glow/i;
const warmBright = (hex) => { const c = new THREE.Color(hex), hsl = {}; c.getHSL(hsl); return hsl.l >= 0.55 && hsl.s >= 0.45 && (hsl.h <= 0.17 || hsl.h >= 0.95); };
/** 是灯：名字里有灯 / 火 / 焰…（≤ 8 m 的小件），或暖亮色的小件（≤ 3 m） */
function isLight(v, w, h, d, color) {
  const big = Math.max(w, h, d);
  return (LIGHT_RE.test(String(v.label || "")) && big <= 8) || (big <= 3 && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) && warmBright(color));
}
/** 发光色：暖色的照原色提亮，其它（冷色的咒灯）也提亮一点 */
const glowColor = (hex) => { try { return "#" + new THREE.Color(hex).lerp(new THREE.Color("#ffffff"), 0.25).getHexString(); } catch { return GLOW; } };

/**
 * 体块 → 网格。每个体块拆成件（主体 / 屋顶 / 浮岛草顶 / 树干 / 吊脚柱），件的世界矩阵 = 平移(底面中心) · 转 rotation_y · 件偏移 · 缩放。
 * 同一单位几何的件 ≥ INSTANCE_MIN 个就合成一个 InstancedMesh（每实例自带颜色）；地标与选中的单独出网格（名字 landmark:id / house:id / shape:id）。
 * @returns {{ group, stats: { volumes, shapes: {shape: n}, meshes, instanced, instances } }}
 */
function volumeMeshes(c, pal, isSel) {
  const { sid, T } = c, out = new THREE.Group(), stats = { volumes: 0, shapes: {}, meshes: 0, instanced: 0, instances: 0, lights: 0 };
  out.name = "volumes";
  const buckets = new Map(), singles = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
  const matOf = new Map(), lam = (color, alpha = 1, glow = false) => { const k = color + "|" + alpha + "|" + glow; if (!matOf.has(k)) matOf.set(k, glow ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial(Object.assign({ color }, alpha < 1 ? { transparent: true, opacity: alpha, depthWrite: false } : {}))); return matOf.get(k); };
  // 夜里：灯 / 灯笼 / 火这些小件自己发光（不受暗光照影响）；细高的灯柱只在顶上点一盏
  const night = !!(sid.style && sid.style.lighting && sid.style.lighting.time_of_day === "night");
  for (const v of sid.volumes || []) {
    if (!v || !Array.isArray(v.position) || !Array.isArray(v.size)) continue;
    const sh = shapeOf(v), [w, h, d] = volDims(v), base = volumeBase(v, T), r = roofOf(v), lm = v.importance === "landmark", hot = isSel(v), type = volumeType(v);
    stats.volumes++; stats.shapes[sh] = (stats.shapes[sh] || 0) + 1;
    const body = hot ? SELECT_COLOR : lm ? "#b8452b" : v.kind === "tree" ? pal.foliage : volumeColor(v, pal, "side");
    const alpha = v.kind === "water" ? 0.6 : 1;
    const parts = [];
    if (v.kind === "island") {
      const top = Math.min(0.8, h * 0.15);
      parts.push({ geo: "icone:7", s: [w, h - top, d], color: hot ? SELECT_COLOR : "#8a7a5c" }, { geo: ROUND_SHAPES.has(sh) ? "cyl:20" : "box", s: [w * 1.02, top, d * 1.02], p: [0, h - top, 0], color: hot ? SELECT_COLOR : "#7d9a5f" });
    } else if (v.kind === "tree" && (sh === "cone" || sh === "sphere" || sh === "dome")) {
      const trunk = h * 0.28, b = bodyPart(v);
      parts.push(Object.assign(b, { s: [w, h - trunk, d], p: [0, trunk, 0], color: body }), { geo: "cyl:8", s: [Math.max(0.25, w * 0.12), trunk, Math.max(0.25, w * 0.12)], color: "#6b4f2a" });
    } else {
      parts.push(Object.assign(bodyPart(v), { color: body, alpha }));
      const rp = roofPart(v, r);
      if (rp) parts.push(Object.assign(rp, { color: hot ? SELECT_COLOR : lm ? pal.roof : pal.roof }));
    }
    if (night && !hot && isLight(v, w, h, d, body)) {
      if (h > 2.5 * Math.max(w, d) && h > 1.5) { const k = Math.max(0.6, Math.min(1.6, 3 * Math.max(w, d))); parts.push({ geo: "sphere", s: [k, k, k], p: [0, h, 0], color: GLOW, glow: true }); }
      else parts[0] = Object.assign(parts[0], { color: glowColor(body), glow: true });
      stats.lights++;
    }
    if (v.stilt_m > 0.2) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push({ geo: "box", s: [0.3, v.stilt_m, 0.3], p: [(sx * w) / 2.3, -v.stilt_m, (sz * d) / 2.3], color: "#8a6a44" });
    const rot = ((v.rotation_y || 0) * Math.PI) / 180, origin = new THREE.Matrix4().compose(new THREE.Vector3(v.position[0], base, v.position[2]), q.setFromAxisAngle(Y, rot).clone(), new THREE.Vector3(1, 1, 1));
    const name = `${lm ? "landmark" : type === "house" ? "house" : v.kind === "prop" ? "prop" : "shape"}:${v.id}`;
    parts.forEach((p, i) => {
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...(p.p || [0, 0, 0])), new THREE.Quaternion().setFromAxisAngle(Y, p.ry || 0), new THREE.Vector3(...p.s.map((x) => Math.max(0.01, x))));
      const M = origin.clone().multiply(local), a = p.alpha || 1, g = !!p.glow;
      if (lm || hot) { singles.push({ geo: p.geo, M, color: p.color, a, g, name: i === 0 ? name : `${name}#${i}` }); return; }
      const k = p.geo + "|" + a + "|" + (g ? "glow" : "");
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ geo: p.geo, M, color: p.color, a, g, name: i === 0 ? name : `${name}#${i}` });
    });
  }
  for (const [k, list] of buckets) {
    if (list.length < INSTANCE_MIN) { singles.push(...list); continue; }
    const a = list[0].a, mesh = new THREE.InstancedMesh(unitGeo(list[0].geo), lam("#ffffff", a, list[0].g), list.length), col = new THREE.Color();
    list.forEach((it, i) => { mesh.setMatrixAt(i, it.M); mesh.setColorAt(i, col.set(it.color)); });
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `inst:${k.split("|")[0]}`; mesh.userData.ids = list.map((it) => it.name);
    out.add(mesh); stats.meshes++; stats.instanced++; stats.instances += list.length;
  }
  for (const it of singles) {
    const mesh = new THREE.Mesh(unitGeo(it.geo), lam(it.color, it.a, it.g));
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(it.M); mesh.name = it.name;
    out.add(mesh); stats.meshes++;
  }
  return { group: out, stats };
}

/** 折线按地形采样（每 step 米一点，含端点）：[{x, z, dx, dz, t}]，t = 累计长度 */
function sampleLine(points, step) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L, n = Math.max(1, Math.ceil(L / step));
    for (let k = out.length ? 1 : 0; k <= n; k++) out.push({ x: a[0] + dx * (L * k) / n, z: a[1] + dz * (L * k) / n, dx, dz, t: acc + (L * k) / n });
    acc += L;
  }
  return out;
}
/** 贴地（或给定高度函数）的带子：宽 W，高度 yOf(s) */
function ribbon(S, W, yOf, material) {
  const pos = [], idx = [];
  S.forEach((s, i) => {
    const y = yOf(s);
    pos.push(s.x - s.dz * (W / 2), y, s.z + s.dx * (W / 2), s.x + s.dz * (W / 2), y, s.z - s.dx * (W / 2));
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}
/** 沿 S 每个采样点放一个盒子（InstancedMesh）：台阶 / 木板 */
function boxesAlong(S, size, yOf, material) {
  const m = new THREE.InstancedMesh(unitGeo("box"), material, Math.max(1, S.length)), M = new THREE.Matrix4(), Y = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
  S.forEach((s, i) => { M.compose(new THREE.Vector3(s.x, yOf(s), s.z), q.setFromAxisAngle(Y, -Math.atan2(s.dz, s.dx)), new THREE.Vector3(...size)); m.setMatrixAt(i, M); });
  m.count = S.length; m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere();
  return m;
}
/** 传送门：竖立的发光环 */
function portalMesh(at, y, name) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.25, 8, 28), new THREE.MeshLambertMaterial({ color: "#7a4fc9", emissive: "#3a1f80" }));
  m.position.set(at[0], y + 2, at[1]); m.name = name;
  return m;
}
/**
 * 路 / 桥 / 隧道 / 运河 / 传送门（按 style）。path（v4 的路）与 river 仍画贴地线；road / stairs / ramp / canal 画贴地带（stairs 加台阶块）；
 * bridge = 每段一块桥面（deck_y，缺省两端地面较高者 + 0.5）+ 桥墩（piers，地面到桥面的圆柱）；rope_bridge = 下垂的木板 + 两根索；
 * tunnel = 地面上的虚线 + 两端洞口；portal = 两端竖环。
 */
function pathMeshes(c, isSel) {
  const { sid, T } = c, out = new THREE.Group();
  out.name = "paths";
  const lam = (color, extra = {}) => new THREE.MeshLambertMaterial(Object.assign({ color, side: THREE.DoubleSide }, extra));
  for (const p of sid.paths || []) {
    if (!p.points || p.points.length < 2) continue;
    const st = p.kind === "river" ? "river" : pathStyleOf(p), hot = isSel(p), W = Math.max(0.8, Number(p.width) || (st === "road" ? 4 : 2)), P = p.points;
    const gy = (s) => T.heightAt(s.x, s.z);
    if (p.unrouted) { // 走不通的连接：两端小柱 + 一条虚线，不做路面
      const a = P[0], b = P[P.length - 1], ya = T.heightAt(a[0], a[1]) + 1, yb = T.heightAt(b[0], b[1]) + 1;
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], ya, a[1]), new THREE.Vector3(b[0], yb, b[1])]), new THREE.LineDashedMaterial({ color: hot ? SELECT_COLOR : "#b5523b", dashSize: 2, gapSize: 1.5 }));
      ln.computeLineDistances(); ln.name = "unrouted:" + p.id; out.add(ln);
      for (const [q, y] of [[a, ya], [b, yb]]) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2, 8), lam("#b5523b")); m.position.set(q[0], y, q[1]); out.add(m); }
      continue;
    }
    if (st === "river" || st === "path") {
      const vs = sampleLine(P, 2).map((s) => new THREE.Vector3(s.x, gy(s) + 0.25, s.z));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs), new THREE.LineBasicMaterial({ color: hot ? SELECT_COLOR : st === "river" ? "#4f86c6" : p.id === "main_trail" ? "#6b5a3a" : "#8b7d5b" }));
      line.name = "path:" + p.id; out.add(line); continue;
    }
    const g = new THREE.Group(); g.name = `${st}:${p.id}`; out.add(g);
    if (st === "bridge" || st === "rope_bridge") {
      const S = sampleLine(P, st === "rope_bridge" ? 0.8 : 2), total = S.length ? S[S.length - 1].t : 0;
      const deck = Number.isFinite(Number(p.deck_y)) && p.deck_y != null ? Number(p.deck_y) : Math.max(T.heightAt(P[0][0], P[0][1]), T.heightAt(P[P.length - 1][0], P[P.length - 1][1])) + 0.5;
      const sag = st === "rope_bridge" ? Math.min(3, total * 0.05) : 0, yOf = (s) => deck - (total > 0 ? sag * 4 * (s.t / total) * (1 - s.t / total) : 0);
      const wood = lam(hot ? SELECT_COLOR : st === "bridge" ? "#cfc6ae" : "#8a6a44");
      if (st === "bridge") {
        for (let i = 1; i < P.length; i++) {
          const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < 0.05) continue;
          const m = new THREE.Mesh(new THREE.BoxGeometry(L + 0.2, 0.6, W), wood);
          m.position.set((a[0] + b[0]) / 2, deck - 0.3, (a[1] + b[1]) / 2); m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); m.name = `deck:${p.id}`; g.add(m);
        }
        const piers = pierPoints(p), pm = lam("#8d867a"), r = clamp(W * 0.15, 0.3, 1.2);
        for (const q of piers) { const y0 = T.heightAt(q[0], q[1]) - 1, H = Math.max(0.5, deck - 0.6 - y0), m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, H, 10), pm); m.position.set(q[0], y0 + H / 2, q[1]); m.name = `pier:${p.id}`; g.add(m); }
      } else {
        const planks = boxesAlong(S, [0.5, 0.12, W], yOf, wood); planks.name = `planks:${p.id}`; g.add(planks);
        for (const o of [-W / 2, W / 2]) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(S.map((s) => new THREE.Vector3(s.x - s.dz * o, yOf(s) + 1, s.z + s.dx * o))), new THREE.LineBasicMaterial({ color: "#5a4a2a" })));
      }
      continue;
    }
    if (st === "portal") { for (const [k, q] of [[0, P[0]], [1, P[P.length - 1]]]) g.add(portalMesh(q, T.heightAt(q[0], q[1]), `portal:${p.id}:${k}`)); continue; }
    if (st === "tunnel") {
      const vs = sampleLine(P, 2).map((s) => new THREE.Vector3(s.x, gy(s) + 0.3, s.z)), line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs), new THREE.LineDashedMaterial({ color: hot ? SELECT_COLOR : "#3b342d", dashSize: 1, gapSize: 1.2 }));
      line.computeLineDistances(); g.add(line);
      for (let k = 0; k < 2; k++) { const a = k ? P[P.length - 1] : P[0], b = k ? P[P.length - 2] : P[1], m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.6, W + 1), lam("#3b342d")); m.position.set(a[0], T.heightAt(a[0], a[1]) + 1.3, a[1]); m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); m.name = `tunnel_mouth:${p.id}`; g.add(m); }
      continue;
    }
    const S = sampleLine(P, 1.5);
    if (st === "canal") { g.add(ribbon(S, W, (s) => gy(s) + 0.08, lam(hot ? SELECT_COLOR : "#4f86c6", { transparent: true, opacity: 0.7, depthWrite: false }))); continue; }
    g.add(ribbon(S, W, (s) => gy(s) + 0.12, lam(hot ? SELECT_COLOR : st === "road" ? "#b5ab98" : st === "stairs" ? "#a8a090" : "#b8a77a")));
    if (st === "stairs") { const steps = boxesAlong(sampleLine(P, 1), [0.45, 0.3, W], (s) => gy(s) + 0.15, lam("#8d867a")); steps.name = `steps:${p.id}`; g.add(steps); }
  }
  for (const m of sid.markers || []) if (m && m.kind === "portal" && Array.isArray(m.position)) out.add(portalMesh([m.position[0], m.position[2]], Number.isFinite(m.position[1]) ? m.position[1] : T.heightAt(m.position[0], m.position[2]), "portal:" + m.id));
  return out;
}
/** 水面：regions kind water（surface_y，缺省多边形顶点地面最低处 + 0.3）→ 半透明平面 */
function waterMeshes(c) {
  const { sid, T } = c, out = new THREE.Group();
  out.name = "water";
  for (const r of sid.regions || []) {
    if (!r || r.kind !== "water" || !Array.isArray(r.polygon) || r.polygon.length < 3) continue;
    const y = Number.isFinite(Number(r.surface_y)) && r.surface_y != null ? Number(r.surface_y) : Math.min(...r.polygon.map((q) => T.heightAt(q[0], q[1]))) + 0.3;
    const g = new THREE.ShapeGeometry(new THREE.Shape(r.polygon.map(([x, z]) => new THREE.Vector2(x, -z))));
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: "#4f86c6", transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    m.position.y = y; m.name = "water:" + r.id; m.renderOrder = 3; out.add(m);
  }
  return out;
}
/** 标记（docs/07 §1.1）：圈选 / 手绘线 = 贴地虚线（离地 0.4 m，不被地形挡），图钉 = 竖杆 + 球；选中的橙色 */
function markMeshes(c) {
  const g = new THREE.Group(), sel = c.selected || null;
  g.name = "marks";
  for (const m of marksOf(c)) {
    const color = sel && (sel.mark_id === m.id || (sel.type === "mark" && sel.id === m.id)) ? SELECT_COLOR : "#1f6feb", k = new THREE.Group();
    k.name = `mark:${m.id}`;
    if (m.type === "pin") {
      const [x, z] = m.world[0], y = c.T.heightAt(x, z), M = new THREE.MeshBasicMaterial({ color });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), M), head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), M);
      pole.position.set(x, y + 2, z); head.position.set(x, y + 4.4, z); k.add(pole, head);
    } else {
      const P = m.type === "area" ? m.world.concat([m.world[0]]) : m.world, pts = sampleLine(P, 1.5).map((q) => new THREE.Vector3(q.x, c.T.heightAt(q.x, q.z) + 0.4, q.z));
      if (pts.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 1.6, gapSize: 0.9, depthTest: false, transparent: true }));
      line.computeLineDistances(); line.renderOrder = 6; k.add(line);
    }
    g.add(k);
  }
  return g;
}
