import type { EffortChoice, ModelProviderSelectProps } from '../model/types.ts'

interface EffortPaneProps {
  choices: EffortChoice[]
  currentEffort: string | undefined
  registerRef: (node: HTMLButtonElement | null) => void
  onBack: () => void
  onSelect: (effort: string | undefined) => void
  t: ModelProviderSelectProps['t']
}

export function EffortPane({ choices, currentEffort, registerRef, onBack, onSelect, t }: EffortPaneProps): JSX.Element {
  return (
    <div style={{ padding: '0 12px 8px' }}>
      <div style={headerStyle}>
        <button ref={registerRef} type="button" style={backStyle} onClick={onBack}>
          ← {t('effort.back')}
        </button>
        <span style={titleStyle}>{t('effort.title')}</span>
      </div>
      {choices.map((choice) => {
        const selected = currentEffort === choice.effort
        return (
          <button
            key={choice.key}
            ref={registerRef}
            type="button"
            style={selected ? selectedRowStyle : rowStyle}
            onClick={() => onSelect(choice.effort)}
          >
            <span style={nameStyle}>{choice.label}</span>
            {selected && <span style={checkStyle}>✓</span>}
            {choice.description && <span style={descStyle}>{choice.description}</span>}
          </button>
        )
      })}
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
  flex: 1,
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
