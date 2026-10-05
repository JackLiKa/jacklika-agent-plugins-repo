# @jacklika/dsh-connector

Bundle combining the Qoder and Devin connector plugins for DeepSeek Harness, plus a provider-first model selector.

## Install

Install this package as a DSH Bundle:

```bash
dsh plugin add @jacklika/dsh-connector
```

## Contents

- `@jacklika/dsh-qoder-connect` — Qoder CLI connector (CN + Global)
- `@jacklika/dsh-devin-connect` — Devin API connector
- `@jacklika/dsh-connector-core` — shared host/client primitives
- `@jacklika/dsh-model-selector` — provider-first, family-grouped composer model selector

## Requirements

- DeepSeek Harness/Cordis inside the verified window documented in `docs/compatibility.md`.
- Node.js `^22.19.0 || >=24.0.0`
- `qodercli` for Qoder providers (CN + Global)
- `DEVIN_API_KEY` or a PAT set through the settings UI for Devin

## Security

PATs are never persisted to the plugin package tree and are not logged. Write operations to host routes require a per-process control key and loopback validation.
