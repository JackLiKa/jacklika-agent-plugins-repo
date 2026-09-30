import type { QoderWebStatus } from './status-document.ts'
import { variantOfStatusPath } from './status-paths.ts'

let pollIntervalMs = 300_000
const toggles = { cn: false, global: false }
let togglesSnapshot = { ...toggles }
const signIn = { cn: false, global: false }
let signInSnapshot = { ...signIn }
let revision = 0
const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function setQuotaPollMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 60_000 && ms !== pollIntervalMs) {
    pollIntervalMs = ms
    bump()
  }
}

export function quotaPollMs(): number {
  return pollIntervalMs
}

export function setQuotaToggles(cn: boolean, global: boolean): void {
  if (toggles.cn !== cn || toggles.global !== global) {
    toggles.cn = cn
    toggles.global = global
    togglesSnapshot = { cn, global }
    bump()
  }
}

export function quotaToggles(): { cn: boolean; global: boolean } {
  return togglesSnapshot
}

export function noteQuotaSignIn(variantId: 'qoder' | 'qoder-global', signedIn: boolean): void {
  const key = variantId === 'qoder' ? 'cn' : 'global'
  if (signIn[key] !== signedIn) {
    signIn[key] = signedIn
    signInSnapshot = { ...signIn }
    bump()
  }
}

export function quotaSignInState(): { cn: boolean; global: boolean } {
  return signInSnapshot
}

export function onQuotaSettingsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function quotaSettingsRevision(): number {
  return revision
}

const statusDocuments: { cn: QoderWebStatus | undefined; global: QoderWebStatus | undefined } = {
  cn: undefined,
  global: undefined,
}
const statusFetchedAt: { cn: number | undefined; global: number | undefined } = {
  cn: undefined,
  global: undefined,
}

export function noteQuotaStatus(path: string, status: QoderWebStatus): void {
  const variantId = variantOfStatusPath(path)
  if (variantId === 'qoder' && statusDocuments.cn !== status) {
    statusDocuments.cn = status
    statusFetchedAt.cn = Date.now()
    bump()
  } else if (variantId === 'qoder-global' && statusDocuments.global !== status) {
    statusDocuments.global = status
    statusFetchedAt.global = Date.now()
    bump()
  }
  noteQuotaSignIn(variantId, status.status === 'signed-in')
}

export function quotaStatus(variantId: 'qoder' | 'qoder-global'): QoderWebStatus | undefined {
  return variantId === 'qoder' ? statusDocuments.cn : statusDocuments.global
}

export function quotaStatusFetchedAt(variantId: 'qoder' | 'qoder-global'): number | undefined {
  return variantId === 'qoder' ? statusFetchedAt.cn : statusFetchedAt.global
}

export function quotaStatusIsFresh(variantId: 'qoder' | 'qoder-global', maxAgeMs: number): boolean {
  const fetchedAt = quotaStatusFetchedAt(variantId)
  const document = quotaStatus(variantId)
  if (fetchedAt === undefined || document === undefined) return false
  return Date.now() - fetchedAt < maxAgeMs
}
