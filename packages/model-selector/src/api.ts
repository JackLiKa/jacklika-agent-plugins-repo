import type { ModelParams } from './model/types.ts'

const STORAGE_KEY = '@jacklika/dsh-model-selector:params'

function selectEndpoint(providerId: string): string | undefined {
  const base = 'http://127.0.0.1:19387'
  if (providerId === 'devin') return `${base}/plugins/dsh-devin-connect/select`
  if (providerId.startsWith('qoder')) return `${base}/plugins/dsh-qoder-connect/select/${providerId}`
  return undefined
}

function storageKey(providerId: string, modelId: string): string {
  return `${STORAGE_KEY}:${providerId}:${modelId}`
}

export function readStoredParams(providerId: string, modelId: string): ModelParams {
  try {
    const raw = localStorage.getItem(storageKey(providerId, modelId))
    if (raw === null) return {}
    return JSON.parse(raw) as ModelParams
  } catch {
    return {}
  }
}

function writeStoredParams(providerId: string, modelId: string, params: ModelParams): void {
  try {
    localStorage.setItem(storageKey(providerId, modelId), JSON.stringify(params))
  } catch {
    // ignore storage errors
  }
}

export async function persistModelParams(
  providerId: string,
  modelId: string,
  params: ModelParams,
): Promise<boolean> {
  writeStoredParams(providerId, modelId, params)
  const endpoint = selectEndpoint(providerId)
  if (endpoint === undefined) return true
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        contextWindow: params.contextWindow,
        reasoningEffort: params.reasoningEffort,
        maxTokens: params.maxTokens,
      }),
    })
    return response.ok
  } catch {
    return false
  }
}
