# @jacklika/dsh-memory-curator

Curator tools for the DSH memory vault. This package is a member of the `@jacklika/dsh-memory` Bundle; do not install it directly.

## Tools

- `memory_recall(query)` — Search the vault for prior notes before starting a task.
- `memory_capture(title, summary, ...)` — Persist durable knowledge after significant work, with conflict detection and optional user approval.

## Note ids

When `id` is omitted, `memory_capture` derives it from the title: Unicode letters and digits are kept (NFC-normalized, lowercased) and every other run of characters becomes a single `-`, so CJK and other non-Latin titles stay readable and distinct. A title with no letters or digits at all falls back to `note-<12 hex chars of its sha256>`, so symbol-only captures never collapse into one shared file.

## Overwriting a capture

`mode: 'overwrite'` replaces the note body but merges its frontmatter: fields another writer recorded and the original `created` survive, `title` and `tags` come from this call, and `updated` is stamped. A first capture writes `created` only.

See the Bundle documentation in `docs/usage.md` for configuration and workflow.
