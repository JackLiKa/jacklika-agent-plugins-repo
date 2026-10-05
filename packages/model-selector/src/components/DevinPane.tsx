import { useEffect, useMemo, useState } from 'react'
import { persistModelParams, readStoredParams } from '../api.ts'
import { selectionFor } from '../model/selection.ts'
import type { CatalogGroup, CatalogModel, DirectorySnapshot, ModelParams, ModelProviderSelectProps, Selection } from '../model/types.ts'

interface DevinPaneProps {
  directory: DirectorySnapshot
  onSelect: (selection: Selection) => void
  t: ModelProviderSelectProps['t']
}

const CONTEXT_OPTIONS = [
  { label: '200K 默认', value: 200_000 },
  { label: '400K', value: 400_000 },
  { label: '1M', value: 1_000_000 },
]

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']

export function DevinPane({ directory, onSelect, t }: DevinPaneProps): JSX.Element {
  const providerId = 'devin'
  const currentModelId = directory.current?.provider === providerId ? directory.current.model : undefined
  const currentParams = useMemo(() => (currentModelId !== undefined ? readStoredParams(providerId, currentModelId) : {}), [currentModelId])
  const [query, setQuery] = useState('')
  const [contextWindow, setContextWindow] = useState<number>(currentParams.contextWindow ?? 200_000)
  const [reasoningEffort, setReasoningEffort] = useState<string>(currentParams.reasoningEffort ?? 'medium')

  useEffect(() => {
    if (currentModelId === undefined) return
    const params = readStoredParams(providerId, currentModelId)
    if (params.contextWindow !== undefined) setContextWindow(params.contextWindow)
    if (params.reasoningEffort !== undefined) setReasoningEffort(params.reasoningEffort)
  }, [currentModelId])

  const groups = useMemo(() => buildDevinSections(directory.groups, directory.current), [directory.groups, directory.current])
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((section) => ({ ...section, models: section.models.filter((m) => m.model.name.toLowerCase().includes(q)) }))
      .filter((section) => section.models.length > 0)
  }, [groups, query])

  const selectModel = async (group: CatalogGroup, model: CatalogModel) => {
    const params: ModelParams = { contextWindow, reasoningEffort }
    await persistModelParams(group.id, model.id, params)
    onSelect(selectionFor(group, model, params))
  }

  return (
    <div style={containerStyle}>
      <div style={paramsPanelStyle}>
        <ParamRow label={t('devin.contextWindow')} options={CONTEXT_OPTIONS} value={contextWindow} onChange={setContextWindow} />
        <ParamRow label={t('devin.reasoningEffort')} options={EFFORT_OPTIONS.map((e) => ({ label: e, value: e }))} value={reasoningEffort} onChange={setReasoningEffort} />
      </div>
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
          <Section key={section.title} title={section.title} models={section.models} current={directory.current} onSelect={selectModel} />
        ))}
        {filteredGroups.length === 0 && <div style={emptyStyle}>{t('devin.empty')}</div>}
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
        const selected = current?.provider === group.id && current.model === model.id
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
  onSelect: (group: CatalogGroup, model: CatalogModel) => void
}): JSX.Element {
  const hue = stringHue(model.name)
  const free = isFreeModel(model)
  return (
    <button type="button" style={selected ? selectedRowStyle : rowStyle} onClick={() => onSelect(group, model)}>
      <span style={iconStyle}>⚙</span>
      <div style={infoStyle}>
        <div style={nameRowStyle}>
          <span style={nameStyle}>{model.name}</span>
          {selected && <span style={checkStyle}>✓</span>}
        </div>
        {model.description && <div style={descStyle}>{model.description}</div>}
      </div>
      <div style={tagsStyle}>
        {free && <span style={freeTagStyle}>Free</span>}
        <div style={meterStyle} aria-hidden>
          <div style={{ ...meterFillStyle, width: `${30 + (hue % 50)}%`, background: `hsl(${hue}, 70%, 55%)` }} />
        </div>
      </div>
    </button>
  )
}

function buildDevinSections(groups: CatalogGroup[], current: DirectorySnapshot['current']) {
  const currentBaseId = current?.model ?? null
  const recentlyUsed: { group: CatalogGroup; model: CatalogModel }[] = []
  const recommended: { group: CatalogGroup; model: CatalogModel }[] = []
  const others: { group: CatalogGroup; model: CatalogModel }[] = []

  for (const group of groups) {
    for (const model of group.models) {
      const entry = { group, model }
      if (currentBaseId && model.id === currentBaseId) {
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

function isFreeModel(model: CatalogModel): boolean {
  const name = model.name.toLowerCase()
  return name.includes('adaptive') || name.includes('fusion')
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
  color: 'var(--ms-fg)',
}

const paramsPanelStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--ms-border)',
}

const paramRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  marginBottom: 10,
  flexWrap: 'wrap',
}

const paramLabelStyle: React.CSSProperties = {
  minWidth: 90,
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
  flexShrink: 0,
  lineHeight: '28px',
  whiteSpace: 'nowrap',
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
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '1px solid var(--ms-border)',
}

const searchIconStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
}

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
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
  padding: '8px 0',
}

const sectionTitleStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--ms-fg-muted)',
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
  color: 'var(--ms-fg)',
  cursor: 'pointer',
  textAlign: 'left',
}

const selectedRowStyle: React.CSSProperties = {
  ...rowStyle,
  background: 'var(--ms-active)',
}

const iconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  background: 'var(--ms-active)',
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
  color: 'var(--ms-fg-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const checkStyle: React.CSSProperties = {
  color: 'var(--ms-accent)',
  fontSize: 12,
}

const tagsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
}

const freeTagStyle: React.CSSProperties = {
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--ms-accent)',
  color: 'var(--ms-bg)',
  fontSize: 10,
  fontWeight: 600,
}

const meterStyle: React.CSSProperties = {
  width: 40,
  height: 4,
  borderRadius: 2,
  background: 'var(--ms-border)',
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
  color: 'var(--ms-fg-muted)',
}
