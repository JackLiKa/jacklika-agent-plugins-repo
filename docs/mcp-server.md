# MCP server

`@jacklika/dsh-memory-mcp` exposes the vault over standard MCP stdio transport so any MCP client (Claude Code, Cursor, an Obsidian bridge, or dsh's own `dsh-mcp-client`) can read and write notes without the dsh plugin stack.

## Run

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N]
```

`--vault` defaults to `<cwd>/.plugins/memory/` to match the dsh-memory Bundle default. The server has no build step.

## Client configuration

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

## Surface

- Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same tool names and `baseVersion` conflict errors as the dsh tools, with one intentional difference: MCP `wiki_search` is a plain AND keyword match sorted by note id and returns a bare array of `{id, title}` (no relevance `score`, no `backlinks`, no layered ranking, no `{ hits, total, truncated }` envelope and therefore no vault-wide match count — the dsh tool returns that envelope). MCP `wiki_write` likewise returns `{id, mode, bytes}` without the `version` field the dsh tool adds, so callers that want to chain `baseVersion` writes get the version from `wiki_read`. The layered BM25/phrase/graph/semantic ranking lives in `@jacklika/dsh-tool-memory-filesystem`; the MCP server stays dependency-free. `wiki_read` returns the same `mtime` + `modifiedExternally` fields as the dsh tool, and `wiki_write` normalizes `created`/`updated` frontmatter timestamps to `+08:00` the same way. `wiki_read`/`wiki_graph` resolve `[[link]]` targets with the same Obsidian-style semantics as the dsh tools: exact vault-relative path, then path suffix, then basename match, choosing the fewest path segments then the lowest id on ambiguity.
- Resources: `note:///<id>` via `resources/list` / `resources/read`.

## What it guarantees — and what it does not

- Writes through **one** server process are serialized; use a single shared server per vault for single-writer semantics.
- It is not a global lock: other processes and direct file writes bypass it. `baseVersion` checks and atomic rename keep those writes correct.
- It does not run `memory-git`; commit the vault externally or use the dsh path for history.
