import { useQuery } from '@tanstack/react-query'
import type { UpdaterState } from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { queryClient } from './query'

export const updaterKey = ['updater'] as const

/** The auto-updater state from main; pushed live through `updater:state`. */
export function useUpdaterState(): UpdaterState {
  return useQuery({ queryKey: updaterKey, queryFn: () => api.updater.getState() }).data ?? { status: 'idle' }
}

export const updaterActions = {
  async check() {
    try {
      queryClient.setQueryData(updaterKey, await api.updater.check())
    } catch (e) {
      toastError(e, 'Couldn’t check for updates')
    }
  },
  async restart() {
    try {
      await api.updater.quitAndInstall()
    } catch (e) {
      toastError(e, 'Couldn’t restart to update')
    }
  },
}

/** The launcher's own version info. */
export function useAppInfo() {
  return useQuery({ queryKey: ['app', 'info'], queryFn: () => api.app.getInfo() })
}
