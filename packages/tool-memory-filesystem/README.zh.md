---
description: "基于本地 Markdown 仓库的面向模型的 wiki/记忆工具，支持 Obsidian 风格双向链接和 YAML frontmatter。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-filesystem

[English](README.md) | 中文

## 概述

`dsh-tool-memory-filesystem` 让 agent 可以读取、搜索和追加本地 Markdown 仓库中的笔记。笔记是普通的 `.md` 文件，可包含 YAML frontmatter 和 Obsidian 风格 `[[link]]` 链接。部署时以 Cordis 插件形式挂载即可；默认情况下每个会话使用自己工作区下的 `<session cwd>/.dsh/memory/` 作为仓库，因此每个项目拥有独立的记忆库。需要共享仓库时可显式配置 `vaultRoot`。模型会看到 `memory_runtime_info`、`wiki_read`、`wiki_search` 和 `wiki_write` 工具。MVP 不需要向量数据库，只使用文件名和关键词搜索，并通过链接跟随保证上下文完整。

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
| `extensions` | `string[]` | `['.md']` | 视为笔记的文件扩展名。至少需列出一个扩展名；空列表会导致插件加载失败。 |
| `maxLinkDepth` | `number` | `1` | `wiki_read` 解析 `[[link]]` 的最大深度。 |
| `maxSearchResults` | `number` | `20` | `wiki_search` 返回的最大结果数。 |
| `indexHiddenDirs` | `boolean` | `false` | 是否索引以 `.` 开头的目录（`.git` 与 `node_modules` 始终排除）。当 `vaultRoot` 指向工作区根时开启，以纳入 `.dsh/memory/` 中的笔记。 |
| `excludeDirs` | `string[]` | `['archive']` | 从搜索索引中排除的目录名（任意层级）。`archive` 目录用于存放已遗忘笔记并默认排除；图谱索引需单独配置 graph 插件；显式调用 `wiki_read` 仍可读取归档笔记。 |
| `bundleName` | `string` | `''` | `memory_runtime_info` 回报的可选 Bundle 身份；随附 Bundle 会设置该值。 |
| `bundleVersion` | `string` | `''` | `memory_runtime_info` 回报的可选 Bundle 版本；随附 Bundle 会保持它与 package manifest 一致。 |

### 工具

- `memory_runtime_info(expectedCwd?, expectedVaultRoot?, expectedProfile?)` — 返回只读身份信封，包含已加载 filesystem 组件、配置的 Bundle、Profile 提示、调用会话工作区、解析后的 Vault、Vault/Git 是否存在及稳定指纹。验收流程必须同时给出两个绝对路径期望，并在创建夹具前要求 `preflight.safeToWrite:true`；缺少或不匹配的期望会失败关闭且不写入。Profile 值仅是环境提示，可能不可用，不能证明冻结安装或供应链策略已通过。
- `wiki_read(id)` — 按仓库相对路径读取笔记，返回 frontmatter、正文、链接、已解析的链接笔记、内容指纹 `version`、`+08:00` 格式的文件 `mtime`，以及 `modifiedExternally` 标志（文件自本插件上次观察以来在磁盘上被改动时为 `true`，例如 Obsidian 编辑）。插件按绝对路径维护一个 256 条上限的 LRU mtime 表；自身的 `wiki_write` 与 `wiki_restore` 会刷新记录，因此这两类插件写入不会误报。失败会以结构化错误返回，错误信息只含仓库相对 id（如 `cannot read note "x.md": no such note`），绝不嵌入宿主绝对路径；因此在仓库首次写入之前（仓库根目录尚不存在时）发起的读取，与已存在仓库中读取缺失文件一样返回 `no such note`。
- `wiki_search(query, exactTitle?, maxResults?)` — 按标题、id、正文关键词搜索；查询词采用 OR 匹配，并按字段加权的 BM25 式评分排序（标题/id 命中权重最高，稀有词权重更高），另有整段短语加分与被强命中笔记链接的图增强；挂载 `wiki_semantic_search` 时两路排序经 RRF 融合。返回 `{ hits, total, truncated, fused, semantic }` 分页结构：每条命中含笔记 id、标题、分数、反向链接与 `expired` 标志；`total` 是截断前的全部命中数；`truncated` 为 `true` 表示结果被上限截断；`fused` 表示是否成功融合语义排序；`semantic` 为 `'ok'`、`'unavailable'` 或 `'error'`。传入 `exactTitle` 时仍需 `query`，但会在截断之前对全 Vault 的标题做 NFC、大小写和分隔符折叠后的精确匹配，跳过相关度/语义排序，并继续返回 `total` 与 `truncated`；此模式用于精确标题冲突检查，不用于宽泛召回。`maxResults` 可覆盖本调用时的配置上限。无法读取的条目（扫描途中被删除、权限不足）会被跳过并记入日志，而不是让整次调用失败。
- `wiki_write(id, content, mode?, baseVersion?, requireExisting?)` — 创建或追加笔记。追加模式保留 frontmatter 并添加时间戳标题；两种写入模式都会把 `created`/`updated` frontmatter 值归一化为 `+08:00` 秒级精度（不可解析的值原样保留）。把 `wiki_read` 返回的 `version` 作为 `baseVersion` 传入时，若笔记在读取后被其他写入方改动，写入会显式失败。设置 `requireExisting: true` 表示只更新、不新建：笔记必须已存在，缺失时写入直接失败而不会创建（也不会留下空父目录），调用方若写错了 id 会收到错误而不是多出一篇笔记。返回值为 `{ id, mode, bytes, version }`，其中 `version` 就是刚发布内容的指纹——可直接作为下一次写入的 `baseVersion`，无需再 `wiki_read` 一次即可串联乐观并发校验。通过仓库内 symlink 写入会更新链接指向的笔记并保留链接本身（损坏的链接会被拒绝）；原子替换会把笔记原有的权限位带到新文件。
- `wiki_history(id, limit?)` — 返回单条笔记的 git 提交历史 `{ commits: [{ hash, date, message, author }] }`，最新提交在前。要求 Vault 内存在 git 仓库；返回的 hash 可传给 `wiki_restore`。
- `wiki_restore(id, hash, baseVersion)` — 将笔记前滚到某个历史 git 提交的内容，而不重写历史。必须传入 `wiki_read` 的当前 `version` 作为 `baseVersion`；过期版本会失败关闭。当 `memory-git` 配置为处理 `wiki_restore`（如 Bundle 中的配置）时，恢复会产生新提交；未配置该包装层时只写工作树，返回值不宣称 `committed`。

### 安全

所有路径都必须在该次调用解析出的仓库根目录下；越界路径会被拒绝。笔记 id 只使用 `/` 作为分隔符：id 中出现反斜杠会直接以结构化错误拒绝，而不会被当作随平台变化的分隔符，因此同一个 id 在不同系统上不会指向不同文件；百分号编码也从不解码，`%2e%2e` 只是一个字面名字。`[[link]]` 链接目标则保持宽松：用 Windows 风格分隔符写出的目标与其 `/` 形式解析结果一致。仓库内的 symlink 会先解析到真实目标并重新做包含校验，因此追加写入落在链接目标上而非替换链接；损坏的 symlink 会被拒绝。错误信息保持仓库相对路径，不嵌入宿主绝对路径。该插件不通过 `ctx.fs` 访问文件，因此不继承文件沙箱策略；访问权限由 OS 文件权限和本插件的越界检查共同控制。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是一个没有运行时服务的 Cordis 函数插件，在 `ctx.tools` 上注册一个只读运行态证明工具及类型化 Vault 工具。仓库根目录在每次工具调用时解析：优先使用显式 `vaultRoot`（相对路径锚定会话工作区），否则使用 `<session cwd>/.dsh/memory/`，使每个工作区拥有自己的笔记。每个工具都通过 `node:fs/promises` 直接读取 Markdown 文件，并借助 `path.resolve` 词法前缀检查加 realpath 包含复检保持在解析出的根目录内。YAML frontmatter 使用 `js-yaml` 解析（开头 `---` 前带 UTF-8 BOM 亦可识别；frontmatter 出现重复键时按“后者胜出”处理，而不是丢弃整个块）；`[[link|alias]]` 形式的引用会提取管道符前的目标；出现在行内代码或围栏代码块中的 `[[...]]` 是语法示例而非链接，会被忽略。链接目标按 Obsidian 语义对已索引的笔记 id 解析：先精确匹配仓库相对路径，再做路径后缀匹配（`[[notes/foo]]` 可命中 `shared/notes/foo.md`），最后匹配仓库内任意位置的 basename——每一级都容忍目标带或不带扩展名。多重命中时优先路径段最少者，仍并列则取码点序最小的 id，因此解析结果跨平台确定；链接目标中的 Windows 风格分隔符会与解析器自身的归一化一致地转成 `/`。与之相对，笔记 id 直接拒绝反斜杠，严格与宽松两侧因此不会对“名字指向哪个文件”产生分歧。搜索时从仓库内容构建临时索引（无法读取的条目会被跳过并记入日志，单个坏文件不会使整次扫描失败）并分层排序：OR 匹配的字段加权评分（id/标题 ×3、反向链接 ×1、正文 ×1，含 IDF 使稀有词权重更高、BM25 饱和与长度归一化避免长笔记占优）、整段短语加分，以及被强命中笔记链接的图增强。挂载 `wiki_semantic_search` 时其排序经倒数排名融合并入；语义检索失败时回退到纯词法排序。`wiki_write` 以原子方式发布：正文先写入同级临时文件，再 `rename` 覆盖目标，因此并发读者永远不会读到写了一半的笔记；临时文件继承目标笔记的权限位，且写入或 rename 失败时会被清理。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### 模型看到的内容

模型看到的是生成的 `memory_runtime_info`、`wiki_read`、`wiki_search` 和 `wiki_write` schema。工具描述会告知模型：笔记是带 YAML frontmatter 和 Obsidian 风格 `[[link]]` 链接的 Markdown 文件，`wiki_read` 会按配置深度跟随链接。

##### `wiki_read` 的完整描述

```markdown
Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, linked notes, mtime, and a modifiedExternally flag that is true when the file changed on disk since this tool last observed it.
```

##### `wiki_search` 的完整描述

```markdown
Search the wiki vault by note title or body keyword. Terms are OR-matched; results are ranked by field-weighted relevance (title/id hits outrank body hits, rare terms weigh more, notes linked from strong hits get a boost, and results may be fused with semantic search when available). Returns { hits, total, truncated }: each hit carries the note id, title, score, and backlinks, total counts every match before the result cap, and truncated is true when that cap cut the list. Use this before asking the user which note to read.
```

##### `wiki_write` 的完整描述

```markdown
Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header. Set requireExisting to update a note that must already exist: the write then fails instead of creating a new note. Returns { id, mode, bytes, version }, where version fingerprints the written content and can be passed as baseVersion on the next write without reading the note again.
```

#### Token 影响

`wiki_read` 返回请求笔记的完整正文，以及 `maxLinkDepth` 范围内所有可达链接笔记的正文。长笔记或密集链接图可能显著增加下次请求的 token 数。`wiki_search` 只返回有限的结果元数据；其 `total` 会告知被上限截断而未返回的命中数量。

#### KV Cache 影响

独立。该插件仅提供工具结果，不改变请求头、系统提示或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **未接入沙箱策略** — 插件直接读取文件，绕过 `ctx.fs` 沙箱与审批机制。未来可以提供委托给 `ctx.fs` 的 provider 以继承策略。
- **无向量搜索** — 仅支持关键词搜索。未来可新增 `tool-memory-vector` 包提供基于 embedding 的检索，而无需修改本包。
- **不支持图片或二进制附件** — 笔记按 UTF-8 文本处理。附件应继续使用 attachment 体系。
- **无内置写协调** —— 写入是原子的（临时文件 + `rename`），读者不会看到半写文件，但对同一笔记的并发 `wiki_write` 仍可能丢更新。协作调用方可传 `baseVersion` 把丢更新变成显式冲突；挂载 `@jacklika/dsh-memory-queue` 可获得进程内串行化，并可选用心跳刷新的跨进程锁。
- **无法读取的条目被跳过而非作为数据暴露** —— 进程读不到的笔记或目录会从读取、搜索与链接解析结果中消失，仅通过 logger 警告报告；工具返回值本身不会列出被跳过的条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
