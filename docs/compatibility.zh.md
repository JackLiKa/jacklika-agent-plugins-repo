# 兼容性

## 已验证基线

| 组件 | 声明范围 | 已验证基线 |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | 本地：22.23.2；CI 覆盖 Linux、macOS、Windows 上的 22.19.0 与当前 24.x |
| pnpm | 仓库开发使用 11.7.0 | 11.7.0 |
| DeepSeek Harness 包 | peer `>=0.1.7-rc.1 <0.3.0-0` | `0.1.7-rc.10` 与 `0.2.0-rc.1` 均跑过完整套件 |
| Cordis | peer exact `4.0.4` | 4.0.4 |
| Git | `git` 必须在 `PATH` 中；插件使用 `-C`、`init`、`rev-parse`、`status`、`add`、`commit` | 本地：Apple Git 2.50.1；CI 使用各 runner 自带 Git |

Harness peer 范围故意采用有界范围而非精确版本。Harness API 尚未稳定，桌面应用会自动更新，因此精确 peer 会把兼容但无关的新版本也变成加载时拒绝——这在验证本套件时已经发生过两次。有界范围保留了关键保护：下一个主版本线仍会在代码加载前被拒绝，因为 `>=0.1.7-rc.1 <0.3.0-0` 只接纳 0.1.x 与 0.2.x 线（从 `0.1.7-rc.1` 起），并明确排除 0.3.x 的每个预发布版本。`-0` 后缀必不可少，因为 semver 开启 `includePrerelease` 时会把 `0.3.0-rc.1` 视为满足 `<0.3.0`。窗口内的每个发布都必须通过完整 CI 与独立的 Profile 安装测试，才能加入窗口；超出当前已验证线的扩容也需要同等证据。因此“允许”与“已验证”在当前指向同一窗口。

Harness 在 registry 安装前和 Profile 组合前都会检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer。本套件的 Bundle 声明了该有界范围，因此超出验证线的运行时会先在加载前被拒绝。Harness 提供显式的 `allow-version --accept-risk` 豁免，但它是紧急用户决策，不是本套件的安装步骤。超出窗口的运行时通常应通过验证并移动窗口来解决。

## 引用的 Harness API

| 插件包 | 导入 |
|---|---|
| 所有 Cordis 插件 | `@deepseek-ai/cordis` 的 `Context`；`@deepseek-ai/schemastery` 的 config |
| scope | `@deepseek-ai/dsh-llm` 的 `ToolCallId`；`@deepseek-ai/dsh-tools` 的 `ToolDispatchExecution`、`ToolExecutionResult` 与 `ctx.tools.execute` |
| queue 与 git | `@deepseek-ai/dsh-tools` 的 `ToolExecutionResult` 与 `tools/execute` 瀑布 |
| filesystem、graph、vector、curator | `@deepseek-ai/dsh-tools` 的 `defineTool` / `ToolRunContext`；filesystem、graph、curator 也使用 `@deepseek-ai/dsh-util-values` 的 `JsonValue` |
| todo-anchor | `@deepseek-ai/dsh-tools` 的 `ToolExecutionResult` 与 `tools/execute` 瀑布；`@deepseek-ai/dsh-system-prompt` 的 `ctx.systemPrompt.context` |

Bundle 本身只包含 Cordis patch 与对成员包的运行时依赖。

## 本套件依赖的 Harness 接缝

| 接缝 | 使用方 | 所依赖的契约 |
|---|---|---|
| `tools/execute` 瀑布 | scope、queue、git、todo-anchor | 监听器调用 `next()`，之后可读 `exec.name` / `exec.arguments`。todo-anchor 把错误结果视为“未写入”，绝不锚定它。 |
| `ctx.systemPrompt.context` | todo-anchor | 注册有序的动态运行时上下文。`text` 可以是函数，在**每次提示词组装**时求值；结果长度为 0 则被丢弃。渲染出的快照被标注为取代此前的运行时上下文快照——这正是注入值能比压缩摘要活得更久的原因。 |
| `todo/write` 会话事件 | Harness，非本套件 | `todo_write` 把 `{content, status}[]` 作为会话事件持久化。本套件把它记录为**所依赖的事实**，而绝不作为自己调用的 API。 |

## 本套件绕过的已知 Harness 缺口

- **没有 `todo_read`。** `todo_write` 全量替换清单，且没有任何工具把它读回来，因此停止写入的模型会一直看到自己上次的声明，而上下文里丢了清单的会话也无法找回。todo-anchor 把清单镜像进动态上下文，消除的是**丢失**那一半；**过期**那一半是行为问题，任何插件都无法消除。
- **`exec.agent` 的会话身份存在但类型单薄。** `tools/execute` 派发携带 `exec.agent.id`——即会话 id——todo-anchor 据此按会话分键清单。公开 `Agent` 类型只保证 `id`，因此插件做防御式读取（先 `id` 再 `sessionId`），并对无 scope 的组装回退到进程级最近清单。
- **任务清单状态不会被注入系统提示词。** `@deepseek-ai/dsh-system-prompt` 中没有任何 todo 贡献，因此被 resume、fork 或压缩过的会话没有一等公民途径找回当前清单。

一个 `todo_read` 工具，或每轮重新注入当前清单，都会让 todo-anchor 变得不必要。在它出现之前，镜像就是变通方案，而仓库笔记仍是持久记录。

## 跨平台说明

- Vault 路径通过 Node `path` 模块解析，并在任何读写前经过校验。
- 完整 Windows/macOS/Linux CI 矩阵会在每次 push 时运行 `install`、`typecheck`、`lint`、`test`、`build`、`test:multiprocess`、`test:pack` 与 `test:profile`。
