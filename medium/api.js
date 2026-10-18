// api.js — 与本地 Python 服务（desktop/api_server.py）的 /api/* 通信。密钥不经过这里。

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { data = { error: "bad json", message: `HTTP ${res.status}` }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  /** 服务是否在（用 python http.server 直接开静态页时没有 /api，前端退回「纯本地模拟」） */
  async health() { try { return await call("GET", "/api/health"); } catch { return null; } },
  config() { return call("GET", "/api/config"); },
  setConfig(patch) { return call("POST", "/api/config", patch); },
  testKey(api_key) { return call("POST", "/api/config/test", api_key ? { api_key } : {}); },
  /** 一句话 → 3 张卡。axis / targets / locked 用于「换一批」 */
  draft(intent, { axis = null, targets = null, locked = null } = {}) { return call("POST", "/api/ai/draft", { intent, axis, targets, locked }); },
  /** 人的一次动作（结构化事实）→ 对当前卡的 patch + 复述 */
  revise(card, action, locked = null) { return call("POST", "/api/ai/revise", { card, action, locked }); },
  /** 意图 SID vs 引擎读回 → score_readback 的结果 */
  score(intent, readback, opts = {}) { return call("POST", "/api/score", { intent, readback, auto_map: true, ...opts }); },
  save(name, content) { return call("POST", "/api/save", { name, content }); },
};
