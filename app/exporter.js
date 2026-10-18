// exporter.js — 保存 SID、导出实验包（zip：scene.sid.json + views + glb + PROTOCOL.md + assets）
import { slug } from "./state.js";

export function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/** 下载文件名：保留中文，只去掉文件系统不允许的字符（slug 只用于 id） */
export function fileStem(name) {
  const t = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().replace(/^[. _]+|[. _]+$/g, "");
  return t || "scene";
}

export function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = (/data:(.*?);/.exec(head) || [])[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function saveSid(store) {
  const doc = store.doc;
  download(`${fileStem(doc.meta.name)}.sid.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  store.status("已保存 .sid.json（浏览器下载）");
}

export async function exportPackage(store, viewport, status = () => {}) {
  if (!window.JSZip) throw new Error("JSZip 没有加载（需要联网访问 cdn.jsdelivr.net）");
  status("渲染俯视图…");
  const top = viewport.renderToDataURL("top", 2048);
  status("渲染鸟瞰透视图…");
  const iso = viewport.renderToDataURL("iso", 2048);
  const topBlob = dataURLToBlob(top.dataURL), isoBlob = dataURLToBlob(iso.dataURL);
  if (!topBlob.size || !isoBlob.size) throw new Error("视图图片为空，导出中止");

  const doc = JSON.parse(JSON.stringify(store.doc));
  // 保留原有的其它视图条目（如用户手放的 perspective 截图），只替换本工具生成的两张
  const kept = (doc.views || []).filter((v) => v.kind !== "top_down" && !(v.image === "views/iso.png"));
  doc.views = kept.concat([
    { kind: "top_down", image: "views/top.png", scale_m_per_px: Math.round(top.scale_m_per_px * 1e5) / 1e5, north_up: true, labels_drawn: true },
    { kind: "perspective", image: "views/iso.png", camera: iso.camera, labels_drawn: true },
  ]);

  const zip = new window.JSZip();
  zip.file("scene.sid.json", JSON.stringify(doc, null, 2));
  zip.file("views/top.png", topBlob);
  zip.file("views/iso.png", isoBlob);

  status("导出 glb…");
  const glb = await viewport.exportGLB();
  if (glb) zip.file("scene.glb", glb);

  let protocol = null;
  try {
    const r = await fetch("../spec/PROTOCOL.md", { cache: "no-store" });
    if (r.ok) protocol = await r.text();
  } catch { /* 离线或不是从仓库根目录启动 */ }
  if (protocol) zip.file("PROTOCOL.md", protocol);

  // 素材：只打包文档里 shape=custom 且本次会话已导入的文件（文档驱动，被删 / 被撤销的不会混进来）
  const packed = new Set();
  for (const v of doc.volumes) {
    if (v.shape !== "custom") continue;
    const h = doc.asset_hints[v.id];
    const a = h && h.file ? viewport.assets.get(h.file) : null;
    if (a && !packed.has(h.file)) { packed.add(h.file); zip.file(h.file, a.file); }
  }

  zip.file("README.txt", [
    `${doc.meta.name} — SID 导出包（由 ai-scene-bridge 编辑器生成）`,
    "",
    "scene.sid.json   场景意图（以此为准）",
    "views/top.png    俯视图：北朝上，带 id / label / 尺寸 / 朝向箭头 / 比例尺 / 坐标刻度",
    "views/iso.png    鸟瞰透视示意（相机参数在 scene.sid.json 的 views 里）",
    glb && "scene.glb        体块与标记的几何（根节点 SID_scene，节点名 = id，extras.sid 里有 kind / label / size 等）；v0 只作参考，Compile 仍按 PROTOCOL 用原生几何体",
    protocol ? "PROTOCOL.md      给 AI 的读法、编译、验证协议" : "（缺 PROTOCOL.md：请把仓库 spec/PROTOCOL.md 复制进来）",
    packed.size ? "assets/          导入素材的原文件；v0 忽略，v1 按 asset_hints[id].file 使用" : null,
    kept.length ? "views/ 其它条目  来自原 SID 的外部视图，图片未随包导出" : null,
    "",
    "约定：单位米，+Y 上，右手系，北 = −Z，position 为底面中心，rotation_y 0 = 朝北、逆时针为正。",
  ].filter(Boolean).join("\n"));

  status("打包…");
  const blob = await zip.generateAsync({ type: "blob" });
  download(`${fileStem(doc.meta.name)}-export.zip`, blob);
  return { top, iso, size: blob.size, hasGlb: !!glb, hasProtocol: !!protocol, assets: packed.size, keptViews: kept.length };
}
