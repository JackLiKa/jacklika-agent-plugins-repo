import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ConnectorListCard } from '@jacklika/dsh-connector-core/client'
import { QoderPluginCard } from './client/QoderPluginCard.tsx'
import { injectQuotaCss } from './client/quota-styles.ts'
import { QODER_LOCALES } from './client/locales.ts'

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
