# @jacklika/dsh-memory-curator

Curator tools for the DSH memory vault. This package is a member of the `@jacklika/dsh-memory` Bundle; do not install it directly.

## Tools

- `memory_recall(query)` — Search the vault for prior notes before starting a task. Returns `{ query, hits, total, truncated }`, where `total` is the vault-wide match count passed through from `wiki_search` and can exceed `hits.length` when either layer caps its results, and `truncated` is `true` whenever it did — recall reports its own 20-hit presentation cap, not only the search layer's — so a caller can tell "these are all the matches" from "there are more". Per-turn auto-capture notes from `memory-anchor` are hidden from the hit list and subtracted from `total`, so bookkeeping never crowds out curated knowledge; the match anchors on the notes namespace, so a curated note whose name merely shares the prefix is still returned.
- `memory_capture(title, summary, ...)` — Persist durable knowledge after significant work, with conflict detection and optional user approval. Set `requireExisting: true` for an update-only capture targeting the exact derived or explicit `id` (title matches do not redirect it): it replaces the body of an existing note by default (provide the complete current summary), preserves `created` and other frontmatter fields, and fails instead of creating a missing note. Pass `mode: 'append'` explicitly only to add genuinely new material; old text remains visible. Without `requireExisting`, approved conflicts still default to append. Because changing that note is the declared intent, no conflict approval is requested. Returns `{ written, id, mode, conflict, version, created?, updated?, committed? }`: `version` is the SHA-1 of the persisted note text, `created` is present on first capture, `updated` is present on updates, and `committed` is present when `memory-git` completed the commit. `conflict` reports a detected match that needed a policy decision, so a successful update-only capture reports `false`.

## Note ids

When `id` is omitted, `memory_capture` derives it from the title: Unicode letters and digits are kept (NFC-normalized, lowercased) and every other run of characters becomes a single `-`, so CJK and other non-Latin titles stay readable and distinct. A title with no letters or digits at all falls back to `note-<12 hex chars of its sha256>`, so symbol-only captures never collapse into one shared file.

## Overwriting a capture

`mode: 'overwrite'` replaces the note body but merges its frontmatter: fields another writer recorded and the original `created` survive, `title` and `tags` come from this call, and `updated` is stamped. An intervening change detected between reading the old note and writing it fails instead of replacing that change. A first capture writes `created` only.

See the Bundle documentation in `docs/usage.md` for configuration and workflow.
