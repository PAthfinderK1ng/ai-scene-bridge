# medium/ — 「场景对话」正式版

人和 AI 沟通三维游戏场景的媒介。人只做选择、指点、判断；AI 只做结构级决定；几何由确定性引擎算。
设计依据：`docs/03-交互设计-场景对话.md`（六原则、六步流程、D1–D17 决策）。

## 跑起来

```bat
.venv\Scripts\python -X utf8 desktop\sid_editor.py
```
会起一个只监听 127.0.0.1 的本地服务（静态文件 + `/api/*`）并用 WebView2 开窗口；`--no-window --port 8766` 只起服务，然后浏览器开 http://127.0.0.1:8766/medium/ 。
没有 Anthropic 密钥时自动用内置的模拟 AI（脚本），整条流程照样能走；点右上角「AI：…」填密钥后换成 Claude（默认 `claude-opus-5-5`，结构化输出）。密钥只存在本机 `%LOCALAPPDATA%\ai-scene-bridge\config.json`，网页拿不到。

## 六步

| 步 | 人做什么 | AI / 引擎做什么 |
| --- | --- | --- |
| 说 | 一句话（「我要生成山城村庄」） | AI 出 3 张**完整**方案卡（原型 + 参数 + 地标 / 入口放置类 + 每层用途密度 + 色板 + 文案）；引擎把每张算成几何（台地、房、主路、关系） |
| 选 | 挑一张 | 卡上黄标是三张之间真正不同的字段 |
| 答 | 最多 4 个问题，顺序 坡度 → 规模 → 地标 → 入口/第一眼，每个可「你定」 | 每个选项都有算过的缩略图（剖面 / 俯视 / 第一眼） |
| 画 | 画一笔（主路）/ 圈一块（用途或密度）/ 拖图钉（地标、入口）/ 点一下（看理解）| 笔画先变成「事实」（折点、吸附、穿过哪几层、跨溪）再给 AI；几何即时重算 |
| 核 | 右栏「我理解为」逐条点对 / 翻替代 / 锁 | 「关系检查」✓/✗ 由程序算并给修法；「我假设了」列出默认值 |
| 出 | 导出引擎包；引擎侧搭完把读回导进来 | 红点标出差的对象，每个三选：按意图修 / 接受引擎版 / 不重要 |

## 文件

```
medium/
  index.html / style.css        界面骨架与样式
  app.js                        流程控制器（说选答画核出）、手势、换一批
  questions.js                  答：四个问题（坡度 / 规模 / 地标 / 入口）与「问完了」、快捷 chip
  exportflow.js                 出：导出弹窗、读回比对、红点三选一（按意图修 / 接受引擎版 / 不重要）
  settings.js                   右上角 AI 状态 pill 与「AI 设置」弹窗（密钥先测后存、模型、强制模拟）
  scene.js                      引擎适配层：卡 + 人的覆盖（路 / 区域 / 图钉 / 不重要）→ SID；自动补支路
  api.js                        /api/* 调用（AI 代理、读回评分、配置）
  cards.js / panels.js          方案卡与差异标签；右栏三面板 + 色板 / 风格板
  exporter.js                   引擎包（scene.sid.json + views/*.png + BRIEF.md + PROTOCOL.md）与读回差异
  views/map.js                  俯视语义图（数据驱动，含手势绑定）
  views/profile.js              沿主路的侧剖面（层带、坡度着色、台阶估计）
  views/eye.js                  「第一眼」：从入口 1.7 m 眼高朝地标的示意透视（远中近山脊 + 体块投影 + 遮挡）
  views/preview3d.js            three.js 3D 预览（只看）
  engine/                       确定性几何引擎（见 engine/SPEC.md）
    terrain.js   原型 → 多边形台地 → 高度场；layout.js 房屋布局；routing.js A* / 之字路；relations.js 关系与检查
    strokes.js   笔画 → 事实；diversity.js 变体差异与变化轴；color.js k-means 取色与角色分配；validate.js；sid.js 组装
    tests/       每模块一页测试（无头 Edge 跑）
```

## 测试

```bat
python -X utf8 tools\run_browser_test.py medium\engine\tests\sid.test.html
python -X utf8 desktop\test_api.py
```
前者跑引擎测试页（8 页共 96 个用例），后者在进程内起服务用模拟 AI 跑 22 条接口冒烟。

## 几条铁律（代码里怎么体现）

- **LLM 永远不写坐标**：AI 只能返回 `ai_service.CARD_SCHEMA` / `PATCH_SCHEMA` 里的字段（枚举 + 数字范围，`additionalProperties: false`）；坐标全部由 `engine/sid.js` 的 `applyCard` / `resolve` 算出。
- **人的覆盖永远保留**：`scene.js` 把手画的路、圈的区域、拖过的地标 / 入口记在 `user` 里，每次重算先 resolve 再叠回去。
- **关系是算出来的**：`relations.analyze` 给出六项检查与修法；「每层台地都有路可达」不成立时 `scene.js` 自动补支路。
- **变体先过门槛**：`diversity.distinctEnough` 对算过几何的三张卡做签名距离，太像就按地标轴重出一次。
