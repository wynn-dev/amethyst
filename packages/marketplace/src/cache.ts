/**
 * A small TTL + LRU cache for parsed GET responses.
 *
 * The clients depend only on the {@link MarketCache} interface, so the main process can swap
 * in a persistent (SQLite) implementation later. {@link MemoryCache} is the default: a `Map`
 * kept in recency order, evicting the least recently used entry once `maxEntries` is reached
 * and dropping entries lazily when their TTL has passed.
 *
 * Cached values are shared between callers. Treat everything returned by the clients as
 * read-only.
 */

export interface MarketCache {
  /** Returns the value, or `undefined` when absent or expired. Counts as a use for LRU. */
  get(key: string): unknown
  set(key: string, value: unknown, ttlMs: number): void
  delete(key: string): void
  clear(): void
}

export interface MemoryCacheOptions {
  /** Maximum number of entries before LRU eviction (default 500). */
  maxEntries?: number
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number
}

interface Entry {
  value: unknown
  expiresAt: number
}

export class MemoryCache implements MarketCache {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 500)
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): unknown {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (!(ttlMs > 0)) return
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Freshness windows from the marketplace spec (§6.2). */
export const CACHE_TTL = {
  tags: 24 * HOUR,
  search: 5 * MINUTE,
  project: HOUR,
  versionList: 10 * MINUTE,
  version: 24 * HOUR,
  changelog: 24 * HOUR,
} as const
