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

### Acceptance execution boundary (unreleased source)

The optional `memory-scope` `acceptanceMode` guard is disabled by default and is **not present in the published rc.33 desktop Profile**. For future deployments, run paging workers in a separate Loader/process configured `read-only`; run acceptance writers in a separate `bounded-write` instance with a realpath-bound `acceptanceCwd` and exact run-specific `acceptanceWritePrefixes`. Do not trust an agent-supplied role or assume a prompt prevents tool calls. This guard covers memory tools routed through its own waterfall, not shell writes, other plugins, or other processes. Use an OS read-only mount/sandbox if those surfaces are available to the worker.

Independently reconcile the Vault Git history with `scripts/audit-memory-acceptance.mjs` (read-only). Store the manifest **outside** the Vault, pin `--baseline` to a commit before any acceptance write, and rerun after the final report and any asynchronous auto-capture. Example manifest:

```json
{
  "schemaVersion": 1,
  "createPrefixes": ["shared/notes/dsh-run-123/"],
  "updateIds": [],
  "archiveMoves": [
    {
      "from": "shared/notes/dsh-run-123/target.md",
      "to": "archive/shared/notes/dsh-run-123/target.md"
    }
  ]
}
```

Run `node scripts/audit-memory-acceptance.mjs --vault <absolute-vault> --baseline <commit> --manifest <absolute-json>` from the source repository. It compares all committed changes since baseline (including path pairs for archives), fails on any unexpected path or dirty working tree, outputs JSON, and exits nonzero on failure. Declare planned auto-capture IDs/prefixes explicitly; never silently exempt all `auto-capture/`. The auditor does not prove who called a tool or validate pre-baseline history, and cannot prevent writes by itself. A fresh Vault needs an initial trusted commit before the baseline can be pinned.

- Plugins and skills are trusted code/configuration: they run inside the dsh process with full host privileges. Only install versions you control.
- `nestedRepo` default (`init`) prevents memory commits from silently entering an enclosing project repository — a real boundary found during development, now closed by default.
- Path containment rejects `..`, absolute-path, cross-root, and existing symlink/junction escapes. Reads verify the real target; writes verify the nearest existing ancestor before and after directory creation, resolve in-vault symlinks to their target (re-checked for containment) so appending through a link updates the linked note instead of replacing the link, refuse broken links, and publish atomically via a sibling temp-file rename that carries the old permission bits.
- Link-target resolution stays lexical and lenient by design (percent-encoding is not decoded, and Windows-style separators in a `[[link]]` target normalize to `/`), but note ids are strict: a backslash in an id, or a NUL byte anywhere, is rejected, so one id cannot denote different files on different platforms. Neither rule decides what the filesystem may touch — containment is enforced separately on the resolved real path. Unreadable entries are skipped with a logger warning so one bad file cannot fail a whole scan, and error messages stay vault-relative without host paths.

## Concurrency truth table

| Writer set | Protection |
|---|---|
| One MCP server process | Fully serialized |
| dsh tool path with `memory-queue` | In-process FIFO + optional cross-process `mkdir` lock |
| Multiple MCP servers / direct file writes | `baseVersion` conflict errors + atomic rename (detect, not prevent) |
