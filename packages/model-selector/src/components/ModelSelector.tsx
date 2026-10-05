import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTheme } from '../hooks/useTheme.ts'
import { decodeModelId, findCurrentChoice, selectionFor } from '../model/selection.ts'
import type { Choice, ModelProviderSelectProps, Selection, SelectorMode } from '../model/types.ts'
import { DevinPane } from './DevinPane.tsx'
import { ModeToggle } from './ModeToggle.tsx'
import { OriginalPane } from './OriginalPane.tsx'
import { QoderPane } from './QoderPane.tsx'
import { StatusBlock } from './StatusBlock.tsx'

const MENU_MIN_WIDTH = 360
const MENU_MAX_HEIGHT = 560
const MENU_MARGIN = 8
const MODE_KEY = '@jacklika/dsh-model-selector:mode'

function themeVars(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  if (theme === 'light') {
    return {
      '--ms-bg': '#ffffff',
      '--ms-fg': '#111111',
      '--ms-fg-muted': '#666666',
      '--ms-border': 'rgba(0,0,0,0.08)',
      '--ms-hover': 'rgba(0,0,0,0.04)',
      '--ms-active': 'rgba(0,0,0,0.06)',
      '--ms-accent': '#16a34a',
      '--ms-badge-bg': '#16a34a',
      '--ms-input-bg': '#f5f5f5',
      '--ms-banner-bg': '#16a34a',
    } as React.CSSProperties
  }
  return {
    '--ms-bg': '#1e1e1e',
    '--ms-fg': '#eeeeee',
    '--ms-fg-muted': '#888888',
    '--ms-border': 'rgba(255,255,255,0.08)',
    '--ms-hover': 'rgba(255,255,255,0.06)',
    '--ms-active': 'rgba(255,255,255,0.08)',
    '--ms-accent': '#4ade80',
    '--ms-badge-bg': '#16a34a',
    '--ms-input-bg': 'rgba(255,255,255,0.05)',
    '--ms-banner-bg': '#16a34a',
  } as React.CSSProperties
}

export function ModelSelector({ locked, available, directory, load, select, t }: ModelProviderSelectProps): JSX.Element | null {
  const theme = useTheme()
  const state = useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot())
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<SelectorMode>(() => loadMode())
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const id = useId()

  const choices: Choice[] = useMemo(
    () =>
      state.groups.flatMap((group) =>
        group.models.map((model) => ({
          group,
          model,
          selection: selectionFor(group, model),
        })),
      ),
    [state.groups],
  )

  const currentChoice = findCurrentChoice(choices, state.current)
  const modelLabel = currentChoice?.model.name ?? (state.current ? decodeModelId(state.current.model).baseModelId : t('trigger.fallback'))
  const providerLabel = currentChoice?.group.name
  const triggerLabel = providerLabel === undefined ? modelLabel : `${modelLabel} · ${providerLabel}`
  const triggerAria = currentChoice === undefined ? t('trigger.selectAria') : t('trigger.aria', { model: modelLabel, provider: providerLabel })

  const busy = state.status === 'selecting'
  const reload = () => {
    lastActionRef.current = 'load'
    load()
  }

  const computeMenuPos = () => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.max(MENU_MIN_WIDTH, rect.width)
    const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(240, viewportHeight * 0.75))
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? maxHeight

    let top = rect.top - menuHeight - 6
    if (top < MENU_MARGIN) {
      top = rect.bottom + 6
    }
    if (top + maxHeight + MENU_MARGIN > viewportHeight) {
      top = Math.max(MENU_MARGIN, viewportHeight - maxHeight - MENU_MARGIN)
    }

    let left = rect.right - width
    if (left < MENU_MARGIN) left = MENU_MARGIN
    if (left + width + MENU_MARGIN > viewportWidth) {
      left = Math.max(MENU_MARGIN, viewportWidth - width - MENU_MARGIN)
    }

    setMenuPos({ top, left, width, maxHeight })
  }

  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    let rafId = 0
    const tick = () => {
      computeMenuPos()
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    const onScroll = () => computeMenuPos()
    const onResize = () => computeMenuPos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [open])

  const show = () => {
    setOpen(true)
    reload()
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (open && event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
  }

  if (!available) return null

  const onBlur = (event: React.FocusEvent) => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean) => {
    if (accepted) {
      close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      // eslint-disable-next-line no-console
      console.error(message)
    }
  }

  const choose = (selection: Selection) => {
    if (state.current !== null && state.current.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    select(selection).then(settleSelection)
  }

  const onModeChange = (next: SelectorMode) => {
    setMode(next)
    saveMode(next)
  }

  const statusBlock = (
    <StatusBlock
      loading={state.status === 'loading'}
      loadingText={t('status.loading')}
      errorText={state.error !== null && lastActionRef.current === 'load' ? t('error.action', { message: state.error }) : null}
      onRetry={reload}
      retryText={t('retry')}
    />
  )

  const menuStyle: React.CSSProperties | undefined = menuPos
    ? {
        ...themeVars(theme),
        position: 'fixed',
        top: menuPos.top,
        left: menuPos.left,
        width: menuPos.width,
        maxHeight: menuPos.maxHeight,
        zIndex: 1000,
        overflow: 'auto',
        background: 'var(--ms-bg)',
        border: '1px solid var(--ms-border)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
        color: 'var(--ms-fg)',
      }
    : undefined

  const pane = mode === 'original'
    ? <OriginalPane directory={state} onSelect={choose} t={t} />
    : <ReplicaPane directory={state} onSelect={choose} t={t} />

  return (
    <div ref={rootRef} style={rootStyle} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked || busy}
        style={triggerStyle}
        onClick={() => (open ? close() : show())}
      >
        <span style={triggerMainStyle}>{modelLabel}</span>
        {providerLabel !== undefined && <span style={triggerMutedStyle}>· {providerLabel}</span>}
        <span style={chevronStyle}>{open ? '▲' : '▼'}</span>
      </button>
      {open && menuStyle !== undefined && (
        <div ref={menuRef} id={`${id}-menu`} style={menuStyle} role="menu" aria-label={t('trigger.selectAria')}>
          <div style={headerStyle}>
            <span style={titleStyle}>{t('popup.title')}</span>
            <ModeToggle mode={mode} onChange={onModeChange} t={t} />
          </div>
          {pane}
          {statusBlock}
        </div>
      )}
    </div>
  )
}

function ReplicaPane({ directory, onSelect, t }: { directory: import('../model/types.ts').DirectorySnapshot; onSelect: (s: Selection) => void; t: ModelProviderSelectProps['t'] }): JSX.Element {
  const [provider, setProvider] = useState(directory.current?.provider ?? directory.groups[0]?.id)
  const currentGroup = directory.groups.find((g) => g.id === provider) ?? directory.groups[0]

  if (directory.groups.length === 0) {
    return <div style={emptyStyle}>{t('replica.empty')}</div>
  }

  return (
    <div style={replicaContainerStyle}>
      <div style={tabsStyle}>
        {directory.groups.map((group) => (
          <button
            key={group.id}
            type="button"
            style={group.id === provider ? activeTabStyle : tabStyle}
            onClick={() => setProvider(group.id)}
          >
            {group.name}
          </button>
        ))}
      </div>
      {currentGroup && (
        <ReplicaProviderPane group={currentGroup} directory={directory} onSelect={onSelect} t={t} />
      )}
    </div>
  )
}

function ReplicaProviderPane({
  group,
  directory,
  onSelect,
  t,
}: {
  group: import('../model/types.ts').CatalogGroup
  directory: import('../model/types.ts').DirectorySnapshot
  onSelect: (s: Selection) => void
  t: ModelProviderSelectProps['t']
}): JSX.Element {
  const provider = group.id
  const isDevin = provider === 'devin'
  const isQoder = provider === 'qoder' || provider === 'qoder-global'
  const scopedDirectory = useMemo(() => ({ ...directory, groups: [group] }), [directory, group])

  if (isDevin) return <DevinPane directory={scopedDirectory} onSelect={onSelect} t={t} />
  if (isQoder) return <QoderPane directory={scopedDirectory} onSelect={onSelect} t={t} />
  return <OriginalPane directory={scopedDirectory} onSelect={onSelect} t={t} />
}

function loadMode(): SelectorMode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    if (raw === 'replica') return 'replica'
  } catch {
    // Ignore storage errors (private mode / disabled localStorage).
  }
  return 'original'
}

function saveMode(mode: SelectorMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Ignore storage errors.
  }
}

const rootStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: '100%',
}

const triggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  border: '1px solid var(--ms-border)',
  borderRadius: 6,
  background: 'var(--ms-bg)',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--ms-fg)',
  maxWidth: '100%',
  overflow: 'hidden',
}

const triggerMainStyle: React.CSSProperties = {
  fontWeight: 500,
  color: 'var(--ms-fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const triggerMutedStyle: React.CSSProperties = {
  color: 'var(--ms-fg-muted)',
  fontSize: 12,
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const chevronStyle: React.CSSProperties = {
  marginLeft: 4,
  fontSize: 10,
  color: 'var(--ms-fg-muted)',
  flexShrink: 0,
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ms-fg)',
}

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--ms-fg-muted)',
}

const replicaContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 320,
  maxHeight: '100%',
}

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  padding: '8px 12px 0',
  borderBottom: '1px solid var(--ms-border)',
}

const tabStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: 'none',
  background: 'transparent',
  color: 'var(--ms-fg-muted)',
  cursor: 'pointer',
  fontSize: 13,
}

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  color: 'var(--ms-fg)',
  borderBottom: '2px solid var(--ms-accent)',
}
