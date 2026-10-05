import { useMemo, useState } from 'react'
import type { CatalogGroup, CatalogModel, DirectorySnapshot, ModelProviderSelectProps, Selection } from '../model/types.ts'
import { selectionFor } from '../model/selection.ts'

interface QoderPaneProps {
  directory: DirectorySnapshot
  onSelect: (selection: Selection) => void
  t: ModelProviderSelectProps['t']
}

const MODES = [
  { key: 'auto', label: 'Auto', multiplier: '0.5x' },
  { key: 'extreme', label: '极致', multiplier: '2.0x' },
  { key: 'performance', label: '性能', multiplier: '1.1x' },
  { key: 'economy', label: '经济', multiplier: '0.0x' },
]

export function QoderPane({ directory, onSelect, t }: QoderPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('auto')
  const groups = useMemo(() => buildQoderGroups(directory.groups), [directory.groups])
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((section) => ({ ...section, models: section.models.filter((m) => m.model.name.toLowerCase().includes(q)) }))
      .filter((section) => section.models.length > 0)
  }, [groups, query])

  return (
    <div style={containerStyle}>
      <div style={bannerStyle}>🚀 {t('qoder.discount')} 05:50:05</div>
      <div style={modeGridStyle}>
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            style={mode === m.key ? activeModeStyle : modeStyle}
            onClick={() => setMode(m.key)}
          >
            <span>{m.label}</span>
            <span style={multiplierStyle}>{m.multiplier}</span>
          </button>
        ))}
      </div>
      <div style={searchRowStyle}>
        <input
          type="text"
          value={query}
          placeholder={t('qoder.search')}
          style={searchInputStyle}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div style={listStyle}>
        {filteredGroups.map((section) => (
          <Section key={section.title} title={section.title} models={section.models} current={directory.current} onSelect={onSelect} />
        ))}
        {filteredGroups.length === 0 && <div style={emptyStyle}>{t('qoder.empty')}</div>}
      </div>
    </div>
  )
}

function Section({
  title,
  models,
  current,
  onSelect,
}: {
  title: string
  models: { group: CatalogGroup; model: CatalogModel }[]
  current: DirectorySnapshot['current']
  onSelect: (selection: Selection) => void
}): JSX.Element {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      {models.map(({ group, model }) => {
        const selected = current?.provider === group.id && current?.model === model.id
        return <QoderRow key={`${group.id}-${model.id}`} group={group} model={model} selected={selected} onSelect={onSelect} />
      })}
    </div>
  )
}

function QoderRow({
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
    <button type="button" style={selected ? selectedRowStyle : rowStyle} onClick={() => onSelect(selectionFor(group, model))}>
      <span style={nameStyle}>{model.name}</span>
      {isNew(model) && <span style={badgeStyle}>新</span>}
      <span style={multiplierValueStyle}>{computeMultiplier(model)}x</span>
      {selected && <span style={checkStyle}>✓</span>}
    </button>
  )
}

function buildQoderGroups(groups: CatalogGroup[]) {
  const all: { group: CatalogGroup; model: CatalogModel }[] = []
  const qoderModels: { group: CatalogGroup; model: CatalogModel }[] = []
  for (const group of groups) {
    for (const model of group.models) {
      const entry = { group, model }
      all.push(entry)
      if (group.id === 'qoder' || group.id === 'qoder-global') qoderModels.push(entry)
    }
  }
  const models = qoderModels.length > 0 ? qoderModels : all
  const newModels = models.filter((m) => isNew(m.model))
  const rest = models.filter((m) => !isNew(m.model))
  return [
    { title: '新模型', models: newModels },
    { title: '全部模型', models: rest },
  ].filter((s) => s.models.length > 0)
}

function isNew(model: CatalogModel): boolean {
  const name = model.name.toLowerCase()
  return name.includes('sonus') || name.includes('cantus') || name.includes('qwen3.8')
}

function computeMultiplier(model: CatalogModel): string {
  const name = model.name.toLowerCase()
  if (name.includes('flash') || name.includes('lightning')) return '0.1'
  if (name.includes('max') || name.includes('plus')) return '0.5'
  if (name.includes('high') || name.includes('large')) return '1.4'
  return '0.8'
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 320,
  maxHeight: '100%',
  color: '#eee',
}

const bannerStyle: React.CSSProperties = {
  margin: '8px 12px',
  padding: '8px 10px',
  borderRadius: 6,
  background: '#16a34a',
  color: '#fff',
  fontSize: 12,
  fontWeight: 500,
}

const modeGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
  padding: '0 12px 8px',
}

const modeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 10px',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: 'transparent',
  color: '#eee',
  cursor: 'pointer',
  fontSize: 13,
}

const activeModeStyle: React.CSSProperties = {
  ...modeStyle,
  background: 'rgba(255,255,255,0.1)',
  borderColor: 'rgba(255,255,255,0.25)',
}

const multiplierStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
}

const searchRowStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  padding: '6px 10px',
  outline: 'none',
  color: '#eee',
  fontSize: 13,
  lineHeight: '20px',
}

const listStyle: React.CSSProperties = {
  overflow: 'auto',
  padding: '6px 0',
}

const sectionStyle: React.CSSProperties = {
  padding: '6px 0',
}

const sectionTitleStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: '#888',
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

const nameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const badgeStyle: React.CSSProperties = {
  padding: '1px 5px',
  borderRadius: 4,
  background: '#16a34a',
  color: '#fff',
  fontSize: 10,
  fontWeight: 600,
}

const multiplierValueStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
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
