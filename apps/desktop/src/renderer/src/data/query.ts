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
