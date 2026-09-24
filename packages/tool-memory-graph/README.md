---
description: "Model-facing wiki_graph tool exposing the [[link]] graph of a Markdown vault."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-graph` gives agents read-only graph queries over the Markdown vault used by [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.md). The model sees one tool, `wiki_graph`, which returns note nodes and directed edges derived from Obsidian-style `[[link]]` references — either the whole vault or the reachable subgraph around one note. The package reuses the filesystem plugin's vault resolution and parsing helpers, so path containment, frontmatter handling, and the `indexHiddenDirs` policy match without a second parser.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile or patch file:

```yaml
- name: '@jacklika/dsh-tool-memory-graph'
```

It resolves the same vault root per call as `tool-memory-filesystem`: an explicit `vaultRoot` (relative paths anchor at the session workspace), otherwise `<session cwd>/.dsh/memory/`.

### Configure the graph

| Field | Type | Default | Description |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | Vault root. Empty selects the per-workspace memory directory; a relative path resolves against the session workspace. |
| `extensions` | `string[]` | `['.md']` | File extensions treated as notes. |
| `indexHiddenDirs` | `boolean` | `false` | Index directories whose names start with `.` (`.git` and `node_modules` stay excluded). Enable when `vaultRoot` points at the workspace root so `.dsh/memory/` notes are included. |
| `maxDepth` | `number` | `1` | Maximum BFS depth when a center id is given. |
| `maxNodes` | `number` | `200` | Maximum nodes returned in one graph. |

### Tools

- `wiki_graph(id?, depth?)` — without `id`, return every note and directed edge in the vault. With `id`, return the reachable subgraph within `depth` hops; edges from boundary nodes are included when both endpoints are selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a single Cordis function plugin that registers `wiki_graph` on `ctx.tools`. Per call it resolves the vault root through the shared `resolveMemoryVaultRoot` helper, lists notes through the shared `listNotePaths` walker, and extracts `[[link]]` targets through `extractLinks`/`resolveLinkTarget`. A breadth-first walk selects the node set first; edges are then collected from every selected node so boundary-node outgoing edges are not dropped. Output is `{ nodes: [{ id, title, backlinks }], edges: [{ from, to }] }`.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `wiki_graph` schema in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory-graph). The description states that the graph is read-only and derived from `[[link]]` references.

##### Verbatim description for `wiki_graph`

```markdown
Return the Obsidian-style [[link]] graph of the wiki vault: note ids, titles, and directed edges. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth.
```

#### Token effect

A whole-vault call returns every note and edge; large vaults can add many tokens. Center-id subgraph calls bound output by `depth`.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No visualization** — the tool returns JSON nodes and edges; rendering (Obsidian graph view, Mermaid) is left to consumers.
- **Backlinks reflect the whole vault** — node `backlinks` counts are computed over all notes, not just the selected subgraph.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
