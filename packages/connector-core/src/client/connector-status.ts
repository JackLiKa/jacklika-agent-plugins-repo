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
  quotaText?: string | undefined
  extra?: Record<string, string> | undefined
}

interface ConnectorStatusState {
  providers: Record<string, ConnectorProviderStatus>
  revision: number
}

let state: ConnectorStatusState = { providers: {}, revision: 0 }
let snapshot = { ...state }
const listeners = new Set<() => void>()

function bump(): void {
  snapshot = { providers: { ...state.providers }, revision: state.revision }
  for (const listener of listeners) listener()
}

export function setConnectorStatus(provider: ConnectorProviderStatus): void {
  const current = state.providers[provider.id]
  if (
    !current ||
    current.signedIn !== provider.signedIn ||
    current.detail !== provider.detail ||
    current.modelsCount !== provider.modelsCount ||
    current.name !== provider.name
  ) {
    state = {
      providers: { ...state.providers, [provider.id]: provider },
      revision: state.revision + 1,
    }
    bump()
  }
}

export function removeConnectorStatus(id: string): void {
  if (id in state.providers) {
    const next = { ...state.providers }
    delete next[id]
    state = { providers: next, revision: state.revision + 1 }
    bump()
  }
}

export function connectorStatus(): { providers: Record<string, ConnectorProviderStatus>; revision: number } {
  return snapshot
}

export function onConnectorStatusChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
