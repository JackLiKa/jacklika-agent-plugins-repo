import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface FilePatStoreOptions {
  filePath: string
  envToken?: string
}

export interface PatStore {
  get(): string | undefined | Promise<string | undefined>
  set(value: string): Promise<{ ok: true; tail: string } | { ok: false; error: string }>
  clear(): Promise<{ ok: true }>
}

export function createFilePatStore(options: FilePatStoreOptions): PatStore {
  let memory: string | undefined
  let loaded = false

  async function load(): Promise<string | undefined> {
    if (loaded) return memory
    loaded = true
    const env = options.envToken ? process.env[options.envToken] : undefined
    if (env) {
      memory = env
      return memory
    }
    try {
      const text = await readFile(options.filePath, 'utf8')
      const data = JSON.parse(text) as unknown
      if (data && typeof data === 'object' && 'pat' in data && typeof (data as Record<string, unknown>).pat === 'string') {
        memory = (data as Record<string, unknown>).pat as string
      }
    } catch {
      // File missing or unreadable is fine.
    }
    return memory
  }

  function tail(value: string): string {
    if (value.length < 8) return '***'
    return `***${value.slice(-4)}`
  }

  return {
    async get() {
      return load()
    },
    async set(value: string) {
      try {
        await mkdir(dirname(options.filePath), { recursive: true })
        await writeFile(options.filePath, JSON.stringify({ pat: value, savedAt: Date.now() }, null, 2), { mode: 0o600 })
        memory = value
        return { ok: true as const, tail: tail(value) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false as const, error: message }
      }
    },
    async clear() {
      try {
        await unlink(options.filePath)
      } catch {
        // ignore
      }
      memory = undefined
      loaded = true
      return { ok: true as const }
    },
  }
}
