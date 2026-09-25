---
description: "The dsh memory bundle: an Obsidian-compatible Markdown vault with per-agent write namespaces, serialized writes, and git history layered over dsh-base."
kind: "package-bundle"
---

# @jacklika/dsh-memory

English | [中文](README.zh.md)

## Summary

`dsh-memory` is the external Profile Bundle that mounts the complete memory chain — an Obsidian-compatible Markdown vault plus its write coordination — after `dsh-base`. Install this one package into a custom Profile; its runtime dependencies bring every member plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the Bundle through the Harness Plugin Manager; the Profile may already exist or be created by the command:

```sh
dsh plugin --profile memory add @jacklika/dsh-memory@0.1.7-rc.2
```

Keep the Bundle after `dsh-base` and include an application layer such as `dsh-headless` or `dsh-web-app`. Semantic search stays disabled until the profile patch supplies an embeddings endpoint:

```yaml
- id: tool-memory-vector
  disabled: false
  config:
    endpoint: http://localhost:11434/v1/embeddings
    model: nomic-embed-text
```

The vault defaults to `<session cwd>/.dsh/memory/`; override `vaultRoot` on `tool-memory-filesystem`, `memory-queue`, or `memory-git` from the profile patch.

<a id="understand-the-implementation"></a>
## Understand the implementation

The bundle's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest field. Its insert list mounts the write ladder in waterfall order:

1. `memory-scope` rewrites private `wiki_write` ids into `agents/<agent key>/` namespaces so agents cannot collide by construction; `shared/` prefixes pass through.
2. `memory-queue` serializes surviving same-lane writes with an `mkdir` lock and heartbeat-counter liveness, so separate processes cannot interleave.
3. `memory-git` commits `shared/` writes inside the lock; `nestedRepo: 'init'` keeps vault history in the vault's own `.git`, never the enclosing project repo.
4. `tool-memory-filesystem` owns the vault: `wiki_read`, `wiki_search`, `wiki_write` with atomic publication and optional `baseVersion` conflict detection.
5. `tool-memory-graph` adds `wiki_graph` link-graph queries.

`tool-memory-vector` ships disabled because it requires an external embeddings endpoint. All git commits are local; nothing pushes.

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The bundle itself adds no request prefix; each inserted row's package owns any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Scope, queue locks, and version checks are advisory: writers outside the waterfall (shell, Obsidian, other processes) bypass them; atomic rename and `baseVersion` bound the damage.
- Write scope is partition-only: every agent can read the whole vault, including other agents' namespaces.
- `tool-memory-vector` needs an external embeddings endpoint; enabling it sends note content to that endpoint.
- Git history has no read/rollback tool yet; use `git` directly in the vault.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
