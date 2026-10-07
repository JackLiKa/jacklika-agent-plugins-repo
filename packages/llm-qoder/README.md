---
description: "Mounts the local Qoder CLI as the `qoder` and `qoder-byok` provider routes: the account's live model catalog, warm per-session inner sessions, attachment-backed image input, and provider-reported cache token buckets."
kind: "package-reference"
---

# @jacklika/dsh-llm-qoder

English | [中文](README.zh.md)

## Summary

`dsh-llm-qoder` runs the machine's `qodercli` as a dsh model backend. It declares two configurable provider routes and mounts one adapter for both: `qoder` serves the account's built-in models, `qoder-byok` the account-custom ones, and neither carries a credential in config — both ride the Qoder CLI's own login. Model metadata is fetched live from the CLI, kept for a TTL, and backed by a static catalog captured from one account while no live fetch is available.

Each dsh session keeps a warm inner CLI session, so a long conversation is fed incrementally rather than rebuilt every turn; side channels (titles, compaction summaries) bypass the pool with one one-shot request against the same model. Images reach the model through the host attachment store, token usage is reported in the Harness's disjoint buckets — with the provider's own cache counts whenever the CLI reports them — and every registration, warm subprocesses included, is disposed with the Loader fiber.

This is a fork: provenance and every local change are listed in [Provenance and Local Changes](#provenance-and-local-changes).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Provenance and Local Changes](#provenance-and-local-changes)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it after the LLM service, then select `qoder/<model>` or `qoder-byok/<model>` from any model seat:

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@jacklika/dsh-llm-qoder'
```

The bundle's own patch inserts the row under the id `llm-qoder`; a profile can override that row to bound the pool or the catalog TTL:

```yaml
- id: llm-qoder
  name: '@jacklika/dsh-llm-qoder'
  config:
    maxSessions: 4
    modelCacheTtlSeconds: 600
```

A row patch replaces the whole config, so repeat every key the profile still needs.

### Configure the route

| Field | Type | Default | Description |
|---|---|---|---|
| `maxSessions` | number | `8` | Maximum simultaneously warm inner qodercli sessions (1–64). Revealing a session moves it to the back of the pool; the oldest closes when the pool overflows. |
| `modelCacheTtlSeconds` | number | `300` | Seconds a fetched CLI model catalog stays fresh before the next request re-fetches it (10–86400). |

### Credentials

There is no token field. The adapter authenticates through the Qoder CLI's own login on the machine running dsh, so a deployment needs `qodercli` installed and signed in; a profile cannot supply an account. The BYOK route is not a second account — it is the same catalog filtered to account-custom models.

<a id="understand-the-implementation"></a>
## Understand the implementation

Five pieces, all disposed with the Loader fiber:

- **Provider directory entries** (`ctx.llm.registerConfigurableProviders`) declare `qoder` and `qoder-byok` with the display names `Qoder CLI` and `Qoder 自定义` and this plugin's settings namespace, so the composer model seat and the Models settings page render two named groups instead of anonymous routes.
- **The adapter route** (`ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`) serves both routes from one adapter instance. `listModels` splits the account catalog by entry source: the built-in route hides account-custom models, and the BYOK route serves only those.
- **The live model catalog** (`QoderModelCatalog`) asks the CLI for the account's catalog through one short-lived inner session. A fetched snapshot stays fresh for the configured TTL; concurrent callers share one in-flight fetch; a fetch that fails or exceeds 20 seconds serves the last good snapshot, and a deployment that never fetched falls back to the static catalog in [catalog.ts](src/catalog.ts).
- **The attachment store** is injected lazily (`ctx.inject(['attachments'])`), so the routes register even on a deployment without one; images then degrade to the Harness's own handle text instead of failing the turn.
- **A dispose hook** closes every warm inner session (`ctx.effect(() => () => adapter.close())`), because `registerAdapter`'s disposer only withdraws the routes, not the CLI subprocesses the adapter owns.

Model addressing is resolved before the catalog lookup: `deepseek-v4-flash` and `deepseek-v4-pro` expand to `dfmodel` and `dmodel`, a `qoder-` prefix is stripped, and any other id passes through. The resolved value finds the metadata, but `resolveModel` echoes the requested id back, because the seam rejects a resolved model whose id differs from the one asked for.

Capability is only claimed when verified. `resolveModel` declares image input only for a live entry whose `isVl` flag is exactly `true`; the Harness projects images to handle text for a route that omits it, so a claim the CLI did not make would silently drop pixels. It reports the catalog's `defaultContextWindow` as the route's window, falling back to `maxInputTokens` and then to 200 000 — deliberately not the ceiling: qodercli reports `maxInputTokens` as the model's maximum (often 1 M) while `defaultContextWindow` is the effective per-session window, and pricing the context meter against the ceiling would push auto-compaction far past what the provider accepts.

<a id="model-experience"></a>
## Model Experience

**First turns and continuations.** The Harness conversation is rendered once into a role-labelled text feed and sent as the inner session's prompt. Later turns feed only the tail — fresh user messages plus in-place-refreshed context snapshots — while tool results are delivered to the parked tool handlers rather than re-fed. History that diverges past repair (index 0 changed, more than two in-place mutations, or a shorter message list) rebuilds the inner session cold from the full feed.

**Side channels.** Requests without a session id — titles, compaction summaries — never touch the pool: one one-shot turn with tools disabled, against the main session's model, so the summarization target dsh records is what qodercli actually ran.

**Images.** Image references are resolved through the host attachment store into base64 at the attachment's own dimensions, with a 1 MiB encoded ceiling per forwarded image. A route that does not declare vision receives the Harness's flattened handle text; an attachment the host could not read leaves a note naming it, so the inner model still knows it existed.

**Token accounting.** A stream frame that carries cache traffic is reported as disjoint buckets — input excluding cache reads and writes, plus cache read, cache write and `totalTokens` — with a reasoning estimate emitted only when it does not exceed the provider's own output count, because the Harness rejects a sample claiming more thinking than output. Frames without metering data fall back to a session-level estimate priced like the Harness token meter (4 characters per token over the rendered conversation, plus image tokens), which keeps compaction thresholds seeing real occupancy.

**Errors.** The CLI's failure text is classified into the Harness's context-window-exceeded, quota-exceeded, or backend-turn code, so the agent loop reacts to an exhausted window differently from a spent quota.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Nothing to configure but the pool and the TTL.** The route authenticates only through the local `qodercli` login; a profile cannot supply a token or an account, and a deployment without a signed-in CLI can list the static catalog but cannot run a turn.
- **`qoder-byok` is a catalog split, not a second account.** Both routes read the same CLI login; the BYOK route only filters to account-custom models.
- **Catalog freshness is bounded.** Entries live for the TTL, and a failed refresh quietly serves the last good snapshot. The static fallback is one account's capture from 2026-08 and declares no vision capability, because it cannot verify one.
- **The fallback estimate is not provider metering.** It is good enough for the context meter and compaction thresholds, not for billing or cache-hit analysis.
- **Warm sessions are process state.** `maxSessions` bounds them, overflow closes the least recently used session, a host restart rebuilds cold, and each warm session holds a live CLI subprocess.
- **Runtime strings are upstream's.** Prompt instructions, role labels, the `Qoder 自定义` display name and the CJK catalog descriptions are kept verbatim; they are behaviour surface — what the inner model and the UI read — deliberately excluded from the English-comment migration.
- **Upstream's unit specs are not carried over.** Coverage today is the Loader composition test below; porting the seven upstream spec files and adapting them to the cache-bucket patch is deferred.

<a id="provenance-and-local-changes"></a>
## Provenance and Local Changes

Vendored from [JiamingZang/dsh-llm-qodersdk](https://github.com/JiamingZang/dsh-llm-qodersdk) at commit `3515f20c28e8c01476ca27509ca0b8c5090e82d7` (MIT — the original `LICENSE` is kept verbatim).

Local changes, all in the host half:

1. **Package shape** — rebuilt as `packages/llm-qoder` under this repository's conventions: `src/` TypeScript compiled by `tsc` (upstream shipped `lib/` output alongside sources), `@jacklika/dsh-llm-qoder` identity, this bilingual README pair.
2. **Cache-bucket usage patch** — [session.ts](src/session.ts) reports provider cache traffic before the session-level estimate: a frame carrying `cache_read_input_tokens`/`cache_creation_input_tokens` outranks the estimate, its buckets are disjoint (input excludes cache reads and writes) and carry `totalTokens`, and a reasoning estimate is emitted only when it does not exceed the provider's own output count. The estimate remains the fallback, where upstream used it unconditionally.
3. **Lint cleanup** — the reasoning-effort policy object in [adapter.ts](src/adapter.ts) no longer spreads a conditional expression.
4. **Unit specs not carried over** — upstream shipped seven `.spec.ts` files; this package ships one real Loader composition test instead.

Everything else is byte-identical to upstream, including the runtime strings listed under Known Limitations. The one exception is [models.ts](src/models.ts), which upstream shipped with CRLF line endings and this repository's `.gitattributes` normalizes to LF.

<a id="dev-note"></a>
## Dev Note

`tests/loader-composition.spec.ts` boots the real Loader beside the real `@deepseek-ai/dsh-llm` service and asserts the composition seam: both routes appear in the provider directory with their display names, the adapter's entries reach `listConfigurableProviders()`, and disposing the plugin fiber withdraws them. It deliberately stops before any model lookup, because every catalog path in this adapter goes through the local Qoder CLI login, which a hermetic test cannot assume.
