# @jacklika/dsh-model-selector

DeepSeek Harness 聊天输入框的供应商优先模型选择器。

替换默认的 `conversation.input.model` 插槽，提供可读性更好的三级选择器：

1. **根菜单** – 选择模型或推理等级。
2. **供应商** – 选择供应商，支持搜索与重试加载失败的供应商。
3. **模型** – 只看所选供应商的模型，并按 family 分组。

## 工作原理

选择器在官方插槽 `conversation.input.model` 上以 `priority: -1` 注册，加载期间覆盖原生选择器；卸载后原生选择器自动恢复。

它复用 DSH 的 per-session `modelDirectories` 服务：

- 供应商列表、模型分组、推理等级都来自 `directory.store`。
- 选中模型通过 `directory.select()` 提交，因此路由、推理等级处理与 adapter 默认行为与原生选择器完全一致。

## 模型元数据

模型在 `description` 字段中提供上下文长度与价格信息（由 `@jacklika/dsh-devin-connect` 等 adapter 提供）。选择器会在模型名下方渲染这些元数据。

## Family 分组

Devin 每个模型 family 下有多个变体（如 `SWE-2 High/Medium/Max`、`Claude Fable 5.1 Medium/Low/...`）。选择器按 ` › ` 分隔符拆分模型名，并为每个 family 渲染一个分组标题，使相关变体排在一起。

## 键盘导航

- `↑` / `↓` 在当前面板中移动焦点。
- `Esc` 一级一级返回：模型 → 供应商 → 根菜单 → 关闭。
- 也可使用鼠标点击供应商/模型。
