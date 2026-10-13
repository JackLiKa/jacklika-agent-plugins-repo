# @jacklika/dsh-memory-mcp

MCP stdio server that exposes the memory vault to any MCP client (Claude Code, Cursor, Obsidian bridges, `dsh-mcp-client`). One process owns every write, so clients serialize through the server instead of negotiating filesystem locks — this is the "single writer" deployment of the memory suite.

## Run

```sh
# from the workspace root
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# or after install
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` defaults to `<cwd>/.plugins/memory/` to match the dsh-memory Bundle default; `--max-link-depth N` controls `wiki_read` link following (default 1); `--notes-dir DIR` is the shared curated zone `memory_capture` writes to (default `shared/notes`, the memory-curator default).

## Surface

Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same contract as `@jacklika/dsh-tool-memory-filesystem` / `-graph`, including `baseVersion` optimistic concurrency on writes, `mtime` + `modifiedExternally` on reads, and `+08:00` `created`/`updated` normalization on writes. `memory_capture` mirrors the dsh curator tool: it derives the note id from the title when omitted, merges an existing note's frontmatter, and returns `{written, id, mode, conflict, version, created?, updated?}`. Two differences are intentional: `committed` never appears because MCP writes do not run memory-git, and `scope` is not offered because MCP has no agent namespace. With no approval channel over MCP, a conflicting capture fails closed exactly as the dsh tool does in headless runs — `written: false`, `conflict: true`, and a reason pointing at `conflictPolicy: 'skip'` — which makes the approve-then-append branch unreachable: a capture that writes without `requireExisting` is always a full-note overwrite. `requireExisting: true` declares an update instead: it appends to a note that must already exist, needs no approval, and fails rather than creating a missing note; `wiki_write` takes the same flag. Note ids reject backslashes, and failures name the vault-relative id without embedding host paths. Resources: `note:///<id>` over `resources/list` / `resources/read`.

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

- One server process serializes **its own** writes; that is the robustness story.
- Independent server processes or direct filesystem writers are not serialized — `baseVersion` conflict errors and atomic rename still protect correctness, and the dsh `memory-git` plugin covers audit/history on the dsh tool-calling path.
- Writes through MCP do **not** produce git commits; mount `dsh-memory-git` on the dsh side or commit the vault externally if you need history for MCP-origin writes.
- Everything is local: stdio only, no network listener, no telemetry.
