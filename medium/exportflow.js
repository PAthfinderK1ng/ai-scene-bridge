// exportflow.js — 「出」：导出引擎包的弹窗、读回 JSON 的导入与比对表、红点三选一。
import { api } from "./api.js";
import { el } from "./cards.js";
import { humanize } from "./panels.js";
import { renderMap } from "./views/map.js";
import { buildPackage, download, fileStem, cleanSid, readbackDiffs } from "./exporter.js";

const $ = (s) => document.querySelector(s);
let A = null;
/** 注入 app.js 的状态与工具：{ S, ai, bump, setStep, renderViews, renderPanels, ctx } */
export function initExport(deps) { A = deps; }

/** 打开弹窗并把焦点放到第一个按钮 */
function openModal(kids) { $("#modal-card").replaceChildren(...kids); $("#modal").hidden = false; const b = $("#modal-card button"); if (b) b.focus(); }
/** 关弹窗；只是看了一眼没导读回的话，步骤回到「核」 */
export function closeModal() { $("#modal").hidden = true; if (A.S.step === 6 && !A.S.readback) A.setStep(5); }

/** 「出」弹窗：三步说明 + ① 交给引擎（两个导出按钮）+ ② 读回拖放框 */
export function openExport() {
  const { S } = A;
  if (!S.scene) return;
  A.setStep(6);
  const sc = S.scene, f = sc.facts;
  const body = el("div", {});
  const status = el("div", { class: "hint" });
  const fileIn = el("input", { type: "file", accept: ".json,application/json", style: "display:none", onchange: (ev) => { const file = ev.target.files && ev.target.files[0]; if (file) onReadbackFile(file, body, status); ev.target.value = ""; } });
  const n = [...S.confirmed].length, total = (S.items || []).length;
  openModal([
    el("h3", {}, "出：交给引擎"),
    el("div", {}, `「${sc.sid.meta.name || sc.card.name}」· ${f.houses} 栋 · ${f.terraces} 层 · 关系 ${f.checks_ok}/${f.checks_total} ✓ · 理解 ${n}/${total} 条已点对`),
    el("ol", { class: "hint", style: "margin:6px 0 0 18px;padding:0" },
      el("li", {}, "点「导出引擎包」得到一个 zip：里面是场景意图（scene.sid.json）、三张图，和一份给搭建者（人或 AI）的交代 BRIEF.md。"),
      el("li", {}, "把 zip 交给引擎那边，照着搭。"),
      el("li", {}, "搭完让引擎导出 readback.json，拖回下面的框里，差的地方会在俯视图上点红。")),
    el("div", { class: "actions" },
      el("span", { class: "hint" }, "① 交给引擎："),
      el("button", { class: "ubtn primary", onclick: async () => {
        status.textContent = "在渲染三张图并打包…";
        try {
          const blob = await buildPackage({ sid: sc.sid, card: sc.card, facts: sc.facts, checks: sc.checks, understanding: (S.items || []).map((i) => ({ text: i.text, detail: i.detail, confirmed: S.confirmed.has(i.key) })), eye: S.eye, views: { map: renderMap(A.ctx(), { footer: true }), profile: S.profileSvg, eye: S.eyeSvg, three: S.three && S.three.snapshot ? S.three.snapshot() : null }, corrections: S.corrections });
          download(`${fileStem(sc.sid.meta.name || sc.card.name)}.scene-package.zip`, blob);
          status.textContent = `已下载 ${Math.round(blob.size / 1024)} KB 的包。`;
        } catch (e) { status.textContent = "打包失败：" + e.message; }
      } }, "导出引擎包（zip）"),
      el("button", { class: "ubtn", onclick: () => { download(`${fileStem(sc.sid.meta.name || sc.card.name)}.sid.json`, new Blob([JSON.stringify(cleanSid(sc.sid), null, 2)], { type: "application/json" })); status.textContent = "已下载 .sid.json（只有意图，没有图和交代）"; } }, "只要意图 JSON"),
      el("span", { class: "spacer" }), el("button", { class: "ubtn", onclick: closeModal }, "关闭")),
    el("div", { class: "filebox", ondragover: (e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#b8452b"; }, ondragleave: (e) => { e.currentTarget.style.borderColor = ""; }, ondrop: (e) => { e.preventDefault(); e.currentTarget.style.borderColor = ""; const file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) onReadbackFile(file, body, status); }, onclick: () => fileIn.click() }, "② 引擎搭完后：把 readback.json 拖到这里，或点一下选文件"), fileIn,
    status, body,
  ]);
  if (S.readback) renderReadback(body, status);
}

/** 读回文件 → 校验 → /api/score → 红点与表格；错误全部给出能行动的中文 */
export async function onReadbackFile(file, body, status) {
  const { S } = A;
  if (!S.scene) return;
  if (file.size > 20 * 1024 * 1024) { status.textContent = "文件太大（> 20 MB），不是读回 JSON 吧？"; return; }
  status.textContent = "在比对…";
  try {
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { const pos = (String(e.message).match(/position (\d+)/) || [])[1]; throw new Error(`不是合法 JSON${pos ? `（第 ${pos} 个字符附近）` : ""}`); }
    if (!json || typeof json !== "object" || Array.isArray(json) || (!json.objects && !json.volumes)) throw new Error("读回应是一个 JSON 对象：引擎格式 {objects:[{name, position, …}]}，或带 volumes 的 SID");
    const res = await api.score(cleanSid(S.scene.sid), json);
    S.readback = res; S.diffs = readbackDiffs(res, S.scene.sid);
    A.renderViews();
    renderReadback(body, status);
    const s = res.summary;
    if (s.matched === 0) A.ai(`一个都没对上：引擎里的名字像「${(s.extra || []).slice(0, 3).join("」「") || "？"}」，这里的 id 像「${S.scene.sid.volumes.slice(0, 3).map((v) => v.id).join("」「")}」。导出时请保留 id 作为对象名。`);
    else A.ai(`读回对上了 ${s.matched}/${s.intent_objects} 个对象：位置偏差中位数 ${s.pos_err_median_m} m，${s.pos_ok_rate_pct}% 在容差内；缺 ${s.missing.length}，多 ${s.extra.length}。红点是差的地方，每个点都给你三个选择。`);
  } catch (e) {
    const k = e.kind === "offline" ? "本地服务没响应，比对要靠它。" : e.kind === "timeout" ? "比对等太久没回来。" : "";
    status.textContent = `读回没比成：${k || e.message}`;
  }
}

/** 比对结果表：每行一个对象，差的行红字 + 三选一 */
export function renderReadback(body, status) {
  const { S } = A;
  const res = S.readback; if (!res) return;
  body.replaceChildren();
  const s = res.summary;
  const okMark = (v) => (v === true ? "✓" : v === false ? "✗" : "—");
  const pct = (v) => (v == null ? "—" : `${v}%`);
  const vis = s.visible_from_spawn || {}, con = s.trail_connected || {};
  status.textContent = `读回格式 ${res.format} · 匹配 ${s.matched}/${s.intent_objects} · 位置中位误差 ${s.pos_err_median_m} m · 位置合格 ${s.pos_ok_rate_pct}% · 尺寸合格 ${s.size_ok_rate_pct}% · 朝向合格 ${s.rot_ok_rate_pct}% · 层合格 ${pct(s.level_ok_rate_pct)} · 颜色合格 ${pct(s.color_ok_rate_pct)} · 出生点见地标 ${okMark(vis.readback)}${vis.readback === false && vis.blocked_by ? `（被 ${humanize(vis.blocked_by)} 挡）` : ""} · 主路连通 ${okMark(con.readback)}`;
  const levelCell = (r) => (r.level_intent == null ? "—" : r.level_ok === false ? `${r.level_intent + 1}→${r.level_readback + 1} 层` : `${r.level_intent + 1} 层`);
  const colorCell = (r) => (r.delta_e == null ? "—" : el("span", {}, el("span", { class: "swatch", style: `background:${r.color_readback}`, title: `读回 ${r.color_readback} · 意图 ${r.color_intent}` }), ` ΔE ${r.delta_e}`));
  const table = el("table", {}, el("tr", {}, ...["对象", "匹配到", "位置误差 m", "高度差 m", "尺寸比", "朝向差°", "层", "颜色", "怎么办"].map((h) => el("th", {}, h))));
  const again = () => renderReadback(body, status);
  for (const r of res.rows) {
    const d = S.diffs.find((x) => x.id === r.id);
    const bad = !!d;
    table.append(el("tr", { class: bad ? "bad" : "" }, el("td", { title: r.id }, humanize(r.id)), el("td", {}, r.matched || "—"), el("td", { class: "num" }, r.pos_err_m ?? "—"), el("td", { class: "num" }, r.dy_m ?? "—"), el("td", { class: "num" }, r.size_ratio ?? "—"), el("td", { class: "num" }, r.rot_err ?? "—"),
      el("td", { class: "num" }, levelCell(r)), el("td", { class: "num" }, colorCell(r)),
      el("td", {}, bad ? el("div", { class: "fixes" }, ...diffButtons(d, again)) : "✓")));
  }
  for (const d of S.diffs.filter((x) => x.missing)) table.append(el("tr", { class: "bad" }, el("td", { title: d.id }, humanize(d.id)), el("td", {}, "— 引擎里没有"), ...Array.from({ length: 6 }, () => el("td", { class: "num" }, "—")), el("td", {}, el("div", { class: "fixes" }, ...diffButtons(d, again)))));
  body.append(table);
  if (vis.readback === false || con.readback === false) body.append(el("p", { class: "hint" }, `${vis.readback === false ? `引擎里从出生点看不见地标${vis.blocked_by ? `（被 ${humanize(vis.blocked_by)} 挡）` : ""}${vis.intent ? "，意图里能看见" : ""}。` : ""}${con.readback === false ? `引擎里主路没有从出生点连到地标门前${con.intent ? "，意图里是连通的" : ""}。` : ""}`));
  if (S.corrections.length) body.append(el("div", { style: "margin-top:8px" }, el("b", {}, "下一轮修正要求（会写进 BRIEF.md）"), el("pre", {}, S.corrections.join("\n"))));
}

/** 一个红点的三选一：按意图修（记进修正要求）/ 接受引擎版（意图跟着改并锁住）/ 不重要 */
export function diffButtons(d, after = () => {}) {
  const { S } = A;
  const row = d.row || {};
  const done = () => { S.diffs = S.diffs.filter((x) => x.id !== d.id); A.renderViews(); after(); };
  return [
    el("button", { class: "chip", onclick: () => { A.bump("choose"); const txt = d.missing ? `${d.id}：引擎里没放，请按 SID 位置 (${d.from[0]}, ${d.from[1]}) 补上` : `${d.id}：意图位置 (${d.from[0]}, ${d.from[1]})，引擎放在 (${d.to ? d.to.map((v) => Math.round(v * 10) / 10).join(", ") : "?"})，偏 ${row.pos_err_m} m${row.rot_ok === false ? `，朝向差 ${row.rot_err}°` : ""}${row.size_ok === false ? `，尺寸比 ${row.size_ratio}` : ""}${row.level_ok === false ? `，落在第 ${row.level_readback + 1} 层而不是第 ${row.level_intent + 1} 层` : ""}${row.color_ok === false ? `，颜色 ${row.color_readback} 应为 ${row.color_intent}（ΔE ${row.delta_e}）` : ""}；请按意图重放`; if (!S.corrections.includes(txt)) S.corrections.push(txt); done(); A.ai(`记下了：${humanize(d.id)}按意图重放（写进下一轮 BRIEF 的修正要求）。`); } }, "按意图修"),
    d.to ? el("button", { class: "chip", onclick: () => { A.bump("choose"); S.scene.acceptReadback(d.id, row.readback_position || [d.to[0], 0, d.to[1]], row.readback_rotation_y); done(); A.renderPanels(); A.ai(`${humanize(d.id)}接受引擎的位置，意图跟着改了并锁住。`); } }, "接受引擎版") : null,
    el("button", { class: "chip", onclick: () => { A.bump("choose"); done(); } }, "不重要"),
  ].filter(Boolean);
}
