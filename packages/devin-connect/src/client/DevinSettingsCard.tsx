import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { setConnectorStatus } from '@jacklika/dsh-connector-core/client'
import { isDevinWebStatus, type DevinWebStatus } from './status-document.ts'
import { noteDevinStatus } from './status-store.ts'

export interface DevinSettingsCardProps {
  close: () => void
  t: TranslateNS<'devin'>
}

const DEVIN_STATUS_PATH = '/plugins/dsh-devin-connect/status'
const DEVIN_AUTH_PATH = '/plugins/dsh-devin-connect/auth'

async function fetchStatus(): Promise<DevinWebStatus | undefined> {
  try {
    const response = await fetch(DEVIN_STATUS_PATH, { method: 'GET', credentials: 'same-origin' })
    const value = await response.json().catch(() => undefined)
    if (isDevinWebStatus(value)) return value
    return { status: 'error', message: 'invalid status document', authKey: '' }
  } catch (error) {
    return { status: 'error', message: String(error), authKey: '' }
  }
}

async function postAuth(authKey: string, pat: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(DEVIN_AUTH_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Devin-Auth-Key': authKey },
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

async function postClear(authKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(DEVIN_AUTH_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Devin-Auth-Key': authKey },
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

function syncStatus(next: DevinWebStatus | undefined): void {
  const signedIn = next?.status === 'signed-in'
  const detail = signedIn ? (next.user?.email ?? next.user?.name) : undefined
  const models = signedIn && Array.isArray(next.models)
    ? next.models.map((m) => {
      if (typeof m === 'string') return m
      const item = m as Record<string, unknown>
      return typeof item.name === 'string' ? item.name : String(item.id ?? '')
    }).filter(Boolean)
    : []
  noteDevinStatus(signedIn, detail, models.length)
  const user = signedIn ? next?.user : undefined
  setConnectorStatus({
    id: 'devin',
    name: 'Devin',
    signedIn,
    ...(detail ? { detail } : {}),
    ...(user ? { username: user.name, email: user.email } : {}),
    modelsCount: models.length,
    models,
  })
}

export function DevinSettingsCard({ close, t }: DevinSettingsCardProps): JSX.Element {
  const [pat, setPat] = useState('')
  const [status, setStatus] = useState<DevinWebStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  const refresh = async () => {
    const next = await fetchStatus()
    setStatus(next)
    syncStatus(next)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function save() {
    setBusy(true)
    setMessage(undefined)
    const current = await fetchStatus()
    if (!current || current.status !== 'signed-out') {
      setMessage(t('invalidPat'))
      setBusy(false)
      return
    }
    const result = await postAuth(current.authKey, pat)
    if (result.ok) {
      setPat('')
      void refresh()
    } else {
      setMessage(result.error || t('invalidPat'))
    }
    setBusy(false)
  }

  async function clear() {
    setBusy(true)
    setMessage(undefined)
    const current = await fetchStatus()
    const authKey = current && 'authKey' in current ? current.authKey : ''
    const result = await postClear(authKey)
    if (result.ok) {
      void refresh()
    } else {
      setMessage(result.error || t('invalidPat'))
    }
    setBusy(false)
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h2>{t('title')}</h2>
      {message && <div style={{ color: '#ff4d4f' }}>{message}</div>}
      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>{t('patLabel')}</label>
      <input
        type="password"
        value={pat}
        placeholder={t('patPlaceholder')}
        onChange={(e) => setPat(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button disabled={busy || !pat} onClick={save}>{t('savePat')}</button>
        <button onClick={clear}>{t('clearPat')}</button>
        <button onClick={refresh}>{t('refresh')}</button>
        <button onClick={close}>{t('clearPat')}</button>
      </div>
      {status === undefined && <p>{t('loading')}</p>}
      {status?.status === 'signed-out' && <p>{t('signedOut')}</p>}
      {status?.status === 'error' && <p style={{ color: '#ff4d4f' }}>{status.message}</p>}
      {status?.status === 'signed-in' && (
        <div>
          <p>{t('signedInAs', { tail: status.pat.tail })}</p>
          {status.user.name && <p>{t('userName')}: {status.user.name}</p>}
          {status.user.email && <p>{t('userEmail')}: {status.user.email}</p>}
          {status.user.organizations.length > 0 && <p>{t('organizations')}: {status.user.organizations.join(', ')}</p>}
          <h4 style={{ marginTop: 16, marginBottom: 8 }}>{t('models')}</h4>
          {status.models.length === 0 ? (
            <p>{t('noModels')}</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {status.models.map((model, index) => {
                const id = typeof model === 'string' ? model : String((model as Record<string, unknown>).id ?? index)
                const name = typeof model === 'object' && model !== null && typeof (model as Record<string, unknown>).name === 'string'
                  ? (model as Record<string, unknown>).name as string
                  : id
                return <li key={index} style={{ padding: '4px 0' }}>{name}</li>
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
