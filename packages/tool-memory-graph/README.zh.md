---
description: "面向模型的 wiki_graph 工具，输出 Markdown 仓库的 [[link]] 链接图。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

[English](README.md) | 中文

## 概述

`dsh-tool-memory-graph` 让 agent 对 [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.zh.md) 使用的 Markdown 仓库做只读图查询。模型可见 `wiki_graph`、精简的隔离检查工具 `wiki_graph_audit`，以及限量分页工具 `wiki_graph_page`。`wiki_graph` 返回两类来源推导的笔记节点和有向边：显式 Obsidian 风格 `[[link]]` 引用，以及笔记之间的关键词共现（frontmatter tags/title 与正文中的显著词）。因此它能暴露类似“B 与 C 都提到 `word1`”的隐式关联，且当某条笔记被重写、共同词消失时该关联自动消失；若重写后双方出现新的共词（如 `word2`），则自动建立以 `word2` 为标签的新关联。该包复用 filesystem 插件的仓库根解析与解析辅助函数，路径约束、frontmatter 处理和 `indexHiddenDirs` 策略完全一致，不引入第二套解析器。

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
| `excludeDirs` | `string[]` | `['archive']` | 建图前排除这些目录名及其笔记、链接目标和关键词边；归档笔记仍可由 `wiki_read` 按 id 直接读取。 |
| `maxDepth` | `number` | `1` | 指定中心笔记时 BFS 的最大深度。 |
| `maxDepthLimit` | `number` | `20` | 生效 `depth` 的硬上限。请求更大值时会被钳制到该值，子图报告实际遍历的深度。必须 `>= maxDepth`。 |
| `maxNodes` | `number` | `200` | 默认节点返回上限；单次调用可覆盖。 |
| `maxNodesLimit` | `number` | `2000` | 节点生效上限的硬约束，配置默认值也受限。 |
| `maxEdges` | `number` | `1000` | 默认边返回上限；单次调用可覆盖。 |
| `maxEdgesLimit` | `number` | `20000` | 边生效上限的硬约束，配置默认值也受限。 |
| `pageSizeLimit` | `number` | `250` | 单次 `wiki_graph_page` 最多返回的节点或边数。 |
| `pageScanNodesLimit` | `number` | `5000` | 索引笔记数超过此服务端工作量上限时拒绝全图分页。 |
| `pageScanEdgesLimit` | `number` | `250000` | 完整边生成超出此上限时拒绝分页；审计不依赖分页上限。 |
| `keywordMaxDocFraction` | `number` | `1` | 建边前丢弃出现在超过该比例索引笔记中的关键词。几乎出现在每篇笔记中的词会把所有节点连成一片、不携带区分信号；`1` 保留全部词（历史行为）。 |
| `keywordEdgeTopK` | `number` | `0` | 每个节点最多保留该数量的关键词边；一条边仅当两端都把它排进自己的前 K 时才保留（互近邻）。`0` 关闭剪枝（历史行为）。两个选项都不影响 `wiki_graph_audit`——审计始终检查未稀疏化的边集。 |

### 工具

- `wiki_graph(id?, depth?, maxNodes?, maxEdges?)` —— 不传 `id` 返回全图，传入则返回 `depth` 跳内的子图。单次预算必须为正整数，并受 `maxNodesLimit`/`maxEdgesLimit` 硬上限钳制；返回 `effectiveMaxNodes`/`effectiveMaxEdges` 表示实际采用的预算。显式 link 边仅有 `from`/`to`（没有 `type`），关键词边携带 `type: 'keyword'`、`keywords`、`weight`。在既有 `truncated`、`edgesTruncated` 和可选生效 `depth` 之外，还返回 `nodesTotal`、`nodesReturned`、`edgesTotal`、`edgesReturned`、`edgesDropped`、`excludedDirs`。`nodesTotal` 是节点截断前的可达索引笔记数；`edgesTotal` 是**已返回节点之间**在边截断前的候选边数，保证 `edgesReturned + edgesDropped === edgesTotal`。若节点已截断，被裁节点相关的边不在该数内；只有两个截断标志均为 `false` 才可视为穷尽。`excludedDirs` 是配置的索引排除目录名，不是排除笔记数。以实际存在但被排除的笔记为中心会报 `note excluded by excludeDirs`，缺失笔记仍报 `note not found`。
- `wiki_graph_audit()` —— 不返回图谱数组，直接检查完整索引。返回 `{ indexedNodes, checkedLinks, excludedDirsApplied, excludedNodesInIndex, excludedEdgeEndpoints, archiveNodesInIndex, archiveEdgeEndpoints, skippedEntries, scanStable, complete, archiveExcluded, snapshotId }`。在结果上限之前检查索引及链接候选；若被排除笔记误入索引，则检查其关键词边端点。`complete:false` 表示有不可读条目或初始扫描与核验扫描期间检测到变化，不能判 PASS。`archiveExcluded:true` 需要扫描完整、`archive` 排除策略生效且归档节点/边端点均为零。这是服务端检查，不依赖截断后的边列表。
- `wiki_graph_page(kind, id?, depth?, pageSize?, cursor?)` —— 在完整图谱中分页 `kind:'nodes'` 或 `kind:'edges'`，不受 `wiki_graph` 的结果上限约束。默认每页 100 项，并受 `pageSizeLimit` 限制。返回 `{ kind, nodes, edges, total, offset, pageSize, nextCursor, snapshotId, excludedDirs }`；每页携带相同 **kind/id/depth** 与上一页的 `nextCursor`，直到返回 null。两轮扫描必须一致，且不能跳过不可读条目。cursor 含内容/图谱指纹和偏移；图谱变化时返回 `stale graph snapshot`，必须从第一页重启，不能静默漏项。节点排序为 id 或 BFS 距离，边沿用被截断 `wiki_graph` 的 link 优先/权重/id 比较器。每页都会重新建图，开销可能较高；超过 `pageScanNodesLimit`/`pageScanEdgesLimit` 则拒绝而非无限制导出。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是单个 Cordis 函数插件，在 `ctx.tools` 上注册 `wiki_graph`。每次调用通过共享的 `resolveMemoryVaultRoot` 解析仓库根，用 `listNotePaths` 遍历笔记，用 `extractLinks`/`resolveLinkTarget` 提取 `[[link]]` 目标。已索引目标按与 `wiki_read` 相同的 Obsidian 语义解析——先精确仓库相对路径，再路径后缀，最后在已索引笔记中做 basename 匹配，多重命中按确定性规则选择。排除目录（默认 `archive`）在链接解析和关键词建边之前就退出索引：活动笔记的 `[[link]]` 若仅指向已归档笔记，会变为不可解析链接，不会重定向到归档副本。归档笔记仍可直接 `wiki_read`，但不能作为图谱中心。除显式链接外，工具还会从每条笔记提取显著词（frontmatter `tags` ×3、frontmatter `title` ×2、正文词 ×1），并为任意两篇共享一个或多个词的笔记创建 `keyword` 边。广度优先遍历带 visited 集合（循环链接图因此可终止），同时跟随 `link` 边与 `keyword` 边以确定节点集合，再从所有已选节点收集边，因此边界节点的出边不会丢失。节点集合超过 `maxNodes` 时，全仓库图保留码点序最小的若干 id（与 `tool-memory-filesystem` 的并列排序规则一致），子图则保留离中心最近的笔记——先按 BFS 层级、再按 id——因此保留哪些笔记不依赖目录列举顺序，子图也不会丢掉自己的中心节点。由于 `wiki_graph` 每次调用都会从磁盘重新计算，重写一条笔记会移除旧的 `keyword` 边，并为新正文中保留下来的或新出现的词建立新边。边在节点集合确定后按 `maxEdges` 截断：显式 `link` 边优先，其后是 `keyword` 边按 `weight` 降序，并以 id 作确定性并列裁决——保留哪些边同样不依赖目录列举顺序。请求的 `depth` 在遍历前会被钳制到 `maxDepthLimit`——一个配置期上限，必须不小于 `maxDepth`——子图结果会报告实际遍历生效的 `depth`，调用方因此无法触发无界遍历，同时仍能看出结果延伸了多远。以非已索引笔记作为中心 id 会以 `note not found` 失败；无法读取的笔记会被跳过（记入 logger 警告），不会让整次调用失败。输出为 `{ nodes: [{ id, title }], edges: [{ from, to, type, keywords?, weight? }], truncated: boolean, edgesTruncated: boolean, depth?: number }`，其中 `truncated` 对应节点上限、`edgesTruncated` 对应边上限，`depth` 仅在子图结果中出现。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型可见内容

模型看到生成的 `wiki_graph`、`wiki_graph_audit`、`wiki_graph_page` schema，三者均为只读；审计返回精简一致性结果，分页每次最多返回 `pageSizeLimit` 项。

##### `wiki_graph` 的原文描述

```markdown
Return the link and keyword graph of the wiki vault. Explicit `[[link]]` edges have from/to (no type); keyword edges have type `keyword`, keywords and weight. Optional id/depth selects a subgraph. Per-call maxNodes/maxEdges are clamped to configured maxNodesLimit/maxEdgesLimit and reported as effectiveMaxNodes/effectiveMaxEdges. Returns nodesTotal/nodesReturned and edgesTotal/edgesReturned/edgesDropped; edgesTotal counts edges between returned nodes before the edge cap, not edges lost to a node cap. truncated/edgesTruncated retain their meanings. excludedDirs reports directory names omitted before link resolution; an existing excluded center fails with a distinct error. Only when both truncation flags are false is the returned graph exhaustive.
```

#### Token 影响

`wiki_graph` 默认上限为 200 节点/1000 边。完整隔离核验应调用 `wiki_graph_audit`，而非放大输出预算。`wiki_graph_page` 默认每页最多返回 250 项，但每页重建完整图谱仍可能耗费 CPU 和内存；大图可能触发分页扫描上限，精简审计不受此影响。

#### KV Cache 影响

独立。插件只提供工具结果，不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **无可视化** —— 工具返回 JSON 节点与边；渲染（Obsidian 图谱、Mermaid）由消费方负责。
- **边限于已选节点** —— 只有两端都在 `maxNodes` 截断后保留下来的节点之间的链接才会出现，子图边界外的出边被省略；密集仓库随后可能触及 `maxEdges` 上限，`edgesTruncated` 会表明返回的边只是确定性切片。
- **在线 Vault 快照是乐观校验** —— 两次内容扫描能发现审计/分页期间的变化，下一页会拒绝已变化的指纹；未协调的外部写入不受锁保护，核验之后瞬间仍可改变 Vault。要对任意外部写入提供严格时点快照，需文件系统快照或统一锁。超大图可能触发分页扫描上限，需离线导出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
