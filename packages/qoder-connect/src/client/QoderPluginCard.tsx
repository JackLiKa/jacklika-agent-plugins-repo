import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { setConnectorStatus } from '@jacklika/dsh-connector-core/client'
import { mergeCreditAccounts, sortPackageRows, visibleQuotaGroups, clampPercent } from './quota-merge.ts'
import { noteQuotaSignIn, noteQuotaStatus } from './quota-settings-store.ts'
import { isQoderWebStatus, type QoderCredits, type QoderPlan, type QoderWebStatus } from './status-document.ts'
import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from './status-paths.ts'

const POLL_INTERVAL_MS = 60_000

const QODER_CN_CARD = {
  id: 'qoder' as const,
  titleKey: 'title' as const,
  introKey: 'intro' as const,
  signedOutKey: 'signedOutHint' as const,
  patGuideKey: 'patGuide' as const,
  patPlaceholderKey: 'patPlaceholder' as const,
  statusPath: QODER_STATUS_PATH,
  probePath: QODER_PROBE_PATH,
  authPath: QODER_AUTH_PATH,
}

const QODER_GLOBAL_CARD = {
  id: 'qoder-global' as const,
  titleKey: 'titleAI' as const,
  introKey: 'introAI' as const,
  signedOutKey: 'signedOutHintAI' as const,
  patGuideKey: 'patGuideAI' as const,
  patPlaceholderKey: 'patPlaceholderAI' as const,
  statusPath: QODER_GLOBAL_STATUS_PATH,
  probePath: QODER_GLOBAL_PROBE_PATH,
  authPath: QODER_GLOBAL_AUTH_PATH,
}

const QODER_CARD_VARIANTS = [QODER_CN_CARD, QODER_GLOBAL_CARD]

type Variant = typeof QODER_CARD_VARIANTS[number]

export interface QoderPluginCardProps {
  close?: () => void
  t: TranslateNS<'qoder'>
  variant?: Variant
  unified?: boolean
}

function formatTime(timestamp: number | string | undefined): string {
  if (timestamp === undefined) return ''
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M3.5 5.5L7 9l3.5-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function QoderPluginCard({ close, t, variant, unified = false }: QoderPluginCardProps): JSX.Element {
  const isUnified = unified
  const [activeVariantId, setActiveVariantId] = useState<'qoder' | 'qoder-global'>('qoder')
  const currentVariant = isUnified
    ? (activeVariantId === 'qoder' ? QODER_CN_CARD : QODER_GLOBAL_CARD)
    : (variant ?? QODER_CN_CARD)

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<QoderWebStatus | undefined>(undefined)
  const [readFailure, setReadFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [patDraft, setPatDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [patBusy, setPatBusy] = useState(false)
  const [patNotice, setPatNotice] = useState<string | undefined>(undefined)
  const [patError, setPatError] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState('status')
  const mounted = useRef(true)
  const readSeq = useRef(0)
  const manualControllers = useRef(new Set<AbortController>())
  const patInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setStatus(undefined)
    setReadFailure(undefined)
    setPatDraft('')
    setReplacing(false)
    setPatError(undefined)
    setPatNotice(undefined)
    void refresh()
    return () => {
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [open, currentVariant.statusPath])

  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(id) }
  }, [open, currentVariant.statusPath])

  function formatQoderQuota(credits: QoderCredits | undefined, plan: QoderPlan | undefined): string | undefined {
    if (!credits) return undefined
    if (credits.error) return `Quota error: ${credits.error}`
    const accounts = credits.accounts.filter((a) => !a.unlimited)
    const quotaSummary = accounts.length === 0
      ? (credits.accounts.some((a) => a.unlimited) ? 'Unlimited' : undefined)
      : `${accounts.reduce((sum, a) => sum + (a.remain ?? 0), 0)} / ${accounts.reduce((sum, a) => sum + (a.size ?? 0), 0)} credits`
    const parts: string[] = []
    if (plan?.planTierName) parts.push(plan.planTierName)
    if (quotaSummary) parts.push(quotaSummary)
    return parts.length > 0 ? parts.join(' | ') : undefined
  }

  function syncConnectorStatus(value: QoderWebStatus): void {
    const signedIn = value.status === 'signed-in'
    const user = signedIn ? value.user : undefined
    const detail = value.status === 'signed-in' && value.user
      ? (value.user.email ?? value.user.username ?? value.pat?.tail)
      : (value.status === 'error' ? value.message : undefined)
    const models = signedIn && Array.isArray(value.models)
      ? value.models.map((m) => (typeof m === 'string' ? m : String((m as Record<string, unknown>).id ?? ''))).filter(Boolean)
      : []
    setConnectorStatus({
      id: currentVariant.id,
      name: currentVariant.id === 'qoder' ? 'Qoder' : 'Qoder China',
      signedIn,
      ...(detail ? { detail } : {}),
      username: user?.username,
      email: user?.email,
      userType: user?.userType,
      orgId: user?.orgId,
      avatarUrl: user?.avatarUrl,
      modelsCount: models.length,
      models,
      quotaText: signedIn ? formatQoderQuota(value.credits, value.plan) : undefined,
    })
  }

  function trackController(): AbortController {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    return controller
  }

  function untrack(controller: AbortController): void {
    manualControllers.current.delete(controller)
  }

  async function refresh(): Promise<boolean> {
    const seq = ++readSeq.current
    const controller = trackController()
    const current = () => mounted.current && !controller.signal.aborted && seq === readSeq.current
    try {
      const response = await fetch(currentVariant.statusPath, {
        method: 'GET',
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json()
      if (!isQoderWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      syncConnectorStatus(value)
      noteQuotaStatus(currentVariant.statusPath, value)
      noteQuotaSignIn(currentVariant.id, value.status === 'signed-in')
      setReadFailure(undefined)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (current()) {
        setReadFailure(message)
        setStatus((prev) => prev ?? { status: 'error', message, authKey: '' })
      }
      return false
    } finally {
      untrack(controller)
    }
  }

  async function manualRefresh(): Promise<void> {
    setBusy(true)
    await refresh()
    setBusy(false)
  }

  async function savePat(): Promise<void> {
    setPatBusy(true)
    setPatError(undefined)
    setPatNotice(undefined)
    try {
      const status = await fetch(currentVariant.statusPath, { method: 'GET', credentials: 'same-origin' }).then((r) => r.json())
      if (!isQoderWebStatus(status) || status.status !== 'signed-out') {
        setPatError(t('patInvalid'))
        setPatBusy(false)
        return
      }
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': status.authKey },
        body: JSON.stringify({ action: 'save-pat', pat: patDraft }),
      })
      const record = await response.json().catch(() => undefined)
      if (!response.ok || typeof record !== 'object' || record === null || record.ok !== true) {
        const error = typeof record === 'object' && record !== null ? String(record.error ?? '') : ''
        setPatError(error === 'qoder_invalid_pat' || error === 'qoder_missing_pat' ? t('patInvalid') : t('patSaveFailed'))
        setPatBusy(false)
        return
      }
      setPatDraft('')
      setReplacing(false)
      setPatNotice(t('patSaved'))
      noteQuotaSignIn(currentVariant.id, true)
      await refresh()
    } catch (error) {
      setPatError(String(error))
    } finally {
      setPatBusy(false)
    }
  }

  async function clearPat(): Promise<void> {
    setPatBusy(true)
    try {
      const currentStatus = status
      const authKey = currentStatus && 'authKey' in currentStatus ? currentStatus.authKey : ''
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': authKey },
        body: JSON.stringify({ action: 'clear' }),
      })
      const value = await response.json().catch(() => undefined)
      if (typeof value === 'object' && value !== null && value.ok === true) {
        const synthetic: QoderWebStatus = { status: 'signed-out', authKey }
        setStatus(synthetic)
        noteQuotaStatus(currentVariant.statusPath, synthetic)
        noteQuotaSignIn(currentVariant.id, false)
        await refresh()
      }
    } catch (error) {
      setPatError(String(error))
    } finally {
      setPatBusy(false)
    }
  }

  function beginReplace(): void {
    setPatDraft('')
    setPatError(undefined)
    setPatNotice(undefined)
    setReplacing(true)
    requestAnimationFrame(() => patInput.current?.focus())
  }

  const authKey = status && 'authKey' in status ? status.authKey : undefined

  const statusLabel =
    status === undefined ? t('loading')
      : status.status === 'signed-in' ? t('signedInAs', { tail: status.pat.tail })
        : status.status === 'signed-out' ? t('signedOut')
          : status.message

  const cardTitle = isUnified ? t('title') : t(currentVariant.titleKey)
  const cardIntro = t(currentVariant.introKey)
  const cnStatus = undefined // dot status omitted for brevity

  return (
    <li style={{ ...cardStyle, ...(open ? cardOpenStyle : {}) }}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${cardTitle}`}
        onClick={() => setOpen(!open)}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{cardTitle}</span>
          <span style={descriptionStyle}>{cardIntro}</span>
        </span>
        <span style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>
          <ChevronDownIcon />
        </span>
      </button>

      {open && (
        <div style={cardBodyStyle}>
          {isUnified && (
            <div style={segmentedContainerStyle} role="tablist" aria-label="Qoder Version Selection">
              <button
                role="tab"
                aria-selected={activeVariantId === 'qoder'}
                style={segmentedTabItemStyle(activeVariantId === 'qoder')}
                onClick={() => setActiveVariantId('qoder')}
              >
                <span style={dotStyle(cnStatus)} aria-hidden="true" />
                <span>{t('variantTabCN')}</span>
              </button>
              <button
                role="tab"
                aria-selected={activeVariantId === 'qoder-global'}
                style={segmentedTabItemStyle(activeVariantId === 'qoder-global')}
                onClick={() => setActiveVariantId('qoder-global')}
              >
                <span style={dotStyle(cnStatus)} aria-hidden="true" />
                <span>{t('variantTabGlobal')}</span>
              </button>
            </div>
          )}

          <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
          <div style={rowStyle}>
            <div style={statusStyle} role="status" aria-busy={status === undefined}>
              <span>{statusLabel}</span>
            </div>
            <button style={buttonStyle} disabled={busy} onClick={manualRefresh}>
              {busy ? t('refreshing') : t('refresh')}
            </button>
            {status?.status === 'signed-in' && (
              <>
                <button style={buttonStyle} disabled={busy || patBusy} onClick={beginReplace}>{t('patReplace')}</button>
                <button style={buttonStyle} disabled={busy || patBusy} onClick={clearPat}>
                  {patBusy ? t('patClearing') : t('patClear')}
                </button>
              </>
            )}
          </div>

          {readFailure !== undefined && status !== undefined && status.status !== 'error' && (
            <p style={errorStyle}>{t('statusRefreshFailed', { message: readFailure })}</p>
          )}

          {status?.status === 'signed-in' && (
            <>
              {status.pat && <p style={bodyStyle}>{t('signedInAs', { tail: status.pat.tail })}</p>}
              {replacing && patEntry(t, currentVariant, patDraft, setPatDraft, patBusy, savePat, setReplacing, setPatError, patInput)}
              {patNotice && <p style={noticeStyle}>{patNotice}</p>}
              {patError && <p style={errorStyle}>{patError}</p>}

              <div role="tablist" style={tabBarStyle}>
                {['status', 'models'].map((id) => (
                  <button
                    role="tab"
                    key={id}
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    style={{ ...tabStyle, ...(tab === id ? tabActiveStyle : {}) }}
                  >
                    {t(`${id === 'status' ? 'tabStatus' : 'tabModels'}` as 'tabStatus' | 'tabModels')}
                  </button>
                ))}
              </div>

              {tab === 'status' && statusTab(t, status)}
              {tab === 'models' && modelsTab(t, status.models)}
            </>
          )}

          {status?.status === 'signed-out' && (
            <>
              <p style={bodyStyle}>{t(currentVariant.signedOutKey)}</p>
              {authKey !== undefined && patEntry(t, currentVariant, patDraft, setPatDraft, patBusy, savePat, setReplacing, setPatError, patInput)}
              {patError && <p style={errorStyle}>{patError}</p>}
            </>
          )}

          {status?.status === 'error' && <p style={errorStyle}>{status.message}</p>}
          {close !== undefined && (
            <div style={{ marginTop: 12 }}>
              <button style={buttonStyle} onClick={close}>{t('cancel')}</button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function patEntry(
  t: TranslateNS<'qoder'>,
  variant: Variant,
  patDraft: string,
  setPatDraft: (value: string) => void,
  patBusy: boolean,
  savePat: () => void,
  setReplacing: (value: boolean) => void,
  setPatError: (value: string | undefined) => void,
  patInput: React.RefObject<HTMLInputElement | null>,
): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={bodyStyle}>{t(variant.patGuideKey)}</p>
      <div style={patRowStyle}>
        <input
          ref={patInput as Ref<HTMLInputElement>}
          type="password"
          value={patDraft}
          placeholder={t(variant.patPlaceholderKey)}
          aria-label={t('patHeading')}
          disabled={patBusy}
          onChange={(e) => setPatDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePat() } }}
          style={patInputStyle}
        />
        <button style={primaryButtonStyle} disabled={patBusy || patDraft.trim() === ''} onClick={savePat}>
          {patBusy ? t('patSaving') : t('patSave')}
        </button>
        <button style={buttonStyle} disabled={patBusy} onClick={() => { setReplacing(false); setPatDraft(''); setPatError(undefined) }}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

function statusTab(t: TranslateNS<'qoder'>, status: Extract<QoderWebStatus, { status: 'signed-in' }>): JSX.Element {
  const accounts = mergeCreditAccounts(status.credits?.accounts ?? [])
  const groups = visibleQuotaGroups(accounts)
  const totalRemain = groups.reduce((sum, g) => sum + (g.unlimited ? 0 : g.remain), 0)
  const totalSize = groups.reduce((sum, g) => sum + (g.unlimited ? 0 : g.size), 0)
  const unlimitedAll = groups.length > 0 && groups.every((g) => g.unlimited)
  const cycleReset = status.credits?.cycleResetTime
  const user = status.user

  return (
    <div style={tabPanelStyle}>
      <h4>{t('accountHeading')}</h4>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {user?.username && <li style={bodyStyle}>{t('userName')}: {user.username}</li>}
        {user?.email && <li style={bodyStyle}>{t('userEmail')}: {user.email}</li>}
        {user?.userType && <li style={bodyStyle}>{t('userType')}: {user.userType}</li>}
        {user?.orgId && <li style={bodyStyle}>{t('orgId')}: {user.orgId}</li>}
        {typeof status.models?.length === 'number' && (
          <li style={bodyStyle}>{t('modelsAvailable')}: {status.models.length}</li>
        )}
      </ul>

      <h4>{t('creditsHeading')}</h4>
      {groups.length === 0 ? (
        <p style={bodyStyle}>{t('quotaUnavailable')}</p>
      ) : (
        <>
          <div style={rowStyle}>
            <span>
              {t('remaining')}: {unlimitedAll ? t('creditsTotalUnlimited') : totalRemain}
            </span>
            <span>
              {t('total')}: {unlimitedAll ? t('creditsTotalUnlimited') : totalSize > 0 ? totalSize : '?'}
            </span>
          </div>
          {cycleReset && <p style={bodyStyle}>{t('cycleResetAt', { time: formatTime(cycleReset) })}</p>}
          {status.credits?.error && <p style={errorStyle}>{t('creditsError', { message: String(status.credits.error) })}</p>}

          <h4>{t('creditsDetailHeading')}</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sortPackageRows(groups).map((group, index) => (
              <CreditBar key={`${group.packageName}-${index}`} group={group} t={t} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function modelsTab(t: TranslateNS<'qoder'>, models: unknown[]): JSX.Element {
  if (!models || models.length === 0) return <div style={tabPanelStyle}><p>{t('noModels')}</p></div>
  return (
    <div style={tabPanelStyle}>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {models.map((model, index) => {
          const id = typeof model === 'string' ? model : String((model as Record<string, unknown>).id ?? index)
          const contextWindow = typeof model === 'object' && model !== null ? Number((model as Record<string, unknown>).contextWindow) : undefined
          return (
            <li key={index} style={rowStyle}>
              <span>{id}</span>
              {contextWindow !== undefined && !Number.isNaN(contextWindow) && (
                <span style={mutedStyle}>{formatTokens(contextWindow)}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CreditBar({ group, t }: { group: { packageName: string; remain: number; size: number; unlimited: boolean; packageEndTime?: string }; t: TranslateNS<'qoder'> }): JSX.Element {
  const pct = group.unlimited ? undefined : clampPercent(group.remain, group.size)
  return (
    <li style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
      <div style={rowStyle}>
        <span>{group.packageName}</span>
        <span>
          {group.unlimited ? t('creditsTotalUnlimited') : `${group.remain} / ${group.size > 0 ? group.size : '?'}`}
        </span>
      </div>
      {pct !== undefined && (
        <div style={barContainerStyle}>
          <div style={{ ...barFillStyle, width: `${pct}%` }} />
        </div>
      )}
      {group.packageEndTime && <p style={mutedStyle}>{t('expires')}: {formatTime(group.packageEndTime)}</p>}
    </li>
  )
}

const mutedStyle: React.CSSProperties = { color: '#888', fontSize: '0.85rem' }

const cardStyle: React.CSSProperties = {
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  marginBottom: 8,
  overflow: 'hidden',
}

const cardOpenStyle: React.CSSProperties = {
  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '12px 16px',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
}

const headTextStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' }
const nameStyle: React.CSSProperties = { fontWeight: 600 }
const descriptionStyle: React.CSSProperties = { fontSize: '0.85rem', color: '#666' }
const chevronStyle: React.CSSProperties = { transition: 'transform 0.2s' }
const cardBodyStyle: React.CSSProperties = { padding: '0 16px 16px' }
const quotaTitleStyle: React.CSSProperties = { fontSize: '1rem', margin: '12px 0 8px' }
const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const statusStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const buttonStyle: React.CSSProperties = { padding: '4px 10px', border: '1px solid #ccc', borderRadius: 4, background: '#f5f5f5', cursor: 'pointer' }
const primaryButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid var(--dsw-alias-button-primary-fill, #1677ff)',
  borderRadius: 4,
  background: 'var(--dsw-alias-button-primary-fill, #1677ff)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  cursor: 'pointer',
}
const bodyStyle: React.CSSProperties = { margin: '8px 0', color: '#333' }
const errorStyle: React.CSSProperties = { color: '#ff4d4f' }
const noticeStyle: React.CSSProperties = { color: '#52c41a' }
const tabBarStyle: React.CSSProperties = { display: 'flex', gap: 4, borderBottom: '1px solid #eee', margin: '12px 0' }
const tabStyle: React.CSSProperties = { padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer' }
const tabActiveStyle: React.CSSProperties = { borderBottom: '2px solid #1677ff', color: '#1677ff' }
const tabPanelStyle: React.CSSProperties = { padding: '8px 0' }
const segmentedContainerStyle: React.CSSProperties = { display: 'flex', gap: 4, margin: '12px 0' }
const segmentedTabItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #ccc', borderRadius: 4,
  background: active ? '#e6f4ff' : '#fff', cursor: 'pointer',
})
const dotStyle = (_status: unknown): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%', background: '#999',
})
const patRowStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const patInputStyle: React.CSSProperties = { flex: 1, padding: 8, border: '1px solid #ccc', borderRadius: 4 }
const barContainerStyle: React.CSSProperties = { height: 6, borderRadius: 3, background: '#eee', overflow: 'hidden', marginTop: 4 }
const barFillStyle: React.CSSProperties = { height: '100%', background: '#1677ff' }
