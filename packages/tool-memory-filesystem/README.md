---
description: "Model-facing wiki/memory tools over a local Markdown vault with Obsidian-style links and YAML frontmatter."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-filesystem

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-filesystem` gives agents read, search, and append access to a local Markdown vault. Notes are ordinary `.md` files with optional YAML frontmatter and Obsidian-style `[[link]]` references. A deployment mounts this package as a Cordis plugin; by default each session reads and writes notes under its own workspace at `<session cwd>/.dsh/memory/`, so every project keeps a private memory store. An explicit `vaultRoot` can pin one shared vault instead. The model sees `memory_runtime_info`, `wiki_read`, `wiki_search`, and `wiki_write` tools. No vector database is required — the MVP uses filename and keyword search, with link following for contextual completeness.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile or patch file:

```yaml
- name: '@jacklika/dsh-tool-memory-filesystem'
```

Each session then uses `<session cwd>/.dsh/memory/` as its vault. To share one vault across sessions, set an explicit root:

```yaml
- name: '@jacklika/dsh-tool-memory-filesystem'
  config:
    vaultRoot: /path/to/obsidian-vault
```

A relative `vaultRoot` resolves against the calling session's workspace.

### Configure the vault

| Field | Type | Default | Description |
|---|---|---|---|
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | Vault root. Empty selects the per-workspace memory directory; a relative path resolves against the session workspace. |
| `extensions` | `string[]` | `['.md']` | File extensions treated as notes. Must list at least one extension; an empty list fails plugin load. |
| `maxLinkDepth` | `number` | `1` | Maximum `[[link]]` hops `wiki_read` resolves. |
| `maxSearchResults` | `number` | `20` | Maximum `wiki_search` hits. |
| `indexHiddenDirs` | `boolean` | `false` | Index directories whose names start with `.` (`.git` and `node_modules` stay excluded). Enable when `vaultRoot` points at the workspace root so `.dsh/memory/` notes are included. |
| `excludeDirs` | `string[]` | `['archive']` | Directory names excluded from search indexing at any depth. The `archive` directory holds forgotten notes and is excluded by default; configure the graph plugin separately for graph indexing. Explicit `wiki_read` calls can still retrieve archived notes. |
| `indexCacheSize` | `number` | `0` | Maximum number of vaults whose `wiki_search` index is cached between calls; `0` disables caching (the historical per-call rebuild). A cached index is reused only while every note's `(path, mtime, size)` signature matches, so any external edit or `touch` forces a rebuild. |
| `bundleName` | `string` | `''` | Optional Bundle identity reported by `memory_runtime_info`; the shipped Bundle sets this value. |
| `bundleVersion` | `string` | `''` | Optional Bundle version reported by `memory_runtime_info`; the shipped Bundle keeps it aligned with its package manifest. |

### Tools

- `memory_runtime_info(expectedCwd?, expectedVaultRoot?, expectedModuleRoot?, expectedProfile?)` — return a read-only identity envelope for the loaded filesystem component, configured Bundle, profile hint, calling session workspace, resolved vault, vault/git existence, and a stable fingerprint. Acceptance flows must provide absolute cwd and vault expectations and require `preflight.safeToWrite:true` before creating fixtures. `expectedModuleRoot` optionally proves package provenance with lexical and realpath containment; a module outside that root fails closed. The profile value remains a non-authoritative environment hint: an unavailable hint appears in `warnings` without blocking a proven cwd/vault/module identity, while an available contradictory hint appears in `mismatches`. It is not proof of frozen installation or supply-chain policy compliance.
- `wiki_read(id)` — read one note by vault-relative path and return its frontmatter, body, links, linked notes, a `version` content fingerprint, the file's `mtime` as a `+08:00` timestamp, and a `modifiedExternally` flag that is `true` when the file changed on disk since this plugin last observed it (e.g. an Obsidian edit). The plugin keeps a bounded 256-entry LRU of observed mtimes keyed by absolute path; its own `wiki_write` and `wiki_restore` re-record the mtime so those plugin writes never flag. Failures come back as structured errors that name the vault-relative id (`cannot read note "x.md": no such note`) and never embed host paths, so a read issued before the vault's first write — when the vault root itself does not exist yet — reports the same `no such note` as a missing file in a vault that already exists.
- `wiki_search(query, exactTitle?, maxResults?)` — keyword search across note titles, ids, and bodies; query terms are OR-matched and ranked by field-weighted BM25-style scoring (title/id hits weigh most, rare terms weigh more) plus a verbatim-phrase bonus and a link-graph boost; when `wiki_semantic_search` is mounted the two rankings fuse via reciprocal rank fusion. Returns a `{ hits, total, truncated, fused, semantic }` page: each hit carries the note id, title, score, backlinks, and an `expired` flag; `total` counts every match *before* the cap; `truncated` is `true` when that cap cut the list; `fused` is `true` when a semantic ranking was successfully fused, `false` otherwise; `semantic` is `'ok'`, `'unavailable'`, or `'error'`. With `exactTitle`, the query is required but title matching uses NFC/case folding and collapsed separators over the full vault *before* the cap; this mode bypasses relevance/semantic ranking and still reports `total` and `truncated`. Use it for exact-title conflict checks, not broad recall. `maxResults` overrides the configured cap for this call. Entries that cannot be read (deleted mid-scan, permission denied) are skipped and logged rather than failing the call.
- `wiki_write(id, content, mode?, baseVersion?, requireExisting?)` — create or append to a note. Append mode preserves frontmatter and adds a timestamp header; both write modes normalize `created`/`updated` frontmatter values to `+08:00` second precision (unparseable values pass through). Passing a `version` from `wiki_read` as `baseVersion` makes the write fail loudly when another writer changed the note in between. Setting `requireExisting: true` makes the write update-only: the note must already exist, and a missing note fails instead of being created (no parent directory is left behind), so a caller that addressed the wrong id gets an error rather than a stray note. The result is `{ id, mode, bytes, version }`, where `version` fingerprints the bytes just published — feed it straight back as `baseVersion` on the next write to chain optimistic-concurrency checks without a `wiki_read` round-trip. Writing through an in-vault symlink updates the linked note and keeps the link (a broken link is refused), and atomic replacement carries the note's existing permission bits to the new file.
- `wiki_history(id, limit?)` — return the git commit history of one note as `{ commits: [{ hash, date, message, author }] }`, newest first. Requires a git repository inside the vault; the returned hashes can be passed to `wiki_restore`.
- `wiki_restore(id, hash, baseVersion)` — roll a note forward to the content of an earlier git commit without rewriting history. Requires the current `version` from `wiki_read` as `baseVersion`; a stale version fails closed. When `memory-git` is configured to handle `wiki_restore` (as in the Bundle), the restored state becomes a new forward commit; without that wrapper, it remains a working-tree write and the result does not claim `committed`.

### Security

All paths are resolved under the vault root for that call; a path that escapes the vault is rejected. Note ids are addressed with `/` only: an id containing a backslash is rejected with a structured error instead of being read as a platform-dependent separator, so the same id cannot name different files on different systems, and percent-encoding is never decoded, so `%2e%2e` is a literal name. `[[link]]` targets stay lenient where ids are strict — a target written with Windows-style separators resolves the same as its `/` form. In-vault symlinks are followed to their real target, which is re-checked for containment, so a symlinked note is appended through rather than replaced; a broken symlink is refused. Error messages stay vault-relative and never embed host paths. The plugin does not use `ctx.fs`, so the configured filesystem sandbox policy does not apply; vault access is governed by OS permissions and this containment check.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

This package is a single Cordis function plugin with no runtime service. It registers a read-only runtime-attestation tool plus the typed vault tools on `ctx.tools`. The vault root is resolved per tool call: the explicit `vaultRoot` config when set (relative paths anchor at the session workspace), otherwise `<session cwd>/.dsh/memory/` so each workspace owns its notes. Each tool reads Markdown files directly through `node:fs/promises` and stays inside the resolved root via `path.resolve` + prefix checking plus a realpath containment re-check. YAML frontmatter is parsed with `js-yaml` (a leading UTF-8 BOM before the opening `---` is tolerated, and duplicate keys resolve last-one-wins instead of dropping the block); `[[link|alias]]` references extract the target before the pipe; `[[...]]` inside inline code spans or fenced code blocks is documentation, not a link, and is ignored. Link targets resolve Obsidian-style against the indexed note ids: an exact vault-relative path first, then a path-suffix match (`[[notes/foo]]` finds `shared/notes/foo.md`), then a basename match anywhere in the vault — each tier tolerates the target carrying or omitting the extension. Ambiguous matches pick the fewest path segments, then the lowest id in code-point order, so resolution is deterministic across platforms, and Windows-style separators in a link target normalize to `/` the same way the resolver's own normalization does. Note ids, by contrast, reject a backslash outright, so the strict and lenient sides of the rule never disagree about which file a name denotes. Search builds a transient index from the vault contents and ranks it in layers: OR-matched field-weighted scoring (id/title ×3, backlinks ×1, body ×1, with IDF so rare terms weigh more and BM25 saturation plus length normalization so long notes do not dominate), a verbatim-phrase bonus, and a graph boost for notes linked from strong hits. When `wiki_semantic_search` is registered, its ranking is fused in via reciprocal rank fusion; semantic failures fall back to the lexical ranking. The transient index skips entries that cannot be read (each logged as a warning) so one bad file cannot fail a scan. `wiki_write` publishes atomically: the body is staged in a sibling temp file and `rename`d over the target, so concurrent readers never observe a partially written note; the staged file inherits the target's permission bits and is removed again if staging or rename fails.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `memory_runtime_info`, `wiki_read`, `wiki_search`, and `wiki_write` schemas. Their descriptions tell the model that notes are Markdown files with YAML frontmatter and Obsidian-style `[[link]]` references, and that `wiki_read` follows links up to the configured depth.

##### Verbatim description for `wiki_read`

```markdown
Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, linked notes, mtime, and a modifiedExternally flag that is true when the file changed on disk since this tool last observed it.
```

##### Verbatim description for `wiki_search`

```markdown
Search the wiki vault by note title or body keyword. Terms are OR-matched; results are ranked by field-weighted relevance (title/id hits outrank body hits, rare terms weigh more, notes linked from strong hits get a boost, and results may be fused with semantic search when available). Returns { hits, total, truncated }: each hit carries the note id, title, score, and backlinks, total counts every match before the result cap, and truncated is true when that cap cut the list. Use this before asking the user which note to read.
```

##### Verbatim description for `wiki_write`

```markdown
Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header. Set requireExisting to update a note that must already exist: the write then fails instead of creating a new note. Returns { id, mode, bytes, version }, where version fingerprints the written content and can be passed as baseVersion on the next write without reading the note again.
```

#### Token effect

`wiki_read` returns the full body of the requested note plus every linked note reachable within `maxLinkDepth`. Long notes or dense link graphs can add many tokens to the next request. `wiki_search` returns a bounded list of result metadata only; its `total` reports matches beyond the cap without returning them.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No sandbox policy integration** — the plugin reads files directly, so it bypasses the `ctx.fs` sandbox and approval gates. A future provider could delegate reads to `ctx.fs` to inherit policy.
- **No vector search** — search is keyword-only. A separate `tool-memory-vector` package could add embedding-based retrieval without changing this package.
- **No embedded image or binary support** — notes are treated as UTF-8 text. Attachments should remain in the attachment seam.
- **No built-in write coordination** — writes are atomic (temp file + `rename`), so readers never see partial files, but simultaneous `wiki_write` calls to the same note can still lose updates. Cooperative callers can pass `baseVersion` to turn a lost update into a loud conflict; mount `@jacklika/dsh-memory-queue` for in-process serialization, optionally with a heartbeat-refreshed cross-process lock.
- **Unreadable entries are skipped, not surfaced as data** — a note or directory the process cannot read is omitted from read, search, and linked-note results and reported only through a logger warning; the tool result itself does not list what was skipped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
