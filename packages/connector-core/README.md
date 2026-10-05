# @jacklika/dsh-connector-core

Shared primitives for the Qoder and Devin connector plugins.

## Scope

- `CliLlmAdapter` base class for spawning an official CLI as a DSH LLM adapter.
- Web route helpers: loopback validation, safe JSON responses, body reading, constant-time control keys, and token redaction.
- A shared client-side connector status store (`__jacklikaConnectorStatusStore`) used by all connector client bundles to feed one unified dashboard.
- Reusable TypeScript types for host/client contracts, including structured quota accounts and model groups.

## Client surfaces

- **ConnectorListCard** — a single sidebar card that appears only when at least one provider is connected; shows the number of connected providers; opens a unified dashboard modal.
- **Unified dashboard** — accordion-style provider rows, per-account quota progress bars, expandable model lists grouped by family.

## Security notes

- All connector web routes validate the `Host` and `Origin` headers to ensure loopback-only access.
- PAT/secret write operations additionally require a per-process control key generated at load time.
- Error messages are passed through `safeMessage()` to redact Bearer tokens, JWTs, `code=...`, `token=...`, and other secret-like substrings before they reach logs or the UI.
