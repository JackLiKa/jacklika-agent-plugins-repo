# @jacklika/dsh-memory-anchor

让"先查记忆再行动、结束后入库"的纪律在每轮 prompt 中恒在。vault 约定沉淀在 `memory-vault` skill 里，但 skill 只在模型主动加载时才生效。本插件以动态运行时上下文（`ctx.systemPrompt.context`）贡献一小段恒在提醒，Harness 每轮组装 prompt 都会重新渲染，压缩后仍然存在。

**诚实边界**：召回无法自动化 —— 插件不会替模型检索 vault。但入库**可以**：Harness 以 Cordis 事件形式发布会话事件流（`session/event`，携带 `turn/start`、`tool/call`、`tool/result`、`assistant/message`、`turn/end`），`dsh-workspace-changes` 正是靠它快照每轮。`autoCapture` 开启（默认）时，插件在 `turn/end` 通过 `wiki_write` 追加一段机械式回合摘要。该摘要是启发式记账（工具名、短摘录），不是模型整理的笔记 —— 持久结论仍需显式 `memory_capture`/`wiki_write`。

## 自动入库

每个有可观测活动的回合会在 `<captureNotePrefix>-<sessionId>.md`（默认 `shared/notes/auto-capture-<id>.md`）追加一节：

- 空闲回合（无工具调用、无消息）不写；
- 未挂载 `wiki_write` 的部署不写；
- 笔记 id 经过清洗（`sess:abc/1` → `auto-capture-sess-abc-1`）；
- 写入失败只记日志，绝不抛进会话事件流。

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
    autoCapture: true                         # turn/end 时追加回合摘要
    captureNotePrefix: 'shared/notes/auto-capture'
    excerptChars: 200                         # 摘要中每条消息的摘录上限
```

- 两个提醒都关闭时贡献渲染为 `''`，Harness 会整体丢弃 —— prompt 中不留痕迹。
- Vault 句（"The Vault is the persistent record of this workspace."）只在 `vaultHint` 开启**且** `wiki_write` 或 `memory_capture` 确实注册时出现，未装记忆套件的部署不会看到指向不存在工具的提示。
- 贡献与 `session/event` 监听器随插件的 Loader fiber 一起卸载。
