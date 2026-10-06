---
description: "Upstream requests for DeepSeek Harness: a todo_read tool or per-turn todo injection, and a documented session identity on tools/execute dispatches."
kind: "upstream-request"
---

# Harness todo gaps — upstream requests

Drafted for the DeepSeek Harness maintainers. Three requests around the task-list seam, ordered by how much they would simplify downstream plugins.

## Request 1: a `todo_read` tool

`todo_write` is a whole-list replace (`dsh-tool-todo` appends a `todo/write` session event validated as `{content, status}[]`, and the `todos` session projection folds it). Nothing reads the list back to the model:

- no `todo_read` tool exists anywhere in the Harness;
- the `todos` session projection has a `wire.view`, but it serves client UIs, not the model;
- the projection's `apply` resets the state to `null` on `turn/start`, so even a host-side reader loses the list between turns.

## Request 2: inject the current list into the system prompt

`@deepseek-ai/dsh-system-prompt` contains zero todo contributions. Since the list is already a session projection, contributing it as dynamic runtime context on every assembly would make the current state visible for free — including after compaction, fork, and resume, where a stale summary is the only trace left today.

Either of requests 1–2 removes the need for `@jacklika/dsh-todo-anchor`, which mirrors successful `todo_write` dispatches into a dynamic prompt context.

## Request 3: document `exec.agent` on `tools/execute` dispatches

`tools/execute` executions do carry a session identity — `exec.agent.id` is the session id (the desk-era shape used `agent.sessionId`), and `assembleContextFor` passes the same agent as the assembly `scope`. But `agent` is optional on `ToolExecutionInput`, the public `Agent` type guarantees only `id`, and nothing documents that the dispatch-to-assembly identity chain is stable. Asking for a documented contract — "an agent-scoped dispatch always carries `exec.agent.id`, and the matching assembly receives that agent as `context.scope`" — would let observers key state per session without defensive probing.

## Evidence

- `dsh-session-format-*` validates `"todo/write": disposition(["todos"])` with `{content, status}` items.
- `dsh-tool-todo` registers `todo_write` with `parameters.todos` (required array of `{content, status}` objects, `additionalProperties: false`) and the `todos` projection; it has no read path.
- `dsh-system-prompt` has no todo reference; `dsh-session-projection` has no todo reader for models.
- `dsh-tool-todo`'s projection resets on `turn/start`, so the projection is a UI surface, not durable model-facing state.

## Impact

Without a read path, a list lost to compaction, resume, or a model switch is unrecoverable inside the session — the model cannot distinguish "no list" from "lost list". Without injection, a stale list is invisible: the model never learns its last write is out of date. Without documented `exec.agent` identity, per-session observers (anchors, audit trails, scoped side effects) must guess at which fields are stable across releases.
