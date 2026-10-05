import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ConnectorListCard, setConnectorStatus, type QuotaAccount } from '@jacklika/dsh-connector-core/client'
import { QoderPluginCard } from './client/QoderPluginCard.tsx'
import { injectQuotaCss } from './client/quota-styles.ts'
import { QODER_LOCALES } from './client/locales.ts'
import { isQoderWebStatus, type QoderCredits, type QoderPlan } from './client/status-document.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from './client/status-paths.ts'

const POLL_INTERVAL_MS = 30_000

function buildQoderQuota(credits: QoderCredits | undefined, plan: QoderPlan | undefined):
  { text: string | undefined; accounts: QuotaAccount[]; summaryPercent?: number } {
  const empty = { text: undefined, accounts: [] as QuotaAccount[] }
  if (!credits) return empty
  if (credits.error) return { text: `Quota error: ${credits.error}`, accounts: [] }
  const accounts = credits.accounts.filter((a) => !a.unlimited && (a.size ?? 0) > 0)
  if (accounts.length === 0) {
    const unlimited = credits.accounts.some((a) => a.unlimited)
    return { text: unlimited ? 'Unlimited' : undefined, accounts: [] }
  }
  const accountBars: QuotaAccount[] = accounts.map((a) => {
    const used = (a.size ?? 0) - (a.remain ?? 0)
    const total = a.size ?? 0
    const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
    return { name: a.packageName || 'Credits', used, total, percent }
  })
  const totalUsed = accountBars.reduce((sum, a) => sum + a.used, 0)
  const totalSize = accountBars.reduce((sum, a) => sum + a.total, 0)
  const summaryPercent = totalSize > 0 ? Math.min(100, Math.round((totalUsed / totalSize) * 100)) : 0
  const parts: string[] = []
  if (plan?.planTierName) parts.push(plan.planTierName)
  parts.push(`${totalUsed} / ${totalSize} credits`)
  return { text: parts.join(' | '), accounts: accountBars, summaryPercent }
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
        const quota = signedIn ? buildQoderQuota(value.credits, value.plan) : undefined
        setConnectorStatus({
          id,
          name,
          signedIn,
          ...(detail ? { detail } : {}),
          ...(user ? { username: user.username, email: user.email, userType: user.userType, orgId: user.orgId, avatarUrl: user.avatarUrl } : {}),
          modelsCount: models.length,
          models,
          quotaText: quota?.text,
          quotaPercent: quota?.summaryPercent,
          quotaUsed: quota?.accounts.reduce((sum, a) => sum + a.used, 0),
          quotaTotal: quota?.accounts.reduce((sum, a) => sum + a.total, 0),
          quotaAccounts: quota?.accounts,
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
