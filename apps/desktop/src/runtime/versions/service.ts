/**
 * Minecraft and loader version lists (through `@amethyst/installer`'s metadata client, cached on
 * disk under `cache/meta/`) and the version folders installed in the shared `minecraft/versions`.
 *
 * Lists are served stale-while-revalidate: whatever the cache holds is returned at once, and a
 * list older than the refresh interval is revalidated in the background (conditional requests),
 * announced by `versions:changed` when its content changed. Nothing here runs at boot; the
 * metadata client is created on first use.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { MetadataClient } from '@amethyst/installer'
import type {
  InstalledVersionRow,
  LoaderKind,
  LoaderVersionList,
  LoaderVersionRow,
  MinecraftVersionList,
  MinecraftVersionQuery,
  MinecraftVersionRow,
  MinecraftVersionType,
  VersionsService,
} from '@shared/services'
import type { Emit } from '../context'
import { detectRuntimeFromVersions } from '../instances/model'
import type { InstanceManager } from '../instances/service'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import { AppError, errorMessage, invalid } from '../util/errors'
import { asRecord, readString } from '../util/parse'

const log = logger('versions')

/** The metadata calls this service uses (the real client, or a fake in tests). */
export type VersionsMeta = Pick<MetadataClient, 'minecraftManifest' | 'loaderGameVersions' | 'loaderVersions' | 'forgeVersions' | 'neoForgeVersions'>

/** Background-refreshable lists. */
type ListKey = 'minecraft' | LoaderKind

export interface VersionsDeps {
  layout: DataLayout
  emit: Emit
  instances: Pick<InstanceManager, 'list' | 'get'>
  /** The shared metadata client (created lazily). */
  meta: () => Promise<VersionsMeta>
  /** True while an install or a game uses this version id (deleting it is refused). */
  versionInUse?: (versionId: string) => boolean
  /** A list older than this is revalidated in the background (default 10 minutes). */
  refreshIntervalMs?: number
  now?: () => number
}

const VERSION_ID = /^[\w.+\- ]{1,128}$/

/** Hash of a list, to announce only real changes. */
const digest = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex')

export class VersionsManager {
  readonly #d: VersionsDeps
  readonly #now: () => number
  readonly #interval: number
  /** Last successful revalidation per list (this session). */
  readonly #fetchedAt = new Map<ListKey, number>()
  /** Last attempt per list, so a failing server is not hammered. */
  readonly #attemptedAt = new Map<ListKey, number>()
  readonly #digests = new Map<ListKey, string>()
  readonly #refreshing = new Map<ListKey, Promise<void>>()

  constructor(deps: VersionsDeps) {
    this.#d = deps
    this.#now = deps.now ?? Date.now
    this.#interval = deps.refreshIntervalMs ?? 10 * 60_000
  }

  get #versionsDir(): string {
    return path.join(this.#d.layout.minecraft, 'versions')
  }

  // -------------------------------------------------------------------------------------------
  // Remote lists
  // -------------------------------------------------------------------------------------------

  #freshness(key: ListKey, fetchedAt?: number): { fetchedAt: number; stale: boolean } {
    const at = Math.max(fetchedAt ?? 0, this.#fetchedAt.get(key) ?? 0)
    const stale = this.#now() - at >= this.#interval
    if (stale) this.#refreshInBackground(key)
    return { fetchedAt: at, stale }
  }

  /** Revalidate `key` unless that happened (or was attempted) recently. Never rejects. */
  #refreshInBackground(key: ListKey): void {
    if (this.#refreshing.has(key)) return
    const attempted = this.#attemptedAt.get(key) ?? -Infinity
    if (this.#now() - attempted < 60_000) return
    void this.refreshList(key)
  }

  /** Revalidate one list now; emits `versions:changed` when its content changed. Never rejects. */
  refreshList(key: ListKey): Promise<void> {
    const running = this.#refreshing.get(key)
    if (running) return running
    this.#attemptedAt.set(key, this.#now())
    const p = (async () => {
      try {
        const meta = await this.#d.meta()
        const o = { force: true }
        let data: unknown
        if (key === 'minecraft') data = (await meta.minecraftManifest(o)).data
        else if (key === 'fabric' || key === 'quilt') data = await Promise.all([meta.loaderGameVersions(key, o), meta.loaderVersions(key, o)])
        else if (key === 'forge') data = await meta.forgeVersions(undefined, o)
        else data = await meta.neoForgeVersions(undefined, o)
        this.#fetchedAt.set(key, this.#now())
        const d = digest(data)
        const before = this.#digests.get(key)
        this.#digests.set(key, d)
        if (before !== undefined && before !== d) this.#d.emit('versions:changed', { lists: [key] })
      } catch (e) {
        log.warn(`cannot refresh the ${key} version list: ${errorMessage(e)}`)
      } finally {
        this.#refreshing.delete(key)
      }
    })()
    this.#refreshing.set(key, p)
    return p
  }

  async listMinecraft(query: MinecraftVersionQuery = {}): Promise<MinecraftVersionList> {
    const types = new Set<string>(Array.isArray(query?.types) && query.types.length > 0 ? query.types : ['release'])
    const meta = await this.#d.meta()
    const [result, installed] = await Promise.all([meta.minecraftManifest(), this.#completeIds()])
    this.#digests.set('minecraft', this.#digests.get('minecraft') ?? digest(result.data))
    const keep = (t: string) => (t === 'old_beta' || t === 'old_alpha' ? types.has('old') : types.has(t))
    const items: MinecraftVersionRow[] = result.data.versions
      .filter((v) => keep(v.type))
      .map((v) => ({ id: v.id, type: (['release', 'snapshot', 'old_beta', 'old_alpha'].includes(v.type) ? v.type : 'snapshot') as MinecraftVersionType, releaseTime: v.releaseTime, installed: installed.has(v.id) }))
    return { items, latest: { ...result.data.latest }, ...this.#freshness('minecraft', result.stale ? 0 : result.fetchedAt) }
  }

  async listLoaders(loader: LoaderKind, minecraft: string): Promise<LoaderVersionList> {
    if (typeof minecraft !== 'string' || !VERSION_ID.test(minecraft)) throw invalid('A Minecraft version is required')
    const meta = await this.#d.meta()
    let items: LoaderVersionRow[]
    if (loader === 'fabric' || loader === 'quilt') {
      const [games, loaders] = await Promise.all([meta.loaderGameVersions(loader), meta.loaderVersions(loader)])
      this.#digests.set(loader, this.#digests.get(loader) ?? digest([games, loaders]))
      items = games.some((g) => g.version === minecraft) ? loaders.map((l, i) => ({ version: l.version, stable: l.stable, recommended: false, latest: i === 0 })) : []
    } else if (loader === 'forge') {
      const builds = await meta.forgeVersions(minecraft)
      items = builds.map((b) => ({ version: b.version, stable: true, recommended: b.recommended, latest: b.latest }))
    } else if (loader === 'neoforge') {
      const builds = await meta.neoForgeVersions(minecraft)
      items = builds.map((b, i) => ({ version: b.version, stable: !b.prerelease, recommended: false, latest: i === 0 }))
    } else {
      throw invalid(`Unknown loader ${String(loader)}`)
    }
    return { items, ...this.#freshness(loader) }
  }

  async refresh(): Promise<void> {
    await Promise.all((['minecraft', 'fabric', 'quilt', 'forge', 'neoforge'] as const).map((k) => this.refreshList(k)))
    this.#d.emit('versions:changed', { lists: ['minecraft', 'fabric', 'quilt', 'forge', 'neoforge'] })
  }

  // -------------------------------------------------------------------------------------------
  // Installed versions
  // -------------------------------------------------------------------------------------------

  /** Ids with a finished install (`.install-lock`). */
  async #completeIds(): Promise<Set<string>> {
    const names = await readdir(this.#versionsDir).catch(() => [] as string[])
    const done = await Promise.all(names.map(async (n) => ((await stat(path.join(this.#versionsDir, n, '.install-lock')).catch(() => undefined))?.isFile() ? n : undefined)))
    return new Set(done.filter((n): n is string => n !== undefined))
  }

  async #folderSize(dir: string, depth = 0): Promise<number> {
    if (depth > 3) return 0
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const sizes = await Promise.all(
      entries.map(async (e) => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) return this.#folderSize(p, depth + 1)
        if (!e.isFile()) return 0
        return (await stat(p).catch(() => undefined))?.size ?? 0
      }),
    )
    return sizes.reduce((a, b) => a + b, 0)
  }

  async listInstalled(): Promise<InstalledVersionRow[]> {
    const dirents = await readdir(this.#versionsDir, { withFileTypes: true }).catch(() => [])
    const ids = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && VERSION_ID.test(d.name)).map((d) => d.name)
    const jsons = new Map<string, Record<string, unknown>>()
    const rows = await Promise.all(
      ids.map(async (id) => {
        const dir = path.join(this.#versionsDir, id)
        const raw = await readFile(path.join(dir, `${id}.json`), 'utf8').then(
          (t) => asRecord(JSON.parse(t) as unknown),
          () => undefined,
        )
        if (raw) jsons.set(id, raw)
        const [complete, sizeBytes] = await Promise.all([stat(path.join(dir, '.install-lock')).then((s) => s.isFile(), () => false), this.#folderSize(dir)])
        return { id, complete, sizeBytes }
      }),
    )
    const parentOf = (id: string) => readString(jsons.get(id)?.inheritsFrom) ?? null
    const chainOf = (id: string): string[] => {
      const chain: string[] = []
      for (let cur: string | null = id; cur && !chain.includes(cur) && chain.length < 8; cur = parentOf(cur)) chain.push(cur)
      return chain
    }
    // Which installed versions each instance needs (its version and every parent).
    const usedBy = new Map<string, string[]>()
    for (const summary of this.#d.instances.list()) {
      let versionId = ''
      try {
        versionId = this.#d.instances.get(summary.id).versionId
      } catch {
        continue
      }
      if (!versionId) continue
      for (const v of chainOf(versionId)) usedBy.set(v, [...(usedBy.get(v) ?? []), summary.id])
    }
    return rows
      .map(({ id, complete, sizeBytes }): InstalledVersionRow => {
        const chain = chainOf(id)
        const layers = chain.map((v) => jsons.get(v)).filter((j): j is Record<string, unknown> => j !== undefined)
        const runtime = layers.length > 0 ? detectRuntimeFromVersions(layers) : null
        const minecraft = chain.length > 0 && jsons.has(chain.at(-1) as string) ? (readString(jsons.get(chain.at(-1) as string)?.id) ?? (chain.at(-1) as string)) : ''
        let loader: InstalledVersionRow['loader'] = null
        for (const kind of ['forge', 'neoforge', 'fabric', 'quilt'] as const) if (runtime?.[kind]) loader = { kind, version: runtime[kind] as string }
        return {
          id,
          minecraft,
          loader,
          inheritsFrom: parentOf(id),
          complete,
          usedBy: usedBy.get(id) ?? [],
          children: ids.filter((other) => other !== id && parentOf(other) === id),
          sizeBytes,
        }
      })
      .toSorted((a, b) => a.id.localeCompare(b.id))
  }

  async deleteInstalled(id: string): Promise<void> {
    if (typeof id !== 'string' || !VERSION_ID.test(id) || id === '.' || id === '..') throw invalid('Invalid version id')
    const row = (await this.listInstalled()).find((r) => r.id === id)
    if (!row) throw new AppError('ENOT_FOUND', `Version ${id} is not installed`)
    if (row.usedBy.length > 0) throw new AppError('EBUSY', `Version ${id} is used by ${row.usedBy.length} instance(s)`, { usedBy: row.usedBy })
    if (row.children.length > 0) throw new AppError('EBUSY', `Version ${id} is the base of ${row.children.join(', ')}`, { children: row.children })
    if (this.#d.versionInUse?.(id)) throw new AppError('EBUSY', `Version ${id} is being installed or played`)
    await rm(path.join(this.#versionsDir, id), { recursive: true, force: true })
    this.#d.emit('versions:changed', { lists: ['installed', 'minecraft'] })
  }
}

/** The RPC facade. */
export function versionsService(manager: VersionsManager): VersionsService {
  return {
    listMinecraft: (query) => manager.listMinecraft(query),
    listLoaders: (loader, minecraft) => manager.listLoaders(loader, minecraft),
    refresh: () => manager.refresh(),
    listInstalled: () => manager.listInstalled(),
    deleteInstalled: (id) => manager.deleteInstalled(id),
  }
}
