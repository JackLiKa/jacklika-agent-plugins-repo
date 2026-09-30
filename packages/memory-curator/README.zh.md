# @jacklika/dsh-memory-curator

DSH 记忆库的策展工具。本包是 `@jacklika/dsh-memory` Bundle 的成员，不要单独安装。

## 工具

- `memory_recall(query)` — 在任务开始前搜索知识库中的相关笔记。
- `memory_capture(title, summary, ...)` — 在有意义的任务结束后持久化知识，支持冲突检测与可选的用户审批。

配置与工作流请参阅 Bundle 文档 `docs/usage.zh.md`。
