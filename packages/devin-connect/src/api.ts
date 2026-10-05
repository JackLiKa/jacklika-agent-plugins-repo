import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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
}

async function runDevin(args: string[], pat?: string): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (pat) env.DEVIN_API_KEY = pat
  return new Promise((resolve) => {
    const child = spawn('devin', args, { env })
    const stdout: string[] = []
    const stderr: string[] = []
    if (child.stdout) createInterface(child.stdout).on('line', (line) => stdout.push(line))
    if (child.stderr) createInterface(child.stderr).on('line', (line) => stderr.push(line))
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode })
    })
  })
}

export async function listDevinModels(pat: string): Promise<DevinModel[]> {
  // First try the Devin connect-protocol protobuf endpoint, which returns the
  // same model catalog used by the Windsurf/CLI client.
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
    // fall back to CLI
  }

  const result = await runDevin(['models', 'list', '--format', 'json'], pat)
  if (!result.ok) {
    throw new Error(result.stderr || `devin exited with ${result.exitCode}`)
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (Array.isArray(parsed)) {
      return parsed.map((m) => {
        const item = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {}
        const id = typeof item.id === 'string' ? item.id : String(item.name ?? '')
        return { id, name: typeof item.name === 'string' ? item.name : id }
      })
    }
    if (parsed && typeof parsed === 'object' && 'models' in parsed && Array.isArray((parsed as Record<string, unknown>).models)) {
      return ((parsed as Record<string, unknown>).models as unknown[]).map((m) => {
        const item = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {}
        const id = typeof item.id === 'string' ? item.id : String(item.name ?? '')
        return { id, name: typeof item.name === 'string' ? item.name : id }
      })
    }
    return []
  } catch {
    return []
  }
}
