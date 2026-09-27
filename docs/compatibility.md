# Compatibility

## Verified baseline

| Component | Declared range | Verified baseline |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | Local: 22.23.2; CI covers 22.19.0 and current 24.x on Linux, macOS, and Windows |
| pnpm | repository development uses 11.7.0 | 11.7.0 |
| DeepSeek Harness packages | `>=0.1.7-rc.1 <0.1.8` peers | Both releases of the 0.1.7 line, `0.1.7-rc.1` and `0.1.7-rc.2`; each ran the full suite |
| Cordis | exact `4.0.4` peer | 4.0.4 |
| Git | `git` must be on `PATH`; the plugin uses `-C`, `init`, `rev-parse`, `status`, `add`, and `commit` | Local: Apple Git 2.50.1; CI uses each runner's Git |

The Harness peer range is bounded rather than exact, deliberately. Harness APIs are pre-stable, and the desktop application updates itself, so an exact peer converts every unrelated release into a load-time refusal even when the plugin is compatible—it did so twice while this suite was being verified. A range keeps the protection that matters: the next release line is still rejected before code loads, because `>=0.1.7-rc.1 <0.1.8` admits one line only. Every release inside the window must pass the full CI and the independent Profile installation tests before it joins the window, and widening the window past the verified line needs the same evidence. “Allowed” and “verified” therefore name the same window today.

Harness checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer before registry installation and again before Profile composition. This suite declares that bounded range for the Bundle, so a runtime outside the verified line is rejected before code loads. Harness has an explicit exact-version `allow-version --accept-risk` exemption, but it is an emergency user decision—not an installation step for this suite. A runtime outside the window must normally be fixed by verifying it and moving the window.

## Imported Harness APIs

| Plugin packages | Imports |
|---|---|
| all Cordis plugins | `Context` from `@deepseek-ai/cordis`; Schemastery config from `@deepseek-ai/schemastery` |
| scope | `ToolCallId` from `@deepseek-ai/dsh-llm`; `ToolDispatchExecution`, `ToolExecutionResult`, and `ctx.tools.execute` from `@deepseek-ai/dsh-tools` |
| queue and git | `ToolExecutionResult` and the `tools/execute` waterfall from `@deepseek-ai/dsh-tools` |
| filesystem, graph, vector | `defineTool` / `ToolRunContext` from `@deepseek-ai/dsh-tools`; filesystem and graph also use `JsonValue` from `@deepseek-ai/dsh-util-values` |

The Bundle itself contains only a Cordis patch and runtime dependencies on the six member packages.
