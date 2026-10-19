// views/preview3d.js — 3D 预览（只看，不编辑）。three.js 走 importmap（jsdelivr），离线 / 没有 WebGL 时给一行字而不是报错。
// 两种用法：中栏「3D」整页，和俯视图 / 剖面右下角的「3D 小窗」（inset：不出提示文字，仍可转视角）。
// 画：地形（可调透明度，切到地下层自动 35%）、体块、路与溪、出生点、地下空间（半透明暗色体块）、
// 空中空间（带 1 m 厚度的板）、连接点（楼梯 / 梯子 / 井 / 竖井 / 升降台 / 索桥 / 坡道的竖向符号）、剖切面（半透明竖面）。
import { paletteOf } from "./map.js";
import { sectionPath } from "../engine/section.js";
import { CLEARANCE } from "../engine/strata.js";
import { pathCrossings } from "../engine/routing.js";

let THREE = null, OrbitControls = null, loadErr = null;
async function lib() {
  if (THREE || loadErr) return !loadErr;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    return true;
  } catch (e) { loadErr = e; return false; }
}
/** 地下层时地面自动透明度 */
export const UNDERGROUND_OPACITY = 0.35;
/** 重建节流（毫秒） */
export const THROTTLE_MS = 150;
const UG_COLOR = "#3b3a52", SLAB_COLOR = "#a39a88", CONN_COLOR = "#6b4f2a", SEC_COLOR = "#7a4fc9";

function offline(container, inset, text) {
  const note = document.createElement("div");
  note.className = "hint three-offline";
  note.style.cssText = inset ? "padding:8px;font-size:12px;line-height:1.4" : "padding:20px";
  note.textContent = inset ? text.short : text.long;
  container.append(note);
  return { offline: true, update() {}, setGroundOpacity() {}, setSection() {}, snapshot() { return null; }, dispose() { container.replaceChildren(); } };
}

/**
 * 挂载到 container。
 * @param {HTMLElement} container
 * @param {object} ctx { sid, T, stratum?: "ground"|"underground"|"sky" }
 * @param {{inset?: boolean}} [o] inset = 3D 小窗（不出提示文字）
 * @returns {Promise<{update(ctx), setGroundOpacity(o: number|null), setSection(section|null), snapshot(): string|null, dispose(), offline?: true}>}
 *   update 节流 150 ms；setGroundOpacity(null) 回到自动（地下层 35%，其它 100%）；
 *   setSection 接受 {mode, line, width_m} 或 sampleSection 结果（有 path），null 收起剖切面。
 */
export async function mountPreview(container, ctx, o = {}) {
  const inset = !!o.inset;
  container.replaceChildren();
  if (!(await lib())) return offline(container, inset, { short: "3D 需要联网（three.js）", long: "3D 预览需要联网加载 three.js（cdn.jsdelivr.net）。离线时请看俯视图 / 剖面 / 第一眼三张图。" });
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: !inset, preserveDrawingBuffer: true }); }
  catch (e) { return offline(container, inset, { short: "3D 不可用（没有 WebGL）", long: "这台机器的浏览器没有 WebGL，3D 预览不可用。请看俯视图 / 剖面 / 第一眼三张图。" }); }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#eef1f2");
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-60, 80, 40);
  scene.add(sun);
  if (!inset) {
    const note = document.createElement("div");
    note.className = "three-note";
    note.textContent = "拖动旋转 · 滚轮缩放 · 右键平移";
    container.append(note);
  }

  let group = new THREE.Group(), secMesh = null, groundMat = null;
  scene.add(group);
  let nBuilds = 0, alive = true, dirty = true, cur = ctx, secCfg = null, manualOpacity = null, lastBuild = 0, timer = null, pending = null, placed = false;

  function resize() {
    const w = container.clientWidth || (inset ? 320 : 600), h = container.clientHeight || (inset ? 220 : 400);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  controls.addEventListener("change", () => { dirty = true; });

  const disposeTree = (obj) => obj.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach((m) => m.dispose()); });
  const opacityFor = (c) => (manualOpacity != null ? manualOpacity : c.stratum === "underground" ? UNDERGROUND_OPACITY : 1);
  function applyOpacity() {
    if (!groundMat) return;
    const op = opacityFor(cur);
    groundMat.opacity = op; groundMat.transparent = op < 1; groundMat.depthWrite = op >= 1; groundMat.needsUpdate = true;
    dirty = true;
  }

  /** 镜头对准村子本身（房子 / 地标 / 空间 / 入口的包围球），不对整块地形：小窗里村子占满画面 */
  function fitCamera(sid, T) {
    const pts = [];
    for (const v of sid.volumes || []) if (v.position && v.size) { const r = Math.max(v.size[0], v.size[2]) / 2; for (const [dx, dz] of [[-r, -r], [r, r]]) pts.push([v.position[0] + dx, v.position[1] + v.size[1], v.position[2] + dz]); }
    for (const sp of sid.spaces || []) if (sp.polygon) for (const q of sp.polygon) pts.push([q[0], sp.floor_y || 0, q[1]]);
    for (const m of sid.markers || []) if (m.kind === "player_spawn" && m.position) pts.push(m.position);
    const b = sid.bounds;
    if (!pts.length) pts.push([b.min[0], 0, b.min[2]], [b.max[0], 0, b.max[2]]);
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])));
    const c = lo.map((v, k) => (v + hi[k]) / 2);
    const r = Math.max(12, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const d = (r / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * (inset ? 0.92 : 1), dir = new THREE.Vector3(0.12, 0.62, 0.78).normalize();
    controls.target.set(c[0], c[1], c[2]);
    camera.position.set(c[0] + dir.x * d, c[1] + dir.y * d, c[2] + dir.z * d);
    controls.update();
  }
  function build(c) {
    cur = c; lastBuild = performance.now(); nBuilds++;
    scene.remove(group); disposeTree(group);
    group = new THREE.Group();
    const { sid, T } = c;
    const pal = paletteOf(sid);
    const b = sid.bounds;
    const W = b.max[0] - b.min[0], D = b.max[2] - b.min[2];
    const seg = inset ? 40 : 60;
    // 地形：PlaneGeometry 旋转到 XZ，再按 heightAt 抬高；顶点色按层
    const geo = new THREE.PlaneGeometry(W, D, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const layer = (sid.meta && sid.meta.layer_height_m) || 3;
    const maxLevel = Math.max(1, ...(T.terraces || []).map((t) => t.level));
    const lo = new THREE.Color("#e9e2cf"), hi = new THREE.Color("#9fb38a"), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (b.min[0] + b.max[0]) / 2, z = pos.getZ(i) + (b.min[2] + b.max[2]) / 2;
      const h = T.heightAt(x, z);
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

    // 体块
    const matWall = new THREE.MeshLambertMaterial({ color: pal.wall });
    const matRoof = new THREE.MeshLambertMaterial({ color: pal.roof });
    const matLm = new THREE.MeshLambertMaterial({ color: "#b8452b" });
    const matTree = new THREE.MeshLambertMaterial({ color: pal.foliage });
    for (const v of sid.volumes || []) {
      if (!v.position || !v.size) continue;
      const [w, h, d] = v.size;
      let mesh;
      if (v.shape === "cylinder") mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, (w / 2) * 0.7, h, 10), matTree);
      else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), v.importance === "landmark" ? matLm : matWall);
        if (v.importance !== "landmark") { const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, Math.min(0.6, h * 0.15), d * 1.1), matRoof); roof.position.y = h / 2; mesh.add(roof); }
      }
      mesh.position.set(v.position[0], v.position[1] + h / 2, v.position[2]);
      mesh.rotation.y = ((v.rotation_y || 0) * Math.PI) / 180;
      group.add(mesh);
    }
    // 路与溪
    for (const p of sid.paths || []) {
      if (!p.points || p.points.length < 2) continue;
      const vs = [];
      for (let i = 1; i < p.points.length; i++) {
        const a = p.points[i - 1], q = p.points[i];
        const n = Math.max(2, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 2));
        for (let k = 0; k <= n; k++) { const t = k / n; const x = a[0] + (q[0] - a[0]) * t, z = a[1] + (q[1] - a[1]) * t; vs.push(new THREE.Vector3(x, T.heightAt(x, z) + 0.25, z)); }
      }
      const g2 = new THREE.BufferGeometry().setFromPoints(vs);
      group.add(new THREE.Line(g2, new THREE.LineBasicMaterial({ color: p.kind === "river" ? "#4f86c6" : p.id === "main_trail" ? "#6b5a3a" : "#8b7d5b" })));
    }
    // 桥：路过溪处一块石板（与俯视图同一来源）
    const matBridge = new THREE.MeshLambertMaterial({ color: "#cfc6ae" });
    for (const br of pathCrossings(sid.paths || [])) {
      const L = (br.width || 4) + 2, m = new THREE.Mesh(new THREE.BoxGeometry(L, 0.5, 3), matBridge);
      m.position.set(br.at[0], T.heightAt(br.at[0], br.at[1]) + 0.6, br.at[1]); m.rotation.y = -Math.atan2(br.dir[1], br.dir[0]);
      group.add(m);
    }
    // 出生点
    const sp = (sid.markers || []).find((m) => m.kind === "player_spawn");
    if (sp) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.2, 8), new THREE.MeshLambertMaterial({ color: "#1f6feb" }));
      cone.position.set(sp.position[0], T.heightAt(sp.position[0], sp.position[2]) + 1.1, sp.position[2]);
      group.add(cone);
      const th = ((sp.rotation_y || 0) * Math.PI) / 180;
      const dir = new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th));
      group.add(new THREE.ArrowHelper(dir, cone.position.clone(), 8, 0x1f6feb, 2, 1));
    }
    // 空间与连接点
    for (const s of sid.spaces || []) { const m = spaceMesh(s, c.stratum); if (m) group.add(m); }
    for (const m of sid.markers || []) if (m.kind === "connector" && Array.isArray(m.position)) group.add(connectorMesh(m));

    scene.add(group);
    applyOpacity();
    if (secCfg) drawSection();
    if (!placed) { fitCamera(sid, T); placed = true; }
    dirty = true;
  }

  /** 空间：多边形挤出。地下 = floor_y → floor_y + height 的半透明暗色体；空中 = floor_y 往下 1 m 的板 */
  function spaceMesh(s, stratum) {
    if (!Array.isArray(s.polygon) || s.polygon.length < 3) return null;
    const shape = new THREE.Shape(s.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
    const under = s.stratum === "underground";
    const depth = under ? Math.max(0.5, s.height) : CLEARANCE.slab;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // 形状 (x, −z) → 世界 (x, ·, z)，挤出方向 → +y
    const faded = stratum && stratum !== "ground" && stratum !== s.stratum;
    const mat = under
      ? new THREE.MeshLambertMaterial({ color: UG_COLOR, transparent: true, opacity: faded ? 0.25 : 0.6, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: SLAB_COLOR, transparent: faded, opacity: faded ? 0.35 : 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = under ? s.floor_y : s.floor_y - CLEARANCE.slab;
    mesh.name = "space:" + s.id; mesh.renderOrder = under ? 1 : 0;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: under ? "#1d1c28" : "#4d4539", transparent: true, opacity: faded ? 0.3 : 0.9 }));
    mesh.add(edges);
    return mesh;
  }

  /** 连接点：竖向符号（下端 position[1] / bottom_y，上端 top_y） */
  function connectorMesh(m) {
    const g = new THREE.Group();
    g.name = "connector:" + m.id;
    const x = m.position[0], z = m.position[2];
    const y0 = Number.isFinite(m.bottom_y) ? m.bottom_y : m.position[1], y1 = Number.isFinite(m.top_y) ? m.top_y : y0 + 3;
    const H = Math.max(0.5, y1 - y0);
    const mat = new THREE.MeshLambertMaterial({ color: CONN_COLOR });
    const box = (w, h, d, px, py, pz, ry = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(px, py, pz); b.rotation.y = ry; g.add(b); };
    if (m.via === "stairs") {
      const n = Math.min(80, Math.max(3, Math.round(H / 0.5)));
      for (let i = 0; i < n; i++) { const a = (i / 8) * Math.PI * 2, y = y0 + (H * (i + 0.5)) / n; box(1.4, 0.15, 0.5, x + Math.cos(a) * 0.8, y, z + Math.sin(a) * 0.8, -a); }
      box(0.2, H, 0.2, x, y0 + H / 2, z);
    } else if (m.via === "ladder") {
      box(0.12, H, 0.12, x - 0.4, y0 + H / 2, z); box(0.12, H, 0.12, x + 0.4, y0 + H / 2, z);
      for (let y = y0 + 0.3; y < y1; y += 0.6) box(0.8, 0.06, 0.06, x, y, z);
    } else if (m.via === "well" || m.via === "shaft") {
      const r = m.via === "shaft" ? 1.6 : 1.1;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 16, 1, true), new THREE.MeshLambertMaterial({ color: CONN_COLOR, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      cyl.position.set(x, y0 + H / 2, z); g.add(cyl);
    } else if (m.via === "elevator") {
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, H, 2)), new THREE.LineBasicMaterial({ color: CONN_COLOR }));
      frame.position.set(x, y0 + H / 2, z); g.add(frame);
      box(1.8, 0.15, 1.8, x, y0 + H / 2, z);
    } else box(0.35, H, 0.35, x, y0 + H / 2, z);
    // 两端的小圆盘（看得出接在哪）
    for (const y of [y0, y1]) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 12), mat); d.position.set(x, y + 0.05, z); g.add(d); }
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
    for (const s of cur.sid.spaces || []) { lo = Math.min(lo, s.floor_y - CLEARANCE.slab); hi = Math.max(hi, s.floor_y + s.height); }
    lo -= 2; hi += 10;
    const pos = [], idx = [];
    path.forEach((p, i) => { pos.push(p[0], lo, p[1], p[0], hi, p[1]); if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    secMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SEC_COLOR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    secMesh.name = "section"; secMesh.renderOrder = 3;
    const top = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p[0], cur.T.heightAt(p[0], p[1]) + 0.3, p[1]))), new THREE.LineBasicMaterial({ color: SEC_COLOR }));
    secMesh.add(top);
    const band = widthBand(path, Number(secCfg.width_m) || 0);
    if (band) secMesh.add(band);
    scene.add(secMesh);
    dirty = true;
  }

  /** 宽度带：贴地的半透明网格带（沿线每 2 m、横向 4 格），和俯视图上的紫带对应 */
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
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SEC_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    m.name = "section_band"; m.renderOrder = 4;
    return m;
  }

  function loop() {
    if (!alive) return;
    controls.update();
    if (dirty && renderer.domElement.clientWidth) { renderer.render(scene, camera); dirty = false; }
    requestAnimationFrame(loop);
  }
  resize();
  build(ctx);
  loop();
  return {
    /** 节流 150 ms：短时间内多次 update 只按最后一次重建 */
    update(c) {
      if (!alive || !c) return;
      pending = c;
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (alive && pending) { const p = pending; pending = null; build(p); } }, Math.max(0, THROTTLE_MS - (performance.now() - lastBuild)));
    },
    setGroundOpacity(op) { manualOpacity = op == null ? null : Math.max(0.05, Math.min(1, Number(op))); applyOpacity(); },
    setSection(sec) { secCfg = sec || null; drawSection(); },
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    /** 测试 / 调试用：当前场景里的对象名与地面透明度 */
    debug() { const names = []; scene.traverse((x) => { if (x.name) names.push(x.name); }); return { names, groundOpacity: groundMat ? groundMat.opacity : null, section: !!secMesh, builds: nBuilds }; },
    dispose() { alive = false; if (timer) clearTimeout(timer); if (ro) ro.disconnect(); controls.dispose(); if (secMesh) disposeTree(secMesh); disposeTree(group); renderer.dispose(); container.replaceChildren(); },
  };
}
