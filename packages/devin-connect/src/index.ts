import { CliLlmAdapter, createControlKey, createFilePatStore, createSelectedParamsStore, type CliVariant, type PatStore, type SelectedParamsStore, type WebRouteContext } from '@jacklika/dsh-connector-core'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { registerDevinWebRoutes } from './server.js'

const DEFAULT_MODELS: LlmModelInfo[] = [
  { provider: 'devin', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', inputModalities: ['text'] },
  { provider: 'devin', id: 'claude-opus-4.6', name: 'Claude Opus 4.6', inputModalities: ['text'] },
  { provider: 'devin', id: 'opus', name: 'Opus', inputModalities: ['text'] },
  { provider: 'devin', id: 'codex', name: 'Codex', inputModalities: ['text'] },
]

function devinDataDir(ctx: any): string {
  const profile = ctx.profileContext?.name ?? ctx.get?.('profileContext')?.name ?? 'default'
  return join(process.env.DSH_HOME ?? homedir(), '.dsh', 'profiles', profile, '.dsh-devin-connect')
}

const DEVIN_VARIANT: CliVariant & {
  statusPath: string
  authPath: string
} = {
  id: 'devin',
  displayName: 'Devin',
  cliCommand: 'devin',
  envToken: 'DEVIN_API_KEY',
  defaultModels: DEFAULT_MODELS,
  statusPath: '/plugins/dsh-devin-connect/status',
  authPath: '/plugins/dsh-devin-connect/auth',
}

interface ConfiguredModel {
  id: string
  name: string
  contextWindow?: number
}

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

const ModelSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().required(),
  contextWindow: Schema.number(),
})

interface DevinConfig extends Record<string, unknown> {
  enabled: boolean
  models: ConfiguredModel[]
  cliCommand: string
  timeoutMs: number
}

export const Config: Schema<DevinConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  models: Schema.array(ModelSchema).default([]),
  cliCommand: Schema.string().default('devin'),
  timeoutMs: Schema.number().default(120_000),
})

export const name = 'llm-devin'
export const inject = ['llm', 'profileContext'] as const

function modelCachePath(dataDir: string): string {
  return join(dataDir, '.devin-models-cache.json')
}

function ensureProvider(models: readonly LlmModelInfo[], provider: string): LlmModelInfo[] {
  return models.map((m) => (m.provider ? m : { ...m, provider }))
}

function withFamilyPrefix(models: readonly LlmModelInfo[]): LlmModelInfo[] {
  return models.map((m) => {
    const family = (m as unknown as Record<string, unknown>).family
    if (typeof family === 'string' && family.length > 0 && !m.name.startsWith(`${family} › `)) {
      return { ...m, name: `${family} › ${m.name}` }
    }
    return m
  })
}

function readModelCacheSync(path: string): LlmModelInfo[] | undefined {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed) && parsed.length > 0 && typeof (parsed[0] as Record<string, unknown>).id === 'string') {
      return ensureProvider(parsed as LlmModelInfo[], 'devin')
    }
  } catch {
    // ignore missing or malformed cache
  }
  return undefined
}

class DevinAdapter extends CliLlmAdapter {
  private readonly cachePath: string
  private readonly paramsStore: SelectedParamsStore
  private readonly patStore: PatStore
  private readonly selectedParams = new Map<string, AdapterModelParams>()

  constructor(variant: CliVariant, config: DevinConfig, dataDir: string, patStore: PatStore) {
    const configured = config.models
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : withFamilyPrefix(variant.defaultModels)
    super({ variant: { ...variant, cliCommand: config.cliCommand, defaultModels: models }, config: config as Record<string, unknown> })
    this.cachePath = modelCachePath(dataDir)
    this.paramsStore = createSelectedParamsStore(dataDir)
    this.patStore = patStore
  }

  protected override async resolveToken(): Promise<string | undefined> {
    const env = process.env[this.variant.envToken]
    if (env) return env
    return this.patStore.get()
  }

  private async cachedModels(): Promise<readonly LlmModelInfo[]> {
    try {
      const text = await readFile(this.cachePath, 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && typeof (parsed[0] as Record<string, unknown>).id === 'string') {
        return withFamilyPrefix(ensureProvider(parsed as LlmModelInfo[], 'devin'))
      }
    } catch {
      // ignore missing or malformed cache
    }
    return this.variant.defaultModels
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return this.cachedModels()
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const parsed = parseCompositeModelId(model)
    if (Object.keys(parsed.params).length > 0) {
      this.selectedParams.set(parsed.baseId, parsed.params)
    }
    const cached = await this.cachedModels()
    const info = cached.find((m) => m.id === parsed.baseId)
    const result: LlmResolvedModelInfo = { provider, id: parsed.baseId, name: info?.name ?? parsed.baseId }
    if (info?.inputModalities !== undefined) {
      result.inputModalities = info.inputModalities as readonly ModelModality[]
    }
    return result
  }

  protected buildArgs(options: GenerateOptions): string[] {
    const base = this.buildBaseOptions(options)
    const args = ['-p']
    const stored = options.model ? this.paramsStore.readSync(options.model) : undefined
    const encoded = options.model ? this.selectedParams.get(options.model) : undefined
    const reasoningEffort = options.reasoningEffort ?? encoded?.reasoningEffort ?? stored?.reasoningEffort
    const maxTokens = encoded?.maxTokens ?? encoded?.contextWindow ?? stored?.maxTokens ?? stored?.contextWindow ?? base.maxTokens
    if (options.model) args.push('--model', options.model)
    if (maxTokens) args.push('--max-output-tokens', String(maxTokens))
    if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort)
    args.push('--', base.prompt)
    return args
  }

  protected parseLine(line: string): StreamChunk | undefined {
    const trimmed = line.trim()
    if (trimmed.length === 0) return undefined
    return { type: 'text-delta', index: 0, text: `${trimmed}\n` }
  }
}

export function apply(ctx: any, config: DevinConfig) {
  if (!config.enabled) return

  const dataDir = devinDataDir(ctx)
  const cachePath = modelCachePath(dataDir)
  const patStore = createFilePatStore({
    filePath: join(dataDir, '.devin-auth.json'),
    envToken: DEVIN_VARIANT.envToken,
  })
  const adapter = new DevinAdapter(DEVIN_VARIANT, config, dataDir, patStore)
  const releaseAdapter = ctx.llm.registerAdapter([DEVIN_VARIANT.id], adapter)
  const configured = config.models
  const initialModels = configured.length > 0
    ? configured.map((m) => ({ provider: 'devin', id: m.id, name: m.name, inputModalities: ['text' as const] }))
    : withFamilyPrefix(readModelCacheSync(cachePath) ?? DEFAULT_MODELS.map((m) => ({ provider: 'devin', id: m.id, name: m.name, inputModalities: ['text' as const] })))

  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: DEVIN_VARIANT.id,
      displayName: DEVIN_VARIANT.displayName,
      settingsNs: 'devin',
      settingsPath: [],
      models: initialModels,
    },
  ])

  ctx.effect(() => () => {
    releaseAdapter?.()
    releaseDirectory?.()
  })

  ctx.inject(['webServer'], (webCtx: WebRouteContext) => {
    registerDevinWebRoutes(webCtx, {
      envToken: DEVIN_VARIANT.envToken,
      statusPath: DEVIN_VARIANT.statusPath,
      authPath: DEVIN_VARIANT.authPath,
      selectPath: '/plugins/dsh-devin-connect/select',
      dataDir,
      modelsCachePath: cachePath,
      defaultModels: DEFAULT_MODELS.map((m) => ({ id: m.id, name: m.name })),
      store: patStore,
      authKey: createControlKey(),
    })
  })
}
