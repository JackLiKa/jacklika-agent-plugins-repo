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
      if (id.trim().length > 0) models.push({ id: id.trim(), name: name.trim() || id.trim() })
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
