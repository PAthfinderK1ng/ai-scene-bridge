// panels.js — 右侧面板：选中对象、对象列表、场景与意图、调色板、关系、校验结果
import {
  find, collArray, allObjects, COLLS, COLL_LABEL, VOLUME_KINDS, REGION_KINDS, PATH_KINDS, MARKER_KINDS,
  FEATURE_KINDS, RELATION_TYPES, IMPORTANCE, TIMES, ORIENTED_MARKER_KINDS, renameId, removeById, uniqueId, slug, normDeg,
} from "./state.js";

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

// 每个输入框带一个稳定的 data-k（"区段:标签:序号"），重建 DOM 后用它把焦点放回去
let currentSection = "";
function row(label, ...inputs) {
  inputs.forEach((inp, i) => { if (inp && inp.setAttribute && !inp.dataset.k) inp.dataset.k = `${currentSection}:${label}:${i}`; });
  return el("div", { class: "row" }, el("label", {}, label), ...inputs);
}
const num = (value, onChange, step = 0.5, extra = {}) => el("input", Object.assign({ type: "number", step, value: value ?? "", onchange: (e) => onChange(parseFloat(e.target.value)) }, extra));
const text = (value, onChange, placeholder = "") => el("input", { type: "text", value: value ?? "", placeholder, onchange: (e) => onChange(e.target.value.trim()) });
const area = (value, onChange) => el("textarea", { onchange: (e) => onChange(e.target.value) }, value ?? "");
const btn = (label, onclick, cls = "") => el("button", { class: cls, type: "button", onclick }, label);
/** 下拉：value 不在列表里时也如实显示（标「不在列表」），不悄悄换成别的值 */
function sel(value, options, onChange, allowEmpty = false) {
  const s = el("select", { onchange: (e) => onChange(e.target.value) });
  if (allowEmpty) s.append(el("option", { value: "" }, "（无）"));
  for (const o of options) s.append(el("option", { value: o }, o));
  if (value && !options.includes(value)) s.append(el("option", { value }, `${value}（不在列表）`));
  s.value = value ? value : allowEmpty ? "" : options[0] ?? "";
  return s;
}

export class Panels {
  constructor(store) {
    this.store = store;
    this.$sel = $("#sec-selection .body");
    this.$objs = $("#sec-objects .body");
    this.$scene = $("#sec-scene .body");
    this.$pal = $("#sec-palette .body");
    this.$rel = $("#sec-relations .body");
    this.$val = $("#sec-validate .body");
    this._dirty = null;
    this._raf = 0;
    store.on("doc", () => this.schedule("all"));
    store.on("selection", () => this.schedule("sel"));
    this.renderAll();
  }
  get doc() { return this.store.doc; }
  mut(fn, label = "") { return this.store.mutate(fn, label); }
  roles() { return (this.doc.style.palette || []).map((p) => p.role).filter(Boolean); }
  ids() { return allObjects(this.doc).map(({ obj }) => obj.id); }

  /** 合并一帧内的多次重绘，并在重绘后把焦点放回原来的输入框（否则 Tab 切格时焦点会丢） */
  schedule(what) {
    this._dirty = this._dirty === "all" ? "all" : what;
    if (this._raf) return;
    // 宏任务即可（Tab 的焦点此时已落到下一格）；不用 rAF，后台 / 隐藏标签页里 rAF 不触发
    this._raf = setTimeout(() => {
      this._raf = 0;
      const w = this._dirty;
      this._dirty = null;
      const a = document.activeElement;
      const k = a && a.dataset ? a.dataset.k : null;
      const selStart = a && "selectionStart" in a ? a.selectionStart : null;
      const selEnd = a && "selectionEnd" in a ? a.selectionEnd : null;
      if (w === "all") this.renderAll();
      else { this.renderSelection(); this.renderObjects(); this.renderRelations(); }
      if (k) {
        const back = document.querySelector(`#panel [data-k="${CSS.escape(k)}"]`);
        if (back) {
          back.focus({ preventScroll: true });
          if (selStart !== null && selStart !== undefined) { try { back.setSelectionRange(selStart, selEnd); } catch { /* number/select 不支持 */ } }
        }
      }
    });
  }

  renderAll() {
    this.renderSelection();
    this.renderObjects();
    this.renderScene();
    this.renderPalette();
    this.renderRelations();
  }

  // ------------------------------------------------------------ 选中对象
  renderSelection() {
    currentSection = "sel";
    const box = this.$sel;
    box.replaceChildren();
    const id = this.store.selection;
    const f = id && find(this.doc, id);
    if (!f) { box.append(el("div", { class: "empty" }, "点击视口里的对象，或在「对象列表」里选一个。")); return; }
    const { coll, obj } = f;
    const set = (fn, label = "") => this.mut((doc) => { const g = find(doc, id); if (g) fn(g.obj, doc); }, label);
    const out = [el("div", { class: "hint" }, `${COLL_LABEL[coll]} · ${coll}`)];

    out.push(row("id", text(obj.id, (v) => {
      const nid = slug(v);
      if (!nid || nid === id) return this.schedule("sel");
      if (find(this.doc, nid)) { this.store.status(`id「${nid}」已存在`); return this.schedule("sel"); }
      this.mut((doc) => { const g = find(doc, id); renameId(doc, id, nid); g.obj.id = nid; }, `已重命名为 ${nid}`);
      this.store.select(nid);
    })));
    out.push(row("label", text(obj.label, (v) => set((o) => (o.label = v)), "给人看的名字")));

    if (coll === "volumes") {
      out.push(row("kind", sel(obj.kind, VOLUME_KINDS, (v) => set((o) => (o.kind = v)))));
      if (obj.shape === "custom") {
        const hint = this.doc.asset_hints[id] || {};
        out.push(row("shape", el("input", { type: "text", value: `custom（素材 ${hint.file || "未知"}）`, disabled: "" })));
        out.push(row("素材正面", sel(hint.front_axis || "+Z", ["+Z", "-Z"], (v) => set((o, doc) => { doc.asset_hints[id] = Object.assign({}, doc.asset_hints[id], { front_axis: v }); }))));
        out.push(el("div", { class: "hint" }, "glTF 规范模型正面朝 +Z，SID 的 0° 朝北(−Z)，默认已补偿 180°；若模型反了就切成 −Z。"));
      } else {
        out.push(row("shape", sel(obj.shape, ["box", "cylinder", "ramp"], (v) => set((o) => (o.shape = v)))));
      }
      out.push(row("位置 x y z", ...[0, 1, 2].map((i) => num(obj.position[i], (v) => set((o) => (o.position[i] = Number.isFinite(v) ? v : 0))))));
      out.push(row("尺寸 宽 高 深", ...[0, 1, 2].map((i) => num(obj.size[i], (v) => set((o) => (o.size[i] = Math.max(0.1, Number.isFinite(v) ? Math.abs(v) : 0.1)))))));
      out.push(row("rotation_y °", num(obj.rotation_y || 0, (v) => set((o) => (o.rotation_y = normDeg(Number.isFinite(v) ? v : 0))), 5)));
      out.push(row("color_role", sel(obj.color_role || "", this.roles(), (v) => set((o) => { if (v) o.color_role = v; else delete o.color_role; }), true)));
      out.push(row("importance", sel(obj.importance || "", IMPORTANCE, (v) => set((o) => { if (v) o.importance = v; else delete o.importance; }), true)));
      out.push(row("material_intent", text(obj.material_intent, (v) => set((o) => (o.material_intent = v)), "例如：木板墙 + 茅草顶")));
      const hint = this.doc.asset_hints[id] || {};
      out.push(row("资产检索词", text(hint.search, (v) => set((o, doc) => { doc.asset_hints[id] = Object.assign({}, doc.asset_hints[id], { search: v }); }), "medieval wooden cottage")));
      out.push(row("生成提示词", text(hint.generator_prompt, (v) => set((o, doc) => { doc.asset_hints[id] = Object.assign({}, doc.asset_hints[id], { generator_prompt: v }); }), "给 Meshy / Tripo 的英文提示")));
    } else if (coll === "markers") {
      out.push(row("kind", sel(obj.kind, MARKER_KINDS, (v) => set((o) => (o.kind = v)))));
      out.push(row("位置 x y z", ...[0, 1, 2].map((i) => num(obj.position[i], (v) => set((o) => (o.position[i] = Number.isFinite(v) ? v : 0))))));
      if (ORIENTED_MARKER_KINDS.includes(obj.kind) || "rotation_y" in obj) {
        out.push(row("rotation_y °", num(obj.rotation_y || 0, (v) => set((o) => (o.rotation_y = normDeg(Number.isFinite(v) ? v : 0))), 5)));
      }
    } else if (coll === "regions") {
      out.push(row("kind", sel(obj.kind, REGION_KINDS, (v) => set((o) => (o.kind = v)))));
      out.push(row("surface", sel(obj.surface || "", this.roles(), (v) => set((o) => { if (v) o.surface = v; else delete o.surface; }), true)));
      out.push(row("density 0–1", num(obj.density, (v) => set((o) => { if (Number.isFinite(v)) o.density = Math.min(1, Math.max(0, v)); else delete o.density; }), 0.1)));
      out.push(row("polygon", area(JSON.stringify(obj.polygon), (v) => this.parsePoints(v, 3, (pts) => set((o) => (o.polygon = pts))))));
      out.push(el("div", { class: "hint" }, "多边形顶点 [[x,z],…]，俯视顺序；拖动整体移动，形状在这里改数字。"));
    } else if (coll === "paths") {
      out.push(row("kind", sel(obj.kind, PATH_KINDS, (v) => set((o) => (o.kind = v)))));
      out.push(row("width m", num(obj.width, (v) => set((o) => (o.width = Math.max(0.1, Number.isFinite(v) ? v : 1))))));
      out.push(row("surface", sel(obj.surface || "", this.roles(), (v) => set((o) => { if (v) o.surface = v; else delete o.surface; }), true)));
      out.push(row("points", area(JSON.stringify(obj.points), (v) => this.parsePoints(v, 2, (pts) => set((o) => (o.points = pts))))));
      out.push(el("div", { class: "hint" }, "折线顶点 [[x,z],…]；拖动整体移动，加减点在这里改数字。"));
    } else if (coll === "features") {
      out.push(row("kind", sel(obj.kind, FEATURE_KINDS, (v) => set((o) => (o.kind = v)))));
      out.push(row("中心 x z", num(obj.center[0], (v) => set((o) => (o.center[0] = Number.isFinite(v) ? v : 0))), num(obj.center[2], (v) => set((o) => (o.center[2] = Number.isFinite(v) ? v : 0)))));
      out.push(row("radius m", num(obj.radius, (v) => set((o) => (o.radius = Math.max(0.5, Number.isFinite(v) ? v : 0.5))))));
      out.push(row("height m", num(obj.height, (v) => set((o) => (o.height = Number.isFinite(v) ? v : 0)))));
      out.push(el("div", { class: "hint" }, "高度为负表示凹陷（坑）。"));
    }
    out.push(row("notes", area(obj.notes, (v) => set((o) => (o.notes = v)))));

    const actions = el("div", { class: "actions" });
    if (coll === "volumes" || coll === "markers") {
      actions.append(btn("复制", () => {
        let nid;
        this.mut((doc) => {
          const g = find(doc, id);
          const copy = JSON.parse(JSON.stringify(g.obj));
          nid = uniqueId(doc, g.obj.id.replace(/_\d+$/, "") + "_1");
          copy.id = nid;
          copy.position = [copy.position[0] + 2, copy.position[1], copy.position[2] + 2];
          collArray(doc, coll).push(copy);
          if (doc.asset_hints[id]) doc.asset_hints[nid] = JSON.parse(JSON.stringify(doc.asset_hints[id])); // 共享同一个素材文件
        }, "已复制");
        this.store.select(nid);
      }));
    }
    actions.append(btn("删除", () => this.mut((doc) => removeById(doc, id), `已删除 ${id}`), "danger"));
    out.push(actions);
    box.append(...out);
  }

  parsePoints(txt, min, apply) {
    try {
      const pts = JSON.parse(txt);
      if (!Array.isArray(pts) || pts.length < min || !pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) throw new Error();
      apply(pts);
    } catch {
      this.store.status(`点列表格式应为 [[x,z],…]，至少 ${min} 个点`);
      this.schedule("sel");
    }
  }

  // ------------------------------------------------------------ 对象列表
  renderObjects() {
    const box = this.$objs;
    box.replaceChildren();
    const selId = this.store.selection;
    let any = false;
    for (const coll of COLLS) {
      const arr = collArray(this.doc, coll);
      if (!arr.length) continue;
      any = true;
      box.append(el("div", { class: "hint" }, `${COLL_LABEL[coll]} (${arr.length})`));
      const ul = el("ul", { class: "list" });
      for (const o of arr) {
        ul.append(el("li", { class: o.id === selId ? "selected" : "", onclick: () => this.store.select(o.id) },
          el("span", {}, o.id), el("span", { class: "kind" }, o.kind || ""), el("span", { class: "lab" }, o.label || "")));
      }
      box.append(ul);
    }
    if (!any) box.append(el("div", { class: "empty" }, "还没有对象。用工具栏添加，或点「示例」。"));
  }

  // ------------------------------------------------------------ 场景与意图
  renderScene() {
    currentSection = "scene";
    const d = this.doc;
    const box = this.$scene;
    box.replaceChildren();
    const set = (fn, label = "") => this.mut(fn, label);
    box.append(row("名称", text(d.meta.name, (v) => set((doc) => (doc.meta.name = v || "scene")))));
    box.append(row("一句话意图", area(d.intent.summary, (v) => set((doc) => (doc.intent.summary = v)))));
    box.append(row("情绪词", text((d.intent.mood || []).join(", "), (v) => set((doc) => (doc.intent.mood = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean))), "逗号分隔")));
    box.append(row("玩法", text(d.intent.gameplay, (v) => set((doc) => (doc.intent.gameplay = v)), "探索 / 战斗 / 叙事…")));
    box.append(row("玩家身高 m", num(d.meta.player_height, (v) => set((doc) => (doc.meta.player_height = Number.isFinite(v) && v > 0 ? v : 1.8)), 0.1)));
    box.append(row("网格 m", num(d.meta.grid, (v) => set((doc) => (doc.meta.grid = Number.isFinite(v) && v > 0 ? v : 0.5)), 0.25)));
    const bset = (arr, i) => (v) => set((doc) => (doc.bounds[arr][i] = Number.isFinite(v) ? v : doc.bounds[arr][i]), "已更新 bounds");
    box.append(row("bounds min x z", num(d.bounds.min[0], bset("min", 0), 5), num(d.bounds.min[2], bset("min", 2), 5)));
    box.append(row("bounds max x z", num(d.bounds.max[0], bset("max", 0), 5), num(d.bounds.max[2], bset("max", 2), 5)));
    box.append(row("bounds 高 y", num(d.bounds.max[1], bset("max", 1), 5)));
    const L = d.style.lighting;
    box.append(row("时段", sel(L.time_of_day || "noon", TIMES, (v) => set((doc) => (doc.style.lighting.time_of_day = v)))));
    box.append(row("太阳方位 / 高度",
      num(L.sun_azimuth_deg ?? 200, (v) => set((doc) => (doc.style.lighting.sun_azimuth_deg = Number.isFinite(v) ? normDeg(v) : 200)), 5, { min: 0, max: 360 }),
      num(L.sun_elevation_deg ?? 45, (v) => set((doc) => (doc.style.lighting.sun_elevation_deg = Number.isFinite(v) ? Math.min(90, Math.max(-10, v)) : 45)), 5, { min: -10, max: 90 })));
    box.append(el("div", { class: "hint" }, "方位从北顺时针 0–360°，高度 −10–90°。参考图：图片放进导出包的 refs/，这里只记路径与说明"));
    (d.style.references || []).forEach((ref, i) => {
      box.append(row(`参考 ${i + 1}`,
        text(ref.path, (v) => set((doc) => (doc.style.references[i].path = v)), "refs/xxx.jpg"),
        text(ref.note, (v) => set((doc) => (doc.style.references[i].note = v)), "说明"),
        btn("×", () => set((doc) => doc.style.references.splice(i, 1)))));
    });
    box.append(el("div", { class: "actions" }, btn("+ 参考图", () => set((doc) => { (doc.style.references ||= []).push({ path: "", note: "" }); }))));
  }

  // ------------------------------------------------------------ 调色板
  renderPalette() {
    currentSection = "pal";
    const box = this.$pal;
    box.replaceChildren();
    const pal = this.doc.style.palette;
    const refs = (role) => {
      let n = 0;
      for (const v of this.doc.volumes) if (v.color_role === role) n++;
      for (const r of this.doc.regions) if (r.surface === role) n++;
      for (const p of this.doc.paths) if (p.surface === role) n++;
      return n;
    };
    pal.forEach((p, i) => {
      box.append(el("div", { class: "row" },
        el("input", { type: "color", "data-k": `pal:color:${i}`, value: /^#[0-9a-f]{6}$/i.test(p.hex || "") ? p.hex : "#888888", onchange: (e) => this.mut((doc) => (doc.style.palette[i].hex = e.target.value.toUpperCase())) }),
        text(p.role, (v) => {
          const nr = slug(v, "role");
          this.mut((doc) => {
            const old = doc.style.palette[i].role;
            doc.style.palette[i].role = nr;
            // 引用它的 color_role / surface 一起改名
            for (const vol of doc.volumes) if (vol.color_role === old) vol.color_role = nr;
            for (const r of doc.regions) if (r.surface === old) r.surface = nr;
            for (const pa of doc.paths) if (pa.surface === old) pa.surface = nr;
          }, `角色 ${p.role} → ${nr}`);
        }, "role"),
        text(p.note, (v) => this.mut((doc) => (doc.style.palette[i].note = v)), "说明"),
        btn("×", () => {
          const n = refs(p.role);
          if (n && !confirm(`「${p.role}」还被 ${n} 个对象引用，删除后它们会显示为「不在列表」。确定删除？`)) return;
          this.mut((doc) => doc.style.palette.splice(i, 1));
        })));
    });
    box.append(el("div", { class: "hint" }, "role 被体块的 color_role、区域 / 路径的 surface 引用；改名会同步引用。"));
    box.append(el("div", { class: "actions" }, btn("+ 颜色", () => this.mut((doc) => doc.style.palette.push({ role: "role_" + (doc.style.palette.length + 1), hex: "#888888", note: "" })))));
  }

  // ------------------------------------------------------------ 关系
  renderRelations() {
    const box = this.$rel;
    box.replaceChildren();
    const rels = this.doc.relations;
    const ids = this.ids();
    if (!rels.length) box.append(el("div", { class: "empty" }, "还没有关系。关系是给 AI 看的：谁朝着谁、谁挨着谁、从哪能看到什么。"));
    rels.forEach((r, i) => box.append(el("div", { class: "row" }, el("span", { style: "flex:1" }, `${r.type}(${r.a} → ${r.b})`), btn("×", () => this.mut((doc) => doc.relations.splice(i, 1))))));
    if (ids.length >= 2) {
      const cur = this.store.selection && ids.includes(this.store.selection) ? this.store.selection : ids[0];
      const t = sel("faces", RELATION_TYPES, () => {});
      const a = sel(cur, ids, () => {});
      const b = sel(ids.find((x) => x !== cur) || ids[0], ids, () => {});
      box.append(el("div", { class: "row" }, t, a, b, btn("添加", () => {
        if (a.value === b.value) return this.store.status("a 和 b 不能相同");
        this.mut((doc) => doc.relations.push({ type: t.value, a: a.value, b: b.value }), "已添加关系");
      })));
    }
  }

  // ------------------------------------------------------------ 校验
  renderValidation(msgs) {
    const box = this.$val;
    box.replaceChildren();
    for (const m of msgs) {
      box.append(el("div", { class: `msg ${m.level}`, onclick: () => m.id && this.store.select(m.id) }, m.msg));
    }
  }
}
