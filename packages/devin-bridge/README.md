---
description: "Registers the Devin adapter as the `devin` provider route, so the agent loop can run Claude, GPT, Gemini, GLM, SWE and Kimi models hosted by Devin — including reasoning effort, image input, streaming tool calls and token accounting."
kind: "package-reference"
---

# @jacklika/dsh-devin-bridge

English | [中文](README.zh.md)

## Summary

`dsh-devin-bridge` speaks Devin Connect on the Harness's behalf. It registers `devin` in the configurable-provider directory and mounts one adapter for that route, translating every model request into the `ChatMessage` RPC at `server.codeium.com` and decoding the response stream back into Harness chunks — text, thinking, tool calls, finish reason, and token usage. Credentials come from the Devin CLI's own `credentials.toml`, so an account already logged in to Devin needs no token in the profile; a `token` field exists for deployments that would rather pin one.

The route exposes the models this package bundles (45 entries, generated from one live Devin catalog) and can refresh that list from the server through the standard model-discovery channel. Reasoning effort is expressed the Harness way — a four-value slider — and mapped internally onto Devin's effort-bearing model uids.

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

Mount it after the LLM service, and select `devin/<model>` from any model seat:

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@jacklika/dsh-devin-bridge'
```

The bundle's own patch already inserts the row under the id `devin-bridge`; overriding the row is what a profile does to pin a token or trim the model list:

```yaml
- id: devin-bridge
  name: '@jacklika/dsh-devin-bridge'
  config:
    token: 'devin-session-token$...'
    defaultContextWindow: 1000000
    models:
      - id: glm-5-2
        name: GLM-5.2 High
        contextWindow: 200000
```

A row patch replaces the whole config, so repeat every key the profile still needs.

### Configure the bridge

| Field | Type | Default | Description |
|---|---|---|---|
| `token` | string (`secret`) | `''` | Devin session token in the `devin-session-token$...` form. Empty means read the Devin CLI credentials instead. |
| `baseUrl` | string | `https://server.codeium.com` | Devin Connect endpoint. Left at the default, the session's own `api_server_url` wins when the credentials file carries one. |
| `proxy` | string | `''` | Outbound proxy for Devin traffic: `http://`, `https://`, `socks5://` or `socks5h://`. Empty connects directly. |
| `forceHttp1` | boolean | `true` | Speak HTTP/1.1 towards Devin. Set `false` to let the transport negotiate HTTP/2. |
| `defaultContextWindow` | number | `128000` | Context window for a model the list does not describe. |
| `defaultMaxTokens` | number | `16384` | Output ceiling for a model the list does not describe. |
| `models` | array | 45 bundled entries | Models the route advertises: `{id, name, contextWindow, supportsImages}`. Volatile, so a settings write reaches readers without a remount. |
| `retryPolicy` | object | Harness default | Retry policy for this route, resolved once at registration. |

### Credentials

The token is resolved per operation, in this order, and the *configured* token is never cached:

1. `config.token`, when the profile sets it;
2. the credentials file at `DEVIN_CREDENTIALS_PATH`, when that variable is set;
3. the Devin CLI's own credentials file — `~/.local/share/devin/credentials.toml` on Unix, `%APPDATA%\devin\credentials.toml` on Windows — which `devin auth login` writes.

A file-based session reads two keys: `windsurf_api_key` (the token) and `api_server_url` (the endpoint). With none of the three present, the first adapter call throws an error naming all three ways to supply one; the failure is not cached, so setting a token afterwards takes effect on the next call.

<a id="understand-the-implementation"></a>
## Understand the implementation

Four pieces, all disposed with the Loader fiber:

- **The provider directory entry** (`ctx.llm.registerConfigurableProviders`) declares `devin` with the display name `Devin` and this plugin's own settings namespace, which is how the composer model seat and the Models settings page render a named group instead of an anonymous route.
- **The adapter route** (`ctx.llm.registerAdapter(['devin'], adapter)`) is the request path. The adapter holds a connection *thunk*, not a connection: every operation reads `token`/`baseUrl`/`proxy` fresh, and the Connect client is rebuilt whenever that tuple changes.
- **Model discovery** (`ctx.llm.registerModelDiscovery`) answers the "fetch available models" action by calling Devin's `GetCascadeModelConfigs` RPC. Disabled entries are dropped, uids deduplicated, and variants of one family merged into a single base model per family, preferring the promo variant.
- **A retry-policy override**, resolved once at registration rather than per request, so the configured policy cannot drift mid-session.

Token accounting comes from the `usage` block Devin attaches to each response, reported in the Harness's disjoint buckets: uncached input, output, cache read, cache write. Cache fields are omitted when the server does not report them, so a provider that stops returning them degrades to "unknown", never to a wrong number.

Images never travel bare. An image block is resolved through the host attachment store into bytes and forwarded inline as base64; without a store the turn fails loudly rather than silently dropping the image. Images are attached only for the current turn — earlier turns collapse to the placeholder `[Image omitted from history]` so a long session does not resend its whole picture history.

<a id="model-experience"></a>
## Model Experience

The model receives Devin's own view of the conversation: text blocks accumulate into one prompt, a reasoning block becomes the prompt's `thinking` field, tool calls are forwarded as name plus raw JSON arguments, and tool definitions travel as JSON Schema with display-only annotations stripped.

Reasoning effort is a Harness slider with four values; each maps to a Devin model uid, and a mapping that the catalog does not know falls back to the configured id rather than failing the turn:

| Harness effort | Devin uid suffix | Example |
|---|---|---|
| `high` (default) | none | `glm-5-2` |
| `medium` | `-medium` | `glm-5-2-medium` |
| `max` | `-max` | `glm-5-2-max` |
| `none` | `-none` | `glm-5-2-none` |

The catalog this package ships keeps the *real* uids, because the ids model discovery derives are base ids with the effort suffix stripped, and not all of those resolve at the endpoint. A deployment that adopts a discovered list should expect base ids; a deployment that keeps the bundled list addresses the exact variants Devin accepted at generation time.

Errors are translated: Connect failures become `LlmError` with the HTTP-ish code preserved, and a stream that ends without a finish reason is reported as an error rather than a clean stop. The adapter reports an aborted request as aborted, so the Harness can tell a cancelled turn from a failed one.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Only the host half is vendored.** Upstream also shipped a browser-side client (model picker UI). The Harness already renders configurable providers and model discovery, so that half is not needed here; it is deliberately absent rather than pending.
- **The bundled catalog drifts.** Devin adds and retires models server-side. The shipped list is a snapshot; use model discovery (or a profile patch) when a model is missing. Bundling a list at all is a deliberate trade: it makes the route usable with zero network calls at startup.
- **Credits, not tokens, are what Devin bills.** The usage block carries token counts, but Devin's own cost accounting is credit-based and server-side; the plugin makes no attempt to price a turn.
- **`baseUrl` is a real override, not a hint.** Pointing it at anything other than the default bypasses the credentials file's own `api_server_url`; that is how a self-hosted or regional endpoint is reached, and it is the operator's responsibility to keep token and endpoint consistent.
- **Proxy agents are CommonJS optional dependencies**, loaded lazily through `createRequire`, so an unproxied deployment never loads them.

<a id="provenance-and-local-changes"></a>
## Provenance and Local Changes

Vendored from [Arborsm/dsh-plugin-devin-bridge](https://github.com/Arborsm/dsh-plugin-devin-bridge) at commit `ced035dd2f43b2dbf37a25c8a47b8ae1c1cc47f4` (MIT — the original `LICENSE` is kept verbatim). The upstream README describes the plugin as written for Harness 0.1.x; the port below is what makes it compile and run against the 0.2.0 API in this repository.

Local changes, all in the host half:

1. **Package shape** — rebuilt as `packages/devin-bridge` with the repository's conventions: `src/` TypeScript compiled by `tsc` (upstream shipped `lib/` built by tsdown), English comments, `@jacklika/dsh-devin-bridge` identity.
2. **Message model (0.2.0)** — the request converter takes `RequestMessage` (which includes the ephemeral `RequestUserInput`) instead of `Message`; the tool-result error flag is read from the tool message's own `isError`/role, because 0.2.0 content blocks have no `tool-result` type.
3. **Identifiers** — `CallId` renamed to `ToolCallId` throughout the decoder and adapter.
4. **Model discovery signature** — the callback is `(request, signal)`, so cancellation reaches `discoverModels` as a second argument.
5. **`exactOptionalPropertyTypes` cleanups** — optional transport and connection fields declare `| undefined` explicitly.
6. **ESM proxy loading** — the proxy agents are required through `createRequire`, since a bare `require` does not exist in this ESM package.
7. **Bundled catalog** — upstream carried three hand-written default models; this fork ships `src/default-models.ts` with 45 entries generated from one live catalog response, family-merged the same way model discovery merges, keeping the resolvable uids.
8. **Volatile model list** — `models` is declared `.volatile()` and unwrapped by `readModels`, and the schema uses the two-type-parameter annotation the Harness itself uses when a field's input and output shapes differ.

<a id="dev-note"></a>
## Dev Note

`src/proto/gen/devin_pb.ts` is generated from `src/proto/devin.proto` (Connect/Buf, protobuf-es 2). Do not hand-edit the generated file; regenerate it instead.

The bundled default list was generated once against a live account through the adapter's own catalog fetch, family-merged exactly as `discoverModels()` merges and with the legacy `MODEL_*` aliases dropped; `src/default-models.ts` documents that provenance at the top of the file. Regenerate it the same way when Devin's catalog moves.
