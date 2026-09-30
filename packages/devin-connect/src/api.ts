const DEVIN_BASE_URL = 'https://api.devin.ai'

export interface DevinSelf {
  user_id?: string
  email?: string
  name?: string
  organizations?: Array<{ id: string; name: string }>
}

async function devinFetch<T>(pat: string, path: string): Promise<T> {
  const response = await fetch(`${DEVIN_BASE_URL}${path}`, {
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

export async function fetchDevinSelf(pat: string): Promise<DevinSelf> {
  return devinFetch<DevinSelf>(pat, '/v3/self')
}

export async function verifyDevinPat(pat: string): Promise<{ valid: boolean; user?: DevinSelf }> {
  try {
    const self = await fetchDevinSelf(pat)
    return { valid: true, user: self }
  } catch {
    return { valid: false }
  }
}
