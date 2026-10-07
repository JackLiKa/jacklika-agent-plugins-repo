# Compatibility

## Verified baseline

| Component | Declared range | Verified baseline |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | Local: 22.23.2; CI covers 22.19.0 and current 24.x on Linux, macOS, and Windows |
| pnpm | repository development uses 11.7.0 | 11.7.0 |
| DeepSeek Harness packages | `>=0.1.7-rc.1 <0.3.0-0 || >=0.2.0-rc.1 <0.3.0-0` peers | `0.1.7-rc.10` and `0.2.0-rc.1` each ran the full suite; the two LLM provider adapters were absorbed after that split and are verified on `0.2.0-rc.1` |
| Cordis | exact `4.0.4` peer | 4.0.4 |
| Git | `git` must be on `PATH`; the plugin uses `-C`, `init`, `rev-parse`, `status`, `add`, and `commit` | Local: Apple Git 2.50.1; CI uses each runner's Git |

The Harness peer range is bounded rather than exact, deliberately. Harness APIs are pre-stable, and the desktop application updates itself, so an exact peer converts every unrelated release into a load-time refusal even when the plugin is compatible—it did so twice while this suite was being verified. A range keeps the protection that matters: the next release line is still rejected before code loads, because `>=0.1.7-rc.1 <0.3.0-0 || >=0.2.0-rc.1 <0.3.0-0` admits only the 0.1.x and 0.2.x lines (from `0.1.7-rc.1` onward) and explicitly excludes every prerelease of 0.3.x. That "only 0.1.x/0.2.x" property holds under the `includePrerelease` semantics the Harness runtime validates with; package managers resolve peers under default semantics, where a prerelease can only match a comparator carrying a prerelease at the same major.minor.patch — so a second branch exists purely for npm/pnpm resolution, and whenever the verified line moves (for example to `0.2.1-rc.x`) a sibling branch with the same tuple must be added. The `-0` suffix is necessary because semver with `includePrerelease` would otherwise treat `0.3.0-rc.1` as satisfying `<0.3.0`. Every release inside the window must pass the full CI and the independent Profile installation tests before it joins the window, and widening the window past the verified line needs the same evidence. “Allowed” and “verified” therefore name the same window today.

Harness checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer before registry installation and again before Profile composition. This suite declares that bounded range for the Bundle, so a runtime outside the verified line is rejected before code loads. Harness has an explicit exact-version `allow-version --accept-risk` exemption, but it is an emergency user decision—not an installation step for this suite. A runtime outside the window must normally be fixed by verifying it and moving the window.

## Imported Harness APIs

| Plugin packages | Imports |
|---|---|
| all Cordis plugins | `Context` from `@deepseek-ai/cordis`; Schemastery config from `@deepseek-ai/schemastery` |
| scope | `ToolCallId` from `@deepseek-ai/dsh-llm`; `ToolDispatchExecution`, `ToolExecutionResult`, and `ctx.tools.execute` from `@deepseek-ai/dsh-tools` |
| queue and git | `ToolExecutionResult` and the `tools/execute` waterfall from `@deepseek-ai/dsh-tools` |
| filesystem, graph, vector, curator | `defineTool` / `ToolRunContext` from `@deepseek-ai/dsh-tools`; filesystem, graph, and curator also use `JsonValue` from `@deepseek-ai/dsh-util-values` |
| todo-anchor | `ToolExecutionResult` and the `tools/execute` waterfall from `@deepseek-ai/dsh-tools`; `ctx.systemPrompt.context` from `@deepseek-ai/dsh-system-prompt` |
| memory-anchor | `ctx.systemPrompt.context` from `@deepseek-ai/dsh-system-prompt`; `ToolCallId` from `@deepseek-ai/dsh-llm`; `ToolExecutionInput`, `ctx.tools.get`, and `ctx.tools.execute` from `@deepseek-ai/dsh-tools`; `formatBeijingTime` from `@jacklika/dsh-memory-time`; the Cordis `session/event` feed (no import — plain `ctx.on`) |
| devin-bridge, llm-qoder | `LlmAdapter`, `LlmError`, `ToolCallId`, `ReasoningEffortId` and the registration seams (`ctx.llm.registerAdapter`, `registerConfigurableProviders`, `registerModelDiscovery`) from `@deepseek-ai/dsh-llm`; the `attachments` service from `@deepseek-ai/dsh-attachment` |

The Bundle itself contains only a Cordis patch and runtime dependencies on the member packages. The two provider adapters are standalone: each ships its own `cordis.patch.yml` and is mounted directly, never through the Bundle.

## Harness seams this suite depends on

| Seam | Used by | Contract relied on |
|---|---|---|
| `tools/execute` waterfall | scope, queue, git, todo-anchor; memory-anchor as a caller | A listener calls `next()` and may read `exec.name` / `exec.arguments` afterwards. todo-anchor treats an error result as "not written" and never anchors it. memory-anchor re-enters the pipeline for its auto-capture write, carrying the session's own agent, so the scope, queue, and git layers observe an automatic write exactly as they observe a model-issued one; a plugin-issued call has no `parent` token, so under `mode: 'ptc'` it collapses to `UNKNOWN_TOOL` and the anchor records the turn as unwritten rather than warning. |
| `ctx.systemPrompt.context` | todo-anchor | Registers ordered dynamic runtime context. `text` may be a function, evaluated on every prompt assembly; a zero-length result is dropped. The rendered snapshot is marked as superseding earlier runtime-context snapshots, which is what lets an injected value outlive a compaction summary. |
| `todo/write` session event | Harness, not this suite | `todo_write` persists `{content, status}[]` as a session event. The suite records this as a fact it depends on, never as an API it calls. |
| `ctx.llm` registration seams | devin-bridge, llm-qoder | An adapter registers its routes, its configurable-provider directory entries, and its settings-namespace model discovery as three separate handles, each disposed with the fiber. Both adapters rely on the directory entry for the display name selection surfaces render, and neither expects `registerAdapter`'s disposer to close what the adapter itself owns — subprocesses, HTTP clients, and warm CLI sessions need their own `ctx.effect` teardown. |
| `attachments` service | devin-bridge, llm-qoder | Image references resolve through the host attachment store into bytes the provider accepts. Both adapters treat the service as optional (devin: `ctx.get`, qoder: `ctx.inject`), so image handling degrades to the Harness's flattened handle text on a deployment without one instead of failing the turn. |
| `session/event` Cordis event | memory-anchor | `ctx.sessions` publishes every session event (`turn/start`, `tool/call`, `tool/result`, `assistant/message`, `turn/end`) to descendant listeners — the same feed `dsh-workspace-changes` uses. Listeners are observe-only: errors are logged per listener, never propagated. |

## Known Harness gaps this suite works around

- **No `todo_read`.** `todo_write` replaces the whole list and no tool reads it back, so a model that stops writing keeps seeing its own last claim, and a session that loses the list in context cannot recover it. todo-anchor mirrors the list into dynamic context to remove the *loss* half; the *staleness* half is behavioural and no plugin can close it.
- **`exec.agent` session identity is present but thinly typed.** `tools/execute` dispatches carry `exec.agent.id` — the session id — which todo-anchor uses to key lists per session. The public `Agent` type only guarantees `id`, so the plugin reads it defensively (`id`, then `sessionId`) and falls back to a process-global list for scope-less assemblies.
- **Todo state is not injected into the system prompt.** `@deepseek-ai/dsh-system-prompt` contains no todo contribution, so a resumed, forked, or compacted session has no first-class way to recover the current list.

A `todo_read` tool, or re-injecting the current list on every turn, would make todo-anchor unnecessary. Until one exists, the mirror is the workaround and a Vault note remains the durable record.

## Cross-platform notes

- Vault paths are resolved with Node's `path` module and validated before any read/write.
- The Devin adapter resolves its credentials file per platform (`~/.local/share/devin/credentials.toml` on Unix, `%APPDATA%\devin\credentials.toml` on Windows, or `DEVIN_CREDENTIALS_PATH` anywhere) and loads its proxy agents through `createRequire`, so no proxy dependency is loaded on a deployment that never uses one.
- Installing `@jacklika/dsh-llm-qoder` also installs `@qoder-ai/qoder-agent-sdk`, whose `postinstall` downloads a ~56 MB worker runtime from `download.qoder.com`. pnpm versions that block dependency build scripts by default skip that download, and every qoder turn then fails locally with `Qoder worker runtime not found` — so the installing profile must allow the SDK's build script or point `QODERCLI_PATH` at an existing `qodercli`. See the package README's Runtime section.
- The full Windows/macOS/Linux CI matrix runs `install`, `typecheck`, `lint`, `test`, `build`, `test:multiprocess`, `test:pack`, and `test:profile` on every push.
