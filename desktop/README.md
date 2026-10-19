# desktop/ — 本地服务与桌面壳

| 文件 | 作用 |
| --- | --- |
| `sid_editor.py` | 入口。起本地服务（只监听 127.0.0.1，随机端口），用系统 WebView2（pywebview）开窗口加载 `/medium/`；pywebview 不可用时退回 Edge `--app` 模式。`--no-window` 只起服务，`--port N` 固定端口 |
| `api_server.py` | 静态文件 + `/api/*`：`GET /api/health`（带 provider / model）、`GET/POST /api/config`（服务商、各家密钥打码、模型、思考开关）、`POST /api/config/test`（按服务商测一次最短请求）、`POST /api/ai/draft`、`POST /api/ai/revise`（都收 `force_mock: true` = 这次走模拟；回包都带 `provider`、`_usage`（`cost_cny` 或 `cost_usd`）、`_ms`）、`POST /api/score`（意图 vs 读回，复用 `tools/score_readback.py`）、`POST /api/save`。拒绝外部 Origin |
| `ai_service.py` | AI 入口：配置（服务商、各家密钥、兼容旧的扁平配置）、`get_ai()` 选服务商，以及 Claude 调用层：`draft`（一句话 → 3 张卡）与 `revise`（人的动作事实 → 结构 patch + 复述）。官方 `anthropic` SDK（1.15.0），结构化输出（`output_config.format = json_schema`，`CARD_SCHEMA` / `REVISE_SCHEMA` 严格枚举 + 数值范围，LLM 没有任何写坐标的字段），默认模型 `claude-opus-5-5`，系统提示（含一张示例卡）带 prompt cache，默认开服务端 refusal fallback。先看 `stop_reason` 再读内容：拒绝 / 截断 / 不合 schema 抛 `AIError`（带类别与 usage）。没有密钥或 `mock: true` 时用 `MockAI`（确定性脚本） |
| `ai_common.py` | 各服务商共用：词表、`CARD_SCHEMA` / `PATCH_SCHEMA` / `REVISE_SCHEMA`（含多层空间 `levels`，最多 3 项，只有枚举与层数，没有坐标）、示例卡、系统提示、用户文本、`field_table()`（把 schema 压成字段表，写进 DeepSeek 的提示）、`AIError` |
| `ai_deepseek.py` | DeepSeek 调用层（标准库 urllib，不加依赖）：OpenAI 兼容 `/chat/completions`，`response_format: json_object`，思考默认关；回来后在本地去掉多余字段、补上推得出的缺省值、夹取并校验，不合格就带错误清单回喂、重试一次；JSON 解析失败先本地修（`repair_json`：围栏 / 尾逗号 / 字符串里的英文双引号与换行），修好且合 schema 就不回喂（`usage.repaired`）；429 / 5xx / 断连重试 1 次，超时 90 s；记录 usage 与人民币费用 |
| `ai_mock.py` | 模拟 AI：认得地下 / 地宫 / 溶洞 / 地道 / 地窖 / 井 / 空中 / 栈道 / 浮岛 / 天桥 / 多层，生成 levels；改卡认得「加一个地宫」「去掉空中平台」「换成夜里」 |
| `schema_lite.py` | 不依赖 jsonschema 的最小校验器：`api_schema()` 把结构化输出 API 不支持的 `minimum / maximum / pattern / minItems(>1) / maxItems` 剥掉再发（SDK 只在 `messages.parse()` 自动剥，`create()` 原样发会 400）；`validate()` / `clamp()` 在模型回来后本地校验、把越界数值夹回范围 |
| `test_api.py` | 进程内起服务、用模拟 AI 跑接口冒烟 + 用假 client 测 `ClaudeAI` 的真实调用路径（请求形状、beta 回退、refusal / max_tokens、本地校验、错误 payload）+ 用假 urllib 响应测 `DeepSeekAI`（请求体、回喂重试、usage 与费用、HTTP 错误分类）+ force_mock + 配置读写不泄露明文：`python -X utf8 desktop\test_api.py` |
| `build.bat` | PyInstaller 打包 → `dist\SceneDialog\SceneDialog.exe`（onedir，约 50 MB，含 medium/ app/ spec/ tools/ 与 anthropic） |

密钥存在 `%LOCALAPPDATA%\ai-scene-bridge\config.json`（`{"provider", "mock", "providers": {"anthropic": {...}, "deepseek": {...}}}`；旧的扁平 `{"api_key", "model"}` 视为 anthropic，下次保存时迁移），或环境变量 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`；`/api/config` 只回传 `has_key` 与打码后的 `key_hint`，网页永远拿不到明文。导出的文件在 `%LOCALAPPDATA%\ai-scene-bridge\exports\`（浏览器下载不可用时的备选）。

依赖（`.venv`）：`pywebview`、`pyinstaller`、`anthropic`（`build.bat` 第一次会自动装）。源码运行：

```bat
.venv\Scripts\python -X utf8 desktop\sid_editor.py
```

## 服务商：DeepSeek（默认）与 Claude

右上角「AI：…」→ 服务商选 DeepSeek / Claude，两家的密钥分别保存。密钥只存在本机 config.json，网页上只看得到 `sk-…` 加末四位。

**DeepSeek 配置**（`providers.deepseek`）：
- `api_key`
- `model`：默认 `deepseek-flash`，也可填 `deepseek-v4-pro`
- `base_url`：默认 `https://api.deepseek.com`
- `thinking`：默认 `false`。开着思考时 token 全花在推理上，又慢又贵，出卡用不着，建议一直关着。

**价格**（官方中文价目页 api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-10-19 取，人民币每百万 token，高峰 / 空闲）。高峰是北京时间周一到周五 9–12 点、14–18 点，空闲时段半价：

| 模型 | 输入（缓存命中） | 输入（未命中） | 输出 |
| --- | --- | --- | --- |
| deepseek-flash | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| deepseek-v4-pro | 0.30 / 0.15 | 9.0 / 4.5 | 27 / 13.5 |

费用按请求发出时是否在高峰来估算（`_usage.cost_cny`、`_usage.peak`）。不识别法定节假日，节假日会多算。模型不在价目表里时 `cost_cny` 为 null，只给 token 数。

**为什么不用 json_schema**：DeepSeek 只有 `json_object` 模式。字段约束写在系统提示里：由 `CARD_SCHEMA` / `REVISE_SCHEMA` 自动生成的字段表，加一张示例卡和一条改卡示例。结果回来后在本地严格校验，不合格就把错误清单回喂、重试一次；坏 JSON 先本地修，修得好就不多花这一次。地标位置多了 `entry`（村口），「村口 / 寨口 / 入口处」由 `intent_rules.py` 本地锁定。「桥」（不含天桥 / 索桥 / 吊桥）锁成有溪，锁定行写「桥：路过溪处」，引擎在路与溪的交点放桥（`facts.bridges`）。原型被本地改回人说的那种时，卡名换成原型名（之字叠落型 / 环台广场型 / 溪谷双坡型），一句话也按原型重写，免得文案和缩略图对不上。一句话 / 小结里的层数、地标名、入口方位（山脚 / 半山 / 山顶、东南西）都按字段改写，末尾「。」后多出的一两个孤立字（模型偶尔吐的乱码）去掉。region kind `gathering` = 聚落（更密的民居，照常放房）。

**实测**（2026-10-19，flash，思考关，29 次调用共 ¥0.137；详见 `build/eval/deepseek-findings.md`）：
- 出三张卡：每次约 6 s，约 3.5k 输入 + 1.3k 输出 token，约 ¥0.006。12 个输入全部合 schema；多层空间（地宫 + 井、栈道 + 浮岛）该给的都给了。
- 改卡：每次约 1.6–3 s，约 ¥0.0015。首轮发现模型总漏掉 `ask_to_point`，每句话要调两次。现在改为本地从 `understood` 推出，并在提示里补了示例，一次就成。
- 主要弱点：为了让三张卡不同，模型会改掉人明说的条件（地标、陡缓、层数）。提示词改成「明说的三张都照办，只在没说死的地方拉开」后改善了大半，但仍有少数卡换了原型。建议前端用本地关键词把原型锁成 targets。
- 系统提示约 3k token，从第 2 次调用起缓存命中约 85%。

测模型与密钥：在设置里点「测试密钥」，会按所选服务商发一条 8 token 的最短请求。

## 接真实 API 前后怎么验证

真实 Claude 调用路径按 claude-api 技能文档核过（Opus 5.5：不传 `thinking` / 采样参数，深度只用 `output_config.effort`；结构化输出；`fallbacks: "default"` + `server-side-fallback-2026-07-01`；`stop_reason` 先看再读），但**本机没有密钥，真模型没有实际跑过**。拿到密钥后按这五步走：

1. **填密钥**：开界面 → 右上角「AI：…」→ 粘贴 `sk-ant-…`，模型留 `claude-opus-5-5`，不勾「模拟」→ 保存。密钥只写进 `%LOCALAPPDATA%\ai-scene-bridge\config.json`。也可以不进界面，直接设环境变量 `ANTHROPIC_API_KEY`。
2. **测试密钥**：同一个对话框点「测试」。成功显示 `可用 · 模型 · 毫秒`；失败会给一句诊断（401 密钥无效 / 404 模型名不对 / 429 限流 / 529 过载 / 连不上）。这一步只发 256 token 的最短请求。
3. **跑 eval 脚本**（DeepSeek 加 `--provider deepseek`。现在有 12 个固定输入，其中 2 个是多层空间题。`--only q03,q11` 只重跑这几题，`--revise "再陡一点,换成夜里"` 测改卡，`--max-calls` 是调用上限。以下是原来的说明：10 个固定输入，每个要 3 张卡，真模型约 10 次调用、每次几千 token）：
   ```bat
   .venv\Scripts\python -X utf8 tools\eval_first_interpretation.py
   ```
   没有密钥或加 `--mock` 时走模拟 AI（整条链路照样跑通，报告里会标明）。想要更严的 schema 校验先装 `jsonschema`（`.venv\Scripts\pip install jsonschema`，没装会用 `desktop/schema_lite.py`）。脚本会：调 `draft` → 校验每张卡 → 写 `build\eval\cards.json` → 用无头 Edge 跑 `medium/engine/tests/eval_cards.test.html` 算几何（房子数、关系检查、三张是否够不同）→ 写 `build\eval\report.md`。
4. **看 report.md**：顶部有耗时、usage 与按 Opus 5.5 定价（$4 / $20 每百万 token，缓存读 $0.20）估算的费用；总表最后一列「首次理解正确？」留空给人填——每个输入看三张卡是否把那句话里的时段、溪、地标、规模、陡缓、入口都落到了字段上。**D17：10 个里 ≥ 8 个「是」才过**；不过就按 D17 决策 a，给点 / 画动作加用途芯片确认。`cache_read` 从第二次调用起应该 > 0（系统提示约 1.5k token，Opus 5.5 最小可缓存 512）；一直是 0 说明缓存没命中。
5. **在界面里试 3 句**：例如「黄昏的山城村庄，山顶有座寺」「夜里亮灯的小山村，溪边有水车」「清晨有雾的大寨子，很陡，顶上一座塔」。每句看：三张卡是否都对得上这句话、黄标差异是否真的是结构差异、挑一张后说「再陡一点」「换成塔」能否变成 patch 并复述；对话底部的灰字会写 `Claude · 毫秒`。失败时弹出的错误带 `status / type / request_id / hint`，把这几项原文发给开发者就能定位。

调用失败的几类回应（都走 HTTP 502，前端原样显示 `message`）：`error: "ai"`（Anthropic 的 API 错误，带 `status / type / request_id / retryable / hint`）、`ai_refusal`（模型拒绝，带 `category`）、`ai_truncated`（输出被 `max_tokens` 截断）、`ai_schema`（本地校验不过，带 `errors` 路径）。
