import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { CancelledError } from '@amethyst/task'
import { InstallError } from './errors'

/** The temp-file name every installer write uses: `<target>.<pid>-<8 hex>.tmp`. */
export function tempPathFor(path: string): string {
  return `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
}

const TEMP_NAME = /\.(\d+)-[0-9a-f]{8}\.tmp$/

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Delete temp files ({@link tempPathFor}) in `dir` left behind by an installer process that is no
 * longer running (a crash or kill between write and rename). Temps of live processes, including
 * this one, are kept. Best effort: never throws.
 */
export async function sweepStaleTemps(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(TEMP_NAME.exec(name)?.[1] ?? Number.NaN)
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) return
      await rm(join(dir, name), { force: true }).catch(() => {})
    }),
  )
}

/**
 * Write a file atomically: write a sibling temp file, then rename it over the target. Stale temps
 * of crashed installs in the same folder are cleaned up afterwards.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  await sweepStaleTemps(dirname(path))
}

/** Write pretty-printed JSON atomically. */
export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Read and parse a JSON file; `undefined` when it does not exist or does not parse. */
export async function readJsonIfValid(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Make `alias` a hard link to `target`, atomically replacing whatever is there. A no-op when it
 * already is one. Both paths must be on the same volume.
 */
export async function hardLink(target: string, alias: string): Promise<void> {
  const [t, a] = await Promise.all([stat(target), stat(alias).catch(() => undefined)])
  if (a && a.ino === t.ino && a.dev === t.dev) return
  const tmp = tempPathFor(alias)
  await mkdir(dirname(alias), { recursive: true })
  await link(target, tmp)
  try {
    await rename(tmp, alias)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Join `child` (a relative, untrusted path such as a version id or zip entry) under `root`,
 * refusing anything that would escape it.
 *
 * @throws {InstallError} `EINSTALL_BAD_METADATA` for absolute paths or `..` escapes.
 */
export function safeJoin(root: string, ...child: string[]): string {
  const full = resolve(root, ...child)
  const rel = relative(resolve(root), full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new InstallError('EINSTALL_BAD_METADATA', `path ${JSON.stringify(join(...child))} escapes ${root}`)
  }
  return full
}

/** Validate a version id used as a directory name. */
export function checkVersionId(id: string): string {
  if (id === '' || id === '.' || id === '..' || /[/\\\0:]/.test(id)) {
    throw new InstallError('EINSTALL_BAD_METADATA', `invalid version id ${JSON.stringify(id)}`)
  }
  return id
}

/** `<root>/versions/<id>/<id>.json` */
export function versionJsonPath(root: string, id: string): string {
  checkVersionId(id)
  return join(root, 'versions', id, `${id}.json`)
}

/** `<root>/versions/<id>/<id>.jar` */
export function versionJarPath(root: string, id: string): string {
  checkVersionId(id)
  return join(root, 'versions', id, `${id}.jar`)
}

/** A FIFO in-process mutex keyed by name. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>()

  /** Run `fn` once every earlier holder of `key` has finished. */
  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => {
      release = r
    })
    const tail = previous.then(() => mine)
    this.#tails.set(key, tail)
    try {
      await waitOrAbort(previous, signal)
      return await fn()
    } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

function waitOrAbort(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p
  signal.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new CancelledError(String(signal.reason ?? 'Cancelled')))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise()
      },
      reject,
    )
  })
}
