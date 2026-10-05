import { CliLlmAdapter, StreamBlockEmitter, createControlKey, createFilePatStore, type CliVariant, type PatStore, type WebRouteContext } from '@jacklika/dsh-connector-core'
import type { FinishReason, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
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
  clearEnv: ['DEVIN_API_KEY', 'DEVIN_MODEL'],
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
  private readonly patStore: PatStore
  private readonly selectedParams = new Map<string, AdapterModelParams>()

  constructor(variant: CliVariant, config: DevinConfig, dataDir: string, patStore: PatStore) {
    const configured = config.models
    const models = configured.length > 0
      ? configured.map((m) => ({ provider: variant.id, id: m.id, name: m.name, inputModalities: ['text' as const] }))
      : withFamilyPrefix(variant.defaultModels)
    super({ variant: { ...variant, cliCommand: config.cliCommand, defaultModels: models }, config: config as Record<string, unknown> })
    this.cachePath = modelCachePath(dataDir)
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

  /**
   * `devin -p` requires a TTY and only renders its TUI banner under pipes, so
   * the adapter speaks ACP (Agent Client Protocol, newline-delimited JSON-RPC)
   * over stdio — `devin acp` is the CLI's supported headless surface.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const token = await this.resolveToken()
    if (!token || token.length === 0) {
      throw new Error(`Missing environment token: ${this.variant.envToken}`)
    }
    const base = this.buildBaseOptions(options)
    const prompt = base.system ? `${base.system}\n\n${base.prompt}` : base.prompt
    const { child, cleanup } = this.spawnManaged(
      this.buildArgs(options),
      this.buildProcessEnv(token),
      options,
      false,
    )
    const stderrPromise = this.readStderr(child.stderr ?? null)

    let nextId = 1
    const pending = new Map<number, { resolve: (v: Record<string, unknown> | undefined) => void; reject: (e: Error) => void }>()
    const notifications: Record<string, unknown>[] = []
    let notifyWaiter: (() => void) | null = null
    let streamEnded = false
    const wake = () => {
      const waiter = notifyWaiter
      notifyWaiter = null
      waiter?.()
    }

    const send = (msg: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`)
    }
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const id = nextId
        nextId += 1
        pending.set(id, { resolve, reject })
        send({ jsonrpc: '2.0', id, method, params })
      })

    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return
      }
      if (typeof msg.id === 'number' && msg.method === undefined) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        if (!entry) return
        const err = msg.error as { message?: string; code?: number } | undefined
        if (err) entry.reject(new Error(err.message ?? `devin acp error ${err.code ?? ''}`))
        else entry.resolve(msg.result as Record<string, unknown> | undefined)
      } else if (typeof msg.method === 'string' && typeof msg.id === 'number') {
        if (msg.method === 'session/request_permission') {
          send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
        } else {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })
        }
      } else if (typeof msg.method === 'string') {
        notifications.push(msg)
        wake()
      }
    })
    rl.on('close', () => {
      streamEnded = true
      wake()
    })
    // The agent's MCP/tool children can inherit the stdout pipe and keep it
    // open after the main process exits, so treat process exit as end-of-
    // stream rather than relying on `rl 'close'` alone.
    let exited = false
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => {
        exited = true
        wake()
        resolve({ code })
      })
    })

    const sessionRef: { id?: string } = {}
    const abortHandler = () => {
      if (sessionRef.id) {
        send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionRef.id } })
      }
    }
    options.signal?.addEventListener('abort', abortHandler)

    let finished = false
    let promptError: Error | undefined
    let stopReason: string | undefined
    let promptResult: Record<string, unknown> | undefined
    const take = () =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        const check = () => {
          if (notifications.length > 0) return resolve(notifications.shift()!)
          if (streamEnded || finished || exited) return resolve(null)
          notifyWaiter = check
        }
        check()
      })

    try {
      const init = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'dsh-devin-connect', version: '0.1.0' },
      })
      const authMethods = init?.authMethods
      if (Array.isArray(authMethods) && authMethods.length > 0) {
        const methodId = (authMethods[0] as Record<string, unknown>).id
        if (typeof methodId === 'string') {
          try {
            // The Devin ACP host accepts the PAT through `meta.api_key`
            // regardless of the advertised browser method id.
            await request('authenticate', { methodId, meta: { api_key: token } })
          } catch {
            // env token may already satisfy authentication
          }
        }
      }
      const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = session?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('devin acp did not return a sessionId')
      }
      sessionRef.id = sessionId

      const emitter = new StreamBlockEmitter()
      request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
        .then((result) => {
          finished = true
          promptResult = result
          stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn'
          wake()
        })
        .catch((error: Error) => {
          finished = true
          promptError = error
          wake()
        })

      while (true) {
        const note = await take()
        if (note === null) break
        if (note.method !== 'session/update') continue
        const update = (note.params as Record<string, unknown> | undefined)?.update as
          | Record<string, unknown>
          | undefined
        const content = update?.content as Record<string, unknown> | undefined
        const out: StreamChunk[] = []
        if (update?.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
          emitter.delta(out, 'text', content.text)
        } else if (update?.sessionUpdate === 'agent_thought_chunk' && content?.type === 'text' && typeof content.text === 'string') {
          emitter.delta(out, 'reasoning', content.text)
        }
        for (const chunk of out) yield chunk
      }

      const tail: StreamChunk[] = []
      emitter.close(tail)
      for (const chunk of tail) yield chunk

      if (promptError) throw promptError
      if (!finished) {
        const { code } = await Promise.race([
          exitPromise,
          new Promise<{ code: number | null }>((resolve) => setTimeout(() => resolve({ code: null }), 2000)),
        ])
        const stderr = await Promise.race([
          stderrPromise,
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 2000)),
        ])
        throw new Error(
          `devin acp terminated before the prompt completed${code !== null ? ` (exit ${code})` : ''}${stderr ? `: ${stderr}` : ''}`,
        )
      }
      const usage = promptResult?.usage as Record<string, unknown> | undefined
      if (usage) {
        const tokenUsage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number; totalTokens?: number } = {
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
        }
        if (typeof usage.cachedWriteTokens === 'number') tokenUsage.cacheWriteTokens = usage.cachedWriteTokens
        if (typeof usage.cachedReadTokens === 'number') tokenUsage.cacheReadTokens = usage.cachedReadTokens
        if (typeof usage.totalTokens === 'number') tokenUsage.totalTokens = usage.totalTokens
        yield { type: 'usage', usage: tokenUsage }
      }
      yield { type: 'finish', reason: acpFinishReason(stopReason) }
    } finally {
      options.signal?.removeEventListener('abort', abortHandler)
      rl.close()
      cleanup()
    }
  }

  protected buildArgs(options: GenerateOptions): string[] {
    const args = ['acp']
    if (options.model) args.push('--model', options.model)
    return args
  }

  protected parseLine(): StreamChunk[] | undefined {
    return undefined
  }
}

function acpFinishReason(stopReason: string | undefined): FinishReason {
  switch (stopReason) {
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: 'request cancelled', code: 'CANCELLED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: 'model refused the request', code: 'REFUSAL' } }
    default:
      return { kind: 'stop' }
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
