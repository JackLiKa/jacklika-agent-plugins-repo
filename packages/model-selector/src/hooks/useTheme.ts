import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSystemTheme, () => 'dark')
}
