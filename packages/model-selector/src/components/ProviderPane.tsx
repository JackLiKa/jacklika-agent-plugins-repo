import { useState } from 'react'
import { filterFailuresByQuery, filterGroupsByQuery } from '../model/selection.ts'
import type { CatalogFailure, CatalogGroup, ModelProviderSelectProps } from '../model/types.ts'

interface ProviderPaneProps {
  groups: CatalogGroup[]
  failures: CatalogFailure[]
  current: { provider: string; model: string; reasoningEffort?: string } | null
  registerRef: (node: HTMLButtonElement | null) => void
  statusBlock: JSX.Element
  onBack: () => void
  onSelect: (group: CatalogGroup) => void
  onRetry: () => void
  t: ModelProviderSelectProps['t']
}

export function ProviderPane({
  groups,
  failures,
  current,
  registerRef,
  statusBlock,
  onBack,
  onSelect,
  onRetry,
  t,
}: ProviderPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const visibleGroups = filterGroupsByQuery(groups, query)
  const visibleFailures = filterFailuresByQuery(failures, query)

  return (
    <div style={{ padding: '0 12px 8px' }}>
      <div style={headerStyle}>
        <button ref={registerRef} type="button" style={backStyle} onClick={onBack}>
          ← {t('provider.back')}
        </button>
        <span style={titleStyle}>{t('provider.title')}</span>
      </div>
      <input
        style={searchStyle}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('model.searchPlaceholder')}
      />
      {visibleGroups.map((group) => {
        const isCurrent = current?.provider === group.id
        return (
          <button
            key={group.id}
            ref={registerRef}
            type="button"
            style={rowStyle}
            onClick={() => onSelect(group)}
          >
            <span style={nameStyle}>{group.name}</span>
            <span style={countStyle}>
              {t('provider.models', { count: group.models.length })}
            </span>
            {isCurrent && <span style={currentBadgeStyle}>{t('provider.current')}</span>}
          </button>
        )
      })}
      {visibleFailures.map((failure) => (
        <div key={failure.id} style={failureRowStyle}>
          <span style={failureNameStyle}>{failure.name}</span>
          <span style={failureMessageStyle}>{failure.message}</span>
          <button ref={registerRef} type="button" style={retryStyle} onClick={onRetry}>
            {t('provider.retry')}
          </button>
        </div>
      ))}
      {statusBlock}
    </div>
  )
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0 10px',
}

const backStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#555',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
}

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#111',
}

const searchStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  marginBottom: 8,
  border: '1px solid #d9d9d9',
  borderRadius: 6,
  fontSize: 12,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 6px',
  margin: '2px 0',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
}

const nameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  color: '#111',
}

const countStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
}

const currentBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#1677ff',
  background: '#e6f4ff',
  padding: '2px 6px',
  borderRadius: 4,
}

const failureRowStyle: React.CSSProperties = {
  padding: '8px 6px',
  margin: '2px 0',
  borderRadius: 6,
  background: '#fff2f0',
}

const failureNameStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#111',
}

const failureMessageStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#ff4d4f',
  margin: '0 8px',
}

const retryStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#1677ff',
  cursor: 'pointer',
  fontSize: 12,
}
