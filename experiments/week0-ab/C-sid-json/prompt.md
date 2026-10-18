# C · SID JSON + 预计算关系，无图（直接整段粘贴给 Agent；把 `<C>` 换成本目录的实际路径）

> 准备：把 B-sid 包复制一份为 C-sid-json，**删掉 `views/` 目录**，`scene.sid.json` 里的 `views` 字段清空为 `[]`。其余（`scene.sid.json`、`PROTOCOL.md`）不变。本组不允许 AI 看任何图片，也不允许它截图自检。

帮我在 Unity 里搭一个黄昏时分的小村口场景。场景的完整意图在 `<C>/scene.sid.json`。

先读 `<C>/PROTOCOL.md`，按它的「读法」顺序读完 `scene.sid.json`，再按「Compile」章节在引擎里复现，最后按「Verify」章节读回、比对、修正。坐标换算以 PROTOCOL 第 2 节为准，动手前先放一个测试盒子核对换算方向。`asset_hints` 这次忽略，只用几何体。**本次不提供任何图片，也不要截图**；布局完全依据 JSON 里的坐标、尺寸、朝向与 `relations`。

## 搭建要求

- 引擎：Unity，就用当前打开的空场景，通过 MCP 操作。不要导入外部资产，只用原生几何体（Cube / Cylinder / Plane / Sphere / Capsule）和纯色材质。
- 单位米，玩家身高 1.8 m。放一个 1.8 m 高的 Capsule 在出生点作为尺度参照，命名 `aux_player`。
- 建一个根对象 `SID_scene`，所有东西挂在它下面。每个对象的名字必须与 SID 里的 `id` 完全一致（例如 `house_1`、`well`、`main_road_s`）；你自己加的辅助物（树干、树冠、分段的路等）名字以 `aux_` 开头。
- 材质颜色用 SID 调色板里的 HEX 值，不要留默认白。
- 不要向我提问，自行决定。最多自我迭代 3 轮（每轮：建 / 改 → 经 MCP 读回层级与 transform 和 JSON 对照 → 修），不截图。
- 做完后交付三样东西：
  1. 读回文件 `readback.json`，格式如下（`position` 用 `transform.position`，`scale` 用 `localScale`，`euler_y` 用 `transform.eulerAngles.y`，`primitive` 填 cube / cylinder / plane / sphere / capsule / empty），把 `SID_scene` 下的全部对象都列进去：
     ```json
     { "engine": "unity",
       "objects": [
         { "name": "house_1", "primitive": "cube", "position": [-10, 2, 6], "scale": [6, 4, 5], "euler_y": -240 }
       ] }
     ```
  2. 两张截图由**我**来截（俯视、出生点视角），你不用管。
  3. 3–5 句话：你对这个场景的理解、哪里拿不准、你做了什么假设。
