# mydsh-plugin

DeepSeek Harness plugin suite: the memory vault chain plus future plugin packs.

## Packages

| Package | Role |
|---|---|
| `@jacklika/dsh-tool-memory-filesystem` | `wiki_read` / `wiki_search` / `wiki_write` tools over an Obsidian-compatible Markdown vault |
| `@jacklika/dsh-tool-memory-graph` | `wiki_graph` link-graph queries over the vault |
| `@jacklika/dsh-tool-memory-vector` | `wiki_semantic_search` embedding search (needs an OpenAI-compatible endpoint) |
| `@jacklika/dsh-memory-scope` | Rewrites `wiki_write` ids into per-agent `agents/<key>/` namespaces |
| `@jacklika/dsh-memory-queue` | Serializes writes with a cross-process `mkdir` lock |
| `@jacklika/dsh-memory-git` | Commits `shared/` writes to the vault's own git repo |
| `@jacklika/dsh-memory` | Profile bundle mounting the whole chain in waterfall order |

## Use in a dsh profile

Add the bundle after `@deepseek-ai/dsh-base` in the profile's `dsh.profile.bundles`, or insert the plugin rows from a profile `cordis.patch.yml`:

```yaml
- insert:
    - id: memory-scope
      name: '@jacklika/dsh-memory-scope'
    - id: memory-queue
      name: '@jacklika/dsh-memory-queue'
      config: { crossProcessLock: true, laneArgument: id }
    - id: memory-git
      name: '@jacklika/dsh-memory-git'
    - id: tool-memory-filesystem
      name: '@jacklika/dsh-tool-memory-filesystem'
    - id: tool-memory-graph
      name: '@jacklika/dsh-tool-memory-graph'
```

Install into a profile with `dsh plugin --profile <name> add <package>` or `pnpm add` inside the profile directory. `@deepseek-ai/*` peers resolve from the dsh installation at runtime.

## Develop

```sh
pnpm install
pnpm test
```

New plugins: add a directory under `packages/`, name it `@jacklika/dsh-<name>`, export `name`/`inject`/`Config`/`apply`, and register a `paths` alias in `tsconfig.base.json`.
