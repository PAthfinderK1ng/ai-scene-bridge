# 场景对话 · 确定性几何引擎规范（v1）

> 这是正式版「场景对话」的内核。原则只有一条：**LLM 永远不写坐标**。房子、路、台阶、高度、朝向、可见性、颜色数值全部由这里的纯函数算出；LLM 只给结构级提案（地形原型 + 参数、地标放哪类位置、每层密度、调色板角色）和语义（名字、材质意图、备注）。
> 所有模块是浏览器 ES module（无构建、无依赖），纯函数、确定性（随机只来自传入的 `seed`），跑在 `medium/engine/`。测试页在 `medium/engine/tests/`，用 `python tools/run_browser_test.py <页面>` 跑（无头 Edge）。

## 0. 坐标与单位（与 spec/sid.schema.json 一致）

- 单位米。x 向东，z 向南（+z 南，−z 北），y 向上。右手系，同 glTF / three.js。
- 俯视图上方是北（−z）。`rotation_y`：0 = 朝北（−z），俯视逆时针为正；朝向向量 = (−sin θ, 0, −cos θ)。
- 体块 `position` 是**底面中心**；`size` = [宽 x, 高 y, 深 z]。
- 场景默认 `bounds` = min [−60, 0, −60]，max [60, 40, 60]（120 m 见方）。
- 高度显示单位是「层」：`meta.layer_height_m`（默认 3）。层号 = round((h − base) / layer)。
- 所有点用 `[x, z]`（俯视二维）；需要高度时另给 y。

## 1. 地形（terrain.js，已实现）

### SID 扩展（D13）
`terrain.features[]`（schema 已要求 `id/kind/center/radius/height`）新增可选字段：
- `polygon: [[x,z],...]`：平台的俯视多边形（3–32 点；溪谷两岸的长条带 18 点）。有 `polygon` 时 `center`/`radius` 由引擎回填为质心与外接半径。
- `level: int`：层号（0 = 最低），`height = level * layer_height_m`。
- `skirt: number`：平台边缘坡面宽度（米），默认 clamp(height × 0.8, 2, 10)。
- `kind` 新增 `plateau`（有 polygon 的台地）；`hill` 为圆形穹顶；`pit` 负穹顶；`ridge` 同 plateau；`cliff` 只作标注。

### 高度函数
`h(x,z) = base + max(各正特征贡献) + sum(各负特征贡献)`：
- plateau：多边形内 = height；外侧 = height × max(0, 1 − d/skirt)，d 为到多边形边的距离。
- hill：height × max(0, 1 − (r/R)²)。pit 同形取负。
用 max 叠加，上层台地多边形落在下层之内就自然形成叠落。

### 接口
```js
import { buildTerrain, MIN_BAND, MIN_BAND_HARD } from "./terrain.js";
const T = buildTerrain(sid, { res: 2 });   // res = 网格米数
T.heightAt(x, z)            // 双线性插值，米
T.gradientAt(x, z)          // [dh/dx, dh/dz]
T.slopeAt(x, z)             // |gradient|，无量纲（0.6 ≈ 31°，0.7 ≈ 35°）
T.levelAt(x, z)             // 层号（整数）
T.terraces                  // [{ id, index, level, height, polygon, centroid, feature }] 按 height 升序
T.terraceAt(x, z)           // 点所在的最高台地或 null
T.contours(step = T.layer)  // [{ level, height, segments: [[[x,z],[x,z]], ...] }] marching squares
T.valleyLine()              // [[x,z],...] 每行最低点连成的折线（自北向南）
T.sampleProfile(points)     // 沿折线每 1 m 采样 → [{ d, x, z, h }]
T.inside(x, z)              // 是否在 bounds 内
T.grid                      // { xmin, zmin, res, nx, nz, h: Float32Array }
```

### 原型（v3；v4 起只在 tests/fixtures.js 里给测试造样例，产品地形来自 plan.js）
```js
import { generateArchetype, ARCHETYPES } from "./tests/fixtures.js";
generateArchetype(name, params, bounds, seed) → {
  features,                 // 写进 sid.terrain.features 的数组（含 polygon / level / center / radius / height）
  stream,                   // [[x,z],...] 或 null（溪流中心线，自北向南）
  spots: {                  // 地标候选点
    top: [x,z], ridge_end: [x,z], cliff_edge: [x,z], plaza: [x,z], entry: [x,z] },  // cliff_edge 一律在顶层（环台 = 顶层环带朝广场一侧，溪谷 = 东岸顶层朝谷口一段）；plaza 在中间那层（层数 / 2 取整）
  entries: { S: [x,z], E: [x,z], W: [x,z] },     // 入口候选（在 bounds 边缘、低处）
  summit: [x,z], valley_bottom: [x,z],            // 出生点候选
  layer_height_m,
}
```
`name ∈ ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"]`
`params = { entry_side: "S"|"E"|"W", terraces: 3..7, layer_height_m: 2.5..6, plateau_width: "narrow"|"medium"|"wide", stream: boolean }`
三种原型都先在「入口在南、上坡朝北」的局部坐标生成，再按 `entry_side` 旋转：E → (x,z)→(z,−x)，W → (x,z)→(−z,x)。
- 窄台地：溪谷两岸与环台的每条台地带宽 ≥ 8 m（`MIN_BAND`）；层多到 bounds 放不下时先收溪的摆幅、再收带宽，但不低于 7 m（`MIN_BAND_HARD`）。
- `spots.entry`（村口）：最低一层朝入口一侧的平地，离入口山脚（`valley_bottom`）8–12 m。之字坡在第 1 层台地边往里 3 m；环台 / 溪谷的第 1 层台地离入口太远时落在台地外同高（第 1 层）的平地上（溪谷在谷口东岸、离溪 7.5 m）。

## 2. 房屋布局（layout.js）

```js
import { layoutHouses, scatterTrees, HOUSE_SIZES } from "./layout.js";
layoutHouses(sid, T, opts) → { volumes: Volume[], perTerrace: {[level]: n}, rejected: {reason: n}, filled: n }
```
- 输入：`sid.regions[]`（每个台地一个 region：`polygon`、`kind`、`density` 0–1.6、可选 `terrace_level`）；没有 regions 时按 `T.terraces` 全部铺。`kind === "forest"` 调 `scatterTrees`，`gathering`（聚落）与 `other` 一样放房（密度由 density 定），`plaza` 不放房只铺地，`farmland`/`terrace`（梯田）不放房。
- 规则（全部由算法保证，不靠 AI）：
  1. 房子完全在所在台地多边形内（内缩 2 m），且 `T.terraceAt` 四个底角同一层（不跨崖）。
  2. 间距随密度：density 1 → 中心距约 9 m；0.5 → 14 m；1.5 → 6.5 m。用种子化的泊松盘 / 抖动网格采样。
  3. 不压路：到任何 `sid.paths` 折线的距离 ≥ 路宽/2 + 2.5 m；不压溪（kind river）≥ 路宽/2 + 3 m；离地标体块 ≥ 4 m；互不重叠（OBB）。
  4. 朝向：长边平行等高线（即垂直于 `gradientAt`），门朝下坡；若 12 m 内有路，门改朝最近的路点。`rotation_y` 按第 0 节约定。
  5. 尺寸从 `HOUSE_SIZES`（宽 5–7、高 3.5–4.5、深 4–6）按种子抖动；`position.y = T.heightAt(x,z)`。
  6. id：`house_<level>_<序号>`；`kind: "building"`，`shape: "box"`，`importance: "secondary"`，`color_role: "wall"`，`generated: true`。
  7. 窄带兜底（`fillBand`）：一块区域按上面的规则一栋都没放下（或不到 2 栋，区域密度 ≥ 0.75 时）——常见于 7–10 m 宽的环带 / 溪谷带——就在区域内 1.5 m 网格上按「离边最远」排序（带的中线优先），用最小的房子（宽 5、深 3.5–4 m）再放；朝向先按规则 4，放不下再试朝下坡 / 朝外（长边自然顺着带长方向）。全图密度 ≥ 0.75 却不到 6 栋时，再按面积从大到小每块多放一栋。规则 1、3 照旧。`filled` 是兜底放下的栋数。
- `scatterTrees(region, T, density, seed) → Volume[]`：圆柱体块 `kind: "prop"`，`label: "树"`，size [5, 7, 5] 抖动，间距 4–6 m，`generated: true`。
- 确定性：同一 `(sid, opts.seed)` 两次调用结果逐字节相同。

## 3. 路由（routing.js）

```js
import { routeTrail, zigzagTrail, routeStream, pathFacts, simplify } from "./routing.js";
routeTrail(T, from, to, { maxSlope = 0.7, res = 2, avoidPolys = [], seed }) → { points, facts }
zigzagTrail(T, from, to, { folds, maxSlope }) → { points, facts }      // 指定折返数（0 = 直上）
routeStream(T, bounds) → [[x,z],...]                                     // 沿 valleyLine 自北向南，起终点在 bounds 边缘
pathFacts(points, T) → { length_m, climb_m, descent_m, folds, max_slope, steps_estimate, segments: [{ from, to, length, slope }] }
simplify(points, tolerance_m) → points                                     // Douglas–Peucker
```
- `routeTrail`：在 `res` 米网格上 A*（8 邻域），代价 = 距离 × (1 + 3 × slope)，slope > maxSlope 的移动不可走；`avoidPolys` 内不可走。结果简化到 ≤ 24 点，起终点精确等于 from/to。
- `zigzagTrail`：构造法。沿 from→to 的主方向分 `folds+1` 段，交替偏到横向两侧（偏移量取台地宽度的 0.6），再逐段校验坡度，超过 `maxSlope` 的段自动再加一折。
- `facts.folds`：行进方向横向分量变号的次数；`steps_estimate = climb_m / 0.17`。
- 失败（不可达）返回 `points: null` 与 `facts.reason`。

## 4. 关系与检查（relations.js）

```js
import { analyze, lineOfSight, reachable } from "./relations.js";
analyze(sid, T) → { relations: Relation[], checks: Check[] }
lineOfSight(T, volumes, from = [x,z], to = [x,z], { eye = 1.7, targetHeight }) → { visible: boolean, blockedBy: "terrain"|"volume:<id>"|null }
reachable(T, paths, from, to, { maxSlope = 0.7, res = 2 }) → boolean
```
- `relations` 自动生成：`on_top_of`（每栋房 / 地标 → 所在台地 id）、`faces`（房 → 最近的路或地标）、`adjacent`（房与房间距 < 10 m）、`visible_from`（地标 ← 出生点，若可见）、`connects`（主路 → 它经过的台地）。
- `checks`（给右栏「关系检查」，顺序固定）：
  | id | 文案 | 判定 | fixes（给人三选一） |
  | --- | --- | --- | --- |
  | spawn_sees_landmark | 入口 能看见 {地标} | lineOfSight 从出生点 1.7 m 到地标顶部 | 地标再高一层 / 入口挪到路口 / 不重要 |
  | trail_reaches_landmark | 主路 能到达 {地标} | 主路终点距地标 < 6 m 且 reachable | 把路接到地标 / 不重要 |
  | landmark_on_top | {地标} 在 顶层台地（卡说 plaza 时「在 广场」、说 entry 时「在 村口」） | terraceAt(地标) 是最高层；plaza 在广场区域或中间那层、entry 所在台地是最低一层（按台地不按高度，最低层调高后仍算）也算对 | 挪到顶层 / 不重要 |
  | houses_no_overlap | 房子 不重叠 | OBB 两两不交 | 重排房子（生成的换种子重排，本地）/ 挪开一点（两栋都是人放的） |
  | houses_clear_of_paths | 房子 不压路 | 距离规则同 layout；人拖过 / 锁住的房子也查；主路为躲人放的房子绕行时文案加「主路为躲开 … 绕了一下」 | 重排房子 / 挪开一点（人放的挪到最近的空位，不删） |
  | houses_on_terraces | 房子 都在台地上 | 每栋非地标建筑（含 user_moved）四角 terraceAt 相同；四角都在台地外时须同层且不陡 | 挪回最近的台地 / 不重要 |
  | terraces_reachable | 每层台地 都有路可达 | 每个台地多边形 10 m 内有主路点，且 reachable | 补一段支路 / 不重要 |
  「挪回最近的台地 / 挪开一点」用 `nearestHouseSpot(sid, T, house)`：在原位周围 1 m 一圈圈找（同圈按角度固定顺序，确定性），要求四角同一台地、离台地边 ≥ 0.3 m、门朝向按 §2 规则 4、离路 / 溪同 layout、离其它体块 ≥ 0.8 m（地标 4 m）；挪过的房子算人放的（`locked`、`user_moved`）。
  主路绕行：resolve 的 A* 把人放的房子外扩 2.5 m 当禁行区；有房子贴着主路（6 m 内）时把它们拿掉再算一次 A*，新路穿过的那几栋记进 `main_trail.detour_around` 与 `facts.trail.detour_around`。
  `Check = { id, text, ok, detail, severity: "error"|"warn", fixes: [{ label, patch(sid) }] }`，`patch` 直接改 sid（不重新布局，调用方再 resolve）。
  有多层空间时，`sid.resolve` 在这七项之后追加 `spaces_connected`、`spaces_clear_of_terrain`（见 §10）。可达性只管地面这一层，跨层由 `spaces_connected` 管。
- 可见性：沿 from→to 每 1 m 采样，视线高度线性插值；若某处 `T.heightAt + 0.3 > 视线高` 则被地形挡；若落在某体块 OBB 内且视线高 < 体块顶 则被该体块挡（忽略 `generated` 的树以外的 prop？不，树也挡）。
- 可达：网格 BFS，可走 = slope ≤ maxSlope 或在任一 path 走廊内（距折线 ≤ 宽/2 + 1）。

## 5. 笔画事实（strokes.js）

人的每一笔先经这里变成结构化事实，LLM 永远不看像素。
```js
import { classifyStroke, strokeToPath, strokeToPolygon, simplify } from "./strokes.js";
classifyStroke(points) → "tap" | "line" | "loop"
strokeToPath(points, { T, anchors: { spawn, landmark, pathPoints, streamPoints }, snap = 10, maxPoints = 12 }) → {
  points,                       // 简化 + 吸附后的折线
  facts: { n_points, length_m, start_snapped_to: "spawn"|"landmark"|"path"|"stream"|null, end_snapped_to, levels_crossed: [0,1,2], crosses_stream: boolean, max_slope }
}
strokeToPolygon(points, { T, maxPoints = 10 }) → { polygon, area_m2, levels_touched: [...], centroid }
```
- `tap`：长度 < 3 m；`loop`：长度 > 20 m 且首尾距离 < 8% 长度；其余 `line`。
- 吸附：起 / 终点距 anchors 中某点 ≤ snap 米则精确替换为该点。
- 简化：Douglas–Peucker，容差自适应使点数 ≤ maxPoints。

## 6. 候选差异（v4 起在 plan.js）

原 diversity.js 已删除。「换一批 / 三张卡够不够不同」改成按 plan 的构成算，不用编译：
```js
import { planDistance, distinctPlans } from "./plan.js";
planDistance(planA, planB) → number   // 地形种类 ×1.2 + 地标 / 建筑形制 ×0.8 + 空间布局 ×0.6 + 区域用途 ×0.4 + 路的走法 ×0.3 + 水 ×0.5（各为多重集 Jaccard 距离）
                                      // + |总高差差|/4 + |场地边长差|/80 + 时段不同 0.2 + 入口方向不同 0.2 + |地形块数差|/5
distinctPlans(plans, threshold = 1) → boolean
```

## 7. 颜色（color.js）

```js
import { extractPalette, assignRoles, paletteShift, hexToLab, deltaE } from "./color.js";
extractPalette(imageData, { k = 6, seed }) → [{ hex, weight }]   // k-means（Lab 空间），weight 为占比
assignRoles(colors) → [{ role, hex, note }]   // roof/wall/stone/foliage/mist 五个角色的启发式分配
paletteShift(palette, "cool"|"warm"|"desaturate"|"neutral") → palette
hexToLab(hex) → [L, a, b]；deltaE(hexA, hexB) → number（CIE76）
```
角色启发式：foliage = 最绿（a* 最负）；wall = 最亮；roof = 最暗且饱和度低；stone = 中灰；mist = 最亮且饱和度最低（可与 wall 相同则取次亮）。

## 8. SID 文档工具（sid.js）

```js
import { newDoc, resolve, snapshot, restore, THEME, setTerraceHeight, resetTerraceHeight, landmarkDoor, rotationToward, riversOf, expandedFootprint } from "./sid.js";
newDoc(theme = THEME.mountain_village) → sid                         // 含默认调色板、bounds、meta.layer_height_m
resolve(sid, { seed, autoSpur = true }) → { sid, T, checks, facts, ms } // 布房 → 支路 → 空间刷新 → relations → validate
setTerraceHeight(sid, featureId, h) / resetTerraceHeight(sid, featureId)
snapshot(sid) / restore(json)
```
- Card（applyCard / applyPatch / normalizeCard）随 v4 删除：场景由 plan 编译（§13）。
- **两种模式**：`meta.plan_mode`（plan 编译出来的 SID）下 resolve 不碰路、地标、出生点（它们由编译决定），只清 / 重放 generated 的房子与树、自动支路，检查里没有 `landmark_on_top`（换成 plan.js 的放置检查），`trail_reaches_landmark` 看主路自己的终点（`meta.trail_target`）；旧模式（测试夹具直接摆的 SID）还按「出生点 → 地标门前」算主路 `main_trail`。
- 多个地标时主地标 = `meta.focus`（出生点第一眼看的那个）；房子 = 非地标的 building。
- regions[].building（plan 的建筑类型）决定布房的形制与尺寸（§2、§13）；volumes 带 `form / roof / floors / label / plan_id / zone_id`。
- facts 另有 `forms`（按形制计数）、`stilt_houses`（柱脚 > 0.5 m 的吊脚楼数）、`bridges`（路过溪处）、`spaces`（interior.spaceFacts 的汇总对象）。
- 空间直接用 interior.js：resolve 在布房前 `refreshSpaces`，检查末尾接 `spaceChecks`（spaces_connected / interior_connected / spaces_clear_of_terrain）；没有本地桩。

## 9. 测试约定

每个模块一页 `medium/engine/tests/<module>.test.html`：
```html
<!doctype html><meta charset="utf-8"><pre id="out">running</pre>
<script type="module">
import { test, run, assert, close, between } from "./harness.js";
import { ... } from "../xxx.js";
test("...", () => { ... });
run();
</script>
```
跑：`python tools/run_browser_test.py medium/engine/tests/xxx.test.html`。确定性测试必须包含「同参数两次结果相同」。几何测试用 `fixtures.js` 里的 `villageSid()`（slope_zigzag、4 层、入口南）与 `valleySid()`。

## 10. 地下 / 空中空间（interior.js，v4，docs/05 §4；原 strata.js 已并入）

AI 只给结构（stratum、layout、under / over 目标、depth_layers / height_layers、size_m、branching、sublevels、corridor_m、rooms + links、connect），外轮廓、内部布局、高度、连接点全由这里算。
```js
import { SPACE, LAYOUT_LABEL, VIA_LABEL, levelsOf, levelStep, levelFloor, entryLevel, goalLevel, fitFloor, clearLimit, setSpaceFloor, spaceClearance,
  groundRange, sidTarget, buildInterior, compileSpaces, entryFloor, connectorHeights, connectorFor, refreshSpaces, makeSpace, interiorGraph,
  spaceChecks, spaceFacts } from "./interior.js";
compileSpaces(planSpaces, sid, T, resolveTarget?, { seed }) → { spaces, connectors, warnings }   // plan.js 调；不改 sid
buildInterior(space, sid, T, { seed, center, approach, preferBoundary, axis_deg }) → { polygon, floor_y, height, passages, rooms, links, entrance, goal, facts, … }
makeSpace({ stratum, polygon, layout?, … }, sid, T) → { space, connector } | null   // 人在地下 / 空中层圈的
refreshSpaces(sid, T) → sid      // resolve 调：补内部、重定高度、连接点回到入口上方
spaceChecks(sid, T) → Check[]    // spaces_connected / interior_connected / spaces_clear_of_terrain；没有空间时 []
```
- **位置**：中心 = under / over 目标的投影 + 人拖过的 `offset_m`；空中压在建筑上方时挪到旁边。入口朝 `connect.from`（建筑就落在它旁边 R + 2 m），没有时朝出生点。
- **内部布局**：maze（格 = 走廊宽 × 2，DFS 生成树 + 按 branching 打通 0 / 15 / 35% 死路，终点室在最远格，层间梯子在两层都可达的格）、galleries（主巷 + 每 8–10 m 横巷 + 采场，层间暗井在主巷端部）、halls（前厅 → 甬道 → 主厅 → 后室 + 对称耳室）、network（3–9 个洞室，最小生成树 + 0–3 条回环）、rooms、chamber、corridor。
- **rooms**：房间 + 连线图 BFS 排到网格上（冲突换格，「左 / 右」的名字偏向左 / 右）；相邻两列（行）的中心距 = 两边最大房间半宽之和 + 一段走廊（走廊宽 + 2.5 m，夹在 4–6 m），整体缩到 size_m 以内（最小 0.4 倍）；名字像走廊的房间（甬道 / 廊）画成窄长条。给了 connect.from 时入口落在连接点上，否则最大的房间（主室）落在 under 目标正下方。
- **外轮廓**：没有人给的轮廓时 = 房间多边形与通道缓冲带（半宽 + 0.75 m）的并集（栅格化后描外边界、按栅格精度化简），不用凸包；maze 是外接矩形，chamber 是那一间。
- **高度**（0.5 m 取整）：地下 = 外轮廓质心处地面 − depth_layers × 层高 − 净高 − (层数 − 1) × 层距（最上层顶板在地面下 depth_layers 层），再压到每条通道 / 每个房间上方地面 − 2 m 以下；空中 = 地面 + height_layers × 层高，再抬到下方地面 + 3 m + 1 m 板厚以上。界面上的「深 N 层 / 高 N 层」按同一口径现算（views/map.js spaceDepth）。
- **连接点**：`markers[]` 里 `{ id: conn_<空间 id>, kind: "connector", via, from: "ground" | 空间 id, to, position: [x, 下端 y, z], top_y, bottom_y, label: 下行 / 上行 + 方式 }`，落在入口正上方。
- **确定性**：随机只来自 seed / layout_seed（「换一个」改 layout_seed）。

## 11. 剖切（section.js，D19）

```js
import { defaultSection, sectionPath, sampleSection, rotateSection, widthClamp, projectToPath, SECTION_WIDTH } from "./section.js";
defaultSection(sid, T) → { mode: "trail", line: [[x,z],[x,z]], width_m: 12 }   // line 预置为主路首尾，无主路为南北中线
sectionPath(section, sid) → [[x,z], ...]      // trail：主路折线（无主路退回南北中线，自南向北）；line：两点（不合法退回中线）
sampleSection(sid, T, section = sid.meta.section ?? defaultSection) → {
  path, length_m, width_m,
  ground: [{ d, h, x, z, terrace_id, level }],             // 每 1 m；level 在台地上取台地层号，否则 levelAt
  terraces: [{ id, level, height, d0, d1, user_height }],  // 剖切线穿过的平台段（同一台地被穿几次就几段）
  volumes: [{ id, kind, importance, d0, d1, y0, y1, label }],
  spaces: [{ id, stratum, kind, d0, d1, floor_y, height, label }],
  connectors: [{ id, via, d, top_y, bottom_y }],
  paths: [{ id, kind, d }]                                 // 与剖切线相交的路 / 溪（trail 模式不含主路自己），按 d 排序
}
rotateSection(section, deg, pivot = 中点) → { mode: "line", line, width_m }   // 俯视逆时针为正；trail 模式先换成 line
widthClamp(w) → 2..60 的整数，非数字 12
projectToPath(path, [x,z]) → { d, off, q }    // 最近点的弧长与横向距离
```
- **入带**：体块的中心或任一底角横向距离 ≤ 宽/2；空间的任一顶点 ≤ 宽/2，或剖切线采样点落在多边形内 / 距多边形 ≤ 宽/2；连接点 position ≤ 宽/2。
- **投影**：`d0 / d1` 取四角（空间取顶点）投影的最小 / 最大弧长；折线拐弯处投影会跳段，跨度超过「形状对角线 × 1.5 + 2 m」时改用中心投影 ± 半对角线。体块 `y0 = max(position.y, 地面)`。
- 纯函数、确定性、不调 AI；拖剖切线 / 拖宽度只需重新调 `sampleSection`。

## 12. 界面的本地操作（medium/app.js）

全部本地、即时、绝不调 AI；状态只有 `store`（app.js 导出），每次改动走 `edit(label, fn)` / `planOps(label, ops)`，自动进撤销栈。
- 改 plan：构成清单的旋钮、＋加一个、删除、锁 → `planOps` → `compileWith(plan, user)` 重编译。
- 人的覆盖（`store.user`，重编译时保留）：拖过的房子（锁住的 `u_house_<n>`）、删掉的生成物（按位置记）、剖面上调过的台地高度（`terraceH`）、画的路 / 通道、圈的区域 / 空间。
- 图上拖动：地标 / 入口 → `place.nudge_m`；地形块 → 反算 `at.dir / at.dist`；空间 → `offset_m`。plan 里依然没有 AI 写的坐标。

## 13. 构成图编译（plan.js，v4，docs/05 §2–3）

```js
import { PLAN_SCHEMA, PLAN_GROUPS, DIRV, normalizePlan, compilePlan, applyOps, resolveTarget, knobsFor, summarize, newElement, planDistance, distinctPlans } from "./plan.js";
normalizePlan(plan) → { plan, warnings }        // 按 spec/plan.schema.json 清洗：丢未知 / 坐标字段、夹数值、校枚举、补 id 与按 type 的默认值、引用降级、断环
compilePlan(plan, { seed, ignored }) → { sid, T, checks, facts, index, plan, warnings, ms }
applyOps(plan, ops) → { plan, warnings }         // set（字段可嵌套，value null = 删字段）/ add / remove（"rel:<i>" 删关系）
resolveTarget(sid, T, id) → { point, polygon, top_y, base_y, kind, label, sid_ids } | null
knobsFor(group, element, schema = PLAN_SCHEMA, plan) → 旋钮数组；summarize(group, element, plan) → 清单一行
newElement(group, type, plan) → 「＋ 加一个」的默认项
```
- PLAN_SCHEMA 在模块加载时从 `spec/plan.schema.json` fetch（单一事实来源；页面必须经 http 打开）。
- 编译顺序：场地（bounds = ±size_m/2）→ 地形块按 at 依赖顺序叠（hill / ridge = 椭圆穹顶；slope_terraces / ring_terraces / plateau / cliff / island 顶 = `override` 平顶，按顺序压上去；valley / basin / pit = 负的平底多边形）→ 池塘 → buildTerrain → 水（溪沿低处 A*，有谷且没给源头时顺第一条谷）→ 区域（on 的台地按 levels / side 取子集 → regions，带 building）→ 地标 / 入口按位置依赖顺序求解（候选点 + 打分：出场地 1000、压水 50、挤别的地标 80、压已路由的路 30、地面不平 2 + 高差、关系不成立 2（入口看不见 look_at 1）、名次 × 0.05；之后加 nudge_m）→ 朝向（place.facing / 入口）→ 空间（interior.compileSpaces：外轮廓、内部布局、高度、连接点）→ 路（第一条是 main_trail；节点：地标 = 门前，桥 = 两头（中间直线过桥），途经的门 = 门前门后，区域 / 地形 = 里面靠前一点的位置，水 / 路 = 最近点；style：winding A* 0.7、stairs A* 1.2（绕两倍多远或上不去就直上）、zigzag 之字、straight / bridge / tunnel 直线）→ 外观 → resolve → 放置检查 `place_<id>` + 关系检查 `rel_<i>`（relations.relationChecks，修法是 plan ops）→ 索引 `index[plan_id] = { group, sid_ids }`。
- 层号压在 `site.relief_layers` 以内（总高差调小时顶上几层并成一层）；层高 = `site.layer_m`。
- 确定性：同 plan + seed → 同 SID；seed 只影响台地多边形抖动、布房、A* 抖动与空间内部。
