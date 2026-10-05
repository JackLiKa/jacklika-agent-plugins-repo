import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DevinSettingsCard } from './client/DevinSettingsCard.tsx'
import { DEVIN_LOCALES } from './client/locales.ts'

export const name = 'jacklika/devin-connect-client'

export const inject = [
  'locale',
  'ui-renderer',
  'ui-sidebar',
  'ui-settings',
]

export function apply(ctx: Context): void {
  ctx.effect(() => {
    try {
      const disposeDict = ctx.locale.register('devin', DEVIN_LOCALES)
      const disposeSlot = ctx.slots.register({
        name: 'settings.section',
        id: 'devin',
        order: 210,
        label: 'Devin',
        locale: 'devin',
      } as const, DevinSettingsCard)
      return () => {
        disposeSlot()
        disposeDict()
      }
    } catch (error) {
      console.error('[devin-connect-client] apply failed:', error)
      return () => {}
    }
  })
}
