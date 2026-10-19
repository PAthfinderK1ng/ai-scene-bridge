# desktop/ — 本地服务与桌面壳

| 文件 | 作用 |
| --- | --- |
| `sid_editor.py` | 入口。起本地服务（只监听 127.0.0.1，随机端口），用系统 WebView2（pywebview）开窗口加载 `/medium/`；pywebview 不可用时退回 Edge `--app` 模式。`--no-window` 只起服务，`--port N` 固定端口 |
| `api_server.py` | 静态文件 + `/api/*`：`GET /api/health`、`GET/POST /api/config`、`POST /api/config/test`、`POST /api/ai/draft`、`POST /api/ai/revise`、`POST /api/score`（意图 vs 读回，复用 `tools/score_readback.py`）、`POST /api/save`。拒绝外部 Origin |
| `ai_service.py` | Claude 调用层：`draft`（一句话 → 3 张卡）与 `revise`（人的动作事实 → 结构 patch + 复述）。官方 `anthropic` SDK（1.15.0），结构化输出（`output_config.format = json_schema`，`CARD_SCHEMA` / `REVISE_SCHEMA` 严格枚举 + 数值范围，LLM 没有任何写坐标的字段），默认模型 `claude-opus-5-5`，系统提示（含一张示例卡）带 prompt cache，默认开服务端 refusal fallback。先看 `stop_reason` 再读内容：拒绝 / 截断 / 不合 schema 抛 `AIError`（带类别与 usage）。没有密钥或 `mock: true` 时用 `MockAI`（确定性脚本） |
| `schema_lite.py` | 不依赖 jsonschema 的最小校验器：`api_schema()` 把结构化输出 API 不支持的 `minimum / maximum / pattern / minItems(>1) / maxItems` 剥掉再发（SDK 只在 `messages.parse()` 自动剥，`create()` 原样发会 400）；`validate()` / `clamp()` 在模型回来后本地校验、把越界数值夹回范围 |
| `test_api.py` | 进程内起服务、用模拟 AI 跑接口冒烟 + 用假 client 测 `ClaudeAI` 的真实调用路径（请求形状、beta 回退、refusal / max_tokens、本地校验、错误 payload）：`python -X utf8 desktop\test_api.py` |
| `build.bat` | PyInstaller 打包 → `dist\SceneDialog\SceneDialog.exe`（onedir，约 50 MB，含 medium/ app/ spec/ tools/ 与 anthropic） |

密钥存在 `%LOCALAPPDATA%\ai-scene-bridge\config.json`（`{"api_key", "model", "mock"}`），或环境变量 `ANTHROPIC_API_KEY`；`/api/config` 只回传 `has_key` 与打码后的 `key_hint`，网页永远拿不到明文。导出的文件在 `%LOCALAPPDATA%\ai-scene-bridge\exports\`（浏览器下载不可用时的备选）。

依赖（`.venv`）：`pywebview`、`pyinstaller`、`anthropic`（`build.bat` 第一次会自动装）。源码运行：

```bat
.venv\Scripts\python -X utf8 desktop\sid_editor.py
```

## 接真实 API 前后怎么验证

真实 Claude 调用路径按 claude-api 技能文档核过（Opus 5.5：不传 `thinking` / 采样参数，深度只用 `output_config.effort`；结构化输出；`fallbacks: "default"` + `server-side-fallback-2026-07-01`；`stop_reason` 先看再读），但**本机没有密钥，真模型没有实际跑过**。拿到密钥后按这五步走：

1. **填密钥**：开界面 → 右上角「AI：…」→ 粘贴 `sk-ant-…`，模型留 `claude-opus-5-5`，不勾「模拟」→ 保存。密钥只写进 `%LOCALAPPDATA%\ai-scene-bridge\config.json`。也可以不进界面，直接设环境变量 `ANTHROPIC_API_KEY`。
2. **测试密钥**：同一个对话框点「测试」。成功显示 `可用 · 模型 · 毫秒`；失败会给一句诊断（401 密钥无效 / 404 模型名不对 / 429 限流 / 529 过载 / 连不上）。这一步只发 256 token 的最短请求。
3. **跑 eval 脚本**（10 个固定输入，每个要 3 张卡，真模型约 10 次调用、每次几千 token）：
   ```bat
   .venv\Scripts\python -X utf8 tools\eval_first_interpretation.py
   ```
   没有密钥或加 `--mock` 时走模拟 AI（整条链路照样跑通，报告里会标明）。想要更严的 schema 校验先装 `jsonschema`（`.venv\Scripts\pip install jsonschema`，没装会用 `desktop/schema_lite.py`）。脚本会：调 `draft` → 校验每张卡 → 写 `build\eval\cards.json` → 用无头 Edge 跑 `medium/engine/tests/eval_cards.test.html` 算几何（房子数、关系检查、三张是否够不同）→ 写 `build\eval\report.md`。
4. **看 report.md**：顶部有耗时、usage 与按 Opus 5.5 定价（$4 / $20 每百万 token，缓存读 $0.20）估算的费用；总表最后一列「首次理解正确？」留空给人填——每个输入看三张卡是否把那句话里的时段、溪、地标、规模、陡缓、入口都落到了字段上。**D17：10 个里 ≥ 8 个「是」才过**；不过就按 D17 决策 a，给点 / 画动作加用途芯片确认。`cache_read` 从第二次调用起应该 > 0（系统提示约 1.5k token，Opus 5.5 最小可缓存 512）；一直是 0 说明缓存没命中。
5. **在界面里试 3 句**：例如「黄昏的山城村庄，山顶有座寺」「夜里亮灯的小山村，溪边有水车」「清晨有雾的大寨子，很陡，顶上一座塔」。每句看：三张卡是否都对得上这句话、黄标差异是否真的是结构差异、挑一张后说「再陡一点」「换成塔」能否变成 patch 并复述；对话底部的灰字会写 `Claude · 毫秒`。失败时弹出的错误带 `status / type / request_id / hint`，把这几项原文发给开发者就能定位。

调用失败的几类回应（都走 HTTP 502，前端原样显示 `message`）：`error: "ai"`（Anthropic 的 API 错误，带 `status / type / request_id / retryable / hint`）、`ai_refusal`（模型拒绝，带 `category`）、`ai_truncated`（输出被 `max_tokens` 截断）、`ai_schema`（本地校验不过，带 `errors` 路径）。
