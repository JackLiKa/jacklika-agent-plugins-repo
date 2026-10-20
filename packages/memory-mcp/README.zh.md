# @jacklika/dsh-memory-mcp

MCP stdio 服务器，把 memory vault 暴露给任意 MCP 客户端（Claude Code、Cursor、Obsidian 桥、`dsh-mcp-client`）。每个进程串行处理自身请求，并通过按笔记分区的 vault 锁与 dsh memory queue 协调写入；直接编辑文件的程序不参与该协议。

## 运行

```sh
# 从 workspace 根目录
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# 或安装后
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` 默认为 `<cwd>/.plugins/memory/`，与 dsh-memory Bundle 默认保持一致；`--max-link-depth N` 控制 `wiki_read` 的链接展开深度（默认 1）；`--notes-dir DIR` 是 `memory_capture` 写入的共享策展区（默认 `shared/notes`，与 memory-curator 默认一致）。

## 暴露面

工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph` —— 与 `@jacklika/dsh-tool-memory-filesystem` / `-graph` 的契约相同，写操作带 `baseVersion` 乐观并发控制，读操作返回 `mtime` + `modifiedExternally`，写入归一化 `created`/`updated` 为 `+08:00`，读/搜返回 `expired` 标志，搜索返回 `fused`/`semantic` 信号。`memory_capture` 与 dsh 策展工具对齐：省略 `id` 时由标题推导笔记 id，覆盖既有笔记时合并 frontmatter，返回 `{written, id, mode, conflict, version, created?, updated?}`。`memory_capture` 与 `memory_correct` 接受可选的 `source_session`、`commit`、`verified` 来源字段。有两处有意差异：MCP 写入不跑 memory-git，因此永不返回 `committed`；MCP 没有 agent 命名空间，因此不提供 `scope`。MCP 无审批通道，冲突捕获按 dsh 工具的无头行为 fail closed——`written: false`、`conflict: true`，reason 指向 `conflictPolicy: 'skip'`——环境变量 `DSH_MEMORY_CONFLICT_POLICY=skip` 为无头运行提供同样的放宽，逐次调用的 `conflictPolicy` 仍优先——这也使“批准后追加”分支不可达：不带 `requireExisting` 而真正落盘的捕获总是整篇覆盖写。`requireExisting: true` 则表示严格更新标题推导或显式给出的目标 `id`（不会重定向到同标题的其他笔记）：默认以完整当前结论覆盖已存在笔记的正文，无需审批，笔记缺失时失败而非创建。只有新增材料才显式传 `mode: 'append'`，以保留旧正文；`wiki_write` 同样支持 `requireExisting`，但保留自身默认追加模式。笔记 id 拒绝反斜杠，失败信息只含仓库相对 id，不嵌入宿主路径。资源：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

`memory_correct(id, baseVersion, summary, details?, tags?)` 在 `wiki_read` 后覆盖精确的既有笔记，保留未指定的元数据，拒绝过期版本，绝不新建或追加。`memory_capture` 会独立于宽泛关键词搜索的截断，检查精确目标以及全 Vault 精确标题命中；未指定明确 id 且多个笔记同标题时仍视为歧义。MCP 纠错结果不含 `committed` 字段。

`memory_forget(id, baseVersion)` 将笔记移入 `archive/<原相对路径>`，使其不再出现在搜索/图谱结果中。MCP 侧的移动是文件系统重命名，不产生 git 提交，因为 MCP 服务器不运行 `memory-git`；如需历史，请在外部提交 vault。

## 客户端配置

任何会说 stdio JSON-RPC 的 MCP 客户端都能挂载：

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/jacklika-agent-plugins-repo/packages/memory-mcp/src/server.mjs", "--vault", "/path/to/vault"]
    }
  }
}
```

## 协调约定

- 每个服务器进程串行处理**自身**请求；写入还会取得与 dsh memory queue 相同的按笔记分区锁，因此遵守协议的 MCP/dsh 进程不会交错写入同一 id。持锁超时会拒绝写入；MCP 不会自行回收废弃锁。
- 直接编辑文件的程序不使用该锁。`baseVersion` 只能发现受保护写入前可见的修改，不能对不遵守协议的编辑器提供事务保证；原子重命名可防止文件内容写入一半。dsh 侧 `memory-git` 仅审计 dsh 工具调用路径。
- 通过 MCP 的写入**不会**产生 git 提交；如果需要记录 MCP 来源写入的历史，请在 dsh 侧挂载 `dsh-memory-git` 或在外部提交 vault。
- 完全本地：仅 stdio，无网络监听，无遥测。
