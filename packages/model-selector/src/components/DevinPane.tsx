import { useMemo, useState } from 'react'
import type { CatalogGroup, CatalogModel, DirectorySnapshot, ModelProviderSelectProps, Selection } from '../model/types.ts'
import { selectionFor } from '../model/selection.ts'

interface DevinPaneProps {
  directory: DirectorySnapshot
  onSelect: (selection: Selection) => void
  t: ModelProviderSelectProps['t']
}

export function DevinPane({ directory, onSelect, t }: DevinPaneProps): JSX.Element {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => buildDevinSections(directory.groups, directory.current), [directory.groups, directory.current])
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((section) => ({ ...section, models: section.models.filter((m) => m.model.name.toLowerCase().includes(q)) }))
      .filter((section) => section.models.length > 0)
  }, [groups, query])

  return (
    <div style={containerStyle}>
      <div style={searchRowStyle}>
        <span style={searchIconStyle}>🔎</span>
        <input
          type="text"
          value={query}
          placeholder={t('devin.search')}
          style={searchInputStyle}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div style={listStyle}>
        {filteredGroups.map((section) => (
          <Section key={section.title} title={section.title} models={section.models} current={directory.current} onSelect={onSelect} />
        ))}
        {filteredGroups.length === 0 && <div style={emptyStyle}>{t('devin.empty')}</div>}
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
        return <DevinRow key={`${group.id}-${model.id}`} group={group} model={model} selected={selected} onSelect={onSelect} />
      })}
    </div>
  )
}

function DevinRow({
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
  const hue = stringHue(model.name)
  return (
    <button type="button" style={selected ? selectedRowStyle : rowStyle} onClick={() => onSelect(selectionFor(group, model))}>
      <span style={iconStyle}>⚙</span>
      <div style={infoStyle}>
        <div style={nameRowStyle}>
          <span style={nameStyle}>{model.name}</span>
          {selected && <span style={checkStyle}>✓</span>}
        </div>
        {model.description && <div style={descStyle}>{model.description}</div>}
      </div>
      <div style={meterStyle} aria-hidden>
        <div style={{ ...meterFillStyle, width: `${30 + (hue % 50)}%`, background: `hsl(${hue}, 70%, 55%)` }} />
      </div>
    </button>
  )
}

function buildDevinSections(groups: CatalogGroup[], current: DirectorySnapshot['current']) {
  const currentId = current ? `${current.provider}/${current.model}` : null
  const recentlyUsed: { group: CatalogGroup; model: CatalogModel }[] = []
  const recommended: { group: CatalogGroup; model: CatalogModel }[] = []
  const others: { group: CatalogGroup; model: CatalogModel }[] = []

  for (const group of groups) {
    for (const model of group.models) {
      const entry = { group, model }
      const id = `${group.id}/${model.id}`
      if (currentId && id === currentId) {
        recentlyUsed.push(entry)
      } else if (isRecommended(model)) {
        recommended.push(entry)
      } else {
        others.push(entry)
      }
    }
  }

  const sections: { title: string; models: { group: CatalogGroup; model: CatalogModel }[] }[] = []
  if (recentlyUsed.length) sections.push({ title: 'Recently Used', models: recentlyUsed })
  if (recommended.length) sections.push({ title: 'Recommended', models: recommended })
  if (others.length) sections.push({ title: 'All Models', models: others })
  if (sections.length === 0) sections.push({ title: 'All Models', models: [] })
  return sections
}

function isRecommended(model: CatalogModel): boolean {
  const name = model.name.toLowerCase()
  return name.includes('swe-2') || name.includes('opus') || name.includes('fable') || name.includes('astra') || name.includes('kimi')
}

function stringHue(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash << 5) - hash + ch.charCodeAt(0)
  return Math.abs(hash) % 360
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 360,
  maxHeight: '100%',
  color: '#eee',
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
  padding: '6px 0',
}

const sectionStyle: React.CSSProperties = {
  padding: '8px 0',
}

const sectionTitleStyle: React.CSSProperties = {
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
  gap: 10,
  width: '100%',
  padding: '10px 12px',
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

const iconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.08)',
  fontSize: 14,
  flexShrink: 0,
}

const infoStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const nameRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const nameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
}

const descStyle: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: '#888',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const checkStyle: React.CSSProperties = {
  color: '#4ade80',
  fontSize: 12,
}

const meterStyle: React.CSSProperties = {
  width: 40,
  height: 4,
  borderRadius: 2,
  background: 'rgba(255,255,255,0.1)',
  overflow: 'hidden',
  flexShrink: 0,
}

const meterFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 2,
}

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: '#888',
}
