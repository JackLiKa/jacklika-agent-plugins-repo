import { useSyncExternalStore, useState } from 'react'
import { connectorStatus, onConnectorStatusChange } from './connector-status.js'

export interface ConnectorListCardProps {
  wide: boolean
}

export function ConnectorListCard({ wide }: ConnectorListCardProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(onConnectorStatusChange, connectorStatus)

  const providers = Object.values(state.providers).filter((p) => p.signedIn)
  const count = providers.length
  if (count === 0) return null

  const label = `已接入 ${count} 个供应商 / ${count} provider${count > 1 ? 's' : ''} connected`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        style={buttonStyle}
        disabled={!wide}
        onClick={() => setOpen(!open)}
        title={label}
      >
        <span>{wide ? label : count}</span>
        <span style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <div style={panelStyle}>
          {providers.map((p) => (
            <div key={p.id} style={rowStyle}>
              <span style={dotStyle} />
              <span style={nameStyle}>{p.name}</span>
              <span style={detailStyle}>{p.detail ?? ''}</span>
              {typeof p.modelsCount === 'number' && p.modelsCount > 0 && (
                <span style={detailStyle}>{p.modelsCount} models</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  padding: '6px 8px',
  border: '1px solid #e0e0e0',
  borderRadius: 4,
  background: '#fff',
  cursor: 'pointer',
  fontSize: '0.85rem',
  lineHeight: 1.2,
}

const chevronStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  transition: 'transform 0.15s ease',
}

const panelStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #e8e8e8',
  borderRadius: 4,
  background: '#fafafa',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.85rem',
}

const dotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#52c41a',
  flexShrink: 0,
}

const nameStyle: React.CSSProperties = {
  fontWeight: 500,
  minWidth: 60,
}

const detailStyle: React.CSSProperties = {
  color: '#666',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
