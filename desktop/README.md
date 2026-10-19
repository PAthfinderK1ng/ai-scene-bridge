# desktop/ — 本地服务与 AI（v5：场景程序 + 两步生成）

几个内聚的文件，没有互相注入：

| 文件 | 作用 |
| --- | --- |
| `app.py` | 入口。起本地服务（只监听 127.0.0.1，默认随机端口；拒绝外部 Origin），用系统 WebView2（pywebview）开窗口加载 `/medium/`；没有 WebView2 时退回 Edge `--app`，再不行用默认浏览器。`--no-window` 只起服务，`--port N` 固定端口。`/api/*` 路由见下表 |
| `ai.py` | **问什么**：提示词（构思 / 展开 / 改动）、后处理（本地修 / 夹取 / 校验）、模拟 AI、`DeepSeekAI` / `ClaudeAI`（= 底层客户端 + 构思 / 展开 / 改动）、两步编排 `generate`、入口 `draft` / `revise`。`plans.py` / `rules.py` / `providers.py` 的名字在这里全部再导出，外部只用 `ai.X` |
| `providers.py` | **怎么问**（v5 从 ai.py 拆出，ai.py 超过 1200 行）：DeepSeek urllib 客户端（json_object、回喂一次、429 / 5xx / 断连重试、调用上限、线程安全）、Claude SDK 客户端（结构化输出、服务端 refusal fallback）、JSON 修复、费用、配置、错误 payload、密钥测试；**下半**：概念 → 场景程序（模拟 AI 的题材配方；真模型某张没写成时的**补位**按那张概念自己搭——terrain_idea 落成抬起 / 坑 / 环 / 湖 / 峡谷，key_structures 逐条出形体并按词挑排法（环 / 夹道 / 一排 / 悬浮 / 散布 / 中轴长堤），只有说到具体结构才借片段；主体 = 第一条关键结构，按数量词 / 形状词出 radial 弧形段、stack 空心塔、grid、linear、高架长台面；地下结构写成 space 的房间；三张骨架雷同时 `diversity.clones` + 警告；题材配方数据在 rules.py）。v5 第 1 轮从 rules.py 拆出 compose.py，第 2 轮验收并进本文件：后端比 v4 只多这一个文件，单文件仍 ≤ ~1200 行 |
| `plans.py` | 场景程序 plan v2 的 schema 与工具（不联网）：读 `spec/plan.schema.json`（单一事实来源）；小校验器、夹取、清洗、给 Claude 的 schema；**语法表** `grammar()`（由 schema 生成，节点按 type、地形按 op 各一行）；场景树遍历、按 id / `towers[2]` 找元素、ops 检查与应用、根节点锚点规则、形体计数与上限 |
| `rules.py` | 本地知识：**片段库**（14 个小结构）、词表、本地锁定（draft / revise 都锁）、**空间组织标签** `organization`（按证据强度只打主体结构的 2–4 个；带台阶边的坑 / 下沉不算台地；有地下 space 或压低 > 6 m、坑里放了东西的坑打「地下」；地形按尺度称重：< 3 m 的槽、窄沟、小池、广告墙不算；网格重复 / 三条以上的渠打「网格」）与三张差异 `diversity`。角色词（神殿 / 城堡 / 书库 / 广场 / 祭坛）在程序名字 / 概念 / 关键结构里说到了就算有，没说到给现有主体改名，不另加盒子；「空中」没满足时把主体所在的组整体抬成悬空，不往每张塞同一组浮岛 |
| `test_app.py` | 全部后端测试（模拟 AI、假 urllib、假 anthropic client，不联网不花钱）：`python -X utf8 desktop\test_app.py` |
| `build.bat` | PyInstaller 打包 → `dist\SceneDialog\SceneDialog.exe`（带上 `medium/ spec/ tools/`） |

```bat
.venv\Scripts\python -X utf8 desktop\app.py                     :: 开窗口
.venv\Scripts\python -X utf8 desktop\app.py --no-window --port 8791
```

## AI 输出什么：场景程序（docs/06 §2）

v4 只开放了名字，没开放结构（地形词表是台地型的、建筑只能撒小房子、提示词示例全是山村）。v5 让 AI 自己搭结构：用形体（box / cylinder / cone / dome / pyramid / wedge / arch / torus / sphere / prism）和建筑件（building / tower / wall / courtyard / stairs / platform / island / water …）组成 `group`，用 `repeat`（linear / grid / radial / along / scatter / mirror / stack）重复，用 `link` 连接，地形用 `terrain[]` 雕刻操作（raise / lower / flatten / terrace / ramp / carve / lake / river / cliff / dune / noise）。台地、撒房子、地下空间变成可选的**生成器节点**（terraces / scatter_houses / space / grove / field），题材需要才用。

坐标规则：**组内可以写米制的尺寸与偏移**（size_m / offset_m / rotate_deg / spacing_m / radius_m / path_m），**根节点只能用锚点**（`site.N`、`hall.top`、`towers[2]`、地形操作 id），全局摆放交给引擎（落地 / 避让 / 路由 / 检查）。后端兜住这条：根节点没锚点 → `at: site.center` 并丢掉它的 offset；`position / x / z` 之类一律去掉。

## 两步生成（docs/06 §3）

1. **构思**（1 次短调用，约 0.5k 入 / 0.5k 出）：三个空间概念 `{name, concept, key_structures[≤5], terrain_idea, why_different}`。系统提示没有固定例句和维度清单：先想题材自己的空间逻辑（功能怎么组织、人怎么走、为什么在这儿、灵魂结构），再给三个由不同设计动机（叙事 / 动线 / 地形 / 功能 / 象征 / 尺度 / 年代 / 社群…）驱动、空间组织明显不同的概念；明说不套「一个往上、一个铺开或在水上、一个往地下」的三分法，不要默认台地 + 撒房子；why_different 写设计动机。每次请求从 `ai.LENSES`（22 个空间组织原则：轴线仪式、环形向心、水网、岛链、巨物残骸…）随机抽 2 个「视角」写进用户消息（可以借鉴，不必照用；至少一个概念不用视角、只从题材的灵魂结构出发；why_different 不引用视角名），抽到的记进 `_steps[0].lenses`。
2. **展开**（3 次调用，`concurrent.futures` 线程池**并行**）：每个概念写成一段程序。系统提示 = 铁律 + 由 schema 生成的**语法表** + **片段库**（14 个小片段，每个 2–5 行：环形塔群、轴线院落、悬浮群岛 + 光桥、峡谷栈道、地下大厅、港口码头 + 防波堤、阶梯金字塔、窄巷层叠楼、城墙 + 门楼、湖心岛、瀑布台阶、台地村落、迷宫空间、崖顶城堡），**不给整张示例**；明说「不要默认用台地 / 撒房子」「名字随便起」「组内可以写米制尺寸与偏移，根节点只能用锚点」。user 文本里给本张概念 + 另两张概念（不要撞）。展开与改动共用同一个系统提示（前缀缓存）。
3. 每张展开各自：`json_object` → 本地修 JSON（围栏 / 尾逗号 / 没转义的引号与换行 / **深层嵌套里多或少的括号**）→ 去多余字段 → 房间补 id、links 房间名换 id → 锚在 `X.top` 又写 `elev_m = X 高度` 的去掉 → 根节点锚点 → ref 字段去部位 → id 去重 → 形体 ≤ 600 → 夹取 → 可选字段的小错删掉 → 校验；不合格把错误清单**回喂一次**。还不行：**用同一概念重新调一次**；再不行：**模拟 AI 按同一概念补那一张**，在 `sources` / `fills` / `warnings` 里标注。
4. 构思调用两轮都不合格 → 概念改用模拟 AI 的，展开照样走模型（`_concepts_fallback`）；服务商 HTTP 错误（401 / 402 …）照常抛出。

## /api

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/health` | — | `{ok, version, mock, provider, provider_label, model, thinking, root}` |
| `GET /api/config` | — | `{provider, provider_label, mock, mock_forced, has_key, key_hint, model, key_source, thinking, providers: {anthropic, deepseek: {has_key, key_hint, model, models, key_source, thinking?}}}`，没有明文 |
| `POST /api/config` | `{provider?, mock?, providers?: {deepseek: {api_key?, model?, thinking?, base_url?}, anthropic: {api_key?, model?}}}`，也收扁平 `api_key / model / thinking`；`api_key: ""` = 清除 | 同 GET |
| `POST /api/config/test` | `{provider?, api_key?, model?}` | `{ok, provider, model, ms, text, usage}` 或 `{ok: false, message, status, hint}` |
| `GET /api/plan/schema` | — | `spec/plan.schema.json` 原样 |
| `POST /api/ai/draft` | `{intent, locked?: {plan, ids?}, variant?, force_mock?, max_calls?}`（max_calls 1–8，本次最多几次 HTTP，默认 8，超了那张由模拟 AI 补位） | 见下 |
| `POST /api/ai/revise` | `{plan, action: "一句话" 或 {type: "text", text}, locked?: {ids} 或 [ids], force_mock?}` | 见下 |
| `POST /api/score` | `{intent: sid, readback, map?, auto_map?}` | `tools/score_readback.py` 的比对结果 |
| `POST /api/save` | `{name, content}` | `{ok, path}`（写到 `%LOCALAPPDATA%\ai-scene-bridge\exports\`） |
| `POST /api/validate` | `{doc, schema: "plan" \| "sid"}` | `{ok, errors, count, engine}` |

draft 响应：

```jsonc
{ "plans": [plan, plan, plan],              // 场景程序 v2，已经过本地锁定，合 plan.schema.json；plan.concept / key_structures 来自构思
  "concepts": [{"name": "星穹塔院", "concept": "…", "key_structures": ["…"], "terrain_idea": "…", "why_different": "它往天上竖着堆叠；另两个…"}, ×3],
  "sources": ["deepseek", "deepseek", "mock"],  // 每张是谁写的（mock = 补位）
  "fills": [{"plan": 2, "reason": "schema: …"}],  // 补位的那几张和原因
  "constraints": ["海", "港口"],             // 「按你的话锁定了：…」
  "constraints_fixed": [{"plan": 1, "fields": ["补港口（港口码头 + 防波堤）"]}],  // 哪张被本地补了什么（= 模型漏掉的）
  "diversity": {"org_pairwise": [4, 2, 6], "org_min": 2, "organization": [["垂直", "环形"], ["地下"], ["水上"]],
                "presets": [[], [], []], "pairwise": [5, 6, 6], "min": 5, "dims": ["ground", "organization", "terrain", "types", "patterns", "links"]},
  "warnings": ["plan 2：引用不存在 nodes[3].at → hall2", "plan 3：模型这张没写成，用模拟 AI 按同一概念补位（…）"],
  "provider": "deepseek" | "claude" | "mock",
  "_usage": {"input", "output", "cache_read", "calls": 4, "cost_cny", …,   // 三步合计
             "parts": {"concepts": {…}, "expand": [{…}, {…}, {…}]}, "expand_wall_ms": 6100},
  "_steps": [{"step": "concepts", "ms", "provider", "usage"}, {"step": "expand", "k": 0, "ms", "attempts", "feedback", "provider", "usage", "errors"?}, …],
  "_ms": 10200, "_fixes"?: ["plan 2：…"], "_concepts_fallback"?: true }
```

revise 响应：

```jsonc
{ "understood": true, "restatement": "法师塔改成 8 个。",   // ≤ 60 字
  "ops": [{"op": "set", "id": "towers", "field": "count", "value": 8}],   // 已逐条校验，可直接 applyOps
  "question": null | "一句追问", "ask_to_point": false,
  "constraints": ["8 个塔"], "constraints_fixed": ["加浮岛"],   // 本地补的 op
  "provider": "...", "_usage": {...}, "_ms": 1800, "_model_ops": [...], "_model_restatement": "..." }
```

- `ops` 作用在程序树上（`spec/plan.schema.json` 的 `definitions.op_*`）：
  - `{op: "set", id, field, value}`：`id` 是节点 / 地形操作 id（树里任何深度），或 `site / spawn / lighting / plan`（根上的 name / concept / mood / palette）；`field` 可以是嵌套路径（`size_m.1`、`connect.via`、`child.roof`）；`id` 写 `towers[2]` 只改那个实例（写进 repeat 的 `overrides`）；`value: null` 删字段。值按该字段 schema 校验，越界夹回。
  - `{op: "add", to, value, index?}`：`to` = `root`（也收 `nodes`）/ `terrain` / `relations` / 某个能装子节点的节点 id（加成它的 children；repeat 不行）。值按节点 / 地形操作 / 关系 schema 校验，id 重了本地改名，没写 id 本地补。
  - `{op: "remove", id}`：删节点（连子树）/ 地形操作；`towers[2]` 只删一个实例（写进 `skip`）；关系用 `rel:<序号>`。
  - 不合法的 op 不会出现在响应里；`id / locks / skip / overrides / layout_seed` 不能直接 set；锁住的 id（含它的实例）一律不动。
- `locked`：draft 时 `{plan, ids}`（ids 缺省取 `plan.locks`）——这些项原样放回三张新程序（同 id 的替换，没有的挂到根上、沿用父组锚点），新程序的 `locks` 记下；revise 时碰到这些 id 的 op 丢掉。
- `variant`：换一批的批次号（模拟 AI 轮换配方；真模型在提示里说「换三种之前没用过的空间组织」）。
- `force_mock: true`：这次走模拟 AI（演示 / 截图 / 测试用，不花钱）。
- 失败：AI 回来了但不能用 → 502 `{error: "ai_<kind>", kind: refusal|truncated|empty|bad_json|schema|budget, message, errors?, usage}`（只有构思步会这样抛；展开步会补位）；服务商 HTTP / 网络错误 → 502 `{error: "ai", provider, status, type, request_id, retryable, hint}`；参数错 → 400。

## 本地锁定（不花钱、不靠模型自觉）

`ai.extract(句子)` 读出说死的条件，`ai.enforce(plan, 条件)` 写死到每一张上，`ai.enforce_ops(plan, ops, 句子)` 在 revise 时补 op。补上的东西按**片段库**拼、锚到主体旁（`hall.E` + 组内偏移）或场地上没用过的方位（`site.NE`），不写全局坐标。

- 时段（黄昏 / 夜里 / 清晨…；「夜市 / 霓虹」也算夜里）。
- **点了名的结构**（三张都要有对应节点，label 含这个词或 type 对得上；没有就按片段 / 模板补一个）：塔（法师塔 / 钟楼 / 灯塔…）、浮岛、码头 / 港口、金字塔、神殿 / 寺 / 庙 / 殿、城墙、城堡、桥（吊桥 → rope_bridge，连两个根节点）、栈道、瀑布、门楼、雕像、大树、水晶、庭院、广场、祭坛、图书馆、招牌、船、礁石、花园、森林。
- **数量**：「七座法师塔」「三座浮岛」→ 对应 repeat 的 count（没有就补一个环形重复）。
- **规模**：「一角 / 小」→ `site.size_m` 80–140；「宏大 / 巨大」→ 260–400。
- **地形词** → `site.ground` 或地形操作：湖 → lake 操作（或 ground lake）、海 / 港口 / 海盗 → ground coast、沙漠 → desert（或 dune 操作）、峡谷 → carve、悬崖 → raise edge cliff、山城 / 山上 → mountain（或 raise）、岛 → island、河 / 溪 → river；「空中 / 云上」→ 至少一处悬空（浮岛）。
- **地下空间**：迷宫 → `space.layout: maze`；矿洞 → galleries（同句说了迷宫就是 maze）；地宫 → halls；溶洞 → network；地窖 → chamber；「两层的」→ `sublevels`；「岔路多」→ `branching: high`；「从井下去」→ `connect.via: well`。同层、布局已经对的空间直接改名认领，不重复加。
- 从哪边进 → `spawn.at: site.<方向>`。
- revise 也锁：「去掉法师塔」→ 删那组 repeat；「加一座浮岛」→ add 片段；「矿洞是个迷宫」→ set layout=maze 并在复述里写「矿洞改成迷宫平面」；模型已经做到了就不补、不重复说。

## 模拟 AI

没有密钥、勾了模拟或 `force_mock` 时用。构思按**题材配方**轮换给三个空间组织不同的概念：每个题材 4–6 个组织（学院 → 塔环 / 水网书院 / 中轴书院 / 浮空 / 环廊 / 地宫；港口 → 炮台海港 / 残垣港 / 环湾泊地 / 海蚀洞寨 / 水上棚寨；神殿 → 轴线金字塔 / 绿洲神殿 / 列柱长廊 / 峡谷崖庙 / 沉沙地宫；夜市、空中花园、山城、迷宫、城堡同理；没命中的题材用轴线 / 浮空 / 峡谷 / 湖心通用配方），一批里最多一个往上、最多一个往下，不出「上 / 水 / 地下」三分法。带片段的配方按片段库拼程序，只写概念的（auto）由 recipe_from_concept 按词搭。除了山城，不会出现台地 / 撒房子。revise 认「再高一点 / 大一点 / 小一点 / 多两座 / 少一些 / 散开 / 收拢 / 悬空 / 落地 / 换成穹顶 / 转一下 / 更陡 / 岔路多 / 去掉 X」，加 / 删词表里的结构、时段、迷宫由本地锁定补。确定性：同输入同结果，`variant` 换配方。

## 服务商

配置在 `%LOCALAPPDATA%\ai-scene-bridge\config.json`（`{provider, mock, providers: {anthropic: {...}, deepseek: {...}}}`；旧的扁平 `{api_key, model}` 视为 anthropic，下次保存时迁移），或环境变量 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`。网页只看得到 `has_key` 与打码的 `key_hint`。

**DeepSeek（默认）**：标准库 urllib，`/chat/completions`，`response_format: json_object`，思考默认关。max_tokens：构思 1500、展开 6000、改动 2000（开思考各加 8000）。429 / 5xx / 断连重试 1 次，超时 120 s。`max_calls` 是一个实例最多发几次 HTTP（超了抛 `AIError(budget)`，带上第一轮的 schema 错与回包开头；并行时先保证每张都有第一次请求）。没有回喂预算、只错 ≤ 3 个节点时本地去掉出错节点（`salvage_plan`）后用这张，救不回才由模拟补位。`/api/ai/draft` 每次 HTTP 的原样回包落到 `%LOCALAPPDATA%\ai-scene-bridge\logs\`（不含请求头 / 密钥，系统提示只记长度）。费用按官方人民币价目（deepseek-flash 每百万 token：缓存命中 0.04 / 0.02，未命中 2 / 1，输出 8 / 4 元，高峰 / 空闲）记在 `_usage.cost_cny`，draft 是三步合计、`parts` 是分项。

**Claude**：官方 `anthropic` SDK，`output_config.format = json_schema`（构思用构思 schema，展开用 `{plan}` + 场景树定义，改动用 revise schema）。发前 `ai.claude_schema()` 剥掉 API 不支持的约束、`oneOf → anyOf`、`definitions → $defs`、每个对象 `additionalProperties: false`，op 的「任意值」换成能表达的 anyOf；回来后同一套本地后处理。Opus 5.5 不传 `thinking` / 采样参数，构思 / 展开 `effort: low`、改动 `medium`；默认开服务端 refusal fallback。本机没有 Claude 密钥，这条路径只用假 client 测过；场景树是递归 schema，真机结构化输出是否接受**没有验证**。

## 评测

```bat
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --mock
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --provider deepseek --only q01,q03 --max-calls 8
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --replay build\eval\raw-v5.json --only q01,q03
```

写 `build\eval\plans-v5.json`（模型原样 + 锁定后的程序 + 概念）、`build\eval\report-v5.md`（每步耗时 / token / 费用、展开是否一次过 schema、补位、三张的空间组织标签与两两差、台地 / 撒房子、锁定补了什么）、`build\eval\raw-v5.json`（每次 HTTP 的原样回包）。`--replay` 用记录的回包离线重放整条流程（改了后处理 / 锁定后验证，不花钱）。真机记录见 `build\eval\deepseek-v5.md`。
