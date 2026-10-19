# -*- coding: utf-8 -*-
"""
ai.py — 「场景对话」的全部 AI（跑在本地 Python 服务里，密钥不进浏览器）

AI 输出构成图 plan（docs/05 §2）：任意数量的地形块 / 区域 / 建筑类型 / 地标 / 路 / 水 / 空间 / 关系，名字随便起，
尺寸用米，位置只用相对关系，**没有坐标**。引擎（medium/engine/plan.js）把 plan 编译成 SID。

后端三个文件：
- plans.py：plan 的 schema（spec/plan.schema.json 是单一事实来源）、小校验器、夹取、清洗、按 id 找元素、ops 检查与应用
- rules.py：本地锁定——从人的那句话里读出说死的条件，写死到三张 plan 上；revise 也锁
- ai.py（本文件）：提示词、JSON 修复、三个实现（MockAI 不联网 / DeepSeekAI 用 urllib + json_object / ClaudeAI 用 anthropic SDK）、
  配置（%LOCALAPPDATA%/ai-scene-bridge/config.json）、费用、错误，以及入口 draft(payload) / revise(payload) / test_key(payload)。
  plans.py 与 rules.py 的名字在这里全部再导出，外部（app.py、测试、tools/）只用 ai.X。
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



# 构成图的 schema / 工具（plans.py）与本地锁定（rules.py）全部在这里再导出，外部仍然只用 ai.X。
from plans import (
    API_UNSUPPORTED,
    LIST_GROUPS,
    NO_SET_FIELDS,
    ONE_GROUPS,
    REL_ACROSS,
    REL_SYNONYM,
    _FILE_CACHE,
    _branch_for,
    _clean_plan,
    _defs,
    _load_json,
    _set_path,
    _type_ok,
    _types,
    _ui,
    api_schema,
    apply_ops,
    brief,
    check_ops,
    clamp,
    config_path,
    data_dir,
    dedupe_ids,
    deref,
    describe_ops,
    diversity,
    example_plans,
    field_schema,
    fix_rels,
    has_key,
    index,
    item_schema,
    new_id,
    plan_props,
    plan_schema,
    ref_warnings,
    resource_root,
    signature,
    spec_path,
    strip_extra,
    validate,
)  # noqa: F401
from rules import (
    BUILDING_LEX,
    CLAUSE,
    CN_NUM,
    CONNECT_LEX,
    ENTRY_LEX,
    LANDMARK_LEX,
    LAYOUT_CN,
    PLACE_LEX,
    REMOVE_WORDS,
    SIDE_CN,
    SPACE_LEX,
    TERRACE_TYPES,
    TERRAIN_DEFAULT,
    TERRAIN_LEX,
    TIME_CN,
    TIME_WORDS,
    ZONE_LEX,
    _DIRV,
    _blobs,
    _clause_at,
    _convert_terrace,
    _first,
    _fit,
    _free_at,
    _highest,
    _is_entry_route,
    _num,
    _place_for,
    _place_ok,
    _range_of,
    _scan,
    _size_of,
    _stream_id,
    _terrain_of,
    default_landmark,
    default_space,
    default_stream,
    default_terrain,
    drop_refs,
    enforce,
    enforce_ops,
    extract,
    hint,
    rooms_from_text,
    summary,
)  # noqa: F401

# ============================================================ 4. 提示词
def _one_line(p: dict) -> str:
    return json.dumps(p, ensure_ascii=False, separators=(",", ":"))


def prompt_examples(n: int = 2) -> list[dict]:
    """示例 plan 里最短的 n 个（压成单行写进提示词）"""
    ex = sorted(example_plans().values(), key=lambda p: len(_one_line(p)))
    return ex[:n]


def _enum(group: str, field: str) -> str:
    s = field_schema(group, field) or {}
    if "items" in s:
        s = deref(s["items"], plan_schema())
    return " / ".join(str(x) for x in s.get("enum") or []) or "（见字段表）"


def system_prompt() -> str:
    """系统提示（两家共用，稳定前缀便于缓存）。词表从 schema 取，示例从 spec/examples/plans 取。"""
    key = ("sys", os.stat(spec_path("plan.schema.json")).st_mtime, tuple(sorted(example_plans())))
    if _FILE_CACHE.get("_sys", (None,))[0] == key:
        return _FILE_CACHE["_sys"][1]
    ex = prompt_examples(2)
    text = f"""你是「场景对话」里的三维游戏场景构成师。人用一句话说想要什么场景，你输出构成图 plan（JSON），程序把它编译成几何。

铁律：
1. 不写任何坐标。plan 里没有 x / z / position / points 这类字段。位置只用相对关系：at（相对谁、哪个方向、多远的比例）和 place（在谁的顶上 / 边上 / 尽头 / 下面…）。尺寸用米，层数用小整数。
2. 名字随便起，数量不限（在范围内）。地形块、区域、建筑类型、地标、路、水、地下 / 空中空间、关系都按这句话需要自由组合。label 用人话（吊脚木楼、风雨桥、戏台、矿洞迷宫），id 用英文小写短名（a-z、0-9、_），供互相引用；引用只能指向本 plan 里已有的 id，或 site / spawn。
3. 人这句话里说死的东西，三张都必须有：时段、有没有溪、点了名的地标（寨门 / 鼓楼 / 风雨桥 / 戏台 / 水车 / 寺 / 塔 / 大树…，label 里要有这个词）、层数、陡缓、从哪边进、地形词（环台 / 之字 / 两岸 / 溪谷 / 悬崖…）、地下 / 空中空间和它的布局（迷宫 → layout maze；矿洞 → galleries；地宫 → halls 或 rooms；溶洞 → network；「两层的」→ sublevels 2；「岔路多」→ branching high）。没提地下 / 空中就不要加空间。
4. 三张 plan 必须在**构成**上不同，不许只换名字和颜色。至少在两件事上拉开：地形组合不同（主地形块换一种、加减台地 / 谷 / 崖 / 平台）；布局不同（区域落在哪些地形上、主路怎么走）；地标关系不同（放在谁的顶上 / 边上 / 尽头，出生点从哪看到它）；空间布局不同（深度、大小、连接、内部层数）。
5. 设计因果：先定最重要的地标在哪，再定玩家从哪进、怎么一眼看见它（relations 写 visible_from）；主路连起出生点和地标；上密下疏；溪走谷底。
6. 文案简体中文，具体、短。name ≤ 10 字；one_liner 一句话说玩家进来第一眼看见什么，提到的东西必须真在 plan 里。

各组：
- site：场地边长 size_m（米）、总高差几层 relief_layers、每层多高 layer_m。
- terrain：地形块，按顺序叠，后面的可以引用前面的。type ∈ {_enum('terrain', 'type')}：hill 穹顶山 / ridge 长条山脊 / slope_terraces 坡上一层层台地带（steps 级数、orient 上坡方向）/ ring_terraces 一圈圈环台（中心高）/ plateau 平台 / cliff 陡崖边 / valley 谷 / basin 盆地 / pit 坑 / island 四周低的高台。这是几何原语，不是模板，任意组合。
- buildings：建筑类型（不是一栋栋）。form ∈ {_enum('buildings', 'form')}：stilt_house 吊脚楼能站在坡上，courtyard 院落一次一组，round_house 圆楼。
- zones：区域。on 一个地形块，levels 选哪几层（all / low / mid / high 或层号数组），use ∈ {_enum('zones', 'use')}，building 用哪种建筑，density 0–1.6。
- landmarks：地标 / 重要建筑，form 同上，place 放置。
- spawn：出生点 place + look_at（看向谁）。
- paths：路，from / to / via 是 id 或 spawn，style ∈ {_enum('paths', 'style')}。第一条是主路。
- water：溪 / 河，from → to（写法同 at）。
- spaces：地下（stratum underground，under 谁，depth_layers 深几层）/ 空中（sky，over 谁）。layout ∈ {_enum('spaces', 'layout')}：chamber 单室 / corridor 地道 / maze 迷宫 / galleries 矿道（主巷 + 横巷 + 采场）/ halls 厅堂（前厅—甬道—主厅，两侧耳室）/ network 洞穴网 / rooms（给 rooms 清单 + links 连线，"entry" 表示从地面下来的入口；只排一层）。空中只用 chamber 平台 / corridor 栈道 / network 平台群 / rooms，height_layers 高几层。size_m 外轮廓边长，branching 岔路多少，sublevels 内部几层，corridor_m 走廊宽，height_m 每层净高（可不写），connect 从谁附近、怎么下去 / 上去。
- relations：type ∈ {_enum('relations', 'type')}，a / b 是 id 或 spawn。
- palette：roof / wall / stone / foliage / mist 五个角色的 hex，和题材、时段相配；lighting.time_of_day；mood ≤ 4 个词。

相对放置：
- at = {{of: "site" 或 id, dir: C|N|NE|E|SE|S|SW|W|NW, dist: 0–1}}：从 of 的中心往 dir 走 dist × of 的半径。
- place = {{rel, target, side?, facing?, gap_m?}}，rel ∈ {_enum('landmarks', 'place.rel')}：top_of 顶上 / center_of 中央 / edge_of 边上（side 指哪边，不给就朝出生点）/ end_of 路或长条的尽头 / beside 旁边 / behind 背后（相对出生点）/ between 两者之间（target 给两个 id）/ under 下面 / above 上面 / along 沿着路或溪 / at_entry 入口处。

示例 plan（只示范写法与完整度；三张不要照抄它们的构成）：
""" + "\n".join(_one_line(p) for p in ex) + """

再说一遍：不写坐标；人说死的三张都有；三张在构成上真的不同。"""
    _FILE_CACHE["_sys"] = (key, text)
    return text


def draft_user_text(intent: str, cons: dict, locked: dict | None, variant: int = 0) -> str:
    parts = [f"人说：「{intent}」",
             "给出 3 张 plan：这句话里说死的东西三张都要有；没说死的部分三张在构成上拉开（地形组合 / 布局 / 地标关系 / 空间布局）。"]
    h = hint(cons)
    if h:
        parts.append(h)
    if locked and isinstance(locked.get("plan"), dict) and locked.get("ids"):
        keep = [el for i, (g, el) in index(locked["plan"]).items() if i in set(locked["ids"])]
        parts.append("人锁住了这几项，三张都原样保留（id 不变），其它的重新构成：\n" + "\n".join(_one_line(e) for e in keep))
    if variant:
        parts.append(f"这是第 {variant + 1} 批：换几种之前没用过的构成。")
    return "\n\n".join(parts)


def revise_user_text(plan: dict, action: dict, locked_ids: list | None) -> str:
    parts = ["当前 plan：\n" + _one_line(plan),
             "人的动作（程序已转成结构化事实，不是像素）：\n" + json.dumps(action, ensure_ascii=False),
             "只输出对当前 plan 的改动 ops（op ∈ set / add / remove）、一句复述（≤ 60 字）、必要时一句追问（question）。"
             "set：{op:\"set\", id, field, value}，field 是该元素的字段名（嵌套用点，如 place.rel），site / spawn / lighting 用组名当 id；"
             "add：{op:\"add\", group, value}，value 是该组的完整元素（带新 id）；remove：{op:\"remove\", id}。"
             "只放真要改的，不要把整张 plan 抄回来。改空间布局就 set 它的 layout（迷宫 = maze），复述里写「改成迷宫平面」这样的话。"
             "翻不成结构改动时（模糊的形容词）：understood=false、ask_to_point=true、ops=[]，在 restatement 里问清是位置、大小还是长相。"]
    if locked_ids:
        parts.append("锁住、不能改的 id：" + ", ".join(locked_ids))
    return "\n\n".join(parts)


# ============================================================ 5. JSON 修复
def repair_json(text: str) -> tuple[Any, list[str]] | None:
    """模型偶尔吐的坏 JSON 本地修（不花钱）：去 ```json 围栏与前后杂字；字符串里没转义的英文双引号 / 裸换行；尾逗号。修不好返回 None。"""
    t = (text or "").strip()
    fixes: list[str] = []
    if t.startswith("```"):
        t = t[3:]
        t = t[4:] if t[:4].lower() == "json" else t
        t = t.rstrip()
        t = t[:-3] if t.endswith("```") else t
        t = t.strip()
        fixes.append("去掉代码块围栏")
    starts = [i for i in (t.find("{"), t.find("[")) if i >= 0]
    if not starts:
        return None
    a, b = min(starts), max(t.rfind("}"), t.rfind("]"))
    if b <= a:
        return None
    if a > 0 or b < len(t) - 1:
        fixes.append("去掉 JSON 前后的杂字")
    t = t[a:b + 1]
    out: list[str] = []
    n_quote = n_nl = n_comma = 0
    in_str = esc = False
    i, L = 0, len(t)
    while i < L:
        ch = t[i]
        if in_str:
            if esc:
                esc = False
                out.append(ch)
            elif ch == "\\":
                esc = True
                out.append(ch)
            elif ch == '"':
                j = i + 1
                while j < L and t[j] in " \t\r\n":
                    j += 1
                if j >= L or t[j] in ",}]:":
                    in_str = False
                    out.append(ch)
                else:
                    out.append('\\"')
                    n_quote += 1
            elif ch in "\n\r\t":
                out.append({"\n": "\\n", "\r": "\\r", "\t": "\\t"}[ch])
                n_nl += 1
            else:
                out.append(ch)
        else:
            if ch == '"':
                in_str = True
                out.append(ch)
            elif ch == ",":
                j = i + 1
                while j < L and t[j] in " \t\r\n":
                    j += 1
                if j < L and t[j] in "}]":
                    n_comma += 1
                else:
                    out.append(ch)
            else:
                out.append(ch)
        i += 1
    if n_comma:
        fixes.append(f"去掉尾逗号 ×{n_comma}")
    if n_quote:
        fixes.append(f"转义字符串里的双引号 ×{n_quote}")
    if n_nl:
        fixes.append(f"转义字符串里的换行 ×{n_nl}")
    try:
        return json.loads("".join(out)), fixes
    except json.JSONDecodeError:
        return None


# ============================================================ 6. 三个实现
class AIError(RuntimeError):
    """HTTP 200 回来了但结果不能用：kind ∈ refusal / truncated / empty / bad_json / schema。detail 原样透给前端。"""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail


class DeepSeekAPIError(Exception):
    """DeepSeek 的 HTTP / 网络错误，字段与 anthropic.APIError 对齐（status_code / message / body / request_id）"""

    provider = "deepseek"

    def __init__(self, message: str, status_code: int | None = None, body: Any = None, etype: str | None = None):
        super().__init__(message)
        self.message, self.status_code, self.body, self.request_id = message, status_code, body, None
        err = body.get("error") if isinstance(body, dict) else None
        self.etype = etype or (err.get("type") if isinstance(err, dict) else None) or "DeepSeekAPIError"


def _defs_key(root: dict) -> str:
    return "$defs" if "$defs" in root else "definitions"


def ai_view(schema: Any) -> Any:
    """AI 看到 / 要写的 schema：去掉 x-ui.hidden 的人写字段（locks、nudge_m、offset_m、layout_seed；id 保留）与 x-* 提示"""
    if isinstance(schema, list):
        return [ai_view(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k.startswith("x-"):
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: ai_view(pv) for pk, pv in v.items()
                      if pk == "id" or not (isinstance(pv, dict) and (pv.get("x-ui") or {}).get("hidden"))}
            if "required" in schema:
                out["required"] = [r for r in schema["required"] if r in out[k]]
        elif k == "required" and "properties" in schema:
            continue
        else:
            out[k] = ai_view(v)
    return out


def draft_schema() -> dict:
    """{plans: [plan × 3]}，plan 本体与它的定义都从 spec/plan.schema.json 来（AI 视图）"""
    root = plan_schema()
    k = _defs_key(root)
    plan = {kk: v for kk, v in root.items() if kk not in ("definitions", "$defs", "$schema", "$id", "title", "description")}
    return ai_view({"type": "object", "properties": {"plans": {"type": "array", "items": {"$ref": f"#/{k}/plan"}, "minItems": 3, "maxItems": 3}},
                    "required": ["plans"], "additionalProperties": False, k: {**_defs(root), "plan": plan}})


def revise_schema() -> dict:
    """{understood, restatement, ops, question?, ask_to_point}。ops 取 plan.schema.json 的 definitions.ops（op_set / op_add / op_remove）；
    value 的细节由 check_ops 按元素 schema 查（错误更具体）。restatement / question 的约束跟 definitions.revise。"""
    root = plan_schema()
    k = _defs_key(root)
    defs = _defs(root)
    rv = (defs.get("revise") or {}).get("properties") or {}
    return {"type": "object", "properties": {
        "understood": {"type": "boolean", "description": "是否把人的话翻成了可执行的 ops"},
        "restatement": {**(rv.get("restatement") or {"type": "string"}), "description": "一句话复述改了什么"},
        "ops": {"$ref": f"#/{k}/ops"} if "ops" in defs else {"type": "array", "items": {"type": "object"}},
        "question": rv.get("question") or {"type": ["string", "null"]},
        "ask_to_point": {"type": "boolean", "description": "翻不了时为 true：请人在图上指"}},
        "required": ["understood", "restatement", "ops", "ask_to_point"], "additionalProperties": False, k: defs}


def claude_schema(schema: dict, revise_mode: bool = False) -> dict:
    """发给 Claude 的 schema：api_schema 之后，把 op 里「任意值」换成能表达的 anyOf（结构化输出要求每个对象 additionalProperties=false，
    {} 与裸 object 表达不了）。add 的 value = 各组元素之一；set 的 value = 标量 / 数组 / place / at / connect。"""
    s = api_schema(ai_view(schema))
    defs = s.get("$defs") or {}
    if revise_mode and "op_set" in defs and "op_add" in defs:
        groups = {"terrain": "terrain", "buildings": "building", "zones": "zone", "landmarks": "landmark", "paths": "path", "water": "water", "spaces": "space", "relations": "relation"}
        defs["op_add"]["properties"]["value"] = {"anyOf": [{"$ref": f"#/$defs/{d}"} for d in groups.values() if d in defs]}
        conn = (defs.get("space") or {}).get("properties", {}).get("connect")
        defs["op_set"]["properties"]["value"] = {"anyOf": [
            {"type": "string"}, {"type": "number"}, {"type": "boolean"},
            {"type": "array", "items": {"type": "number"}}, {"type": "array", "items": {"type": "string"}},
            *([{"$ref": "#/$defs/place"}] if "place" in defs else []), *([{"$ref": "#/$defs/at"}] if "at" in defs else []),
            *([conn] if conn else []), *([{"type": "array", "items": {"$ref": "#/$defs/palette_entry"}}] if "palette_entry" in defs else [])]}
    return s


def postprocess_plans(data: Any) -> tuple[dict, list[str], list[str]]:
    """模型回来的 draft：包成 {plans}、去多余字段、id 去重、夹取、校验。返回 (data, fixes, errors)。"""
    if isinstance(data, list):
        data = {"plans": data}
    if not isinstance(data, dict):
        return {"plans": []}, [], ["应为 {\"plans\": [3 个 plan]}"]
    if "plans" not in data:
        for alt in ("cards", "options", "scenes"):
            if isinstance(data.get(alt), list):
                data = {"plans": data.pop(alt), **{k: v for k, v in data.items() if k.startswith("_")}}
                break
    sch = draft_schema()
    fixes = strip_extra(sch, data, "$", sch)
    for i, p in enumerate(data.get("plans") or []):
        if isinstance(p, dict):
            fixes += [f"plans[{i}] {x}" for x in dedupe_ids(p)]
            fix_rels(p, f"plans[{i}]", fixes)
    f2: list = []
    data = clamp(sch, data, "$", sch, f2)
    errors = validate(sch, data, "$", sch)
    return data, fixes + f2, errors


def postprocess_revise(data: Any, plan: dict, locked_ids: set) -> tuple[dict, list[str], list[str]]:
    if not isinstance(data, dict):
        return {}, [], ["应为一个 json 对象"]
    fixes: list[str] = []
    if "ask_to_point" not in data and isinstance(data.get("understood"), bool):  # 实测 flash 常漏这个布尔，能由 understood 推出
        data["ask_to_point"] = not data["understood"]
        fixes.append(f"$.ask_to_point: 缺 → {data['ask_to_point']}（由 understood 推出）")
    if "ops" not in data and data.get("understood") is False:
        data["ops"] = []
        fixes.append("$.ops: 缺 → []")
    for i, op in enumerate(data.get("ops") or []):  # place.rel 近义词（同 draft）
        if not isinstance(op, dict):
            continue
        if op.get("op") == "add":
            fix_rels(op.get("value"), f"$.ops[{i}].value", fixes)
        elif op.get("field") == "place" and isinstance(op.get("value"), dict):
            fix_rels({"place": op["value"]}, f"$.ops[{i}].value", fixes)
        elif op.get("field") == "place.rel" and isinstance(op.get("value"), str):
            box = {"place": {"rel": op["value"]}}
            fix_rels(box, f"$.ops[{i}].value", fixes)
            op["value"] = box["place"]["rel"]
    sch = revise_schema()
    fixes += strip_extra(sch, data, "$", sch)
    errors = [e for e in validate(sch, data, "$", sch) if not e.startswith("$.ops[")]  # ops 的细节交给 check_ops（按元素 schema 查，错误更具体）
    good, op_errs, op_fixes = check_ops(plan, data.get("ops") or [], locked_ids)
    data["ops"] = good if not op_errs else data.get("ops") or []
    return data, fixes + op_fixes, errors + op_errs


def _usage_zero(model: str = "mock", ms: int = 0) -> dict:
    return {"model": model, "input": 0, "output": 0, "cache_read": 0, "ms": ms, "cost_cny": 0.0, "calls": 0}


class MockAI:
    """模拟 AI：确定性，不联网、不花钱。draft 以示例 plan 为骨架挑 3 个构成不同的，再按句子锁定 / 补元素；revise 认常见说法。"""

    name = "mock"
    model = "mock"

    def draft(self, intent: str, cons: dict, locked: dict | None, variant: int = 0) -> dict:
        exs = list(example_plans().items())
        if not exs:
            raise RuntimeError("缺 spec/examples/plans/*.plan.json（模拟 AI 的骨架）")

        def score(p: dict) -> int:
            s = 0
            types = {t.get("type") for t in p.get("terrain") or []}
            s += 3 * sum(1 for x in cons.get("terrain", []) if x["type"] in types)
            labels = "".join(l.get("label", "") for l in p.get("landmarks") or [])
            s += 2 * sum(1 for x in cons.get("landmarks", []) if x["word"] in labels)
            lay = {x.get("layout") for x in p.get("spaces") or []}
            s += 2 * sum(1 for x in cons.get("spaces", []) if x["layout"] in lay)
            s += sum(1 for b in cons.get("buildings", []) if any(x.get("form") == b["form"] for x in p.get("buildings") or []))
            s += 1 if (cons.get("stream") is True and p.get("water")) else 0
            words = (p.get("name") or "") + (p.get("one_liner") or "")
            s += min(3, sum(1 for k in range(len(intent) - 1) if intent[k:k + 2] in words))  # 句子里的词和骨架的名字 / 一句话重合
            return s
        n = len(exs)
        order = sorted(range(n), key=lambda i: (-score(exs[i][1]), (i - variant) % n))
        plans = []
        for k, i in enumerate(order[:3]):
            p = copy.deepcopy(exs[i][1])
            p, _ = enforce(p, cons)
            p["one_liner"] = describe(p)
            plans.append(p)
        names = [p.get("name") for p in plans]
        for k, p in enumerate(plans):
            if names.count(p.get("name")) > 1:
                p["name"] = (p.get("name") or "方案")[:8] + "二三"[k - 1: k] if k else p.get("name")
        return {"plans": plans, "provider": "mock", "_usage": _usage_zero()}

    def revise(self, plan: dict, action: dict, locked_ids: set) -> dict:
        t = str(action.get("text") or action.get("value") or "")
        ops: list = []
        say: list[str] = []
        site = plan.get("site") or {}
        if any(w in t for w in REMOVE_WORDS):
            for g in ("landmarks", "spaces", "terrain", "zones", "buildings", "paths", "water"):
                for el in plan.get(g) or []:
                    lab = el.get("label") or ""
                    if lab and (lab in t or any(w in t and w in lab for w in [x[0] for x in LANDMARK_LEX] + [w for x in SPACE_LEX for w in x[0]] + ["崖", "溪", "广场", "台", "路"])):
                        ops.append({"op": "remove", "id": el["id"]})
                        say.append(f"去掉了{lab}")
        else:
            def bump(field, delta, lo_hi=None):
                sch = field_schema("site", field) or {}
                v = (site.get(field) or 0) + delta
                v = max(sch.get("minimum", v), min(sch.get("maximum", v), v))
                return round(v, 1) if isinstance(v, float) else v
            if re.search("陡", t):
                v = bump("layer_m", 1.0)
                ops.append({"op": "set", "id": "site", "field": "layer_m", "value": v}); say.append(f"每层 {v} m，更陡")
            elif re.search("缓|平一点", t):
                v = bump("layer_m", -1.0)
                ops.append({"op": "set", "id": "site", "field": "layer_m", "value": v}); say.append(f"每层 {v} m，更缓")
            if re.search("更高|多几层|再高|多一层", t):
                v = bump("relief_layers", 1)
                ops.append({"op": "set", "id": "site", "field": "relief_layers", "value": v}); say.append(f"总高差 {v} 层")
            if re.search("大一点|更大|再大", t) and "地标" not in t:
                v = bump("size_m", 30)
                ops.append({"op": "set", "id": "site", "field": "size_m", "value": v}); say.append(f"场地放大到 {v} m")
            elif re.search("小一点|更小|再小", t):
                v = bump("size_m", -30)
                ops.append({"op": "set", "id": "site", "field": "size_m", "value": v}); say.append(f"场地缩到 {v} m")
            if re.search("密", t) or re.search("稀|少一点", t):
                k = 1.3 if "密" in t else 0.7
                for z in plan.get("zones") or []:
                    if isinstance(z.get("density"), (int, float)) and z.get("use") != "plaza":
                        ops.append({"op": "set", "id": z["id"], "field": "density", "value": round(min(1.6, max(0.0, z["density"] * k)), 2)})
                say.append("房子加密三成" if k > 1 else "房子减三成")
            if re.search("岔路多|更绕|复杂一点", t):
                sp = next((s for s in plan.get("spaces") or [] if s.get("layout") in ("maze", "galleries", "network")), None)
                if sp:
                    ops.append({"op": "set", "id": sp["id"], "field": "branching", "value": "high"}); say.append(f"{sp.get('label')}岔路更多")
            m = re.search(r"把?([一-龥]{1,6}?)(?:换成|改成)([一-龥]{1,6})", t)
            src = next((l for l in plan.get("landmarks") or [] if m and l.get("label") and (l["label"] in m.group(1) or m.group(1) in l["label"])), None)
            dst = next((x for x in LANDMARK_LEX if m and x[0] in m.group(2)), None)
            if src and dst:  # 「把鼓楼换成戏台」
                ops += [{"op": "set", "id": src["id"], "field": "label", "value": dst[0]}, {"op": "set", "id": src["id"], "field": "form", "value": dst[1]}]
                say.append(f"{src['label']}换成{dst[0]}")
            elif re.search("换个地标|换一个地标|地标换", t) and plan.get("landmarks"):
                lm = plan["landmarks"][0]
                have = {l.get("label") for l in plan["landmarks"]}
                nxt = next((x for x in LANDMARK_LEX if x[0] not in have and x[1] not in (lm.get("form"), "bridge", "custom", "well") and len(x[0]) > 1), LANDMARK_LEX[2])
                ops += [{"op": "set", "id": lm["id"], "field": "label", "value": nxt[0]}, {"op": "set", "id": lm["id"], "field": "form", "value": nxt[1]}]
                say.append(f"{lm.get('label')}换成{nxt[0]}")
        good, _, _ = check_ops(plan, ops, locked_ids)
        return {"understood": True, "restatement": "；".join(say), "ops": good, "ask_to_point": False, "provider": "mock", "_usage": _usage_zero()}


def describe(p: dict) -> str:
    """一句话描述一张 plan（模拟 AI 的 one_liner）：从出生点看见什么、站在什么地形上、地下 / 空中有什么"""
    lms = [l.get("label") for l in p.get("landmarks") or [] if l.get("label")]
    terr = {t.get("id"): t.get("label") for t in p.get("terrain") or [] if t.get("label")}
    blab = {b.get("id"): b.get("label") for b in p.get("buildings") or [] if b.get("label")}
    homes = [z for z in p.get("zones") or [] if z.get("use") == "housing" and z.get("on") in terr]
    sps = [s.get("label") + ("（" + LAYOUT_CN.get(s.get("layout"), "") + (f" {s['sublevels']} 层" if (s.get("sublevels") or 1) > 1 else "") + "）" if s.get("layout") else "") for s in p.get("spaces") or [] if s.get("label")]
    side = SIDE_CN.get(((p.get("spawn") or {}).get("place") or {}).get("side"), "")
    s = (f"从{side}边进来" if side else "一进来") + (f"先看见{lms[0]}" if lms else "")
    if homes:  # 房子真正住在哪块地形上就说哪块
        bid = next((z["building"] for z in homes if z.get("building") in blab), None)
        on = list(dict.fromkeys(terr[z["on"]] for z in homes if not bid or z.get("building") == bid))
        b = blab.get(bid)
        s += "，" + "、".join(on[:2]) + "上" + ("长满" + b if b else "是房子")
    elif terr:
        s += "，" + "、".join(list(terr.values())[:2]) + "上是房子"
    if len(lms) > 1:
        s += "，还有" + "、".join(lms[1:3])
    if sps:
        s += "；" + "、".join(sps[:2])
    return s + "。"


# ---------- DeepSeek
DS_DEFAULT_MODEL = "deepseek-flash"
DS_DEFAULT_BASE_URL = "https://api.deepseek.com"
DS_MODELS = ["deepseek-flash", "deepseek-v4-pro"]
# 元 / 百万 token：(高峰, 空闲)。来源 api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-19 取）
DS_PRICING = {
    "deepseek-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},
    "deepseek-v4-flash": {"hit": (0.04, 0.02), "miss": (2.0, 1.0), "output": (8.0, 4.0)},
    "deepseek-v4-pro": {"hit": (0.30, 0.15), "miss": (9.0, 4.5), "output": (27.0, 13.5)},
}
DS_RETRYABLE = {429, 500, 502, 503, 504}


def is_peak(now: dt.datetime | None = None) -> bool:
    """北京时间周一至周五 9–12、14–18 点为高峰（不识别节假日）"""
    t = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone(dt.timedelta(hours=8)))
    return t.weekday() < 5 and (9 <= t.hour < 12 or 14 <= t.hour < 18)


def estimate_cost_cny(usage: dict | None, model: str | None = None, peak: bool | None = None) -> float | None:
    if not usage:
        return None
    m = model or usage.get("model") or ""
    key = next((k for k in DS_PRICING if m == k), None) or next((k for k in DS_PRICING if m.startswith(k)), None)
    if not key:
        return None
    p = DS_PRICING[key]
    i = 0 if (usage.get("peak") if peak is None else peak) else 1
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    hit = n("cache_read")
    miss = n("cache_miss") if usage.get("cache_miss") is not None else max(0.0, n("input") - hit)
    return round((hit * p["hit"][i] + miss * p["miss"][i] + n("output") * p["output"][i]) / 1e6, 6)


def _sum_usage(a: dict | None, b: dict) -> dict:
    if not a:
        return b
    s = dict(b)
    for k in ("input", "output", "cache_read", "cache_miss", "cache_write", "reasoning", "ms", "calls"):
        if a.get(k) is not None or b.get(k) is not None:
            s[k] = (a.get(k) or 0) + (b.get(k) or 0)
    for k in ("cost_cny", "cost_usd"):
        if k in a or k in b:
            s[k] = None if a.get(k) is None or b.get(k) is None else round(a[k] + b[k], 6)
    return s


class DeepSeekAI:
    """DeepSeek 官方 /chat/completions（OpenAI 兼容），只用标准库。没有 json_schema：json_object + 系统提示里的字段表，
    回来后本地修 JSON → 去多余字段 → 夹取 → 校验（plan schema + ops 合法性），不合格把错误清单回喂、重试一次。"""

    name = "deepseek"
    TIMEOUT = 120.0
    MAX_TOKENS = {"draft": 8000, "revise": 2000}
    THINKING_EXTRA = 8000

    def __init__(self, api_key: str, model: str = DS_DEFAULT_MODEL, base_url: str = DS_DEFAULT_BASE_URL, thinking: bool = False, urlopen=None):
        self.api_key = api_key
        self.model = model or DS_DEFAULT_MODEL
        self.base_url = (base_url or DS_DEFAULT_BASE_URL).rstrip("/")
        self.thinking = bool(thinking)
        self._urlopen = urlopen or urllib.request.urlopen
        self.retry_sleep = 2.0

    @staticmethod
    def system_prompt() -> str:
        return (system_prompt() + "\n\n输出格式：只输出一个 json 对象，不要 markdown 代码块，不要解释，不要出现字段表以外的字段，可选字段不用就省略（不要写 null）。\n"
                "出三张时输出 {\"plans\": [plan1, plan2, plan3]}，plan 的字段表（? = 可选，/*…*/ 是中文名）：\n" + brief(plan_schema())
                + "\n\n改动时输出 {\"understood\": true, \"restatement\": \"…\", \"ops\": [...], \"ask_to_point\": false}，四个字段都要有；restatement ≤ 60 字；需要追问时加 \"question\": \"一句话追问\"。"
                + "\n改动示例：" + _one_line({"understood": True, "restatement": "矿洞改成两层的迷宫平面，岔路多。", "ops": [
                    {"op": "set", "id": "mine", "field": "layout", "value": "maze"}, {"op": "set", "id": "mine", "field": "sublevels", "value": 2},
                    {"op": "add", "group": "landmarks", "value": {"id": "stage", "label": "戏台", "form": "stage", "size_m": [10, 6, 8], "place": {"rel": "edge_of", "target": "plaza", "side": "N"}}},
                    {"op": "remove", "id": "cliff_e"}], "ask_to_point": False}))

    def _post_once(self, body: dict, timeout: float) -> dict:
        req = urllib.request.Request(self.base_url + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + self.api_key})
        try:
            with self._urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
            try:
                b = json.loads(raw)
            except Exception:
                b = {"error": {"message": raw[:300]}}
            err = b.get("error") if isinstance(b, dict) else None
            raise DeepSeekAPIError((err.get("message") if isinstance(err, dict) else None) or f"HTTP {e.code}", status_code=e.code, body=b) from None
        except (socket.timeout, TimeoutError) as e:
            raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
                raise DeepSeekAPIError(f"等了 {int(timeout)} s 没回来", etype="APITimeoutError") from e
            raise DeepSeekAPIError(f"连不上 {self.base_url}：{getattr(e, 'reason', e)}", etype="APIConnectionError") from e
        except json.JSONDecodeError as e:
            raise DeepSeekAPIError(f"响应不是 JSON：{e}", etype="APIConnectionError") from e

    def _post(self, body: dict) -> dict:
        """429 / 5xx / 断连重试 1 次；超时不重试"""
        try:
            return self._post_once(body, self.TIMEOUT)
        except DeepSeekAPIError as e:
            if not (e.status_code in DS_RETRYABLE or e.etype == "APIConnectionError"):
                raise
            time.sleep(self.retry_sleep)
            return self._post_once(body, self.TIMEOUT)

    def _body(self, messages: list, max_tokens: int) -> dict:
        return {"model": self.model, "messages": messages, "max_tokens": max_tokens + (self.THINKING_EXTRA if self.thinking else 0), "stream": False,
                "thinking": {"type": "enabled" if self.thinking else "disabled"}, "response_format": {"type": "json_object"}}

    def _usage(self, resp: dict, ms: int) -> dict:
        u = resp.get("usage") or {}
        det = u.get("completion_tokens_details") or {}
        out = {"input": u.get("prompt_tokens"), "output": u.get("completion_tokens"), "cache_read": u.get("prompt_cache_hit_tokens"),
               "cache_miss": u.get("prompt_cache_miss_tokens"), "reasoning": det.get("reasoning_tokens"), "model": resp.get("model") or self.model,
               "request_id": resp.get("id"), "ms": ms, "finish_reason": ((resp.get("choices") or [{}])[0] or {}).get("finish_reason"), "peak": is_peak(), "calls": 1}
        out["cost_cny"] = estimate_cost_cny(out, self.model)
        return out

    def structured(self, user_text: str, post: Callable[[Any], tuple[dict, list, list]], max_tokens: int) -> dict:
        """一次结构化调用（含至多一次回喂重试）。post(data) → (data, fixes, errors)。"""
        messages = [{"role": "system", "content": self.system_prompt()}, {"role": "user", "content": user_text}]
        usage = None
        first_errors: list[str] = []
        last: AIError | None = None
        for attempt in range(2):
            t0 = time.time()
            resp = self._post(self._body(messages, max_tokens))
            u = self._usage(resp, int((time.time() - t0) * 1000))
            usage = _sum_usage(usage, u)
            choice = (resp.get("choices") or [{}])[0] or {}
            text = ((choice.get("message") or {}).get("content") or "").strip()
            fin = choice.get("finish_reason")
            if fin == "content_filter":
                raise AIError("refusal", "DeepSeek 的内容过滤拦下了这次输出", category="content_filter", usage=usage)
            if fin == "length":
                raise AIError("truncated", f"输出到 {u.get('output')} token 被截断（max_tokens={max_tokens}），JSON 不完整", usage=usage, sample=text[-200:])
            if not text:
                raise AIError("empty", f"模型没有返回内容（finish_reason={fin}）", usage=usage)
            repaired: list[str] = []
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                fixed = repair_json(text)
                data = None
                if fixed is None:
                    errors = [f"不是合法 JSON：{e}"]
                    last = AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300])
                else:
                    data, repaired = fixed
                    usage["repaired"] = True
            if data is not None:
                data, fixes, errors = post(data)
                if repaired:
                    fixes = ["本地修 JSON：" + "、".join(repaired)] + fixes
                if not errors:
                    data["_usage"] = usage
                    if attempt:
                        data["_retried"], data["_retry_errors"] = True, first_errors[:8]
                    if fixes:
                        data["_fixes"] = fixes
                    return data
                last = AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors[:40], usage=usage)
            if attempt == 0:
                first_errors = errors
                messages = messages + [{"role": "assistant", "content": text},
                                       {"role": "user", "content": "上面的 json 有这些问题：\n" + "\n".join("- " + x for x in errors[:12]) + "\n改正后重新输出完整的 json（只输出 json）。"}]
        assert last is not None
        last.detail["usage"] = usage
        raise last

    def draft(self, intent: str, cons: dict, locked: dict | None, variant: int = 0) -> dict:
        data = self.structured(draft_user_text(intent, cons, locked, variant), postprocess_plans, self.MAX_TOKENS["draft"])
        data["provider"] = self.name
        return data

    def revise(self, plan: dict, action: dict, locked_ids: set) -> dict:
        data = self.structured(revise_user_text(plan, action, sorted(locked_ids)), lambda d: postprocess_revise(d, plan, locked_ids), self.MAX_TOKENS["revise"])
        data["provider"] = self.name
        return data

    def ping(self) -> dict:
        t0 = time.time()
        body = {"model": self.model, "messages": [{"role": "user", "content": "只回复两个字母：ok"}], "max_tokens": 8, "stream": False, "thinking": {"type": "disabled"}}
        resp = self._post_once(body, 30.0)
        u = self._usage(resp, int((time.time() - t0) * 1000))
        text = (((resp.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        return {"ok": True, "model": resp.get("model") or self.model, "ms": u["ms"], "text": text, "usage": {"input": u["input"], "output": u["output"], "cost_cny": u["cost_cny"]}}


# ---------- Claude
CLAUDE_DEFAULT_MODEL = "claude-opus-5-5"
# 美元 / 百万 token（claude-api 技能：Opus 5.5 $4 / $20，缓存写 $5，缓存读 $0.20）
CLAUDE_PRICING = {"claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.20}}


def estimate_cost_usd(usage: dict | None, model: str | None = None) -> float | None:
    if not usage:
        return None
    key = next((k for k in CLAUDE_PRICING if (model or usage.get("model") or "").startswith(k)), None)
    if not key:
        return None
    p = CLAUDE_PRICING[key]
    n = lambda k: float(usage.get(k) or 0)  # noqa: E731
    return round((n("input") * p["input"] + n("output") * p["output"] + n("cache_write") * p["cache_write"] + n("cache_read") * p["cache_read"]) / 1e6, 6)


class ClaudeAI:
    """官方 anthropic SDK。结构化输出 output_config.format（schema 发前经 api_schema 剥掉不支持的约束，回来后本地校验 + 夹取）；
    Opus 5.5 不传 thinking / 采样参数，深度只用 effort；默认开服务端 refusal fallback（beta 被拒就退回普通调用）；先看 stop_reason 再读内容。"""

    name = "claude"
    fallback_beta_ok = True
    MAX_TOKENS = 16000

    def __init__(self, api_key: str, model: str = CLAUDE_DEFAULT_MODEL, timeout: float = 180.0, max_retries: int = 2):
        import anthropic  # 延迟导入：没装 / 没密钥时不影响服务启动
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)
        self.model = model or CLAUDE_DEFAULT_MODEL

    def _kwargs(self, user_text: str, schema: dict, effort: str) -> dict:
        return dict(model=self.model, max_tokens=self.MAX_TOKENS,
                    system=[{"type": "text", "text": system_prompt(), "cache_control": {"type": "ephemeral"}}],
                    messages=[{"role": "user", "content": user_text}],
                    output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})

    def _usage(self, resp: Any, ms: int) -> dict:
        u = getattr(resp, "usage", None)
        g = lambda k: getattr(u, k, None)  # noqa: E731
        out = {"input": g("input_tokens"), "output": g("output_tokens"), "cache_read": g("cache_read_input_tokens"), "cache_write": g("cache_creation_input_tokens"),
               "model": getattr(resp, "model", None), "stop_reason": getattr(resp, "stop_reason", None), "request_id": getattr(resp, "_request_id", None), "ms": ms,
               "fallback_used": any(getattr(it, "type", None) == "fallback_message" for it in (g("iterations") or [])), "calls": 1}
        out["cost_usd"] = estimate_cost_usd(out)
        return out

    def structured(self, user_text: str, schema: dict, post: Callable[[Any], tuple[dict, list, list]], effort: str) -> dict:
        a = self.anthropic
        kw = self._kwargs(user_text, schema, effort)
        t0 = time.time()
        resp = None
        if ClaudeAI.fallback_beta_ok:
            try:
                resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
            except a.BadRequestError as e:
                body = getattr(e, "body", None)
                msg = (str((body.get("error") or {}).get("message")) if isinstance(body, dict) and isinstance(body.get("error"), dict) else "") + " " + str(e)
                if "anthropic-beta" not in msg.lower() and "fallback" not in msg.lower():
                    raise
                ClaudeAI.fallback_beta_ok = False
        if resp is None:
            resp = self.client.messages.create(**kw)
        usage = self._usage(resp, int((time.time() - t0) * 1000))
        stop = getattr(resp, "stop_reason", None)
        if stop == "refusal":
            sd = getattr(resp, "stop_details", None)
            cat, expl = getattr(sd, "category", None), getattr(sd, "explanation", None)
            raise AIError("refusal", "模型拒绝了这个请求" + (f"（类别 {cat}）" if cat else "") + (f"：{expl}" if expl else ""), category=cat, explanation=expl, usage=usage)
        text = next((b.text for b in (getattr(resp, "content", None) or []) if getattr(b, "type", None) == "text"), "")
        if stop == "max_tokens":
            raise AIError("truncated", f"输出到 {usage.get('output')} token 被截断（max_tokens={self.MAX_TOKENS}），JSON 不完整", usage=usage, sample=text[-200:])
        if not text:
            raise AIError("empty", f"模型没有返回文本块（stop_reason={stop}）", usage=usage)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise AIError("bad_json", f"模型输出不是合法 JSON：{e}", usage=usage, sample=text[:300]) from e
        data, fixes, errors = post(data)
        if errors:
            raise AIError("schema", "模型输出不符合 schema：" + "；".join(errors[:6]), errors=errors[:40], usage=usage)
        data["_usage"] = usage
        if fixes:
            data["_fixes"] = fixes
        return data

    def draft(self, intent: str, cons: dict, locked: dict | None, variant: int = 0) -> dict:
        d = self.structured(draft_user_text(intent, cons, locked, variant), claude_schema(draft_schema()), postprocess_plans, "low")
        d["provider"] = self.name
        return d

    def revise(self, plan: dict, action: dict, locked_ids: set) -> dict:
        d = self.structured(revise_user_text(plan, action, sorted(locked_ids)), claude_schema(revise_schema(), True), lambda x: postprocess_revise(x, plan, locked_ids), "medium")
        d["provider"] = self.name
        return d


# ============================================================ 7. 配置、错误
PROVIDERS = ("anthropic", "deepseek")
PROVIDER_LABEL = {"anthropic": "Claude", "deepseek": "DeepSeek", "mock": "模拟"}
PROVIDER_DEFAULTS = {
    "anthropic": {"api_key": "", "model": CLAUDE_DEFAULT_MODEL},
    "deepseek": {"api_key": "", "model": DS_DEFAULT_MODEL, "base_url": DS_DEFAULT_BASE_URL, "thinking": False},
}
MODEL_CHOICES = {"anthropic": ["claude-opus-5-5", "claude-sonnet-5-5"], "deepseek": list(DS_MODELS)}
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}


def _read_raw() -> dict:
    try:
        with open(config_path(), encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _normalize(raw: dict) -> dict:
    """文件里的配置 → 规范结构。旧的扁平 {api_key, model} 归到 anthropic。"""
    provs = {p: dict(PROVIDER_DEFAULTS[p]) for p in PROVIDERS}
    for p, v in (raw.get("providers") or {}).items():
        if p in provs and isinstance(v, dict):
            provs[p].update({k: x for k, x in v.items() if x is not None and k != "key_source"})
    if raw.get("api_key") and not provs["anthropic"]["api_key"]:
        provs["anthropic"]["api_key"] = raw["api_key"]
    if raw.get("model") and "providers" not in raw:
        provs["anthropic"]["model"] = raw["model"]
    prov = raw.get("provider")
    if prov not in PROVIDERS:
        prov = "anthropic" if provs["anthropic"]["api_key"] else "deepseek"
    return {"provider": prov, "mock": bool(raw.get("mock")), "providers": provs}


def load_config() -> dict:
    """规范配置 + 环境变量补的密钥（key_source=env）+ 当前服务商的扁平镜像"""
    cfg = _normalize(_read_raw())
    for p, pc in cfg["providers"].items():
        pc["key_source"] = "config" if pc.get("api_key") else ""
        if not pc.get("api_key") and os.environ.get(ENV_KEYS[p]):
            pc["api_key"], pc["key_source"] = os.environ[ENV_KEYS[p]], "env"
    cur = cfg["providers"][cfg["provider"]]
    cfg.update({"api_key": cur.get("api_key", ""), "model": cur.get("model"), "thinking": bool(cur.get("thinking")), "base_url": cur.get("base_url"), "key_source": cur.get("key_source", "")})
    return cfg


def save_config(patch: dict) -> dict:
    """patch：{provider?, mock?, providers?: {p: {api_key?, model?, thinking?, base_url?}}}，也收扁平 {api_key?, model?, thinking?}（写给当前服务商）。
    api_key 给空串 = 清除。只写文件里的值，不把环境变量里的密钥写回。"""
    cfg = _normalize(_read_raw())
    if patch.get("provider") in PROVIDERS:
        cfg["provider"] = patch["provider"]
    if patch.get("mock") is not None:
        cfg["mock"] = bool(patch["mock"])
    per = {p: dict(v) for p, v in (patch.get("providers") or {}).items() if p in PROVIDERS and isinstance(v, dict)}
    flat = {k: patch[k] for k in ("api_key", "model", "thinking", "base_url") if k in patch and patch[k] is not None}
    if flat:
        per.setdefault(cfg["provider"], {}).update(flat)
    for p, v in per.items():
        pc = cfg["providers"][p]
        if v.get("api_key") is not None:
            pc["api_key"] = str(v["api_key"]).strip()
        if v.get("model"):
            pc["model"] = str(v["model"]).strip()
        if v.get("thinking") is not None and p == "deepseek":
            pc["thinking"] = bool(v["thinking"])
        if v.get("base_url") and p == "deepseek":
            pc["base_url"] = str(v["base_url"]).strip()
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return load_config()


def key_hint(key: str) -> str:
    """打码：只露前缀与末 4 位"""
    if not key:
        return ""
    if len(key) <= 12:
        return "已设置"
    return (key[:7] if key.startswith("sk-ant-") else key[:3]) + "…" + key[-4:]


def public_config() -> dict:
    """给前端看的配置：绝不含密钥明文"""
    cfg = load_config()
    provs = {}
    for p, pc in cfg["providers"].items():
        provs[p] = {"has_key": bool(pc.get("api_key")), "key_hint": key_hint(pc.get("api_key") or ""), "model": pc.get("model"), "key_source": pc.get("key_source", ""), "models": MODEL_CHOICES[p]}
        if p == "deepseek":
            provs[p]["thinking"] = bool(pc.get("thinking"))
    cur = provs[cfg["provider"]]
    return {"provider": cfg["provider"], "provider_label": PROVIDER_LABEL[cfg["provider"]], "mock": bool(cfg["mock"]) or not cur["has_key"], "mock_forced": bool(cfg["mock"]),
            "has_key": cur["has_key"], "key_hint": cur["key_hint"], "model": cur["model"], "key_source": cur["key_source"], "thinking": bool(cur.get("thinking")), "providers": provs}


def config_for(provider: str, cfg: dict | None = None) -> dict:
    """同一份配置换个服务商看（评测脚本 --provider 用）"""
    cfg = dict(cfg or load_config())
    if provider not in PROVIDERS:
        raise ValueError(f"未知服务商 {provider}，可选 {PROVIDERS}")
    pc = cfg["providers"][provider]
    cfg.update({"provider": provider, "api_key": pc.get("api_key", ""), "model": pc.get("model"), "thinking": bool(pc.get("thinking")), "base_url": pc.get("base_url"), "key_source": pc.get("key_source", "")})
    return cfg


def get_ai(cfg: dict | None = None, force_mock: bool = False):
    """按配置选服务商；没密钥 / mock / force_mock 时给 MockAI"""
    cfg = cfg or load_config()
    if force_mock or cfg.get("mock") or not cfg.get("api_key"):
        return MockAI()
    if cfg.get("provider") == "deepseek":
        return DeepSeekAI(cfg["api_key"], cfg.get("model") or DS_DEFAULT_MODEL, cfg.get("base_url") or DS_DEFAULT_BASE_URL, bool(cfg.get("thinking")))
    try:
        return ClaudeAI(cfg["api_key"], cfg.get("model") or CLAUDE_DEFAULT_MODEL)
    except ImportError as e:  # 有密钥却没装 SDK：明说，不悄悄退回模拟
        raise RuntimeError("anthropic SDK 未安装：在仓库根目录执行 .venv\\Scripts\\pip install anthropic，或在 AI 设置里换 DeepSeek / 勾「模拟」") from e


def api_error_types() -> tuple:
    try:
        import anthropic
        return (anthropic.APIError, DeepSeekAPIError)
    except Exception:
        return (DeepSeekAPIError,)


CLAUDE_HINTS = {400: "请求被 API 拒绝：多半是参数或 schema 的问题，把 message 原文发给开发者", 401: "密钥无效、已撤销或格式不对：到 AI 设置里重新粘贴",
                402: "账户计费问题：到 console.anthropic.com 看余额 / 付款方式", 403: "这把密钥没有权限用这个模型或功能",
                404: "模型名不存在或不可用：检查 AI 设置里的模型名（默认 claude-opus-5-5）", 413: "请求过大", 429: "触发限流：等几十秒再试",
                500: "Anthropic 服务异常：稍后重试", 529: "Anthropic 过载：稍后重试"}
DS_HINTS = {400: "请求格式错误：把 message 原文发给开发者", 401: "DeepSeek 密钥无效：到 AI 设置里重新粘贴", 402: "DeepSeek 余额不足：到 platform.deepseek.com 充值",
            422: "参数错误：多半是模型名不对（默认 deepseek-flash）", 429: "请求太频繁：等几十秒再试", 500: "DeepSeek 服务异常：稍后重试", 503: "DeepSeek 繁忙：稍后重试"}
RETRYABLE = {408, 409, 429, 500, 502, 503, 529}


def error_payload(e: Exception) -> dict:
    """服务商的 HTTP / 网络错误 → 前端能诊断的 JSON：状态码、类型、request_id、能否重试、一句中文提示"""
    status = getattr(e, "status_code", None)
    body = getattr(e, "body", None)
    provider = getattr(e, "provider", None) or "anthropic"
    err = body.get("error") if isinstance(body, dict) else None
    etype = err.get("type") if isinstance(err, dict) else None
    if provider == "deepseek" and not etype:
        etype = getattr(e, "etype", None)
    is_timeout = type(e).__name__ == "APITimeoutError" or etype == "APITimeoutError"
    is_conn = status is None
    msg = getattr(e, "message", None) or str(e)
    if provider == "deepseek":
        bad_model = status in (400, 404, 422) and "model" in msg.lower()
        hint = ("模型名不对：检查 AI 设置里的模型名（默认 deepseek-flash）" if bad_model else DS_HINTS.get(status)) \
            or ("等太久没回：再试一次" if is_timeout else "连不上 api.deepseek.com：检查网络 / 代理" if is_conn else "")
    else:
        hint = CLAUDE_HINTS.get(status) or ("等太久没回：再试一次或降低 effort" if is_timeout else "连不上 api.anthropic.com：检查网络 / 代理" if is_conn else "")
    return {"error": "ai", "provider": provider, "message": msg, "status": status, "type": etype or type(e).__name__,
            "request_id": getattr(e, "request_id", None), "retryable": is_conn or status in RETRYABLE, "hint": hint}


# ============================================================ 8. 入口（app.py 的路由）
def _finish(res: dict, ai_obj: Any, t0: float) -> dict:
    ms = int((time.time() - t0) * 1000)
    res.setdefault("provider", getattr(ai_obj, "name", "mock"))
    if not res.get("_usage"):
        res["_usage"] = _usage_zero(getattr(ai_obj, "model", "mock"), ms)
    res["_ms"] = ms
    return res


def _keep_locked(plan: dict, locked: dict | None) -> tuple[dict, list[str]]:
    """「锁」住的项（locked.ids，取自 locked.plan）原样放回新 plan（换一批时不动）"""
    if not locked or not isinstance(locked.get("plan"), dict) or not locked.get("ids"):
        return plan, []
    src = index(locked["plan"])
    p = copy.deepcopy(plan)
    ch = []
    for lid in locked["ids"]:
        if lid not in src:
            continue
        g, el = src[lid]
        if g in ONE_GROUPS:
            if p.get(g) != el:
                p[g] = copy.deepcopy(el)
                ch.append(f"锁·{g}")
            continue
        lst = p.setdefault(g, [])
        k = next((i for i, x in enumerate(lst) if isinstance(x, dict) and x.get("id") == lid), None)
        if k is None:
            lst.append(copy.deepcopy(el))
            ch.append(f"锁·{el.get('label') or lid}")
        elif lst[k] != el:
            lst[k] = copy.deepcopy(el)
            ch.append(f"锁·{el.get('label') or lid}")
    return p, ch


def draft(payload: dict) -> dict:
    """POST /api/ai/draft：{intent, locked?: {plan, ids}, variant?, force_mock?} →
    {plans: [3], constraints: [短语], constraints_fixed: [{plan, fields}], diversity, warnings, provider, _usage, _ms, _fixes?}"""
    intent = str(payload.get("intent") or "").strip()
    if not intent:
        raise ValueError("intent 不能为空")
    t0 = time.time()
    ai_obj = get_ai(force_mock=bool(payload.get("force_mock")))
    cons = extract(intent)
    locked = payload.get("locked") if isinstance(payload.get("locked"), dict) else None
    if locked and isinstance(locked.get("plan"), dict):  # 锁住的 id：显式给的 + plan.locks
        locked = {**locked, "ids": sorted(set(locked.get("ids") or []) | set(locked["plan"].get("locks") or []))}
    variant = int(payload.get("variant") or payload.get("seed") or 0)
    res = ai_obj.draft(intent, cons, locked, variant)
    keep = set((locked or {}).get("ids") or [])
    fixed, warns = [], []
    plans = res.get("plans") or []
    for i, p in enumerate(plans):
        p, ch1 = _keep_locked(p, locked)
        p, ch2 = enforce(p, cons, keep)
        if (ch1 or ch2) and res.get("provider") == "mock":
            p["one_liner"] = describe(p)  # 模拟 AI 的一句话按嫁接后的构成重写，和卡片摘要对得上
        plans[i] = p
        if ch1 or ch2:
            fixed.append({"plan": i, "fields": ch1 + ch2})
        warns += [f"plan {i + 1}：引用不存在 {w}" for w in ref_warnings(p)]
        bad = validate(plan_schema(), p)
        if bad:  # 锁定补出来的东西也必须合 schema
            warns += [f"plan {i + 1}：{e}" for e in bad[:5]]
    res["plans"] = plans
    res["constraints"] = summary(cons)
    res["constraints_fixed"] = fixed
    res["diversity"] = diversity(plans)
    res["warnings"] = warns
    return _finish(res, ai_obj, t0)


RESTATE_MAX = 60  # definitions.revise.restatement.maxLength


def revise(payload: dict, ai_obj: Any = None) -> dict:
    """POST /api/ai/revise：{plan, action: {type:'text', text} | 字符串, locked?: {ids} | [ids], force_mock?} →
    {understood, restatement, ops, question?, ask_to_point, constraints, constraints_fixed, provider, _usage, _ms, _fixes?}"""
    plan, action = payload.get("plan"), payload.get("action")
    if not isinstance(plan, dict) or not action:
        raise ValueError("需要 plan 与 action")
    if isinstance(action, str):
        action = {"type": "text", "text": action}
    lk = payload.get("locked")
    locked_ids = (set(lk.get("ids") or []) if isinstance(lk, dict) else set(lk or [])) | set(plan.get("locks") or [])
    t0 = time.time()
    ai_obj = ai_obj or get_ai(force_mock=bool(payload.get("force_mock")))
    res = ai_obj.revise(plan, action, locked_ids)
    text = str(action.get("text") or "")
    ops = res.get("ops") or []
    res["_model_ops"], res["_model_restatement"] = list(ops), res.get("restatement")
    extra, notes, say = enforce_ops(plan, ops, text, locked_ids) if text else ([], [], [])
    ops = ops + extra
    asks = [s for s in say if s.endswith("？")]
    say = [s for s in say if not s.endswith("？")]
    if asks and not ops:  # 锁定找不到要改的东西：先问，不新增
        res.update(understood=False, ask_to_point=False, question=asks[0], restatement="")
    rs = (res.get("restatement") or "").strip().rstrip("。；")
    key = lambda s: s.split("改成")[-1] if "改成" in s else s[2:] if s.startswith("加了") else s  # noqa: E731  「矿洞改成迷宫平面」→「迷宫平面」
    must = [s for s in say if key(s) not in rs]  # 复述要说到锁定补的事；模型已经说了就不重复
    if must:
        room = RESTATE_MAX - len("；".join(must)) - 2
        rs = "；".join(must) + (("；" + rs[:room]) if rs and room > 4 else "")
    if ops and not res.get("understood"):
        res["understood"], res["ask_to_point"] = True, False
    if ops and not rs:
        rs = describe_ops(plan, ops)[:RESTATE_MAX - 1]
    if not ops and res.get("provider") == "mock" and not rs and not res.get("question"):
        res.update(understood=False, ask_to_point=True, question="是位置、大小，还是长相的事？在图上画一笔或圈一块最准。")
        rs = "这句我没把握翻成结构改动"
    res["ops"] = ops
    rs = rs[:RESTATE_MAX - 1]
    res["restatement"] = rs + ("。" if rs and not rs.endswith(("。", "？", "！")) else "")
    res["constraints"] = summary(extract(text))
    res["constraints_fixed"] = notes
    return _finish(res, ai_obj, t0)


def test_key(payload: dict) -> dict:
    """POST /api/config/test：按服务商发一条最短请求。可带 provider / api_key / model 测还没保存的密钥。"""
    cfg = load_config()
    prov = payload.get("provider") if payload.get("provider") in PROVIDERS else cfg["provider"]
    pc = cfg["providers"][prov]
    key = (payload.get("api_key") or pc.get("api_key") or "").strip()
    model = (payload.get("model") or pc.get("model") or "").strip()
    if not key:
        return {"ok": False, "provider": prov, "message": "没有密钥"}
    try:
        if prov == "deepseek":
            return {"provider": prov, **DeepSeekAI(key, model or DS_DEFAULT_MODEL, pc.get("base_url") or DS_DEFAULT_BASE_URL).ping()}
        import anthropic
        client = anthropic.Anthropic(api_key=key, timeout=30.0, max_retries=0)
        t0 = time.time()
        resp = client.messages.create(model=model or CLAUDE_DEFAULT_MODEL, max_tokens=256, output_config={"effort": "low"}, messages=[{"role": "user", "content": "只回复两个字母：ok"}])
        if resp.stop_reason == "refusal":
            return {"ok": False, "provider": prov, "message": "模型拒绝了测试请求（stop_reason=refusal）", "model": resp.model}
        text = "".join(b.text for b in resp.content if b.type == "text")
        return {"ok": True, "provider": prov, "model": resp.model, "ms": int((time.time() - t0) * 1000), "text": text,
                "usage": {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}}
    except api_error_types() as e:
        p = error_payload(e)
        return {**p, "ok": False, "provider": prov, "message": (p["hint"] + "（" + p["message"] + "）") if p["hint"] else p["message"]}
