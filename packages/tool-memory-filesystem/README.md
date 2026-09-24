---
description: "Model-facing wiki/memory tools over a local Markdown vault with Obsidian-style links and YAML frontmatter."
kind: "package-reference"
---

# @jacklika/dsh-tool-memory-filesystem

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory-filesystem` gives agents read, search, and append access to a local Markdown vault. Notes are ordinary `.md` files with optional YAML frontmatter and Obsidian-style `[[link]]` references. A deployment mounts this package as a Cordis plugin; by default each session reads and writes notes under its own workspace at `<session cwd>/.dsh/memory/`, so every project keeps a private memory store. An explicit `vaultRoot` can pin one shared vault instead. The model sees `wiki_read`, `wiki_search`, and `wiki_write` tools. No vector database is required — the MVP uses filename and keyword search, with link following for contextual completeness.

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
| `extensions` | `string[]` | `['.md']` | File extensions treated as notes. |
| `maxLinkDepth` | `number` | `1` | Maximum `[[link]]` hops `wiki_read` resolves. |
| `maxSearchResults` | `number` | `20` | Maximum `wiki_search` hits. |
| `indexHiddenDirs` | `boolean` | `false` | Index directories whose names start with `.` (`.git` and `node_modules` stay excluded). Enable when `vaultRoot` points at the workspace root so `.dsh/memory/` notes are included. |

### Tools

- `wiki_read(id)` — read one note by vault-relative path and return its frontmatter, body, links, linked notes, and a `version` content fingerprint.
- `wiki_search(query)` — keyword search across note titles, ids, and bodies; results include backlink counts.
- `wiki_write(id, content, mode?, baseVersion?)` — create or append to a note. Append mode preserves frontmatter and adds a timestamp header. Passing a `version` from `wiki_read` as `baseVersion` makes the write fail loudly when another writer changed the note in between.

### Security

All paths are resolved under the vault root for that call; a path that escapes the vault is rejected. The plugin does not use `ctx.fs`, so the configured filesystem sandbox policy does not apply; vault access is governed by OS permissions and this containment check.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

This package is a single Cordis function plugin with no runtime service. It registers three typed tools on `ctx.tools`. The vault root is resolved per tool call: the explicit `vaultRoot` config when set (relative paths anchor at the session workspace), otherwise `<session cwd>/.dsh/memory/` so each workspace owns its notes. Each tool reads Markdown files directly through `node:fs/promises` and stays inside the resolved root via `path.resolve` + prefix checking. YAML frontmatter is parsed with `js-yaml`; `[[link|alias]]` references extract the target before the pipe. Search builds a transient index from the vault contents and sorts hits by backlink count. `wiki_write` publishes atomically: the body is staged in a sibling temp file and `rename`d over the target, so concurrent readers never observe a partially written note.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`wiki_read`, `wiki_search`, and `wiki_write` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory-filesystem). Their descriptions tell the model that notes are Markdown files with YAML frontmatter and Obsidian-style `[[link]]` references, and that `wiki_read` follows links up to the configured depth.

##### Verbatim description for `wiki_read`

```markdown
Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, and linked notes.
```

##### Verbatim description for `wiki_search`

```markdown
Search the wiki vault by note title or body keyword. Returns matching note ids, titles, and backlink counts. Use this before asking the user which note to read.
```

##### Verbatim description for `wiki_write`

```markdown
Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header.
```

#### Token effect

`wiki_read` returns the full body of the requested note plus every linked note reachable within `maxLinkDepth`. Long notes or dense link graphs can add many tokens to the next request. `wiki_search` returns a bounded list of result metadata only.

#### KV Cache effect

Independent. The plugin only supplies tool results; it does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No sandbox policy integration** — the plugin reads files directly, so it bypasses the `ctx.fs` sandbox and approval gates. A future provider could delegate reads to `ctx.fs` to inherit policy.
- **No vector search** — search is keyword-only. A separate `tool-memory-vector` package could add embedding-based retrieval without changing this package.
- **No embedded image or binary support** — notes are treated as UTF-8 text. Attachments should remain in the attachment seam.
- **No built-in write coordination** — writes are atomic (temp file + `rename`), so readers never see partial files, but simultaneous `wiki_write` calls to the same note can still lose updates. Cooperative callers can pass `baseVersion` to turn a lost update into a loud conflict; mount `@jacklika/dsh-memory-queue` for in-process serialization, optionally with a heartbeat-refreshed cross-process lock.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
