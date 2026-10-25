import { useQuery } from '@tanstack/react-query'
import { fixture } from './query'
import { fixtureProject, fixtureProjects } from './fixtures'
import type { ProjectType } from './types'

// Wired hooks moved to their domain modules; re-exported here for existing imports.
export { useAccounts } from './accounts'
export { useTasks } from './tasks'
export { useJavaRuntimes } from './java'
export { useGameVersions, useLoaderVersions } from './versions'
export { useAppInfo } from './updater'
export { useHomeUpdates } from './home'

/**
 * Discover search. `query` empty = landing (featured/trending).
 * TODO(wire): replace with api.marketplace.search({ type, query, source, sort, gameVersion, loader, categories, offset })
 * → { hits: ProjectHit[]; total: number; failedSources: Source[] } (paged, infinite scroll).
 */
export function useProjectSearch(type: ProjectType, query: string, source: 'all' | 'modrinth' | 'curseforge') {
  return useQuery({
    queryKey: ['discover', type, query, source],
    queryFn: () =>
      fixture(
        () => {
          const all = fixtureProjects(type, query)
          return source === 'all' ? all : all.filter((p) => p.source === source)
        },
        () => [],
        query ? 180 : 0,
      ),
  })
}

/**
 * One project page.
 * TODO(wire): replace with api.marketplace.getProject(source, id) → ProjectDetail.
 */
export function useProject(id: string) {
  return useQuery({ queryKey: ['project', id], queryFn: () => fixture(() => fixtureProject(id) ?? null, () => null) })
}
