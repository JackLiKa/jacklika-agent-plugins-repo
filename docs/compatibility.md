# Compatibility

## Verified baseline

| Component | Declared range | Verified baseline |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | Local: 22.23.2; CI covers 22.19.0 and current 24.x on Linux, macOS, and Windows |
| pnpm | repository development uses 11.7.0 | 11.7.0 |
| DeepSeek Harness packages | exact `0.1.7-rc.1` peers | Harness checkout and published packages at `0.1.7-rc.1` |
| Cordis | exact `4.0.4` peer | 4.0.4 |
| Git | `git` must be on `PATH`; the plugin uses `-C`, `init`, `rev-parse`, `status`, `add`, and `commit` | Local: Apple Git 2.50.1; CI uses each runner's Git |

The exact Harness peer versions are intentional. Harness APIs are pre-stable, so a wider semver range would claim compatibility that has not been tested. A new Harness release must pass the full CI and independent Profile installation tests before these ranges change. “Allowed” and “verified” therefore mean the same exact release today.

Harness checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer before registry installation and again before Profile composition. This suite declares an exact Bundle peer so an incompatible runtime is rejected before code loads. Harness has an explicit exact-version `allow-version --accept-risk` exemption, but it is an emergency user decision—not an installation step for this suite. A mismatch must normally be fixed by selecting a tested plugin/Harness release pair.

## Imported Harness APIs

| Plugin packages | Imports |
|---|---|
| all Cordis plugins | `Context` from `@deepseek-ai/cordis`; Schemastery config from `@deepseek-ai/schemastery` |
| scope | `ToolCallId` from `@deepseek-ai/dsh-llm`; `ToolDispatchExecution`, `ToolExecutionResult`, and `ctx.tools.execute` from `@deepseek-ai/dsh-tools` |
| queue and git | `ToolExecutionResult` and the `tools/execute` waterfall from `@deepseek-ai/dsh-tools` |
| filesystem, graph, vector | `defineTool` / `ToolRunContext` from `@deepseek-ai/dsh-tools`; filesystem and graph also use `JsonValue` from `@deepseek-ai/dsh-util-values` |

The Bundle itself contains only a Cordis patch and runtime dependencies on the six member packages.
