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
  protected abstract parseLine(line: string): StreamChunk | undefined

  protected async resolveToken(): Promise<string | undefined> {
    return process.env[this.variant.envToken]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const token = await this.resolveToken()
    if (!token || token.length === 0) {
      throw new Error(`Missing environment token: ${this.variant.envToken}`)
    }

    const args = this.buildArgs(options)
    const env: NodeJS.ProcessEnv = { ...process.env, [this.variant.envToken]: token }
    if (this.variant.cliConfigDir) env.QODER_CONFIG_DIR = this.variant.cliConfigDir
    const child: ChildProcess = spawn(this.variant.cliCommand, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const abort = () => {
      if (!child.killed) child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', abort)

    let accumulated = ''
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }

      for await (const line of this.readLines(child.stdout ?? null)) {
        const chunk = this.parseLine(line)
        if (chunk) {
          if (chunk.type === 'text-delta') accumulated += chunk.text
          yield chunk
        }
      }

      const stderr = await this.readStderr(child.stderr ?? null)
      if (child.exitCode !== 0 && child.exitCode !== null) {
        throw new Error(
          `${this.variant.cliCommand} exited with ${child.exitCode}${stderr ? `: ${stderr}` : ''}`,
        )
      }

      yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulated } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (!child.killed) child.kill('SIGTERM')
    }
  }
}
