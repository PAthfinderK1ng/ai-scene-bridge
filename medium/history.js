// history.js — 撤销 / 重做（D21）。每次本地改动或 AI 改动之前记一份 scene.snapshotState()，上限 50 步。
import { S } from "./state.js";

const LIMIT = 50;
const undoStack = [], redoStack = [];
const take = (label) => ({ snap: S.scene.snapshotState(), userSet: [...S.userSet], label });
const put = (e) => { S.scene.restoreState(e.snap); S.userSet = new Set(e.userSet); };

/** 改之前调：返回一条待提交的记录（改失败时用它还原） */
export function record(label = "") { return S.scene ? take(label) : null; }
/** 改成功后调：入撤销栈，清空重做栈 */
export function commit(e) { if (!e) return; undoStack.push(e); if (undoStack.length > LIMIT) undoStack.shift(); redoStack.length = 0; }
/** 改失败时调：回到记录时的样子 */
export function rollback(e) { if (e && S.scene) put(e); }
/** 撤销一步，返回那一步的说明（没有可撤销的返回 null） */
export function undo() { const e = undoStack.pop(); if (!e || !S.scene) return null; redoStack.push(take(e.label)); put(e); return e.label; }
export function redo() { const e = redoStack.pop(); if (!e || !S.scene) return null; undoStack.push(take(e.label)); put(e); return e.label; }
export function clearHistory() { undoStack.length = 0; redoStack.length = 0; }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
