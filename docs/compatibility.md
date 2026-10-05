# Compatibility

## Verified baseline

| Component | Declared range | Verified baseline |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | Local: 22.23.2; CI covers 22.19.0 and current 24.x on Linux, macOS, and Windows |
| pnpm | repository development uses 11.7.0 | 11.7.0 |
| DeepSeek Harness packages | `>=0.1.7-rc.1 <0.3.0-0` peers | `0.1.7-rc.10` and `0.2.0-rc.1` each ran the full suite |
| Cordis | exact `4.0.4` peer | 4.0.4 |
| Git | `git` must be on `PATH`; the plugin uses `-C`, `init`, `rev-parse`, `status`, `add`, and `commit` | Local: Apple Git 2.50.1; CI uses each runner's Git |

The Harness peer range is bounded rather than exact, deliberately. Harness APIs are pre-stable, and the desktop application updates itself, so an exact peer converts every unrelated release into a load-time refusal even when the plugin is compatible—it did so twice while this suite was being verified. A range keeps the protection that matters: the next release line is still rejected before code loads, because `>=0.1.7-rc.1 <0.3.0-0` admits only the 0.1.x and 0.2.x lines (from `0.1.7-rc.1` onward) and explicitly excludes every prerelease of 0.3.x. The `-0` suffix is necessary because semver with `includePrerelease` would otherwise treat `0.3.0-rc.1` as satisfying `<0.3.0`. Every release inside the window must pass the full CI and the independent Profile installation tests before it joins the window, and widening the window past the verified line needs the same evidence. “Allowed” and “verified” therefore name the same window today.

Harness checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer before registry installation and again before Profile composition. This suite declares that bounded range for the Bundle, so a runtime outside the verified line is rejected before code loads. Harness has an explicit exact-version `allow-version --accept-risk` exemption, but it is an emergency user decision—not an installation step for this suite. A runtime outside the window must normally be fixed by verifying it and moving the window.

## Imported Harness APIs

| Plugin packages | Imports |
|---|---|
| all Cordis plugins | `Context` from `@deepseek-ai/cordis`; Schemastery config from `@deepseek-ai/schemastery` |
| scope | `ToolCallId` from `@deepseek-ai/dsh-llm`; `ToolDispatchExecution`, `ToolExecutionResult`, and `ctx.tools.execute` from `@deepseek-ai/dsh-tools` |
| queue and git | `ToolExecutionResult` and the `tools/execute` waterfall from `@deepseek-ai/dsh-tools` |
| filesystem, graph, vector, curator | `defineTool` / `ToolRunContext` from `@deepseek-ai/dsh-tools`; filesystem, graph, and curator also use `JsonValue` from `@deepseek-ai/dsh-util-values` |
| connector-core, devin-connect, qoder-connect | `CliLlmAdapter`, DSH LLM model registration and resolution from `@deepseek-ai/dsh-llm`; web route primitives from `@deepseek-ai/cordis` |
| model-selector | `slots`, `modelDirectories`, `sessions`, `locale` from DSH client services; React 18 |

The Bundle itself contains only a Cordis patch and runtime dependencies on the member packages.

## Cross-platform notes

- Vault paths are resolved with Node's `path` module and validated before any read/write.
- Connector CLI adapters spawn a login shell (`/bin/bash -lc` on macOS/Linux, `cmd.exe /c` on Windows) so the user's PATH and environment are available.
- Devin CLI credential discovery uses `~/.local/share/devin/credentials.toml` on macOS/Linux and `%LOCALAPPDATA%/devin/credentials.toml` on Windows.
- Qoder config directories live under `~/.dsh/profiles/<profile>/.dsh-qoder-connect` on all platforms.
- The full Windows/macOS/Linux CI matrix runs `install`, `typecheck`, `lint`, `test`, `build`, `test:multiprocess`, `test:pack`, and `test:profile` on every push.
