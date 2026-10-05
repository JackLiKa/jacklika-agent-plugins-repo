import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DevinSettingsCard } from './client/DevinSettingsCard.tsx'
import { DEVIN_LOCALES } from './client/locales.ts'
import { DevinSidebarCard } from './client/DevinSidebarCard.tsx'

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
      const disposeFooter = ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'devin-status',
          order: 110,
          label: 'Devin',
          locale: 'devin',
        } as const, DevinSidebarCard))
      return () => {
        disposeSlot()
        disposeFooter()
        disposeDict()
      }
    } catch (error) {
      console.error('[devin-connect-client] apply failed:', error)
      return () => {}
    }
  })
}
