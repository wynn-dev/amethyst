/**
 * Modrinth API v2 client (https://docs.modrinth.com).
 *
 * All reads used by the launcher are unauthenticated. Modrinth requires a uniquely
 * identifying User-Agent, so every request sends `wynn-dev/amethyst/<version>` (or the
 * caller's own string). Requests go through a shared {@link RateLimiter} (250 per minute,
 * 6 in flight) that follows the `X-Ratelimit-*` headers and pauses on 429.
 *
 * Batch endpoints are chunked (100 ids or hashes per request) and ids are validated
 * client-side, because one malformed id makes Modrinth reject the whole batch. Invalid ids
 * and hashes are dropped, matching how the API omits unknown ones.
 *
 * Array query parameters (`ids`, `loaders`, `game_versions`, `facets`) are JSON-encoded,
 * then URL-encoded, as the API expects.
 */

import { CACHE_TTL, MemoryCache, type MarketCache } from './cache'
import { MarketplaceError } from './errors'
import { Transport, type FetchLike, type Query, type RequestOptions } from './http'
import type { MarketProjectType } from './model'
import { RateLimiter } from './rate-limit'
import { array, arrayOf, isRecord, record, withId } from './validate'

// ---------------------------------------------------------------------------------------------
// API shapes (subset used by the launcher)
// ---------------------------------------------------------------------------------------------

export type ModrinthSide = 'required' | 'optional' | 'unsupported' | 'unknown'
export type ModrinthVersionType = 'release' | 'beta' | 'alpha'
export type ModrinthDependencyType = 'required' | 'optional' | 'incompatible' | 'embedded'
export type ModrinthHashAlgorithm = 'sha1' | 'sha512'
/** Search sort order. */
export type ModrinthSortIndex = 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'

export interface ModrinthSearchHit {
  project_id: string
  project_type: string
  slug: string
  title: string
  description: string
  author: string
  categories: string[]
  display_categories?: string[]
  versions: string[]
  downloads: number
  follows: number
  icon_url?: string | null
  date_created: string
  date_modified: string
  latest_version?: string
  license?: string
  client_side?: ModrinthSide
  server_side?: ModrinthSide
  gallery?: string[]
  featured_gallery?: string | null
  color?: number | null
}

export interface ModrinthSearchResult {
  hits: ModrinthSearchHit[]
  offset: number
  limit: number
  total_hits: number
}

export interface ModrinthProject {
  id: string
  slug: string
  project_type: string
  title: string
  description: string
  body?: string
  client_side?: ModrinthSide
  server_side?: ModrinthSide
  categories: string[]
  additional_categories?: string[]
  loaders: string[]
  game_versions: string[]
  versions: string[]
  downloads: number
  followers: number
  icon_url?: string | null
  color?: number | null
  license?: { id: string; name: string; url?: string | null }
  issues_url?: string | null
  source_url?: string | null
  wiki_url?: string | null
  discord_url?: string | null
  donation_urls?: { id: string; platform: string; url: string }[]
  gallery?: { url: string; featured: boolean; title?: string | null; description?: string | null; created: string; ordering: number }[]
  published: string
  updated: string
  status?: string
  team: string
}

export interface ModrinthFile {
  url: string
  filename: string
  primary: boolean
  size: number
  hashes: { sha1?: string; sha512?: string }
  file_type?: string | null
}

export interface ModrinthDependency {
  project_id?: string | null
  version_id?: string | null
  file_name?: string | null
  dependency_type: ModrinthDependencyType
}

export interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  changelog?: string | null
  version_type: ModrinthVersionType
  featured?: boolean
  status?: string
  date_published: string
  downloads: number
  game_versions: string[]
  loaders: string[]
  files: ModrinthFile[]
  dependencies: ModrinthDependency[]
}

export interface ModrinthDependencies {
  projects: ModrinthProject[]
  versions: ModrinthVersion[]
}

export interface ModrinthCategoryTag {
  icon: string
  name: string
  project_type: string
  header: string
}

export interface ModrinthLoaderTag {
  icon: string
  name: string
  supported_project_types: string[]
}

export interface ModrinthGameVersionTag {
  version: string
  version_type: 'release' | 'snapshot' | 'alpha' | 'beta'
  date: string
  major: boolean
}

export interface ModrinthTeamMember {
  team_id: string
  user: { id: string; username: string; name?: string | null; avatar_url?: string | null }
  role: string
  ordering?: number
}

// ---------------------------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------------------------

/**
 * Search parameters. Each filter becomes one facet group: the outer facet array is AND and
 * each inner array is OR.
 */
export interface ModrinthSearchParams {
  query?: string
  /** Datapacks are searched as `project_type:mod` plus `categories:datapack`. Worlds are not on Modrinth. */
  projectType?: MarketProjectType
  /** Loader names, one OR group (`categories:<loader>`). Expand Quilt/NeoForge with `expandLoaders`. */
  loaders?: string[]
  /** Minecraft versions, one OR group (`versions:<mc>`). */
  gameVersions?: string[]
  /** Category names, one OR group. */
  categories?: string[]
  /** `client` for client-side mods, `server` for server-side mods. */
  environment?: 'client' | 'server'
  /** SPDX licence id. */
  license?: string
  /** Extra raw facet groups appended as-is, e.g. `[['downloads>1000']]`. */
  facets?: string[][]
  /** Default: `relevance` with a query, `downloads` without. */
  index?: ModrinthSortIndex
  offset?: number
  /** 1 to 100 (default 20). */
  limit?: number
}

/** Maps a unified project type to Modrinth's `project_type`, or `null` when Modrinth lacks it. */
export function modrinthProjectType(type: MarketProjectType): string | null {
  switch (type) {
    case 'mod':
    case 'modpack':
    case 'resourcepack':
    case 'shader':
      return type
    case 'datapack':
      return 'mod'
    case 'world':
      return null
  }
}

/** Builds the facet array for {@link ModrinthSearchParams}. */
export function buildModrinthFacets(params: ModrinthSearchParams): string[][] {
  const facets: string[][] = []
  if (params.projectType) {
    const type = modrinthProjectType(params.projectType)
    if (!type) {
      throw new MarketplaceError('EINVALID_ARGUMENT', `Modrinth has no ${params.projectType} projects`, {
        platform: 'modrinth',
      })
    }
    facets.push([`project_type:${type}`])
    if (params.projectType === 'datapack') facets.push(['categories:datapack'])
  }
  if (params.gameVersions?.length) facets.push(params.gameVersions.map((v) => `versions:${v}`))
  if (params.loaders?.length) facets.push(params.loaders.map((l) => `categories:${l}`))
  if (params.categories?.length) facets.push(params.categories.map((c) => `categories:${c}`))
  if (params.environment === 'client') {
    facets.push(['client_side:required', 'client_side:optional'], ['server_side:optional', 'server_side:unsupported'])
  } else if (params.environment === 'server') {
    facets.push(['server_side:required', 'server_side:optional'], ['client_side:optional', 'client_side:unsupported'])
  }
  if (params.license) facets.push([`license:${params.license}`])
  for (const group of params.facets ?? []) if (group.length) facets.push(group)
  return facets
}

/** Builds the `/search` query string parameters. */
export function buildModrinthSearchQuery(params: ModrinthSearchParams): Query {
  const query = params.query?.trim() ?? ''
  const facets = buildModrinthFacets(params)
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 20)))
  return {
    query: query || undefined,
    facets: facets.length ? JSON.stringify(facets) : undefined,
    index: params.index ?? (query ? 'relevance' : 'downloads'),
    offset: Math.max(0, Math.floor(params.offset ?? 0)),
    limit,
  }
}

const ID_RE = /^[0-9A-Za-z]{8}$/
const SLUG_RE = /^[\w!@$()`.+,"\-']{3,64}$/
const HASH_RE: Record<ModrinthHashAlgorithm, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha512: /^[0-9a-f]{128}$/,
}

/** True for an 8-character base62 Modrinth id. */
export function isModrinthId(id: string): boolean {
  return ID_RE.test(id)
}

/** True for a Modrinth id or project slug. */
export function isModrinthIdOrSlug(id: string): boolean {
  return ID_RE.test(id) || SLUG_RE.test(id)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)]
}

function normaliseHashes(hashes: string[], algorithm: ModrinthHashAlgorithm): string[] {
  return unique(hashes.map((h) => h.toLowerCase()).filter((h) => HASH_RE[algorithm].test(h)))
}

// ---------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------

const parseProject = (v: unknown, what = 'project') => withId<ModrinthProject>(v, what)
const parseProjects = (v: unknown) => arrayOf(v, 'projects', parseProject)
const parseVersion = (v: unknown, what = 'version') => {
  const o = withId<ModrinthVersion>(v, what)
  array(o.files, `${what}.files`)
  return o
}
const parseVersions = (v: unknown) => arrayOf(v, 'versions', parseVersion)
const versionMap = (v: unknown): Record<string, ModrinthVersion> => {
  const o = record(v, 'hash map')
  for (const [hash, item] of Object.entries(o)) parseVersion(item, `versions[${hash}]`)
  return o as Record<string, ModrinthVersion>
}
const searchResult = (v: unknown): ModrinthSearchResult => {
  const o = record(v, 'search result')
  arrayOf(o.hits, 'hits', (x, w) => withId(x, w, 'project_id'))
  if (typeof o.total_hits !== 'number') throw new Error('total_hits is missing')
  return o as unknown as ModrinthSearchResult
}
const named = <T>(v: unknown, what: string, key: string) =>
  arrayOf(v, what, (x, w) => {
    const o = record(x, w)
    if (typeof o[key] !== 'string') throw new Error(`${w}.${key} is missing`)
    return o as T
  })

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export const MODRINTH_API = 'https://api.modrinth.com/v2'

/** The User-Agent Modrinth sees: `wynn-dev/amethyst/<version>`. */
export function amethystUserAgent(version: string): string {
  return `wynn-dev/amethyst/${version}`
}

export interface ModrinthClientOptions {
  /** Launcher version used in the default User-Agent (default `dev`). */
  version?: string
  /** Full User-Agent override. */
  userAgent?: string
  fetch?: FetchLike
  baseUrl?: string
  /** GET cache; `false` disables it (default: a new {@link MemoryCache}). */
  cache?: MarketCache | false
  /** Rate limiter; `false` disables it (default: 250/min, 6 in flight). */
  limiter?: RateLimiter | false
  timeoutMs?: number
  retries?: number
  retryDelaysMs?: readonly number[]
  random?: () => number
}

export interface ModrinthVersionFilter {
  loaders?: string[]
  gameVersions?: string[]
  featured?: boolean
}

export interface ModrinthUpdateFilter {
  algorithm?: ModrinthHashAlgorithm
  loaders?: string[]
  gameVersions?: string[]
}

/** Newest first by `date_published` (server order is not trusted). */
export function sortVersionsNewestFirst<T extends { date_published: string }>(list: T[]): T[] {
  return list.toSorted((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))
}

const AUXILIARY_FILE_TYPES = new Set(['required-resource-pack', 'optional-resource-pack', 'sources-jar', 'sources'])

/**
 * Picks the file to install from a version: the named file, else the primary file, else a
 * `.jar`/`.mrpack`, else the first non-auxiliary file.
 */
export function pickModrinthFile(v: Pick<ModrinthVersion, 'files'>, filename?: string): ModrinthFile | undefined {
  if (filename) return v.files.find((f) => f.filename === filename)
  const candidates = v.files.filter((f) => !f.file_type || !AUXILIARY_FILE_TYPES.has(f.file_type))
  return (
    candidates.find((f) => f.primary) ??
    candidates.find((f) => f.filename.endsWith('.jar') || f.filename.endsWith('.mrpack')) ??
    candidates[0]
  )
}

export class ModrinthClient {
  readonly userAgent: string
  private readonly http: Transport

  constructor(options: ModrinthClientOptions = {}) {
    this.userAgent = options.userAgent ?? amethystUserAgent(options.version ?? 'dev')
    this.http = new Transport({
      platform: 'modrinth',
      baseUrl: options.baseUrl ?? MODRINTH_API,
      headers: { 'user-agent': this.userAgent },
      fetch: options.fetch,
      cache: options.cache ?? new MemoryCache(),
      limiter: options.limiter ?? new RateLimiter({ capacity: 250, windowMs: 60_000, maxConcurrent: 6 }),
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      retryDelaysMs: options.retryDelaysMs,
      random: options.random,
    })
  }

  /** `GET /search`. */
  search(params: ModrinthSearchParams = {}, opts?: RequestOptions): Promise<ModrinthSearchResult> {
    return this.http.request(
      { path: '/search', query: buildModrinthSearchQuery(params), ttlMs: CACHE_TTL.search, validate: searchResult },
      opts,
    )
  }

  /** `GET /project/{id|slug}`. */
  getProject(idOrSlug: string, opts?: RequestOptions): Promise<ModrinthProject> {
    return this.http.request(
      { path: `/project/${encodeURIComponent(idOrSlug)}`, ttlMs: CACHE_TTL.project, validate: (v) => parseProject(v) },
      opts,
    )
  }

  /** `GET /projects?ids=[...]`, chunked. Invalid ids are dropped; unknown ids are absent from the result. */
  async getProjects(ids: string[], opts?: RequestOptions): Promise<ModrinthProject[]> {
    const valid = unique(ids).filter(isModrinthIdOrSlug)
    const pages = await Promise.all(
      chunk(valid, 100).map((part) =>
        this.http.request(
          { path: '/projects', query: { ids: JSON.stringify(part) }, ttlMs: CACHE_TTL.project, validate: parseProjects },
          opts,
        ),
      ),
    )
    return pages.flat()
  }

  /** `GET /project/{id}/version`, filtered, sorted newest first. */
  async getProjectVersions(
    idOrSlug: string,
    filter: ModrinthVersionFilter = {},
    opts?: RequestOptions,
  ): Promise<ModrinthVersion[]> {
    const list = await this.http.request(
      {
        path: `/project/${encodeURIComponent(idOrSlug)}/version`,
        query: {
          loaders: filter.loaders?.length ? JSON.stringify(filter.loaders) : undefined,
          game_versions: filter.gameVersions?.length ? JSON.stringify(filter.gameVersions) : undefined,
          featured: filter.featured,
        },
        ttlMs: CACHE_TTL.versionList,
        validate: parseVersions,
      },
      opts,
    )
    return sortVersionsNewestFirst(list)
  }

  /** `GET /version/{id}`. */
  getVersion(id: string, opts?: RequestOptions): Promise<ModrinthVersion> {
    if (!isModrinthId(id)) {
      return Promise.reject(
        new MarketplaceError('EINVALID_ARGUMENT', `Invalid Modrinth version id: ${id}`, { platform: 'modrinth' }),
      )
    }
    return this.http.request({ path: `/version/${id}`, ttlMs: CACHE_TTL.version, validate: (v) => parseVersion(v) }, opts)
  }

  /** `GET /versions?ids=[...]`, chunked. Invalid ids are dropped. */
  async getVersions(ids: string[], opts?: RequestOptions): Promise<ModrinthVersion[]> {
    const valid = unique(ids).filter(isModrinthId)
    const pages = await Promise.all(
      chunk(valid, 100).map((part) =>
        this.http.request(
          { path: '/versions', query: { ids: JSON.stringify(part) }, ttlMs: CACHE_TTL.version, validate: parseVersions },
          opts,
        ),
      ),
    )
    return pages.flat()
  }

  /** `GET /version_file/{hash}`. Rejects with `ENOT_FOUND` when the hash is unknown. */
  getVersionFromHash(hash: string, algorithm: ModrinthHashAlgorithm = 'sha1', opts?: RequestOptions): Promise<ModrinthVersion> {
    const [h] = normaliseHashes([hash], algorithm)
    if (!h) {
      return Promise.reject(
        new MarketplaceError('EINVALID_ARGUMENT', `Invalid ${algorithm} hash: ${hash}`, { platform: 'modrinth' }),
      )
    }
    // Hash results belong in the resource index, not the HTTP cache.
    return this.http.request({ path: `/version_file/${h}`, query: { algorithm }, validate: (v) => parseVersion(v) }, opts)
  }

  /** `POST /version_files`, chunked. Returns hash → version; unknown hashes are absent. */
  async getVersionsFromHashes(
    hashes: string[],
    algorithm: ModrinthHashAlgorithm = 'sha1',
    opts?: RequestOptions,
  ): Promise<Record<string, ModrinthVersion>> {
    const valid = normaliseHashes(hashes, algorithm)
    const pages = await Promise.all(
      chunk(valid, 100).map((part) =>
        this.http.request(
          { method: 'POST', path: '/version_files', body: { hashes: part, algorithm }, validate: versionMap },
          opts,
        ),
      ),
    )
    return Object.assign({}, ...pages) as Record<string, ModrinthVersion>
  }

  /** `POST /version_file/{hash}/update`: newest version matching the filter. */
  getLatestVersionFromHash(hash: string, filter: ModrinthUpdateFilter = {}, opts?: RequestOptions): Promise<ModrinthVersion> {
    const algorithm = filter.algorithm ?? 'sha1'
    const [h] = normaliseHashes([hash], algorithm)
    if (!h) {
      return Promise.reject(
        new MarketplaceError('EINVALID_ARGUMENT', `Invalid ${algorithm} hash: ${hash}`, { platform: 'modrinth' }),
      )
    }
    return this.http.request(
      {
        method: 'POST',
        path: `/version_file/${h}/update`,
        query: { algorithm },
        body: updateBody(filter),
        validate: (v) => parseVersion(v),
      },
      opts,
    )
  }

  /**
   * `POST /version_files/update`, chunked: hash → newest version matching the loaders and
   * game versions. Used by update checks.
   */
  async getLatestVersionsFromHashes(
    hashes: string[],
    filter: ModrinthUpdateFilter = {},
    opts?: RequestOptions,
  ): Promise<Record<string, ModrinthVersion>> {
    const algorithm = filter.algorithm ?? 'sha1'
    const valid = normaliseHashes(hashes, algorithm)
    const pages = await Promise.all(
      chunk(valid, 100).map((part) =>
        this.http.request(
          {
            method: 'POST',
            path: '/version_files/update',
            body: { hashes: part, algorithm, ...updateBody(filter) },
            validate: versionMap,
          },
          opts,
        ),
      ),
    )
    return Object.assign({}, ...pages) as Record<string, ModrinthVersion>
  }

  /** `GET /project/{id}/dependencies`. */
  getProjectDependencies(idOrSlug: string, opts?: RequestOptions): Promise<ModrinthDependencies> {
    return this.http.request(
      {
        path: `/project/${encodeURIComponent(idOrSlug)}/dependencies`,
        ttlMs: CACHE_TTL.project,
        validate: (v) => {
          const o = record(v, 'dependencies')
          return { projects: parseProjects(o.projects ?? []), versions: parseVersions(o.versions ?? []) }
        },
      },
      opts,
    )
  }

  /** `GET /project/{id}/members`. */
  getTeamMembers(idOrSlug: string, opts?: RequestOptions): Promise<ModrinthTeamMember[]> {
    return this.http.request(
      {
        path: `/project/${encodeURIComponent(idOrSlug)}/members`,
        ttlMs: CACHE_TTL.project,
        validate: (v) =>
          arrayOf(v, 'members', (x, w) => {
            const o = record(x, w)
            if (!isRecord(o.user)) throw new Error(`${w}.user is missing`)
            return o as unknown as ModrinthTeamMember
          }),
      },
      opts,
    )
  }

  /** `GET /tag/category`. */
  getCategories(opts?: RequestOptions): Promise<ModrinthCategoryTag[]> {
    return this.http.request(
      { path: '/tag/category', ttlMs: CACHE_TTL.tags, validate: (v) => named<ModrinthCategoryTag>(v, 'categories', 'name') },
      opts,
    )
  }

  /** `GET /tag/loader`. */
  getLoaders(opts?: RequestOptions): Promise<ModrinthLoaderTag[]> {
    return this.http.request(
      { path: '/tag/loader', ttlMs: CACHE_TTL.tags, validate: (v) => named<ModrinthLoaderTag>(v, 'loaders', 'name') },
      opts,
    )
  }

  /** `GET /tag/game_version`. */
  getGameVersions(opts?: RequestOptions): Promise<ModrinthGameVersionTag[]> {
    return this.http.request(
      {
        path: '/tag/game_version',
        ttlMs: CACHE_TTL.tags,
        validate: (v) => named<ModrinthGameVersionTag>(v, 'game versions', 'version'),
      },
      opts,
    )
  }
}

function updateBody(filter: ModrinthUpdateFilter): { loaders?: string[]; game_versions?: string[] } {
  const body: { loaders?: string[]; game_versions?: string[] } = {}
  if (filter.loaders?.length) body.loaders = filter.loaders
  if (filter.gameVersions?.length) body.game_versions = filter.gameVersions
  return body
}
