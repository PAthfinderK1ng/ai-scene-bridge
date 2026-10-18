# ai-scene-bridge

让人和 AI 高效沟通「三维游戏场景」的中间媒介 —— 探索项目。

## 一句话

AI（Claude Code / Cursor + UE/Unity MCP）会写代码，但不会「搭地图」。本项目做的不是又一个编辑器，而是一场围绕空间的**对话**：
人说一句话（「我要生成山城村庄」），AI 出三张完整方案，人挑一张、答最多四个问题、在图上画一笔圈一块拖图钉、逐条核对 AI 的复述；确认后导出一份引擎无关的**场景意图文件（SID）**和给引擎侧 AI 的交代，在 **Unreal Engine** 或 **Unity** 中落地，再把读回导进来标红验收。
分工：人只做选择、指点、判断；AI 只做结构级决定；坐标、房子、路、可见性全部由确定性引擎算（**LLM 永远不写坐标**）。

## 出发点：四个痛点假设

| 编号 | 痛点 | 一句话 | 调研结论 |
| --- | --- | --- | --- |
| P1 | AI 只会用代码写地图 | 程序化脚本 + 硬编码坐标，三维空间理解能力不足 | 部分成立 |
| P2 | 想象与结果有出入 | 自然语言描述不清位置、尺度、朝向、层次、视线 | 成立 |
| P3 | 不知道要什么颜色 | 说了「这是山、这是树」也不知道具体色彩 / 材质 / 风格 | 部分成立 |
| P4 | 只会堆几何体 | 不知道场景「具体长什么样」，只能方块圆柱平面堆叠 | 部分成立 |

依据见 [docs/01](docs/01-调研-痛点验证与可行性.md)。

## 正式版：「场景对话」（medium/）

```bat
.venv\Scripts\python -X utf8 desktop\sid_editor.py
```
或双击打包好的 `dist\SceneDialog\SceneDialog.exe`（没有就先运行 `desktop\build.bat`）。没有 Anthropic 密钥时用内置的模拟 AI 跑通全流程；点右上角「AI：…」填密钥后换成 Claude。
六步：**说**（一句话）→ **选**（三张算过几何的方案卡，黄标是真正的差异）→ **答**（坡度 / 规模 / 地标 / 入口，每个可「你定」，选项带缩略图）→ **画**（画一笔是主路、圈一块是用途或密度、拖图钉挪地标入口、点一下看理解）→ **核**（右栏「我理解为」逐条点对，「关系检查」✓/✗ 带修法，「我假设了」列出默认值）→ **出**（引擎包 zip；读回 JSON 导入后红点三选一）。
三张图：俯视语义图（可操作）、沿主路的侧剖面（高度按「层」显示）、「第一眼」（从入口 1.7 m 眼高看地标的示意透视）；另有 three.js 3D 预览。
细节与文件说明见 [medium/README.md](medium/README.md)，交互设计与 17 项决策见 [docs/03](docs/03-交互设计-场景对话.md)。

## 过程产物

- [prototype/](prototype/index.html) —— 重做前的可点击交互原型（AI 回复为脚本），用于把关交互方式
- [app/](app/README.md) —— 第一版「摆体块」SID 编辑器，被用户否定后保留作实验输入端 / SID 校验测试台（同一服务下 `/app/`）
- [experiments/week0-ab/](experiments/week0-ab/README.md) —— 第 0 周四组对照实验包（A 纯文字 / B 文字 + 俯视图 / C JSON + 关系 / D 引擎内灰盒），实验本身待跑

## 文档

- [docs/00-项目愿景.md](docs/00-项目愿景.md) —— 原始想法、要回答的问题、成功标准
- [docs/01-调研-痛点验证与可行性.md](docs/01-调研-痛点验证与可行性.md) —— 多智能体调研报告（124 个来源）：P2 成立、P1/P3/P4 部分成立；价值在语义意图层 + 预计算关系 + 校验器；sidecar JSON 必须（glTF extras 会被 UE / Unity 导入器丢掉）
- [docs/02-中间层设计草案-v0.md](docs/02-中间层设计草案-v0.md) —— SID 格式、导出包与 AI 协议、引擎编译、分期计划、外观层
- [docs/03-交互设计-场景对话.md](docs/03-交互设计-场景对话.md) —— 重做版交互：六条原则、六步流程、七种输入动作、高差 / 外观 / 读回的沟通方式、D1–D17 决策与评审结论
- [spec/](spec/README.md) —— SID 的 JSON Schema（含多边形台地 `polygon/level/skirt`、`meta.layer_height_m`）、手写示例、给引擎侧 AI 的 [PROTOCOL.md](spec/PROTOCOL.md)
- [medium/engine/SPEC.md](medium/engine/SPEC.md) —— 几何引擎规范：坐标约定、地形原型、布局规则、路由、关系检查、笔画事实、变体差异、颜色

## 测试

```bat
python -X utf8 tools\run_browser_test.py medium\engine\tests\sid.test.html
python -X utf8 desktop\test_api.py
```
引擎 8 页测试（无头 Edge 运行，不需要 Node）共 96 个用例；后端 22 条接口冒烟（模拟 AI）。

## 当前状态

- [x] 立项，整理四个痛点与方案假设
- [x] 第一轮调研（170 条发现，66 核实 / 101 修正 / 1 推翻），结论对设计的影响见 [docs/02 §0.5](docs/02-中间层设计草案-v0.md)
- [x] 设计草案 v0 + SID v0.1 Schema + 示例场景 + 第 0 周实验包
- [x] 第一版 SID 编辑器（app/）→ 用户否定「摆体块」分工 → 交互原型（prototype/）→ 评审团定稿（docs/03）→ D1–D17 批准
- [x] 正式版「场景对话」：确定性引擎（地形 / 布局 / 路由 / 关系 / 笔画 / 变体 / 颜色 / 组装）、本地 AI 代理（Claude 结构化输出 + 模拟模式）、六步界面、三张图 + 3D、导出包、读回对比
- [ ] 用真实密钥跑一轮：首次理解准确率 < 80% 则按 D17 加「用途芯片」确认
- [ ] 在 Unity + MCP 上用导出包搭一次，把读回导回来验收；再补 UE
- [ ] 第 0 周四组对照实验
- [ ] 更多题材（目前只深做「山地村落」一个原型族）

## 目录

```
ai-scene-bridge/
├── README.md
├── medium/                       正式版「场景对话」（ES modules，无构建）
│   ├── index.html / app.js / scene.js / views/ / cards.js / panels.js / exporter.js / api.js
│   └── engine/                   确定性几何引擎 + SPEC.md + tests/
├── desktop/                      本地服务（api_server.py + ai_service.py）与 WebView2 桌面壳（sid_editor.py），build.bat 打包
├── prototype/                    交互原型（脚本 AI）
├── app/                          第一版 SID 编辑器（three.js）
├── docs/                         00 愿景 · 01 调研 · 02 设计草案 · 03 交互设计
├── spec/                         sid.schema.json · PROTOCOL.md · examples/
├── tools/                        render_topdown.py · score_readback.py · run_browser_test.py
└── experiments/week0-ab/         第 0 周实验包
```

## 说明

- 项目名用 ASCII，是因为 UE / Unity 对非 ASCII 路径不友好。
- 本仓库作者：[PAthfinderK1ng](https://github.com/PAthfinderK1ng)
