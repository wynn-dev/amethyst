/**
 * Forge/NeoForge install processors: variable tables, argument substitution, output tracking and
 * execution.
 *
 * A modern install profile lists processors (small Java tools) that turn the vanilla client jar
 * into the patched Forge/NeoForge jar. Their arguments are templates:
 *
 * - `[group:artifact:version[:classifier][@ext]]` → the absolute library path of that artifact;
 * - `{NAME}` → a variable: a profile `data` entry or a built-in (`SIDE`, `MINECRAFT_JAR`,
 *   `MINECRAFT_VERSION`, `ROOT`, `INSTALLER`, `LIBRARY_DIR`).
 *
 * `data` values are themselves `[coordinate]`s, `'quoted literals'` (quotes stripped) or `/paths`
 * inside the installer jar (extracted to disk). An unknown `{NAME}` aborts the install.
 */
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeEnv } from '@amethyst/game'
import type { TaskContext } from '@amethyst/task'
import { openZip } from '@amethyst/zip'
import { abortReason } from '../abort'
import { InstallError, ProcessorError, ProcessorOutputError } from '../errors'
import { checkFile, type FileSpec } from '../files'
import { pathExists, safeJoin } from '../fs-util'
import { coordinatePath } from '../maven'
import type { Processor, ProfileData } from './profile'

/** The side being installed. Amethyst installs clients only. */
export type Side = 'client' | 'server'

/** Inputs for {@link buildVariables}. */
export interface VariableContext {
  side: Side
  /** `{ROOT}`: the Minecraft root directory. */
  root: string
  /** `{LIBRARY_DIR}`: `<root>/libraries`. */
  libraryDir: string
  /** `{MINECRAFT_JAR}`: `<root>/versions/<mc>/<mc>.jar`. */
  minecraftJar: string
  /** `{MINECRAFT_VERSION}`. */
  minecraftVersion: string
  /** `{INSTALLER}`: path of the installer jar. */
  installer: string
  /**
   * Map an in-installer path (`/data/client.lzma`) to the absolute path it was extracted to.
   * Required when a `data` value is such a path.
   */
  resolveInstallerPath?: (entry: string) => string
}

/** Absolute library path of a maven coordinate under `libraryDir` (path traversal is rejected). */
export function libraryPathOf(coordinate: string, libraryDir: string): string {
  return safeJoin(libraryDir, coordinatePath(coordinate))
}

const COORDINATE = /^\[(.+)\]$/
const LITERAL = /^'(.*)'$/s

/**
 * Turn one `data` value into its final string: `[coord]` → library path, `'literal'` → literal
 * without quotes, `/entry` → extracted installer entry, anything else unchanged.
 *
 * @throws {InstallError} `EINSTALL_BAD_INSTALLER` for an in-jar path without a resolver.
 */
export function resolveDataValue(value: string, ctx: VariableContext): string {
  const coord = COORDINATE.exec(value)
  if (coord) return libraryPathOf(coord[1] as string, ctx.libraryDir)
  const literal = LITERAL.exec(value)
  if (literal) return literal[1] as string
  if (value.startsWith('/')) {
    if (!ctx.resolveInstallerPath) throw new InstallError('EINSTALL_BAD_INSTALLER', `data value ${value} refers to an installer entry, but none can be extracted`)
    return ctx.resolveInstallerPath(value)
  }
  return value
}

/**
 * Build the variable table for one side: every `data` entry (resolved with
 * {@link resolveDataValue}) plus the built-ins, which take precedence.
 */
export function buildVariables(data: Record<string, ProfileData> | undefined, ctx: VariableContext): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(data ?? {})) vars[key] = resolveDataValue(value[ctx.side], ctx)
  vars.SIDE = ctx.side
  vars.MINECRAFT_JAR = ctx.minecraftJar
  vars.MINECRAFT_VERSION = ctx.minecraftVersion
  vars.ROOT = ctx.root
  vars.INSTALLER = ctx.installer
  vars.LIBRARY_DIR = ctx.libraryDir
  return vars
}

/**
 * Substitute one processor argument: a whole-argument `[coordinate]` becomes a library path;
 * otherwise every `{NAME}` is replaced by its variable. `\` escapes the next character.
 *
 * @throws {InstallError} `EINSTALL_UNKNOWN_VARIABLE` for an unknown `{NAME}` or an unclosed brace.
 */
export function substituteArgument(arg: string, vars: Record<string, string>, libraryDir: string): string {
  const coord = COORDINATE.exec(arg)
  if (coord) return libraryPathOf(coord[1] as string, libraryDir)
  let out = ''
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i] as string
    if (c === '\\' && i + 1 < arg.length) {
      out += arg[++i]
      continue
    }
    if (c !== '{') {
      out += c
      continue
    }
    const end = arg.indexOf('}', i + 1)
    if (end < 0) throw new InstallError('EINSTALL_UNKNOWN_VARIABLE', `unclosed variable in processor argument ${JSON.stringify(arg)}`)
    const name = arg.slice(i + 1, end)
    const value = vars[name]
    if (value === undefined) throw new InstallError('EINSTALL_UNKNOWN_VARIABLE', `unknown variable {${name}} in processor argument ${JSON.stringify(arg)}`)
    out += value
    i = end
  }
  return out
}

/** A file a processor produces. */
export interface ProcessorOutput {
  path: string
  /** Expected sha1, when the profile declares one (and it is not a rewritten `mappings.tsrg`). */
  sha1?: string
  /** `.jar`/`.zip` outputs without a sha1 must open as a non-empty zip. */
  validator?: 'zip'
}

/** Flags whose value names a file the processor writes. */
const OUTPUT_FLAGS = new Set(['--output', '--out-jar', '--slim', '--extra'])

/**
 * The outputs of a processor: its declared `outputs` (both sides substituted, quotes stripped from
 * the hashes) plus files named by `--output`, `--out-jar`, `--slim` and `--extra` arguments.
 * Directory outputs are skipped (a trailing `/`, `{ROOT}`, `{LIBRARY_DIR}`, or `BUNDLER_EXTRACT`
 * with `--libraries`/`--all`). Checksums of `*mappings.tsrg` are ignored because later processors
 * legitimately rewrite them.
 */
export function processorOutputs(processor: Processor, args: readonly string[], vars: Record<string, string>, libraryDir: string): ProcessorOutput[] {
  const outputs = new Map<string, ProcessorOutput>()
  const add = (path: string, sha1?: string) => {
    const out: ProcessorOutput = { path }
    if (sha1 && !path.endsWith('mappings.tsrg')) out.sha1 = sha1.toLowerCase()
    if (!out.sha1 && /\.(jar|zip)$/i.test(path)) out.validator = 'zip'
    outputs.set(path, out)
  }
  for (const [key, value] of Object.entries(processor.outputs ?? {})) {
    const path = substituteArgument(key, vars, libraryDir)
    const hash = substituteArgument(value, vars, libraryDir).replace(LITERAL, '$1')
    add(path, hash || undefined)
  }
  const task = args[args.indexOf('--task') + 1]
  const extractsDirectory = task === 'BUNDLER_EXTRACT' && (args.includes('--libraries') || args.includes('--all'))
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i] as string
    if (!OUTPUT_FLAGS.has(flag)) continue
    const target = args[i + 1] as string
    if (outputs.has(target)) continue
    if (target.endsWith('/') || target === vars.ROOT || target === vars.LIBRARY_DIR || (flag === '--output' && extractsDirectory)) continue
    add(target)
  }
  return [...outputs.values()]
}

/** Read `Main-Class` from a jar's `META-INF/MANIFEST.MF` (continuation lines are joined). */
export async function readMainClass(jarPath: string): Promise<string> {
  let manifest: string
  try {
    const zip = await openZip(jarPath)
    try {
      manifest = await zip.readText('META-INF/MANIFEST.MF', { maxBytes: 1024 * 1024 })
    } finally {
      await zip.close()
    }
  } catch (e) {
    throw new InstallError('EINSTALL_PROCESSOR_BAD_JAR', `cannot read the manifest of processor ${jarPath}: ${(e as Error).message}`, { path: jarPath, cause: e })
  }
  const lines: string[] = []
  for (const line of manifest.split(/\r\n|\r|\n/)) {
    if (line.startsWith(' ') && lines.length > 0) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  for (const line of lines) {
    const m = /^Main-Class:\s*(.+?)\s*$/i.exec(line)
    if (m?.[1]) return m[1]
  }
  throw new InstallError('EINSTALL_PROCESSOR_NO_MAIN_CLASS', `processor ${jarPath} has no Main-Class`, { path: jarPath })
}

/** One processor JVM invocation. */
export interface ProcessorInvocation {
  /** Path of the `java` executable. */
  java: string
  /** Extra JVM options placed before `-cp` (proxy settings, for example). */
  jvmArgs: string[]
  classpath: string[]
  mainClass: string
  args: string[]
  cwd: string
}

/** What a processor run produced. */
export interface ProcessorRunResult {
  exitCode: number | null
  signal: string | null
  /** The last (at most 64 KiB) of combined stdout/stderr. */
  log: string
  /** True when the run was killed for exceeding its timeout. */
  timedOut?: boolean
}

/** Options passed to a {@link ProcessorRunner}. */
export interface ProcessorRunOptions {
  signal?: AbortSignal
  /** Kill the processor after this long (ms). */
  timeoutMs?: number
  /** Live output, for showing progress in the UI. */
  onOutput?: (text: string) => void
  /** Base environment (default `process.env`). It is sanitised like the game's (`sanitizeEnv`). */
  baseEnv?: Record<string, string | undefined>
}

/** Runs one processor. Injectable so tests (and alternative strategies) can replace the JVM. */
export type ProcessorRunner = (invocation: ProcessorInvocation, options: ProcessorRunOptions) => Promise<ProcessorRunResult>

const LOG_LIMIT = 64 * 1024
/** How long the output pipes may stay open after a processor has exited. */
const PIPE_DRAIN_MS = 1500

/**
 * The default {@link ProcessorRunner}: `java [jvmArgs] -cp <classpath> <mainClass> <args...>` in its
 * own process group. Output is kept in a 64 KiB ring. On abort or timeout the group gets SIGTERM,
 * then SIGKILL after 5 s; the promise settles only once the process has exited (rejecting with the
 * abort reason when aborted). The environment is the game's sanitised one: no `ELECTRON_*`
 * (`ELECTRON_RUN_AS_NODE`), `NODE_OPTIONS`, `DYLD_*` or JVM-injection variables (`JAVA_TOOL_OPTIONS`,
 * `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`), so nothing in the launcher's environment can load an agent
 * or a dylib into a processor JVM.
 */
export const spawnProcessor: ProcessorRunner = (inv, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortReason(options.signal))
      return
    }
    const child = spawn(inv.java, [...inv.jvmArgs, '-cp', inv.classpath.join(':'), inv.mainClass, ...inv.args], {
      cwd: inv.cwd,
      env: sanitizeEnv(options.baseEnv ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout or cancel also stops anything the tool forked.
      detached: true,
    })
    let log = ''
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      log = (log + text).slice(-LOG_LIMIT)
      options.onOutput?.(text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const stop = () => {
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), 5000)
    }
    const onAbort = () => stop()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          stop()
        }, options.timeoutMs)
      : undefined
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
    }
    let settled = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      if (drainTimer) clearTimeout(drainTimer)
      if (options.signal?.aborted) reject(abortReason(options.signal))
      else resolve({ exitCode, signal, log, timedOut })
    }
    child.on('error', (e) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new InstallError('EINSTALL_PROCESSOR_FAILED', `cannot start ${inv.java}: ${e.message}`, { cause: e }))
    })
    // 'close' waits for the pipes too: a grandchild that escaped the process group (or a pipe kept
    // open after a timeout kill) would hold them forever. Once the processor itself has exited, give
    // the pipes a bounded time to drain, then destroy them and settle anyway.
    child.on('exit', (exitCode, signal) => {
      drainTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        settle(exitCode, signal)
      }, PIPE_DRAIN_MS)
    })
    child.on('close', (exitCode, signal) => settle(exitCode, signal))
  })

/** Options for {@link runProcessors}. */
export interface RunProcessorsOptions {
  processors: readonly Processor[]
  /** The variable table from {@link buildVariables}. */
  variables: Record<string, string>
  libraryDir: string
  /** Working directory for processors (the Minecraft root). */
  cwd: string
  side?: Side
  /** `java` executable. Required unless every processor is skipped or handled natively. */
  java?: string
  jvmArgs?: string[]
  runner?: ProcessorRunner
  /** Per-processor timeout (default 10 minutes). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Progress in processors. */
  ctx?: TaskContext
  /** Live output of the running processor. */
  onLog?: (text: string, mainClass: string) => void
  /**
   * Run a processor without Java (for example `DOWNLOAD_MOJMAPS`). Return `true` when handled; the
   * outputs are validated as usual.
   */
  handleNatively?: (processor: Processor, args: string[], outputs: ProcessorOutput[]) => Promise<boolean>
}

/** Result of {@link runProcessors}. */
export interface RunProcessorsResult {
  /** Processors executed with Java. */
  ran: number
  /** Processors handled without Java. */
  native: number
  /** Processors skipped because all their outputs were already valid. */
  skipped: number
  /** Output tail of every processor that ran, in order (for error reports). */
  logs: { mainClass: string; log: string }[]
}

function outputSpec(o: ProcessorOutput): FileSpec {
  const spec: FileSpec = { path: o.path, urls: [] }
  if (o.sha1) spec.sha1 = o.sha1
  if (o.validator) spec.validator = o.validator
  return spec
}

async function outputsValid(outputs: readonly ProcessorOutput[], signal?: AbortSignal): Promise<ProcessorOutputError | undefined> {
  for (const o of outputs) {
    // oxlint-disable-next-line no-await-in-loop -- few outputs per processor
    const problem = await checkFile(outputSpec(o), signal)
    if (problem) return new ProcessorOutputError(o.path, o.sha1, problem.reason === 'checksum' ? problem.actual : undefined)
  }
  return undefined
}

/**
 * Run the processors for one side, in order. A processor is skipped when it declares (or implies)
 * outputs and all of them are already valid. After each run the outputs are verified; on failure
 * they are deleted and a {@link ProcessorOutputError} is thrown. A non-zero exit throws a
 * {@link ProcessorError} carrying the output tail.
 *
 * @throws {InstallError} `EINSTALL_UNKNOWN_VARIABLE`, `EINSTALL_NO_JAVA`,
 * `EINSTALL_PROCESSOR_BAD_JAR`, `EINSTALL_PROCESSOR_NO_MAIN_CLASS`, `EINSTALL_PROCESSOR_FAILED`,
 * `EINSTALL_PROCESSOR_OUTPUT`; the abort reason on cancellation.
 */
export async function runProcessors(options: RunProcessorsOptions): Promise<RunProcessorsResult> {
  const side = options.side ?? 'client'
  const signal = options.signal ?? options.ctx?.signal
  const runner = options.runner ?? spawnProcessor
  const selected = options.processors.filter((p) => !p.sides || p.sides.includes(side))
  // Substitute everything up front: an unknown variable fails the install before anything runs.
  const prepared = selected.map((processor) => {
    const args = (processor.args ?? []).map((a) => substituteArgument(a, options.variables, options.libraryDir))
    return { processor, args, outputs: processorOutputs(processor, args, options.variables, options.libraryDir) }
  })
  const result: RunProcessorsResult = { ran: 0, native: 0, skipped: 0, logs: [] }
  options.ctx?.update(0, prepared.length)
  for (const [index, { processor, args, outputs }] of prepared.entries()) {
    if (signal?.aborted) throw abortReason(signal)
    // oxlint-disable-next-line no-await-in-loop -- processors depend on each other's outputs
    if (outputs.length > 0 && !(await outputsValid(outputs, signal))) {
      result.skipped++
      options.ctx?.update(index + 1, prepared.length)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (options.handleNatively && (await options.handleNatively(processor, args, outputs))) {
      result.native++
    } else {
      if (!options.java) throw new InstallError('EINSTALL_NO_JAVA', 'Forge/NeoForge processors need Java, but no Java executable was provided')
      const jar = libraryPathOf(processor.jar, options.libraryDir)
      const classpath = [...new Set([...(processor.classpath ?? []).map((c) => libraryPathOf(c, options.libraryDir)), jar])]
      // A missing classpath entry is silently ignored by the JVM and surfaces as NoClassDefFoundError.
      for (const entry of classpath) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (!(await pathExists(entry))) throw new InstallError('EINSTALL_FILE_INVALID', `processor library ${entry} is missing`, { path: entry })
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      const mainClass = await readMainClass(jar)
      options.ctx?.update(index, prepared.length, mainClass)
      // oxlint-disable-next-line no-await-in-loop -- see above
      const run = await runner(
        { java: options.java, jvmArgs: options.jvmArgs ?? [], classpath, mainClass, args, cwd: options.cwd },
        { signal, timeoutMs: options.timeoutMs ?? 10 * 60_000, onOutput: options.onLog && ((text) => options.onLog?.(text, mainClass)) },
      )
      result.logs.push({ mainClass, log: run.log })
      result.ran++
      if (run.exitCode !== 0) {
        const how = run.timedOut ? 'timed out' : run.signal ? `was killed by ${run.signal}` : `exited with code ${run.exitCode}`
        throw new ProcessorError(`processor ${mainClass} ${how}`, mainClass, run.exitCode, run.signal, run.log)
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    const bad = await outputsValid(outputs, signal)
    if (bad) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await Promise.all(outputs.map((o) => rm(o.path, { force: true })))
      throw bad
    }
    options.ctx?.update(index + 1, prepared.length)
  }
  return result
}

/** `<root>/libraries` */
export function libraryDirOf(root: string): string {
  return join(root, 'libraries')
}
