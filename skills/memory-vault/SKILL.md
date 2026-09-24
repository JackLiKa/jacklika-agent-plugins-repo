---
name: memory-vault
description: Use when the session needs durable cross-session memory — reading or writing notes in the Obsidian-compatible wiki vault, linking concepts, or deciding what belongs in shared memory versus private agent notes.
---

# Memory vault workflow

The vault is an Obsidian-compatible Markdown store under `.dsh/memory/` of the session workspace (or the configured `vaultRoot`). Four tools operate on it: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` (plus `wiki_semantic_search` when enabled).

## When to read

- At task start, `wiki_search` for the domain concepts, prior decisions, and people involved before asking the user to repeat context.
- `wiki_graph` to see how a note connects to the rest of the vault before extending it.
- `wiki_read` returns a `version` fingerprint — keep it when you intend to write back to the same note.

## When to write

Write only durable knowledge: decisions and their rationale, discovered APIs/paths/commands, project conventions, user preferences, TODO states worth surviving the session. Do not write transient reasoning, per-step progress, or content already in the repository.

## Where to write

- Your notes land under `agents/<your key>/` automatically — do not add the prefix yourself.
- `shared/` is the curated public zone; write there only for knowledge meant for every agent and future session.
- Prefer one note per concept under `concepts/`, dated logs under `daily/`.

## Safe write protocol

1. `wiki_read(id)` — note the returned `version`.
2. Compose the change.
3. `wiki_write(id, content, baseVersion: <version>)` — if the note changed since your read, the write fails; re-read and redo instead of overwriting blindly.
4. Appending adds a timestamped section; `mode: overwrite` replaces the whole body — use it only for full rewrites.

## Linking convention

- Reference other notes with `[[note-id]]` links so `wiki_graph` and backlinks stay meaningful.
- Link liberally on first mention of a concept; do not repeat links every paragraph.
- Keep YAML frontmatter minimal: `title`, `tags`, `created` are enough.

## What is already handled for you

- Concurrent writes to the same note are serialized; you do not need to wait or retry for lock reasons.
- `shared/` writes are committed to the vault's own git history — your writes are auditable and recoverable.
- Files publish atomically; a reader never sees a half-written note.
