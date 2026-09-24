# MCP server

`@jacklika/dsh-memory-mcp` 通过标准 MCP stdio 传输把 vault 暴露给任何 MCP 客户端（Claude Code、Cursor、Obsidian 桥接，或 dsh 自带的 `dsh-mcp-client`），无需 dsh 插件栈即可读写笔记。

## 运行

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N]
```

`--vault` 默认 `<cwd>/.dsh/memory/`。server 零依赖、无构建步骤。

## 客户端配置

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

## 暴露面

- 工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph`——与 dsh 工具语义一致，含 `baseVersion` 冲突报错。
- Resources：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

## 能保证什么、不能保证什么

- 经过**单个** server 进程的写被串行化；每 vault 只挂一个共享 server 即获得单写者语义。
- 它不是全局锁：其他进程和直接文件写会绕过它；`baseVersion` 校验与原子 rename 保证这些写仍然正确。
- 不运行 `memory-git`；需要历史时在外部提交 vault，或走 dsh 路径。
