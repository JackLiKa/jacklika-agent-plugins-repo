# @jacklika/dsh-model-selector

DeepSeek Harness 聊天输入框的自定义模型选择器。

替换默认的 `conversation.input.model` 插槽，提供两种模式：

- **原版** – 紧凑的供应商分组列表，风格与原生选择器一致。
- **复刻** – 按当前供应商还原 Devin 或 Qoder 原生选择器，并支持上下文窗口、推理等级等参数调节。

上次选择的模式通过 `localStorage` 记忆；默认模式为 **原版**。

## 工作原理

选择器在官方插槽 `conversation.input.model` 上以 `priority: -1` 注册，加载期间覆盖原生选择器；卸载后原生选择器自动恢复。

它复用 DSH 的 per-session `modelDirectories` 服务：

- 供应商列表、模型分组、推理等级都来自 `directory.store`。
- 选中模型通过 `directory.select()` 提交，因此路由与原生选择器完全一致。

## 参数调节

在 **复刻** 模式下，Devin 和 Qoder 面板会显示两行参数：

- **上下文窗口** – 200K、400K、1M。
- **推理等级 / 思考模式** – low、medium、high、xhigh、max。

选中的参数会编码进模型 id：`model-id@@ctx=<tokens>&effort=<level>`。Devin 和 Qoder 的 adapter 会解码该 id，并把参数传给各自 CLI：

- `--max-output-tokens <tokens>`
- `--reasoning-effort <level>`

## UI 主题

弹窗通过 CSS 变量跟随操作系统主题（`prefers-color-scheme`），在浅色与深色 DeepSeek Harness 主题下都能正确显示。

## 键盘导航

- `Esc` 关闭弹窗。
- 支持鼠标/触摸选择。
