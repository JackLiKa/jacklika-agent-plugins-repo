interface QoderVariantEndpoints {
  apiBase: string
  openapiBase: string
}

export const QODER_ENDPOINTS: Record<string, QoderVariantEndpoints> = {
  qoder: {
    apiBase: 'https://api.qoder.com.cn/api/v1/cloud',
    openapiBase: 'https://openapi.qoder.com.cn',
  },
  'qoder-global': {
    apiBase: 'https://api.qoder.com/api/v1/cloud',
    openapiBase: 'https://openapi.qoder.sh',
  },
}

export interface QoderModel {
  id: string
  name: string
  contextWindow?: number
  defaultContextWindow?: number
  supportedContextWindows?: number[]
}

export interface QoderUsage {
  userQuota?: {
    total: number
    used: number
    remaining: number
    percentage: number
    unit: string
  }
  addOnQuota?: {
    total: number
    used: number
    remaining: number
    unit: string
  }
  orgResourcePackage?: {
    cap: number
    used: number
    remaining: number
    percentage: number
    unit: string
  }
  totalUsagePercentage?: number
  expiresAt?: number
  isQuotaExceeded?: boolean
  credits?: {
    accounts: Array<{
      packageName: string
      remain: number
      size: number
      packageEndTime?: string
      unlimited?: boolean
    }>
    unlimited?: boolean
    total?: number
    totalSize?: number
    cycleResetTime?: string
  }
  creditsError?: string
}

async function qoderFetch<T>(pat: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}

function getEndpoints(variantId: string): QoderVariantEndpoints {
  const endpoints = QODER_ENDPOINTS[variantId] ?? QODER_ENDPOINTS.qoder
  if (endpoints === undefined) throw new Error('unknown qoder variant')
  return endpoints
}

export async function listQoderModels(pat: string, variantId: string): Promise<QoderModel[]> {
  const { apiBase } = getEndpoints(variantId)
  const { data } = await qoderFetch<{ data?: Array<Record<string, unknown>> }>(pat, `${apiBase}/models`)
  return (data ?? []).map((m) => {
    const model: QoderModel = {
      id: String(m.id ?? ''),
      name: String(m.display_name ?? m.id ?? ''),
    }
    if (typeof m.max_input_tokens === 'number') model.contextWindow = m.max_input_tokens
    if (typeof m.default_context_window === 'number') model.defaultContextWindow = m.default_context_window
    if (Array.isArray(m.available_context_windows)) {
      model.supportedContextWindows = m.available_context_windows.filter(
        (v): v is number => typeof v === 'number',
      )
    }
    return model
  })
}

export async function fetchQoderUsage(pat: string, variantId: string): Promise<QoderUsage> {
  const { openapiBase } = getEndpoints(variantId)
  return qoderFetch<QoderUsage>(pat, `${openapiBase}/api/v2/quota/usage`)
}

export async function verifyQoderPat(pat: string, variantId: string): Promise<{ valid: boolean; userType?: string }> {
  try {
    const { apiBase } = getEndpoints(variantId)
    const result = await qoderFetch<{ data?: unknown[]; object?: string }>(pat, `${apiBase}/agents?limit=1`)
    const info: { valid: true; userType?: string } = { valid: true }
    if (typeof result.object === 'string') info.userType = result.object
    return info
  } catch {
    return { valid: false }
  }
}
