export interface DevinStatusSignedOut {
  status: 'signed-out'
  reason?: string
  authKey: string
}

export interface DevinStatusSignedIn {
  status: 'signed-in'
  authKey: string
  pat: { source: string; tail: string }
  catalog: { source: string; fetchedAt: number }
  user: { email?: string; name?: string; organizations: string[] }
  models: unknown[]
}

export interface DevinStatusError {
  status: 'error'
  message: string
  authKey: string
}

export type DevinWebStatus = DevinStatusSignedOut | DevinStatusSignedIn | DevinStatusError

export function isDevinWebStatus(value: unknown): value is DevinWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  if (status === 'signed-out' || status === 'signed-in') return true
  return status === 'error' && typeof (value as Record<string, unknown>)['message'] === 'string'
}
