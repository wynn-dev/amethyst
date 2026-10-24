import { useQuery } from '@tanstack/react-query'
import type { InstanceDetail as RuntimeInstance, InstanceSummary as RuntimeInstanceRow, LoaderKind } from '@shared/services'
import { api, subscribe } from '@/lib/rpc'
import { queryClient } from './query'

/**
 * The runtime's own instance rows and details, for the content and Discover areas (target bars,
 * compatibility filters, "Add from another instance…", upstream modpacks). Kept separate from the
 * sidebar's view models so either side can evolve; invalidated by `instances:changed`.
 */
export const instanceInfoKeys = {
  list: ['instance-info'] as const,
  detail: (id: string) => ['instance-info', id] as const,
}

export function useInstanceRows() {
  return useQuery({ queryKey: instanceInfoKeys.list, queryFn: () => api.instances.list() })
}

export function useInstanceInfo(id: string | undefined) {
  return useQuery({ queryKey: instanceInfoKeys.detail(id ?? ''), queryFn: () => api.instances.get(id ?? ''), enabled: !!id })
}

let installed = false
function installInstanceEvents(): void {
  if (installed) return
  installed = true
  subscribe('instances:changed', ({ added, updated, removed }) => {
    void queryClient.invalidateQueries({ queryKey: instanceInfoKeys.list, exact: true })
    // The sidebar's view models (data/instances.ts) follow the same events.
    void queryClient.invalidateQueries({ queryKey: ['instances'] })
    for (const id of [...updated, ...removed, ...added]) void queryClient.invalidateQueries({ queryKey: instanceInfoKeys.detail(id) })
  })
  subscribe('runtime:restarted', () => void queryClient.invalidateQueries({ queryKey: instanceInfoKeys.list }))
}
installInstanceEvents()

const LOADER_LABEL: Record<LoaderKind, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }

/** "1.21.1 · Fabric" for a runtime instance row. */
export function runtimeLabel(i: Pick<RuntimeInstanceRow, 'minecraft' | 'loader'>): string {
  return i.loader ? `${i.minecraft} · ${LOADER_LABEL[i.loader.kind]}` : i.minecraft
}

export const loaderLabel = (kind: LoaderKind | null | undefined) => (kind ? LOADER_LABEL[kind] : 'Vanilla')

export type { RuntimeInstance, RuntimeInstanceRow }
