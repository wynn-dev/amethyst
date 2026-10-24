/**
 * CurseForge file fingerprint: 32-bit MurmurHash2 (public domain, Austin Appleby) with seed 1,
 * computed over the file's bytes after removing every 0x09, 0x0A, 0x0D and 0x20 byte
 * (everywhere, including binary data). The result is an unsigned 32-bit integer.
 *
 * MurmurHash2 mixes the input length into its initial state, so the normalised length must be
 * known before hashing starts. That gives three ways to hash:
 *
 * - a `Uint8Array`/`Buffer`: one pass in memory;
 * - a factory returning a fresh stream (`() => createReadStream(path)`): two streaming passes
 *   (count, then hash) with constant memory. Prefer this for large files;
 * - a one-shot `AsyncIterable` (an already-open stream): read once in chunks; the normalised
 *   bytes are buffered, so memory is proportional to the file size.
 *
 * {@link FingerprintHasher} is the incremental core when the length is already known. All
 * arithmetic uses `Math.imul` for 32-bit wrap-around. The code is pure and safe to run in a
 * `worker_threads` worker.
 */

const M = 0x5bd1e995
const SEED = 1

/** True for the bytes CurseForge strips before hashing: tab, LF, CR and space. */
export function isFingerprintWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20
}

/** Number of bytes in `chunk` that are hashed (i.e. not whitespace). */
export function countFingerprintBytes(chunk: Uint8Array): number {
  let n = 0
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i] as number
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20) n++
  }
  return n
}

/**
 * Incremental fingerprint over raw (un-normalised) chunks whose normalised length is known.
 * Whitespace is skipped as chunks are fed, so chunk boundaries do not matter.
 */
export class FingerprintHasher {
  private h: number
  private k = 0
  private pending = 0
  private seen = 0
  private done = false

  /** @param normalisedLength byte count after whitespace removal (see {@link countFingerprintBytes}). */
  constructor(private readonly normalisedLength: number) {
    if (!Number.isInteger(normalisedLength) || normalisedLength < 0) {
      throw new RangeError(`Invalid fingerprint length: ${normalisedLength}`)
    }
    // MurmurHash2 uses a 32-bit length; files over 4 GiB wrap like the reference algorithm.
    this.h = (SEED ^ normalisedLength) >>> 0
  }

  update(chunk: Uint8Array): this {
    if (this.done) throw new Error('FingerprintHasher.update() after digest()')
    let { h, k, pending } = this
    let seen = 0
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number
      if (b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20) continue
      seen++
      k |= b << (pending * 8)
      if (++pending === 4) {
        k = Math.imul(k, M)
        k ^= k >>> 24
        k = Math.imul(k, M)
        h = Math.imul(h, M) ^ k
        k = 0
        pending = 0
      }
    }
    this.h = h
    this.k = k
    this.pending = pending
    this.seen += seen
    return this
  }

  /** Finishes the hash. Throws if the bytes fed do not add up to the declared length. */
  digest(): number {
    if (this.done) throw new Error('FingerprintHasher.digest() called twice')
    this.done = true
    if (this.seen !== this.normalisedLength) {
      throw new Error(`Fingerprint length mismatch: declared ${this.normalisedLength}, hashed ${this.seen}`)
    }
    let h = this.h
    if (this.pending > 0) {
      h ^= this.k
      h = Math.imul(h, M)
    }
    h ^= h >>> 13
    h = Math.imul(h, M)
    h ^= h >>> 15
    return h >>> 0
  }
}

/** Fingerprint of an in-memory buffer. */
export function curseforgeFingerprintSync(data: Uint8Array): number {
  return new FingerprintHasher(countFingerprintBytes(data)).update(data).digest()
}

export type FingerprintSource = Uint8Array | AsyncIterable<Uint8Array> | (() => AsyncIterable<Uint8Array>)

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason
}

/**
 * CurseForge fingerprint (uint32) of a buffer or stream. See the module comment for which
 * input to choose. Chunks may be `Buffer`s or any `Uint8Array`.
 */
export async function curseforgeFingerprint(source: FingerprintSource, signal?: AbortSignal): Promise<number> {
  checkAbort(signal)
  if (source instanceof Uint8Array) return curseforgeFingerprintSync(source)

  if (typeof source === 'function') {
    let length = 0
    for await (const chunk of source()) {
      checkAbort(signal)
      length += countFingerprintBytes(chunk)
    }
    const hasher = new FingerprintHasher(length)
    for await (const chunk of source()) {
      checkAbort(signal)
      hasher.update(chunk)
    }
    return hasher.digest()
  }

  // One-shot stream: keep only the non-whitespace bytes of each chunk.
  const kept: Uint8Array[] = []
  let length = 0
  for await (const chunk of source) {
    checkAbort(signal)
    const out = new Uint8Array(countFingerprintBytes(chunk))
    let j = 0
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number
      if (b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20) out[j++] = b
    }
    kept.push(out)
    length += out.length
  }
  const hasher = new FingerprintHasher(length)
  for (const part of kept) hasher.update(part)
  return hasher.digest()
}
