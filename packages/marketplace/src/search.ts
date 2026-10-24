/**
 * Combined Modrinth + CurseForge search (marketplace spec §4.2 and §4.3).
 *
 * {@link searchMarketplace} translates one set of {@link MarketSearchFilters} into each
 * platform's parameters, queries the enabled platforms in parallel, and merges the pages with
 * {@link mergeSearchResults}. Each platform is paged independently through a
 * {@link MarketSearchCursor}; a platform stops being queried once it is exhausted (CurseForge
 * at its 10 000 result window). A failing platform does not hide the other's results: its
 * error is returned in `errors` and its cursor is left where it was so "load more" retries it.
 *
 * Merging interleaves the two lists (Modrinth #1, CurseForge #1, Modrinth #2, ...), or
 * merge-sorts by title when sorting by name. A Modrinth hit and a CurseForge hit are the same
 * project when their slugs match case-insensitively **and** their normalised titles match, or
 * when the caller links them (e.g. a local file attributed to both). Duplicates are shown once,
 * using the preferred platform's data, with the other attached as `linked`.
 */

import {
  capCurseForgeTotal,
  CURSEFORGE_RESULT_WINDOW,
  CurseForgeSortField,
  type CurseForgeClient,
  type CurseForgeSearchParams,
} from './curseforge'
import type { MarketSource } from './errors'
import type { RequestOptions } from './http'
import {
  curseForgeClassForProjectType,
  curseForgeLoaderType,
  curseForgeModToProject,
  expandLoaders,
  modrinthHitToProject,
  type MarketProject,
  type MarketProjectType,
} from './model'
import { modrinthProjectType, type ModrinthClient, type ModrinthSearchParams, type ModrinthSortIndex } from './modrinth'
import type { CurseForgeModLoaderTypeId } from './curseforge'

export type MarketSort = 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest' | 'name'

export interface MarketSearchFilters {
  query?: string
  projectType: MarketProjectType
  /** Minecraft version, e.g. the instance's. */
  gameVersion?: string
  /** The instance loader (`fabric`, `quilt`, `forge`, `neoforge`), or a shader loader for Modrinth shaders. Expanded with `expandLoaders`. */
  loader?: string
  /** Modrinth category names (one OR group). Categories apply only to their own platform. */
  modrinthCategories?: string[]
  /** CurseForge category ids (up to 10). */
  curseforgeCategoryIds?: number[]
  /** Modrinth only. */
  environment?: 'client' | 'server'
  /** Default: `relevance` with a query, `downloads` without. */
  sort?: MarketSort
  /** 20, 50 or 100 (default 20). CurseForge is clamped to 50. */
  pageSize?: number
}

export interface MarketSearchCursor {
  modrinth: { offset: number; total: number; done: boolean }
  curseforge: { index: number; total: number; done: boolean }
}

export interface MarketSearchPage {
  items: MarketProject[]
  /** Modrinth total plus CurseForge total capped at 10 000. */
  total: number
  /** Pass back to fetch the next page. */
  cursor: MarketSearchCursor
  hasMore: boolean
  /** Per-platform failures (the other platform's results are still returned). */
  errors: Partial<Record<MarketSource, unknown>>
}

export interface MarketSearchClients {
  /** Omit to disable Modrinth. */
  modrinth?: ModrinthClient
  /** Omit (or pass an unavailable client) to disable CurseForge. */
  curseforge?: CurseForgeClient
}

export interface MergeOptions {
  sort?: MarketSort
  /** Platform whose data is shown for merged duplicates (default `modrinth`). */
  prefer?: MarketSource
  /** Known `[modrinthProjectId, curseforgeModId]` pairs, e.g. from local attribution. */
  links?: Iterable<readonly [string, string]>
}

/** An initial cursor (both platforms at offset 0). */
export function initialCursor(): MarketSearchCursor {
  return { modrinth: { offset: 0, total: 0, done: false }, curseforge: { index: 0, total: 0, done: false } }
}

function effectiveSort(filters: MarketSearchFilters): MarketSort {
  return filters.sort ?? (filters.query?.trim() ? 'relevance' : 'downloads')
}

const MODRINTH_INDEX: Record<MarketSort, ModrinthSortIndex> = {
  relevance: 'relevance',
  downloads: 'downloads',
  follows: 'follows',
  updated: 'updated',
  newest: 'newest',
  name: 'relevance', // Modrinth cannot sort by name; the merge sorts by title.
}

/** CurseForge has no pure relevance sort; Popularity stands in (spec §4.3). */
const CURSEFORGE_SORT: Record<MarketSort, { field: number; order: 'asc' | 'desc' }> = {
  relevance: { field: CurseForgeSortField.Popularity, order: 'desc' },
  downloads: { field: CurseForgeSortField.TotalDownloads, order: 'desc' },
  follows: { field: CurseForgeSortField.Popularity, order: 'desc' },
  updated: { field: CurseForgeSortField.LastUpdated, order: 'desc' },
  newest: { field: CurseForgeSortField.ReleasedDate, order: 'desc' },
  name: { field: CurseForgeSortField.Name, order: 'asc' },
}

const LOADER_TYPES = new Set<MarketProjectType>(['mod', 'modpack'])

/** Translates unified filters into Modrinth search parameters, or `null` if Modrinth lacks the type. */
export function toModrinthSearch(filters: MarketSearchFilters, offset = 0): ModrinthSearchParams | null {
  if (!modrinthProjectType(filters.projectType)) return null
  const useLoader = filters.loader && (LOADER_TYPES.has(filters.projectType) || filters.projectType === 'shader')
  return {
    query: filters.query,
    projectType: filters.projectType,
    gameVersions: filters.gameVersion ? [filters.gameVersion] : undefined,
    loaders: useLoader && filters.loader ? expandLoaders(filters.loader, filters.gameVersion) : undefined,
    categories: filters.modrinthCategories,
    environment: filters.environment,
    index: MODRINTH_INDEX[effectiveSort(filters)],
    offset,
    limit: Math.min(100, filters.pageSize ?? 20),
  }
}

/** Translates unified filters into CurseForge search parameters. */
export function toCurseForgeSearch(filters: MarketSearchFilters, index = 0): CurseForgeSearchParams {
  const sort = CURSEFORGE_SORT[effectiveSort(filters)]
  let loaderTypes: CurseForgeModLoaderTypeId[] | undefined
  if (filters.loader && LOADER_TYPES.has(filters.projectType)) {
    loaderTypes = expandLoaders(filters.loader, filters.gameVersion)
      .map(curseForgeLoaderType)
      .filter((t): t is CurseForgeModLoaderTypeId => t !== undefined)
  }
  return {
    classId: curseForgeClassForProjectType(filters.projectType),
    categoryIds: filters.curseforgeCategoryIds?.length ? filters.curseforgeCategoryIds : undefined,
    gameVersion: filters.gameVersion,
    searchFilter: filters.query,
    sortField: sort.field,
    sortOrder: sort.order,
    modLoaderType: loaderTypes?.length === 1 ? loaderTypes[0] : undefined,
    modLoaderTypes: loaderTypes && loaderTypes.length > 1 ? loaderTypes : undefined,
    index,
    pageSize: Math.min(50, filters.pageSize ?? 20),
  }
}

/** Lower-case, accent-free, alphanumerics only: `"Sodium!"` and `"sodium"` compare equal. */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** True when a Modrinth and a CurseForge entry are confidently the same project. */
export function isSameProject(
  modrinth: MarketProject,
  curseforge: MarketProject,
  links?: ReadonlySet<string>,
): boolean {
  if (links?.has(`${modrinth.id}|${curseforge.id}`)) return true
  const ta = normaliseTitle(modrinth.title)
  return (
    modrinth.slug.toLowerCase() === curseforge.slug.toLowerCase() && ta !== '' && ta === normaliseTitle(curseforge.title)
  )
}

/** Merges one page from each platform (see the module comment for the rules). */
export function mergeSearchResults(
  modrinth: MarketProject[],
  curseforge: MarketProject[],
  options: MergeOptions = {},
): MarketProject[] {
  const prefer = options.prefer ?? 'modrinth'
  const links = new Set<string>()
  for (const [mr, cf] of options.links ?? []) links.add(`${mr}|${cf}`)

  const absorbed = new Set<MarketProject>()
  const mrEntries = modrinth.map((mr) => {
    const twin = curseforge.find((cf) => !absorbed.has(cf) && isSameProject(mr, cf, links))
    if (!twin) return mr
    absorbed.add(twin)
    return prefer === 'modrinth' ? { ...mr, linked: twin } : { ...twin, linked: mr }
  })
  const cfEntries = curseforge.filter((cf) => !absorbed.has(cf))

  if (options.sort === 'name') {
    return [...mrEntries, ...cfEntries].toSorted((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  }
  const out: MarketProject[] = []
  for (let i = 0; i < Math.max(mrEntries.length, cfEntries.length); i++) {
    const a = mrEntries[i]
    const b = cfEntries[i]
    if (a) out.push(a)
    if (b) out.push(b)
  }
  return out
}

/** The combined total shown to the user: CurseForge is capped at its 10 000 result window. */
export function combinedTotal(modrinthTotal: number, curseforgeTotal: number): number {
  return modrinthTotal + capCurseForgeTotal(curseforgeTotal)
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (e instanceof Error && e.name === 'AbortError')
}

/**
 * Searches every enabled platform in parallel and returns one merged page. Pass the returned
 * `cursor` to load the next page. Cancellation rejects; other per-platform failures are
 * reported in `errors`.
 */
export async function searchMarketplace(
  clients: MarketSearchClients,
  filters: MarketSearchFilters,
  cursor: MarketSearchCursor = initialCursor(),
  opts: RequestOptions & Omit<MergeOptions, 'sort'> = {},
): Promise<MarketSearchPage> {
  const next: MarketSearchCursor = { modrinth: { ...cursor.modrinth }, curseforge: { ...cursor.curseforge } }
  const errors: MarketSearchPage['errors'] = {}
  const request = { signal: opts.signal, fresh: opts.fresh }

  const mrParams = clients.modrinth ? toModrinthSearch(filters, cursor.modrinth.offset) : null
  if (!mrParams) next.modrinth.done = true
  const cfEnabled = clients.curseforge?.isAvailable() === true
  if (!cfEnabled) next.curseforge.done = true

  const [mr, cf] = await Promise.allSettled([
    mrParams && !cursor.modrinth.done && clients.modrinth ? clients.modrinth.search(mrParams, request) : undefined,
    cfEnabled && !cursor.curseforge.done && clients.curseforge
      ? clients.curseforge.searchMods(toCurseForgeSearch(filters, cursor.curseforge.index), request)
      : undefined,
  ])

  let mrItems: MarketProject[] = []
  if (mr.status === 'fulfilled' && mr.value) {
    const r = mr.value
    mrItems = r.hits.map(modrinthHitToProject)
    next.modrinth.offset = cursor.modrinth.offset + r.hits.length
    next.modrinth.total = r.total_hits
    next.modrinth.done = r.hits.length === 0 || next.modrinth.offset >= r.total_hits
  } else if (mr.status === 'rejected') {
    if (isAbort(mr.reason, opts.signal)) throw mr.reason
    errors.modrinth = mr.reason
  }

  let cfItems: MarketProject[] = []
  if (cf.status === 'fulfilled' && cf.value) {
    const r = cf.value
    cfItems = r.data.map(curseForgeModToProject)
    const reachable = capCurseForgeTotal(r.pagination.totalCount)
    next.curseforge.index = cursor.curseforge.index + r.data.length
    next.curseforge.total = reachable
    next.curseforge.done =
      r.data.length === 0 || next.curseforge.index >= reachable || next.curseforge.index >= CURSEFORGE_RESULT_WINDOW
  } else if (cf.status === 'rejected') {
    if (isAbort(cf.reason, opts.signal)) throw cf.reason
    errors.curseforge = cf.reason
  }

  return {
    items: mergeSearchResults(mrItems, cfItems, { sort: effectiveSort(filters), prefer: opts.prefer, links: opts.links }),
    total: next.modrinth.total + next.curseforge.total,
    cursor: next,
    hasMore: !next.modrinth.done || !next.curseforge.done,
    errors,
  }
}
