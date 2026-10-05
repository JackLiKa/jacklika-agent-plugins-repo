import { CliLlmAdapter, createControlKey, createFilePatStore, createSelectedParamsStore, type CliVariant, type PatStore, type SelectedParamsStore, type WebRouteContext } from '@jacklika/dsh-connector-core'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { registerQoderWebRoutes } from './server.js'

const DEFAULT_MODELS: LlmModelInfo[] = [
  { provider: 'qoder', id: 'efficient', name: 'Qoder Efficient', inputModalities: ['text'] },
  { provider: 'qoder', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', inputModalities: ['text'] },
  { provider: 'qoder', id: 'claude-opus-4', name: 'Claude Opus 4', inputModalities: ['text'] },
  { provider: 'qoder', id: 'o3', name: 'OpenAI o3', inputModalities: ['text'] },
  { provider: 'qoder', id: 'o4-mini', name: 'OpenAI o4-mini', inputModalities: ['text'] },
]

function qoderDataDir(ctx: any): string {
  const profile = ctx.profileContext?.name ?? ctx.get?.('profileContext')?.name ?? 'default'
  return join(process.env.DSH_HOME ?? homedir(), '.dsh', 'profiles', profile, '.dsh-qoder-connect')
}

interface QoderVariant extends CliVariant {
  cliConfigDir: string
  region: 'china' | 'global'
  statusPath: string
  authPath: string
  probePath: string
}

function makeQoderVariants(dataDir: string): QoderVariant[] {
  return [
    {
      id: 'qoder',
      displayName: 'Qoder',
      cliCommand: 'qodercli',
      envToken: 'QODER_PERSONAL_ACCESS_TOKEN',
      cliConfigDir: join(dataDir, 'qoder', 'qoder-config'),
      region: 'global',
      defaultModels: DEFAULT_MODELS.map((m) => ({ ...m, provider: 'qoder' })),
      statusPath: '/plugins/dsh-qoder-connect/status',
      authPath: '/plugins/dsh-qoder-connect/auth',
      probePath: '/plugins/dsh-qoder-connect/probe',
    },
    {
      id: 'qoder-global',
      displayName: 'Qoder China',
      cliCommand: 'qodercli',
      envToken: 'QODER_CHINA_PERSONAL_ACCESS_TOKEN',
      cliConfigDir: join(dataDir, 'qoder-global', 'qoder-config'),
      region: 'china',
      defaultModels: DEFAULT_MODELS.map((m) => ({ ...m, provider: 'qoder-global' })),
      statusPath: '/plugins/dsh-qoder-connect/global/status',
      authPath: '/plugins/dsh-qoder-connect/global/auth',
      probePath: '/plugins/dsh-qoder-connect/global/probe',
    },
  ]
}

interface ConfiguredModel {
  id: string
  name: string
  contextWindow?: number
}

const ModelSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().required(),
  contextWindow: Schema.number(),
})

interface AdapterModelParams {
  contextWindow?: number
  reasoningEffort?: string
  maxTokens?: number
}

const PARAMS_SEP = '@@'

function parseCompositeModelId(compositeId: string): { baseId: string; params: AdapterModelParams } {
  const idx = compositeId.indexOf(PARAMS_SEP)
  if (idx < 0) return { baseId: compositeId, params: {} }
  const baseId = compositeId.slice(0, idx)
  const params: AdapterModelParams = {}
  const query = compositeId.slice(idx + PARAMS_SEP.length)
  for (const part of query.split('&')) {
    const [key, value] = part.split('=')
    if (value === undefined) continue
    const decoded = decodeURIComponent(value)
    if (key === 'ctx') params.contextWindow = Number(decoded)
    if (key === 'effort') params.reasoningEffort = decoded
    if (key === 'max') params.maxTokens = Number(decoded)
  }
  return { baseId, params }
}

function qoderModelCachePath(dataDir: string, variantId: string): string {
  return join(dataDir, `.qoder-${variantId}-models-cache.json`)
}

function readModelCacheSync(path: string, providerId?: string): LlmModelInfo[] | undefined {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed) && parsed.length > 0 && typeof (parsed[0] as Record<string, unknown>).id === 'string') {
      return parsed.map((m) => ({
        provider: providerId ?? ((m as Record<string, unknown>).provider as string) ?? 'qoder',
        id: (m as Record<string, unknown>).id as string,
        name: ((m as Record<string, unknown>).name as string) ?? (m as Record<string, unknown>).id as string,
        inputModalities: ((m as Record<string, unknown>).inputModalities as string[]) ?? ['text'],
      })) as LlmModelInfo[]
    }
  } catch {
    // ignore missing or malformed cache
  }
  return undefined
}

interface QoderConfig extends Record<string, unknown> {
  enabled: boolean
  models: ConfiguredModel[]
  timeoutMs: number
}

export const Config: Schema<QoderConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  models: Schema.array(ModelSchema).default([]),
  timeoutMs: Schema.number().default(120_000),
})

export const name = 'llm-qoder'
export const inject = ['llm', 'profileContext'] as const

class QoderAdapter extends CliLlmAdapter {
  private readonly selectedParams = new Map<string, AdapterModelParams>()
  private readonly modelCachePath: string
  private readonly paramsStore: SelectedParamsStore
  private readonly patStore: PatStore

  constructor(variant: CliVariant & { modelCachePath: string }, config: QoderConfig, dataDir: string, patStore: PatStore) {
    const configured = config.models
    const cached = readModelCacheSync(variant.modelCachePath)
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : cached ?? variant.defaultModels
    super({ variant: { ...variant, defaultModels: models }, config: config as Record<string, unknown> })
    this.modelCachePath = variant.modelCachePath
    this.paramsStore = createSelectedParamsStore(dataDir)
    this.patStore = patStore
  }

  protected override async resolveToken(): Promise<string | undefined> {
    const env = process.env[this.variant.envToken]
    if (env) return env
    return this.patStore.get()
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return readModelCacheSync(this.modelCachePath, this.variant.id) ?? this.variant.defaultModels
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const parsed = parseCompositeModelId(model)
    if (Object.keys(parsed.params).length > 0) {
      this.selectedParams.set(parsed.baseId, parsed.params)
    }
    return { provider, id: parsed.baseId, name: parsed.baseId }
  }

  protected buildArgs(options: GenerateOptions): string[] {
    const base = this.buildBaseOptions(options)
    const stored = options.model ? this.paramsStore.readSync(options.model) : undefined
    const encoded = options.model ? this.selectedParams.get(options.model) : undefined
    const reasoningEffort = encoded?.reasoningEffort ?? stored?.reasoningEffort ?? options.reasoningEffort
    const maxTokens = encoded?.maxTokens ?? encoded?.contextWindow ?? stored?.maxTokens ?? stored?.contextWindow ?? base.maxTokens
    const args = [
      '-p',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
      '--no-session-persistence',
    ]
    if (base.system) args.push('--system-prompt', base.system)
    if (maxTokens) args.push('--max-output-tokens', String(maxTokens))
    if (reasoningEffort) args.push('--reasoning-effort', String(reasoningEffort))
    args.push('--', base.prompt)
    return args
  }

  protected parseLine(line: string): StreamChunk | undefined {
    const trimmed = line.trim()
    if (trimmed.length === 0) return undefined
    if (trimmed.startsWith('{')) {
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>
        if (typeof event.content === 'string') {
          return { type: 'text-delta', index: 0, text: event.content }
        }
        if (typeof event.delta === 'string') {
          return { type: 'text-delta', index: 0, text: event.delta }
        }
        if (event.type === 'content' && typeof event.data === 'string') {
          return { type: 'text-delta', index: 0, text: event.data }
        }
      } catch {
        // fall through to plain-text treatment
      }
    }
    return { type: 'text-delta', index: 0, text: `${trimmed}\n` }
  }
}

export function apply(ctx: any, config: QoderConfig) {
  if (!config.enabled) return

  const dataDir = qoderDataDir(ctx)
  const variants = makeQoderVariants(dataDir)
  const adapters: QoderAdapter[] = []
  const releaseAdapters: Array<() => void> = []
  const releaseDirectories: Array<() => void> = []
  const watchers: Array<() => void> = []
  const patStores: PatStore[] = []

  function buildProviderEntry(variant: QoderVariant, models: LlmModelInfo[]) {
    return {
      provider: variant.id,
      displayName: variant.displayName,
      settingsNs: 'qoder',
      settingsPath: [],
      models,
    }
  }

  for (const variant of variants) {
    const variantWithCache = { ...variant, modelCachePath: qoderModelCachePath(dataDir, variant.id) }
    const patStore = createFilePatStore({
      filePath: join(
        dataDir,
        variant.id === 'qoder'
          ? '.qoder-auth.json'
          : variant.id === 'qoder-china'
            ? '.qoder-china-auth.json'
            : '.qoder-global-auth.json',
      ),
      envToken: variant.envToken,
    })
    const adapter = new QoderAdapter(variantWithCache, config, dataDir, patStore)
    adapters.push(adapter)
    patStores.push(patStore)
    releaseAdapters.push(ctx.llm.registerAdapter([variant.id], adapter))

    const configured = config.models
    const cached = readModelCacheSync(variantWithCache.modelCachePath, variant.id)
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] as const }))
      : cached ?? variant.defaultModels
    const entry = buildProviderEntry(variant, models)
    const releaseDirectory = ctx.llm.registerConfigurableProviders([entry])
    releaseDirectories.push(releaseDirectory)

    try {
      const watcher = watch(variantWithCache.modelCachePath, () => {
        const refreshed = readModelCacheSync(variantWithCache.modelCachePath, variant.id)
        const refreshedModels = configured.length > 0
          ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] as const }))
          : refreshed ?? variant.defaultModels
        releaseDirectory.replace([buildProviderEntry(variant, refreshedModels)])
      })
      watchers.push(() => watcher.close())
    } catch {
      // ignore watch errors on platforms where fs.watch is unavailable
    }
  }

  ctx.effect(() => () => {
    releaseAdapters.forEach((release) => release())
    releaseDirectories.forEach((release) => release())
    watchers.forEach((stop) => stop())
  })

  ctx.inject(['webServer'], (webCtx: WebRouteContext) => {
    const runtimes = variants.map((variant, index) => ({
      id: variant.id,
      envToken: variant.envToken,
      dataDir,
      cliConfigDir: variant.cliConfigDir,
      region: variant.region,
      statusPath: variant.statusPath,
      authPath: variant.authPath,
      selectPath: `/plugins/dsh-qoder-connect/select/${variant.id}`,
      probePath: variant.probePath,
      modelCachePath: qoderModelCachePath(dataDir, variant.id),
      store: patStores[index] ?? createFilePatStore({
        filePath: join(
          dataDir,
          variant.id === 'qoder'
            ? '.qoder-auth.json'
            : variant.id === 'qoder-china'
              ? '.qoder-china-auth.json'
              : '.qoder-global-auth.json',
        ),
        envToken: variant.envToken,
      }),
      authKey: createControlKey(),
      probeKey: createControlKey(),
    }))
    registerQoderWebRoutes(webCtx, runtimes)
  })
}
