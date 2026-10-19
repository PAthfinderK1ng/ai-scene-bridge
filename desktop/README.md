# desktop/ — 本地服务与 AI（v4）

三个文件，没有互相注入：

| 文件 | 作用 |
| --- | --- |
| `app.py` | 入口。起本地服务（只监听 127.0.0.1，默认随机端口；拒绝外部 Origin），用系统 WebView2（pywebview）开窗口加载 `/medium/`；没有 WebView2 时退回 Edge `--app`，再不行用默认浏览器。`--no-window` 只起服务，`--port N` 固定端口。`/api/*` 路由见下表 |
| `ai.py` | 和模型打交道的部分：提示词、JSON 修复、DeepSeek / Claude / 模拟三个实现、配置与费用、入口 `draft` / `revise` / `test_key`（`app.py` 的路由直接调）；`plans.py` 与 `rules.py` 的名字在这里全部再导出，外部只用 `ai.X` |
| `plans.py` | 构成图 plan 的 schema 与工具（不联网）：读 `spec/plan.schema.json`（单一事实来源）与 `spec/examples/plans/`；不依赖 jsonschema 的小校验器（`$ref` / `oneOf` / 范围 / pattern）、夹取、清洗；按 id 找元素；ops 合法性检查与应用 |
| `rules.py` | 本地锁定：从人的那句话里读出说死的条件（时段、溪、地标名、层数、坡度、入口、地形词、迷宫 / 矿洞 / 地宫 / 栈道……），写死到三张 plan 上；revise 也锁 |
| `test_app.py` | 全部后端测试（模拟 AI、假 urllib、假 anthropic client，不联网不花钱）：`python -X utf8 desktop\test_app.py` |
| `build.bat` | PyInstaller 打包 → `dist\SceneDialog\SceneDialog.exe`（带上 `medium/ spec/ tools/`） |

```bat
.venv\Scripts\python -X utf8 desktop\app.py                     :: 开窗口
.venv\Scripts\python -X utf8 desktop\app.py --no-window --port 8791
```

## AI 输出什么：构成图 plan（docs/05）

AI 不再从菜单里挑原型，而是写一张**开放的构成图**：任意数量的地形块、区域、建筑类型、地标、路、水、地下 / 空中空间和关系，名字随便起（吊脚木楼、风雨桥、矿洞迷宫），尺寸用米，位置只用相对关系（`at`：相对谁、哪个方向、多远的比例；`place`：在谁的顶上 / 边上 / 尽头 / 下面…）。**schema 里没有任何坐标字段**。引擎 `medium/engine/plan.js` 把 plan 编译成 SID。

- **draft**：一句话 → 3 张 plan，要求三张在构成上不同（地形组合 / 布局 / 地标关系 / 空间布局），人说死的三张都有。
- **revise**：人的一句话 → 对当前 plan 的 `ops`（`set` 改一个字段、`add` 加一项、`remove` 删一项）+ 一句复述。界面上的本地操作（拖、旋钮、加删）**不调 AI**。

## /api

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/health` | — | `{ok, version, mock, provider, provider_label, model, thinking, root}` |
| `GET /api/config` | — | `{provider, provider_label, mock, mock_forced, has_key, key_hint, model, key_source, thinking, providers: {anthropic, deepseek: {has_key, key_hint, model, models, key_source, thinking?}}}`，没有明文 |
| `POST /api/config` | `{provider?, mock?, providers?: {deepseek: {api_key?, model?, thinking?, base_url?}, anthropic: {api_key?, model?}}}`，也收扁平 `api_key / model / thinking`；`api_key: ""` = 清除 | 同 GET |
| `POST /api/config/test` | `{provider?, api_key?, model?}` | `{ok, provider, model, ms, text, usage}` 或 `{ok: false, message, status, hint}` |
| `GET /api/plan/schema` | — | `spec/plan.schema.json` 原样 |
| `POST /api/ai/draft` | `{intent, locked?: {plan, ids?}, variant?, force_mock?}` | 见下 |
| `POST /api/ai/revise` | `{plan, action: "一句话" 或 {type: "text", text}, locked?: {ids} 或 [ids], force_mock?}` | 见下 |
| `POST /api/score` | `{intent: sid, readback, map?, auto_map?}` | `tools/score_readback.py` 的比对结果 |
| `POST /api/save` | `{name, content}` | `{ok, path}`（写到 `%LOCALAPPDATA%\ai-scene-bridge\exports\`） |

draft 响应：

```jsonc
{ "plans": [plan, plan, plan],            // 已经过本地锁定，合 plan.schema.json
  "constraints": ["环台", "崖", "吊脚木楼", "寨门在崖边"],   // 「按你的话锁定了：…」
  "constraints_fixed": [{"plan": 1, "fields": ["地标·寨门", "地形·崖"]}],  // 哪张被本地补了什么（= 模型漏掉的）
  "diversity": {"pairwise": [4, 3, 5], "min": 3, "dims": ["terrain", "landmarks", "spaces", "paths", "zones", "spawn"]},
  "warnings": ["plan 2：引用不存在 zones[0].on → hilltop"],   // 引擎会降级到 site
  "provider": "deepseek" | "claude" | "mock", "_usage": {...}, "_ms": 6200, "_fixes"?: [...], "_retried"?: true }
```

revise 响应：

```jsonc
{ "understood": true, "restatement": "矿洞改成迷宫平面。",   // ≤ 60 字
  "ops": [{"op": "set", "id": "mine", "field": "layout", "value": "maze"}],   // 已逐条校验，可直接 applyOps
  "question": null | "一句追问", "ask_to_point": false,
  "constraints": ["矿洞 · 迷宫"], "constraints_fixed": ["矿洞布局"],   // 本地补的 op
  "provider": "...", "_usage": {...}, "_ms": 1800 }
```

- `ops` 规则（docs/05 §5）：`set` 的 `id` 是元素 id，或 `site / spawn / lighting`，或 `plan`（根上的 name / one_liner / mood / palette）；`field` 是点分路径（`place.rel`、`connect.via`），值按该字段的 schema 校验，越界夹回；`add` 的 `value` 按该组 schema 校验，id 重了本地改名；`remove` 删元素，关系用 `rel:<序号>`。不合法的 op 不会出现在响应里。`id / locks / nudge_m / offset_m` AI 不能改。
- `locked`：draft 时 `{plan, ids}`（ids 缺省取 `plan.locks`）——这些项原样放回三张新 plan（「换一批」时不动）；revise 时碰到这些 id 的 op 丢掉。
- `variant`：换一批的批次号（模拟 AI 换骨架；真模型在提示里说「换几种没用过的构成」）。
- `force_mock: true`：这次走模拟 AI（演示 / 截图 / 测试用，不花钱）。
- 失败：AI 回来了但不能用 → 502 `{error: "ai_<kind>", kind: refusal|truncated|empty|bad_json|schema, message, errors?, usage}`；服务商 HTTP / 网络错误 → 502 `{error: "ai", provider, status, type, request_id, retryable, hint}`；参数错 → 400。

## 本地锁定（不花钱、不靠模型自觉）

`ai.extract(句子)` 读出说死的条件，`ai.enforce(plan, 条件)` 写死到每一张上，`ai.enforce_ops(plan, ops, 句子)` 在 revise 时补 op：

- 时段（黄昏 / 夜里 / 清晨…）、有没有溪（「溪 / 河 / 两岸 / 水车 / 桥」→ 要有溪）、层数（「七层」→ `site.relief_layers`；「小村」3–4、「大寨」≥ 6）、陡缓（`site.layer_m`）、从哪边进（`spawn.place`）。
- **地标名是开放的**：句子里的「寨门 / 鼓楼 / 风雨桥 / 戏台 / 水车 / 寺 / 塔 / 大树 / 祠堂 / 牌坊…」三张都要有 label 含这个词的 landmark，没有就按 form 补一个默认放置；同一小句里有位置词（崖边 / 山顶 / 村口 / 广场 / 溪上 / 尽头）就锁放置。
- 地形词：环台 → `ring_terraces`，之字 → `slope_terraces` + 主路 `zigzag`，两岸 / 溪谷 → `valley`，悬崖 / 崖边 → `cliff`，山脊 / 盆地 / 天坑 / 孤岛。
- 建筑词：吊脚楼 → `stilt_house`（且有住宅区在用它），土楼 / 圆楼 → `round_house`，院落 → `courtyard`。
- 空间：迷宫 → 一个 `layout: maze` 的地下空间（和矿洞 / 地宫同句时就是那个空间）；矿洞 → label 含「矿洞」且 `galleries`（同时说了迷宫就是 `maze`）；地宫 → `halls` 或 `rooms`（「前厅—甬道—主墓室，两侧耳室」直接排成房间清单 + 连线）；溶洞 → `network`；栈道 / 浮岛 / 天桥 → 空中空间；「两层的」→ `sublevels`；「岔路多」→ `branching: high`；「X 下有…」→ `under: X`；「从井下去」→ `connect.via: well`。句子没提地下 / 空中时，模型自己加的空间去掉（人锁住的不动）。
- revise 也锁：「矿洞是个迷宫」→ ops 里必须有把那个空间 `layout` 设成 `maze` 的 set（模型没给就本地补），复述里写「矿洞改成迷宫平面」。

## 服务商

配置在 `%LOCALAPPDATA%\ai-scene-bridge\config.json`（`{provider, mock, providers: {anthropic: {...}, deepseek: {...}}}`；旧的扁平 `{api_key, model}` 视为 anthropic，下次保存时迁移），或环境变量 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`。网页只看得到 `has_key` 与打码的 `key_hint`。

**DeepSeek（默认）**：标准库 urllib，`/chat/completions`，`response_format: json_object`，思考默认关（`providers.deepseek.thinking`）。没有 json_schema：系统提示里放由 plan schema 生成的 TypeScript 风格字段表（`ai.brief()`，带范围与中文名）+ 两个最短的示例 plan（单行）+ 改动示例。回来后：坏 JSON 先本地修（围栏 / 尾逗号 / 没转义的引号与换行），修好就不回喂；去掉多余字段与可选 null、id 去重、按 schema 夹取，再校验 plan schema 与 ops 合法性；不合格把错误清单回喂、重试一次。429 / 5xx / 断连重试 1 次，超时 120 s。费用按官方人民币价目（deepseek-flash 每百万 token：缓存命中 0.04 / 0.02，未命中 2 / 1，输出 8 / 4 元，高峰 / 空闲）记在 `_usage.cost_cny`。

**Claude**：官方 `anthropic` SDK，`output_config.format = json_schema`。发前 `ai.claude_schema()` 剥掉 API 不支持的约束（`minimum / maximum / pattern / maxLength / maxItems…` 折进 description）、`oneOf → anyOf`、`definitions → $defs`、每个对象 `additionalProperties: false`，op 的「任意值」换成能表达的 anyOf；回来后本地校验 + 夹取。Opus 5.5 不传 `thinking` / 采样参数，draft `effort: low`、revise `medium`；默认开服务端 refusal fallback（`server-side-fallback-2026-07-01` + `fallbacks: "default"`，被拒就退回普通调用）；先看 `stop_reason` 再读内容。本机没有 Claude 密钥，这条路径只用假 client 测过。

**模拟**：没有密钥、勾了模拟或 `force_mock` 时用。draft 以 `spec/examples/plans/` 为骨架，按句子里的词挑 3 个构成不同的，再走同一套本地锁定把句子里的东西补进去；revise 认「加 / 去掉 / 换个地标 / 更陡 / 更缓 / 更密 / 更稀 / 更高 / 大一点 / 岔路多 / 夜里 / 迷宫 / 矿洞 / 地宫…」。确定性：同输入同结果，`variant` 换骨架。

## 评测

```bat
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --mock
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --provider deepseek --only q02,q03 --max-calls 3
.venv\Scripts\python -X utf8 tools\eval_first_interpretation.py --provider deepseek --skip-draft --revise "矿洞是个迷宫" --max-calls 2
```

写 `build\eval\plans.json`（模型原样 + 锁定后的 plan）、`build\eval\report-v4.md`（合 schema、构成差、锁定补了什么、耗时、token、费用）。真机记录见 `build\eval\deepseek-v4.md`。
