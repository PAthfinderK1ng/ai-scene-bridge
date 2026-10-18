# desktop/ — 本地服务与桌面壳

| 文件 | 作用 |
| --- | --- |
| `sid_editor.py` | 入口。起本地服务（只监听 127.0.0.1，随机端口），用系统 WebView2（pywebview）开窗口加载 `/medium/`；pywebview 不可用时退回 Edge `--app` 模式。`--no-window` 只起服务，`--port N` 固定端口 |
| `api_server.py` | 静态文件 + `/api/*`：`GET /api/health`、`GET/POST /api/config`、`POST /api/config/test`、`POST /api/ai/draft`、`POST /api/ai/revise`、`POST /api/score`（意图 vs 读回，复用 `tools/score_readback.py`）、`POST /api/save`。拒绝外部 Origin |
| `ai_service.py` | Claude 调用层：`draft`（一句话 → 3 张卡）与 `revise`（人的动作事实 → 结构 patch + 复述）。官方 `anthropic` SDK，结构化输出（`output_config.format = json_schema`，`CARD_SCHEMA` / `REVISE_SCHEMA` 严格枚举 + 数值范围，LLM 没有任何写坐标的字段），默认模型 `claude-opus-5-5`，系统提示带 prompt cache。没有密钥或 `mock: true` 时用 `MockAI`（确定性脚本） |
| `test_api.py` | 进程内起服务、用模拟 AI 跑 22 条接口冒烟：`python -X utf8 desktop\test_api.py` |
| `build.bat` | PyInstaller 打包 → `dist\SceneDialog\SceneDialog.exe`（onedir，约 50 MB，含 medium/ app/ spec/ tools/ 与 anthropic） |

密钥存在 `%LOCALAPPDATA%\ai-scene-bridge\config.json`（`{"api_key", "model", "mock"}`），或环境变量 `ANTHROPIC_API_KEY`；`/api/config` 只回传 `has_key` 与打码后的 `key_hint`，网页永远拿不到明文。导出的文件在 `%LOCALAPPDATA%\ai-scene-bridge\exports\`（浏览器下载不可用时的备选）。

依赖（`.venv`）：`pywebview`、`pyinstaller`、`anthropic`（`build.bat` 第一次会自动装）。源码运行：

```bat
.venv\Scripts\python -X utf8 desktop\sid_editor.py
```
