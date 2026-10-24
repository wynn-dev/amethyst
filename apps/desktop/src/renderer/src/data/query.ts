import { QueryClient } from '@tanstack/react-query'

/**
 * Reads are cached by TanStack Query (ARCHITECTURE.md IPC rule 1). Change events from the
 * runtime will invalidate keys; there is no polling and no refetch on focus (performance.md I5).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    },
  },
})

export type FixtureMode = 'normal' | 'empty' | 'error' | 'loading'

const MODE_KEY = 'amethyst:fixtures'

/**
 * Dev/screenshot knob for placeholder data: `localStorage['amethyst:fixtures']` set to
 * `empty`, `error` or `loading` shows those states on every screen. Removed with the fixtures.
 */
export function fixtureMode(): FixtureMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'empty' || v === 'error' || v === 'loading' ? v : 'normal'
  } catch {
    return 'normal'
  }
}

/** Resolves placeholder data the way an RPC call would: async, and honouring the fixture mode. */
export function fixture<T>(value: () => T, empty: () => T, delayMs = 0): Promise<T> {
  const mode = fixtureMode()
  if (mode === 'loading') return new Promise<T>(() => {})
  if (mode === 'error') return Promise.reject(Object.assign(new Error('The background runtime is not responding.'), { code: 'ERUNTIME' }))
  const v = mode === 'empty' ? empty() : value()
  return delayMs ? new Promise((r) => setTimeout(() => r(v), delayMs)) : Promise.resolve(v)
}
