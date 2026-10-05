import { useSyncExternalStore, useState } from 'react'
import type { ConnectorProviderStatus } from './connector-status.js'
import { connectorStatus, onConnectorStatusChange } from './connector-status.js'

export interface ConnectorListCardProps {
  wide: boolean
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function formatNumber(n: number | undefined): string {
  if (n === undefined) return '-'
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function ProviderDashboard({ provider }: { provider: ConnectorProviderStatus }): JSX.Element {
  const hasQuota = provider.quotaTotal !== undefined && provider.quotaTotal > 0
  const percent = provider.quotaPercent ?? 0
  const used = provider.quotaUsed ?? 0
  const total = provider.quotaTotal ?? 0
  const unlimited = provider.quotaText?.toLowerCase().includes('unlimited')

  const fields: { label: string; value: string | undefined }[] = [
    { label: 'Username', value: provider.username },
    { label: 'Email', value: provider.email },
    { label: 'User type', value: provider.userType },
    { label: 'Org', value: provider.orgId },
    { label: 'Models', value: typeof provider.modelsCount === 'number' ? String(provider.modelsCount) : undefined },
  ]
  const visibleFields = fields.filter((f) => f.value)

  return (
    <div style={providerCardStyle}>
      <div style={providerHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={statusDotStyle} />
          <span style={providerNameStyle}>{provider.name}</span>
        </div>
        {typeof provider.modelsCount === 'number' && provider.modelsCount > 0 && (
          <span style={modelBadgeStyle}>{provider.modelsCount} models</span>
        )}
      </div>

      {visibleFields.length > 0 && (
        <div style={fieldGridStyle}>
          {visibleFields.map((f) => (
            <div key={f.label} style={fieldItemStyle}>
              <span style={fieldLabelStyle}>{f.label}</span>
              <span style={fieldValueStyle} title={f.value}>{f.value}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={fieldLabelStyle}>Quota</span>
          <span style={fieldValueStyle}>
            {provider.quotaText ?? (unlimited ? 'Unlimited' : 'Not available')}
          </span>
        </div>
        {hasQuota && (
          <div>
            <div style={progressTrackStyle}>
              <div
                style={{
                  ...progressFillStyle,
                  width: `${clamp(percent, 0, 100)}%`,
                  backgroundColor: percent >= 90 ? '#ff4d4f' : percent >= 70 ? '#faad14' : '#52c41a',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: '#888' }}>
              <span>{formatNumber(used)} used</span>
              <span>{formatNumber(total)} total</span>
            </div>
          </div>
        )}
      </div>

      {provider.models && provider.models.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={fieldLabelStyle}>Model list</div>
          <ul style={modelListStyle}>
            {provider.models.slice(0, 20).map((m) => (
              <li key={m} style={modelItemStyle}>{m}</li>
            ))}
            {provider.models.length > 20 && (
              <li style={mutedItemStyle}>... {provider.models.length - 20} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export function ConnectorListCard({ wide: _wide }: ConnectorListCardProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(onConnectorStatusChange, connectorStatus)

  const providers = Object.values(state.providers).filter((p) => p.signedIn)
  const count = providers.length
  if (count === 0) return null

  const label = `已接入 ${count} 个供应商 / ${count} provider${count > 1 ? 's' : ''} connected`

  return (
    <>
      <button type="button" style={cardButtonStyle} onClick={() => setOpen(true)} title={label}>
        <span style={cardDotStyle} />
        <span style={cardLabelStyle}>{label}</span>
        <span style={cardChevronStyle}>▶</span>
      </button>

      {open && (
        <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div style={modalStyle}>
            <div style={modalHeaderStyle}>
              <span style={modalTitleStyle}>连接器 Dashboard / Connector Dashboard</span>
              <button type="button" style={closeButtonStyle} onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div style={modalBodyStyle}>
              {providers.map((provider) => (
                <ProviderDashboard key={provider.id} provider={provider} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const cardButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #e5e5e5',
  borderRadius: 8,
  background: '#ffffff',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13,
  color: '#333',
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
}

const cardDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#52c41a',
  flexShrink: 0,
}

const cardLabelStyle: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const cardChevronStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#999',
  flexShrink: 0,
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10000,
  background: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const modalStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 560,
  maxHeight: '80vh',
  background: '#ffffff',
  borderRadius: 12,
  boxShadow: '0 10px 40px rgba(0,0,0,0.18)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const modalHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 18px',
  borderBottom: '1px solid #f0f0f0',
}

const modalTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#222',
}

const closeButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: '50%',
  background: '#f5f5f5',
  cursor: 'pointer',
  fontSize: 14,
  color: '#666',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const modalBodyStyle: React.CSSProperties = {
  overflow: 'auto',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const providerCardStyle: React.CSSProperties = {
  border: '1px solid #f0f0f0',
  borderRadius: 10,
  padding: 14,
  background: '#fafafa',
}

const providerHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
}

const statusDotStyle: React.CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: '#52c41a',
}

const providerNameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#222',
}

const modelBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 10,
  background: '#e6f7ff',
  color: '#1890ff',
}

const fieldGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '6px 12px',
}

const fieldItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
}

const fieldValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#333',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const progressTrackStyle: React.CSSProperties = {
  height: 8,
  borderRadius: 4,
  background: '#e5e5e5',
  overflow: 'hidden',
}

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 4,
  transition: 'width 0.3s ease',
}

const modelListStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '6px 0 0',
  maxHeight: 140,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const modelItemStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#444',
  padding: '3px 0',
  borderBottom: '1px solid #f0f0f0',
}

const mutedItemStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
  padding: '3px 0',
}
