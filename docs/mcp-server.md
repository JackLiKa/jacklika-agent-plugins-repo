# MCP server

`@jacklika/dsh-memory-mcp` exposes the vault over standard MCP stdio transport so any MCP client (Claude Code, Cursor, an Obsidian bridge, or dsh's own `dsh-mcp-client`) can read and write notes without the dsh plugin stack.

## Run

```sh
node packages/memory-mcp/src/server.mjs --vault /path/to/vault [--max-link-depth N] [--notes-dir DIR]
```

`--vault` defaults to `<cwd>/.plugins/memory/` to match the dsh-memory Bundle default, and `--notes-dir` — the `memory_capture` shared zone — defaults to `shared/notes`, the memory-curator default. The server has no build step.

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

- Tools: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` — same tool names and `baseVersion` conflict errors as the dsh tools, with one intentional difference: MCP `wiki_search` is a plain AND keyword match sorted by note id and returns a bare array of `{id, title}` (no relevance `score`, no `backlinks`, no layered ranking, no `{ hits, total, truncated }` envelope and therefore no vault-wide match count — the dsh tool returns that envelope). MCP `wiki_write` returns `{id, mode, bytes, version, created?, updated?}`: the `version` is the same SHA-1 fingerprint `wiki_read` reports, so callers can chain `baseVersion` writes without a separate read; `created` and `updated` are returned when the note frontmatter carries them. The `title` field returned by `wiki_search` and `wiki_graph` follows the same fallback as the dsh tools: `frontmatter.title` first, then the first Markdown `# heading`, then the id without extension. The layered BM25/phrase/graph/semantic ranking lives in `@jacklika/dsh-tool-memory-filesystem`; the MCP server stays dependency-free. `wiki_read` returns the same `mtime` + `modifiedExternally` fields as the dsh tool, and `wiki_write` normalizes `created`/`updated` frontmatter timestamps to `+08:00` the same way. `wiki_read`/`wiki_graph` resolve `[[link]]` targets with the same Obsidian-style semantics as the dsh tools: exact vault-relative path, then path suffix, then basename match, choosing the fewest path segments then the lowest id on ambiguity. `memory_capture` mirrors the dsh curator tool's return fields — `{written, id, mode, conflict, version, created?, updated?}` — minus `committed`, which requires memory-git, and minus `scope`, which requires an agent namespace MCP does not have; with no approval channel it fails closed on a conflict exactly as the dsh tool does headless (`written: false`, `conflict: true`, a reason pointing at `conflictPolicy: 'skip'`), so a capture that writes without `requireExisting` is always a full-note overwrite; `requireExisting: true` declares an update instead — it appends to a note that must already exist and fails rather than creating a missing one, with no approval needed, and `wiki_write` accepts the same flag. Note ids reject backslashes, and failures name the vault-relative id without embedding host paths.
- Resources: `note:///<id>` via `resources/list` / `resources/read`.

## What it guarantees — and what it does not

- Writes through **one** server process are serialized; use a single shared server per vault for single-writer semantics.
- It is not a global lock: other processes and direct file writes bypass it. `baseVersion` checks and atomic rename keep those writes correct.
- It does not run `memory-git`; commit the vault externally or use the dsh path for history.
