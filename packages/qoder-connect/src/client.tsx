import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { QoderPluginCard } from './client/QoderPluginCard.tsx'
import { injectQuotaCss } from './client/quota-styles.ts'
import { QODER_LOCALES } from './client/locales.ts'
import { SidebarQuotaCard } from './client/SidebarQuotaCard.tsx'

export const name = 'jacklika/qoder-connect-client'

export const inject = [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-sidebar',
]

export function apply(ctx: Context): void {
  ctx.effect(() => {
    try {
      const disposeDict = ctx.locale.register('qoder', QODER_LOCALES)
      const disposeCss = injectQuotaCss()
      const disposeSection = ctx.slots.register({
        name: 'settings.section',
        id: 'qoder',
        order: 200,
        label: 'Qoder',
        locale: 'qoder',
      } as const, QoderPluginCard)
      const disposeFooter = ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'qoder-quota',
        order: 100,
        label: 'Qoder',
        locale: 'qoder',
      } as const, SidebarQuotaCard)
      return () => {
        disposeSection()
        disposeFooter()
        disposeCss()
        disposeDict()
      }
    } catch (error) {
      console.error('[qoder-connect-client] apply failed:', error)
      return () => {}
    }
  })
}
