# -*- coding: utf-8 -*-
"""
plans.py — 构成图 plan 的 schema 与工具（不联网）

1. 路径与 plan schema（spec/plan.schema.json 是单一事实来源）+ 小校验器、夹取、清洗
2. plan 工具：按 id 找元素、ops 合法性检查与应用
本文件不依赖网络与模型；rules.py 与 ai.py 都用它。
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ============================================================ 1. 路径与 schema
def resource_root() -> str:
    """PyInstaller 打包后资源在 sys._MEIPASS；源码运行时是仓库根目录"""
    base = getattr(sys, "_MEIPASS", None)
    if base and os.path.isdir(os.path.join(base, "medium")):
        return base
    return ROOT


def data_dir() -> str:
    d = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ai-scene-bridge")
    os.makedirs(d, exist_ok=True)
    return d


def config_path() -> str:
    return os.path.join(data_dir(), "config.json")


def spec_path(*parts: str) -> str:
    return os.path.join(resource_root(), "spec", *parts)


_FILE_CACHE: dict = {}


def _load_json(path: str):
    """按 mtime 缓存：spec 改了立即生效，不用重启服务"""
    mt = os.stat(path).st_mtime
    hit = _FILE_CACHE.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    _FILE_CACHE[path] = (mt, data)
    return data


def plan_schema() -> dict:
    p = spec_path("plan.schema.json")
    if not os.path.isfile(p):
        raise RuntimeError("缺 spec/plan.schema.json")
    return _load_json(p)


def _clean_plan(p: dict) -> dict:
    return {k: v for k, v in p.items() if not str(k).startswith(("_", "$"))}


def example_plans() -> dict:
    """spec/examples/plans/*.plan.json → {文件名: plan}（去掉 _ / $ 开头的注释键）"""
    d = spec_path("examples", "plans")
    out = {}
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".plan.json"):
                data = _load_json(os.path.join(d, fn))
                out[fn[: -len(".plan.json")]] = _clean_plan(data.get("plan") if isinstance(data.get("plan"), dict) else data)
    return out


def _defs(root: dict) -> dict:
    return {**(root.get("definitions") or {}), **(root.get("$defs") or {})}


def deref(node: Any, root: dict) -> Any:
    """跟着 $ref（#/definitions/x、#/$defs/x）走到底"""
    n = 0
    while isinstance(node, dict) and "$ref" in node and n < 32:
        ref = node["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/"):
            return {}
        cur: Any = root
        for part in ref[2:].split("/"):
            cur = cur[part.replace("~1", "/").replace("~0", "~")]
        node, n = cur, n + 1
    return node


def _type_ok(t: str, v: Any) -> bool:
    return {
        "integer": lambda: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda: isinstance(v, (int, float)) and not isinstance(v, bool),
        "string": lambda: isinstance(v, str),
        "boolean": lambda: isinstance(v, bool),
        "array": lambda: isinstance(v, list),
        "object": lambda: isinstance(v, dict),
        "null": lambda: v is None,
    }.get(t, lambda: True)()


def _types(s: dict) -> list:
    t = s.get("type")
    return t if isinstance(t, list) else ([t] if t else [])


def validate(schema: Any, data: Any, path: str = "$", root: dict | None = None) -> list[str]:
    """违规清单（空 = 合法）。每条形如 "$.plans[0].site.size_m: 300 > maximum 240"。只认本项目用到的关键字。"""
    root = root if root is not None else schema
    s = deref(schema, root)
    if not isinstance(s, dict):
        return []
    errs: list[str] = []
    for key in ("anyOf", "oneOf"):
        if key in s:
            tries = [validate(b, data, path, root) for b in s[key]]
            if all(tries):
                best = min(tries, key=len)
                errs.append(f"{path}: 不符合任何一种写法" + (f"（最接近的一种：{best[0]}）" if best else ""))
            return errs
    for b in s.get("allOf", []):
        errs += validate(b, data, path, root)
    ts = _types(s)
    if ts and not any(_type_ok(t, data) for t in ts):
        return errs + [f"{path}: 类型应为 {'/'.join(ts)}，实际 {type(data).__name__}"]
    if "enum" in s and data not in s["enum"]:
        errs.append(f"{path}: {data!r} 不在 {s['enum']} 里")
    if "const" in s and data != s["const"]:
        errs.append(f"{path}: 应为 {s['const']!r}")
    if isinstance(data, dict):
        props = s.get("properties") or {}
        for k in s.get("required", []):
            if k not in data:
                errs.append(f"{path}: 缺少必填字段 {k}")
        ap = s.get("additionalProperties")
        for k, v in data.items():
            if k in props:
                errs += validate(props[k], v, f"{path}.{k}", root)
            elif str(k).startswith("_"):
                continue
            elif ap is False:
                errs.append(f"{path}: 多出字段 {k}")
            elif isinstance(ap, dict):
                errs += validate(ap, v, f"{path}.{k}", root)
    elif isinstance(data, list):
        if "minItems" in s and len(data) < s["minItems"]:
            errs.append(f"{path}: {len(data)} 项 < 至少 {s['minItems']} 项")
        if "maxItems" in s and len(data) > s["maxItems"]:
            errs.append(f"{path}: {len(data)} 项 > 至多 {s['maxItems']} 项")
        items, prefix = s.get("items"), s.get("prefixItems")
        if isinstance(prefix, list):
            for i, sub in enumerate(prefix[: len(data)]):
                errs += validate(sub, data[i], f"{path}[{i}]", root)
        elif isinstance(items, list):
            for i, sub in enumerate(items[: len(data)]):
                errs += validate(sub, data[i], f"{path}[{i}]", root)
        elif isinstance(items, dict):
            for i, v in enumerate(data):
                errs += validate(items, v, f"{path}[{i}]", root)
    elif isinstance(data, (int, float)) and not isinstance(data, bool):
        if "minimum" in s and data < s["minimum"]:
            errs.append(f"{path}: {data} < 最小 {s['minimum']}")
        if "maximum" in s and data > s["maximum"]:
            errs.append(f"{path}: {data} > 最大 {s['maximum']}")
        if "exclusiveMinimum" in s and data <= s["exclusiveMinimum"]:
            errs.append(f"{path}: {data} ≤ {s['exclusiveMinimum']}")
        if "exclusiveMaximum" in s and data >= s["exclusiveMaximum"]:
            errs.append(f"{path}: {data} ≥ {s['exclusiveMaximum']}")
    elif isinstance(data, str):
        if "pattern" in s and not re.search(s["pattern"], data):
            errs.append(f"{path}: {data!r} 不匹配 {s['pattern']}")
        if "minLength" in s and len(data) < s["minLength"]:
            errs.append(f"{path}: 长度 {len(data)} < {s['minLength']}")
        if "maxLength" in s and len(data) > s["maxLength"]:
            errs.append(f"{path}: 长度 {len(data)} > {s['maxLength']}")
    return errs


def _branch_for(s: dict, value: Any, root: dict) -> dict | None:
    """anyOf / oneOf 里挑一支来夹取 / 清洗：先找已经合法的，再找类型对得上且必填字段齐的唯一一支"""
    branches = [deref(b, root) for b in (s.get("anyOf") or s.get("oneOf") or [])]
    for b in branches:
        if not validate(b, value, "$", root):
            return b
    fit = [b for b in branches if isinstance(b, dict) and (not _types(b) or any(_type_ok(t, value) for t in _types(b)))]
    if isinstance(value, dict):
        fit = [b for b in fit if all(k in value for k in b.get("required", []))
               and all(value.get(k) == (deref(v, root) or {}).get("const", value.get(k)) for k, v in (b.get("properties") or {}).items() if k in value)]
    return fit[0] if len(fit) == 1 else None


def clamp(schema: Any, value: Any, path: str = "$", root: dict | None = None, fixes: list | None = None) -> Any:
    """返回夹取后的值（数值夹进范围、整数取整、超长文字截断、超长数组截断），改动记进 fixes。只碰这几类，不猜别的。"""
    root = root if root is not None else schema
    fixes = fixes if fixes is not None else []
    s = deref(schema, root)
    if not isinstance(s, dict):
        return value
    if "anyOf" in s or "oneOf" in s:
        b = _branch_for(s, value, root)
        return clamp(b, value, path, root, fixes) if b is not None else value
    ts = _types(s)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and ("number" in ts or "integer" in ts):
        v = value
        if "integer" in ts and "number" not in ts and isinstance(v, float):
            v = int(round(v))
        lo, hi = s.get("minimum"), s.get("maximum")
        if lo is not None and v < lo:
            v = lo
        if hi is not None and v > hi:
            v = hi
        if v != value or type(v) is not type(value):
            fixes.append(f"{path}: {value} → {v}")
        return v
    if isinstance(value, str) and "maxLength" in s and len(value) > s["maxLength"]:
        v = value[: s["maxLength"]]
        fixes.append(f"{path}: 截到 {s['maxLength']} 字")
        return v
    if isinstance(value, list):
        out = value
        if "maxItems" in s and len(value) > s["maxItems"]:
            out = value[: s["maxItems"]]
            fixes.append(f"{path}: {len(value)} 项 → {s['maxItems']} 项")
        items, prefix = s.get("items"), s.get("prefixItems")
        seq = prefix if isinstance(prefix, list) else items if isinstance(items, list) else None
        if seq is not None:
            return [clamp(seq[i], v, f"{path}[{i}]", root, fixes) if i < len(seq) else v for i, v in enumerate(out)]
        if isinstance(items, dict):
            return [clamp(items, v, f"{path}[{i}]", root, fixes) for i, v in enumerate(out)]
        return list(out)
    if isinstance(value, dict):
        props = s.get("properties") or {}
        return {k: (clamp(props[k], v, f"{path}.{k}", root, fixes) if k in props else v) for k, v in value.items()}
    return value


def strip_extra(schema: Any, data: Any, path: str = "$", root: dict | None = None) -> list[str]:
    """原地去掉 additionalProperties=false 下多出的字段、可选字段的 null。返回改动清单。"""
    root = root if root is not None else schema
    s = deref(schema, root)
    fixes: list[str] = []
    if not isinstance(s, dict):
        return fixes
    if "anyOf" in s or "oneOf" in s:
        b = _branch_for(s, data, root)
        return strip_extra(b, data, path, root) if b is not None else fixes
    if isinstance(data, dict) and (s.get("properties") or s.get("additionalProperties") is False):
        props, req = s.get("properties") or {}, set(s.get("required") or [])
        for k in list(data):
            if str(k).startswith("_"):
                continue
            if (s.get("additionalProperties") is False and k not in props) or (data[k] is None and k not in req):
                fixes.append(f"{path}.{k}: 去掉")
                del data[k]
            elif k in props:
                fixes += strip_extra(props[k], data[k], f"{path}.{k}", root)
    elif isinstance(data, list) and isinstance(s.get("items"), dict):
        for i, v in enumerate(data):
            fixes += strip_extra(s["items"], v, f"{path}[{i}]", root)
    return fixes


API_UNSUPPORTED = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "maxItems",
                   "default", "examples", "$schema", "$id", "$comment", "format", "uniqueItems", "minProperties", "maxProperties", "propertyNames", "prefixItems")


def api_schema(schema: dict) -> dict:
    """给 Claude 结构化输出的副本：剥掉不支持的约束（折进 description）与 x-* 提示；oneOf → anyOf；
    definitions → $defs；每个对象 additionalProperties=false。原 schema 不动，回来后本地校验 + 夹取。"""
    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        out: dict = {}
        dropped: dict = {}
        for k, v in node.items():
            if k.startswith("x-"):
                continue
            if k in API_UNSUPPORTED or (k == "minItems" and v not in (0, 1)):
                if k not in ("$schema", "$id", "$comment", "examples", "default"):
                    dropped[k] = v
            elif k in ("properties", "definitions", "$defs"):
                out["$defs" if k == "definitions" else k] = {name: walk(sub) for name, sub in v.items()}
            elif k == "$ref" and isinstance(v, str):
                out[k] = v.replace("#/definitions/", "#/$defs/")
            elif k == "oneOf":
                out["anyOf"] = walk(v)
            elif k in ("items", "anyOf", "allOf", "additionalProperties"):
                out[k] = walk(v)
            else:
                out[k] = copy.deepcopy(v)
        if out.get("type") == "object" or "properties" in out:
            out["additionalProperties"] = False
        if dropped:
            note = "{" + ", ".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in dropped.items()) + "}"
            out["description"] = (out["description"] + " " + note) if out.get("description") else note
        return out
    return walk(schema)


def has_key(node: Any, key: str) -> bool:
    if isinstance(node, dict):
        return key in node or any(has_key(v, key) for v in node.values())
    if isinstance(node, list):
        return any(has_key(v, key) for v in node)
    return False


def brief(root: dict) -> str:
    """把 plan schema 压成 TypeScript 风格的几行（给没有结构化输出的 DeepSeek 写进系统提示）：
    定义里被引用的类型只展开一次（At = {...}），各组一行，带范围与 x-ui 中文名。"""
    defs = _defs(root)
    used: list[str] = []

    def name_of(ref: str) -> str:
        return ref.rsplit("/", 1)[-1]

    def r(node: Any, depth: int = 0) -> str:
        if not isinstance(node, dict):
            return "any"
        if "$ref" in node:
            n = name_of(node["$ref"])
            if n in defs and n not in used:
                used.append(n)
            return n
        for key in ("anyOf", "oneOf"):
            if key in node:
                return " | ".join(r(b, depth) for b in node[key])
        if "const" in node:
            return json.dumps(node["const"], ensure_ascii=False)
        if "enum" in node:
            return "|".join(str(x) for x in node["enum"])
        ts = _types(node)
        t = ts[0] if ts else ("object" if "properties" in node else "")
        if t == "object":
            props, req = node.get("properties") or {}, set(node.get("required") or [])
            parts = []
            for k, sub in props.items():
                if k != "id" and isinstance(sub, dict) and (sub.get("x-ui") or {}).get("hidden"):
                    continue  # 人写的字段（locks / nudge_m / offset_m / layout_seed）不给 AI 看
                xu = (sub.get("x-ui") or {}) if isinstance(sub, dict) else {}
                ui = (xu.get("label") or "") + (("：" + xu["ai_hint"]) if xu.get("ai_hint") else "") or None
                parts.append(f"{k}{'' if k in req else '?'}: {r(sub, depth + 1)}" + (f" /*{ui}*/" if ui else ""))
            return "{" + ", ".join(parts) + "}"
        if t == "array":
            it = node.get("prefixItems") or node.get("items")
            inner = ("[" + ", ".join(r(x, depth + 1) for x in it) + "]") if isinstance(it, list) else (r(it, depth + 1) + "[]")
            lo, hi = node.get("minItems"), node.get("maxItems")
            if isinstance(it, dict) and it.get("type") in ("number", "integer") and lo is not None and lo == hi:
                inner = "[" + ", ".join([r(it)] * lo) + "]"
            elif lo is not None and lo == hi:
                inner += f"(恰好{lo}项)"
            elif lo or hi:
                inner += f"({lo or 0}–{hi if hi is not None else ''}项)"
            return inner
        if t in ("number", "integer"):
            rng = f" {node['minimum']}–{node['maximum']}" if "minimum" in node and "maximum" in node else ""
            return ("int" if t == "integer" else "num") + rng
        if t == "string":
            if node.get("pattern", "").startswith("^#"):
                return "\"#RRGGBB\""
            if node.get("pattern", "").startswith("^[a-z]"):
                return "小写英文短名(a-z0-9_)"
            return "str" + (f"≤{node['maxLength']}字" if "maxLength" in node else "")
        if t == "boolean":
            return "bool"
        return t or "any"

    lines = []
    req = set(root.get("required") or [])
    for k, sub in (root.get("properties") or {}).items():
        if isinstance(sub, dict) and (sub.get("x-ui") or {}).get("hidden"):
            continue
        lines.append(f"{k}{'' if k in req else '?'}: {r(sub)}")
    i = 0
    deflines = []
    while i < len(used):  # 展开过程中可能引用更多定义
        n = used[i]
        deflines.append(f"{n} = {r(defs[n])}")
        i += 1
    return "\n".join(["plan = {"] + ["  " + x for x in lines] + ["}"] + deflines)


# ============================================================ 2. plan 工具
LIST_GROUPS = ("terrain", "buildings", "zones", "landmarks", "paths", "water", "spaces", "relations")
ONE_GROUPS = ("site", "spawn", "lighting")
NO_SET_FIELDS = {"id", "locks", "nudge_m", "offset_m", "layout_seed"}  # 人写的（锁、拖过的微调、「换一个」）AI 不碰


def plan_props() -> dict:
    return plan_schema().get("properties") or {}


def item_schema(group: str) -> dict:
    """某一组单个元素的 schema（列表组取 items，单例组取本身）"""
    root = plan_schema()
    if group == "plan":
        return {k: v for k, v in root.items() if k not in ("definitions", "$defs")}
    s = deref(plan_props().get(group) or {}, root)
    if isinstance(s, dict) and (s.get("type") == "array" or "items" in s):
        return deref(s.get("items") or {}, root)
    return s if isinstance(s, dict) else {}


def field_schema(group: str, field: str) -> dict | None:
    """点路径（place.rel、size_m.0）在某组元素里的 schema；不存在返回 None"""
    root = plan_schema()
    s: Any = item_schema(group)
    for part in field.split("."):
        s = deref(s, root)
        if not isinstance(s, dict):
            return None
        if "anyOf" in s or "oneOf" in s:
            cand = [deref(b, root) for b in (s.get("anyOf") or s.get("oneOf"))]
            cand = [b for b in cand if isinstance(b, dict) and part in (b.get("properties") or {})]
            if not cand:
                return None
            s = cand[0]
        if part.isdigit() and (s.get("type") == "array" or "items" in s or "prefixItems" in s):
            seq = s.get("prefixItems") or s.get("items")
            s = seq[int(part)] if isinstance(seq, list) and int(part) < len(seq) else (seq if isinstance(seq, dict) else None)
            if s is None:
                return None
            continue
        props = s.get("properties") or {}
        if part not in props:
            return None
        s = props[part]
    return deref(s, root)


def index(plan: dict) -> dict:
    """id → (组, 元素)。单例组（site / spawn / lighting）用组名当 id；根上的 name / one_liner / mood / palette 用 id "plan"。"""
    out: dict = {"plan": ("plan", plan)}
    for g in ONE_GROUPS:
        if isinstance(plan.get(g), dict):
            out[g] = (g, plan[g])
    for g in LIST_GROUPS:
        for el in plan.get(g) or []:
            if isinstance(el, dict) and isinstance(el.get("id"), str):
                out.setdefault(el["id"], (g, el))
    return out


def new_id(plan: dict, base: str, taken: set | None = None) -> str:
    base = re.sub(r"[^a-z0-9_]", "_", (base or "item").lower()).strip("_") or "item"
    if not base[0].isalpha():
        base = "x_" + base
    used = set(index(plan)) | (taken or set()) | {"site", "spawn", "entry", "plan"}
    if base not in used:
        return base
    k = 2
    while f"{base}_{k}" in used:
        k += 1
    return f"{base}_{k}"


def _set_path(obj: dict, field: str, value: Any) -> None:
    parts = field.split(".")
    cur: Any = obj
    for i, part in enumerate(parts[:-1]):
        nxt_is_idx = parts[i + 1].isdigit()
        if isinstance(cur, list):
            cur = cur[int(part)]
            continue
        if not isinstance(cur.get(part), (dict, list)):
            cur[part] = [] if nxt_is_idx else {}
        cur = cur[part]
    last = parts[-1]
    if isinstance(cur, list):
        i = int(last)
        while len(cur) <= i:
            cur.append(None)
        cur[i] = value
    else:
        cur[last] = value


def apply_ops(plan: dict, ops: list) -> dict:
    """ops 应用到 plan 的副本（假定已经过 check_ops）。被删元素的引用不在这里处理：引擎 normalizePlan 会降级。"""
    p = copy.deepcopy(plan)
    for op in ops:
        kind = op.get("op")
        if kind == "set":
            hit = index(p).get(op.get("id"))
            if hit:
                _set_path(hit[1], op["field"], copy.deepcopy(op.get("value")))
        elif kind == "add":
            p.setdefault(op["group"], []).append(copy.deepcopy(op["value"]))
        elif kind == "remove":
            rid = str(op.get("id") or "")
            if rid.startswith("rel:") and rid[4:].isdigit():  # 关系没有 id，按序号删
                k = int(rid[4:])
                p["relations"] = [r for i, r in enumerate(p.get("relations") or []) if i != k]
                continue
            hit = index(p).get(rid)
            if hit and hit[0] in LIST_GROUPS:
                p[hit[0]] = [e for e in p[hit[0]] if e is not hit[1]]
                if rid in (p.get("locks") or []):
                    p["locks"] = [x for x in p["locks"] if x != rid]
    return p


def check_ops(plan: dict, ops: Any, locked_ids: set | None = None) -> tuple[list, list[str], list[str]]:
    """逐条检查 ops（docs/05 §5）：set 的字段必须是该元素 schema 里的、值要合 schema（越界夹回）；add 的值要合该组 schema、id 不重；
    remove 的 id 要存在。返回 (合法的 ops, 错误清单, 本地修正清单)。锁住的 id 一律不动。"""
    root = plan_schema()
    good: list = []
    errs: list[str] = []
    fixes: list[str] = []
    if not isinstance(ops, list):
        return [], ["ops 应为数组"], []
    cur = copy.deepcopy(plan)
    locked_ids = locked_ids or set()
    for i, op in enumerate(ops):
        where = f"ops[{i}]"
        if not isinstance(op, dict):
            errs.append(f"{where}: 应为对象")
            continue
        kind = op.get("op")
        idx = index(cur)
        if kind in ("set", "remove") and op.get("id") in locked_ids:
            fixes.append(f"{where}: {op.get('id')} 已锁住，不改")
            continue
        if kind == "set":
            tid, field = op.get("id"), op.get("field")
            if tid not in idx:
                errs.append(f"{where}: 没有 id 为 {tid!r} 的元素（可用：{', '.join(list(idx)[:30])}）")
                continue
            group = idx[tid][0]
            if not isinstance(field, str) or not re.fullmatch(r"[a-z_]+(\.[a-z_]+)*", field) or field.split(".")[-1] in NO_SET_FIELDS:
                errs.append(f"{where}: field 应为该元素的字段名（点分路径，不能改 id / locks / nudge_m / offset_m / layout_seed）")
                continue
            sub = field_schema(group, field)
            if sub is None:
                allowed = ", ".join((item_schema(group).get("properties") or {}).keys())
                errs.append(f"{where}: {group} 没有字段 {field!r}（可用：{allowed}）")
                continue
            f2: list = []
            val = clamp(sub, copy.deepcopy(op.get("value")), f"{where}.value", root, f2)
            e = validate(sub, val, f"{where}.value", root)
            if e:
                errs += e
                continue
            fixes += f2
            op = {**op, "value": val}
        elif kind == "add":
            group, val = op.get("group"), copy.deepcopy(op.get("value"))
            if group not in LIST_GROUPS or group not in plan_props():
                errs.append(f"{where}: group 应为 {'/'.join(g for g in LIST_GROUPS if g in plan_props())} 之一")
                continue
            if not isinstance(val, dict):
                errs.append(f"{where}: value 应为对象")
                continue
            sch = item_schema(group)
            if "id" in (sch.get("properties") or {}):
                if not isinstance(val.get("id"), str) or val["id"] in idx:
                    nid = new_id(cur, val.get("id") or group[:-1] if group.endswith("s") else group)
                    fixes.append(f"{where}: id {val.get('id')!r} → {nid}")
                    val["id"] = nid
            f2 = strip_extra(sch, val, f"{where}.value", root)
            val = clamp(sch, val, f"{where}.value", root, f2)
            e = validate(sch, val, f"{where}.value", root)
            if e:
                errs += e
                continue
            fixes += f2
            op = {"op": "add", "group": group, "value": val}
        elif kind == "remove":
            tid = op.get("id")
            if isinstance(tid, str) and tid.startswith("rel:"):
                k = tid[4:]
                if not (k.isdigit() and int(k) < len(cur.get("relations") or [])):
                    errs.append(f"{where}: 没有关系 {tid}（关系按 rel:<序号> 删，序号从 0 起）")
                    continue
                good.append({"op": "remove", "id": tid})
                cur = apply_ops(cur, [good[-1]])
                continue
            if tid not in idx or idx[tid][0] not in LIST_GROUPS:
                errs.append(f"{where}: 没有可删的 id {tid!r}")
                continue
            op = {"op": "remove", "id": tid}
        else:
            errs.append(f"{where}: op 应为 set / add / remove")
            continue
        good.append(op)
        cur = apply_ops(cur, [op])
    return good, errs, fixes


def _ui(group: str, field: str) -> dict:
    """某字段的 x-ui（中文名、枚举中文）；字段在 $ref 后面时取引用处与定义处合并的提示"""
    root = plan_schema()
    s: Any = item_schema(group)
    ui: dict = {}
    for part in field.split("."):
        s = deref(s, root)
        prop = ((s or {}).get("properties") or {}).get(part) if isinstance(s, dict) else None
        if not isinstance(prop, dict):
            return ui
        ui = {**((deref(prop, root) or {}).get("x-ui") or {}), **(prop.get("x-ui") or {})}
        s = prop
    return ui


def describe_ops(plan: dict, ops: list) -> str:
    """ops → 一句中文复述（模型没给复述、或模拟 AI 用）"""
    idx = index(plan)
    parts = []
    for op in ops:
        if op.get("op") == "add":
            v = op.get("value") or {}
            parts.append(f"加了{v.get('label') or v.get('id') or ''}")
        elif op.get("op") == "remove":
            el = idx.get(op.get("id"), (None, {}))[1]
            parts.append(f"去掉了{(el or {}).get('label') or op.get('id')}")
        elif op.get("op") == "set" and op.get("id") in idx:
            g, el = idx[op["id"]]
            ui = _ui(g, op.get("field", ""))
            val = op.get("value")
            vs = (ui.get("options") or {}).get(val, val) if isinstance(val, str) else val
            if isinstance(vs, (int, float)) and not isinstance(vs, bool):
                vs = f" {vs} {ui.get('unit') or ''}".rstrip()
            who = {"site": "场地", "lighting": "", "spawn": "出生点", "plan": ""}.get(g, el.get("label") or op["id"])
            parts.append(f"{who}{ui.get('label') or op.get('field')}改成{vs if not isinstance(vs, (dict, list)) else '新的'}")
    return "；".join(dict.fromkeys(parts))


def ref_warnings(plan: dict) -> list[str]:
    """引用了不存在的 id（引擎会降级到 site，这里只提一句）"""
    ids = set(index(plan)) | {"site", "spawn", "entry"}
    out: list[str] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if k in ("of", "target", "on", "under", "over", "from", "to", "look_at", "building", "a", "b", "c") and isinstance(v, str) and v not in ids:
                    out.append(f"{path}.{k} → {v}")
                elif k in ("via", "target") and isinstance(v, list):
                    out.extend(f"{path}.{k} → {x}" for x in v if isinstance(x, str) and x not in ids)
                elif isinstance(v, (dict, list)):
                    walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")
    for g in LIST_GROUPS + ONE_GROUPS:
        if g in plan:
            walk(plan[g], g)
    return out


def dedupe_ids(plan: dict) -> list[str]:
    """同一张 plan 里重复的 id 改名。建筑类型和别的元素撞名时改建筑类型那个（只有 zones[].building 指向它，跟着改；
    路的 via、空间的 connect.from、关系、地标的 place.target 都不会指向建筑类型，所以它们原本说的是另一个）。其余撞名改后出现的那个。"""
    reserved = {"site", "spawn", "entry"}
    others = reserved | {el["id"] for g in LIST_GROUPS if g != "buildings" for el in plan.get(g) or [] if isinstance(el, dict) and isinstance(el.get("id"), str)}
    fixes = []
    taken = set(others)
    for b in plan.get("buildings") or []:
        if not (isinstance(b, dict) and isinstance(b.get("id"), str)):
            continue
        old = b["id"]
        if old in taken:
            k = 2
            while f"{old}_{k}" in taken or any(isinstance(x, dict) and x.get("id") == f"{old}_{k}" for x in plan.get("buildings") or []):
                k += 1
            b["id"] = f"{old}_{k}"
            moved = 0
            if old in others:  # 和非建筑撞名：building 字段一定指的是这个建筑类型
                for z in plan.get("zones") or []:
                    if isinstance(z, dict) and z.get("building") == old:
                        z["building"] = b["id"]
                        moved += 1
            fixes.append(f"buildings.{old}: id 重复 → {b['id']}" + (f"（{moved} 个区域跟着改）" if moved else ""))
        taken.add(b["id"])
    seen: set = set(reserved)
    for g in LIST_GROUPS:
        if g == "buildings":
            continue
        for el in plan.get(g) or []:
            if isinstance(el, dict) and isinstance(el.get("id"), str):
                if el["id"] in seen:
                    k = 2
                    while f"{el['id']}_{k}" in seen:
                        k += 1
                    fixes.append(f"{g}.{el['id']}: id 重复 → {el['id']}_{k}")
                    el["id"] = f"{el['id']}_{k}"
                seen.add(el["id"])
    return fixes


# 放置关系的近义词（模型偶尔写枚举外的词）：本地换成枚举里的，省一次回喂
REL_SYNONYM = {
    "on": "top_of", "on_top": "top_of", "atop": "top_of", "top": "top_of", "upon": "top_of", "on_top_of": "top_of", "summit_of": "top_of",
    "near": "beside", "next_to": "beside", "by": "beside", "adjacent": "beside", "adjacent_to": "beside", "nearby": "beside", "close_to": "beside", "beside_of": "beside", "near_to": "beside",
    "in": "center_of", "inside": "center_of", "within": "center_of", "middle_of": "center_of", "center": "center_of", "centre_of": "center_of", "centre": "center_of", "in_center_of": "center_of", "at_center_of": "center_of", "on_center_of": "center_of",
    "edge": "edge_of", "at_edge_of": "edge_of", "on_edge_of": "edge_of", "rim_of": "edge_of", "side_of": "edge_of", "brink_of": "edge_of",
    "end": "end_of", "at_end_of": "end_of",
    "below": "under", "beneath": "under", "underneath": "under", "under_of": "under",
    "over": "above", "above_of": "above",
    "back_of": "behind", "behind_of": "behind",
    "alongside": "along", "following": "along", "along_side": "along",
    "entry": "at_entry", "entrance": "at_entry", "at_entrance": "at_entry", "at_gate": "at_entry",
}
REL_ACROSS = {"across", "across_of", "spanning", "span", "spans", "crossing", "cross", "over_water", "bridging"}


def fix_rels(node: Any, path: str = "$", fixes: list | None = None) -> list[str]:
    """place.rel 不在枚举里时按近义词换掉（across：两个目标 → between，一个 → center_of）。返回改了什么。"""
    fixes = [] if fixes is None else fixes
    ok = set(((_defs(plan_schema()).get("place") or {}).get("properties") or {}).get("rel", {}).get("enum") or [])
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "place" and isinstance(v, dict) and isinstance(v.get("rel"), str) and ok and v["rel"] not in ok:
                key = re.sub(r"[\s\-]+", "_", v["rel"].strip().lower())
                new = key if key in ok else ("between" if isinstance(v.get("target"), list) and len(v["target"]) == 2 else "center_of") if key in REL_ACROSS else REL_SYNONYM.get(key)
                if new == "between" and not (isinstance(v.get("target"), list) and len(v["target"]) == 2):
                    new = "center_of"
                if new in ok:
                    fixes.append(f"{path}.place.rel: {v['rel']} → {new}")
                    v["rel"] = new
            if isinstance(v, (dict, list)):
                fix_rels(v, f"{path}.{k}", fixes)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            fix_rels(v, f"{path}[{i}]", fixes)
    return fixes


def signature(plan: dict) -> dict:
    """构成签名：三张之间比的就是这些（地形组合 / 地标关系 / 空间布局 / 路 / 区域 / 出生方向）"""
    def place_of(x):
        pl = x.get("place") or {}
        return f"{x.get('form')}@{pl.get('rel')}"
    return {
        "terrain": tuple(sorted(t.get("type", "?") for t in plan.get("terrain") or [])),
        "landmarks": tuple(sorted(place_of(x) for x in plan.get("landmarks") or [])),
        "spaces": tuple(sorted(f"{s.get('stratum')}:{s.get('layout')}" for s in plan.get("spaces") or [])),
        "paths": tuple(sorted(p.get("style", "?") for p in plan.get("paths") or [])),
        "zones": tuple(sorted(z.get("use", "?") for z in plan.get("zones") or [])),
        "spawn": json.dumps(((plan.get("spawn") or {}).get("place") or {}), sort_keys=True),
    }


def diversity(plans: list) -> dict:
    """三张两两在几个构成维度上不同；min ≥ 2 算构成上真的不同"""
    sigs = [signature(p) for p in plans if isinstance(p, dict)]
    pairs = []
    for i in range(len(sigs)):
        for j in range(i + 1, len(sigs)):
            pairs.append(sum(sigs[i][k] != sigs[j][k] for k in sigs[i]))
    return {"pairwise": pairs, "min": min(pairs) if pairs else None, "dims": list(sigs[0]) if sigs else []}
