/* oxlint-disable no-await-in-loop -- retries are sequential by design */
import { abortReason, HttpError } from './errors'

/** Retry policy for transient failures. */
export interface RetryOptions {
  /** Retries after the first attempt (default 3). `0` disables retries. */
  retries: number
  /** Delay before the first retry, in ms (default 500). Doubles on every retry. */
  baseDelayMs: number
  /** Upper bound of the exponential backoff, in ms (default 30 000). */
  maxDelayMs: number
  /** Upper bound applied to `Retry-After`, in ms (default 60 000). */
  maxRetryAfterMs: number
  /** Called before each retry wait, e.g. for logging or telemetry. */
  onRetry?: (info: RetryInfo) => void
}

/** Passed to {@link RetryOptions.onRetry}. */
export interface RetryInfo {
  /** 1 for the first retry. */
  attempt: number
  delayMs: number
  error: Error
  url: string
}

export const DEFAULT_RETRY: Readonly<RetryOptions> = Object.freeze({
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
})

/** Network error codes worth retrying (connection resets, timeouts, DNS, unreachable hosts). */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ERR_HTTP2_STREAM_ERROR',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_STREAM_PREMATURE_CLOSE',
])

/** Codes that usually mean "offline": retried at most once so failures surface quickly. */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'ENETUNREACH', 'ENETDOWN'])

function errorCode(e: unknown): string | undefined {
  let cur: unknown = e
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && code !== 'UND_ERR') return code
    cur = cur.cause
  }
  return undefined
}

/** Whether an HTTP status is transient: 408, 429 and 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/** Whether an error (HTTP or network) is transient and worth retrying. */
export function isRetryableError(e: unknown): boolean {
  if (e instanceof HttpError) return isRetryableStatus(e.status)
  const code = errorCode(e)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

/** Max retries allowed for this error, given the policy (offline errors are capped at 1). */
export function retryBudget(e: unknown, retries: number): number {
  const code = errorCode(e)
  return code !== undefined && OFFLINE_CODES.has(code) ? Math.min(1, retries) : retries
}

/** Parse `Retry-After` (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const v = Array.isArray(value) ? value[0] : value
  if (!v) return undefined
  if (/^\s*\d+\s*$/.test(v)) return Number.parseInt(v, 10) * 1000
  const date = Date.parse(v)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** Delay before retry number `attempt` (1-based): exponential backoff with ±25 % jitter, or `Retry-After`. */
export function backoffDelay(attempt: number, policy: RetryOptions, error?: unknown): number {
  if (error instanceof HttpError && error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxRetryAfterMs)
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(exp * (0.75 + Math.random() * 0.5))
}

/** Promise-based sleep that rejects with the abort reason as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run `fn` and retry it on transient errors according to `policy`. `attempt` is 0 for the first
 * call. Aborts are never retried.
 */
export async function withRetry<T>(url: string, policy: RetryOptions, signal: AbortSignal | undefined, fn: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal)
      if (!isRetryableError(e) || attempt >= retryBudget(e, policy.retries)) throw e
      const delayMs = backoffDelay(attempt + 1, policy, e)
      policy.onRetry?.({ attempt: attempt + 1, delayMs, error: e as Error, url })
      await sleep(delayMs, signal)
    }
  }
}
