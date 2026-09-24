---
description: "基于本地 Markdown 仓库的面向模型的 wiki/记忆工具，支持 Obsidian 风格双向链接和 YAML frontmatter。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-filesystem

[English](README.md) | 中文

## 概述

`dsh-tool-memory-filesystem` 让 agent 可以读取、搜索和追加本地 Markdown 仓库中的笔记。笔记是普通的 `.md` 文件，可包含 YAML frontmatter 和 Obsidian 风格 `[[link]]` 链接。部署时以 Cordis 插件形式挂载即可；默认情况下每个会话使用自己工作区下的 `<session cwd>/.dsh/memory/` 作为仓库，因此每个项目拥有独立的记忆库。需要共享仓库时可显式配置 `vaultRoot`。模型会看到 `wiki_read`、`wiki_search` 和 `wiki_write` 三个工具。MVP 不需要向量数据库，只使用文件名和关键词搜索，并通过链接跟随保证上下文完整。

## 目录

- [使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

在 profile 或 patch 文件中挂载插件：

```yaml
- name: '@jacklika/dsh-tool-memory-filesystem'
```

此后每个会话使用 `<session cwd>/.dsh/memory/` 作为自己的仓库。需要跨会话共享一个仓库时，显式指定根目录：

```yaml
- name: '@jacklika/dsh-tool-memory-filesystem'
  config:
    vaultRoot: /path/to/obsidian-vault
```

相对路径的 `vaultRoot` 会相对于调用会话的工作区解析。

### 配置仓库

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | 仓库根目录。留空表示使用按工作区隔离的记忆目录；相对路径相对于会话工作区解析。 |
| `extensions` | `string[]` | `['.md']` | 视为笔记的文件扩展名。 |
| `maxLinkDepth` | `number` | `1` | `wiki_read` 解析 `[[link]]` 的最大深度。 |
| `maxSearchResults` | `number` | `20` | `wiki_search` 返回的最大结果数。 |
| `indexHiddenDirs` | `boolean` | `false` | 是否索引以 `.` 开头的目录（`.git` 与 `node_modules` 始终排除）。当 `vaultRoot` 指向工作区根时开启，以纳入 `.dsh/memory/` 中的笔记。 |

### 工具

- `wiki_read(id)` — 按仓库相对路径读取笔记，返回 frontmatter、正文、链接、已解析的链接笔记，以及内容指纹 `version`。
- `wiki_search(query)` — 按标题、id、正文关键词搜索；结果包含反向链接数量。
- `wiki_write(id, content, mode?, baseVersion?)` — 创建或追加笔记。追加模式保留 frontmatter 并添加时间戳标题。把 `wiki_read` 返回的 `version` 作为 `baseVersion` 传入时，若笔记在读取后被其他写入方改动，写入会显式失败。

### 安全

所有路径都必须在该次调用解析出的仓库根目录下；越界路径会被拒绝。该插件不通过 `ctx.fs` 访问文件，因此不继承文件沙箱策略；访问权限由 OS 文件权限和本插件的越界检查共同控制。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是一个没有运行时服务的 Cordis 函数插件，只在 `ctx.tools` 上注册三个类型化工具。仓库根目录在每次工具调用时解析：优先使用显式 `vaultRoot`（相对路径锚定会话工作区），否则使用 `<session cwd>/.dsh/memory/`，使每个工作区拥有自己的笔记。每个工具都通过 `node:fs/promises` 直接读取 Markdown 文件，并借助 `path.resolve` + 前缀检查保持在解析出的根目录内。YAML frontmatter 使用 `js-yaml` 解析；`[[link|alias]]` 形式的引用会提取管道符前的目标。搜索时从仓库内容构建临时索引，并按反向链接数量排序。`wiki_write` 以原子方式发布：正文先写入同级临时文件，再 `rename` 覆盖目标，因此并发读者永远不会读到写了一半的笔记。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### 模型看到的内容

模型看到的是生成的 [`wiki_read`、`wiki_search` 和 `wiki_write` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory-filesystem)。工具描述会告知模型：笔记是带 YAML frontmatter 和 Obsidian 风格 `[[link]]` 链接的 Markdown 文件，`wiki_read` 会按配置深度跟随链接。

##### `wiki_read` 的完整描述

```markdown
Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, and linked notes.
```

##### `wiki_search` 的完整描述

```markdown
Search the wiki vault by note title or body keyword. Returns matching note ids, titles, and backlink counts. Use this before asking the user which note to read.
```

##### `wiki_write` 的完整描述

```markdown
Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header.
```

#### Token 影响

`wiki_read` 返回请求笔记的完整正文，以及 `maxLinkDepth` 范围内所有可达链接笔记的正文。长笔记或密集链接图可能显著增加下次请求的 token 数。`wiki_search` 只返回有限的结果元数据。

#### KV Cache 影响

独立。该插件仅提供工具结果，不改变请求头、系统提示或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **未接入沙箱策略** — 插件直接读取文件，绕过 `ctx.fs` 沙箱与审批机制。未来可以提供委托给 `ctx.fs` 的 provider 以继承策略。
- **无向量搜索** — 仅支持关键词搜索。未来可新增 `tool-memory-vector` 包提供基于 embedding 的检索，而无需修改本包。
- **不支持图片或二进制附件** — 笔记按 UTF-8 文本处理。附件应继续使用 attachment 体系。
- **无内置写协调** —— 写入是原子的（临时文件 + `rename`），读者不会看到半写文件，但对同一笔记的并发 `wiki_write` 仍可能丢更新。协作调用方可传 `baseVersion` 把丢更新变成显式冲突；挂载 `@jacklika/dsh-memory-queue` 可获得进程内串行化，并可选用心跳刷新的跨进程锁。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
