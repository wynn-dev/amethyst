import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import { mapLimit } from '@amethyst/task'
import type { ProbeCache } from './cache'
import { type JavaHomeEntry, listJavaHomes } from './javahome'
import { probeJava, type SpawnPolicy } from './probe'
import type { JavaRecord, JavaSource } from './types'

/** A `bin/java` path to probe and where it came from. */
export interface JavaCandidate {
  path: string
  source: JavaSource
}

export interface DiscoverOptions {
  /** Home directory for user-level sources (default `os.homedir()`). */
  home?: string
  /** Environment for `JAVA_HOME`, `PATH`, `SDKMAN_DIR`... (default `process.env`). */
  env?: NodeJS.ProcessEnv
  /**
   * Prefix for system-wide locations (`/Library`, `/opt/homebrew`, `/usr/local`). Default `/`.
   * Tests point it at a fixture tree.
   */
  root?: string
  /** Amethyst's managed runtimes directory. */
  runtimesDir?: string
  /** User-added paths: a `bin/java`, a JDK home or a `.jdk` bundle. Kept even when missing. */
  extraPaths?: readonly string[]
  /** Paths the user removed; matched against both the discovered path and its realpath. */
  hidden?: Iterable<string>
  /**
   * JVMs from `java_home`. Default: run `/usr/libexec/java_home`. `false` skips it; a function
   * replaces it (tests).
   */
  javaHome?: false | ((signal?: AbortSignal) => Promise<JavaHomeEntry[]>)
  cache?: ProbeCache
  spawn?: SpawnPolicy
  /** Probes in flight at once (default 4). */
  concurrency?: number
  timeoutMs?: number
  hostArch?: 'arm64' | 'x64'
  signal?: AbortSignal
}

/** The Apple stub: forwards to whatever `java_home` picks, or pops an install dialog. Never probe it. */
const APPLE_STUB = '/usr/bin/java'

/** Source priority when several paths alias one binary: lower wins. */
const PRIORITY: Partial<Record<JavaSource, number>> = { managed: 0, java_home: 1, manual: 2 }

/**
 * Expand a path whose segments may contain `*` wildcards (e.g. `openjdk*`, `*`) into the
 * existing directories it matches. Entries starting with `.` only match a literal `.` pattern.
 */
async function globDirs(base: string, segments: readonly string[]): Promise<string[]> {
  if (segments.length === 0) return [base]
  const [head, ...rest] = segments as [string, ...string[]]
  if (!head.includes('*')) return globDirs(join(base, head), rest)
  let names: string[]
  try {
    names = await readdir(base)
  } catch {
    return []
  }
  const re = new RegExp(`^${head.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  const matches = names.filter((n) => re.test(n) && (!n.startsWith('.') || head.startsWith('.'))).toSorted()
  const nested = await Promise.all(matches.map((n) => globDirs(join(base, n), rest)))
  return nested.flat()
}

/** `X/bin/java` or `X/Contents/Home/bin/java`, whichever exists (both when both do). */
async function javaIn(dir: string): Promise<string[]> {
  const options = [join(dir, 'bin', 'java'), join(dir, 'Contents', 'Home', 'bin', 'java'), join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')]
  const found = await Promise.all(options.map(async (p) => ((await stat(p).catch(() => undefined))?.isFile() ? p : undefined)))
  return found.filter((p): p is string => p !== undefined)
}

/** Every `bin/java` under the directories matching `base/segments`. */
async function fromDirs(source: JavaSource, base: string, segments: string[], skip?: (dir: string) => boolean): Promise<{ source: JavaSource; paths: string[] }> {
  const dirs = (await globDirs(base, segments)).filter((d) => !skip?.(d))
  const found = await Promise.all(dirs.map(javaIn))
  return { source, paths: found.flat() }
}

/**
 * Enumerate candidate executables from every macOS source, in priority order: managed runtimes,
 * `java_home`, user-added paths, the JavaVirtualMachines folders, Homebrew (arm64 and Intel
 * prefixes), SDKMAN, asdf, mise, jenv, Gradle toolchains, Mojang launcher runtimes, `JAVA_HOME`
 * and `PATH`. Not de-duplicated; see {@link discoverJava}.
 */
export async function findJavaCandidates(options: DiscoverOptions = {}): Promise<JavaCandidate[]> {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const root = options.root ?? '/'
  const sys = (...p: string[]) => join(root, ...p)
  const out: JavaCandidate[] = []
  const add = (source: JavaSource, paths: string[]) => {
    for (const path of paths) out.push({ path, source })
  }

  const javaHomes = async (): Promise<JavaCandidate[]> => {
    if (options.javaHome === false) return []
    const entries = await (options.javaHome ? options.javaHome(options.signal) : listJavaHomes({ signal: options.signal })).catch(() => [])
    return entries.filter((e) => e.enabled !== false).map((e) => ({ path: join(e.home, 'bin', 'java'), source: 'java_home' as const }))
  }

  const extra = async (): Promise<JavaCandidate[]> => {
    const result: JavaCandidate[] = []
    for (const raw of options.extraPaths ?? []) {
      const p = resolve(raw)
      // oxlint-disable-next-line no-await-in-loop -- a few user paths, checked in order
      const st = await stat(p).catch(() => undefined)
      if (st?.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop
        const found = await javaIn(p)
        result.push(...(found.length ? found : [join(p, 'bin', 'java')]).map((path) => ({ path, source: 'manual' as const })))
      } else result.push({ path: p, source: 'manual' })
    }
    return result
  }

  const mise = env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'mise')
  const sdkman = env.SDKMAN_DIR ?? join(home, '.sdkman')
  const asdf = env.ASDF_DATA_DIR ?? join(home, '.asdf')
  const groups = await Promise.all([
    options.runtimesDir ? fromDirs('managed', options.runtimesDir, ['*']) : { source: 'managed' as const, paths: [] },
    javaHomes().then((c) => ({ source: 'java_home' as const, paths: c.map((x) => x.path) })),
    extra().then((c) => ({ source: 'manual' as const, paths: c.map((x) => x.path) })),
    fromDirs('system', sys('Library', 'Java', 'JavaVirtualMachines'), ['*']),
    fromDirs('user', join(home, 'Library', 'Java', 'JavaVirtualMachines'), ['*']),
    fromDirs('homebrew', sys('opt', 'homebrew', 'opt'), ['openjdk*', 'libexec', 'openjdk.jdk']),
    fromDirs('homebrew', sys('opt', 'homebrew', 'Cellar'), ['openjdk*', '*', 'libexec', 'openjdk.jdk']),
    fromDirs('homebrew-intel', sys('usr', 'local', 'opt'), ['openjdk*', 'libexec', 'openjdk.jdk']),
    fromDirs('homebrew-intel', sys('usr', 'local', 'Cellar'), ['openjdk*', '*', 'libexec', 'openjdk.jdk']),
    fromDirs('sdkman', join(sdkman, 'candidates', 'java'), ['*'], (d) => basename(d) === 'current'),
    fromDirs('asdf', join(asdf, 'installs', 'java'), ['*']),
    fromDirs('mise', join(mise, 'installs', 'java'), ['*']),
    fromDirs('jenv', join(home, '.jenv', 'versions'), ['*']),
    fromDirs('gradle', join(home, '.gradle', 'jdks'), ['*']),
    fromDirs('mojang-launcher', join(home, 'Library', 'Application Support', 'minecraft', 'runtime'), ['*', '*', '*']),
  ])
  for (const g of groups) add(g.source, g.paths)

  if (env.JAVA_HOME) out.push({ path: join(env.JAVA_HOME, 'bin', 'java'), source: 'java-home-env' })
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && dir.startsWith('/')) out.push({ path: join(dir, 'java'), source: 'path' })
  }
  return out
}

/**
 * Find and probe every Java on this Mac. Candidates are de-duplicated by realpath (and
 * `(dev, inode)` for hard links), keeping the managed path, then the `java_home` path, then the
 * first found. The Apple `/usr/bin/java` stub and hidden paths are dropped. Missing candidates
 * are dropped too, except user-added ones, which are returned as `missing` records.
 *
 * Probes run with bounded concurrency and go through `cache`, so a rescan of unchanged JDKs is
 * one `stat` + `realpath` each and spawns nothing.
 */
export async function discoverJava(options: DiscoverOptions = {}): Promise<JavaRecord[]> {
  const candidates = await findJavaCandidates(options)
  const hidden = new Set([...(options.hidden ?? [])].map((p) => resolve(p)))
  const root = options.root ?? '/'
  const stub = join(root, APPLE_STUB)

  const resolved = await mapLimit(
    candidates,
    16,
    async (c) => {
      const st = await stat(c.path).catch(() => undefined)
      const real = st ? await realpath(c.path).catch(() => undefined) : undefined
      return { ...c, path: resolve(c.path), real, key: st && st.isFile() ? `${st.dev}:${st.ino}` : undefined }
    },
    options.signal,
  )

  const byKey = new Map<string, (typeof resolved)[number]>()
  const missing: JavaCandidate[] = []
  for (const c of resolved) {
    if (hidden.has(c.path) || (c.real && hidden.has(c.real))) continue
    if (c.path === APPLE_STUB || c.real === APPLE_STUB || c.path === stub || c.real === stub) continue
    if (!c.real || !c.key) {
      if (c.source === 'manual' && !missing.some((m) => m.path === c.path)) missing.push(c)
      continue
    }
    const key = c.key
    const existing = byKey.get(key)
    if (!existing || (PRIORITY[c.source] ?? 9) < (PRIORITY[existing.source] ?? 9)) byKey.set(key, c)
  }

  const unique = [...byKey.values()]
  const records = await mapLimit(
    [...unique, ...missing],
    options.concurrency ?? 4,
    (c) =>
      probeJava(c.path, {
        source: c.source,
        cache: options.cache,
        spawn: options.spawn,
        timeoutMs: options.timeoutMs,
        managedDir: options.runtimesDir,
        hostArch: options.hostArch,
        env: options.env,
        signal: options.signal,
      }),
    options.signal,
  )
  return records
}
