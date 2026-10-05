import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface QoderModel {
  id: string
  name: string
}

export interface QoderUser {
  username?: string
  email?: string
  user_type?: string
  org_id?: string
  avatar_url?: string
  allow_byok?: number
}

export interface QoderUsageQuota {
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
}

export interface QoderUsage {
  userQuota?: QoderUsageQuota | undefined
  orgResourcePackage?: QoderUsageQuota | undefined
  addOnQuota?: QoderUsageQuota | undefined
  totalUsagePercentage?: number | undefined
  isQuotaExceeded?: boolean | undefined
  expiresAt?: string | undefined
}

const qoderRegionEndpoints = {
  global: { openApi: 'https://openapi.qoder.sh' },
  china: { openApi: 'https://openapi.qoder.com.cn' },
} as const

type QoderRegion = keyof typeof qoderRegionEndpoints

interface QoderAuthState {
  jobToken: string
  refreshToken?: string | undefined
  userId: string
  name: string
  email: string
  expiresAt: number
}

const jobTokenCache = new Map<string, QoderAuthState>()

const qoderUserAgent = 'qoder/1.1.47'

async function exchangePat(pat: string, region: QoderRegion): Promise<QoderAuthState> {
  const cached = jobTokenCache.get(`${region}:${pat}`)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached
  }
  const openApi = qoderRegionEndpoints[region].openApi
  const response = await fetch(`${openApi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': qoderUserAgent,
      'cosy-version': '1.0.1',
      'cosy-clienttype': '5',
    },
    body: JSON.stringify({ personal_token: pat }),
  })
  if (!response.ok) {
    throw new Error(`jobToken exchange failed: ${response.status}`)
  }
  const data = await response.json() as {
    token: string
    refresh_token?: string
    expires_at?: number
    expires_in?: number
    user?: { id?: string; name?: string; email?: string }
  }
  if (!data.token) {
    throw new Error('jobToken exchange returned no token')
  }
  const auth: QoderAuthState = {
    jobToken: data.token,
    refreshToken: data.refresh_token,
    userId: data.user?.id ?? '',
    name: data.user?.name ?? '',
    email: data.user?.email ?? '',
    expiresAt: data.expires_at ?? (Date.now() + (data.expires_in ?? 86400) * 1000),
  }
  // If exchange didn't include user info, fetch it separately.
  if (!auth.userId) {
    const userInfo = await fetchQoderUserInfo(auth.jobToken, region)
    if (userInfo) {
      auth.userId = userInfo.id ?? auth.userId
      auth.name = userInfo.name ?? auth.name
      auth.email = userInfo.email ?? auth.email
    }
  }
  jobTokenCache.set(`${region}:${pat}`, auth)
  return auth
}

async function fetchQoderUserInfo(jobToken: string, region: QoderRegion): Promise<{ id?: string; name?: string; email?: string } | undefined> {
  const openApi = qoderRegionEndpoints[region].openApi
  try {
    const response = await fetch(`${openApi}/api/v1/userinfo`, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: 'application/json',
        'User-Agent': qoderUserAgent,
      },
    })
    if (!response.ok) return undefined
    return await response.json() as { id?: string; name?: string; email?: string }
  } catch {
    return undefined
  }
}

interface QoderCliResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

async function runQoderCli(
  args: string[],
  options: { pat?: string; cliConfigDir: string },
): Promise<QoderCliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, QODER_CONFIG_DIR: options.cliConfigDir }
  if (options.pat) env.QODER_PERSONAL_ACCESS_TOKEN = options.pat
  return new Promise((resolve) => {
    const child = spawn('qodercli', args, { env })
    const stdout: string[] = []
    const stderr: string[] = []
    if (child.stdout) {
      createInterface(child.stdout).on('line', (line) => stdout.push(line))
    }
    if (child.stderr) {
      createInterface(child.stderr).on('line', (line) => stderr.push(line))
    }
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode })
    })
  })
}

export async function listQoderModels(pat: string, cliConfigDir: string): Promise<QoderModel[]> {
  const result = await runQoderCli(['--list-models'], { pat, cliConfigDir })
  if (!result.ok) {
    throw new Error(result.stderr || `qodercli exited with ${result.exitCode}`)
  }
  const lines = result.stdout.split('\n')
  const modelLines = lines.slice(lines.findIndex((l) => l.trim() === 'MODEL') + 1)
  return modelLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((id) => ({ id, name: id }))
}

export async function fetchQoderUser(pat: string, cliConfigDir: string): Promise<QoderUser | undefined> {
  const result = await runQoderCli(['status', '-o', 'json'], { pat, cliConfigDir })
  if (!result.ok) return undefined
  try {
    return JSON.parse(result.stdout) as QoderUser
  } catch {
    return undefined
  }
}

export async function verifyQoderPat(pat: string, cliConfigDir: string): Promise<{ valid: boolean }> {
  try {
    await listQoderModels(pat, cliConfigDir)
    return { valid: true }
  } catch {
    return { valid: false }
  }
}

async function openApiJsonRequest<T>(
  pat: string,
  region: QoderRegion,
  endpoint: string,
): Promise<T | undefined> {
  const auth = await exchangePat(pat, region)
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.jobToken}`,
      Accept: 'application/json',
      'accept-encoding': 'identity',
      'User-Agent': qoderUserAgent,
      'cosy-version': '1.0.1',
      'cosy-clienttype': '5',
    },
  })
  if (!response.ok) return undefined
  return (await response.json()) as T
}

export async function fetchQoderUserProfile(
  pat: string,
  region: QoderRegion = 'global',
): Promise<{ username?: string | undefined; email?: string | undefined; userType?: string | undefined; orgId?: string | undefined; avatarUrl?: string | undefined } | undefined> {
  const auth = await exchangePat(pat, region)
  if (!auth.userId && !auth.email && !auth.name) return undefined
  return {
    username: auth.name || undefined,
    email: auth.email || undefined,
  }
}

export async function fetchQoderUsage(
  pat: string,
  region: QoderRegion = 'global',
): Promise<QoderUsage | undefined> {
  const openApi = qoderRegionEndpoints[region].openApi
  const raw = await openApiJsonRequest<Record<string, unknown>>(pat, region, `${openApi}/api/v2/quota/usage`)
  if (!raw || typeof raw !== 'object') return undefined
  return {
    userQuota: normalizeQuota(raw.userQuota),
    orgResourcePackage: normalizeQuota(raw.orgResourcePackage),
    addOnQuota: normalizeQuota(raw.addOnQuota),
    totalUsagePercentage: asNumber(raw.totalUsagePercentage),
    isQuotaExceeded: typeof raw.isQuotaExceeded === 'boolean' ? raw.isQuotaExceeded : false,
    expiresAt: normalizeDate(raw.expiresAt),
  }
}

export interface QoderPlan {
  userType?: string | undefined
  planTierName?: string | undefined
  planTier?: string | undefined
  isPersonalVersion?: boolean | undefined
  isHighestTier?: boolean | undefined
  isRenewed?: boolean | undefined
  startDate?: string | undefined
  endDate?: string | undefined
  organization?: { orgId: string; orgName: string; roleName?: string | undefined } | undefined
  featureAllowed?: { quest: boolean; wiki: boolean; codeReview: boolean } | undefined
}

export async function fetchQoderPlan(
  pat: string,
  region: QoderRegion = 'global',
): Promise<QoderPlan | undefined> {
  const openApi = qoderRegionEndpoints[region].openApi
  const raw = await openApiJsonRequest<Record<string, unknown>>(pat, region, `${openApi}/api/v2/user/plan`)
  if (!raw || typeof raw !== 'object') return undefined
  const userType = asString(raw.user_type ?? raw.userType)
  const planTierName = asString(raw.plan_tier_name ?? raw.planTierName ?? raw.plan_name ?? raw.planName)
  if (!userType || !planTierName) return undefined
  return {
    userType,
    planTierName,
    planTier: asString(raw.plan_tier ?? raw.planTier),
    isPersonalVersion: asBoolean(raw.is_personal_version ?? raw.isPersonalVersion),
    isHighestTier: asBoolean(raw.is_highest_tier ?? raw.isHighestTier),
    isRenewed: asBoolean(raw.is_renewed ?? raw.isRenewed),
    startDate: normalizeDate(raw.start_date ?? raw.startDate),
    endDate: normalizeDate(raw.end_date ?? raw.endDate),
    organization: normalizeOrganization(raw.organization),
    featureAllowed: normalizeFeatureAllowed(raw.feature_allowed ?? raw.featureAllowed),
  }
}

export interface QoderAccountStatus {
  allowByok: number
  teamAllowByok?: number
  isPrivacyPolicyModifiable?: boolean
}

export async function fetchQoderStatus(
  pat: string,
  region: QoderRegion = 'global',
): Promise<QoderAccountStatus | undefined> {
  const openApi = qoderRegionEndpoints[region].openApi
  const raw = await openApiJsonRequest<Record<string, unknown>>(pat, region, `${openApi}/api/v3/user/status`)
  if (!raw || typeof raw !== 'object') return undefined
  const featureSwitches = (raw.featureSwitches ?? raw.feature_switches) as Record<string, unknown> | undefined
  const teamSwitches = (raw.teamSwitches ?? raw.team_switches) as Record<string, unknown> | undefined
  const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0
  const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok)
  const isPrivacyPolicyModifiable = asBoolean(raw.isPrivacyPolicyModifiable ?? raw.is_data_policy_modifiable)
  const result: QoderAccountStatus = { allowByok }
  if (teamAllowByok !== undefined) result.teamAllowByok = teamAllowByok
  if (isPrivacyPolicyModifiable !== undefined) result.isPrivacyPolicyModifiable = isPrivacyPolicyModifiable
  return result
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function normalizeQuota(raw: unknown): QoderUsageQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const total = asNumber(obj.total) ?? asNumber(obj.cap) ?? (asNumber(obj.remaining) !== undefined && asNumber(obj.used) !== undefined ? (asNumber(obj.remaining)! + asNumber(obj.used)!) : undefined) ?? 0
  const used = asNumber(obj.used) ?? 0
  const remaining = asNumber(obj.remaining) ?? Math.max(0, total - used)
  let percentage: number
  if (asNumber(obj.percentage) !== undefined) {
    const p = asNumber(obj.percentage)!
    percentage = p <= 1 && total > 1 ? p * 100 : p
  } else {
    percentage = total > 0 ? (used / total) * 100 : 0
  }
  const unit = asString(obj.unit) ?? 'credits'
  return { total, used, remaining, percentage, unit }
}

function normalizeDate(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number' && raw > 0) return new Date(raw).toISOString()
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed) && parsed > 0) return new Date(parsed).toISOString()
  }
  return undefined
}

function normalizeOrganization(raw: unknown): QoderPlan['organization'] {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const orgId = asString(obj.org_id ?? obj.orgId ?? obj.id)
  const orgName = asString(obj.org_name ?? obj.orgName ?? obj.name)
  if (!orgId || !orgName) return undefined
  return {
    orgId,
    orgName,
    roleName: asString(obj.role_name ?? obj.roleName),
  }
}

function normalizeFeatureAllowed(raw: unknown): QoderPlan['featureAllowed'] {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  return {
    quest: asBoolean(obj.quest) ?? false,
    wiki: asBoolean(obj.wiki) ?? false,
    codeReview: asBoolean(obj.code_review ?? obj.codeReview) ?? false,
  }
}
