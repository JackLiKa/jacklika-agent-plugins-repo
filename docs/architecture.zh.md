# 架构

记忆套件是分层设计：每层解决不同的失效模式，所有层汇聚到同一个本地 Markdown vault。

```
Skill          skills/memory-vault          — 教模型何时/如何使用记忆
  ↓
Tool calling   @jacklika/dsh-tool-memory-*  — dsh 原生工具
               @jacklika/dsh-memory-*       — 写协调（scope/queue/git）
  ↓
MCP            @jacklika/dsh-memory-mcp     — 面向非 dsh 客户端的 stdio server
  ↓
Vault          <workspace>/.plugins/memory/     — Obsidian 兼容的 Markdown 笔记
```

## Vault

- 默认位置：`<session cwd>/.plugins/memory/`——按工作区隔离，与代码同处。
- 笔记是普通 Markdown，可选 `---` YAML frontmatter 和 `[[wiki 链接]]`。
- `agents/<key>/` 是各 agent 的命名空间（写入由 `memory-scope` 自动重写）；`shared/` 是公共策展区。

所有存入 Vault、给人看的时间戳都使用 **Asia/Shanghai（`+08:00`）** 时间，包括笔记 frontmatter 的 `created` 和 append 追加小节的标题。这保证了本地审计日志的可读性，也避免 UTC `Z` 与本地时间混用。

## 图谱可观测性与归档

`wiki_graph` 在构建节点、解析 `[[link]]` 目标和生成关键词边**之前**排除 `excludeDirs`（默认 `['archive']`）。仅指向已归档目标的链接变为不可解析，不会重定向到 `archive/`。归档 id 仍可由 `wiki_read` 直接读取；以存在但被排除的笔记为图谱中心会得到可区分的排除错误。返回的 `excludedDirs` 表示配置策略，而不是被排除笔记的数量。

`wiki_graph` 除既有的 `truncated`/`edgesTruncated` 外还返回 `nodesTotal`/`nodesReturned` 和 `edgesTotal`/`edgesReturned`/`edgesDropped`。`edgesTotal` 是**已返回节点之间**边上限应用前的边数；被节点上限裁掉的节点所关联的边不计入其中。仅当 `truncated:false` **且** `edgesTruncated:false` 时，返回图谱才可视为穷尽。单次 `maxNodes`/`maxEdges` 覆盖可提高验收预算，但受配置 `maxNodesLimit`/`maxEdgesLimit` 钳制；`effectiveMaxNodes`/`effectiveMaxEdges` 明确返回实际生效上限。提高预算需防止工具响应过大。

全库归档隔离验收应使用 `wiki_graph_audit()`：它在输出截断之前检查索引及边端点，返回 `archiveExcluded`、`complete`、`scanStable`、`skippedEntries` 与内容指纹。`complete:false` 不能作为隔离证据。若要逐页读取完整节点/边列表而不放大单次模型响应，可调用 `wiki_graph_page(kind:'nodes'|'edges', pageSize, cursor?)`。分页顺序确定、每次响应有上限；每页重建并复核 Vault，指纹过期会拒绝而非静默混合版本。这是乐观一致性，不是针对外部写入的原子快照；超大图可能超过服务端工作量上限。

## 写协调链（tool-calling 路径）

```
wiki_write("notes/x.md")
  → memory-scope   把 id 重写为 agents/<key>/notes/x.md（结构性防冲突；
                   shared/ 直通，role: curator 旁路）
  → memory-queue   FIFO lane + 可选跨进程 mkdir 锁 + 心跳判活
  → memory-git     把笔记提交进 vault 自己的 git 仓库（prefixes: ['shared/', 'agents/']）
  → wiki_write     baseVersion 乐观并发校验 + 临时文件原子 rename
```

每层都是独立的 opt-in `tools/execute` waterfall 装饰器；`wiki_write` 本体零修改。挂载顺序即加载顺序。

## MCP 路径

`dsh-memory-mcp` 是零依赖 Node stdio server，实现同一组工具，外加策展工具 `memory_capture` 与 `note:///` resources。单个 server 进程串行化自己的写——即单写者部署形态。注意事项（详见 [security.md](security.zh.md)）：

- 串行化按进程生效；多个独立 MCP 进程和直接文件写不在覆盖范围——`baseVersion` 与原子 rename 仍是兜底。
- MCP 来源的写不产生 git commit；`memory-git` 只在 dsh tool-calling 路径上运行。

