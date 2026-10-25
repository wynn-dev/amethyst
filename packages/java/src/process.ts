import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

/** Outcome of {@link runProcess}. Never rejects for exit codes; only `error` describes spawn failures. */
export interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** Set when the process could not be started (`ENOENT`, `EACCES`, `EBADARCH`...). */
  error?: NodeJS.ErrnoException
  timedOut: boolean
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Output kept per stream; the rest is dropped (default 1 MiB). */
  maxOutputBytes?: number
}

/** How long stdout/stderr may stay open after the process exited or was killed. */
const PIPE_DRAIN_MS = 1000

/**
 * Spawn a short-lived helper (`java -version`, `java_home`, `xattr`) with a timeout. stdin is
 * closed so a prompting binary cannot hang, and the process is killed on timeout or abort.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  const max = options.maxOutputBytes ?? 1024 * 1024
  return new Promise((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false
    let settled = false
    let spawnError: NodeJS.ErrnoException | undefined
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? process.env,
        cwd: options.cwd,
        signal: options.signal,
        killSignal: 'SIGKILL',
        windowsHide: true,
      })
    } catch (e) {
      // Bad executables (EBADEXEC -85, EBADARCH -86) can make spawn throw synchronously.
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: e as NodeJS.ErrnoException, timedOut: false })
      return
    }
    // 'close' waits for stdout/stderr to close, which never happens while a grandchild (a
    // wrapper's background job) or a stopped process holds the pipes. After 'exit' (or a
    // timeout/abort kill) give the pipes a bounded drain, then settle anyway.
    let drain: ReturnType<typeof setTimeout> | undefined
    const settleSoon = () => {
      drain ??= setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(child.exitCode, child.signalCode)
      }, PIPE_DRAIN_MS)
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
          settleSoon()
        }, options.timeoutMs)
      : undefined
    options.signal?.addEventListener('abort', settleSoon, { once: true })
    child.stdout.on('data', (b: Buffer) => {
      if (outLen < max) out.push(b)
      outLen += b.length
    })
    child.stderr.on('data', (b: Buffer) => {
      if (errLen < max) err.push(b)
      errLen += b.length
    })
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (drain) clearTimeout(drain)
      options.signal?.removeEventListener('abort', settleSoon)
      resolve({
        code,
        signal: sig,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: spawnError,
        timedOut,
      })
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e
      // 'close' may never follow a failed spawn.
      if (child.pid === undefined) finish(null, null)
    })
    child.on('exit', settleSoon)
    child.on('close', finish)
  })
}

/** Environment for probing a JVM: options that make it print extra lines are removed. */
export function probeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'JAVA_OPTIONS']) delete copy[key]
  return copy
}

/** Hardware facts of the Mac we run on. */
export interface HostInfo {
  /** The CPU of the machine, independent of how this process runs. */
  arch: 'arm64' | 'x64'
  /** This process runs under Rosetta 2 (`sysctl.proc_translated` is 1). */
  translated: boolean
}

let hostInfo: Promise<HostInfo> | undefined

/**
 * Detect the real hardware arch. `process.arch` reports `x64` under Rosetta, so the launcher must
 * not use it to pick runtimes. Cached for the process lifetime.
 */
export function detectHost(): Promise<HostInfo> {
  hostInfo ??= (async () => {
    const [arm, translated] = await Promise.all([
      runProcess('/usr/sbin/sysctl', ['-in', 'hw.optional.arm64'], { timeoutMs: 2000 }),
      runProcess('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeoutMs: 2000 }),
    ])
    const isArm = arm.stdout.trim() === '1' || (arm.error !== undefined && process.arch === 'arm64')
    return { arch: isArm ? 'arm64' : process.arch === 'arm64' ? 'arm64' : 'x64', translated: translated.stdout.trim() === '1' }
  })()
  return hostInfo
}
