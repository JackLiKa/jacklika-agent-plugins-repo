import type { SelectorMode } from '../model/types.ts'

interface ModeToggleProps {
  mode: SelectorMode
  onChange: (mode: SelectorMode) => void
  t: (key: string) => string
}

export function ModeToggle({ mode, onChange, t }: ModeToggleProps): JSX.Element {
  return (
    <div style={containerStyle}>
      <button
        type="button"
        aria-pressed={mode === 'original'}
        style={mode === 'original' ? activeStyle : inactiveStyle}
        onClick={() => onChange('original')}
      >
        {t('mode.original')}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'replica'}
        style={mode === 'replica' ? activeStyle : inactiveStyle}
        onClick={() => onChange('replica')}
      >
        {t('mode.replica')}
      </button>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  borderRadius: 6,
  background: 'var(--ms-active)',
}

const baseStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: 'none',
  borderRadius: 4,
  fontSize: 12,
  lineHeight: '16px',
  cursor: 'pointer',
  color: 'var(--ms-fg-muted)',
  background: 'transparent',
}

const activeStyle: React.CSSProperties = {
  ...baseStyle,
  color: 'var(--ms-bg)',
  background: 'var(--ms-fg)',
  fontWeight: 500,
}

const inactiveStyle: React.CSSProperties = baseStyle
