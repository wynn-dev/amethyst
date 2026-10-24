import { useQuery } from '@tanstack/react-query'
import type { Events } from '@shared/events'
import type { LoaderKind as RuntimeLoader } from '@shared/services'
import { api } from '@/lib/rpc'
import type { GameVersion, LoaderKind, LoaderVersion } from './types'

type ListName = Events['versions:changed']['lists'][number]

export const versionKeys = {
  list: (name: ListName) => ['versions', name] as const,
  minecraft: (snapshots: boolean) => ['versions', 'minecraft', snapshots ? 'all' : 'releases'] as const,
  loader: (kind: RuntimeLoader, minecraft: string) => ['versions', kind, minecraft] as const,
}

/**
 * Minecraft versions from Mojang's manifest (served from the on-disk cache; a stale list refreshes
 * in the background and `versions:changed` follows). Snapshots and old versions are opt-in.
 */
export function useGameVersions(snapshots = false) {
  return useQuery({
    queryKey: versionKeys.minecraft(snapshots),
    queryFn: async (): Promise<GameVersion[]> => {
      const list = await api.versions.listMinecraft({ types: snapshots ? ['release', 'snapshot', 'old'] : ['release'] })
      return list.items.map((v) => ({ id: v.id, type: v.type, releasedAt: Date.parse(v.releaseTime) || 0, installed: v.installed }))
    },
  })
}

/** Builds of a loader for a Minecraft version, newest first. Empty when the loader doesn't support it. */
export function useLoaderVersions(kind: LoaderKind, minecraft: string | undefined) {
  return useQuery({
    queryKey: versionKeys.loader(kind === 'vanilla' ? 'fabric' : kind, minecraft ?? ''),
    enabled: kind !== 'vanilla' && !!minecraft,
    queryFn: async (): Promise<LoaderVersion[]> => {
      const list = await api.versions.listLoaders(kind as RuntimeLoader, minecraft!)
      // Prefer a stable build as "recommended" when the loader has no promotion of its own.
      const hasRecommended = list.items.some((v) => v.recommended)
      const firstStable = list.items.find((v) => v.stable)?.version
      return list.items.map((v) => ({ version: v.version, recommended: hasRecommended ? v.recommended : v.version === firstStable, latest: v.latest }))
    },
  })
}
