# spec · Scene Intent Document (SID)

引擎无关的声明式场景意图文件，是 ai-scene-bridge 的核心：用户与 AI 之间交换"场景是什么"的媒介。

- [sid.schema.json](sid.schema.json) —— v0.1 的 JSON Schema（draft-07）
- [examples/village-square.sid.json](examples/village-square.sid.json) —— 手写示例：村口广场（第 0 周 A/B 实验用）
- 设计说明与坐标约定见 [docs/02-中间层设计草案-v0.md](../docs/02-中间层设计草案-v0.md)

## 约定速查

| 项 | 值 |
| --- | --- |
| 单位 | 米 |
| 上轴 / 手性 | +Y / 右手（同 glTF） |
| 北 | −Z |
| `position` | 对象**底面中心** |
| `rotation_y` | 绕 +Y 的度数，0 = 面朝北，俯视逆时针为正 |
| `id` | `^[a-z][a-z0-9_]*$`，人可读，如 `house_1` |
| 网格 | 默认 0.5 m 吸附 |

## 校验

有 Python 时：

```bash
python -X utf8 -c "import json,jsonschema,sys; s=json.load(open('spec/sid.schema.json',encoding='utf-8')); d=json.load(open('spec/examples/village-square.sid.json',encoding='utf-8')); jsonschema.validate(d,s); print('ok')"
```

有 Node 时用 ajv（后续编辑器内置）。

## v0.2 增补（「场景对话」正式版用到的字段）

- `terrain.features[]`：`kind: plateau` 的台地可以用 `polygon`（俯视多边形）+ `level`（层号）+ `skirt`（边缘坡面宽）表达，`height = level × meta.layer_height_m`；高度场取各台地贡献的最大值，上层多边形落在下层之内就形成叠落。圆形 `center/radius` 仍然可用。
- `meta.layer_height_m`（一层多少米，默认 3）、`meta.archetype`（地形原型名）、`meta.card`（AI 与人商定的结构卡）。
- `volumes[] / paths[]`：`generated`（引擎按规则生成，重算会重放）、`locked`（人确认，不动）、`user_drawn`（人手画的路）、`terrace_level`。
- `regions[]`：新增 `kind` 取值 `plaza`、`terrace`；`density` 上限 1.6；`terrace_level`、`user_set`。
- `views[]`：新增 `kind: section`（侧剖面）。
引擎如何生成与消费这些字段见 [medium/engine/SPEC.md](../medium/engine/SPEC.md)，引擎侧 AI 怎么读见 [PROTOCOL.md](PROTOCOL.md) 第 0 节。
