# 第 0 周实验 · 纯文字 vs SID + 俯视图

> 目的：在写任何编辑器代码之前，用一个场景、一套引擎、一个模型，验证「结构化场景意图 + 图」是否比「自然语言」更能让 AI 复现用户想要的布局。
> 不写编辑器；B 条件的输入由 `tools/render_topdown.py` 从手写 SID 生成。

## 要验证的假设

| 编号 | 假设 | 若成立意味着 |
| --- | --- | --- |
| H1 | B（SID + 俯视图）的布局还原度明显高于 A1（用户随手写的自然语言） | 痛点 P2 成立，中间层有价值 |
| H2 | B 的还原度仍明显高于 A2（把全部数字都用文字说清的"尽力描述"） | 结构化 + 图本身提升了 AI 的执行，格式与图是核心 |
| H3 | 三个条件都做不到位置误差 < 1 m | 瓶颈在执行端（MCP / 引擎脚本），先做编译器与协议，不急做编辑器 |

结果怎么读：

- B ≫ A1 且 B ≈ A2：价值主要在**产生描述**（工具帮用户把脑子里的画面变成完整、无歧义的描述），编辑器值得做，重点是编辑体验与自动补全关系，而不是导出格式本身。
- B ≫ A2：**格式与图**对 AI 有直接帮助，优先把导出包做扎实。
- B ≈ A1：先别做编辑器，先做 Unity / UE 的导入脚本与 PROTOCOL，把执行端打通。

## 条件

| 条件 | 输入 | 目录 |
| --- | --- | --- |
| A1 自然描述 | 一段用户会随手写的话 | [A1-natural/prompt.md](A1-natural/prompt.md) |
| A2 尽力描述 | 把 SID 里的全部数字与颜色都用文字说清 | [A2-verbose/prompt.md](A2-verbose/prompt.md) |
| B SID + 图 | `scene.sid.json` + `views/top.png` + `views/iso.png` + `PROTOCOL.md` | [B-sid/prompt.md](B-sid/prompt.md) |

三个条件的「搭建要求」段完全相同，唯一变量是意图的传达方式。

## 环境

- Unity 6.x（任意），新建 3D 空项目，空场景（只保留 Main Camera 与 Directional Light）。
- 一个 Unity MCP server（如 CoplayDev/unity-mcp），接到 Claude Code（或 Cursor）。记录 server 名称与版本。
- 模型固定（记录名称与日期）。每次运行用**新会话**，避免上一轮的记忆污染。
- B 条件：把 `B-sid/` 整个目录放到 Agent 能读到的位置（例如 Unity 项目根目录下的 `sid/`），prompt 里的路径按实际改。
- UE 作为第二轮，流程相同，把 prompt 里的 Unity 字样换成 UE，读回用 `"engine": "unreal"` 格式。

## 流程

1. 生成 B 包（已生成，改了 SID 后重跑）：
   ```bash
   python tools/render_topdown.py spec/examples/village-square.sid.json --out-dir experiments/week0-ab/B-sid --iso --emit-sid
   ```
   然后把 `spec/PROTOCOL.md` 复制到 `B-sid/PROTOCOL.md`（已复制）。
2. 每个条件跑 2 次，顺序交替（A1, B, A2, A2, B, A1），模型有随机性，单次结果不作数。
3. 每次：清空场景 → 新会话 → 粘贴 prompt → 不中途提示 → 记录自迭代轮数、耗时、token。
4. 收集产物到 `runs/<条件>-<轮次>/`：
   - `readback.json`（AI 导出，格式见 prompt 末尾）
   - `top.png`、`spawn.png`（AI 截的两张图）
   - `summary.md`（AI 的 3–5 句说明）
   - `transcript.md`（对话记录，可选）
5. 评分：
   ```bash
   python tools/score_readback.py spec/examples/village-square.sid.json experiments/week0-ab/runs/B-1/readback.json --out experiments/week0-ab/runs/B-1/score.json
   ```
   A 条件里 AI 自己起的名字对不上 SID 的 id，先看脚本打印的「最近邻建议映射」，确认后写成 `map.json` 再跑一遍（或加 `--auto-map`）。
6. 人评两项（1–5）：颜色 / 风格符合度，整体「像不像我要的」。两人独立打分更好。
7. 把每次结果填进 [scoring/score-sheet.md](scoring/score-sheet.md)。

## 指标（与 docs/02 第 8 节一致）

| 指标 | 定义 | 目标 |
| --- | --- | --- |
| 位置误差 | 意图与实际的 XZ 平面距离，均值 / 中位数 | < 1 m |
| 位置合格率 | 误差 < 1 m 的对象比例 | 越高越好 |
| 尺寸合格率 | 最大维度比在 0.8–1.25 内 | 越高越好 |
| 朝向合格率 | 绕上轴差 < 20°（盒子同时报 mod 180 的版本） | 越高越好 |
| 缺漏 / 多余 | 对象计数差 | 0 |
| 颜色人评、整体人评 | 1–5 | ≥ 4 |
| 自迭代轮数、耗时 | 过程成本 | 越少越好 |

## 注意

- A 条件的 prompt 里**不能**出现 SID、PROTOCOL、俯视图；Agent 的 cwd 里也别放 B 包。
- 三个条件对「搭建要求」的措辞必须一字不差，改一处就三处都改。
- 不要在中途纠正 AI。它问问题就当它没问，等它自己决定。
- `readback.json` 的 `position` 是 Unity 的 `transform.position`（几何中心），脚本会按几何体类型换算回底面中心；AI 若用了别的几何体（如 Quad），在 `primitive` 字段写明。
- 结果不理想时先看最大的错误是什么（南北颠倒？陷进地里？朝向全反？），这些是 PROTOCOL 该补的坑，不是 SID 格式的问题。
- 手写 SID 时朝向最容易错：第一版示例里四栋房子的 `rotation_y` 全部背对了井，路还从井上穿过，渲染成俯视图一眼就看出来、纯看 JSON 看不出来。改 SID 后务必重跑渲染并看图，再开实验。

## 调研报告后的修订：改为四组对照（v2）

调研报告（[docs/01 §5.2](../../docs/01-调研-痛点验证与可行性.md)）指出两点必须改：(1) **"JSON" 与 "JSON + 图" 要分开测**，因为 LayoutVLM 的消融显示图像主要改善碰撞而非位置 / 旋转，合在一起测分不清是谁的功劳；(2) 必须加一组**引擎内灰盒由 Agent 经 MCP 读层级**的对照，否则无法证明中间层优于这条免费替代路线。修订后的四组：

| 条件 | 输入 | 怎么准备 | 目录 |
| --- | --- | --- | --- |
| A | 纯文字（A1 随手写 / A2 尽力描述） | 现有 | A1-natural / A2-verbose |
| B | 文字 + 标注俯视图 PNG（无 JSON） | 用 B 包里的 `views/top.png` + A1 的文字 | B-image |
| C | SID JSON + 预计算关系 + PROTOCOL（**无图**） | 用编辑器或脚本导出，删掉 `views/` | C-sid-json |
| D | 引擎内灰盒 | 把编辑器导出的 `scene.glb` 导入 Unity（或人用 ProBuilder 照俯视图搭），新会话让 Agent 经 MCP 读层级，要求"不改布局，只做材质 / 灯光 / 标记" | D-engine-greybox |

原来的 B（SID + 俯视图 + PROTOCOL）保留为 B+C 的合并组，可选跑。

**判读规则**（来自报告）：C ≫ A/B 且 C ≈ D → 中间层的价值只剩"不开引擎 + 预计算关系 + 语义 / 色彩标注"，做 Unity 插件而不是独立工具；D ≫ C → 放弃独立输入端，只做"标注 + 校验"插件；A ≈ C → 重新审视 P2。

**新增度量**：AABB 重叠 > 5 cm 的计数、越出 bounds 计数、对话轮数、总 token（Claude Code `/usage`）、MCP 调用数、墙钟时间。`score_readback.py` 算位置 / 尺寸 / 朝向 / 缺漏，外加台地层、出生点可见地标、主路连通、颜色 ΔE（读回带 `color` 时）；重叠与越界先手数或用编辑器的「校验」按钮对读回文件跑一遍。

**场景**：先用村口广场（户外、有视线与高差，P2 更敏感）；报告建议再加一个 8×6×3 m、14 物体的室内房间作为第二场景（4 墙 + 门 + 2 窗 + 桌 + 4 椅 + 吊灯 + 台灯 + 书架），室内是求解器路线覆盖最好的领域，能看出中间层相对学术方案的增量。

## 本目录

```
week0-ab/
├── README.md
├── A1-natural/prompt.md          A 纯文字（随手写）
├── A2-verbose/prompt.md          A 纯文字（尽力描述）
├── B-image/prompt.md             B 文字 + 标注俯视图，无 JSON（图从 B-sid/views 复制）
├── C-sid-json/prompt.md          C SID JSON + 关系 + PROTOCOL，无图（从 B-sid 复制后删 views/）
├── D-engine-greybox/prompt.md    D 引擎内灰盒（导入 scene.glb），Agent 读层级只做上装
├── B-sid/                        B+C 合并组（可选）
│   ├── prompt.md
│   ├── scene.sid.json        （由 render_topdown.py --emit-sid 生成，含 views）
│   ├── views/top.png
│   ├── views/iso.png
│   └── PROTOCOL.md           （复制自 spec/PROTOCOL.md）
├── scoring/
│   ├── score-sheet.md
│   ├── map.example.json
│   ├── readback.example-unity.json   （由 SID 按 PROTOCOL 公式生成的理想读回，用来自检脚本）
│   ├── terraced.sid.json             （「场景对话」导出的 4 层台地山村，自检台地层 / 可见性 / 连通性 / 颜色）
│   ├── terraced.readback.example-unity.json          （上者的理想读回，带 color 与 aux_main_trail_* 路段：应全合格）
│   └── terraced.readback.example-unity-broken.json   （故意弄坏：一栋房挪层、地标前 20 m 体块、一栋房颜色错、主路没爬上去）
└── runs/                     （实验产物，按 <条件>-<轮次> 建目录）
```
