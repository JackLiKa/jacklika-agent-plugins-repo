import { CliLlmAdapter, createControlKey, createFilePatStore, type CliVariant, type WebRouteContext } from '@jacklika/dsh-connector-core'
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
  const profile = ctx.get?.('profileContext')?.name ?? 'default'
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
export const inject = ['llm'] as const

function modelCachePath(dataDir: string): string {
  return join(dataDir, '.devin-models-cache.json')
}

function ensureProvider(models: readonly LlmModelInfo[], provider: string): LlmModelInfo[] {
  return models.map((m) => (m.provider ? m : { ...m, provider }))
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

  constructor(variant: CliVariant, config: DevinConfig, dataDir: string) {
    const configured = config.models
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : variant.defaultModels
    super({ variant: { ...variant, cliCommand: config.cliCommand, defaultModels: models }, config: config as Record<string, unknown> })
    this.cachePath = modelCachePath(dataDir)
  }

  private async cachedModels(): Promise<readonly LlmModelInfo[]> {
    try {
      const text = await readFile(this.cachePath, 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && typeof (parsed[0] as Record<string, unknown>).id === 'string') {
        return ensureProvider(parsed as LlmModelInfo[], 'devin')
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
    const cached = await this.cachedModels()
    const info = cached.find((m) => m.id === model)
    const result: LlmResolvedModelInfo = { provider, id: model, name: info?.name ?? model }
    if (info?.inputModalities !== undefined) {
      result.inputModalities = info.inputModalities as readonly ModelModality[]
    }
    return result
  }

  protected buildArgs(options: GenerateOptions): string[] {
    const base = this.buildBaseOptions(options)
    const args = ['-p']
    if (options.model) args.push('--model', options.model)
    if (base.maxTokens) args.push('--max-output-tokens', String(base.maxTokens))
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
  const adapter = new DevinAdapter(DEVIN_VARIANT, config, dataDir)
  const releaseAdapter = ctx.llm.registerAdapter([DEVIN_VARIANT.id], adapter)
  const configured = config.models
  const initialModels = configured.length > 0
    ? configured.map((m) => ({ provider: 'devin', id: m.id, name: m.name, inputModalities: ['text' as const] }))
    : readModelCacheSync(cachePath) ?? DEFAULT_MODELS.map((m) => ({ provider: 'devin', id: m.id, name: m.name, inputModalities: ['text' as const] }))

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
      modelsCachePath: cachePath,
      defaultModels: DEFAULT_MODELS.map((m) => ({ id: m.id, name: m.name })),
      store: createFilePatStore({
        filePath: join(dataDir, '.devin-auth.json'),
        envToken: DEVIN_VARIANT.envToken,
      }),
      authKey: createControlKey(),
    })
  })
}
