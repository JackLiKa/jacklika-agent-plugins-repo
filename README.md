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

## Install

The formal entry is the Bundle package, not the monorepo root:

```sh
dsh plugin --profile memory add @jacklika/dsh-memory@0.1.7-rc.1
dsh --profile memory --dump-config
```

The Bundle installs all six runtime members and must follow `@deepseek-ai/dsh-base`; the Profile also needs an application layer. The suite is a private plugin package and is not published to a public registry, so install it from a checkout: run `pnpm build`, then pass an absolute path to `packages/memory` — see [Private and local installation](docs/usage.md#private-and-local-installation). `pnpm test:profile` remains the reproducible tarball-level installation test. See [Install and use](docs/usage.md) for registry, private, and local paths, PowerShell, Skill, enable/disable, and uninstall instructions, and [Compatibility](docs/compatibility.md) for exact verified versions.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:pack
pnpm test:profile
```

New plugins: add a directory under `packages/`, name it `@jacklika/dsh-<name>`, export `name`/`inject`/`Config`/`apply`, and register a `paths` alias in `tsconfig.base.json`.
