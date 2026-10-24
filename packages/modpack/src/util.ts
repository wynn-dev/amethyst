/* oxlint-disable no-await-in-loop -- folders are walked and pruned one level at a time */
/**
 * Internal helpers: one-pass multi-digest hashing (with CRC-32), hash comparison, atomic JSON
 * writes and small file system utilities.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { abortError, throwIfAborted } from './errors'
import type { FileHashes } from './types'

/** Digests of a file on disk. `sha1` and `crc32` are always computed. */
export interface LocalHashes {
  sha1: string
  crc32: string
  sha512?: string
  md5?: string
  size: number
}

/**
 * Hash a file in one streaming pass: SHA-1 and CRC-32 always, plus SHA-512 / MD5 on request.
 */
export async function hashLocal(file: string, extra: { sha512?: boolean; md5?: boolean } = {}, signal?: AbortSignal): Promise<LocalHashes> {
  throwIfAborted(signal)
  const sha1 = createHash('sha1')
  const sha512 = extra.sha512 ? createHash('sha512') : undefined
  const md5 = extra.md5 ? createHash('md5') : undefined
  let crc = 0
  let size = 0
  const stream = createReadStream(file, { highWaterMark: 256 * 1024 })
  const onAbort = () => signal && stream.destroy(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      sha1.update(buf)
      sha512?.update(buf)
      md5?.update(buf)
      crc = crc32(buf, crc)
      size += buf.length
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const out: LocalHashes = { sha1: sha1.digest('hex'), crc32: (crc >>> 0).toString(16).padStart(8, '0'), size }
  if (sha512) out.sha512 = sha512.digest('hex')
  if (md5) out.md5 = md5.digest('hex')
  return out
}

/**
 * Compare two hash sets by the strongest digest both have: sha512, sha1, md5, then crc32.
 * Returns undefined when they share none.
 */
export function compareHashes(a: FileHashes, b: FileHashes): boolean | undefined {
  for (const k of ['sha512', 'sha1', 'md5', 'crc32'] as const) {
    const x = a[k]
    const y = b[k]
    if (x && y) return x.toLowerCase() === y.toLowerCase()
  }
  return undefined
}

/** Hash a file with whatever is needed to compare it against `expected`. */
export function hashFor(file: string, expected: FileHashes, signal?: AbortSignal): Promise<LocalHashes> {
  return hashLocal(file, { sha512: !!expected.sha512, md5: !!expected.md5 && !expected.sha1 && !expected.sha512 }, signal)
}

/** `lstat` that resolves undefined for a missing path. */
export async function lstatOrUndefined(p: string) {
  return lstat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return undefined
    throw e
  })
}

/** Write JSON atomically (temp file + rename). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/** Read and parse a JSON file; undefined when missing. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown
}

/** Remove now-empty parent directories of `file`, stopping at (and keeping) `root`. */
export async function pruneEmptyParents(root: string, file: string): Promise<void> {
  let dir = path.dirname(file)
  while (dir.length > root.length && dir.startsWith(root)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

/** Every regular file under `dir`, as `/`-separated paths relative to `dir`. Symlinks are skipped. */
export async function listFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    throwIfAborted(signal)
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(child)
      else if (e.isFile()) out.push(child)
    }
  }
  await walk('')
  return out.toSorted()
}

/** A timestamp usable in file names: `20261024T101112123Z`. */
export function fileTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '')
}
