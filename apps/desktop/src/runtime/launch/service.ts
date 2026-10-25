/**
 * Launching and watching the game.
 *
 * The pipeline (each step is announced as `launch:state` `preparing{step}` and timed):
 *
 * 1. `resolve`: the instance's linked version (`install` first when it is missing or stale).
 * 2. `java`: the runtime for the version's requirement and the Java policy, installed when
 *    missing, verified once per binary. Nothing is asked: failures are typed (`EJAVA_REQUIRED`).
 * 3. `natives`: the natives plan for the JVM's **real** architecture; LWJGL 2 versions fetch the
 *    Amethyst arm64 natives manifest (`ENATIVES_UNAVAILABLE` when it is not available).
 * 4. `verify`: a fast `diagnose` (sizes; hashes only for files changed since the install, the
 *    client jar and small metadata), then `repair` as a visible task when something is missing.
 * 5. `account`: the session (refreshed silently; started in parallel with the steps above).
 * 6. `prelaunch`: the user's pre-launch command, if any.
 * 7. `build`: natives extraction and the command line from settings and instance overrides.
 * 8. `spawn`: the process starts; output goes to a bounded ring buffer per instance and, while a
 *    log view is subscribed, to `launch:log` batches.
 *
 * When everything is installed, click → spawn takes a few tens of milliseconds; nothing in the
 * pipeline waits on optional scans.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { totalmem } from 'node:os'
import path from 'node:path'
import {
  autoMemory,
  buildLaunchCommand,
  diagnose,
  extractNatives,
  launch as spawnGame,
  nativesDirectory,
  planNatives,
  prepareLegacyAssets,
  redactArgs,
  redactCommand,
  resolveVersion,
  sanitizeEnv,
  type BuildLaunchOptions,
  type DiagnoseIssue,
  type GameProcess,
  type LaunchResult,
  type LogEvent,
  type NativesPlan,
  type QuickPlay,
  type ResolvedVersion,
} from '@amethyst/game'
import { installMissing, repairVersion } from '@amethyst/installer'
import type { HttpClient } from '@amethyst/net'
import type { Session } from '@amethyst/auth'
import type {
  CrashReport,
  GameLogPage,
  HostServices,
  LaunchOptions,
  LaunchService,
  LaunchStarted,
  LaunchState,
  LaunchStep,
  RunningGame,
  Settings,
} from '@shared/services'
import type { Events } from '@shared/events'
import type { AccountManager } from '../accounts/service'
import type { Emit } from '../context'
import type { InstanceManager, ResolvedInstance } from '../instances/service'
import { installTimestamp, isInstalled, touchInstallLock, usesLwjgl2, type InstallManager } from '../install/service'
import type { JavaChoice, JavaManager } from '../java/service'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import type { TaskRegistry } from '../tasks/registry'
import type { TelemetryHooks } from '../telemetry'
import { withoutUnsafeEnv } from '../util/env'
import { AppError, errorCode, errorMessage, isAbortError } from '../util/errors'
import { loadClientId } from './client-id'
import { LogRing } from './log-buffer'
import type { Lwjgl2NativesSource } from './natives-source'
import { adoptedProcess, isAlive, processStartTime, RunningGamesStore, type ProcessStartReader, type RunningRecord } from './running'

const log = logger('launch')

/** The `@amethyst/game` functions the pipeline uses (replaceable in tests). */
export interface GameApi {
  resolveVersion: typeof resolveVersion
  planNatives: typeof planNatives
  diagnose: typeof diagnose
  extractNatives: typeof extractNatives
  prepareLegacyAssets: typeof prepareLegacyAssets
  buildLaunchCommand: typeof buildLaunchCommand
  launch: typeof spawnGame
  installMissing: typeof installMissing
  repairVersion: typeof repairVersion
}

const defaultGame: GameApi = { resolveVersion, planNatives, diagnose, extractNatives, prepareLegacyAssets, buildLaunchCommand, launch: spawnGame, installMissing, repairVersion }

/** Runs the pre-launch command; resolves with its exit code and the tail of its stderr. */
export type PreLaunchRunner = (command: string, options: { cwd: string; env: Record<string, string>; signal: AbortSignal; timeoutMs: number }) => Promise<{ code: number | null; stderr: string }>

export interface LaunchDeps {
  layout: DataLayout
  emit: Emit
  settings: { readonly value: Settings }
  tasks: TaskRegistry
  /** App version, passed as `${launcher_version}`. */
  version: string
  instances: Pick<InstanceManager, 'resolve' | 'recordPlaySession' | 'setActivity'>
  install: Pick<InstallManager, 'install' | 'isBusy'>
  java: Pick<JavaManager, 'forLaunch' | 'requirementFor'>
  accounts: () => Promise<Pick<AccountManager, 'list' | 'sessionForLaunch'>>
  natives: Pick<Lwjgl2NativesSource, 'get'>
  http: () => Promise<HttpClient>
  host: Pick<HostServices, 'setLauncherHidden'>
  telemetry: TelemetryHooks
  game?: Partial<GameApi>
  preLaunch?: PreLaunchRunner
  /** macOS product version for library rules (default `13.0`). */
  osVersion?: string
  /** Lines kept per instance (default 5,000). */
  logCapacity?: number
  /** Minimum time between two `launch:log` batches per instance (default 100 ms). */
  logBatchMs?: number
  totalMemoryMB?: () => number
  /** Bound for the `account` step (default 90 s). */
  accountTimeoutMs?: number
  /** True while a modpack import/update/rollback or a version change writes into the instance. */
  isChanging?: (instanceId: string) => boolean
  /** Undo a modpack commit an earlier session was killed in, before the instance is used. */
  recoverModpack?: (instanceDir: string) => Promise<void>
  /** Process start time by pid (default `ps -o lstart=`), to recognise games after a restart. */
  processStart?: ProcessStartReader
  /** Whether a pid exists (default `kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean
  /** How often an adopted game (started before a runtime restart) is checked for exit (default 2 s). */
  adoptPollMs?: number
}

interface Run {
  instanceId: string
  launchId: string
  phase: 'preparing' | 'running' | 'exited'
  step: LaunchStep | null
  controller: AbortController
  pid: number
  startedAt: number
  ready: boolean
  hidLauncher: boolean
  process?: GameProcess
  log: LogRing
  gameDir: string
  result?: LaunchResult
  /** Values redacted from every game output line (the game or a mod may print its arguments). */
  secrets?: readonly string[]
  /** LWJGL generation of the launched version (from the natives plan). */
  lwjgl?: 2 | 3
}

/**
 * LWJGL 2 era games (Minecraft ≤ 1.12.2, old Forge) often quit with a non-zero exit code after a
 * normal shutdown (LWJGL/OpenAL teardown). Such an exit is not a crash when the game came up and
 * left no crash evidence: no crash report, no JVM `hs_err` log, no native load error, no signal.
 */
export function isBenignLegacyExit(result: LaunchResult, lwjgl: 2 | 3 | undefined, crashPrinted = false): boolean {
  return (
    lwjgl === 2 &&
    !crashPrinted &&
    result.crashed &&
    !result.killed &&
    result.ready &&
    result.exitCode !== null &&
    result.signal === null &&
    !result.crashReportPath &&
    !result.hsErrPath &&
    !result.nativeLoadError
  )
}

const MAX_BATCH_LINES = 500
const MAX_CRASH_BYTES = 512 * 1024
const PRELAUNCH_TIMEOUT_MS = 5 * 60_000
/** Upper bound for the `account` step (the token refresh), so Play never spins forever on it. */
const ACCOUNT_TIMEOUT_MS = 90_000
/** Exited runs whose logs are kept (beyond the running ones). */
const MAX_FINISHED_RUNS = 16

/** After the pre-launch shell exits, how long its pipes may stay open (a backgrounded `cmd &` keeps them). */
const PRELAUNCH_DRAIN_MS = 1_000

/**
 * `sh -c` in the instance folder (the command is user-authored; see launch.md §11.2), in its own
 * process group. Resolves when the shell exits (output still held open by a backgrounded
 * grandchild is dropped after {@link PRELAUNCH_DRAIN_MS}); on timeout or abort the whole group is
 * killed, so the launch never hangs on it.
 */
export const runPreLaunchCommand: PreLaunchRunner = (command, { cwd, env, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stderr = ''
    const keep = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096)
    }
    child.stderr?.on('data', keep)
    child.stdout?.on('data', (c: Buffer) => log.info(`pre-launch: ${c.toString('utf8').trimEnd().slice(0, 2000)}`))
    let settled = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      signal.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      settle()
    }
    const timer = setTimeout(() => {
      killGroup()
      finish(() => resolve({ code: null, stderr }))
    }, timeoutMs)
    const onAbort = () => {
      killGroup()
      finish(() => reject(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (e) => finish(() => reject(e)))
    child.once('exit', (code) => {
      drainTimer = setTimeout(() => finish(() => resolve({ code, stderr })), PRELAUNCH_DRAIN_MS)
    })
    child.once('close', (code) => finish(() => resolve({ code, stderr })))
  })

/** Log lines for the ring and the view, with the session's secrets (token, `token:<t>:<uuid>`) redacted. */
function toLines(events: readonly LogEvent[], secrets: readonly string[] = []): Omit<Events['launch:log']['lines'][number], 'seq'>[] {
  return events.map((e) => {
    const text = e.throwable ? `${e.message}\n${e.throwable}` : e.message
    return {
      time: e.time,
      level: e.level,
      stream: e.stream,
      thread: e.thread ?? null,
      logger: e.logger ?? null,
      text: secrets.length > 0 ? (redactArgs([text], secrets)[0] as string) : text,
    }
  })
}

/** Normalise any pipeline failure to a typed, RPC-friendly error. */
function launchError(e: unknown, signal: AbortSignal): AppError {
  if (signal.aborted || isAbortError(e)) return new AppError('ECANCELLED', 'The launch was cancelled')
  if (e instanceof AppError) return e
  const code = errorCode(e) ?? 'ELAUNCH_FAILED'
  const details = (e as { details?: unknown }).details
  return new AppError(code, errorMessage(e), details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined, { cause: e })
}

export class LaunchManager {
  readonly #d: LaunchDeps
  readonly #game: GameApi
  readonly #runs = new Map<string, Run>()
  readonly #subscribers = new Map<string, number>()
  readonly #pending = new Map<string, { launchId: string; lines: Events['launch:log']['lines']; gap: boolean }>()
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  readonly #hiddenBy = new Set<string>()
  /** The version id each active run launches. */
  readonly #versionOf = new Map<string, string>()
  /** Running games on disk, so a restarted runtime adopts them again. */
  readonly #running: RunningGamesStore
  /** Serialises the running-games bookkeeping (add after spawn, remove on exit, adoption). */
  #runningQueue: Promise<unknown> = Promise.resolve()
  #clientId: Promise<string | undefined> | undefined

  constructor(deps: LaunchDeps) {
    this.#d = deps
    this.#game = { ...defaultGame, ...deps.game }
    this.#running = new RunningGamesStore(deps.layout.runningGames)
  }

  #queueRunning<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.#runningQueue.then(fn).catch((e: unknown) => {
      log.warn('cannot update the running-games record', e)
      return undefined
    })
    this.#runningQueue = next
    return next
  }

  /** The per-install `${clientid}`; a storage failure never blocks a launch. */
  #getClientId(): Promise<string | undefined> {
    this.#clientId ??= loadClientId(this.#d.layout.clientId).catch((e: unknown) => {
      log.warn('cannot read or store the launcher client id', e)
      this.#clientId = undefined
      return undefined
    })
    return this.#clientId
  }

  /** True while the instance is launching or running (instances use this to refuse rename/delete). */
  isActive(instanceId: string): boolean {
    const run = this.#runs.get(instanceId)
    return run !== undefined && run.phase !== 'exited'
  }

  /** True while a launch or a game uses this version id. */
  isVersionRunning(versionId: string): boolean {
    for (const run of this.#runs.values()) if (run.phase !== 'exited' && this.#versionOf.get(run.launchId) === versionId) return true
    return false
  }

  #emitState(run: Run, state: LaunchState): void {
    this.#d.emit('launch:state', { instanceId: run.instanceId, launchId: run.launchId, ...state } as Events['launch:state'])
  }

  // -------------------------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------------------------

  async launch(instanceId: string, options: LaunchOptions = {}): Promise<LaunchStarted> {
    const clickAt = performance.now()
    if (this.isActive(instanceId)) throw new AppError('EBUSY', 'This instance is already running')
    if (this.#d.install.isBusy(instanceId)) throw new AppError('EBUSY', 'Wait for the install to finish')
    if (this.#d.isChanging?.(instanceId)) throw new AppError('EBUSY', 'Wait for the modpack or version change to finish')
    const inst = this.#d.instances.resolve(instanceId)
    const run: Run = {
      instanceId,
      launchId: randomUUID(),
      phase: 'preparing',
      step: null,
      controller: new AbortController(),
      pid: 0,
      startedAt: 0,
      ready: false,
      hidLauncher: false,
      log: new LogRing(this.#d.logCapacity),
      gameDir: inst.dir,
    }
    this.#runs.delete(instanceId)
    this.#runs.set(instanceId, run)
    this.#trimRuns()
    this.#d.instances.setActivity(instanceId, 'launching')
    const timings: [LaunchStep, number][] = []
    try {
      const started = await this.#pipeline(run, inst, options ?? {}, timings, clickAt)
      const breakdown = timings.map(([s, ms]) => `${s} ${ms.toFixed(0)}`).join(', ')
      log.info(`launched “${inst.config.name}” (pid ${started.pid}) in ${started.clickToSpawnMs} ms: ${breakdown}`)
      return started
    } catch (e) {
      const error = launchError(e, run.controller.signal)
      this.#versionOf.delete(run.launchId)
      run.phase = 'exited'
      run.step = null
      this.#d.instances.setActivity(instanceId, 'idle')
      this.#emitState(run, { state: 'failed', code: error.code, message: error.message })
      // Typed failures are expected conditions; only report the unexpected ones (if the user allows it).
      if (error.code === 'ELAUNCH_FAILED') this.#d.telemetry.reportError(e, { source: 'runtime', handled: true })
      log.warn(`launch of “${inst.config.name}” failed after ${(performance.now() - clickAt).toFixed(0)} ms (${timings.map(([s, ms]) => `${s} ${ms.toFixed(0)}`).join(', ')}): ${error.code} ${error.message}`)
      throw error
    }
  }

  async #pipeline(run: Run, inst: ResolvedInstance, options: LaunchOptions, timings: [LaunchStep, number][], clickAt: number): Promise<LaunchStarted> {
    const { layout, settings } = this.#d
    const game = this.#game
    const signal = run.controller.signal
    const root = layout.minecraft
    const versionsDir = path.join(root, 'versions')
    const config = inst.config
    const overrides = config.overrides
    const g = settings.value.game

    const step = async <T>(name: LaunchStep, fn: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted()
      run.step = name
      this.#emitState(run, { state: 'preparing', step: name })
      const t = performance.now()
      try {
        return await fn()
      } finally {
        timings.push([name, performance.now() - t])
      }
    }

    // The account refresh may need the network: start it now, await it at its step.
    const sessionPromise: Promise<Session> = (async () => {
      const accounts = await this.#d.accounts()
      const id = options.accountId ?? accounts.list().find((a) => a.selected)?.id
      if (!id) throw new AppError('EACCOUNT_REQUIRED', 'Add an account before playing')
      return accounts.sessionForLaunch(id)
    })()
    sessionPromise.catch(() => {})

    // 1. Resolve (install first when needed).
    let versionId = config.versionId
    let resolved = await step('resolve', async () => {
      await this.#d.recoverModpack?.(inst.dir)
      if (!versionId || !(await isInstalled(root, versionId))) return undefined
      try {
        const r = await game.resolveVersion(versionsDir, versionId, { signal })
        // A version that no longer matches the instance's runtime is re-installed.
        return r.minecraftVersion === config.runtime.minecraft ? r : undefined
      } catch (e) {
        if (String(errorCode(e)).startsWith('EVERSION_')) return undefined
        throw e
      }
    })
    if (!resolved) {
      resolved = await step('install', async () => {
        versionId = (await this.#d.install.install(inst.id, { signal })).versionId
        return game.resolveVersion(versionsDir, versionId, { signal })
      })
    }
    const version = resolved
    this.#versionOf.set(run.launchId, versionId)

    // 2. Java.
    const choice: JavaChoice = await step('java', async () => {
      const requirement = await this.#d.java.requirementFor(inst.id, version)
      return this.#d.java.forLaunch({ requirement, ...(overrides.javaPath ? { pinnedPath: overrides.javaPath } : {}) }, { signal })
    })
    const jvmArch = choice.java.arch === 'x64' ? 'x64' : 'arm64'
    if (choice.result.rosetta) log.warn(`launching with an x86_64 Java under Rosetta: ${choice.java.path}`)

    // 3. Natives plan for the JVM's real architecture.
    const replace = g.replaceArm64Natives !== 'off'
    const plan: NativesPlan = await step('natives', async () => {
      const lwjgl2 = jvmArch === 'arm64' && replace && usesLwjgl2(version) ? await this.#d.natives.get(signal) : undefined
      const p = game.planNatives(version, { jvmArch, replace, ...(this.#d.osVersion ? { osVersion: this.#d.osVersion } : {}), ...(lwjgl2 ? { lwjgl2 } : {}) })
      if (!p.ok) {
        throw new AppError('ENATIVES_UNAVAILABLE', `Minecraft ${version.minecraftVersion} cannot start on Apple Silicon yet: ${p.issues.map((i) => i.message).join('; ')}`, {
          version: version.id,
          libraries: p.issues.map((i) => i.library),
        })
      }
      return p
    })

    // 4. Verify (fast) and repair.
    const skipVerify = overrides.skipAssetVerification ?? g.skipVerification
    const trustBefore = await installTimestamp(root, versionId)
    const issues = await step('verify', () =>
      game.diagnose(version, root, { natives: plan, hash: skipVerify ? 'never' : 'suspect', assets: !skipVerify, ...(trustBefore !== undefined ? { trustBefore } : {}), signal }),
    )
    const fixable = issues.filter((i) => i.problem !== 'unavailable')
    if (fixable.length > 0) await step('repair', () => this.#repair(run, inst, versionId, version, plan, fixable, choice, trustBefore))

    // 5. Account.
    const session = await step('account', async () => {
      // The refresh takes no signal: bound it, and let a cancel through at once.
      const s = await new Promise<Session>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AppError('ETIMEOUT', 'Refreshing the account took too long. Check the connection and try again.', { step: 'account' })),
          this.#d.accountTimeoutMs ?? ACCOUNT_TIMEOUT_MS,
        )
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        sessionPromise.then(resolve, reject).finally(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        })
      })
      this.#d.telemetry.redact(s.username)
      return s
    })

    // 6. Pre-launch command.
    // Never pass code-injecting variables (DYLD_*, JAVA_TOOL_OPTIONS…), even from an older file.
    const env = withoutUnsafeEnv({ ...g.env, ...overrides.env })
    const preLaunch = (overrides.preLaunchCommand ?? g.preLaunchCommand).trim()
    if (preLaunch) {
      await step('prelaunch', async () => {
        const runner = this.#d.preLaunch ?? runPreLaunchCommand
        const r = await runner(preLaunch, { cwd: inst.dir, env: sanitizeEnv(process.env, env), signal, timeoutMs: PRELAUNCH_TIMEOUT_MS })
        if (r.code !== 0) throw new AppError('EPRELAUNCH_FAILED', `The pre-launch command exited with ${r.code ?? 'a signal'}`, { exitCode: r.code, stderr: r.stderr })
      })
    }

    // 7. Natives, legacy assets and the command line.
    const command = await step('build', async () => {
      const librariesDir = path.join(root, 'libraries')
      const assetsDir = path.join(root, 'assets')
      const nativesDir = nativesDirectory(versionsDir, version.id, plan)
      await Promise.all([
        game.extractNatives(plan, { librariesDir, nativesDir, signal }),
        version.assets === 'legacy' || version.assets === 'pre-1.6' ? game.prepareLegacyAssets({ assetsDir, assets: version.assets, gameDir: inst.dir, signal }) : undefined,
      ])
      return game.buildLaunchCommand(version, await this.#commandOptions(inst, options, choice, plan, nativesDir, session, env))
    })
    for (const w of command.warnings) log.warn(`${version.id}: ${w}`)

    // 8. Spawn.
    run.secrets = command.secrets
    if (plan.lwjgl) run.lwjgl = plan.lwjgl
    const proc = await step('spawn', () =>
      game.launch(command, {
        detached: true,
        onLog: (events) => this.#onLog(run, events),
        onReady: () => this.#onReady(run, inst),
        readyFallbackMs: 60_000,
      }),
    )
    if (signal.aborted) {
      void proc.kill(0)
      throw new AppError('ECANCELLED', 'The launch was cancelled')
    }
    const clickToSpawnMs = Math.round(performance.now() - clickAt)
    run.phase = 'running'
    run.step = null
    run.pid = proc.pid
    run.startedAt = proc.startedAt
    run.process = proc
    this.#d.instances.setActivity(inst.id, 'running')
    this.#emitState(run, { state: 'running', pid: proc.pid, startedAt: proc.startedAt, ready: false })
    log.info(`command: ${redactCommand(command)}`)
    this.#d.telemetry.capture('launch_started')
    this.#d.telemetry.capture('perf_launch', { clickToSpawnMs })
    void proc.exited.then((result) => this.#onExit(run, inst, result))
    this.#remember(run, versionId)
    // Cancelling after the spawn stops the game.
    signal.addEventListener('abort', () => void proc.kill(), { once: true })
    return { launchId: run.launchId, pid: proc.pid, startedAt: proc.startedAt, clickToSpawnMs }
  }

  async #repair(run: Run, inst: ResolvedInstance, versionId: string, version: ResolvedVersion, plan: NativesPlan, issues: DiagnoseIssue[], choice: JavaChoice, trustBefore: number | undefined): Promise<void> {
    const http = await this.#d.http()
    const root = this.#d.layout.minecraft
    const game = this.#game
    log.info(`${issues.length} file(s) of ${versionId} need repair: ${issues.slice(0, 5).map((i) => `${i.name} (${i.problem})`).join(', ')}${issues.length > 5 ? ', …' : ''}`)
    await this.#d.tasks.runAndWait(
      { name: 'launch.repair', params: { name: inst.config.name, files: issues.length }, instanceId: inst.id },
      async (ctx) => {
        if (issues.every((i) => i.url)) {
          const r = await game.installMissing(issues, { root, http, ctx })
          if (r.unresolved.length > 0) throw new AppError('EINSTALL_INCOMPLETE', `${r.unresolved.length} file(s) could not be repaired`, { files: r.unresolved.map((i) => i.name) })
          return
        }
        const r = await game.repairVersion(versionId, {
          root,
          http,
          ctx,
          java: choice.java.path,
          diagnose: (signal) => game.diagnose(version, root, { natives: plan, hash: 'suspect', ...(trustBefore !== undefined ? { trustBefore } : {}), ...(signal ? { signal } : {}) }),
        })
        const left = r.after.filter((i) => i.problem !== 'unavailable')
        if (left.length > 0) throw new AppError('EINSTALL_INCOMPLETE', `${left.length} file(s) could not be repaired`, { files: left.map((i) => i.name) })
      },
      { signal: run.controller.signal },
    )
    await touchInstallLock(root, versionId)
  }

  async #modCount(dir: string): Promise<number> {
    const names = await readdir(path.join(dir, 'mods')).catch(() => [] as string[])
    return names.filter((n) => n.endsWith('.jar')).length
  }

  async #commandOptions(
    inst: ResolvedInstance,
    options: LaunchOptions,
    choice: JavaChoice,
    plan: NativesPlan,
    nativesDir: string,
    session: Session,
    env: Record<string, string>,
  ): Promise<BuildLaunchOptions> {
    const g = this.#d.settings.value.game
    const o = inst.config.overrides
    const clientId = await this.#getClientId()
    const memory = o.memory ?? (g.memory.mode === 'unassigned' ? undefined : { mode: g.memory.mode, minMB: g.memory.minMB, maxMB: g.memory.maxMB })
    let heap: { minMB?: number; maxMB?: number } | undefined
    if (memory?.mode === 'auto') heap = autoMemory(await this.#modCount(inst.dir), this.#d.totalMemoryMB?.() ?? Math.round(totalmem() / 1048576))
    else if (memory?.mode === 'manual') heap = { ...(memory.minMB > 0 ? { minMB: memory.minMB } : {}), ...(memory.maxMB > 0 ? { maxMB: memory.maxMB } : {}) }

    const jvmArgs = o.jvmArgs ?? (g.jvmArgs.length > 0 ? g.jvmArgs : undefined)
    const gameArgs = o.gameArgs ?? g.gameArgs
    const wrapper = (o.wrapperCommand ?? g.wrapperCommand).trim()
    const width = o.window?.width ?? g.resolution.width
    const height = o.window?.height ?? g.resolution.height
    const fullscreen = o.window?.fullscreen ?? g.resolution.fullscreen
    const resolution = fullscreen || (width > 0 && height > 0) ? { ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}), fullscreen } : undefined

    let quickPlay: QuickPlay | undefined
    if (options.quickPlay) quickPlay = options.quickPlay
    else if (options.server?.host) quickPlay = { type: 'multiplayer', host: options.server.host, ...(options.server.port ? { port: options.server.port } : {}) }
    else if (o.autoJoinServer?.host) quickPlay = { type: 'multiplayer', host: o.autoJoinServer.host, ...(o.autoJoinServer.port ? { port: o.autoJoinServer.port } : {}) }

    return {
      java: { path: choice.java.path, arch: choice.java.arch === 'x64' ? 'x64' : 'arm64' },
      dirs: this.#d.layout.minecraft,
      gameDir: inst.dir,
      auth: {
        username: session.username,
        uuid: session.uuid,
        accessToken: session.accessToken,
        userType: session.kind === 'microsoft' ? 'msa' : 'legacy',
        ...(session.kind === 'microsoft' && session.xuid ? { xuid: session.xuid } : {}),
        ...(clientId ? { clientId } : {}),
      },
      natives: plan,
      nativesDir,
      ...(this.#d.osVersion ? { osVersion: this.#d.osVersion } : {}),
      launcherName: 'amethyst',
      launcherVersion: this.#d.version,
      dockName: inst.config.name,
      ...(heap ? { memory: heap } : {}),
      ...(jvmArgs ? { jvmArgs } : {}),
      ...(gameArgs.length > 0 ? { gameArgs } : {}),
      ...(wrapper ? { wrapper } : {}),
      ...(resolution ? { resolution } : {}),
      ...(quickPlay ? { quickPlay, quickPlayPath: path.join(inst.dir, '.amethyst', 'quickplay.json') } : {}),
      env,
    }
  }

  // -------------------------------------------------------------------------------------------
  // The running game
  // -------------------------------------------------------------------------------------------

  #onReady(run: Run, inst: ResolvedInstance): void {
    run.ready = true
    if (run.phase === 'running') this.#emitState(run, { state: 'running', pid: run.pid, startedAt: run.startedAt, ready: true })
    const hide = inst.config.overrides.hideLauncherOnLaunch ?? this.#d.settings.value.game.hideLauncherWhileRunning
    if (hide && run.phase !== 'exited') {
      run.hidLauncher = true
      if (this.#hiddenBy.size === 0) void this.#d.host.setLauncherHidden(true).catch((e: unknown) => log.warn('cannot hide the launcher', e))
      this.#hiddenBy.add(run.launchId)
    }
  }

  #onExit(run: Run, inst: ResolvedInstance, exit: LaunchResult): void {
    const printed = run.lwjgl === 2 && exit.crashed && run.log.tail(run.log.capacity).some((l) => l.text.includes('---- Minecraft Crash Report ----'))
    const result = isBenignLegacyExit(exit, run.lwjgl, printed) ? { ...exit, crashed: false } : exit
    run.phase = 'exited'
    run.result = result
    run.ready = false
    this.#versionOf.delete(run.launchId)
    void this.#queueRunning(() => this.#running.remove(run.launchId))
    const endedAt = Date.now()
    void this.#d.instances.recordPlaySession(inst.id, run.startedAt, endedAt).catch((e: unknown) => log.warn('cannot record the play session', e))
    try {
      this.#d.instances.setActivity(inst.id, 'idle')
    } catch {
      // The instance is gone.
    }
    if (run.hidLauncher) {
      this.#hiddenBy.delete(run.launchId)
      if (this.#hiddenBy.size === 0) void this.#d.host.setLauncherHidden(false).catch((e: unknown) => log.warn('cannot show the launcher', e))
    }
    this.#flushLog(run.instanceId)
    const crashReportPath = result.crashReportPath ?? result.hsErrPath ?? null
    this.#emitState(run, {
      state: 'exited',
      code: result.exitCode,
      signal: result.signal,
      crashed: result.crashed,
      killed: result.killed,
      crashReportPath,
      durationMs: result.durationMs,
      nativeLoadError: result.nativeLoadError ?? null,
    })
    const exitKind = result.killed ? 'killed' : result.crashed ? 'crash' : 'normal'
    this.#d.telemetry.capture('launch_exited', { exitKind, durationMs: Math.min(result.durationMs, 86_400_000) })
    log.info(`“${inst.config.name}” exited (${exitKind}, code ${result.exitCode ?? result.signal}) after ${Math.round(result.durationMs / 1000)} s${crashReportPath ? `; report ${crashReportPath}` : ''}`)
  }

  // -------------------------------------------------------------------------------------------
  // Games that outlive the runtime
  // -------------------------------------------------------------------------------------------

  /** Record a spawned game (pid plus the kernel's start time for it) so a restarted runtime finds it. */
  #remember(run: Run, versionId: string): void {
    const readStart = this.#d.processStart ?? processStartTime
    void this.#queueRunning(async () => {
      const processStart = await readStart(run.pid)
      if (!processStart || run.phase === 'exited') return
      await this.#running.add({ instanceId: run.instanceId, launchId: run.launchId, pid: run.pid, startedAt: run.startedAt, processStart, versionId })
    })
  }

  /**
   * Adopt the games an earlier runtime started that are still running: same pid **and** same
   * process start time (a reused pid is not ours). They count as running (busy checks, the
   * Play/Stop UI) and can be stopped; their exit is noticed by polling. Stale records are dropped.
   */
  async adoptRunning(): Promise<number> {
    const readStart = this.#d.processStart ?? processStartTime
    const alive = this.#d.isAlive ?? isAlive
    const adopted = await this.#queueRunning(async () => {
      const records = await this.#running.list()
      const keep: RunningRecord[] = []
      let count = 0
      for (const r of records) {
        const current = this.#runs.get(r.instanceId)
        if (current && current.phase !== 'exited') {
          if (current.launchId === r.launchId) keep.push(r)
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- a handful of records, checked one by one
        if (!alive(r.pid) || (await readStart(r.pid)) !== r.processStart) continue
        let inst: ResolvedInstance
        try {
          inst = this.#d.instances.resolve(r.instanceId)
        } catch {
          continue
        }
        keep.push(r)
        this.#adopt(r, inst)
        count++
      }
      if (keep.length !== records.length) await this.#running.replace(keep)
      return count
    })
    return adopted ?? 0
  }

  #adopt(r: RunningRecord, inst: ResolvedInstance): void {
    const proc = adoptedProcess(r, { pollMs: this.#d.adoptPollMs ?? 2_000, ...(this.#d.isAlive ? { alive: this.#d.isAlive } : {}), ...(this.#d.processStart ? { processStart: this.#d.processStart } : {}) })
    const run: Run = {
      instanceId: r.instanceId,
      launchId: r.launchId,
      phase: 'running',
      step: null,
      controller: new AbortController(),
      pid: r.pid,
      startedAt: r.startedAt,
      ready: true,
      hidLauncher: false,
      process: proc,
      log: new LogRing(this.#d.logCapacity),
      gameDir: inst.dir,
    }
    run.log.push({ time: Date.now(), level: 'INFO', stream: 'stdout', thread: null, logger: null, text: 'Amethyst restarted while the game was running. Earlier output is not available.' })
    this.#runs.delete(r.instanceId)
    this.#runs.set(r.instanceId, run)
    if (r.versionId) this.#versionOf.set(r.launchId, r.versionId)
    this.#d.instances.setActivity(inst.id, 'running')
    this.#emitState(run, { state: 'running', pid: r.pid, startedAt: r.startedAt, ready: true })
    void proc.exited.then((result) => this.#onExit(run, inst, result))
    log.info(`adopted “${inst.config.name}” (pid ${r.pid}), started ${new Date(r.startedAt).toISOString()} before a runtime restart`)
  }

  /** Wait for pending running-games writes (tests and shutdown). */
  async flushRunning(): Promise<void> {
    await this.#runningQueue
    await this.#running.flush()
  }

  #onLog(run: Run, events: readonly LogEvent[]): void {
    const lines = toLines(events, run.secrets).map((l) => run.log.push(l))
    if ((this.#subscribers.get(run.instanceId) ?? 0) <= 0) return
    let pending = this.#pending.get(run.instanceId)
    if (!pending || pending.launchId !== run.launchId) {
      pending = { launchId: run.launchId, lines: [], gap: pending !== undefined }
      this.#pending.set(run.instanceId, pending)
    }
    pending.lines.push(...lines)
    if (pending.lines.length > MAX_BATCH_LINES) {
      pending.lines.splice(0, pending.lines.length - MAX_BATCH_LINES)
      pending.gap = true
    }
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = undefined
      for (const id of this.#pending.keys()) this.#flushLog(id)
    }, this.#d.logBatchMs ?? 100)
  }

  #flushLog(instanceId: string): void {
    const pending = this.#pending.get(instanceId)
    if (!pending) return
    this.#pending.delete(instanceId)
    if (pending.lines.length === 0) return
    this.#d.emit('launch:log', { instanceId, launchId: pending.launchId, lines: pending.lines, gap: pending.gap })
  }

  /** Keep the logs of at most {@link MAX_FINISHED_RUNS} exited runs (the oldest are dropped). */
  #trimRuns(): void {
    const finished = [...this.#runs.values()].filter((r) => r.phase === 'exited')
    for (const r of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RUNS))) this.#runs.delete(r.instanceId)
  }

  async kill(instanceId: string, options: { force?: boolean } = {}): Promise<void> {
    const run = this.#runs.get(instanceId)
    if (!run || run.phase === 'exited') return
    if (run.phase === 'preparing') {
      run.controller.abort('Cancelled by the user')
      return
    }
    void run.process?.kill(options?.force ? 0 : 10_000)
  }

  listRunning(): RunningGame[] {
    return [...this.#runs.values()]
      .filter((r) => r.phase !== 'exited')
      .map((r) => ({ instanceId: r.instanceId, launchId: r.launchId, phase: r.phase === 'running' ? 'running' : 'preparing', step: r.step, pid: r.pid, startedAt: r.startedAt, ready: r.ready }))
  }

  getLog(instanceId: string, options: { since?: number; limit?: number } = {}): GameLogPage {
    const run = this.#runs.get(instanceId)
    if (!run) return { launchId: null, lines: [], nextSeq: 0, dropped: 0, running: false }
    const since = Number.isInteger(options?.since) && (options.since as number) >= 0 ? (options.since as number) : 0
    const limit = Number.isInteger(options?.limit) ? Math.min(Math.max(1, options.limit as number), 5_000) : 1_000
    const page = run.log.since(since, limit)
    return { launchId: run.launchId, lines: page.lines, nextSeq: page.nextSeq, dropped: page.dropped, running: run.phase !== 'exited' }
  }

  subscribeLog(instanceId: string): void {
    this.#subscribers.set(instanceId, (this.#subscribers.get(instanceId) ?? 0) + 1)
  }

  unsubscribeLog(instanceId: string): void {
    const n = (this.#subscribers.get(instanceId) ?? 0) - 1
    if (n <= 0) {
      this.#subscribers.delete(instanceId)
      this.#pending.delete(instanceId)
    } else this.#subscribers.set(instanceId, n)
  }

  async openCrashReport(instanceId: string): Promise<CrashReport> {
    const run = this.#runs.get(instanceId)
    const file = run?.result?.crashReportPath ?? run?.result?.hsErrPath
    if (!run || !file) throw new AppError('ENOT_FOUND', 'The last run left no crash report')
    // Only files the game wrote into its own folder (crash reports, hs_err logs).
    const rel = path.relative(run.gameDir, path.resolve(file))
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('ENOT_FOUND', 'The crash report is outside the instance folder')
    const handle = await open(file, 'r').catch(() => {
      throw new AppError('ENOT_FOUND', 'The crash report is gone')
    })
    try {
      const { size } = await handle.stat()
      const buffer = Buffer.alloc(Math.min(size, MAX_CRASH_BYTES))
      await handle.read(buffer, 0, buffer.length, 0)
      return { path: file, kind: /hs_err_pid\d+\.log$/.test(file) ? 'jvm' : 'crash-report', text: buffer.toString('utf8'), truncated: size > MAX_CRASH_BYTES }
    } finally {
      await handle.close()
    }
  }

  /**
   * Shutdown: stop flushing and cancel launches still being prepared, so their downloads and
   * pre-launch command do not outlive the app. Running games keep running (they are detached).
   */
  dispose(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    for (const run of this.#runs.values()) if (run.phase === 'preparing') run.controller.abort('The launcher is quitting')
  }
}

/** The RPC facade. */
export function launchService(manager: LaunchManager): LaunchService {
  return {
    launch: (id, options) => manager.launch(id, options),
    kill: (id, options) => manager.kill(id, options),
    listRunning: async () => manager.listRunning(),
    getLog: async (id, options) => manager.getLog(id, options),
    subscribeLog: async (id) => manager.subscribeLog(id),
    unsubscribeLog: async (id) => manager.unsubscribeLog(id),
    openCrashReport: (id) => manager.openCrashReport(id),
  }
}
