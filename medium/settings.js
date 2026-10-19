// settings.js — 右上角 AI 状态 pill 与「AI 设置」弹窗：密钥（显示 / 清除 / 保存前先测）、模型候选、强制模拟。
// 密钥只进输入框和 /api/config，不回显到任何消息或日志。
import { api } from "./api.js";
import { el } from "./cards.js";

const $ = (s) => document.querySelector(s);
let A = null;
/** 注入 app.js 的状态与工具：{ S, sys } */
export function initSettings(deps) { A = deps; }

/** 问一次 /api/health，刷新 pill（模拟 / Claude / 未连接）；同时只跑一个 */
export async function refreshAI() {
  const { S } = A;
  if (S.refreshing) return;
  S.refreshing = true;
  try {
    const h = await api.health();
    S.ai = h;
    const pill = $("#ai-status");
    if (!h) { pill.textContent = "AI：服务未连接"; pill.title = "本地 Python 服务没响应：用 python desktop/sid_editor.py 启动"; pill.className = "pill mock"; return; }
    if (h.mock) { pill.textContent = "AI：模拟 · 点我填密钥"; pill.title = "没有密钥时用脚本模拟；填入 Anthropic API Key 后换成 Claude"; pill.className = "pill mock"; }
    else { pill.textContent = `AI：${h.model}`; pill.title = "正在用 Claude；点我改设置"; pill.className = "pill live"; }
  } finally { S.refreshing = false; }
}

/** 密钥失效 / 服务掉线时由错误处理调用：把 pill 改成能点的提示 */
export function markPill(kind) {
  const pill = $("#ai-status");
  if (kind === "auth") { pill.textContent = "AI：密钥无效，点此设置"; pill.className = "pill bad"; }
  else if (kind === "offline") { pill.textContent = "AI：服务未连接"; pill.className = "pill mock"; refreshAI(); }
}

/** 打开设置弹窗：读当前配置填表（密钥框永远留空）、模型候选、按有没有密钥决定哪些控件可用 */
export async function openSettings() {
  const dlg = $("#settings");
  let c = null;
  try { c = await api.config(); } catch { /* 服务未连接 */ }
  if (c) {
    $("#s-key").value = ""; $("#s-key").type = "password"; $("#s-show").textContent = "显示";
    $("#s-key").placeholder = c.has_key ? `已保存 ${c.key_hint}（留空不改）` : "sk-ant-…";
    $("#s-model").value = c.model;
    $("#s-models").replaceChildren(...[c.model, "claude-opus-5-5", "claude-sonnet-4-5"].filter((v, i, a) => v && a.indexOf(v) === i).map((v) => el("option", { value: v })));
    $("#s-mock").checked = !!c.mock && c.has_key; $("#s-mock").disabled = !c.has_key;
    $("#s-clear").hidden = !c.has_key || c.key_source === "env";
    $("#s-key-hint").textContent = c.key_source === "env" ? "当前密钥来自环境变量 ANTHROPIC_API_KEY（这里清不掉）" : c.has_key ? "" : "没有密钥：现在用的是模拟 AI。填一把 Anthropic 密钥，保存前会先测一次。";
  } else { $("#s-key-hint").textContent = "本地服务未连接：请用 python desktop/sid_editor.py 启动"; $("#s-mock").disabled = true; $("#s-clear").hidden = true; }
  $("#s-test-result").textContent = "";
  if (!dlg.open) dlg.showModal();
}

const TEST_ERR = { auth: "密钥无效或过期", net: "连不上 Anthropic（网络 / 代理）", offline: "本地服务没响应", timeout: "等太久没回来", model: "模型名不对", rate: "请求太频繁或额度用完", busy: "模型繁忙" };
/** 测密钥：本地服务对坏密钥回非 2xx 时 api.testKey 会 throw，这里一律折成 { ok:false, message: 中文原因 }，不让英文 / 原始字典外露 */
async function testKeySafe(key) {
  try { return await api.testKey(key); }
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
  $("#ai-status").addEventListener("click", openSettings);
  $("#s-cancel").addEventListener("click", () => $("#settings").close());
  $("#s-show").addEventListener("click", () => { const k = $("#s-key"); k.type = k.type === "password" ? "text" : "password"; $("#s-show").textContent = k.type === "password" ? "显示" : "隐藏"; });
  $("#s-clear").addEventListener("click", async () => {
    if (!confirm("清除本机保存的密钥？之后用模拟 AI。")) return;
    try { await api.setConfig({ api_key: "" }); await refreshAI(); sys("密钥已清除，现在用模拟 AI。"); openSettings(); } catch (e) { $("#s-test-result").textContent = "清除失败：" + e.message; }
  });
  const lockButtons = (on) => { $("#s-save").disabled = on; $("#s-test").disabled = on; $("#s-clear").disabled = on; };
  $("#s-test").addEventListener("click", async () => {
    const key = $("#s-key").value.trim();
    const who = key ? "刚输入的密钥" : "已保存的密钥";
    $("#s-test-result").textContent = `${who}：测试中…`;
    lockButtons(true);
    try { const r = await testKeySafe(key || undefined); $("#s-test-result").textContent = `${who}：${r.ok ? `可用 · ${r.model} · ${r.ms} ms` : `不可用：${r.message}`}`; }
    finally { lockButtons(false); }
  });
  $("#settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const { S } = A;
    const patch = { model: $("#s-model").value.trim() || undefined, mock: $("#s-mock").checked };
    const key = $("#s-key").value.trim();
    lockButtons(true);
    try {
      if (key) {
        $("#s-test-result").textContent = "先测一下…";
        const r = await testKeySafe(key);
        if (!r.ok) { $("#s-test-result").textContent = `不可用：${r.message}，没有保存。`; return; }
        patch.api_key = key;
      }
      await api.setConfig(patch);
      $("#settings").close();
      await refreshAI();
      sys(`AI 设置已保存：${S.ai && S.ai.mock ? "模拟模式" : "使用 " + (S.ai && S.ai.model)}`);
    } catch (e) { $("#s-test-result").textContent = "保存失败：" + ((e.data && e.data.message) || e.message); }
    finally { lockButtons(false); }
  });
}
