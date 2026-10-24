import { randomBytes } from 'node:crypto'
import { lstat, readdir, readFile, readlink, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hashFile } from '@amethyst/net'
import { mapLimit } from '@amethyst/task'
import { writeJsonAtomic } from './cache'
import { abortError } from './errors'
import { runProcess } from './process'
import type { JavaArch } from './types'

/** Written at the root of every managed runtime; records what was installed for verify/repair. */
export const INSTALLED_MANIFEST = '.amethyst-installed.json'

/** A regular file as installed. `mtimeMs`/`size` enable the no-hash fast path. */
export interface InstalledFile {
  size: number
  mtimeMs: number
  sha1: string
  executable: boolean
}

/** Contents of {@link INSTALLED_MANIFEST}. */
export interface InstalledRuntime {
  schema: 1
  source: 'mojang' | 'zulu'
  /** Folder name under the runtimes directory (`java-runtime-delta`, `zulu-8`). */
  name: string
  component?: string
  majorVersion: number
  version: string
  arch: JavaArch
  /** `bin/java`, relative to the runtime folder. */
  javaPath: string
  installedAt: string
  mojang?: { platform: string; manifestSha1: string; manifestSize: number; manifestUrl: string }
  zulu?: { packageUuid: string; name: string; url: string; sha256: string; size: number; packageType: 'jre' | 'jdk'; javaVersion: number[] }
  files: Record<string, InstalledFile>
  /** Symlink path -> target string, both relative to the runtime folder. */
  links: Record<string, string>
}

/** A folder in the managed runtimes directory. */
export interface ManagedRuntime {
  name: string
  dir: string
  /** Absolute `bin/java`, when one exists. */
  javaPath?: string
  installed?: InstalledRuntime
}

/** Read {@link INSTALLED_MANIFEST}; `undefined` if missing or malformed. */
export async function readInstalledRuntime(dir: string): Promise<InstalledRuntime | undefined> {
  try {
    const data = JSON.parse(await readFile(join(dir, INSTALLED_MANIFEST), 'utf8')) as InstalledRuntime
    if (data?.schema !== 1 || (data.source !== 'mojang' && data.source !== 'zulu') || typeof data.javaPath !== 'string' || typeof data.files !== 'object') return undefined
    data.links ??= {}
    return data
  } catch {
    return undefined
  }
}

export async function writeInstalledRuntime(dir: string, data: InstalledRuntime): Promise<void> {
  await writeJsonAtomic(join(dir, INSTALLED_MANIFEST), data)
}

/**
 * The `bin/java` inside a runtime folder, detected by what exists (never by folder name):
 * Mojang's `jre.bundle/Contents/Home/bin/java`, a normalised `Contents/Home/bin/java`, or `bin/java`.
 */
export async function findRuntimeJava(dir: string): Promise<string | undefined> {
  for (const rel of ['jre.bundle/Contents/Home/bin/java', 'Contents/Home/bin/java', 'bin/java']) {
    const p = join(dir, ...rel.split('/'))
    // oxlint-disable-next-line no-await-in-loop -- at most three stats, in priority order
    const st = await lstat(p).catch(() => undefined)
    if (st?.isFile()) return p
  }
  return undefined
}

/** List runtime folders (dot-folders such as staging areas are ignored). */
export async function listManagedRuntimes(runtimesDir: string): Promise<ManagedRuntime[]> {
  let names: string[]
  try {
    names = (await readdir(runtimesDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  } catch {
    return []
  }
  return Promise.all(
    names.toSorted().map(async (name) => {
      const dir = join(runtimesDir, name)
      const [javaPath, installed] = await Promise.all([findRuntimeJava(dir), readInstalledRuntime(dir)])
      const r: ManagedRuntime = { name, dir }
      if (javaPath) r.javaPath = javaPath
      if (installed) r.installed = installed
      return r
    }),
  )
}

/** One verification failure. `manifest` means the install record itself is missing. */
export interface VerifyProblem {
  path: string
  problem: 'manifest' | 'missing' | 'type' | 'size' | 'hash' | 'mode' | 'link'
}

export interface VerifyReport {
  ok: boolean
  problems: VerifyProblem[]
  /** Files checked / files whose content was hashed. */
  checked: number
  hashed: number
  installed?: InstalledRuntime
}

export interface VerifyOptions {
  /** Hash every file (explicit "repair"). Default: hash only files whose size or mtime changed. */
  full?: boolean
  signal?: AbortSignal
  concurrency?: number
}

/**
 * Check a managed runtime against its {@link INSTALLED_MANIFEST}: every file exists with the
 * recorded size (and sha1 when its mtime changed, or always with `full`), executables are
 * executable, and every symlink has its recorded target.
 */
export async function verifyRuntime(dir: string, options: VerifyOptions = {}): Promise<VerifyReport> {
  const installed = await readInstalledRuntime(dir)
  if (!installed) return { ok: false, problems: [{ path: INSTALLED_MANIFEST, problem: 'manifest' }], checked: 0, hashed: 0 }
  const problems: VerifyProblem[] = []
  let hashed = 0
  const entries = Object.entries(installed.files)
  await mapLimit(
    entries,
    options.concurrency ?? 8,
    async ([rel, f]) => {
      const abs = join(dir, ...rel.split('/'))
      const st = await lstat(abs).catch(() => undefined)
      if (!st) return problems.push({ path: rel, problem: 'missing' })
      if (!st.isFile()) return problems.push({ path: rel, problem: 'type' })
      if (st.size !== f.size) return problems.push({ path: rel, problem: 'size' })
      if (options.full || st.mtimeMs !== f.mtimeMs) {
        hashed++
        if ((await hashFile(abs, 'sha1', options.signal)) !== f.sha1) return problems.push({ path: rel, problem: 'hash' })
      }
      if (f.executable && (st.mode & 0o111) === 0) problems.push({ path: rel, problem: 'mode' })
      return undefined
    },
    options.signal,
  )
  for (const [rel, target] of Object.entries(installed.links)) {
    if (options.signal?.aborted) throw abortError(options.signal)
    // oxlint-disable-next-line no-await-in-loop -- readlink is cheap; a few hundred at most
    const actual = await readlink(join(dir, ...rel.split('/'))).catch(() => undefined)
    if (actual !== target) problems.push({ path: rel, problem: 'link' })
  }
  problems.sort((a, b) => a.path.localeCompare(b.path))
  return { ok: problems.length === 0, problems, checked: entries.length, hashed, installed }
}

/**
 * Remove `com.apple.quarantine` recursively from a directory Amethyst just extracted, so
 * Gatekeeper does not block the JVM. Only ever called on our own staging folders. A missing
 * `xattr` tool or a non-zero exit is not an error. Returns `true` when `xattr` ran successfully.
 */
export async function clearQuarantine(dir: string, signal?: AbortSignal): Promise<boolean> {
  const r = await runProcess('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dir], { timeoutMs: 30_000, signal, cwd: '/' })
  return !r.error && r.code === 0
}

const locks = new Map<string, Promise<unknown>>()

/** Serialise work per key (concurrent installs of the same runtime folder). */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

/**
 * Atomically move a fully prepared `tree` to `dest`: an existing `dest` is renamed aside first
 * and restored if the swap fails, then deleted. Both paths must be on the same volume.
 */
export async function commitDir(tree: string, dest: string, asideDir: string): Promise<void> {
  const aside = join(asideDir, `.old-${randomBytes(4).toString('hex')}`)
  let moved = false
  try {
    await rename(dest, aside)
    moved = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    await rename(tree, dest)
  } catch (e) {
    if (moved) await rename(aside, dest).catch(() => {})
    throw e
  }
  if (moved) await rm(aside, { recursive: true, force: true })
}
