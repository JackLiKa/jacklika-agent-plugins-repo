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

## 写协调链（tool-calling 路径）

```
wiki_write("notes/x.md")
  → memory-scope   把 id 重写为 agents/<key>/notes/x.md（结构性防冲突；
                   shared/ 直通，role: curator 旁路）
  → memory-queue   FIFO lane + 可选跨进程 mkdir 锁 + 心跳判活
  → memory-git     把笔记提交进 vault 自己的 git 仓库（prefixes: ['shared/']）
  → wiki_write     baseVersion 乐观并发校验 + 临时文件原子 rename
```

每层都是独立的 opt-in `tools/execute` waterfall 装饰器；`wiki_write` 本体零修改。挂载顺序即加载顺序。

## MCP 路径

`dsh-memory-mcp` 是零依赖 Node stdio server，实现同一组工具加 `note:///` resources。单个 server 进程串行化自己的写——即单写者部署形态。注意事项（详见 [security.md](security.zh.md)）：

- 串行化按进程生效；多个独立 MCP 进程和直接文件写不在覆盖范围——`baseVersion` 与原子 rename 仍是兜底。
- MCP 来源的写不产生 git commit；`memory-git` 只在 dsh tool-calling 路径上运行。
