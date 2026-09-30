---
name: memory-vault
description: Use when the session needs durable cross-session memory — reading or writing notes in the Obsidian-compatible wiki vault, linking concepts, or deciding what belongs in shared memory versus private agent notes.
---

# Memory vault workflow

The vault is an Obsidian-compatible Markdown store under `.dsh/memory/` of the session workspace (or the configured `vaultRoot`). Four tools operate on it: `wiki_read`, `wiki_search`, `wiki_write`, `wiki_graph` (plus `wiki_semantic_search` when enabled). A curator layer also provides `memory_recall` and `memory_capture`; prefer those for routine task-start/task-end memory work.

## Task-start recall

- Call `memory_recall(query)` with the user's task or the domain concepts involved.
- If it returns relevant notes, read the most relevant ones with `wiki_read` and incorporate the context into your plan.
- `memory_recall` is a thin wrapper over `wiki_search` and returns note ids, titles, and backlink counts.

## Task-end capture

- At the end of a significant task — especially when you reached a decision, fixed a bug, discovered an API, or clarified a convention — call `memory_capture(title, summary, ...)`.
- It will derive a stable note id from the title, check for conflicts with existing notes, ask the user for approval if one exists, and write the captured knowledge to the shared curated zone.
- Use `scope: shared` (the default) for knowledge meant for every agent and future session. Use `scope: private` only for notes that must stay inside the current agent namespace.

## Direct vault tools

Use `wiki_read`, `wiki_search`, `wiki_write`, and `wiki_graph` directly only when the curator tools do not fit (for example, reading a specific linked note, updating an existing note with a known id, or inspecting the link graph).

## Where notes land

- `memory_capture` with `scope: shared` writes under `shared/notes/` by default.
- Private notes land under `agents/<your key>/` automatically — do not add the prefix yourself.
- Prefer one note per concept; `memory_capture` will append a timestamped section to an existing note when the same title already exists and is approved.

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
