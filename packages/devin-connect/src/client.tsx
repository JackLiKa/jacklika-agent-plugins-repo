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
        const user = signedIn ? value.user : undefined
        const modelGroups: Record<string, Array<{ name: string; description?: string }>> = {}
        const modelNames: string[] = []
        if (signedIn && Array.isArray(value.models)) {
          for (const m of value.models) {
            if (typeof m === 'string') {
              modelNames.push(m)
              continue
            }
            const item = m as Record<string, unknown>
            const name = typeof item.name === 'string' ? item.name : String(item.id ?? '')
            const family = typeof item.family === 'string' ? item.family : 'Models'
            const description = typeof item.description === 'string' ? item.description : undefined
            if (!name) continue
            const displayName = family && family !== 'Models' ? `${family} › ${name}` : name
            modelNames.push(displayName)
            if (!modelGroups[family]) modelGroups[family] = []
            const groupEntry: { name: string; description?: string } = { name }
            if (description) groupEntry.description = description
            modelGroups[family].push(groupEntry)
          }
        }
        const credits = signedIn ? value.credits : undefined
        const total = credits?.total
        const used = credits?.used
        const quotaPercent = credits?.percent ?? (
          typeof total === 'number' && total > 0 && typeof used === 'number'
            ? Math.min(100, Math.round((used / total) * 100))
            : undefined
        )
        setConnectorStatus({
          id: 'devin',
          name: 'Devin',
          signedIn,
          ...(detail ? { detail } : {}),
          ...(user ? { username: user.name, email: user.email } : {}),
          modelsCount: modelNames.length,
          models: modelNames,
          modelGroups,
          ...(credits?.error
            ? { quotaText: `Quota: ${credits.error}` }
            : credits
              ? {
                  quotaText: credits.text ?? (credits.total !== undefined
                    ? `${used ?? 0} / ${credits.total} ${credits.unit ?? 'ACU'}`
                    : (used !== undefined ? `${used} ${credits.unit ?? 'ACU'} used` : undefined)),
                  quotaPercent,
                  quotaUsed: used,
                  quotaTotal: total,
                }
              : {}),
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
