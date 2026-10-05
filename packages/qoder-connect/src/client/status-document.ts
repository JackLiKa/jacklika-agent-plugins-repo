/** Minimal discriminated status document coming from the host.
 * 200 does not mean the body is usable — it may be empty, null, a proxy page, or an array.
 */
export interface QoderStatusSignedOut {
  status: 'signed-out'
  reason?: string
  authKey: string
}

export interface QoderPlan {
  userType?: string
  planTierName?: string
  planTier?: string
  isPersonalVersion?: boolean
  isHighestTier?: boolean
  isRenewed?: boolean
  startDate?: string
  endDate?: string
  organization?: { orgId: string; orgName: string; roleName?: string }
  featureAllowed?: { quest: boolean; wiki: boolean; codeReview: boolean }
}

export interface QoderAccountStatus {
  allowByok: number
  teamAllowByok?: number
  isPrivacyPolicyModifiable?: boolean
}

export interface QoderStatusSignedIn {
  status: 'signed-in'
  authKey: string
  probeKey: string
  pat: { source: string; tail: string }
  catalog: { source: string; fetchedAt: number }
  user?: { username?: string; email?: string; userType?: string; orgId?: string; avatarUrl?: string; allowByok?: boolean }
  plan?: QoderPlan
  accountStatus?: QoderAccountStatus
  models: unknown[]
  credits?: QoderCredits
  probe?: QoderProbe
}

export interface QoderStatusError {
  status: 'error'
  message: string
  authKey: string
}

export type QoderWebStatus = QoderStatusSignedOut | QoderStatusSignedIn | QoderStatusError

export interface QoderCredits {
  accounts: QoderAccount[]
  unlimited?: boolean
  total?: number
  totalSize?: number
  cycleResetTime?: string
  percentage?: number
  isQuotaExceeded?: boolean
  error?: string
}

export interface QoderAccount {
  packageName: string
  remain: number
  size: number
  packageEndTime?: string
  unlimited?: boolean
}

export interface QoderProbe {
  candidates: unknown[]
  results: unknown[]
}

export function isQoderWebStatus(value: unknown): value is QoderWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  if (status === 'signed-out' || status === 'signed-in') return true
  return status === 'error' && typeof (value as Record<string, unknown>)['message'] === 'string'
}
