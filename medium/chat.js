// chat.js — 左栏聊天：只用来和 AI 说话。消息、等待气泡（可取消 / 失败给中文原因）、每次 AI 调用的耗时与费用一行。
// 本地操作（点、拖、圈、面板）不往这里写任何东西。
import { api } from "./api.js";
import { el, settle } from "./cards.js";
import { $, S, A } from "./state.js";
import { openSettings, markPill } from "./settings.js";

export const ERR_TEXT = { offline: "本地服务没响应（它关了？）", auth: "密钥无效或过期", model: "模型名不对", rate: "请求太频繁或余额不足", busy: "模型繁忙", timeout: "等太久了（超过时限没回来）", net: "连不上 AI 服务商（网络 / 代理）", server: "服务出错" };

/** 「调 AI」小标：会花钱的按钮都带它 */
export const aiTag = () => el("span", { class: "ai-tag", title: "点了会调用一次 AI" }, "调 AI");

/** 滚到一条消息：贴着底部时才动 */
function scrollToMsg(m) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80 || log.lastElementChild === m;
  if (nearBottom) log.scrollTop = 1e9;
}
/** 一条消息（ai / user / sys），可带附件节点 */
export function msg(who, text, attach) {
  const m = el("div", { class: "msg " + who }, who === "sys" ? null : el("div", { class: "who" }, who === "ai" ? "AI" : "你"), text);
  if (attach) m.append(el("div", { class: "attach" }, attach));
  $("#log").append(m); scrollToMsg(m);
  return m;
}
export const ai = (t, a) => msg("ai", t, a);
export const sys = (t) => msg("sys", t);

/** 一排 chip：点一个后整组失效 */
export function chips(labels, onPick, { tag } = {}) {
  const row = el("div", { class: "chiprow" });
  labels.forEach((l) => row.append(el("button", { class: "chip", onclick: (ev) => { settle(ev.currentTarget); A.bump("choose"); onPick(l); } }, l, tag && tag(l) ? aiTag() : null)));
  return row;
}

/** 等待气泡：原地替换成结果；3 s 起显示秒数；可取消；失败时给中文原因 + 重试 / 设置 / 改模拟 */
export function thinking(t, { onCancel } = {}) {
  const txt = el("span", { class: "txt" }, t), sec = el("span", { class: "sec" });
  const m = el("div", { class: "msg ai thinking" }, el("div", { class: "who" }, "AI"), txt, sec);
  if (onCancel) m.append(el("button", { class: "chip mini", onclick: (ev) => { settle(ev.currentTarget); onCancel(); } }, "取消"));
  $("#log").append(m); scrollToMsg(m);
  const t0 = Date.now();
  const tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); if (s >= 3) sec.textContent = ` ${s} s`; }, 1000);
  const stop = () => { clearInterval(tick); m.classList.remove("thinking"); };
  return {
    done(text, attach) { stop(); m.replaceChildren(el("div", { class: "who" }, "AI"), text); if (attach) m.append(el("div", { class: "attach" }, attach)); scrollToMsg(m); return m; },
    update(text) { txt.textContent = text; },
    fail(e, retry) {
      stop();
      if (e && e.kind === "cancel") { m.className = "msg sys"; m.replaceChildren("已取消。"); return; }
      const kind = e && e.kind, data = (e && e.data) || {};
      const raw = [data.hint, e && e.message, data.request_id ? `request_id ${data.request_id}` : ""].filter(Boolean).join("\n");
      m.replaceChildren(el("div", { class: "who" }, "AI"), ERR_TEXT[kind] || "AI 调用失败", el("details", { class: "raw" }, el("summary", {}, "原始信息"), raw || String(e)));
      const labels = ["重试", "打开 AI 设置"].concat(kind !== "offline" ? ["这次用模拟 AI"] : []);
      m.append(el("div", { class: "attach" }, chips(labels, (l) => {
        if (l === "重试") { if (retry) retry(); }
        else if (l.startsWith("打开")) openSettings();
        else { S.mock = true; sys("这一页之后都用模拟 AI（不花钱），刷新页面换回。"); if (retry) retry(); }
      }, { tag: (l) => l === "重试" })));
      if (kind === "auth" || kind === "offline") markPill(kind);
      scrollToMsg(m);
    },
  };
}

const fmtK = (n) => (n == null ? "0" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const PROV = { deepseek: "DeepSeek", claude: "Claude", anthropic: "Claude", mock: "模拟 AI" };
/** 一次 AI 调用的一行：「DeepSeek flash · 1.8 s · 2.1k token · ¥0.002」；模拟写「不花钱」 */
export function usageLine(d) {
  if (!d) return;
  const u = d._usage || {}, ms = d._ms ?? u.ms ?? 0;
  const who = `${PROV[d.provider] || d.provider || "AI"}${d.provider !== "mock" && u.model ? " " + String(u.model).replace(/^deepseek-|^claude-/, "") : ""}`;
  if (d.provider === "mock") { sys(`${who} · ${(ms / 1000).toFixed(1)} s · 不花钱`); return; }
  const tok = (u.input || 0) + (u.output || 0);
  const cost = u.cost_cny != null ? (u.cost_cny < 0.001 ? "<¥0.001" : `¥${u.cost_cny.toFixed(3)}`) : u.cost_usd != null ? `$${u.cost_usd.toFixed(3)}` : "";
  sys([who, `${(ms / 1000).toFixed(1)} s`, `${fmtK(tok)} token`, cost].filter(Boolean).join(" · "));
}
