// views/view3d.js — 3D 预览（只看，不编辑；原 preview3d.js）。three.js 走 importmap（jsdelivr），离线 / 没有 WebGL 时给一行字而不是报错。
// 两种用法：中栏「3D」整页，和俯视图 / 剖面右下角的「3D 小窗」（inset：不出提示文字，仍可转视角）。
// 画：地形（可调透明度，地下层自动 35%）、房子与全部地标（按 form 出体块）、路与溪、桥、出生点、
// 空间内部实体（通道 = 沿折线的盒子、房间 = 多边形挤出、层间连接 = 竖梯；当前内部层实、其它层半透明）、连接点、剖切面。
// 纯函数式挂载：数据进（ctx），回调没有；不调 AI。
import { paletteOf, sublevelOf, SELECT_COLOR, ROOM_FILL } from "./map.js";
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
/** 重建节流（毫秒） */
export const THROTTLE_MS = 150;
const UG_COLOR = "#3b3a52", WAY_COLOR = "#cdb894", SKY_WAY = "#a0784a", SLAB_COLOR = "#a39a88", CONN_COLOR = "#6b4f2a", SEC_COLOR = "#7a4fc9";

/**
 * 挂载到 container，立即返回句柄（three.js 在后台加载；加载前的调用会记住，加载后按最后一次画）。
 * @param {HTMLElement} container
 * @param {object} ctx { sid, T, stratum?, interiorLevel?: 0|1|2, section?: {mode, line, width_m}, selected?: {plan_id?, sid_id?} }
 * @param {{inset?: boolean}} [o] inset = 3D 小窗（不出提示文字）
 * @returns {{ ready: Promise<boolean>, offline: boolean, update(ctx), setGroundOpacity(o: number|null), setSection(section|null), snapshot(): string|null, debug(): object, dispose() }}
 *   update 节流 150 ms；setGroundOpacity(null) 回到自动（地下层 35%，其它 100%）；setSection 接受 {mode, line, width_m} 或有 path 的采样结果，null 收起；
 *   ctx.section 在 update 时也会同步剖切面（显式 setSection 优先）。
 */
export function mountView3d(container, ctx, o = {}) {
  const inset = !!o.inset;
  container.replaceChildren();
  let impl = null, alive = true, cur = ctx, opacity = null, section, sectionSet = false;
  const handle = {
    offline: false,
    ready: null,
    update(c) { if (!alive || !c) return; cur = c; if (impl) impl.update(c); },
    setGroundOpacity(op) { opacity = op == null ? null : Math.max(0.05, Math.min(1, Number(op))); if (impl) impl.setGroundOpacity(opacity); },
    setSection(sec) { section = sec || null; sectionSet = true; if (impl) impl.setSection(section); },
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-60, 80, 40); scene.add(sun);
  if (!inset) { const n = document.createElement("div"); n.className = "three-note"; n.textContent = "拖动旋转 · 滚轮缩放 · 右键平移"; container.append(n); }

  let group = new THREE.Group(), secMesh = null, groundMat = null, nBuilds = 0, alive = true, dirty = true, cur = ctx, secCfg, secExplicit = false, manualOpacity = null, lastBuild = 0, timer = null, pending = null, placed = false;
  scene.add(group);
  const resize = () => { const w = container.clientWidth || (inset ? 320 : 600), h = container.clientHeight || (inset ? 220 : 400); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  controls.addEventListener("change", () => { dirty = true; });
  const disposeTree = (obj) => obj.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach((m) => m.dispose()); });
  const opacityFor = (c) => (manualOpacity != null ? manualOpacity : c.stratum === "underground" ? UNDERGROUND_OPACITY : 1);
  function applyOpacity() { if (!groundMat) return; const op = opacityFor(cur); groundMat.opacity = op; groundMat.transparent = op < 1; groundMat.depthWrite = op >= 1; groundMat.needsUpdate = true; dirty = true; }
  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial(Object.assign({ color }, extra));

  /** 镜头对准村子（房子 / 地标 / 空间 / 入口的包围球），不对整块地形 */
  function fitCamera(sid) {
    const pts = [];
    for (const v of sid.volumes || []) if (v.position && v.size) { const r = Math.max(v.size[0], v.size[2]) / 2; for (const [dx, dz] of [[-r, -r], [r, r]]) pts.push([v.position[0] + dx, v.position[1] + v.size[1], v.position[2] + dz]); }
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
    const isSel = (o) => !!sel && ((sel.sid_id && sel.sid_id === o.id && !sel.part) || (!sel.sid_id && sel.plan_id && (o.plan_id === sel.plan_id || o.zone_id === sel.plan_id)));
    const W = b.max[0] - b.min[0], D = b.max[2] - b.min[2], seg = inset ? 40 : 60;
    // 地形：PlaneGeometry 转到 XZ，按 heightAt 抬高；顶点色按层
    const geo = new THREE.PlaneGeometry(W, D, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), layer = (sid.meta && sid.meta.layer_height_m) || 3;
    const maxLevel = Math.max(1, ...(T.terraces || []).map((t) => t.level)), lo = new THREE.Color("#e9e2cf"), hi = new THREE.Color("#9fb38a"), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (b.min[0] + b.max[0]) / 2, z = pos.getZ(i) + (b.min[2] + b.max[2]) / 2, h = T.heightAt(x, z);
      pos.setX(i, x); pos.setZ(i, z); pos.setY(i, h);
      tmp.copy(lo).lerp(hi, Math.min(1, Math.max(0, h / (layer * maxLevel))));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const ground = new THREE.Mesh(geo, groundMat);
    ground.name = "ground"; ground.renderOrder = 2;
    group.add(ground);

    // 房子与地标：按 form 出体块（圆楼 / 井 / 树 = 圆柱，塔 = 高盒子加尖顶，吊脚楼 = 抬高的盒子加柱脚）
    const M = { wall: mat(pal.wall), roof: mat(pal.roof), lm: mat("#b8452b"), tree: mat(pal.foliage), stone: mat(pal.stone), wood: mat("#8a6a44"), sel: mat(SELECT_COLOR) };
    for (const v of sid.volumes || []) {
      if (!v.position || !v.size) continue;
      const [w, h, d] = v.size, lm = v.importance === "landmark", hot = isSel(v);
      let mesh;
      if (v.shape === "cylinder") mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, (w / 2) * (v.kind === "prop" ? 0.7 : 1), h, 12), hot ? M.sel : v.kind === "prop" && v.form !== "well" ? M.tree : lm ? M.lm : M.wall);
      else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hot ? M.sel : lm ? (v.form === "wall" || v.form === "statue" ? M.stone : M.lm) : M.wall);
        if (v.form === "tower") { const r = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.75, Math.min(4, h * 0.25), 4), M.roof); r.position.y = h / 2 + Math.min(4, h * 0.25) / 2; r.rotation.y = Math.PI / 4; mesh.add(r); }
        else if (!lm || ["hall", "pavilion", "gate", "stage", "custom", "house"].includes(v.form)) { const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, Math.min(0.6, h * 0.15), d * 1.1), M.roof); roof.position.y = h / 2; mesh.add(roof); }
      }
      mesh.position.set(v.position[0], v.position[1] + h / 2, v.position[2]);
      mesh.rotation.y = ((v.rotation_y || 0) * Math.PI) / 180;
      mesh.name = (lm ? "landmark:" : v.kind === "building" ? "house:" : "prop:") + v.id;
      if (v.stilt_m > 0.2) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, v.stilt_m, 0.3), M.wood); post.position.set((sx * w) / 2.3, -h / 2 - v.stilt_m / 2, (sz * d) / 2.3); mesh.add(post); }
      group.add(mesh);
    }
    // 路与溪
    for (const p of sid.paths || []) {
      if (!p.points || p.points.length < 2) continue;
      const vs = [];
      for (let i = 1; i < p.points.length; i++) {
        const a = p.points[i - 1], q = p.points[i], n = Math.max(2, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 2));
        for (let k = 0; k <= n; k++) { const t = k / n, x = a[0] + (q[0] - a[0]) * t, z = a[1] + (q[1] - a[1]) * t; vs.push(new THREE.Vector3(x, T.heightAt(x, z) + 0.25, z)); }
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs), new THREE.LineBasicMaterial({ color: isSel(p) ? SELECT_COLOR : p.kind === "river" ? "#4f86c6" : p.id === "main_trail" ? "#6b5a3a" : "#8b7d5b" }));
      line.name = "path:" + p.id; group.add(line);
    }
    const matBridge = mat("#cfc6ae");
    for (const br of pathCrossings(sid.paths || [])) { const L = (br.width || 4) + 2, m = new THREE.Mesh(new THREE.BoxGeometry(L, 0.5, 3), matBridge); m.position.set(br.at[0], T.heightAt(br.at[0], br.at[1]) + 0.6, br.at[1]); m.rotation.y = -Math.atan2(br.dir[1], br.dir[0]); group.add(m); }
    const sp = (sid.markers || []).find((m) => m.kind === "player_spawn");
    if (sp) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.2, 8), mat("#1f6feb"));
      cone.position.set(sp.position[0], T.heightAt(sp.position[0], sp.position[2]) + 1.1, sp.position[2]); cone.name = "spawn";
      group.add(cone);
      const th = ((sp.rotation_y || 0) * Math.PI) / 180;
      group.add(new THREE.ArrowHelper(new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th)), cone.position.clone(), 8, 0x1f6feb, 2, 1));
    }
    for (const s of sid.spaces || []) { const m = spaceGroup(s, c, sel); if (m) group.add(m); }
    for (const m of sid.markers || []) if (m.kind === "connector" && Array.isArray(m.position)) group.add(connectorMesh(m));
    scene.add(group);
    applyOpacity();
    if (!secExplicit) secCfg = c.section || null;
    drawSection();
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
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    debug() { const names = []; scene.traverse((x) => { if (x.name) names.push(x.name); }); return { names, groundOpacity: groundMat ? groundMat.opacity : null, section: !!secMesh, builds: nBuilds }; },
    dispose() { alive = false; if (timer) clearTimeout(timer); if (ro) ro.disconnect(); controls.dispose(); if (secMesh) disposeTree(secMesh); disposeTree(group); renderer.dispose(); container.replaceChildren(); },
  };
}
