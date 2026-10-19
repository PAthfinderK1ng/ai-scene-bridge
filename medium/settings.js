// settings.js — 右上角 AI 状态 pill 与「AI 设置」弹窗：服务商（Claude / DeepSeek）、密钥（按服务商分别保存；显示 / 清除 / 保存前先测）、
// 模型候选、DeepSeek 的「深度思考」开关、强制模拟。弹窗骨架在 index.html，服务商分段与思考开关由这里动态建。
// 密钥只进输入框和 /api/config，不回显到任何消息或日志。
import { api } from "./api.js";
import { el } from "./cards.js";

const $ = (s) => document.querySelector(s);
const PROVIDERS = [["deepseek", "DeepSeek"], ["anthropic", "Claude"]];
const KEY_LABEL = { anthropic: "Anthropic API Key", deepseek: "DeepSeek API Key" };
const KEY_PH = { anthropic: "sk-ant-…", deepseek: "sk-…" };
const MODELS = { anthropic: ["claude-opus-5-5", "claude-sonnet-4-5"], deepseek: ["deepseek-flash", "deepseek-v4-pro"] };
let A = null;
let C = null;          // 最近一次 /api/config
let sel = "deepseek";  // 弹窗里选中的服务商
const typed = {};      // 每个服务商输入框里还没保存的密钥 / 模型（切换分段时不丢）

/** 注入 app.js 的状态与工具：{ S, sys } */
export function initSettings(deps) { A = deps; }

/** 「DeepSeek flash」「Claude opus-5-5」：服务商 + 去掉前缀的模型名（+ 思考） */
export function aiLabel(h) {
  if (!h) return "";
  const prov = h.provider_label || (h.provider === "anthropic" ? "Claude" : "DeepSeek");
  const m = String(h.model || "").replace(/^deepseek-/, "").replace(/^claude-/, "");
  return `${prov} ${m}`.trim() + (h.thinking ? " · 思考" : "");
}

/** 问一次 /api/health，刷新 pill（模拟 / DeepSeek / Claude / 未连接）；同时只跑一个 */
export async function refreshAI() {
  const { S } = A;
  if (S.refreshing) return;
  S.refreshing = true;
  try {
    const h = await api.health();
    S.ai = h;
    const pill = $("#ai-status");
    if (!h) { pill.textContent = "AI：服务未连接"; pill.title = "本地 Python 服务没响应：用 python desktop/sid_editor.py 启动"; pill.className = "pill mock"; return; }
    if (h.mock) { pill.textContent = "AI：模拟 · 点我设置"; pill.title = "没有密钥或勾了模拟：用脚本模拟，不花钱。点我填 DeepSeek / Claude 密钥"; pill.className = "pill mock"; }
    else { pill.textContent = `AI：${aiLabel(h)}`; pill.title = "只有打字、重出、换一批才调 AI；点我改设置"; pill.className = "pill live"; }
  } finally { S.refreshing = false; }
}

/** 密钥失效 / 服务掉线时由错误处理调用：把 pill 改成能点的提示 */
export function markPill(kind) {
  const pill = $("#ai-status");
  if (kind === "auth") { pill.textContent = "AI：密钥无效，点此设置"; pill.className = "pill bad"; }
  else if (kind === "offline") { pill.textContent = "AI：服务未连接"; pill.className = "pill mock"; refreshAI(); }
}

/** 弹窗里缺的控件（服务商分段、思考开关）第一次打开时建好 */
function ensureControls() {
  if ($("#s-prov")) return;
  const keyRow = $("#s-key").closest("label");
  const seg = el("div", { id: "s-prov", class: "row", role: "group", "aria-label": "服务商" }, el("span", {}, "服务商"),
    ...PROVIDERS.map(([p, label]) => el("button", { type: "button", class: "ubtn", "data-p": p, "aria-pressed": "false", onclick: () => pick(p) }, label)));
  keyRow.before(seg);
  const think = el("label", { class: "row", id: "s-think-row" }, el("input", { id: "s-think", type: "checkbox" }), "深度思考（更慢、更贵；默认关）");
  $("#s-model").closest("label").after(think);
  document.head.append(el("style", {}, "#s-prov{display:flex;gap:6px;align-items:center;margin-top:10px;font-size:13px}#s-prov button[aria-pressed=true]{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}#s-think-row[hidden]{display:none}"));
}

/** 记下当前服务商输入框里的东西，再切到 p */
function stash() { typed[sel] = { key: $("#s-key").value, model: $("#s-model").value, think: $("#s-think").checked }; }
function pick(p) { stash(); sel = p; fill(); }

/** 按选中的服务商填表（密钥框永远不回显已保存的密钥） */
function fill() {
  const pc = (C && C.providers && C.providers[sel]) || {};
  const t = typed[sel] || {};
  document.querySelectorAll("#s-prov button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === sel)));
  $("#s-key").closest("label").querySelector("span").textContent = KEY_LABEL[sel];
  $("#s-key").value = t.key || ""; $("#s-key").type = "password"; $("#s-show").textContent = "显示";
  $("#s-key").placeholder = pc.has_key ? `已保存 ${pc.key_hint}（留空不改）` : KEY_PH[sel];
  $("#s-model").value = t.model || pc.model || MODELS[sel][0];
  $("#s-models").replaceChildren(...[...(pc.models || []), ...MODELS[sel]].filter((v, i, a) => v && a.indexOf(v) === i).map((v) => el("option", { value: v })));
  $("#s-think-row").hidden = sel !== "deepseek";
  $("#s-think").checked = t.think ?? !!pc.thinking;
  $("#s-mock").checked = !!(C && C.mock_forced); $("#s-mock").disabled = !pc.has_key && !t.key;
  $("#s-clear").hidden = !pc.has_key || pc.key_source === "env";
  $("#s-key-hint").textContent = pc.key_source === "env" ? `当前密钥来自环境变量（这里清不掉）` : pc.has_key ? "" : `没有 ${KEY_LABEL[sel]}：会用模拟 AI。填上后保存前会先测一次。`;
  $("#s-test-result").textContent = "";
}

/** 打开设置弹窗：读当前配置，选中当前服务商 */
export async function openSettings() {
  const dlg = $("#settings");
  ensureControls();
  C = null;
  try { C = await api.config(); } catch { /* 服务未连接 */ }
  for (const k of Object.keys(typed)) delete typed[k];
  if (C) { sel = C.provider || "deepseek"; fill(); }
  else { $("#s-key-hint").textContent = "本地服务未连接：请用 python desktop/sid_editor.py 启动"; $("#s-mock").disabled = true; $("#s-clear").hidden = true; }
  if (!dlg.open) dlg.showModal();
}

const TEST_ERR = { auth: "密钥无效或过期", net: "连不上服务商（网络 / 代理）", offline: "本地服务没响应", timeout: "等太久没回来", model: "模型名不对", rate: "请求太频繁或余额不足", busy: "模型繁忙" };
/** 测密钥：本地服务对坏密钥回非 2xx 时 api.testKey 会 throw，这里一律折成 { ok:false, message: 中文原因 }，不让英文 / 原始字典外露 */
async function testKeySafe(key, opts) {
  try { return await api.testKey(key, opts); }
  catch (e) {
    const d = (e && e.data) || {};
    const why = (d.hint && !/Error code|\{/.test(d.hint) ? d.hint : null) || TEST_ERR[e && e.kind] || "服务出错";
    const rid = d.request_id || (String(d.message || "").match(/req_[A-Za-z0-9]+/) || [])[0];
    return { ok: false, message: why + (rid ? `（request_id ${rid}）` : "") };
  }
}

/** 绑定弹窗里的按钮：显示 / 隐藏、清除、测试、保存（先测后存） */
export function bindSettings() {
  const { sys } = A;
  ensureControls();
  $("#ai-status").addEventListener("click", openSettings);
  $("#s-cancel").addEventListener("click", () => $("#settings").close());
  $("#s-show").addEventListener("click", () => { const k = $("#s-key"); k.type = k.type === "password" ? "text" : "password"; $("#s-show").textContent = k.type === "password" ? "显示" : "隐藏"; });
  $("#s-key").addEventListener("input", () => { $("#s-mock").disabled = !$("#s-key").value.trim() && !(C && C.providers && C.providers[sel] && C.providers[sel].has_key); });
  $("#s-clear").addEventListener("click", async () => {
    if (!confirm(`清除本机保存的 ${KEY_LABEL[sel]}？`)) return;
    try { await api.setConfig({ providers: { [sel]: { api_key: "" } } }); await refreshAI(); sys("密钥已清除。"); openSettings(); } catch (e) { $("#s-test-result").textContent = "清除失败：" + e.message; }
  });
  const lockButtons = (on) => { $("#s-save").disabled = on; $("#s-test").disabled = on; $("#s-clear").disabled = on; };
  const model = () => $("#s-model").value.trim() || undefined;
  $("#s-test").addEventListener("click", async () => {
    const key = $("#s-key").value.trim();
    const who = key ? "刚输入的密钥" : "已保存的密钥";
    $("#s-test-result").textContent = `${who}：测试中…`;
    lockButtons(true);
    try { const r = await testKeySafe(key || undefined, { provider: sel, model: model() }); $("#s-test-result").textContent = `${who}：${r.ok ? `可用 · ${r.model} · ${r.ms} ms` : `不可用：${r.message}`}`; }
    finally { lockButtons(false); }
  });
  $("#settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const { S } = A;
    const pc = { model: model() };
    if (sel === "deepseek") pc.thinking = $("#s-think").checked;
    const key = $("#s-key").value.trim();
    lockButtons(true);
    try {
      if (key) {
        $("#s-test-result").textContent = "先测一下…";
        const r = await testKeySafe(key, { provider: sel, model: pc.model });
        if (!r.ok) { $("#s-test-result").textContent = `不可用：${r.message}，没有保存。`; return; }
        pc.api_key = key;
      }
      await api.setConfig({ provider: sel, mock: $("#s-mock").checked, providers: { [sel]: pc } });
      $("#settings").close();
      await refreshAI();
      sys(`AI 设置已保存：${S.ai && S.ai.mock ? "模拟（不花钱）" : aiLabel(S.ai)}`);
    } catch (e) { $("#s-test-result").textContent = "保存失败：" + ((e.data && e.data.message) || e.message); }
    finally { lockButtons(false); }
  });
}
