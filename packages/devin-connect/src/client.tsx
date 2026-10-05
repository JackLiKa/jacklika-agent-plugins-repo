import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DevinSettingsCard } from './client/DevinSettingsCard.tsx'
import { DEVIN_LOCALES } from './client/locales.ts'

export const name = 'jacklika/devin-connect-client'

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
