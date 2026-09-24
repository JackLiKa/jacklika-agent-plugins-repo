---
description: "Commits successful memory-tool writes to git through the tools/execute waterfall — opt-in version history, rollback, and audit for the vault."
kind: "package-reference"
---

# @jacklika/dsh-memory-git

English | [中文](README.zh.md)

## Summary

`dsh-memory-git` turns matching tool writes — `wiki_write` by default — into git commits through the `tools/execute` waterfall. Each successful write is staged and committed inside the vault, so the memory store gains version history, rollback, and per-write audit without changing `dsh-tool-memory-filesystem`. Commits are limited to configured id prefixes — `shared/` by default — so curated knowledge is versioned while per-agent namespaces stay unversioned. The plugin registers no tools of its own and requires a `git` binary on `PATH`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount after `dsh-memory-queue` so commits run inside the vault lock:

```yaml
- name: '@jacklika/dsh-memory-queue'
  config:
    crossProcessLock: true
- name: '@jacklika/dsh-memory-git'
- name: '@jacklika/dsh-tool-memory-filesystem'
```

### Configure the git layer

| Field | Type | Default | Description |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | Tool names whose successful dispatches are committed. |
| `idArgument` | `string` | `'id'` | Argument carrying the vault-relative note id. |
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | Repository working tree; same per-call resolution as the memory tools. |
| `prefixes` | `string[]` | `['shared/']` | Only ids under these prefixes are committed; `[]` commits every write. |
| `nestedRepo` | `'init' \| 'inherit' \| 'own'` | `'init'` | `init`: vault owns its `.git`, never joining an enclosing repo. `inherit`: join the nearest enclosing repo (init only when none exists). `own`: require an existing `<vault>/.git`, fail otherwise. |
| `autoInit` | `boolean` | `true` | Permit `git init` when the selected `nestedRepo` mode allows it. |
| `authorName` / `authorEmail` | `string` | `dsh-memory-git` / `dsh-memory-git@localhost` | Commit identity passed via `git -c`. |
| `commitPrefix` | `string` | `'wiki_write'` | Commit message prefix; the note id follows it. |
| `indexLockRetries` / `indexLockRetryMs` | `number` | `30` / `100` | Retries when `.git/index.lock` is held by another git process. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin installs one `ctx.on('tools/execute', …)` waterfall listener that runs `next()` first and commits only on success. Repository selection follows `nestedRepo`: `init` (default) checks `<vault>/.git` directly and creates it under `autoInit`, so a vault inside a git-managed workspace never leaks commits into the enclosing project; `inherit` resolves `rev-parse --git-dir` upward and joins the nearest enclosing repo; `own` fails when `<vault>/.git` is absent. The commit sequence is `status --porcelain -- <id>` (clean → skip so no empty commits), `add -- <id>`, then `commit -m "<commitPrefix>: <id>" -- <id>` with the pathspec limiting the record to the written note. All git calls serialize on one in-process chain and retry only on a held `index.lock`. A failed commit fails the dispatch result even though the note was written; the divergence is surfaced rather than hidden.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tools, prompts, or results of its own — it adds a durable side effect to dispatches other packages own.

#### KV Cache effect

The wrapper does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Commits only mount-mounted writers** — a writer outside the waterfall (shell command, unmounted process, manual Obsidian edit) leaves uncommitted changes in the working tree; periodic `git status` sweeps or a CI hook are deferred.
- **Merge conflicts surface as errors** — two repositories syncing the same vault still need git-level merge handling; the plugin deliberately performs no fetch/pull/merge.
- **Requires `git` on `PATH`** — environments without a git binary fail the dispatch loudly at the first matching write.
- **Per-write commits can be noisy** — high-frequency append flows produce one commit per call; squash or checkpoint strategies are deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
