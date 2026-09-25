# 安全与数据流

## 什么留在本地

- Vault 读写：仅本地文件系统。
- `memory-git`：只做本地 `git add` / `git commit`——**永不 push**；推送永远是手动行为。
- MCP server：仅 stdio，无网络监听，无遥测，无任何隐藏外发调用。

## 什么会离开本机

| 路径 | 暴露 |
|---|---|
| LLM 调用 | 进入 prompt 的笔记内容会发给所配置的模型供应商——这是任何 agent 记忆的固有性质。 |
| `wiki_semantic_search` | 笔记内容会发给所配置的 embeddings 端点；配置端点前保持禁用。 |
| Vault 的 `git push` | 仅手动。`nestedRepo: init`（默认）使 vault 拥有独立仓库，工作区 push 不会携带记忆历史。 |

## 信任边界

- 插件与 skill 是受信代码/配置：它们在 dsh 进程内以完整宿主权限运行，只安装你自己掌控的版本。
- `nestedRepo` 默认值（`init`）防止记忆提交静默进入外层项目仓库——这是开发中发现的真实边界，现已默认关闭。
- 路径包含校验拒绝 `..`、绝对路径、跨根路径及已有 symlink/junction 逃逸。读会校验真实目标；写会在建目录前后校验最近的已有祖先，再通过同目录临时文件原子 rename 发布。

## 并发保障对照

| 写入方集合 | 保障 |
|---|---|
| 单个 MCP server 进程 | 完全串行 |
| 挂了 `memory-queue` 的 dsh 工具路径 | 进程内 FIFO + 可选跨进程 `mkdir` 锁 |
| 多 MCP server / 直接文件写 | `baseVersion` 冲突报错 + 原子 rename（检测而非阻止） |
