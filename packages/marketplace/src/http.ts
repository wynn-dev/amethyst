/**
 * Shared JSON transport for the platform clients.
 *
 * One {@link Transport} per platform handles everything that is not API-specific:
 *
 * - URL building (parameters that are `undefined`, `null` or `''` are never sent);
 * - an injectable `fetch` (default: the global one) with a per-attempt timeout;
 * - the {@link RateLimiter}, fed from response headers and paused on 429;
 * - retries with backoff for 429, 500/502/503/504, network errors and timeouts (never for
 *   other 4xx);
 * - in-flight de-duplication of identical requests (same method, URL and body);
 * - the GET cache ({@link MarketCache});
 * - response validation, before anything is cached;
 * - normalisation of every failure into a {@link MarketplaceError}.
 *
 * De-duplicated requests are shared: aborting one caller's signal rejects only that caller,
 * and the underlying request is aborted only once every caller has gone.
 */

import type { MarketCache } from './cache'
import { MarketplaceError, type MarketSource } from './errors'
import type { RateLimiter } from './rate-limit'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Per-call options accepted by every client method. */
export interface RequestOptions {
  signal?: AbortSignal
  /** Skip a fresh cache entry and refetch (the result is still cached). Used by update checks. */
  fresh?: boolean
}

export type QueryValue = string | number | boolean | undefined | null
export type Query = Record<string, QueryValue>

export interface TransportOptions {
  platform: MarketSource
  baseUrl: string
  headers: Record<string, string>
  fetch?: FetchLike
  /** `false` disables caching. */
  cache?: MarketCache | false
  /** `false` disables client-side rate limiting. */
  limiter?: RateLimiter | false
  /** Per-attempt timeout covering headers and body (default 20 000 ms). */
  timeoutMs?: number
  /** Retries after the first attempt (default 3). */
  retries?: number
  /** Backoff for 5xx / network errors, indexed by attempt (default 500, 1500, 4000 ms). */
  retryDelaysMs?: readonly number[]
  /** Backoff for 429 responses that carry no `Retry-After` hint (default 2000, 4000, 8000 ms). */
  rateLimitDelaysMs?: readonly number[]
  /** Called with every response status before it is interpreted. */
  onResponse?: (status: number) => void
  /** Source of jitter in [0, 1) (default `Math.random`). */
  random?: () => number
}

export interface TransportRequest<T> {
  method?: 'GET' | 'POST'
  path: string
  query?: Query
  body?: unknown
  /** Cache TTL for GET responses. Omit or 0 to skip the cache. */
  ttlMs?: number
  /** Validates and narrows the parsed JSON. Throw (any error) to reject the shape. */
  validate: (value: unknown) => T
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

interface Inflight {
  promise: Promise<unknown>
  controller: AbortController
  refs: number
}

/** Builds `base + path + ?query`, dropping empty parameters. */
export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Parses `Retry-After` (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function errorMessageFromBody(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text)
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>
      for (const k of ['description', 'errorMessage', 'error', 'message']) {
        if (typeof o[k] === 'string' && o[k]) return (o[k] as string).slice(0, 300)
      }
    }
  } catch {
    // Not JSON (often an HTML error page); never surface it.
  }
  return undefined
}

export class Transport {
  readonly platform: MarketSource
  private readonly options: TransportOptions
  private readonly fetchImpl: FetchLike
  private readonly cache: MarketCache | undefined
  private readonly limiter: RateLimiter | undefined
  private readonly inflight = new Map<string, Inflight>()

  constructor(options: TransportOptions) {
    this.options = options
    this.platform = options.platform
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.cache = options.cache === false ? undefined : options.cache
    this.limiter = options.limiter === false ? undefined : options.limiter
  }

  url(path: string, query?: Query): string {
    return buildUrl(this.options.baseUrl, path, query)
  }

  async request<T>(req: TransportRequest<T>, opts: RequestOptions = {}): Promise<T> {
    const method = req.method ?? 'GET'
    const url = this.url(req.path, req.query)
    const body = req.body === undefined ? undefined : JSON.stringify(req.body)
    const cacheKey = method === 'GET' && this.cache && req.ttlMs ? `${this.platform} ${url}` : undefined

    if (cacheKey && !opts.fresh) {
      const hit = this.cache?.get(cacheKey)
      if (hit !== undefined) return hit as T
    }

    const key = `${method} ${url} ${body ?? ''}${opts.fresh ? ' fresh' : ''}`
    return this.shared(
      key,
      async (signal) => {
        const value = await this.execute(method, url, body, req.validate, signal)
        if (cacheKey && req.ttlMs) this.cache?.set(cacheKey, value, req.ttlMs)
        return value
      },
      opts.signal,
    ) as Promise<T>
  }

  private shared(key: string, run: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let entry = this.inflight.get(key)
    if (!entry) {
      const controller = new AbortController()
      const created: Inflight = { promise: Promise.resolve(), controller, refs: 0 }
      created.promise = run(controller.signal).finally(() => {
        if (this.inflight.get(key) === created) this.inflight.delete(key)
      })
      this.inflight.set(key, created)
      entry = created
    }
    entry.refs += 1
    if (!signal) return entry.promise
    const shared = entry
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        shared.refs -= 1
        if (shared.refs === 0) {
          if (this.inflight.get(key) === shared) this.inflight.delete(key)
          shared.controller.abort(signal.reason)
        }
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort)
          resolve(v)
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      )
    })
  }

  private backoff(delays: readonly number[], attempt: number): number {
    const base = delays[Math.min(attempt, delays.length - 1)] ?? 1000
    const jitter = 1 + ((this.options.random ?? Math.random)() * 0.5 - 0.25)
    return Math.round(base * jitter)
  }

  private async execute<T>(
    method: string,
    url: string,
    body: string | undefined,
    validate: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    const retries = this.options.retries ?? 3
    const retryDelays = this.options.retryDelaysMs ?? [500, 1500, 4000]
    const rateDelays = this.options.rateLimitDelaysMs ?? [2000, 4000, 8000]
    const platform = this.platform

    // Attempts are sequential by design, so awaiting inside the loop is intended.
    /* oxlint-disable no-await-in-loop */
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < retries
      let failure: MarketplaceError
      let waitMs = 0

      const release = this.limiter ? await this.limiter.acquire(signal) : undefined
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? 20_000)
      try {
        const headers: Record<string, string> = { accept: 'application/json', ...this.options.headers }
        if (body !== undefined) headers['content-type'] = 'application/json'
        let res: Response
        try {
          res = await this.fetchImpl(url, {
            method,
            headers,
            body,
            redirect: 'follow',
            signal: AbortSignal.any([signal, timeout.signal]),
          })
        } catch (e) {
          if (signal.aborted) throw signal.reason
          throw timeout.signal.aborted
            ? new MarketplaceError('ETIMEOUT', `Request timed out: ${url}`, { platform, url, retryable: true, cause: e })
            : new MarketplaceError('ENETWORK', `Network error: ${url}`, { platform, url, retryable: true, cause: e })
        }

        this.limiter?.observe(res.headers)
        this.options.onResponse?.(res.status)

        let text: string
        try {
          text = await res.text()
        } catch (e) {
          if (signal.aborted) throw signal.reason
          throw new MarketplaceError(timeout.signal.aborted ? 'ETIMEOUT' : 'ENETWORK', `Failed reading body: ${url}`, {
            platform,
            url,
            status: res.status,
            retryable: true,
            cause: e,
          })
        }

        if (res.ok) {
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch (e) {
            throw new MarketplaceError('EBAD_RESPONSE', `Invalid JSON from ${url}`, { platform, url, status: res.status, cause: e })
          }
          try {
            return validate(json)
          } catch (e) {
            if (e instanceof MarketplaceError) throw e
            const detail = e instanceof Error ? e.message : String(e)
            throw new MarketplaceError('EBAD_RESPONSE', `Unexpected response shape from ${url}: ${detail}`, {
              platform,
              url,
              status: res.status,
              cause: e,
            })
          }
        }

        const detail = errorMessageFromBody(text)
        const suffix = detail ? `: ${detail}` : ''
        const init = { platform, url, status: res.status, retryable: RETRYABLE_STATUS.has(res.status) }
        if (res.status === 429) {
          const hinted =
            parseRetryAfter(res.headers.get('retry-after')) ??
            parseRetryAfter(res.headers.get('x-ratelimit-reset'))
          waitMs = hinted ?? this.backoff(rateDelays, attempt)
          if (this.limiter) {
            this.limiter.pauseFor(waitMs)
            waitMs = 0 // the limiter holds the next acquire
          }
          failure = new MarketplaceError('ERATE_LIMITED', `${platform} is rate-limiting requests${suffix}`, init)
        } else if (res.status === 404) {
          throw new MarketplaceError('ENOT_FOUND', `Not found: ${url}${suffix}`, init)
        } else if (res.status === 403 && platform === 'curseforge') {
          throw new MarketplaceError('ECF_FORBIDDEN', `CurseForge rejected the API key${suffix}`, init)
        } else {
          failure = new MarketplaceError('EHTTP', `HTTP ${res.status} from ${url}${suffix}`, init)
          if (!init.retryable) throw failure
          waitMs =
            res.status === 503
              ? (parseRetryAfter(res.headers.get('retry-after')) ?? this.backoff(retryDelays, attempt))
              : this.backoff(retryDelays, attempt)
        }
      } catch (e) {
        if (!(e instanceof MarketplaceError) || !e.retryable || !canRetry) throw e
        failure = e
        waitMs = this.backoff(retryDelays, attempt)
      } finally {
        clearTimeout(timer)
        release?.()
      }

      if (!canRetry) throw failure
      if (waitMs > 0) await sleep(waitMs, signal)
    }
    /* oxlint-enable no-await-in-loop */
  }
}
