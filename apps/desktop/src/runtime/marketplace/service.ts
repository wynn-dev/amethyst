/**
 * Modrinth and CurseForge through `@amethyst/marketplace`: search, project and version pages,
 * installs (downloaded with `@amethyst/net` straight into the content store, hash-verified,
 * then cloned into the instance) and hash-based update checks.
 *
 * The CurseForge key comes from the build (`AMETHYST_CURSEFORGE_API_KEY`) and never leaves the
 * runtime; without it CurseForge is reported unavailable and skipped everywhere.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathKey, sanitizeFileName, stripDisabled, uniqueName } from '@amethyst/content'
import {
  CurseForgeClient,
  curseForgeFileToVersion,
  curseForgeLoaderType,
  curseForgeModToProject,
  expandLoaders,
  isMarketplaceError,
  ModrinthClient,
  modrinthProjectToProject,
  modrinthVersionToVersion,
  pickLatestCurseForgeFile,
  pickModrinthFile,
  projectTypeFromCurseForgeClass,
  projectTypeFromModrinth,
  searchMarketplace,
  sortVersionsNewestFirst,
  MarketplaceError,
  type CurseForgeFile,
  type MarketProject,
  type MarketVersion,
  type ModrinthVersion,
} from '@amethyst/marketplace'
import { download } from '@amethyst/net'
import { mapLimit } from '@amethyst/task'
import type {
  HostServices,
  MarketCursor,
  MarketInstallInput,
  MarketInstallResult,
  MarketPlatform,
  MarketplaceService,
  MarketProjectDetail,
  MarketProjectRow,
  MarketProjectType,
  MarketSearchPage,
  MarketSearchQuery,
  MarketStatus,
  MarketVersionQuery,
  MarketVersionRow,
  ResourceKind,
  UpdateCandidate,
} from '@shared/services'
import type { DbClient } from '../db/client'
import type { Platform, SourceRow } from '../db/protocol'
import { loaderOf } from '../instances/model'
import type { InstanceManager } from '../instances/service'
import { logger } from '../log'
import type { WorkerPool } from '../resources/pool'
import { resourceId } from '../resources/rows'
import type { ResourceManager } from '../resources/service'
import type { ResourceWorkerHandlers } from '../resources/worker-handlers'
import type { TaskRegistry } from '../tasks/registry'
import { AppError, errorMessage, invalid } from '../util/errors'
import { PersistentMarketCache } from './cache'

const log = logger('marketplace')
const NEGATIVE_TTL_MS = 7 * 24 * 3600 * 1000
const UPDATE_TTL_MS = 10 * 60 * 1000
const MODRINTH_ID = /^[0-9A-Za-z]{8}$/

export interface MarketplaceDeps {
  version: string
  curseforgeApiKey?: string
  db: Pick<DbClient, 'query'> | undefined
  instances: Pick<InstanceManager, 'resolve'>
  resources: Pick<ResourceManager, 'items' | 'refreshSources' | 'rescan' | 'store' | 'knownSources'>
  pool: Pick<WorkerPool<ResourceWorkerHandlers>, 'call'>
  tasks: TaskRegistry
  host: Pick<HostServices, 'trash'>
  /** Inject clients (tests). */
  modrinth?: ModrinthClient
  curseforge?: CurseForgeClient
  now?: () => number
}

const KIND_FOR_TYPE: Partial<Record<MarketProjectType, ResourceKind>> = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', world: 'saves' }

function toError(e: unknown): { code: string; message: string } {
  return { code: isMarketplaceError(e) ? e.code : ((e as { code?: string })?.code ?? 'EFAILED'), message: errorMessage(e) }
}

/** Marketplace errors as RPC errors with their platform, status and retryability. */
function mapError(e: unknown): unknown {
  if (!(e instanceof MarketplaceError)) return e
  return new AppError(e.code, e.message, { platform: e.platform, ...(e.status !== undefined ? { status: e.status } : {}), retryable: e.retryable }, { cause: e })
}

function row(p: MarketProject, installed: Set<string>): MarketProjectRow {
  return {
    key: p.key,
    platform: p.source,
    id: p.id,
    slug: p.slug,
    title: p.title,
    author: p.author,
    summary: p.summary,
    iconUrl: p.iconUrl,
    projectType: p.projectType,
    downloads: p.downloads,
    followers: p.followers,
    categories: p.categories,
    loaders: p.loaders,
    updatedAt: p.updatedAt,
    websiteUrl: p.websiteUrl,
    linked: p.linked ? { platform: p.linked.source, id: p.linked.id } : null,
    installed: installed.has(p.key) || (p.linked ? installed.has(p.linked.key) : false),
  }
}

function versionRow(v: MarketVersion): MarketVersionRow {
  const file = v.files.find((f) => f.primary) ?? v.files[0]
  return {
    id: v.id,
    platform: v.source,
    projectId: v.projectId,
    name: v.name,
    versionNumber: v.versionNumber,
    releaseType: v.releaseType,
    publishedAt: v.publishedAt,
    downloads: v.downloads,
    gameVersions: v.gameVersions,
    loaders: v.loaders,
    file: file ? { fileName: file.fileName, size: file.size, sha1: file.sha1 } : null,
    manualDownloadRequired: file?.manualDownloadRequired ?? false,
    dependencies: v.dependencies.map((d) => ({ projectId: d.projectId, versionId: d.versionId, type: d.type })),
  }
}

export class MarketplaceManager {
  readonly #d: MarketplaceDeps
  readonly #cache: PersistentMarketCache
  readonly #modrinth: ModrinthClient
  readonly #curseforge: CurseForgeClient
  readonly #now: () => number
  #warmed: Promise<unknown> | undefined

  constructor(deps: MarketplaceDeps) {
    this.#d = deps
    this.#now = deps.now ?? Date.now
    this.#cache = new PersistentMarketCache(deps.db)
    this.#modrinth = deps.modrinth ?? new ModrinthClient({ version: deps.version, cache: this.#cache })
    this.#curseforge = deps.curseforge ?? new CurseForgeClient({ version: deps.version, cache: this.#cache, ...(deps.curseforgeApiKey ? { apiKey: deps.curseforgeApiKey } : {}) })
  }

  /** Warm the response cache from the index once, on first use. */
  #ready(): Promise<unknown> {
    this.#warmed ??= this.#cache.warm()
    return this.#warmed
  }

  /** The API clients, for the modpack service. CurseForge is `undefined` when unavailable in this build. */
  clients(): { modrinth: ModrinthClient; curseforge: CurseForgeClient | undefined } {
    return { modrinth: this.#modrinth, curseforge: this.#curseforge.isAvailable() ? this.#curseforge : undefined }
  }

  status(): MarketStatus {
    const curseforge = this.#curseforge.isAvailable()
    return { modrinth: true, curseforge, ...(curseforge ? {} : { curseforgeReason: this.#d.curseforgeApiKey ? 'forbidden' : 'no-key' }) }
  }

  #cf(): CurseForgeClient {
    if (!this.#curseforge.isAvailable()) throw new AppError('EUNAVAILABLE', 'CurseForge is not available in this build', { platform: 'curseforge' })
    return this.#curseforge
  }

  async search(query: MarketSearchQuery, cursor?: MarketCursor): Promise<MarketSearchPage> {
    await this.#ready()
    if (!query || typeof query.projectType !== 'string') throw invalid('projectType is required')
    const platforms = new Set(query.platforms ?? ['modrinth', 'curseforge'])
    const installed = query.instanceId ? this.#d.resources.knownSources(query.instanceId) : new Set<string>()
    const page = await searchMarketplace(
      {
        ...(platforms.has('modrinth') ? { modrinth: this.#modrinth } : {}),
        ...(platforms.has('curseforge') && this.#curseforge.isAvailable() ? { curseforge: this.#curseforge } : {}),
      },
      {
        projectType: query.projectType,
        ...(query.query ? { query: query.query } : {}),
        ...(query.gameVersion ? { gameVersion: query.gameVersion } : {}),
        ...(query.loader ? { loader: query.loader } : {}),
        ...(query.modrinthCategories ? { modrinthCategories: query.modrinthCategories } : {}),
        ...(query.curseforgeCategoryIds ? { curseforgeCategoryIds: query.curseforgeCategoryIds } : {}),
        ...(query.environment ? { environment: query.environment } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.pageSize ? { pageSize: query.pageSize } : {}),
      },
      cursor,
    )
    const errors: MarketSearchPage['errors'] = {}
    for (const [platform, e] of Object.entries(page.errors)) errors[platform as MarketPlatform] = toError(e)
    return { items: page.items.map((p) => row(p, installed)), total: page.total, cursor: page.cursor, hasMore: page.hasMore, errors }
  }

  async getProject(platform: MarketPlatform, projectId: string): Promise<MarketProjectDetail> {
    await this.#ready()
    try {
      if (platform === 'modrinth') {
        const p = await this.#modrinth.getProject(projectId)
        const project = modrinthProjectToProject(p)
        const members = await this.#modrinth.getTeamMembers(p.id).catch(() => [])
        const owner = members.find((m) => m.role === 'Owner') ?? members[0]
        return {
          ...row({ ...project, author: owner?.user.name || owner?.user.username || '' }, new Set()),
          body: p.body ?? '',
          bodyFormat: 'markdown',
          gameVersions: project.gameVersions,
          license: p.license?.name ?? p.license?.id ?? null,
          links: { ...(p.issues_url ? { issues: p.issues_url } : {}), ...(p.source_url ? { source: p.source_url } : {}), ...(p.wiki_url ? { wiki: p.wiki_url } : {}), ...(p.discord_url ? { discord: p.discord_url } : {}) },
          gallery: (p.gallery ?? []).toSorted((a, b) => a.ordering - b.ordering).map((g) => ({ url: g.url, title: g.title ?? null })),
          createdAt: project.createdAt,
        }
      }
      const cf = this.#cf()
      const id = Number(projectId)
      if (!Number.isSafeInteger(id) || id <= 0) throw invalid('Bad CurseForge project id')
      const mod = await cf.getMod(id)
      const project = curseForgeModToProject(mod)
      return {
        ...row(project, new Set()),
        body: await cf.getModDescription(id).catch(() => ''),
        bodyFormat: 'html',
        gameVersions: project.gameVersions,
        license: null,
        links: { ...(mod.links?.issuesUrl ? { issues: mod.links.issuesUrl } : {}), ...(mod.links?.sourceUrl ? { source: mod.links.sourceUrl } : {}), ...(mod.links?.wikiUrl ? { wiki: mod.links.wikiUrl } : {}) },
        gallery: (mod.screenshots ?? []).map((s) => ({ url: s.url, title: s.title ?? null })),
        createdAt: project.createdAt,
      }
    } catch (e) {
      throw mapError(e)
    }
  }

  async getVersions(platform: MarketPlatform, projectId: string, query: MarketVersionQuery = {}): Promise<MarketVersionRow[]> {
    await this.#ready()
    try {
      if (platform === 'modrinth') {
        const loaders = query.loader ? expandLoaders(query.loader, query.gameVersion) : undefined
        const list = await this.#modrinth.getProjectVersions(projectId, { ...(loaders ? { loaders } : {}), ...(query.gameVersion ? { gameVersions: [query.gameVersion] } : {}) })
        return list.map((v) => versionRow(modrinthVersionToVersion(v)))
      }
      const id = Number(projectId)
      if (!Number.isSafeInteger(id) || id <= 0) throw invalid('Bad CurseForge project id')
      const files = await this.#cfFiles(id, {
        ...(query.gameVersion ? { gameVersion: query.gameVersion } : {}),
        ...(query.loader ? { loaders: expandLoaders(query.loader, query.gameVersion) } : {}),
        index: Math.max(0, Math.trunc(query.page ?? 0)) * 50,
      })
      return files.map((f) => versionRow(curseForgeFileToVersion(f))).toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    } catch (e) {
      throw mapError(e)
    }
  }

  /**
   * One page of a CurseForge project's files for a loader set. CurseForge filters by a single
   * `modLoaderType`, so an expanded set (Quilt also runs Fabric files, NeoForge 1.20.1 Forge
   * files) is one request per loader, merged by file id.
   */
  async #cfFiles(modId: number, params: { gameVersion?: string; loaders?: string[]; index?: number }, opts?: { fresh?: boolean }): Promise<CurseForgeFile[]> {
    const types = [...new Set((params.loaders ?? []).flatMap((l) => curseForgeLoaderType(l) ?? []))]
    const pages = await Promise.all(
      (types.length > 0 ? types : [undefined]).map((t) =>
        this.#cf().getModFiles(modId, { ...(params.gameVersion ? { gameVersion: params.gameVersion } : {}), ...(t !== undefined ? { modLoaderType: t } : {}), index: params.index ?? 0, pageSize: 50 }, opts),
      ),
    )
    return [...new Map(pages.flatMap((p) => p.data).map((f) => [f.id, f])).values()]
  }

  async getChangelog(platform: MarketPlatform, projectId: string, versionId: string): Promise<string> {
    try {
      if (platform === 'modrinth') return (await this.#modrinth.getVersion(versionId)).changelog ?? ''
      const modId = Number(projectId)
      const fileId = Number(versionId)
      if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) throw invalid('Bad CurseForge ids')
      return await this.#cf().getFileChangelog(modId, fileId)
    } catch (e) {
      throw mapError(e)
    }
  }

  /** Resolve a version, its file and the folder it belongs in. */
  async #resolveInstall(input: MarketInstallInput): Promise<{ version: MarketVersion; kind: ResourceKind; title: string }> {
    if (input.platform === 'modrinth') {
      if (!MODRINTH_ID.test(input.versionId)) throw invalid('Bad Modrinth version id')
      const [v, p] = await Promise.all([this.#modrinth.getVersion(input.versionId), this.#modrinth.getProject(input.projectId)])
      if (v.project_id !== p.id) throw invalid('The version does not belong to this project')
      const picked = pickModrinthFile(v)
      const version = modrinthVersionToVersion({ ...v, files: picked ? [{ ...picked, primary: true }] : [] })
      const type = projectTypeFromModrinth(p.project_type, p.loaders)
      return { version, kind: this.#kindFor(type), title: p.title }
    }
    const cf = this.#cf()
    const modId = Number(input.projectId)
    const fileId = Number(input.versionId)
    if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) throw invalid('Bad CurseForge ids')
    const [file, mod] = await Promise.all([cf.getFile(modId, fileId), cf.getMod(modId)])
    return { version: curseForgeFileToVersion(file, mod), kind: this.#kindFor(projectTypeFromCurseForgeClass(mod.classId)), title: mod.name }
  }

  #kindFor(type: MarketProjectType | null): ResourceKind {
    const kind = type ? KIND_FOR_TYPE[type] : undefined
    if (!kind) throw new AppError('EUNSUPPORTED', type === 'modpack' ? 'Modpacks are installed as new instances' : `Installing ${type ?? 'this content'} into an instance is not supported`)
    return kind
  }

  async install(input: MarketInstallInput): Promise<MarketInstallResult> {
    if (!input || (input.platform !== 'modrinth' && input.platform !== 'curseforge')) throw invalid('Unknown platform')
    const inst = this.#d.instances.resolve(input.instanceId)
    await this.#ready()
    let resolved
    try {
      resolved = await this.#resolveInstall(input)
    } catch (e) {
      throw mapError(e)
    }
    const { version, kind, title } = resolved
    const file = version.files[0]
    if (!file) throw new AppError('ENO_FILE', 'This version has no downloadable file')
    if (file.manualDownloadRequired || !file.url) {
      return {
        resource: null,
        manual: [{ projectId: version.projectId, fileId: version.id, fileName: file.fileName, websiteUrl: file.websiteUrl ?? '', sha1: file.sha1, size: file.size }],
      }
    }
    if (input.replaces && input.replaces.kind !== kind) throw invalid('The replaced resource is in another folder')
    const url = file.url
    const store = this.#d.resources.store

    const id = await this.#d.tasks.runAndWait({ name: 'market.install', params: { title, version: version.versionNumber }, instanceId: inst.id }, async (ctx) => {
      const dir = path.join(inst.dir, kind)
      await mkdir(dir, { recursive: true })
      if (kind === 'saves') {
        const tmp = path.join(store.root, 'tmp', `world-${randomBytes(6).toString('hex')}.zip`)
        try {
          await download({ url, dest: tmp, size: file.size, ...(file.sha1 ? { checksum: { algorithm: 'sha1', value: file.sha1 } } : {}) }, { ctx, signal: ctx.signal })
          const world = await this.#d.pool.call('importWorld', { source: tmp, savesDir: dir }, ctx.signal)
          return resourceId(world.folderName, 'saves')
        } finally {
          await rm(tmp, { force: true })
        }
      }
      // 1. Into the store (skipped when the blob is already there).
      let sha1 = file.sha1?.toLowerCase() ?? null
      if (sha1 && (await store.has(sha1, file.size))) {
        ctx.update(1, 1, 'already downloaded')
      } else if (sha1) {
        const dest = store.pathOf(sha1)
        await mkdir(path.dirname(dest), { recursive: true })
        await download({ url, dest, size: file.size, checksum: { algorithm: 'sha1', value: sha1 } }, { ctx, signal: ctx.signal })
        await chmod(dest, 0o444).catch(() => {})
      } else {
        const tmp = path.join(store.root, 'tmp', `dl-${randomBytes(6).toString('hex')}`)
        try {
          await download({ url, dest: tmp, size: file.size, ...(file.sha512 ? { checksum: { algorithm: 'sha512', value: file.sha512 } } : {}) }, { ctx, signal: ctx.signal })
          sha1 = (await this.#d.pool.call('ingest', { storeRoot: store.root, source: tmp }, ctx.signal)).sha1
        } finally {
          await rm(tmp, { force: true })
        }
      }
      if (!sha1) throw new AppError('EINTERNAL', 'The download has no hash')
      // 2. Into the instance, never under an unsanitised name.
      const { items } = await this.#d.resources.items(inst.id, kind)
      let current = input.replaces ? items.find((i) => i.row.id === input.replaces?.id) : undefined
      if (input.replaces && !current) throw new AppError('ENOT_FOUND', 'The resource to replace is gone')
      // One file per project: installing another version of a project already in the folder replaces it.
      current ??= items.find((i) => i.row.source?.platform === input.platform && i.row.source.projectId === version.projectId && i.row.sha1 !== sha1)
      let name = sanitizeFileName(file.fileName, 'download.jar')
      // An update of a disabled mod stays disabled.
      if (kind === 'mods' && current && !current.row.enabled) name = `${stripDisabled(name)}.disabled`
      // One file per content hash: the same bytes already in the folder (under any name) are not placed twice.
      const twin = items.find((i) => i !== current && i.row.sha1 === sha1 && (kind !== 'mods' || i.row.enabled))
      let placed: string | undefined
      if (twin) {
        name = twin.row.fileName
      } else {
        const existing = items.find((i) => pathKey(i.row.fileName) === pathKey(name))
        const replacingInPlace = existing !== undefined && existing.path === current?.path
        if (existing && !replacingInPlace) name = await uniqueName(dir, name)
        await store.place(sha1, path.join(dir, name), { overwrite: replacingInPlace, signal: ctx.signal })
        if (!replacingInPlace) placed = path.join(dir, name)
      }
      // 3. Provenance is authoritative over later hash lookups.
      await this.#d.db
        ?.query('sources.put', { rows: [{ sha1, platform: input.platform, projectId: version.projectId, versionId: version.id, confidence: 'manifest', resolvedAt: this.#now() }] })
        .catch((e: unknown) => log.warn('cannot record attribution', e))
      // 4. An update replaces the old file (never leaves both): if the old file cannot be removed,
      //    the new one is taken back out and the folder stays as it was.
      if (current && pathKey(current.path) !== pathKey(path.join(dir, name))) {
        try {
          await this.#d.host.trash(current.path)
        } catch (e) {
          if (placed) await rm(placed, { force: true }).catch(() => {})
          throw e
        }
      }
      return resourceId(name, kind)
    })
    await this.#d.resources.rescan(inst.id, kind)
    return { resource: { kind, id }, manual: [] }
  }

  // -------------------------------------------------------------------------------------------
  // Attribution and update checks
  // -------------------------------------------------------------------------------------------

  /** Look up unattributed hashes on Modrinth (bulk) and CurseForge (fingerprints); cache misses for a week. */
  async #attribute(items: { sha1: string; path: string }[]): Promise<Map<string, SourceRow[]>> {
    const db = this.#d.db
    const bySha = new Map<string, SourceRow[]>()
    if (!db || items.length === 0) return bySha
    const sha1s = [...new Set(items.map((i) => i.sha1))]
    for (const r of await db.query('sources.get', { sha1s }).catch(() => [] as SourceRow[])) bySha.set(r.sha1, [...(bySha.get(r.sha1) ?? []), r])
    const now = this.#now()
    const since = now - NEGATIVE_TTL_MS
    const unknown = sha1s.filter((h) => !bySha.has(h))
    if (unknown.length === 0) return bySha

    const found: SourceRow[] = []
    const freshMr = new Set(await db.query('lookups.fresh', { sha1s: unknown, platform: 'modrinth', since }).catch(() => [] as string[]))
    const askMr = unknown.filter((h) => !freshMr.has(h))
    if (askMr.length > 0) {
      try {
        const versions = await this.#modrinth.getVersionsFromHashes(askMr)
        const misses: string[] = []
        for (const h of askMr) {
          const v = versions[h]
          if (v && MODRINTH_ID.test(v.id) && MODRINTH_ID.test(v.project_id)) found.push({ sha1: h, platform: 'modrinth', projectId: v.project_id, versionId: v.id, confidence: 'hash', resolvedAt: now })
          else misses.push(h)
        }
        if (misses.length > 0) await db.query('lookups.put', { sha1s: misses, platform: 'modrinth', now })
      } catch (e) {
        log.warn(`Modrinth hash lookup failed: ${errorMessage(e)}`)
      }
    }

    const stillUnknown = unknown.filter((h) => !found.some((f) => f.sha1 === h))
    if (this.#curseforge.isAvailable() && stillUnknown.length > 0) {
      const freshCf = new Set(await db.query('lookups.fresh', { sha1s: stillUnknown, platform: 'curseforge', since }).catch(() => [] as string[]))
      const askCf = stillUnknown.filter((h) => !freshCf.has(h))
      if (askCf.length > 0) {
        try {
          const known = new Map(await db.query('fingerprints.get', { sha1s: askCf }))
          const missing = items.filter((i) => askCf.includes(i.sha1) && !known.has(i.sha1))
          if (missing.length > 0) {
            const computed = await this.#d.pool.call('fingerprints', { files: missing.map((i) => ({ path: i.path, sha1: i.sha1 })) })
            for (const [h, fp] of computed) known.set(h, fp)
            if (computed.length > 0) await db.query('fingerprints.put', { entries: computed })
          }
          const byFp = new Map<number, string[]>()
          for (const [h, fp] of known) byFp.set(fp, [...(byFp.get(fp) ?? []), h])
          const matches = await this.#curseforge.matchFingerprints([...byFp.keys()])
          const matched = new Set<string>()
          for (const m of matches.exactMatches) {
            for (const h of byFp.get(m.file.fileFingerprint) ?? []) {
              matched.add(h)
              found.push({ sha1: h, platform: 'curseforge', projectId: String(m.file.modId), versionId: String(m.file.id), confidence: 'hash', resolvedAt: now })
            }
          }
          // While CurseForge's index warms up, a miss means "try later", not "unknown".
          if (matches.isCacheBuilt) {
            const misses = askCf.filter((h) => !matched.has(h))
            if (misses.length > 0) await db.query('lookups.put', { sha1s: misses, platform: 'curseforge', now })
          }
        } catch (e) {
          log.warn(`CurseForge fingerprint lookup failed: ${errorMessage(e)}`)
        }
      }
    }
    if (found.length > 0) {
      await db.query('sources.put', { rows: found }).catch(() => undefined)
      for (const r of found) bySha.set(r.sha1, [...(bySha.get(r.sha1) ?? []), r])
    }
    return bySha
  }

  async checkUpdates(instanceId: string, kind: ResourceKind, options: { releaseOnly?: boolean; fresh?: boolean } = {}): Promise<UpdateCandidate[]> {
    if (kind === 'saves') return []
    const inst = this.#d.instances.resolve(instanceId)
    await this.#ready()
    const releaseOnly = options.releaseOnly ?? true
    const { items } = await this.#d.resources.items(instanceId, kind)
    const candidates = items.filter((i) => i.row.enabled && i.row.sha1 && !i.row.isDirectory).map((i) => ({ sha1: i.row.sha1 as string, path: i.path, row: i.row }))
    if (candidates.length === 0) return []
    const sources = await this.#attribute(candidates)
    await this.#d.resources.refreshSources(instanceId, kind)

    const minecraft = inst.config.runtime.minecraft
    const loader = loaderOf(inst.config.runtime)
    const loaders = kind === 'mods' && loader ? expandLoaders(loader.kind, minecraft) : undefined
    const filter = JSON.stringify({ minecraft, loaders: loaders ?? null, releaseOnly })
    const now = this.#now()

    // Each file is checked on exactly one platform: its install provenance, else Modrinth, else CurseForge.
    const plan = candidates.flatMap((c) => {
      const rows = sources.get(c.sha1) ?? []
      const src = rows.find((r) => r.confidence === 'manifest') ?? rows.find((r) => r.platform === 'modrinth') ?? rows.find((r) => r.platform === 'curseforge')
      return src && (src.platform === 'modrinth' || this.#curseforge.isAvailable()) ? [{ ...c, src }] : []
    })
    const cached = new Map<string, unknown>()
    if (!options.fresh && this.#d.db) {
      const rows = await this.#d.db.query('updates.get', { keys: plan.map((p) => ({ sha1: p.sha1, platform: p.src.platform, filter })), since: now - UPDATE_TTL_MS }).catch(() => [])
      for (const r of rows) cached.set(`${r.platform}:${r.sha1}`, r.result)
    }
    const results = new Map<string, UpdateCandidate['latest'] | null>()
    const toStore: { sha1: string; platform: Platform; filter: string; result: unknown; checkedAt: number }[] = []

    const mrPlan = plan.filter((p) => p.src.platform === 'modrinth' && !cached.has(`modrinth:${p.sha1}`))
    if (mrPlan.length > 0) {
      try {
        const latest = await this.#modrinth.getLatestVersionsFromHashes(
          mrPlan.map((p) => p.sha1),
          { ...(loaders ? { loaders } : {}), ...(minecraft ? { gameVersions: [minecraft] } : {}) },
          { fresh: true },
        )
        await mapLimit(mrPlan, 4, async (p) => {
          let v: ModrinthVersion | undefined = latest[p.sha1]
          if (v && releaseOnly && v.version_type !== 'release') {
            const list = await this.#modrinth.getProjectVersions(v.project_id, { ...(loaders ? { loaders } : {}), ...(minecraft ? { gameVersions: [minecraft] } : {}) }, { fresh: true }).catch(() => [] as ModrinthVersion[])
            v = sortVersionsNewestFirst(list).find((x) => x.version_type === 'release')
          }
          const file = v ? pickModrinthFile(v) : undefined
          const result = v && file && v.id !== p.src.versionId ? { versionId: v.id, name: v.name, versionNumber: v.version_number, releaseType: v.version_type, publishedAt: v.date_published, fileName: file.filename } : null
          results.set(`modrinth:${p.sha1}`, result)
          toStore.push({ sha1: p.sha1, platform: 'modrinth', filter, result, checkedAt: now })
        })
      } catch (e) {
        log.warn(`Modrinth update check failed: ${errorMessage(e)}`)
      }
    }

    const cfPlan = plan.filter((p) => p.src.platform === 'curseforge' && !cached.has(`curseforge:${p.sha1}`))
    if (cfPlan.length > 0 && this.#curseforge.isAvailable()) {
      await mapLimit(cfPlan, 4, async (p) => {
        try {
          const files = await this.#cfFiles(Number(p.src.projectId), { ...(minecraft ? { gameVersion: minecraft } : {}), ...(loaders ? { loaders } : {}) }, { fresh: true })
          const latest = pickLatestCurseForgeFile(files, { releaseOnly })
          const result =
            latest && String(latest.id) !== p.src.versionId
              ? { versionId: String(latest.id), name: latest.displayName, versionNumber: latest.displayName, releaseType: latest.releaseType === 1 ? 'release' : latest.releaseType === 2 ? 'beta' : 'alpha', publishedAt: latest.fileDate, fileName: latest.fileName }
              : null
          results.set(`curseforge:${p.sha1}`, result as UpdateCandidate['latest'] | null)
          toStore.push({ sha1: p.sha1, platform: 'curseforge', filter, result, checkedAt: now })
        } catch (e) {
          log.warn(`CurseForge update check for ${p.src.projectId} failed: ${errorMessage(e)}`)
        }
      })
    }
    if (toStore.length > 0) await this.#d.db?.query('updates.put', { rows: toStore }).catch(() => undefined)

    const latestOf = (p: (typeof plan)[number]) => {
      const key = `${p.src.platform}:${p.sha1}`
      return (results.has(key) ? results.get(key) : cached.get(key)) as UpdateCandidate['latest'] | null | undefined
    }
    const published = await this.#publishedDates(plan.filter((p) => latestOf(p)).map((p) => p.src))
    const out: UpdateCandidate[] = []
    const seen = new Set<string>()
    for (const p of plan) {
      const latest = latestOf(p)
      // One plan entry per project: the same mod is never offered twice.
      if (!latest || seen.has(`${p.src.platform}:${p.src.projectId}`)) continue
      // An update is never a downgrade (e.g. the newest release when a newer beta is installed).
      const current = Date.parse(published.get(`${p.src.platform}:${p.src.versionId}`) ?? '')
      const next = Date.parse(latest.publishedAt)
      if (Number.isFinite(current) && Number.isFinite(next) && next <= current) continue
      seen.add(`${p.src.platform}:${p.src.projectId}`)
      out.push({ resourceId: p.row.id, fileName: p.row.fileName, platform: p.src.platform, projectId: p.src.projectId, currentVersionId: p.src.versionId, latest })
    }
    return out
  }

  /** Publish dates of the installed versions (`platform:versionId` → ISO date), batched; unknown ones are absent. */
  async #publishedDates(srcs: { platform: Platform; versionId?: string | null }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const ids = (platform: Platform) => [...new Set(srcs.flatMap((s) => (s.platform === platform && s.versionId ? [s.versionId] : [])))]
    const mr = ids('modrinth').filter((id) => MODRINTH_ID.test(id))
    const cf = ids('curseforge').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
    await Promise.all([
      mr.length > 0 &&
        (async () => {
          for (const v of await this.#modrinth.getVersions(mr)) out.set(`modrinth:${v.id}`, v.date_published)
        })().catch((e: unknown) => log.warn(`Modrinth version lookup failed: ${errorMessage(e)}`)),
      cf.length > 0 &&
        this.#curseforge.isAvailable() &&
        (async () => {
          for (const f of await this.#curseforge.getFiles(cf)) out.set(`curseforge:${f.id}`, f.fileDate)
        })().catch((e: unknown) => log.warn(`CurseForge file lookup failed: ${errorMessage(e)}`)),
    ])
    return out
  }

  async flush(): Promise<void> {
    await this.#cache.flush()
  }
}

/** The RPC facade. */
export function marketplaceService(manager: () => MarketplaceManager): MarketplaceService {
  return {
    getStatus: async () => manager().status(),
    search: (q, c) => manager().search(q, c),
    getProject: (p, id) => manager().getProject(p, id),
    getVersions: (p, id, q) => manager().getVersions(p, id, q),
    getChangelog: (p, id, v) => manager().getChangelog(p, id, v),
    install: (input) => manager().install(input),
    checkUpdates: (i, k, o) => manager().checkUpdates(i, k, o),
  }
}
