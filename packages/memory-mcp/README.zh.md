# @jacklika/dsh-memory-mcp

MCP stdio 服务器，把 memory vault 暴露给任意 MCP 客户端（Claude Code、Cursor、Obsidian 桥、`dsh-mcp-client`）。单一进程持有所有写操作，因此客户端通过服务器串行化，而不是自己协商文件系统锁——这是 memory 套件的“单写者”部署形态。

## 运行

```sh
# 从 workspace 根目录
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# 或安装后
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` 默认为 `<cwd>/.plugins/memory/`，与 dsh-memory Bundle 默认保持一致；`--max-link-depth N` 控制 `wiki_read` 的链接展开深度（默认 1）；`--notes-dir DIR` 是 `memory_capture` 写入的共享策展区（默认 `shared/notes`，与 memory-curator 默认一致）。

## 暴露面

工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph` —— 与 `@jacklika/dsh-tool-memory-filesystem` / `-graph` 的契约相同，写操作带 `baseVersion` 乐观并发控制，读操作返回 `mtime` + `modifiedExternally`，写入归一化 `created`/`updated` 为 `+08:00`。`memory_capture` 与 dsh 策展工具对齐：省略 `id` 时由标题推导笔记 id，覆盖既有笔记时合并 frontmatter，返回 `{written, id, mode, conflict, version, created?, updated?}`。有两处有意差异：MCP 写入不跑 memory-git，因此永不返回 `committed`；MCP 没有 agent 命名空间，因此不提供 `scope`。MCP 无审批通道，冲突捕获按 dsh 工具的无头行为 fail closed——`written: false`、`conflict: true`，reason 指向 `conflictPolicy: 'skip'`——这也使“批准后追加”分支不可达：不带 `requireExisting` 而真正落盘的捕获总是整篇覆盖写。`requireExisting: true` 则表示严格更新标题推导或显式给出的目标 `id`（不会重定向到同标题的其他笔记）：默认以完整当前结论覆盖已存在笔记的正文，无需审批，笔记缺失时失败而非创建。只有新增材料才显式传 `mode: 'append'`，以保留旧正文；`wiki_write` 同样支持 `requireExisting`，但保留自身默认追加模式。笔记 id 拒绝反斜杠，失败信息只含仓库相对 id，不嵌入宿主路径。资源：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

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

- 单个服务器进程串行化**自身**的写入；这是主要的健壮性保证。
- 独立的服务器进程或直接文件系统写入者不会被串行化——`baseVersion` 冲突错误与原子重命名仍能保护正确性，而 dsh 侧的 `memory-git` 插件会在 dsh 工具调用路径上覆盖审计/历史。
- 通过 MCP 的写入**不会**产生 git 提交；如果需要记录 MCP 来源写入的历史，请在 dsh 侧挂载 `dsh-memory-git` 或在外部提交 vault。
- 完全本地：仅 stdio，无网络监听，无遥测。
