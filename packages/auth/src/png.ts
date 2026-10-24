/**
 * Skin image validation without an image library: the PNG signature and the IHDR chunk are
 * enough to check the format and dimensions before an upload.
 */

import { crc32 } from 'node:zlib'
import { AuthError } from './errors'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Client-side upper bound for skin uploads. Real skins are a few KB; Mojang rejects large files. */
export const MAX_SKIN_BYTES = 256 * 1024

/**
 * Read width and height from a PNG's IHDR chunk. Returns `undefined` if the bytes are not a PNG
 * (bad signature, IHDR not first, wrong length, or bad CRC).
 */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 8-byte signature + 4 length + 4 type + 13 data + 4 CRC.
  if (bytes.length < 33) return undefined
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13) return undefined
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return undefined
  if (crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) return undefined
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0) return undefined
  return { width, height }
}

/** Whether a PNG has skin dimensions: 64×64, or legacy 64×32. */
export function isSkinSize(size: { width: number; height: number }): boolean {
  return size.width === 64 && (size.height === 64 || size.height === 32)
}

/**
 * Throw unless `bytes` is a PNG of 64×64 or 64×32 pixels and at most {@link MAX_SKIN_BYTES}.
 * Codes: `ESKIN_TOO_LARGE`, `ESKIN_INVALID_PNG`, `ESKIN_BAD_DIMENSIONS`.
 */
export function validateSkinPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > MAX_SKIN_BYTES) throw new AuthError('ESKIN_TOO_LARGE', 'Skin file is too large')
  const size = readPngDimensions(bytes)
  if (!size) throw new AuthError('ESKIN_INVALID_PNG', 'Skin file is not a valid PNG image')
  if (!isSkinSize(size)) {
    throw new AuthError('ESKIN_BAD_DIMENSIONS', `Invalid skin image (must be 64×64 or 64×32, got ${size.width}×${size.height})`)
  }
  return size
}
