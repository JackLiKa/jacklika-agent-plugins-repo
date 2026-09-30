# @jacklika/dsh-qoder-connect

DSH plugin that connects Qoder's CLI/model service as a DeepSeek Harness LLM provider.

## Variants

- `qoder` (CN region)
- `qoder-global` (Global region)

## Configuration

```yaml
enabled: true
models: []
timeoutMs: 120000
```

- `enabled` — register the providers.
- `models` — override the default model catalog with custom entries.
- `timeoutMs` — CLI request timeout.

## PAT

The plugin reads `QODER_PERSONAL_ACCESS_TOKEN` (CN) and `QODER_GLOBAL_PERSONAL_ACCESS_TOKEN` (Global) from environment variables, or accepts a PAT written through the settings UI. The UI only displays a one-way token tail and never logs the full PAT.

## Client UI

A settings card and sidebar quota panel are registered through `dsh.client` when the renderer is available. The UI calls host routes under `/plugins/dsh-qoder-connect/*` with per-process control keys for writes.
