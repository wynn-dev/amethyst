/**
 * Installing an instance's game version (Minecraft plus its loader) into the shared `minecraft/`
 * folder with `@amethyst/installer`, as tasks with byte-weighted progress, and linking the
 * resulting version id to the instance. Forge/NeoForge processors run with an arm64 Java of the
 * version's major, installed first when missing.
 *
 * One install per instance at a time (a second call joins the first); while it runs the
 * instance is busy, so it cannot be renamed or deleted.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { diagnose, planNatives, resolveVersion, type JvmArch, type ResolvedVersion } from '@amethyst/game'
import {
  installMissing,
  InstallError,
  planInstall,
  repairVersion,
  runInstall,
  type InstallPlan,
  type InstallRequest,
  type MetadataClient,
} from '@amethyst/installer'
import type { HttpClient } from '@amethyst/net'
import type { TaskContext, TaskSnapshot } from '@amethyst/task'
import type { InstallOutcome, InstallPlanView, InstallService, InstallStatus, InstanceActivity, InstanceRuntime, RepairOutcome, Settings } from '@shared/services'
import type { Emit } from '../context'
import type { InstanceManager } from '../instances/service'
import { loaderOf } from '../instances/model'
import type { JavaManager } from '../java/service'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import type { TaskRegistry } from '../tasks/registry'
import type { TelemetryHooks } from '../telemetry'
import { AppError, invalid } from '../util/errors'
import type { Lwjgl2NativesSource } from '../launch/natives-source'

const log = logger('install')

/** The installer functions used here (replaceable in tests). */
export interface InstallerApi {
  planInstall: typeof planInstall
  runInstall: typeof runInstall
  installMissing: typeof installMissing
  repairVersion: typeof repairVersion
}

const defaultApi: InstallerApi = { planInstall, runInstall, installMissing, repairVersion }

export interface InstallDeps {
  layout: DataLayout
  emit: Emit
  tasks: TaskRegistry
  settings: { readonly value: Settings }
  instances: Pick<InstanceManager, 'resolve' | 'update' | 'setActivity' | 'activityOf'>
  java: Pick<JavaManager, 'pathForMajor' | 'choose' | 'requirementFor'>
  meta: () => Promise<MetadataClient>
  http: () => Promise<HttpClient>
  natives: Pick<Lwjgl2NativesSource, 'get'>
  telemetry: Pick<TelemetryHooks, 'capture'>
  api?: Partial<InstallerApi>
}

/** The installer request for an instance runtime. */
export function requestOf(runtime: InstanceRuntime): InstallRequest {
  const loader = loaderOf(runtime)
  return loader ? { minecraft: runtime.minecraft, loader: { kind: loader.kind, version: loader.version } } : { minecraft: runtime.minecraft }
}

/** Steps of `runInstall` that download bytes (their leaf tasks report bytes). */
const BYTE_STEPS = new Set(['client', 'libraries', 'assets', 'loader', 'loader-libraries'])

/** Bytes downloaded by an install, summed from the byte-reporting leaves of its task tree. */
export function downloadedBytes(snapshot: TaskSnapshot): number {
  const leaves = (s: TaskSnapshot): number => (s.children.length === 0 ? (s.total > 0 ? s.progress : 0) : s.children.reduce((n, c) => n + leaves(c), 0))
  return snapshot.children.filter((c) => BYTE_STEPS.has(c.name)).reduce((n, c) => n + leaves(c), 0)
}

/** True when the version folder holds a finished install. */
export async function isInstalled(minecraftDir: string, versionId: string): Promise<boolean> {
  if (!versionId) return false
  return (await stat(path.join(minecraftDir, 'versions', versionId, '.install-lock')).catch(() => undefined))?.isFile() === true
}

/** The `.install-lock` timestamp: files not modified since then are trusted by size. */
export async function installTimestamp(minecraftDir: string, versionId: string): Promise<number | undefined> {
  try {
    const lock = JSON.parse(await readFile(path.join(minecraftDir, 'versions', versionId, '.install-lock'), 'utf8')) as { timestamp?: unknown }
    return typeof lock.timestamp === 'number' && Number.isFinite(lock.timestamp) ? lock.timestamp : undefined
  } catch {
    return undefined
  }
}

/**
 * Move the `.install-lock` timestamp to now after a successful repair, so the files it just
 * downloaded are trusted by size (not re-hashed) on the next launches.
 */
export async function touchInstallLock(minecraftDir: string, versionId: string): Promise<void> {
  const file = path.join(minecraftDir, 'versions', versionId, '.install-lock')
  try {
    const lock = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ ...lock, timestamp: Date.now() }))
    await rename(tmp, file)
  } catch (e) {
    log.warn(`cannot update the install lock of ${versionId}`, e)
  }
}

export class InstallManager {
  readonly #d: InstallDeps
  readonly #api: InstallerApi
  readonly #running = new Map<string, Promise<InstallOutcome>>()
  /** Version ids being written (for "delete installed version"). */
  readonly #versions = new Map<string, number>()

  constructor(deps: InstallDeps) {
    this.#d = deps
    this.#api = { ...defaultApi, ...deps.api }
  }

  get root(): string {
    return this.#d.layout.minecraft
  }

  /** An install or repair of this instance is running. */
  isBusy(instanceId: string): boolean {
    return this.#running.has(instanceId)
  }

  /** An install writes into this version id (or one inheriting from it). */
  isVersionBusy(versionId: string): boolean {
    return (this.#versions.get(versionId) ?? 0) > 0
  }

  #hold(versionId: string): () => void {
    this.#versions.set(versionId, (this.#versions.get(versionId) ?? 0) + 1)
    return () => {
      const n = (this.#versions.get(versionId) ?? 1) - 1
      if (n <= 0) this.#versions.delete(versionId)
      else this.#versions.set(versionId, n)
    }
  }

  async #plan(request: InstallRequest, signal?: AbortSignal): Promise<InstallPlan> {
    const [meta, http] = await Promise.all([this.#d.meta(), this.#d.http()])
    const options = { root: this.root, http, meta, ...(signal ? { signal } : {}) }
    try {
      return await this.#api.planInstall(request, options)
    } catch (e) {
      // A loader build newer than the cached list: revalidate the lists once and retry.
      if (!(e instanceof InstallError) || e.code !== 'EINSTALL_NOT_FOUND' || !request.loader) throw e
      const kind = request.loader.kind
      if (kind === 'forge') await meta.forgeVersions(undefined, { force: true, ...(signal ? { signal } : {}) })
      else if (kind === 'neoforge') await meta.neoForgeVersions(undefined, { force: true, ...(signal ? { signal } : {}) })
      else throw e
      return this.#api.planInstall(request, options)
    }
  }

  async plan(instanceId: string): Promise<InstallPlanView> {
    const inst = this.#d.instances.resolve(instanceId)
    if (!inst.config.runtime.minecraft) throw invalid('The instance has no Minecraft version')
    const plan = await this.#plan(requestOf(inst.config.runtime))
    return {
      versionId: plan.versionId,
      minecraft: plan.minecraft.id,
      loader: plan.loader ? { kind: plan.loader.kind, version: plan.loader.version } : null,
      steps: plan.steps.map((s) => ({ id: s.id, bytes: s.bytes ?? null, files: s.files ?? null, needsJava: s.needsJava === true })),
      totalBytes: plan.totalBytes,
      javaMajor: plan.javaMajor,
      needsJava: plan.needsJava,
    }
  }

  async status(instanceId: string): Promise<InstallStatus> {
    const inst = this.#d.instances.resolve(instanceId)
    const versionId = inst.config.versionId
    return { versionId, installed: await isInstalled(this.root, versionId), installing: this.isBusy(instanceId) }
  }

  /** Mark the instance busy for `fn`, restoring the previous activity afterwards. */
  async #busy<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    const previous: InstanceActivity = this.#d.instances.activityOf(instanceId)
    this.#d.instances.setActivity(instanceId, 'installing')
    try {
      return await fn()
    } finally {
      this.#d.instances.setActivity(instanceId, previous === 'installing' ? 'idle' : previous)
    }
  }

  /** Install the instance's runtime and link the version id (joins a running install). */
  install(instanceId: string, options: { signal?: AbortSignal; ctx?: TaskContext } = {}): Promise<InstallOutcome> {
    const running = this.#running.get(instanceId)
    if (running) return running
    let inst
    try {
      inst = this.#d.instances.resolve(instanceId)
    } catch (e) {
      return Promise.reject(e)
    }
    const runtime = { ...inst.config.runtime }
    if (!runtime.minecraft) return Promise.reject(invalid('The instance has no Minecraft version'))
    const request = requestOf(runtime)
    const params: Record<string, string> = { name: inst.config.name, minecraft: runtime.minecraft }
    if (request.loader) Object.assign(params, { loader: request.loader.kind, loaderVersion: request.loader.version })
    const p = this.#busy(instanceId, async () => {
      const started = Date.now()
      let release: (() => void) | undefined
      const work = async (ctx: TaskContext) => {
        const plan = await this.#plan(request, ctx.signal)
        release = this.#hold(plan.versionId)
        const [meta, http] = await Promise.all([this.#d.meta(), this.#d.http()])
        const result = await this.#api.runInstall(plan, {
          root: this.root,
          http,
          meta,
          ctx,
          resolveJava: (major, signal) => this.#d.java.pathForMajor(major, signal ? { signal } : {}),
        })
        return { plan, result }
      }
      // Standalone: a root `install.run` task. Inside another task (a modpack import): a child of it.
      const handle = options.ctx ? undefined : this.#d.tasks.run({ name: 'install.run', params, instanceId }, work, options.signal ? { signal: options.signal } : {})
      try {
        const { plan, result } = await (handle ? handle.promise : (options.ctx as TaskContext).child('install.run', work, { params }))
        const durationMs = Date.now() - started
        // Child installs cannot see their subtree; count the plan's sizes instead (an upper bound).
        const bytes = handle ? downloadedBytes(handle.snapshot()) : plan.totalBytes
        // Link the version unless the runtime changed while installing.
        const now = this.#d.instances.resolve(instanceId).config.runtime
        if (JSON.stringify(now) === JSON.stringify(runtime)) await this.#d.instances.update(instanceId, { versionId: result.versionId })
        else log.warn(`instance ${instanceId} changed while installing ${result.versionId}; not linking it`)
        this.#d.emit('versions:changed', { lists: ['installed', 'minecraft'] })
        log.info(`installed ${result.versionId} in ${durationMs} ms (${(bytes / 1048576).toFixed(1)} MiB downloaded)`)
        this.#d.telemetry.capture('install_completed', { loader: request.loader?.kind ?? 'vanilla', mcVersion: runtime.minecraft, durationMs, bytes })
        if (bytes >= 1048576 && durationMs > 0) {
          const files = plan.steps.reduce((n, s) => n + (s.files ?? 0), 0)
          this.#d.telemetry.capture('perf_download', { throughputBps: Math.round((bytes * 1000) / durationMs), files })
        }
        return { versionId: result.versionId, durationMs, bytes }
      } finally {
        release?.()
      }
    }).finally(() => this.#running.delete(instanceId))
    this.#running.set(instanceId, p)
    return p
  }

  /** Re-download (and for Forge/NeoForge rebuild) what a full check finds broken. */
  async repair(instanceId: string): Promise<RepairOutcome> {
    const inst = this.#d.instances.resolve(instanceId)
    const versionId = inst.config.versionId
    if (!versionId || !(await isInstalled(this.root, versionId))) {
      const r = await this.install(instanceId)
      return { versionId: r.versionId, found: 0, repaired: 0, remaining: [], reranProcessors: false }
    }
    if (this.#running.has(instanceId)) throw new AppError('EBUSY', 'An install of this instance is running')
    const p = (async (): Promise<RepairOutcome> => {
      return this.#busy(instanceId, () =>
        this.#d.tasks.runAndWait({ name: 'install.repair', params: { name: inst.config.name, version: versionId }, instanceId }, async (ctx) => {
          const release = this.#hold(versionId)
          try {
            return await this.#repair(instanceId, versionId, ctx)
          } finally {
            release()
          }
        }),
      )
    })().finally(() => this.#running.delete(instanceId))
    this.#running.set(instanceId, p.then((r) => ({ versionId: r.versionId, durationMs: 0, bytes: 0 })))
    return p
  }

  async #repair(instanceId: string, versionId: string, ctx: TaskContext): Promise<RepairOutcome> {
    const inst = this.#d.instances.resolve(instanceId)
    const resolved = await resolveVersion(path.join(this.root, 'versions'), versionId, { signal: ctx.signal })
    const requirement = await this.#d.java.requirementFor(instanceId, resolved)
    const pinnedPath = inst.config.overrides.javaPath
    const choice = await this.#d.java.choose({ requirement, ...(pinnedPath ? { pinnedPath } : {}) })
    const arch: JvmArch = choice.result.java?.arch === 'x64' ? 'x64' : 'arm64'
    const replace = this.#d.settings.value.game.replaceArm64Natives !== 'off'
    const lwjgl2 = arch === 'arm64' && replace && usesLwjgl2(resolved) ? await this.#d.natives.get(ctx.signal).catch(() => undefined) : undefined
    const natives = planNatives(resolved, { jvmArch: arch, replace, ...(lwjgl2 ? { lwjgl2 } : {}) })
    const loader = loaderOf(inst.config.runtime)
    const java = loader && (loader.kind === 'forge' || loader.kind === 'neoforge') ? await this.#d.java.pathForMajor(requirement.majorVersion, { signal: ctx.signal }) : undefined
    const http = await this.#d.http()
    const r = await this.#api.repairVersion(versionId, {
      root: this.root,
      http,
      ctx,
      ...(java ? { java } : {}),
      diagnose: (signal) => diagnose(resolved, this.root, { natives, hash: 'always', ...(signal ? { signal } : {}) }),
    })
    return {
      versionId,
      found: r.before.length,
      repaired: r.repaired.length,
      remaining: r.after.map((i) => ({ name: i.name, problem: i.problem ?? 'missing', message: (i as { message?: string }).message ?? null })),
      reranProcessors: r.reranProcessors,
    }
  }
}

/** True when the version uses LWJGL 2 natives (Minecraft 1.12.2 and older). */
export function usesLwjgl2(version: Pick<ResolvedVersion, 'libraries'>): boolean {
  return version.libraries.some((l) => typeof l.library.name === 'string' && l.library.name.startsWith('org.lwjgl.lwjgl:lwjgl-platform:'))
}

/** The RPC facade. */
export function installService(manager: InstallManager): InstallService {
  return {
    plan: (id) => manager.plan(id),
    status: (id) => manager.status(id),
    install: (id) => manager.install(id),
    repair: (id) => manager.repair(id),
  }
}
