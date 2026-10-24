import { constants } from 'node:fs'
import { access, chmod, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { ProbeCache } from './cache'
import { machOArch, readMachO } from './macho'
import { probeEnv, runProcess } from './process'
import { normalizeArch, readReleaseFile } from './release'
import type { InvalidReason, JavaArch, JavaRecord, JavaSource } from './types'
import { parseJavaVersion, parseVersionBanner } from './version'

/**
 * When to spawn the JVM:
 * - `'fallback'` (default): only when the `release` file and Mach-O header do not give both the
 *   version and the arch. Rescans of normal JDKs spawn nothing.
 * - `'always'`: spawn `java -XshowSettings:properties -version` (pre-launch validation, after a
 *   managed install). A cached record is reused only if it was already verified.
 * - `'never'`: metadata only.
 */
export type SpawnPolicy = 'fallback' | 'always' | 'never'

export interface ProbeOptions {
  spawn?: SpawnPolicy
  /** Timeout for the spawned JVM (default 10 s). */
  timeoutMs?: number
  signal?: AbortSignal
  cache?: ProbeCache
  /** Recorded on the result (default `'manual'`). */
  source?: JavaSource
  /**
   * Amethyst's managed runtimes directory. Records inside it are flagged `managed`, and a
   * non-executable binary there is chmodded to 0755 once (never outside it).
   */
  managedDir?: string
  /** Hardware arch, used to decide which slice of a universal binary runs (default `'arm64'`). */
  hostArch?: 'arm64' | 'x64'
  /** Environment for the spawn; `JAVA_TOOL_OPTIONS` and friends are always removed. */
  env?: NodeJS.ProcessEnv
}

const DEFAULT_TIMEOUT = 10_000

/**
 * Parse `-XshowSettings:properties` output (`    key = value` lines on stderr). Multi-line
 * values (e.g. `java.library.path`) are joined with `\n`.
 */
export function parseShowSettings(text: string): Record<string, string> {
  const props: Record<string, string> = {}
  let last: string | undefined
  let inProps = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Property settings:')) {
      inProps = true
      continue
    }
    const m = /^ {4}([^\s=][^=]*?) = (.*)$/.exec(line)
    if (m) {
      last = m[1] as string
      props[last] = m[2] as string
      inProps = true
      continue
    }
    if (inProps && last && /^ {8,}\S/.test(line)) {
      props[last] += `\n${line.trim()}`
      continue
    }
    last = undefined
  }
  return props
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** errno 86 on macOS: "Bad CPU type in executable" (an x86_64 binary without Rosetta). */
function isBadCpuType(e: NodeJS.ErrnoException | undefined): boolean {
  return !!e && (e.errno === -86 || e.code === 'EBADARCH' || /bad cpu type/i.test(e.message))
}

/**
 * Probe one `bin/java`. Never throws for a broken JVM: it returns a record with `valid: false`
 * and an `invalidReason`. Only cancellation rejects.
 *
 * The cheap path reads `<home>/release` (`JAVA_VERSION`, `OS_ARCH`, `IMPLEMENTOR`) and the
 * Mach-O header of the binary; arm64, x86_64 and universal binaries are told apart without
 * running anything. A JVM is spawned only per {@link SpawnPolicy}, with a timeout, a stripped
 * environment and `/` as its working directory. When it is, its `os.arch` is authoritative.
 */
export async function probeJava(javaPath: string, options: ProbeOptions = {}): Promise<JavaRecord> {
  const policy = options.spawn ?? 'fallback'
  const source = options.source ?? 'manual'
  const path = resolve(javaPath)
  const now = Date.now()
  const base = (patch: Partial<JavaRecord>): JavaRecord => ({
    path,
    realPath: path,
    javaHome: dirname(dirname(path)),
    version: '',
    majorVersion: 0,
    arch: 'unknown',
    source,
    managed: false,
    valid: false,
    verified: false,
    mtimeMs: 0,
    size: 0,
    probedAt: now,
    ...patch,
  })
  options.signal?.throwIfAborted()

  let st
  let real: string
  try {
    st = await stat(path)
    real = await realpath(path)
  } catch {
    return base({ invalidReason: 'missing' })
  }
  if (!st.isFile()) return base({ invalidReason: 'missing' })

  const managedDir = options.managedDir ? await realpath(options.managedDir).catch(() => resolve(options.managedDir as string)) : undefined
  const managed = managedDir !== undefined && isInside(real, managedDir)
  const cached = options.cache?.get(real, st.mtimeMs, st.size, now)
  if (cached && (policy !== 'always' || cached.verified)) return { ...cached, path, source: managed ? 'managed' : source, managed }

  const home = dirname(dirname(real))
  const record = base({ realPath: real, javaHome: home, managed, source: managed ? 'managed' : source, mtimeMs: st.mtimeMs, size: st.size })

  if (!(await isExecutable(real))) {
    if (managed) await chmod(real, 0o755).catch(() => {})
    if (!(await isExecutable(real))) {
      record.invalidReason = 'not-executable'
      return remember(options.cache, record)
    }
  }

  const [macho, release] = await Promise.all([readMachO(real), readReleaseFile(home)])
  let arch: JavaArch = 'unknown'
  if (macho) {
    record.machO = macho.archs
    arch = machOArch(macho, options.hostArch ?? 'arm64')
  }
  if (arch === 'unknown') arch = normalizeArch(release?.OS_ARCH)
  const releaseVersion = release?.JAVA_VERSION ? parseJavaVersion(release.JAVA_VERSION) : undefined
  record.arch = arch
  if (releaseVersion) {
    record.version = releaseVersion.version
    record.majorVersion = releaseVersion.majorVersion
  }
  if (release?.IMPLEMENTOR) record.vendor = release.IMPLEMENTOR
  if (release?.JVM_VARIANT) record.vmName = release.JVM_VARIANT

  const complete = releaseVersion !== undefined && arch !== 'unknown'
  if (policy === 'never' || (policy === 'fallback' && complete)) {
    record.valid = complete
    if (!complete) record.invalidReason = 'unparseable'
    return remember(options.cache, record)
  }

  const result = await runProcess(real, ['-XshowSettings:properties', '-version'], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: options.signal,
    env: probeEnv(options.env),
    cwd: '/',
    maxOutputBytes: 256 * 1024,
  })
  options.signal?.throwIfAborted()
  const fail = (reason: InvalidReason): JavaRecord => {
    record.valid = false
    record.invalidReason = reason
    return remember(options.cache, record)
  }
  if (result.timedOut) return fail('timeout')
  if (isBadCpuType(result.error)) return fail('bad-cpu-type')
  if (result.error) return fail('spawn-failed')

  const props = parseShowSettings(result.stderr)
  if (Object.keys(props).length === 0) Object.assign(props, parseShowSettings(result.stdout))
  const spawned =
    (props['java.version'] ? parseJavaVersion(props['java.version']) : undefined) ??
    parseVersionBanner(result.stderr) ??
    parseVersionBanner(result.stdout) ??
    (props['java.specification.version'] ? parseJavaVersion(props['java.specification.version']) : undefined)
  if (!spawned || result.code !== 0) return fail(spawned ? 'spawn-failed' : 'unparseable')

  record.version = spawned.version
  record.majorVersion = spawned.majorVersion
  const runtimeArch = normalizeArch(props['os.arch'])
  if (runtimeArch !== 'unknown') record.arch = runtimeArch
  if (props['java.vendor']) record.vendor = props['java.vendor']
  if (props['java.vm.name']) record.vmName = props['java.vm.name']
  record.valid = true
  record.verified = true
  return remember(options.cache, record)
}

function remember(cache: ProbeCache | undefined, record: JavaRecord): JavaRecord {
  cache?.set(record)
  return record
}
