---
description: "Re-injects the session task list into every prompt through the tools/execute waterfall and a dynamic prompt context, so a list written once cannot silently go stale."
kind: "package-reference"
---

# @jacklika/dsh-todo-anchor

English | [中文](README.zh.md)

## Summary

`dsh-todo-anchor` keeps the session task list visible for the whole task. `todo_write` replaces the entire list, no tool reads it back, and nothing in the Harness re-injects it, so a list written once at the start keeps claiming whatever it said last, and a resumed, forked, or compacted session can lose even that. The plugin observes successful dispatches of the configured tool, remembers the entry array, and contributes it as dynamic runtime context — the one channel the Harness re-renders into every prompt and marks as superseding earlier snapshots. It registers no tools of its own and writes nothing to disk.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount beside the prompt and tool registries, before the tool that owns the list:

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@jacklika/dsh-todo-anchor'
```

### Configure the anchor

| Field | Type | Default | Description |
|---|---|---|---|
| `toolName` | string | `todo_write` | Tool whose successful dispatches refresh the anchored list. |
| `todosArgument` | string | `todos` | Argument of that tool carrying the entry array. Verified against `@deepseek-ai/dsh-tool-todo`, which declares `todos` as a required array of `{content, status}` objects; a mismatch throws rather than silently disabling the anchor. |
| `contextName` | string | `todo-anchor:list` | Name of the registered dynamic prompt context. |
| `order` | number | `130` | Placement among dynamic contexts. The Harness reserves 110–120 for sandbox policy, approval policy, and subagent delegation. |
| `reminder` | boolean | `true` | Render the write-back rule alongside the list. |
| `maxItems` | number | `50` | Cap on rendered entries; later entries collapse into a count. |

<a id="understand-the-implementation"></a>
## Understand the implementation

Two registrations, both disposed with the Loader fiber:

- A **`tools/execute` waterfall listener** — the same seam `dsh-memory-git` uses to commit writes. It calls `next()` first, returns immediately unless the dispatch succeeded and named the configured tool, then reads the entry array out of `exec.arguments`. A failed dispatch is never anchored, so the plugin cannot adopt a list the registry rejected.
- A **dynamic prompt context** (`ctx.systemPrompt.context`), whose `text` is a function the Harness evaluates on every prompt assembly. That is what makes the list survive compaction: the rendered snapshot is explicitly labelled as superseding earlier runtime-context snapshots, so the current list always outranks a summary that predates it.

The ordering is deliberate. The listener only observes; it never rewrites the tool result, and it never touches the vault.

<a id="model-experience"></a>
## Model Experience

The model receives no new tool and no change to `todo_write`. What changes is the runtime context of every request after the first write:

```
Current task list (kept in sync by the `todo_write` tool).

- [x] audit the parser
- [~] fix the CRLF path
- [ ] write the regression test

Re-write this list as soon as an item completes. It is a progress display, not a record:
no tool reads it back and nothing else re-injects it, so a list left stale is
indistinguishable from real progress. Durable decisions belong in the memory Vault.
```

The trailing Vault sentence is emitted only when a vault tool (`wiki_write` or `memory_capture`) is registered — checked at each assembly — so a deployment without `@jacklika/dsh-memory` never points the model at tools that do not exist.

An empty list renders `''`, which the Harness drops, so a session that never wrote a task list is unaffected.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Per-session lists, in-process only.** Lists are keyed by `exec.agent.id` — the session id the agent loop stamps on every dispatch — so concurrent sessions never see each other's lists, and a resumed session keeps its identity even when the live agent object is rebuilt. A scope-less assembly (host without per-agent assembly) falls back to the most recent write. The map still lives in process memory: a `todo_read` tool would remove the need for this plugin entirely, because the list could be read back on demand instead of mirrored.
- **Schema-checked, fail-loud.** At activation — or on the first matching dispatch, if the tool registered later — the plugin compares `todosArgument` against the tool's compiled parameter schema and throws when they disagree. A renamed argument therefore breaks the dispatch with an explicit error instead of anchoring nothing.
- **Display, not record.** The list is process state: it does not survive a host restart, and it is not a substitute for a Vault note. The reminder says so, and the durable half of progress tracking belongs to `@jacklika/dsh-memory`.
- **Staleness is reduced, not eliminated.** Re-injection makes an out-of-date list *visible* on every turn; only the model re-writing it makes the list *correct*.

<a id="dev-note"></a>
## Dev Note

`tests/render.spec.ts` covers the renderer as a pure function. `tests/loader-composition.spec.ts` boots the real Loader next to the real prompt and tool registries, registers a stub `todo_write`, dispatches it, and asserts against `renderContextSnapshot(await ctx.systemPrompt.assemble())` — the same text the Harness puts in the next prompt.
