# MCP server

`@jacklika/dsh-memory-mcp` 通过标准 MCP stdio 传输把 vault 暴露给任何 MCP 客户端（Claude Code、Cursor、Obsidian 桥接，或 dsh 自带的 `dsh-mcp-client`），无需 dsh 插件栈即可读写笔记。

## 运行

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N] [--notes-dir DIR]
```

`--vault` 默认 `<cwd>/.plugins/memory/`，与 dsh-memory Bundle 默认保持一致；`--notes-dir`（`memory_capture` 的共享策展区）默认 `shared/notes`，与 memory-curator 默认一致。server 无构建步骤。

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

- 工具：`wiki_read`、`wiki_search`、`wiki_write`、`wiki_graph`——与 dsh 工具同名，含 `baseVersion` 冲突报错，但有一处有意差异：MCP 版 `wiki_search` 是朴素的 AND 关键词匹配、按笔记 id 排序，返回的是 `{id, title}` 裸数组（无相关性 `score`、无 `backlinks`、无分层排序，也没有 `{ hits, total, truncated }` 信封结构，因此拿不到全库命中数——dsh 工具返回该信封）。MCP 版 `wiki_write` 返回 `{id, mode, bytes, version, created?, updated?}`：`version` 与 `wiki_read` 返回的 SHA-1 指纹一致，调用方可直接拿来做 `baseVersion` 续写，不必再读一次；`created`/`updated` 在笔记 frontmatter 包含它们时返回。`wiki_search` 与 `wiki_graph` 的 `title` 字段与 dsh 工具采用相同的回退规则：优先 `frontmatter.title`，其次是正文第一个 Markdown `# 标题`，最后是去掉扩展名的 id。分层 BM25/短语/图/语义排序只在 `@jacklika/dsh-tool-memory-filesystem` 中实现；MCP server 保持零依赖。`wiki_read` 与 dsh 工具一样返回 `mtime` + `modifiedExternally` 字段，`wiki_write` 同样把 `created`/`updated` frontmatter 时间戳归一化为 `+08:00`。`wiki_read`/`wiki_graph` 解析 `[[link]]` 目标与 dsh 工具使用相同的 Obsidian 语义：先精确仓库相对路径，再路径后缀，最后 basename 匹配，多重命中时优先路径段最少者、仍并列取码点序最小的 id。`memory_capture` 与 dsh 策展工具返回字段一致——`{written, id, mode, conflict, version, created?, updated?}`——但不含需要 memory-git 的 `committed`，也不含需要 agent 命名空间的 `scope`；由于没有审批通道，冲突时与 dsh 工具的无头行为一致地 fail closed（`written: false`、`conflict: true`，reason 指向 `conflictPolicy: 'skip'`），因此不带 `requireExisting` 而真正落盘的捕获总是整篇覆盖写；`requireExisting: true` 则表示声明的更新——默认以完整当前结论覆盖必须已存在笔记的正文（只有新增材料才显式传 `mode: 'append'` 以保留旧正文），笔记缺失时失败而非创建，且无需审批，`wiki_write` 也接受同一参数。笔记 id 拒绝反斜杠，失败信息只含仓库相对 id，不嵌入宿主路径。
- `memory_correct(id, baseVersion, summary, details?, tags?)` 与 dsh 纠错工具对齐：先读取精确 id，再仅在版本仍匹配时以完整当前正文覆盖。MCP 不返回 `committed`。`memory_capture` 会独立于宽泛搜索的截断，确认精确目标与全 Vault 的精确同标题命中；未指定明确 id 且多个笔记同标题时仍视为歧义。
- Resources：通过 `resources/list` / `resources/read` 访问 `note:///<id>`。

## 能保证什么、不能保证什么

- 每个 MCP 进程串行处理自身请求；遵守协议的 MCP/dsh 写入还会使用同一个按笔记分区的 vault 锁。持锁超时不会修改笔记，MCP 不会自行回收废弃锁目录。
- 直接编辑文件的程序绕过锁。`baseVersion` 会拒绝受保护写入前可见的修改，但不能让未参与协调的外部编辑成为事务；原子 rename 防止内容写入一半。
- 不运行 `memory-git`；需要历史时在外部提交 vault，或走 dsh 路径。
