/**
 * Streaming multi-digest hashing. A file is read once and fed to every requested digest, so
 * computing SHA-1 and SHA-512 together costs one pass over the disk. CurseForge's murmur2
 * fingerprint lives in `@amethyst/marketplace`, not here.
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { abortError, throwIfAborted } from './errors'

/** Digest algorithms supported by {@link hashFile}. */
export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512' | 'md5'

/** Lowercase hex digests for each requested algorithm, plus the number of bytes hashed. */
export type HashResult<A extends HashAlgorithm = HashAlgorithm> = { [K in A]: string } & { size: number }

/** Options for {@link hashFile} and {@link hashStream}. */
export interface HashOptions {
  signal?: AbortSignal
  /** Called with the cumulative number of bytes hashed after each chunk. */
  onProgress?: (bytes: number) => void
}

const SUPPORTED: ReadonlySet<string> = new Set<HashAlgorithm>(['sha1', 'sha256', 'sha512', 'md5'])

/** True for a lowercase or uppercase hex SHA-1 (40 hex digits). */
export function isSha1(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

/**
 * Incremental hasher for several digests at once. Feed chunks with `update`, then call
 * `digest` once.
 */
export class MultiHasher<A extends HashAlgorithm = HashAlgorithm> {
  readonly #hashes: [A, Hash][]
  #size = 0

  constructor(algorithms: readonly A[]) {
    const unique = [...new Set(algorithms)]
    if (unique.length === 0) throw new RangeError('At least one hash algorithm is required')
    for (const a of unique) if (!SUPPORTED.has(a)) throw new RangeError(`Unsupported hash algorithm: ${a}`)
    this.#hashes = unique.map((a) => [a, createHash(a)])
  }

  /** Bytes fed so far. */
  get size(): number {
    return this.#size
  }

  update(chunk: Uint8Array): void {
    this.#size += chunk.byteLength
    for (const [, h] of this.#hashes) h.update(chunk)
  }

  digest(): HashResult<A> {
    const out: Record<string, string | number> = { size: this.#size }
    for (const [a, h] of this.#hashes) out[a] = h.digest('hex')
    return out as HashResult<A>
  }
}

/**
 * Hash a readable stream with every algorithm in `algorithms`, consuming it fully.
 * Rejects with an `AbortError` (and destroys the stream) when `signal` fires.
 */
export async function hashStream<A extends HashAlgorithm>(stream: Readable, algorithms: readonly A[], options: HashOptions = {}): Promise<HashResult<A>> {
  const { signal, onProgress } = options
  const hasher = new MultiHasher(algorithms)
  if (signal?.aborted) {
    stream.destroy()
    throw abortError(signal)
  }
  const onAbort = () => signal && stream.destroy(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of stream) {
      hasher.update(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array))
      onProgress?.(hasher.size)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  throwIfAborted(signal)
  return hasher.digest()
}

/**
 * Hash a file in one streaming pass, computing every digest in `algorithms` (default SHA-1).
 *
 * @example
 * const { sha1, sha512, size } = await hashFile(jar, ['sha1', 'sha512'])
 */
export async function hashFile<A extends HashAlgorithm = 'sha1'>(
  filePath: string,
  algorithms: readonly A[] = ['sha1' as A],
  options: HashOptions = {},
): Promise<HashResult<A>> {
  throwIfAborted(options.signal)
  return hashStream(createReadStream(filePath, { highWaterMark: 256 * 1024 }), algorithms, options)
}
