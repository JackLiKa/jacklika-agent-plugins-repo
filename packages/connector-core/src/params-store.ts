import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SelectedParams {
  contextWindow?: number | undefined
  reasoningEffort?: string | undefined
  maxTokens?: number | undefined
}

export interface SelectedParamsStore {
  readonly path: string
  readSync(modelId: string): SelectedParams | undefined
  write(modelId: string, params: SelectedParams): void
}

export function createSelectedParamsStore(dataDir: string): SelectedParamsStore {
  const path = join(dataDir, 'selected-params.json')

  function readAll(): Record<string, SelectedParams> {
    try {
      const text = readFileSync(path, 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, SelectedParams>
      }
    } catch {
      // missing or malformed store
    }
    return {}
  }

  return {
    path,
    readSync(modelId: string): SelectedParams | undefined {
      return readAll()[modelId]
    },
    write(modelId: string, params: SelectedParams): void {
      const all = readAll()
      all[modelId] = params
      writeFileSync(path, JSON.stringify(all), 'utf8')
    },
  }
}
