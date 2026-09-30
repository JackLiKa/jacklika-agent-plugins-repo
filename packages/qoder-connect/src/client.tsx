import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-client-locale/client'
import '@deepseek-ai/dsh-client-ui-renderer/client'
import '@deepseek-ai/dsh-client-ui-settings/client'
import { QuotaSettingsCard } from './client/QuotaSettingsCard.tsx'
import { injectQuotaCss } from './client/quota-styles.ts'
import { QODER_LOCALES } from './client/locales.ts'

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
    const disposeDict = ctx.locale.register('qoder', QODER_LOCALES)
    const disposeCss = injectQuotaCss()
    const disposeSlot = ctx.slots.register({
      name: 'settings.section',
      id: 'qoder',
      order: 200,
      label: 'Qoder',
      locale: 'qoder',
    } as const, QuotaSettingsCard)
    return () => {
      disposeSlot()
      disposeCss()
      disposeDict()
    }
  })
}
