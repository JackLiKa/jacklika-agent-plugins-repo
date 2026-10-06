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

## Write-coordination chain (tool-calling path)

```
wiki_write("notes/x.md")
  → memory-scope   rewrites id to agents/<key>/notes/x.md (structural conflict prevention;
                   shared/ passes through, role: curator bypasses)
  → memory-queue   FIFO lane + optional cross-process mkdir lock with heartbeat liveness
  → memory-git     commits the note into the vault's own git repo (prefixes: ['shared/'])
  → wiki_write     baseVersion optimistic check + atomic temp-file rename
```

Each layer is a separate opt-in `tools/execute` waterfall decorator; `wiki_write` itself is never modified. Mount order is load order.

## MCP path

`dsh-memory-mcp` is a zero-dependency Node stdio server implementing the same tools plus `note:///` resources. One server process serializes its own writes — the single-writer deployment. Caveats (documented in [security.md](security.md)):

- Serialization is per server process; independent MCP processes and direct filesystem writers are not covered — `baseVersion` and atomic rename remain the safety net.
- MCP-origin writes do not produce git commits; `memory-git` runs on the dsh tool-calling path only.

## Connector plugins

`@jacklika/dsh-qoder-connect` and `@jacklika/dsh-devin-connect` wrap external LLM services as DSH LLM adapters. Each connector:

1. Registers a DSH LLM adapter for its provider route (`qoder`, `qoder-china`, `devin`).
2. Hosts loopback-only web routes under `/plugins/<id>/*` for status, token save/verify, and (for Devin) model-cache refresh.
3. Publishes client-side status into the shared connector status store provided by `@jacklika/dsh-connector-core`.
4. Reuses `CliLlmAdapter` so generation calls go through the provider's official CLI, with `--model` and `--max-output-tokens` mapped from DSH options.

The host half never exposes full PATs in responses; only masked tails are sent to the UI.

## Unified dashboard

`@jacklika/dsh-connector-core` supplies:

- `ConnectorListCard` — a sidebar card that appears only when at least one connector reports `signedIn`; clicking opens a unified dashboard.
- The unified dashboard modal — accordion provider rows, per-account quota progress bars, and expandable model lists grouped by family.

