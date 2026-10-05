import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

export * from './web.js'
export * from './store.js'
export * from './params-store.js'

export interface CliVariant {
  id: string
  displayName: string
  cliCommand: string
  envToken: string
  defaultModels: LlmModelInfo[]
  cliConfigDir?: string
  /** Env var the CLI actually reads, when it differs from `envToken`. */
  cliTokenEnv?: string
  /** Env vars removed from the child environment before injection. */
  clearEnv?: readonly string[]
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'text' && typeof block.text === 'string') return block.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function lastUserPrompt(messages: GenerateOptions['messages']): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role === 'user') return extractText(message.content)
  }
  return ''
}

function firstSystemText(messages: GenerateOptions['messages'], fallback?: string): string | undefined {
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = extractText(message.content)
      if (text) return text
    }
  }
  return fallback
}

export interface CliAdapterOptions {
  variant: CliVariant
  config: Record<string, unknown>
}

/**
 * Stateful text/reasoning block emitter for provider stream parsers. Buffers
 * per-block text so `block-end` carries the assembled block, and enforces
 * single-open-block ordering across interleaved deltas.
 */
export class StreamBlockEmitter {
  private nextIndex = 0
  private open: { kind: 'text' | 'reasoning'; index: number; text: string } | null = null

  delta(out: StreamChunk[], kind: 'text' | 'reasoning', text: string): void {
    if (!text) return
    if (this.open?.kind !== kind) this.close(out)
    if (!this.open) {
      this.open = { kind, index: this.nextIndex, text: '' }
      this.nextIndex += 1
      out.push({ type: 'block-start', index: this.open.index, blockType: kind })
    }
    this.open.text += text
    out.push({
      type: kind === 'text' ? 'text-delta' : 'reasoning-delta',
      index: this.open.index,
      text,
    })
  }

  close(out: StreamChunk[]): void {
    if (!this.open) return
    out.push({
      type: 'block-end',
      index: this.open.index,
      block: { type: this.open.kind, text: this.open.text },
    })
    this.open = null
  }
}

export abstract class CliLlmAdapter extends LlmAdapter {
  protected variant: CliVariant
  protected config: Record<string, unknown>

  constructor(options: CliAdapterOptions) {
    super()
    this.variant = options.variant
    this.config = options.config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.variant.displayName }
  }

  override providerRetryPolicy(): undefined {
    return undefined
  }

  override imageRequestPricing(): undefined {
    return undefined
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return this.variant.defaultModels
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = this.variant.defaultModels.find((m) => m.id === model)
    const result: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: info?.name ?? model,
    }
    if (info?.inputModalities !== undefined) {
      result.inputModalities = info.inputModalities as readonly ModelModality[]
    }
    return result
  }

  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  protected async *readLines(stdout: Readable | null): AsyncIterable<string> {
    if (!stdout) return
    for await (const line of createInterface(stdout)) {
      yield line
    }
  }

  protected async readStderr(stderr: Readable | null): Promise<string> {
    if (!stderr) return ''
    const chunks: string[] = []
    for await (const line of createInterface(stderr)) {
      chunks.push(line)
    }
    return chunks.join('\n')
  }

  protected buildBaseOptions(options: GenerateOptions): {
    prompt: string
    system?: string
    maxTokens?: number
  } {
    const result: { prompt: string; system?: string; maxTokens?: number } = {
      prompt: lastUserPrompt(options.messages),
    }
    const system = firstSystemText(options.messages, options.system)
    if (system !== undefined) result.system = system
    if (options.maxTokens !== undefined) result.maxTokens = options.maxTokens
    return result
  }

  protected abstract buildArgs(options: GenerateOptions): string[]
  protected abstract parseLine(line: string): StreamChunk[] | undefined

  /** Chunks emitted once stdout reaches EOF, before the exit-status check. */
  protected flushStream(): StreamChunk[] {
    return []
  }

  protected async resolveToken(): Promise<string | undefined> {
    return process.env[this.variant.envToken]
  }

  protected spawnManaged(
    args: string[],
    env: NodeJS.ProcessEnv,
    options: GenerateOptions,
    endStdin = true,
  ): { child: ChildProcess; cleanup: () => void } {
    const child: ChildProcess = spawn(this.variant.cliCommand, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    if (endStdin) child.stdin?.end()

    let killTimer: NodeJS.Timeout | undefined
    const terminate = () => {
      if (child.killed) return
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 5000)
      killTimer.unref?.()
    }
    const hardTimeout = setTimeout(terminate, 120_000)

    const abort = terminate
    options.signal?.addEventListener('abort', abort)

    const cleanup = () => {
      clearTimeout(hardTimeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      terminate()
    }
    child.once('exit', () => {
      clearTimeout(hardTimeout)
      if (killTimer) clearTimeout(killTimer)
    })
    return { child, cleanup }
  }

  protected buildProcessEnv(token: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of this.variant.clearEnv ?? []) delete env[key]
    env[this.variant.cliTokenEnv ?? this.variant.envToken] = token
    if (this.variant.cliConfigDir) env.QODER_CONFIG_DIR = this.variant.cliConfigDir
    return env
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const token = await this.resolveToken()
    if (!token || token.length === 0) {
      throw new Error(`Missing environment token: ${this.variant.envToken}`)
    }

    const { child, cleanup } = this.spawnManaged(
      this.buildArgs(options),
      this.buildProcessEnv(token),
      options,
    )

    let sawFinish = false
    // Read stdout to a terminal `finish` chunk or process exit — never EOF.
    // CLIs like qodercli spawn MCP/daemon children that inherit the stdout
    // pipe, which would keep readline open forever after the main process
    // finished and leave the harness permanently "thinking".
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => resolve({ code }))
    })
    const stderrPromise = this.readStderr(child.stderr ?? null).catch(() => '')
    try {
      const lines = child.stdout ? createInterface(child.stdout) : null
      const iterator = lines?.[Symbol.asyncIterator]()
      while (iterator && !sawFinish) {
        const next = await Promise.race([iterator.next(), exitPromise.then(() => null)])
        if (next === null || next.done) break
        const chunks = this.parseLine(next.value)
        if (!chunks) continue
        for (const chunk of chunks) {
          if (chunk.type === 'finish') sawFinish = true
          yield chunk
        }
      }

      for (const chunk of this.flushStream()) {
        if (chunk.type === 'finish') sawFinish = true
        yield chunk
      }

      if (!sawFinish) {
        cleanup()
        const { code } = await exitPromise
        const stderr = await Promise.race([
          stderrPromise,
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 2000)),
        ])
        if (code !== 0 && code !== null) {
          throw new Error(
            `${this.variant.cliCommand} exited with ${code}${stderr ? `: ${stderr}` : ''}`,
          )
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } finally {
      cleanup()
    }
  }
}
