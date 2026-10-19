# -*- coding: utf-8 -*-
"""
plans.py — 场景程序 plan v2 的 schema 与工具（不联网）

1. 路径与 plan schema（spec/plan.schema.json 是单一事实来源）+ 小校验器、夹取、清洗、给 Claude 的 schema、给模型的语法表（grammar）
2. 场景程序工具：场景树遍历、按 id / 实例引用找元素、ops（set 嵌套路径 / add 到 nodes·terrain·group / remove）检查与应用、
   根节点锚点规则、形体计数与上限
本文件不依赖网络与模型；rules.py 与 ai.py 都用它。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from typing import Any

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
    """数据目录：%LOCALAPPDATA%/ai-scene-bridge（配置、场景、记忆、导出、日志）；环境变量 SCENE_DIALOG_DATA_DIR 整个换掉它（测试用，不碰真实数据与密钥）"""
    d = os.environ.get("SCENE_DIALOG_DATA_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "ai-scene-bridge")
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


# ============================================================ 2. 场景程序工具（v2：terrain[] 雕刻 + nodes[] 场景树）
ROOT_LISTS = ("terrain", "nodes", "relations")
ONE_GROUPS = ("site", "spawn", "lighting")
LIST_GROUPS = ROOT_LISTS  # 旧名（外部脚本还在用）
AI_FORBIDDEN = {"locks", "layout_seed", "one_liner", "skip", "overrides", "marks"}  # 人写的（锁、「换一个」的种子、人画的标记）、旧字段、实例改动（ops 写）：不给 AI 写
NO_SET_FIELDS = {"id", "locks", "layout_seed", "skip", "overrides"}  # set 不能直接碰（实例改动用 id[k]）
CHILD_LISTS = ("children",)
CHILD_ONE = ("child",)
REF_KEYS = ("at", "under", "over", "from", "to", "along", "area", "around", "look_at", "a", "b", "c", "target")
REF_ONLY = ("under", "over", "around", "along", "area", "look_at", "a", "b", "c")  # 这些字段是 ref（id / id[k] / site / spawn），不能带 .部位
REF_LIST_KEYS = ("via",)
ANCHOR = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(\[\d+\])?(\.[A-Za-z_]+)?$")
RESERVED_IDS = {"site", "spawn", "plan", "entry", "root", "terrain", "relations", "lighting"}
INSTANCE = re.compile(r"^([a-z][a-z0-9_]*)\[(\d{1,3})\]$")
MAX_SHAPES = 600


def plan_props() -> dict:
    return plan_schema().get("properties") or {}


def _pick(s: Any, value: Any, root: dict) -> Any:
    """anyOf / oneOf 里按 value.type（或 op）挑一支；挑不出来就原样返回"""
    s = deref(s, root)
    if not isinstance(s, dict) or not ("anyOf" in s or "oneOf" in s):
        return s
    if isinstance(value, dict):
        for key in ("type", "op"):
            t = value.get(key)
            if t is None:
                continue
            for b in s.get("anyOf") or s.get("oneOf"):
                b = deref(b, root)
                ts = deref(((b or {}).get("properties") or {}).get(key) or {}, root)
                if isinstance(ts, dict) and (ts.get("const") == t or t in (ts.get("enum") or [])):
                    return _pick(b, value, root)
    b = _branch_for(s, value, root)
    return _pick(b, value, root) if b is not None else s


def item_schema(group: str, value: Any = None) -> dict:
    """某一组单个元素的 schema（列表组取 items，单例组取本身；有分支时按 value.type / op 挑）。group="node" = 场景树节点。"""
    root = plan_schema()
    if group == "plan":
        return {k: v for k, v in root.items() if k not in ("definitions", "$defs")}
    if group == "node":
        s = deref((plan_props().get("nodes") or {}), root)
        s = s.get("items") if isinstance(s, dict) else None
        s = s or _defs(root).get("node") or {}
    else:
        s = deref(plan_props().get(group) or {}, root)
        if isinstance(s, dict) and (s.get("type") == "array" or "items" in s):
            s = s.get("items") or {}
    s = _pick(s, value if value is not None else {}, root)
    return s if isinstance(s, dict) else {}


def node_types() -> list[str]:
    """节点 type 的全部取值（从 schema 读：单一 node 定义的 type.enum，或各分支的 const / enum）"""
    root = plan_schema()
    s = deref((deref(plan_props().get("nodes") or {}, root) or {}).get("items") or _defs(root).get("node") or {}, root)
    out: list = []

    def take(b):
        b = deref(b, root)
        if not isinstance(b, dict):
            return
        if "anyOf" in b or "oneOf" in b:
            for x in b.get("anyOf") or b.get("oneOf"):
                take(x)
            return
        t = deref(((b.get("properties") or {}).get("type")) or {}, root)
        for v in ([t.get("const")] if "const" in t else []) + list(t.get("enum") or []):
            if v not in out:
                out.append(v)
    take(s)
    return out


def field_schema_in(s: Any, field: str, value: Any = None) -> dict | None:
    """点路径（size_m.0、connect.via、children.2.label）在某个元素 schema 里的子 schema；不存在返回 None"""
    root = plan_schema()
    cur_v = value
    for part in field.split("."):
        s = _pick(s, cur_v, root)
        if not isinstance(s, dict):
            return None
        if part.isdigit():
            seq = s.get("prefixItems") or s.get("items")
            s = seq[int(part)] if isinstance(seq, list) and int(part) < len(seq) else (seq if isinstance(seq, dict) else None)
            cur_v = cur_v[int(part)] if isinstance(cur_v, list) and int(part) < len(cur_v) else None
            if s is None:
                return None
            continue
        props = s.get("properties") or {}
        if part not in props:
            return None
        s = props[part]
        cur_v = cur_v.get(part) if isinstance(cur_v, dict) else None
    return _pick(s, cur_v, root)


def field_schema(group: str, field: str, value: Any = None) -> dict | None:
    return field_schema_in(item_schema(group, value), field, value)


def to_ref(v: Any) -> Any:
    """锚点 → ref：「site.N」→ site，「hall.top」→ hall，「towers[2].S」→ towers[2]"""
    if not isinstance(v, str):
        return v
    m = ANCHOR.match(v.strip())
    if not m:
        return v
    return m.group(1) + (m.group(2) or "")


ANCHOR_PARTS = ("top", "bottom", "center", "C", "N", "NE", "E", "SE", "S", "SW", "W", "NW", "inner", "outer", "start", "mid", "end", "left", "right")
_SUB_RE = re.compile(r"^([a-z][a-z0-9_]{0,31}(?:\[\d{1,3}\])?)\.([A-Za-z][A-Za-z0-9_]{0,31}(?:\[\d{1,3}\])?)(?:\.([A-Za-z]+))?$")
_ANCHOR_FIELDS = ("at", "from", "to", "under", "over", "around", "along", "area", "look_at", "a", "b", "c")


def fix_sub_anchors(plan: dict, fixes: list | None = None) -> list[str]:
    """「组.子节点」式的锚点（'axis.obelisk'、'core.hall.top'）：子节点的 id 全树唯一，直接写它自己 → 'obelisk' / 'hall.top'。
    实测 DeepSeek 常这样写（以为要带组名），以前被当成「去掉不认识的部位」改成了组本身，锚错了地方。"""
    fixes = [] if fixes is None else fixes
    ids = {t["id"] for t in plan.get("terrain") or [] if isinstance(t, dict) and isinstance(t.get("id"), str)}
    ids |= {n["id"] for n in all_nodes(plan) if isinstance(n.get("id"), str)}

    def fix(v: str) -> str | None:
        m = _SUB_RE.match(v)
        if not m or m.group(2) in ANCHOR_PARTS:
            return None
        sub = m.group(2)
        if re.sub(r"\[\d+\]$", "", sub) not in ids:
            return None
        return sub + (f".{m.group(3)}" if m.group(3) and m.group(3) in ANCHOR_PARTS else "")

    def walk(d: Any, path: str) -> None:
        if isinstance(d, list):
            for i, x in enumerate(d):
                if isinstance(x, str) and path.endswith(".via"):
                    new = fix(x)
                    if new:
                        fixes.append(f"{path}[{i}]: {x!r} → {new!r}（子节点直接写自己的 id）")
                        d[i] = new
                else:
                    walk(x, f"{path}[{i}]")
            return
        if not isinstance(d, dict):
            return
        for k, v in d.items():
            if isinstance(v, str) and k in _ANCHOR_FIELDS:
                new = fix(v)
                if new:
                    fixes.append(f"{path}.{k}: {v!r} → {new!r}（子节点直接写自己的 id）")
                    d[k] = new
            elif isinstance(v, (dict, list)):
                walk(v, f"{path}.{k}")
    for key in ("terrain", "nodes", "relations", "spawn"):
        walk(plan.get(key), f"$.{key}")
    return fixes


def normalize_refs(plan: dict, fixes: list | None = None) -> list[str]:
    """只收 ref 的字段（under / over / around / along / area / look_at / 关系的 a b c / connect.from）写成了带部位的锚点 → 去掉部位"""
    fixes = [] if fixes is None else fixes

    def fix(d: dict, keys, path: str) -> None:
        for k in keys:
            v = d.get(k)
            if isinstance(v, str) and to_ref(v) != v:
                fixes.append(f"{path}.{k}: {v} → {to_ref(v)}")
                d[k] = to_ref(v)
    for n, path, *_ in walk_nodes(plan.get("nodes") or []):
        fix(n, REF_ONLY, path)
        if isinstance(n.get("connect"), dict):
            fix(n["connect"], ("from",), path + ".connect")
    for i, r in enumerate(plan.get("relations") or []):
        if isinstance(r, dict):
            fix(r, ("a", "b", "c"), f"relations[{i}]")
    if isinstance(plan.get("spawn"), dict):
        fix(plan["spawn"], ("look_at",), "spawn")
    return fixes


def walk_nodes(nodes: Any, path: str = "nodes", parent: dict | None = None):
    """场景树深度优先：(节点, 路径, 父节点, 所在列表或 None)。children 是列表，child / template 是单个子节点。"""
    if not isinstance(nodes, list):
        return
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            continue
        yield n, f"{path}[{i}]", parent, nodes
        yield from _walk_inner(n, f"{path}[{i}]")


def _walk_inner(n: dict, path: str):
    for k in CHILD_LISTS:
        if isinstance(n.get(k), list):
            yield from walk_nodes(n[k], f"{path}.{k}", n)
    for k in CHILD_ONE:
        c = n.get(k)
        if isinstance(c, dict):
            yield c, f"{path}.{k}", n, None
            yield from _walk_inner(c, f"{path}.{k}")


def all_nodes(plan: dict) -> list[dict]:
    return [n for n, *_ in walk_nodes(plan.get("nodes") or [])]


def anchor_base(ref: Any) -> str | None:
    """「towers[2].top」→ towers；「site.N」→ site；不是锚点写法返回 None"""
    if not isinstance(ref, str):
        return None
    m = ANCHOR.match(ref.strip())
    return m.group(1) if m else None


def index(plan: dict) -> dict:
    """id → (类, 元素)。类 ∈ plan / site / spawn / lighting / terrain / node / mark。根上的 name / concept / mood / palette 用 id "plan"。
    mark = 人画的标记（docs/07 §1.1，plan.marks）：可以被锚点引用，不能被 ops 改 / 删。"""
    out: dict = {"plan": ("plan", plan)}
    for g in ONE_GROUPS:
        if isinstance(plan.get(g), dict):
            out[g] = (g, plan[g])
    for t in plan.get("terrain") or []:
        if isinstance(t, dict) and isinstance(t.get("id"), str):
            out.setdefault(t["id"], ("terrain", t))
    for n, *_ in walk_nodes(plan.get("nodes") or []):
        if isinstance(n.get("id"), str):
            out.setdefault(n["id"], ("node", n))
    for m in plan.get("marks") or []:
        if isinstance(m, dict) and isinstance(m.get("id"), str):
            out.setdefault(m["id"], ("mark", m))
    return out


def resolve(plan: dict, ref: Any) -> tuple[str, dict] | None:
    """按 id 找（含 towers[2] 这种实例引用：落到 repeat 本身）"""
    base = anchor_base(ref)
    return index(plan).get(base) if base else None


def new_id(plan: dict, base: str, taken: set | None = None) -> str:
    base = re.sub(r"[^a-z0-9_]", "_", (base or "item").lower()).strip("_") or "item"
    if not base[0].isalpha():
        base = "x_" + base
    used = set(index(plan)) | (taken or set()) | RESERVED_IDS
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


def _del_path(obj: dict, field: str) -> None:
    parts = field.split(".")
    cur: Any = obj
    for part in parts[:-1]:
        cur = cur[int(part)] if isinstance(cur, list) else (cur.get(part) if isinstance(cur, dict) else None)
        if cur is None:
            return
    if isinstance(cur, dict):
        cur.pop(parts[-1], None)


def _remove_from(plan: dict, target: dict) -> bool:
    """从树里摘掉某个元素（按对象身份）"""
    for g in ("terrain", "nodes"):
        lst = plan.get(g) or []
        if any(x is target for x in lst):
            plan[g] = [x for x in lst if x is not target]
            return True
    for n, _, parent, container in walk_nodes(plan.get("nodes") or []):
        if n is target and parent is not None:
            if container is not None:
                for k in CHILD_LISTS:
                    if parent.get(k) is container:
                        parent[k] = [x for x in container if x is not target]
                        return True
            for k in CHILD_ONE:
                if parent.get(k) is target:
                    del parent[k]
                    return True
    return False


def _add_target(plan: dict, to: Any) -> tuple[str, list] | None:
    """add 的目的地：root（根节点，也收 nodes）/ terrain / relations，或某个能装子节点的节点 id（加到它的 children；repeat 不行）"""
    if to in ("root", "nodes"):
        return "nodes", plan.setdefault("nodes", [])
    if to in ("terrain", "relations"):
        return to, plan.setdefault(to, [])
    hit = index(plan).get(to) if isinstance(to, str) else None
    if hit and hit[0] == "node" and hit[1].get("type") != "repeat" and "child" not in hit[1]:
        return "node", hit[1].setdefault("children", [])
    return None


def norm_op(op: Any) -> Any:
    """模型常见的别名：add 的 to 写成 parent / group / into；set 的 path 写成 field"""
    if not isinstance(op, dict):
        return op
    o = dict(op)
    if o.get("op") == "add" and "to" not in o:
        for k in ("parent", "into", "group", "target"):
            if k in o:
                o["to"] = o.pop(k)
                break
        o.setdefault("to", "root")
    if o.get("op") == "add" and o.get("to") == "nodes":
        o["to"] = "root"
    if o.get("op") == "set" and "field" not in o and "path" in o:
        o["field"] = o.pop("path")
    return o


def apply_ops(plan: dict, ops: list) -> dict:
    """ops 应用到 plan 的副本（假定已经过 check_ops）。被删元素的引用不在这里处理：引擎落地时降级到 site。"""
    p = copy.deepcopy(plan)
    for op in ops:
        op = norm_op(op)
        kind = op.get("op")
        inst = INSTANCE.match(str(op.get("id") or ""))
        if kind == "set":
            hit = resolve(p, op.get("id"))
            if hit and inst and hit[1].get("type") == "repeat":  # 单个实例：写进 repeat 的 overrides
                ov = hit[1].setdefault("overrides", {}).setdefault(inst.group(2), {})
                _set_path(ov, op["field"], copy.deepcopy(op.get("value")))
            elif hit:
                if op.get("value") is None:
                    _del_path(hit[1], op["field"])
                else:
                    _set_path(hit[1], op["field"], copy.deepcopy(op.get("value")))
        elif kind == "add":
            dest = _add_target(p, op.get("to"))
            if dest:
                k = op.get("index")
                if isinstance(k, int) and 0 <= k <= len(dest[1]):
                    dest[1].insert(k, copy.deepcopy(op["value"]))
                else:
                    dest[1].append(copy.deepcopy(op["value"]))
        elif kind == "remove":
            rid = str(op.get("id") or "")
            if rid.startswith("rel:") and rid[4:].isdigit():  # 关系没有 id，按序号删
                k = int(rid[4:])
                p["relations"] = [r for i, r in enumerate(p.get("relations") or []) if i != k]
                continue
            hit = resolve(p, rid)
            if hit and inst and hit[1].get("type") == "repeat":  # 单个实例：写进 repeat 的 skip
                sk = hit[1].setdefault("skip", [])
                if int(inst.group(2)) not in sk:
                    sk.append(int(inst.group(2)))
                continue
            if hit and hit[0] in ("node", "terrain"):
                _remove_from(p, hit[1])
                if rid in (p.get("locks") or []):
                    p["locks"] = [x for x in p["locks"] if x != rid]
    return p


def _el_schema(kind: str, el: Any) -> dict:
    return item_schema(kind if kind != "plan" else "plan", el)


def check_ops(plan: dict, ops: Any, locked_ids: set | None = None) -> tuple[list, list[str], list[str]]:
    """逐条检查 ops（docs/06 §3）：set 的字段必须是该元素 schema 里的（可嵌套路径）、值要合 schema（越界夹回）；
    add 到 nodes / terrain / relations 或某个 group 的 children，值要合 schema、id 不重；remove 的 id 要存在。
    返回 (合法的 ops, 错误清单, 本地修正清单)。锁住的 id 一律不动。"""
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
        op = norm_op(op)
        kind = op.get("op")
        idx = index(cur)
        base = anchor_base(op.get("id"))
        if kind in ("set", "remove") and (op.get("id") in locked_ids or base in locked_ids):
            fixes.append(f"{where}: {op.get('id')} 已锁住，不改")
            continue
        if kind in ("set", "remove") and (idx.get(base) or ("",))[0] == "mark":
            errs.append(f"{where}: {base} 是人画的标记，只能当锚点用（at / area / along），不能改 / 删")
            continue
        if kind == "set":
            tid, field = op.get("id"), op.get("field")
            if base not in idx:
                errs.append(f"{where}: 没有 id 为 {tid!r} 的元素（可用：{', '.join(list(idx)[:40])}）")
                continue
            g, el = idx[base]
            inst = INSTANCE.match(str(tid))
            if inst and el.get("type") == "repeat" and isinstance(el.get("child"), dict):
                el = el["child"]  # 改单个实例：字段按模板节点查，写进 overrides
            elif tid != base:
                fixes.append(f"{where}: {tid} 不是重复的实例，按 {base} 改")
                tid = base
            if not isinstance(field, str) or not re.fullmatch(r"[a-z_][a-z0-9_]*(\.([a-z_][a-z0-9_]*|\d+))*", field) or field.split(".")[0] in NO_SET_FIELDS:
                errs.append(f"{where}: field 应为该元素的字段名（点分路径，如 size_m.1、connect.via；不能改 id / locks / skip / overrides）")
                continue
            sub = field_schema_in(_el_schema(g, el), field, el)
            if sub is None:
                allowed = ", ".join((_el_schema(g, el).get("properties") or {}).keys())
                errs.append(f"{where}: {('节点 ' + str(el.get('type'))) if g == 'node' else g} 没有字段 {field!r}（可用：{allowed}）")
                continue
            f2: list = []
            val = copy.deepcopy(op.get("value"))
            if val is None and g in ("node", "terrain", "site", "spawn", "lighting"):  # null = 删掉这个字段
                good.append({"op": "set", "id": tid, "field": field, "value": None})
                cur = apply_ops(cur, [good[-1]])
                continue
            if isinstance(val, dict):
                f2 += strip_extra(sub, val, f"{where}.value", root)
            val = clamp(sub, val, f"{where}.value", root, f2)
            if field.split(".")[-1] == "type" and g == "node":  # 换类型：整个节点按新类型再查一遍
                trial = copy.deepcopy(el)
                _set_path(trial, field, val)
                e = validate(_el_schema("node", trial), trial, f"{where}.value", root)
            else:
                e = validate(sub, val, f"{where}.value", root)
            if e:
                errs += e
                continue
            fixes += f2
            op = {"op": "set", "id": tid, "field": field, "value": val}
        elif kind == "add":
            to, val = op.get("to"), copy.deepcopy(op.get("value"))
            dest = _add_target(cur, to)
            if dest is None:
                errs.append(f"{where}: to 应为 root / terrain / relations，或某个 group 节点的 id（{to!r} 不行；repeat 改它的 child 用 set）")
                continue
            if not isinstance(val, dict):
                errs.append(f"{where}: value 应为对象")
                continue
            g = "node" if dest[0] in ("node", "nodes") else "terrain" if dest[0] == "terrain" else "relations"
            sch = item_schema(g, val)
            if g != "relations":
                if isinstance(val.get("id"), str) and (val["id"] in idx or val["id"] in RESERVED_IDS):
                    nid = new_id(cur, val["id"])
                    fixes.append(f"{where}: id {val['id']!r} → {nid}")
                    val["id"] = nid
                elif not isinstance(val.get("id"), str) and "id" in (sch.get("properties") or {}):
                    val["id"] = new_id(cur, str(val.get("type") or val.get("op") or "item"))
            f2 = strip_extra(sch, val, f"{where}.value", root)
            val = clamp(sch, val, f"{where}.value", root, f2)
            e = validate(sch, val, f"{where}.value", root)
            if e:
                errs += e
                continue
            fixes += f2
            op = {"op": "add", "to": "root" if dest[0] == "nodes" else to, "value": val, **({"index": op["index"]} if isinstance(op.get("index"), int) else {})}
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
            if base not in idx or idx[base][0] not in ("node", "terrain"):
                errs.append(f"{where}: 没有可删的 id {tid!r}")
                continue
            inst = INSTANCE.match(str(tid))
            if inst and idx[base][1].get("type") == "repeat":
                op = {"op": "remove", "id": tid}
            else:
                if tid != base:
                    fixes.append(f"{where}: {tid} 不是重复的实例，按 {base} 删")
                op = {"op": "remove", "id": base}
        else:
            errs.append(f"{where}: op 应为 set / add / remove")
            continue
        good.append(op)
        cur = apply_ops(cur, [op])
    return good, errs, fixes


def _ui(kind: str, field: str, el: Any = None) -> dict:
    """某字段的 x-ui（中文名、枚举中文）；字段在 $ref 后面时取引用处与定义处合并的提示"""
    root = plan_schema()
    s: Any = _el_schema(kind, el)
    ui: dict = {}
    for part in field.split("."):
        s = _pick(s, el, root)
        prop = ((s or {}).get("properties") or {}).get(part) if isinstance(s, dict) else None
        if not isinstance(prop, dict):
            return ui
        ui = {**((deref(prop, root) or {}).get("x-ui") or {}), **(prop.get("x-ui") or {})}
        s = prop
        el = el.get(part) if isinstance(el, dict) else None
    return ui


def describe_ops(plan: dict, ops: list) -> str:
    """ops → 一句中文复述（模型没给复述、或模拟 AI 用）"""
    parts = []
    for op in ops:
        op = norm_op(op)
        if op.get("op") == "add":
            v = op.get("value") or {}
            parts.append(f"加了{v.get('label') or v.get('id') or v.get('op') or ''}")
        elif op.get("op") == "remove":
            el = (resolve(plan, op.get("id")) or (None, {}))[1]
            parts.append(f"去掉了{(el or {}).get('label') or op.get('id')}")
        elif op.get("op") == "set":
            hit = resolve(plan, op.get("id"))
            if not hit:
                continue
            g, el = hit
            ui = _ui(g, op.get("field", ""), el)
            val = op.get("value")
            vs = (ui.get("options") or {}).get(val, val) if isinstance(val, str) else val
            if isinstance(vs, (int, float)) and not isinstance(vs, bool):
                vs = f" {vs} {ui.get('unit') or ''}".rstrip()
            elif isinstance(vs, list) and all(isinstance(x, (int, float)) for x in vs):
                vs = " " + "×".join(f"{x:g}" for x in vs) + (" " + ui["unit"] if ui.get("unit") else "")
            who = {"site": "场地", "lighting": "", "spawn": "出生点", "plan": ""}.get(g, el.get("label") or op["id"])
            parts.append(f"{who}{ui.get('label') or op.get('field')}改成{vs if not isinstance(vs, (dict, list)) else '新的'}")
    return "；".join(dict.fromkeys(parts))


def _refs(node: Any, path: str, out: list, skip_children: bool = True) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k in REF_KEYS and isinstance(v, str):
                out.append((f"{path}.{k}", v))
            elif k in REF_LIST_KEYS and isinstance(v, list):
                out.extend((f"{path}.{k}", x) for x in v if isinstance(x, str))
            elif isinstance(v, dict) and k not in (CHILD_ONE if skip_children else ()):
                _refs(v, f"{path}.{k}", out, skip_children)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _refs(v, f"{path}[{i}]", out, skip_children)


def all_refs(plan: dict) -> list[tuple[str, str]]:
    """plan 里所有引用（路径, 锚点串）：节点 / 地形操作 / 关系 / 出生点"""
    out: list = []
    for i, t in enumerate(plan.get("terrain") or []):
        _refs(t, f"terrain[{i}]", out)
    for n, path, *_ in walk_nodes(plan.get("nodes") or []):
        _refs({k: v for k, v in n.items() if k not in CHILD_LISTS + CHILD_ONE}, path, out)
    for i, r in enumerate(plan.get("relations") or []):
        _refs(r, f"relations[{i}]", out)
    if isinstance(plan.get("spawn"), dict):
        _refs(plan["spawn"], "spawn", out)
    return out


def ref_warnings(plan: dict) -> list[str]:
    """引用了不存在的 id（引擎会降级到 site，这里只提一句）"""
    ids = set(index(plan)) | {"site", "spawn"}
    return [f"{path} → {ref}" for path, ref in all_refs(plan) if anchor_base(ref) and anchor_base(ref) not in ids and not str(ref).startswith("site")]


def dedupe_ids(plan: dict) -> list[str]:
    """同一张 plan 里重复的 id（节点、地形操作同一个命名空间；保留字 site / spawn / plan 也算）改名，后出现的那个改"""
    seen: set = set(RESERVED_IDS)
    fixes: list[str] = []
    els = [t for t in plan.get("terrain") or [] if isinstance(t, dict)] + all_nodes(plan)
    for el in els:
        if isinstance(el.get("id"), str):
            if el["id"] in seen:
                k = 2
                while f"{el['id']}_{k}" in seen:
                    k += 1
                fixes.append(f"{el['id']}: id 重复 → {el['id']}_{k}")
                el["id"] = f"{el['id']}_{k}"
            seen.add(el["id"])
    return fixes


ROOT_ANCHOR_KEYS = ("at", "under", "over", "from", "area", "around", "along")
GLOBAL_KEYS = ("position", "pos", "x", "y", "z", "coords", "world", "world_m", "xyz", "center_m", "location")


def fix_roots(plan: dict, fixes: list | None = None) -> list[str]:
    """硬规则：根节点不写全局坐标。根节点没有锚点（at / under / from …）→ 锚到 site.center，丢掉它的 offset_m；
    任何节点上的 position / x / z 之类全局坐标字段一律去掉。返回改了什么。"""
    fixes = [] if fixes is None else fixes
    for n, path, parent, _ in walk_nodes(plan.get("nodes") or []):
        for k in GLOBAL_KEYS:
            if k in n:
                del n[k]
                fixes.append(f"{path}.{k}: 不写全局坐标，去掉")
        if parent is None and not any(n.get(k) for k in ROOT_ANCHOR_KEYS):
            n["at"] = "site.center"
            if "offset_m" in n:
                del n["offset_m"]
                fixes.append(f"{path}: 根节点没有锚点 → at=site.center，去掉 offset_m（根节点只用锚点）")
            else:
                fixes.append(f"{path}: 根节点没有锚点 → at=site.center")
    return fixes


def _count_of(n: dict) -> int:
    """一个节点展开后的形体数（repeat 乘数量；生成器按粗估）"""
    t = n.get("type")
    kids = sum(_count_of(c) for c in n.get("children") or [] if isinstance(c, dict))
    if t == "repeat":
        k = n.get("count")
        if n.get("pattern") == "mirror":
            k = 2
        elif n.get("pattern") == "stack":
            k = n.get("levels") or n.get("count") or 3
        elif n.get("pattern") == "grid":
            k = (n.get("rows") or 1) * (n.get("cols") or 1) if n.get("rows") or n.get("cols") else (k or 4)
        k = int(k or 4)
        return k * (_count_of(n["child"]) if isinstance(n.get("child"), dict) else 1) + kids
    if t == "group":
        return kids
    if t == "scatter_houses":
        return int(n.get("count") or round(40 * float(n.get("density") or 1))) + kids
    if t in ("grove", "field"):
        return int(n.get("count") or 20) + kids
    if t in ("link", "space", "terraces"):
        return kids
    return 1 + kids


def shape_count(plan: dict) -> int:
    return sum(_count_of(n) for n in plan.get("nodes") or [] if isinstance(n, dict))


def cap_shapes(plan: dict, limit: int = MAX_SHAPES, fixes: list | None = None) -> list[str]:
    """展开后超过 limit 个形体：从展开最多的 repeat 起把 count 往下压，直到不超"""
    fixes = [] if fixes is None else fixes
    for _ in range(40):
        n_all = shape_count(plan)
        if n_all <= limit:
            break
        reps = [n for n in all_nodes(plan) if n.get("type") in ("repeat", "scatter_houses", "grove", "field") and isinstance(n.get("count"), int) and n["count"] > 2]
        if not reps:
            break
        big = max(reps, key=_count_of)
        new = max(2, int(big["count"] * max(0.3, limit / n_all)))
        if new >= big["count"]:
            new = big["count"] - 1
        fixes.append(f"{big.get('id') or big.get('label') or big.get('type')}: count {big['count']} → {new}（展开后 {n_all} 个形体 > {limit}）")
        big["count"] = new
    return fixes


# ---------- 给模型看的语法表（由 schema 生成：通用字段一行，按 type / op 各一行；同字段的类型并成一行）
def _short(node: Any, root: dict, depth: int = 0) -> str:
    if not isinstance(node, dict):
        return "any"
    if "$ref" in node:
        name = node["$ref"].rsplit("/", 1)[-1]
        if name in ("anchor", "ref", "id", "node", "terrain_op", "relation", "palette_entry", "room", "site", "spawn", "lighting"):
            return name
        if name in ("offset", "pair", "local_pts"):
            return {"offset": "[dx,dz] | [dx,dy,dz]", "pair": "[num,num]", "local_pts": "[[x,z], …]"}[name]
        return _short(deref(node, root), root, depth)
    for key in ("anyOf", "oneOf"):
        if key in node:
            return " | ".join(_short(b, root, depth) for b in node[key])
    if "const" in node:
        return json.dumps(node["const"], ensure_ascii=False)
    if "enum" in node:
        return "|".join(str(x) for x in node["enum"])
    ts = _types(node)
    t = ts[0] if ts else ("object" if "properties" in node else "")
    if t in ("number", "integer"):
        rng = f" {node['minimum']:g}–{node['maximum']:g}" if "minimum" in node and "maximum" in node else ""
        return ("int" if t == "integer" else "num") + rng
    if t == "string":
        if str(node.get("pattern", "")).startswith("^#"):
            return '"#RRGGBB"'
        return "str" + (f"≤{node['maxLength']}" if "maxLength" in node else "")
    if t == "boolean":
        return "bool"
    if t == "array":
        it = node.get("items")
        lo, hi = node.get("minItems"), node.get("maxItems")
        if isinstance(it, dict):
            inner = deref(it, root)
            if inner.get("type") in ("number", "integer") and lo == hi and lo:
                return "[" + ", ".join(["num"] * lo) + "]"
            if inner.get("type") == "array":
                return "[[ref,ref], …]" if "$ref" in json.dumps(inner.get("items")) else "[[x,z], …]"
            return _short(it, root, depth + 1) + "[]" + (f"≤{hi}" if hi else "")
        return "[]"
    if t == "object":
        if depth > 1:
            return "{…}"
        props = node.get("properties") or {}
        return "{" + ", ".join(f"{k}?: {_short(v, root, depth + 1)}" for k, v in props.items() if k not in AI_FORBIDDEN) + "}"
    return t or "any"


def _when_of(prop: Any) -> dict:
    return ((prop.get("x-ui") or {}).get("when") or {}) if isinstance(prop, dict) else {}


def grammar() -> str:
    """场景程序的精简语法表（DeepSeek 的系统提示与 Claude 的提示共用）：根、site、terrain_op 按 op、node 按 type、spawn / relation / palette"""
    root = plan_schema()
    defs = _defs(root)
    req = set(root.get("required") or [])
    lines = ["plan = {" + ", ".join(f"{k}{'' if k in req else '?'}: {_short(v, root)}" for k, v in (root.get("properties") or {}).items() if k not in AI_FORBIDDEN) + "}"]
    for name in ("site", "spawn", "relation", "palette_entry", "lighting", "room"):
        if name in defs:
            d = defs[name]
            rq = set(d.get("required") or [])
            lines.append(f"{name} = {{" + ", ".join(f"{k}{'' if k in rq else '?'}: {_short(v, root, 1)}" for k, v in (d.get("properties") or {}).items() if k not in AI_FORBIDDEN) + "}")
    if "anchor" in defs:
        lines.append("anchor（at / from / to / via）= " + str(defs["anchor"].get("description") or "")[:200])
    if "ref" in defs:
        lines.append("ref（under / over / around / along / area / look_at / connect.from / 关系的 a b c）= " + str(defs["ref"].get("description") or "") + "（不带 .部位）")
    xsize = root.get("x-size") or {}

    def per_kind(d: dict, key: str, kinds: list) -> list[str]:
        props = d.get("properties") or {}
        common: list = []
        by: dict = {k: [] for k in kinds}
        for f, sub in props.items():
            if f in AI_FORBIDDEN or f == key:
                continue
            w = _when_of(sub)
            note = ""
            if key in w:
                targets = [k for k in kinds if k in w[key]]
            elif w:
                (wk, wv), = list(w.items())[:1]
                note = f"({wk}={'/'.join(map(str, wv))} 时)"
                dep = _when_of(props.get(wk)).get(key) if wk in props else None
                targets = [k for k in kinds if k in dep] if dep else []
            else:
                common.append(f)
                continue
            for k in targets:
                by[k].append(f + note)
        out = [f"{d.get('title') or ''}通用 = {{" + ", ".join(f"{f}?: {_short(props[f], root, 1)}" for f in common) + "}"]
        groups: dict = {}
        for k in kinds:
            sig = (tuple(by[k]), tuple(xsize.get(k) or []) if key == "type" else ())
            groups.setdefault(sig, []).append(k)
        for (fs, size), ks in groups.items():
            bits = []
            if size:
                bits.append("size_m=[" + ",".join(size) + "]")
            for f in fs:
                base = f.split("(")[0]
                bits.append(f"{f}: {_short(props[base], root, 1)}" if base != "size_m" else f)
            out.append("  " + " / ".join(ks) + "：" + ("；".join(bits) if bits else "只有通用字段"))
        return out
    if "terrain_op" in defs:
        ops = list((defs["terrain_op"]["properties"].get("op") or {}).get("enum") or [])
        lines += [x.replace("通用", "terrain_op 通用", 1) if i == 0 else x for i, x in enumerate(per_kind(defs["terrain_op"], "op", ops))]
    if "node" in defs:
        types = list((defs["node"]["properties"].get("type") or {}).get("enum") or [])
        lines += [x.replace("通用", "node 通用", 1) if i == 0 else x for i, x in enumerate(per_kind(defs["node"], "type", types))]
    return "\n".join(lines)
