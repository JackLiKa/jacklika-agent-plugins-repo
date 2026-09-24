# mydsh-plugin

DeepSeek Harness plugin suite: the memory vault chain plus future plugin packs. See [docs/](docs/README.md) ([中文](docs/README.zh.md)) for suite-level documentation.

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
| `@jacklika/dsh-memory-mcp` | Zero-dependency MCP stdio server exposing the vault to any MCP client (single-writer semantics) |

## Skills

| Skill | Role |
|---|---|
| `skills/memory-vault` | Teaches agents the vault workflow: when to read/write, safe `baseVersion` writes, namespace semantics, linking conventions |

Mount it through `skill-filesystem` in a profile `cordis.patch.yml`:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['/path/to/mydsh-plugin/skills']
```

## Three-layer robustness

The suite is designed as three complementary layers:

- **Skill** (`skills/memory-vault`): teaches the model *how and when* to use memory — read-before-write, `baseVersion` conflict retry, `shared/` versus `agents/<key>/` placement.
- **Tool calling** (`@jacklika/dsh-tool-memory-*` + `dsh-memory-*`): native dsh tools with queue locking, per-agent namespaces, atomic writes, and git history on `shared/`.
- **MCP** (`@jacklika/dsh-memory-mcp`): the same vault over standard stdio MCP for non-dsh clients — one server process owns all writes.

All paths converge on one local Markdown vault; there is no network listener and no telemetry.

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
