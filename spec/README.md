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
python -I -c "import json,jsonschema,sys; s=json.load(open('spec/sid.schema.json',encoding='utf-8')); d=json.load(open('spec/examples/village-square.sid.json',encoding='utf-8')); jsonschema.validate(d,s); print('ok')"
```

有 Node 时用 ajv（后续编辑器内置）。
