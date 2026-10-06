---
description: "通过 tools/execute 瀑布与动态提示词上下文，把会话任务清单重新注入每一次请求，使一次写下的清单不会悄然过期。"
kind: "package-reference"
---

# @jacklika/dsh-todo-anchor

[English](README.md) | 中文

## 概述

`dsh-todo-anchor` 让会话任务清单在整个任务期间保持可见。`todo_write` 是**全量替换**，没有任何工具能把它读回来，Harness 也不会重新注入它 —— 因此只在开头写一次的清单会一直声称它上次说的内容，而被 resume、fork 或压缩过的会话甚至可能连那份清单都丢掉。本插件监听目标工具的**成功派发**，记住条目数组，并以**动态运行时上下文**的形式提供出去 —— 那是 Harness 每次组装提示词时都会重新渲染、且明确标注为"取代此前快照"的唯一通道。插件自身不注册任何工具，也不向磁盘写入任何内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与提示词注册表、工具注册表一并挂载，并置于持有该清单的工具之前：

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@jacklika/dsh-todo-anchor'
```

### 配置锚点

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolName` | string | `todo_write` | 其成功派发会刷新锚定清单的工具。 |
| `todosArgument` | string | `todos` | 该工具中承载条目数组的参数名。已对照 `@deepseek-ai/dsh-tool-todo` 验证：真实工具声明 `todos` 为必填的 `{content, status}` 对象数组；配置不匹配时会抛错，而不是静默失效。 |
| `contextName` | string | `todo-anchor:list` | 所注册动态提示词上下文的名称。 |
| `order` | number | `130` | 在动态上下文中的排序位。Harness 保留 110–120 给沙箱策略、审批策略与子代理委派。 |
| `reminder` | boolean | `true` | 是否在清单旁渲染回写规则。 |
| `maxItems` | number | `50` | 渲染条目上限；超出部分折叠为计数。 |

<a id="understand-the-implementation"></a>
## 理解实现

两处注册，均随 Loader fiber 一并释放：

- **`tools/execute` 瀑布监听器** —— 与 `dsh-memory-git` 提交写入所用的是同一个接缝。它先调用 `next()`，若派发未成功或工具名不匹配则立即返回，随后从 `exec.arguments` 取出条目数组。**失败的派发永远不会被锚定**，因此插件不可能采用一个注册表已拒绝的清单。
- **动态提示词上下文**（`ctx.systemPrompt.context`），其 `text` 是一个由 Harness 在**每次组装提示词时**求值的函数。这正是清单能扛过压缩的原因：渲染出的快照被明确标注为取代此前的运行时上下文快照，因此当前清单永远优先于早于它的摘要。

顺序是刻意的。监听器只做观察：它从不改写工具结果，也从不触碰仓库。

<a id="model-experience"></a>
## 模型体验

模型不会获得新工具，`todo_write` 的行为也没有变化。改变的是首次写入之后**每次请求的运行时上下文**：

```
Current task list (kept in sync by the `todo_write` tool).

- [x] audit the parser
- [~] fix the CRLF path
- [ ] write the regression test

Re-write this list as soon as an item completes. It is a progress display, not a record:
no tool reads it back and nothing else re-injects it, so a list left stale is
indistinguishable from real progress. Durable decisions belong in the memory Vault.
```

末尾的 Vault 提示句仅在注册了 vault 工具（`wiki_write` 或 `memory_capture`）时才输出——每次组装时检测——因此未安装 `@jacklika/dsh-memory` 的部署不会让模型去调用不存在的工具。

空清单渲染为 `''`，会被 Harness 丢弃，因此从未写过任务清单的会话完全不受影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **按会话隔离，但仅在进程内。** 清单以 `exec.agent.id`（agent loop 为每次派发打上的会话 id）为键——并发会话（主线程与子代理）互不可见，即使存活 agent 对象被重建，恢复的会话仍沿用同一身份。无 scope 的组装（不做按 agent 组装的宿主）回退到最近一次写入。映射仍存于进程内存：一个 `todo_read` 工具会让本插件彻底不需要存在——那时清单可以按需读回，而不必被镜像。
- **校验 schema，响铃报错。** 在激活时——若工具注册更晚则在首次匹配到派发时——插件会把 `todosArgument` 与该工具编译后的参数 schema 对照，不一致即抛错。参数被改名因此会让派发以明确错误失败，而不是静默锚定不到任何内容。
- **是显示，不是记录。** 清单是进程内状态：它不跨宿主重启存活，也不能替代仓库笔记 —— 提醒文案已明说这一点，进度追踪的持久那一半属于 `@jacklika/dsh-memory`。
- **只减轻过期，不消除过期。** 重新注入让过期的清单在每一轮都**可见**；但只有模型重新写入，清单才会**正确**。

<a id="dev-note"></a>
## 开发说明

`tests/render.spec.ts` 以纯函数方式覆盖渲染器。`tests/loader-composition.spec.ts` 在真实提示词注册表与工具注册表旁启动真实 Loader，注册一个 `todo_write` 桩，派发它，并对 `renderContextSnapshot(await ctx.systemPrompt.assemble())` 断言 —— 那正是 Harness 放进下一次提示词的文本。
