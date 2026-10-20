# @jacklika/dsh-memory-curator

DSH 记忆库的策展工具。本包是 `@jacklika/dsh-memory` Bundle 的成员，不要单独安装。

## 工具

- `memory_recall(query)` — 在任务开始前搜索知识库中的相关笔记。返回 `{ query, hits, total, truncated }`，其中 `total` 是从 `wiki_search` 透传的全库命中数；任一层截断（搜索层上限或 recall 自身的 20 条展示上限）都会使 `total` 大于 `hits.length` 且 `truncated` 为 `true`——调用方因此能区分“这就是全部命中”与“还有更多”。`memory-anchor` 写入的逐回合自动入库笔记会从命中列表中隐藏，并从 `total` 中扣除，记账内容不会挤占策展知识；匹配锚定在策展区命名空间上，仅名字前缀相同的策展笔记仍会返回。
- `memory_capture(title, summary, ...)` — 在有意义的任务结束后持久化知识，支持冲突检测与可选的用户审批。直接检查目标笔记是否存在；冲突搜索使用全 Vault 精确标题匹配，不受宽泛关键词搜索截断影响。未给出明确 id 且多个笔记同标题时拒绝猜选。审批期间笔记发生变化则拒绝写入。设置 `requireExisting: true` 表示只更新、不新建，严格使用标题推导或显式给出的目标 `id`（不会重定向到同标题的其他笔记）：默认覆盖现有笔记的正文（`summary` 应包含完整的当前结论），保留 `created` 等既有 frontmatter 字段；笔记缺失时直接失败而不会创建。只有新增材料才显式传 `mode: 'append'`，此时旧正文仍可见。不设置 `requireExisting` 时，经批准的冲突写入仍默认追加。由于“更新这篇笔记”本身就是声明的意图，此类调用不会请求冲突审批。返回 `{ written, id, mode, conflict, version, created?, updated?, committed? }`：`version` 是持久化笔记文本的 SHA-1 指纹；首次入库返回 `created`；更新写入返回 `updated`；挂载 `memory-git` 完成提交时还会返回 `committed`。`conflict` 表示检测到的命中需要策略裁决，因此成功执行的只更新捕获会返回 `false`。当捕获因冲突被拒绝时，响应还会携带 `suggested: { tool: 'memory_correct', id, baseVersion? }`，指明发生冲突的笔记（已读取时附版本），让调用方改为修正既有笔记而不是重试追加。返回的 `id` 为实际落盘 id，私有作用域改写时包含 agent 命名空间。当 `summary` 自身以 Markdown 标题开头时，该标题按原样使用，不再前置 `# <title>`，调用方自带 H1 不会产生重复标题。无审批服务的 headless 场景下，环境变量 `DSH_MEMORY_CONFLICT_POLICY=skip` 可把默认 `ask` 策略放宽为 `skip`——它永远不能将已配置的 `skip` 收紧回 `ask`，且逐次调用的 `conflictPolicy` 参数仍优先；其他取值会导致插件加载失败。

- `memory_correct(id, baseVersion, summary, details?, tags?)` — 先 `wiki_read` 目标笔记，再传入其精确 `id`、返回的 `version` 与完整替换正文。它不追加、不按标题猜选目标、不创建缺失笔记；版本过期时拒绝写入。省略 tags 时保留原值，其他 frontmatter 字段也保留。以 Markdown 标题开头的 `summary` 按原样使用，不前置 `# <title>`。返回字段与 `memory_capture` 写入结果一致，`mode: 'overwrite'`、`conflict: false`；DSH 写入仍经过既有 queue 与 git 审计路径。

- `memory_forget(id, baseVersion)` — 将策展笔记移入归档区（`archive/<原相对路径>`）。笔记未被物理删除，仍可显式 `wiki_read` 读取，但 `wiki_search` 与 `wiki_graph` 默认不再返回它。必须传入 `wiki_read` 得到的当前 `version`；过期版本会失败关闭。若配置了 `memory-git`，此次移动会被提交。

- `memory_compact(scope?, maxAgeDays?, dryRun?)` — 归档笔记。默认 `scope: 'auto-capture'` 归档旧的逐回合自动捕获笔记，只保留最近 N 个会话（默认关闭；在 curator 配置中通过 `autoCaptureCompact: { enabled: true, keepSessions: N }` 开启）。`scope: 'stale'` 归档同时满足「mtime 早于 `maxAgeDays`（必填，≥ 1）」且「无入链 `[[links]]`」的笔记——链接关系取自 `wiki_graph` 的 link 边，因此 stale pass 需要安装 graph 工具；除参数外无需额外 curator 配置。该 pass 是幂等的：重复执行不会产生重复归档文件。它与其他变更工具使用同一跨进程锁车道。传 `dryRun: true` 可预览选中项——返回 `{ compacted: true, dryRun: true, kept, archived: 0, archivedIds: [], wouldArchive }`，不归档任何内容。

## 笔记 id

省略 `id` 时，`memory_capture` 由标题推导笔记 id：保留 Unicode 字母与数字（先做 NFC 归一化并转小写），其余连续字符统一折叠为单个 `-`，因此中日韩等非拉丁标题依然可读且互不相同。完全不含字母与数字的标题退化为 `note-<标题 sha256 的前 12 位十六进制>`，纯符号标题的写入不会坍缩到同一个文件。

## 覆盖式入库

`mode: 'overwrite'` 替换笔记正文，但会合并既有 frontmatter：其他写入方记录的字段与原始 `created` 都保留，`title` 与 `tags` 以本次调用为准，并写入 `updated`。如果从读取旧笔记到写入之间检测到其他修改，则拒绝覆盖该修改。首次入库只写 `created`。

## 来源字段

`memory_capture` 与 `memory_correct` 接受可选的 `source_session`、`commit`、`verified` 参数。传入后会被写入笔记 frontmatter，作为后续检索加权与审计的一等公民字段。当前版本暂不改变搜索排序。

配置与工作流请参阅 Bundle 文档 `docs/usage.zh.md`。
