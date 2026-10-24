import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { malformed } from './errors'
import type { NbtCompression } from './types'

const gunzip = promisify(zlib.gunzip)
const inflate = promisify(zlib.inflate)
const gzip = promisify(zlib.gzip)
const deflate = promisify(zlib.deflate)

/** Default cap on decompressed size; guards against decompression bombs. */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024

/**
 * Guess the compression of an NBT blob from its first bytes: gzip magic `1F 8B`, a valid
 * zlib header (deflate method, checksum divisible by 31), otherwise uncompressed.
 */
export function detectCompression(bytes: Uint8Array): NbtCompression {
  const a = bytes[0]
  const b = bytes[1]
  if (a === undefined || b === undefined) return 'none'
  if (a === 0x1f && b === 0x8b) return 'gzip'
  if ((a & 0x0f) === 8 && a >> 4 <= 7 && ((a << 8) | b) % 31 === 0) return 'zlib'
  return 'none'
}

/** Decompress `bytes` (async, off the main thread's JS execution via the zlib thread pool). */
export async function decompress(bytes: Uint8Array, compression: NbtCompression, maxOutputLength: number): Promise<Uint8Array> {
  if (compression === 'none') return bytes
  try {
    const fn = compression === 'gzip' ? gunzip : inflate
    return await fn(bytes, { maxOutputLength })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw malformed(`Decompressed NBT exceeds ${maxOutputLength} bytes`, { cause: e })
    throw malformed(`Corrupt ${compression} stream: ${(e as Error).message}`, { cause: e })
  }
}

/** Compress `bytes` with the chosen method. */
export async function compress(bytes: Uint8Array, compression: NbtCompression): Promise<Buffer> {
  if (compression === 'gzip') return gzip(bytes)
  if (compression === 'zlib') return deflate(bytes)
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
