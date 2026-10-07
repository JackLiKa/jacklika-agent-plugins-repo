// Automatic reader for the Devin CLI credentials.toml.
// Ported from codex-router/src/devin-cli-status.mjs + devin-cli-session.mjs.
//
// Devin CLI (`devin auth login`) persists the session token to credentials.toml.
// This module is read-only: it never modifies, copies, or deletes another tool's credential file.

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_API_SERVER_URL = 'https://server.codeium.com'

/**
 * Platform-specific path to the Devin CLI credentials.toml.
 * The DEVIN_CREDENTIALS_PATH environment variable overrides it.
 */
export function devinCredentialsPath(): string {
  if (process.env.DEVIN_CREDENTIALS_PATH) return process.env.DEVIN_CREDENTIALS_PATH
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin', 'credentials.toml')
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'devin', 'credentials.toml')
}

export interface DevinSession {
  /** windsurf_api_key, formatted as devin-session-token$... */
  apiKey: string
  /** api_server_url, defaults to https://server.codeium.com */
  apiServerUrl: string
  /** Optional devin_api_url */
  devinApiUrl?: string
}

/**
 * Parses a Devin session from credentials.toml.
 * Uses a lightweight TOML scanner instead of a full TOML library to avoid extra dependencies.
 * Reads only top-level string keys and rejects duplicate keys and multi-line values.
 */
export function devinSessionEntry(contents: string): DevinSession | undefined {
  const table = scanTomlTopLevel(contents)
  const apiKey = table['windsurf_api_key']
  if (typeof apiKey !== 'string' || !apiKey) return undefined
  return {
    apiKey,
    apiServerUrl: table['api_server_url'] || DEFAULT_API_SERVER_URL,
    ...table['devin_api_url'] ? { devinApiUrl: table['devin_api_url'] } : {},
  }
}

/**
 * Attempts to read a session from the Devin CLI credentials.toml.
 * Returns undefined when the file is missing or malformed; never throws.
 */
export function readDevinSession(options?: { credentialsPath?: string }): DevinSession | undefined {
  const path = options?.credentialsPath ?? devinCredentialsPath()
  if (!existsSync(path)) return undefined
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return devinSessionEntry(contents)
  } catch {
    return undefined
  }
}

// ─── Lightweight top-level TOML scanner ─────────────────────────────────────

/**
 * Scans the top-level string key=value pairs of a TOML file.
 * Supports only the `key = "value"` form; tables, arrays, multi-line strings and
 * other complex structures are not supported. Duplicate keys throw (fail-closed).
 */
function scanTomlTopLevel(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = contents.split('\n')
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    // Skip blank lines and comments
    if (line === '' || line.startsWith('#')) continue
    // table header — entering a table section stops top-level scanning
    if (line.startsWith('[')) {
      inTable = true
      continue
    }
    // Lines inside a table section are not read (top-level keys only)
    if (inTable) continue
    // key = "value"
    const eqIdx = line.indexOf('=')
    if (eqIdx < 0) continue
    const key = line.slice(0, eqIdx).trim()
    const valuePart = line.slice(eqIdx + 1).trim()
    // Only string values are read
    if (!valuePart.startsWith('"')) continue
    // Simple double-quoted string parse (no escapes; credentials.toml tokens contain no special chars)
    const closing = valuePart.indexOf('"', 1)
    if (closing < 0) throw new Error(`unterminated string at line ${i + 1}`)
    const value = valuePart.slice(1, closing)
    if (key in result) throw new Error(`duplicate key "${key}" at line ${i + 1}`)
    result[key] = value
  }
  return result
}
