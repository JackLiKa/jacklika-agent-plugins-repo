# Usage

## Install into a dsh profile

```sh
# creates the profile if absent, installs the bundle, appends it to dsh.profile.bundles
dsh plugin --profile <name> add /path/to/mydsh-plugin/packages/memory
```

Then ensure the profile's `bundles` also contain an app layer (e.g. `@deepseek-ai/dsh-headless`) and launch:

```sh
dsh --profile <name> "<task>"
```

After publishing to npm, replace the local path with `@jacklika/dsh-memory`; usage is identical.

## Mount the skill

In the profile's `cordis.patch.yml`:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['/path/to/mydsh-plugin/skills']
```

The `memory-vault` skill then appears in the agent's skill catalog and teaches it the vault workflow.

## Tool reference

| Tool | Package | Purpose |
|---|---|---|
| `wiki_read` | `dsh-tool-memory-filesystem` | Read a note; returns frontmatter, body, `[[links]]`, `version`, linked notes |
| `wiki_search` | `dsh-tool-memory-filesystem` | Keyword search over titles/bodies |
| `wiki_write` | `dsh-tool-memory-filesystem` | Append (default) or overwrite; `baseVersion` for optimistic concurrency |
| `wiki_graph` | `dsh-tool-memory-graph` | Full vault link graph or a `depth`-bounded subgraph around one note |
| `wiki_semantic_search` | `dsh-tool-memory-vector` | Embedding search; disabled until an OpenAI-compatible endpoint is configured |

Coordination plugins register no tools; they decorate `wiki_write`:

| Plugin | Config highlights |
|---|---|
| `dsh-memory-scope` | `sharedPrefixes` (default `['shared/']`), `role: curator` |
| `dsh-memory-queue` | `crossProcessLock`, `laneArgument: id` |
| `dsh-memory-git` | `prefixes` (default `['shared/']`), `nestedRepo: init \| inherit \| own` (default `init`) |

## Typical model-side flow

1. `wiki_search "RAG"` → find candidate notes.
2. `wiki_read "concepts/RAG.md"` → keep the returned `version`.
3. `wiki_write(id, content, baseVersion)` → on conflict error, re-read and retry.
