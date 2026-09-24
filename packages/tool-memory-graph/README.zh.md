---
description: "面向模型的 wiki_graph 工具，输出 Markdown 仓库的 [[link]] 链接图。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

[English](README.md) | 中文

## 概述

`dsh-tool-memory-graph` 让 agent 对 [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.zh.md) 使用的 Markdown 仓库做只读图查询。模型可见一个工具 `wiki_graph`，返回由 Obsidian 风格 `[[link]]` 引用推导的笔记节点和有向边——可以是全仓库图，也可以是以某条笔记为中心的可达子图。该包复用 filesystem 插件的仓库根解析与解析辅助函数，路径约束、frontmatter 处理和 `indexHiddenDirs` 策略完全一致，不引入第二套解析器。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

在 profile 或 patch 文件中挂载插件：

```yaml
- name: '@jacklika/dsh-tool-memory-graph'
```

仓库根与 `tool-memory-filesystem` 一致，每次调用时解析：显式 `vaultRoot`（相对路径锚定会话工作区），否则使用 `<session cwd>/.dsh/memory/`。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | 仓库根。留空时使用按工作区隔离的记忆目录；相对路径相对于会话工作区解析。 |
| `extensions` | `string[]` | `['.md']` | 视为笔记的文件扩展名。 |
| `indexHiddenDirs` | `boolean` | `false` | 是否索引以 `.` 开头的目录（`.git` 与 `node_modules` 始终排除）。当 `vaultRoot` 指向工作区根时开启，以纳入 `.dsh/memory/`。 |
| `maxDepth` | `number` | `1` | 指定中心笔记时 BFS 的最大深度。 |
| `maxNodes` | `number` | `200` | 单次图查询返回的最大节点数。 |

### 工具

- `wiki_graph(id?, depth?)` —— 不传 `id` 时返回全仓库的节点与有向边；传 `id` 时返回 `depth` 跳内的可达子图，两个端点都被选中时边界节点的出边也会包含。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是单个 Cordis 函数插件，在 `ctx.tools` 上注册 `wiki_graph`。每次调用通过共享的 `resolveMemoryVaultRoot` 解析仓库根，用 `listNotePaths` 遍历笔记，用 `extractLinks`/`resolveLinkTarget` 提取 `[[link]]` 目标。先用广度优先遍历确定节点集合，再从所有已选节点收集边，因此边界节点的出边不会丢失。输出为 `{ nodes: [{ id, title, backlinks }], edges: [{ from, to }] }`。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型可见内容

模型在[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory-graph)中看到生成的 `wiki_graph` schema。描述声明该图是只读的，由 `[[link]]` 引用推导。

##### `wiki_graph` 的原文描述

```markdown
Return the Obsidian-style [[link]] graph of the wiki vault: note ids, titles, and directed edges. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth.
```

#### Token 影响

全仓库调用返回所有节点与边，大仓库可能产生较多 token。指定中心 id 的子图调用通过 `depth` 限制输出规模。

#### KV Cache 影响

独立。插件只提供工具结果，不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **无可视化** —— 工具返回 JSON 节点与边；渲染（Obsidian 图谱、Mermaid）由消费方负责。
- **backlinks 基于全仓库统计** —— 节点的 `backlinks` 计数覆盖全部笔记，而非仅选中子图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
