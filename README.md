# ai-scene-bridge

让人和 AI 高效沟通「三维游戏场景」的中间媒介 —— 探索项目。

## 一句话

AI（Claude Code / Cursor + UE/Unity MCP）会写代码，但不会「搭地图」。本项目做的不是又一个编辑器，而是一场围绕空间的**对话**：
人说一句话（「我要生成山城村庄」），AI 出三张完整方案，人挑一张，然后直接在图上拖、画、圈、调高度（地面、地下、天上都可以）；随时导出一份引擎无关的**场景意图文件（SID）**和给引擎侧 AI 的交代，在 **Unreal Engine** 或 **Unity** 中落地，再把读回导进来标红验收。
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
.venv\Scripts\python -X utf8 desktop\app.py
```
或双击打包好的 `dist\SceneDialog\SceneDialog.exe`（没有就先运行 `desktop\build.bat`）。AI 可选 **DeepSeek**（`deepseek-flash`，默认关思考，出三张卡约 6 秒、约 ¥0.006 一次）或 **Claude**；没有密钥时用内置的模拟 AI 跑通全流程。点右上角「AI：…」切换服务商、填密钥。
四步：**说**（一句话，调 AI）→ **选**（三张**构成**不同的方案，中间并排）→ **改**（全部本地、即时、可撤销，不花钱）→ **出**（随时可点：引擎包 zip；读回 JSON 导入后红点三选一）。

**AI 自己搭结构（v5，docs/06）**：AI 不从菜单里挑，而是先想三个**空间概念**（从题材自己的逻辑出发、设计动机各不相同，每次请求另抽两个随机「视角」作可选参考），再把每个概念并行写成一段**场景程序**：形体（盒、圆柱、空心环带、圆锥、穹顶、金字塔、楔、拱、环、球、多棱柱）与建筑件（楼、塔、墙、院、台阶、平台、柱、门、雕像、树、岩、晶体、浮岛、水）组成组，可嵌套、可**重复**（一排 / 网格 / 环形 / 沿路 / 散布 / 镜像 / 叠层）；地形用雕刻操作叠（抬起、压低、削平、台阶化、坡道、开沟、成湖、河、立崖、沙丘、起伏）；路、台阶、桥、索桥、隧道、水渠、传送门把东西连起来；台地村落、撒房子、迷宫 / 矿道 / 地宫是可选的生成器。组内可以写米制尺寸与偏移（像建筑师的草图），**根节点只用锚点**（`site.N`、`主殿.top`、`法师塔[2]`），落地、避让、路由、检查都由引擎（`medium/engine/program.js`）做。

「改」里能做的：
- **右栏场景树**：AI 写了什么就列什么——地形操作、组 → 子节点、重复（「法师塔 × 6 · 环形」）、连接、生成器；每项的旋钮从 `spec/plan.schema.json` 生成（尺寸、个数、半径、间距、偏移、旋转、离地、屋顶、排法、锚点），可改名、加节点、删除、锁住。
- **俯视图直接拖**：拖一个东西 = 改它在父组里的偏移；Alt 拖重复里的单个实例只改那一个；工具 移动 / 画路 / 圈区域 / 剖切 / 擦除，Ctrl+Z 撤销，Esc 取消。
- **剖面**自选剖切线与宽度，悬空的东西在剖面里上下拖改离地高度；**3D 小窗**实时跟着变；地下 / 天上图层看空间内部（迷宫、矿道、厅堂、房间图）。
- 只有「发送」「三个都不要，重出」「换一批」会调 AI（按钮标「调 AI」，显示构思 + 展开三步合计的耗时、token、费用）；你那句话里说死的东西（时段、点了名的结构、地形词、地下空间、规模）本地锁定，三张都有。

视图：俯视语义图、侧剖面、「第一眼」（出生点 1.7 m 眼高）、3D；俯视与剖面带 3D 小窗。
细节与文件说明见 [medium/README.md](medium/README.md)；v5 规格见 [docs/06](docs/06-场景程序.md)，之前几轮见 [docs/05](docs/05-AI原生场景构成.md)、[docs/04](docs/04-改版-直接操作与多层空间.md)，交互原则见 [docs/03](docs/03-交互设计-场景对话.md)。

## 过程产物

- [prototype/](prototype/index.html) —— 重做前的可点击交互原型（AI 回复为脚本），用于把关交互方式
- [app/](app/README.md) —— 第一版「摆体块」SID 编辑器，被用户否定后保留作实验输入端 / SID 校验测试台（同一服务下 `/app/`）
- [experiments/week0-ab/](experiments/week0-ab/README.md) —— 第 0 周四组对照实验包（A 纯文字 / B 文字 + 俯视图 / C JSON + 关系 / D 引擎内灰盒），实验本身待跑

## 文档

- [docs/00-项目愿景.md](docs/00-项目愿景.md) —— 原始想法、要回答的问题、成功标准
- [docs/01-调研-痛点验证与可行性.md](docs/01-调研-痛点验证与可行性.md) —— 多智能体调研报告（124 个来源）：P2 成立、P1/P3/P4 部分成立；价值在语义意图层 + 预计算关系 + 校验器；sidecar JSON 必须（glTF extras 会被 UE / Unity 导入器丢掉）
- [docs/02-中间层设计草案-v0.md](docs/02-中间层设计草案-v0.md) —— SID 格式、导出包与 AI 协议、引擎编译、分期计划、外观层
- [docs/03-交互设计-场景对话.md](docs/03-交互设计-场景对话.md) —— 重做版交互：六条原则、六步流程、七种输入动作、高差 / 外观 / 读回的沟通方式、D1–D17 决策与评审结论
- [docs/04-改版-直接操作与多层空间.md](docs/04-改版-直接操作与多层空间.md) —— 试用后的改版：说→选→改→出、只有打字才调 AI、直接拖动、自选剖切与剖面调高、地下 / 空中空间（D18–D21）、DeepSeek 接入与实测
- [docs/05-AI原生场景构成.md](docs/05-AI原生场景构成.md) —— v4：开放构成图、空间内部布局（迷宫 / 矿道 / 厅堂 / 洞穴网 / 房间图）、代码合并
- [docs/06-场景程序.md](docs/06-场景程序.md) —— v5：AI 写场景程序（形体 + 组 + 重复 + 地形雕刻 + 连接 + 生成器），两步生成（三个概念 → 并行展开），为什么 v4 还像预设
- [spec/](spec/README.md) —— SID 的 JSON Schema（含多边形台地 `polygon/level/skirt`、`meta.layer_height_m`）、手写示例、给引擎侧 AI 的 [PROTOCOL.md](spec/PROTOCOL.md)
- [medium/engine/SPEC.md](medium/engine/SPEC.md) —— 几何引擎规范：坐标约定、地形原型、布局规则、路由、关系检查、笔画事实、变体差异、颜色

## 测试

```bat
python -X utf8 tools\run_browser_test.py medium\engine\tests\sid.test.html
python -X utf8 desktop\test_app.py
```
引擎 11 页测试（无头 Edge 运行，不需要 Node）共 418 个用例（含 7 个示例程序的 222 条编译检查）；界面流程 `medium/tests/flow.test.html` 138 例（需先起本地服务，见文件头）；后端 `desktop/test_app.py` 178 条（模拟 AI + 假的 DeepSeek / Claude 客户端 + 两步生成 + 本地锁定）；读回评分 38 条。DeepSeek 实测见 `desktop/README.md` 与 `build/eval/`。

## 当前状态

- [x] 立项，整理四个痛点与方案假设
- [x] 第一轮调研（170 条发现，66 核实 / 101 修正 / 1 推翻），结论对设计的影响见 [docs/02 §0.5](docs/02-中间层设计草案-v0.md)
- [x] 设计草案 v0 + SID v0.1 Schema + 示例场景 + 第 0 周实验包
- [x] 第一版 SID 编辑器（app/）→ 用户否定「摆体块」分工 → 交互原型（prototype/）→ 评审团定稿（docs/03）→ D1–D17 批准
- [x] 正式版「场景对话」：确定性引擎（地形 / 布局 / 路由 / 关系 / 笔画 / 变体 / 颜色 / 组装）、本地 AI 代理（Claude 结构化输出 + 模拟模式）、六步界面、三张图 + 3D、导出包、读回对比
- [x] 试用后改版（docs/04）：说→选→改→出；只有打字才调 AI；直接拖动；自选剖切、剖面调高、3D 小窗；地下 / 空中空间；撤销 / 重做
- [x] 接 DeepSeek 实测：deepseek-flash 出卡约 6 s / ¥0.006，改卡约 2 s / ¥0.0015；说死的条件本地锁定
- [ ] 首次理解准确率按 D17 人工复核（`tools/eval_first_interpretation.py --provider deepseek` 生成报告）
- [ ] 在 Unity + MCP 上用导出包搭一次，把读回导回来验收；再补 UE
- [ ] 第 0 周四组对照实验
- [ ] 更多题材（目前只深做「山地村落」一个原型族）

## 目录

```
ai-scene-bridge/
├── README.md
├── medium/                       正式版「场景对话」（ES modules，无构建）
│   ├── index.html / style.css / app.js（store + 流程）/ ui.js（构成清单）/ views/（map / profile / eye / view3d）
│   └── engine/                   确定性几何引擎 + SPEC.md + tests/
├── desktop/                      app.py（本地服务 + WebView2 窗口）、ai.py（提示词、两步生成、入口）、providers.py（DeepSeek / Claude / 模拟）、plans.py（程序 schema 与工具）、rules.py（本地锁定、片段库、组织标签）、test_app.py，build.bat 打包
├── prototype/                    交互原型（脚本 AI）
├── app/                          第一版 SID 编辑器（three.js）
├── docs/                         00 愿景 · 01 调研 · 02 设计草案 · 03 交互设计 · 04 改版 · 05 AI 原生构成（v4）
├── spec/                         sid.schema.json · PROTOCOL.md · examples/
├── tools/                        render_topdown.py · score_readback.py · run_browser_test.py
└── experiments/week0-ab/         第 0 周实验包
```

## 说明

- 项目名用 ASCII，是因为 UE / Unity 对非 ASCII 路径不友好。
- 本仓库作者：[PAthfinderK1ng](https://github.com/PAthfinderK1ng)
