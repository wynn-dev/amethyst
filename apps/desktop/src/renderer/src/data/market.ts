import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  InstanceSummary as RuntimeInstanceRow,
  MarketPlatform,
  MarketProjectRow,
  MarketProjectType,
  MarketSearchPage,
  MarketSearchQuery,
  MarketVersionRow,
  ResourceKind,
  UpdateCandidate,
} from '@shared/services'
import { api } from '@/lib/rpc'
import { errorMessage, toastError } from '@/lib/error-messages'
import { openExternal } from '@/lib/files'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'
import { resourceKeys } from './content'

/** Modrinth and CurseForge over `api.marketplace`. */

export const marketKeys = {
  status: ['market', 'status'] as const,
  search: (q: MarketSearchQuery) => ['market', 'search', q] as const,
  project: (platform: MarketPlatform, id: string) => ['market', 'project', platform, id] as const,
  versions: (platform: MarketPlatform, id: string, gameVersion?: string, loader?: string) => ['market', 'versions', platform, id, gameVersion ?? '', loader ?? ''] as const,
  changelog: (platform: MarketPlatform, projectId: string, versionId: string) => ['market', 'changelog', platform, projectId, versionId] as const,
  updates: (instanceId: string, kind: ResourceKind) => ['market', 'updates', instanceId, kind] as const,
}

/** Project types that install into one of an instance's folders. */
export const KIND_FOR_TYPE: Partial<Record<MarketProjectType, ResourceKind>> = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', world: 'saves' }

export function useMarketStatus() {
  return useQuery({ queryKey: marketKeys.status, queryFn: () => api.marketplace.getStatus() })
}

/** Infinite search; each platform pages independently through the cursor. */
export function useMarketSearch(query: MarketSearchQuery) {
  return useInfiniteQuery({
    queryKey: marketKeys.search(query),
    queryFn: ({ pageParam }) => api.marketplace.search(query, pageParam),
    initialPageParam: undefined as MarketSearchPage['cursor'] | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    staleTime: 10 * 60_000,
    gcTime: 10 * 60_000,
  })
}

export function useMarketProject(platform: MarketPlatform | undefined, id: string | undefined) {
  return useQuery({
    queryKey: marketKeys.project(platform ?? 'modrinth', id ?? ''),
    queryFn: () => api.marketplace.getProject(platform ?? 'modrinth', id ?? ''),
    enabled: !!platform && !!id,
    staleTime: 10 * 60_000,
  })
}

export function useMarketVersions(platform: MarketPlatform, id: string, filter: { gameVersion?: string; loader?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: marketKeys.versions(platform, id, filter.gameVersion, filter.loader),
    queryFn: () => api.marketplace.getVersions(platform, id, { ...(filter.gameVersion ? { gameVersion: filter.gameVersion } : {}), ...(filter.loader ? { loader: filter.loader } : {}) }),
    enabled: enabled && !!id,
    staleTime: 10 * 60_000,
  })
}

export function useChangelog(platform: MarketPlatform, projectId: string, versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: marketKeys.changelog(platform, projectId, versionId),
    queryFn: () => api.marketplace.getChangelog(platform, projectId, versionId),
    enabled,
    staleTime: Infinity,
  })
}

/** `modrinth:<id>` keys (search rows and route params). */
export function parseProjectKey(key: string): { platform: MarketPlatform; id: string } | undefined {
  const m = /^(modrinth|curseforge):(.+)$/.exec(key)
  return m ? { platform: m[1] as MarketPlatform, id: m[2] as string } : undefined
}
export const projectKey = (platform: MarketPlatform, id: string) => `${platform}:${id}`

/** Pick the version to install: newest release for the instance, else newest of any channel. */
export function bestVersion(versions: MarketVersionRow[]): MarketVersionRow | undefined {
  return versions.find((v) => v.releaseType === 'release' && v.file) ?? versions.find((v) => v.file)
}

/* ------------------------------------------------------------------------------------------ */
/* Installing                                                                                 */
/* ------------------------------------------------------------------------------------------ */

type InstallState = { state: 'installing' } | { state: 'installed'; resourceId: string | null } | { state: 'failed'; message: string }

/** Install states by `instanceId|projectKey`, for Install buttons (this session). */
export const useInstallStates = create<{ states: Record<string, InstallState> }>(() => ({ states: {} }))
const stateKey = (instanceId: string, key: string) => `${instanceId}|${key}`
const setState = (k: string, s: InstallState) => useInstallStates.setState((st) => ({ states: { ...st.states, [k]: s } }))

export function useInstallState(instanceId: string | undefined, key: string): InstallState | undefined {
  return useInstallStates((s) => (instanceId ? s.states[stateKey(instanceId, key)] : undefined))
}

export interface InstallTarget {
  id: string
  name: string
  minecraft: string
  loader: RuntimeInstanceRow['loader']
}

/** Attributed projects already in an instance folder (`platform:projectId`). */
async function installedKeys(instanceId: string, kind: ResourceKind): Promise<Set<string>> {
  const page = await api.resources.list(instanceId, kind, { limit: 1000 })
  return new Set(page.items.flatMap((r) => (r.source ? [projectKey(r.source.platform, r.source.projectId)] : [])))
}

/**
 * Install a project (or one chosen version) into an instance, plus its required dependencies
 * that are not there yet. Reports success or a mapped error; never silent.
 */
export async function installProject(
  project: Pick<MarketProjectRow, 'platform' | 'id' | 'title' | 'projectType'>,
  target: InstallTarget,
  version?: MarketVersionRow,
): Promise<boolean> {
  const key = projectKey(project.platform, project.id)
  const k = stateKey(target.id, key)
  setState(k, { state: 'installing' })
  try {
    const kind = (project.projectType && KIND_FOR_TYPE[project.projectType]) ?? 'mods'
    const loader = kind === 'mods' ? target.loader?.kind : undefined
    let chosen = version
    if (!chosen) {
      const versions = await api.marketplace.getVersions(project.platform, project.id, { gameVersion: target.minecraft, ...(loader ? { loader } : {}) })
      chosen = bestVersion(versions)
      if (!chosen) throw Object.assign(new Error(`No version of ${project.title} supports ${target.minecraft}${loader ? ` with ${loader}` : ''}.`), { code: 'ENO_COMPATIBLE_VERSION' })
    }
    const result = await api.marketplace.install({ instanceId: target.id, platform: project.platform, projectId: project.id, versionId: chosen.id })
    if (result.manual.length > 0) {
      const m = result.manual[0]!
      setState(k, { state: 'failed', message: 'Manual download required' })
      toast({
        kind: 'warning',
        title: `${project.title} must be downloaded by hand`,
        message: `The author doesn’t allow launchers to download ${m.fileName}. Download it from CurseForge, then drop it on the ${kind === 'mods' ? 'Mods' : 'content'} tab.`,
        duration: 0,
        actions: [{ label: 'Open Download Page', onClick: () => openExternal(m.websiteUrl) }],
      })
      return false
    }
    // Required dependencies (one level; their own dependencies are rare and listed on their pages).
    const required = chosen.dependencies.filter((d) => d.type === 'required' && d.projectId)
    let deps = 0
    if (required.length > 0) {
      const have = await installedKeys(target.id, kind)
      for (const d of required) {
        const depKey = projectKey(project.platform, d.projectId ?? '')
        if (have.has(depKey)) continue
        try {
          let depVersionId = d.versionId
          if (!depVersionId) {
            // oxlint-disable-next-line no-await-in-loop -- dependencies install one after another
            const list = await api.marketplace.getVersions(project.platform, d.projectId ?? '', { gameVersion: target.minecraft, ...(loader ? { loader } : {}) })
            depVersionId = bestVersion(list)?.id ?? null
          }
          if (!depVersionId) continue
          // oxlint-disable-next-line no-await-in-loop
          const r = await api.marketplace.install({ instanceId: target.id, platform: project.platform, projectId: d.projectId ?? '', versionId: depVersionId })
          if (r.resource) deps++
        } catch (e) {
          toastError(e, `Couldn’t install a dependency of ${project.title}`)
        }
      }
    }
    setState(k, { state: 'installed', resourceId: result.resource?.id ?? null })
    void queryClient.invalidateQueries({ queryKey: ['market', 'search'] })
    void queryClient.invalidateQueries({ queryKey: resourceKeys.kind(target.id, kind) })
    toast({ kind: 'success', title: `Installed ${project.title}`, message: `Added to “${target.name}”${deps ? ` with ${deps} required ${deps === 1 ? 'dependency' : 'dependencies'}` : ''}.` })
    return true
  } catch (e) {
    setState(k, { state: 'failed', message: errorMessage(e) })
    toastError(e, `Couldn’t install ${project.title}`)
    return false
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Updates                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Remembered per instance: whether update checks include beta and alpha versions. */
export const useUpdatePolicy = create<{ prereleases: Record<string, boolean>; set: (instanceId: string, on: boolean) => void }>()(
  persist((set) => ({ prereleases: {}, set: (id, on) => set((s) => ({ prereleases: { ...s.prereleases, [id]: on } })) }), { name: 'amethyst:update-policy', version: 1 }),
)

/** Update candidates of a folder. Runs only when asked (`enabled`), then stays cached. */
export function useUpdateCandidates(instanceId: string, kind: ResourceKind, enabled: boolean) {
  const prereleases = useUpdatePolicy((s) => s.prereleases[instanceId] ?? false)
  return useQuery({
    queryKey: [...marketKeys.updates(instanceId, kind), prereleases],
    queryFn: () => api.marketplace.checkUpdates(instanceId, kind, { releaseOnly: !prereleases }),
    enabled: enabled && !!instanceId,
    staleTime: 10 * 60_000,
  })
}

/** Install updates one by one (each replaces its file; a disabled mod stays disabled). */
export async function applyUpdates(instanceId: string, kind: ResourceKind, candidates: UpdateCandidate[], names: Record<string, string>): Promise<void> {
  let done = 0
  const failed: string[] = []
  for (const c of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one replacement at a time keeps the folder consistent
      await api.marketplace.install({ instanceId, platform: c.platform, projectId: c.projectId, versionId: c.latest.versionId, replaces: { kind, id: c.resourceId } })
      done++
    } catch (e) {
      failed.push(names[c.resourceId] ?? c.fileName)
      if (candidates.length === 1) toastError(e, `Couldn’t update ${names[c.resourceId] ?? c.fileName}`)
    }
  }
  void queryClient.invalidateQueries({ queryKey: marketKeys.updates(instanceId, kind) })
  if (failed.length === 0) toast({ kind: 'success', title: done === 1 ? `Updated ${names[candidates[0]?.resourceId ?? ''] ?? '1 file'}` : `Updated ${done} files` })
  else if (candidates.length > 1) toast({ kind: done ? 'warning' : 'error', title: done ? `Updated ${done}, ${failed.length} failed` : 'Couldn’t install the updates', message: failed.slice(0, 3).join(', ') + (failed.length > 3 ? '…' : '') })
}

/* ------------------------------------------------------------------------------------------ */
/* Favourites                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface Favourite {
  key: string
  platform: MarketPlatform
  id: string
  title: string
  author: string
  summary: string
  iconUrl: string | null
  projectType: MarketProjectType | null
}

/**
 * Local Favourites. The services contract has no favourites (Modrinth collections are deferred,
 * DECISIONS.md), so they live in this window's storage and stay browsable offline.
 */
export const useFavourites = create<{ items: Record<string, Favourite>; toggle: (f: Favourite) => void }>()(
  persist(
    (set) => ({
      items: {},
      toggle: (f) =>
        set((s) => {
          const next = { ...s.items }
          if (next[f.key]) delete next[f.key]
          else next[f.key] = f
          return { items: next }
        }),
    }),
    { name: 'amethyst:favourites', version: 2, migrate: () => ({ items: {} }) },
  ),
)
