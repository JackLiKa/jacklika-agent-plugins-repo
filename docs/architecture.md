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
Vault          <workspace>/.dsh/memory/     — Obsidian-compatible Markdown notes
```

## The vault

- Default location: `<session cwd>/.dsh/memory/` — per-workspace, lives next to the code.
- Notes are plain Markdown with optional `---` YAML frontmatter and `[[wiki links]]`.
- `agents/<key>/` holds per-agent namespaces (writes are rewritten there by `memory-scope`); `shared/` is the curated public zone.

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
