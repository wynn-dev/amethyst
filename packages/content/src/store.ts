/* oxlint-disable no-await-in-loop -- garbage collection walks shard folders one at a time */
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ContentError, throwIfAborted, wrapFsError } from './errors'
import { isSha1, MultiHasher, type HashAlgorithm, type HashResult } from './hash'
import { cloneFile } from './util/clone'

/** How {@link ContentStore.place} materialised a blob. */
export type PlaceMethod = 'clone' | 'hardlink' | 'copy'

/** File system operations used by the store; injectable so fallbacks can be tested. */
export interface StoreFs {
  /** Copy-on-write clone; rejects when cloning is impossible. Default: {@link cloneFile}. */
  clone(src: string, dest: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  /** Plain byte copy. */
  copyFile(src: string, dest: string): Promise<void>
}

/** Options for {@link ContentStore}. */
export interface ContentStoreOptions {
  /**
   * Allow the hard-link fallback in {@link ContentStore.place} (default true). A hard link shares
   * the inode with the store, so a tool rewriting the placed file in place would also change
   * the blob; disable it when that matters more than disk space.
   */
  hardLinks?: boolean
  /** Override `clone` / `link` / `copyFile` (tests). */
  fs?: Partial<StoreFs>
}

/** Options for {@link ContentStore.ingest}. */
export interface IngestOptions<A extends HashAlgorithm = never> {
  /** Reject with `ECHECKSUM` unless the content has this SHA-1. */
  expectedSha1?: string
  /** Reject with `ECHECKSUM` unless the content has this many bytes. */
  expectedSize?: number
  /** Extra digests to compute in the same pass (e.g. `['sha512']`). */
  algorithms?: readonly A[]
  signal?: AbortSignal
}

/** Result of {@link ContentStore.ingest}. */
export type IngestResult<A extends HashAlgorithm = never> = HashResult<'sha1' | A> & {
  /** True when the blob was already in the store (the new bytes were discarded). */
  existed: boolean
}

/** Options for {@link ContentStore.place}. */
export interface PlaceOptions {
  /** Replace an existing file at the destination (default false: `EEXIST`). */
  overwrite?: boolean
  signal?: AbortSignal
}

/** Options for {@link ContentStore.gc}. */
export interface GcOptions {
  /** Keep unreferenced blobs whose mtime is newer than this many milliseconds (default 0). */
  minAgeMs?: number
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean
  signal?: AbortSignal
}

const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code

/**
 * Content-addressed blob store. Blobs live at `<root>/sha1/<first two hex>/<sha1>` and are
 * read-only (`0444`); temporary files live in `<root>/tmp`. The app uses
 * `<appData>/store` as the root.
 *
 * Instances hold *placements* (independent copies), never the blobs themselves, so the store
 * keeps no reference counts: the caller's index is the reference truth for {@link gc}.
 * Holds no global state and is safe to use from a worker thread.
 */
export class ContentStore {
  readonly root: string
  readonly #fs: StoreFs
  readonly #hardLinks: boolean

  constructor(root: string, options: ContentStoreOptions = {}) {
    this.root = path.resolve(root)
    this.#hardLinks = options.hardLinks ?? true
    this.#fs = {
      clone: options.fs?.clone ?? cloneFile,
      link: options.fs?.link ?? fsp.link,
      copyFile: options.fs?.copyFile ?? ((src, dest) => fsp.copyFile(src, dest)),
    }
  }

  /** Absolute path of the blob for `sha1` (whether or not it exists). */
  pathOf(sha1: string): string {
    if (!isSha1(sha1)) throw new ContentError('EINVALID_ARGUMENT', `Not a SHA-1: ${JSON.stringify(sha1)}`)
    const h = sha1.toLowerCase()
    return path.join(this.root, 'sha1', h.slice(0, 2), h)
  }

  /** True when the blob exists. Pass `size` to also require that size (a cheap integrity check). */
  async has(sha1: string, size?: number): Promise<boolean> {
    const st = await fsp.stat(this.pathOf(sha1)).catch(() => undefined)
    return st?.isFile() === true && (size === undefined || st.size === size)
  }

  /**
   * Add content to the store from a file path or a stream. Bytes are written to a temporary
   * file while being hashed (SHA-1 plus `algorithms`), verified against `expectedSha1` /
   * `expectedSize`, then renamed into place atomically. If the blob already exists the
   * temporary file is discarded.
   *
   * @throws {ContentError} `ECHECKSUM` on a hash or size mismatch.
   */
  async ingest<A extends HashAlgorithm = never>(source: string | Readable | AsyncIterable<Uint8Array>, options: IngestOptions<A> = {}): Promise<IngestResult<A>> {
    const { signal } = options
    throwIfAborted(signal)
    if (options.expectedSha1 !== undefined && !isSha1(options.expectedSha1)) {
      throw new ContentError('EINVALID_ARGUMENT', `Not a SHA-1: ${JSON.stringify(options.expectedSha1)}`)
    }
    const tmpDir = path.join(this.root, 'tmp')
    await fsp.mkdir(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, randomBytes(12).toString('hex'))
    const hasher = new MultiHasher<'sha1' | A>(['sha1', ...(options.algorithms ?? [])])
    const input =
      typeof source === 'string' ? createReadStream(source, { highWaterMark: 256 * 1024 }) : source instanceof Readable ? source : Readable.from(source, { objectMode: false })
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hasher.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(input, tap, createWriteStream(tmp, { mode: 0o644 }), signal ? { signal } : {})
      const digest = hasher.digest()
      if (options.expectedSize !== undefined && digest.size !== options.expectedSize) {
        throw new ContentError('ECHECKSUM', `Size mismatch: expected ${options.expectedSize} bytes, got ${digest.size}`)
      }
      if (options.expectedSha1 !== undefined && digest.sha1 !== options.expectedSha1.toLowerCase()) {
        throw new ContentError('ECHECKSUM', `SHA-1 mismatch: expected ${options.expectedSha1.toLowerCase()}, got ${digest.sha1}`)
      }
      const dest = this.pathOf(digest.sha1)
      const existing = await fsp.stat(dest).catch(() => undefined)
      if (existing?.isFile() && existing.size === digest.size) {
        await fsp.rm(tmp, { force: true })
        return { ...digest, existed: true }
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.chmod(tmp, 0o444)
      await fsp.rename(tmp, dest)
      return { ...digest, existed: false }
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw wrapFsError(e, 'Cannot ingest into the content store')
    }
  }

  /**
   * Materialise a blob at `destPath`. Tries, in order: an APFS clone (copy-on-write, no extra
   * space; `COPYFILE_FICLONE_FORCE`, or `cp -c` on macOS where Node cannot clone), a hard link
   * (unless disabled), and a plain copy. The file
   * is created under a temporary name in the destination folder and renamed into place, so
   * the destination never holds a partial file. Clones and copies are made writable (`0644`).
   *
   * @throws {ContentError} `ENOT_FOUND` when the blob is missing, `EEXIST` when `destPath`
   * exists and `overwrite` is not set.
   */
  async place(sha1: string, destPath: string, options: PlaceOptions = {}): Promise<{ method: PlaceMethod; path: string }> {
    throwIfAborted(options.signal)
    const blob = this.pathOf(sha1)
    if (!(await this.has(sha1))) throw new ContentError('ENOT_FOUND', `Blob ${sha1} is not in the store`)
    if (!options.overwrite && (await fsp.lstat(destPath).catch(() => undefined))) {
      throw new ContentError('EEXIST', `${destPath} already exists`)
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true })
    const tmp = `${destPath}.${randomBytes(6).toString('hex')}.part`
    try {
      const method = await this.#materialise(blob, tmp)
      if (method !== 'hardlink') await fsp.chmod(tmp, 0o644)
      throwIfAborted(options.signal)
      if (!options.overwrite) {
        // Re-check right before the rename: another writer may have created the file meanwhile.
        if (await fsp.lstat(destPath).catch(() => undefined)) throw new ContentError('EEXIST', `${destPath} already exists`)
      }
      await fsp.rename(tmp, destPath)
      return { method, path: destPath }
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw wrapFsError(e, `Cannot place ${sha1} at ${destPath}`)
    }
  }

  async #materialise(blob: string, target: string): Promise<PlaceMethod> {
    try {
      await this.#fs.clone(blob, target)
      return 'clone'
    } catch (e) {
      // Not APFS, another volume, or no clone support: fall through.
      if (errCode(e) === 'ENOENT' && !(await this.#exists(blob))) throw e
      await fsp.rm(target, { force: true })
    }
    if (this.#hardLinks) {
      try {
        await this.#fs.link(blob, target)
        return 'hardlink'
      } catch (e) {
        // EXDEV (another volume), EPERM/ENOTSUP (no hard links on this file system), EMLINK.
        if (errCode(e) === 'ENOENT' && !(await this.#exists(blob))) throw e
        await fsp.rm(target, { force: true })
      }
    }
    await this.#fs.copyFile(blob, target)
    return 'copy'
  }

  async #exists(p: string): Promise<boolean> {
    return (await fsp.stat(p).catch(() => undefined)) !== undefined
  }

  /** Remove a blob. Returns false when it was not there. */
  async remove(sha1: string): Promise<boolean> {
    const p = this.pathOf(sha1)
    const st = await fsp.stat(p).catch(() => undefined)
    if (!st) return false
    await fsp.rm(p, { force: true })
    return true
  }

  /** Every blob hash in the store. */
  async *list(signal?: AbortSignal): AsyncGenerator<{ sha1: string; size: number; mtimeMs: number }> {
    const base = path.join(this.root, 'sha1')
    const shards = await fsp.readdir(base).catch(() => [] as string[])
    for (const shard of shards) {
      throwIfAborted(signal)
      if (!/^[0-9a-f]{2}$/.test(shard)) continue
      for (const name of await fsp.readdir(path.join(base, shard)).catch(() => [] as string[])) {
        if (!isSha1(name) || !name.startsWith(shard)) continue
        const st = await fsp.stat(path.join(base, shard, name)).catch(() => undefined)
        if (st?.isFile()) yield { sha1: name, size: st.size, mtimeMs: st.mtimeMs }
      }
    }
  }

  /**
   * Delete every blob whose SHA-1 is not in `referenced` (and that is older than `minAgeMs`),
   * then remove empty shard folders and temporary files older than a day. Callers must include
   * hashes that in-progress installs are about to place.
   */
  async gc(referenced: Iterable<string>, options: GcOptions = {}): Promise<{ removed: string[]; freedBytes: number }> {
    const keep = new Set<string>()
    for (const h of referenced) keep.add(h.toLowerCase())
    const now = Date.now()
    const removed: string[] = []
    let freedBytes = 0
    for await (const blob of this.list(options.signal)) {
      if (keep.has(blob.sha1)) continue
      if (options.minAgeMs && now - blob.mtimeMs < options.minAgeMs) continue
      if (!options.dryRun) await fsp.rm(this.pathOf(blob.sha1), { force: true })
      removed.push(blob.sha1)
      freedBytes += blob.size
    }
    if (!options.dryRun) {
      const base = path.join(this.root, 'sha1')
      for (const shard of await fsp.readdir(base).catch(() => [] as string[])) {
        await fsp.rmdir(path.join(base, shard)).catch(() => {})
      }
      const tmpDir = path.join(this.root, 'tmp')
      for (const name of await fsp.readdir(tmpDir).catch(() => [] as string[])) {
        const p = path.join(tmpDir, name)
        const st = await fsp.stat(p).catch(() => undefined)
        if (st && now - st.mtimeMs > TMP_MAX_AGE_MS) await fsp.rm(p, { force: true, recursive: true })
      }
    }
    return { removed, freedBytes }
  }
}
