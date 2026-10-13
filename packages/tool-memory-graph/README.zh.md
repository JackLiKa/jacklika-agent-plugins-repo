---
description: "面向模型的 wiki_graph 工具，输出 Markdown 仓库的 [[link]] 链接图。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

[English](README.md) | 中文

## 概述

`dsh-tool-memory-graph` 让 agent 对 [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.zh.md) 使用的 Markdown 仓库做只读图查询。模型可见一个工具 `wiki_graph`，返回两类来源推导的笔记节点和有向边：显式 Obsidian 风格 `[[link]]` 引用，以及笔记之间的关键词共现（frontmatter tags/title 与正文中的显著词）。因此它能暴露类似“B 与 C 都提到 `word1`”的隐式关联，且当某条笔记被重写、共同词消失时该关联自动消失；若重写后双方出现新的共词（如 `word2`），则自动建立以 `word2` 为标签的新关联。该包复用 filesystem 插件的仓库根解析与解析辅助函数，路径约束、frontmatter 处理和 `indexHiddenDirs` 策略完全一致，不引入第二套解析器。

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
| `maxEdges` | `number` | `1000` | 单次图查询返回的最大边数。 |

### 工具

- `wiki_graph(id?, depth?)` —— 不传 `id` 时返回全仓库的节点与有向边；传 `id` 时返回 `depth` 跳内的可达子图，两个端点都被选中时边界节点的出边也会包含。边携带 `type`（`link` 或 `keyword`）、`keywords`（仅 `keyword` 边）和 `weight`（合并词频）。输出为 `{ nodes, edges, truncated, edgesTruncated }`：`truncated` 对应 `maxNodes` 截断，`edgesTruncated` 对应 `maxEdges` 截断，两者分开报告，节点完整不会被误读为整图完整。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是单个 Cordis 函数插件，在 `ctx.tools` 上注册 `wiki_graph`。每次调用通过共享的 `resolveMemoryVaultRoot` 解析仓库根，用 `listNotePaths` 遍历笔记，用 `extractLinks`/`resolveLinkTarget` 提取 `[[link]]` 目标。目标按与 `wiki_read` 相同的 Obsidian 语义解析——先精确仓库相对路径，再路径后缀，最后全仓库 basename 匹配，多重命中按确定性规则选择。除显式链接外，工具还会从每条笔记提取显著词（frontmatter `tags` ×3、frontmatter `title` ×2、正文词 ×1），并为任意两篇共享一个或多个词的笔记创建 `keyword` 边。广度优先遍历带 visited 集合（循环链接图因此可终止），同时跟随 `link` 边与 `keyword` 边以确定节点集合，再从所有已选节点收集边，因此边界节点的出边不会丢失。节点集合超过 `maxNodes` 时，全仓库图保留码点序最小的若干 id（与 `tool-memory-filesystem` 的并列排序规则一致），子图则保留离中心最近的笔记——先按 BFS 层级、再按 id——因此保留哪些笔记不依赖目录列举顺序，子图也不会丢掉自己的中心节点。由于 `wiki_graph` 每次调用都会从磁盘重新计算，重写一条笔记会移除旧的 `keyword` 边，并为新正文中保留下来的或新出现的词建立新边。边在节点集合确定后按 `maxEdges` 截断：显式 `link` 边优先，其后是 `keyword` 边按 `weight` 降序，并以 id 作确定性并列裁决——保留哪些边同样不依赖目录列举顺序。以非已索引笔记作为中心 id 会以 `note not found` 失败；无法读取的笔记会被跳过（记入 logger 警告），不会让整次调用失败。输出为 `{ nodes: [{ id, title }], edges: [{ from, to, type, keywords?, weight? }], truncated: boolean, edgesTruncated: boolean }`，其中 `truncated` 对应节点上限、`edgesTruncated` 对应边上限。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型可见内容

模型看到生成的 `wiki_graph` schema。描述声明该图是只读的，由 `[[link]]` 引用与共享关键词共同推导。

##### `wiki_graph` 的原文描述

```markdown
Return the link and keyword graph of the wiki vault: note ids, titles, and directed edges. Explicit `[[link]]` edges are type `link`; edges derived from shared significant terms are type `keyword` with `keywords` and `weight`. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth. Nodes are capped at maxNodes (`truncated`) and edges at maxEdges (`edgesTruncated`).
```

#### Token 影响

全仓库调用返回所有节点与边，大仓库可能产生较多 token。指定中心 id 的子图调用通过 `depth` 限制输出规模。

#### KV Cache 影响

独立。插件只提供工具结果，不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **无可视化** —— 工具返回 JSON 节点与边；渲染（Obsidian 图谱、Mermaid）由消费方负责。
- **边限于已选节点** —— 只有两端都在 `maxNodes` 截断后保留下来的节点之间的链接才会出现，子图边界外的出边被省略；密集仓库随后可能触及 `maxEdges` 上限，`edgesTruncated` 会表明返回的边只是确定性切片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
