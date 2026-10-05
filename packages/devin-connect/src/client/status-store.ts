interface DevinStatusSnapshot {
  signedIn: boolean
  email?: string
  modelsCount: number
  fetchedAt?: number
}

let status: DevinStatusSnapshot = { signedIn: false, modelsCount: 0 }
let statusSnapshot = { ...status }
let revision = 0
const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  statusSnapshot = { ...status }
  for (const listener of listeners) listener()
}

export function noteDevinStatus(signedIn: boolean, email?: string, modelsCount?: number): void {
  const next: DevinStatusSnapshot = {
    signedIn,
    modelsCount: modelsCount ?? 0,
    fetchedAt: Date.now(),
    ...(email ? { email } : {}),
  }
  if (status.signedIn !== next.signedIn || status.email !== next.email || status.modelsCount !== next.modelsCount) {
    status = next
    bump()
  }
}

export function devinStatus(): DevinStatusSnapshot {
  return statusSnapshot
}

export function onDevinStatusChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function devinStatusRevision(): number {
  return revision
}
