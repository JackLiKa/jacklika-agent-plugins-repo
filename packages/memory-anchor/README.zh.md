# @jacklika/dsh-memory-anchor

让"先查记忆再行动、结束后入库"的纪律在每轮 prompt 中恒在。vault 约定沉淀在 `memory-vault` skill 里，但 skill 只在模型主动加载时才生效。本插件以动态运行时上下文（`ctx.systemPrompt.context`）贡献一小段恒在提醒，Harness 每轮组装 prompt 都会重新渲染，压缩后仍然存在。

**诚实边界**：DSH 没有 `turn/start` / `turn/end` 钩子，所以这只是**提醒层**。它不会也无法自动召回或自动入库 —— 不会拦截任何 turn，不会自行检索或写库。

## 配置

```yaml
- name: '@jacklika/dsh-memory-anchor'
  config:
    contextName: 'memory-anchor:discipline'   # 默认
    order: 135                                # 在 Harness 110-120 与 todo-anchor 130 之后
    recallReminder: true                      # 「先查记忆再作答」一行
    captureReminder: true                     # 「结束后记录结论」一行
    recallText: '...'                         # 两行文案均可完全覆盖
    captureText: '...'
    vaultHint: true                           # 允许出现 Vault 句
```

- 两个提醒都关闭时贡献渲染为 `''`，Harness 会整体丢弃 —— prompt 中不留痕迹。
- Vault 句（"The Vault is the persistent record of this workspace."）只在 `vaultHint` 开启**且** `wiki_write` 或 `memory_capture` 确实注册时出现，未装记忆套件的部署不会看到指向不存在工具的提示。
- 贡献随插件的 Loader fiber 一起卸载。
