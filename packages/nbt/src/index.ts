/**
 * Java Edition Named Binary Tag (NBT) reader and writer.
 *
 * Values use a typed, lossless model ({@link NbtTag}): explicit numeric widths, `bigint` longs,
 * typed arrays for array tags and `Map`-backed compounds that preserve key order. Use
 * {@link readNbt} / {@link writeNbt} for files (gzip, zlib or uncompressed) and {@link toPlain}
 * for read-only display.
 *
 * Reading is schema-less and defensive: nesting is capped at 512 levels, every length is
 * checked against the remaining input before allocating, and decompressed size is bounded.
 * All failures throw {@link NbtError} with a stable `code`.
 */
import { compress, DEFAULT_MAX_DECOMPRESSED_BYTES, decompress, detectCompression } from './compression'
import { decodeNbt, type DecodeOptions } from './reader'
import type { NbtCompound, NbtCompression, NbtReadResult } from './types'
import { encodeNbt } from './writer'

export { NbtError, type NbtErrorCode } from './errors'
export { decodeMutf8, encodeMutf8 } from './mutf8'
export { toPlain, type NbtPlain, type NbtPlainObject, type ToPlainOptions } from './plain'
export { DEFAULT_MAX_DEPTH, decodeNbt, type DecodeOptions } from './reader'
export { encodeNbt } from './writer'
export { DEFAULT_MAX_DECOMPRESSED_BYTES, detectCompression }
export {
  nbt,
  NBT_TAG_IDS,
  NBT_TYPES,
  type NbtByte,
  type NbtByteArray,
  type NbtCompound,
  type NbtCompression,
  type NbtDouble,
  type NbtFile,
  type NbtFloat,
  type NbtInt,
  type NbtIntArray,
  type NbtList,
  type NbtLong,
  type NbtLongArray,
  type NbtReadResult,
  type NbtShort,
  type NbtString,
  type NbtTag,
  type NbtTagOf,
  type NbtType,
} from './types'

/** Options for {@link readNbt}. */
export interface ReadNbtOptions extends DecodeOptions {
  /** Force a compression instead of auto-detecting it from the magic bytes. */
  compression?: NbtCompression
  /** Upper bound on the decompressed size in bytes. Defaults to 128 MiB. */
  maxDecompressedBytes?: number
}

/** Options for {@link writeNbt}. */
export interface WriteNbtOptions {
  /** Compression to wrap the payload in. `level.dat` and player data use `gzip`. */
  compression: NbtCompression
}

/**
 * Read an NBT file from bytes. Compression (gzip, zlib or none) is auto-detected unless
 * `options.compression` is given. Decompression runs asynchronously on the libuv pool.
 *
 * @throws {NbtError} `ENBT_MALFORMED` when the data is corrupt, truncated, too deep or too large.
 */
export async function readNbt(data: Uint8Array, options: ReadNbtOptions = {}): Promise<NbtReadResult> {
  const compression = options.compression ?? detectCompression(data)
  const raw = await decompress(data, compression, options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES)
  const file = decodeNbt(raw, options)
  return { ...file, compression }
}

/**
 * Encode an NBT document (root compound plus optional root name, default `""`) and compress it.
 *
 * @throws {NbtError} `ENBT_INVALID` when a value cannot be encoded.
 */
export async function writeNbt(file: { name?: string; root: NbtCompound }, options: WriteNbtOptions): Promise<Buffer> {
  return compress(encodeNbt(file), options.compression)
}
