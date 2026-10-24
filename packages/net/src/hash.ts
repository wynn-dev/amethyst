/* oxlint-disable no-await-in-loop -- file blocks are hashed in order by design */
import { createHash, type Hash } from 'node:crypto'
import { type FileHandle, open } from 'node:fs/promises'
import { abortReason } from './errors'
import type { HashAlgorithm } from './types'

const BUFFER_SIZE = 128 * 1024
const POOL_LIMIT = 16
const pool: Buffer[] = []

/** Borrow a read buffer; reused across calls so hashing thousands of files allocates almost nothing. */
function acquire(): Buffer {
  return pool.pop() ?? Buffer.allocUnsafe(BUFFER_SIZE)
}

function release(buf: Buffer): void {
  if (pool.length < POOL_LIMIT) pool.push(buf)
}

/** Feed bytes `[start, end)` of an open file into `hash`, reading through a pooled buffer. */
export async function hashRange(fh: FileHandle, hash: Hash, start: number, end: number, signal?: AbortSignal): Promise<void> {
  const buf = acquire()
  try {
    let pos = start
    while (pos < end) {
      if (signal?.aborted) throw abortReason(signal)
      const { bytesRead } = await fh.read(buf, 0, Math.min(BUFFER_SIZE, end - pos), pos)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  } finally {
    release(buf)
  }
}

/**
 * Hash a file with a streaming read and return the lowercase hex digest. I/O errors (including
 * `ENOENT`) propagate; they are never turned into a spurious mismatch.
 */
export async function hashFile(path: string, algorithm: HashAlgorithm, signal?: AbortSignal): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const hash = createHash(algorithm)
    await hashRange(fh, hash, 0, Number.POSITIVE_INFINITY, signal)
    return hash.digest('hex')
  } finally {
    await fh.close()
  }
}
