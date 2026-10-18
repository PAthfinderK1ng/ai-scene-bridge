// views/preview3d.js — 3D 预览（只看，不编辑）。three.js 走 importmap（jsdelivr），离线时给出提示而不是报错。
import { paletteOf } from "./map.js";

let THREE = null, OrbitControls = null, loadErr = null;
async function lib() {
  if (THREE || loadErr) return !loadErr;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    return true;
  } catch (e) { loadErr = e; return false; }
}

/**
 * 挂载到 container；返回 { update(ctx), dispose() }。
 * ctx = { sid, T }
 */
export async function mountPreview(container, ctx) {
  container.replaceChildren();
  if (!(await lib())) {
    const note = document.createElement("div");
    note.className = "hint";
    note.style.padding = "20px";
    note.textContent = "3D 预览需要联网加载 three.js（cdn.jsdelivr.net）。离线时请看俯视图 / 侧剖面 / 第一眼三张图。";
    container.append(note);
    return { update() {}, dispose() {} };
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-60, 80, 40);
  scene.add(sun);
  const note = document.createElement("div");
  note.className = "three-note";
  note.textContent = "拖动旋转 · 滚轮缩放 · 右键平移";
  container.append(note);

  let group = new THREE.Group();
  scene.add(group);
  let alive = true, dirty = true;

  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  controls.addEventListener("change", () => { dirty = true; });

  function build(c) {
    scene.remove(group);
    group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
    group = new THREE.Group();
    const { sid, T } = c;
    const pal = paletteOf(sid);
    const b = sid.bounds;
    const W = b.max[0] - b.min[0], D = b.max[2] - b.min[2];
    const seg = 60;
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
      tmp.copy(lo).lerp(hi, Math.min(1, h / (layer * maxLevel)));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // 体块
    const matWall = new THREE.MeshLambertMaterial({ color: pal.wall });
    const matRoof = new THREE.MeshLambertMaterial({ color: pal.roof });
    const matLm = new THREE.MeshLambertMaterial({ color: "#b8452b" });
    const matTree = new THREE.MeshLambertMaterial({ color: pal.foliage });
    for (const v of sid.volumes || []) {
      if (!v.position || !v.size) continue;
      const [w, h, d] = v.size;
      let mesh;
      if (v.shape === "cylinder") mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2 * 0.7, h, 10), matTree);
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
    scene.add(group);
    if (!build.placed) {
      const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      camera.position.set(cx + 10, 70, b.max[2] + 70);
      controls.target.set(cx, 5, cz);
      controls.update();
      build.placed = true;
    }
    dirty = true;
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
    update(c) { if (alive) build(c); },
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    dispose() { alive = false; ro.disconnect(); controls.dispose(); renderer.dispose(); container.replaceChildren(); },
  };
}
