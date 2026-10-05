export interface QuotaAccount {
  name: string
  used: number
  total: number
  percent: number
}

export interface ConnectorProviderStatus {
  id: string
  name: string
  signedIn: boolean
  detail?: string | undefined
  username?: string | undefined
  email?: string | undefined
  userType?: string | undefined
  orgId?: string | undefined
  avatarUrl?: string | undefined
  modelsCount?: number | undefined
  models?: string[] | undefined
  modelGroups?: Record<string, Array<{ name: string; description?: string }>> | undefined
  quotaText?: string | undefined
  quotaPercent?: number | undefined
  quotaUsed?: number | undefined
  quotaTotal?: number | undefined
  quotaAccounts?: QuotaAccount[] | undefined
  extra?: Record<string, string> | undefined
}

interface ConnectorStatusState {
  providers: Record<string, ConnectorProviderStatus>
  revision: number
}

interface SharedStore {
  state: ConnectorStatusState
  snapshot: ConnectorStatusState
  listeners: Set<() => void>
}

const STORE_KEY = '__jacklikaConnectorStatusStore'

function getGlobal(): Record<string, unknown> | undefined {
  if (typeof globalThis !== 'undefined') return globalThis as Record<string, unknown>
  return undefined
}

function createStore(): SharedStore {
  const initial: ConnectorStatusState = { providers: {}, revision: 0 }
  return { state: initial, snapshot: initial, listeners: new Set() }
}

function getSharedStore(): SharedStore {
  const g = getGlobal()
  if (g && g[STORE_KEY]) {
    return g[STORE_KEY] as SharedStore
  }
  const store = createStore()
  if (g) {
    g[STORE_KEY] = store
  }
  return store
}

const shared = getSharedStore()

function bump(): void {
  shared.snapshot = { providers: { ...shared.state.providers }, revision: shared.state.revision }
  for (const listener of shared.listeners) listener()
}

export function setConnectorStatus(provider: ConnectorProviderStatus): void {
  const current = shared.state.providers[provider.id]
  if (
    !current ||
    current.signedIn !== provider.signedIn ||
    current.detail !== provider.detail ||
    current.modelsCount !== provider.modelsCount ||
    current.modelGroups !== provider.modelGroups ||
    current.name !== provider.name ||
    current.quotaText !== provider.quotaText ||
    current.quotaPercent !== provider.quotaPercent ||
    current.quotaUsed !== provider.quotaUsed ||
    current.quotaTotal !== provider.quotaTotal ||
    current.quotaAccounts !== provider.quotaAccounts ||
    current.username !== provider.username ||
    current.email !== provider.email
  ) {
    shared.state = {
      providers: { ...shared.state.providers, [provider.id]: provider },
      revision: shared.state.revision + 1,
    }
    bump()
  }
}

export function removeConnectorStatus(id: string): void {
  if (id in shared.state.providers) {
    const next = { ...shared.state.providers }
    delete next[id]
    shared.state = { providers: next, revision: shared.state.revision + 1 }
    bump()
  }
}

export function connectorStatus(): { providers: Record<string, ConnectorProviderStatus>; revision: number } {
  return shared.snapshot
}

export function onConnectorStatusChange(listener: () => void): () => void {
  shared.listeners.add(listener)
  return () => { shared.listeners.delete(listener) }
}
