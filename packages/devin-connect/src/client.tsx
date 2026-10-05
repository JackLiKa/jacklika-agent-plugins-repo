import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { setConnectorStatus } from '@jacklika/dsh-connector-core/client'
import { DevinSettingsCard } from './client/DevinSettingsCard.tsx'
import { DEVIN_LOCALES } from './client/locales.ts'
import { isDevinWebStatus } from './client/status-document.ts'

const DEVIN_STATUS_PATH = '/plugins/dsh-devin-connect/status'
const POLL_INTERVAL_MS = 30_000

function startStatusPoller(): () => void {
  async function tick(): Promise<void> {
    try {
      const response = await fetch(DEVIN_STATUS_PATH, { method: 'GET', credentials: 'same-origin' })
      const value = await response.json().catch(() => undefined)
      if (isDevinWebStatus(value)) {
        const signedIn = value.status === 'signed-in'
        const detail = signedIn ? (value.user?.email ?? value.user?.name) : undefined
        setConnectorStatus({
          id: 'devin',
          name: 'Devin',
          signedIn,
          ...(detail ? { detail } : {}),
          modelsCount: signedIn && Array.isArray(value.models) ? value.models.length : 0,
        })
      }
    } catch {
      // ignore transient fetch errors
    }
  }
  void tick()
  const timer = window.setInterval(tick, POLL_INTERVAL_MS)
  return () => window.clearInterval(timer)
}

export const name = 'jacklika/devin-connect-client'

export const inject = [
  'locale',
  'slots',
]

export function apply(ctx: Context): void {
  ctx.effect(() => {
    try {
      const disposeDict = ctx.locale.register('devin', DEVIN_LOCALES)
      const disposeSlot = ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'devin',
          order: 210,
          label: 'Devin',
          locale: 'devin',
        } as const, DevinSettingsCard))
      const disposePoller = startStatusPoller()
      return () => {
        disposeSlot()
        disposePoller()
        disposeDict()
      }
    } catch (error) {
      console.error('[devin-connect-client] apply failed:', error)
      return () => {}
    }
  })
}
