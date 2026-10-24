/**
 * Minimal HTTP helper over the global `fetch`, with per-request timeouts, cancellation, retry
 * with backoff for transient statuses, and typed errors.
 *
 * Bodies are read exactly once, inside the timeout window, so callers can inspect both the text
 * and the parsed JSON without the "body already used" trap.
 */

import { AuthError, sleep, type AuthErrorType } from './errors'

/** Options accepted by every network-facing function in this package. */
export interface HttpOptions {
  /** `fetch` implementation. Defaults to the global `fetch`; inject one for tests. */
  fetch?: typeof fetch
  /** Cancels the whole operation. Rejections are `AuthError` with code `ECANCELLED`. */
  signal?: AbortSignal
  /** Per-request timeout in milliseconds (default 30 000). */
  timeoutMs?: number
  /** Retry policy for transient failures of the Xbox and Minecraft services calls. */
  retry?: Partial<RetryPolicy>
}

/** Retry policy for 408, 425, 429, 500, 502, 503 and 504 responses. */
export interface RetryPolicy {
  /** Total attempts including the first (default 4). */
  attempts: number
  /** Base delay for exponential backoff, in milliseconds (default 500). */
  baseMs: number
  /** Maximum delay between attempts (default 30 000). A larger `Retry-After` stops retrying. */
  capMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 500, capMs: 30_000 }
export const DEFAULT_TIMEOUT_MS = 30_000

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/** A fully read response. */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: Headers
  text: string
  /** Parsed JSON body, or `undefined` if the body is not valid JSON. */
  json: unknown
  /** The `Retry-After` header converted to milliseconds, if present. */
  retryAfterMs?: number
}

/** @internal */
export interface RequestOptions extends HttpOptions {
  /** Error category for transport failures in this step. */
  stage: AuthErrorType
  /** Apply {@link RetryPolicy} to transient statuses. */
  retryable?: boolean
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function parseJson(text: string): unknown {
  const t = text.trimStart()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** @internal Perform one logical request, retrying transient statuses when `retryable` is set. */
export async function request(url: string, init: RequestInit, options: RequestOptions): Promise<HttpResponse> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const policy = { ...DEFAULT_RETRY, ...options.retry }
  const attempts = options.retryable ? Math.max(1, policy.attempts) : 1
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) {
      throw new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: options.signal.reason })
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let res: Response
    let text: string
    try {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by design
      res = await fetchImpl(url, { ...init, signal })
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
      if (attempt < attempts && RETRY_STATUSES.has(res.status)) {
        const delay = Math.max(retryAfterMs ?? 0, Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1)))
        if (delay <= policy.capMs) {
          // oxlint-disable-next-line no-await-in-loop
          await res.body?.cancel().catch(() => {})
          // oxlint-disable-next-line no-await-in-loop
          await sleep(delay, options.signal)
          continue
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      text = await res.text()
      const out: HttpResponse = { status: res.status, ok: res.ok, headers: res.headers, text, json: parseJson(text) }
      if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs
      return out
    } catch (e) {
      if (e instanceof AuthError) throw e
      if (options.signal?.aborted) {
        throw new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: options.signal.reason })
      }
      if (timeout.aborted) {
        throw new AuthError('ETIMEOUT', `Request to ${new URL(url).host} timed out`, {
          type: options.stage,
          reason: 'NETWORK',
          retryable: true,
          cause: e,
        })
      }
      throw new AuthError('ENETWORK', `Could not reach ${new URL(url).host}`, {
        type: options.stage,
        reason: 'NETWORK',
        retryable: true,
        cause: e,
      })
    }
  }
}

/** @internal Shorthand for a JSON POST. */
export function postJson(url: string, body: unknown, headers: Record<string, string>, options: RequestOptions): Promise<HttpResponse> {
  return request(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) },
    options,
  )
}

/** @internal Shorthand for a form-encoded POST. */
export function postForm(url: string, params: Record<string, string>, options: RequestOptions): Promise<HttpResponse> {
  return request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    },
    options,
  )
}

/** @internal Narrow an unknown JSON value to a plain object. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** @internal Read a string field from an unknown object. */
export function str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === 'string' ? v : undefined
}

/** @internal Read a finite number field from an unknown object. */
export function num(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
