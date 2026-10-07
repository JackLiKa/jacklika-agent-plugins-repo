// The dsh-devin-bridge entry: registers DevinAdapter as the `devin` provider
// route of the dsh LLM service, so the agent loop can drive Devin-hosted models
// through Devin Connect.
//
// Token resolution order:
//   1. composition entry config.token (a profile patch sets it),
//   2. the credentials.toml at DEVIN_CREDENTIALS_PATH, when that is set,
//   3. the Devin CLI's own credentials.toml (`devin auth login` writes it).
//
// Vendored from github.com/Arborsm/dsh-plugin-devin-bridge (MIT — see LICENSE)
// and ported to the Harness 0.2.0 API; README.md lists every local change.

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type RetryPolicyConfig,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DevinAdapter, type DevinCatalogModel } from './adapter/devin.ts'
import { DEFAULT_MODELS } from './default-models.ts'
import { readDevinSession, DEFAULT_API_SERVER_URL } from './adapter/credentials.ts'

export const name = 'devin-bridge'
export const inject = ['llm']

const PROVIDER = 'devin'
// The settings namespace is this bundle's row id in the profile patch: the
// Settings service projects a plugin's own Config schema under the id of the
// entry that mounted it, and the configured-provider directory addresses the
// same namespace.
const SETTINGS_NS = 'devin-bridge'

// ─── Config schema ──────────────────────────────────────────────────────────

export interface Config {
  /**
   * Devin session token in the `devin-session-token$<...>` form. Left empty,
   * the plugin reads the Devin CLI's credentials.toml instead.
   */
  token: string
  /** Devin Connect endpoint; defaults to https://server.codeium.com. */
  baseUrl: string
  /** Optional outbound proxy URL (http/https/socks5). */
  proxy: string
  /** Force HTTP/1.1 towards Devin; default true. */
  forceHttp1: boolean
  /** Default context window; default 128000. */
  defaultContextWindow: number
  /** Default maximum output tokens; default 16384. */
  defaultMaxTokens: number
  /**
   * Available models; defaults to the catalog bundled in default-models.ts.
   *
   * The schema declares this field volatile, so the Loader hands `apply()` a
   * live reference while a profile patch supplies a plain list; read the value
   * through `readModels`, never directly.
   */
  models: DevinCatalogModel[] | VolatileRef<readonly DevinCatalogModel[] | undefined>
  /** Retry policy. */
  retryPolicy: RetryPolicyConfig
}

/** Runtime shape of a schema-declared volatile field: a live, read-only reference. */
export interface VolatileRef<T> {
  get(): T
}

/** What a profile patch or settings form writes: the volatile field as a plain list. */
type ConfigInput = Omit<Config, 'models'> & {
  models?: DevinCatalogModel[]
}

const catalogModel: z<DevinCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  supportsImages: z.boolean(),
  family: z.string(),
  isPremium: z.boolean(),
  isPromo: z.boolean(),
  creditMultiplier: z.number().step(0.01),
})

// The volatile `models` field makes the schema's input and output types differ,
// which the single-parameter annotation cannot express; cast as the Harness does
// for its own two-shaped configs.
export const Config = z.object({
  token: z.string().role('secret').default(''),
  baseUrl: z.string().default('https://server.codeium.com'),
  proxy: z.string().default(''),
  forceHttp1: z.boolean().default(true),
  defaultContextWindow: z.number().step(1).min(1).default(128_000),
  defaultMaxTokens: z.number().step(1).min(1).default(16_384),
  // Volatile so the settings service may write it — a model list adopted from the
  // Devin catalog is written through a settings/profile write, and that write must
  // reach readers without a remount.
  models: z.array(catalogModel).default([...DEFAULT_MODELS]).volatile(),
  retryPolicy: RetryPolicySchema,
}) as unknown as z<ConfigInput, Config>

/**
 * Unwrap the volatile `models` field. The Loader hands a volatile field to
 * `apply()` as a live reference, while a profile patch supplies a plain array;
 * both must reach the adapter as a plain list.
 * @param value - the configured models, however the field was populated.
 * @returns the current model list.
 */
function readModels(value: Config['models']): readonly DevinCatalogModel[] {
  return Array.isArray(value) ? value : value.get() ?? []
}

// ─── Token resolution ───────────────────────────────────────────────────────

interface ResolvedConnection {
  token: string
  baseUrl: string
}

// ─── Plugin entry ───────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  // The attachment store (image input) is looked up once, at load time.
  const attachments = ctx.get('attachments')
  const readImage: ((ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<StoredImageAttachment>) | undefined =
    attachments
      ? (ref, signal) => attachments.readImage(ref, signal)
      : undefined

  // Credentials are resolved lazily, per operation: the profile patch is read
  // at startup, so no configuration changes underneath a running fiber.
  let cachedConn: ResolvedConnection | null = null
  let cachedConnKey = ''
  const resolveConn = (): ResolvedConnection => {
    // A configured token wins outright and is never cached.
    if (config.token) return { token: config.token, baseUrl: config.baseUrl }
    // Otherwise read credentials.toml once per baseUrl, not per request.
    const key = config.baseUrl
    if (cachedConn !== null && cachedConnKey === key) return cachedConn
    const session = readDevinSession()
    if (session) {
      const baseUrl = config.baseUrl === DEFAULT_API_SERVER_URL
        ? session.apiServerUrl
        : config.baseUrl
      cachedConn = { token: session.apiKey, baseUrl }
      cachedConnKey = key
      return cachedConn
    }
    // Never cache the error, so configuring a token takes effect immediately.
    const hint = process.platform === 'win32'
      ? '%APPDATA%\\devin\\credentials.toml'
      : '~/.local/share/devin/credentials.toml'
    throw new Error(
      `devin-bridge: no Devin session token found. Either:\n` +
      `  1. Set token in the profile patch to a "devin-session-token$..." value, or\n` +
      `  2. Run "devin auth login" to create ${hint}, or\n` +
      `  3. Set DEVIN_CREDENTIALS_PATH to a custom credentials.toml path`,
    )
  }

  // The adapter holds a connection thunk and reads it on every operation.
  const adapter = new DevinAdapter({
    options: () => {
      const { token, baseUrl } = resolveConn()
      return {
        token,
        baseUrl,
        proxy: config.proxy || undefined,
        forceHttp1: config.forceHttp1,
        models: readModels(config.models),
        defaultContextWindow: config.defaultContextWindow,
        defaultMaxTokens: config.defaultMaxTokens,
        ...readImage ? { readImage } : {},
      }
    },
  })

  // The configurable-provider directory, the adapter route, and model discovery
  // each hold a registration handle, released together on unload.
  let directoryHandle: (() => void) | null = null
  let adapterHandle: ((() => void) & { replace?: (p: string[]) => void }) | null = null
  let discoveryHandle: (() => void) | null = null

  const register = (): void => {
    // The retry policy is captured at registration, not read per request.
    const retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(
      config.retryPolicy,
      `llm: provider "${PROVIDER}" retryPolicy`,
    )
    // Override the adapter's providerRetryPolicy to carry the captured policy.
    ;(adapter as unknown as {
      providerRetryPolicy: (_provider: string) => ResolvedRetryPolicy | undefined
    }).providerRetryPolicy = () => retryPolicy

    if (!directoryHandle) {
      directoryHandle = ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: 'Devin', settingsNs: SETTINGS_NS, settingsPath: [] },
      ])
    }
    if (!adapterHandle) {
      adapterHandle = ctx.llm.registerAdapter([PROVIDER], adapter) as never
    }
    if (!discoveryHandle) {
      discoveryHandle = ctx.llm.registerModelDiscovery(SETTINGS_NS, (_request, signal) =>
        adapter.discoverModels(signal),
      )
    }
  }

  const unregister = (): void => {
    if (discoveryHandle) {
      try { discoveryHandle() } catch { /* already disposed */ }
      discoveryHandle = null
    }
    if (adapterHandle) {
      try { adapterHandle() } catch { /* already disposed */ }
      adapterHandle = null
    }
    if (directoryHandle) {
      try { directoryHandle() } catch { /* already disposed */ }
      directoryHandle = null
    }
  }

  register()

  // Unload the registrations with the plugin's Loader fiber.
  ctx.effect(() => () => unregister())
}

export { DevinAdapter } from './adapter/devin.ts'
export type { DevinCatalogModel, DevinAdapterOptions, DevinConnectionOptions } from './adapter/devin.ts'
export { readDevinSession, devinCredentialsPath, type DevinSession } from './adapter/credentials.ts'
