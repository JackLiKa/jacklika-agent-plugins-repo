import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createCipheriv, createHash, publicEncrypt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

export interface QoderUsage {
  userQuota?: {
    total: number
    used: number
    remaining: number
    percentage: number
    unit: string
  }
  expiresAt?: number
}

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const qoderIdeVersion = '1.1.47'
const qoderCustomAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const qoderStdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

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

function aesEncrypt(plaintext: string, key: string): string {
  const iv = Buffer.from(key, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return encrypted.toString('base64')
}

function rsaEncryptKey(aesKey: string): string {
  const keyBuffer = Buffer.from(aesKey, 'utf8')
  const encrypted = publicEncrypt({ key: qoderRSAPublicKey, padding: 1 /* RSA_PKCS1_PADDING */ }, keyBuffer)
  return encrypted.toString('base64')
}

function md5(data: string): string {
  return createHash('md5').update(data, 'utf8').digest('hex')
}

function qoderEncodeBody(plaintext: string): string {
  const std = Buffer.from(plaintext, 'utf8').toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  const table = new Uint8Array(256)
  for (let i = 0; i < 256; i++) table[i] = i
  for (let i = 0; i < 64; i++) {
    table[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  const source = Buffer.from(rearranged, 'latin1')
  const target = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) {
    target[i] = table[source[i] ?? 0] ?? 0
  }
  return target.toString('latin1')
}

async function readMachineId(cliConfigDir: string): Promise<string> {
  const userPath = join(process.env.HOME ?? process.env.USERPROFILE ?? '/', '.qoder', '.auth', 'machine_id')
  const fallbackPath = join(cliConfigDir, '.qoder-machine-id')
  for (const p of [userPath, fallbackPath]) {
    if (existsSync(p)) {
      try {
        const value = await readFile(p, 'utf8')
        if (value.trim()) return value.trim()
      } catch {
        // fall through
      }
    }
  }
  return randomUUID().replace(/-/g, '')
}

async function exchangePat(pat: string, region: QoderRegion): Promise<QoderAuthState> {
  const cached = jobTokenCache.get(`${region}:${pat}`)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached
  }
  const openApi = qoderRegionEndpoints[region].openApi
  const response = await fetch(`${openApi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      headers: { Authorization: `Bearer ${jobToken}` },
    })
    if (!response.ok) return undefined
    return await response.json() as { id?: string; name?: string; email?: string }
  } catch {
    return undefined
  }
}

function buildCosyHeaders(
  jobToken: string,
  userId: string,
  machineId: string,
  url: string,
  encodedBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const aesKey = randomUUID().replace(/-/g, '').slice(0, 16)
  const userInfo = JSON.stringify({
    uid: userId,
    security_oauth_token: jobToken,
    name: '',
    aid: '',
    email: '',
  })
  const infoB64 = aesEncrypt(userInfo, aesKey)
  const cosyKey = rsaEncryptKey(aesKey)
  const cosyPayload = JSON.stringify({
    version: 'v1',
    requestId: randomUUID(),
    info: infoB64,
    cosyVersion: qoderIdeVersion,
    ideVersion: '',
  })
  const payloadB64 = Buffer.from(cosyPayload, 'utf8').toString('base64')
  const pathname = new URL(url).pathname
  const sigPath = pathname.startsWith('/algo') ? pathname.slice(5) : pathname
  const bodyHash = md5(encodedBody)
  const bodyLen = Buffer.byteLength(encodedBody, 'utf8')
  const sig = md5(`${payloadB64}\n${cosyKey}\n${timestamp}\n${encodedBody}\n${sigPath}`)
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': userId,
    'Cosy-Date': String(timestamp),
    'Cosy-Version': qoderIdeVersion,
    'Cosy-Machineid': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': process.platform === 'win32' ? 'x86_64_windows' : process.platform === 'darwin' ? 'aarch64_linux' : 'x86_64_linux',
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': String(bodyLen),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': 'disagree',
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

export async function fetchQoderUsage(
  pat: string,
  region: QoderRegion = 'global',
  cliConfigDir: string = '',
): Promise<QoderUsage | undefined> {
  const openApi = qoderRegionEndpoints[region].openApi
  const endpoint = `${openApi}/api/v2/quota/usage`
  try {
    const auth = await exchangePat(pat, region)
    const machineId = await readMachineId(cliConfigDir)
    const body = ''
    const encodedBody = qoderEncodeBody(body)
    const headers = buildCosyHeaders(auth.jobToken, auth.userId, machineId, endpoint, encodedBody)
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
    })
    if (!response.ok) return undefined
    return (await response.json()) as QoderUsage
  } catch {
    return undefined
  }
}
