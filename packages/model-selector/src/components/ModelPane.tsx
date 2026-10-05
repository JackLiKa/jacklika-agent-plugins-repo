import { useMemo, useState } from 'react'
import { filterModelsByQuery } from '../model/selection.ts'
import type { CatalogGroup, ModelProviderSelectProps } from '../model/types.ts'

interface ModelPaneProps {
  group: CatalogGroup
  current: { provider: string; model: string; reasoningEffort?: string } | null
  registerRef: (node: HTMLButtonElement | null) => void
  statusBlock: JSX.Element
  onBack: () => void
  onSelect: (model: CatalogGroup['models'][number]) => void
  t: ModelProviderSelectProps['t']
}

export function ModelPane({ group, current, registerRef, statusBlock, onBack, onSelect, t }: ModelPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterModelsByQuery(group.models, query), [group.models, query])
  const families = useMemo(() => {
    const map = new Map<string, typeof filtered>()
    for (const model of filtered) {
      const family = extractFamily(model.name)
      if (!map.has(family)) map.set(family, [])
      map.get(family)!.push(model)
    }
    return Array.from(map.entries())
  }, [filtered])

  return (
    <div style={{ padding: '0 12px 8px' }}>
      <div style={headerStyle}>
        <button ref={registerRef} type="button" style={backStyle} onClick={onBack}>
          ← {t('model.back')}
        </button>
        <span style={titleStyle}>{group.name}</span>
        <span style={countStyle}>{t('model.models', { count: group.models.length })}</span>
      </div>
      <input
        style={searchStyle}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('model.searchPlaceholder')}
      />
      {families.map(([family, models]) => (
        <div key={family} style={{ marginTop: 6 }}>
          {family !== '' && <div style={familyStyle}>{family}</div>}
          {models.map((model) => {
            const selected = current?.provider === group.id && current?.model === model.id
            return (
              <button
                key={model.id}
                ref={registerRef}
                type="button"
                style={selected ? selectedRowStyle : rowStyle}
                onClick={() => onSelect(model)}
              >
                <span style={nameStyle}>{trimFamily(model.name, family)}</span>
                {selected && <span style={checkStyle}>✓</span>}
                {model.description && <span style={descStyle}>{model.description}</span>}
              </button>
            )
          })}
        </div>
      ))}
      {statusBlock}
    </div>
  )
}

function extractFamily(name: string): string {
  const idx = name.indexOf(' › ')
  return idx > 0 ? name.slice(0, idx) : ''
}

function trimFamily(name: string, family: string): string {
  const prefix = family ? `${family} › ` : ''
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
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
  flex: 1,
}

const countStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
}

const searchStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  marginBottom: 8,
  border: '1px solid #d9d9d9',
  borderRadius: 6,
  fontSize: 12,
}

const familyStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#222',
  padding: '6px 4px 2px',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  width: '100%',
  padding: '8px 6px',
  margin: '2px 0',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
}

const selectedRowStyle: React.CSSProperties = {
  ...rowStyle,
  background: '#e6f4ff',
}

const nameStyle: React.CSSProperties = {
  flexBasis: '100%',
  fontSize: 13,
  color: '#111',
  fontWeight: 500,
}

const checkStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 12,
  color: '#1677ff',
}

const descStyle: React.CSSProperties = {
  flexBasis: '100%',
  fontSize: 11,
  color: '#888',
}
