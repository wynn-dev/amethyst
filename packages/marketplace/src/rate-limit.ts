/**
 * Client-side rate limiter: a token bucket plus a concurrency cap, served in FIFO order.
 *
 * Each request calls {@link RateLimiter.acquire} and gets a `release` function to call when the
 * response has been read. Tokens refill continuously (`capacity` per `windowMs`).
 *
 * The limiter also listens to the server: {@link RateLimiter.observe} reads Modrinth's
 * `X-Ratelimit-Remaining` / `X-Ratelimit-Reset` headers and holds new requests until the
 * window resets once fewer than `lowWatermark` requests remain, and
 * {@link RateLimiter.pauseFor} pauses every queued request after a 429.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window (default 250, headroom under Modrinth's 300/min). */
  capacity?: number
  /** Window length in ms (default 60 000). */
  windowMs?: number
  /** Maximum requests in flight (default 6). */
  maxConcurrent?: number
  /** Pause until reset when the server reports fewer remaining requests than this (default 10). */
  lowWatermark?: number
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  cleanup: () => void
}

export class RateLimiter {
  readonly capacity: number
  readonly windowMs: number
  readonly maxConcurrent: number
  readonly lowWatermark: number
  private readonly now: () => number
  private tokens: number
  private refilledAt: number
  private pausedUntil = 0
  private active = 0
  private readonly queue: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 250)
    this.windowMs = Math.max(1, options.windowMs ?? 60_000)
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 6)
    this.lowWatermark = Math.max(0, options.lowWatermark ?? 10)
    this.now = options.now ?? Date.now
    this.tokens = this.capacity
    this.refilledAt = this.now()
  }

  /** Requests currently holding a slot. */
  get inFlight(): number {
    return this.active
  }

  /** Requests waiting for a slot or token. */
  get pending(): number {
    return this.queue.length
  }

  /** Milliseconds until requests are allowed again after a pause, or 0. */
  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.now())
  }

  /** Wait for a token and a concurrency slot. Resolves with a one-shot `release`. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        reject(signal?.reason)
        this.pump()
      }
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.pump()
    })
  }

  /** Hold every request (queued and future) for at least `ms`. */
  pauseFor(ms: number): void {
    if (!(ms > 0)) return
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms)
    this.pump()
  }

  /** Update the bucket from `X-Ratelimit-*` response headers. Missing headers are ignored. */
  observe(headers: Headers): void {
    const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') ?? '', 10)
    const reset = Number.parseFloat(headers.get('x-ratelimit-reset') ?? '')
    if (!Number.isFinite(remaining)) return
    this.refill()
    this.tokens = Math.min(this.tokens, Math.max(0, remaining))
    if (remaining < this.lowWatermark && Number.isFinite(reset) && reset > 0) this.pauseFor(reset * 1000)
  }

  private refill(): void {
    const now = this.now()
    const elapsed = now - this.refilledAt
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs)
      this.refilledAt = now
    }
  }

  private waitMs(): number {
    this.refill()
    const paused = this.pausedUntil - this.now()
    const forToken = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * this.windowMs) / this.capacity)
    return Math.max(0, paused, forToken)
  }

  private pump(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.queue.length > 0) {
      if (this.active >= this.maxConcurrent) return // a release will pump again
      const wait = this.waitMs()
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.pump()
        }, wait)
        return
      }
      const waiter = this.queue.shift()
      if (!waiter) return
      waiter.cleanup()
      this.tokens -= 1
      this.active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        this.pump()
      })
    }
  }
}
