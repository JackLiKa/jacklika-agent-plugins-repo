# MCP server

`@jacklika/dsh-memory-mcp` exposes the vault over standard MCP stdio transport so any MCP client (Claude Code, Cursor, an Obsidian bridge, or dsh's own `dsh-mcp-client`) can read and write notes without the dsh plugin stack.

## Run

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N]
```

`--vault` defaults to `<cwd>/.dsh/memory/`. The server has no dependencies and no build step.

## Client configuration

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

## Surface

- Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same semantics as the dsh tools, including `baseVersion` conflict errors.
- Resources: `note:///<id>` via `resources/list` / `resources/read`.

## What it guarantees — and what it does not

- Writes through **one** server process are serialized; use a single shared server per vault for single-writer semantics.
- It is not a global lock: other processes and direct file writes bypass it. `baseVersion` checks and atomic rename keep those writes correct.
- It does not run `memory-git`; commit the vault externally or use the dsh path for history.
