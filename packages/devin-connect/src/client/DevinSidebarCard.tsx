import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { devinStatus, onDevinStatusChange } from './status-store.ts'

export interface DevinSidebarCardProps {
  wide: boolean
  t: TranslateNS<'devin'>
}

export function DevinSidebarCard({ wide, t }: DevinSidebarCardProps): JSX.Element {
  useSyncExternalStore(onDevinStatusChange, () => undefined)
  const status = devinStatus()

  const label = status.signedIn
    ? `Devin: ${status.email ?? t('connected')}`
    : `Devin: ${t('signedOut')}`

  return (
    <button style={buttonStyle} disabled={!wide} title={label}>
      {wide ? label : 'D'}
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
