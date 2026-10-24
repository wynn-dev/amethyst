import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Decompress } from 'lzma1'
import { abortError, JavaError } from './errors'

/**
 * Streaming decoder for the LZMA "alone" format (`.lzma`: 13-byte header, then raw LZMA1), which
 * is what Mojang's runtime manifests offer as `downloads.lzma`. Decoding uses the pure-TypeScript
 * `lzma1` package, so it runs in the main thread or a `worker_threads` worker alike.
 */

/** Largest dictionary accepted from a header. Mojang uses 8 MiB; a hostile header could claim 4 GiB. */
export const MAX_LZMA_DICT = 64 * 1024 * 1024

/** Parsed `.lzma` header. `uncompressedSize` is `undefined` when the header says "unknown". */
export interface LzmaHeader {
  lc: number
  lp: number
  pb: number
  dictSize: number
  uncompressedSize?: number
}

/** Parse and sanity-check the 13-byte `.lzma` header. Throws `ELZMA` when it is not one. */
export function parseLzmaHeader(bytes: Uint8Array): LzmaHeader {
  if (bytes.length < 13) throw new JavaError('ELZMA', 'LZMA header truncated')
  const props = bytes[0] as number
  if (props >= 9 * 5 * 5) throw new JavaError('ELZMA', `invalid LZMA properties byte ${props}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, 13)
  const dictSize = view.getUint32(1, true)
  if (dictSize > MAX_LZMA_DICT) throw new JavaError('ELZMA', `LZMA dictionary too large (${dictSize} bytes)`)
  const size = view.getBigUint64(5, true)
  const header: LzmaHeader = { lc: props % 9, lp: Math.floor(props / 9) % 5, pb: Math.floor(props / 45), dictSize }
  if (size !== 0xffffffffffffffffn) header.uncompressedSize = Number(size)
  return header
}

export interface DecodeLzmaOptions {
  /** Expected decompressed size; decoding stops with `ELZMA` as soon as it is exceeded. */
  size?: number
  /** Expected sha1 of the decompressed bytes. */
  sha1?: string
  signal?: AbortSignal
}

/**
 * Decompress `src` (a `.lzma` file) into `dest`, streaming. Output goes to `<dest>.lzpart`
 * while being hashed and is renamed into place only when its size and sha1 match. On any
 * failure the partial file is removed and an `ELZMA` {@link JavaError} is thrown (or the
 * abort reason). Returns the number of bytes written.
 */
export async function decodeLzmaFile(src: string, dest: string, options: DecodeLzmaOptions = {}): Promise<number> {
  const { signal } = options
  signal?.throwIfAborted()
  const part = `${dest}.lzpart`
  const header = await readHead(src)
  parseLzmaHeader(header)
  const hash = createHash('sha1')
  let written = 0
  const fh = await open(part, 'w')
  let ok = false
  try {
    const input = Readable.toWeb(createReadStream(src, { highWaterMark: 256 * 1024 })) as unknown as WebReadableStream<Uint8Array>
    const output = input.pipeThrough(new Decompress() as unknown as TransformStream<Uint8Array, Uint8Array>) as unknown as AsyncIterable<Uint8Array>
    try {
      for await (const chunk of output) {
        if (signal?.aborted) throw abortError(signal)
        written += chunk.length
        if (options.size !== undefined && written > options.size) throw new JavaError('ELZMA', `LZMA output exceeds expected ${options.size} bytes`)
        hash.update(chunk)
        // oxlint-disable-next-line no-await-in-loop -- sequential writes keep memory bounded
        await fh.write(chunk)
      }
    } catch (e) {
      if (e instanceof JavaError || signal?.aborted) throw signal?.aborted ? abortError(signal) : e
      throw new JavaError('ELZMA', `LZMA decode failed: ${(e as Error).message}`, { cause: e })
    }
    if (options.size !== undefined && written !== options.size) throw new JavaError('ELZMA', `LZMA output is ${written} bytes, expected ${options.size}`)
    const digest = hash.digest('hex')
    if (options.sha1 && digest !== options.sha1.toLowerCase()) throw new JavaError('ELZMA', `LZMA output sha1 ${digest} does not match ${options.sha1}`)
    ok = true
  } finally {
    await fh.close()
    if (!ok) await rm(part, { force: true })
  }
  await rename(part, dest)
  return written
}

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(13)
    const { bytesRead } = await fh.read(buf, 0, 13, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}
