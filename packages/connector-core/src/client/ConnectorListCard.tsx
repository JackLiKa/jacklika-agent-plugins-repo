import { useSyncExternalStore, useState } from 'react'
import type { ConnectorProviderStatus } from './connector-status.js'
import { connectorStatus, onConnectorStatusChange } from './connector-status.js'

export interface ConnectorListCardProps {
  wide: boolean
}

function ProviderRow({ provider, wide }: { provider: ConnectorProviderStatus; wide: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const extras: { label: string; value: string | undefined }[] = [
    { label: 'Username', value: provider.username },
    { label: 'Email', value: provider.email },
    { label: 'User type', value: provider.userType },
    { label: 'Org', value: provider.orgId },
    { label: 'Models', value: typeof provider.modelsCount === 'number' ? String(provider.modelsCount) : undefined },
  ]
  const visibleExtras = extras.filter((e) => e.value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        style={rowButtonStyle}
        onClick={() => setExpanded(!expanded)}
        title={provider.name}
      >
        <span style={dotStyle} />
        <span style={nameStyle}>{provider.name}</span>
        {wide && <span style={detailStyle}>{provider.detail ?? ''}</span>}
        {typeof provider.modelsCount === 'number' && provider.modelsCount > 0 && (
          <span style={badgeStyle}>{provider.modelsCount}</span>
        )}
        <span style={{ ...chevronStyle, transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {expanded && (
        <div style={detailPanelStyle}>
          {visibleExtras.length === 0 ? (
            <span style={mutedStyle}>No dashboard data available.</span>
          ) : (
            visibleExtras.map((e) => (
              <div key={e.label} style={detailRowStyle}>
                <span style={detailLabelStyle}>{e.label}</span>
                <span style={detailValueStyle}>{e.value}</span>
              </div>
            ))
          )}
          {provider.models && provider.models.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <span style={detailLabelStyle}>Model list</span>
              <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', maxHeight: 120, overflow: 'auto' }}>
                {provider.models.slice(0, 20).map((m) => (
                  <li key={m} style={modelItemStyle}>{m}</li>
                ))}
                {provider.models.length > 20 && (
                  <li style={mutedStyle}>... {provider.models.length - 20} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
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
            <ProviderRow key={p.id} provider={p} wide={wide} />
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

const rowButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 4px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontSize: '0.85rem',
  textAlign: 'left',
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
  flex: 1,
}

const badgeStyle: React.CSSProperties = {
  padding: '2px 6px',
  borderRadius: 10,
  background: '#e6f7ff',
  color: '#1890ff',
  fontSize: '0.75rem',
}

const detailPanelStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #eee',
  borderRadius: 4,
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const detailRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: '0.8rem',
}

const detailLabelStyle: React.CSSProperties = {
  color: '#666',
}

const detailValueStyle: React.CSSProperties = {
  color: '#333',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 140,
}

const modelItemStyle: React.CSSProperties = {
  padding: '2px 0',
  fontSize: '0.8rem',
  color: '#333',
}

const mutedStyle: React.CSSProperties = {
  color: '#999',
  fontSize: '0.8rem',
}
