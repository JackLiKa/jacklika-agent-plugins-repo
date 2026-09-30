# @jacklika/dsh-devin-connect

DSH plugin that connects the Devin API as a DeepSeek Harness LLM provider.

## Variant

- `devin` — Devin API via PAT.

## Configuration

```yaml
enabled: true
models: []
timeoutMs: 120000
```

- `enabled` — register the provider.
- `models` — override the default model catalog.
- `timeoutMs` — request timeout for status checks.

## PAT

The plugin reads `DEVIN_API_KEY` from environment variables, or accepts a token written through the settings UI. The UI only displays a token tail and never logs the full key.

## Client UI

A settings card is registered through `dsh.client` when the renderer is available. It calls host routes under `/plugins/dsh-devin-connect/*` with per-process control keys for writes.
