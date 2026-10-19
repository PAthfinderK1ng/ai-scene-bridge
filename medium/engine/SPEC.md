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
import { buildTerrain, generateArchetype, ARCHETYPES } from "./terrain.js";
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

### 原型（LLM 选原型和参数，引擎生成多边形）
```js
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

## 6. 候选差异与变化轴（diversity.js）

```js
import { signature, distance, distinctEnough, axisOverrides, AXES } from "./diversity.js";
signature(resolvedSid) → { archetype, landmark: [x,z], levels, houses, entry_bearing_deg, palette_lab: [L,a,b] }
distance(sigA, sigB) → number        // 加权：地标位移/30 + |levels 差| + |houses 差|/15 + bearing 差/90 + ΔE/30
distinctEnough(sigs, threshold = 1.0) → boolean   // 两两 distance 都 ≥ threshold
axisOverrides(axis, base) → [override, override, override]
```
`AXES = { landmark: "地标位置", terraces: "台地层数", entry: "入口方位", density: "密度", palette: "色板冷暖" }`
- landmark → `landmark.placement` ∈ [top, ridge_end, cliff_edge]；terraces → [n−1, n, n+1] 夹在 3..7；entry → [S, E, W]；density → 全局 density × [0.6, 1, 1.4]；palette → `paletteShift` 的 [cool, neutral, warm]。
- override 的形状与 Draft 卡片参数一致（见第 8 节），由调用方合并进卡片参数再重算。

## 7. 颜色（color.js）

```js
import { extractPalette, assignRoles, paletteShift, hexToLab, deltaE } from "./color.js";
extractPalette(imageData, { k = 6, seed }) → [{ hex, weight }]   // k-means（Lab 空间），weight 为占比
assignRoles(colors) → [{ role, hex, note }]   // roof/wall/stone/foliage/mist 五个角色的启发式分配
paletteShift(palette, "cool"|"warm"|"desaturate"|"neutral") → palette
hexToLab(hex) → [L, a, b]；deltaE(hexA, hexB) → number（CIE76）
```
角色启发式：foliage = 最绿（a* 最负）；wall = 最亮；roof = 最暗且饱和度低；stone = 中灰；mist = 最亮且饱和度最低（可与 wall 相同则取次亮）。

## 8. SID 组装（sid.js）

```js
import { newDoc, resolve, applyCard, applyPatch, snapshot, restore, THEME, setTerraceHeight, resetTerraceHeight } from "./sid.js";
newDoc(theme = THEME.mountain_village) → sid                         // 含默认调色板、bounds、meta.layer_height_m
applyCard(sid, card) → sid        // 把 LLM 的卡片提案（第 8 节 Card 结构）落成 terrain.features / markers / regions / style
resolve(sid, { seed }) → { sid, T, checks, facts }                 // 跑 layout → routing → relations，写回 volumes/paths/relations（generated）
// facts.bridges = [{ path, at: [x,z], dir: [dx,dz], width }]：路过溪处 = 桥（routing.pathCrossings；6 m 内算一座）。
// A* 对溪面 + 1 m 内的格点加 3 步长代价（opts.wet），路要过溪就直着过一次，不顺着溪床走。
applyPatch(sid, patch) → sid      // LLM 的 Revise 结构 patch（只允许改参数 / 放置类 / 密度 / 调色板 / 文案 / levels）
setTerraceHeight(sid, featureId, h) → sid   // 剖面拖平台段：只改这一层，0.5 m 吸附，写 user_height，skirt 重算
resetTerraceHeight(sid, featureId) → sid    // 「恢复」：height = level × 层高，去掉 user_height
snapshot(sid) / restore(json)
```
- **台地单独调高**：`features[].user_height: true` 的高度不被覆盖；`applyCard` / `applyPatch` 重新生成地形时，**同原型**同 id 的台地沿用它（换原型则丢弃）。resolve 时房子贴新高度、主路 / 支路重算、`user_moved` 的体块 y 跟到地面。
- **多层空间**：Card 可选 `levels`（≤ 3 项，见 §10）。`applyCard` 删掉上次生成的空间与连到它们的连接点，保留 `user_set` 的空间与它们的连接点，再按 levels 生成（`generated: true`）。resolve 在主路 / 支路之后、布房之前调 `refreshSpaces`（generated 空间按当前地形重算 floor_y，连接点按主路重新选位置、重算两端高度），房子避开连接点 3×3 m；checks 末尾追加 `spaceChecks`；`facts.spaces = { total, underground, sky, connectors }`。
- `meta.section`（剖切设置）原样保留，引擎不改它。
**Card（LLM Draft 的一张卡）**：
```json
{ "name": "环湾叠落型", "one_liner": "...", "archetype": "ring_terrace",
  "params": { "entry_side": "S", "terraces": 4, "layer_height_m": 3, "plateau_width": "medium", "stream": false },
  "landmark": { "kind": "temple", "label": "山顶寺", "placement": "top", "size_m": [8, 9, 8] },
  "spawn": { "placement": "valley_bottom" },
  "regions": [ { "terrace": 0, "kind": "other", "density": 0.6, "label": "下村" }, { "terrace": 3, "kind": "plaza", "density": 0, "label": "顶台" } ],
  "palette": [ { "role": "roof", "hex": "#4A4A4A", "note": "青瓦" }, ... 5 项 ],
  "lighting": { "time_of_day": "dusk" }, "mood": ["宁静"], "summary": "一句话" }
```
`landmark.placement ∈ top|ridge_end|cliff_edge|plaza|entry`（entry = 村口，原型的 `spots.entry`）；`spawn.placement ∈ valley_bottom|side_slope|summit|S|E|W`。
可选 `"levels": [{ "stratum": "underground", "kind": "cave", "anchor": "landmark", "depth_layers": 2, "size": "medium", "connect": "stairs", "label": "寺下溶洞" }]`（§10）。
resolve 之后 SID 里：`terrain.features`（原型生成）、`markers`（spawn、landmark 为 volume + marker poi）、`regions`（每层一个 + LLM 指定的 kind/density）、`volumes`（地标 + 房子 + 树，房子 `generated: true`）、`paths`（主路 `main_trail`，溪 `stream`）、`relations`、`constraints`（locked、must_reach）。

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

## 10. 多层空间（strata.js，D18）

地面之外的地下 / 空中空间。AI 只给结构（层、种类、锚点类、层数、大小、连接方式），多边形、高度、连接点全由这里算。
```js
import { STRATA_KINDS, SPACE_LABEL, STRATUM_LABEL, CONNECTOR_VIA, VIA_LABEL, ANCHORS, ANCHOR_LABEL, SIZES, NET_HEIGHT, DEFAULT_VIA, CLEARANCE,
  normalizeLevels, generateSpaces, makeSpace, connectorFor, connectorsFor, connectorHeights, refreshSpaces, spaceChecks, spaceFacts,
  fitFloor, clearLimit, spaceClearance, groundRange, anchorPoint, bridgeEnd } from "./strata.js";
normalizeLevels(levels) → Level[]                         // ≤ 3 项；stratum / kind 不合法的丢；其余回退默认
generateSpaces(levels, sid, T, g?) → { spaces, connectors } // applyCard 调；g = generateArchetype 结果（省略时按 meta 重算）
makeSpace({ stratum, kind?, polygon, floor_y?, height?, label?, id?, connect? }, sid, T) → { space, connector } | null   // 人圈的；不改 sid
connectorFor(space, sid, T, end = 0) → marker              // 天桥 end 1 是另一端（id 加 _2）
refreshSpaces(sid, T) → sid                                // resolve 调
spaceChecks(sid, T) → Check[]                               // 没有空间时 []
```
- **SID**：`sid.spaces[] = { id, stratum: underground|sky, kind, polygon, floor_y, height, label, anchor, size, depth_layers | height_layers, connect, generated | user_set, user_height? }`；连接点是 `markers[]` 里 `{ id, kind: "connector", via, from, to, position: [x, 下端 y, z], top_y, bottom_y, label, generated, user_moved? }`，`from` / `to` 是 `"ground"` 或空间 id。
- **种类**：地下 cave 溶洞（净高 6）/ tunnel 地道（3，4 m 宽长条，沿下坡方向）/ cellar 地窖（3）/ crypt 地宫（5）；空中 platform 平台（4）/ walkway 栈道（3，3 m 宽长条，沿等高线）/ island 浮岛（6）/ bridge 天桥（3，3 m 宽长条，跨谷或跨台地）。默认连接：stairs / ramp / ladder / stairs；stairs / ladder / elevator / stairs。
- **锚点**：landmark 地标中心 / village 面积最大的 other 区域 / top 顶层台地内 / plaza 广场区域（无则原型广场点）/ ridge_end、cliff_edge 原型给的点 / entry 出生点。空中空间锚在地标时贴着地标侧面放（沿「地标 → 入口」的垂线偏开），不压在地标头顶。
- **多边形**：圆角 12 边形，直径 small 10 / medium 18 / large 28 m（种子化 ±6% 抖动、0.8–1 椭圆比）；长条长 16 / 28 / 40 m。整体平移进 bounds（留 2 m）。天桥另一端：24 方向 × 10–60 m 搜索，两端高差 ≤ 2 层，中间谷 ≥ 2 m 或两端在不同台地，评分 = 谷深×2 + 跨台地 3 − |长度 − 目标|×0.3；找不到就沿下坡方向。
- **高度**（0.5 m 取整）：地下 `floor_y = 质心处地面 − depth_layers × 层高 − 净高`，再压到「多边形内地面最低点 − 2 m − 净高」以下；空中 `floor_y = 质心处地面 + height_layers × 层高`，再抬到「多边形内地面最高点 + 3 m + 1 m 板厚」以上。默认 depth_layers 2、height_layers 3。
- **连接点**：地下 = 多边形内离主路（无主路时离「入口 → 地标」线）最近的点；空中 = 多边形边上（向内 1 m）离主路最近的点；天桥 = 两条短边中点各一个。避开地标与人放的体块（外扩 1 m）。文案「下行 / 上行 + 楼梯 / 梯子 / 井 / 竖井 / 升降台 / 索桥 / 坡道」。
- **检查**：
  | id | 文案 | 判定 | fixes |
  | --- | --- | --- | --- |
  | spaces_connected | 每个空间 都连到地面 | 从 ground 沿连接点（无向）BFS 到达每个空间 | 补一个连接点 / 不重要 |
  | spaces_clear_of_terrain | 空间 不穿地形 | 地下顶板低于多边形内地面最低点 ≥ 2 m；空中板底（floor_y − 1）高于最高点 ≥ 3 m | 下移到合格高度 / 上移到合格高度（两种都有时「移到合格高度」）/ 不重要 |
- **重算**：generated 且没有 user_set / user_height 的空间每次 resolve 按规则重算 floor_y（地形调高后仍在地面下）；generated 且没 user_moved 的连接点按主路重选位置；其余连接点只重算两端高度；引用了不存在空间的连接点删掉。
- **确定性**：随机只来自 `sid.meta.seed`（= card.seed）；id = `space_<kind>_<n>`，人圈的 `u_space_<n>`，连接点 `conn_<空间 id>`。

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

## 12. 场景适配层（medium/scene.js）的本地操作

全部本地、即时、绝不调 AI；改的都是人的覆盖（`scene.user`）或 sid 里人的对象，重算时保留，都在 `snapshotState()` 里（可撤销）。
- `removeVolume(id)`：程序生成的房子 / 树记位置（`user.removed = [[x, z, kind], …]`，不记 id——重排后 id 会变），每次 rebuild 后把同类生成物在 3 m（树 1.5 m）内的去掉；换原型（`setCard` 的 archetype 变了）时作废。
- `setSpaceConnect(id, via)`：人加的空间直接改它的连接点（via 与「上行 / 下行 + 方式」文案）；AI 生成的改卡片 `levels` 对应项的 `connect` 再重算。返回 scene，不合法返回 false。
- `lockVolume(id, false)`：拖过的房子（`user_moved`）只把 `locked` 设 false，留在原地；其余交回程序排（`generated: true`）。
- `previewState(mutator) → Scene`：克隆一份，对副本执行 `mutator(s)`（任意本地方法），mutator 里的多次 rebuild 合并成最后一次；本体不变。给 3D 小窗做拖动中的实时预览。实测 villageSid 规模（之字坡 4 层、16 栋）单次中位约 9 ms（无头 Edge），7 层溪谷约 60 ms；`s.ms` 是这次耗时。
