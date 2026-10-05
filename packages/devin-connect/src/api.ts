import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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
}

async function runDevin(args: string[], pat?: string): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (pat) env.DEVIN_API_KEY = pat
  const command = `devin ${args.map((a) => shellEscape(a)).join(' ')}`
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-lc', command]
  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, { env })
    const stdout: string[] = []
    const stderr: string[] = []
    if (child.stdout) createInterface(child.stdout).on('line', (line) => stdout.push(line))
    if (child.stderr) createInterface(child.stderr).on('line', (line) => stderr.push(line))
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode })
    })
  })
}

function shellEscape(arg: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) return arg
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
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

function parseDevinCliModelCatalog(parsed: unknown): DevinModel[] {
  const families: unknown[] = []
  if (Array.isArray(parsed)) {
    families.push(...parsed)
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.models)) families.push(...obj.models)
    if (Array.isArray(obj.families)) families.push(...obj.families)
  }
  const models: DevinModel[] = []
  for (const family of families) {
    if (!family || typeof family !== 'object') continue
    const f = family as Record<string, unknown>
    const variants = Array.isArray(f.variants) ? f.variants : [family]
    for (const raw of variants) {
      if (!raw || typeof raw !== 'object') continue
      const v = raw as Record<string, unknown>
      const id = typeof v.model_uid === 'string' ? v.model_uid : typeof v.id === 'string' ? v.id : ''
      const name = typeof v.label === 'string' ? v.label : typeof v.name === 'string' ? v.name : id
      const family = typeof f.family_label === 'string' ? f.family_label : undefined
      if (id.trim().length > 0) {
        const model: DevinModel = { id: id.trim(), name: name.trim() || id.trim() }
        if (family) model.family = family
        models.push(model)
      }
    }
  }
  return models
}

export async function listDevinModels(pat: string): Promise<DevinModel[]> {
  // Prefer the Devin CLI because it uses the user's existing CLI session and
  // returns the same rich catalog shown in Windsurf.
  const result = await runDevin(['models', 'list', '--format', 'json'], pat)
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.stdout) as unknown
      const models = parseDevinCliModelCatalog(parsed)
      if (models.length > 0) return models
    } catch {
      // fall through to protobuf
    }
  }

  // Fall back to the connect-protocol protobuf endpoint.
  try {
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
    const models = decoded
      .filter((c) => !c.disabled && c.modelUid.trim().length > 0)
      .map((c) => ({ id: c.modelUid.trim(), name: c.label.trim() || c.modelUid.trim() }))
    if (models.length > 0) return models
  } catch {
    // ignore
  }

  if (!result.ok) {
    throw new Error(result.stderr || `devin exited with ${result.exitCode}`)
  }
  return []
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
