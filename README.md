# ai-scene-bridge

让用户和 AI 高效沟通「三维场景」的中间层 —— 探索项目。

## 一句话

AI（Claude Code / Cursor + UE/Unity MCP）会写代码，但不会「搭地图」。本项目做一个**中间沟通媒介**：
一份引擎无关的**场景意图文件（SID）**，加上围绕它的查看编辑器、校验器、引擎编译器和 AI 协议。
主流程是「生成后引导」：AI 先把文字写成 SID 草稿，用户在编辑器里看三秒、拖两下，确认后 AI 在 **Unreal Engine** 或 **Unity** 中落地，再读回比对。

## 出发点：四个痛点假设

| 编号 | 痛点 | 一句话 |
| --- | --- | --- |
| P1 | AI 只会用代码写地图 | 程序化脚本 + 硬编码坐标，三维空间理解能力不足 |
| P2 | 想象与结果有出入 | 自然语言描述不清位置、尺度、朝向、层次、视线 |
| P3 | 不知道要什么颜色 | 说了「这是山、这是树」也不知道具体色彩 / 材质 / 风格 |
| P4 | 只会堆几何体 | 不知道场景「具体长什么样」，只能方块圆柱平面堆叠 |

这四个痛点是否成立、「中间层」方案是否可行，见调研报告。

## 先用起来：SID 编辑器（MVP v0）

双击 `run-editor.bat`（或在仓库根目录执行 `python -m http.server 8765`），打开 <http://localhost:8765/app/>。
点「示例」加载村口广场，点对象后用 W / E / R 移动 / 旋转 / 缩放，右侧面板改语义与颜色，「导出实验包」得到一个 zip（SID + 俯视图 + 等轴测图 + glb + PROTOCOL），解压后整个目录交给 AI。
详细说明与已知限制见 [app/README.md](app/README.md)。需要联网加载 three.js。

## 文档

- [docs/00-项目愿景.md](docs/00-项目愿景.md) —— 原始想法、要回答的问题、成功标准
- [docs/01-调研-痛点验证与可行性.md](docs/01-调研-痛点验证与可行性.md) —— 多智能体调研报告：P1 / P3 / P4 部分成立、P2 成立；方案技术可行但"独立 Web 工具摆方块导 JSON"没有必要性，价值在语义标注 + 预计算关系 + 校验器，首发形态应为 Unity 插件 + Claude Code Skill，先做四组对照实验（124 个来源）
- [docs/02-中间层设计草案-v0.md](docs/02-中间层设计草案-v0.md) —— 中间层是什么、两条流程、SID 格式、导出包与 AI 协议、引擎编译、编辑器 MVP、分期计划、外观层（未解决）
- [spec/](spec/README.md) —— SID 的 JSON Schema、手写示例、给 AI 的 [PROTOCOL.md](spec/PROTOCOL.md)
- [experiments/week0-ab/](experiments/week0-ab/README.md) —— 第 0 周实验包：A1 自然描述 / A2 尽力描述 / B SID + 俯视图 三份输入、评分表
- [tools/](tools/) —— `render_topdown.py`（SID → 俯视图 / 等轴测图）、`score_readback.py`（意图 vs 引擎读回的还原度评分）

## 当前状态

- [x] 立项，整理四个痛点与方案假设
- [x] 第一轮调研完成（8 维度 → 逐条核查 → 两位反方 → 补查 → 报告；170 条发现，66 核实 / 101 修正 / 1 推翻）；结论对设计的影响见 [docs/02 §0.5](docs/02-中间层设计草案-v0.md)
- [x] 设计草案 v0 + SID v0.1 Schema + 示例场景
- [x] 第 0 周实验包：渲染脚本、三份输入、PROTOCOL、评分脚本（脚本已自检，实验本身待跑）
- [x] 网页版 SID 编辑器 MVP v0（app/）：摆体块 / 标记 / 区域 / 路径 / 山丘，属性、调色板、关系、校验，导出实验包，glTF 素材导入
- [ ] 第 0 周实验（已按报告改为四组：A 纯文字 / B 文字 + 俯视图 / C JSON + 关系 / D 引擎内灰盒读层级），在 Unity + MCP 上跑
- [ ] 待决定：按报告建议转向「Unity 插件 + Skill」、网页编辑器降级为实验输入端，还是继续打磨网页编辑器
- [ ] 第 1–2 周：Web 编辑器 MVP（Three.js），能摆体块、标语义、取色、导出包
- [ ] 第 3 周：Unity 导入 / 读回脚本 + PROTOCOL.md，跑通全流程
- [ ] 第 4 周：UE Python 导入 / 读回，校验器，diff

## 目录

```
ai-scene-bridge/
├── README.md
├── run-editor.bat                启动本地服务并打开编辑器
├── app/                          网页版 SID 编辑器（three.js，无构建）
├── docs/
│   ├── 00-项目愿景.md
│   ├── 01-调研-痛点验证与可行性.md
│   └── 02-中间层设计草案-v0.md
├── spec/
│   ├── README.md
│   ├── PROTOCOL.md               给 AI 的读法 / 编译 / 验证协议
│   ├── sid.schema.json
│   └── examples/village-square.sid.json
├── tools/
│   ├── render_topdown.py         SID → views/top.png, views/iso.png
│   ├── score_readback.py         意图 vs 读回 → 位置 / 尺寸 / 朝向 / 缺漏
│   └── requirements.txt
└── experiments/week0-ab/
    ├── README.md                 实验流程、假设、指标
    ├── A1-natural/  A2-verbose/  B-sid/
    └── scoring/                  评分表、映射示例、理想读回
```

运行工具前：`pip install -r tools/requirements.txt`

## 说明

- 项目名用 ASCII，是因为 UE / Unity 对非 ASCII 路径不友好。
- 本仓库作者：[PAthfinderK1ng](https://github.com/PAthfinderK1ng)
