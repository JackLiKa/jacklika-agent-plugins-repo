import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-client-ui-renderer/client'
import '@deepseek-ai/dsh-client-ui-settings/client'
import type { ReactNode } from 'react'

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
    const dispose = ctx.slots.register({
      name: 'settings.section',
      id: 'devin',
      order: 210,
      label: 'Devin',
    } as const, DevinSettingsSection)
    return dispose
  })
}

function DevinSettingsSection(props: { close: () => void }): ReactNode {
  return (
    <div>
      <h2>Devin connector</h2>
      <p>Client UI modules are being implemented.</p>
      <button onClick={props.close}>Close</button>
    </div>
  )
}
