# @jacklika/dsh-model-selector

DeepSeek Harness 聊天输入框的供应商优先模型选择器。

替换默认的 `conversation.input.model` 插槽，提供三级选择：

1. **根菜单** – 选择模型或推理等级。
2. **供应商** – 选择供应商，支持搜索与重试加载失败的供应商。
3. **模型** – 只看所选供应商的模型，并按 family 分组（如 `SWE-2`、`Claude Fable 5.1`），每个模型下方显示上下文长度和价格信息。

选择器复用 DSH 原生的 `modelDirectories` 服务与 `directory.select()`，选择行为完全兼容。
