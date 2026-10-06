import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decodeGetCliModelConfigsResponse,
  encodeGetCliModelConfigsRequest,
  maybeGunzip,
} from './devin-proto.js'

const DEVIN_BASE_URL = 'https://api.devin.ai'

function normalizeDevinSessionToken(token: string): string {
  const prefix = 'devin-session-token$'
  return token.startsWith(prefix) ? token : `${prefix}${token}`
}

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

export interface DevinModel {
  id: string
  name: string
  family?: string
  description?: string
}

interface DevinCredentials {
  apiKey: string
  apiServerUrl: string
}

function devinCredentialsPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'devin', 'credentials.toml')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'devin', 'credentials.toml')
}

function parseTomlish(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
    }
    result[key] = value
  }
  return result
}

async function readDevinCredentials(): Promise<DevinCredentials | undefined> {
  try {
    const text = await readFile(devinCredentialsPath(), 'utf8')
    const data = parseTomlish(text)
    const apiKey = data.windsurf_api_key ?? data.api_key
    if (!apiKey) return undefined
    const apiServerUrl = (data.api_server_url ?? 'https://server.codeium.com').replace(/\/$/, '')
    return { apiKey, apiServerUrl }
  } catch {
    return undefined
  }
}

async function fetchDevinUsageFromCredentials(): Promise<DevinCredits | undefined> {
  const creds = await readDevinCredentials()
  if (!creds) return undefined
  const response = await fetch(`${creds.apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    },
    body: JSON.stringify({
      metadata: {
        apiKey: creds.apiKey,
        ideName: 'devin',
        ideVersion: '1.108.2',
        extensionName: 'devin',
        extensionVersion: '1.108.2',
        locale: 'en',
      },
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = (await response.json()) as Record<string, unknown>
  const userStatus = json.userStatus as Record<string, unknown> | undefined
  const planStatus = userStatus?.planStatus as Record<string, unknown> | undefined
  const planInfo = (planStatus?.planInfo ?? json.planInfo) as Record<string, unknown> | undefined
  const planName = typeof planInfo?.planName === 'string' ? planInfo.planName : undefined

  const availableCredits = typeof planStatus?.availablePromptCredits === 'number'
    ? planStatus.availablePromptCredits
    : undefined
  const overage = typeof planStatus?.overageBalanceMicros === 'string'
    ? Number(planStatus.overageBalanceMicros) / 1_000_000
    : undefined
  const dailyPercent = typeof planStatus?.dailyQuotaRemainingPercent === 'number'
    ? planStatus.dailyQuotaRemainingPercent
    : undefined
  const weeklyPercent = typeof planStatus?.weeklyQuotaRemainingPercent === 'number'
    ? planStatus.weeklyQuotaRemainingPercent
    : undefined

  const usedPercent = weeklyPercent !== undefined
    ? 100 - weeklyPercent
    : dailyPercent !== undefined
      ? 100 - dailyPercent
      : undefined

  let text = planName ?? 'Devin'
  if (availableCredits !== undefined) {
    text += availableCredits < 0 ? ' | Unlimited credits' : ` | ${availableCredits.toLocaleString()} credits`
  }
  if (usedPercent !== undefined) {
    text += ` | ${usedPercent}% used`
  }
  if (overage !== undefined && overage !== 0) {
    text += ` | Overage $${overage.toFixed(2)}`
  }

  const result: DevinCredits = {
    total: 100,
    used: usedPercent ?? 0,
    remain: 100 - (usedPercent ?? 0),
    unit: 'percent',
    text,
  }
  if (usedPercent !== undefined) result.percent = usedPercent
  return result
}

export async function listDevinModels(pat: string): Promise<DevinModel[]> {
  // Protobuf endpoint authenticates with the PAT directly.
  // PAT directly and never spawns the CLI. Invoking `devin models` while no
  // CLI credentials exist makes the CLI launch a browser login window.
  // Protobuf endpoint authenticates with the PAT directly. The `devin` CLI
  // is never invoked here: without a valid interactive CLI session it opens
  // a browser login window, and a `credentials.toml` written for another
  // session type does not stop it.
  const body = encodeGetCliModelConfigsRequest({ apiKey: normalizeDevinSessionToken(pat) })
  const response = await fetch(`${DEVIN_BASE_URL}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      accept: '*/*',
    },
    body: body as unknown as BodyInit,
  })
  if (!response.ok) {
    throw new Error(`Devin model discovery failed: ${response.status}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  const decoded = decodeGetCliModelConfigsResponse(maybeGunzip(raw))
  return decoded
    .filter((c) => !c.disabled && c.modelUid.trim().length > 0)
    .map((c) => ({ id: c.modelUid.trim(), name: c.label.trim() || c.modelUid.trim() }))
}

export interface DevinCredits {
  total?: number
  used?: number
  remain?: number
  unit?: string
  error?: string
  text?: string
  percent?: number
}

export async function fetchDevinUsage(pat: string): Promise<DevinCredits | undefined> {
  // Prefer the local Devin CLI credentials because they give us the same
  // personal account quota/usage data shown inside the Devin app, without
  // needing an enterprise service user.
  try {
    const fromCredentials = await fetchDevinUsageFromCredentials()
    if (fromCredentials) return fromCredentials
  } catch {
    // fall through to enterprise endpoints
  }

  // Devin v3 exposes consumption/ACU endpoints only at enterprise scope and
  // requires the service user to have billing permissions. If the PAT is not an
  // enterprise service user, these calls will 403/404 and we simply leave the
  // quota section empty.
  try {
    const orgs = await devinFetch<Array<{ id: string }>>(pat, '/v3/enterprise/organizations')
    if (!orgs || orgs.length === 0) {
      return { error: 'No enterprise organizations available for this PAT.' }
    }

    // Try ACU limits first (gives a hard cap).
    try {
      const limits = await devinFetch<{ items?: Array<{ limit?: number; usage?: number }> }>(
        pat,
        '/v3/enterprise/consumption/acu-limits/devin?first=100',
      )
      let total = 0
      let used = 0
      for (const item of limits.items ?? []) {
        total += typeof item.limit === 'number' ? item.limit : 0
        used += typeof item.usage === 'number' ? item.usage : 0
      }
      if (total > 0) {
        return { total, used, remain: Math.max(0, total - used), unit: 'ACU' }
      }
    } catch {
      // fall through to daily consumption
    }

    // Fallback: sum daily consumption for the last 30 days.
    const now = Math.floor(Date.now() / 1000)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60
    const consumption = await devinFetch<{ items?: Array<{ total_acus?: number; acus?: number }> }>(
      pat,
      `/v3/enterprise/consumption/daily?time_after=${thirtyDaysAgo}&time_before=${now}&first=100`,
    )
    let used = 0
    for (const item of consumption.items ?? []) {
      used += typeof item.total_acus === 'number' ? item.total_acus : typeof item.acus === 'number' ? item.acus : 0
    }
    return used > 0 ? { used, unit: 'ACU (30d)' } : undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: message.includes('HTTP 403') ? 'Quota data requires enterprise billing permission.' : message }
  }
}
