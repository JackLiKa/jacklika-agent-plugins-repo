import { useEffect, useMemo, useState } from 'react'
import { decodeModelId, selectionFor } from '../model/selection.ts'
import type { CatalogGroup, CatalogModel, DirectorySnapshot, ModelProviderSelectProps, Selection } from '../model/types.ts'

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

const CONTEXT_OPTIONS = [
  { label: '200K 默认', value: 200_000 },
  { label: '400K', value: 400_000 },
  { label: '1M', value: 1_000_000 },
]

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']

export function QoderPane({ directory, onSelect, t }: QoderPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('auto')
  const decoded = useMemo(() => (directory.current ? decodeModelId(directory.current.model) : null), [directory.current])
  const [contextWindow, setContextWindow] = useState<number>(decoded?.params.contextWindow ?? 200_000)
  const [reasoningEffort, setReasoningEffort] = useState<string>(decoded?.params.reasoningEffort ?? 'medium')

  useEffect(() => {
    if (decoded?.params.contextWindow !== undefined) setContextWindow(decoded.params.contextWindow)
    if (decoded?.params.reasoningEffort !== undefined) setReasoningEffort(decoded.params.reasoningEffort)
  }, [decoded?.params.contextWindow, decoded?.params.reasoningEffort])

  const groups = useMemo(() => buildQoderGroups(directory.groups), [directory.groups])
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((section) => ({ ...section, models: section.models.filter((m) => m.model.name.toLowerCase().includes(q)) }))
      .filter((section) => section.models.length > 0)
  }, [groups, query])

  const selectModel = (group: CatalogGroup, model: CatalogModel) => {
    onSelect(
      selectionFor(group, model, {
        contextWindow,
        reasoningEffort,
      }),
    )
  }

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
      <div style={paramsPanelStyle}>
        <ParamRow label={t('qoder.contextWindow')} options={CONTEXT_OPTIONS} value={contextWindow} onChange={setContextWindow} />
        <ParamRow label={t('qoder.reasoningEffort')} options={EFFORT_OPTIONS.map((e) => ({ label: e, value: e }))} value={reasoningEffort} onChange={setReasoningEffort} />
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
          <Section key={section.title} title={section.title} models={section.models} current={directory.current} onSelect={selectModel} />
        ))}
        {filteredGroups.length === 0 && <div style={emptyStyle}>{t('qoder.empty')}</div>}
      </div>
    </div>
  )
}

function ParamRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { label: string; value: T }[]
  value: T
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div style={paramRowStyle}>
      <span style={paramLabelStyle}>{label}</span>
      <div style={chipsStyle}>
        {options.map((opt) => {
          const active = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              style={active ? activeChipStyle : chipStyle}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
          )
        })}
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
  onSelect: (group: CatalogGroup, model: CatalogModel) => void
}): JSX.Element {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      {models.map(({ group, model }) => {
        const selected = current?.provider === group.id && decodeModelId(current.model).baseModelId === model.id
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
  onSelect: (group: CatalogGroup, model: CatalogModel) => void
}): JSX.Element {
  return (
    <button type="button" style={selected ? selectedRowStyle : rowStyle} onClick={() => onSelect(group, model)}>
      <span style={nameStyle}>{model.name}</span>
      {isNew(model) && <span style={badgeStyle}>新</span>}
      {isEditable(model) && <span style={editStyle}>✎</span>}
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

function isEditable(model: CatalogModel): boolean {
  return model.name.toLowerCase().includes('sonus')
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
  color: 'var(--ms-fg)',
}

const bannerStyle: React.CSSProperties = {
  margin: '8px 12px',
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--ms-banner-bg)',
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
  border: '1px solid var(--ms-border)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--ms-fg)',
  cursor: 'pointer',
  fontSize: 13,
}

const activeModeStyle: React.CSSProperties = {
  ...modeStyle,
  background: 'var(--ms-active)',
  borderColor: 'var(--ms-accent)',
}

const multiplierStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--ms-fg-muted)',
}

const paramsPanelStyle: React.CSSProperties = {
  padding: '0 12px 8px',
  borderBottom: '1px solid var(--ms-border)',
}

const paramRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
}

const paramLabelStyle: React.CSSProperties = {
  width: 70,
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
  flexShrink: 0,
}

const chipsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  flex: 1,
}

const chipStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid var(--ms-border)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--ms-fg)',
  cursor: 'pointer',
  fontSize: 12,
}

const activeChipStyle: React.CSSProperties = {
  ...chipStyle,
  background: 'var(--ms-active)',
  borderColor: 'var(--ms-accent)',
}

const searchRowStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--ms-border)',
}

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--ms-input-bg)',
  border: '1px solid var(--ms-border)',
  borderRadius: 6,
  padding: '6px 10px',
  outline: 'none',
  color: 'var(--ms-fg)',
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
  color: 'var(--ms-fg-muted)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  color: 'var(--ms-fg)',
  cursor: 'pointer',
  textAlign: 'left',
}

const selectedRowStyle: React.CSSProperties = {
  ...rowStyle,
  background: 'var(--ms-active)',
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
  background: 'var(--ms-banner-bg)',
  color: '#fff',
  fontSize: 10,
  fontWeight: 600,
}

const editStyle: React.CSSProperties = {
  color: 'var(--ms-fg-muted)',
  fontSize: 12,
  cursor: 'pointer',
}

const multiplierValueStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
}

const checkStyle: React.CSSProperties = {
  color: 'var(--ms-accent)',
  fontSize: 12,
}

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--ms-fg-muted)',
}
