# Usage

## Install into a dsh profile

```sh
# 1. creates the profile if absent, installs the bundle, appends it to dsh.profile.bundles
dsh plugin --profile <name> add /path/to/mydsh-plugin/packages/memory

# 2. local development only: link every suite package into the profile so the
#    bundle's cordis.patch.yml can resolve them (`link:` installs no deps)
cd ~/.dsh/profiles/<name>
pnpm add /path/to/mydsh-plugin/packages/tool-memory-filesystem \
         /path/to/mydsh-plugin/packages/tool-memory-graph \
         /path/to/mydsh-plugin/packages/tool-memory-vector \
         /path/to/mydsh-plugin/packages/memory-scope \
         /path/to/mydsh-plugin/packages/memory-queue \
         /path/to/mydsh-plugin/packages/memory-git
```

Then ensure the profile's `bundles` also contain an app layer (e.g. `@deepseek-ai/dsh-headless`) and launch:

```sh
dsh --profile <name> "<task>"
```

Local development requires `pnpm build` in this repository first — packages resolve to `lib/` output; suite-internal `devDependencies` `link:` to a local deepseek-harness checkout, so edit those paths if your checkout lives elsewhere. After publishing to npm, `dsh plugin --profile <name> add @jacklika/dsh-memory` suffices — real dependencies install normally and step 2 disappears.

## Uninstall

```sh
cd ~/.dsh/profiles/<name>
pnpm remove @jacklika/dsh-memory @jacklika/dsh-memory-git @jacklika/dsh-memory-queue \
            @jacklika/dsh-memory-scope @jacklika/dsh-tool-memory-filesystem \
            @jacklika/dsh-tool-memory-graph @jacklika/dsh-tool-memory-vector
```

Then delete `"@jacklika/dsh-memory"` from `dsh.profile.bundles` in the profile `package.json`. The vault under `.dsh/memory/` is left untouched — delete it manually if unwanted.

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
| `dsh-memory-scope` | `sharedPrefixes` (default `['shared/']`), `role: curator`, `agentKey` (empty = per-session namespace) |
| `dsh-memory-queue` | `crossProcessLock`, `laneArgument: id` |
| `dsh-memory-git` | `prefixes` (default `['shared/']`), `nestedRepo: init \| inherit \| own` (default `init`) |

## Typical model-side flow

1. `wiki_search "RAG"` → find candidate notes.
2. `wiki_read "concepts/RAG.md"` → keep the returned `version`.
3. `wiki_write(id, content, baseVersion)` → on conflict error, re-read and retry.
