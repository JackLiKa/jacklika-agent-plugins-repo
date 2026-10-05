import { useCallback } from 'react'
import { nextPaneOnEscape } from '../model/selection.ts'
import type { Pane } from '../model/types.ts'

export type ItemRefs = { current: (HTMLButtonElement | null)[] }

export interface KeyboardNavigationOptions {
  open: boolean
  pane: Pane
  itemRefs: ItemRefs
  setPane: (pane: Pane) => void
  onClose: (restoreFocus?: boolean) => void
}

export function useKeyboardNavigation({ open, pane, itemRefs, setPane, onClose }: KeyboardNavigationOptions) {
  const moveFocus = useCallback(
    (offset: number) => {
      const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (items.length === 0) return
      const active = items.findIndex((item) => item === document.activeElement)
      items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
    },
    [itemRefs],
  )

  const onRootKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (open && event.key === 'Escape') {
        event.preventDefault()
        const next = nextPaneOnEscape(pane)
        if (next === 'close') {
          onClose(true)
        } else {
          setPane(next)
        }
        return
      }
      if (!open) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveFocus(event.key === 'ArrowDown' ? 1 : -1)
      }
    },
    [open, pane, setPane, onClose, moveFocus],
  )

  return { onRootKeyDown, moveFocus }
}
