import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation.ts'
import { findCurrentChoice, selectionFor, sortGroupsForCurrent } from '../model/selection.ts'
import type { Choice, ModelProviderSelectProps, Pane, Selection } from '../model/types.ts'
import { EffortPane } from './EffortPane.tsx'
import { ModelPane } from './ModelPane.tsx'
import { ProviderPane } from './ProviderPane.tsx'
import { RootPane } from './RootPane.tsx'
import { StatusBlock } from './StatusBlock.tsx'

const MENU_MIN_WIDTH = 360
const MENU_MAX_HEIGHT = 560
const MENU_MARGIN = 8

export function ModelSelector({ locked, available, directory, load, select, t }: ModelProviderSelectProps): JSX.Element | null {
  const state = useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot())
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const paneRef = useRef(pane)
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
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortIsCustom = effectiveEffort !== undefined && effectiveEffort !== reasoning?.defaultEffort
  const effortLabel =
    reasoning === undefined
      ? undefined
      : effectiveEffort === undefined
        ? t('effort.providerDefault')
        : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
  const visibleEffortLabel = effortIsCustom ? effortLabel : undefined

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const providerLabel = currentChoice?.group.name
  const triggerLabel =
    providerLabel === undefined
      ? visibleEffortLabel === undefined
        ? modelLabel
        : `${modelLabel} · ${visibleEffortLabel}`
      : visibleEffortLabel === undefined
        ? `${modelLabel} · ${providerLabel}`
        : `${modelLabel} · ${providerLabel} · ${visibleEffortLabel}`

  const triggerAria =
    currentChoice === undefined
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel, provider: providerLabel })
        : t('trigger.ariaEffort', { model: modelLabel, provider: providerLabel, effort: effortLabel })

  const effortChoices: { key: string; effort?: string; label: string; description?: string }[] = useMemo(() => {
    if (reasoning === undefined) return []
    const result: { key: string; effort?: string; label: string; description?: string }[] = []
    if (reasoning.defaultEffort === undefined) {
      result.push({ key: 'provider-default', label: t('effort.providerDefault') })
    }
    for (const effort of reasoning.efforts) {
      const entry: { key: string; effort: string; label: string; description?: string } = {
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      }
      if (effort.description !== undefined) entry.description = effort.description
      result.push(entry)
    }
    return result
  }, [reasoning, t])

  const providerGroups = useMemo(
    () => sortGroupsForCurrent(state.groups, state.current?.provider),
    [state.groups, state.current?.provider],
  )

  const activeProviderGroup = useMemo(
    () => state.groups.find((group) => group.id === selectedProvider),
    [state.groups, selectedProvider],
  )

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

    // Use the menu's real rendered height so it sits flush above the trigger with no extra gap.
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? maxHeight

    // Prefer above the trigger, since the selector sits at the bottom of the composer.
    let top = rect.top - menuHeight - 6
    if (top < MENU_MARGIN) {
      top = rect.bottom + 6
    }
    if (top + maxHeight + MENU_MARGIN > viewportHeight) {
      top = Math.max(MENU_MARGIN, viewportHeight - maxHeight - MENU_MARGIN)
    }

    // Right-align the popup to the trigger (common for a button on the right side of the composer).
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
    if (open && paneRef.current !== pane) {
      itemRefs.current.find((item): item is HTMLButtonElement => item !== null)?.focus()
    }
    paneRef.current = pane
  }, [pane, open])

  useEffect(() => {
    if (!open) return
    // Run a frame loop while the menu is open so it follows the trigger if the
    // composer layout changes (sidebar resizes, zoom, window resize, etc.).
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
    setPane('root')
    setOpen(true)
    reload()
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }

  const { onRootKeyDown } = useKeyboardNavigation({ open, pane, itemRefs, setPane, onClose: close })

  if (!available) return null

  const onBlur = (event: React.FocusEvent) => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean) => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
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

  const chooseEffort = (effort: string | undefined) => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: Selection = {
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
    lastActionRef.current = 'select'
    select(selection).then(settleSelection)
  }

  itemRefs.current = []
  let cursor = 0
  const registerRef = (node: HTMLButtonElement | null) => {
    itemRefs.current[cursor++] = node
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
        position: 'fixed',
        top: menuPos.top,
        left: menuPos.left,
        width: menuPos.width,
        maxHeight: menuPos.maxHeight,
        zIndex: 1000,
        overflow: 'auto',
        background: '#fff',
        border: '1px solid #e0e0e0',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        padding: '10px 0',
      }
    : undefined

  return (
    <div ref={rootRef} style={rootStyle} onKeyDown={onRootKeyDown} onBlur={onBlur}>
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
        {visibleEffortLabel !== undefined && <span style={triggerMutedStyle}>· {visibleEffortLabel}</span>}
        <span style={chevronStyle}>{open ? '▲' : '▼'}</span>
      </button>
      {open && menuStyle !== undefined && (
        <div ref={menuRef} id={`${id}-menu`} style={menuStyle} role="menu" aria-label={t('trigger.selectAria')}>
          {pane === 'root' && (
            <RootPane
              current={state.current}
              currentChoice={currentChoice}
              choices={choices}
              effortChoices={effortChoices}
              registerRef={registerRef}
              onModel={() => setPane('provider')}
              onEffort={() => setPane('effort')}
              t={t}
            />
          )}
          {pane === 'provider' && (
            <ProviderPane
              groups={providerGroups}
              failures={state.failures}
              current={state.current}
              registerRef={registerRef}
              statusBlock={statusBlock}
              onBack={() => setPane('root')}
              onSelect={(group) => {
                setSelectedProvider(group.id)
                setPane('model')
              }}
              onRetry={reload}
              t={t}
            />
          )}
          {pane === 'model' && activeProviderGroup && (
            <ModelPane
              group={activeProviderGroup}
              current={state.current}
              registerRef={registerRef}
              statusBlock={statusBlock}
              onBack={() => setPane('provider')}
              onSelect={(model) => choose(selectionFor(activeProviderGroup, model))}
              t={t}
            />
          )}
          {pane === 'effort' && currentChoice && (
            <EffortPane
              choices={effortChoices}
              currentEffort={effectiveEffort}
              registerRef={registerRef}
              onBack={() => setPane('root')}
              onSelect={chooseEffort}
              t={t}
            />
          )}
        </div>
      )}
    </div>
  )
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
  border: '1px solid #d9d9d9',
  borderRadius: 6,
  background: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: '20px',
  color: '#333',
  maxWidth: '100%',
  overflow: 'hidden',
}

const triggerMainStyle: React.CSSProperties = {
  fontWeight: 500,
  color: '#111',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const triggerMutedStyle: React.CSSProperties = {
  color: '#888',
  fontSize: 12,
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const chevronStyle: React.CSSProperties = {
  marginLeft: 4,
  fontSize: 10,
  color: '#999',
  flexShrink: 0,
}
