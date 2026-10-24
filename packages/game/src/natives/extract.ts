/**
 * Extracting old-style natives (launch.md §5.1) into a natives directory.
 *
 * The directory is rebuilt atomically: jars are extracted into a temporary sibling, a manifest
 * (`.amethyst-natives.json`) is written, and the result is renamed into place. When the manifest
 * already lists the same libraries (by name and hash) and every recorded file still verifies,
 * nothing is extracted. A changed library set always produces a fresh directory, so stale
 * x86_64 dylibs never linger. Concurrent launches of the same version are safe: whoever loses
 * the rename race verifies and uses the winner's directory.
 */
/* oxlint-disable no-await-in-loop -- jars and entries are processed sequentially on purpose */
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TaskContext } from '@amethyst/task'
import { openZip } from '@amethyst/zip'
import { abortError, GameError, throwIfAborted } from '../errors'
import type { ResolvedLibrary } from '../libraries'
import { hashFile } from '../hash'
import type { NativesPlan } from './plan'

export const NATIVES_MANIFEST = '.amethyst-natives.json'

/** Sub-folders that 26.x JSON points `java.library.path`, JNA, LWJGL and Netty at. */
export const NATIVES_SUBDIRS = ['java', 'jna', 'lwjgl', 'netty'] as const

interface ManifestEntry {
  file: string
  library: string
  sha1: string
  size: number
}

interface Manifest {
  schemaVersion: 1
  /** Sorted `name#hash` identities of the extracted libraries. */
  libraries: string[]
  entries: ManifestEntry[]
}

export interface ExtractNativesOptions {
  /** `<root>/libraries`. */
  librariesDir: string
  /** Target natives directory, e.g. from {@link nativesDirectory}. */
  nativesDir: string
  signal?: AbortSignal
  ctx?: TaskContext
}

export interface ExtractNativesResult {
  dir: string
  /** False when the existing directory was verified and reused. */
  extracted: boolean
  /** Absolute paths of the extracted native files. */
  files: string[]
}

/**
 * Default natives directory for a plan: `versions/<id>/<id>-natives-<arch>`. Keyed by JVM arch so
 * switching between a Rosetta and a native JVM never mixes dylibs; table revisions and library
 * changes are handled by the manifest inside.
 */
export function nativesDirectory(versionsDir: string, id: string, plan: Pick<NativesPlan, 'jvmArch'>): string {
  return path.join(versionsDir, id, `${id}-natives-${plan.jvmArch}`)
}

function identity(lib: ResolvedLibrary): string {
  return `${lib.name}#${lib.download.sha256 ?? lib.download.sha1 ?? lib.download.size ?? ''}`
}

/** Platform sub-folder filter: flat entries always; `osx/<arch>/...` entries only for the JVM arch. */
function keepEntry(name: string, exclude: readonly string[], arch: string): boolean {
  if (name.endsWith('/')) return false
  if (exclude.some((p) => name.startsWith(p))) return false
  if (name.includes('META-INF/')) return false
  if (name.endsWith('.sha1') || name.endsWith('.git')) return false
  const segments = name.split('/')
  if (segments.length > 1) {
    const want = arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86']
    return segments[0] === 'osx' && want.includes(segments[1] ?? '')
  }
  return true
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    const m = JSON.parse(await readFile(path.join(dir, NATIVES_MANIFEST), 'utf8')) as Manifest
    return m && m.schemaVersion === 1 && Array.isArray(m.libraries) && Array.isArray(m.entries) ? m : undefined
  } catch {
    return undefined
  }
}

/** True when `dir` holds exactly `wanted` and every recorded file still has its size and sha1. */
async function verify(dir: string, wanted: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
  const m = await readManifest(dir)
  if (!m || m.libraries.length !== wanted.length || m.libraries.some((l, i) => l !== wanted[i])) return undefined
  const files: string[] = []
  for (const e of m.entries) {
    if (path.basename(e.file) !== e.file) return undefined
    const file = path.join(dir, e.file)
    const st = await stat(file).catch(() => undefined)
    if (!st?.isFile() || st.size !== e.size) return undefined
    if ((await hashFile(file, 'sha1', signal)) !== e.sha1) return undefined
    files.push(file)
  }
  return files
}

async function ensureSubdirs(dir: string): Promise<void> {
  await Promise.all(NATIVES_SUBDIRS.map((s) => mkdir(path.join(dir, s), { recursive: true })))
}

async function extractJar(lib: ResolvedLibrary, jar: string, into: string, arch: string, signal: AbortSignal | undefined, out: Map<string, ManifestEntry>): Promise<void> {
  const zip = await openZip(jar)
  try {
    for (const entry of await zip.entries()) {
      throwIfAborted(signal)
      const name = entry.name
      if (entry.isDirectory || entry.isSymlink || !keepEntry(name, lib.extractExclude ?? [], arch)) continue
      const base = name.split('/').pop() ?? ''
      if (base === '' || base === '.' || base === '..' || base === NATIVES_MANIFEST || base.includes('\0')) continue
      const target = path.join(into, base)
      const hash = createHash('sha1')
      let size = 0
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk)
          size += chunk.length
          cb(null, chunk)
        },
      })
      await pipeline(await zip.openStream(name, { signal }), tap, createWriteStream(target), signal ? { signal } : {})
      out.set(base, { file: base, library: lib.name, sha1: hash.digest('hex'), size })
    }
  } finally {
    await zip.close()
  }
}

/**
 * Make `options.nativesDir` contain exactly the extracted natives of `plan.extract`, and create
 * the `java`/`jna`/`lwjgl`/`netty` sub-folders that newer versions expect.
 *
 * @throws {GameError} `ENATIVES_EXTRACT` listing every jar that failed (missing, corrupt, unsafe).
 */
export async function extractNatives(plan: Pick<NativesPlan, 'extract' | 'jvmArch'>, options: ExtractNativesOptions): Promise<ExtractNativesResult> {
  const { nativesDir: dir, librariesDir, signal, ctx } = options
  throwIfAborted(signal)
  const wanted = plan.extract.map(identity).toSorted()

  const existing = await verify(dir, wanted, signal)
  if (existing) {
    await ensureSubdirs(dir)
    return { dir, extracted: false, files: existing }
  }

  const parent = path.dirname(dir)
  await mkdir(parent, { recursive: true })
  const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await mkdir(tmp, { recursive: true })
  try {
    const entries = new Map<string, ManifestEntry>()
    const failures: { library: string; path: string; message: string }[] = []
    let done = 0
    for (const lib of plan.extract) {
      throwIfAborted(signal)
      const jar = path.join(librariesDir, lib.download.path)
      try {
        await extractJar(lib, jar, tmp, plan.jvmArch, signal, entries)
      } catch (e) {
        if (signal?.aborted) throw abortError(signal)
        failures.push({ library: lib.name, path: jar, message: (e as Error).message })
      }
      ctx?.update(++done, plan.extract.length)
    }
    if (failures.length > 0) {
      throw new GameError('ENATIVES_EXTRACT', `Failed to extract natives: ${failures.map((f) => `${f.library} (${f.message})`).join('; ')}`, { failures })
    }
    const manifest: Manifest = { schemaVersion: 1, libraries: wanted, entries: [...entries.values()] }
    await writeFile(path.join(tmp, NATIVES_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
    await ensureSubdirs(tmp)

    // Swap into place. A concurrent launch may win the race; then reuse its directory if valid.
    const swap = async (): Promise<boolean> => {
      try {
        await rename(tmp, dir)
        return true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e
        return false
      }
    }
    if (!(await swap())) {
      const theirs = await verify(dir, wanted, signal)
      if (theirs) {
        await rm(tmp, { recursive: true, force: true })
        await ensureSubdirs(dir)
        return { dir, extracted: false, files: theirs }
      }
      const old = `${dir}.old-${process.pid}-${randomBytes(4).toString('hex')}`
      await rename(dir, old)
      if (!(await swap())) throw new GameError('ENATIVES_EXTRACT', `Cannot replace natives directory ${dir}`, { path: dir })
      await rm(old, { recursive: true, force: true })
    }
    return { dir, extracted: true, files: manifest.entries.map((e) => path.join(dir, e.file)) }
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}
