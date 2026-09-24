---
description: "Partitions memory-tool write ids into per-agent namespaces through the tools/execute waterfall — opt-in collision prevention for multi-agent vaults."
kind: "package-reference"
---

# @jacklika/dsh-memory-scope

English | [中文](README.zh.md)

## Summary

`dsh-memory-scope` rewrites the id argument of configured tools — `wiki_write` by default — to `agents/<agent key>/<id>` through the `tools/execute` waterfall. Distinct agents therefore write distinct notes by construction instead of contending for one file. Ids under `sharedPrefixes` pass through untouched, forming a shared zone that `@jacklika/dsh-memory-queue` or a curator agent arbitrates. Read and search tools are untouched: every agent still sees the whole vault. The plugin registers no tools of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount in front of the memory filesystem plugin:

```yaml
- name: '@jacklika/dsh-memory-scope'
- name: '@jacklika/dsh-tool-memory-filesystem'
- name: '@jacklika/dsh-memory-queue'   # optional: arbitrates shared/ writes
  config:
    crossProcessLock: true
    laneArgument: id
```

A curator deployment that consolidates `agents/*` notes into `shared/` mounts the plugin with `role: curator` so its writes are never rewritten.

### Configure the scope

| Field | Type | Default | Description |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | Tool names whose id argument is namespaced. |
| `idArgument` | `string` | `'id'` | Argument carrying the vault-relative note id. |
| `scopePrefix` | `string` | `'agents'` | Top-level vault directory holding every agent namespace. |
| `sharedPrefixes` | `string[]` | `['shared/']` | Id prefixes forming the shared zone; matching ids are not rewritten. Each entry must end with `/`. |
| `role` | `'scoped' \| 'curator'` | `'scoped'` | `curator` disables rewriting so the deployment writes the shared zone directly. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin installs one `ctx.on('tools/execute', …)` waterfall listener. For a matching call it reads the `idArgument` value, skips ids already under a shared prefix or the caller's own namespace, derives a path-safe key from `exec.agent.id`, and re-dispatches the call through `ctx.tools.execute` with the id rewritten to `<scopePrefix>/<key>/<id>`. Re-dispatch is required because parsed arguments are deep-frozen before wrappers run; the nested execution inherits `rootCallId`, marks `parent`, and mints a `<callId>:scoped` call id, so the durable log records the real on-disk id. Calls without an agent, without a string id, or under the `curator` role pass straight to `next()`.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `wiki_write`, whose id argument the wrapper rewrites to `agents/<key>/<id>` so the tool result reports the on-disk path rather than the requested one.

#### KV Cache effect

The wrapper does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Scoping is advisory** — a tool not listed in `toolNames`, or a writer outside the waterfall (shell command, unmounted process), can still write any path; the shared zone needs `@jacklika/dsh-memory-queue` for real arbitration.
- **Writes are scoped, reads are not** — every agent can read and search the whole vault including other agents' namespaces; per-agent read isolation is deferred.
- **Namespace key follows the session id** — resumed or forked sessions keep their own key only when the runtime preserves `exec.agent.id`; non-agent calls pass through unscoped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
