# Security and data flows

## What stays local

- Vault reads/writes: local filesystem only.
- `memory-git`: local `git add` / `git commit` only — **never pushes**; push is always a manual act.
- MCP server: stdio only, no network listener, no telemetry, no hidden outbound calls.

## What leaves the machine

| Path | Exposure |
|---|---|
| LLM calls | Note content placed into prompts is sent to the configured model provider — this is inherent to any agent memory. |
| `wiki_semantic_search` | Note content is sent to the configured embeddings endpoint. Disabled until an endpoint is configured. |
| `git push` of the vault | Manual only. With `nestedRepo: init` (default) the vault has its own repo, so a workspace push never carries memory history. |

## Trust boundaries

- Plugins and skills are trusted code/configuration: they run inside the dsh process with full host privileges. Only install versions you control.
- `nestedRepo` default (`init`) prevents memory commits from silently entering an enclosing project repository — a real boundary found during development, now closed by default.
- Path containment rejects `..` escapes on every tool call; writes publish atomically via temp-file rename.

## Concurrency truth table

| Writer set | Protection |
|---|---|
| One MCP server process | Fully serialized |
| dsh tool path with `memory-queue` | In-process FIFO + optional cross-process `mkdir` lock |
| Multiple MCP servers / direct file writes | `baseVersion` conflict errors + atomic rename (detect, not prevent) |
