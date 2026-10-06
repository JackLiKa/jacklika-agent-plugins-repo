import { CliLlmAdapter, StreamBlockEmitter, createControlKey, createFilePatStore, type CliVariant, type PatStore, type WebRouteContext } from '@jacklika/dsh-connector-core'
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
      clearEnv: ['QODER_PERSONAL_ACCESS_TOKEN', 'QODER_CHINA_PERSONAL_ACCESS_TOKEN'],
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
      // qodercli only reads QODER_PERSONAL_ACCESS_TOKEN regardless of region;
      // the region comes from the per-variant config dir, not the env name.
      cliTokenEnv: 'QODER_PERSONAL_ACCESS_TOKEN',
      clearEnv: ['QODER_PERSONAL_ACCESS_TOKEN', 'QODER_CHINA_PERSONAL_ACCESS_TOKEN'],
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

/** Strip a legacy `id@@params` suffix left behind by the removed selector. */
function baseModelId(id: string): string {
  const idx = id.indexOf('@@')
  return idx < 0 ? id : id.slice(0, idx)
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

/**
 * Parser for qodercli `--output-format stream-json`: one complete JSON event
 * per stdout line in the Claude-Code envelope schema. `assistant` events carry
 * complete `message.content[]` snapshots that may repeat as the message grows,
 * so text/thinking are deduplicated by message id and only new suffixes are
 * emitted. `result` is the terminal event; `system`, `user`, hook, and rate-
 * limit events are protocol noise and never reach the transcript.
 */
export class QoderStreamParser {
  private readonly emitter = new StreamBlockEmitter()
  private readonly emittedLen = new Map<string, number>()

  parseLine(line: string): StreamChunk[] | undefined {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return undefined
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return undefined
    }
    const out: StreamChunk[] = []
    switch (event.type) {
      case 'assistant': {
        const message = (event.message ?? {}) as Record<string, unknown>
        const id = typeof message.id === 'string' ? message.id : 'default'
        const content = Array.isArray(message.content) ? message.content : []
        let thinking = ''
        let text = ''
        for (const block of content as Record<string, unknown>[]) {
          if (block?.type === 'thinking' && typeof block.thinking === 'string') {
            thinking += block.thinking
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            text += block.text
          }
        }
        this.emitDelta(out, 'reasoning', `${id}:reasoning`, thinking)
        this.emitDelta(out, 'text', `${id}:text`, text)
        return out
      }
      case 'result': {
        this.emitter.close(out)
        const usage = event.usage as Record<string, unknown> | undefined
        if (usage && typeof usage === 'object') {
          const tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          }
          if (typeof usage.cache_read_input_tokens === 'number') tokenUsage.cacheReadTokens = usage.cache_read_input_tokens
          if (typeof usage.cache_creation_input_tokens === 'number') tokenUsage.cacheWriteTokens = usage.cache_creation_input_tokens
          out.push({ type: 'usage', usage: tokenUsage })
        }
        if (event.is_error === true) {
          throw new Error(
            typeof event.result === 'string' && event.result.length > 0
              ? event.result
              : `qodercli error: ${typeof event.subtype === 'string' ? event.subtype : 'unknown'}`,
          )
        }
        out.push({ type: 'finish', reason: { kind: 'stop' } })
        return out
      }
      default:
        return out
    }
  }

  flush(): StreamChunk[] {
    const out: StreamChunk[] = []
    this.emitter.close(out)
    return out
  }

  private emitDelta(out: StreamChunk[], kind: 'text' | 'reasoning', key: string, full: string): void {
    const emitted = this.emittedLen.get(key) ?? 0
    if (full.length <= emitted) return
    this.emittedLen.set(key, full.length)
    this.emitter.delta(out, kind, full.slice(emitted))
  }
}

class QoderAdapter extends CliLlmAdapter {
  private parser = new QoderStreamParser()
  private readonly modelCachePath: string
  private readonly patStore: PatStore

  constructor(variant: CliVariant & { modelCachePath: string }, config: QoderConfig, patStore: PatStore) {
    const configured = config.models
    const cached = readModelCacheSync(variant.modelCachePath)
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : cached ?? variant.defaultModels
    super({ variant: { ...variant, defaultModels: models }, config: config as Record<string, unknown> })
    this.modelCachePath = variant.modelCachePath
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
    const baseId = baseModelId(model)
    return { provider, id: baseId, name: baseId }
  }

  protected buildArgs(options: GenerateOptions): string[] {
    this.parser = new QoderStreamParser()
    const base = this.buildBaseOptions(options)
    const reasoningEffort = options.reasoningEffort
    const maxTokens = options.maxTokens ?? base.maxTokens
    const args = [
      '-p',
      '--model',
      baseModelId(options.model),
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      // DSH conversations are chat-only: disable the agent toolset and any
      // user-level MCP servers so the CLI never executes tools on the user's
      // machine or spawns stdio children that keep the output pipe open.
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ]
    if (base.system) args.push('--system-prompt', base.system)
    if (maxTokens) args.push('--max-output-tokens', String(maxTokens))
    if (reasoningEffort) args.push('--reasoning-effort', String(reasoningEffort))
    args.push('--', base.prompt)
    return args
  }

  protected parseLine(line: string): StreamChunk[] | undefined {
    return this.parser.parseLine(line)
  }

  protected override flushStream(): StreamChunk[] {
    return this.parser.flush()
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
    const adapter = new QoderAdapter(variantWithCache, config, patStore)
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
