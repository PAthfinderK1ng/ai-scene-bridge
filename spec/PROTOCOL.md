# PROTOCOL · 给 AI 的场景意图协议（草稿 v0.1）

> 这份文件是写给 AI（Claude Code / Cursor 等编程 Agent）看的。拿到一个 SID 导出包时，先读完它，再动引擎。
> 人类读者：这是 [docs/02 设计草案](../docs/02-中间层设计草案-v0.md) 第 3 节的落地版。

## 0. 你拿到的是什么

两种来源的包，文件略有不同，读法一样：

```
<package>/                        「场景对话」（medium/）导出的包
├── scene.sid.json                主文件：场景意图（几何 + 语义 + 风格 + 关系 + 约束）
├── BRIEF.md                      人和 AI 都能读的搭建交代：结构决定、第一眼、主路、民居分布、色板 hex、已确认的理解、关系检查、上一轮读回后的修正要求。先读它
├── views/top.png                 俯视语义图：北朝上，台地按层着色，房子（门朝向短线）、地标、入口视锥、主路、溪、区域标签
├── views/profile.png             沿主路的侧剖面（纵向有夸张）：层带、坡度着色（红段 > 0.7）、入口小人、地标体块
├── views/first-sight.png         从出生点 1.7 m 眼高朝地标的示意透视（不是渲染）：地标在画面左 / 中 / 右、仰角、是否被挡
├── views/preview-3d.png          3D 预览截图（可能没有）
├── sid.schema.json               校验用
└── PROTOCOL.md                   本文件

<package>/                        第一版编辑器（app/）或 Python 脚本导出的包
├── scene.sid.json
├── views/top.png                 俯视正交图：网格 5/10 m，坐标刻度，比例尺，每个对象画有 id、label、尺寸、朝向箭头
├── views/iso.png                 鸟瞰示意：编辑器导出透视（kind=perspective）；脚本导出正交等轴测（kind=isometric）。可能没有
├── scene.glb                     体块与标记的几何（根节点 SID_scene，节点名 = id）。只作参考、校对；可能没有
├── assets/  refs/  README.txt    素材原文件 / 参考图 / 说明；都可能没有
└── PROTOCOL.md
```

**以 `scene.sid.json` 为准。** 图是帮你建立整体印象、核对相对关系的，坐标与尺寸一律取自 JSON。

「场景对话」导出的 SID 比第一版多这些东西，含义如下：
- `terrain.features[]` 里的台地是**多边形**：`kind: plateau`，`polygon` 是俯视多边形，`level` 是层号（0 最低），`height = level × meta.layer_height_m`，边缘坡面宽 `skirt`。高度场 = 各台地贡献取最大值：多边形内等于 `height`，外侧线性落到 0。请按这个做地形（Unity：Terrain 或按多边形挤出的网格；UE：Landscape 或 ProceduralMesh），不要用圆形山丘近似。
- `volumes[]` 里 `generated: true` 的是引擎按规则铺的民居 / 树（长边平行等高线、门朝下坡或朝路、不压路、不重叠、不跨崖），坐标同样精确；`locked: true` 的是人确认过的，一毫米不能动；`importance: landmark` 的是地标；`kind: prop` + `shape: cylinder` + `label: 树` 是树冠占位。
- `terrain.layers[]`（v0.6）是**层表**：按场景里实际的台地 / 平面分（引擎从高度场找的 `source: auto`，或人定的 `source: user`，带 `height_m` / `label` / `no`），不是 `layer_height_m` 切片；`meta.layer_zero` 是 0 层的高度（`layer_zero_from` 说明来自出生点所在层 / 人定 / 基准面），层号 `no` = 往上 +1、往下 −1。BRIEF.md 与俯视图 / 剖面的「N 层」都按它说；读回比对的「层」列也按它算。
- `paths[]`：`main_trail` 是主路（`user_drawn: true` 表示人手画的），`spur_*` 是为了让每层台地都有路可达而补的支路，`stream` 是溪（`kind: river`）。主路请做成**石阶 + 歇脚平台**，`BRIEF.md` 里有折数、爬升、台阶数估计。
- `regions[]`：每层台地一个（`terrace_level`），`kind` 为 other（民居）/ plaza（广场，不放房）/ forest（林子，只有树）/ farmland / terrace（梯田）/ gathering（聚落，更密的民居，照常放房）；`user_set: true` 的是人圈出来的多边形。
- `meta.card` 是 AI 与人商定的结构卡（原型、层数、层高、地标放置类、入口放置类、每层用途与密度、色板、时段），`meta.archetype` 是地形原型名；`meta.ignored_checks` 是人说「不重要」的关系检查。
- `relations[]` 全部由程序算出（on_top_of / faces / adjacent / visible_from / connects），可用来自检。
- `spaces[]`（可能没有）：地面之外的**地下空间**（`stratum: underground`：cave 溶洞 / tunnel 地道 / cellar 地窖 / crypt 地宫）与**空中空间**（`stratum: sky`：platform 平台 / walkway 栈道 / island 浮岛 / bridge 天桥），`markers[]` 里 `kind: connector` 的是把它们接到地面或彼此的**连接点**。怎么搭见第 3.4 节。
- `terrain.features[]` 上 `user_height: true` 的台地是人单独调过高度的层：`height` 是实际值，不再等于 `level × 层高`，照 `height` 做。`volumes[]` 上 `user_moved: true`（id 常为 `u_house_<n>`）的是人拖过的房子，和 `locked` 一样不要动。

## 1. 读法（按这个顺序）

1. `meta`：确认约定 —— 单位米、`+Y` 上、右手系、北 = `−Z`、`player_height`、`grid`。**`position` 是底面中心**，不是几何中心。
2. `intent.summary` 与 `views/top.png`：先搞清这是个什么地方、玩家从哪里看、什么是视觉中心（`importance = landmark`）。
3. `volumes` → `regions` → `paths` → `markers` → `terrain.features`：逐条读，记下 id。
4. `relations`：用它核对你对布局的理解（谁朝着谁、谁挨着谁、从出生点能看到什么）。坐标与关系冲突时以坐标为准，但要在总结里指出来。
5. `style`：`palette` 给的是精确 HEX 与角色；`color_role` 把对象连到调色板；`material_intents` 与 `lighting` 决定材质与灯。
6. `constraints`：`locked` 的对象一毫米都不能动；`must_reach` 的目标必须能从出生点走到；`min_clearance` 是路两侧的净空。
7. `asset_hints`：v0 实验里**忽略**（只用几何体）。`shape: "custom"` 的体块（编辑器导入的素材）v0 也按盒子占位到 `size`。v1 才用它换资产：有 `file` 的，优先用 `scene.glb` 里同名节点（已对齐、已缩放）；要用原文件就导入 `assets/<file>`，按 `fit=scale_to_volume` 逐轴缩放到 `size`（scale_i = size_i / 原模型包围盒_i），把原模型包围盒的 (center.x, min.y, center.z) 对齐到 `position`，`front_axis` 为 `+Z`（glTF 默认）时先绕 Y 转 180° 再施加 `rotation_y`；文件缺失或无 `file` 时按 `fallback` 退回几何体。

## 2. 坐标换算

SID：米，+Y 上，右手系，北 = −Z，`rotation_y` 0 = 朝北，俯视逆时针为正。

| | Unity | Unreal Engine |
| --- | --- | --- |
| 单位 | 米 | 厘米 |
| 上轴 / 手性 / 前方 | +Y / 左手 / +Z | +Z / 左手 / +X |
| SID (x, y, z) → 引擎位置 | (x, y, −z) | (−z·100, x·100, y·100) |
| SID 宽×高×深 (w, h, d) → 引擎缩放 | (w, h, d) | (d, w, h) |
| SID `rotation_y` → 引擎绕上轴旋转 | eulerY = −rotation_y | yaw = −rotation_y |

**底面中心 → 几何中心**：引擎原生几何体的 pivot 在几何中心，所以放置时要把高度的一半加上去（见第 3 节各几何体）。
这套公式还没有经过往返测试，**第一件事**是放一个 `rotation_y = 30`、尺寸 2×1×4 的盒子在 (5, 0, −10)，截俯视图和 `views/top.png` 对照，确认位置、朝向、长短边都一致，再继续。

注意：SID 的前向（`rotation_y` 0 = −Z）与 glTF / three.js 的模型前向（+Z）相反。编辑器与 `scene.glb` 导出已对 `shape: custom` 的素材补偿了 180°（`asset_hints[id].front_axis`，默认 `+Z`），原生几何体不受影响。

## 3. Compile：在引擎里复现

### 3.1 顺序（先布局，后外观）

1. 新建或清空场景。建根对象 `SID_scene`，所有东西挂在它下面。
2. **地面**：按 `bounds` 铺一块，颜色 = palette.ground。
3. **地形特征**：`hill` 用一个半埋的球或缩放的圆柱/圆锥占位（底面半径 = radius，露出高度 = height），颜色 = palette.foliage 或 ground；`pit` 用凹陷占位（v0 可只画一圈标记）。
4. **regions**：薄片（高 0.05 m）铺在多边形的包围盒上（能画真实多边形更好），颜色 = `surface` 对应的 palette 角色；`forest` 区域内按 `density` 撒几根 "树"（圆柱干 + 球冠），间距 ≥ 4 m。
5. **paths**：每一段用细长盒子，宽 = `width`，高 0.02 m，颜色 = `surface`。
6. **volumes**：`box` → Cube，`cylinder` → Cylinder（`rotation_y` 照常施加，只有 w≠d 的椭圆柱才看得出），`ramp` 与 `custom` → v0 一律用 Cube 占位到 `size`；名字 = id；位置、缩放、旋转按第 2 节；颜色 = palette[`color_role`]，没有 `color_role` 时按 kind：building→wall，wall→roof，rock/prop→stone，water→water。
7. **markers**：空物体，名字 = id。`light` → 点光源（暖色，`notes` 里有描述）；`player_spawn` → 空物体 + 一个 1.8 m 高的 Capsule（命名 `aux_player`）作为尺度参照，面朝 `rotation_y`。
8. **灯光**：方向光按 `style.lighting.sun_azimuth_deg`（从北顺时针，度）与 `sun_elevation_deg`；天空/环境色 = palette.sky。
9. **截图**：俯视（正交，北朝上）一张；从 `player_spawn` 位置、`player_height` 高度、朝 `rotation_y` 方向一张；有 `poi` 的再从 poi 补一张。
10. **自检**：第 4 节的 Verify 跑一遍，先修布局偏差，再修颜色。

### 3.2 各引擎几何体的尺寸基准

| 几何体 | Unity 默认 | 放置公式（SID 底面中心 (x, y, z)，尺寸 (w, h, d)） |
| --- | --- | --- |
| Cube | 1×1×1，中心 pivot | position = (x, y + h/2, −z)；localScale = (w, h, d) |
| Cylinder | 直径 1、高 2 | position = (x, y + h/2, −z)；localScale = (w, h/2, d)；eulerY = −rotation_y（正圆柱转不转一样，读回不比较朝向） |
| 空物体（markers） | 无几何 | position = (x, y, −z)，不加 h/2；读回 primitive 填 `empty` |
| Plane | 10×10，无厚度 | position = (x, y, −z)；localScale = (w/10, 1, d/10) |
| Sphere | 直径 1 | localScale = (w, h, d) |
| Capsule | 直径 1、高 2 | localScale = (w, h/2, d) |

| 几何体 | UE BasicShapes 默认 | 放置公式 |
| --- | --- | --- |
| Cube / Cylinder / Plane | 100 cm 基准，中心 pivot | location = (−z·100, x·100, (y + h/2)·100)；scale = (d, w, h)；rotation = (0, 0, −rotation_y) |
| 空 Actor（markers、灯） | 无几何 | location = (−z·100, x·100, y·100)，不加 h/2；读回 mesh 填 `empty` |

### 3.3 规则

- **名字就是 id。** GameObject / Actor 的名字必须与 SID 的 id 完全一致（小写、下划线）。你自己加的辅助物（树干、树冠、尺度参照、分段的路）名字以 `aux_` 开头。
- **不要加 SID 里没有的对象**（辅助物除外），不要删对象，不要"优化"布局。觉得不合理，写进总结，不要擅自改。
- **颜色用精确 HEX。** 不要用默认白材质，不要凭感觉配色。
- **数字直接用，不要"大约"。** 吸附到 `meta.grid` 的数字已经是最终值。
- **一次只做一步，做完就看。** 每完成一类对象截一次俯视图，和 `views/top.png` 对照。
- **不要向用户提问。** 不确定的写进最后的总结。

### 3.4 多层空间与连接点怎么搭

高度全部是**绝对值**（米，与地形同一基准），引擎已保证：地下空间顶板到地面至少 2 m 岩层，空中空间板底离地面至少 3 m。

| 字段 | 含义 |
| --- | --- |
| `spaces[].polygon` | 俯视多边形 `[x, z]`（圆角多边形，或地道 / 栈道 / 天桥的 4 点长条） |
| `spaces[].floor_y` | 可走地面的高度：地下 = 洞底；空中 = 板面 |
| `spaces[].height` | 地下 = 净高（洞底到顶板）；空中 = 板面以上可用高度。空中的板**厚 1 m，在板面之下**（板底 = `floor_y − 1`） |
| `markers[kind=connector]` | `via` 形式，`from` / `to` 是 `"ground"` 或空间 id，`position` 是**下端**，`top_y` / `bottom_y` 是两端高度 |

**地下（underground）**，二选一：
1. **挖空**：地形支持挖洞（Unity 体素 / Marching Cubes 地形、UE Landscape Hole + 网格）时，按多边形从 `floor_y` 挖到 `floor_y + height`，洞顶以上保留岩层。
2. **用盒体围合**（地形不能挖时，v0 推荐）：地板 = 多边形挤出 0.5 m 薄片（顶面在 `floor_y`）；墙 = 沿多边形每条边一块 0.5 m 厚、`height` 高的盒子；顶板 = 多边形挤出 0.5 m（底面在 `floor_y + height`）。名字 `aux_<空间 id>_floor / _wall_<n> / _ceiling`，空间本身建一个空物体 `<空间 id>` 放在质心、`floor_y` 高度。
   连接点处在地形上开一个洞口（或在洞口位置放 `aux_<连接点 id>_mouth` 标出），否则玩家下不去。

**空中（sky）**：
- **板**：多边形挤出 1 m，顶面在 `floor_y`，名字 `<空间 id>`（几何中心 y = `floor_y − 0.5`）。`walkway` / `bridge` 加 1 m 高栏杆（`aux_<id>_rail_<n>`）。
- **支撑**：`platform` / `walkway` 在多边形顶点处立柱（`aux_<id>_post_<n>`，0.4 m 见方，从该点地面到板底），柱距 > 8 m 时中间补柱；`bridge` 只在两端落地，不立中柱；`island`（浮岛）不要支撑，板下加一个倒锥形岩体（`aux_<id>_rock`）。

**连接点（connector）**：放在 `position`，从 `bottom_y` 通到 `top_y`，名字 = 连接点 id。

| via | 怎么做 |
| --- | --- |
| `stairs` 楼梯 | 直跑或折返楼梯，每级高 0.17 m、深 0.3 m，宽 1.5 m；落差 > 3 m 每 3 m 加一个歇脚平台 |
| `ladder` 梯子 | 0.6 m 宽竖梯，贴着空间边缘，顶部留 1 m 开口 |
| `well` 井 | 直径 2 m 圆筒井口（地面以上 0.8 m 井栏）+ 内侧竖梯 |
| `shaft` 竖井 | 2×2 m 方形竖井 + 竖梯，口部加盖板边框 |
| `elevator` 升降台 | 2×2 m 平台 + 四角导轨，从 `bottom_y` 到 `top_y` |
| `rope_bridge` 索桥 | 从 `position` 到所连空间最近的边，悬索步道宽 1.2 m |
| `ramp` 坡道 | 坡度 ≤ 1:3 的折返坡道，宽 2 m |

自检：从出生点能走到每个连接点的上 / 下端；地下空间的顶板不能露出地面；空中板底下不能有地形穿出。BRIEF.md 的「空间层」一节会列出每个空间与它的连接点。

## 4. Verify：读回、比对、修正

### 4.1 读回格式

把场景里 `SID_scene` 根对象下的全部对象导出为 JSON（通过 MCP 查询层级与 transform，或引擎脚本）：

Unity：
```json
{ "engine": "unity",
  "objects": [
    { "name": "house_1", "primitive": "cube", "position": [-10, 2, 6], "scale": [6, 4, 5], "euler_y": -240 },
    { "name": "spawn", "primitive": "empty", "position": [0, 0, -34], "scale": [1, 1, 1], "euler_y": 0 }
  ] }
```
`position` = `transform.position`（几何中心），`scale` = `localScale`，`euler_y` = `transform.eulerAngles.y`，`primitive` ∈ cube / cylinder / plane / sphere / capsule / empty / mesh。空物体（标记、灯）必须填 `empty`，否则会被当成 1 m 的盒子、高度差 −0.5 m。

Unreal：
```json
{ "engine": "unreal",
  "objects": [
    { "name": "house_1", "mesh": "cube", "location": [600, -1000, 200], "scale": [5, 6, 4], "yaw": -240 },
    { "name": "spawn", "mesh": "empty", "location": [-3400, 0, 0], "scale": [1, 1, 1], "yaw": 0 }
  ] }
```
`mesh` ∈ cube / cylinder / plane / sphere / cone / empty。

每个对象可以再带一个 `color` 字段（材质主色的精确 HEX，`"#RRGGBB"`，如 `"color": "#D9C9A3"`）。带了评分脚本就会把它与意图里该对象 `color_role` 对应的 `style.palette` HEX 比色差（CIE76 ΔE ≤ 10 合格）；不带则颜色不计分。

直接导入 `scene.glb` 的情况（实验 D 组）：glb 节点的 translation 已经是底面中心、scale 就是 (w, h, d)，不要再按原生几何体减半高；读回请直接写成 SID 形态（`volumes[].position/size/rotation_y`，SID 坐标系），或在 Unity 格式里把 `primitive` 填 `mesh`。

区域 / 路径 / 地形的复现物（薄片、路段、半球）名字按 id 或 `aux_<id>_*` 命名；评分脚本默认不对它们计分、也不算"多余"。

写到导出包同级的 `readback.json`。评分脚本 `tools/score_readback.py` 会把它换算回 SID 坐标并与意图比较。

### 4.2 阈值与处理

| 指标 | 阈值 | 超了怎么办 |
| --- | --- | --- |
| 位置误差（XZ 平面） | < 1 m | 直接改 transform |
| 尺寸比（最大维度） | 0.8–1.25 | 改 scale；注意 Cylinder 高是 scale.y × 2 |
| 朝向差 | < 20° | 先查符号（−rotation_y），再查长短边是否对调 |
| 缺漏 / 多余 | 0 | 补上 / 删掉 |
| 台地层（每个体块，`level_ok`） | 读回位置落在的层 = 意图位置的层。层按场景里**实际的台地**分（高度场里的平坦面、台地多边形、基准面），不是按 `layer_height_m` 切片：出生点所在层为 0，往上 +1、往下 −1，点归到高度最近的层；地形按 `terrain.features` 的高度函数算，`summary.layers` 给出每层高度 | 把体块挪回它该在的台地多边形内；别只改 y |
| 出生点看见地标（`summary.visible_from_spawn.readback`） | 与意图一致（从 `player_spawn` 位置 `player_height` 眼高到地标顶部，沿线每 1 m 采样：地形 + 0.3 m 不高过视线、不穿过任何体块 OBB） | 看 `blocked_by`：`terrain` 查地形有没有做高了，`volume:<名字>` 把那个体块挪开或压矮 |
| 主路连通（`summary.trail_connected.readback`） | 与意图一致（2 m 网格 BFS，可走 = 坡度 ≤ 0.7 或在路走廊内；路走廊 = 到路中心线 ≤ 宽/2 + 1 m；终点 = 距地标中心 ≤ 6 m 的任一格） | 路段要连续、按 `aux_<path_id>_*` 命名、从 `player_spawn` 一直铺到地标门前；台地墙处靠路爬坡 |
| 颜色（读回带 `color` 时，`color_ok`） | CIE76 ΔE ≤ 10（与 `color_role` → `style.palette` 的 HEX 比） | 重设材质，直接用 HEX |

先修布局，再修外观。修完再读回一次。

### 4.3 「场景对话」里的读回验收

把 `readback.json` 导入「场景对话」（出 → 导入读回 JSON 对比），差的对象在俯视图上标成红点，每个红点三选一：**按意图修**（写进下一轮 `BRIEF.md` 的「修正要求」，请按意图位置重放）、**接受引擎版**（意图跟着引擎改并锁住，下轮不要再动它）、**不重要**。
除位置 / 尺寸 / 朝向外，评分脚本还会算三件事并在表格里显示：出生点能否看见地标（`relations` 里有 `visible_from`）、主路是否从出生点一直到地标门前（`must_reach`）、每栋房子是否落在它该在的台地层上（表格「层」列）；读回带 `color` 时再比颜色（「颜色」列的 ΔE）。层或颜色不对的对象同样标红点、同样三选一。

## 5. Draft：从文字生成 SID（本实验不用，供「生成后引导」流程）

- 单位米、`player_height` 1.8、所有数字吸附 0.5 m 网格。
- 先定 `bounds` 与 `importance = landmark` 的对象，再放 primary，再 secondary，最后 detail。
- 每个对象必须有 `label`（人话）与 `notes`（为什么放这儿）；`relations` 至少覆盖每个 primary 对象一条。
- 不重叠；路两侧留 ≥ 3 m；出生点不在体块里，面朝视觉中心。
- `style.palette` 至少 5 个角色，HEX 精确；`intent.summary` 一段话说清"玩家第一眼看到什么"。
- 写完用 `spec/sid.schema.json` 校验。

## 6. 常见错误

1. 忘了 `position` 是底面中心，整个场景陷进地里一半。
2. Unity 忘了 Z 取负，南北颠倒；或者只翻了位置没翻旋转。
3. UE 把 (w, h, d) 直接当 scale，长短边与高度全错。
4. 把 Cylinder 的 `size` 当半径（它是直径）；把 Unity Cylinder 的 scale.y 当高度（高是 2 倍）。
5. 朝向符号反了：所有房子的门都背对广场。看 `relations` 里的 `faces` 就能发现。
6. 用"大约"的数字、随意的颜色、自己起的名字。
7. 一口气全建完才看一眼。
