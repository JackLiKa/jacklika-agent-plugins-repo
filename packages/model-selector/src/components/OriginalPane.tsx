import { useMemo, useState } from 'react'
import type { CatalogGroup, CatalogModel, DirectorySnapshot, ModelProviderSelectProps, Selection } from '../model/types.ts'
import { selectionFor } from '../model/selection.ts'

interface OriginalPaneProps {
  directory: DirectorySnapshot
  onSelect: (selection: Selection) => void
  t: ModelProviderSelectProps['t']
}

export function OriginalPane({ directory, onSelect, t }: OriginalPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return directory.groups
    return directory.groups
      .map((group) => ({ ...group, models: group.models.filter((m) => m.name.toLowerCase().includes(q)) }))
      .filter((group) => group.models.length > 0)
  }, [directory.groups, query])

  return (
    <div style={containerStyle}>
      <div style={searchRowStyle}>
        <span style={searchIconStyle}>🔎</span>
        <input
          type="text"
          value={query}
          placeholder={t('original.search')}
          style={searchInputStyle}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div style={listStyle}>
        {filteredGroups.map((group) => (
          <GroupSection key={group.id} group={group} current={directory.current} onSelect={onSelect} />
        ))}
        {filteredGroups.length === 0 && <div style={emptyStyle}>{t('original.empty')}</div>}
      </div>
    </div>
  )
}

function GroupSection({
  group,
  current,
  onSelect,
}: {
  group: CatalogGroup
  current: DirectorySnapshot['current']
  onSelect: (selection: Selection) => void
}): JSX.Element {
  return (
    <div style={groupStyle}>
      <div style={groupNameStyle}>{group.name}</div>
      {group.models.map((model) => {
        const selected = current?.provider === group.id && current?.model === model.id
        return (
          <ModelRow key={model.id} group={group} model={model} selected={selected} onSelect={onSelect} />
        )
      })}
    </div>
  )
}

function ModelRow({
  group,
  model,
  selected,
  onSelect,
}: {
  group: CatalogGroup
  model: CatalogModel
  selected: boolean
  onSelect: (selection: Selection) => void
}): JSX.Element {
  return (
    <button
      type="button"
      style={selected ? selectedRowStyle : rowStyle}
      onClick={() => onSelect(selectionFor(group, model))}
    >
      <span style={modelNameStyle}>{model.name}</span>
      {model.description && <span style={descStyle}>{model.description}</span>}
      {selected && <span style={checkStyle}>✓</span>}
    </button>
  )
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 320,
  maxHeight: '100%',
}

const searchRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const searchIconStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
}

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: '#eee',
  fontSize: 13,
  lineHeight: '20px',
}

const listStyle: React.CSSProperties = {
  overflow: 'auto',
  padding: '8px 0',
}

const groupStyle: React.CSSProperties = {
  padding: '6px 0',
}

const groupNameStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  color: '#eee',
  cursor: 'pointer',
  textAlign: 'left',
}

const selectedRowStyle: React.CSSProperties = {
  ...rowStyle,
  background: 'rgba(255,255,255,0.08)',
}

const modelNameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
}

const descStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const checkStyle: React.CSSProperties = {
  color: '#4ade80',
  fontSize: 12,
}

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: '#888',
}
