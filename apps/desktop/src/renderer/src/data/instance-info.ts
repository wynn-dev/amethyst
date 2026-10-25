import { useQuery } from '@tanstack/react-query'
import type { InstanceDetail as RuntimeInstance, InstanceSummary as RuntimeInstanceRow, LoaderKind } from '@shared/services'
import { api } from '@/lib/rpc'
import { instanceKeys, useRuntimeInstances } from './instances'

/**
 * The runtime's own instance rows and details, for the content and Discover areas (target bars,
 * compatibility, "Add from another instance…", upstream modpacks). These read the same cache
 * entries as `data/instances.ts` (`['instances']`, `['instances', id]`), which `data/events.ts`
 * invalidates on `instances:changed`; nothing is fetched twice.
 */

/** Every instance as the runtime returns it. */
export const useInstanceRows = useRuntimeInstances

/** One instance in full (`null` when it doesn't exist). Shares `useInstance`'s cache entry. */
export function useInstanceInfo(id: string | undefined) {
  return useQuery({
    queryKey: instanceKeys.detail(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<RuntimeInstance | null> => {
      try {
        return await api.instances.get(id ?? '')
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOT_FOUND') return null
        throw e
      }
    },
  })
}

const LOADER_LABEL: Record<LoaderKind, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }

/** "1.21.1 · Fabric" for a runtime instance row. */
export function runtimeLabel(i: Pick<RuntimeInstanceRow, 'minecraft' | 'loader'>): string {
  return i.loader ? `${i.minecraft} · ${LOADER_LABEL[i.loader.kind]}` : i.minecraft
}

export const loaderLabel = (kind: LoaderKind | null | undefined) => (kind ? LOADER_LABEL[kind] : 'Vanilla')

export type { RuntimeInstance, RuntimeInstanceRow }
