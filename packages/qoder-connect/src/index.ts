import { CliLlmAdapter, createControlKey, createFilePatStore, type CliVariant, type WebRouteContext } from '@jacklika/dsh-connector-core'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
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
  const profile = ctx.get?.('profileContext')?.name ?? 'default'
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
export const inject = ['llm'] as const

class QoderAdapter extends CliLlmAdapter {
  constructor(variant: CliVariant, config: QoderConfig) {
    const configured = config.models
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : variant.defaultModels
    super({ variant: { ...variant, defaultModels: models }, config: config as Record<string, unknown> })
  }

  protected buildArgs(options: GenerateOptions): string[] {
    const base = this.buildBaseOptions(options)
    const args = [
      '-p',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
      '--no-session-persistence',
    ]
    if (base.system) args.push('--system-prompt', base.system)
    if (base.maxTokens) args.push('--max-output-tokens', String(base.maxTokens))
    if (options.reasoningEffort) args.push('--reasoning-effort', String(options.reasoningEffort))
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
  const providers: any[] = []

  for (const variant of variants) {
    const adapter = new QoderAdapter(variant, config)
    adapters.push(adapter)
    providers.push({
      provider: variant.id,
      displayName: variant.displayName,
      settingsNs: 'qoder',
      settingsPath: [],
    })
  }

  const releaseAdapters: Array<() => void> = []
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i]!
    const adapter = adapters[i]!
    releaseAdapters.push(ctx.llm.registerAdapter([variant.id], adapter))
  }

  const releaseDirectory = ctx.llm.registerConfigurableProviders(providers)

  ctx.effect(() => () => {
    releaseAdapters.forEach((release) => release())
    releaseDirectory?.()
  })

  ctx.inject(['webServer'], (webCtx: WebRouteContext) => {
    const runtimes = variants.map((variant) => ({
      id: variant.id,
      envToken: variant.envToken,
      cliConfigDir: variant.cliConfigDir,
      region: variant.region,
      statusPath: variant.statusPath,
      authPath: variant.authPath,
      probePath: variant.probePath,
      store: createFilePatStore({
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
