import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { Events } from '@shared/events'
import type { BackupRow, ResourceKind, ResourcePage, ResourceQuery, ResourceRow } from '@shared/services'
import { api, subscribe } from '@/lib/rpc'
import { reportBulk, toastError } from '@/lib/error-messages'
import { revealInFinder } from '@/lib/files'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'

/*
 * Instance content (mods, resource packs, shader packs, worlds) over `api.resources`.
 *
 * Lists are paged (PAGE rows per query) and only the pages a table scrolls to are fetched.
 * `resources:changed` is applied incrementally, at most once per frame: rows that changed in
 * place refetch only the pages that hold them; additions, removals and rows whose sort or filter
 * keys moved refetch the loaded pages of the affected list; `reset` refetches everything.
 */

export const PAGE = 100

export type ListQuery = Omit<ResourceQuery, 'offset' | 'limit'>

export const resourceKeys = {
  instance: (instanceId: string) => ['res', instanceId] as const,
  kind: (instanceId: string, kind: ResourceKind) => ['res', instanceId, kind] as const,
  pages: (instanceId: string, kind: ResourceKind) => ['res', instanceId, kind, 'page'] as const,
  page: (instanceId: string, kind: ResourceKind, q: string, page: number) => ['res', instanceId, kind, 'page', q, page] as const,
  all: (instanceId: string, kind: ResourceKind, q: string) => ['res', instanceId, kind, 'all', q] as const,
  detail: (instanceId: string, kind: ResourceKind, id: string) => ['res', instanceId, kind, 'detail', id] as const,
  analysis: (instanceId: string) => ['res', instanceId, 'mods', 'analysis'] as const,
  backups: (instanceId: string, worldId?: string) => ['res', instanceId, 'saves', 'backups', worldId ?? '*'] as const,
  /** Content counts; without `modded`, the prefix covering both variants (for invalidation). */
  counts: (instanceId: string, modded?: boolean) => (modded === undefined ? (['res', instanceId, 'counts'] as const) : (['res', instanceId, 'counts', modded] as const)),
}

/** Stable serialisation of a list query (the cache key part). */
export function queryHash(q: ListQuery): string {
  const clean: Record<string, unknown> = {}
  for (const k of Object.keys(q).toSorted()) {
    const v = (q as Record<string, unknown>)[k]
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0 && k !== 'ids')) clean[k] = v
  }
  return JSON.stringify(clean)
}

/** Singular/plural nouns per folder. */
export const KIND_NOUN: Record<ResourceKind, [string, string]> = {
  mods: ['mod', 'mods'],
  resourcepacks: ['resource pack', 'resource packs'],
  shaderpacks: ['shader pack', 'shader packs'],
  saves: ['world', 'worlds'],
}
export const noun = (kind: ResourceKind, n: number) => (n === 1 ? `1 ${KIND_NOUN[kind][0]}` : `${n} ${KIND_NOUN[kind][1]}`)

/* ------------------------------------------------------------------------------------------ */
/* Scan state and change events                                                               */
/* ------------------------------------------------------------------------------------------ */

const useScanState = create<{ scanning: Record<string, boolean> }>(() => ({ scanning: {} }))

export function useScanning(instanceId: string, kind: ResourceKind): boolean {
  return useScanState((s) => s.scanning[`${instanceId}\u0000${kind}`] ?? false)
}

/** Fields that decide a row's position or membership in a sorted, filtered list. */
const positionKey = (r: ResourceRow) => JSON.stringify([r.name, r.fileName, r.mtimeMs, r.size, r.enabled, r.source?.platform ?? null, r.authors, r.pending])

let queue: Events['resources:changed'][] = []
let scheduled = false

function schedule(): void {
  if (scheduled) return
  scheduled = true
  const run = () => {
    scheduled = false
    const batch = queue
    queue = []
    for (const ev of batch) void applyChange(ev)
  }
  if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

/** Merge events of the same folder (one frame may carry several). */
function enqueue(ev: Events['resources:changed']): void {
  const same = queue.find((q) => q.instanceId === ev.instanceId && q.kind === ev.kind)
  if (same) {
    same.reset ||= ev.reset
    same.revision = Math.max(same.revision, ev.revision)
    same.changed = [...new Set([...same.changed, ...ev.changed])]
    same.removed = [...new Set([...same.removed, ...ev.removed])]
  } else queue.push({ ...ev, changed: [...ev.changed], removed: [...ev.removed] })
  schedule()
}

async function applyChange(ev: Events['resources:changed']): Promise<void> {
  const { instanceId, kind } = ev
  // Small whole-list queries and problem analysis are cheap: refetch them.
  void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, kind), 'all'] })
  void queryClient.invalidateQueries({ queryKey: resourceKeys.counts(instanceId) })
  if (kind === 'mods') void queryClient.invalidateQueries({ queryKey: resourceKeys.analysis(instanceId) })
  for (const id of [...ev.changed, ...ev.removed]) void queryClient.invalidateQueries({ queryKey: resourceKeys.detail(instanceId, kind, id) })
  if (kind === 'saves') void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, 'saves'), 'backups'] })

  const pages = queryClient.getQueriesData<ResourcePage>({ queryKey: resourceKeys.pages(instanceId, kind) })
  if (ev.reset || ev.removed.length > 0) {
    await queryClient.invalidateQueries({ queryKey: resourceKeys.pages(instanceId, kind) })
    return
  }
  // Group cached pages by list (query hash).
  const lists = new Map<string, { key: readonly unknown[]; page: ResourcePage | undefined }[]>()
  for (const [key, page] of pages) {
    const q = String(key[4])
    lists.set(q, [...(lists.get(q) ?? []), { key, page }])
  }
  const changed = new Set(ev.changed)
  await Promise.all(
    [...lists].map(async ([q, list]) => {
      const before = new Map<string, string>()
      const holding: (readonly unknown[])[] = []
      for (const { key, page } of list) {
        let holds = false
        for (const r of page?.items ?? []) {
          if (!changed.has(r.id)) continue
          before.set(r.id, positionKey(r))
          holds = true
        }
        if (holds) holding.push(key)
      }
      const listKey = [...resourceKeys.pages(instanceId, kind), q]
      // A changed row that no loaded page holds is new (or newly matches): positions shift.
      const loadedAll = list.every(({ page }) => page !== undefined)
      if (before.size < changed.size && loadedAll) {
        await queryClient.invalidateQueries({ queryKey: listKey })
        return
      }
      await Promise.all(holding.map((key) => queryClient.invalidateQueries({ queryKey: key, exact: true })))
      // The row's sort or filter fields moved: the other loaded pages of this list shift too.
      for (const key of holding) {
        const page = queryClient.getQueryData<ResourcePage>(key)
        for (const r of page?.items ?? []) {
          if (before.has(r.id) && before.get(r.id) !== positionKey(r)) {
            await queryClient.invalidateQueries({ queryKey: listKey })
            return
          }
        }
      }
    }),
  )
}

let installed = false
export function installResourceEvents(): void {
  if (installed) return
  installed = true
  subscribe('resources:changed', enqueue)
  subscribe('resources:scan', ({ instanceId, kind, scanning }) => {
    useScanState.setState((s) => ({ scanning: { ...s.scanning, [`${instanceId}\u0000${kind}`]: scanning } }))
  })
  subscribe('runtime:restarted', () => void queryClient.invalidateQueries({ queryKey: ['res'] }))
  subscribe('resources:trash-failed', ({ restored, kept, message }) => {
    const n = restored.length + kept.length
    toast({
      kind: 'warning',
      title: `Couldn’t move ${n === 1 ? 'a deleted file' : `${n} deleted files`} to the Trash`,
      message: restored.length > 0 ? `${restored.join(', ')} ${restored.length === 1 ? 'was' : 'were'} put back. ${message}` : `Nothing was erased; Amethyst will try again next time. ${message}`,
    })
  })
}
installResourceEvents()

/* ------------------------------------------------------------------------------------------ */
/* Reads                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Keep an instance's folders live while a content tab shows it (reference-counted in the runtime). */
export function useWatchInstance(instanceId: string): void {
  useEffect(() => {
    if (!instanceId) return
    api.resources.watch(instanceId).catch(() => undefined)
    return () => void api.resources.unwatch(instanceId).catch(() => undefined)
  }, [instanceId])
}

export interface PagedList {
  /** One slot per matching row; `undefined` until its page has loaded. */
  rows: (ResourceRow | undefined)[]
  total: number
  isPending: boolean
  isError: boolean
  error: unknown
  /** A background scan of the folder is running. */
  scanning: boolean
  /** Make sure the page holding `index` is loaded (call it for rows scrolled into view). */
  request: (index: number) => void
  refetch: () => void
}

/** A virtualised, paged content list. */
export function usePagedResources(instanceId: string, kind: ResourceKind, query: ListQuery): PagedList {
  const q = queryHash(query)
  const [wanted, setWanted] = useState<{ q: string; pages: number[] }>({ q, pages: [0] })
  const pages = wanted.q === q ? wanted.pages : [0]
  const results = useQueries({
    queries: pages.map((n) => ({
      queryKey: resourceKeys.page(instanceId, kind, q, n),
      queryFn: () => api.resources.list(instanceId, kind, { ...query, offset: n * PAGE, limit: PAGE }),
      enabled: !!instanceId,
      // Typing in the search field keeps the previous rows until the new ones arrive.
      placeholderData: (prev: ResourcePage | undefined) => prev,
    })),
  })
  const first = results[0]
  const scanning = useScanning(instanceId, kind)
  const total = first?.data?.total ?? 0
  const rows = useMemo(() => {
    const out: (ResourceRow | undefined)[] = Array.from({ length: total })
    results.forEach((r, i) => {
      const n = pages[i] ?? 0
      r.data?.items.forEach((row, j) => {
        if (n * PAGE + j < total) out[n * PAGE + j] = row
      })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when any page's data changes
  }, [total, ...results.map((r) => r.data)])
  const request = useCallback(
    (index: number) => {
      const n = Math.floor(index / PAGE)
      setWanted((w) => {
        const cur = w.q === q ? w.pages : [0]
        return cur.includes(n) ? (w.q === q ? w : { q, pages: cur }) : { q, pages: [...cur, n] }
      })
    },
    [q],
  )
  return {
    rows,
    total,
    isPending: first?.isPending ?? true,
    isError: results.some((r) => r.isError),
    error: results.find((r) => r.isError)?.error,
    scanning: scanning || (first?.data?.scanning ?? false),
    request,
    refetch: () => void queryClient.invalidateQueries({ queryKey: resourceKeys.pages(instanceId, kind) }),
  }
}

/** Every row of a small list (enabled resource packs, the worlds menu, pickers), up to 1000. */
export function useResourceAll(instanceId: string, kind: ResourceKind, query: ListQuery = {}, enabled = true) {
  const q = queryHash(query)
  return useQuery({
    queryKey: resourceKeys.all(instanceId, kind, q),
    queryFn: async () => (await api.resources.list(instanceId, kind, { ...query, limit: 1000 })).items,
    enabled: enabled && !!instanceId,
  })
}

/**
 * Every mod of an instance, for the Change Version consequences (B4.6). `update` is unknown
 * until a version-specific check runs, so it is never set here.
 */
export function useMods(instanceId: string) {
  return useQuery({
    queryKey: resourceKeys.all(instanceId, 'mods', queryHash({})),
    queryFn: async () => (await api.resources.list(instanceId, 'mods', { limit: 1000 })).items,
    select: (rows): (ResourceRow & { update?: { version: string } })[] => rows,
    enabled: !!instanceId,
  })
}

/**
 * Row totals of the content folders (one small `resources.list` page each): the Overview summary
 * and the instance tab counts. Refreshed whenever a folder changes.
 */
export function useContentCounts(id: string, modded: boolean) {
  return useQuery({
    // Keyed on `modded` too: after Change Version (Vanilla → Fabric) the mod counts are fetched anew.
    queryKey: resourceKeys.counts(id, modded),
    staleTime: 30_000,
    enabled: !!id,
    queryFn: async () => {
      const total = (kind: ResourceKind, enabled?: boolean) =>
        api.resources
          .list(id, kind, { limit: 1, ...(enabled === undefined ? {} : { enabled }) })
          .then((p) => p.total)
          .catch(() => undefined)
      const [mods, modsEnabled, resourcePacks, shaders, worlds] = await Promise.all([
        modded ? total('mods') : undefined,
        modded ? total('mods', true) : undefined,
        total('resourcepacks'),
        total('shaderpacks'),
        total('saves'),
      ])
      return { mods, modsEnabled, resourcePacks, shaders, worlds }
    },
  })
}

/** Worlds of an instance (for "Launch into World"). */
export function useWorlds(instanceId: string) {
  return useResourceAll(instanceId, 'saves')
}

export function useResourceDetail(instanceId: string, kind: ResourceKind, id: string | undefined) {
  return useQuery({
    queryKey: resourceKeys.detail(instanceId, kind, id ?? ''),
    queryFn: () => api.resources.get(instanceId, kind, id ?? ''),
    enabled: !!id && !!instanceId,
  })
}

export function useModAnalysis(instanceId: string, enabled = true) {
  return useQuery({ queryKey: resourceKeys.analysis(instanceId), queryFn: () => api.resources.analyze(instanceId), enabled: enabled && !!instanceId })
}

export function useBackups(instanceId: string, worldId: string | undefined) {
  return useQuery({
    queryKey: resourceKeys.backups(instanceId, worldId),
    queryFn: () => api.resources.listBackups(instanceId, worldId),
    enabled: !!instanceId && !!worldId,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Mutations                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Patch cached rows right away (the change event confirms or corrects it). */
function patchRows(instanceId: string, kind: ResourceKind, ids: string[], patch: Partial<ResourceRow>): void {
  const set = new Set(ids)
  for (const [key, page] of queryClient.getQueriesData<ResourcePage>({ queryKey: resourceKeys.pages(instanceId, kind) })) {
    if (!page?.items.some((r) => set.has(r.id))) continue
    queryClient.setQueryData<ResourcePage>(key, { ...page, items: page.items.map((r) => (set.has(r.id) ? { ...r, ...patch } : r)) })
  }
}

export async function setResourcesEnabled(instanceId: string, kind: ResourceKind, ids: string[], enabled: boolean): Promise<boolean> {
  if (ids.length === 0) return true
  if (kind !== 'shaderpacks') patchRows(instanceId, kind, ids, { enabled })
  try {
    const result = await api.resources.setEnabled(instanceId, kind, ids, enabled)
    // Success shows in the list itself; only failures need words.
    if (result.failed.length) {
      reportBulk(result, { done: (n) => `${enabled ? 'Enabled' : 'Disabled'} ${noun(kind, n)}`, failed: `Couldn’t ${enabled ? 'enable' : 'disable'} ${ids.length === 1 ? 'it' : 'them'}` })
      void queryClient.invalidateQueries({ queryKey: resourceKeys.pages(instanceId, kind) })
    }
    return result.failed.length === 0
  } catch (e) {
    void queryClient.invalidateQueries({ queryKey: resourceKeys.pages(instanceId, kind) })
    if ((e as { code?: string }).code === 'ENO_SHADER_LOADER') throw e
    toastError(e, `Couldn’t ${enabled ? 'enable' : 'disable'} ${ids.length === 1 ? KIND_NOUN[kind][0] : KIND_NOUN[kind][1]}`)
    return false
  }
}

/** Move rows to the Trash with an Undo toast. `label` names a single row ("Sodium"). */
export async function trashResources(instanceId: string, kind: ResourceKind, ids: string[], label?: string): Promise<void> {
  if (ids.length === 0) return
  try {
    const result = await api.resources.delete(instanceId, kind, ids, { undoable: true })
    const what = result.done.length === 1 && label ? `“${label}”` : noun(kind, result.done.length)
    if (result.failed.length > 0) {
      reportBulk(result, { done: (n) => `Moved ${noun(kind, n)} to the Trash`, failed: 'Couldn’t move to the Trash' })
    }
    if (result.done.length === 0) return
    const token = result.undoToken
    toast({
      kind: 'success',
      title: `Moved ${what} to the Trash`,
      duration: 10_000,
      actions: token
        ? [
            {
              label: 'Undo',
              onClick: () => {
                api.resources
                  .undoDelete(instanceId, token)
                  .then((r) => reportBulk(r, { done: (n) => `Restored ${n === 1 && label ? `“${label}”` : noun(kind, n)}`, failed: 'Couldn’t restore the files' }))
                  .catch((e: unknown) => toastError(e, 'Couldn’t undo'))
              },
            },
          ]
        : [],
    })
  } catch (e) {
    toastError(e, 'Couldn’t move to the Trash')
  }
}

export async function addResourceFiles(instanceId: string, kind: ResourceKind, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  try {
    const result = await api.resources.add(instanceId, kind, paths)
    reportBulk(result, { done: (n) => `Added ${noun(kind, n)}`, failed: `Couldn’t add ${paths.length === 1 ? 'the file' : 'the files'}` })
    return result.done
  } catch (e) {
    toastError(e, `Couldn’t add ${KIND_NOUN[kind][1]}`)
    return []
  }
}

export async function addFromInstance(instanceId: string, kind: ResourceKind, fromInstanceId: string, ids: string[]): Promise<void> {
  try {
    const result = await api.resources.addFromInstance(instanceId, kind, fromInstanceId, ids)
    reportBulk(result, { done: (n) => `Added ${noun(kind, n)}`, failed: `Couldn’t add the ${KIND_NOUN[kind][1]}` })
  } catch (e) {
    toastError(e, `Couldn’t add the ${KIND_NOUN[kind][1]}`)
  }
}

export async function setPackOrder(instanceId: string, ids: string[]): Promise<void> {
  // Optimistic: the enabled list re-sorts immediately.
  const pos = new Map(ids.map((id, i) => [id, i]))
  for (const [key, rows] of queryClient.getQueriesData<ResourceRow[]>({ queryKey: [...resourceKeys.kind(instanceId, 'resourcepacks'), 'all'] })) {
    if (rows) queryClient.setQueryData<ResourceRow[]>(key, rows.map((r) => (pos.has(r.id) ? { ...r, enabled: true, order: pos.get(r.id) } : r)))
  }
  try {
    await api.resources.setPackOrder(instanceId, ids)
  } catch (e) {
    void queryClient.invalidateQueries({ queryKey: resourceKeys.kind(instanceId, 'resourcepacks') })
    toastError(e, 'Couldn’t change the load order')
  }
}

export async function createBackup(instanceId: string, worldId: string, name: string): Promise<BackupRow | undefined> {
  try {
    const backup = await api.resources.createBackup(instanceId, worldId)
    void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, 'saves'), 'backups'] })
    toast({ kind: 'success', title: `Backed up “${name}”` })
    return backup
  } catch (e) {
    toastError(e, `Couldn’t back up “${name}”`)
    return undefined
  }
}

export async function restoreBackup(instanceId: string, backup: BackupRow, mode: 'copy' | 'replace'): Promise<string | undefined> {
  try {
    const { worldId } = await api.resources.restoreBackup(instanceId, backup.id, mode)
    void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, 'saves'), 'backups'] })
    toast({ kind: 'success', title: mode === 'copy' ? `Restored “${backup.worldName}” as a copy` : `Restored “${backup.worldName}”`, message: mode === 'replace' ? 'The previous version is in the Trash.' : undefined })
    return worldId
  } catch (e) {
    toastError(e, 'Couldn’t restore the backup')
    return undefined
  }
}

export async function deleteBackup(instanceId: string, backup: BackupRow): Promise<void> {
  try {
    await api.resources.deleteBackup(instanceId, backup.id)
    void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, 'saves'), 'backups'] })
    toast({ kind: 'success', title: 'Deleted the backup' })
  } catch (e) {
    toastError(e, 'Couldn’t delete the backup')
  }
}

export async function pruneBackups(instanceId: string): Promise<void> {
  try {
    const removed = await api.resources.pruneBackups(instanceId)
    void queryClient.invalidateQueries({ queryKey: [...resourceKeys.kind(instanceId, 'saves'), 'backups'] })
    toast({ kind: 'success', title: removed.length ? `Deleted ${removed.length} old automatic backup${removed.length === 1 ? '' : 's'}` : 'No old automatic backups to clean up' })
  } catch (e) {
    toastError(e, 'Couldn’t clean up backups')
  }
}

export async function exportWorld(instanceId: string, worldId: string, name: string, output: string): Promise<void> {
  try {
    const result = await api.resources.exportWorld(instanceId, worldId, output)
    toast({ kind: 'success', title: `Exported “${name}”`, actions: [{ label: 'Show in Finder', onClick: () => revealInFinder(result.path) }] })
  } catch (e) {
    toastError(e, `Couldn’t export “${name}”`)
  }
}
