---
description: "通过 tools/execute waterfall 把成功的记忆工具写入提交为 git commit——为仓库提供可选的版本历史、回滚与审计。"
kind: "package-reference"
---

# @jacklika/dsh-memory-git

[English](README.md) | 中文

## 概述

`dsh-memory-git` 通过 `tools/execute` waterfall 把指定工具写入（默认 `wiki_write`）变成 git commit。每次成功写入都会在仓库内 stage 并提交，使记忆库获得版本历史、回滚与逐次写入审计能力，且**不需要修改** `dsh-tool-memory-filesystem`。提交限定在配置的 id 前缀内（默认 `shared/`），因此公共知识有版本而各 agent 命名空间不入版本。本插件不注册任何工具，并要求 `PATH` 上存在 `git` 可执行文件。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

挂载在 `dsh-memory-queue` 之后，使提交落在仓库锁内：

```yaml
- name: '@jacklika/dsh-memory-queue'
  config:
    crossProcessLock: true
- name: '@jacklika/dsh-memory-git'
- name: '@jacklika/dsh-tool-memory-filesystem'
```

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | 成功派发后需要提交的工具名列表。 |
| `idArgument` | `string` | `'id'` | 携带仓库相对笔记 id 的参数名。 |
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | git 工作树；与记忆工具相同的按调用解析规则。 |
| `prefixes` | `string[]` | `['shared/']` | 仅此前缀下的 id 会被提交；`[]` 表示提交所有写入。 |
| `nestedRepo` | `'init' \| 'inherit' \| 'own'` | `'init'` | `init`：vault 拥有自己的 `.git`，不并入外层仓库；`inherit`：并入最近的外层仓库（找不到时才 init）；`own`：要求 `<vault>/.git` 已存在，否则报错。 |
| `autoInit` | `boolean` | `true` | 在所选 `nestedRepo` 模式允许时执行 `git init`。 |
| `authorName` / `authorEmail` | `string` | `dsh-memory-git` / `dsh-memory-git@localhost` | 经 `git -c` 传入的提交身份。 |
| `commitPrefix` | `string` | `'wiki_write'` | 提交信息前缀，后接笔记 id。 |
| `indexLockRetries` / `indexLockRetryMs` | `number` | `30` / `100` | `.git/index.lock` 被其他 git 进程占用时的重试次数与间隔。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件安装一个 `ctx.on('tools/execute', …)` waterfall 监听器：先执行 `next()`，仅在成功时提交。仓库选择遵循 `nestedRepo`：`init`（默认）直接检查 `<vault>/.git` 并在 `autoInit` 下创建，使 git 管理工作区内的 vault 不会把提交泄漏进外层项目；`inherit` 用 `rev-parse --git-dir` 向上解析并入最近外层仓库；`own` 在 `<vault>/.git` 缺失时报错。提交序列为 `status --porcelain -- <id>`（干净则跳过，避免空提交）→ `add -- <id>` → `commit -m "<commitPrefix>: <id>" -- <id>`，pathspec 把记录限定在被写笔记内。所有 git 调用经一条进程内链串行，且只对被占用的 `index.lock` 重试。提交失败会让该次派发返回错误，尽管笔记已写入——分叉被显式暴露而非隐藏。

-----

<a id="model-experience"></a>
## 模型体验

无 —— 插件不注册任何工具、prompt 或结果，只对其他包的派发附加持久副作用。

#### KV Cache 影响

该包装层不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只提交经瀑布链的写入方** —— 瀑布链之外的写入（shell 命令、未挂载进程、Obsidian 手动编辑）会在工作树留下未提交改动；周期性 `git status` 清扫或 CI 钩子留待后续。
- **合并冲突以错误暴露** —— 同步同一 vault 的两个仓库仍需 git 层 merge 处理；插件刻意不执行 fetch/pull/merge。
- **要求 `PATH` 上有 `git`** —— 无 git 可执行文件的环境会在首个匹配写入处显式失败。
- **逐次提交可能产生噪音** —— 高频 append 流每次调用产生一个 commit；squash 或 checkpoint 策略留待后续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
