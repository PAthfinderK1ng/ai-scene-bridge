# -*- coding: utf-8 -*-
"""
schema_lite.py — 不依赖 jsonschema 的最小 JSON Schema 工具（校验 / 夹取 / 发给 API 前的清洗）

为什么要有它：
- Claude 结构化输出（output_config.format = json_schema）不支持 minimum / maximum / multipleOf /
  minLength / maxLength / pattern / minItems(>1) / maxItems（见 claude-api 技能 shared/tool-use-concepts.md
  「JSON Schema Limitations」）。anthropic SDK 只在 messages.parse() 走 pydantic 时自动剥掉这些约束；
  messages.create() 里直接传 dict schema 是原样发出去的 → 会 400。
- 所以：api_schema() 把不支持的关键字剥掉并折进 description（模型「可能」照做），模型回来后用
  validate() 本地校验、clamp() 把越界数值夹回范围；CARD_SCHEMA / REVISE_SCHEMA 本身保持严格不变。
- 本机不一定装了 jsonschema；评测脚本与测试在没有 jsonschema 时退回这里的 validate()。

只实现本项目 schema 用到的关键字：type / enum / const / properties / required / additionalProperties(false) /
items / minItems / maxItems / minimum / maximum / exclusiveMinimum / exclusiveMaximum / pattern / minLength / maxLength / anyOf。
"""
from __future__ import annotations

import copy
import re
from typing import Any

UNSUPPORTED_BY_API = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "maxItems")


def api_schema(schema: dict) -> dict:
    """返回一份能直接发给结构化输出 API 的副本：剥掉不支持的约束，折进 description；minItems 只保留 0 / 1。"""
    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        out: dict = {}
        dropped: dict = {}
        for k, v in node.items():
            if k in UNSUPPORTED_BY_API or (k == "minItems" and v not in (0, 1)):
                dropped[k] = v
            elif k in ("properties", "$defs", "definitions"):
                out[k] = {name: walk(sub) for name, sub in v.items()}
            elif k in ("items", "anyOf", "allOf", "oneOf"):
                out[k] = walk(v)
            else:
                out[k] = copy.deepcopy(v)
        if dropped:
            note = "{" + ", ".join(f"{k}: {v}" for k, v in dropped.items()) + "}"
            out["description"] = (out["description"] + "\n\n" + note) if out.get("description") else note
        return out
    return walk(schema)


def _type_ok(t: str, v: Any) -> bool:
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    if t == "null":
        return v is None
    return True


def validate(schema: dict, data: Any, path: str = "$") -> list[str]:
    """返回违规清单（空列表 = 合法）。每条形如 "$.cards[0].params.terraces: 9 > maximum 7"。"""
    errs: list[str] = []
    if "anyOf" in schema:
        if not any(not validate(sub, data, path) for sub in schema["anyOf"]):
            errs.append(f"{path}: 不匹配 anyOf 的任何一支")
        return errs
    t = schema.get("type")
    types = t if isinstance(t, list) else ([t] if t else [])
    if types and not any(_type_ok(x, data) for x in types):
        errs.append(f"{path}: 类型应为 {'/'.join(types)}，实际 {type(data).__name__}")
        return errs
    if "enum" in schema and data not in schema["enum"]:
        errs.append(f"{path}: {data!r} 不在枚举 {schema['enum']} 里")
    if "const" in schema and data != schema["const"]:
        errs.append(f"{path}: 应为常量 {schema['const']!r}")
    if isinstance(data, dict):
        for k in schema.get("required", []):
            if k not in data:
                errs.append(f"{path}: 缺少必填字段 {k}")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for k in data:
                if k not in props and not str(k).startswith("_"):
                    errs.append(f"{path}: 多出字段 {k}")
        for k, sub in props.items():
            if k in data:
                errs += validate(sub, data[k], f"{path}.{k}")
    elif isinstance(data, list):
        if "minItems" in schema and len(data) < schema["minItems"]:
            errs.append(f"{path}: 长度 {len(data)} < minItems {schema['minItems']}")
        if "maxItems" in schema and len(data) > schema["maxItems"]:
            errs.append(f"{path}: 长度 {len(data)} > maxItems {schema['maxItems']}")
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(data):
                errs += validate(schema["items"], v, f"{path}[{i}]")
    elif isinstance(data, (int, float)) and not isinstance(data, bool):
        if "minimum" in schema and data < schema["minimum"]:
            errs.append(f"{path}: {data} < minimum {schema['minimum']}")
        if "maximum" in schema and data > schema["maximum"]:
            errs.append(f"{path}: {data} > maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and data <= schema["exclusiveMinimum"]:
            errs.append(f"{path}: {data} ≤ exclusiveMinimum {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and data >= schema["exclusiveMaximum"]:
            errs.append(f"{path}: {data} ≥ exclusiveMaximum {schema['exclusiveMaximum']}")
    elif isinstance(data, str):
        if "pattern" in schema and not re.search(schema["pattern"], data):
            errs.append(f"{path}: {data!r} 不匹配 pattern {schema['pattern']}")
        if "minLength" in schema and len(data) < schema["minLength"]:
            errs.append(f"{path}: 长度 {len(data)} < minLength {schema['minLength']}")
        if "maxLength" in schema and len(data) > schema["maxLength"]:
            errs.append(f"{path}: 长度 {len(data)} > maxLength {schema['maxLength']}")
    return errs


def clamp(schema: dict, data: Any, path: str = "$") -> list[str]:
    """原地把越界的数值夹回 [minimum, maximum]，返回改动清单（"$.x: 1.9 → 1.6"）。只碰数值，不碰别的。"""
    fixes: list[str] = []
    if "anyOf" in schema or not isinstance(schema, dict):
        return fixes
    if isinstance(data, dict):
        for k, sub in schema.get("properties", {}).items():
            if k in data:
                if isinstance(data[k], (int, float)) and not isinstance(data[k], bool) and sub.get("type") in ("number", "integer"):
                    v = data[k]
                    lo, hi = sub.get("minimum"), sub.get("maximum")
                    nv = v
                    if lo is not None and nv < lo:
                        nv = lo
                    if hi is not None and nv > hi:
                        nv = hi
                    if sub.get("type") == "integer" and isinstance(nv, float) and nv.is_integer():
                        nv = int(nv)
                    if nv != v:
                        data[k] = nv
                        fixes.append(f"{path}.{k}: {v} → {nv}")
                else:
                    fixes += clamp(sub, data[k], f"{path}.{k}")
    elif isinstance(data, list) and isinstance(schema.get("items"), dict):
        for i, v in enumerate(data):
            fixes += clamp(schema["items"], v, f"{path}[{i}]")
    return fixes


def has_key(node: Any, key: str) -> bool:
    """schema 树里任何一层是否出现某个关键字（测试用）"""
    if isinstance(node, dict):
        return key in node or any(has_key(v, key) for v in node.values())
    if isinstance(node, list):
        return any(has_key(v, key) for v in node)
    return False
