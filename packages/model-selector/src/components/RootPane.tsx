import type { Choice, EffortChoice, ModelProviderSelectProps } from '../model/types.ts'

interface RootPaneProps {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  currentChoice: Choice | undefined
  choices: Choice[]
  effortChoices: EffortChoice[]
  registerRef: (node: HTMLButtonElement | null) => void
  onModel: () => void
  onEffort: () => void
  t: ModelProviderSelectProps['t']
}

export function RootPane({ currentChoice, effortChoices, registerRef, onModel, onEffort, t }: RootPaneProps): JSX.Element {
  const hasEffort = effortChoices.length > 0
  const currentEffort = effortChoices.find((c) => c.effort === currentChoice?.selection.reasoningEffort)

  return (
    <div style={{ padding: '0 12px' }}>
      <button ref={registerRef} type="button" style={rowStyle} onClick={onModel}>
        <span style={labelStyle}>{t('root.model')}</span>
        <span style={valueStyle}>{currentChoice?.model.name ?? t('trigger.fallback')}</span>
        <span style={hintStyle}>{currentChoice?.group.name}</span>
      </button>
      {hasEffort && (
        <button ref={registerRef} type="button" style={rowStyle} onClick={onEffort}>
          <span style={labelStyle}>{t('root.effort')}</span>
          <span style={valueStyle}>{currentEffort?.label ?? t('effort.providerDefault')}</span>
        </button>
      )}
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 8px',
  margin: '2px 0',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
}

const labelStyle: React.CSSProperties = {
  width: 72,
  flexShrink: 0,
  fontSize: 13,
  color: '#555',
}

const valueStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  color: '#111',
}

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
}
