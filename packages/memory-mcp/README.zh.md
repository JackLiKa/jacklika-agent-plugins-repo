# @jacklika/dsh-memory-mcp

零依赖的 MCP stdio 服务器，把 memory vault 暴露给任意 MCP 客户端（Claude Code、Cursor、Obsidian 桥、`dsh-mcp-client`）。单一进程持有所有写操作，因此客户端通过服务器串行化，而不是自己协商文件系统锁——这是 memory 套件的“单写者”部署形态。

## 运行

```sh
# 从 workspace 根目录
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# 或安装后
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` 默认为 `<cwd>/.dsh/memory/`；`--max-link-depth N` 控制 `wiki_read` 的链接展开深度（默认 1）。

## 暴露面

工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph` —— 与 `@jacklika/dsh-tool-memory-filesystem` / `-graph` 的契约相同，写操作带 `baseVersion` 乐观并发控制。资源：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

## 客户端配置

任何会说 stdio JSON-RPC 的 MCP 客户端都能挂载：

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mydsh-plugin/packages/memory-mcp/src/server.mjs", "--vault", "/path/to/vault"]
    }
  }
}
```

## 协调约定

- 单个服务器进程串行化**自身**的写入；这是主要的健壮性保证。
- 独立的服务器进程或直接文件系统写入者不会被串行化——`baseVersion` 冲突错误与原子重命名仍能保护正确性，而 dsh 侧的 `memory-git` 插件会在 dsh 工具调用路径上覆盖审计/历史。
- 通过 MCP 的写入**不会**产生 git 提交；如果需要记录 MCP 来源写入的历史，请在 dsh 侧挂载 `dsh-memory-git` 或在外部提交 vault。
- 完全本地：仅 stdio，无网络监听，无遥测。
