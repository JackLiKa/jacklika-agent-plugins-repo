---
description: "面向模型的 wiki_semantic_search 工具，通过可配置的 OpenAI 兼容 embeddings 端点按向量相似度排序笔记。"
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-vector

[English](README.md) | 中文

## 概述

`dsh-tool-memory-vector` 为 Markdown 记忆仓库提供可选的语义检索，作为 [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.zh.md) 的补充插件。模型可见 `wiki_semantic_search`：通过可配置的 OpenAI 兼容 embeddings 端点把笔记转成向量，按余弦相似度排序。每条笔记的向量按文件 mtime 缓存在仓库根下的 `.vector-index.json`，重复搜索只重新嵌入有改动的笔记。缓存同时记录由缓存 schema、endpoint 与 model 组成的指纹：不同 embedding 空间产生的向量与 query 向量不可比较，因此三者任一变化都会整体作废缓存并重新嵌入全部笔记，而不是按 mtime 继续复用旧向量。关键词检索（`wiki_search`）仍由 filesystem 包提供；本工具与之互补，永不替代。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

在 profile 或 patch 文件中挂载，并配置端点与模型：

```yaml
- name: '@jacklika/dsh-tool-memory-vector'
  config:
    endpoint: http://localhost:11434/v1/embeddings
    model: nomic-embed-text
```

`endpoint` 与 `model` 必填——任一为空或 endpoint 不是 HTTP(S) 时，插件在加载期直接报错。Ollama 或其他 OpenAI 兼容 embeddings 服务均可。凭据应放在 `apiKeyEnv` 指定的环境变量；安全运行时配置仍可直接传 `apiKey`。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | 仓库根。留空时使用按工作区隔离的记忆目录；相对路径相对于会话工作区解析。 |
| `extensions` | `string[]` | `['.md']` | 视为笔记的文件扩展名。 |
| `endpoint` | `string` | 必填 | OpenAI 兼容 embeddings 端点 URL。 |
| `model` | `string` | 必填 | 端点认识的 embedding 模型名。 |
| `apiKey` | `string` | `''` | 直接 Bearer token；为空时读取 `apiKeyEnv`，且永不记录或持久化。 |
| `apiKeyEnv` | `string` | `'DSH_MEMORY_EMBEDDING_API_KEY'` | 保存 Bearer token 的环境变量名。 |
| `requestTimeoutMs` | `number` | `30000` | 单次 embeddings 请求的最长时间。 |
| `maxResults` | `number` | `10` | 返回的最大命中数。 |
| `maxCharsPerNote` | `number` | `8000` | 单条笔记送去 embedding 的最大 UTF-8 字符数。 |
| `batchSize` | `number` | `16` | 单次 embeddings 请求的最大输入数。 |
| `indexHiddenDirs` | `boolean` | `false` | 是否索引以 `.` 开头的目录（`.git` 与 `node_modules` 始终排除）。 |

### 工具

- `wiki_semantic_search(query)` —— 先按 mtime 刷新向量索引，再对 query 取 embedding，按余弦相似度返回前 `maxResults` 条 `[{ id, score }]`。

-----

<a id="understand-the-implementation"></a>
## 实现说明

本包是单个 Cordis 函数插件，在 `ctx.tools` 上注册 `wiki_semantic_search`。每次调用通过共享的 `resolveMemoryVaultRoot` 解析仓库根，用 `listNotePaths` 遍历笔记。`refreshIndex` 先删除已消失文件的索引项，再对 mtime 变化的笔记按 `batchSize` 分批请求 embedding（每条最多 `maxCharsPerNote` 字符），仅在有变化时写回 `.vector-index.json`。写回的文件是信封结构——`{ schemaVersion, fingerprint, notes }`，其中 `fingerprint` 是 `{ schemaVersion, endpoint, model }` 的 sha1——缓存缺失、损坏，或是在其他 schema/endpoint/model 下写入的，都会在复用前被整体丢弃，因此下一次搜索会在当前 embedding 空间下重新嵌入整个仓库。query 向量每次现取；笔记向量走缓存。相似度为余弦值，零范数向量记 0 分。端点报错、响应结构异常、空向量都会让工具调用直接失败。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型可见内容

模型看到生成的 `wiki_semantic_search` schema。描述说明这是基于语义的检索，并提示模型用 `wiki_search` 做精确关键词查找。

##### `wiki_semantic_search` 的原文描述

```markdown
Semantic search over the wiki vault using embeddings: ranks notes by meaning rather than exact keywords. Returns matching note ids with similarity scores. Use wiki_search for exact keyword lookups.
```

#### Token 影响

结果是有上限的 `{ id, score }` 列表，不返回笔记正文。无论仓库多大，token 开销都较低。

#### KV Cache 影响

独立。插件只提供工具结果，不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **依赖外部端点** —— 无本地 embedding 兜底；端点不可达时工具直接失败。
- **每个仓库只有一份缓存槽** —— `.vector-index.json` 存放在仓库内且只保存一个指纹，因此共享同一仓库但配置不同模型或端点的两套部署会在每次切换时互相作废，各自重新嵌入整个仓库。这种情况下结果是正确的，只是有浪费。
- **切换即重建的代价** —— 修改 `endpoint`、`model` 或缓存 schema 版本会按设计丢弃全部已缓存向量；切换后的第一次搜索要承担一次完整重嵌入。
- **不返回笔记正文** —— 消费方需再调 `wiki_read` 取内容；合并检索工具留待后续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
