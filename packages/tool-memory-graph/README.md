---
description: "Model-facing wiki_graph tool exposing the [[link]] graph of a Markdown vault."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-graph

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-graph` gives agents read-only graph queries over the Markdown vault used by [`dsh-tool-memory-filesystem`](../tool-memory-filesystem/README.md). The model sees `wiki_graph`, the compact `wiki_graph_audit` isolation check, and the bounded `wiki_graph_page` traversal. `wiki_graph` returns note nodes and directed edges derived from two sources: explicit Obsidian-style `[[link]]` references, and keyword co-occurrence between notes (frontmatter tags/title and body terms). It can therefore expose an implicit association such as "B and C both mention `word1`", and that association automatically disappears when one note is rewritten and the shared term is no longer present — or is replaced by a new shared term such as `word2`. The package reuses the filesystem plugin's vault resolution and parsing helpers, so path containment, frontmatter handling, and the `indexHiddenDirs` policy match without a second parser.

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
| `excludeDirs` | `string[]` | `['archive']` | Exclude these directory names before graph nodes, link targets, and keyword edges are built. Archived notes remain directly readable with `wiki_read`. |
| `maxDepth` | `number` | `1` | Maximum BFS depth when a center id is given. |
| `maxDepthLimit` | `number` | `20` | Hard upper bound for the effective `depth`. A call asking for more is clamped to this value, and the subgraph reports the depth actually traversed. Must be `>= maxDepth`. |
| `maxNodes` | `number` | `200` | Default node result cap; a call may override it. |
| `maxNodesLimit` | `number` | `2000` | Hard upper bound for the effective node cap, including configured defaults. |
| `maxEdges` | `number` | `1000` | Default edge result cap; a call may override it. |
| `maxEdgesLimit` | `number` | `20000` | Hard upper bound for the effective edge cap, including configured defaults. |
| `pageSizeLimit` | `number` | `250` | Hard cap on nodes or edges returned per `wiki_graph_page` call. |
| `pageScanNodesLimit` | `number` | `5000` | Refuse full-graph paging when the indexed note count exceeds this server-work bound. |
| `pageScanEdgesLimit` | `number` | `250000` | Refuse paging when full edge generation exceeds this bound; audit remains independent of page limits. |

### Tools

- `wiki_graph(id?, depth?, maxNodes?, maxEdges?)` — without `id`, return the vault-wide graph; with `id`, return the reachable subgraph within `depth` hops. Per-call budgets must be positive integers and are clamped to `maxNodesLimit`/`maxEdgesLimit`, with `effectiveMaxNodes`/`effectiveMaxEdges` reporting the applied caps. Explicit link edges have `from`/`to` and no `type`; keyword edges carry `type: 'keyword'`, `keywords`, and `weight`. The result adds `nodesTotal`, `nodesReturned`, `edgesTotal`, `edgesReturned`, `edgesDropped`, and `excludedDirs` alongside the existing `truncated`, `edgesTruncated`, and optional effective `depth`. `nodesTotal` counts reachable indexed notes before the node cap; `edgesTotal` counts candidate edges **among returned nodes** before the edge cap, so `edgesReturned + edgesDropped === edgesTotal`. If nodes were capped, edges incident to omitted nodes are outside that count. Both truncation flags must be `false` for an exhaustive result. `excludedDirs` names configured index exclusions, not a count of excluded notes. An existing excluded note used as center produces `note excluded by excludeDirs` rather than `note not found`; the latter still denotes a missing note.
- `wiki_graph_audit()` — inspect the entire indexed graph without returning the graph arrays. Returns `{ indexedNodes, checkedLinks, excludedDirsApplied, excludedNodesInIndex, excludedEdgeEndpoints, archiveNodesInIndex, archiveEdgeEndpoints, skippedEntries, scanStable, complete, archiveExcluded, snapshotId }`. It scans the index and link candidates before result caps and checks keyword endpoints when excluded notes entered the index. `complete:false` means unreadable entries or a change detected between the initial and verification scans; it must not be treated as a PASS. `archiveExcluded:true` requires a complete scan, an active `archive` exclusion, and zero archived indexed nodes/edge endpoints. This is a server-side check, not proof from an incomplete returned edge page.
- `wiki_graph_page(kind, id?, depth?, pageSize?, cursor?)` — page `kind:'nodes'` or `kind:'edges'` across the full graph, independently of `wiki_graph` result caps. Default page size is 100; the configured `pageSizeLimit` clamps it. Returns `{ kind, nodes, edges, total, offset, pageSize, nextCursor, snapshotId, excludedDirs }`; continue with `nextCursor` and the **same kind/id/depth** until null. Two scans must match and no entries may be skipped. The cursor contains a content/graph fingerprint and offset; a changed graph returns `stale graph snapshot` (restart at page 1), not a silently incomplete page. Ordering is deterministic (nodes by id or BFS distance, edges by the same link-first/weight/id comparator as capped `wiki_graph`). Pages recompute the graph on every call and can be expensive. Excessive graph sizes fail with `pageScanNodesLimit`/`pageScanEdgesLimit` errors; paging is bounded rather than an unlimited-resource export.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a single Cordis function plugin that registers `wiki_graph` on `ctx.tools`. Per call it resolves the vault root through the shared `resolveMemoryVaultRoot` helper, lists notes through the shared `listNotePaths` walker, and extracts `[[link]]` targets through `extractLinks`/`resolveLinkTarget`. Indexed targets resolve with the same Obsidian-style tiers as `wiki_read` — exact vault-relative path, then path suffix, then basename among indexed notes, with deterministic ambiguity handling. Excluded directories (by default `archive`) are removed before both link resolution and keyword-edge construction: an active `[[link]]` pointing only at an archived note remains unresolved, not redirected to the archive copy. An archived note is still available by direct `wiki_read` but cannot be a graph center. In addition to explicit links, the tool extracts significant terms from each note (frontmatter `tags` ×3, frontmatter `title` ×2, body terms ×1) and creates `keyword` edges between any two notes that share one or more terms. A breadth-first walk with a visited set (so cyclical link graphs terminate) follows both `link` and `keyword` edges to select the node set first; edges are then collected from every selected node so boundary-node outgoing edges are not dropped. When the node set exceeds `maxNodes`, a whole-vault graph keeps the lowest ids in code-unit order (the ordering `tool-memory-filesystem` tie-breaks with) and a subgraph keeps the notes nearest the center — BFS level first, then id — so which notes survive the cap never depends on directory-listing order and a subgraph never drops its own center. Because `wiki_graph` recomputes from disk on every call, rewriting a note removes stale `keyword` edges and creates new ones for the terms that survive or appear in the new text. Edges are capped at `maxEdges` after node selection: explicit `link` edges first, then `keyword` edges by descending weight, with a deterministic id tie-break, so the surviving set never depends on directory-listing order. The requested `depth` is clamped to `maxDepthLimit` before the walk — a configuration-time bound that must be at least `maxDepth` — and a subgraph result reports the effective `depth` it traversed, so a caller cannot force an unbounded walk and can still tell how far the returned result reaches. Requesting a center id that is not an indexed note fails with `note not found`, and an unreadable note is skipped (logged as a warning) instead of failing the call. Output is `{ nodes: [{ id, title }], edges: [{ from, to, type, keywords?, weight? }], truncated: boolean, edgesTruncated: boolean, depth?: number }`, where `truncated` covers the node cap, `edgesTruncated` the edge cap, and `depth` is present on subgraph results.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `wiki_graph`, `wiki_graph_audit`, and `wiki_graph_page` schemas. All three are read-only; audit emits a compact consistency result, while paging emits at most `pageSizeLimit` items per call.

##### Verbatim description for `wiki_graph`

```markdown
Return the link and keyword graph of the wiki vault. Explicit `[[link]]` edges have from/to (no type); keyword edges have type `keyword`, keywords and weight. Optional id/depth selects a subgraph. Per-call maxNodes/maxEdges are clamped to configured maxNodesLimit/maxEdgesLimit and reported as effectiveMaxNodes/effectiveMaxEdges. Returns nodesTotal/nodesReturned and edgesTotal/edgesReturned/edgesDropped; edgesTotal counts edges between returned nodes before the edge cap, not edges lost to a node cap. truncated/edgesTruncated retain their meanings. excludedDirs reports directory names omitted before link resolution; an existing excluded center fails with a distinct error. Only when both truncation flags are false is the returned graph exhaustive.
```

#### Token effect

`wiki_graph` is capped by default at 200 nodes and 1000 edges. A full isolation check should use `wiki_graph_audit` instead of raising output caps. `wiki_graph_page` limits each response to 250 items by default, although full graph reconstruction on every page can consume CPU and memory. Large graphs may exceed page scan limits; this does not affect the compact audit.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No visualization** — the tool returns JSON nodes and edges; rendering (Obsidian graph view, Mermaid) is left to consumers.
- **Edges are scoped to selected nodes** — only links whose source and target both survive the `maxNodes` cap are returned, so boundary links outside the selected set are omitted. A dense vault can then also hit the `maxEdges` cap; `edgesTruncated` reports when the returned edges are only a deterministic slice.
- **Live-vault snapshots are optimistic** — two content scans detect changes while an audit or page is built, and the next page rejects a changed fingerprint. External writers are not locked; a write immediately after verification can still change the vault. Strict point-in-time snapshots across arbitrary external writers require filesystem snapshots or coordinated locking. Very large graphs may exceed page scan limits and require an offline export.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
