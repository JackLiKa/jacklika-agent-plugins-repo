# @jacklika/dsh-memory-mcp

MCP stdio server that exposes the memory vault to any MCP client (Claude Code, Cursor, Obsidian bridges, `dsh-mcp-client`). Each process serializes its own requests and coordinates writes with the dsh memory queue through per-note vault locks. Direct filesystem editors do not participate in that protocol.

## Run

```sh
# from the workspace root
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# or after install
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` defaults to `<cwd>/.plugins/memory/` to match the dsh-memory Bundle default; `--max-link-depth N` controls `wiki_read` link following (default 1); `--notes-dir DIR` is the shared curated zone `memory_capture` writes to (default `shared/notes`, the memory-curator default).

## Surface

Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same contract as `@jacklika/dsh-tool-memory-filesystem` / `-graph`, including `baseVersion` optimistic concurrency on writes, `mtime` + `modifiedExternally` on reads, `+08:00` `created`/`updated` normalization on writes, `expired` flags, and `fused`/`semantic` search signals. `memory_capture` mirrors the dsh curator tool: it derives the note id from the title when omitted, merges an existing note's frontmatter, and returns `{written, id, mode, conflict, version, created?, updated?}`. `memory_capture` and `memory_correct` accept optional `source_session`, `commit`, and `verified` provenance fields. Two differences are intentional: `committed` never appears because MCP writes do not run memory-git, and `scope` is not offered because MCP has no agent namespace. With no approval channel over MCP, a conflicting capture fails closed exactly as the dsh tool does in headless runs — `written: false`, `conflict: true`, and a reason pointing at `conflictPolicy: 'skip'` — which makes the approve-then-append branch unreachable: a capture that writes without `requireExisting` is always a full-note overwrite. `requireExisting: true` declares an update of the exact derived or explicit `id` instead (no title-match redirection): it replaces the body of an existing note with the complete current summary by default, needs no approval, and fails rather than creating a missing note. Pass `mode: 'append'` explicitly for additive material that should retain the old body; `wiki_write` takes the same flag but retains its own default append mode. Note ids reject backslashes, and failures name the vault-relative id without embedding host paths. Resources: `note:///<id>` over `resources/list` / `resources/read`.

`memory_correct(id, baseVersion, summary, details?, tags?)` replaces the exact existing note after `wiki_read`. It preserves omitted metadata, rejects stale versions, and never creates or appends. `memory_capture` checks the exact target and full-vault exact-title matches independently of capped broad keyword search; multiple same-title notes without an explicit id remain ambiguous. MCP corrections return no `committed` field.

`memory_forget(id, baseVersion)` moves the note into `archive/<original-relative-path>` so it disappears from search/graph results. The move is a filesystem rename, not a git commit, because the MCP server does not run `memory-git`; commit the vault externally if you need history.

## Client configuration

Any MCP client that speaks stdio JSON-RPC can mount it:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/jacklika-agent-plugins-repo/packages/memory-mcp/src/server.mjs", "--vault", "/path/to/vault"]
    }
  }
}
```

## Coordination contract

- Each server process serializes **its own** requests. Writes also acquire the same per-note lock directory as the dsh memory queue, so cooperating MCP and dsh processes do not interleave writes to the same id. A held lock times out without changing the note; MCP does not reclaim abandoned locks on its own.
- Direct filesystem editors do not use that lock. A `baseVersion` guard detects changes visible before the guarded write, but is not a transaction against uncooperative editors. Atomic rename prevents partial file contents. The dsh `memory-git` plugin covers audit/history only on the dsh tool-calling path.
- Writes through MCP do **not** produce git commits; mount `dsh-memory-git` on the dsh side or commit the vault externally if you need history for MCP-origin writes.
- Everything is local: stdio only, no network listener, no telemetry.
