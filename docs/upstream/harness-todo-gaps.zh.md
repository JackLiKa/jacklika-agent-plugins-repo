---
description: "面向 DeepSeek Harness 的上游请求：todo_read 工具或每轮注入任务清单，以及在 tools/execute 派发上为会话身份立文档契约。"
kind: "upstream-request"
---

# Harness 任务清单缺口 —— 上游请求

起草给 DeepSeek Harness 维护者。围绕任务清单接缝的三项请求，按其对下游插件的简化程度排序。

## 请求 1：`todo_read` 工具

`todo_write` 是全量替换（`dsh-tool-todo` 追加一条按 `{content, status}[]` 校验的 `todo/write` 会话事件，`todos` 会话投影负责折叠），但没有任何路径把清单读回给模型：

- 整个 Harness 中不存在 `todo_read` 工具；
- `todos` 会话投影有 `wire.view`，但它服务的是客户端 UI，不是模型；
- 该投影的 `apply` 在 `turn/start` 时把状态重置为 `null`，因此即使是宿主侧读取也会在轮次之间丢失清单。

## 请求 2：把当前清单注入系统提示词

`@deepseek-ai/dsh-system-prompt` 中没有任何 todo 贡献。清单既然已经是会话投影，在每次组装时以动态运行时上下文贡献出去，就能让当前状态免费可见——包括压缩、fork、resume 之后，而今天这些场景只剩一份过期摘要。

请求 1–2 任意一项落地，`@jacklika/dsh-todo-anchor` 就没有存在必要了——它现在靠镜像成功的 `todo_write` 派发来做动态上下文。

## 请求 3：为 `tools/execute` 派发上的 `exec.agent` 立文档契约

`tools/execute` 的执行体**确实**携带会话身份——`exec.agent.id` 即会话 id（desk 时代曾用 `agent.sessionId`），且 `assembleContextFor` 会把同一个 agent 作为组装的 `scope` 传入。但 `agent` 在 `ToolExecutionInput` 上是可选字段，公开的 `Agent` 类型只保证 `id`，也没有任何文档说明"派发 → 组装"这条身份链是稳定的。请求一份文档契约——"按 agent 路由的派发始终携带 `exec.agent.id`，对应的组装会把该 agent 作为 `context.scope`"——观察者才能按会话分键状态，而不必对字段名做防御式探测。

## 证据

- `dsh-session-format-*` 校验 `"todo/write": disposition(["todos"])`，条目为 `{content, status}`。
- `dsh-tool-todo` 注册的 `todo_write` 声明 `parameters.todos`（必填的 `{content, status}` 对象数组，`additionalProperties: false`），并注册 `todos` 投影；它没有读路径。
- `dsh-system-prompt` 不含 todo 引用；`dsh-session-projection` 没有面向模型的 todo 读取。
- `dsh-tool-todo` 的投影在 `turn/start` 时重置，因此该投影是 UI 面，不是持久的模型可见状态。
- 注（2026-10）：`session/event` Cordis 事件流**是**插件可订阅的接缝——`ctx.sessions` 把 `turn/start`、`tool/call`、`tool/result`、`assistant/message`、`turn/end` 发布给后代上下文的监听器（`dsh-workspace-changes` 与 `dsh-user-questions` 均以此方式订阅）。`@jacklika/dsh-memory-anchor` 已用它实现真实的按轮自动入库。此前"无 turn 生命周期可观测"的假设有误；真正缺的只是面向模型的、有文档契约的接口。

## 影响

没有读路径，清单因压缩、resume 或换模型丢失后在会话内**无法恢复**——模型无法区分"没有清单"和"清单丢了"。没有注入，过期清单不可见：模型永远不知道它上次写入已过期。没有 `exec.agent` 身份的文档契约，按会话工作的观察者（锚定、审计、作用域副作用）只能猜测哪些字段跨版本稳定。
