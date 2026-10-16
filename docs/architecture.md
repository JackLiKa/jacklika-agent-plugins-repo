# Architecture

The memory suite is a layered design: every layer solves a different failure mode, and all layers converge on one local Markdown vault.

```
Skill          skills/memory-vault          — teaches the model how/when to use memory
  ↓
Tool calling   @jacklika/dsh-tool-memory-*  — native dsh tools
               @jacklika/dsh-memory-*       — write coordination (scope/queue/git)
  ↓
MCP            @jacklika/dsh-memory-mcp     — stdio server for non-dsh clients
  ↓
Vault          <workspace>/.plugins/memory/     — Obsidian-compatible Markdown notes
```

## The vault

- Default location: `<session cwd>/.plugins/memory/` — per-workspace, lives next to the code.
- Notes are plain Markdown with optional `---` YAML frontmatter and `[[wiki links]]`.
- `agents/<key>/` holds per-agent namespaces (writes are rewritten there by `memory-scope`); `shared/` is the curated public zone.

All human-facing timestamps stored in the vault use **Asia/Shanghai (`+08:00`)** time, including note `created` frontmatter and append-section headings. This keeps the local audit log readable for the project maintainer and avoids mixing UTC `Z` with local wall-clock dates.

## Runtime identity and acceptance boundary

`memory_runtime_info` is the write gate for acceptance fixtures. It binds evidence from the actually loaded filesystem package to the calling session cwd and the vault root resolved for that call. The shipped Bundle also supplies its name and version through the plugin configuration. Callers provide absolute `expectedCwd` and `expectedVaultRoot`; formal deployment acceptance additionally supplies the installed package directory as `expectedModuleRoot`. The module must remain inside that root after both lexical and realpath containment checks. `preflight.safeToWrite` is true only when all supplied authoritative expectations match. The returned fingerprint covers the runtime identity, profile hint, workspace, and vault state, so reports can identify which instance they tested.

This attestation is deliberately layered rather than a universal deployment PASS. The profile name is a non-authoritative environment hint and can be unavailable. An unavailable expected hint is reported in `warnings`; an available contradictory hint is a mismatch. Package publication, lockfile/frozen-install policy, host-process provenance, runtime behavior, and data-safety checks remain separate gates. A functional acceptance report must retain those statuses independently instead of inferring one from another.

## Graph observability and archives

`wiki_graph` removes `excludeDirs` (default `['archive']`) **before** constructing nodes, resolving `[[link]]` targets, or deriving keyword edges. A link to an archived-only target remains unresolved; it is not redirected to `archive/`. Direct `wiki_read` still works for an archived id, while centering `wiki_graph` on an existing excluded note returns a distinct exclusion error. The result's `excludedDirs` reports the configured policy, not the number of notes excluded.

`wiki_graph` reports `nodesTotal`/`nodesReturned` and `edgesTotal`/`edgesReturned`/`edgesDropped`, plus the existing `truncated`/`edgesTruncated`. `edgesTotal` counts edges **among the returned nodes** before the edge cap; edges involving nodes lost to the node cap are not counted. Only `truncated:false` **and** `edgesTruncated:false` prove the returned graph is exhaustive. Per-call `maxNodes`/`maxEdges` overrides can raise the default budgets for an audit, but are clamped to configured `maxNodesLimit`/`maxEdgesLimit`; `effectiveMaxNodes`/`effectiveMaxEdges` disclose the applied caps. Raise budgets carefully to avoid oversized tool responses.

For vault-wide archive isolation, use `wiki_graph_audit()`: it checks the index and edge endpoints before output capping and returns `archiveExcluded` with `complete`, `scanStable`, `skippedEntries`, and a content fingerprint. A false `complete` is not evidence of isolation. To consume the actual complete node/edge lists without expanding one model response, use `wiki_graph_page(kind:'nodes'|'edges', pageSize, cursor?)`. Pages are ordered deterministically and bounded per response; each rebuilds and rechecks the vault, rejecting a stale fingerprint instead of silently mixing revisions. This is optimistic consistency, not an atomic snapshot against external writers; very large scans can exceed server-work limits.

## Write-coordination chain (tool-calling path)

```
wiki_write("notes/x.md")
  → memory-scope   rewrites id to agents/<key>/notes/x.md (structural conflict prevention;
                   shared/ passes through, role: curator bypasses)
  → memory-queue   FIFO lane + optional cross-process mkdir lock with heartbeat liveness
  → memory-git     commits the note into the vault's own git repo (prefixes: ['shared/', 'agents/'])
  → wiki_write     baseVersion optimistic check + atomic temp-file rename
```

Each layer is a separate opt-in `tools/execute` waterfall decorator; `wiki_write` itself is never modified. Mount order is load order.

## MCP path

`dsh-memory-mcp` is a zero-dependency Node stdio server implementing the same tools plus the curator's `memory_capture` and `note:///` resources. One server process serializes its own writes — the single-writer deployment. Caveats (documented in [security.md](security.md)):

- Serialization is per server process; independent MCP processes and direct filesystem writers are not covered — `baseVersion` and atomic rename remain the safety net.
- MCP-origin writes do not produce git commits; `memory-git` runs on the dsh tool-calling path only.

