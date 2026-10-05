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

  const currentModel = useMemo(() => {
    if (currentModelId === undefined) return undefined
    for (const group of directory.groups) {
      if (group.id !== providerId) continue
      const found = group.models.find((m) => m.id === currentModelId)
      if (found) return found
    }
    return undefined
  }, [directory.groups, currentModelId])

  const sections = useMemo(() => buildFamilySections(directory.groups, providerId), [directory.groups])
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sections
    return sections
      .map((section) => ({
        ...section,
        models: section.models.filter((m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.description ?? '').toLowerCase().includes(q)
        ),
      }))
      .filter((section) => section.models.length > 0)
  }, [sections, query])

  const selectModel = async (group: CatalogGroup, model: CatalogModel) => {
    const params: ModelParams = { contextWindow, reasoningEffort }
    await persistModelParams(group.id, model.id, params)
    onSelect(selectionFor(group, model, params))
  }

  return (
    <div style={containerStyle}>
      <SelectedModelCard model={currentModel} contextWindow={contextWindow} reasoningEffort={reasoningEffort} t={t} />
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
        {filteredSections.map((section) => (
          <Section
            key={section.family}
            family={section.family}
            models={section.models}
            selectedModelId={currentModelId}
            onSelect={selectModel}
          />
        ))}
        {filteredSections.length === 0 && <div style={emptyStyle}>{t('devin.empty')}</div>}
      </div>
    </div>
  )
}

function SelectedModelCard({
  model,
  contextWindow,
  reasoningEffort,
  t,
}: {
  model: CatalogModel | undefined
  contextWindow: number
  reasoningEffort: string
  t: ModelProviderSelectProps['t']
}): JSX.Element {
  const info = useMemo(() => (model ? parseDevinDescription(model.description) : { contextText: '', inputPrice: '', cachedPrice: '', outputPrice: '', capability: 0 }), [model])
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardIconStyle}>⚙</span>
        <div style={cardTitleStyle}>
          <div style={cardNameStyle}>{model?.name ?? t('devin.noSelection')}</div>
          <div style={cardContextStyle}>{info.contextText || `Context ${formatNumber(contextWindow)}`}</div>
        </div>
      </div>
      <div style={cardReasoningStyle}>
        <span style={cardReasoningLabelStyle}>{t('devin.reasoningEffort')}</span>
        <span style={cardReasoningValueStyle}>{reasoningEffort}</span>
      </div>
      <div style={costRowStyle}>
        <CostPill label={t('devin.input')} value={info.inputPrice || '—'} />
        <CostPill label={t('devin.cached')} value={info.cachedPrice || '—'} />
        <CostPill label={t('devin.output')} value={info.outputPrice || '—'} />
      </div>
      <div style={meterPanelStyle}>
        <span style={meterLabelStyle}>{t('devin.current')}</span>
        <div style={meterTrackStyle}>
          <div style={{ ...meterFillStyle, width: `${Math.max(5, Math.round(info.capability * 100))}%` }} />
        </div>
      </div>
    </div>
  )
}

function CostPill({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={costPillStyle}>
      <div style={costPillLabelStyle}>{label}</div>
      <div style={costPillValueStyle}>{value}</div>
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
  family,
  models,
  selectedModelId,
  onSelect,
}: {
  family: string
  models: CatalogModel[]
  selectedModelId: string | undefined
  onSelect: (group: CatalogGroup, model: CatalogModel) => void
}): JSX.Element {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{family}</div>
      {models.map((model) => {
        const selected = selectedModelId === model.id
        return <DevinRow key={model.id} model={model} selected={selected} onSelect={onSelect} />
      })}
    </div>
  )
}

function DevinRow({
  model,
  selected,
  onSelect,
}: {
  model: CatalogModel
  selected: boolean
  onSelect: (group: CatalogGroup, model: CatalogModel) => void
}): JSX.Element {
  const hue = stringHue(model.name)
  const free = isFreeModel(model)
  const info = useMemo(() => parseDevinDescription(model.description), [model.description])
  const group: CatalogGroup = { id: 'devin', name: 'Devin', models: [model] }
  return (
    <button type="button" style={selected ? selectedRowStyle : rowStyle} onClick={() => onSelect(group, model)}>
      <span style={iconStyle}>⚙</span>
      <div style={infoStyle}>
        <div style={nameRowStyle}>
          <span style={nameStyle}>{model.name.replace(/^.*?›\s*/, '')}</span>
          {selected && <span style={checkStyle}>✓</span>}
        </div>
        {info.contextText && <div style={descStyle}>{info.contextText}</div>}
      </div>
      <div style={tagsStyle}>
        {free && <span style={freeTagStyle}>Free</span>}
        <div style={meterStyle} aria-hidden>
          <div style={{ ...meterFillStyle, width: `${Math.max(10, Math.round(info.capability * 100))}%`, background: `hsl(${hue}, 70%, 55%)` }} />
        </div>
      </div>
    </button>
  )
}

function buildFamilySections(groups: CatalogGroup[], providerId: string): { family: string; models: CatalogModel[] }[] {
  const map = new Map<string, CatalogModel[]>()
  for (const group of groups) {
    if (group.id !== providerId) continue
    for (const model of group.models) {
      const [family = 'Models'] = model.name.split(' › ')
      const list = map.get(family) ?? []
      list.push(model)
      map.set(family, list)
    }
  }
  return Array.from(map.entries()).map(([family, models]) => ({ family, models }))
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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  if (n >= 1_000) return `${n / 1_000}K`
  return String(n)
}

function parseDevinDescription(description: string | undefined): {
  contextText: string
  inputPrice: string
  cachedPrice: string
  outputPrice: string
  capability: number
} {
  const result = { contextText: '', inputPrice: '', cachedPrice: '', outputPrice: '', capability: 0 }
  if (description === undefined) return result

  const contextMatch = description.match(/Context\s+([\d,]+)/i)
  if (contextMatch?.[1]) {
    result.contextText = `Context ${contextMatch[1]}`
    const raw = Number(contextMatch[1].replace(/,/g, ''))
    if (!Number.isNaN(raw)) result.capability = Math.min(1, raw / 1_000_000)
  }

  const priceMatches = description.match(/\$([\d.]+)\s*\/\s*MTok(?:\s+In)?/gi)
  if (priceMatches) {
    result.inputPrice = priceMatches[0] ?? ''
    if (priceMatches.length > 1) {
      result.outputPrice = priceMatches[priceMatches.length - 1] ?? ''
    }
  }

  if (result.capability === 0) {
    result.capability = Math.min(1, stringHue(description) / 360)
  }

  return result
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 360,
  maxHeight: '100%',
  color: 'var(--ms-fg)',
}

const cardStyle: React.CSSProperties = {
  padding: 14,
  borderBottom: '1px solid var(--ms-border)',
  background: 'var(--ms-active)',
}

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 10,
}

const cardIconStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  background: 'var(--ms-hover)',
  fontSize: 18,
  flexShrink: 0,
}

const cardTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const cardNameStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const cardContextStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
}

const cardReasoningStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 10,
}

const cardReasoningLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
}

const cardReasoningValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 4,
  background: 'var(--ms-hover)',
}

const costRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 10,
}

const costPillStyle: React.CSSProperties = {
  flex: 1,
  padding: 8,
  borderRadius: 6,
  background: 'var(--ms-hover)',
}

const costPillLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--ms-fg-muted)',
  marginBottom: 2,
}

const costPillValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
}

const meterPanelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const meterLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--ms-fg-muted)',
  width: 50,
}

const meterTrackStyle: React.CSSProperties = {
  flex: 1,
  height: 6,
  borderRadius: 3,
  background: 'var(--ms-border)',
  overflow: 'hidden',
}

const meterFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 3,
  background: 'linear-gradient(90deg, #22c55e, #a855f7)',
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

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--ms-fg-muted)',
}
