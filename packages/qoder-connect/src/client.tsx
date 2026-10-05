import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ConnectorListCard, setConnectorStatus } from '@jacklika/dsh-connector-core/client'
import { QoderPluginCard } from './client/QoderPluginCard.tsx'
import { injectQuotaCss } from './client/quota-styles.ts'
import { QODER_LOCALES } from './client/locales.ts'
import { isQoderWebStatus, type QoderCredits } from './client/status-document.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from './client/status-paths.ts'

const POLL_INTERVAL_MS = 30_000

function formatQoderQuota(credits: QoderCredits | undefined): string | undefined {
  if (!credits) return undefined
  if (credits.error) return `Quota error: ${credits.error}`
  const accounts = credits.accounts.filter((a) => !a.unlimited)
  if (accounts.length === 0) {
    return credits.accounts.some((a) => a.unlimited) ? 'Unlimited' : undefined
  }
  const remain = accounts.reduce((sum, a) => sum + (a.remain ?? 0), 0)
  const size = accounts.reduce((sum, a) => sum + (a.size ?? 0), 0)
  return `${remain} / ${size > 0 ? size : '?'}`
}

function startStatusPoller(statusPath: string, id: string, name: string): () => void {
  async function tick(): Promise<void> {
    try {
      const response = await fetch(statusPath, { method: 'GET', credentials: 'same-origin' })
      const value = await response.json().catch(() => undefined)
      if (isQoderWebStatus(value)) {
        const signedIn = value.status === 'signed-in'
        const detail = value.status === 'signed-in' && value.user
          ? (value.user.email ?? value.user.username ?? value.pat?.tail)
          : (value.status === 'error' ? value.message : undefined)
        const user = signedIn ? value.user : undefined
        const models = signedIn && Array.isArray(value.models)
          ? value.models.map((m) => (typeof m === 'string' ? m : String((m as Record<string, unknown>).id ?? ''))).filter(Boolean)
          : []
        setConnectorStatus({
          id,
          name,
          signedIn,
          ...(detail ? { detail } : {}),
          ...(user ? { username: user.username, email: user.email, userType: user.userType, orgId: user.orgId, avatarUrl: user.avatarUrl } : {}),
          modelsCount: models.length,
          models,
          quotaText: signedIn ? formatQoderQuota(value.credits) : undefined,
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

export const name = 'jacklika/qoder-connect-client'

export const inject = [
  'locale',
  'slots',
]

export function apply(ctx: Context): void {
  ctx.effect(() => {
    try {
      const disposeDict = ctx.locale.register('qoder', QODER_LOCALES)
      const disposeCss = injectQuotaCss()
      const disposeSection = ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'qoder',
          order: 200,
          label: 'Qoder',
          locale: 'qoder',
        } as const, QoderPluginCard))
      const disposeFooter = ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'connector-list',
          order: 100,
          label: 'Connectors',
          locale: 'qoder',
        } as const, ConnectorListCard))
      const disposeQoderPoller = startStatusPoller(QODER_STATUS_PATH, 'qoder', 'Qoder')
      const disposeGlobalPoller = startStatusPoller(QODER_GLOBAL_STATUS_PATH, 'qoder-global', 'Qoder Global')
      return () => {
        disposeSection()
        disposeFooter()
        disposeQoderPoller()
        disposeGlobalPoller()
        disposeCss()
        disposeDict()
      }
    } catch (error) {
      console.error('[qoder-connect-client] apply failed:', error)
      return () => {}
    }
  })
}
