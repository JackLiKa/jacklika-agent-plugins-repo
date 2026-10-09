# @jacklika/dsh-memory-curator

DSH 记忆库的策展工具。本包是 `@jacklika/dsh-memory` Bundle 的成员，不要单独安装。

## 工具

- `memory_recall(query)` — 在任务开始前搜索知识库中的相关笔记。
- `memory_capture(title, summary, ...)` — 在有意义的任务结束后持久化知识，支持冲突检测与可选的用户审批。

## 笔记 id

省略 `id` 时，`memory_capture` 由标题推导笔记 id：保留 Unicode 字母与数字（先做 NFC 归一化并转小写），其余连续字符统一折叠为单个 `-`，因此中日韩等非拉丁标题依然可读且互不相同。完全不含字母与数字的标题退化为 `note-<标题 sha256 的前 12 位十六进制>`，纯符号标题的写入不会坍缩到同一个文件。

配置与工作流请参阅 Bundle 文档 `docs/usage.zh.md`。
