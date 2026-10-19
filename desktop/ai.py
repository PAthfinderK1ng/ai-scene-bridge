# -*- coding: utf-8 -*-
"""
ai.py — 「场景对话」的全部 AI（跑在本地 Python 服务里，密钥不进浏览器）

AI 写**场景程序**（plan v2，docs/06 §2）：形体组成组，组可以嵌套、重复，相对彼此定位；地形用雕刻操作组合。
组内可以写米制尺寸与偏移，根节点只用锚点；落地 / 避让 / 路由 / 检查交给引擎（medium/engine/plan.js）。

两步生成（docs/06 §3）：
1. 构思（一次短调用）：三个由不同设计动机驱动、空间组织不同的概念 {name, concept, key_structures, terrain_idea, why_different}；
   系统提示不给固定例句 / 维度清单，每次随机抽 2 个「视角」（LENSES）写进用户消息作可选参考（至少一个概念不用视角、只从题材的灵魂结构出发），抽到的记进 _steps[0].lenses
2. 展开（三次调用，线程池并行）：每个概念写成一段场景程序；各自 json_object + 本地校验 / 夹取 / 修复 / 回喂一次；
   失败用同一概念重试一次，再失败用模拟 AI 补那一张并标注。

后端文件：
- plans.py：schema（spec/plan.schema.json 是单一事实来源）、小校验器、夹取、语法表、场景树工具、ops 检查与应用
- rules.py：本地知识——片段库、词表、空间组织标签与三张差异、本地锁定（draft / revise 都锁）
- providers.py：服务商底层（DeepSeek urllib 客户端、Claude SDK 客户端、JSON 修复、费用、配置、错误、密钥测试）
  + 概念 → 场景程序（模拟 AI 的题材配方；真模型某张没写成时按概念补位，不套预设）
- ai.py（本文件）：提示词（含用户偏好 memory_context、引用 / 历史）、后处理、三个实现（MockAI / DeepSeekAI / ClaudeAI = 底层客户端 + 构思 / 展开 / 改动）、两步编排 generate。
  plans.py / rules.py / providers.py 的名字在这里再导出，外部只用 ai.X。
- app.py：入口 draft / revise（两步之后的收尾、本地锁定、记忆库、本地「记住」识别）与场景存储、HTTP 路由。
"""
from __future__ import annotations

import concurrent.futures as cf
import copy
import json
import os
import random
import re
import sys
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from plans import (  # noqa: E402
    AI_FORBIDDEN,
    API_UNSUPPORTED,
    LIST_GROUPS,
    MAX_SHAPES,
    NO_SET_FIELDS,
    ONE_GROUPS,
    ROOT_ANCHOR_KEYS,
    ROOT_LISTS,
    _FILE_CACHE,
    _defs,
    _load_json,
    _set_path,
    all_nodes,
    all_refs,
    anchor_base,
    api_schema,
    apply_ops,
    cap_shapes,
    check_ops,
    clamp,
    config_path,
    data_dir,
    dedupe_ids,
    deref,
    example_plans,
    describe_ops,
    field_schema,
    fix_roots,
    fix_sub_anchors,
    grammar,
    has_key,
    index,
    item_schema,
    new_id,
    node_types,
    normalize_refs,
    plan_props,
    plan_schema,
    ref_warnings,
    resolve,
    resource_root,
    shape_count,
    spec_path,
    strip_extra,
    to_ref,
    validate,
    walk_nodes,
)  # noqa: F401
from rules import (  # noqa: E402
    ORG_CN,
    diversity,
    org_scores,
    organization,
    preset_flags,
    signature,
    FRAG,
    FRAGMENTS,
    LAYOUT_CN,
    REMOVE_WORDS,
    SIDE_CN,
    STRUCT_LEX,
    TIME_CN,
    TIME_WORDS,
    add_structure,
    default_space,
    enforce,
    enforce_ops,
    extract,
    fragment_lines,
    has_structure,
    hint,
    instantiate,
    main_id,
    owner_id,
    summary,
)  # noqa: F401

from providers import (  # noqa: E402  概念 → 场景程序
    PALETTES,
    THEMES,
    compose,
    concept_of,
    palette,
    recipe_from_concept,
    auto_recipe,
    recipes_for,
    subject,
)  # noqa: F401
from providers import (  # noqa: E402
    CLAUDE_DEFAULT_MODEL,
    CLAUDE_HINTS,
    CLAUDE_PRICING,
    DS_DEFAULT_BASE_URL,
    DS_DEFAULT_MODEL,
    DS_HINTS,
    DS_MODELS,
    DS_PRICING,
    DS_RETRYABLE,
    ENV_KEYS,
    MODEL_CHOICES,
    PROVIDER_DEFAULTS,
    PROVIDER_LABEL,
    PROVIDERS,
    RETRYABLE,
    AIError,
    ClaudeClient,
    DeepSeekAPIError,
    DeepSeekClient,
    _normalize,
    _read_raw,
    _sum_usage,
    _usage_zero,
    api_error_types,
    config_for,
    error_payload,
    estimate_cost_cny,
    estimate_cost_usd,
    is_peak,
    key_hint,
    load_config,
    public_config,
    repair_json,
    save_config,
    test_key,
)  # noqa: F401


def _one_line(p: Any) -> str:
    return json.dumps(p, ensure_ascii=False, separators=(",", ":"))


# ============================================================ 1. 提示词
CONCEPT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["concepts"],
    "properties": {"concepts": {"type": "array", "minItems": 3, "maxItems": 3, "items": {
        "type": "object", "additionalProperties": False, "required": ["name", "concept", "key_structures", "terrain_idea", "why_different"],
        "properties": {
            "name": {"type": "string", "minLength": 1, "maxLength": 12, "description": "这个地方的名字（随便起）"},
            "concept": {"type": "string", "minLength": 4, "maxLength": 80, "description": "一句话的空间概念"},
            "key_structures": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "string", "maxLength": 24}},
            "terrain_idea": {"type": "string", "maxLength": 50, "description": "地形怎么雕"},
            "why_different": {"type": "string", "maxLength": 80, "description": "它的设计动机，以及空间上和另两个差在哪"}}}}}}
# 记忆（docs/07 §3）：模型发现人表达了**长期**偏好时顺手给的建议（不额外调用）；构思与改动的输出都可以带
MEMORY_KINDS = ("like", "dislike", "rule", "fact")
MEMORY_SUGGEST = {"type": "array", "maxItems": 2, "description": "人表达了长期偏好（不是这一次的改动）时才给，≤ 2 条；没有就省略",
                  "items": {"type": "object", "additionalProperties": False, "required": ["text", "kind"], "properties": {
                      "text": {"type": "string", "minLength": 2, "maxLength": 40}, "kind": {"type": "string", "enum": list(MEMORY_KINDS)}}}}
CONCEPT_SCHEMA["properties"]["memory_suggestions"] = MEMORY_SUGGEST
MEMORY_MAX = 20
MEMORY_KIND_CN = {"like": "喜欢", "dislike": "不喜欢 / 别做", "rule": "规矩", "fact": "关于这个人 / 项目"}
MEMORY_LINE = ('可选 "memory_suggestions": [{"text": "≤30 字", "kind": "like|dislike|rule|fact"}]：只在人这句话流露出**长期**偏好'
               '（以后都、我一向、我喜欢 / 讨厌、我在做某某游戏）时给，≤ 2 条；这一次的改动要求不算，用户偏好里已有的不要重复；没有就省略这个字段。')


def memory_context(items: Any, scene_id: Any = None) -> dict:
    """记忆条目 → {text, ids}：只取启用的、全局的 + 本场景的（scope=scene 只在 scene_id 相同时用），本场景的在前、新的在前，最多 20 条；
    text 按 kind 分组，接在系统提示后面（DeepSeek 拼在后面、Claude 放在缓存断点之后的第二块），明说「这句话说的优先于偏好」。"""
    use = [m for m in items or [] if isinstance(m, dict) and m.get("enabled", True) is not False and str(m.get("text") or "").strip()
           and (m.get("scope") != "scene" or (scene_id and m.get("scene_id") == scene_id))]
    use.sort(key=lambda m: (m.get("scope") != "scene", -float(m.get("created") or 0)))
    use = use[:MEMORY_MAX]
    if not use:
        return {"text": "", "ids": [], "items": []}
    lines = ["用户偏好（跨场景，人以前说过的；只是偏好，不是硬条件。人这句话说的优先于偏好，冲突时照这句话；和题材无关的偏好不用硬套）："]
    for k in MEMORY_KINDS:
        g = [m for m in use if (m.get("kind") if m.get("kind") in MEMORY_KINDS else "rule") == k]
        if g:
            lines.append(MEMORY_KIND_CN[k] + "：")
            lines += [f"- {str(m['text']).strip()[:120]}{'（本场景）' if m.get('scope') == 'scene' else ''}" for m in g]
    return {"text": "\n".join(lines), "ids": [m.get("id") for m in use if m.get("id")], "items": use}
# 构思的「视角」：每次请求随机抽 2 个写进用户消息，只作可选参考（不进系统提示，系统提示里没有任何固定例句或维度清单）
LENSES = [
    "轴线仪式：一条中轴串起门、庭、殿，越往里越庄重", "环形向心：一圈圈围着一个中心，所有东西朝内",
    "线性街巷：沿一条街 / 河 / 栈道展开，两边贴满", "网格街区：规整的棋盘格，街口是节点",
    "簇团：几团各自成组的聚落，团与团之间留空、用路相连", "单体巨构：一个巨大的建筑把所有功能吞进去",
    "层叠立面：贴着一面崖 / 墙一层层往上叠", "下沉院落：从地面往下挖出的院子 / 天井，房间朝院开",
    "峡谷切割：一道沟把场地劈开，两岸对望，桥是关键", "水网：被水道切成小块，桥和船把它们缝起来",
    "岛链：一串大小不一的岛，用桥 / 堤 / 浅滩相连", "悬挑外挂：从主体往外挑出的平台、廊、笼",
    "迷宫：故意绕的路径，岔口、死路、回环", "围合城郭：墙围起来，门是唯一的入口",
    "散落遗迹：零散的残件彼此遥望，空地比建筑多", "蔓生有机：顺着地形 / 根系 / 管线自然长出来，没有直角",
    "朝圣路：一条路一站一站讲故事，终点才是主体", "螺旋上升：绕一个核心螺旋着升起或降下",
    "跨越之城：整个地方长在一座桥 / 坝 / 高架上", "内向中庭：外壁封闭，所有东西面向内院",
    "新旧叠压：新建的长在旧废墟上，看得出两个年代", "巨物残骸：建在一个巨大的东西上或里面（骨架、沉船、陨坑、倒下的雕像）",
]


def draw_lenses(n: int = 2) -> list[str]:
    """每次构思随机抽 n 个视角（不需要确定性：SystemRandom），写进 _steps 方便复盘"""
    return random.SystemRandom().sample(LENSES, n)


def concept_system_prompt() -> str:
    return """你是三维游戏场景的空间构思师。人用一句话说想要什么场景；你给出三个**空间概念**，之后它们会分别被展开成场景程序（形体、组、重复、地形雕刻——什么结构都搭得出来，不受预设限制）。

先在心里想清楚（不用写出来）：这个题材自己的空间逻辑——它的功能怎么组织？人从哪来、怎么走、在哪停？它为什么在这儿？去掉名字以后，什么结构让人一眼认出它（它的灵魂结构）？

再给三个概念，每个由**一个不同的设计动机**驱动，动机从这个题材里找：叙事、动线、地形、功能、象征、尺度、年代、社群……按题材自选。

要求：
1. 三个概念的**空间组织方式**必须明显不同：俯视图和剖面一眼能分开，不是同一个结构换名字、换地面。
2. 不要套「一个往上、一个铺开或在水上、一个往地下」的三分法，也别把高塔、浮岛、地下城当默认答案——题材真的需要才用。名字、结构、地形都从题材里长出来。
3. 不要默认「坡上台地 + 撒小房子」，除非题材就是山村、梯田、民居片区。
4. name ≤ 10 字，像这个地方自己的名字。concept ≤ 60 字。key_structures ≤ 5 条、每条 ≤ 20 字，写清形状、数量、位置关系（不写「建筑群」「若干房屋」）。terrain_idea ≤ 40 字，说地形怎么雕。
5. why_different ≤ 60 字：用这个题材自己的话说设计动机（为什么这样组织），以及空间上和另两个差在哪；不要写「来自某某视角」。超长会被截断。
6. 人这句话里说死的东西（时段、点了名的结构、地形、地下空间、层数、从哪边进）三个概念都要满足，只是满足的方式不同。例：人说「空中花园」，三个都在空中；人说「神殿」，三个的主体都是神殿。
7. 用户消息里可能附两个随机抽的「视角」：可以借鉴，不必照用，和题材不合就忽略；至少一个概念不用视角，只从题材的灵魂结构出发。
8. 文案简体中文，具体、短。
9. 系统提示后面附了「用户偏好」时：和这个题材相关的（时段、氛围、不要的东西）三个概念都要体现，并写进 concept 或 key_structures（例：喜欢夜景 → concept 里写清是夜里的什么景、靠什么亮）；和题材无关的不用硬套。
10. """ + MEMORY_LINE + """

输出：只输出一个 json 对象，不要 markdown，不要解释：
{"concepts": [{"name": "…", "concept": "一句话", "key_structures": ["…"], "terrain_idea": "…", "why_different": "…"}, …共 3 个]}"""


# 环与放射：片段库之外的几行写法（空心环带 / 竖环 / 放射桥网；字段以 spec/plan.schema.json 为准）
RING_LINES = "\n".join([
    '【环带 / 环形回廊】nodes+= {"type":"cylinder","label":"环形回廊","at":"hall","size_m":[72,5],"hollow":true,"wall_m":6}（空心圆柱 = 一圈带子，wall_m = 带宽，中间是空的）',
    '【绕坑摊道（一圈一圈往下）】terrain+= {"op":"lower","id":"pit","at":"site.center","shape":"circle","size_m":[120,120],"depth_m":18,"edge":"terraced","steps":3}',
    'nodes+= {"type":"cylinder","label":"上圈摊道","at":"pit","size_m":[104,3],"hollow":true,"wall_m":7}',
    'nodes+= {"type":"repeat","pattern":"radial","at":"pit","count":12,"radius_m":34,"face":"center","child":{"type":"box","label":"中圈摊位","size_m":[8,4,5]}}（radial 弧段：一圈切向排开的段）',
    '【竖立的环】nodes+= {"type":"torus","label":"星门","at":"plaza","size_m":[16,1.5],"orient":"upright","rotate_deg":90}',
    '【放射桥网】nodes+= {"id":"pods","type":"repeat","pattern":"radial","at":"hub","count":5,"radius_m":48,"child":{"type":"island","label":"浮台","size_m":[16,6,16],"elev_m":20}}',
    'nodes+= {"type":"repeat","pattern":"radial","at":"hub","count":5,"radius_m":48,"child":{"type":"link","style":"bridge","label":"放射栈桥","from":"hub","to":"pods","width_m":3}}（repeat 的 child 是 link：第 k 座桥从 from 连到 to 的第 k 个实例）',
])


def program_system_prompt() -> str:
    """展开与改动共用的系统提示（稳定前缀，DeepSeek / Claude 都能命中缓存）：铁律 + 由 schema 生成的语法表 + 片段库（不给整张示例）"""
    key = ("prog", os.stat(spec_path("plan.schema.json")).st_mtime)
    if _FILE_CACHE.get("_prog", (None,))[0] == key:
        return _FILE_CACHE["_prog"][1]
    text = f"""你是「场景对话」里的三维游戏场景程序员。你写**场景程序**（JSON），引擎把它编译成几何：落地、避让、连路、检查都由引擎做。

铁律：
1. 你自己搭结构：形体（box / cylinder / cone / dome / pyramid / wedge / arch / torus / sphere / prism）与建筑件（building / tower / wall / courtyard / stairs / platform / column / gate / statue / tree / rock / crystal / island / water）组成 group，可以嵌套；repeat 重复（linear 一排 / grid 网格 / radial 环形 / along 沿路 / scatter 散布 / mirror 镜像 / stack 叠层），child 可以是任何节点（含 group / repeat）；link 连接（path / road / stairs / ramp / bridge / rope_bridge / tunnel / canal / portal）。地形用 terrain 雕刻操作按顺序叠（抬起 / 压低 / 削平 / 台阶化 / 坡道 / 开沟 / 成湖 / 河 / 立崖 / 沙丘 / 起伏）。
2. 坐标：组内可以写米制的 size_m / offset_m / rotate_deg / spacing_m / radius_m / path_m（局部坐标，x 东、z 南、y 上）；**根节点只能用 at 锚点**（site.center、site.N、hall.top、towers[2]、地形操作 id），可以带 offset_m（相对锚点），不写全局坐标。
   锚点 = id 或 id.部位（部位只有 top / bottom / center / N / S / E / W / NE / NW / SE / SW / inner / outer / start / mid / end / left / right）；沟 / 河这类线形地形的 .W / .NE / .left / .right 是那一侧的岸（两岸对望 = 一组锚 trench.left、一组锚 trench.right，桥 from trench.left 到 trench.right）；组里的子节点直接写它自己的 id（"obelisk"、"hall.top"），不要写成 "组id.子id"。
   repeat 的方向：linear 默认沿 x（东西）排，沿南北排要写 axis:"z"；mirror axis:"x" = 左右翻（x → −x），模板必须有 x 偏移，不然两份重合成一份；axis:"z" = 前后翻。
   对称一对（街口两根广告柱）= {{"type":"repeat","pattern":"mirror","axis":"x","at":"street.N","child":{{"type":"cylinder","offset_m":[13,0],…}}}}——偏移写在 child 上，不写在 repeat 上。
   夹道（两排柱子 / 石像夹着一条南北向的路）= {{"type":"repeat","pattern":"mirror","axis":"x","child":{{"type":"repeat","pattern":"linear","axis":"z","count":6,"spacing_m":11,"offset_m":[-8,0],"child":{{"type":"column",…}}}}}}。
   elev_m 只给真正悬空的东西（锚在 X.top 上的已经落在 X 顶面，不要再写 elev_m = X 的高度）。高架渠 / 天桥 / 栈道 / 空中步道：elev_m 只写在桥面上（或只装桥面的组上），墩、柱、拱、门写在组外或加 ground:"snap"；组里没有桥面就别给组写 elev_m（组的 elev_m 会把组里所有东西一起抬高）。形体的 children：不写 elev_m 立在父体顶上；写了 elev_m = 离父体底面（离地）的高度，挂在立面上——外挂平台 / 招牌 / 阳台 = {{"type":"building","size_m":[16,58,14],"children":[{{"type":"platform","offset_m":[11,0],"elev_m":26,"size_m":[6,1,10]}}]}}。螺旋梯 = stairs + shape:"cylinder"（size_m [直径, 高]）。地形操作只能锚到 site.*、前面的地形操作和人画的标记（marks 的 id）。layout=rooms 的房间都要有英文 id，links 用房间 id（入口写 "entry"）。
   环形的走道 / 回廊 / 摊带 / 环廊写成空心圆柱（hollow:true，wall_m = 带宽）或 radial 弧段，不要写实心圆柱（实心的会变成一面鼓盖住中间）。竖着立的环（星门、环门）= torus + orient:"upright"。
3. **不要默认用台地 / 撒房子**（terraces、scatter_houses、terrace 操作、edge terraced），除非题材真的需要（山村、梯田、民居片区）。
4. 名字随便起：label 用人话（法师塔、光桥、海盗码头、禁书地窖）。id 用英文小写短名，被引用的才必须写；引用只能指向本程序里已有的 id，或 site / spawn。
5. 人这句话里说死的东西（时段、点了名的结构、地形、地下空间的布局与层数、从哪边进）必须有。
6. 规模：根节点 ≤ 40，children ≤ 32，展开后形体 ≤ {MAX_SHAPES}，地形操作 ≤ 16；嵌套别超过 4 层（宁可多几个根节点），括号要配对。场地 size_m 一般 160–260 米；形体尺寸按真实世界（房子 8–15 m，塔 20–40 m，主殿 25–40 m）。
7. 设计因果：最重要的地标写 role: landmark；spawn.at 定玩家从哪进、look_at 看它；relations 写 visible_from / reachable；用 link 把出生点、地标、各组连起来。
8. 文案简体中文，具体、短。

语法（? = 可选；同一行的 type 共用字段；size_m 各分量按 type 理解）：
{grammar()}

片段库（小结构的写法：按需组合、改尺寸、改数量、改名字、换锚点；不要只用这些，更不要每张都用同一套）：
{fragment_lines()}
{RING_LINES}

输出格式：只输出一个 json 对象，不要 markdown 代码块，不要解释，不要出现语法表以外的字段，可选字段不用就省略（不要写 null）。"""
    _FILE_CACHE["_prog"] = (key, text)
    return text


def system_prompt() -> str:
    """旧名：展开 / 改动的系统提示"""
    return program_system_prompt()


def _locked_lines(locked: dict | None) -> str:
    if not (locked and isinstance(locked.get("plan"), dict) and locked.get("ids")):
        return ""
    idx = index(locked["plan"])
    keep = [idx[i][1] for i in locked["ids"] if i in idx]
    return ("人锁住了这几项，原样保留（id 不变），其它的重新构成：\n" + "\n".join(_one_line(e) for e in keep)) if keep else ""


def concept_user_text(intent: str, cons: dict, locked: dict | None, variant: int = 0, lenses: list | None = None) -> str:
    parts = [f"人说：「{intent}」", "给出 3 个由不同设计动机驱动、空间组织明显不同的概念。"]
    h = hint(cons)
    if h:
        parts.append(h)
    lk = _locked_lines(locked)
    if lk:
        parts.append(lk.replace("原样保留", "三个概念都要容纳它们"))
    if variant:
        parts.append(f"这是第 {variant + 1} 批：换三种之前没用过的空间组织。")
    if lenses:
        parts.append("随机抽的视角（可以借鉴，不必照用；和题材不合就忽略；至少一个概念不用视角，只从题材的灵魂结构出发；why_different 不要引用视角名）：\n"
                     + "\n".join(f"- {x}" for x in lenses))
    return "\n\n".join(parts)


def expand_user_text(intent: str, cons: dict, concepts: list, k: int, locked: dict | None) -> str:
    c = {kk: v for kk, v in concepts[k].items() if not kk.startswith("_")}
    others = [{kk: v for kk, v in x.items() if kk in ("name", "concept")} for i, x in enumerate(concepts) if i != k]
    parts = [f"人说：「{intent}」",
             f"三张卡里你写第 {k + 1} 张，概念：{_one_line(c)}",
             "另两张是（不要和它们撞，空间组织要不同）：" + "；".join(_one_line(o) for o in others)]
    h = hint(cons)
    if h:
        parts.append(h)
    lk = _locked_lines(locked)
    if lk:
        parts.append(lk)
    parts.append("把这个概念写成一段场景程序，输出 {\"plan\": {...}}。name 用概念名，concept 用概念那句话，key_structures 照抄；"
                 "概念里的关键结构都要在 nodes 里出现（label 带上它的名字）；terrain_idea 落成 site.ground + terrain 操作。")
    return "\n\n".join(parts)


def _mark_brief(m: dict) -> dict:
    """提示词里的标记：不给坐标（AI 不写坐标，也不用读），只给 id / 类 / 名字 / 大小"""
    out = {k: m[k] for k in ("id", "type", "label") if k in m}
    pts = m.get("polygon_m") or m.get("path_m")
    if isinstance(pts, list) and pts and all(isinstance(q, list) and len(q) >= 2 for q in pts):
        xs, zs = [float(q[0]) for q in pts], [float(q[1]) for q in pts]
        if m.get("type") == "area":
            out["size_m"] = [round(max(xs) - min(xs)), round(max(zs) - min(zs))]
        else:
            out["length_m"] = round(sum(((xs[i + 1] - xs[i]) ** 2 + (zs[i + 1] - zs[i]) ** 2) ** 0.5 for i in range(len(xs) - 1)))
    return out


def _turn_text(t: Any, n: int = 80) -> str:
    """历史里的一条压成一句：第一句、≤ n 字"""
    s = re.sub(r"\s+", " ", str(t or "")).strip()
    first = re.split(r"(?<=[。！？!?])", s)[0] if len(s) > n else s
    return first[:n] + ("…" if len(first) > n or len(s) > len(first) else "")


HISTORY_ROUNDS = 10  # 只带最近 10 轮（人 + AI 各一条算一轮）


def history_lines(history: Any) -> tuple[list[str], str]:
    """history → (提示词里的行, 上一轮的提示)：上一轮 AI 没生效（ops 0 / effect 说没有看得见的变化）→ 换改法；生效了 → 同方向加大"""
    hs = [h for h in history or [] if isinstance(h, dict) and str(h.get("text") or "").strip()][-2 * HISTORY_ROUNDS:]
    lines = []
    for h in hs:
        if h.get("role") in ("ai", "assistant"):
            extra = [f"ops {h['ops']}" if isinstance(h.get("ops"), int) else "", f"效果：{_turn_text(h.get('effect'), 100)}" if h.get("effect") else ""]
            extra = [x for x in extra if x]
            ids = [str(x) for x in h.get("ids") or [] if isinstance(x, str)][:12]
            extra = extra[:1] + ([f"动了 {', '.join(ids)}"] if ids else []) + extra[1:]
            lines.append(f"AI：{_turn_text(h.get('text'))}" + (f"（{'；'.join(extra)}）" if extra else ""))
        else:
            rids = [str(x) for x in h.get("refs") or [] if isinstance(x, str)][:8]
            lines.append(f"人：{_turn_text(h.get('text'))}" + (f"（指：{', '.join(rids)}）" if rids else ""))
    last = next((h for h in reversed(hs) if h.get("role") in ("ai", "assistant")), None)
    if not last:
        return lines, ""
    eff = str(last.get("effect") or "")
    if last.get("ops") == 0 or re.search("没有看得见|没生效|没有变化|没变化", eff):
        return lines, "上一轮 AI 的改动没生效（ops 为 0 或效果说没有看得见的变化）：人说「还是没改 / 再来」时换一种改法（换字段、换节点、直接加东西），别重复上一轮。"
    return lines, ("上一轮的改动生效了：人说「还不够 / 再来 / 还是太…」时沿同一方向、对同一处加大力度（数量 / 尺寸 / 高度 ×1.5 以上，或加东西）；"
                   "只动上一轮动过的那些 id（AI 那行的「动了 …」）、人指的那块和锚在它上面的东西，场景里别的部分不要顺手改。")


def _ref_line(r: dict) -> str:
    return _one_line({k: r[k] for k in ("kind", "id", "instance", "label", "facts") if k in r})[:420]


def revise_user_text(plan: dict, action: dict, locked_ids: list | None, refs: Any = None, history: Any = None) -> str:
    view = plan
    if plan.get("marks"):
        view = {**plan, "marks": [_mark_brief(m) for m in plan["marks"] if isinstance(m, dict)]}
    parts = ["当前场景程序：\n" + _one_line(view)]
    if plan.get("marks"):
        parts.append("marks 是人在图上画的标记（坐标是人给的，你看不到也不要写）：area（圈的一块）→ at:\"mark_1\" 放在它中心、area:\"mark_1\" 在它范围里散布 / 生成；"
                     "trace（画的一笔）→ along:\"mark_2\" 沿线重复 / 连接；pin（点的位置）→ at:\"mark_3\"。地形操作的 at 也可以写标记 id。标记只能引用，不能 set / remove / add。"
                     "锚到 area 标记上的东西要放得下：水平尺寸（环 / 放射重复按直径 = 2×半径 + 子件、直线重复按 个数×间距）不超过这个标记的 size_m（marks 里和引用的 facts 里都有）；加密度（加个数）时间距跟着缩，个数×间距 仍不超过那一边。"
                     "复述里说位置时照 facts.from_landmark（相对主地标的方位、距离）说，不要猜方位。")
    rl = [r for r in refs or [] if isinstance(r, dict) and r.get("id")][:12]
    fresh, carried = [r for r in rl if not r.get("carried")], [r for r in rl if r.get("carried")]
    if fresh:
        parts.append("人加到对话里的东西（「这 / 这里 / 这块 / 这个 / 它」优先指这些；facts 是引擎算的事实）：\n" + "\n".join(_ref_line(r) for r in fresh))
    if carried:
        parts.append("这句没有新加引用，是接着上一轮说的；上一轮人指的是下面这些（facts 按现在的程序重新算过）——「还是 / 再 / 更 / 这里…」说的还是它们，"
                     "改动落在它们、锚在它们上面的东西和上一轮动过的东西上；句子里点名了别的才去改别的：\n" + "\n".join(_ref_line(r) for r in carried))
    hl, tip = history_lines(history)
    if hl:
        parts.append("最近的对话（旧 → 新；效果 = 引擎算的改动摘要）：\n" + "\n".join(hl) + ("\n" + tip if tip else ""))
    parts.append("人的动作（程序已转成结构化事实，不是像素）：\n" + json.dumps(action, ensure_ascii=False))
    parts += [
             "只输出对当前程序的改动：{\"understood\": true, \"restatement\": \"≤60 字复述\", \"ops\": [...], \"ask_to_point\": false}，需要追问时加 \"question\"。\n"
             "ops：\n"
             "- {\"op\":\"set\",\"id\":\"towers\",\"field\":\"count\",\"value\":8}：id 是节点 / 地形操作的 id（树里任何深度），或 site / spawn / lighting / plan（根上的 name / concept / mood / palette）；"
             "field 可以是嵌套路径（size_m.1、connect.via、child.roof）；id 写 towers[2] 只改第 3 个实例；value 为 null 删掉该字段。\n"
             "- {\"op\":\"add\",\"to\":\"root\" | \"terrain\" | \"relations\" | 某个 group 的 id,\"value\":{完整的节点 / 地形操作 / 关系}}\n"
             "- {\"op\":\"remove\",\"id\":\"x\"}（towers[2] 只删一个实例；关系用 rel:<序号>）\n"
             "只放真要改的，不要把整段程序抄回来。改空间布局就 set 它的 layout（迷宫 = maze），复述里写「改成迷宫平面」这样的话。"
             "翻不成结构改动时（模糊的形容词）：understood=false、ask_to_point=true、ops=[]，在 restatement 里问清是位置、大小还是长相"
             + ("（人已经加了引用 / 接着上一轮的引用：先按引用去改，别再请人指）。" if rl else "。"), MEMORY_LINE]
    if locked_ids:
        parts.append("锁住、不能改的 id：" + ", ".join(locked_ids))
    return "\n\n".join(parts)


# ============================================================ 6. schema、后处理
def _defs_key(root: dict) -> str:
    return "$defs" if "$defs" in root else "definitions"


def ai_view(schema: Any) -> Any:
    """AI 看到 / 要写的 schema：去掉人写的字段（locks、layout_seed）、旧字段、实例改动（skip / overrides）与 x-* 提示"""
    if isinstance(schema, list):
        return [ai_view(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k.startswith("x-"):
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: ai_view(pv) for pk, pv in v.items() if pk not in AI_FORBIDDEN}
            if "required" in schema:
                out["required"] = [r for r in schema["required"] if r in out[k]]
        elif k == "required" and "properties" in schema:
            continue
        else:
            out[k] = ai_view(v)
    return out


def plan_out_schema() -> dict:
    """展开调用的输出 {plan}：plan 本体与定义都从 spec/plan.schema.json 来（AI 视图）"""
    root = plan_schema()
    k = _defs_key(root)
    plan = {kk: v for kk, v in root.items() if kk not in ("definitions", "$defs", "$schema", "$id", "title", "description")}
    return ai_view({"type": "object", "properties": {"plan": {"$ref": f"#/{k}/plan"}}, "required": ["plan"], "additionalProperties": False,
                    k: {**_defs(root), "plan": plan}})


def revise_schema() -> dict:
    """{understood, restatement, ops, question?, ask_to_point}：ops 取 plan.schema.json 的 definitions.ops；value 的细节由 check_ops 查"""
    root = plan_schema()
    k = _defs_key(root)
    defs = _defs(root)
    rv = (defs.get("revise") or {}).get("properties") or {}
    return {"type": "object", "properties": {
        "understood": {"type": "boolean", "description": "是否把人的话翻成了可执行的 ops"},
        "restatement": {**(rv.get("restatement") or {"type": "string"}), "description": "一句话复述改了什么"},
        "ops": {"$ref": f"#/{k}/ops"} if "ops" in defs else {"type": "array", "items": {"type": "object"}},
        "question": rv.get("question") or {"type": ["string", "null"]},
        "ask_to_point": {"type": "boolean", "description": "翻不了时为 true：请人在图上指"},
        "memory_suggestions": MEMORY_SUGGEST},
        "required": ["understood", "restatement", "ops", "ask_to_point"], "additionalProperties": False, k: defs}


def claude_schema(schema: dict, revise_mode: bool = False) -> dict:
    """发给 Claude 的 schema：api_schema 之后，把 op 里「任意值」换成能表达的 anyOf（结构化输出要求每个对象 additionalProperties=false）"""
    s = api_schema(ai_view(schema))
    defs = s.get("$defs") or {}
    if revise_mode and "op_set" in defs and "op_add" in defs:
        defs["op_add"]["properties"]["value"] = {"anyOf": [{"$ref": f"#/$defs/{d}"} for d in ("node", "terrain_op", "relation") if d in defs]}
        defs["op_set"]["properties"]["value"] = {"anyOf": [
            {"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"},
            {"type": "array", "items": {"type": "number"}}, {"type": "array", "items": {"type": "string"}},
            {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
            *([{"$ref": "#/$defs/node"}] if "node" in defs else []), *([{"type": "array", "items": {"$ref": "#/$defs/palette_entry"}}] if "palette_entry" in defs else [])]}
    return s


def _del_at(data: Any, path: str) -> bool:
    """按 "$.nodes[0].children[2].role" 删一个字段（只删对象里的键）"""
    parts = re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path[1:])
    cur = data
    for name, i in parts[:-1]:
        cur = cur[int(i)] if i else (cur.get(name) if isinstance(cur, dict) else None)
        if cur is None:
            return False
    name, i = parts[-1] if parts else (None, None)
    if name and isinstance(cur, dict) and name in cur:
        del cur[name]
        return True
    return False


def _get_at(data: Any, path: str) -> tuple[Any, str | None]:
    parts = re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path[1:])
    cur = data
    for name, i in parts[:-1]:
        cur = cur[int(i)] if i else (cur.get(name) if isinstance(cur, dict) else None)
        if cur is None:
            return None, None
    return cur, (parts[-1][0] if parts else None)


def soft_repair(schema: dict, data: Any, errors: list[str], fixes: list[str]) -> None:
    """不值得回喂的小错本地修（省一次调用）：可选字段的枚举外取值 / 锚点带了不认识的部位 / 可选字段类型不对 → 去部位或删掉这个字段"""
    for e in errors:
        m = re.match(r"(\$[^:]*): (.*)$", e)
        if not m:
            continue
        path, msg = m.group(1), m.group(2)
        parent, key = _get_at(data, path)
        if not isinstance(parent, dict) or key is None or key in ("type", "op", "id", "name", "site", "nodes"):
            continue
        val = parent.get(key)
        if "不匹配" in msg and isinstance(val, str):
            base = re.match(r"^([a-z][a-z0-9_]{0,31}(\[\d{1,3}\])?)", val.strip().lower())
            if base:
                new = "site.center" if base.group(1) == "site" and key in ("at", "from", "to") else base.group(1)
                if new != val:
                    parent[key] = new
                    fixes.append(f"{path}: {val!r} → {new!r}")
                    continue
        if ("不在" in msg or "类型应为" in msg or "不符合任何一种写法" in msg or "不匹配" in msg) and _del_at(data, path):
            fixes.append(f"{path}: {val!r} 不合法，去掉（可选字段）")


def fix_rooms(p: dict, fixes: list) -> None:
    """layout=rooms 的空间：房间没写 id → 按顺序补 r1 r2…；links 里写的是房间名 → 换成 id（实测 flash 常这样写）"""
    for n, path, *_ in walk_nodes(p.get("nodes") or []):
        rooms = n.get("rooms")
        if not isinstance(rooms, list):
            continue
        by_label = {}
        for i, r in enumerate(rooms):
            if isinstance(r, dict):
                if not isinstance(r.get("id"), str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", r["id"]):
                    old = r.get("id")
                    r["id"] = f"r{i + 1}"
                    fixes.append(f"{path}.rooms[{i}].id: {old!r} → {r['id']}")
                    if isinstance(old, str):
                        by_label[old] = r["id"]
                if isinstance(r.get("label"), str):
                    by_label[r["label"]] = r["id"]
        for lk in n.get("links") or []:
            if isinstance(lk, list):
                for j, x in enumerate(lk):
                    if isinstance(x, str) and x in by_label:
                        lk[j] = by_label[x]
                    elif isinstance(x, str) and x in ("入口", "地面", "入口处"):
                        lk[j] = "entry"


def fix_double_elev(p: dict, fixes: list) -> None:
    """锚在地形块顶上（X.top）的东西又写了 elev_m = 那块的高度：引擎已经落在顶面上了，再抬就悬空 → 去掉 elev_m"""
    tops = {t["id"]: float(t.get("height_m") or 0) for t in p.get("terrain") or [] if isinstance(t, dict) and isinstance(t.get("id"), str)}
    for n, path, *_ in walk_nodes(p.get("nodes") or []):
        at, e = n.get("at"), n.get("elev_m")
        if isinstance(at, str) and at.endswith(".top") and isinstance(e, (int, float)) and e > 0:
            h = tops.get(at[:-4])
            if h and abs(h - e) <= max(0.5, 0.1 * h):
                del n["elev_m"]
                fixes.append(f"{path}.elev_m: {e:g} = {at[:-4]} 的高度，已经在顶面上了 → 去掉")


def clean_suggestions(data: dict) -> list[str]:
    """memory_suggestions 写歪了不值得回喂：只留 {text 2–40 字, kind ∈ 四类} 的前 2 条，别的丢掉（kind 不认识按 rule）"""
    v = data.get("memory_suggestions")
    if v is None:
        return []
    good = []
    for x in v if isinstance(v, list) else []:
        t = str((x or {}).get("text") or "").strip()[:40] if isinstance(x, dict) else ""
        if len(t) >= 2:
            good.append({"text": t, "kind": x.get("kind") if x.get("kind") in MEMORY_KINDS else "rule"})
    data.pop("memory_suggestions")
    if good:
        data["memory_suggestions"] = good[:2]
    return [] if good == v else ["memory_suggestions：本地整理"]


def postprocess_concepts(data: Any) -> tuple[dict, list[str], list[str]]:
    if isinstance(data, list):
        data = {"concepts": data}
    if not isinstance(data, dict):
        return {"concepts": []}, [], ["应为 {\"concepts\": [3 个概念]}"]
    if "concepts" not in data:
        for alt in ("ideas", "options", "cards", "plans"):
            if isinstance(data.get(alt), list):
                data = {"concepts": data.pop(alt)}
                break
    fixes = clean_suggestions(data) + strip_extra(CONCEPT_SCHEMA, data)
    for c in data.get("concepts") or []:
        if isinstance(c, dict) and isinstance(c.get("key_structures"), str):
            c["key_structures"] = [x for x in re.split(r"[、，,；;]", c["key_structures"]) if x][:5]
            fixes.append("key_structures: 字符串 → 数组")
    data = clamp(CONCEPT_SCHEMA, data, "$", CONCEPT_SCHEMA, fixes)
    names = [c.get("name") for c in data.get("concepts") or [] if isinstance(c, dict)]
    for i, c in enumerate(data.get("concepts") or []):
        if isinstance(c, dict) and names.count(c.get("name")) > 1 and i:
            c["name"] = (str(c.get("name")) + "二三"[i - 1])[:12]
            fixes.append(f"concepts[{i}].name 重名 → {c['name']}")
    return data, fixes, validate(CONCEPT_SCHEMA, data)


ROOT_ONLY_KEYS = ("site", "terrain", "spawn", "relations", "palette", "lighting", "mood", "key_structures", "one_liner", "locks")


def _looks_root(n: Any, local: set) -> bool:
    """落在组里的节点像不像根节点：锚到组外（site.* / 地形操作 / 别的根节点 / 这个组自己），而不是锚到前面的兄弟"""
    bases = [anchor_base(n.get(k)) for k in ROOT_ANCHOR_KEYS] if isinstance(n, dict) else []
    return any(b and b not in local for b in bases)


def fix_misnested_root(p: dict, fixes: list) -> None:
    """括号少了一截（JSON 修复把缺的闭括号补在了末尾）：根上的键（spawn / relations / palette …）落进了某个节点，
    它前面那串根节点也成了这个节点的 children。把这些键挪回根上；children 里从第一个锚到组外的起，后面整串挪回 plan.nodes（至少留一个）。"""
    for n, path, _, _ in list(walk_nodes(p.get("nodes") or [])):
        keys = [k for k in ROOT_ONLY_KEYS if k in n]
        if not keys:
            continue
        for k in keys:
            v = n.pop(k)
            if p.get(k) in (None, [], {}, ""):
                p[k] = v
                fixes.append(f"plan.{path}.{k}: 括号少了一截，挪回根上")
            else:
                fixes.append(f"plan.{path}.{k}: 根上已有，去掉")
        kids = n.get("children")
        if isinstance(kids, list) and kids:
            j, local = 1, set()
            while j < len(kids):
                local |= {x.get("id") for x, *_ in walk_nodes(kids[j - 1:j]) if x.get("id")}
                if _looks_root(kids[j], local):
                    break
                j += 1
            if j < len(kids):
                tail = kids[j:]
                del kids[j:]
                top = int(re.match(r"nodes\[(\d+)\]", path).group(1)) + 1  # 插回它所在根节点的后面（原来的顺序）
                p["nodes"][top:top] = tail
                fixes.append(f"plan.{path}.children 末尾 {len(tail)} 个像根节点的（{'、'.join(str(t.get('label') or t.get('id') or t.get('type')) for t in tail)}）挪回 plan.nodes")


def postprocess_plan(data: Any) -> tuple[dict, list[str], list[str]]:
    """展开回来的一段程序：包成 {plan}、去多余字段、根节点锚点、ref 去部位、id 去重、形体上限、夹取、小错本地修、校验"""
    if isinstance(data, dict) and isinstance(data.get("plan"), dict):
        p = data["plan"]
    elif isinstance(data, dict) and isinstance(data.get("plans"), list) and data["plans"] and isinstance(data["plans"][0], dict):
        p = data["plans"][0]
    elif isinstance(data, dict) and ("nodes" in data or "site" in data):
        p = data
    else:
        return {"plan": {}}, [], ["应为 {\"plan\": {name, site, terrain?, nodes, …}}"]
    sch = plan_schema()
    fixes: list[str] = []
    if p.pop("marks", None) is not None:
        fixes.append("plan.marks: 标记是人画的，AI 不写，去掉")
    fix_misnested_root(p, fixes)
    fixes += [f"plan{x[1:]}" for x in strip_extra(sch, p)]
    fix_rooms(p, fixes)
    fix_sub_anchors(p, fixes)
    fix_double_elev(p, fixes)
    fix_roots(p, fixes)
    normalize_refs(p, fixes)
    fixes += dedupe_ids(p)
    cap_shapes(p, fixes=fixes)
    p = clamp(sch, p, "$", sch, fixes)
    errors = validate(sch, p)
    if errors:
        soft_repair(sch, p, errors, fixes)
        errors = validate(sch, p)
    return {"plan": p}, fixes, errors


SALVAGE_MAX_NODES = 3  # 没有回喂预算时，最多本地去掉几个出错的节点（再多说明整张写歪了，宁可补位）
_REF_KEYS = ("at", "under", "over", "around", "along", "area")


def salvage_plan(data: Any, errors: list[str]) -> tuple[dict, list[str], list[str]]:
    """展开回包只剩少量错（没有回喂预算 / 回喂后还错）：去掉出错的节点（形体 / 组 / 重复的模板子节点 / 地形操作 / 关系），
    指向它们的连接一并去掉、锚点退回场地中心，再走一遍后处理。救不回（错在 site / name 上，或要去的节点 > 3 个）→ errors 非空。"""
    p = copy.deepcopy((data or {}).get("plan") if isinstance(data, dict) and isinstance(data.get("plan"), dict) else data)
    if not isinstance(p, dict) or not isinstance(p.get("nodes"), list):
        return {"plan": {}}, [], ["没有可救的程序"]
    drop: dict = {}  # id(list) → (list, {idx})
    fixes: list[str] = []
    for e in errors:
        path = e.split(": ", 1)[0]
        parts = re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path[1:])
        if not parts:
            return {"plan": p}, [], errors
        head = parts[0][0]
        if head in ("palette", "lighting", "mood", "look") and head in p:
            p.pop(head)
            fixes.append(f"本地去掉出错的 {head}")
            continue
        if head == "spawn":
            p["spawn"] = {"at": "site.S"}
            fixes.append("本地把出错的出生点换成 site.S")
            continue
        if head in ("terrain", "relations") and len(parts) > 1 and parts[1][1]:
            lst = p.get(head)
            if isinstance(lst, list):
                drop.setdefault(id(lst), (lst, set()))[1].add(int(parts[1][1]))
            continue
        if head != "nodes":
            return {"plan": p}, [], errors
        cur, target, key = p, None, None
        for name, i in parts:
            if name:
                key = name
                cur = cur.get(name) if isinstance(cur, dict) else None
            elif isinstance(cur, list) and int(i) < len(cur):
                if key in ("nodes", "children"):
                    target = (cur, int(i))
                cur = cur[int(i)]
            else:
                break
            if cur is None:
                break
        if target is None:
            return {"plan": p}, [], errors
        drop.setdefault(id(target[0]), (target[0], set()))[1].add(target[1])
    gone: set = set()
    n_nodes = 0
    for lst, idxs in drop.values():
        for i in sorted(idxs, reverse=True):
            if i >= len(lst):
                continue
            el = lst.pop(i)
            if isinstance(el, dict) and "op" in el:
                if isinstance(el.get("id"), str):
                    gone.add(el["id"])
            elif isinstance(el, dict) and "type" in el and "a" not in el:
                n_nodes += 1
                gone |= {n.get("id") for n in all_nodes({"nodes": [el]}) if isinstance(n.get("id"), str)}
            fixes.append(f"本地去掉出错的 {(el.get('label') or el.get('id') or el.get('type') or el.get('op')) if isinstance(el, dict) else el}")
    if n_nodes > SALVAGE_MAX_NODES or not p["nodes"]:
        return {"plan": p}, [], list(errors) + [f"要去掉 {n_nodes} 个节点，太多"]
    if gone:
        def unref(nodes: list, root: bool) -> None:
            for n in list(nodes):
                if not isinstance(n, dict):
                    continue
                if n.get("type") == "link" and any(anchor_base(n.get(k)) in gone for k in ("from", "to")):
                    nodes.remove(n)
                    fixes.append(f"本地去掉连到被删节点的 {n.get('label') or n.get('id')}")
                    continue
                for k in _REF_KEYS:
                    if anchor_base(n.get(k)) in gone:
                        if k == "at" and root:
                            n["at"] = "site.center"
                        else:
                            n.pop(k)
                unref(n.get("children") or [], False)
                if isinstance(n.get("child"), dict):
                    unref([n["child"]], False)
        unref(p["nodes"], True)
        p["relations"] = [r for r in p.get("relations") or [] if not any(anchor_base(r.get(k)) in gone for k in ("a", "b", "c"))]
        if not p["relations"]:
            p.pop("relations")
        if anchor_base((p.get("spawn") or {}).get("look_at")) in gone:
            p["spawn"].pop("look_at")
    out, fx, errs = postprocess_plan({"plan": p})
    return out, fixes + fx, errs


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
    sch = revise_schema()
    fixes += clean_suggestions(data) + strip_extra(sch, data, "$", sch)
    errors = [e for e in validate(sch, data, "$", sch) if not e.startswith("$.ops")]  # ops 的细节交给 check_ops（按节点 schema 查，错误更具体）
    good, op_errs, op_fixes = check_ops(plan, data.get("ops") or [], locked_ids)
    data["ops"] = good if not op_errs else data.get("ops") or []
    return data, fixes + op_fixes, errors + op_errs


# ============================================================ 7. 模拟 AI
class MockAI:
    """模拟 AI：确定性，不联网、不花钱。构思按题材配方轮换给三个空间组织不同的概念（学院 → 水网书院 / 塔环学院 / 中轴书院 …，一批最多一个往上、一个往下），
    展开按片段库拼程序；真模型的某张展开失败时，按那个概念里的词拼一张补位。revise 认常见说法。"""

    name = "mock"
    model = "mock"

    def concepts(self, intent: str, cons: dict, locked: dict | None, variant: int = 0, mem: dict | None = None) -> dict:
        rs = recipes_for(intent, variant)
        out = {"concepts": [{**concept_of(r), "_recipe": auto_recipe(r) if r.get("auto") else r} for r in rs], "_usage": _usage_zero()}
        if mock_suggestions(intent):
            out["memory_suggestions"] = mock_suggestions(intent)
        return out

    def expand(self, intent: str, cons: dict, concepts: list, k: int, locked: dict | None, mem: dict | None = None) -> dict:
        c = concepts[k]
        r = c.get("_recipe") or recipe_from_concept(c)
        likes = " ".join(str(m.get("text")) for m in (mem or {}).get("items") or [] if m.get("kind") != "dislike")
        dislikes = " ".join(str(m.get("text")) for m in (mem or {}).get("items") or [] if m.get("kind") == "dislike" or re.match("不要|别|不许", str(m.get("text"))))
        p = compose(r, None, (cons or {}).get("time_of_day") or extract(likes).get("time_of_day"))  # 偏好：人这句没说时段才用
        if re.search("房子|小屋|民居|村落", dislikes):  # 偏好：不要撒小房子（模拟 AI 只认这一条；真模型读系统提示里的偏好）
            p["nodes"] = [n for n in p.get("nodes") or [] if not (isinstance(n, dict) and n.get("type") == "scatter_houses" and n.get("role") != "landmark")]
        p["name"] = str(c.get("name") or p["name"])[:16]
        p["concept"] = str(c.get("concept") or p.get("concept") or "")[:120]
        p["key_structures"] = [str(x)[:24] for x in (c.get("key_structures") or [])][:6]
        return {"plan": p, "_usage": _usage_zero()}

    def revise(self, plan: dict, action: dict, locked_ids: set, ctx: dict | None = None) -> dict:
        t = str(action.get("text") or action.get("value") or "")
        ops, say = mock_context_ops(plan, t, (ctx or {}).get("refs"), (ctx or {}).get("history"))
        if not ops:
            ops, say = mock_revise_ops(plan, t)
        good, _, _ = check_ops(plan, ops, locked_ids)
        out = {"understood": True, "restatement": "；".join(say), "ops": good, "ask_to_point": False, "provider": "mock", "_usage": _usage_zero()}
        if mock_suggestions(t):
            out["memory_suggestions"] = mock_suggestions(t)
        return out


_PREF_RE = re.compile(r"(?:我|俺)(?:很|最|特别|一直|一向|总是|比较)?(不喜欢|讨厌|受不了|喜欢|偏爱|爱看)([^，。,；;！!？?\s]{1,20})")


def mock_suggestions(t: str) -> list:
    """模拟 AI 的记忆建议：「我喜欢夜景」「我讨厌对称」这种长期偏好的说法 → [{text, kind}]（≤ 2 条）"""
    out = [{"text": (v + o)[:30], "kind": "dislike" if v in ("不喜欢", "讨厌", "受不了") else "like"} for v, o in _PREF_RE.findall(t or "")
           if not re.search("这|那|它", o)]  # 「我不喜欢这个塔」是这一次的改动
    return out[:2]


_HERE_WORDS = ("这里", "这块", "这儿", "这片", "此处", "那里", "那块", "它", "这个", "这")
_MAKE_RE = re.compile(r"(?:做成|改成|变成|弄成|建成|搞成|放|加|建|盖|摆|弄)(?:一个|一片|一座|一些|一圈|一排|个|片|座|些)?([一-鿿]{2,6})")
_MORE_RE = re.compile(r"还是太?(空|稀|少|小|矮|平)|还是没(改|变)|还不够|再来|再多|再密|太空了|太稀|没改|没变化")


def mock_context_ops(plan: dict, t: str, refs: Any, history: Any) -> tuple[list, list[str]]:
    """模拟 AI 用引用与历史：「这里做成夜市」→ 在引用的标记 / 节点上加一组（area / along / at 锚到它）；
    「还是太空了」→ 看历史上一轮改的那一处（引用的、或上一轮 AI 那句话里点名的），数量 ×1.5（没生效就连尺寸一起放大）、再加一圈灯柱"""
    idx = index(plan)
    refs = [r for r in refs or [] if isinstance(r, dict) and anchor_base(r.get("id")) in idx]
    if _MORE_RE.search(t) and history:
        return _mock_more(plan, t, refs, history)
    m = _MAKE_RE.search(t)
    if not (m and refs and (any(w in t for w in _HERE_WORDS) or not _named(plan, t))):
        return [], []
    what = re.sub("[了吧吗呢啊的]+$", "", m.group(1))[:8] or "一组"
    r = refs[0]
    g, el = idx[anchor_base(r["id"])]
    rid = r["id"] + (f"[{r['instance']}]" if isinstance(r.get("instance"), int) else "")
    base = next((v for k, v in (("市", "market"), ("摊", "market"), ("林", "grove"), ("树", "grove"), ("园", "garden"), ("塔", "towers"), ("房", "houses")) if k in what), "spot")
    child = ({"type": "tree", "label": "树", "size_m": [8, 12]} if base == "grove" else
             {"type": "box", "label": f"{what}摊位", "size_m": [4, 3, 4]} if base == "market" else {"type": "building", "label": what, "size_m": [10, 7, 10]})
    node = {"id": new_id(plan, base), "type": "repeat", "label": what, "child": child}
    if g == "mark" and el.get("type") == "area":
        node.update(pattern="scatter", area=rid, count=12)
    elif g == "mark" and el.get("type") == "trace":
        node.update(pattern="along", along=rid, count=8, spacing_m=10)
    else:
        node.update(pattern="grid", at=rid, rows=3, cols=4, spacing_m=8)
    return [{"op": "add", "to": "root", "value": node}], [f"在{r.get('label') or el.get('label') or rid}里放了{what}"]


def _mock_more(plan: dict, t: str, refs: list, history: list) -> tuple[list, list[str]]:
    last = next((h for h in reversed(history) if isinstance(h, dict) and h.get("role") in ("ai", "assistant")), None)
    if not last:
        return [], []
    dead = last.get("ops") == 0 or "没有看得见" in str(last.get("effect") or "")
    said = str(last.get("text") or "") + str(last.get("effect") or "")
    ref_ids = {anchor_base(r["id"]) for r in refs}
    cands = [n for n in all_nodes(plan) if n.get("id") in ref_ids]
    cands += [n for n in all_nodes(plan) if isinstance(n.get("label"), str) and len(n["label"]) >= 2 and n["label"] in said]
    cands += [n for n in plan.get("nodes") or [] if isinstance(n, dict) and any(anchor_base(n.get(k)) in ref_ids for k in ("at", "area", "along"))]
    cands += [n for n in reversed(plan.get("nodes") or []) if isinstance(n, dict)][:1]
    rep = next((x for n in cands for x in [n] + [c for c in n.get("children") or [] if isinstance(c, dict)]
                if x.get("type") == "repeat" and x.get("id") and isinstance(x.get("count") or x.get("rows"), int)), None)
    if rep is None:
        return [], []
    lab = rep.get("label") or (rep.get("child") or {}).get("label") or rep["id"]
    ops, say = [], []
    if isinstance(rep.get("count"), int):
        n = min(60, -(-rep["count"] * 3 // 2))
        ops.append({"op": "set", "id": rep["id"], "field": "count", "value": n})
        say.append(f"{lab}从 {rep['count']} 个加到 {n} 个")
    else:
        ops.append({"op": "set", "id": rep["id"], "field": "rows", "value": rep["rows"] + 2})
        say.append(f"{lab}多两排")
    sz = (rep.get("child") or {}).get("size_m")
    if dead and isinstance(sz, list):
        ops.append({"op": "set", "id": rep["id"], "field": "child.size_m", "value": [round(v * 1.4, 1) for v in sz]})
        say.append("上一轮没看出变化，这次连尺寸一起放大")
    if re.search("空|稀|少|不够", t):
        anchor = {k: rep[k] for k in ("area", "along", "at") if rep.get(k)} or {"at": rep["id"]}
        lamp = {"id": new_id(plan, "lamps"), "type": "repeat", "label": "灯柱", "pattern": "scatter" if "area" in anchor else "along" if "along" in anchor else "radial",
                "count": 8, **anchor, **({"radius_m": 14} if not ({"area", "along"} & set(anchor)) else {}), "child": {"type": "box", "label": "灯柱", "size_m": [0.5, 5, 0.5]}}
        ops.append({"op": "add", "to": "root", "value": lamp})
        say.append("加了一圈灯柱")
    return ops, say


def _named(plan: dict, t: str) -> dict | None:
    """句子里提到名字（label）的节点：最长的那个"""
    hits = [n for n in all_nodes(plan) if isinstance(n.get("label"), str) and len(n["label"]) >= 2 and n["label"] in t]
    hits += [n for n in all_nodes(plan) if isinstance(n.get("label"), str) and len(n["label"]) >= 2 and n not in hits
             and any(w in t and w in n["label"] for w in ("塔", "殿", "岛", "桥", "墙", "门", "台", "院", "楼", "阁", "堡", "巷"))]
    return max(hits, key=lambda n: len(n["label"])) if hits else None


def _rid(plan: dict, n: dict) -> str | None:
    """节点的 id；repeat 的模板没有 id 时用它的 repeat（字段写 child.xxx）"""
    if isinstance(n.get("id"), str):
        return n["id"]
    for x in all_nodes(plan):
        if x.get("child") is n and isinstance(x.get("id"), str):
            return x["id"]
    return None


def mock_revise_ops(plan: dict, t: str) -> tuple[list, list[str]]:
    """模拟 AI 的改动：更高 / 大一点 / 小一点 / 多几座 / 少几座 / 悬空 / 落地 / 散开 / 收拢 / 屋顶 / 转 / 更陡 / 岔路多。
    加 / 去掉 / 夜里 / 迷宫这些由本地锁定（enforce_ops）补。"""
    ops: list = []
    say: list[str] = []
    n = _named(plan, t)
    if any(w in t for w in REMOVE_WORDS):  # 「去掉环崖石阶」：句子里点名的节点（词表里的结构由本地锁定删）
        rid = owner_id(plan, n) if n is not None else None
        if rid:
            ops.append({"op": "remove", "id": rid})
            say.append(f"去掉了{n.get('label') or rid}")
        return ops, say
    tgt = n or next((x for x in all_nodes(plan) if x.get("role") == "landmark"), None)
    rep = None
    if n is not None:
        rep = next((x for x in all_nodes(plan) if x.get("type") == "repeat" and (x.get("child") is n or x is n)), None)
    rep = rep or next((x for x in all_nodes(plan) if x.get("type") == "repeat" and isinstance(x.get("count"), int) and x.get("pattern") not in ("mirror", "stack")), None)

    def scaled(node, idx, k):
        sz = node.get("size_m")
        if isinstance(sz, list) and len(sz) > idx:
            v = list(sz)
            v[idx] = round(v[idx] * k, 1)
            return v
        return None
    if re.search("更高|高一点|再高|拔高|加高", t) and tgt is not None:
        v = scaled(tgt, 1, 1.3)
        rid = _rid(plan, tgt)
        if v and rid:
            ops.append({"op": "set", "id": rid, "field": "size_m" if tgt.get("id") else "child.size_m", "value": v})
            say.append(f"{tgt.get('label') or rid}加高到 {v[1]:g} m")
    if re.search("大一点|更大|再大|放大", t):
        if n is not None and _rid(plan, n):
            sz = n.get("size_m")
            v = [round(x * 1.25, 1) for x in sz] if isinstance(sz, list) else round(float(sz or 10) * 1.25, 1)
            ops.append({"op": "set", "id": _rid(plan, n), "field": "size_m" if n.get("id") else "child.size_m", "value": v})
            say.append(f"{n.get('label')}放大两成半")
        else:
            sz = (plan.get("site") or {}).get("size_m") or [200, 200]
            sz = sz if isinstance(sz, list) else [sz, sz]
            v = [min(400, round(x * 1.2)) for x in sz]
            ops.append({"op": "set", "id": "site", "field": "size_m", "value": v})
            say.append(f"场地放大到 {v[0]}×{v[1]} m")
    elif re.search("小一点|更小|再小|缩小", t):
        sz = (plan.get("site") or {}).get("size_m") or [200, 200]
        sz = sz if isinstance(sz, list) else [sz, sz]
        v = [max(60, round(x * 0.8)) for x in sz]
        ops.append({"op": "set", "id": "site", "field": "size_m", "value": v})
        say.append(f"场地缩到 {v[0]}×{v[1]} m")
    m = re.search(r"(多|少)(一|两|几|三|些|点)", t)
    if m and rep is not None and rep.get("id"):
        d = {"一": 1, "两": 2, "三": 3}.get(m.group(2), 2) * (1 if m.group(1) == "多" else -1)
        v = max(1, int(rep.get("count") or 1) + d)
        ops.append({"op": "set", "id": rep["id"], "field": "count", "value": v})
        say.append(f"{(rep.get('child') or {}).get('label') or rep.get('label') or rep['id']}改成 {v} 个")
    if re.search("散开|半径大|离远|分散", t) and rep is not None and rep.get("id") and rep.get("radius_m"):
        ops.append({"op": "set", "id": rep["id"], "field": "radius_m", "value": round(rep["radius_m"] * 1.3, 1)})
        say.append("环的半径放大三成")
    elif re.search("收拢|靠近一点|半径小|挤一点", t) and rep is not None and rep.get("id") and rep.get("radius_m"):
        ops.append({"op": "set", "id": rep["id"], "field": "radius_m", "value": round(rep["radius_m"] * 0.75, 1)})
        say.append("环的半径收小")
    if re.search("悬空|飘起来|浮起来|飞起来", t) and tgt is not None and _rid(plan, tgt):
        ops.append({"op": "set", "id": _rid(plan, tgt), "field": "elev_m" if tgt.get("id") else "child.elev_m", "value": 24})
        say.append(f"{tgt.get('label')}悬空 24 m")
    elif re.search("落地|贴地|放到地上", t) and tgt is not None and _rid(plan, tgt):
        ops.append({"op": "set", "id": _rid(plan, tgt), "field": "elev_m" if tgt.get("id") else "child.elev_m", "value": 0})
        say.append(f"{tgt.get('label')}落地")
    roof = next((v for w, v in (("穹顶", "dome"), ("尖顶", "spire"), ("平顶", "flat"), ("人字", "gable"), ("锥顶", "cone"), ("攒尖", "pyramid"), ("四坡", "hip")) if w in t), None)
    if roof:
        b = n if n is not None and n.get("type") in ("building", "tower") else next((x for x in all_nodes(plan) if x.get("type") in ("building", "tower") and x.get("role") == "landmark"), None) \
            or next((x for x in all_nodes(plan) if x.get("type") in ("building", "tower")), None)
        if b is not None and _rid(plan, b):
            ops.append({"op": "set", "id": _rid(plan, b), "field": "roof" if b.get("id") else "child.roof", "value": roof})
            say.append(f"{b.get('label')}换成{next(w for w, v in (('穹顶', 'dome'), ('尖顶', 'spire'), ('平顶', 'flat'), ('人字', 'gable'), ('锥顶', 'cone'), ('攒尖', 'pyramid'), ('四坡', 'hip')) if v == roof)}")
    if re.search("转一下|转个方向|旋转|转45|转 45", t) and tgt is not None and _rid(plan, tgt) and tgt.get("id"):
        ops.append({"op": "set", "id": tgt["id"], "field": "rotate_deg", "value": ((tgt.get("rotate_deg") or 0) + 45) % 360})
        say.append(f"{tgt.get('label')}转 45°")
    if re.search("陡", t):
        tr = next((x for x in plan.get("terrain") or [] if x.get("op") in ("raise", "cliff") and x.get("id")), None)
        if tr:
            ops.append({"op": "set", "id": tr["id"], "field": "height_m", "value": round((tr.get("height_m") or 12) * 1.3, 1)})
            ops.append({"op": "set", "id": tr["id"], "field": "edge", "value": "cliff"})
            say.append(f"{tr.get('label') or tr['id']}更高更陡")
    if re.search("岔路多|更绕|复杂一点", t):
        sp = next((x for x in all_nodes(plan) if x.get("type") == "space" and x.get("layout") in ("maze", "galleries", "network") and x.get("id")), None)
        if sp:
            ops.append({"op": "set", "id": sp["id"], "field": "branching", "value": "high"})
            say.append(f"{sp.get('label')}岔路更多")
    return ops, say


# ---------- 两家服务商：底层在 providers.py，这里加「问什么」
def _sys(base: str, mem: dict | None) -> Any:
    """系统提示 + 用户偏好：(稳定前缀, 偏好)；没有偏好就是前缀本身（providers.structured 两种都收）"""
    return (base, mem["text"]) if mem and mem.get("text") else base


class DeepSeekAI(DeepSeekClient):
    """DeepSeek：构思 / 展开 / 改动（系统提示 + 用户偏好 + 用户文本 + 本地后处理）"""

    def concepts(self, intent: str, cons: dict, locked: dict | None, variant: int = 0, mem: dict | None = None) -> dict:
        lenses = draw_lenses()
        d = self.structured(_sys(concept_system_prompt(), mem), concept_user_text(intent, cons, locked, variant, lenses), postprocess_concepts, self.MAX_TOKENS["concepts"])
        d["_lenses"] = lenses
        return d

    def expand(self, intent: str, cons: dict, concepts: list, k: int, locked: dict | None, mem: dict | None = None) -> dict:
        return self.structured(_sys(program_system_prompt(), mem), expand_user_text(intent, cons, concepts, k, locked), postprocess_plan, self.MAX_TOKENS["expand"], salvage=salvage_plan)

    def revise(self, plan: dict, action: dict, locked_ids: set, ctx: dict | None = None) -> dict:
        ctx = ctx or {}
        data = self.structured(_sys(program_system_prompt(), ctx.get("mem")), revise_user_text(plan, action, sorted(locked_ids), ctx.get("refs"), ctx.get("history")),
                               lambda d: postprocess_revise(d, plan, locked_ids), self.MAX_TOKENS["revise"])
        data["provider"] = self.name
        return data


class ClaudeAI(ClaudeClient):
    """Claude：构思 / 展开 / 改动（结构化输出的 schema 由本文件生成；偏好放在缓存断点之后的第二个系统块）"""

    def concepts(self, intent: str, cons: dict, locked: dict | None, variant: int = 0, mem: dict | None = None) -> dict:
        lenses = draw_lenses()
        d = self.structured(_sys(concept_system_prompt(), mem), concept_user_text(intent, cons, locked, variant, lenses), claude_schema(CONCEPT_SCHEMA), postprocess_concepts, "low")
        d["_lenses"] = lenses
        return d

    def expand(self, intent: str, cons: dict, concepts: list, k: int, locked: dict | None, mem: dict | None = None) -> dict:
        return self.structured(_sys(program_system_prompt(), mem), expand_user_text(intent, cons, concepts, k, locked), claude_schema(plan_out_schema()), postprocess_plan, "low")

    def revise(self, plan: dict, action: dict, locked_ids: set, ctx: dict | None = None) -> dict:
        ctx = ctx or {}
        d = self.structured(_sys(program_system_prompt(), ctx.get("mem")), revise_user_text(plan, action, sorted(locked_ids), ctx.get("refs"), ctx.get("history")),
                            claude_schema(revise_schema(), True), lambda x: postprocess_revise(x, plan, locked_ids), "medium")
        d["provider"] = self.name
        return d


MAX_CALLS_CAP = 8  # 一次 draft 最多发几次 HTTP（构思 1 + 展开 3 + 回喂 / 重试）；payload.max_calls 只能往小里设


def _max_calls(v: Any) -> int | None:
    """payload.max_calls → 1..MAX_CALLS_CAP；没给 / 不合法 = MAX_CALLS_CAP（一次出卡最坏也只花 8 次调用的钱，超了那张由模拟 AI 补位）"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return MAX_CALLS_CAP
    return max(1, min(MAX_CALLS_CAP, n))


def get_ai(cfg: dict | None = None, force_mock: bool = False, max_calls: int | None = None):
    """按配置选服务商；没密钥 / mock / force_mock 时给 MockAI。max_calls：本次最多发几次 HTTP（DeepSeek；超了那一张由模拟 AI 补位）"""
    cfg = cfg or load_config()
    if force_mock or cfg.get("mock") or not cfg.get("api_key"):
        return MockAI()
    if cfg.get("provider") == "deepseek":
        return DeepSeekAI(cfg["api_key"], cfg.get("model") or DS_DEFAULT_MODEL, cfg.get("base_url") or DS_DEFAULT_BASE_URL, bool(cfg.get("thinking")), max_calls=max_calls,
                          log_dir=os.path.join(data_dir(), "logs"))  # 每次 HTTP 的原样回包（不含密钥）
    try:
        return ClaudeAI(cfg["api_key"], cfg.get("model") or CLAUDE_DEFAULT_MODEL)
    except ImportError as e:  # 有密钥却没装 SDK：明说，不悄悄退回模拟
        raise RuntimeError("anthropic SDK 未安装：在仓库根目录执行 .venv\\Scripts\\pip install anthropic，或在 AI 设置里换 DeepSeek / 勾「模拟」") from e


# ============================================================ 8. 两步编排（入口 draft / revise 在 app.py：收尾、本地锁定、记忆）
def _err_text(e: Exception) -> str:
    if isinstance(e, AIError):
        return f"{e.kind}: {e}"
    return f"{type(e).__name__}: {getattr(e, 'message', None) or e}"


def generate(ai_obj: Any, intent: str, cons: dict, locked: dict | None = None, variant: int = 0, mem: dict | None = None) -> dict:
    """两步：构思 1 次 → 展开 3 次（线程池并行）。某张展开失败 → 同一概念重试一次 → 再失败用模拟 AI 补那一张（sources / fills 标注）。
    构思调用不合格（AIError）→ 用模拟 AI 的概念继续（_concepts_fallback 标注）；服务商 HTTP 错误照常抛出。
    mem：memory_context() 的结果，接在每次调用的系统提示后面；构思回包里的 memory_suggestions 原样带出。"""
    t0 = time.time()
    steps: list = []
    mk = {"mem": mem} if mem and mem.get("text") else {}
    try:
        c = ai_obj.concepts(intent, cons, locked, variant, **mk)
        concepts = c["concepts"]
        cu = c.get("_usage")
        cfix = c.get("_fixes") or []
        concept_src = getattr(ai_obj, "name", "mock")
    except AIError as e:
        c = MockAI().concepts(intent, cons, locked, variant, **mk)
        concepts, cu, cfix, concept_src = c["concepts"], e.detail.get("usage"), [f"构思调用不能用（{_err_text(e)}），概念改用模拟 AI 的"], "mock"
    steps.append({"step": "concepts", "ms": int((time.time() - t0) * 1000), "provider": concept_src, "usage": cu, **({"lenses": c["_lenses"]} if c.get("_lenses") else {})})

    def one(k: int) -> dict:
        s0 = time.time()
        if hasattr(ai_obj, "begin_task"):
            ai_obj.begin_task()
        used, errs, first, sample = None, [], [], ""
        for attempt in range(2):
            try:
                r = ai_obj.expand(intent, cons, concepts, k, locked, **mk)
                first += list(r.get("_retry_errors") or [])  # 回喂前那一轮的 schema 错（看模型反复错在哪个字段）
                return {"k": k, "plan": r["plan"], "usage": _sum_usage(used, r.get("_usage")), "fixes": r.get("_fixes") or [], "feedback": bool(r.get("_retried")),
                        "attempts": attempt + 1, "errors": errs, "first_errors": first[:12], "source": getattr(ai_obj, "name", "mock"),
                        "ms": int((time.time() - s0) * 1000), **({"salvaged": True} if r.get("_salvaged") else {})}
            except AIError as e:
                errs.append(_err_text(e))
                first += [str(x) for x in (e.detail.get("errors") or [])[:12]]  # budget 也带第一轮的 schema 错（providers.structured）
                if e.detail.get("sample"):
                    sample = str(e.detail["sample"])[:300]
                used = _sum_usage(used, e.detail.get("usage"))
                if e.kind == "budget":
                    break
            except api_error_types() as e:
                errs.append(_err_text(e))
        r = MockAI().expand(intent, cons, concepts, k, locked, **mk)
        return {"k": k, "plan": r["plan"], "usage": used, "fixes": [], "feedback": False, "attempts": len(errs), "errors": errs, "first_errors": first[:12], "source": "mock",
                "ms": int((time.time() - s0) * 1000), **({"first_sample": sample} if sample else {})}
    t1 = time.time()
    if hasattr(ai_obj, "pending_first"):  # 调用上限先保证每张都有第一次，回喂排在后面
        ai_obj.pending_first = len(concepts)
    if getattr(ai_obj, "name", "mock") == "mock":
        outs = [one(k) for k in range(len(concepts))]
    else:
        with cf.ThreadPoolExecutor(max_workers=3) as ex:
            outs = list(ex.map(one, range(len(concepts))))
    total = cu
    for o in outs:
        total = _sum_usage(total, o["usage"])
        steps.append({"step": "expand", "k": o["k"], "ms": o["ms"], "attempts": o["attempts"], "feedback": o["feedback"], "provider": o["source"], "usage": o["usage"],
                      **({"errors": o["errors"]} if o["errors"] else {}), **({"first_errors": o["first_errors"]} if o.get("first_errors") else {}),
                      **({"first_sample": o["first_sample"]} if o.get("first_sample") else {}), **({"salvaged": True} if o.get("salvaged") else {})})
    total = dict(total or _usage_zero(getattr(ai_obj, "model", "mock")))
    total["parts"] = {"concepts": cu, "expand": [o["usage"] for o in outs]}
    total["expand_wall_ms"] = int((time.time() - t1) * 1000)
    fixes = [f"构思：{x}" for x in cfix] + [f"plan {o['k'] + 1}：{x}" for o in outs for x in o["fixes"]]
    res = {"plans": [o["plan"] for o in outs], "concepts": [{k: v for k, v in c.items() if not k.startswith("_")} for c in concepts],
           "sources": [o["source"] for o in outs],
           "fills": [{"plan": o["k"], "reason": o["errors"][-1] if o["errors"] else "调用上限"}
                     for o in outs if o["source"] == "mock" and getattr(ai_obj, "name", "mock") != "mock"],
           "provider": getattr(ai_obj, "name", "mock"), "_usage": total, "_steps": steps, "memory_suggestions": list(c.get("memory_suggestions") or [])}
    if concept_src != getattr(ai_obj, "name", "mock"):
        res["_concepts_fallback"] = True
    if fixes:
        res["_fixes"] = fixes
    return res
