// exporter.js — 导出给引擎的包（zip），以及读回 JSON → 差异（红点）。
// 包里是：scene.sid.json（意图）+ views/*.png（俯视 / 剖面 / 第一眼）+ BRIEF.md（人和 AI 都能读的交代）+ PROTOCOL.md。
import { ARCH_LABEL, TOD_LABEL } from "./cards.js";
import { LANDMARK_LABEL, PLACEMENT_LABEL, SPAWN_LABEL } from "./views/map.js";
import { slopeLabel } from "./views/profile.js";
import { SPACE_LABEL, VIA_LABEL, STRATUM_LABEL } from "./engine/strata.js";

const r1 = (v) => Math.round(Number(v) * 10) / 10;
/** 剖切的一句话（BRIEF 与 views 说明共用） */
export function sectionText(sec) {
  if (!sec) return "沿主路";
  return sec.mode === "line" && Array.isArray(sec.line) ? `直线 (${sec.line[0].map(r1).join(", ")}) → (${sec.line[1].map(r1).join(", ")})，宽 ${sec.width_m} m` : `沿主路，宽 ${sec.width_m} m`;
}

export function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function fileStem(name) {
  const t = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().replace(/^[. _]+|[. _]+$/g, "");
  return t || "scene";
}

/** SVG 元素 → PNG Blob（按 viewBox 比例，宽 px） */
export function svgToPng(svg, px = 1600) {
  return new Promise((resolve, reject) => {
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const vb = (svg.getAttribute("viewBox") || "0 0 100 100").split(/\s+/).map(Number);
    const w = px, h = Math.round((px * vb[3]) / vb[2]);
    clone.setAttribute("width", w); clone.setAttribute("height", h);
    clone.style.background = "#fff";
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve({ blob: b, width: w, height: h, m_per_px: vb[2] / w }) : reject(new Error("toBlob 失败"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG 转图失败")); };
    img.src = url;
  });
}

export function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = (/data:(.*?);/.exec(head) || [])[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** 去掉内部字段（下划线开头）与运行期对象，得到可发出去的 SID */
export function cleanSid(sid) {
  return JSON.parse(JSON.stringify(sid, (k, v) => (k.startsWith("_") || typeof v === "function" ? undefined : v)));
}

/** 给引擎侧（人或 AI）的交代：结构、关系、事实、色板，全部来自卡与引擎 */
export function buildBrief({ sid, card, facts = {}, checks = [], params = [], eye = {}, section = null, corrections = [] }) {
  const p = card.params || {};
  const lm = card.landmark, t = facts.trail || {};
  const lines = [];
  lines.push(`# ${sid.meta.name || card.name || "场景"} — 搭建交代（由「场景对话」生成）`, "");
  lines.push("本包里 `scene.sid.json` 是**意图**，不是网格。请按 PROTOCOL.md 的顺序：先读 SID，再看 views/，先把 volumes / paths / markers 按坐标摆出来（Compile），再对照「关系」逐条核（Verify），最后把实际摆放读回成 readback JSON 交回。", "");
  lines.push("## 一句话", card.one_liner || card.summary || "", "");
  lines.push("## 结构（这些是设计决定，不要改）");
  lines.push(`- 原型：${ARCH_LABEL[card.archetype] || card.archetype}；${p.terraces} 层台地，每层 ${p.layer_height_m} m（terrain.features 里每层一个 plateau 多边形，\`level\` 是层号）。`);
  lines.push(`- 地标：${lm.label}（${LANDMARK_LABEL[lm.kind] || lm.kind}），在${PLACEMENT_LABEL[lm.placement] || lm.placement}，尺寸 ${lm.size_m.join("×")} m（volumes 里 importance=landmark）。`);
  lines.push(`- 玩家出生点：${SPAWN_LABEL[card.spawn.placement] || card.spawn.placement}（markers 里 player_spawn，rotation_y 朝向地标）。${eye.landmark_visible ? `第一眼能看见地标，在画面${eye.landmark_screen}，仰角约 ${eye.landmark_elev_deg}°。` : eye.landmark_visible === false ? "第一眼看不见地标（设计者已知悉）。" : ""}`);
  if (t.length_m != null) lines.push(`- 主路 main_trail：${t.folds === 0 ? "直上" : `之字 ${t.folds} 折`}，${Math.round(t.length_m)} m，爬升 ${Math.round(t.climb_m)} m，约 ${Math.round(t.steps_estimate || 0)} 级台阶；最陡 ${slopeLabel(t.max_slope || 0)}。请做成石阶 + 歇脚平台，不要做成斜坡。`);
  if (p.stream) lines.push("- 溪 stream（paths kind=river）走谷底，宽 4 m，水面低于两岸 0.5 m。");
  const br = facts.bridges || [];
  if (br.length) lines.push(`- 桥 ${br.length} 座（路过溪处，石板桥，桥面与路同宽）：${br.map((b) => `${b.path === "main_trail" ? "主路" : b.path} (${r1(b.at[0])}, ${r1(b.at[1])})`).join("、")}。`);
  if (facts.perTerrace) lines.push(`- 民居 ${facts.houses || 0} 栋：${Object.entries(facts.perTerrace).map(([l, n]) => `${+l + 1} 层 ${n} 栋`).join("，")}。每栋 volumes 里有确切 position / size / rotation_y；长边平行等高线，门（−z 面）朝下坡或朝路。`);
  if (card.regions && card.regions.some((r) => r.kind !== "other")) lines.push(`- 特殊区域：${card.regions.filter((r) => r.kind !== "other").map((r) => `${r.terrace + 1} 层 ${r.label || r.kind}（${r.kind}）`).join("、")}。`);
  lines.push("", "## 外观（P3：按 hex 用，不要自己猜色）");
  for (const c of card.palette || []) lines.push(`- ${c.role}: \`${c.hex}\` ${c.note || ""}`);
  lines.push(`- 时段：${TOD_LABEL[(card.lighting || {}).time_of_day] || "黄昏"}；气氛：${(card.mood || []).join("、")}`);
  lines.push("- 材质意图：屋顶 roof、墙 wall、台阶与挡土墙 stone、树 foliage、远景雾 mist。volumes 的 color_role 指向这些角色。");
  const tuned = ((sid.terrain || {}).features || []).filter((f) => f.user_height);
  if (tuned.length) lines.push(`- 单独调过高度的台地：${tuned.map((f) => `第 ${f.level + 1} 层 +${r1(f.height)} m`).join("、")}（terrain.features 里 user_height: true，按 height 搭，不要按层数推算）。`);
  const moved = (sid.volumes || []).filter((v) => v.user_moved);
  if (moved.length) lines.push(`- 设计者亲手挪过的房子 ${moved.length} 栋（id 以 u_house_ 开头、locked: true），位置按 SID 放。`);
  const spaces = (sid.spaces || []).filter((x) => x && x.polygon);
  const conns = (sid.markers || []).filter((m) => m && m.kind === "connector");
  if (spaces.length) {
    lines.push("", "## 多层空间与连接点（spaces / markers 里 kind=connector）");
    lines.push("地下空间是挖进山体的可走空间（floor_y 是地面绝对高度，height 是净高，顶板到地面至少留 2 m 岩层）；空中空间是悬空的板（floor_y 是板面，板厚 1 m 在板面之下，height 是上方可用高度）。");
    for (const x of spaces) {
      const xs = x.polygon.map((p) => p[0]), zs = x.polygon.map((p) => p[1]);
      lines.push(`- ${x.label || SPACE_LABEL[x.kind]}（${STRATUM_LABEL[x.stratum]} · ${SPACE_LABEL[x.kind] || x.kind}，id \`${x.id}\`）：底面 ${r1(x.floor_y)} m，${x.stratum === "underground" ? "净高" : "上方"} ${r1(x.height)} m，约 ${Math.round(Math.max(...xs) - Math.min(...xs))}×${Math.round(Math.max(...zs) - Math.min(...zs))} m（${x.polygon.length} 边形，见 polygon）${x.user_set ? "；设计者亲手加的" : ""}。`);
    }
    for (const m of conns) lines.push(`- 连接点 \`${m.id}\`：${VIA_LABEL[m.via] || m.via}，${m.from === "ground" ? "地面" : m.from} ↔ ${m.to === "ground" ? "地面" : (spaces.find((x) => x.id === m.to) || {}).label || m.to}，位置 (${r1(m.position[0])}, ${r1(m.position[2])})，下端 ${r1(m.bottom_y ?? m.position[1])} m、上端 ${r1(m.top_y ?? m.position[1])} m。`);
  }
  lines.push("", "## 剖切", `views/profile.png 是剖面：${sectionText(section)}（meta.section）。宽度带内的房子、地标、空间、连接点都投影到剖面上；纵向有夸张，标注是真实米数。`);
  if (params.length) {
    lines.push("", "## 参数（谁定的）");
    for (const p of params) lines.push(`- ${p.label}：${p.value}（${p.by}${p.locked ? "，已锁" : ""}）`);
  }
  lines.push("", "## 关系检查（引擎里搭完请再核一遍）");
  for (const c of checks) lines.push(`- ${c.ok ? "✓" : "✗"} ${c.text}${c.detail ? ` — ${c.detail}` : ""}`);
  if (corrections.length) { lines.push("", "## 上一轮读回后的修正要求"); for (const c of corrections) lines.push(`- ${c}`); }
  lines.push("", "## 读回", "把场景里每个对象的 name / position / scale / rotation 导成 readback JSON（格式见 PROTOCOL.md「读回」一节），导入「场景对话」即可逐个比对。", "");
  return lines.join("\n");
}

/**
 * 组包。views = { map: svg, profile: svg, eye: svg, three?: dataURL }
 * @returns {Promise<Blob>}
 */
export async function buildPackage({ sid, card, facts, checks, params = [], eye, section = null, views, corrections = [] }) {
  if (!window.JSZip) throw new Error("JSZip 没有加载（需要联网访问 cdn.jsdelivr.net）");
  const doc = cleanSid(sid);
  if (section) doc.meta.section = JSON.parse(JSON.stringify(section));
  const zip = new window.JSZip();
  const imgs = [];
  if (views.map) { const r = await svgToPng(views.map, 2048); zip.file("views/top.png", r.blob); imgs.push({ kind: "top_down", image: "views/top.png", scale_m_per_px: Math.round(r.m_per_px * 1e5) / 1e5, north_up: true, labels_drawn: true }); }
  if (views.profile) { const r = await svgToPng(views.profile, 1600); zip.file("views/profile.png", r.blob); imgs.push({ kind: "section", image: "views/profile.png", labels_drawn: true, note: `剖面：${sectionText(section)}，纵向有夸张` }); }
  if (views.eye) { const r = await svgToPng(views.eye, 1600); zip.file("views/first-sight.png", r.blob); imgs.push({ kind: "perspective", image: "views/first-sight.png", labels_drawn: true, note: "从出生点 1.7 m 眼高朝地标的示意，不是渲染" }); }
  if (views.three) { zip.file("views/preview-3d.png", dataURLToBlob(views.three)); imgs.push({ kind: "perspective", image: "views/preview-3d.png", labels_drawn: false, note: "3D 预览截图" }); }
  doc.views = (doc.views || []).filter((v) => !String(v.image || "").startsWith("views/")).concat(imgs);
  zip.file("scene.sid.json", JSON.stringify(doc, null, 2));
  zip.file("BRIEF.md", buildBrief({ sid: doc, card, facts, checks, params, eye, section, corrections }));
  try { const r = await fetch("../spec/PROTOCOL.md"); if (r.ok) zip.file("PROTOCOL.md", await r.text()); } catch { /* 离线 / 打包缺文件时跳过 */ }
  try { const r = await fetch("../spec/sid.schema.json"); if (r.ok) zip.file("sid.schema.json", await r.text()); } catch { /* 同上 */ }
  return zip.generateAsync({ type: "blob" });
}

/** score_readback 的结果 → 地图红点 */
export function readbackDiffs(result, sid) {
  const byId = {};
  for (const v of sid.volumes || []) byId[v.id] = v.position;
  for (const m of sid.markers || []) byId[m.id] = m.position;
  const diffs = [];
  for (const r of result.rows || []) {
    const from = byId[r.id];
    if (!from) continue;
    const bad = r.pos_ok === false || r.size_ok === false || r.rot_ok === false || r.level_ok === false || r.color_ok === false || !r.matched;
    if (!bad) continue;
    diffs.push({ id: r.id, from: [from[0], from[2]], to: r.readback_position ? [r.readback_position[0], r.readback_position[2]] : null, err_m: r.pos_err_m, row: r });
  }
  for (const id of (result.summary && result.summary.missing) || []) if (byId[id] && !diffs.some((d) => d.id === id)) diffs.push({ id, from: [byId[id][0], byId[id][2]], to: null, err_m: null, row: null, missing: true });
  return diffs;
}
