import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { ZipError } from './errors'
import { validateZipPath } from './paths'

/** Per-entry options for {@link ZipWriter}. */
export interface ZipAddOptions {
  /** Deflate the entry (default true). Use false for already-compressed data such as PNGs or jars. */
  compress?: boolean
  /** Unix permission bits to record. Defaults to the source file's mode, or `0o644` for buffers. */
  mode?: number
  /** Modification time to record. Defaults to the source file's mtime, or now for buffers. */
  mtime?: Date
  /** Always write ZIP64 records for this entry, even if it is small. */
  zip64?: boolean
}

/** Streaming zip writer created by {@link createZip}. */
export interface ZipWriter {
  /** Queue a file from disk; it is read and compressed lazily, in order, while streaming out. */
  addFile(filePath: string, zipPath: string, options?: ZipAddOptions): void
  /** Queue an in-memory entry. */
  addBuffer(data: Uint8Array, zipPath: string, options?: ZipAddOptions): void
  /**
   * Write the central directory and wait until the archive is fully on disk at the output path.
   * Rejects (and leaves no output file) if any queued entry failed.
   */
  finish(): Promise<void>
  /** Stop writing and delete the partial output. */
  abort(): Promise<void>
}

/** Options for {@link createZip}. */
export interface CreateZipOptions {
  /** Aborting discards the partial archive; `finish()` then rejects with an `AbortError`. */
  signal?: AbortSignal
  /** Always write the ZIP64 end-of-central-directory records (they are added automatically when needed). */
  zip64?: boolean
}

function yazlOptions(o: ZipAddOptions): Partial<yazl.Options> {
  const out: Partial<yazl.Options> = {}
  if (o.compress !== undefined) out.compress = o.compress
  // Record a regular-file type when only permission bits are given.
  if (o.mode !== undefined) out.mode = (o.mode & 0o170000) === 0 ? 0o100000 | o.mode : o.mode
  if (o.mtime !== undefined) out.mtime = o.mtime
  if (o.zip64) out.forceZip64Format = true
  return out
}

/**
 * Create a zip archive at `outputPath`, streaming entries to disk as they are added.
 * Data is written to a temporary sibling file and renamed into place by `finish()`, so the
 * output path never holds a half-written archive. Entry paths are validated
 * (`EZIP_UNSAFE_PATH` for absolute paths or `..` segments) and stored with `/` separators.
 */
export function createZip(outputPath: string, options: CreateZipOptions = {}): ZipWriter {
  const zip = new yazl.ZipFile()
  const tmpPath = `${outputPath}.${randomBytes(6).toString('hex')}.tmp`
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let state: 'open' | 'finishing' | 'done' = 'open'
  let entryError: unknown

  const written = (async () => {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true })
    await pipeline(zip.outputStream as Readable, createWriteStream(tmpPath), { signal })
  })()
  // Errors surface through finish(). A failed or aborted write leaves only garbage behind.
  written.catch(() => rm(tmpPath, { force: true }).catch(() => {}))

  zip.on('error', (e: unknown) => {
    entryError ??= e
    controller.abort(e)
  })

  const assertOpen = () => {
    if (state !== 'open') throw new ZipError('EZIP_CLOSED', 'Zip writer is already finished')
  }

  return {
    addFile(filePath, zipPath, opts = {}) {
      assertOpen()
      zip.addFile(filePath, validateZipPath(zipPath), yazlOptions(opts))
    },
    addBuffer(data, zipPath, opts = {}) {
      assertOpen()
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      zip.addBuffer(buf, validateZipPath(zipPath), { mode: 0o100644, ...yazlOptions(opts) })
    },
    async finish() {
      assertOpen()
      state = 'finishing'
      zip.end(options.zip64 ? { forceZip64Format: true, comment: '' } : undefined)
      try {
        await written
        if (entryError) throw entryError
        await rename(tmpPath, outputPath)
      } catch (e) {
        await rm(tmpPath, { force: true })
        throw entryError ?? e
      } finally {
        state = 'done'
      }
    },
    async abort() {
      if (state === 'done') return
      state = 'done'
      controller.abort(new Error('Zip writing aborted'))
      await written.catch(() => {})
      await rm(tmpPath, { force: true })
    },
  }
}
