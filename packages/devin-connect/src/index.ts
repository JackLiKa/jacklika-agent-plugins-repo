import { CliLlmAdapter, createControlKey, type CliVariant, type WebRouteContext } from '@jacklika/dsh-connector-core'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { registerDevinWebRoutes, type PatStore } from './server.js'

const DEFAULT_MODELS: LlmModelInfo[] = [
  { provider: 'devin', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', inputModalities: ['text'] },
  { provider: 'devin', id: 'claude-opus-4.6', name: 'Claude Opus 4.6', inputModalities: ['text'] },
  { provider: 'devin', id: 'opus', name: 'Opus', inputModalities: ['text'] },
  { provider: 'devin', id: 'codex', name: 'Codex', inputModalities: ['text'] },
]

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

class DevinAdapter extends CliLlmAdapter {
  constructor(variant: CliVariant, config: DevinConfig) {
    const configured = config.models
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : variant.defaultModels
    super({ variant: { ...variant, cliCommand: config.cliCommand, defaultModels: models }, config: config as Record<string, unknown> })
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

function createPatStore(envToken: string): PatStore {
  let saved: string | undefined
  return {
    get() {
      return saved ?? process.env[envToken]
    },
    async set(value: string) {
      saved = value
      return { ok: true as const, tail: `***${value.slice(-4)}` }
    },
    async clear() {
      saved = undefined
      return { ok: true as const }
    },
  }
}

export function apply(ctx: any, config: DevinConfig) {
  if (!config.enabled) return

  const adapter = new DevinAdapter(DEVIN_VARIANT, config)
  const releaseAdapter = ctx.llm.registerAdapter([DEVIN_VARIANT.id], adapter)
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: DEVIN_VARIANT.id,
      displayName: DEVIN_VARIANT.displayName,
      settingsNs: 'devin',
      settingsPath: [],
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
      store: createPatStore(DEVIN_VARIANT.envToken),
      authKey: createControlKey(),
    })
  })
}
