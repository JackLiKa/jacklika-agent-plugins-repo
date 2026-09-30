/** Plugin-scoped CSS for the Qoder connector UI.
 * The `qdp-` prefix is intentionally different from commandcode's `ccp-`
 * namespace to avoid collisions when both plugins inject global styles.
 */
export const QUOTA_CSS_ID = 'dsh-qoder-connect/QuotaPanel.module.css'

export const QUOTA_CSS = `
.qdp-panel { font-family: system-ui, -apple-system, sans-serif; padding: 16px; }
.qdp-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 12px; }
.qdp-section { margin-bottom: 16px; }
.qdp-label { display: block; font-size: 0.85rem; color: var(--text-secondary, #888); margin-bottom: 4px; }
.qdp-input { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--border, #ccc); border-radius: 4px; background: var(--bg, #fff); color: var(--text, #000); }
.qdp-actions { display: flex; gap: 8px; margin-top: 8px; }
.qdp-button { padding: 6px 12px; border: 1px solid var(--border, #ccc); border-radius: 4px; background: var(--bg-button, #f5f5f5); color: var(--text, #000); cursor: pointer; }
.qdp-button:hover { background: var(--bg-button-hover, #e8e8e8); }
.qdp-button:disabled { opacity: 0.5; cursor: not-allowed; }
.qdp-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border-subtle, #eee); }
.qdp-row:last-child { border-bottom: none; }
.qdp-bar { height: 6px; border-radius: 3px; background: var(--bg-subtle, #ddd); overflow: hidden; margin-top: 4px; }
.qdp-bar-fill { height: 100%; background: var(--accent, #1677ff); }
.qdp-spent .qdp-bar-fill { background: var(--error, #ff4d4f); }
.qdp-list { list-style: none; padding: 0; margin: 0; }
.qdp-error { color: var(--error, #ff4d4f); }
.qdp-muted { color: var(--text-secondary, #888); }
`.trim()

export function injectQuotaCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${QUOTA_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-qoder-connect'
  tag.dataset.pluginCss = QUOTA_CSS_ID
  tag.textContent = QUOTA_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
