# A1 · 自然描述（直接整段粘贴给 Agent）

帮我在 Unity 里搭一个黄昏时分的小村口场景。

中间一口石井，四栋木屋围着井，门都朝着井，房子大概一层楼高，西北那栋最大。一条土路从南边进村，穿过广场，过了井往西北绕出去。村子北边靠着一座不高的缓坡山，东边是一片林子，和广场之间有一道歪歪的木栅栏。玩家从南边路口出生，面朝北，第一眼就该看到井和背后的山。整体低饱和、黄昏逆光，有人气但没人。

## 搭建要求

- 引擎：Unity，就用当前打开的空场景，通过 MCP 操作。不要导入外部资产，只用原生几何体（Cube / Cylinder / Plane / Sphere / Capsule）和纯色材质。
- 单位米，玩家身高 1.8 m。放一个 1.8 m 高的 Capsule 在出生点作为尺度参照，命名 `aux_player`。
- 建一个根对象 `SID_scene`，所有东西挂在它下面。每个对象起有意义的英文小写下划线名（例如 `house_1`、`well`、`main_road`）；你自己加的辅助物（树干、树冠、分段的路等）名字以 `aux_` 开头。
- 材质颜色用具体 HEX 值，不要留默认白。
- 不要向我提问，自行决定。最多自我迭代 3 轮（每轮：建 / 改 → 截俯视图看一眼 → 修）。
- 做完后交付三样东西：
  1. 两张截图：俯视（正交，北朝上）一张，从出生点、1.8 m 高、朝北看一张。
  2. 读回文件 `readback.json`，格式如下（`position` 用 `transform.position`，`scale` 用 `localScale`，`euler_y` 用 `transform.eulerAngles.y`，`primitive` 填 cube / cylinder / plane / sphere / capsule / empty），把 `SID_scene` 下的全部对象都列进去：
     ```json
     { "engine": "unity",
       "objects": [
         { "name": "house_1", "primitive": "cube", "position": [-10, 2, 6], "scale": [6, 4, 5], "euler_y": -20 }
       ] }
     ```
  3. 3–5 句话：你对这个场景的理解、哪里拿不准、你做了什么假设。
