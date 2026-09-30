import { onQuotaSettingsChange, quotaPollMs, quotaToggles, setQuotaPollMs, setQuotaToggles } from './quota-settings-store.ts'

export interface QuotaSettingsSnapshot {
  status: 'ready'
  value: {
    pollMs: number
    cn: boolean
    global: boolean
  }
  writable: true
}

export class OwnQuotaSettingsScope {
  private listeners = new Set<() => void>()
  private snapshot: QuotaSettingsSnapshot

  constructor() {
    this.snapshot = this.buildSnapshot()
  }

  private buildSnapshot(): QuotaSettingsSnapshot {
    const toggles = quotaToggles()
    return {
      status: 'ready',
      value: {
        pollMs: quotaPollMs(),
        cn: toggles.cn,
        global: toggles.global,
      },
      writable: true,
    }
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    const disposeStore = onQuotaSettingsChange(() => this.publish())
    return () => {
      this.listeners.delete(listener)
      disposeStore()
    }
  }

  getSnapshot(): QuotaSettingsSnapshot {
    return this.snapshot
  }

  async set(field: keyof QuotaSettingsSnapshot['value'], value: unknown): Promise<void> {
    if (field === 'pollMs' && typeof value === 'number') {
      setQuotaPollMs(value)
    } else if (field === 'cn' && typeof value === 'boolean') {
      const toggles = quotaToggles()
      setQuotaToggles(value, toggles.global)
    } else if (field === 'global' && typeof value === 'boolean') {
      const toggles = quotaToggles()
      setQuotaToggles(toggles.cn, value)
    }
  }
}
