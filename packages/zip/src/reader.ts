/* oxlint-disable no-await-in-loop -- entries and path components are processed sequentially by design */
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readlink, realpath, rm, symlink, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { callbackify } from 'node:util'
import yauzl from 'yauzl'
import { isAbortError, wrapMalformed, ZipError } from './errors'
import { entrySegments, isInside, resolvePhysical, unsafe } from './paths'

/** One entry of the central directory. */
export interface ZipEntryInfo {
  /** Entry path as stored (backslashes normalized to `/`; directories end with `/`). Not validated. */
  readonly name: string
  /** Uncompressed size in bytes. */
  readonly size: number
  readonly compressedSize: number
  /** CRC-32 of the uncompressed data, as recorded in the central directory. */
  readonly crc: number
  readonly isDirectory: boolean
  /** True for unix symlink entries; the entry data is the link target. */
  readonly isSymlink: boolean
  /** Unix permission bits (e.g. `0o755`) when the archive was created on a unix host. */
  readonly mode?: number
  readonly lastModified: Date
}

/** Options for {@link ZipReader.extractTo}. */
export interface ExtractOptions {
  /** Return false to skip an entry. Receives the entry before `strip` is applied. */
  filter?: (entry: ZipEntryInfo) => boolean
  /** Remove this many leading path components; entries left with no components are skipped. */
  strip?: number
  signal?: AbortSignal
  /** Called after each extracted entry with cumulative and total uncompressed bytes. */
  onProgress?: (extractedBytes: number, totalBytes: number) => void
}

/** Summary of an extraction. */
export interface ExtractResult {
  /** Absolute paths of the files and symlinks written (directories are not listed). */
  files: string[]
  /** Total uncompressed bytes written. */
  bytes: number
}

/** Options for {@link ZipReader.readBuffer}. */
export interface ReadBufferOptions {
  /** Refuse entries larger than this many bytes (`EZIP_TOO_LARGE`). Defaults to 256 MiB. */
  maxBytes?: number
  signal?: AbortSignal
}

/** Random-access reader over a zip archive. Obtain one with {@link openZip}; always {@link ZipReader.close} it. */
export interface ZipReader {
  /** Number of entries declared by the end-of-central-directory record. */
  readonly entryCount: number
  /** All central directory entries in archive order. Read once, then cached. */
  entries(): Promise<readonly ZipEntryInfo[]>
  /** Look up an entry by exact name (the first one wins if the archive has duplicates). */
  entry(name: string): Promise<ZipEntryInfo | undefined>
  has(name: string): Promise<boolean>
  /** Inflate one entry into memory. */
  readBuffer(name: string, options?: ReadBufferOptions): Promise<Buffer>
  /** Read one entry as UTF-8 text, dropping a leading byte-order mark. */
  readText(name: string, options?: ReadBufferOptions): Promise<string>
  /** Open a stream of one entry's uncompressed data. Sizes are validated while streaming. */
  openStream(name: string, options?: { signal?: AbortSignal }): Promise<Readable>
  /**
   * Extract entries into `dir` (created if needed), streaming each file to disk.
   *
   * Every selected entry is validated before anything is written: `..` segments, absolute paths
   * and NUL bytes are rejected with `EZIP_UNSAFE_PATH`. Symlink entries are created only when
   * their target resolves inside `dir`, and no write ever goes through a symlink that leads
   * outside it. Unix permission bits are applied to files (owner read/write is always kept).
   * Rejects with an `AbortError` when `signal` fires; the partially written file is removed.
   */
  extractTo(dir: string, options?: ExtractOptions): Promise<ExtractResult>
  /** Release the file handle. Streams that are still open keep it alive until they end. */
  close(): Promise<void>
}

/** Source accepted by {@link openZip}: a file path or the archive bytes. */
export type ZipSource = string | Uint8Array

const DEFAULT_MAX_READ_BYTES = 256 * 1024 * 1024
const MAX_SYMLINK_TARGET = 4096
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

const YAUZL_OPTIONS: yauzl.Options = {
  lazyEntries: true,
  autoClose: false,
  // Names are decoded by us so that one hostile name does not make the whole archive unreadable;
  // safety is enforced at extraction time instead.
  decodeStrings: false,
  strictFileNames: false,
  validateEntrySizes: true,
}

interface Item {
  info: ZipEntryInfo
  raw: yauzl.Entry
}

/**
 * Open a zip archive for random access. Only the end-of-central-directory record is read
 * here; the central directory is read on first use and no entry data is inflated until
 * requested. Handles ZIP64, data descriptors, backslash separators and non-UTF-8 names (CP437).
 *
 * @throws {ZipError} `EZIP_MALFORMED` when the archive cannot be parsed. File system errors
 * (e.g. `ENOENT`) are passed through unchanged.
 */
export async function openZip(source: ZipSource): Promise<ZipReader> {
  try {
    const zip =
      typeof source === 'string'
        ? await yauzl.openPromise(source, YAUZL_OPTIONS)
        : await yauzl.fromBufferPromise(toBuffer(source), YAUZL_OPTIONS)
    return new YauzlReader(zip)
  } catch (e) {
    if (e instanceof Error && BAD_COMMENT_LENGTH.test(e.message)) {
      const zip = await openIgnoringCommentLength(source).catch(() => undefined)
      if (zip) return new YauzlReader(zip)
    }
    throw wrapMalformed(e, 'Cannot open zip')
  }
}

const BAD_COMMENT_LENGTH = /invalid comment length/i
const EOCD_SIGNATURE = 0x06054b50
const EOCD_SIZE = 22

/**
 * Some tools write an end-of-central-directory record whose comment length disagrees with the
 * bytes that follow it (extra trailing bytes, or a truncated comment). Java's own zip reader, and
 * so the game, accepts these jars (known-issues #1431). Present the archive to yauzl as if the
 * comment had exactly its declared length: cut off what follows, pad a short comment with zeros.
 */
async function openIgnoringCommentLength(source: ZipSource): Promise<yauzl.ZipFile> {
  const handle = typeof source === 'string' ? await open(source, 'r') : undefined
  try {
    const buffer = handle ? undefined : toBuffer(source as Uint8Array)
    const realSize = handle ? (await handle.stat()).size : (buffer as Buffer).length
    const tailLength = Math.min(realSize, EOCD_SIZE + 0xffff)
    const tailStart = realSize - tailLength
    const tail = Buffer.alloc(tailLength)
    if (handle) await handle.read(tail, 0, tailLength, tailStart)
    else (buffer as Buffer).copy(tail, 0, tailStart)
    let eocd = -1
    for (let i = tailLength - EOCD_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd === -1) throw new Error('No end of central directory record')
    const virtualSize = tailStart + eocd + EOCD_SIZE + tail.readUInt16LE(eocd + 20)
    const reader = new PaddedReader(realSize, handle, buffer)
    return await yauzl.fromRandomAccessReaderPromise(reader, virtualSize, YAUZL_OPTIONS)
  } catch (e) {
    await handle?.close()
    throw e
  }
}

/** Reads the archive's real bytes and zeros past its end. Closes the file with the zip. */
class PaddedReader extends yauzl.RandomAccessReader {
  constructor(
    private readonly realSize: number,
    private readonly handle: FileHandle | undefined,
    private readonly buffer: Buffer | undefined,
  ) {
    super()
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const realEnd = Math.min(end, this.realSize)
    const pad = end - Math.max(start, realEnd)
    const { handle, buffer } = this
    async function* bytes() {
      if (realEnd > start) {
        if (buffer) yield buffer.subarray(start, realEnd)
        else if (handle) yield* handle.createReadStream({ start, end: realEnd - 1, autoClose: false })
      }
      if (pad > 0) yield Buffer.alloc(pad)
    }
    return Readable.from(bytes(), { objectMode: false })
  }

  override close(callback: (err: Error | null) => void): void {
    const handle = this.handle
    if (!handle) return callback(null)
    callbackify(() => handle.close())((e) => callback(e))
  }
}

function toBuffer(u8: Uint8Array): Buffer {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
}

function toInfo(e: yauzl.Entry): ZipEntryInfo {
  const name = yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, e.fileNameRaw, e.extraFields, false)
  const host = e.versionMadeBy >> 8
  const attrs = e.externalFileAttributes >>> 16
  // 3 = UNIX, 19 = OS X (APPNOTE 4.4.2.2); mode lives in the high 16 bits of the external attributes.
  const unix = (host === 3 || host === 19) && attrs !== 0
  const fmt = attrs & S_IFMT
  const isDirectory = name.endsWith('/') || (unix && fmt === S_IFDIR) || (host === 0 && (e.externalFileAttributes & 0x10) !== 0)
  return Object.freeze({
    name,
    size: e.uncompressedSize,
    compressedSize: e.compressedSize,
    crc: e.crc32,
    isDirectory,
    isSymlink: unix && !isDirectory && fmt === S_IFLNK,
    mode: unix ? attrs & 0o7777 : undefined,
    lastModified: e.getLastModDate(),
  })
}

async function removeIfLink(target: string): Promise<void> {
  const st = await lstat(target).catch(() => undefined)
  if (st?.isSymbolicLink()) await unlink(target)
}

function abortError(signal: AbortSignal): Error {
  const err = new Error('The operation was aborted', { cause: signal.reason })
  err.name = 'AbortError'
  return err
}

class YauzlReader implements ZipReader {
  #zip: yauzl.ZipFile
  #items?: Promise<{ list: Item[]; byName: Map<string, Item> }>
  #closed = false

  constructor(zip: yauzl.ZipFile) {
    this.#zip = zip
  }

  get entryCount(): number {
    return this.#zip.entryCount
  }

  #load() {
    if (this.#closed) return Promise.reject(new ZipError('EZIP_CLOSED', 'Zip reader is closed'))
    this.#items ??= (async () => {
      const list: Item[] = []
      const byName = new Map<string, Item>()
      try {
        for await (const raw of this.#zip.eachEntry()) {
          const item = { info: toInfo(raw), raw }
          list.push(item)
          if (!byName.has(item.info.name)) byName.set(item.info.name, item)
        }
      } catch (e) {
        throw wrapMalformed(e, 'Cannot read zip central directory')
      }
      return { list, byName }
    })()
    return this.#items
  }

  async #get(name: string): Promise<Item> {
    const item = (await this.#load()).byName.get(name)
    if (!item) throw new ZipError('EZIP_NOT_FOUND', `Zip entry not found: ${name}`)
    return item
  }

  async entries(): Promise<readonly ZipEntryInfo[]> {
    return (await this.#load()).list.map((i) => i.info)
  }

  async entry(name: string): Promise<ZipEntryInfo | undefined> {
    return (await this.#load()).byName.get(name)?.info
  }

  async has(name: string): Promise<boolean> {
    return (await this.#load()).byName.has(name)
  }

  async #open(item: Item): Promise<Readable> {
    if (this.#closed) throw new ZipError('EZIP_CLOSED', 'Zip reader is closed')
    try {
      return await this.#zip.openReadStreamPromise(item.raw)
    } catch (e) {
      throw wrapMalformed(e, `Cannot read zip entry ${item.info.name}`)
    }
  }

  async openStream(name: string, options: { signal?: AbortSignal } = {}): Promise<Readable> {
    options.signal?.throwIfAborted()
    const stream = await this.#open(await this.#get(name))
    const { signal } = options
    if (signal) {
      const onAbort = () => stream.destroy(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      stream.once('close', () => signal.removeEventListener('abort', onAbort))
    }
    return stream
  }

  async #readItem(item: Item, options: ReadBufferOptions): Promise<Buffer> {
    const max = options.maxBytes ?? DEFAULT_MAX_READ_BYTES
    if (item.info.size > max) throw new ZipError('EZIP_TOO_LARGE', `Zip entry ${item.info.name} is ${item.info.size} bytes (limit ${max})`)
    const { signal } = options
    if (signal?.aborted) throw abortError(signal)
    const stream = await this.#open(item)
    const chunks: Buffer[] = []
    const onAbort = () => signal && stream.destroy(abortError(signal))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const chunk of stream) chunks.push(chunk as Buffer)
    } catch (e) {
      throw wrapMalformed(e, `Cannot read zip entry ${item.info.name}`)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    return Buffer.concat(chunks)
  }

  async readBuffer(name: string, options: ReadBufferOptions = {}): Promise<Buffer> {
    return this.#readItem(await this.#get(name), options)
  }

  async readText(name: string, options: ReadBufferOptions = {}): Promise<string> {
    const text = (await this.readBuffer(name, options)).toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }

  async extractTo(dir: string, options: ExtractOptions = {}): Promise<ExtractResult> {
    const { filter, signal, onProgress } = options
    const strip = options.strip ?? 0
    if (!Number.isInteger(strip) || strip < 0) throw new RangeError('strip must be a non-negative integer')
    if (signal?.aborted) throw abortError(signal)

    const { list } = await this.#load()

    // Plan and validate everything before touching the disk.
    const plan: { item: Item; rel: string[] }[] = []
    let totalBytes = 0
    for (const item of list) {
      if (filter && !filter(item.info)) continue
      const rel = entrySegments(item.info.name).slice(strip)
      if (rel.length === 0) continue
      plan.push({ item, rel })
      totalBytes += item.info.size
    }

    await mkdir(dir, { recursive: true })
    const root = await realpath(dir)
    const verifiedDirs = new Set<string>()
    const links: string[] = []
    const files: string[] = []
    let bytes = 0

    // Create `relDir` under root, refusing if an existing symlink would lead it outside.
    const ensureDir = async (relDir: readonly string[]) => {
      const lexical = path.join(root, ...relDir)
      if (verifiedDirs.has(lexical)) return
      const physical = await resolvePhysical(root, relDir)
      if (!isInside(root, physical)) throw unsafe(relDir.join('/'), 'resolves outside the extraction directory through a symlink')
      await mkdir(lexical, { recursive: true })
      verifiedDirs.add(lexical)
    }

    for (const { item, rel } of plan) {
      if (signal?.aborted) throw abortError(signal)
      const { info } = item
      const target = path.join(root, ...rel)
      const parentRel = rel.slice(0, -1)

      if (info.isDirectory) {
        await ensureDir(rel)
        continue
      }

      await ensureDir(parentRel)

      if (info.isSymlink) {
        const linkTarget = (await this.#readItem(item, { maxBytes: MAX_SYMLINK_TARGET, signal })).toString('utf8')
        if (linkTarget === '' || linkTarget.includes('\0') || path.isAbsolute(linkTarget) || /^[a-zA-Z]:/.test(linkTarget)) {
          throw unsafe(info.name, `is a symlink to an absolute or invalid target ${JSON.stringify(linkTarget)}`)
        }
        const parentPhysical = await resolvePhysical(root, parentRel)
        const resolved = await resolvePhysical(parentPhysical, linkTarget.split(/[\\/]/))
        if (!isInside(root, resolved)) throw unsafe(info.name, `is a symlink pointing outside the extraction directory (${linkTarget})`)
        await rm(target, { force: true })
        await symlink(linkTarget, target)
        // Existing directory checks may now resolve differently.
        verifiedDirs.clear()
        links.push(target)
        files.push(target)
        bytes += info.size
        onProgress?.(bytes, totalBytes)
        continue
      }

      await removeIfLink(target)
      const stream = await this.#open(item)
      try {
        await pipeline(stream, createWriteStream(target), signal ? { signal } : {})
      } catch (e) {
        await rm(target, { force: true }).catch(() => {})
        if (isAbortError(e) && signal) throw abortError(signal)
        throw wrapMalformed(e, `Cannot extract zip entry ${info.name}`)
      }
      if (info.mode !== undefined) await chmod(target, (info.mode & 0o777) | 0o600)
      files.push(target)
      bytes += info.size
      onProgress?.(bytes, totalBytes)
    }

    // A later entry may have changed where an earlier symlink resolves; re-check them all.
    for (const link of links) {
      const parentPhysical = await resolvePhysical(root, path.relative(root, path.dirname(link)).split(path.sep))
      const resolved = await resolvePhysical(parentPhysical, (await readlink(link)).split(/[\\/]/))
      if (!isInside(root, resolved)) {
        await unlink(link)
        throw unsafe(path.relative(root, link), 'is a symlink that resolves outside the extraction directory')
      }
    }

    return { files, bytes }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Let an in-flight central directory scan finish so yauzl does not read from a closed fd.
    await this.#items?.catch(() => {})
    this.#zip.close()
  }
}
