/* oxlint-disable no-await-in-loop -- files are added and toggled one at a time, in order */
/**
 * Instance content: mods, resource packs, shader packs and worlds, plus world backups.
 *
 * Each `(instance, kind)` is a collection of rows kept in memory. The first `list` answers at
 * once from a directory listing joined with the SQLite index (unchanged files come back complete;
 * new ones as `pending`), then a background scan in the worker pool hashes and parses whatever
 * changed and announces it with `resources:changed`. Scans are per instance cancellable and never
 * hold any lock another call waits on: launching, instance edits and other folders proceed while
 * a scan runs. Open instances get one coalescing file watcher (see `watcher.ts`).
 */
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  backupWorld,
  ContentStore,
  deleteBackup,
  isContentFileName,
  isPathInside,
  listBackups,
  PARSER_VERSION,
  pathKey,
  pruneBackups,
  resourcePackId,
  restoreBackup,
  sanitizeFileName,
  scanCacheKey,
  setEnabled as setModEnabled,
  stripDisabled,
  uniqueName,
  withPreferredLoader,
  type BackupInfo,
  type ContentEntry,
  type InstanceLoader,
  type SaveInfo,
  type ScanCacheRecord,
  type WorkerScanOptions,
} from '@amethyst/content'
import { mapLimit } from '@amethyst/task'
import type { BackupRow, BulkResult, HostServices, ResourceDetail, ResourceKind, ResourcePage, ResourceQuery, ResourceRow, ResourcesService, ResourceSource, Settings } from '@shared/services'
import type { Emit } from '../context'
import type { DbClient } from '../db/client'
import type { SourceRow } from '../db/protocol'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import { copyTree } from '../instances/copy'
import { loaderOf } from '../instances/model'
import type { InstanceManager } from '../instances/service'
import type { TaskRegistry } from '../tasks/registry'
import { AppError, errorCode, errorMessage, invalid, isAbortError, notFound } from '../util/errors'
import { readActiveShaderPack, readEnabledPacks, setPacksEnabled, shaderLoaderFor, writeActiveShaderPack } from './game-config'
import type { WorkerPool } from './pool'
import { entryDetail, entryRow, pendingRow, resourceId, rowChanged, saveRow } from './rows'
import { InstanceWatcher, type WatchFactory } from './watcher'
import { iconName, type ResourceWorkerHandlers } from './worker-handlers'

const log = logger('resources')
const KINDS: ReadonlySet<string> = new Set<ResourceKind>(['mods', 'resourcepacks', 'shaderpacks', 'saves'])
const MAX_WATCHED = 4
const MAX_CACHED_INSTANCES = 8
/** Above this many changed rows a `reset` is cheaper than listing ids. */
const RESET_THRESHOLD = 100

interface Item {
  row: ResourceRow
  entry?: ContentEntry
  save?: SaveInfo
}

interface Collection {
  kind: ResourceKind
  dir: string
  items: Map<string, Item>
  revision: number
  /** A quick listing was produced. */
  listed: boolean
  /** A full scan finished at least once. */
  scanned: boolean
  scanning: Promise<void> | undefined
  rescan: boolean
  lastScanAt: number
}

interface InstanceState {
  id: string
  dir: string
  collections: Map<ResourceKind, Collection>
  watcher: InstanceWatcher | undefined
  refs: number
  releaseTimer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController
  lastUsed: number
}

export interface ResourceManagerDeps {
  layout: DataLayout
  emit: Emit
  host: Pick<HostServices, 'trash'>
  instances: Pick<InstanceManager, 'resolve' | 'addHooks'>
  /** The SQLite index; optional so the service degrades to scanning without a cache. */
  db: Pick<DbClient, 'query'> | undefined
  pool: Pick<WorkerPool<ResourceWorkerHandlers>, 'call'>
  tasks: TaskRegistry
  settings: { readonly value: Settings }
  /** True while the game runs from the instance (options.txt and world edits wait). */
  isRunning?: (instanceId: string) => boolean
  watchFactory?: WatchFactory
  debounceMs?: number
  /** Delay before an unwatched instance's watcher stops (default 2 s). */
  releaseGraceMs?: number
  now?: () => number
}

const LOADER_FOR: Record<string, InstanceLoader> = { forge: 'forge', neoforge: 'neoforge', fabric: 'fabric', quilt: 'quilt' }

/** Prefer install provenance, then Modrinth, then CurseForge. */
function pickSource(rows: SourceRow[] | undefined): ResourceSource | null {
  if (!rows || rows.length === 0) return null
  const best = rows.toSorted((a, b) => (a.confidence === 'manifest' ? -1 : 0) - (b.confidence === 'manifest' ? -1 : 0) || (a.platform === 'modrinth' ? -1 : 1))[0] as SourceRow
  return { platform: best.platform, projectId: best.projectId, versionId: best.versionId }
}

function backupRow(info: BackupInfo): BackupRow {
  return {
    id: `${info.world}/${info.id}`,
    world: info.world,
    worldName: info.worldName ?? info.world,
    reason: info.reason,
    automatic: info.automatic,
    createdAt: info.createdAt,
    size: info.size,
    ...(info.versionName ? { versionName: info.versionName } : {}),
  }
}

const SAFE_SEGMENT = /^[^/\\\0]+$/

export class ResourceManager {
  readonly #d: ResourceManagerDeps
  readonly #store: ContentStore
  readonly #states = new Map<string, InstanceState>()
  /** Watch references of instances being moved, restored once the move is done. */
  readonly #movedRefs = new Map<string, number>()
  readonly #now: () => number

  constructor(deps: ResourceManagerDeps) {
    this.#d = deps
    this.#now = deps.now ?? Date.now
    this.#store = new ContentStore(deps.layout.store, { hardLinks: false })
    // Stop watchers and cancel scans before an instance folder moves or goes to the Trash; after a
    // move (rename), watch the new folder for whoever watched the old one.
    deps.instances.addHooks({
      release: async (id) => {
        const refs = this.#states.get(id)?.refs ?? 0
        this.#drop(id)
        if (refs > 0) this.#movedRefs.set(id, refs)
      },
      moved: async (id) => {
        const refs = this.#movedRefs.get(id) ?? 0
        this.#movedRefs.delete(id)
        for (let i = 0; i < refs; i++) await this.watch(id).catch(() => undefined)
      },
    })
  }

  get store(): ContentStore {
    return this.#store
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  #state(instanceId: string): InstanceState {
    const inst = this.#d.instances.resolve(instanceId)
    let st = this.#states.get(instanceId)
    if (st && st.dir !== inst.dir) {
      this.#drop(instanceId)
      st = undefined
    }
    if (!st) {
      st = { id: instanceId, dir: inst.dir, collections: new Map(), watcher: undefined, refs: 0, releaseTimer: undefined, controller: new AbortController(), lastUsed: 0 }
      this.#states.set(instanceId, st)
      this.#evictIdle()
    }
    st.lastUsed = this.#now()
    return st
  }

  #collection(st: InstanceState, kind: ResourceKind): Collection {
    if (!KINDS.has(kind)) throw invalid(`Unknown content kind ${String(kind)}`)
    let col = st.collections.get(kind)
    if (!col) {
      col = { kind, dir: path.join(st.dir, kind), items: new Map(), revision: 0, listed: false, scanned: false, scanning: undefined, rescan: false, lastScanAt: 0 }
      st.collections.set(kind, col)
    }
    return col
  }

  /** Forget an instance's state: stop its watcher and cancel its scans. */
  #drop(instanceId: string): void {
    const st = this.#states.get(instanceId)
    if (!st) return
    st.watcher?.stop()
    if (st.releaseTimer) clearTimeout(st.releaseTimer)
    st.controller.abort(new AppError('ECANCELLED', 'Instance released'))
    this.#states.delete(instanceId)
  }

  /** Bound memory: keep at most a few unwatched instances' rows. */
  #evictIdle(): void {
    const idle = [...this.#states.values()].filter((s) => s.refs === 0 && !s.watcher).toSorted((a, b) => a.lastUsed - b.lastUsed)
    while (this.#states.size > MAX_CACHED_INSTANCES && idle.length > 0) this.#drop((idle.shift() as InstanceState).id)
  }

  // -------------------------------------------------------------------------------------------
  // Listing and scanning
  // -------------------------------------------------------------------------------------------

  async list(instanceId: string, kind: ResourceKind, query: ResourceQuery = {}): Promise<ResourcePage> {
    const st = this.#state(instanceId)
    const col = this.#collection(st, kind)
    if (!col.listed && !col.scanned) await this.#quickList(st, col)
    const stale = !st.watcher && this.#now() - col.lastScanAt > 2000
    if (!col.scanning && (!col.scanned || stale)) void this.#scan(st, col)
    return this.#page(col, query)
  }

  #page(col: Collection, query: ResourceQuery): ResourcePage {
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.min(1000, Math.max(1, Math.trunc(query.limit ?? 200)))
    let rows = [...col.items.values()].map((i) => i.row)
    if (query.enabled !== undefined) rows = rows.filter((r) => r.enabled === query.enabled)
    const search = query.search?.trim().toLowerCase()
    if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search) || r.fileName.toLowerCase().includes(search) || r.authors.some((a) => a.toLowerCase().includes(search)))
    const sort = query.sort ?? 'name'
    const by: Record<NonNullable<ResourceQuery['sort']>, (a: ResourceRow, b: ResourceRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.fileName.localeCompare(b.fileName),
      fileName: (a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }),
      modified: (a, b) => b.mtimeMs - a.mtimeMs,
      size: (a, b) => b.size - a.size,
    }
    rows = rows.toSorted(by[sort] ?? by.name)
    return { items: rows.slice(offset, offset + limit), total: rows.length, scanning: col.scanning !== undefined, revision: col.revision }
  }

  async #records(dir: string): Promise<[string, ScanCacheRecord][]> {
    if (!this.#d.db) return []
    try {
      return (await this.#d.db.query('placements.listDir', { dir: pathKey(path.resolve(dir)) })) as [string, ScanCacheRecord][]
    } catch (e) {
      log.warn(`index unavailable, scanning ${dir} without cache: ${errorMessage(e)}`)
      return []
    }
  }

  async #sources(sha1s: string[]): Promise<Map<string, SourceRow[]>> {
    const map = new Map<string, SourceRow[]>()
    if (!this.#d.db || sha1s.length === 0) return map
    const rows = await this.#d.db.query('sources.get', { sha1s }).catch(() => [] as SourceRow[])
    for (const r of rows) map.set(r.sha1, [...(map.get(r.sha1) ?? []), r])
    return map
  }

  #preferLoader(st: InstanceState): InstanceLoader {
    const loader = loaderOf(this.#d.instances.resolve(st.id).config.runtime)
    return loader ? (LOADER_FOR[loader.kind] ?? 'vanilla') : 'vanilla'
  }

  /** Instant listing: directory entries joined with cached index records; unknown files are `pending`. */
  async #quickList(st: InstanceState, col: Collection): Promise<void> {
    col.listed = true
    const dirents = await readdir(col.dir, { withFileTypes: true }).catch(() => [])
    const next = new Map<string, Item>()
    if (col.kind === 'saves') {
      for (const d of dirents) {
        if (d.name.startsWith('.') || !(d.isDirectory() || d.isSymbolicLink())) continue
        const id = resourceId(d.name, 'saves')
        next.set(id, { row: { ...pendingRow(id, 'saves', d.name, { size: 0, mtimeMs: 0, isDirectory: true, enabled: true }), name: d.name } })
      }
      col.items = next
      return
    }
    const kind = col.kind
    const records = new Map(await this.#records(col.dir))
    const enabledPacks = kind === 'resourcepacks' ? new Set(await readEnabledPacks(st.dir)) : undefined
    const activeShader = kind === 'shaderpacks' ? await readActiveShaderPack(st.dir) : undefined
    const prefer = this.#preferLoader(st)
    const listed = await mapLimit(dirents, 32, async (d) => {
      const p = path.join(col.dir, d.name)
      const s = await stat(p).catch(() => undefined)
      if (!s || !(s.isFile() || s.isDirectory()) || !isContentFileName(d.name, kind, s.isDirectory())) return undefined
      return { name: d.name, path: p, st: s }
    })
    const sha1s: string[] = []
    const items: { id: string; entry?: ContentEntry; pending?: ResourceRow; icon?: string }[] = []
    for (const l of listed.filter((x) => x !== undefined).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const id = this.#uniqueId(items.map((i) => i.id), resourceId(l.name, kind))
      const enabled = kind === 'mods' ? stripDisabled(l.name) === l.name : kind === 'resourcepacks' ? (enabledPacks?.has(resourcePackId(l.name)) ?? false) : activeShader === l.name
      const record = records.get(scanCacheKey(l.path))
      if (record && record.size === l.st.size && record.mtimeMs === l.st.mtimeMs && record.ino === l.st.ino && record.parserVersion === PARSER_VERSION) {
        const entry: ContentEntry = {
          path: l.path,
          fileName: l.name,
          baseName: kind === 'mods' ? stripDisabled(l.name) : l.name,
          kind,
          isDirectory: l.st.isDirectory(),
          enabled,
          size: l.st.size,
          mtimeMs: l.st.mtimeMs,
          ino: l.st.ino,
          cached: true,
          ...(record.hashes ? { hashes: record.hashes } : {}),
          ...(record.mod ? { mod: withPreferredLoader(record.mod, prefer) } : {}),
          ...(record.resourcePack ? { resourcePack: record.resourcePack, packId: resourcePackId(l.name) } : {}),
          ...(record.shaderPack ? { shaderPack: record.shaderPack } : {}),
          ...(record.problem ? { problem: record.problem } : {}),
        }
        const rel = entry.mod?.icon ?? entry.resourcePack?.icon
        if (entry.hashes?.sha1) sha1s.push(entry.hashes.sha1)
        items.push({ id, entry, ...(rel && !entry.problem ? { icon: iconName(entry, rel) } : {}) })
      } else {
        items.push({ id, pending: pendingRow(id, kind, l.name, { size: l.st.size, mtimeMs: l.st.mtimeMs, isDirectory: l.st.isDirectory(), enabled }) })
      }
    }
    const sources = await this.#sources(sha1s)
    for (const i of items) {
      if (i.entry) next.set(i.id, { entry: i.entry, row: entryRow(i.id, i.entry, { ...(i.icon ? { iconFile: i.icon } : {}), source: pickSource(sources.get(i.entry.hashes?.sha1 ?? '')) }) })
      else if (i.pending) next.set(i.id, { row: i.pending })
    }
    col.items = next
  }

  #uniqueId(taken: Iterable<string>, id: string): string {
    const set = new Set(taken)
    let out = id
    for (let n = 2; set.has(out); n++) out = `${id}#${n}`
    return out
  }

  /** Run (or queue behind the running one) a full scan of a collection. */
  #scan(st: InstanceState, col: Collection): Promise<void> {
    if (col.scanning) {
      col.rescan = true
      return col.scanning
    }
    const signal = st.controller.signal
    this.#d.emit('resources:scan', { instanceId: st.id, kind: col.kind, scanning: true })
    const run = (async () => {
      try {
        do {
          col.rescan = false
          await this.#scanOnce(st, col, signal)
        } while (col.rescan && !signal.aborted)
      } catch (e) {
        if (!isAbortError(e) && !signal.aborted) log.warn(`scan of ${col.dir} failed: ${errorMessage(e)}`)
      } finally {
        col.scanning = undefined
        col.lastScanAt = this.#now()
        this.#d.emit('resources:scan', { instanceId: st.id, kind: col.kind, scanning: false })
      }
    })()
    col.scanning = run
    return run
  }

  async #scanOnce(st: InstanceState, col: Collection, signal: AbortSignal): Promise<void> {
    const iconsDir = this.#d.layout.icons
    if (col.kind === 'saves') {
      const res = await this.#d.pool.call('scanSaves', { savesDir: col.dir, iconsDir }, signal)
      if (signal.aborted) return
      const next = new Map<string, Item>()
      for (const save of res.saves.toSorted((a, b) => (a.folderName < b.folderName ? -1 : 1))) {
        const id = this.#uniqueId(next.keys(), resourceId(save.folderName, 'saves'))
        const mtime = (await stat(path.join(save.path, 'level.dat')).catch(() => undefined))?.mtimeMs ?? 0
        next.set(id, { save, row: saveRow(id, save, mtime) })
      }
      this.#commit(st, col, next)
      return
    }
    const kind = col.kind
    const records = await this.#records(col.dir)
    const options: WorkerScanOptions = { hashes: ['sha1'], concurrency: 8, preferLoader: this.#preferLoader(st) }
    if (kind === 'resourcepacks') options.enabledPacks = await readEnabledPacks(st.dir)
    if (kind === 'shaderpacks') options.activeShaderPack = await readActiveShaderPack(st.dir)
    const res = await this.#d.pool.call('scanFolder', { dir: col.dir, kind, options, records, iconsDir }, signal)
    if (signal.aborted) return
    if (this.#d.db && (res.upserts.length > 0 || res.deletes.length > 0)) {
      await this.#d.db
        .query('placements.apply', { dir: pathKey(path.resolve(col.dir)), upserts: res.upserts, deletes: res.deletes, now: this.#now() })
        .catch((e: unknown) => log.warn(`cannot update the index for ${col.dir}: ${errorMessage(e)}`))
    }
    const sources = await this.#sources(res.result.entries.flatMap((e) => (e.hashes?.sha1 ? [e.hashes.sha1] : [])))
    const next = new Map<string, Item>()
    for (const entry of res.result.entries) {
      const id = this.#uniqueId(next.keys(), resourceId(entry.fileName, kind))
      const iconFile = res.icons[entry.path]
      next.set(id, { entry, row: entryRow(id, entry, { ...(iconFile ? { iconFile } : {}), source: pickSource(sources.get(entry.hashes?.sha1 ?? '')) }) })
    }
    this.#commit(st, col, next)
  }

  /** Replace a collection's rows and announce what changed. */
  #commit(st: InstanceState, col: Collection, next: Map<string, Item>): void {
    const changed: string[] = []
    const removed: string[] = []
    for (const [id, item] of next) if (rowChanged(col.items.get(id)?.row, item.row)) changed.push(id)
    for (const id of col.items.keys()) if (!next.has(id)) removed.push(id)
    col.items = next
    col.scanned = true
    col.listed = true
    if (changed.length === 0 && removed.length === 0) return
    col.revision++
    const reset = changed.length + removed.length > RESET_THRESHOLD
    this.#d.emit('resources:changed', { instanceId: st.id, kind: col.kind, revision: col.revision, changed: reset ? [] : changed, removed: reset ? [] : removed, reset })
  }

  async refresh(instanceId: string, kind: ResourceKind): Promise<void> {
    const st = this.#state(instanceId)
    await this.#scan(st, this.#collection(st, kind))
  }

  async cancelScans(instanceId: string): Promise<void> {
    const st = this.#states.get(instanceId)
    if (!st) return
    st.controller.abort(new AppError('ECANCELLED', 'Scans cancelled'))
    st.controller = new AbortController()
  }

  /** Make sure a collection has been fully scanned, then return it. */
  async #scanned(instanceId: string, kind: ResourceKind): Promise<{ st: InstanceState; col: Collection }> {
    const st = this.#state(instanceId)
    const col = this.#collection(st, kind)
    if (col.scanning) await col.scanning
    if (!col.scanned) await this.#scan(st, col)
    return { st, col }
  }

  async get(instanceId: string, kind: ResourceKind, id: string): Promise<ResourceDetail> {
    const { col } = await this.#scanned(instanceId, kind)
    const item = col.items.get(id)
    if (!item) throw notFound('Resource')
    return entryDetail(item.row, item.entry, item.save)
  }

  // -------------------------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------------------------

  async watch(instanceId: string): Promise<void> {
    const st = this.#state(instanceId)
    st.refs++
    if (st.releaseTimer) clearTimeout(st.releaseTimer)
    st.releaseTimer = undefined
    if (st.watcher) return
    st.watcher = new InstanceWatcher(st.dir, (kinds) => this.#onDirty(st, kinds), {
      ...(this.#d.watchFactory ? { factory: this.#d.watchFactory } : {}),
      ...(this.#d.debounceMs !== undefined ? { debounceMs: this.#d.debounceMs } : {}),
      onError: (e) => log.warn(`watcher error in ${st.dir}: ${e.message}`),
    })
    try {
      st.watcher.start()
    } catch (e) {
      log.warn(`cannot watch ${st.dir}: ${errorMessage(e)}`)
      st.watcher = undefined
      return
    }
    // Revalidate what is already loaded: it may have changed while nobody watched.
    for (const col of st.collections.values()) if (col.listed || col.scanned) void this.#scan(st, col)
    const watched = [...this.#states.values()].filter((s) => s.watcher).toSorted((a, b) => a.lastUsed - b.lastUsed)
    while (watched.length > MAX_WATCHED) {
      const oldest = watched.shift() as InstanceState
      oldest.watcher?.stop()
      oldest.watcher = undefined
      oldest.refs = 0
    }
  }

  async unwatch(instanceId: string): Promise<void> {
    const st = this.#states.get(instanceId)
    if (!st) return
    st.refs = Math.max(0, st.refs - 1)
    if (st.refs > 0 || !st.watcher) return
    if (st.releaseTimer) clearTimeout(st.releaseTimer)
    st.releaseTimer = setTimeout(() => {
      st.releaseTimer = undefined
      if (st.refs === 0) {
        st.watcher?.stop()
        st.watcher = undefined
        this.#evictIdle()
      }
    }, this.#d.releaseGraceMs ?? 2000)
    st.releaseTimer.unref?.()
  }

  #onDirty(st: InstanceState, kinds: ResourceKind[]): void {
    if (this.#states.get(st.id) !== st) return
    for (const kind of kinds) {
      const col = st.collections.get(kind)
      // Folders nobody listed yet are scanned when they are first listed.
      if (!col || !(col.listed || col.scanned)) continue
      // The game rewrites level.dat on every autosave: re-read worlds after it exits.
      if (kind === 'saves' && this.#d.isRunning?.(st.id)) {
        col.lastScanAt = 0
        continue
      }
      void this.#scan(st, col)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------------------------

  #inside(col: Collection, p: string): void {
    if (!isPathInside(col.dir, p) || path.resolve(p) === path.resolve(col.dir)) throw new AppError('EINVALID_ARGUMENT', 'The file is outside the instance folder')
  }

  async setEnabled(instanceId: string, kind: ResourceKind, ids: string[], enabled: boolean): Promise<BulkResult> {
    if (!Array.isArray(ids)) throw invalid('ids must be a list')
    const { st, col } = await this.#scanned(instanceId, kind)
    const result: BulkResult = { done: [], failed: [] }
    const items = ids.map((id) => ({ id, item: col.items.get(id) }))
    for (const { id, item } of items) if (!item) result.failed.push({ id, code: 'ENOT_FOUND', message: 'Not found' })
    const found = items.filter((x): x is { id: string; item: Item } => x.item !== undefined)

    if (kind === 'saves') throw invalid('Worlds cannot be disabled')
    if (kind === 'mods') {
      for (const { id, item } of found) {
        try {
          this.#inside(col, item.entry?.path ?? '')
          await setModEnabled(item.entry?.path ?? '', enabled, { onConflict: 'rename' })
          result.done.push(id)
        } catch (e) {
          result.failed.push({ id, code: errorCode(e) ?? 'EFAILED', message: errorMessage(e) })
        }
      }
    } else {
      if (this.#d.isRunning?.(instanceId)) throw new AppError('EBUSY', 'Quit the game first: it rewrites its options when it exits')
      if (kind === 'resourcepacks') {
        await setPacksEnabled(st.dir, found.map(({ item }) => resourcePackId(item.row.fileName)), enabled)
        result.done.push(...found.map((f) => f.id))
      } else {
        if (enabled && found.length !== 1) throw invalid('Only one shader pack can be active')
        const mods = await this.#scanned(instanceId, 'mods')
        const modIds = [...mods.col.items.values()].filter((i) => i.row.enabled).flatMap((i) => (i.entry?.mod?.id ? [i.entry.mod.id] : []))
        const loader = shaderLoaderFor(modIds)
        if (!loader) throw new AppError('ENO_SHADER_LOADER', 'No shader mod is installed: add Iris (Fabric, Quilt, NeoForge) or Oculus (Forge)')
        await writeActiveShaderPack(st.dir, loader, enabled ? (found[0]?.item.row.fileName ?? null) : null)
        result.done.push(...found.map((f) => f.id))
      }
    }
    await this.#scan(st, col)
    return result
  }

  async delete(instanceId: string, kind: ResourceKind, ids: string[]): Promise<BulkResult> {
    if (!Array.isArray(ids)) throw invalid('ids must be a list')
    const { st, col } = await this.#scanned(instanceId, kind)
    if (kind === 'saves' && this.#d.isRunning?.(instanceId)) throw new AppError('EBUSY', 'Quit the game before deleting worlds')
    const result: BulkResult = { done: [], failed: [] }
    for (const id of ids) {
      const item = col.items.get(id)
      const target = item?.entry?.path ?? item?.save?.path
      if (!item || !target) {
        result.failed.push({ id, code: 'ENOT_FOUND', message: 'Not found' })
        continue
      }
      try {
        this.#inside(col, target)
        await this.#d.host.trash(target)
        result.done.push(id)
      } catch (e) {
        result.failed.push({ id, code: errorCode(e) ?? 'ETRASH_FAILED', message: errorMessage(e) })
      }
    }
    // Revalidate either way, so the UI shows reality even after a failure.
    await this.#scan(st, col)
    return result
  }

  async add(instanceId: string, kind: ResourceKind, paths: string[]): Promise<BulkResult> {
    if (!Array.isArray(paths)) throw invalid('paths must be a list')
    const { st, col } = await this.#scanned(instanceId, kind)
    await mkdir(col.dir, { recursive: true })
    const result: BulkResult = { done: [], failed: [] }
    const knownHashes = new Set([...col.items.values()].flatMap((i) => (i.row.sha1 ? [i.row.sha1] : [])))
    await this.#d.tasks.runAndWait({ name: 'resources.add', params: { kind, count: paths.length }, instanceId }, async (ctx) => {
      ctx.update(0, paths.length)
      for (const source of paths) {
        ctx.throwIfAborted()
        const label = typeof source === 'string' ? source : String(source)
        try {
          if (typeof source !== 'string' || !path.isAbsolute(source)) throw invalid('An absolute path is required')
          const s = await lstat(source)
          if (kind === 'saves') {
            const world = await this.#d.pool.call('importWorld', { source, savesDir: col.dir }, ctx.signal)
            result.done.push(resourceId(world.folderName, 'saves'))
          } else if (s.isDirectory()) {
            if (kind === 'mods') throw new AppError('EUNSUPPORTED_FILE', 'Mods must be .jar files')
            const name = await uniqueName(col.dir, sanitizeFileName(path.basename(source), 'pack'), { extension: false })
            const { failed } = await copyTree(source, path.join(col.dir, name), { signal: ctx.signal })
            if (failed.length > 0) log.warn(`some files of ${source} were not copied`, failed)
            result.done.push(resourceId(name, kind))
          } else if (s.isFile()) {
            const base = sanitizeFileName(path.basename(source), 'file')
            if (!isContentFileName(base, kind, false)) throw new AppError('EUNSUPPORTED_FILE', kind === 'mods' ? 'Mods must be .jar files' : 'Packs must be .zip files')
            const ingested = await this.#d.pool.call('ingest', { storeRoot: this.#store.root, source }, ctx.signal)
            if (knownHashes.has(ingested.sha1)) {
              // The identical file is already there.
              result.done.push([...col.items.values()].find((i) => i.row.sha1 === ingested.sha1)?.row.id ?? resourceId(base, kind))
            } else {
              const name = await uniqueName(col.dir, base)
              await this.#store.place(ingested.sha1, path.join(col.dir, name), { signal: ctx.signal })
              knownHashes.add(ingested.sha1)
              result.done.push(resourceId(name, kind))
            }
          } else {
            throw new AppError('EUNSUPPORTED_FILE', 'Not a file or folder')
          }
        } catch (e) {
          if (isAbortError(e)) throw e
          result.failed.push({ id: label, code: errorCode(e) ?? 'EFAILED', message: errorMessage(e) })
        }
        ctx.advance(1)
      }
    })
    await this.#scan(st, col)
    return result
  }

  async addFromInstance(instanceId: string, kind: ResourceKind, fromInstanceId: string, ids: string[]): Promise<BulkResult> {
    if (fromInstanceId === instanceId) throw invalid('Choose another instance')
    const { col } = await this.#scanned(fromInstanceId, kind)
    const paths: string[] = []
    const missing: BulkResult['failed'] = []
    for (const id of ids) {
      const item = col.items.get(id)
      const p = item?.entry?.path ?? item?.save?.path
      if (p) paths.push(p)
      else missing.push({ id, code: 'ENOT_FOUND', message: 'Not found' })
    }
    const result = await this.add(instanceId, kind, paths)
    return { done: result.done, failed: [...missing, ...result.failed] }
  }

  // -------------------------------------------------------------------------------------------
  // World backups
  // -------------------------------------------------------------------------------------------

  #backupsDir(instanceId: string): string {
    if (!SAFE_SEGMENT.test(instanceId) || instanceId.startsWith('.')) throw invalid('Bad instance id')
    return path.join(this.#d.layout.backups, instanceId)
  }

  async #backupInfo(instanceId: string, backupId: string): Promise<BackupInfo> {
    const parts = typeof backupId === 'string' ? backupId.split('/') : []
    const [world, stamp] = parts
    if (parts.length !== 2 || !world || !stamp || !SAFE_SEGMENT.test(world) || !SAFE_SEGMENT.test(stamp) || world.startsWith('.') || stamp.startsWith('.')) throw invalid('Bad backup id')
    const info = (await listBackups(this.#backupsDir(instanceId), world)).find((b) => b.id === stamp)
    if (!info || !isPathInside(this.#d.layout.backups, info.path)) throw notFound('Backup')
    return info
  }

  async createBackup(instanceId: string, worldId: string): Promise<BackupRow> {
    const { col } = await this.#scanned(instanceId, 'saves')
    const save = col.items.get(worldId)?.save
    if (!save) throw notFound('World')
    const dir = this.#backupsDir(instanceId)
    const info = await this.#d.tasks.runAndWait({ name: 'resources.backup', params: { world: save.level.levelName ?? save.folderName }, instanceId }, (ctx) =>
      backupWorld(save.path, dir, { ctx, reason: 'manual' }),
    )
    await pruneBackups(dir, { keep: this.#d.settings.value.backups.keep, world: info.world }).catch((e: unknown) => log.warn('cannot prune backups', e))
    return backupRow(info)
  }

  async listBackups(instanceId: string, worldId?: string): Promise<BackupRow[]> {
    let world: string | undefined
    if (worldId !== undefined) {
      const { col } = await this.#scanned(instanceId, 'saves')
      world = col.items.get(worldId)?.save?.folderName ?? worldId
      if (!SAFE_SEGMENT.test(world)) throw invalid('Bad world id')
    }
    return (await listBackups(this.#backupsDir(instanceId), world)).map(backupRow)
  }

  async restoreBackup(instanceId: string, backupId: string, mode: 'copy' | 'replace' = 'copy'): Promise<{ worldId: string }> {
    if (this.#d.isRunning?.(instanceId)) throw new AppError('EBUSY', 'Quit the game before restoring a world')
    const info = await this.#backupInfo(instanceId, backupId)
    const { st, col } = await this.#scanned(instanceId, 'saves')
    const restored = await this.#d.tasks.runAndWait({ name: 'resources.restore', params: { world: info.worldName ?? info.world }, instanceId }, (ctx) =>
      restoreBackup(info, col.dir, { ctx, mode: mode === 'replace' ? 'replace' : 'copy', disposePrevious: (dir) => this.#d.host.trash(dir) }),
    )
    await this.#scan(st, col)
    return { worldId: resourceId(restored.folderName, 'saves') }
  }

  async deleteBackup(instanceId: string, backupId: string): Promise<void> {
    await deleteBackup(await this.#backupInfo(instanceId, backupId))
  }

  async pruneBackups(instanceId: string, keep?: number): Promise<string[]> {
    const n = keep === undefined ? this.#d.settings.value.backups.keep : Math.trunc(keep)
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw invalid('keep must be between 0 and 1000')
    return (await pruneBackups(this.#backupsDir(instanceId), { keep: n })).map((b) => `${b.world}/${b.id}`)
  }

  // -------------------------------------------------------------------------------------------
  // For other services (marketplace, launch)
  // -------------------------------------------------------------------------------------------

  /** Scanned rows of a folder with their files, for update checks and attribution. */
  async items(instanceId: string, kind: ResourceKind): Promise<{ dir: string; items: { row: ResourceRow; path: string; entry?: ContentEntry }[] }> {
    const { col } = await this.#scanned(instanceId, kind)
    return { dir: col.dir, items: [...col.items.values()].flatMap((i) => (i.entry ? [{ row: i.row, path: i.entry.path, entry: i.entry }] : [])) }
  }

  /** `platform:projectId` keys of every attributed row already in memory (never triggers a scan). */
  knownSources(instanceId: string): Set<string> {
    const out = new Set<string>()
    for (const col of this.#states.get(instanceId)?.collections.values() ?? []) {
      for (const item of col.items.values()) if (item.row.source) out.add(`${item.row.source.platform}:${item.row.source.projectId}`)
    }
    return out
  }

  /** Re-read attribution for a folder's rows from the index (after a hash lookup or install). */
  async refreshSources(instanceId: string, kind: ResourceKind): Promise<void> {
    const st = this.#states.get(instanceId)
    const col = st?.collections.get(kind)
    if (!st || !col) return
    const sources = await this.#sources([...col.items.values()].flatMap((i) => (i.row.sha1 ? [i.row.sha1] : [])))
    const next = new Map<string, Item>()
    for (const [id, item] of col.items) next.set(id, { ...item, row: { ...item.row, source: pickSource(sources.get(item.row.sha1 ?? '')) ?? item.row.source } })
    this.#commit(st, col, next)
  }

  /** Rescan a folder now and wait for it (after an install). */
  async rescan(instanceId: string, kind: ResourceKind): Promise<void> {
    const st = this.#state(instanceId)
    await this.#scan(st, this.#collection(st, kind))
  }

  /** Stop every watcher and cancel every scan (shutdown). */
  dispose(): void {
    for (const id of this.#states.keys()) this.#drop(id)
  }
}

/** The RPC facade. */
export function resourcesService(manager: ResourceManager): ResourcesService {
  return {
    list: (i, k, q) => manager.list(i, k, q),
    get: (i, k, id) => manager.get(i, k, id),
    watch: (i) => manager.watch(i),
    unwatch: (i) => manager.unwatch(i),
    refresh: (i, k) => manager.refresh(i, k),
    cancelScans: (i) => manager.cancelScans(i),
    setEnabled: (i, k, ids, e) => manager.setEnabled(i, k, ids, e),
    delete: (i, k, ids) => manager.delete(i, k, ids),
    add: (i, k, paths) => manager.add(i, k, paths),
    addFromInstance: (i, k, from, ids) => manager.addFromInstance(i, k, from, ids),
    createBackup: (i, w) => manager.createBackup(i, w),
    listBackups: (i, w) => manager.listBackups(i, w),
    restoreBackup: (i, b, m) => manager.restoreBackup(i, b, m),
    deleteBackup: (i, b) => manager.deleteBackup(i, b),
    pruneBackups: (i, k) => manager.pruneBackups(i, k),
  }
}
