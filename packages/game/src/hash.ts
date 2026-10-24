import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { abortError } from './errors'

/** Stream a file through a hash and return the lowercase hex digest. */
export async function hashFile(file: string, algorithm: 'sha1' | 'sha256', signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError(signal)
  const hash = createHash(algorithm)
  const stream = createReadStream(file, { highWaterMark: 1 << 20 })
  const onAbort = () => signal && stream.destroy(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return hash.digest('hex')
}
