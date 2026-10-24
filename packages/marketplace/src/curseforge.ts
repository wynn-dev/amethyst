/**
 * CurseForge API v1 client (https://docs.curseforge.com/rest-api/), Minecraft only (gameId 432).
 *
 * The API key is supplied by the caller (main process only; never the renderer). It is
 * optional: without a key {@link CurseForgeClient.isAvailable} is false and every call rejects
 * with `ECF_NO_KEY`, so builds without a key degrade instead of sending keyless requests.
 * The first 403 means the key was rejected: the client disables itself for the session and
 * every later call rejects with `ECF_FORBIDDEN`.
 *
 * Distribution-restricted files come back with `downloadUrl: null`. This client never
 * constructs CDN URLs for them; the unified model marks them `manualDownloadRequired` and
 * links to the file's CurseForge page instead.
 *
 * Search and file listing respect CurseForge's 10 000 result window (`index + pageSize`
 * must not exceed 10 000) and the 50 per page maximum. Only parameters with values are
 * sent.
 */

import { CACHE_TTL, MemoryCache, type MarketCache } from './cache'
import { MarketplaceError, isMarketplaceError } from './errors'
import { Transport, type FetchLike, type Query, type RequestOptions } from './http'
import { RateLimiter } from './rate-limit'
import { arrayOf, cfData, record, withId } from './validate'

export const CURSEFORGE_API = 'https://api.curseforge.com'
export const MINECRAFT_GAME_ID = 432
/** CurseForge never returns results past this offset. */
export const CURSEFORGE_RESULT_WINDOW = 10_000
export const CURSEFORGE_MAX_PAGE_SIZE = 50

/** Top-level content classes for Minecraft. */
export const CurseForgeClass = {
  Mods: 6,
  ResourcePacks: 12,
  Worlds: 17,
  Modpacks: 4471,
  Shaders: 6552,
  DataPacks: 6945,
  Customization: 4546,
  BukkitPlugins: 5,
} as const

export const CurseForgeModLoaderType = {
  Any: 0,
  Forge: 1,
  Cauldron: 2,
  LiteLoader: 3,
  Fabric: 4,
  Quilt: 5,
  NeoForge: 6,
} as const
export type CurseForgeModLoaderTypeId = (typeof CurseForgeModLoaderType)[keyof typeof CurseForgeModLoaderType]

export const CurseForgeSortField = {
  Featured: 1,
  Popularity: 2,
  LastUpdated: 3,
  Name: 4,
  Author: 5,
  TotalDownloads: 6,
  Category: 7,
  GameVersion: 8,
  EarlyAccess: 9,
  FeaturedReleased: 10,
  ReleasedDate: 11,
  Rating: 12,
} as const

/** 1 Release, 2 Beta, 3 Alpha. */
export type CurseForgeReleaseType = 1 | 2 | 3

/** 1 EmbeddedLibrary, 2 Optional, 3 Required, 4 Tool, 5 Incompatible, 6 Include. */
export type CurseForgeRelationType = 1 | 2 | 3 | 4 | 5 | 6

// ---------------------------------------------------------------------------------------------
// API shapes (subset used by the launcher)
// ---------------------------------------------------------------------------------------------

export interface CurseForgePagination {
  index: number
  pageSize: number
  resultCount: number
  totalCount: number
}

export interface CurseForgePage<T> {
  data: T[]
  pagination: CurseForgePagination
}

export interface CurseForgeFileIndex {
  gameVersion: string
  fileId: number
  filename: string
  releaseType: CurseForgeReleaseType
  gameVersionTypeId?: number | null
  modLoader?: number | null
}

export interface CurseForgeMod {
  id: number
  gameId: number
  name: string
  slug: string
  links?: { websiteUrl?: string | null; wikiUrl?: string | null; issuesUrl?: string | null; sourceUrl?: string | null }
  summary: string
  status: number
  downloadCount: number
  thumbsUpCount?: number
  isFeatured?: boolean
  primaryCategoryId?: number
  classId?: number | null
  categories: { id: number; name: string; slug?: string; iconUrl?: string; classId?: number }[]
  authors: { id: number; name: string; url?: string }[]
  logo?: { thumbnailUrl?: string; url?: string } | null
  screenshots?: { title?: string; description?: string; thumbnailUrl?: string; url: string }[]
  mainFileId?: number
  latestFiles?: CurseForgeFile[]
  latestFilesIndexes?: CurseForgeFileIndex[]
  dateCreated: string
  dateModified: string
  dateReleased?: string
  allowModDistribution?: boolean | null
  isAvailable?: boolean
}

export interface CurseForgeFile {
  id: number
  gameId?: number
  modId: number
  isAvailable: boolean
  displayName: string
  fileName: string
  releaseType: CurseForgeReleaseType
  fileStatus: number
  hashes: { value: string; algo: 1 | 2 }[]
  fileDate: string
  fileLength: number
  downloadCount?: number
  /** `null` when the author blocks third-party downloads. */
  downloadUrl: string | null
  gameVersions: string[]
  sortableGameVersions?: { gameVersionName: string; gameVersion: string; gameVersionTypeId?: number }[]
  dependencies: { modId: number; relationType: CurseForgeRelationType }[]
  fileFingerprint: number
  serverPackFileId?: number | null
}

export interface CurseForgeCategory {
  id: number
  gameId: number
  name: string
  slug: string
  url?: string
  iconUrl?: string
  dateModified?: string
  isClass?: boolean
  classId?: number
  parentCategoryId?: number
  displayIndex?: number
}

export interface CurseForgeFingerprintMatch {
  id: number
  file: CurseForgeFile
  latestFiles: CurseForgeFile[]
}

export interface CurseForgeFingerprintMatches {
  /** `false` while CurseForge's index warms up: "try again later", not "no match". */
  isCacheBuilt: boolean
  exactMatches: CurseForgeFingerprintMatch[]
  exactFingerprints: number[]
  partialMatches: CurseForgeFingerprintMatch[]
  partialMatchFingerprints: Record<string, number[]>
  installedFingerprints: number[]
  unmatchedFingerprints: number[]
}

export interface CurseForgeMinecraftVersion {
  id: number
  gameVersionId: number
  versionString: string
  jarDownloadUrl?: string
  jsonDownloadUrl?: string
  approved: boolean
  dateModified: string
  gameVersionTypeId: number
  gameVersionStatus: number
  gameVersionTypeStatus: number
}

export interface CurseForgeModLoaderIndex {
  name: string
  gameVersion: string
  latest: boolean
  recommended: boolean
  dateModified: string
  type: number
}

// ---------------------------------------------------------------------------------------------
// Request builders and helpers
// ---------------------------------------------------------------------------------------------

export interface CurseForgeSearchParams {
  classId?: number
  categoryId?: number
  /** Up to 10; overrides `categoryId`. */
  categoryIds?: number[]
  gameVersion?: string
  /** Up to 4; overrides `gameVersion`. */
  gameVersions?: string[]
  searchFilter?: string
  sortField?: number
  /** Default `desc`. */
  sortOrder?: 'asc' | 'desc'
  modLoaderType?: CurseForgeModLoaderTypeId
  /** Up to 5; overrides `modLoaderType`. Prefer `modLoaderType` when one loader suffices. */
  modLoaderTypes?: CurseForgeModLoaderTypeId[]
  gameVersionTypeId?: number
  authorId?: number
  primaryAuthorId?: number
  slug?: string
  index?: number
  /** 1 to 50 (default 20). */
  pageSize?: number
}

export interface CurseForgeFilesParams {
  gameVersion?: string
  modLoaderType?: CurseForgeModLoaderTypeId
  gameVersionTypeId?: number
  index?: number
  /** 1 to 50 (default 50). */
  pageSize?: number
}

const LOADER_TYPE_NAMES: Record<number, string> = {
  0: 'Any',
  1: 'Forge',
  2: 'Cauldron',
  3: 'LiteLoader',
  4: 'Fabric',
  5: 'Quilt',
  6: 'NeoForge',
}

/** Clamps paging to the 50-per-page maximum and the 10 000 result window. `null` = past the window. */
export function clampCurseForgePage(index = 0, pageSize = 20): { index: number; pageSize: number } | null {
  const i = Math.max(0, Math.floor(index))
  if (i >= CURSEFORGE_RESULT_WINDOW) return null
  const size = Math.min(CURSEFORGE_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)), CURSEFORGE_RESULT_WINDOW - i)
  return { index: i, pageSize: size }
}

/**
 * Builds `/v1/mods/search` query parameters. List parameters use the bracketed encodings
 * from the API docs: `categoryIds=[1,2]`, `gameVersions=["1.20.1"]`, and
 * `modLoaderTypes=[Forge,Fabric]` (loader names, documented but not JSON).
 */
export function buildCurseForgeSearchQuery(params: CurseForgeSearchParams): Query | null {
  const page = clampCurseForgePage(params.index, params.pageSize)
  if (!page) return null
  const categoryIds = params.categoryIds?.slice(0, 10)
  const gameVersions = params.gameVersions?.slice(0, 4)
  const loaderTypes = params.modLoaderTypes
    ?.slice(0, 5)
    .map((t) => LOADER_TYPE_NAMES[t])
    .filter((n): n is string => n !== undefined)
  const multiLoader = loaderTypes && loaderTypes.length > 1
  return {
    gameId: MINECRAFT_GAME_ID,
    classId: params.classId,
    categoryId: categoryIds?.length ? undefined : params.categoryId,
    categoryIds: categoryIds?.length ? JSON.stringify(categoryIds) : undefined,
    gameVersion: gameVersions?.length ? undefined : params.gameVersion,
    gameVersions: gameVersions?.length ? JSON.stringify(gameVersions) : undefined,
    searchFilter: params.searchFilter?.trim() || undefined,
    sortField: params.sortField,
    sortOrder: params.sortField !== undefined ? (params.sortOrder ?? 'desc') : params.sortOrder,
    modLoaderType: multiLoader ? undefined : (params.modLoaderTypes?.[0] ?? params.modLoaderType),
    modLoaderTypes: multiLoader ? `[${loaderTypes.join(',')}]` : undefined,
    gameVersionTypeId: params.gameVersionTypeId,
    authorId: params.authorId,
    primaryAuthorId: params.primaryAuthorId,
    slug: params.slug,
    index: page.index,
    pageSize: page.pageSize,
  }
}

/** Caps a CurseForge `totalCount` to the reachable result window. */
export function capCurseForgeTotal(total: number): number {
  return Math.min(total, CURSEFORGE_RESULT_WINDOW)
}

const INSTALLABLE_STATUS = new Set([4, 10])

/** Approved/released and available. Malware, deleted or archived files are never installable. */
export function isInstallableCurseForgeFile(file: Pick<CurseForgeFile, 'isAvailable' | 'fileStatus'>): boolean {
  return file.isAvailable !== false && INSTALLABLE_STATUS.has(file.fileStatus)
}

/** Newest installable file by `fileDate` (server order is not trusted). */
export function pickLatestCurseForgeFile(
  files: CurseForgeFile[],
  options: { releaseOnly?: boolean } = {},
): CurseForgeFile | undefined {
  return files
    .filter((f) => isInstallableCurseForgeFile(f) && (!options.releaseOnly || f.releaseType === 1))
    .toSorted((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))[0]
}

export interface CurseForgeGameVersionInfo {
  minecraft: string[]
  /** Lower-case loader ids: `forge`, `neoforge`, `fabric`, `quilt`, `liteloader`, `rift`. */
  loaders: string[]
  environments: ('client' | 'server')[]
  java: string[]
  other: string[]
}

const MC_VERSION_RE = /^\d+\.\d+(\.\d+)?(-(pre|rc)\d+|-snapshot)?$/i
const CF_LOADERS = new Map([
  ['forge', 'forge'],
  ['neoforge', 'neoforge'],
  ['fabric', 'fabric'],
  ['quilt', 'quilt'],
  ['liteloader', 'liteloader'],
  ['rift', 'rift'],
])

function pushUnique<T>(list: T[], v: T): void {
  if (!list.includes(v)) list.push(v)
}

/** Classifies the mixed `gameVersions` strings of a file. */
export function classifyCurseForgeGameVersions(
  file: Pick<CurseForgeFile, 'gameVersions' | 'sortableGameVersions'>,
): CurseForgeGameVersionInfo {
  const out: CurseForgeGameVersionInfo = { minecraft: [], loaders: [], environments: [], java: [], other: [] }
  const names = [...(file.gameVersions ?? []), ...(file.sortableGameVersions ?? []).map((s) => s.gameVersionName)]
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    const lower = name.toLowerCase()
    const loader = CF_LOADERS.get(lower)
    if (loader) pushUnique(out.loaders, loader)
    else if (lower === 'client' || lower === 'server') pushUnique(out.environments, lower)
    else if (/^java \d+$/.test(lower)) pushUnique(out.java, name)
    else if (MC_VERSION_RE.test(name)) pushUnique(out.minecraft, name)
    else pushUnique(out.other, name)
  }
  return out
}

const CLASS_SLUGS: Record<number, string> = {
  6: 'mc-mods',
  12: 'texture-packs',
  17: 'worlds',
  4471: 'modpacks',
  6552: 'shaders',
  6945: 'data-packs',
  4546: 'customization',
  5: 'bukkit-plugins',
}

/** The project's page on curseforge.com. */
export function curseForgeProjectUrl(mod: Pick<CurseForgeMod, 'id' | 'slug' | 'classId' | 'links'>): string {
  const site = mod.links?.websiteUrl
  if (site && /^https:\/\/(www\.)?curseforge\.com\//.test(site)) return site.replace(/\/+$/, '')
  const classSlug = mod.classId != null ? CLASS_SLUGS[mod.classId] : undefined
  return classSlug
    ? `https://www.curseforge.com/minecraft/${classSlug}/${encodeURIComponent(mod.slug)}`
    : `https://www.curseforge.com/projects/${mod.id}`
}

/**
 * The page where a user can download a file by hand (for `downloadUrl: null`). Without the
 * mod, falls back to the `/projects/<id>` redirect.
 */
export function curseForgeFilePageUrl(
  file: Pick<CurseForgeFile, 'id' | 'modId'>,
  mod?: Pick<CurseForgeMod, 'id' | 'slug' | 'classId' | 'links'>,
): string {
  if (mod) return `${curseForgeProjectUrl(mod)}/download/${file.id}`
  return `https://www.curseforge.com/projects/${file.modId}`
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0

// ---------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------

const mod = (v: unknown, what = 'mod') => withId<CurseForgeMod>(v, what)
const file = (v: unknown, what = 'file'): CurseForgeFile => {
  const o = withId<CurseForgeFile>(v, what)
  if (typeof o.modId !== 'number') throw new Error(`${what}.modId is missing`)
  return o
}
const page =
  <T>(item: (v: unknown, what: string) => T) =>
  (v: unknown): CurseForgePage<T> => {
    const data = arrayOf(cfData(v), 'data', item)
    const p = record(record(v, 'response').pagination, 'pagination')
    return {
      data,
      pagination: {
        index: Number(p.index) || 0,
        pageSize: Number(p.pageSize) || 0,
        resultCount: Number(p.resultCount) || data.length,
        totalCount: Number(p.totalCount) || 0,
      },
    }
  }
const list =
  <T>(item: (v: unknown, what: string) => T) =>
  (v: unknown): T[] =>
    arrayOf(cfData(v), 'data', item)
const text = (v: unknown): string => {
  const d = cfData(v)
  if (typeof d !== 'string') throw new Error('data is not a string')
  return d
}
const fingerprintMatch = (x: unknown, w: string): CurseForgeFingerprintMatch => {
  const o = record(x, w)
  return {
    id: Number(o.id),
    file: file(o.file, `${w}.file`),
    latestFiles: arrayOf(o.latestFiles ?? [], `${w}.latestFiles`, file),
  }
}
const numbers = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number') : [])
const fingerprintMatches = (v: unknown): CurseForgeFingerprintMatches => {
  const d = record(cfData(v), 'data')
  return {
    isCacheBuilt: d.isCacheBuilt !== false,
    exactMatches: arrayOf(d.exactMatches ?? [], 'exactMatches', fingerprintMatch),
    exactFingerprints: numbers(d.exactFingerprints),
    partialMatches: arrayOf(d.partialMatches ?? [], 'partialMatches', fingerprintMatch),
    partialMatchFingerprints: (d.partialMatchFingerprints ?? {}) as Record<string, number[]>,
    installedFingerprints: numbers(d.installedFingerprints),
    unmatchedFingerprints: numbers(d.unmatchedFingerprints),
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface CurseForgeClientOptions {
  /** API key; when missing or empty the client is unavailable. */
  apiKey?: string
  /** Launcher version used in the default User-Agent (default `dev`). */
  version?: string
  userAgent?: string
  fetch?: FetchLike
  baseUrl?: string
  /** GET cache; `false` disables it (default: a new {@link MemoryCache}). */
  cache?: MarketCache | false
  /** Rate limiter; `false` disables it (default: 120/min, 4 in flight). */
  limiter?: RateLimiter | false
  timeoutMs?: number
  retries?: number
  retryDelaysMs?: readonly number[]
  rateLimitDelaysMs?: readonly number[]
  random?: () => number
}

export class CurseForgeClient {
  private readonly http: Transport | undefined
  private forbidden = false

  constructor(options: CurseForgeClientOptions = {}) {
    const key = options.apiKey?.trim()
    if (!key) return
    this.http = new Transport({
      platform: 'curseforge',
      baseUrl: options.baseUrl ?? CURSEFORGE_API,
      headers: {
        'x-api-key': key,
        'user-agent': options.userAgent ?? `wynn-dev/amethyst/${options.version ?? 'dev'}`,
      },
      fetch: options.fetch,
      cache: options.cache ?? new MemoryCache(),
      limiter: options.limiter ?? new RateLimiter({ capacity: 120, windowMs: 60_000, maxConcurrent: 4, lowWatermark: 0 }),
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      retryDelaysMs: options.retryDelaysMs,
      rateLimitDelaysMs: options.rateLimitDelaysMs,
      random: options.random,
    })
  }

  /** False without a key, or after CurseForge rejected the key (403) this session. */
  isAvailable(): boolean {
    return this.http !== undefined && !this.forbidden
  }

  private async call<T>(fn: (http: Transport) => Promise<T>, trackForbidden = true): Promise<T> {
    if (!this.http) {
      throw new MarketplaceError('ECF_NO_KEY', 'CurseForge is unavailable in this build (no API key)', {
        platform: 'curseforge',
      })
    }
    if (this.forbidden) {
      throw new MarketplaceError('ECF_FORBIDDEN', 'CurseForge rejected the API key earlier this session', {
        platform: 'curseforge',
        status: 403,
      })
    }
    try {
      return await fn(this.http)
    } catch (e) {
      if (trackForbidden && isMarketplaceError(e, 'ECF_FORBIDDEN')) this.forbidden = true
      throw e
    }
  }

  /**
   * `GET /v1/mods/search`. A request past the 10 000 result window resolves to an empty page
   * without calling the API.
   */
  searchMods(params: CurseForgeSearchParams = {}, opts?: RequestOptions): Promise<CurseForgePage<CurseForgeMod>> {
    return this.call(async (http) => {
      const query = buildCurseForgeSearchQuery(params)
      if (!query) {
        return {
          data: [],
          pagination: { index: params.index ?? 0, pageSize: 0, resultCount: 0, totalCount: CURSEFORGE_RESULT_WINDOW },
        }
      }
      return http.request({ path: '/v1/mods/search', query, ttlMs: CACHE_TTL.search, validate: page(mod) }, opts)
    })
  }

  /** `GET /v1/mods/{modId}`. */
  getMod(modId: number, opts?: RequestOptions): Promise<CurseForgeMod> {
    return this.call((http) =>
      http.request({ path: `/v1/mods/${modId}`, ttlMs: CACHE_TTL.project, validate: (v) => mod(cfData(v)) }, opts),
    )
  }

  /** `POST /v1/mods`, chunked by 100. Unknown ids are absent. */
  getMods(modIds: number[], opts?: RequestOptions): Promise<CurseForgeMod[]> {
    return this.call(async (http) => {
      const ids = [...new Set(modIds)].filter(isPositiveInt)
      const pages = await Promise.all(
        chunk(ids, 100).map((part) =>
          http.request(
            { method: 'POST', path: '/v1/mods', body: { modIds: part, filterPcOnly: true }, validate: list(mod) },
            opts,
          ),
        ),
      )
      return pages.flat()
    })
  }

  /** `GET /v1/mods/{modId}/description` (untrusted HTML; sanitise before rendering). */
  getModDescription(modId: number, opts?: RequestOptions): Promise<string> {
    return this.call((http) =>
      http.request({ path: `/v1/mods/${modId}/description`, ttlMs: CACHE_TTL.project, validate: text }, opts),
    )
  }

  /** `GET /v1/mods/{modId}/files`. Only parameters with values are sent. */
  getModFiles(modId: number, params: CurseForgeFilesParams = {}, opts?: RequestOptions): Promise<CurseForgePage<CurseForgeFile>> {
    return this.call(async (http) => {
      const p = clampCurseForgePage(params.index, params.pageSize ?? CURSEFORGE_MAX_PAGE_SIZE)
      if (!p) {
        return { data: [], pagination: { index: params.index ?? 0, pageSize: 0, resultCount: 0, totalCount: 0 } }
      }
      return http.request(
        {
          path: `/v1/mods/${modId}/files`,
          query: {
            gameVersion: params.gameVersion,
            modLoaderType: params.modLoaderType,
            gameVersionTypeId: params.gameVersionTypeId,
            index: p.index || undefined,
            pageSize: p.pageSize,
          },
          ttlMs: CACHE_TTL.versionList,
          validate: page(file),
        },
        opts,
      )
    })
  }

  /** `GET /v1/mods/{modId}/files/{fileId}`. */
  getFile(modId: number, fileId: number, opts?: RequestOptions): Promise<CurseForgeFile> {
    return this.call((http) =>
      http.request(
        { path: `/v1/mods/${modId}/files/${fileId}`, ttlMs: CACHE_TTL.version, validate: (v) => file(cfData(v)) },
        opts,
      ),
    )
  }

  /** `POST /v1/mods/files`, chunked by 100. Unknown ids are absent. */
  getFiles(fileIds: number[], opts?: RequestOptions): Promise<CurseForgeFile[]> {
    return this.call(async (http) => {
      const ids = [...new Set(fileIds)].filter(isPositiveInt)
      const pages = await Promise.all(
        chunk(ids, 100).map((part) =>
          http.request({ method: 'POST', path: '/v1/mods/files', body: { fileIds: part }, validate: list(file) }, opts),
        ),
      )
      return pages.flat()
    })
  }

  /** `GET /v1/mods/{modId}/files/{fileId}/changelog` (untrusted HTML). */
  getFileChangelog(modId: number, fileId: number, opts?: RequestOptions): Promise<string> {
    return this.call((http) =>
      http.request(
        { path: `/v1/mods/${modId}/files/${fileId}/changelog`, ttlMs: CACHE_TTL.changelog, validate: text },
        opts,
      ),
    )
  }

  /**
   * `GET /v1/mods/{modId}/files/{fileId}/download-url`. Resolves `null` for
   * distribution-restricted files (empty data or an error status from this endpoint).
   */
  getFileDownloadUrl(modId: number, fileId: number, opts?: RequestOptions): Promise<string | null> {
    return this.call(async (http) => {
      try {
        return await http.request(
          {
            path: `/v1/mods/${modId}/files/${fileId}/download-url`,
            validate: (v) => {
              const d = record(v, 'response').data
              return typeof d === 'string' && d.startsWith('https://') ? d : null
            },
          },
          opts,
        )
      } catch (e) {
        if (isMarketplaceError(e) && (e.code === 'ENOT_FOUND' || e.code === 'ECF_FORBIDDEN')) return null
        throw e
      }
    }, false)
  }

  /**
   * `POST /v1/fingerprints/432`. Fingerprints that are not positive uint32 values are dropped
   * and duplicates are removed; an empty set resolves without a request (CurseForge answers
   * 400 to an empty array). Large sets are split into chunks of 1000 and merged.
   */
  matchFingerprints(fingerprints: number[], opts?: RequestOptions): Promise<CurseForgeFingerprintMatches> {
    return this.call(async (http) => {
      const valid = [...new Set(fingerprints)].filter((n) => isPositiveInt(n) && n <= 0xffffffff)
      const merged: CurseForgeFingerprintMatches = {
        isCacheBuilt: true,
        exactMatches: [],
        exactFingerprints: [],
        partialMatches: [],
        partialMatchFingerprints: {},
        installedFingerprints: [],
        unmatchedFingerprints: [],
      }
      const results = await Promise.all(
        chunk(valid, 1000).map((part) =>
          http.request(
            {
              method: 'POST',
              path: `/v1/fingerprints/${MINECRAFT_GAME_ID}`,
              body: { fingerprints: part },
              validate: fingerprintMatches,
            },
            opts,
          ),
        ),
      )
      for (const r of results) {
        merged.isCacheBuilt &&= r.isCacheBuilt
        merged.exactMatches.push(...r.exactMatches)
        merged.exactFingerprints.push(...r.exactFingerprints)
        merged.partialMatches.push(...r.partialMatches)
        Object.assign(merged.partialMatchFingerprints, r.partialMatchFingerprints)
        merged.installedFingerprints.push(...r.installedFingerprints)
        merged.unmatchedFingerprints.push(...r.unmatchedFingerprints)
      }
      return merged
    })
  }

  /** `GET /v1/categories?gameId=432[&classId=][&classesOnly=true]`. */
  getCategories(
    params: { classId?: number; classesOnly?: boolean } = {},
    opts?: RequestOptions,
  ): Promise<CurseForgeCategory[]> {
    return this.call((http) =>
      http.request(
        {
          path: '/v1/categories',
          query: { gameId: MINECRAFT_GAME_ID, classId: params.classId, classesOnly: params.classesOnly || undefined },
          ttlMs: CACHE_TTL.tags,
          validate: list((v, w) => withId<CurseForgeCategory>(v, w)),
        },
        opts,
      ),
    )
  }

  /** `GET /v1/minecraft/version`. */
  getMinecraftVersions(params: { sortDescending?: boolean } = {}, opts?: RequestOptions): Promise<CurseForgeMinecraftVersion[]> {
    return this.call((http) =>
      http.request(
        {
          path: '/v1/minecraft/version',
          query: { sortDescending: params.sortDescending },
          ttlMs: CACHE_TTL.tags,
          validate: list((v, w) => {
            const o = record(v, w)
            if (typeof o.versionString !== 'string') throw new Error(`${w}.versionString is missing`)
            return o as unknown as CurseForgeMinecraftVersion
          }),
        },
        opts,
      ),
    )
  }

  /** `GET /v1/minecraft/modloader[?version=][&includeAll=]`. */
  getModLoaders(
    params: { version?: string; includeAll?: boolean } = {},
    opts?: RequestOptions,
  ): Promise<CurseForgeModLoaderIndex[]> {
    return this.call((http) =>
      http.request(
        {
          path: '/v1/minecraft/modloader',
          query: { version: params.version, includeAll: params.includeAll },
          ttlMs: CACHE_TTL.tags,
          validate: list((v, w) => {
            const o = record(v, w)
            if (typeof o.name !== 'string') throw new Error(`${w}.name is missing`)
            return o as unknown as CurseForgeModLoaderIndex
          }),
        },
        opts,
      ),
    )
  }
}
