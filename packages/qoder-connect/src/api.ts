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

export async function fetchQoderUsage(pat: string): Promise<QoderUsage | undefined> {
  const endpoint = 'https://openapi.qoder.sh/api/v2/quota/usage'
  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) return undefined
    return (await response.json()) as QoderUsage
  } catch {
    return undefined
  }
}
