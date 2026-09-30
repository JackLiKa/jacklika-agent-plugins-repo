import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { mergeCreditAccounts, visibleQuotaGroups } from './quota-merge.ts'
import { onQuotaSettingsChange, quotaSignInState, quotaStatus } from './quota-settings-store.ts'

export interface SidebarQuotaCardProps {
  wide: boolean
  t: TranslateNS<'qoder'>
}

function totalRemaining(variant: 'qoder' | 'qoder-global'): number | undefined {
  const status = quotaStatus(variant)
  if (status?.status !== 'signed-in') return undefined
  const groups = visibleQuotaGroups(mergeCreditAccounts(status.credits?.accounts ?? []))
  if (groups.length === 0) return undefined
  if (groups.every((g) => g.unlimited)) return Infinity
  return groups.reduce((sum, g) => sum + (g.unlimited ? 0 : g.remain), 0)
}

export function SidebarQuotaCard({ wide, t }: SidebarQuotaCardProps): JSX.Element {
  useSyncExternalStore(onQuotaSettingsChange, () => undefined)
  const signIn = quotaSignInState()
  const cn = totalRemaining('qoder')
  const global = totalRemaining('qoder-global')

  const anySignedIn = signIn.cn || signIn.global
  const total =
    cn === Infinity || global === Infinity ? Infinity
      : (cn ?? 0) + (global ?? 0)

  if (!anySignedIn) {
    return (
      <button style={buttonStyle} disabled={!wide} onClick={() => {}}>
        {wide ? t('signedOut') : 'Q'}
      </button>
    )
  }

  const label = total === Infinity ? t('creditsTotalUnlimited') : `${t('credits')}: ${total}`

  return (
    <button style={buttonStyle} disabled={!wide} onClick={() => {}} title={label}>
      {wide ? label : 'Q'}
    </button>
  )
}

const buttonStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #e0e0e0',
  borderRadius: 4,
  background: '#fff',
  cursor: 'pointer',
}
