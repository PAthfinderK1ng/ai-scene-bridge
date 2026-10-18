// main.js — 把 store / 视口 / 面板 / 工具栏 / 键盘接起来
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { Store, newDoc, uniqueId, removeById, snap, slug, r2 } from "./state.js";
import { Viewport } from "./scene3d.js";
import { Panels } from "./panels.js";
import { validate } from "./validate.js";
import { saveSid, exportPackage } from "./exporter.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const status = (m) => { statusEl.textContent = m; statusEl.style.color = ""; };

const store = new Store();
store.on("status", status);
const vp = new Viewport($("viewport"), store);
const panels = new Panels(store);
vp.onObjectChange = () => status(vp.liveInfo());
vp.onGizmoChange = (eff) => { for (const b of document.querySelectorAll("button.mode")) b.classList.toggle("active", b.id === "mode-" + eff); };

// ------------------------------------------------------------ 文件
function loadDoc(doc, msg) {
  vp.clearAssets();
  store.setDoc(doc);
  vp.fitPersp();
  status(msg);
}
$("btn-new").onclick = () => { if (confirm("新建空场景？未保存的内容会丢失。")) loadDoc(newDoc(), "已新建"); };
$("btn-open").onclick = () => $("file-open").click();
$("file-open").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const doc = JSON.parse(await f.text());
    if (!doc.sid_version) throw new Error("不是 SID 文件（缺少 sid_version）");
    loadDoc(doc, `已打开 ${f.name}`);
    const customs = (doc.volumes || []).filter((v) => v.shape === "custom").length;
    if (customs) status(`已打开 ${f.name}。有 ${customs} 个导入素材的体块按盒子显示：再「导入素材」同名文件即可接上。`);
  } catch (err) { alert("打开失败：" + err.message); }
};
$("btn-save").onclick = () => saveSid(store);
$("btn-example").onclick = async () => {
  try {
    const r = await fetch("../spec/examples/village-square.sid.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    loadDoc(await r.json(), "已加载示例：村口广场。点对象试试 W / E / R。");
  } catch (err) { alert("加载示例失败（要从仓库根目录启动本地服务）：" + err.message); }
};

// ------------------------------------------------------------ 添加对象
function centerXZ() {
  const c = vp.viewCenter();
  const g = Number(store.doc.meta.grid) || 0.5;
  return [snap(c.x, g), snap(c.z, g)];
}
function add(coll, make, label) {
  const [x, z] = centerXZ();
  let id;
  store.mutate((doc) => {
    const obj = make(doc, x, z);
    id = obj.id;
    if (coll === "features") doc.terrain.features.push(obj);
    else doc[coll].push(obj);
  }, label);
  store.select(id);
}
$("btn-add-box").onclick = () => add("volumes", (doc, x, z) => ({ id: uniqueId(doc, "box_1"), kind: "building", shape: "box", position: [x, 0, z], size: [4, 3, 4], rotation_y: 0, label: "", material_intent: "", color_role: "wall", importance: "secondary", notes: "" }), "已添加盒子");
$("btn-add-cyl").onclick = () => add("volumes", (doc, x, z) => ({ id: uniqueId(doc, "cyl_1"), kind: "prop", shape: "cylinder", position: [x, 0, z], size: [2, 2, 2], rotation_y: 0, label: "", material_intent: "", color_role: "stone", importance: "secondary", notes: "" }), "已添加圆柱");
$("btn-add-marker").onclick = () => add("markers", (doc, x, z) => {
  const hasSpawn = doc.markers.some((m) => m.kind === "player_spawn");
  return hasSpawn
    ? { id: uniqueId(doc, "poi_1"), kind: "poi", position: [x, 0, z], rotation_y: 0, label: "", notes: "" }
    : { id: uniqueId(doc, "spawn"), kind: "player_spawn", position: [x, 0, z], rotation_y: 0, label: "", notes: "" };
}, "已添加标记");
$("btn-add-region").onclick = () => add("regions", (doc, x, z) => ({ id: uniqueId(doc, "region_1"), kind: "gathering", polygon: [[x - 5, z - 5], [x + 5, z - 5], [x + 5, z + 5], [x - 5, z + 5]], surface: "stone", label: "", notes: "" }), "已添加区域（在面板里改多边形）");
$("btn-add-hill").onclick = () => add("features", (doc, x, z) => ({ id: uniqueId(doc, "hill_1"), kind: "hill", center: [x, 0, z], radius: 10, height: 5, label: "", notes: "" }), "已添加山丘");

function deleteSelected() {
  const id = store.selection;
  if (!id) return status("先选中一个对象");
  store.mutate((doc) => removeById(doc, id), `已删除 ${id}`);
}
$("btn-delete").onclick = deleteSelected;

// ------------------------------------------------------------ 导入素材
const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/");
gltfLoader.setDRACOLoader(draco);

$("btn-import").onclick = () => $("file-import").click();
$("file-import").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const url = URL.createObjectURL(f);
  status(`读取 ${f.name}…`);
  gltfLoader.load(url, (gltf) => {
    URL.revokeObjectURL(url);
    let key = `assets/${f.name}`;
    let n = 2;
    while (vp.assets.has(key)) key = `assets/${f.name.replace(/(\.[^.]+)$/, `_${n++}$1`)}`;
    const a = vp.registerAsset(f, key, gltf.scene);
    if (!(a.size.x > 0 && a.size.y > 0 && a.size.z > 0)) { vp.assets.delete(key); return alert("模型包围盒为零，无法放置"); }
    const [x, z] = centerXZ();
    let id;
    store.mutate((doc) => {
      id = uniqueId(doc, slug(f.name.replace(/\.(glb|gltf)$/i, ""), "asset") + "_1");
      doc.volumes.push({ id, kind: "prop", shape: "custom", position: [x, 0, z], size: [r2(a.size.x), r2(a.size.y), r2(a.size.z)], rotation_y: 0, label: f.name, material_intent: "", importance: "secondary", notes: `导入素材 ${f.name}` });
      doc.asset_hints[id] = { file: key, fit: "scale_to_volume", front_axis: "+Z" };
    }, `已导入 ${f.name}（${r2(a.size.x)}×${r2(a.size.y)}×${r2(a.size.z)} m）`);
    store.select(id);
    const big = Math.max(a.size.x, a.size.y, a.size.z);
    if (big > 100) status(`已导入 ${f.name}，最长边 ${r2(big)} m —— 像是厘米单位的模型，可在面板把尺寸除以 100`);
    else if (big < 0.05) status(`已导入 ${f.name}，最长边只有 ${r2(big)} m —— 可能单位过小，可在面板改尺寸`);
  }, undefined, (err) => { URL.revokeObjectURL(url); alert("导入失败：" + (err && err.message ? err.message : err)); });
};

// ------------------------------------------------------------ 模式与视角
function setMode(m) { vp.setMode(m); }
$("mode-translate").onclick = () => setMode("translate");
$("mode-rotate").onclick = () => setMode("rotate");
$("mode-scale").onclick = () => setMode("scale");
function toggleTop() {
  const on = !vp.topView;
  vp.setTopView(on);
  $("btn-top").classList.toggle("active", on);
  $("btn-top").textContent = on ? "透视" : "俯视";
}
$("btn-top").onclick = toggleTop;
$("btn-fit").onclick = () => vp.fitPersp();
$("btn-labels").classList.add("active");
$("btn-labels").onclick = () => $("btn-labels").classList.toggle("active", vp.toggleLabels());
$("btn-undo").onclick = () => store.undo();
$("btn-redo").onclick = () => store.redo();
$("btn-help").onclick = () => $("help").showModal();

// ------------------------------------------------------------ 校验与导出
function runValidate() {
  const msgs = validate(store.doc);
  panels.renderValidation(msgs);
  $("sec-validate").open = true;
  const n = msgs.filter((m) => m.level !== "ok").length;
  status(n ? `校验：${n} 条提示，点击条目可定位` : "校验通过");
  return msgs;
}
$("btn-validate").onclick = runValidate;
$("btn-export").onclick = async () => {
  const b = $("btn-export");
  b.disabled = true;
  try {
    const res = await exportPackage(store, vp, status);
    const warn = [];
    if (!res.hasGlb) warn.push("glb 导出失败");
    if (!res.hasProtocol) warn.push("缺 PROTOCOL.md（请从仓库根目录启动服务，或手动把 spec/PROTOCOL.md 放进包里）");
    if (res.keptViews) warn.push(`保留了 ${res.keptViews} 个外部视图条目，其图片不在包里`);
    status(`已导出 zip（${Math.round(res.size / 1024)} KB${res.assets ? `，含 ${res.assets} 个素材` : ""}）${warn.length ? "；注意：" + warn.join("；") : ""}`);
  } catch (err) {
    console.error(err);
    alert("导出失败：" + err.message);
    status("导出失败");
  } finally { b.disabled = false; }
};

// ------------------------------------------------------------ 拾取与画路径
const vpEl = $("viewport");
let down = null;
let drawing = null;
const snapG = (v) => snap(v, Number(store.doc.meta.grid) || 0.5);

vpEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || vp.transform.axis) { down = null; return; }
  down = [e.clientX, e.clientY];
});
vpEl.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = vp.groundPointAt(e.clientX, e.clientY);
  if (p) vp.setDrawPreview(drawing.points, [snapG(p.x), snapG(p.z)]);
});
vpEl.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4;
  down = null;
  if (moved) return;
  if (drawing) {
    const p = vp.groundPointAt(e.clientX, e.clientY);
    if (p) {
      drawing.points.push([snapG(p.x), snapG(p.z)]);
      vp.setDrawPreview(drawing.points, null);
      status(`画路径：${drawing.points.length} 个点。双击或回车结束，Esc 取消`);
    }
    return;
  }
  store.select(vp.pickAt(e.clientX, e.clientY));
});
vpEl.addEventListener("dblclick", (e) => { if (drawing) { e.preventDefault(); finishPath(); } });

function startPath() {
  drawing = { points: [] };
  vpEl.classList.add("drawing");
  $("btn-draw-path").classList.add("active");
  store.select(null);
  status("画路径：在地面上点击加点，双击或回车结束，Esc 取消");
}
function cancelPath() {
  drawing = null;
  vpEl.classList.remove("drawing");
  $("btn-draw-path").classList.remove("active");
  vp.setDrawPreview(null);
  status("已取消画路径");
}
function finishPath() {
  if (!drawing) return;
  const pts = [];
  for (const p of drawing.points) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  drawing = null;
  vpEl.classList.remove("drawing");
  $("btn-draw-path").classList.remove("active");
  vp.setDrawPreview(null);
  if (pts.length < 2) return status("路径至少要 2 个点，已放弃");
  let id;
  store.mutate((doc) => {
    id = uniqueId(doc, "path_1");
    doc.paths.push({ id, kind: "road", width: 4, points: pts, surface: "ground", label: "", notes: "" });
  }, "已添加路径");
  store.select(id);
}
$("btn-draw-path").onclick = () => (drawing ? cancelPath() : startPath());

// ------------------------------------------------------------ 键盘
window.addEventListener("keydown", (e) => {
  if ($("help").open) return; // 帮助对话框打开时全部交给浏览器（Esc 关闭、Enter 激活按钮）
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === "s") { // 要在输入框早退之前：先 blur 让面板的 onchange 落盘，再保存
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    saveSid(store);
    return;
  }
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") { if (e.key === "Escape") e.target.blur(); return; }
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (mod && k === "y") { e.preventDefault(); store.redo(); return; }
  if (mod || e.altKey) return;
  switch (k) {
    case "w": setMode("translate"); break;
    case "e": setMode("rotate"); break;
    case "r": setMode("scale"); break;
    case "t": toggleTop(); break;
    case "f": vp.fitPersp(); break;
    case "l": $("btn-labels").click(); break;
    case "delete": case "backspace": if (store.selection) { deleteSelected(); e.preventDefault(); } break;
    case "enter": if (drawing) { finishPath(); e.preventDefault(); } break;
    case "escape": if (drawing) cancelPath(); else store.select(null); break;
    default: break;
  }
});
window.addEventListener("beforeunload", (e) => { if (store.undoStack.length) { e.preventDefault(); e.returnValue = ""; } });

// 调试入口（控制台里 sidEditor.store.doc / sidEditor.vp.renderToDataURL("top") 等）
window.sidEditor = { store, vp, panels, validate, exportPackage };

status("就绪。点「示例」加载村口广场，或直接添加对象。");
