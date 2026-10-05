# @jacklika/dsh-devin-connect

DSH plugin that connects the Devin API as a DeepSeek Harness LLM provider.

## Variant

- `devin` — Devin API via PAT.

## Configuration

```yaml
enabled: true
models: []
timeoutMs: 120000
cliCommand: devin
```

- `enabled` — register the provider.
- `models` — override the default model catalog.
- `timeoutMs` — request timeout for status checks and CLI calls.
- `cliCommand` — optional Devin CLI binary name/path (default `devin`).

## PAT

The plugin reads `DEVIN_API_KEY` from environment variables, or accepts a token written through the settings UI. The UI only displays a token tail and never logs the full key.

## Model catalog

The plugin prefers the Devin CLI model catalog (`devin models list --format json`) so the selector shows the same models as the Devin app. Each family (e.g. `SWE-2`, `Claude Fable 5.1`) is preserved for grouping; variant metadata such as context window and cost are exposed to custom selectors.

If the CLI is not authenticated, the plugin falls back to a small built-in list of common Devin models.

## Quota and usage

The status endpoint first reads the local Devin CLI credentials (`~/.local/share/devin/credentials.toml` on macOS/Linux, `%LOCALAPPDATA%/devin/credentials.toml` on Windows) and calls Codeium's `GetUserStatus` endpoint — the same source the Devin app uses. This returns plan name, daily/weekly quota percentage, and overage balance without needing an enterprise PAT.

If that path is unavailable, the plugin falls back to Devin's enterprise consumption endpoints. Those require an enterprise service user with billing permissions and will report a permission-denied state for normal PATs instead of fabricating numbers.

## Client UI

A settings card is registered through `dsh.client` when the renderer is available. It calls host routes under `/plugins/dsh-devin-connect/*` with per-process control keys for writes. The connector publishes its status to the shared connector status store so the unified dashboard can show identity, quota, and model counts.

## Cross-platform notes

CLI calls use `/bin/bash -lc` on macOS/Linux and `cmd.exe /c` on Windows so the user's shell PATH and login environment are inherited. The Devin CLI must already be installed and authenticated for live model discovery.
