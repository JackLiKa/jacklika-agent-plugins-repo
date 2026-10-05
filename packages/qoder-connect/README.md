# @jacklika/dsh-qoder-connect

DSH plugin that connects Qoder's CLI/model service as a DeepSeek Harness LLM provider.

## Variants

- `qoder` — Global region (default).
- `qoder-china` — China region.

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

The plugin reads `QODER_PERSONAL_ACCESS_TOKEN` (Global) and `QODER_CHINA_PERSONAL_ACCESS_TOKEN` (China) from environment variables, or accepts a PAT written through the settings UI. The UI only displays a one-way token tail and never logs the full PAT.

The default variant uses the Global region with the original Qoder client headers. The PAT is exchanged for a job token, which is then used as a Bearer token for user, plan, organization, and quota requests.

## Status

The status endpoint returns:

- Username, email, user type, and avatar.
- Plan tier and organization.
- Credit accounts with per-account remaining/size (e.g. Plan and Org Package).
- The complete model list.

## Client UI

A settings card is registered through `dsh.client` when the renderer is available. The UI calls host routes under `/plugins/dsh-qoder-connect/*` with per-process control keys for writes. The connector publishes its status to the shared connector status store so the unified dashboard can show identity, multiple quota progress bars, and model counts.
