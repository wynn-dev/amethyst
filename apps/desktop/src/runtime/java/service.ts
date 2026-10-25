/**
 * Java runtimes: discovery (`@amethyst/java`) with a persisted probe cache, user-added and hidden
 * paths, managed installs (Mojang `mac-os-arm64`, else Azul Zulu) and the per-launch choice.
 *
 * Nothing runs at boot. The cached records are shown as they are; discovery runs once lazily
 * after first paint ({@link JavaManager.scheduleInitialScan}) and on demand. Probes read the
 * `release` file and the Mach-O header and only spawn a JVM when those are inconclusive, so a
 * rescan of unchanged JDKs spawns nothing. The chosen runtime is verified (one spawn, cached by
 * binary mtime and size) right before a launch.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { HttpClient } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import {
  discoverJava,
  installJavaRuntime,
  javaRequirementFor,
  listManagedRuntimes,
  ProbeCache,
  probeJava,
  selectJava,
  type JavaRecord,
  type JavaRequirement,
  type SelectResult,
} from '@amethyst/java'
import { requiredJavaMajor } from '@amethyst/installer'
import type { GameSettings, JavaRecommendation, JavaRow, JavaService, Settings } from '@shared/services'
import type { Emit } from '../context'
import type { InstanceManager } from '../instances/service'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import { JsonDocument } from '../store/json-store'
import type { TaskRegistry } from '../tasks/registry'
import { AppError, errorMessage, invalid, isAbortError } from '../util/errors'
import { asRecord, readStringArray } from '../util/parse'

const log = logger('java')

/** The `@amethyst/java` functions used here (replaceable in tests). */
export interface JavaApi {
  discoverJava: typeof discoverJava
  probeJava: typeof probeJava
  installJavaRuntime: typeof installJavaRuntime
  listManagedRuntimes: typeof listManagedRuntimes
}

const defaultApi: JavaApi = { discoverJava, probeJava, installJavaRuntime, listManagedRuntimes }

interface JavaConfig {
  /** Paths the user added (a `bin/java`, a home or a bundle), kept even when missing. */
  userPaths: string[]
  /** Discovered runtimes the user removed (path or realpath). */
  hidden: string[]
}

export interface JavaDeps {
  layout: DataLayout
  emit: Emit
  settings: { readonly value: Settings }
  tasks: TaskRegistry
  instances: Pick<InstanceManager, 'resolve'>
  http: () => Promise<HttpClient>
  api?: Partial<JavaApi>
}

/** What the launch and install services need to know about a selection. */
export interface JavaChoice {
  java: JavaRecord
  requirement: JavaRequirement
  result: SelectResult
  /** A managed runtime was installed for this choice. */
  installed: boolean
}

/** Inputs of a selection: the requirement plus the instance's pin. */
export interface JavaQuery {
  requirement: JavaRequirement
  /** The instance's `javaPath` override. */
  pinnedPath?: string
}

export function toJavaRow(r: JavaRecord, userPaths: ReadonlySet<string> = new Set()): JavaRow {
  return {
    path: r.path,
    javaHome: r.javaHome,
    version: r.version,
    majorVersion: r.majorVersion,
    arch: r.arch,
    vendor: r.vendor ?? null,
    source: r.source,
    managed: r.managed,
    userAdded: userPaths.has(r.path) || userPaths.has(r.realPath) || userPaths.has(r.javaHome),
    valid: r.valid,
    invalidReason: r.invalidReason ?? null,
  }
}

/** A selection the launch can use as is (found, and native arm64). */
const usable = (r: SelectResult) => r.java !== undefined && !r.rosetta

/** `bin/java` inside a JDK home or bundle, or the path itself. */
async function javaExecutable(p: string): Promise<string> {
  const abs = path.resolve(p)
  const st = await stat(abs).catch(() => undefined)
  if (!st?.isDirectory()) return abs
  for (const candidate of [path.join(abs, 'bin', 'java'), path.join(abs, 'Contents', 'Home', 'bin', 'java'), path.join(abs, 'Home', 'bin', 'java')]) {
    // oxlint-disable-next-line no-await-in-loop -- at most three stats
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate
  }
  return path.join(abs, 'bin', 'java')
}

export class JavaManager {
  readonly #d: JavaDeps
  readonly #api: JavaApi
  readonly #config: JsonDocument<JavaConfig>
  #cache: ProbeCache | undefined
  #records: JavaRecord[] = []
  #loaded: Promise<void> | undefined
  #scan: Promise<JavaRecord[]> | undefined
  #scanned = false
  #managedChecked = false
  readonly #installs = new Map<number, Promise<JavaRecord>>()
  #initialScan: ReturnType<typeof setTimeout> | undefined

  constructor(deps: JavaDeps) {
    this.#d = deps
    this.#api = { ...defaultApi, ...deps.api }
    this.#config = new JsonDocument<JavaConfig>(deps.layout.javaConfig, {
      version: 1,
      parse: (raw) => ({ userPaths: readStringArray(asRecord(raw).userPaths) ?? [], hidden: readStringArray(asRecord(raw).hidden) ?? [] }),
      defaults: () => ({ userPaths: [], hidden: [] }),
      serialize: (c) => c as unknown as Record<string, unknown>,
    })
  }

  /** Read the persisted probe cache and user paths (first use only). */
  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const [cache] = await Promise.all([ProbeCache.load(this.#d.layout.javaProbeCache), this.#config.load()])
      this.#cache = cache
      const hidden = new Set(this.#config.value.hidden)
      // Show what the last scan found right away (the next scan corrects it), but never offer a
      // runtime whose binary was deleted or replaced since: one stat per record, no spawn.
      const shown = cache.records().filter((r) => !hidden.has(r.path) && !hidden.has(r.realPath) && r.invalidReason !== 'missing')
      const unchanged = await Promise.all(
        shown.map(async (r) => {
          const st = await stat(r.realPath).catch(() => undefined)
          return st?.isFile() === true && st.mtimeMs === r.mtimeMs && st.size === r.size
        }),
      )
      this.#records = shown.filter((_, i) => unchanged[i])
    })().catch((e: unknown) => {
      this.#loaded = undefined
      throw e
    })
    return this.#loaded
  }

  get #userPaths(): Set<string> {
    return new Set(this.#config.value.userPaths.map((p) => path.resolve(p)))
  }

  #rows(records: readonly JavaRecord[]): JavaRow[] {
    const user = this.#userPaths
    return records
      .map((r) => toJavaRow(r, user))
      .toSorted((a, b) => Number(b.valid) - Number(a.valid) || b.majorVersion - a.majorVersion || a.path.localeCompare(b.path))
  }

  async #saveCache(): Promise<void> {
    await this.#cache?.save(this.#d.layout.javaProbeCache).catch((e: unknown) => log.warn('cannot save the Java probe cache', e))
  }

  /** Replace or add records (by realpath). */
  #merge(records: readonly JavaRecord[]): void {
    const byReal = new Map(this.#records.map((r) => [r.realPath, r]))
    for (const r of records) byReal.set(r.realPath, r)
    this.#records = [...byReal.values()]
  }

  /** Run the first discovery `delayMs` after the UI painted (once per session). */
  scheduleInitialScan(delayMs = 3_000): void {
    if (this.#scanned || this.#scan || this.#initialScan) return
    this.#initialScan = setTimeout(() => {
      this.#initialScan = undefined
      if (!this.#scanned) void this.rescan().catch((e: unknown) => log.warn(`Java discovery failed: ${errorMessage(e)}`))
    }, delayMs)
    this.#initialScan.unref?.()
  }

  dispose(): void {
    if (this.#initialScan) clearTimeout(this.#initialScan)
  }

  async list(): Promise<JavaRow[]> {
    await this.#load()
    return this.#rows(this.#records)
  }

  /** Discover every runtime (single flight). */
  rescan(): Promise<JavaRow[]> {
    this.#scan ??= (async () => {
      await this.#load()
      this.#d.emit('java:changed', { scanning: true })
      const started = performance.now()
      try {
        const config = this.#config.value
        const records = await this.#api.discoverJava({
          runtimesDir: this.#d.layout.runtimes,
          extraPaths: config.userPaths,
          hidden: config.hidden,
          cache: this.#cache,
          spawn: 'fallback',
        })
        this.#records = records
        this.#scanned = true
        this.#managedChecked = true
        await this.#saveCache()
        log.info(`found ${records.filter((r) => r.valid).length} usable Java runtime(s) of ${records.length} in ${(performance.now() - started).toFixed(0)} ms`)
        return records
      } finally {
        this.#scan = undefined
        this.#d.emit('java:changed', { scanning: false })
      }
    })()
    return this.#scan.then((r) => this.#rows(r))
  }

  async addPath(p: string): Promise<JavaRow> {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw invalid('An absolute path is required')
    await this.#load()
    const exe = await javaExecutable(p)
    const record = await this.#api.probeJava(exe, { spawn: 'always', cache: this.#cache, source: 'manual', managedDir: this.#d.layout.runtimes })
    if (!record.valid) {
      throw new AppError('EJAVA_INVALID', `${exe} cannot be used: ${record.invalidReason ?? 'unknown problem'}`, { reason: record.invalidReason ?? 'unknown', path: exe })
    }
    const config = this.#config.value
    await this.#config.set({
      userPaths: config.userPaths.includes(exe) ? config.userPaths : [...config.userPaths, exe],
      hidden: config.hidden.filter((h) => h !== exe && h !== record.realPath),
    })
    this.#merge([record])
    await this.#saveCache()
    this.#d.emit('java:changed', { scanning: false })
    return toJavaRow(record, this.#userPaths)
  }

  async removePath(p: string): Promise<void> {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw invalid('An absolute path is required')
    await this.#load()
    const abs = path.resolve(p)
    const record = this.#records.find((r) => r.path === abs || r.realPath === abs || r.javaHome === abs)
    const config = this.#config.value
    const keys = new Set([abs, ...(record ? [record.path, record.realPath, record.javaHome] : [])])
    const userPaths = config.userPaths.filter((u) => !keys.has(path.resolve(u)))
    const wasUser = userPaths.length !== config.userPaths.length
    const hidden = wasUser ? config.hidden : [...new Set([...config.hidden, ...(record ? [record.path, record.realPath] : [abs])])]
    await this.#config.set({ userPaths, hidden })
    this.#records = this.#records.filter((r) => !keys.has(r.path) && !keys.has(r.realPath))
    this.#d.emit('java:changed', { scanning: false })
  }

  /** Install a managed runtime for `major` (single flight per major), as a `java.install` task unless `ctx` is given. */
  installManaged(major: number, options: { component?: string; ctx?: TaskContext; signal?: AbortSignal } = {}): Promise<JavaRecord> {
    if (!Number.isInteger(major) || major < 8 || major > 99) return Promise.reject(invalid('Invalid Java major version'))
    const running = this.#installs.get(major)
    if (running) return running
    const work = async (ctx: TaskContext): Promise<JavaRecord> => {
      await this.#load()
      const client = await this.#d.http()
      const result = await this.#api.installJavaRuntime(
        { majorVersion: major, ...(options.component ? { component: options.component } : {}) },
        { runtimesDir: this.#d.layout.runtimes, client, ctx },
      )
      log.info(`installed Java ${result.java.version} (${result.choice.source}) at ${result.java.path}: ${result.choice.reason}`)
      this.#cache?.set(result.java)
      this.#merge([result.java])
      await this.#saveCache()
      this.#d.emit('java:changed', { scanning: false })
      return result.java
    }
    const p = (options.ctx
      ? options.ctx.child('java.install', work, { params: { major } })
      : this.#d.tasks.runAndWait({ name: 'java.install', params: { major } }, work, options.signal ? { signal: options.signal } : {})
    ).finally(() => this.#installs.delete(major))
    this.#installs.set(major, p)
    return p
  }

  async installRuntime(major: number): Promise<JavaRow> {
    return toJavaRow(await this.installManaged(major), this.#userPaths)
  }

  /**
   * Make sure managed runtimes are known without a full discovery (the launch fast path): probe
   * the `runtimes/` folder through the cache, once per session.
   */
  async #knownRecords(): Promise<JavaRecord[]> {
    await this.#load()
    if (!this.#managedChecked && !this.#scanned) {
      this.#managedChecked = true
      const managed = await this.#api.listManagedRuntimes(this.#d.layout.runtimes)
      const records = await Promise.all(
        managed.flatMap((m) => (m.javaPath ? [this.#api.probeJava(m.javaPath, { cache: this.#cache, source: 'managed', managedDir: this.#d.layout.runtimes })] : [])),
      )
      this.#merge(records)
    }
    return this.#records
  }

  /**
   * Choose a runtime for `query` following the Java policy (`game.java.policy`) and the
   * instance's pin, without installing anything. `willInstall` means a managed runtime should be
   * installed for `requirement.majorVersion`.
   */
  async choose(query: JavaQuery): Promise<{ result: SelectResult; policy: JavaRecommendation['policy']; willInstall: boolean }> {
    const records = await this.#knownRecords()
    const settings: GameSettings['java'] = this.#d.settings.value.game.java
    const { requirement } = query
    const options = { major: requirement.majorVersion, match: requirement.match, okay: requirement.okay }
    if (query.pinnedPath) {
      const pinned = selectJava(records, { ...options, pinnedPath: query.pinnedPath })
      if (pinned.reason === 'pinned') return { result: pinned, policy: 'pinned', willInstall: false }
    }
    const managed = records.filter((r) => r.managed)
    let result: SelectResult
    if (settings.policy === 'custom' && settings.path) {
      result = selectJava(records, { ...options, preferredPath: settings.path })
      if (result.reason !== 'preferred') result = selectJava(managed, options)
    } else if (settings.policy === 'prefer-installed') {
      result = selectJava(records.filter((r) => !r.managed), options)
      if (!usable(result)) {
        const fallback = selectJava(managed, options)
        if (usable(fallback) || !result.java) result = fallback
      }
    } else {
      result = selectJava(managed, options)
    }
    if (query.pinnedPath) result = { ...result, pinnedUnavailable: true }
    return { result, policy: query.pinnedPath ? 'pinned' : settings.policy, willInstall: !usable(result) }
  }

  /**
   * The runtime a launch uses: chosen by {@link choose}, a managed one installed when nothing
   * fits, and verified with one JVM spawn (cached per binary). Throws `EJAVA_REQUIRED`
   * (`details.major`) when no runtime can be provided, and `EJAVA_INVALID` when the chosen one
   * does not start.
   */
  async forLaunch(query: JavaQuery, options: { signal?: AbortSignal; onInstall?: () => void } = {}): Promise<JavaChoice> {
    const { requirement } = query
    let { result, willInstall } = await this.choose(query)
    let java = result.java
    let installed = false
    if (willInstall) {
      options.onInstall?.()
      try {
        java = await this.installManaged(requirement.majorVersion, { ...(requirement.component ? { component: requirement.component } : {}), ...(options.signal ? { signal: options.signal } : {}) })
        installed = true
        result = { ...result, java, reason: 'exact-major', grade: 'matched', rosetta: false, message: `Installed Java ${java.version} for this version.` }
      } catch (e) {
        if (isAbortError(e) || options.signal?.aborted) throw e
        // An x86_64-only match still works (under Rosetta) when no arm64 runtime can be installed.
        if (!result.java) {
          throw new AppError('EJAVA_REQUIRED', `Java ${requirement.majorVersion} is required and could not be installed: ${errorMessage(e)}`, {
            major: requirement.majorVersion,
            component: requirement.component,
            cause: errorMessage(e),
          })
        }
        log.warn(`cannot install an arm64 Java ${requirement.majorVersion}; using ${result.java.path} under Rosetta`, e)
      }
    }
    if (!java) throw new AppError('EJAVA_REQUIRED', `Java ${requirement.majorVersion} is required`, { major: requirement.majorVersion, component: requirement.component })

    // Pre-launch validation: one spawn per binary, then cached.
    const verified = await this.#api.probeJava(java.path, { spawn: 'always', cache: this.#cache, source: java.source, managedDir: this.#d.layout.runtimes, ...(options.signal ? { signal: options.signal } : {}) })
    if (!verified.valid) {
      throw new AppError('EJAVA_INVALID', `${java.path} cannot run: ${verified.invalidReason ?? 'unknown problem'}`, { reason: verified.invalidReason ?? 'unknown', path: java.path, major: requirement.majorVersion })
    }
    if (!verified.verified || verified !== java) {
      this.#merge([verified])
      void this.#saveCache()
    }
    return { java: verified, requirement, result, installed }
  }

  /** A `java` for Forge/NeoForge processors: the best arm64 runtime of exactly `major`, installed when missing. */
  async pathForMajor(major: number, options: { signal?: AbortSignal } = {}): Promise<string> {
    const records = await this.#knownRecords()
    const result = selectJava(records, { major, match: { kind: 'exact', major } })
    if (result.java && !result.rosetta) return result.java.path
    return (await this.installManaged(major, options.signal ? { signal: options.signal } : {})).path
  }

  /** The Java requirement of an instance: from its installed version JSON when linked, else from the Minecraft version. */
  async requirementFor(instanceId: string, resolved?: { javaVersion?: { component?: string; majorVersion: number }; minecraftVersion: string }): Promise<JavaRequirement> {
    const inst = this.#d.instances.resolve(instanceId)
    const runtime = inst.config.runtime
    const forge = runtime.forge !== ''
    if (resolved) return javaRequirementFor({ javaVersion: resolved.javaVersion, minecraftVersion: resolved.minecraftVersion, forge })
    return javaRequirementFor({ javaVersion: { majorVersion: requiredJavaMajor(undefined, runtime.minecraft) }, minecraftVersion: runtime.minecraft, forge })
  }

  async recommend(instanceId: string, resolved?: Parameters<JavaManager['requirementFor']>[1]): Promise<JavaRecommendation> {
    const inst = this.#d.instances.resolve(instanceId)
    const requirement = await this.requirementFor(instanceId, resolved)
    const pinnedPath = inst.config.overrides.javaPath
    const { result, policy, willInstall } = await this.choose({ requirement, ...(pinnedPath ? { pinnedPath } : {}) })
    return {
      major: requirement.majorVersion,
      policy,
      java: result.java ? toJavaRow(result.java, this.#userPaths) : null,
      reason: result.reason,
      message: willInstall && !result.java ? `Java ${requirement.majorVersion} will be installed when you launch.` : result.message,
      rosetta: result.rosetta,
      pinnedUnavailable: result.pinnedUnavailable === true,
      willInstall,
    }
  }

  async flush(): Promise<void> {
    await this.#config.flush()
  }
}

/** The RPC facade. `resolveForRecommend` reads the instance's installed version when it has one. */
export function javaService(manager: JavaManager, resolveForRecommend?: (instanceId: string) => Promise<Parameters<JavaManager['requirementFor']>[1]>): JavaService {
  return {
    list: () => manager.list(),
    rescan: () => manager.rescan(),
    addPath: (p) => manager.addPath(p),
    removePath: (p) => manager.removePath(p),
    installRuntime: (major) => manager.installRuntime(major),
    recommend: async (instanceId) => manager.recommend(instanceId, await resolveForRecommend?.(instanceId).catch(() => undefined)),
  }
}
