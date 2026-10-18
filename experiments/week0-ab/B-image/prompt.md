# B · 文字 + 标注俯视图，无 JSON（直接整段粘贴给 Agent；把 `<B>` 换成本目录的实际路径）

> 准备：把 B-sid 包里的 `views/top.png` 复制到本目录。本组只给 A1 的自然语言 + 这一张图，不给 SID、不给 PROTOCOL。

帮我在 Unity 里搭一个黄昏时分的小村口场景。`<B>/top.png` 是我画的俯视图：北朝上，网格 5 / 10 m，左下角有 10 m 比例尺，每个对象上标了名字、尺寸（宽×高×深，米）和朝向箭头，坐标轴刻度就是场景坐标（x 向东，图上方是 −z 即北）。

中间一口石井，四栋木屋围着井，门都朝着井，房子大概一层楼高，西北那栋最大。一条土路从南边进村，接上广场，再从广场北边往西北绕过山脚出村。村子北边靠着一座不高的缓坡山，东边是一片林子，和广场之间有一道歪歪的木栅栏。玩家从南边路口出生，面朝北，第一眼就该看到井和背后的山。整体低饱和、黄昏逆光。

## 搭建要求

- 引擎：Unity，就用当前打开的空场景，通过 MCP 操作。不要导入外部资产，只用原生几何体（Cube / Cylinder / Plane / Sphere / Capsule）和纯色材质。
- 单位米，玩家身高 1.8 m。放一个 1.8 m 高的 Capsule 在出生点作为尺度参照，命名 `aux_player`。
- 建一个根对象 `SID_scene`，所有东西挂在它下面。每个对象用图上标的名字命名（例如 `house_1`、`well`、`main_road_s`）；你自己加的辅助物（树干、树冠、分段的路等）名字以 `aux_` 开头。
- 图上的坐标是右手系、北 = −z；Unity 是左手系、北 = +z，放进 Unity 时 z 要取负、绕 Y 的旋转取负。
- 材质颜色用具体 HEX 值，不要留默认白。
- 不要向我提问，自行决定。最多自我迭代 3 轮（每轮：建 / 改 → 截俯视图和我的图对照 → 修）。
- 做完后交付三样东西：
  1. 两张截图：俯视（正交，北朝上）一张，从出生点、1.8 m 高、朝北看一张。
  2. 读回文件 `readback.json`，格式如下（`position` 用 `transform.position`，`scale` 用 `localScale`，`euler_y` 用 `transform.eulerAngles.y`，`primitive` 填 cube / cylinder / plane / sphere / capsule / empty），把 `SID_scene` 下的全部对象都列进去：
     ```json
     { "engine": "unity",
       "objects": [
         { "name": "house_1", "primitive": "cube", "position": [-10, 2, 6], "scale": [6, 4, 5], "euler_y": -240 }
       ] }
     ```
  3. 3–5 句话：你对这个场景的理解、哪里拿不准、你做了什么假设。
