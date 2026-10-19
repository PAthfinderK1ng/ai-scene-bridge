// api.js — 与本地 Python 服务（desktop/api_server.py）的 /api/* 通信。密钥不经过这里。
// 每个请求都有超时与可取消的 signal；失败时给 err.kind（offline / auth / model / rate / busy / timeout / cancel / net / server），界面据此给中文提示。

/** 一次 /api 调用：超时自动中止；外部 signal 中止记为 cancel；非 2xx 按状态码归类 kind */
async function call(method, path, body, { timeoutMs = 30000, signal } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  if (signal) { if (signal.aborted) ac.abort("cancel"); else signal.addEventListener("abort", () => ac.abort("cancel"), { once: true }); }
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
  } catch (e) {
    const err = new Error(e && e.message ? e.message : String(e));
    if (ac.signal.aborted) err.kind = ac.signal.reason === "cancel" ? "cancel" : "timeout";
    else if (e instanceof TypeError || (e && e.name === "TypeError")) err.kind = "offline";
    else err.kind = "server";
    throw err;
  } finally { clearTimeout(t); }
  let data = null;
  try { data = await res.json(); } catch { data = { error: "bad json", message: `HTTP ${res.status}` }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    err.kind = classify(res.status, data);
    throw err;
  }
  return data;
}

/** 状态码 → kind。本地服务把上游（Anthropic / DeepSeek）的状态码放在 data.status 里（本身回 502） */
function classify(status, data) {
  const st = (data && data.status) || status;
  const msg = String((data && (data.message || data.type)) || "");
  if (st === 401 || st === 403) return "auth";
  if ((st === 404 || st === 400 || st === 422) && /model/i.test(msg + (data && data.hint || ""))) return "model";
  if (st === 429 || st === 402) return "rate"; // 402：余额 / 计费问题
  if (st === 529 || st === 503 || /overloaded/i.test(msg)) return "busy";
  if (/APIConnectionError|APITimeoutError/.test(msg)) return "net";
  return "server";
}

export const api = {
  /** 服务是否在（用 python http.server 直接开静态页时没有 /api，前端退回「纯本地模拟」） */
  async health() { try { return await call("GET", "/api/health", null, { timeoutMs: 5000 }); } catch { return null; } },
  config() { return call("GET", "/api/config", null, { timeoutMs: 10000 }); },
  setConfig(patch) { return call("POST", "/api/config", patch, { timeoutMs: 30000 }); },
  /** 测密钥：opts 可带 provider / model（测还没保存的设置）；不带 api_key 就测已保存的 */
  testKey(api_key, opts = {}) { return call("POST", "/api/config/test", { ...(api_key ? { api_key } : {}), ...opts }, { timeoutMs: 45000 }); },
  /** 一句话 → 3 张卡。axis / targets / locked 用于「换一批」；mock:true → force_mock（这次走模拟 AI，不花钱）。
   *  返回 { cards, provider, _usage: { input, output, cache_read, ms, cost_cny | cost_usd }, _ms } */
  draft(intent, { axis = null, targets = null, locked = null, mock = false } = {}, { signal, mock: mock2 = false } = {}) {
    return call("POST", "/api/ai/draft", { intent, axis, targets, locked, ...(mock || mock2 ? { force_mock: true } : {}) }, { timeoutMs: 120000, signal });
  },
  /** 人的一句话 / 动作（结构化事实）→ 对当前卡的 patch + 复述（+ provider / _usage / _ms）；{ mock:true } → force_mock */
  revise(card, action, locked = null, { signal, mock = false } = {}) {
    return call("POST", "/api/ai/revise", { card, action, locked, ...(mock ? { force_mock: true } : {}) }, { timeoutMs: 60000, signal });
  },
  /** 意图 SID vs 引擎读回 → score_readback 的结果 */
  score(intent, readback, opts = {}) { return call("POST", "/api/score", { intent, readback, auto_map: true, ...opts }, { timeoutMs: 30000 }); },
  save(name, content) { return call("POST", "/api/save", { name, content }, { timeoutMs: 30000 }); },
};
