import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { clampPercent, mergeCreditAccounts, sortPackageRows } from './quota-merge.ts'
import { noteQuotaStatus, onQuotaSettingsChange, quotaStatus, quotaStatusIsFresh, quotaToggles, setQuotaToggles } from './quota-settings-store.ts'
import { isQoderWebStatus, type QoderWebStatus } from './status-document.ts'
import { QODER_STATUS_PATH, QODER_AUTH_PATH, QODER_GLOBAL_STATUS_PATH, QODER_GLOBAL_AUTH_PATH } from './status-paths.ts'

export interface QuotaSettingsCardProps {
  close: () => void
  t: TranslateNS<'qoder'>
}

async function fetchStatus(path: string): Promise<QoderWebStatus | undefined> {
  try {
    const response = await fetch(path, { method: 'GET', credentials: 'same-origin' })
    const value = await response.json().catch(() => undefined)
    if (isQoderWebStatus(value)) return value
    return { status: 'error', message: 'invalid status document', authKey: '' }
  } catch (error) {
    return { status: 'error', message: String(error), authKey: '' }
  }
}

async function postAuth(path: string, authKey: string, pat: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': authKey },
      body: JSON.stringify({ action: 'set', pat }),
    })
    const value = await response.json().catch(() => undefined)
    if (typeof value === 'object' && value !== null) {
      return { ok: (value as Record<string, unknown>).ok === true, error: String((value as Record<string, unknown>).error ?? '') }
    }
    return { ok: false, error: 'unexpected auth response' }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

async function postClear(path: string, authKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': authKey },
      body: JSON.stringify({ action: 'clear' }),
    })
    const value = await response.json().catch(() => undefined)
    if (typeof value === 'object' && value !== null) {
      return { ok: (value as Record<string, unknown>).ok === true, error: String((value as Record<string, unknown>).error ?? '') }
    }
    return { ok: false, error: 'unexpected clear response' }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export function QuotaSettingsCard({ close, t }: QuotaSettingsCardProps): JSX.Element {
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  const refreshCn = useRefresh(QODER_STATUS_PATH)
  const refreshGlobal = useRefresh(QODER_GLOBAL_STATUS_PATH)

  const statusCn = useSyncExternalStore(
    (cb) => onQuotaSettingsChange(cb),
    () => quotaStatus('qoder'),
    () => undefined,
  )

  const statusGlobal = useSyncExternalStore(
    (cb) => onQuotaSettingsChange(cb),
    () => quotaStatus('qoder-global'),
    () => undefined,
  )

  const toggles = quotaToggles()

  useEffect(() => {
    if (!quotaStatusIsFresh('qoder', 30_000)) refreshCn()
    if (!quotaStatusIsFresh('qoder-global', 30_000)) refreshGlobal()
  }, [refreshCn, refreshGlobal])

  async function save(variant: 'qoder' | 'qoder-global') {
    setBusy(true)
    setMessage(undefined)
    const status = await fetchStatus(variant === 'qoder' ? QODER_STATUS_PATH : QODER_GLOBAL_STATUS_PATH)
    if (!status || status.status !== 'signed-out') {
      setMessage(t('invalidPat'))
      setBusy(false)
      return
    }
    const result = await postAuth(
      variant === 'qoder' ? QODER_AUTH_PATH : QODER_GLOBAL_AUTH_PATH,
      status.authKey,
      pat,
    )
    if (result.ok) {
      setPat('')
      void (variant === 'qoder' ? refreshCn() : refreshGlobal())
    } else {
      setMessage(result.error || t('invalidPat'))
    }
    setBusy(false)
  }

  async function clear(variant: 'qoder' | 'qoder-global') {
    setBusy(true)
    setMessage(undefined)
    const status = await fetchStatus(variant === 'qoder' ? QODER_STATUS_PATH : QODER_GLOBAL_STATUS_PATH)
    const authKey = status && 'authKey' in status ? status.authKey : ''
    const result = await postClear(
      variant === 'qoder' ? QODER_AUTH_PATH : QODER_GLOBAL_AUTH_PATH,
      authKey,
    )
    if (result.ok) {
      void (variant === 'qoder' ? refreshCn() : refreshGlobal())
    } else {
      setMessage(result.error || t('invalidPat'))
    }
    setBusy(false)
  }

  return (
    <div className="qdp-panel">
      <div className="qdp-title">{t('title')}</div>
      {message && <div className="qdp-error">{message}</div>}

      <div className="qdp-section">
        <label className="qdp-label">{t('patLabel')}</label>
        <input
          className="qdp-input"
          type="password"
          value={pat}
          placeholder={t('patPlaceholder')}
          onChange={(e) => setPat(e.target.value)}
        />
        <div className="qdp-actions">
          <button className="qdp-button" disabled={busy || !pat} onClick={() => save('qoder')}>
            {t('savePat')} ({t('cnRegion')})
          </button>
          <button className="qdp-button" disabled={busy || !pat} onClick={() => save('qoder-global')}>
            {t('savePat')} ({t('globalRegion')})
          </button>
        </div>
      </div>

      <RegionSection t={t} variant="qoder" status={statusCn} onClear={() => clear('qoder')} onRefresh={refreshCn} />
      <RegionSection t={t} variant="qoder-global" status={statusGlobal} onClear={() => clear('qoder-global')} onRefresh={refreshGlobal} />

      <div className="qdp-actions">
        <button className="qdp-button" onClick={() => setQuotaToggles(!toggles.cn, toggles.global)}>
          {t('cnRegion')}: {toggles.cn ? 'on' : 'off'}
        </button>
        <button className="qdp-button" onClick={() => setQuotaToggles(toggles.cn, !toggles.global)}>
          {t('globalRegion')}: {toggles.global ? 'on' : 'off'}
        </button>
        <button className="qdp-button" onClick={close}>{t('clearPat')}</button>
      </div>
    </div>
  )
}

function useRefresh(path: string): () => Promise<void> {
  return async () => {
    const status = await fetchStatus(path)
    if (status) noteQuotaStatus(path, status)
  }
}

interface RegionSectionProps {
  t: TranslateNS<'qoder'>
  variant: 'qoder' | 'qoder-global'
  status: QoderWebStatus | undefined
  onClear: () => void
  onRefresh: () => void
}

function RegionSection({ t, variant, status, onClear, onRefresh }: RegionSectionProps): JSX.Element {
  const region = variant === 'qoder' ? t('cnRegion') : t('globalRegion')
  if (!status) return <div className="qdp-section qdp-muted">{region}: {t('loading')}</div>
  if (status.status === 'signed-out') {
    return (
      <div className="qdp-section">
        <strong>{region}</strong>: {t('signedOut')}
        <div className="qdp-actions">
          <button className="qdp-button" onClick={onRefresh}>{t('refresh')}</button>
        </div>
      </div>
    )
  }
  if (status.status === 'error') {
    return (
      <div className="qdp-section">
        <strong>{region}</strong>: <span className="qdp-error">{status.message}</span>
        <div className="qdp-actions">
          <button className="qdp-button" onClick={onClear}>{t('clearPat')}</button>
          <button className="qdp-button" onClick={onRefresh}>{t('refresh')}</button>
        </div>
      </div>
    )
  }

  const accounts = mergeCreditAccounts(status.credits?.accounts ?? [])
  const rows = sortPackageRows(accounts)

  return (
    <div className="qdp-section">
      <div><strong>{region}</strong>: {t('signedInAs', { tail: status.pat.tail })}</div>
      <div className="qdp-actions">
        <button className="qdp-button" onClick={onClear}>{t('clearPat')}</button>
        <button className="qdp-button" onClick={onRefresh}>{t('refresh')}</button>
      </div>
      <h4>{t('credits')}</h4>
      <ul className="qdp-list">
        {rows.map((group) => {
          const pct = clampPercent(group.remain, group.size)
          return (
            <li className={`qdp-row ${group.remain <= 0 ? 'qdp-spent' : ''}`} key={group.packageName}>
              <span>{group.packageName}</span>
              <span>
                {group.unlimited ? '∞' : `${group.remain} / ${group.size > 0 ? group.size : '?'}`}
              </span>
              {pct !== undefined && (
                <div className="qdp-bar">
                  <div className="qdp-bar-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <h4>{t('models')}</h4>
      <ul className="qdp-list">
        {(status.models ?? []).slice(0, 20).map((model, index) => (
          <li className="qdp-row" key={index}>{typeof model === 'string' ? model : String((model as Record<string, unknown>).id ?? index)}</li>
        ))}
      </ul>
    </div>
  )
}
