---
description: "Model-facing wiki_semantic_search tool ranking vault notes by embedding similarity through a configurable OpenAI-compatible endpoint."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-vector

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-vector` adds semantic retrieval to the Markdown memory vault as an optional companion to [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.md). The model sees `wiki_semantic_search`, which embeds notes through a configurable OpenAI-compatible embeddings endpoint and ranks them by cosine similarity. Per-note embeddings are cached by file mtime in `.vector-index.json` under the resolved vault root, so repeated searches only re-embed changed notes. Keyword search (`wiki_search`) remains available in the filesystem package; this tool complements it and never replaces it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile or patch file with an endpoint and model:

```yaml
- name: '@jacklika/dsh-tool-memory-vector'
  config:
    endpoint: http://localhost:11434/v1/embeddings
    model: nomic-embed-text
```

`endpoint` and `model` are required — the plugin fails at load when either is empty. An Ollama or other OpenAI-compatible embeddings server works; `apiKey` is optional.

### Configure the search

| Field | Type | Default | Description |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | Vault root. Empty selects the per-workspace memory directory; a relative path resolves against the session workspace. |
| `extensions` | `string[]` | `['.md']` | File extensions treated as notes. |
| `endpoint` | `string` | required | OpenAI-compatible embeddings endpoint URL. |
| `model` | `string` | required | Embedding model name understood by the endpoint. |
| `apiKey` | `string` | `''` | Bearer token sent to the endpoint; empty sends no header. |
| `maxResults` | `number` | `10` | Maximum hits returned. |
| `maxCharsPerNote` | `number` | `8000` | Maximum UTF-8 characters of one note sent for embedding. |
| `batchSize` | `number` | `16` | Maximum inputs per embeddings request. |
| `indexHiddenDirs` | `boolean` | `false` | Index directories whose names start with `.` (`.git` and `node_modules` stay excluded). |

### Tools

- `wiki_semantic_search(query)` — refresh the mtime-keyed embedding index, embed the query, and return the top `maxResults` notes by cosine similarity as `[{ id, score }]`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a single Cordis function plugin that registers `wiki_semantic_search` on `ctx.tools`. Per call it resolves the vault root through the shared `resolveMemoryVaultRoot` helper and lists notes through `listNotePaths`. `refreshIndex` drops index entries for deleted files, embeds notes whose mtime differs from the cached record (in `batchSize` batches of at most `maxCharsPerNote` characters each), and persists `.vector-index.json` only when something changed. Query embedding is requested per call; note vectors come from the cache. Scores are cosine similarities; zero-norm vectors score 0. Endpoint errors, malformed responses, and empty vectors fail the tool call loudly.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `wiki_semantic_search` schema in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory-vector). The description tells the model this is meaning-based retrieval and points it to `wiki_search` for exact keyword lookups.

##### Verbatim description for `wiki_semantic_search`

```markdown
Semantic search over the wiki vault using embeddings: ranks notes by meaning rather than exact keywords. Returns matching note ids with similarity scores. Use wiki_search for exact keyword lookups.
```

#### Token effect

The result is a bounded list of `{ id, score }` pairs — note bodies are not returned. Token cost stays low regardless of vault size.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External endpoint required** — there is no local embedding fallback; the tool fails when the endpoint is unreachable.
- **Index is per vault, per plugin config** — `.vector-index.json` lives inside the vault; different endpoints or models overwrite each other's entries without invalidation.
- **No atomic index write** — the JSON index is written directly; a crash mid-write can corrupt the cache (next call re-embeds everything).
- **Note bodies are not returned** — consumers must call `wiki_read` for content; a combined retrieval tool is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
