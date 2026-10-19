// session.js — 场景会话与用户记忆（docs/07 §2 §3）。v6 唯一新加的文件：app.js / ui.js 都已接近 1200 行，这一块（存取 + 两个面板）职责独立。
// 场景：/api/scenes（列表、新建、读、存、删 → 回收站 7 天、复制、恢复），改动后 1.5 s 防抖自动保存（程序、候选、聊天、历史、撤销栈、视图状态），
// 启动时打开上次的场景；左侧可收起的场景栏（名字、缩略图、时间；新建 / 改名 / 复制 / 删除）。
// 记忆：/api/memory（列表、加、改、删、清空）；顶栏「记忆」面板（开关、编辑、删除、来源、用过几次）；聊天里「要记住吗：… [记住] [不用]」与「记住这个」。
// 本地服务不可用（或演示时）退回 localStorage：localApi 按同样的路由在浏览器里存，演示用 demo: 前缀且每次清空，不碰真实数据。全部本地，不调 AI。
import { store, call, actions as A, sceneData, loadState } from "./app.js";
import { el } from "./ui.js";
import * as MapView from "./views/map.js";

const $ = (s) => document.querySelector(s);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const btn = (label, on, cls = "", title = null) => el("button", { type: "button", class: cls, title, onclick: on }, label);
/** localStorage（带命名空间：演示是 demo:）；读写失败（隐私模式 / 满了）不报错 */
export function local(k, d, v) {
  const key = store.ns + k;
  try { if (v !== undefined) { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); return v; } const s = localStorage.getItem(key); return s == null ? d : JSON.parse(s); } catch { return d; }
}

// ============================================================ 存取：本地服务，或浏览器里的同样路由
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const err = (status, message) => Object.assign(new Error(message), { status, kind: "server", data: { message } });
export const KIND_LABEL = { like: "喜欢", dislike: "不喜欢", rule: "规则", fact: "事实" };
const guessKind = (t) => (/不喜欢|讨厌|受不了|不要|别/.test(t) ? "dislike" : /喜欢|偏爱|优先/.test(t) ? "like" : /以后|一律|总是|都要|每次/.test(t) ? "rule" : "fact");
const normText = (t) => String(t || "").replace(/[\s，。,.!！？?：:、]/g, "");
/** 服务不可用时的退路：/api/scenes 与 /api/memory 的同样语义，存在 localStorage */
export function localApi(method, path, body = {}) {
  const now = Date.now(), m = /^\/api\/(scenes|memory)(?:\/([^/?]+))?(?:\/(\w+))?/.exec(path) || [], [, kind, id, sub] = m;
  if (kind === "scenes") {
    const S = local("scenes", {}), meta = (s) => ({ id: s.id, name: s.name, created: s.created, updated: s.updated, thumb: s.thumb });
    const save = () => local("scenes", null, S);
    for (const s of Object.values(S)) if (s.deleted && now - s.deleted > 7 * 864e5) delete S[s.id];
    if (!id && method === "GET") return /trash=1/.test(path) ? Object.values(S).filter((s) => s.deleted).map((s) => Object.assign(meta(s), { deleted: s.deleted, purge_at: s.deleted + 7 * 864e5 })) : Object.values(S).filter((s) => !s.deleted).sort((a, b) => b.updated - a.updated).map(meta);
    if (!id && method === "POST") { const s = { id: newId("s"), name: body.name || `场景 ${Object.keys(S).length + 1}`, created: now, updated: now, data: body.data ?? null, thumb: body.thumb }; S[s.id] = s; save(); return meta(s); }
    // 服务暂时连不上时改服务上的场景（存当前场景 / 改名）：在浏览器里按同一个 id 记下，服务回来后补存过去
    if (!S[id] && method === "PUT" && !sub && store.storeDegraded) S[id] = { id, name: body.name || store.sceneName || "场景", created: now, updated: now, data: null };
    const s = S[id];
    if (!s || (s.deleted && sub !== "restore")) throw err(404, s ? "这个场景在回收站里" : "没有这个场景");
    if (method === "GET") return Object.assign(meta(s), { data: s.data });
    if (method === "DELETE") { s.deleted = now; save(); return { ok: true, id, trash_days: 7 }; }
    if (sub === "duplicate") { const c = Object.assign(clone(s), { id: newId("s"), name: `${s.name} 副本`, created: now, updated: now }); S[c.id] = c; save(); return meta(c); }
    if (sub === "restore") delete s.deleted; else for (const k of ["name", "data", "thumb"]) if (body[k] !== undefined) s[k] = body[k];
    s.updated = now; save(); return meta(s);
  }
  if (kind !== "memory") throw err(404, "没有这个接口");
  const M = local("memory", []), save = () => local("memory", null, M);
  if (!id && method === "GET") return M.slice().sort((a, b) => b.created - a.created);
  if (id === "clear") { const all = !body.scope || body.scope === "all", keep = M.filter((x) => !all && (x.scope !== body.scope || (body.scene_id && x.scene_id !== body.scene_id))); local("memory", null, keep); return { ok: true, removed: M.length - keep.length }; }
  if (!id && method === "POST") {
    const text = String(body.text || "").trim().slice(0, 80); if (text.length < 2) throw err(400, "太短了");
    const dup = M.find((x) => normText(x.text) === normText(text)); if (dup) { dup.enabled = true; save(); return Object.assign({}, dup, { duplicate: true }); }
    const it = { id: newId("m"), text, kind: KIND_LABEL[body.kind] ? body.kind : guessKind(text), scope: body.scope === "scene" ? "scene" : "global", source: body.source === "ai" ? "ai" : "you", enabled: body.enabled !== false, created: now, uses: 0 };
    if (it.scope === "scene") it.scene_id = body.scene_id; M.unshift(it); if (M.length > 200) M.length = 200; save(); return it;
  }
  const i = M.findIndex((x) => x.id === id); if (i < 0) throw err(404, "没有这条记忆");
  if (method === "DELETE") { M.splice(i, 1); save(); return { ok: true, id }; }
  for (const k of ["text", "kind", "enabled", "scope", "scene_id"]) if (body[k] !== undefined) M[i][k] = body[k];
  save(); return M[i];
}
/**
 * 场景 / 记忆的存取：本地服务；连不上（或超时）先重试一次，还不行才退回 localStorage 并提示一次。
 * 退回后每 15 s（以及每次存取前，至少隔 8 s）探一下 /api/health：通了就切回服务，把退回期间浏览器里加的记忆和当前场景补存过去。
 */
let probeAt = 0, probing = null;
export async function SC(method, path, body) {
  if (store.storeMode === "local" && store.storeDegraded) await probeBack();
  if (store.storeMode === "server") {
    for (let i = 0; ; i++) {
      try { return await call(method, path, body, { timeoutMs: 15000 }); }
      catch (e) {
        if (e.kind !== "offline" && e.kind !== "timeout") throw e;
        if (i === 0) { await new Promise((r) => setTimeout(r, 400)); continue; }
        store.storeMode = "local"; store.storeDegraded = true; store.degradedAt = Date.now(); probeAt = Date.now();
        A.sys("本地服务暂时连不上：场景和记忆先存在这个浏览器里；服务回来后自动切回去，并补存当前场景和这段时间记下的偏好。", false); renderScenes();
        break;
      }
    }
  }
  return localApi(method, path, body ? clone(body) : {});
}
/** 退回 localStorage 之后探服务；通了就切回 server 并补存（当前场景走正常的保存：服务上没有这个 id 就另存一个） */
export function probeBack({ force = false } = {}) {
  if (!store.storeDegraded) return Promise.resolve(false);
  if (probing) return probing;
  if (!force && Date.now() - probeAt < 8000) return Promise.resolve(false);
  probeAt = Date.now();
  probing = (async () => {
    try { await call("GET", "/api/health", null, { timeoutMs: 3000 }); } catch { return false; }
    const since = store.degradedAt || 0;
    store.storeMode = "server"; store.storeDegraded = false;
    // 这段时间在浏览器里存过 / 改过名的场景：按同一个 id 补存；服务上没有的（这段时间新建的）另存一个，当前场景跟着换 id
    for (const sc of Object.values(local("scenes", {})).filter((x) => x && !x.deleted && x.updated >= since)) {
      const body = { name: sc.name }; if (sc.data) body.data = sc.data; if (sc.thumb) body.thumb = sc.thumb;
      try { await call("PUT", `/api/scenes/${encodeURIComponent(sc.id)}`, body, { timeoutMs: 15000 }); }
      catch (e) {
        if (e.status !== 404 || !sc.data) { console.warn(e); continue; }
        try { const r = await call("POST", "/api/scenes", body, { timeoutMs: 15000 }); if (store.sceneId === sc.id) store.sceneId = r.id; } catch (e2) { console.warn(e2); }
      }
    }
    for (const m of local("memory", []).filter((x) => x && x.created >= since)) {
      try { await call("POST", "/api/memory", { text: m.text, kind: m.kind, scope: m.scope, scene_id: m.scene_id, source: m.source, enabled: m.enabled }, { timeoutMs: 15000 }); } catch (e) { console.warn(e); }
    }
    A.sys("本地服务回来了：场景和记忆接着存到服务上（这段时间的当前场景和记忆已经补存过去）。", false);
    if (store.plan || store.chat.length || store.cards) saveScene(); else refreshScenes();
    refreshMemory();
    return true;
  })().finally(() => { probing = null; });
  return probing;
}
// ============================================================ 场景：自动保存（1.5 s 防抖）/ 打开 / 新建 / 改名 / 复制 / 删除
let saveT = null, chain = Promise.resolve(), thumbFor = null, thumbData;
const isDefaultName = (n) => !n || /^场景 \d+$/.test(n);
/** 缩略图：小俯视图的 SVG（data:image/svg+xml;base64，> 380 KB 就不要了）；程序没变就用上次的 */
function thumb() {
  if (!store.plan || !store.sid) return undefined;
  if (thumbFor === store.sid) return thumbData;
  thumbFor = store.sid; thumbData = undefined;
  try {
    const svg = MapView.renderMap(A.ctx({ stratum: "ground", selected: null, diffs: [], section: null }), { small: true });
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const s = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
    if (s.length < 380000) thumbData = s;
  } catch (e) { console.warn(e); }
  return thumbData;
}
let dirtySince = 0;
/** 改了：1.5 s 没再改就存；一直在改也至少 10 s 存一次 */
export function markDirty() {
  if (!store.booted) return;
  const now = Date.now(); if (!saveT) dirtySince = now;
  clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; saveScene(); }, now - dirtySince > 10000 ? 0 : 1500);
}
/** 调 AI 之前：场景还没存过就先存一次（请求要带 scene_id，场景级记忆才用得上） */
export async function ensureScene() { if (!store.sceneId && store.booted) await flushSave(); }
export function saveScene() { chain = chain.then(doSave).catch((e) => console.warn("场景没存上", e)); return chain; }
export async function flushSave() { if (saveT) { clearTimeout(saveT); saveT = null; return saveScene(); } return chain; }
async function doSave() {
  if (!store.plan && !store.chat.length && !store.cards) return; // 空场景不存
  const body = { data: sceneData(), thumb: thumb() };
  if (isDefaultName(store.sceneName) && store.plan && store.plan.name) body.name = store.plan.name; // 还叫「场景 N」：用程序的名字
  const post = async () => { const r = await SC("POST", "/api/scenes", body); store.sceneId = r.id; store.sceneName = r.name; };
  try {
    if (!store.sceneId) await post();
    else { await SC("PUT", `/api/scenes/${encodeURIComponent(store.sceneId)}`, body); if (body.name) store.sceneName = body.name; }
  } catch (e) {
    if (e.status === 404) await post(); // 在别处被删进回收站了：另存成一个新场景
    else if (e.status === 413) { A.note("这个场景太大了，没存上（> 5 MB）：删掉些聊天或候选再试"); return; }
    else throw e;
  }
  store.savedAt = Date.now(); local("scene.last", null, store.sceneId);
  await refreshScenes();
}
export async function refreshScenes() { try { store.scenes = await SC("GET", "/api/scenes"); } catch (e) { console.warn(e); } renderScenes(); }
const busyNote = () => { if (store.busy) { A.note("AI 还在想，等它回来再换场景"); return true; } return false; };
export async function openScene(id) {
  if (busyNote()) return false;
  await flushSave();
  let r; try { r = await SC("GET", `/api/scenes/${encodeURIComponent(id)}`); } catch (e) { A.note(`没打开（${e.message}）`); await refreshScenes(); return false; }
  store.sceneId = r.id; store.sceneName = r.name; loadState(r.data || {});
  local("scene.last", null, r.id); renderScenes();
  return true;
}
export async function newScene() {
  if (busyNote()) return false;
  await flushSave();
  const r = await SC("POST", "/api/scenes", {});
  store.sceneId = r.id; store.sceneName = r.name; loadState({});
  local("scene.last", null, r.id); await refreshScenes();
  A.note(`新场景「${r.name}」：说一句你想要的`); $("#input").focus();
  return r.id;
}
export async function renameScene(id, name) {
  name = String(name || "").trim().slice(0, 40); if (!name) return false;
  await SC("PUT", `/api/scenes/${encodeURIComponent(id)}`, { name });
  if (id === store.sceneId) store.sceneName = name;
  await refreshScenes(); return true;
}
export async function dupScene(id) {
  if (id === store.sceneId) await flushSave();
  const r = await SC("POST", `/api/scenes/${encodeURIComponent(id)}/duplicate`, {});
  await refreshScenes(); A.note(`复制成「${r.name}」`); return r.id;
}
export async function delScene(id, { ask = true } = {}) {
  const s = store.scenes.find((x) => x.id === id), name = (s && s.name) || "这个场景";
  if (ask && !confirm(`删除「${name}」？会进回收站，7 天内可以恢复。`)) return false;
  if (id === store.sceneId) { clearTimeout(saveT); saveT = null; await chain; }
  await SC("DELETE", `/api/scenes/${encodeURIComponent(id)}`);
  if (id === store.sceneId) {
    store.sceneId = null; store.sceneName = ""; await refreshScenes();
    if (store.scenes.length) await openScene(store.scenes[0].id); else loadState({});
  } else await refreshScenes();
  A.note(`删了「${name}」（在回收站里放 7 天）`, { actions: [{ label: "恢复", fn: async () => { await SC("POST", `/api/scenes/${encodeURIComponent(id)}/restore`, {}); await refreshScenes(); A.note(`恢复了「${name}」`); } }] });
  return true;
}
const ago = (t) => { const s = (Date.now() - (t || 0)) / 1000, d = new Date(t || 0); return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
export function toggleBar(on = $("#scenes").hidden) {
  $("#scenes").hidden = !on; $("#btn-scenes").setAttribute("aria-pressed", String(!!on)); local("scene.bar", null, !!on);
  renderScenes();
}
/** 左侧场景栏：当前场景高亮；点一行 = 换过去；每行 改名 / 复制 / 删除 */
export function renderScenes() {
  const bar = $("#scenes"), nm = $("#btn-scenes .sc-cur");
  if (nm) nm.textContent = store.sceneName || "新场景";
  if (!bar || bar.hidden) return;
  const rename = (s, b) => {
    const inp = el("input", { class: "txt sc-edit", value: s.name, maxlength: 40 });
    const done = (ok) => { if (inp.dataset.done) return; inp.dataset.done = "1"; if (ok && inp.value.trim() && inp.value.trim() !== s.name) renameScene(s.id, inp.value); else renderScenes(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    inp.addEventListener("blur", () => done(true)); inp.addEventListener("click", (e) => e.stopPropagation());
    b.replaceWith(inp); inp.focus(); inp.select();
  };
  const rows = store.scenes.map((s) => {
    const name = el("b", { class: "sc-name" }, s.name);
    return el("div", { class: "sc-row" + (s.id === store.sceneId ? " on" : ""), "data-scene-id": s.id, title: s.id === store.sceneId ? "现在这个" : "换到这个场景", onclick: () => { if (s.id !== store.sceneId) openScene(s.id); } },
      s.thumb ? el("img", { class: "sc-thumb", src: s.thumb, alt: "" }) : el("div", { class: "sc-thumb empty" }, "空"),
      el("div", { class: "sc-meta" }, name, el("span", { class: "hint" }, ago(s.updated))),
      el("div", { class: "sc-acts" }, ...[["改名", () => rename(s, name)], ["复制", () => dupScene(s.id)], ["删除", () => delScene(s.id)]].map(([l, f]) => btn(l, (e) => { e.stopPropagation(); f(); }, "mini", l === "删除" ? "进回收站 7 天" : null))));
  });
  bar.replaceChildren(...[el("div", { class: "sc-head" }, el("b", {}, "场景"), el("span", { class: "spacer" }),
    btn("＋ 新场景", () => newScene(), "ubtn sm", "新开一个场景（聊天、程序、撤销都分开）"), btn("‹", () => toggleBar(false), "mini", "收起")),
  store.storeMode === "local" ? el("div", { class: "hint sc-local" }, store.storeDegraded ? "本地服务暂时连不上：先存在这个浏览器里，回来后自动切回" : "本地服务不可用（或演示）：存在这个浏览器里") : null,
  el("div", { class: "sc-list" }, rows.length ? rows : el("div", { class: "hint" }, "还没有存下的场景：说一句、挑一张，就会自动存"))].filter(Boolean));
}

// ============================================================ 记忆：面板、要不要记住、记住这个
export async function refreshMemory() { try { store.memory = await SC("GET", "/api/memory"); } catch (e) { console.warn(e); } renderMemBadge(); renderMemPanel(); }
export function renderMemBadge() { const b = $("#btn-memory"); if (b) { const n = store.memory.filter((m) => m.enabled).length; b.querySelector("i").textContent = n ? String(n) : ""; b.title = `跨场景的偏好：${n} 条启用（AI 每次调用都会带上）`; } }
export async function memAdd(text, { kind, scope = "global", source = "you" } = {}) {
  text = String(text || "").trim(); if (text.length < 2) return null;
  const body = { text: text.slice(0, 80), source, scope: scope === "scene" && store.sceneId ? "scene" : "global" };
  if (kind) body.kind = kind; if (body.scope === "scene") body.scene_id = store.sceneId;
  try { const it = await SC("POST", "/api/memory", body); await refreshMemory(); return it; } catch (e) { A.note(`没记住（${e.message}）`); return null; }
}
export async function memUpdate(id, patch) {
  if (patch.scope === "scene") { if (!store.sceneId) { A.note("这个场景还没存下来，先说一句或挑一张"); return null; } patch.scene_id = store.sceneId; }
  try { const it = await SC("PUT", `/api/memory/${encodeURIComponent(id)}`, patch); await refreshMemory(); return it; } catch (e) { A.note(`没改成（${e.message}）`); return null; }
}
export async function memDel(id) { try { await SC("DELETE", `/api/memory/${encodeURIComponent(id)}`); } catch (e) { A.note(`没删成（${e.message}）`); } await refreshMemory(); }
export async function memClear({ ask = true } = {}) {
  if (ask && !confirm(`清空全部 ${store.memory.length} 条记忆？清空后 AI 不再知道这些偏好（不能撤销）。`)) return false;
  await SC("POST", "/api/memory/clear", { scope: "all" }); await refreshMemory(); A.note("记忆清空了"); return true;
}
/** 聊天消息旁的「记住这个」 */
export async function memRemember(text, b) {
  const it = await memAdd(text, { source: "you" });
  if (it && b) { b.textContent = it.duplicate ? "已经记着了" : "记住了"; b.disabled = true; }
  if (it) A.note(`${it.duplicate ? "已经记着了" : "记住了"}：${it.text}（顶栏「记忆」里可以改 / 关掉）`);
}
/** AI 回包里的 memory_suggestions：「要记住吗：夜景优先 [记住] [不用]」（不进聊天记录） */
export function memSuggest(s) {
  if (!s || !s.text) return;
  const row = el("div", { class: "chiprow" },
    btn("记住", async (e) => { const b = e.currentTarget; b.closest(".msg").querySelectorAll("button").forEach((x) => { x.disabled = true; }); b.classList.add("on"); const it = await memAdd(s.text, { kind: s.kind, source: "ai" }); if (it) A.sys(`记住了：${it.text}`); }, "chip"),
    btn("不用", (e) => { e.currentTarget.closest(".msg").querySelectorAll("button").forEach((x) => { x.disabled = true; }); e.currentTarget.classList.add("on"); }, "chip"));
  A.msg("ai", `要记住吗：${s.text}（${KIND_LABEL[s.kind] || "偏好"}）`, row, { keep: false, mem: false }).classList.add("mem-suggest");
}
const memOpen = () => !$("#modal").hidden && $("#modal-card").dataset.panel === "memory";
export function openMemory() {
  A.note(null);
  $("#modal-card").dataset.panel = "memory"; $("#modal").hidden = false;
  renderMemPanel(true);
  refreshMemory();
}
function renderMemPanel(force) {
  if (!force && !memOpen()) return;
  const card = $("#modal-card"), M = store.memory, KO = Object.entries(KIND_LABEL);
  const add = el("input", { class: "txt mem-new", placeholder: "比如：夜景优先 / 不要撒小房子 / 路都铺石板", maxlength: 80 });
  const kindSel = el("select", { class: "ref" }, el("option", { value: "" }, "自动分类"), KO.map(([v, l]) => el("option", { value: v }, l)));
  const scopeSel = el("select", { class: "ref" }, el("option", { value: "global" }, "所有场景"), el("option", { value: "scene" }, "只这个场景"));
  const doAdd = async () => { const t = add.value.trim(); if (!t) return; const it = await memAdd(t, { kind: kindSel.value || undefined, scope: scopeSel.value }); if (it) add.value = ""; };
  add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
  const row = (m) => el("div", { class: "mem-row" + (m.enabled ? "" : " off"), "data-mem-id": m.id },
    el("input", { type: "checkbox", class: "mem-on", checked: !!m.enabled, title: m.enabled ? "关掉 = AI 不再看到这条" : "打开", onchange: (e) => memUpdate(m.id, { enabled: e.target.checked }) }),
    (() => { const s = el("select", { class: "ref mem-kind", onchange: (e) => memUpdate(m.id, { kind: e.target.value }) }, KO.map(([v, l]) => el("option", { value: v }, l))); s.value = m.kind; return s; })(),
    el("input", { class: "txt mem-text", value: m.text, maxlength: 80, onchange: (e) => { const v = e.target.value.trim(); if (v && v !== m.text) memUpdate(m.id, { text: v }); } }),
    el("span", { class: "hint mem-meta" }, `${m.source === "ai" ? "AI 建议的" : "你说的"} · ${m.scope === "scene" ? (m.scene_id === store.sceneId ? "只这个场景" : "只某个场景") : "所有场景"} · 用过 ${m.uses || 0} 次`),
    btn("×", () => memDel(m.id), "x", "删掉这条"));
  card.replaceChildren(el("h3", {}, "记忆 · 跨场景的偏好"),
    el("div", { class: "hint" }, "AI 每次调用（构思 / 展开 / 改动）都会带上启用的这些（最多 20 条）；你这句话说的优先于偏好。也可以直接在聊天里说「记住：…」「以后都…」「我不喜欢…」。"),
    el("div", { class: "mem-add" }, add, kindSel, scopeSel, btn("记住", doAdd, "ubtn primary")),
    el("div", { class: "mem-list" }, M.length ? M.map(row) : el("div", { class: "hint" }, "还没有记忆。")),
    el("div", { class: "actions" }, el("span", { class: "hint" }, `${M.filter((m) => m.enabled).length} / ${M.length} 条启用${store.storeMode === "local" ? " · 存在这个浏览器里" : ""}`), el("span", { class: "spacer" }),
      M.length ? btn("清空…", () => memClear(), "ubtn") : null, btn("关闭", () => { $("#modal").hidden = true; delete card.dataset.panel; }, "ubtn")));
}

// ============================================================ 启动：决定存哪儿、打开上次的场景
export async function initSessions({ demo, params }) {
  store.ns = demo ? "demo:" : "";
  store.storeMode = (demo && params.get("store") !== "server") || !store.ai ? "local" : "server";
  if (demo && store.storeMode === "local") { try { for (const k of Object.keys(localStorage)) if (k.startsWith("demo:")) localStorage.removeItem(k); } catch { /* 没有 localStorage */ } }
  if (!store.ai && !demo) A.sys("本地服务不可用：场景和记忆先存在这个浏览器里。", false);
  if (store.storeMode === "server") setInterval(() => { if (store.storeDegraded) probeBack(); }, 15000);
  $("#btn-scenes").addEventListener("click", () => toggleBar());
  $("#btn-memory").addEventListener("click", openMemory);
  new MutationObserver(() => { if ($("#modal").hidden) delete $("#modal-card").dataset.panel; }).observe($("#modal"), { attributes: true, attributeFilter: ["hidden"] });
  await Promise.all([refreshScenes(), refreshMemory()]);
  const last = !demo && local("scene.last", null), row = store.scenes.find((s) => s.id === last) || (!demo && store.scenes[0]);
  if (row) await openScene(row.id); else loadState({});
  store.booted = true;
  if (local("scene.bar", false) || demo === "scenes") toggleBar(true); else renderScenes();
}

// ---------- 演示（?demo=scenes / memory）：都在浏览器里的 demo: 前缀下（或 &store=server 时服务的临时数据目录），不调 AI
export async function demoScenes() {
  await A.loadExample("academy"); await flushSave(); await saveScene();
  const a = store.sceneId;
  await newScene(); await A.loadExample("harbor"); await saveScene();
  await openScene(a);
  toggleBar(true);
}
export async function demoMemory() {
  await memAdd("夜景优先", { kind: "like" }); await memAdd("不要撒小房子", { kind: "dislike" });
  openMemory();
}
