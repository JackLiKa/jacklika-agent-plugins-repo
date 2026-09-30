# @jacklika/dsh-connector-core

Shared primitives for the Qoder and Devin connector plugins.

## Scope

- `CliLlmAdapter` base class for spawning an official CLI as a DSH LLM adapter.
- Web route helpers: loopback validation, safe JSON responses, body reading, constant-time control keys, and token redaction.
- Reusable TypeScript types for host/client contracts.

## Security notes

- All connector web routes validate the `Host` and `Origin` headers to ensure loopback-only access.
- PAT/secret write operations additionally require a per-process control key generated at load time.
- Error messages are passed through `safeMessage()` to redact Bearer tokens, JWTs, `code=...`, `token=...`, and other secret-like substrings before they reach logs or the UI.
