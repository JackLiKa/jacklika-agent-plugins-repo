interface StatusBlockProps {
  loading: boolean
  loadingText: string
  errorText: string | null
  onRetry: () => void
  retryText: string
}

export function StatusBlock({ loading, loadingText, errorText, onRetry, retryText }: StatusBlockProps): JSX.Element | null {
  if (!loading && errorText === null) return null
  return (
    <div style={{ padding: '8px 6px' }}>
      {loading && <div style={loadingStyle}>{loadingText}</div>}
      {errorText !== null && (
        <div style={errorRowStyle}>
          <span style={errorTextStyle}>{errorText}</span>
          <button type="button" style={retryStyle} onClick={onRetry}>
            {retryText}
          </button>
        </div>
      )}
    </div>
  )
}

const loadingStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ms-fg-muted)',
}

const errorRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
}

const errorTextStyle: React.CSSProperties = {
  color: '#ff4d4f',
}

const retryStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--ms-accent)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
}
