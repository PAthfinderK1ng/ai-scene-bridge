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
    top: [x,z], ridge_end: [x,z], cliff_edge: [x,z], plaza: [x,z] },
  entries: { S: [x,z], E: [x,z], W: [x,z] },     // 入口候选（在 bounds 边缘、低处）
  summit: [x,z], valley_bottom: [x,z],            // 出生点候选
  layer_height_m,
}
```
`name ∈ ARCHETYPES = ["slope_zigzag", "ring_terrace", "valley_two_banks"]`
`params = { entry_side: "S"|"E"|"W", terraces: 3..7, layer_height_m: 2.5..6, plateau_width: "narrow"|"medium"|"wide", stream: boolean }`
三种原型都先在「入口在南、上坡朝北」的局部坐标生成，再按 `entry_side` 旋转：E → (x,z)→(z,−x)，W → (x,z)→(−z,x)。

## 2. 房屋布局（layout.js）

```js
import { layoutHouses, scatterTrees, HOUSE_SIZES } from "./layout.js";
layoutHouses(sid, T, opts) → { volumes: Volume[], perTerrace: {[level]: n}, rejected: {reason: n} }
```
- 输入：`sid.regions[]`（每个台地一个 region：`polygon`、`kind`、`density` 0–1.6、可选 `terrace_level`）；没有 regions 时按 `T.terraces` 全部铺。`kind === "forest"` 调 `scatterTrees`，`plaza`/`gathering` 不放房只铺地，`farmland`/`terrace`（梯田）不放房。
- 规则（全部由算法保证，不靠 AI）：
  1. 房子完全在所在台地多边形内（内缩 2 m），且 `T.terraceAt` 四个底角同一层（不跨崖）。
  2. 间距随密度：density 1 → 中心距约 9 m；0.5 → 14 m；1.5 → 6.5 m。用种子化的泊松盘 / 抖动网格采样。
  3. 不压路：到任何 `sid.paths` 折线的距离 ≥ 路宽/2 + 2.5 m；不压溪（kind river）≥ 路宽/2 + 3 m；离地标体块 ≥ 4 m；互不重叠（OBB）。
  4. 朝向：长边平行等高线（即垂直于 `gradientAt`），门朝下坡；若 12 m 内有路，门改朝最近的路点。`rotation_y` 按第 0 节约定。
  5. 尺寸从 `HOUSE_SIZES`（宽 5–7、高 3.5–4.5、深 4–6）按种子抖动；`position.y = T.heightAt(x,z)`。
  6. id：`house_<level>_<序号>`；`kind: "building"`，`shape: "box"`，`importance: "secondary"`，`color_role: "wall"`，`generated: true`。
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
  | landmark_on_top | {地标} 在 顶层台地 | terraceAt(地标) 是最高层 | 挪到顶层 / 不重要 |
  | houses_no_overlap | 房子 不重叠 | OBB 两两不交 | 让 AI 重排 |
  | houses_clear_of_paths | 房子 不压路 | 距离规则同 layout | 让 AI 重排 |
  | terraces_reachable | 每层台地 都有路可达 | 每个台地多边形 10 m 内有主路点，且 reachable | 补一段支路 / 不重要 |
  `Check = { id, text, ok, detail, severity: "error"|"warn", fixes: [{ label, patch(sid) }] }`，`patch` 直接改 sid（不重新布局，调用方再 resolve）。
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
import { newDoc, resolve, applyCard, applyPatch, snapshot, restore, THEME } from "./sid.js";
newDoc(theme = THEME.mountain_village) → sid                         // 含默认调色板、bounds、meta.layer_height_m
applyCard(sid, card) → sid        // 把 LLM 的卡片提案（第 8 节 Card 结构）落成 terrain.features / markers / regions / style
resolve(sid, { seed }) → { sid, T, checks, facts }                 // 跑 layout → routing → relations，写回 volumes/paths/relations（generated）
applyPatch(sid, patch) → sid      // LLM 的 Revise 结构 patch（只允许改参数 / 放置类 / 密度 / 调色板 / 文案）
snapshot(sid) / restore(json)
```
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
`landmark.placement ∈ top|ridge_end|cliff_edge|plaza`；`spawn.placement ∈ valley_bottom|side_slope|summit|S|E|W`。
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
