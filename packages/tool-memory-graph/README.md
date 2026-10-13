---
description: "Model-facing wiki_graph tool exposing the [[link]] graph of a Markdown vault."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-graph` gives agents read-only graph queries over the Markdown vault used by [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.md). The model sees one tool, `wiki_graph`, which returns note nodes and directed edges derived from two sources: explicit Obsidian-style `[[link]]` references, and keyword co-occurrence between notes (frontmatter tags/title and body terms). It can therefore expose an implicit association such as "B and C both mention `word1`", and that association automatically disappears when one note is rewritten and the shared term is no longer present — or is replaced by a new shared term such as `word2`. The package reuses the filesystem plugin's vault resolution and parsing helpers, so path containment, frontmatter handling, and the `indexHiddenDirs` policy match without a second parser.

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
| `maxEdges` | `number` | `1000` | Maximum edges returned in one graph. |

### Tools

- `wiki_graph(id?, depth?)` — without `id`, return every note and directed edge in the vault. With `id`, return the reachable subgraph within `depth` hops; edges from boundary nodes are included when both endpoints are selected. Edges carry `type` (`link` or `keyword`), `keywords` (for `keyword` edges), and `weight` (combined term frequency). Output is `{ nodes, edges, truncated, edgesTruncated }`: `truncated` reports the `maxNodes` cut and `edgesTruncated` the `maxEdges` cut, kept separate so a complete node set is not misread as a complete graph.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a single Cordis function plugin that registers `wiki_graph` on `ctx.tools`. Per call it resolves the vault root through the shared `resolveMemoryVaultRoot` helper, lists notes through the shared `listNotePaths` walker, and extracts `[[link]]` targets through `extractLinks`/`resolveLinkTarget`. Targets resolve with the same Obsidian-style tiers as `wiki_read` — exact vault-relative path, then path suffix, then basename anywhere in the vault, with deterministic ambiguity handling. In addition to explicit links, the tool extracts significant terms from each note (frontmatter `tags` ×3, frontmatter `title` ×2, body terms ×1) and creates `keyword` edges between any two notes that share one or more terms. A breadth-first walk with a visited set (so cyclical link graphs terminate) follows both `link` and `keyword` edges to select the node set first; edges are then collected from every selected node so boundary-node outgoing edges are not dropped. When the node set exceeds `maxNodes`, a whole-vault graph keeps the lowest ids in code-unit order (the ordering `tool-memory-filesystem` tie-breaks with) and a subgraph keeps the notes nearest the center — BFS level first, then id — so which notes survive the cap never depends on directory-listing order and a subgraph never drops its own center. Because `wiki_graph` recomputes from disk on every call, rewriting a note removes stale `keyword` edges and creates new ones for the terms that survive or appear in the new text. Edges are capped at `maxEdges` after node selection: explicit `link` edges first, then `keyword` edges by descending weight, with a deterministic id tie-break, so the surviving set never depends on directory-listing order. Requesting a center id that is not an indexed note fails with `note not found`, and an unreadable note is skipped (logged as a warning) instead of failing the call. Output is `{ nodes: [{ id, title }], edges: [{ from, to, type, keywords?, weight? }], truncated: boolean, edgesTruncated: boolean }`, where `truncated` covers the node cap and `edgesTruncated` the edge cap.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `wiki_graph` schema. The description states that the graph is read-only and derived from `[[link]]` references plus shared keywords.

##### Verbatim description for `wiki_graph`

```markdown
Return the link and keyword graph of the wiki vault: note ids, titles, and directed edges. Explicit `[[link]]` edges are type `link`; edges derived from shared significant terms are type `keyword` with `keywords` and `weight`. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth. Nodes are capped at maxNodes (`truncated`) and edges at maxEdges (`edgesTruncated`).
```

#### Token effect

A whole-vault call returns every note and edge; large vaults can add many tokens. Center-id subgraph calls bound output by `depth`.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No visualization** — the tool returns JSON nodes and edges; rendering (Obsidian graph view, Mermaid) is left to consumers.
- **Edges are scoped to selected nodes** — only links whose source and target both survive the `maxNodes` cap are returned, so boundary links outside the selected set are omitted. A dense vault can then also hit the `maxEdges` cap; `edgesTruncated` reports when the returned edges are only a deterministic slice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
