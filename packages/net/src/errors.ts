import { CancelledError } from '@amethyst/task'
import type { DownloadItem, DownloadStats } from './types'

/**
 * Stable error codes thrown by `@amethyst/net`:
 * - `EHTTP`: the server answered with a non-success status ({@link HttpError}).
 * - `ECHECKSUM`: the downloaded bytes do not match the expected hash ({@link ChecksumError}).
 * - `ESIZE`: the number of bytes received differs from the expected size ({@link SizeMismatchError}).
 * - `EBADRESPONSE`: the response was malformed (invalid JSON, too large, unexpected 2xx status,
 *   bad `Content-Range`, redirect loop or HTTPS to HTTP downgrade).
 * - `ECONFLICT`: two concurrent downloads target the same path with different expectations.
 * - `ESTALLED`: a download URL made no progress (no response, no body bytes) for too long.
 * - `EDOWNLOAD`: one or more items of a batch failed ({@link DownloadError}).
 *
 * Network-level failures (DNS, connection refused, timeouts) are rethrown as produced by Node and
 * undici; they carry their own `code` (`ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, ...).
 * Cancellation surfaces as the signal's abort reason, or a `CancelledError` if the reason is not an
 * `Error`.
 */
export type NetErrorCode = 'EHTTP' | 'ECHECKSUM' | 'ESIZE' | 'EBADRESPONSE' | 'ECONFLICT' | 'ESTALLED'

/** Base class of the typed errors thrown by this package. */
export class NetError extends Error {
  override name = 'NetError'

  constructor(
    readonly code: NetErrorCode,
    message: string,
    /** The request URL with its query string and fragment removed (signed CDN URLs). */
    readonly url?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** The server answered with a status the caller did not accept (after retries, if any). */
export class HttpError extends NetError {
  override name = 'HttpError'
  declare readonly code: 'EHTTP'
  declare readonly url: string

  constructor(
    readonly status: number,
    url: string,
    /** Delay requested by the server through `Retry-After`, in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super('EHTTP', `HTTP ${status} for ${sanitizeUrl(url)}`, sanitizeUrl(url))
  }
}

/** The downloaded content does not hash to the expected value. The partial file is removed. */
export class ChecksumError extends NetError {
  override name = 'ChecksumError'
  declare readonly code: 'ECHECKSUM'

  constructor(
    readonly algorithm: string,
    readonly expected: string,
    readonly actual: string,
    readonly path: string,
    url?: string,
  ) {
    super('ECHECKSUM', `${algorithm} mismatch for ${path}: expected ${expected}, got ${actual}`, url && sanitizeUrl(url))
  }
}

/** The number of bytes received differs from `Content-Length`, the requested range or the expected size. */
export class SizeMismatchError extends NetError {
  override name = 'SizeMismatchError'
  declare readonly code: 'ESIZE'

  constructor(
    readonly expected: number,
    readonly actual: number,
    url?: string,
  ) {
    super('ESIZE', `expected ${expected} bytes, received ${actual}${url ? ` from ${sanitizeUrl(url)}` : ''}`, url && sanitizeUrl(url))
  }
}

/** One failed item of a {@link DownloadError}. */
export interface DownloadFailure {
  item: DownloadItem
  error: Error
}

/**
 * Thrown by `downloadMany` when at least one item failed. Every failure is collected (unless
 * `failFast` is set), with the item it belongs to. `errors` mirrors `failures` for compatibility
 * with `AggregateError` consumers.
 */
export class DownloadError extends AggregateError {
  override name = 'DownloadError'
  readonly code = 'EDOWNLOAD'

  constructor(
    readonly failures: DownloadFailure[],
    /** What did succeed before the batch settled. */
    readonly stats: DownloadStats,
  ) {
    const first = failures[0]
    super(
      failures.map((f) => f.error),
      `${failures.length} download${failures.length === 1 ? '' : 's'} failed` + (first ? `; first: ${first.item.dest}: ${first.error.message}` : ''),
    )
  }
}

/** Strip query string, fragment and credentials so URLs can be shown and logged safely. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url.replace(/[?#].*$/, '')
  }
}

/** The error to throw for an aborted signal: its reason if that is an `Error`, otherwise a `CancelledError`. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new CancelledError(String(reason ?? 'Cancelled'))
}
