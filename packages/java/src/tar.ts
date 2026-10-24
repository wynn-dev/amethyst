/* oxlint-disable no-await-in-loop -- a tar stream is inherently sequential */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { abortError, JavaError } from './errors'

/**
 * A minimal streaming tar extractor (ustar, GNU long names/links, pax `path`/`linkpath`/`size`)
 * for runtime archives. It never trusts the archive:
 *
 * - names that are absolute or contain `..` are rejected with `EUNSAFEPATH`;
 * - nothing is ever written through a symlink: every parent directory is checked with `lstat`;
 * - symlink targets must be relative, may use `..` only as leading segments, and must stay
 *   inside the destination when resolved from the link's directory. Together with the previous
 *   rule this guarantees every link resolves inside the destination;
 * - hard links may only point at regular files extracted earlier from the same archive;
 * - modes are masked to `0o777` (no setuid/setgid/sticky); device and FIFO entries are skipped;
 * - total size and entry count are bounded.
 */

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink'

/** One entry written to disk. Paths are relative to the destination, `/`-separated. */
export interface TarExtracted {
  path: string
  type: TarEntryType
  /** Permission bits applied (files and directories). */
  mode?: number
  size?: number
  /** Hex sha1 of the file content, when `hash` is enabled. */
  sha1?: string
  /** Link target as stored (symlinks) or the archive path of the target (hard links). */
  target?: string
}

export interface ExtractTarOptions {
  signal?: AbortSignal
  /** Leading path components to drop (like `tar --strip-components`). Shallower entries are skipped. */
  strip?: number
  /** Hash every regular file with sha1 while writing it (default `false`). */
  hash?: boolean
  /** Upper bound on the sum of file sizes (default 4 GiB). */
  maxBytes?: number
  /** Upper bound on the number of entries (default 200 000). */
  maxEntries?: number
}

export interface ExtractTarResult {
  entries: TarExtracted[]
  /** Bytes of regular file content written. */
  bytes: number
  /** Entries skipped (unsupported type, or shallower than `strip`). */
  skipped: string[]
}

const BLOCK = 512

/** Pulls exact byte counts out of an async iterable of chunks. */
class ByteReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private done = false
  private readonly it: AsyncIterator<Uint8Array>

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]()
  }

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.done) {
      const r = await this.it.next()
      if (r.done) this.done = true
      else if (r.value.length > 0) {
        const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength)
        this.chunks.push(b)
        this.buffered += b.length
      }
    }
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let off = 0
    while (off < n) {
      const head = this.chunks[0] as Buffer
      const k = Math.min(head.length, n - off)
      head.copy(out, off, 0, k)
      off += k
      if (k === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(k)
    }
    this.buffered -= n
    return out
  }

  /** Exactly `n` bytes, or `undefined` at a clean end of stream (no bytes left at all). */
  async read(n: number): Promise<Buffer | undefined> {
    await this.fill(n)
    if (this.buffered === 0 && this.done) return undefined
    if (this.buffered < n) throw new JavaError('EBADARCHIVE', 'tar archive is truncated')
    return this.take(n)
  }

  /** Yield `n` bytes in chunks of up to 256 KiB as they arrive. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      await this.fill(1)
      if (this.buffered === 0) throw new JavaError('EBADARCHIVE', 'tar archive is truncated')
      const head = this.chunks[0] as Buffer
      const k = Math.min(head.length, left, 256 * 1024)
      yield this.take(k)
      left -= k
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.stream(n)) {
      // discard
    }
  }

  async close(): Promise<void> {
    await this.it.return?.()
  }
}

function cstring(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

/** Parse a numeric header field: octal text, or GNU base-256 when the high bit is set. */
function numeric(buf: Buffer, start: number, len: number): number {
  const field = buf.subarray(start, start + len)
  if (((field[0] as number) & 0x80) !== 0) {
    let v = 0n
    for (let i = 1; i < field.length; i++) v = (v << 8n) | BigInt(field[i] as number)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new JavaError('EBADARCHIVE', 'tar numeric field too large')
    return Number(v)
  }
  const text = cstring(buf, start, len).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new JavaError('EBADARCHIVE', `invalid tar numeric field "${text}"`)
  return Number.parseInt(text, 8)
}

function checksumOk(header: Buffer): boolean {
  const stored = numeric(header, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number)
  return sum === stored
}

/** Parse pax extended header records (`"<len> <key>=<value>\n"`). */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    if (space === -1) break
    const len = Number.parseInt(data.subarray(pos, space).toString('ascii'), 10)
    if (!Number.isInteger(len) || len <= space - pos || pos + len > data.length) throw new JavaError('EBADARCHIVE', 'malformed pax header')
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    pos += len
  }
  return out
}

/**
 * Normalise an archive path into safe segments: drops `.` and empty segments and rejects
 * absolute paths, `..` and NUL bytes with `EUNSAFEPATH`.
 */
export function safeSegments(name: string): string[] {
  if (name.includes('\0')) throw new JavaError('EUNSAFEPATH', `unsafe path in archive: ${JSON.stringify(name)}`)
  if (name.startsWith('/')) throw new JavaError('EUNSAFEPATH', `absolute path in archive: ${name}`)
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new JavaError('EUNSAFEPATH', `path traversal in archive: ${name}`)
  return parts
}

/**
 * Check a symlink target for a link whose parent directory is `parentDepth` levels below the
 * destination root. Throws `EUNSAFEPATH` unless the target is relative, uses `..` only as
 * leading segments, and stays inside the root.
 */
export function checkLinkTarget(target: string, parentDepth: number, linkPath: string): void {
  if (!target || target.includes('\0') || target.startsWith('/')) throw new JavaError('EUNSAFEPATH', `unsafe symlink ${linkPath} -> ${target}`)
  const parts = target.split('/').filter((p) => p !== '' && p !== '.')
  let ups = 0
  while (parts[ups] === '..') ups++
  if (parts.slice(ups).includes('..')) throw new JavaError('EUNSAFEPATH', `symlink target uses ".." after a name: ${linkPath} -> ${target}`)
  if (ups > parentDepth) {
    throw new JavaError('EUNSAFEPATH', `symlink escapes the destination: ${linkPath} -> ${target}`)
  }
}

/** Creates directories under `root` without ever following a symlink. */
export class SafeTree {
  private readonly known = new Set<string>([''])

  constructor(readonly root: string) {}

  abs(rel: string): string {
    return rel ? join(this.root, ...rel.split('/')) : this.root
  }

  /** Ensure `rel` (and its parents) exist as real directories. */
  async dir(rel: string): Promise<void> {
    if (this.known.has(rel)) return
    const parts = rel.split('/')
    let cur = ''
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p
      if (this.known.has(cur)) continue
      const st = await lstat(this.abs(cur)).catch(() => undefined)
      if (!st) await mkdir(this.abs(cur)).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)))
      else if (st.isSymbolicLink()) throw new JavaError('EUNSAFEPATH', `refusing to write through symlink ${cur}`)
      else if (!st.isDirectory()) throw new JavaError('EBADARCHIVE', `${cur} is not a directory`)
      this.known.add(cur)
    }
  }

  /** Remove whatever non-directory sits at `rel` so it can be replaced. */
  async clear(rel: string): Promise<void> {
    const st = await lstat(this.abs(rel)).catch(() => undefined)
    if (!st) return
    if (st.isDirectory()) throw new JavaError('EBADARCHIVE', `${rel} is a directory`)
    await unlink(this.abs(rel))
  }
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

/**
 * Extract a tar stream into `dest` (which is created). See the module notes for the safety
 * rules. Rejects with `EBADARCHIVE`, `EUNSAFEPATH` or the abort reason; partially extracted
 * content is left for the caller to delete (extract into a temp directory).
 */
export async function extractTar(source: AsyncIterable<Uint8Array>, dest: string, options: ExtractTarOptions = {}): Promise<ExtractTarResult> {
  const { signal } = options
  const strip = options.strip ?? 0
  const maxBytes = options.maxBytes ?? 4 * 1024 ** 3
  const maxEntries = options.maxEntries ?? 200_000
  await mkdir(dest, { recursive: true })
  const tree = new SafeTree(dest)
  const reader = new ByteReader(source)
  const result: ExtractTarResult = { entries: [], bytes: 0, skipped: [] }
  const files = new Set<string>()
  const dirModes = new Map<string, number>()
  let longName: string | undefined
  let longLink: string | undefined
  let pax: Record<string, string> = {}
  let count = 0

  const mapPath = (raw: string): string | undefined => {
    const parts = safeSegments(raw)
    if (parts.length <= strip) return undefined
    return parts.slice(strip).join('/')
  }

  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal)
      const header = await reader.read(BLOCK)
      if (!header || header.every((b) => b === 0)) break
      if (!checksumOk(header)) throw new JavaError('EBADARCHIVE', 'tar header checksum mismatch')
      if (++count > maxEntries) throw new JavaError('EBADARCHIVE', 'too many entries in archive')

      const type = String.fromCharCode(header[156] as number)
      let size = numeric(header, 124, 12)
      const padded = Math.ceil(size / BLOCK) * BLOCK

      if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
        if (size > 1024 * 1024) throw new JavaError('EBADARCHIVE', 'oversized tar metadata entry')
        const data = (await reader.read(padded)) ?? Buffer.alloc(0)
        const body = data.subarray(0, size)
        if (type === 'L') longName = cstring(body, 0, body.length)
        else if (type === 'K') longLink = cstring(body, 0, body.length)
        else if (type === 'x') pax = parsePax(body)
        continue
      }

      const magic = header.subarray(257, 262).toString('latin1')
      const prefix = magic === 'ustar' ? cstring(header, 345, 155) : ''
      const baseName = cstring(header, 0, 100)
      const name = pax.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName)
      const linkName = pax.linkpath ?? longLink ?? cstring(header, 157, 100)
      if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size)
      const dataBlocks = pax.size !== undefined ? Math.ceil(size / BLOCK) * BLOCK : padded
      const mode = numeric(header, 100, 8) & 0o777
      pax = {}
      longName = undefined
      longLink = undefined

      const rel = mapPath(name)
      const isFile = type === '0' || type === '\0' || type === '7'
      const isDir = type === '5'
      if (rel === undefined || !(isFile || isDir || type === '1' || type === '2')) {
        result.skipped.push(name)
        await reader.skip(dataBlocks)
        continue
      }

      if (isDir) {
        await tree.dir(rel)
        dirModes.set(rel, mode | 0o700)
        result.entries.push({ path: rel, type: 'directory', mode: mode | 0o700 })
        await reader.skip(dataBlocks)
        continue
      }

      const parent = parentOf(rel)
      await tree.dir(parent)
      await tree.clear(rel)

      if (type === '2') {
        checkLinkTarget(linkName, parent ? parent.split('/').length : 0, rel)
        await symlink(linkName, tree.abs(rel))
        files.delete(rel)
        result.entries.push({ path: rel, type: 'symlink', target: linkName })
        await reader.skip(dataBlocks)
        continue
      }

      if (type === '1') {
        const target = mapPath(linkName)
        if (target === undefined || !files.has(target)) throw new JavaError('EBADARCHIVE', `hard link ${rel} points at unknown entry ${linkName}`)
        await link(tree.abs(target), tree.abs(rel))
        files.add(rel)
        result.entries.push({ path: rel, type: 'hardlink', target })
        await reader.skip(dataBlocks)
        continue
      }

      result.bytes += size
      if (result.bytes > maxBytes) throw new JavaError('EBADARCHIVE', 'archive expands beyond the size limit')
      const hash = options.hash ? createHash('sha1') : undefined
      const fileMode = mode | 0o400
      const fh = await open(tree.abs(rel), 'wx', 0o600)
      try {
        for await (const chunk of reader.stream(size)) {
          if (signal?.aborted) throw abortError(signal)
          hash?.update(chunk)
          await fh.write(chunk)
        }
      } finally {
        await fh.close()
      }
      await reader.skip(dataBlocks - size)
      await chmod(tree.abs(rel), fileMode)
      files.add(rel)
      const entry: TarExtracted = { path: rel, type: 'file', mode: fileMode, size }
      if (hash) entry.sha1 = hash.digest('hex')
      result.entries.push(entry)
    }
  } finally {
    await reader.close()
  }
  // Directory modes last, so a read-only directory does not block its own children.
  for (const [rel, mode] of [...dirModes].toReversed()) await chmod(tree.abs(rel), mode)
  return result
}

/** {@link extractTar} for a `.tar.gz` file on disk. */
export async function extractTarGz(file: string, dest: string, options: ExtractTarOptions = {}): Promise<ExtractTarResult> {
  const gunzip = createReadStream(file).pipe(createGunzip())
  const onAbort = () => gunzip.destroy(options.signal ? abortError(options.signal) : undefined)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await extractTar(gunzip, dest, options)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'Z_DATA_ERROR' || (e as NodeJS.ErrnoException).code === 'Z_BUF_ERROR') {
      throw new JavaError('EBADARCHIVE', `corrupt gzip stream: ${(e as Error).message}`, { cause: e })
    }
    throw e
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    gunzip.destroy()
  }
}
