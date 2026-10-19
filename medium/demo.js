// demo.js — 演示 / 截图模式：?demo=cards|pick|edit|drag|section|strata|export[&view=map|profile|eye|three]。
// 一律走模拟 AI（app.js 里 S.mock = true），尽量走和人一样的路径：点按钮、在俯视图上发真实的 pointer 事件拖。
import { S, A, $ } from "./state.js";
import { msg } from "./chat.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORDER = ["cards", "pick", "edit", "drag", "section", "strata", "export"];
const until = (fn, ms = 4000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v) res(v); else if (Date.now() - t0 > ms) rej(new Error("等不到界面就绪")); else setTimeout(tick, 30); }; tick(); });

/** 世界坐标 [x,z] → 屏幕坐标 */
function toClient(svg, p) { const pt = svg.createSVGPoint(); pt.x = p[0]; pt.y = p[1]; const q = pt.matrixTransform(svg.getScreenCTM()); return [q.x, q.y]; }
/** 在俯视图上把 node 从 from 拖到 to（世界坐标），发真实的 pointerdown / move / up */
async function dragOnMap(node, from, to) {
  const svg = S.mapSvg, a = toClient(svg, from), b = toClient(svg, to);
  const ev = (c) => ({ bubbles: true, cancelable: true, clientX: c[0], clientY: c[1], pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" });
  node.dispatchEvent(new PointerEvent("pointerdown", ev(a)));
  for (let k = 1; k <= 6; k++) svg.dispatchEvent(new PointerEvent("pointermove", ev([a[0] + ((b[0] - a[0]) * k) / 6, a[1] + ((b[1] - a[1]) * k) / 6])));
  svg.dispatchEvent(new PointerEvent("pointerup", ev(b)));
  await sleep(40);
}
const posOf = (n) => n.getAttribute("data-pos").split(" ").map(Number);
const click = (sel, text) => { const b = [...document.querySelectorAll(sel)].find((x) => !text || x.textContent.trim().startsWith(text)); if (!b) throw new Error(`找不到按钮 ${text || sel}`); b.click(); return b; };

/** 点参数面板某一行的某一档 */
function clickParam(label, opt) {
  const row = [...document.querySelectorAll("#params .prow")].find((r) => r.querySelector(".pl").textContent === label);
  const b = row && [...row.querySelectorAll(".seg button")].find((x) => x.textContent === opt);
  if (!b) throw new Error(`参数里找不到 ${label} ${opt}`);
  if (!b.classList.contains("on")) b.click();
}

export async function runDemo(stage, params) {
  const upto = ORDER.indexOf(stage);
  if (upto < 0) return;
  // 说
  msg("user", "我要生成山城村庄"); A.bump("type");
  await A.intent("我要生成山城村庄");
  if (upto >= 1) { (await until(() => document.querySelector(".cmp"))).click(); await sleep(30); }          // 选：点第一张大图
  if (upto >= 2) {                                                                                            // 改：参数点两下，选中一栋房子
    clickParam("层数", "6");
    clickParam("时段", "清晨");
    const h = S.scene.sid.volumes.find((v) => v.kind === "building" && v.importance !== "landmark");
    if (h) A.select({ type: "house", id: h.id });
    await sleep(30);
  }
  if (upto >= 3) {                                                                                            // 拖一栋房子、拖主路折点
    A.setView("map"); await sleep(30);
    const hs = [...S.mapSvg.querySelectorAll("[data-house]")];
    const house = hs[Math.floor(hs.length / 2)];
    if (house) { const p = posOf(house); await dragOnMap(house, p, [p[0] + 8, p[1] + 5]); }
    const v = S.mapSvg.querySelector('[data-trail-vertex="1"]');
    if (v) { const p = posOf(v); await dragOnMap(v, p, [p[0] + 6, p[1] - 4]); }
  }
  if (upto >= 4) {                                                                                            // 剖面：第 3 层拖高 2 m；切直线并转 30°
    A.setView("profile"); await sleep(30);
    const f = (S.scene.sid.terrain.features || []).find((x) => x.kind === "plateau" && x.level === 2);
    if (f) A.profileHandlers.onTerraceHeight(f.id, f.height + 2);
    await sleep(30);
    click("#view-profile .seg-line"); await sleep(30);
    click("#view-profile .sec-rot-l"); await sleep(30);
    click("#view-profile .sec-rot-l"); await sleep(30);
  }
  if (upto >= 5) {                                                                                            // 加一个地下溶洞、一个空中平台，开 3D 小窗
    click("#strata button.add", "＋地下空间"); await sleep(30);
    click("#strata button.add", "＋空中平台"); await sleep(30);
    const cave = (S.scene.sid.spaces || []).find((x) => x.stratum === "underground");
    A.setView("map"); if (cave) A.select({ type: "space", id: cave.id }, "underground"); else A.setStratum("underground");
    if (!S.insetOn) $("#btn-inset").click();
    await sleep(50);
  }
  if (upto >= 6) { $("#btn-export").click(); await sleep(30); }
  const view = params.get("view");
  if (view) A.setView(view);
}
