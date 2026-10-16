---
description: "通过 tools/execute waterfall 把记忆工具的写 id 划分到按 agent 命名的空间——为多 agent 仓库提供可选的结构性冲突预防。"
kind: "package-reference"
---

# @jacklika/dsh-memory-scope

[English](README.md) | 中文

## 概述

`dsh-memory-scope` 通过 `tools/execute` waterfall 把指定工具（默认 `wiki_write`）的 id 参数重写为 `agents/<agent key>/<id>`。不同 agent 因此在结构上写不同的笔记，而不是竞争同一文件。`sharedPrefixes` 下的 id 原样放行，构成由 `@jacklika/dsh-memory-queue` 或 curator agent 仲裁的公共区。读与搜索工具不受影响：每个 agent 仍能看到整个仓库。本插件不注册任何工具。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

挂载在记忆 filesystem 插件之前：

```yaml
- name: '@jacklika/dsh-memory-scope'
- name: '@jacklika/dsh-tool-memory-filesystem'
- name: '@jacklika/dsh-memory-queue'   # optional: arbitrates shared/ writes
  config:
    crossProcessLock: true
    laneArgument: id
```

负责把 `agents/*` 笔记汇总进 `shared/` 的 curator 部署以 `role: curator` 挂载，使其写入不被重写。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | id 参数需要按 agent 划分的工具名列表。 |
| `idArgument` | `string` | `'id'` | 携带仓库相对笔记 id 的参数名。 |
| `scopePrefix` | `string` | `'agents'` | 存放各 agent 命名空间的仓库顶层目录。 |
| `sharedPrefixes` | `string[]` | `['shared/']` | 公共区 id 前缀；命中的 id 不重写。每项必须以 `/` 结尾。 |
| `role` | `'scoped' \| 'curator'` | `'scoped'` | `curator` 关闭重写，使该部署可直接写公共区。 |
| `agentKey` | `string` | `''` | 所有 session 共用的稳定命名空间 key；为空时按调用方 session id 派生。须为单段路径（字母、数字、`.`、`_`、`-`）。 |
| `acceptanceMode` | `'off' \| 'read-only' \| 'bounded-write'` | `'off'` | 进程级工具调用门禁；配置在专用验收部署中，不接受模型自报角色。 |
| `acceptanceCwd` | `string` | `''` | bounded-write 模式要求存在的绝对工作区路径；每次写入与 session cwd 进行 realpath 比对。 |
| `acceptanceWritePrefixes` | `string[]` | `[]` | bounded-write 模式允许的显式 Vault 相对目录前缀；隐式目标与 compact 均拒绝。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件安装一个 `ctx.on('tools/execute', …)` waterfall 监听器。对匹配的调用，它读取 `idArgument` 的值，跳过已在公共前缀或调用方自身命名空间下的 id，从 `agentKey`（配置时）或 `exec.agent.id`（未配置时）派生路径安全的 key，并以重写后的 id `<scopePrefix>/<key>/<id>` 通过 `ctx.tools.execute` 重派发该调用。之所以必须重派发，是因为解析后的参数在 wrapper 运行前已被深冻结；嵌套执行继承 `rootCallId`、标记 `parent`、并使用 `<callId>:scoped` 调用 id，因此持久日志记录的是真实落盘 id。没有 agent、没有字符串 id、或 `curator` 角色下的调用直接 `next()` 透传。

验收时，为图谱分页 worker 在独立 Loader/Profile 实例中配置 `acceptanceMode: read-only`。它在 scope 重写前拒绝记忆写工具，包括 curator 的嵌套调用。另一个独立 driver 可以使用 `bounded-write`、`acceptanceCwd` 和窄范围 `acceptanceWritePrefixes`（例如 `shared/notes/dsh-run-123/`）。没有 agent session、cwd 不符、不安全或隐式 id、`memory_compact`、前缀外写入均以 `POLICY_DENIED` 失败关闭。拒绝事件会输出含工具、agent/call id 和理由（但不含笔记正文）的结构化 warning。这是**进程级配置**，不是同一 desktop 进程中的逐 agent RBAC。不能把只读 worker 放在无限制 driver 进程内；提示词无法授予或撤销能力。可以在两个隔离进程加载同一插件、使用不同配置。

-----

<a id="model-experience"></a>
## 模型体验

通过 `wiki_write` 间接产生影响；该包装层把 id 参数重写为 `agents/<key>/<id>`，因此工具结果回传的是真实落盘路径而非模型请求的路径。

#### KV Cache 影响

该包装层不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **划分是咨询性的** —— 不在 `toolNames` 中的工具、或瀑布链之外的写入方（shell 命令、未挂载的进程）仍可写任意路径；公共区需要 `@jacklika/dsh-memory-queue` 提供真正的仲裁。
- **只划分写，不划分读** —— 每个 agent 都能读和搜索整个仓库，包括其他 agent 的命名空间；按 agent 的读隔离留待后续。
- **命名空间 key 默认跟随 session id** —— 每个新会话是新命名空间，同 id 的续写不会跨会话落在同一文件；需要跨会话可续写的稳定空间时配置 `agentKey`。恢复或 fork 的会话只有在运行时保留 `exec.agent.id` 时才维持自己的 key；非 agent 调用不做划分。
- **验收门禁只覆盖经当前 Loader 调用的已知记忆工具** —— 不会隔离 shell/文件 API、未挂载的插件、其他进程或任意第三方工具。需要宿主全局保证时，使用独立 OS 沙箱只读 worker 或 Vault 只读挂载。`memory_compact` 无法按单个 id 限定目标，bounded-write 模式下明确拒绝。该可选功能尚未包含在已发布的 rc.33 中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
