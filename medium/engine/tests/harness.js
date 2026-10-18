// harness.js — 极简浏览器测试框架。结果写进 <pre id="out">，由 tools/run_browser_test.py 用无头 Edge 抓取。
// 用法：
//   import { test, run, assert, close } from "./harness.js";
//   test("名字", async () => { assert(1 + 1 === 2, "加法"); });
//   run();
const tests = [];
export function test(name, fn) { tests.push([name, fn]); }
export function assert(cond, msg = "assert failed") { if (!cond) throw new Error(msg); }
export function close(a, b, eps = 1e-6, msg = "") { if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg} expected ${b} ± ${eps}, got ${a}`); }
export function between(v, lo, hi, msg = "") { if (!(v >= lo && v <= hi)) throw new Error(`${msg} expected ${lo}..${hi}, got ${v}`); }
export async function run() {
  const out = document.getElementById("out") || document.body.appendChild(Object.assign(document.createElement("pre"), { id: "out" }));
  const lines = [];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; lines.push("PASS " + name); }
    catch (e) { fail++; lines.push("FAIL " + name + ": " + (e && e.stack ? e.stack.split("\n").slice(0, 2).join(" | ") : e)); }
  }
  lines.push(`DONE passed=${pass} failed=${fail}`);
  out.textContent = lines.join("\n");
}
window.addEventListener("error", (e) => { const out = document.getElementById("out"); if (out && !out.textContent.includes("DONE")) out.textContent += `\nFAIL (uncaught) ${e.message}\nDONE passed=0 failed=1`; });
