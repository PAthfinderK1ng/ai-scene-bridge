# app · SID 编辑器（MVP v0）

在浏览器里摆体块、标语义、取色，导出 AI 能读的实验包。纯静态网页，不用装 Node、不用构建。

## 启动

双击仓库根目录的 `run-editor.bat`，或在仓库根目录执行：

```bash
python -m http.server 8765 --bind 127.0.0.1
```

然后打开 <http://localhost:8765/app/>。必须从**仓库根目录**启动，「示例」按钮和导出包里的 PROTOCOL.md 都靠相对路径去读 `spec/`。

需要联网：three.js 与 JSZip 从 jsdelivr CDN 加载。

## 能做什么

| 功能 | 怎么用 |
| --- | --- |
| 打开 / 保存 SID | 工具栏「打开」「保存」（保存走浏览器下载，文件名 `<名称>.sid.json`） |
| 加载示例 | 「示例」读取 `spec/examples/village-square.sid.json` |
| 添加 | 盒子、圆柱、标记（第一个是出生点）、区域（10×10 矩形）、山丘；都放在当前视角中心 |
| 画路径 | 「画路径」后在地面点击加点，双击或回车结束，Esc 取消 |
| 导入素材 | glTF / GLB（含 Draco 压缩），按包围盒作为 `shape: custom` 的体块放入；glTF 正面朝 +Z、SID 的 0° 朝北，默认补偿 180°（面板可切 `front_axis`）；导出包会带原文件 |
| 选择 / 变换 | 点选；W 移动、E 绕 Y 旋转、R 缩放；移动吸附到网格（场景面板「网格 m」，默认 0.5），旋转吸附 5°，缩放吸附 0.5 m；区域 / 路径 / 山丘只能移动，标记不能缩放；只写回真正拖动过的分量 |
| 视角 | 左键旋转、右键平移、滚轮缩放；T 俯视 / 透视；F 全景；L 标签 |
| 属性 | 右侧「选中对象」：id、kind、label、位置、尺寸、朝向、color_role、material_intent、资产检索词、备注 |
| 场景与意图 | 名称、一句话意图、情绪词、玩家身高、网格、bounds、光照、参考图路径 |
| 调色板 | 角色 + HEX + 说明；体块的 color_role、区域 / 路径的 surface 引用它 |
| 关系 | faces / adjacent / visible_from… 给 AI 看 |
| 校验 | id、引用、越界、体块重叠、标记在体块内、faces 朝向一致性、adjacent 间距 |
| 导出实验包 | zip：`scene.sid.json`（含 views）、`views/top.png`（俯视，带坐标刻度）、`views/iso.png`（鸟瞰透视，相机参数写进 views）、`scene.glb`（根节点 `SID_scene`）、`PROTOCOL.md`、`assets/`、`README.txt`；文件名用场景名（中文可用） |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Y（或 Ctrl+Shift+Z） |

## 约定（与 spec 一致）

单位米；+Y 上；右手系；北 = −Z（俯视图上方）；`position` 是底面中心；`rotation_y` 0 = 朝北，俯视逆时针为正；盒子顶上的小箭头就是朝向。

## 已知限制（v0）

- 区域和路径只能整体拖动，改形状要在面板里改数字；没有顶点手柄。
- 山丘是示意用的半球，不是真实地形；导出的 glb 不含区域、路径、地形。
- 导入的素材只在本次会话里有效，保存的 SID 只记文件名（`asset_hints[id].file`）；重新打开后按盒子显示，再导入同名文件即可接上；导出包里会带原文件。
- 必须从 http://localhost 打开：直接双击 index.html 浏览器会拒绝加载模块脚本，页面会在状态栏提示。
- Windows 显示缩放 125% / 150% 已处理（画布按设备像素比渲染、CSS 尺寸跟随容器）。
- 没有网格编辑、材质编辑、灯光烘焙，也不打算有。
- 文件结构：`state.js` 数据与撤销、`scene3d.js` 三维视口与导出渲染、`panels.js` 右侧面板、`validate.js` 校验、`exporter.js` 打包、`main.js` 接线。
