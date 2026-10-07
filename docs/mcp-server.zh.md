# MCP server

`@jacklika/dsh-memory-mcp` 通过标准 MCP stdio 传输把 vault 暴露给任何 MCP 客户端（Claude Code、Cursor、Obsidian 桥接，或 dsh 自带的 `dsh-mcp-client`），无需 dsh 插件栈即可读写笔记。

## 运行

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N]
```

`--vault` 默认 `<cwd>/.plugins/memory/`，与 dsh-memory Bundle 默认保持一致。server 无构建步骤。

## 客户端配置

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

## 暴露面

- 工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph`——与 dsh 工具同名，含 `baseVersion` 冲突报错，但有一处有意差异：MCP 版 `wiki_search` 是朴素的 AND 关键词匹配、按笔记 id 排序、只返回 `{id, title}`（无相关性 `score`、无 `backlinks`、无分层排序）。分层 BM25/短语/图/语义排序只在 `@jacklika/dsh-tool-memory-filesystem` 中实现；MCP server 保持零依赖。`wiki_read` 与 dsh 工具一样返回 `mtime` + `modifiedExternally` 字段，`wiki_write` 同样把 `created`/`updated` frontmatter 时间戳归一化为 `+08:00`。`wiki_read`/`wiki_graph` 解析 `[[link]]` 目标与 dsh 工具使用相同的 Obsidian 语义：先精确仓库相对路径，再路径后缀，最后 basename 匹配，多重命中时优先路径段最少者、仍并列取码点序最小的 id。
- Resources：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

## 能保证什么、不能保证什么

- 经过**单个** server 进程的写被串行化；每 vault 只挂一个共享 server 即获得单写者语义。
- 它不是全局锁：其他进程和直接文件写会绕过它；`baseVersion` 校验与原子 rename 保证这些写仍然正确。
- 不运行 `memory-git`；需要历史时在外部提交 vault，或走 dsh 路径。
