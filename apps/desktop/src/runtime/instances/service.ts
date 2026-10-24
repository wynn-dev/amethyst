/* oxlint-disable no-await-in-loop -- folder moves and icon cleanup are sequential by nature */
/**
 * The instance index and every instance operation (instances spec §4–§6).
 *
 * Boot reads `instances.json` (external instances) and every `instances/<folder>/.amethyst/
 * instance.json` in parallel. Each instance has a stable id stored in its own metadata, so renames
 * and folder moves never change how the UI refers to it. All mutations of one instance are
 * serialised by a per-instance mutex; delete rejects queued work and cancels running tasks first.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isPathInside, pathKey, samePath, uniqueName } from '@amethyst/content'
import { mapLimit } from '@amethyst/task'
import { assetUrl } from '@shared/paths'
import type {
  CreateInstanceInput,
  DeleteInstanceOptions,
  DeleteInstanceResult,
  FolderCheck,
  HostServices,
  IconSource,
  ImportCandidate,
  ImportInstanceInput,
  InstanceActivity,
  InstanceDetail,
  InstancePatch,
  InstanceRuntime,
  InstancesService,
  InstanceState,
  InstanceSummary,
} from '@shared/services'
import type { Emit } from '../context'
import { relativeToRoot, type DataLayout } from '../layout'
import { logger } from '../log'
import { JsonDocument } from '../store/json-store'
import type { TaskRegistry } from '../tasks/registry'
import { AppError, errorCode, invalid, notFound } from '../util/errors'
import { decodeDataUrl, importMediaBytes, importMediaFile } from '../util/media'
import { KeyedMutex } from '../util/mutex'
import { asRecord, isRecord, readString } from '../util/parse'
import { copyTree } from './copy'
import {
  applyInstancePatch,
  detectRuntimeFromVersions,
  emptyRuntime,
  folderNameFor,
  generatedName,
  INSTANCE_SCHEMA_VERSION,
  loaderOf,
  parseInstanceConfig,
  parseOverrides,
  parseUpstream,
  uniqueDisplayName,
  validateName,
  validateRuntime,
  type InstanceConfig,
} from './model'

const log = logger('instances')
const MAX_ICON_BYTES = 8 * 1024 * 1024

/** Never copied when duplicating: launcher scratch space, logs and shared game files of imported folders. */
const DUPLICATE_EXCLUDES = ['.amethyst/staging', '.amethyst/backups', 'logs', 'crash-reports', 'versions', 'libraries', 'assets']
/** Also skipped when copying a `.minecraft`-style folder in: launcher state of other launchers. */
const IMPORT_EXCLUDES = [
  ...DUPLICATE_EXCLUDES,
  'runtime',
  'webcache2',
  'launcher_profiles.json',
  'launcher_accounts.json',
  'launcher_accounts_microsoft_store.json',
  'launcher_msa_credentials.bin',
  'launcher_settings.json',
  'launcher_ui_state.json',
  'launcher_entitlements.json',
  'launcher_product_state.json',
  'launcher_gamer_pics.json',
  'launcher_skins.json',
  'launcher_log.txt',
  'usercache.json',
  'usernamecache.json',
  'treatment_tags.json',
]

/** Hooks other services register to react to instances moving or disappearing. */
export interface InstanceHooks {
  /** Stop watchers and cancel scans for the instance (it is about to be moved or deleted). */
  release?(id: string, dir: string): Promise<void>
  /** Forget cached data of a deleted instance folder (also called with the old folder after a move). */
  removed?(id: string, dir: string): Promise<void>
  /** The instance folder was moved (renamed); `release` was called before. */
  moved?(id: string, from: string, to: string): Promise<void>
  /** True while the game runs from this instance or an install writes into it. */
  isBusy?(id: string): boolean
}

/** A resolved, usable instance (for other services). */
export interface ResolvedInstance {
  id: string
  dir: string
  external: boolean
  config: InstanceConfig
}

interface Entry {
  id: string
  dir: string
  external: boolean
  state: InstanceState
  doc: JsonDocument<InstanceConfig> | undefined
  config: InstanceConfig
  iconUrl: string | null
}

interface RegistryDoc {
  external: { id: string; path: string; name: string }[]
}

export interface InstanceManagerDeps {
  layout: DataLayout
  emit: Emit
  host: Pick<HostServices, 'trash'>
  tasks: TaskRegistry
  /** Download an icon from an `https:` URL. */
  fetchBytes?: (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<Uint8Array>
  now?: () => number
}

const metaPath = (dir: string) => path.join(dir, '.amethyst', 'instance.json')

/** A stable id for metadata that lacks one (derived from the folder, so it survives restarts). */
const fallbackId = (dir: string) => `i-${createHash('sha1').update(pathKey(path.resolve(dir))).digest('hex').slice(0, 20)}`

function newConfig(id: string, name: string, runtime: InstanceRuntime, now: number): InstanceConfig {
  return {
    id,
    name,
    author: '',
    description: '',
    icon: '',
    homepageUrl: '',
    runtime,
    versionId: '',
    overrides: {},
    upstream: null,
    createdAt: now,
    lastOpenedAt: now,
    lastPlayedAt: 0,
    playTimeMs: 0,
  }
}

function instanceDoc(dir: string, fallback: { id: string; name: string }): JsonDocument<InstanceConfig> {
  return new JsonDocument<InstanceConfig>(
    metaPath(dir),
    {
      version: INSTANCE_SCHEMA_VERSION,
      parse: (raw) => parseInstanceConfig(raw, fallback),
      defaults: () => newConfig(fallback.id, fallback.name, emptyRuntime(), 0),
      serialize: (c) => c as unknown as Record<string, unknown>,
    },
    { onCorrupt: 'keep' },
  )
}

const p2 = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => {
  const p = p2
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

export class InstanceManager {
  readonly #layout: DataLayout
  readonly #emit: Emit
  readonly #host: Pick<HostServices, 'trash'>
  readonly #tasks: TaskRegistry
  readonly #fetchBytes: InstanceManagerDeps['fetchBytes']
  readonly #now: () => number
  readonly #entries = new Map<string, Entry>()
  readonly #locks = new KeyedMutex()
  readonly #hooks: InstanceHooks[] = []
  readonly #registry: JsonDocument<RegistryDoc>
  /** Live activity per instance (installs, launches); absent means `idle`. */
  readonly #activity = new Map<string, Exclude<InstanceActivity, 'idle'>>()

  constructor(deps: InstanceManagerDeps) {
    this.#layout = deps.layout
    this.#emit = deps.emit
    this.#host = deps.host
    this.#tasks = deps.tasks
    this.#fetchBytes = deps.fetchBytes
    this.#now = deps.now ?? Date.now
    this.#registry = new JsonDocument<RegistryDoc>(deps.layout.registry, {
      version: 1,
      parse: (raw) => ({
        external: (Array.isArray(raw.external) ? raw.external : []).flatMap((e) => {
          const o = asRecord(e)
          const p = readString(o.path)
          if (!p || !path.isAbsolute(p)) return []
          return [{ id: readString(o.id) ?? fallbackId(p), path: p, name: readString(o.name) ?? path.basename(p) }]
        }),
      }),
      defaults: () => ({ external: [] }),
      serialize: (r) => r as unknown as Record<string, unknown>,
    })
  }

  addHooks(hooks: InstanceHooks): void {
    this.#hooks.push(hooks)
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  /** Load the index (boot). Unreadable instances are listed as `broken`, unreachable external ones as `missing`. */
  async load(): Promise<number> {
    await this.#registry.load()
    await mkdir(this.#layout.instances, { recursive: true })
    const dirents = await readdir(this.#layout.instances, { withFileTypes: true }).catch(() => [])
    const items = [
      ...dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => ({ dir: path.join(this.#layout.instances, d.name), reg: undefined })),
      ...this.#registry.value.external.map((reg) => ({ dir: reg.path, reg })),
    ]
    const loaded = await mapLimit(items, 16, (item) => this.#loadOne(item.dir, item.reg))
    for (const entry of loaded) {
      if (!entry) continue
      if (this.#entries.has(entry.id)) {
        // A folder copied in Finder carries the same id: give the copy its own.
        if (entry.state !== 'ok' || !entry.doc) continue
        const id = randomUUID()
        entry.config = { ...entry.config, id }
        entry.id = id
        await entry.doc.set(entry.config).catch((e: unknown) => log.warn(`cannot re-id ${entry.dir}`, e))
      }
      this.#entries.set(entry.id, entry)
    }
    return this.#entries.size
  }

  async #loadOne(dir: string, reg: RegistryDoc['external'][number] | undefined): Promise<Entry | undefined> {
    const external = reg !== undefined
    const fallback = { id: reg?.id ?? fallbackId(dir), name: reg?.name ?? path.basename(dir) }
    const placeholder = (state: InstanceState): Entry => ({
      id: fallback.id,
      dir,
      external,
      state,
      doc: undefined,
      config: newConfig(fallback.id, fallback.name, emptyRuntime(), 0),
      iconUrl: null,
    })
    if (external && !(await stat(dir).catch(() => undefined))?.isDirectory()) return placeholder('missing')
    const doc = instanceDoc(dir, fallback)
    try {
      const result = await doc.load()
      if (result.outcome === 'missing' || result.outcome === 'reset') {
        // Managed folders without metadata are not instances; a registered external one lost its metadata.
        return external ? { ...placeholder('broken'), doc } : undefined
      }
      if (result.outcome === 'unreadable') return { ...placeholder('broken'), doc }
      const entry: Entry = { id: result.value.id, dir, external, state: 'ok', doc, config: result.value, iconUrl: null }
      entry.iconUrl = await this.#iconUrl(entry)
      return entry
    } catch (e) {
      log.warn(`cannot load instance at ${dir}`, e)
      return { ...placeholder('broken'), doc }
    }
  }

  async #iconUrl(entry: Entry): Promise<string | null> {
    if (!entry.config.icon) return null
    const abs = path.join(entry.dir, entry.config.icon)
    const st = await stat(abs).catch(() => undefined)
    if (!st?.isFile()) return null
    const version = Math.round(st.mtimeMs)
    const rel = relativeToRoot(this.#layout, abs)
    if (rel) return assetUrl(rel, version)
    // External instance: the asset protocol only serves the data root, so mirror the (small) icon.
    const name = `instance-${entry.id}-${version}${path.extname(abs).toLowerCase()}`
    const mirror = path.join(this.#layout.icons, name)
    if (!(await stat(mirror).catch(() => undefined))) {
      await mkdir(this.#layout.icons, { recursive: true })
      for (const old of await readdir(this.#layout.icons).catch(() => [] as string[])) {
        if (old.startsWith(`instance-${entry.id}-`)) await rm(path.join(this.#layout.icons, old), { force: true })
      }
      await copyFile(abs, mirror).catch(() => undefined)
    }
    return assetUrl(`cache/icons/${name}`)
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  #summary(e: Entry): InstanceSummary {
    return {
      id: e.id,
      name: e.config.name,
      state: e.state,
      activity: this.#activity.get(e.id) ?? 'idle',
      iconUrl: e.iconUrl,
      minecraft: e.config.runtime.minecraft,
      loader: loaderOf(e.config.runtime),
      external: e.external,
      createdAt: e.config.createdAt,
      lastOpenedAt: e.config.lastOpenedAt,
      lastPlayedAt: e.config.lastPlayedAt,
      playTimeMs: e.config.playTimeMs,
    }
  }

  #detail(e: Entry): InstanceDetail {
    const c = structuredClone(e.config)
    return {
      ...this.#summary(e),
      path: e.dir,
      author: c.author,
      description: c.description,
      homepageUrl: c.homepageUrl,
      runtime: c.runtime,
      versionId: c.versionId,
      overrides: c.overrides,
      upstream: c.upstream,
    }
  }

  list(): InstanceSummary[] {
    return [...this.#entries.values()]
      .map((e) => this.#summary(e))
      .toSorted((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name))
  }

  get(id: string): InstanceDetail {
    return this.#detail(this.#entry(id))
  }

  /** A usable instance, for other services. Rejects missing and broken ones with `EINSTANCE_UNAVAILABLE`. */
  resolve(id: string): ResolvedInstance {
    const e = this.#entry(id)
    if (e.state !== 'ok') throw new AppError('EINSTANCE_UNAVAILABLE', `“${e.config.name}” is ${e.state === 'missing' ? 'not reachable' : 'damaged'}`, { state: e.state })
    return { id: e.id, dir: e.dir, external: e.external, config: e.config }
  }

  #entry(id: string): Entry {
    const e = typeof id === 'string' ? this.#entries.get(id) : undefined
    if (!e) throw notFound('Instance')
    return e
  }

  #usable(id: string): Entry & { doc: JsonDocument<InstanceConfig> } {
    this.resolve(id)
    return this.#entry(id) as Entry & { doc: JsonDocument<InstanceConfig> }
  }

  #names(except?: string): string[] {
    return [...this.#entries.values()].filter((e) => e.id !== except).map((e) => e.config.name)
  }

  #isBusy(id: string): boolean {
    return this.#hooks.some((h) => h.isBusy?.(id) === true)
  }

  async #release(id: string, dir: string): Promise<void> {
    await Promise.allSettled(this.#hooks.map((h) => h.release?.(id, dir)))
  }

  #changed(change: { added?: string[]; updated?: string[]; removed?: string[] }): void {
    this.#emit('instances:changed', { added: change.added ?? [], updated: change.updated ?? [], removed: change.removed ?? [] })
  }

  // -------------------------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------------------------

  /** Run `fn` under the instance's lock; persist and announce the config it returns. */
  async #mutate(id: string, fn: (entry: Entry & { doc: JsonDocument<InstanceConfig> }) => Promise<InstanceConfig | undefined>): Promise<InstanceDetail> {
    return this.#locks.run(id, async () => {
      const entry = this.#usable(id)
      const next = await fn(entry)
      if (next && JSON.stringify(next) !== JSON.stringify(entry.config)) {
        await entry.doc.set(next)
        entry.config = next
        entry.iconUrl = await this.#iconUrl(entry)
        this.#changed({ updated: [id] })
      }
      return this.#detail(entry)
    })
  }

  async create(input: CreateInstanceInput): Promise<InstanceDetail> {
    if (!isRecord(input)) throw invalid('Missing instance details')
    const runtime = validateRuntime(input.runtime)
    const base = input.name?.trim() ? validateName(input.name) : generatedName(runtime)
    const name = uniqueDisplayName(base, this.#names())
    await mkdir(this.#layout.instances, { recursive: true })
    const folder = await uniqueName(this.#layout.instances, folderNameFor(name), { extension: false })
    const dir = path.join(this.#layout.instances, folder)
    await mkdir(dir)
    try {
      await Promise.all(['mods', 'resourcepacks', 'shaderpacks', '.amethyst'].map((d) => mkdir(path.join(dir, d), { recursive: true })))
      const config = newConfig(randomUUID(), name, runtime, this.#now())
      if (input.author) config.author = String(input.author).slice(0, 10_000)
      if (input.description) config.description = String(input.description).slice(0, 10_000)
      if (input.overrides) config.overrides = parseOverrides(input.overrides)
      if (input.upstream) config.upstream = parseUpstream(input.upstream)
      if (input.icon) {
        try {
          config.icon = await this.#storeIcon(dir, input.icon)
        } catch (e) {
          // The instance is still created without an icon.
          log.warn(`cannot store the icon of ${name}`, e)
        }
      }
      const doc = instanceDoc(dir, { id: config.id, name })
      await doc.load()
      await doc.set(config)
      const entry: Entry = { id: config.id, dir, external: false, state: 'ok', doc, config, iconUrl: null }
      entry.iconUrl = await this.#iconUrl(entry)
      this.#entries.set(entry.id, entry)
      this.#changed({ added: [entry.id] })
      return this.#detail(entry)
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      throw e
    }
  }

  async update(id: string, patch: InstancePatch): Promise<InstanceDetail> {
    if (!isRecord(patch)) throw invalid('The patch must be an object')
    const name: unknown = (patch as InstancePatch).name
    return this.#mutate(id, async (entry) => {
      let next = applyInstancePatch(entry.config, patch)
      if (name !== undefined) next = { ...next, ...(await this.#renameLocked(entry, name as string)) }
      return next
    })
  }

  async rename(id: string, name: string): Promise<InstanceDetail> {
    return this.#mutate(id, async (entry) => ({ ...entry.config, ...(await this.#renameLocked(entry, name)) }))
  }

  /** Rename inside the lock. Moves a managed folder when its new name is free; returns the new name. */
  async #renameLocked(entry: Entry & { doc: JsonDocument<InstanceConfig> }, name: string): Promise<{ name: string }> {
    const display = validateName(name)
    if (display === entry.config.name) return { name: display }
    const taken = this.#names(entry.id)
    if (taken.some((n) => n.normalize('NFC').toLowerCase() === display.normalize('NFC').toLowerCase())) {
      throw new AppError('ENAME_TAKEN', `An instance named “${display}” already exists`, { suggestion: uniqueDisplayName(display, taken) })
    }
    if (entry.external) return { name: display }
    const target = folderNameFor(display)
    const current = path.basename(entry.dir)
    if (target === current) return { name: display }
    if (this.#isBusy(entry.id)) throw new AppError('EBUSY', 'Stop the game or wait for the install to finish before renaming')
    const dest = path.join(this.#layout.instances, target)
    const caseOnly = pathKey(target) === pathKey(current)
    if (!caseOnly && (await lstat(dest).catch(() => undefined))) {
      // Folder name taken: keep the folder, change only the display name.
      log.info(`folder ${target} exists; renaming ${entry.id} without moving it`)
      return { name: display }
    }
    await this.#release(entry.id, entry.dir)
    if (caseOnly) {
      // APFS is case-insensitive: go through a temporary name.
      const tmp = `${dest}.renaming-${randomBytes(4).toString('hex')}`
      await rename(entry.dir, tmp)
      await rename(tmp, dest)
    } else {
      await rename(entry.dir, dest)
    }
    const old = entry.dir
    entry.dir = dest
    entry.doc = instanceDoc(dest, { id: entry.id, name: display })
    await entry.doc.load()
    await Promise.allSettled(this.#hooks.flatMap((h) => [h.removed?.(entry.id, old), h.moved?.(entry.id, old, dest)]))
    return { name: display }
  }

  async duplicate(id: string, name?: string): Promise<InstanceDetail> {
    const source = this.#usable(id)
    const display = uniqueDisplayName(name?.trim() ? validateName(name) : source.config.name, this.#names())
    const folder = await uniqueName(this.#layout.instances, folderNameFor(display), { extension: false })
    const dir = path.join(this.#layout.instances, folder)
    await mkdir(dir)
    try {
      const result = await this.#tasks.runAndWait({ name: 'instances.duplicate', params: { name: display, from: source.config.name }, instanceId: id }, (ctx) =>
        copyTree(source.dir, dir, { exclude: DUPLICATE_EXCLUDES, ctx, signal: ctx.signal }),
      )
      if (result.failed.length > 0) log.warn(`duplicate of ${source.config.name}: ${result.failed.length} entries failed`, result.failed)
      const now = this.#now()
      const config: InstanceConfig = { ...structuredClone(source.config), id: randomUUID(), name: display, createdAt: now, lastOpenedAt: now, lastPlayedAt: 0, playTimeMs: 0 }
      const doc = instanceDoc(dir, { id: config.id, name: display })
      await doc.load()
      await doc.set(config)
      const entry: Entry = { id: config.id, dir, external: false, state: 'ok', doc, config, iconUrl: null }
      entry.iconUrl = await this.#iconUrl(entry)
      this.#entries.set(entry.id, entry)
      this.#changed({ added: [entry.id] })
      return this.#detail(entry)
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      throw e
    }
  }

  async delete(id: string, options: DeleteInstanceOptions = {}): Promise<DeleteInstanceResult> {
    const entry = this.#entry(id)
    // A running game or an install writing into the folder is never interrupted by a delete.
    if (this.#isBusy(id)) throw new AppError('EBUSY', 'Stop the game or wait for the install to finish before deleting this instance')
    const lock = this.#locks.get(id)
    // Delete wins over other work: reject queued work and stop running tasks before taking the lock.
    lock.rejectWaiting(new AppError('ECANCELLED', 'The instance is being deleted'))
    await Promise.allSettled([...this.#tasks.cancelForInstance(id), this.#release(id, entry.dir)])
    return lock.run(async () => {
      const e = this.#entry(id)
      if (this.#isBusy(id)) throw new AppError('EBUSY', 'Stop the game before deleting this instance')
      if (e.external) {
        await this.#registry.set({ external: this.#registry.value.external.filter((r) => r.id !== id) })
        this.#entries.delete(id)
        this.#activity.delete(id)
        this.#changed({ removed: [id] })
        return { trashed: false, rescuedWorlds: [] }
      }
      const rescuedWorlds = options.rescueWorlds === false || e.state === 'missing' ? [] : await this.#rescueWorlds(e)
      try {
        await this.#host.trash(e.dir)
      } catch (err) {
        if (errorCode(err) !== 'ENOENT' && (await stat(e.dir).catch(() => undefined))) {
          throw new AppError('ETRASH_FAILED', `Could not move “${e.config.name}” to the Trash: ${(err as Error).message}`, {
            rescuedWorlds: rescuedWorlds.map((w) => w.path),
          })
        }
      }
      this.#entries.delete(id)
      this.#activity.delete(id)
      await Promise.allSettled(this.#hooks.map((h) => h.removed?.(id, e.dir)))
      this.#changed({ removed: [id] })
      return { trashed: true, rescuedWorlds }
    })
  }

  /** Move real world folders out of `saves/` into `rescued-worlds/<instance> <date>/`. */
  async #rescueWorlds(e: Entry): Promise<{ name: string; path: string }[]> {
    const saves = path.join(e.dir, 'saves')
    const st = await lstat(saves).catch(() => undefined)
    if (!st?.isDirectory()) return []
    const worlds = (await readdir(saves, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.'))
    if (worlds.length === 0) return []
    const target = path.join(this.#layout.rescuedWorlds, `${folderNameFor(e.config.name)} ${stamp(new Date(this.#now()))}`)
    await mkdir(target, { recursive: true })
    const out: { name: string; path: string }[] = []
    for (const w of worlds) {
      const dest = path.join(target, w.name)
      try {
        await rename(path.join(saves, w.name), dest)
        out.push({ name: w.name, path: dest })
      } catch (err) {
        throw new AppError('ERESCUE_FAILED', `Could not move the world “${w.name}” out of the instance; nothing was deleted`, { cause: errorCode(err) })
      }
    }
    return out
  }

  // -------------------------------------------------------------------------------------------
  // Import and repair
  // -------------------------------------------------------------------------------------------

  async #checkFolder(dir: string): Promise<FolderCheck> {
    if (dir === '/' || /^\/Volumes\/[^/]+\/?$/.test(dir) || samePath(dir, homedir())) return 'is-volume-root'
    if (/\.app(\/|$)/i.test(dir)) return 'inside-app-bundle'
    let st
    try {
      st = await stat(dir)
    } catch (e) {
      const code = errorCode(e)
      return code === 'EACCES' || code === 'EPERM' ? 'no-permission' : 'missing'
    }
    if (!st.isDirectory()) return 'not-a-directory'
    try {
      await readdir(dir)
    } catch {
      // macOS privacy protection (Desktop, Documents, removable volumes) needs the user's consent.
      return 'no-permission'
    }
    const real = await realpath(dir).catch(() => dir)
    const managedRoots = [this.#layout.instances, await realpath(this.#layout.instances).catch(() => this.#layout.instances)]
    const dataRoots = [this.#layout.root, await realpath(this.#layout.root).catch(() => this.#layout.root)]
    if (managedRoots.some((r) => isPathInside(r, real) || isPathInside(r, dir)) || dataRoots.some((r) => samePath(r, real))) return 'inside-managed-root'
    for (const e of this.#entries.values()) if (samePath(e.dir, real) || samePath(e.dir, dir)) return 'already-registered'
    const meta = metaPath(dir)
    if (await stat(meta).catch(() => undefined)) {
      try {
        const raw: unknown = JSON.parse(await readFile(meta, 'utf8'))
        if (!isRecord(raw)) return 'bad'
      } catch {
        return 'bad'
      }
    }
    return 'ok'
  }

  async inspectFolder(folder: string): Promise<ImportCandidate> {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw invalid('An absolute folder path is required')
    const dir = path.resolve(folder)
    const check = await this.#checkFolder(dir)
    const candidate: ImportCandidate = { path: dir, check, kind: 'empty', name: path.basename(dir), runtime: null, modCount: 0, worldCount: 0 }
    if (check !== 'ok' && check !== 'bad' && check !== 'already-registered') return candidate
    const names = new Set((await readdir(dir).catch(() => [] as string[])).map((n) => n.toLowerCase()))
    if (check !== 'bad' && names.has('.amethyst')) {
      const doc = instanceDoc(dir, { id: fallbackId(dir), name: path.basename(dir) })
      const r = await doc.load().catch(() => undefined)
      if (r && (r.outcome === 'loaded' || r.outcome === 'recovered')) {
        candidate.kind = 'amethyst'
        candidate.name = r.value.name
        candidate.runtime = r.value.runtime
      }
    }
    if (candidate.kind === 'empty' && ['mods', 'saves', 'options.txt', 'config', 'versions', 'resourcepacks'].some((n) => names.has(n))) candidate.kind = 'game-dir'
    candidate.modCount = (await readdir(path.join(dir, 'mods')).catch(() => [] as string[])).filter((n) => /\.jar$/i.test(n)).length
    const saves = await readdir(path.join(dir, 'saves'), { withFileTypes: true }).catch(() => [])
    candidate.worldCount = (await Promise.all(saves.filter((d) => d.isDirectory()).map((d) => stat(path.join(dir, 'saves', d.name, 'level.dat')).then(() => 1, () => 0)))).reduce<number>((a, b) => a + b, 0)
    candidate.runtime ??= await this.#detectRuntime(dir)
    return candidate
  }

  /** Best-effort runtime from the newest `versions/<id>/<id>.json` and its inheritance chain. */
  async #detectRuntime(dir: string): Promise<Partial<InstanceRuntime> | null> {
    const versions = path.join(dir, 'versions')
    const ids = await readdir(versions).catch(() => [] as string[])
    const readJson = async (id: string): Promise<{ json: Record<string, unknown>; mtime: number } | undefined> => {
      const file = path.join(versions, id, `${id}.json`)
      const st = await stat(file).catch(() => undefined)
      if (!st?.isFile() || st.size > 5 * 1024 * 1024) return undefined
      try {
        const json: unknown = JSON.parse(await readFile(file, 'utf8'))
        return isRecord(json) ? { json, mtime: st.mtimeMs } : undefined
      } catch {
        return undefined
      }
    }
    const all = (await mapLimit(ids, 8, async (id) => ({ id, v: await readJson(id) }))).filter((x) => x.v !== undefined)
    const newest = all.toSorted((a, b) => (b.v?.mtime ?? 0) - (a.v?.mtime ?? 0))[0]
    if (!newest?.v) return null
    const chain = [newest.v.json]
    const seen = new Set([newest.id])
    for (let parent = readString(newest.v.json.inheritsFrom); parent && !seen.has(parent) && chain.length < 8; ) {
      seen.add(parent)
      const p = all.find((x) => x.id === parent)?.v ?? (await readJson(parent))
      if (!p) break
      chain.push(p.json)
      parent = readString(p.json.inheritsFrom)
    }
    return detectRuntimeFromVersions(chain)
  }

  async import(input: ImportInstanceInput): Promise<InstanceDetail> {
    if (!isRecord(input) || typeof input.path !== 'string') throw invalid('A folder is required')
    const candidate = await this.inspectFolder(input.path)
    if (candidate.check !== 'ok') throw new AppError('EIMPORT_REJECTED', `This folder cannot be imported (${candidate.check})`, { check: candidate.check })
    const src = candidate.path
    const now = this.#now()

    // Metadata of an existing Amethyst instance, when there is one.
    let existing: InstanceConfig | undefined
    if (candidate.kind === 'amethyst') {
      const doc = instanceDoc(src, { id: fallbackId(src), name: path.basename(src) })
      existing = (await doc.load()).value
    }
    const runtime = input.runtime ? validateRuntime(input.runtime) : existing?.runtime.minecraft ? existing.runtime : undefined
    if (!runtime) throw invalid('Choose the Minecraft version (and loader) of this folder', { keys: ['runtime'] })
    const base = input.name?.trim() ? validateName(input.name) : (existing?.name ?? path.basename(src))
    const name = uniqueDisplayName(base, this.#names())
    const config: InstanceConfig = existing
      ? { ...existing, id: this.#entries.has(existing.id) ? randomUUID() : existing.id, name, runtime }
      : newConfig(randomUUID(), name, runtime, now)

    if (input.mode === 'in-place') {
      const doc = instanceDoc(src, { id: config.id, name })
      await doc.load()
      await doc.set(config)
      await this.#registry.set({ external: [...this.#registry.value.external.filter((r) => !samePath(r.path, src)), { id: config.id, path: src, name }] })
      const entry: Entry = { id: config.id, dir: src, external: true, state: 'ok', doc, config, iconUrl: null }
      entry.iconUrl = await this.#iconUrl(entry)
      this.#entries.set(entry.id, entry)
      this.#changed({ added: [entry.id] })
      return this.#detail(entry)
    }
    if (input.mode !== 'copy') throw invalid('mode must be "in-place" or "copy"')

    const folder = await uniqueName(this.#layout.instances, folderNameFor(name), { extension: false })
    const dir = path.join(this.#layout.instances, folder)
    await mkdir(dir)
    try {
      const result = await this.#tasks.runAndWait({ name: 'instances.import', params: { name } }, (ctx) => copyTree(src, dir, { exclude: IMPORT_EXCLUDES, ctx, signal: ctx.signal }))
      if (result.failed.length > 0) log.warn(`import of ${src}: ${result.failed.length} entries failed`, result.failed)
      const copied: InstanceConfig = { ...config, id: randomUUID(), createdAt: existing ? config.createdAt : now, lastOpenedAt: now }
      const doc = instanceDoc(dir, { id: copied.id, name })
      await doc.load()
      await doc.set(copied)
      const entry: Entry = { id: copied.id, dir, external: false, state: 'ok', doc, config: copied, iconUrl: null }
      entry.iconUrl = await this.#iconUrl(entry)
      this.#entries.set(entry.id, entry)
      this.#changed({ added: [entry.id] })
      return this.#detail(entry)
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      throw e
    }
  }

  async repair(id: string, runtime: Partial<InstanceRuntime> & { minecraft: string }): Promise<InstanceDetail> {
    const valid = validateRuntime(runtime)
    return this.#locks.run(id, async () => {
      const e = this.#entry(id)
      if (e.state !== 'broken' || !e.doc) throw new AppError('EINVALID_ARGUMENT', 'Only damaged instances can be repaired')
      const moved = await e.doc.discardUnreadable()
      if (moved) log.warn(`kept the unreadable metadata of ${e.dir} as ${moved}`)
      await mkdir(path.dirname(metaPath(e.dir)), { recursive: true })
      const config = newConfig(e.id, uniqueDisplayName(path.basename(e.dir), this.#names(e.id)), valid, this.#now())
      await e.doc.set(config)
      e.config = config
      e.state = 'ok'
      this.#changed({ updated: [id] })
      return this.#detail(e)
    })
  }

  // -------------------------------------------------------------------------------------------
  // Icons, recency and play time
  // -------------------------------------------------------------------------------------------

  /** Store an icon image in the instance folder as `icon.<ext>`; returns the relative path. */
  async #storeIcon(dir: string, source: IconSource): Promise<string> {
    const options = { kinds: ['image'] as const, maxBytes: MAX_ICON_BYTES, allowSvg: true, stem: 'icon' }
    let stored
    if ('path' in source && typeof source.path === 'string') {
      if (!path.isAbsolute(source.path)) throw invalid('An absolute file path is required')
      stored = await importMediaFile(source.path, dir, options)
    } else if ('dataUrl' in source && typeof source.dataUrl === 'string') {
      stored = await importMediaBytes(decodeDataUrl(source.dataUrl), dir, options)
    } else if ('url' in source && typeof source.url === 'string') {
      if (!/^https:\/\//i.test(source.url)) throw invalid('Only https: icon URLs are allowed')
      if (!this.#fetchBytes) throw new AppError('EUNAVAILABLE', 'Downloading icons is not available')
      stored = await importMediaBytes(await this.#fetchBytes(source.url, { maxBytes: MAX_ICON_BYTES }), dir, options)
    } else {
      throw invalid('Unknown icon source')
    }
    const keep = path.basename(stored.path)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (/^icon\.(png|jpe?g|gif|webp|svg)$/i.test(name) && name !== keep) await rm(path.join(dir, name), { force: true })
    }
    return keep
  }

  setIcon(id: string, icon: IconSource | null): Promise<InstanceDetail> {
    return this.#mutate(id, async (entry) => {
      if (icon === null) {
        if (entry.config.icon && /^icon\.[a-z]+$/i.test(entry.config.icon)) await rm(path.join(entry.dir, entry.config.icon), { force: true })
        return { ...entry.config, icon: '' }
      }
      if (!isRecord(icon)) throw invalid('Unknown icon source')
      const rel = await this.#storeIcon(entry.dir, icon)
      // Force a new URL even when the file name did not change.
      entry.iconUrl = null
      return { ...entry.config, icon: rel }
    })
  }

  /**
   * Set the live activity shown in the instance rows (install and launch services). Emits
   * `instances:changed` when it changes. Busy-ness for rename/delete is decided by the
   * `isBusy` hooks, not by this value.
   */
  setActivity(id: string, activity: InstanceActivity): void {
    if (!this.#entries.has(id)) return
    const previous = this.#activity.get(id) ?? 'idle'
    if (previous === activity) return
    if (activity === 'idle') this.#activity.delete(id)
    else this.#activity.set(id, activity)
    this.#changed({ updated: [id] })
  }

  /** The live activity of an instance (`idle` when unknown). */
  activityOf(id: string): InstanceActivity {
    return this.#activity.get(id) ?? 'idle'
  }

  async markOpened(id: string): Promise<void> {
    await this.#mutate(id, async (entry) => ({ ...entry.config, lastOpenedAt: this.#now() }))
  }

  /**
   * Record a finished game session (called by the launch service). Sessions with a negative
   * length or longer than 7 days (clock jumps) only update `lastPlayedAt`.
   */
  async recordPlaySession(id: string, startedAt: number, endedAt: number): Promise<void> {
    const length = endedAt - startedAt
    const valid = Number.isFinite(length) && length >= 0 && length <= 7 * 24 * 3600 * 1000
    await this.#mutate(id, async (entry) => ({ ...entry.config, lastPlayedAt: Math.max(entry.config.lastPlayedAt, startedAt), playTimeMs: entry.config.playTimeMs + (valid ? length : 0) }))
  }

  /** Flush pending metadata writes (shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([this.#registry.flush(), ...[...this.#entries.values()].map((e) => e.doc?.flush())])
  }
}

/** The RPC facade. */
export function instancesService(manager: InstanceManager): InstancesService {
  return {
    list: async () => manager.list(),
    get: async (id) => manager.get(id),
    create: (input) => manager.create(input),
    update: (id, patch) => manager.update(id, patch),
    rename: (id, name) => manager.rename(id, name),
    duplicate: (id, name) => manager.duplicate(id, name),
    delete: (id, options) => manager.delete(id, options),
    inspectFolder: (p) => manager.inspectFolder(p),
    import: (input) => manager.import(input),
    repair: (id, runtime) => manager.repair(id, runtime),
    setIcon: (id, icon) => manager.setIcon(id, icon),
    markOpened: (id) => manager.markOpened(id),
  }
}
