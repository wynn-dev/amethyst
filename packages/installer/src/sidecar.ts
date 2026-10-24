import { getDefaultHttpClient, type HttpClient } from '@amethyst/net'
import { InstallError } from './errors'

/** Digest algorithms published as maven sidecar files (`<file>.sha1`, `<file>.sha256`). */
export type SidecarAlgorithm = 'sha1' | 'sha256'

const LENGTH: Record<SidecarAlgorithm, number> = { sha1: 40, sha256: 64 }

/**
 * Parse a maven checksum sidecar: either a bare hex digest or `<digest>  <filename>`.
 * Returns the lowercase digest, or `undefined` when the content is not a digest of the right length
 * (for example an HTML error page served with status 200).
 */
export function parseSidecar(text: string, algorithm: SidecarAlgorithm): string | undefined {
  const token = text.trim().split(/\s+/)[0] ?? ''
  const re = new RegExp(`^[0-9a-fA-F]{${LENGTH[algorithm]}}$`)
  return re.test(token) ? token.toLowerCase() : undefined
}

/**
 * Fetch `<url>.<algorithm>` and parse it.
 *
 * @throws {InstallError} `EINSTALL_UNVERIFIED` when the sidecar exists but is not a digest;
 * HTTP and network errors from `@amethyst/net` propagate.
 */
export async function fetchSidecarHash(
  url: string,
  algorithm: SidecarAlgorithm,
  options: { http?: HttpClient; signal?: AbortSignal } = {},
): Promise<string> {
  const http = options.http ?? getDefaultHttpClient()
  const text = await http.text(`${url}.${algorithm}`, { signal: options.signal, maxBytes: 4096, retry: { retries: 1 } })
  const hash = parseSidecar(text, algorithm)
  if (!hash) throw new InstallError('EINSTALL_UNVERIFIED', `${url}.${algorithm} is not a ${algorithm} digest`, { url })
  return hash
}

/** A digest for a file whose contents will be executed. */
export interface VerifiedHash {
  algorithm: SidecarAlgorithm
  value: string
}

/**
 * Get a trusted digest for an artifact that will be executed (Forge/NeoForge installer jars),
 * preferring the `.sha256` sidecar and falling back to `.sha1`. **Fails closed**: when neither
 * sidecar can be fetched and parsed, it throws instead of returning nothing.
 *
 * @throws {InstallError} `EINSTALL_UNVERIFIED` when no digest is available. Cancellation propagates.
 */
export async function requireSidecarHash(url: string, options: { http?: HttpClient; signal?: AbortSignal } = {}): Promise<VerifiedHash> {
  const errors: string[] = []
  for (const algorithm of ['sha256', 'sha1'] as const) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the fallback only runs when the first sidecar fails
      return { algorithm, value: await fetchSidecarHash(url, algorithm, options) }
    } catch (e) {
      if (options.signal?.aborted) throw e
      errors.push(`${algorithm}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new InstallError('EINSTALL_UNVERIFIED', `refusing to use ${url}: no checksum could be obtained (${errors.join('; ')})`, { url })
}
