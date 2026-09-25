---
description: "通过 tools/execute waterfall 串行化指定工具调用——为记忆工具提供可选的写顺序保障。"
kind: "package-reference"
---

# @jacklika/dsh-memory-queue

[English](README.md) | 中文

## 概述

`dsh-memory-queue` 通过 `tools/execute` waterfall 把发往指定工具（默认 `wiki_write`）的并发调用串行化。挂载后记忆仓库获得单写者顺序保证，且**不需要修改** `dsh-tool-memory-filesystem`：被列出的工具调用进入共享 FIFO 链，其余工具调用照常派发。开启 `crossProcessLock` 后，串行区段还会在仓库根目录持有一个基于 `mkdir` 的锁目录，使不同的 dsh 进程也无法交错写入。本插件不注册任何工具。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

与记忆 filesystem 插件一起挂载：

```yaml
- name: '@jacklika/dsh-tool-memory-filesystem'
- name: '@jacklika/dsh-memory-queue'
```

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | 需要进入同一条串行链的工具名列表。 |
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | 锁目录所在的仓库根；与记忆工具相同的按调用解析规则。 |
| `crossProcessLock` | `boolean` | `false` | 在每次串行派发前后于仓库根获取锁目录，使不同进程无法交错调用。 |
| `laneArgument` | `string` | `''` | 以某个字符串工具参数的值划分独立串行链与锁目录——例如设为 `id` 时，写不同笔记可并行，写同一笔记仍串行。 |
| `lockStaleMs` | `number` | `15000` | 锁目录超过该时长未刷新即视为被遗弃并被回收；必须大于 `2 × lockHeartbeatMs`。 |
| `lockHeartbeatMs` | `number` | `2000` | 持有方刷新锁目录 mtime 的间隔。 |
| `lockTimeoutMs` | `number` | `30000` | 等待持有方释放锁的超时毫秒数。 |
| `lockRetryMs` | `number` | `100` | 锁获取重试间隔。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件安装一个 `ctx.on('tools/execute', …)` waterfall 监听器。工具名在 `toolNames` 中的调用进入按 lane 划分的 promise 链；每个调用在前一个串行调用结束后才执行 `next()`。未列出的工具直接 `next()` 透传。开启 `crossProcessLock` 时，串行区段使用 `<vault>/.memory-queue.lock` 上的原子 `mkdir` 锁。持有方把随机 ownership token、hostname、PID 写入 `owner.json`，并每 `lockHeartbeatMs` 递增 `<lock>/heartbeat`。不同 `laneArgument` 值获得独立的 SHA-1 命名锁目录并可并行。等待方只有在心跳连续 `lockStaleMs` 不变后才认为锁 stale；同机 owner 的 PID 仍存活时绝不回收。回收与释放会先 rename 锁目录，释放前还会校验 ownership token，因此旧 owner 不会删除后继 owner 的锁。等待支持 AbortSignal；超过 `lockTimeoutMs` 时明确失败。

-----

<a id="model-experience"></a>
## 模型体验

无 —— 插件不注册任何工具、prompt 或结果，只对其他包的工具调用重排序。

#### KV Cache 影响

该包装层不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **锁是咨询性的** —— `crossProcessLock` 只约束挂载了本插件的进程；瀑布链之外的写入方（其他工具、shell 命令）仍可能与仓库竞态。`wiki_write` 的原子发布使此类竞态不再损坏文件，其可选 `baseVersion` 校验可把丢更新变成对协作调用方显式报冲突。
- **每条链按 lane 值串行** —— `laneArgument` 值相同的调用（即使属于不同列出工具）仍互相串行；按工具分通道的能力留待后续。
- **旧式锁需要一个观察窗口** —— 没有 `heartbeat` 文件的锁目录（手工创建或旧版本插件）要观察到 mtime 在本地 `lockStaleMs` 内不变才判定死亡，因此回收死锁需要一个完整窗口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
