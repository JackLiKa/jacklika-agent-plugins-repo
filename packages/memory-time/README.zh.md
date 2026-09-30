# @jacklika/dsh-memory-time

dsh-memory 套件的共享时间戳格式化工具。

`formatBeijingTime(date)` 返回 Asia/Shanghai（`+08:00`）时区、类 ISO 的字符串。记忆库的笔记 frontmatter（`created`）和 append 小节标题都采用这一约定，保证本地审计日志使用同一套时钟，不会把 UTC `Z` 与本地墙钟日期混用。
