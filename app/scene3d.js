// scene3d.js — three.js 视口：从 SID 建场景、选择、变换、俯视/透视、导出渲染与 glb
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { find, colorFor, snap, normDeg, centroid2, r2, MARKER_COLORS, ORIENTED_MARKER_KINDS } from "./state.js";

const DEG = Math.PI / 180;
// 单位几何体：底面在 y=0，mesh.scale 就是尺寸，mesh.position 就是 SID 的 position（底面中心）
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 32).translate(0, 0.5, 0);
const UNIT_DOME = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
const BOX_EDGES = new THREE.EdgesGeometry(UNIT_BOX);
const CYL_EDGES = new THREE.EdgesGeometry(UNIT_CYL, 40);
const SHARED = new Set([UNIT_BOX, UNIT_CYL, UNIT_DOME, BOX_EDGES, CYL_EDGES]);
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x222222 });
const PREVIEW_MAT = new THREE.LineDashedMaterial({ color: 0x1f6feb, dashSize: 1, gapSize: 0.5 });
const GRID_MINOR_MAT = new THREE.LineBasicMaterial({ color: 0xd9d4c7 });
const GRID_MAJOR_MAT = new THREE.LineBasicMaterial({ color: 0xb9b3a4 });
const BOUNDS_MAT = new THREE.LineBasicMaterial({ color: 0x444444 });
const KEEP_MATS = new Set([EDGE_MAT, PREVIEW_MAT, GRID_MINOR_MAT, GRID_MAJOR_MAT, BOUNDS_MAT]);

/** rotation_y → 朝向单位向量。0 = 朝北(−Z)，逆时针为正；与 three.js 右手系绕 +Y 的旋转一致 */
export function facingVec(deg) {
  const t = deg * DEG;
  return new THREE.Vector3(-Math.sin(t), 0, -Math.cos(t));
}
/** 从物体四元数反算 rotation_y（避免欧拉角 (π, θ, π) 的歧义） */
export function yawOf(obj) {
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(obj.quaternion);
  return normDeg(Math.atan2(-d.x, -d.z) / DEG);
}

function makeLabel(text) {
  const div = document.createElement("div");
  div.className = "label";
  div.textContent = text;
  return new CSS2DObject(div);
}

/** 释放一棵子树的 GPU 资源与标签 DOM；keep 里的（共享几何体 / 导入素材的资源）跳过 */
function disposeTree(root, keep) {
  root.traverse((o) => {
    if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.remove(); // three 的 remove 只给直接子节点发 removed 事件
    if (o.geometry && !SHARED.has(o.geometry) && !keep.has(o.geometry)) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!KEEP_MATS.has(m) && !keep.has(m)) m.dispose();
      }
    }
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Viewport {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    // 导入的素材：键 = asset_hints[id].file（"assets/<文件名>"），随文档的重命名 / 删除 / 撤销自动跟随
    this.assets = new Map();
    this.assetRes = new Set(); // 导入素材的 geometry / material，rebuild 时不 dispose
    this.mode = "translate";
    this.topView = false;
    this.labelsOn = true;
    this.onObjectChange = null;
    this.onGizmoChange = null;
    this._dragStart = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labelRenderer = new CSS2DRenderer();
    Object.assign(labelRenderer.domElement.style, { position: "absolute", top: "0", left: "0", pointerEvents: "none" });
    container.appendChild(labelRenderer.domElement);
    this.labelRenderer = labelRenderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeeebe4);
    this.scene = scene;

    this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.persp.position.set(40, 45, 70);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 2000);
    this.ortho.position.set(0, 500, 0);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(0, 0, 0);
    this.camera = this.persp;

    this.orbit = new OrbitControls(this.persp, renderer.domElement);
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.02;
    this.orbitTop = new OrbitControls(this.ortho, renderer.domElement);
    this.orbitTop.enableRotate = false;
    this.orbitTop.screenSpacePanning = true;
    this.orbitTop.enabled = false;

    this.transform = new TransformControls(this.persp, renderer.domElement);
    this.transform.setTranslationSnap(0.5);
    this.transform.setRotationSnap(5 * DEG);
    this.transform.setScaleSnap(0.5);
    this.helper = this.transform.getHelper ? this.transform.getHelper() : this.transform;
    scene.add(this.helper);
    this.transform.addEventListener("dragging-changed", (e) => {
      if (e.value) {
        this.orbit.enabled = false;
        this.orbitTop.enabled = false;
        const o = this.transform.object;
        this._dragStart = o ? { pos: o.position.clone(), scale: o.scale.clone(), quat: o.quaternion.clone() } : null;
      } else {
        this.orbit.enabled = !this.topView;
        this.orbitTop.enabled = this.topView;
        this.commitSelected();
      }
    });
    this.transform.addEventListener("objectChange", () => {
      if (this.selBox.visible) this.selBox.update();
      if (this.onObjectChange) this.onObjectChange();
    });

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9280, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-60, 90, 50);
    scene.add(sun);

    this.staticGroup = new THREE.Group();
    this.objectsGroup = new THREE.Group();
    this.helperGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    scene.add(this.staticGroup, this.objectsGroup, this.helperGroup, this.previewGroup);

    // 选中框与预览线各一个实例，复用，不反复 new / dispose
    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xff9900);
    this.selBox.visible = false;
    scene.add(this.selBox);
    this.preview = new THREE.Line(new THREE.BufferGeometry(), PREVIEW_MAT);
    this.preview.visible = false;
    this.previewGroup.add(this.preview);

    this.meshById = new Map();
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    store.on("doc", () => this.rebuild());
    store.on("selection", (id) => this.attachById(id));
    this.rebuild();
    this.fitPersp();

    const loop = () => {
      requestAnimationFrame(loop);
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    };
    loop();
  }

  // ---------------------------------------------------------------- 素材
  registerAsset(file, key, gltfScene) {
    const box = new THREE.Box3().setFromObject(gltfScene);
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    gltfScene.traverse((o) => {
      if (o.geometry) this.assetRes.add(o.geometry);
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.assetRes.add(m);
    });
    const entry = { file, key, scene: gltfScene, size, center, min: box.min.clone() };
    this.assets.set(key, entry);
    return entry;
  }
  clearAssets() {
    for (const r of this.assetRes) r.dispose && r.dispose();
    this.assetRes.clear();
    this.assets.clear();
  }
  /** shape=custom 的体块按 asset_hints[id].file 找已导入的素材 */
  assetFor(doc, v) {
    if (v.shape !== "custom") return null;
    const h = doc.asset_hints && doc.asset_hints[v.id];
    return h && h.file ? this.assets.get(h.file) || null : null;
  }
  /** glTF 规范正面朝 +Z，SID 的 0° 朝 −Z：front_axis 默认 "+Z" 时补 180° */
  assetYaw(doc, id) {
    const h = doc.asset_hints && doc.asset_hints[id];
    return (h && h.front_axis) === "-Z" ? 0 : Math.PI;
  }
  /** 把素材包成「底面中心在原点、朝向已补偿、缩放到 size」的组 */
  buildAssetGroup(doc, v, asset) {
    const root = new THREE.Group();
    const fit = new THREE.Group();
    fit.add(asset.scene.clone(true));
    fit.position.set(-asset.center.x, -asset.min.y, -asset.center.z);
    const yaw = new THREE.Group();
    yaw.rotation.y = this.assetYaw(doc, v.id);
    yaw.add(fit);
    root.add(yaw);
    root.scale.set(v.size[0] / (asset.size.x || 1), v.size[1] / (asset.size.y || 1), v.size[2] / (asset.size.z || 1));
    return root;
  }

  // ---------------------------------------------------------------- 相机与尺寸
  bounds() {
    const b = this.store.doc.bounds || { min: [-40, 0, -40], max: [40, 25, 40] };
    let [xmin, , zmin] = b.min, [xmax, ymax, zmax] = b.max;
    if (xmax <= xmin) xmax = xmin + 1;
    if (zmax <= zmin) zmax = zmin + 1;
    return { xmin, zmin, xmax, zmax, ymax: Math.max(ymax, 1), cx: (xmin + xmax) / 2, cz: (zmin + zmax) / 2, W: xmax - xmin, H: zmax - zmin };
  }
  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // CSS 尺寸由 style.css 的 width/height:100% 决定
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }
  updateOrtho() {
    const b = this.bounds();
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    const hw = (Math.max(b.W, b.H * aspect) / 2) * 1.08, hh = hw / aspect;
    Object.assign(this.ortho, { left: -hw, right: hw, top: hh, bottom: -hh });
    this.ortho.updateProjectionMatrix();
  }
  fitPersp() {
    const b = this.bounds();
    const D = Math.max(b.W, b.H);
    this.persp.position.set(b.cx - 0.55 * D, 0.55 * D, b.cz + 0.8 * D);
    this.orbit.target.set(b.cx, 0, b.cz);
    this.orbit.update();
    if (this.topView) this.setTopView(true);
  }
  setTopView(on) {
    this.topView = on;
    this.camera = on ? this.ortho : this.persp;
    if (on) {
      const b = this.bounds();
      this.ortho.position.set(b.cx, 500, b.cz);
      this.ortho.up.set(0, 0, -1);
      this.ortho.lookAt(b.cx, 0, b.cz);
      this.ortho.zoom = 1;
      this.orbitTop.target.set(b.cx, 0, b.cz);
      this.orbitTop.update();
      this.updateOrtho();
    }
    this.orbit.enabled = !on;
    this.orbitTop.enabled = on;
    this.transform.camera = this.camera;
  }
  viewCenter() {
    return (this.topView ? this.orbitTop.target : this.orbit.target).clone();
  }
  toggleLabels() {
    this.labelsOn = !this.labelsOn;
    this.setLabelsVisible(this.labelsOn);
    return this.labelsOn;
  }
  setLabelsVisible(on) {
    this.scene.traverse((o) => { if (o.isCSS2DObject) o.visible = on; });
  }

  // ---------------------------------------------------------------- 重建
  rebuild() {
    const doc = this.store.doc;
    for (const g of [this.staticGroup, this.objectsGroup, this.helperGroup]) {
      for (const c of [...g.children]) { disposeTree(c, this.assetRes); g.remove(c); }
    }
    this.meshById.clear();
    this.transform.detach();
    this.selBox.visible = false;
    const g = Number(doc.meta.grid) || 0.5;
    this.transform.setTranslationSnap(g);
    this.buildStatic();
    doc.volumes.forEach((v) => this.addVolume(v));
    doc.regions.forEach((r, i) => this.addRegion(r, i));
    doc.paths.forEach((p, i) => this.addPath(p, i));
    doc.markers.forEach((m) => this.addMarker(m));
    (doc.terrain.features || []).forEach((f) => this.addFeature(f));
    this.updateOrtho();
    this.attachById(this.store.selection);
    this.setLabelsVisible(this.labelsOn);
  }

  buildStatic() {
    const b = this.bounds();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(b.W, b.H), new THREE.MeshStandardMaterial({ color: 0xede8dc, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(b.cx, -0.02, b.cz);
    this.staticGroup.add(ground);
    // 网格对齐世界坐标的 5 m / 10 m 整数倍，与 tools/render_topdown.py 一致
    const minor = [], major = [];
    for (let x = Math.ceil(b.xmin / 5) * 5; x <= b.xmax + 1e-6; x += 5) {
      (x % 10 === 0 ? major : minor).push(new THREE.Vector3(x, 0.005, b.zmin), new THREE.Vector3(x, 0.005, b.zmax));
    }
    for (let z = Math.ceil(b.zmin / 5) * 5; z <= b.zmax + 1e-6; z += 5) {
      (z % 10 === 0 ? major : minor).push(new THREE.Vector3(b.xmin, 0.005, z), new THREE.Vector3(b.xmax, 0.005, z));
    }
    if (minor.length) this.staticGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(minor), GRID_MINOR_MAT));
    if (major.length) this.staticGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(major), GRID_MAJOR_MAT));
    const pts = [[b.xmin, b.zmin], [b.xmax, b.zmin], [b.xmax, b.zmax], [b.xmin, b.zmax], [b.xmin, b.zmin]].map(([x, z]) => new THREE.Vector3(x, 0.03, z));
    this.staticGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), BOUNDS_MAT));
    const n = makeLabel("N ↑ 北 (−Z)");
    n.position.set(b.cx, 0.5, b.zmin - 2);
    this.staticGroup.add(n);
    const s = makeLabel("S 南 (+Z)");
    s.position.set(b.cx, 0.5, b.zmax + 2);
    this.staticGroup.add(s);
  }

  register(root, id, coll) {
    root.userData.id = id;
    root.userData.coll = coll;
    this.objectsGroup.add(root);
    this.meshById.set(id, root);
    return root;
  }

  addVolume(v) {
    const doc = this.store.doc;
    const col = new THREE.Color(colorFor(doc, v, "volumes"));
    let root;
    const asset = this.assetFor(doc, v);
    if (asset) {
      root = this.buildAssetGroup(doc, v, asset);
      const lab = makeLabel(`${v.id}${v.label ? "\n" + v.label : ""}`);
      lab.position.set(0, asset.size.y || 1, 0);
      root.add(lab);
    } else {
      const cyl = v.shape === "cylinder";
      root = new THREE.Mesh(cyl ? UNIT_CYL : UNIT_BOX, new THREE.MeshStandardMaterial({ color: col, roughness: 0.9 }));
      root.scale.set(v.size[0], v.size[1], v.size[2]);
      root.add(new THREE.LineSegments(cyl ? CYL_EDGES : BOX_EDGES, EDGE_MAT));
      const lab = makeLabel(`${v.id}${v.label ? "\n" + v.label : ""}${v.shape === "custom" ? "\n（素材未加载，按盒子显示）" : ""}`);
      lab.position.set(0, 1, 0);
      root.add(lab);
    }
    root.position.set(v.position[0], v.position[1], v.position[2]);
    root.rotation.y = (v.rotation_y || 0) * DEG;
    this.register(root, v.id, "volumes");
    const round = v.shape === "cylinder" && Math.abs(v.size[0] - v.size[2]) < 1e-6;
    if (!round) {
      const len = Math.max(v.size[2] / 2, 0.8);
      const arrow = new THREE.ArrowHelper(facingVec(v.rotation_y || 0), new THREE.Vector3(v.position[0], v.position[1] + v.size[1] + 0.05, v.position[2]), len, 0x111111, Math.min(0.7, len * 0.45), Math.min(0.45, len * 0.3));
      this.helperGroup.add(arrow);
    }
  }

  addMarker(m) {
    const col = new THREE.Color(MARKER_COLORS[m.kind] || "#444444");
    let root;
    if (m.kind === "player_spawn") {
      const ph = Number(this.store.doc.meta.player_height) || 1.8;
      root = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, Math.max(0.2, ph - 0.6), 4, 12).translate(0, ph / 2, 0), new THREE.MeshStandardMaterial({ color: col }));
      root.add(body);
      root.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, ph * 0.55, 0), 1.6, col.getHex(), 0.5, 0.3));
    } else {
      const geo = m.kind === "light" ? new THREE.SphereGeometry(0.35, 16, 12).translate(0, 0.35, 0) : new THREE.OctahedronGeometry(0.45).translate(0, 0.45, 0);
      root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, emissive: m.kind === "light" ? col : 0x000000, emissiveIntensity: 0.6 }));
    }
    root.position.set(m.position[0], m.position[1], m.position[2]);
    root.rotation.y = (m.rotation_y || 0) * DEG;
    const lab = makeLabel(`${m.id}${m.label ? "\n" + m.label : ""}`);
    lab.position.set(0, 2.2, 0);
    root.add(lab);
    this.register(root, m.id, "markers");
  }

  addRegion(r, idx) {
    if (!r.polygon || r.polygon.length < 3) return;
    const col = new THREE.Color(colorFor(this.store.doc, r, "regions"));
    // 组原点放在质心，子物体用相对坐标：gizmo 才会出现在区域上，整体拖动 = 组位移
    const [cx, cz] = centroid2(r.polygon);
    const rel = r.polygon.map(([x, z]) => [x - cx, z - cz]);
    const shape = new THREE.Shape(rel.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // (x, y) → (x, 0, −y)，所以上面用了 −z
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(rel.map(([x, z]) => new THREE.Vector3(x, 0.01, z))), new THREE.LineDashedMaterial({ color: 0x333333, dashSize: 1, gapSize: 0.6 }));
    outline.computeLineDistances();
    const root = new THREE.Group();
    root.add(mesh, outline);
    root.position.set(cx, 0.02 + idx * 0.002, cz);
    root.userData.base = root.position.clone();
    const lab = makeLabel(`${r.id}${r.label ? "\n" + r.label : ""}\n[${r.kind}]`);
    lab.position.set(0, 0.3, 0);
    root.add(lab);
    this.register(root, r.id, "regions");
  }

  addPath(p, idx) {
    if (!p.points || p.points.length < 2) return;
    const col = new THREE.Color(colorFor(this.store.doc, p, "paths"));
    const mat = new THREE.MeshBasicMaterial({ color: col });
    const root = new THREE.Group();
    const w = Math.max(0.1, p.width || 1), y = 0.03 + idx * 0.002;
    const [cx, cz] = centroid2(p.points);
    const rel = p.points.map(([x, z]) => [x - cx, z - cz]);
    for (let i = 0; i < rel.length - 1; i++) {
      const [x0, z0] = rel[i], [x1, z1] = rel[i + 1];
      const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(L, 0.04, w), mat);
      seg.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      seg.rotation.y = Math.atan2(-dz, dx);
      root.add(seg);
    }
    for (const [x, z] of rel) {
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.04, 16), mat);
      joint.position.set(x, 0, z);
      root.add(joint);
    }
    root.position.set(cx, y, cz);
    root.userData.base = root.position.clone();
    const [x0, z0] = rel[0], [x1, z1] = rel[1];
    const lab = makeLabel(`${p.id}${p.label ? " · " + p.label : ""} (w=${p.width} m)`);
    lab.position.set((x0 + x1) / 2, 0.3, (z0 + z1) / 2);
    root.add(lab);
    this.register(root, p.id, "paths");
  }

  addFeature(f) {
    const mesh = new THREE.Mesh(UNIT_DOME, new THREE.MeshStandardMaterial({ color: 0x9daa7a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, roughness: 1 }));
    mesh.scale.set(Math.max(0.1, f.radius), f.height === 0 ? 0.01 : f.height, Math.max(0.1, f.radius));
    mesh.position.set(f.center[0], f.center[1] || 0, f.center[2]);
    const lab = makeLabel(`${f.id}${f.label ? "\n" + f.label : ""}\n${f.kind} r=${f.radius} h=${f.height} m`);
    lab.position.set(0, 1, 0);
    mesh.add(lab);
    this.register(mesh, f.id, "features");
  }

  // ---------------------------------------------------------------- 选择与变换
  attachById(id) {
    this.transform.detach();
    this.selBox.visible = false;
    if (!id) { this.notifyGizmo(); return; }
    const o = this.meshById.get(id);
    if (!o) { this.notifyGizmo(); return; }
    this.transform.attach(o);
    this.selBox.setFromObject(o);
    this.selBox.visible = true;
    this.applyGizmo();
  }
  setMode(m) {
    this.mode = m;
    this.applyGizmo();
  }
  /** 当前对象实际允许的模式（regions/paths/features 只能平移，markers 不能缩放） */
  effectiveMode() {
    const id = this.store.selection;
    const f = id && find(this.store.doc, id);
    if (!f) return this.mode;
    if ((f.coll === "regions" || f.coll === "paths" || f.coll === "features") && this.mode !== "translate") return "translate";
    if (f.coll === "markers" && this.mode === "scale") return "translate";
    return this.mode;
  }
  applyGizmo() {
    const id = this.store.selection;
    const f = id && find(this.store.doc, id);
    const t = this.transform;
    if (!f) { this.notifyGizmo(); return; }
    const mode = this.effectiveMode();
    t.setMode(mode);
    if (mode === "rotate") { t.showX = false; t.showZ = false; t.showY = true; }
    else if (mode === "translate") { t.showX = true; t.showZ = true; t.showY = f.coll === "markers"; }
    else { t.showX = true; t.showY = true; t.showZ = true; }
    // custom 素材的 scale 是「size / 原尺寸」的比例，吸附 0.5 没有意义
    t.setScaleSnap(f.coll === "volumes" && f.obj.shape === "custom" ? null : 0.5);
    this.notifyGizmo();
  }
  notifyGizmo() { if (this.onGizmoChange) this.onGizmoChange(this.effectiveMode()); }
  detachTransform() { this.transform.detach(); }

  /** 把 gizmo 拖出来的结果写回文档：只写真正变化了的分量；没变化就只重建（吸回原值），不进撤销栈 */
  commitSelected() {
    const id = this.store.selection;
    const start = this._dragStart;
    this._dragStart = null;
    if (!id) return;
    const o = this.meshById.get(id);
    if (!o || !find(this.store.doc, id)) return;
    const eps = 1e-6;
    const p = o.position, s = o.scale;
    const movedAxis = start ? [Math.abs(p.x - start.pos.x) > eps, Math.abs(p.y - start.pos.y) > eps, Math.abs(p.z - start.pos.z) > eps] : [true, true, true];
    const scaledAxis = start ? [Math.abs(s.x - start.scale.x) > eps, Math.abs(s.y - start.scale.y) > eps, Math.abs(s.z - start.scale.z) > eps] : [true, true, true];
    const rotated = start ? !o.quaternion.equals(start.quat) : true;
    if (!movedAxis.some(Boolean) && !scaledAxis.some(Boolean) && !rotated) { this.rebuild(); return; }
    const g = Number(this.store.doc.meta.grid) || 0.5;
    const yaw = yawOf(o);
    const changed = this.store.mutate((doc) => {
      const f = find(doc, id);
      if (!f) return;
      const { coll, obj } = f;
      if (coll === "volumes") {
        const pos = [p.x, Math.max(0, p.y), p.z];
        obj.position = obj.position.map((v, i) => (movedAxis[i] ? snap(pos[i], g) : v));
        const a = this.assetFor(doc, obj);
        const sc = [Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)];
        if (a) {
          const base = [a.size.x || 1, a.size.y || 1, a.size.z || 1];
          obj.size = obj.size.map((v, i) => (scaledAxis[i] ? Math.max(0.1, r2(sc[i] * base[i])) : v));
        } else {
          obj.size = obj.size.map((v, i) => (scaledAxis[i] ? Math.max(0.1, snap(sc[i], 0.5)) : v));
        }
        if (rotated) obj.rotation_y = yaw;
      } else if (coll === "markers") {
        const pos = [p.x, Math.max(0, r2(p.y)), p.z];
        obj.position = obj.position.map((v, i) => (movedAxis[i] ? (i === 1 ? pos[1] : snap(pos[i], g)) : v));
        if (rotated && (ORIENTED_MARKER_KINDS.includes(obj.kind) || "rotation_y" in obj)) obj.rotation_y = yaw;
      } else if (coll === "features") {
        obj.center = [movedAxis[0] ? snap(p.x, g) : obj.center[0], obj.center[1] || 0, movedAxis[2] ? snap(p.z, g) : obj.center[2]];
      } else {
        const base = o.userData.base || new THREE.Vector3();
        const dx = movedAxis[0] ? snap(p.x - base.x, g) : 0, dz = movedAxis[2] ? snap(p.z - base.z, g) : 0;
        const pts = coll === "regions" ? obj.polygon : obj.points;
        for (const pt of pts) { pt[0] = r2(pt[0] + dx); pt[1] = r2(pt[1] + dz); }
      }
    }, `已更新 ${id}`);
    if (!changed) this.rebuild();
  }

  liveInfo() {
    const id = this.store.selection;
    const o = id && this.meshById.get(id);
    if (!o) return "";
    const f = find(this.store.doc, id);
    const p = o.position, s = o.scale;
    let size = `${r2(s.x)}×${r2(s.y)}×${r2(s.z)}`;
    if (f && f.coll === "volumes") {
      const a = this.assetFor(this.store.doc, f.obj);
      if (a) size = `${r2(Math.abs(s.x) * a.size.x)}×${r2(Math.abs(s.y) * a.size.y)}×${r2(Math.abs(s.z) * a.size.z)}`;
    }
    return `${id}  位置 (${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)})  尺寸 ${size} m  朝向 ${yawOf(o)}°`;
  }

  // ---------------------------------------------------------------- 拾取
  ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }
  pickAt(clientX, clientY) {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObjects(this.objectsGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.id) o = o.parent;
      if (o && o.userData.id) return o.userData.id;
    }
    return null;
  }
  groundPointAt(clientX, clientY) {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, p) ? p : null;
  }
  setDrawPreview(points, cursor) {
    if (!points || !points.length) { this.preview.visible = false; return; }
    const pts = points.map(([x, z]) => new THREE.Vector3(x, 0.1, z));
    if (cursor) pts.push(new THREE.Vector3(cursor[0], 0.1, cursor[1]));
    if (pts.length === 1) pts.push(pts[0].clone().add(new THREE.Vector3(0.01, 0, 0)));
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.preview.computeLineDistances();
    this.preview.visible = true;
  }

  // ---------------------------------------------------------------- 导出
  /** 离屏渲染俯视图 / 鸟瞰透视图并叠加标注，返回 {dataURL, width, height, scale_m_per_px, camera} */
  renderToDataURL(kind, W = 2048) {
    const b = this.bounds();
    const doc = this.store.doc;
    const maxTex = Math.min(8192, this.renderer.capabilities.maxTextureSize || 8192);
    W = Math.min(W, maxTex);
    let H, cam, mpp = null, camera = null;
    if (kind === "top") {
      // 像素长宽比最多 1:4；细长场景左右 / 上下补留白而不是拉伸，x、z 两向共用一个 m/px
      const MAX_ASPECT = 4;
      let vw = b.W, vh = b.H;
      if (vh / vw > MAX_ASPECT) vw = vh / MAX_ASPECT;
      if (vw / vh > MAX_ASPECT) vh = vw / MAX_ASPECT;
      mpp = vw / W;
      H = Math.max(256, Math.round(vh / mpp));
      cam = new THREE.OrthographicCamera(-vw / 2, vw / 2, (mpp * H) / 2, -(mpp * H) / 2, 1, 2000);
      cam.position.set(b.cx, 500, b.cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(b.cx, 0, b.cz);
    } else {
      H = Math.round(W * 0.66);
      const D = Math.max(b.W, b.H);
      const pos = [b.cx - 0.8 * D, 0.65 * D, b.cz + 1.0 * D];
      cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 5000);
      cam.position.set(pos[0], pos[1], pos[2]);
      cam.lookAt(b.cx, 0, b.cz);
      camera = { position: pos.map(r2), look_at: [r2(b.cx), 0, r2(b.cz)], fov_deg: 35, aspect: r2(W / H) };
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.setClearColor(0xf4f1ea, 1);
    const hv = this.helper.visible, sv = this.selBox.visible, pv = this.previewGroup.visible;
    this.helper.visible = false;
    this.selBox.visible = false;
    this.previewGroup.visible = false;
    r.render(this.scene, cam);
    this.helper.visible = hv;
    this.selBox.visible = sv;
    this.previewGroup.visible = pv;

    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(r.domElement, 0, 0);
    r.dispose();
    if (r.forceContextLoss) r.forceContextLoss();

    const px = (x, y, z) => {
      const p = new THREE.Vector3(x, y, z).project(cam);
      return [((p.x + 1) / 2) * W, ((1 - p.y) / 2) * H];
    };
    const fs = Math.max(11, Math.round(W / 125));
    const FONT = `"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif`;
    const drawText = (lines, x, y, color = "#111") => {
      lines = lines.filter(Boolean);
      if (!lines.length) return;
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lh = fs * 1.25;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs;
      const h = lh * lines.length + fs * 0.4;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      roundRect(ctx, x - w / 2, y - h / 2, w, h, 5);
      ctx.fill();
      ctx.fillStyle = color;
      lines.forEach((l, i) => ctx.fillText(l, x, y - h / 2 + fs * 0.2 + lh * (i + 0.5)));
    };
    for (const v of doc.volumes) { const [x, y] = px(v.position[0], v.position[1] + v.size[1], v.position[2]); drawText([v.id, v.label || "", `${v.size.map(r2).join("×")} m`], x, y); }
    for (const f of doc.terrain.features || []) { const [x, y] = px(f.center[0], Math.max(0, f.height), f.center[2]); drawText([f.id, f.label || "", `${f.kind} r=${f.radius} h=${f.height} m`], x, y, "#4F5F2F"); }
    for (const rg of doc.regions) { const [cx, cz] = centroid2(rg.polygon); const [x, y] = px(cx, 0, cz); drawText([rg.id, rg.label || "", `[${rg.kind}]`], x, y, "#333"); }
    for (const p of doc.paths) { const a = p.points[0], b2 = p.points[1] || a; const [x, y] = px((a[0] + b2[0]) / 2, 0, (a[1] + b2[1]) / 2); drawText([`${p.id} (w=${p.width} m)`, p.label || ""], x, y, "#3A2F1F"); }
    for (const m of doc.markers) { const [x, y] = px(m.position[0], m.position[1] + 0.5, m.position[2]); drawText([m.id, m.label || ""], x, y - fs * 1.8, MARKER_COLORS[m.kind] || "#333"); }

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = `700 ${Math.round(fs * 1.4)}px ${FONT}`;
    ctx.fillStyle = "#111";
    ctx.fillText(`${doc.meta.name} — ${kind === "top" ? "俯视图 (top_down)" : "鸟瞰透视 (perspective)"}`, fs, fs * 1.8);
    ctx.font = `${Math.round(fs * 0.9)}px ${FONT}`;
    ctx.fillStyle = "#444";
    ctx.fillText(`单位 m · 北 = −Z${kind === "top" ? "（图上方）" : ""} · position = 底面中心 · 尺寸 = 宽×高×深 · 箭头 = 朝向 (rotation_y, 0 = 北, 逆时针为正)`, fs, fs * 3.3);

    if (kind === "top") {
      // 坐标刻度（10 m 倍数）
      ctx.font = `${Math.round(fs * 0.85)}px ${FONT}`;
      ctx.fillStyle = "#555";
      ctx.textAlign = "center";
      for (let x = Math.ceil(b.xmin / 10) * 10; x <= b.xmax; x += 10) { const [sx, sy] = px(x, 0, b.zmax); ctx.fillText(`${x}`, sx, Math.min(H - fs * 0.4, sy + fs * 1.1)); }
      ctx.textAlign = "right";
      for (let z = Math.ceil(b.zmin / 10) * 10; z <= b.zmax; z += 10) { const [sx, sy] = px(b.xmin, 0, z); ctx.fillText(`${z}`, Math.max(fs * 1.6, sx - fs * 0.3), sy + fs * 0.35); }
      // 比例尺 + 指北针
      const [sx0, sy0] = px(b.xmin + 2, 0, b.zmax - 2);
      const [sx1] = px(b.xmin + 12, 0, b.zmax - 2);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = Math.max(3, fs / 4);
      ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy0); ctx.stroke();
      ctx.textAlign = "center";
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.fillStyle = "#111";
      ctx.fillText("10 m", (sx0 + sx1) / 2, sy0 - fs * 0.8);
      const nx = W - fs * 3, y0 = fs * 8, y1 = fs * 4.5;
      ctx.beginPath(); ctx.moveTo(nx, y0); ctx.lineTo(nx, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(nx, y1 - fs * 0.8); ctx.lineTo(nx - fs * 0.6, y1 + fs * 0.5); ctx.lineTo(nx + fs * 0.6, y1 + fs * 0.5); ctx.closePath(); ctx.fill();
      ctx.font = `700 ${Math.round(fs * 1.2)}px ${FONT}`;
      ctx.fillText("N", nx, y0 + fs * 1.3);
    }
    const dataURL = c.toDataURL("image/png");
    if (!dataURL || dataURL.length < 100) throw new Error(`${kind} 视图渲染失败（画布 ${W}×${H} 可能超出显卡限制）`);
    return { dataURL, width: W, height: H, scale_m_per_px: mpp, camera };
  }

  buildExportGroup() {
    const doc = this.store.doc;
    const g = new THREE.Group();
    g.name = "SID_scene";
    for (const v of doc.volumes) {
      let o;
      const a = this.assetFor(doc, v);
      if (a) {
        o = this.buildAssetGroup(doc, v, a);
      } else {
        o = new THREE.Mesh(v.shape === "cylinder" ? UNIT_CYL : UNIT_BOX, new THREE.MeshStandardMaterial({ color: new THREE.Color(colorFor(doc, v, "volumes")) }));
        o.scale.set(v.size[0], v.size[1], v.size[2]);
      }
      o.position.set(v.position[0], v.position[1], v.position[2]);
      o.rotation.y = (v.rotation_y || 0) * DEG;
      o.name = v.id;
      o.userData = { sid: { id: v.id, kind: v.kind, shape: v.shape, label: v.label || "", color_role: v.color_role || "", material_intent: v.material_intent || "", importance: v.importance || "", size: v.size, rotation_y: v.rotation_y || 0 } };
      g.add(o);
    }
    for (const m of doc.markers) {
      const o = new THREE.Object3D();
      o.position.set(m.position[0], m.position[1], m.position[2]);
      o.rotation.y = (m.rotation_y || 0) * DEG;
      o.name = m.id;
      o.userData = { sid: { id: m.id, kind: m.kind, label: m.label || "" } };
      g.add(o);
    }
    return g;
  }
  exportGLB() {
    return new Promise((resolve) => {
      const g = this.buildExportGroup();
      new GLTFExporter().parse(g, (res) => resolve(res instanceof ArrayBuffer ? res : null), (err) => { console.error(err); resolve(null); }, { binary: true, onlyVisible: false });
    });
  }
}
