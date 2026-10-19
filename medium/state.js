// state.js — 全局状态 S 与跨模块的动作表 A（app.js 启动时填入）。各模块只在运行期读 A，不在加载时读，避免循环依赖。
export const $ = (s) => document.querySelector(s);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 本机浏览器里的小偏好（小窗位置 / 开关）：读写失败（隐私模式等）就用默认值，不影响功能 */
export function store(key, def, val) {
  try {
    if (arguments.length > 2) { localStorage.setItem(key, JSON.stringify(val)); return val; }
    const v = localStorage.getItem(key);
    return v == null ? def : JSON.parse(v);
  } catch { return def; }
}

export const S = {
  step: 1, intent: "", cards: [], resolved: [], axis: null, scene: null, comparing: false,
  locked: new Set(),   // 参数行的锁（锁住的不参与「换一批」，AI 的 patch 也不改）
  userSet: new Set(),  // 人动过的参数（没动过的带「默认」）
  tool: "move", view: "map", stratum: "ground", sel: null,
  insetOn: store("scene.inset.on", false), insetMin: store("scene.inset.min", false), // 3D 小窗：开 / 收成按钮（记在本机浏览器）
  board: "default", reference: null,
  meter: { point: 0, choose: 0, type: 0, coord: 0 }, // 内部计数（界面不显示）
  ai: null, mock: false, diffs: [], corrections: [], readback: null,
  busy: 0, pendingText: null, inflight: null, refreshing: false, checksExpanded: false,
  eye: {}, mapSvg: null, axisCursor: 0,
};

/** 由 app.js 填：edit / applyPatch / renderAll / renderViews / renderSide / note / hint / setTool / setView / setStratum / select / bump / ai / sys / openExport … */
export const A = {};
