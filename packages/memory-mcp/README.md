# @jacklika/dsh-memory-mcp

Zero-dependency MCP stdio server that exposes the memory vault to any MCP client (Claude Code, Cursor, Obsidian bridges, `dsh-mcp-client`). One process owns every write, so clients serialize through the server instead of negotiating filesystem locks — this is the "single writer" deployment of the memory suite.

## Run

```sh
# from the workspace root
node packages/memory-mcp/src/server.mjs --vault /path/to/vault

# or after install
npx dsh-memory-mcp --vault /path/to/vault
```

`--vault` defaults to `<cwd>/.dsh/memory/`; `--max-link-depth N` controls `wiki_read` link following (default 1).

## Surface

Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same contract as `@jacklika/dsh-tool-memory-filesystem` / `-graph`, including `baseVersion` optimistic concurrency on writes. Resources: `note:///<id>` over `resources/list` / `resources/read`.

## Client configuration

Any MCP client that speaks stdio JSON-RPC can mount it:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mydsh-plugin/packages/memory-mcp/src/server.mjs", "--vault", "/path/to/vault"]
    }
  }
}
```

## Coordination contract

- One server process serializes **its own** writes; that is the robustness story.
- Independent server processes or direct filesystem writers are not serialized — `baseVersion` conflict errors and atomic rename still protect correctness, and the dsh `memory-git` plugin covers audit/history on the dsh tool-calling path.
- Writes through MCP do **not** produce git commits; mount `dsh-memory-git` on the dsh side or commit the vault externally if you need history for MCP-origin writes.
- Everything is local: stdio only, no network listener, no telemetry.
