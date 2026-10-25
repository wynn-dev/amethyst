/**
 * Spawning and watching the game process (launch.md §11, §13).
 *
 * The command is spawned directly with an argv array (no shell). Both output streams are
 * line-buffered through {@link LogParser} and delivered as batched {@link LogEvent}s. Readiness
 * and crashes are detected per parsed line, and after exit the crash report and any JVM
 * `hs_err_pid*.log` written since the launch are located on disk.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { GameError } from './errors'
import type { LaunchCommand } from './command'
import { LogParser, type LogEvent } from './logs'

export interface LaunchProcessOptions {
  /** Aborting stops the game (SIGTERM, then SIGKILL after `killTimeoutMs`). */
  signal?: AbortSignal
  /** Give the game its own process group (so it survives the launcher, and kills reach wrappers). Default false. */
  detached?: boolean
  /** Batched log events, at most every `batchMs`. */
  onLog?: (events: LogEvent[]) => void
  /** Called once when the game window is considered ready. */
  onReady?: () => void
  batchMs?: number
  /** Flush early when this many events are pending (default 500). */
  maxBatch?: number
  /** Grace period between SIGTERM and SIGKILL (default 10 s). */
  killTimeoutMs?: number
  /**
   * Fallback readiness: after this long, the game counts as ready if `logs/latest.log` was written
   * since launch. Default 60 s; 0 disables.
   */
  readyFallbackMs?: number
  /**
   * After the process exits, how long to keep reading its output before giving up on the pipes
   * (a grandchild may still hold them open). Default 2 s.
   */
  drainTimeoutMs?: number
}

export interface LaunchResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Exited abnormally, printed a crash report, or left a JVM crash log. False when the user stopped it. */
  crashed: boolean
  /** Stopped through `kill()` or the abort signal. */
  killed: boolean
  ready: boolean
  durationMs: number
  crashReportPath?: string
  hsErrPath?: string
  /**
   * Native loading failure seen in the output: `architecture` for "incompatible architecture"
   * (x86_64 dylib in an arm64 JVM or the reverse), `unsatisfied-link` for other
   * `UnsatisfiedLinkError`s.
   */
  nativeLoadError?: 'architecture' | 'unsatisfied-link'
}

export interface GameProcess {
  readonly pid: number
  readonly startedAt: number
  readonly ready: boolean
  /** Resolves when the process has exited and its output is flushed. Never rejects. */
  readonly exited: Promise<LaunchResult>
  /** SIGTERM, then SIGKILL after `timeoutMs` (default `killTimeoutMs`). Resolves with the result. */
  kill(timeoutMs?: number): Promise<LaunchResult>
}

/** Output fragments that mean the client window is up (matched per line). */
export const READY_MARKERS: readonly string[] = [
  'Missing metadata in pack',
  'Registering resource reload listener',
  'Reloading ResourceManager',
  'LWJGL Version: ',
  'OpenAL initialized.',
  ' Preparing level ',
  'Sound engine started',
]

const CRASH_HEADER = '---- Minecraft Crash Report ----'
const CRASH_SAVED = /Crash report saved to:?\s*(?:#@!@#\s*)?(\S.*?)\s*$/
const HS_ERR = /^#\s*(\/\S*hs_err_pid\d+\.log)\s*$/

async function mtime(p: string): Promise<number | undefined> {
  return stat(p).then(
    (s) => (s.isFile() ? s.mtimeMs : undefined),
    () => undefined,
  )
}

/** Newest file in `dir` matching `test` whose mtime is at or after `since`. */
async function newest(dir: string, test: (name: string) => boolean, since: number): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[])
  let best: { file: string; t: number } | undefined
  const stats = await Promise.all(names.filter(test).map(async (n) => ({ file: path.join(dir, n), t: await mtime(path.join(dir, n)) })))
  for (const s of stats) if (s.t !== undefined && s.t >= since && (!best || s.t > best.t)) best = { file: s.file, t: s.t }
  return best?.file
}

function spawnError(e: NodeJS.ErrnoException, file: string): GameError {
  if (e.code === 'ENOENT') return new GameError('ELAUNCH_JAVA_NOT_FOUND', `Cannot run ${file}: not found`, { path: file }, { cause: e })
  if (e.code === 'EACCES' || e.code === 'EPERM') return new GameError('ELAUNCH_JAVA_PERMISSION', `Cannot run ${file}: not executable`, { path: file }, { cause: e })
  return new GameError('ELAUNCH_SPAWN', `Cannot start ${file}: ${e.message}`, { path: file, errno: e.code }, { cause: e })
}

/**
 * Start the game. Resolves once the process is running; spawn failures reject with
 * `ELAUNCH_JAVA_NOT_FOUND`, `ELAUNCH_JAVA_PERMISSION` or `ELAUNCH_SPAWN`.
 */
export async function launch(command: Pick<LaunchCommand, 'java' | 'args' | 'cwd' | 'env'> & { wrapper?: readonly string[] }, options: LaunchProcessOptions = {}): Promise<GameProcess> {
  options.signal?.throwIfAborted()
  const argv = [...(command.wrapper ?? []), command.java, ...command.args]
  const file = argv[0] as string
  await mkdir(command.cwd, { recursive: true })
  // Crash files keep second-level mtimes on some filesystems; allow a little slack.
  const startedAt = Date.now()
  const since = startedAt - 2000

  const child: ChildProcess = spawn(file, argv.slice(1), {
    cwd: command.cwd,
    env: command.env,
    detached: options.detached ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (e) => reject(spawnError(e as NodeJS.ErrnoException, file)))
  })
  // Later errors (for example a failed kill) must not become unhandled 'error' events.
  child.on('error', () => {})
  const pid = child.pid as number

  let ready = false
  let killed = false
  let crashSeen = false
  let reportedPath: string | undefined
  let hsErrFromOutput: string | undefined
  let nativeLoadError: LaunchResult['nativeLoadError']
  let hsErrNext = false

  const batchMs = options.batchMs ?? 100
  const maxBatch = options.maxBatch ?? 500
  let pending: LogEvent[] = []
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (batchTimer) clearTimeout(batchTimer)
    batchTimer = undefined
    if (pending.length === 0) return
    const batch = pending
    pending = []
    options.onLog?.(batch)
  }

  const markReady = () => {
    if (ready) return
    ready = true
    options.onReady?.()
  }

  const inspect = (text: string) => {
    if (!ready && READY_MARKERS.some((m) => text.includes(m))) markReady()
    if (text.includes(CRASH_HEADER)) crashSeen = true
    const saved = CRASH_SAVED.exec(text)
    if (saved) {
      let p = saved[1] as string
      const txt = p.lastIndexOf('.txt')
      if (txt !== -1) p = p.slice(0, txt + 4)
      reportedPath = path.resolve(command.cwd, p)
    }
    if (text.includes('incompatible architecture')) nativeLoadError = 'architecture'
    else if (!nativeLoadError && text.includes('UnsatisfiedLinkError')) nativeLoadError = 'unsatisfied-link'
    // "# An error report file with more information is saved as:" then "# /path/hs_err_pid123.log".
    if (hsErrNext) {
      const m = HS_ERR.exec(text.trim())
      if (m) hsErrFromOutput = m[1]
      hsErrNext = false
    }
    if (text.includes('An error report file with more information is saved as')) hsErrNext = true
  }

  const onEvent = (event: LogEvent) => {
    inspect(event.message)
    if (event.throwable) inspect(event.throwable)
    if (!options.onLog) return
    pending.push(event)
    if (pending.length >= maxBatch) flush()
    else batchTimer ??= setTimeout(flush, batchMs)
  }
  const out = new LogParser('stdout', onEvent)
  const err = new LogParser('stderr', onEvent)
  child.stdout?.on('data', (c: Buffer) => out.push(c))
  child.stderr?.on('data', (c: Buffer) => err.push(c))

  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const fallbackMs = options.readyFallbackMs ?? 60_000
  if (fallbackMs > 0) {
    fallbackTimer = setTimeout(async () => {
      const t = await mtime(path.join(command.cwd, 'logs', 'latest.log'))
      if (t !== undefined && t >= since) markReady()
    }, fallbackMs)
    fallbackTimer.unref?.()
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined
  const exited = new Promise<LaunchResult>((resolve) => {
    // Resolve on the child's own `exit`, not on stream `close`: a grandchild that inherited the
    // pipes (for example an `osascript` the game started) can hold stdout open long after the
    // game is gone. After exit, give the pipes a bounded window to drain, then let go of them.
    let exitInfo: { code: number | null; sig: NodeJS.Signals | null } | undefined
    let finished = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    child.once('exit', (code, sig) => {
      exitInfo = { code, sig }
      drainTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        void finish(code, sig)
      }, options.drainTimeoutMs ?? 2000)
    })
    child.once('close', (code, sig) => void finish(exitInfo?.code ?? code, exitInfo?.sig ?? sig))
    const finish = async (code: number | null, sig: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      if (drainTimer) clearTimeout(drainTimer)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      out.end()
      err.end()
      flush()
      const abnormal = (code !== 0 && code !== null) || (sig !== null && !killed) || crashSeen || reportedPath !== undefined
      let crashReportPath: string | undefined
      let hsErrPath: string | undefined
      if (reportedPath && (await mtime(reportedPath)) !== undefined) crashReportPath = reportedPath
      if (abnormal && !killed) {
        crashReportPath ??= await newest(path.join(command.cwd, 'crash-reports'), (n) => n.endsWith('.txt'), since)
        if (hsErrFromOutput && (await mtime(hsErrFromOutput)) !== undefined) hsErrPath = hsErrFromOutput
        else if ((await mtime(path.join(command.cwd, `hs_err_pid${pid}.log`))) !== undefined) hsErrPath = path.join(command.cwd, `hs_err_pid${pid}.log`)
        else hsErrPath = await newest(command.cwd, (n) => /^hs_err_pid\d+\.log$/.test(n), since)
      }
      const result: LaunchResult = {
        exitCode: code,
        signal: sig,
        crashed: !killed && (abnormal || hsErrPath !== undefined),
        killed,
        ready,
        durationMs: Date.now() - startedAt,
      }
      if (crashReportPath) result.crashReportPath = crashReportPath
      if (hsErrPath) result.hsErrPath = hsErrPath
      if (nativeLoadError) result.nativeLoadError = nativeLoadError
      resolve(result)
    }
  })

  let exitedFlag = false
  exited.then(() => (exitedFlag = true))

  const signalChild = (s: NodeJS.Signals) => {
    try {
      if (options.detached) process.kill(-pid, s)
      else child.kill(s)
    } catch {
      // Already gone.
    }
  }

  const kill = (timeoutMs = options.killTimeoutMs ?? 10_000): Promise<LaunchResult> => {
    if (!exitedFlag && !killed) {
      killed = true
      signalChild('SIGTERM')
      killTimer = setTimeout(() => signalChild('SIGKILL'), timeoutMs)
    }
    return exited
  }
  const onAbort = () => void kill()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    pid,
    startedAt,
    get ready() {
      return ready
    },
    exited,
    kill,
  }
}
