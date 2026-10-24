/**
 * The marketplace clients' GET cache: an in-memory LRU (synchronous, as the clients expect)
 * written through to the SQLite index in batches, and warmed from it on start, so tags, project
 * pages and version lists survive restarts and work offline within their TTLs.
 */
import { MemoryCache, type MarketCache } from '@amethyst/marketplace'
import type { DbClient } from '../db/client'
import { logger } from '../log'

const log = logger('market-cache')
const FLUSH_MS = 1000
const MAX_DB_BYTES = 64 * 1024 * 1024

export class PersistentMarketCache implements MarketCache {
  readonly #memory: MemoryCache
  readonly #db: Pick<DbClient, 'query'> | undefined
  readonly #now: () => number
  #pending = new Map<string, { value: unknown; expiresAt: number }>()
  #deleted = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(db: Pick<DbClient, 'query'> | undefined, options: { maxEntries?: number; now?: () => number } = {}) {
    this.#db = db
    this.#now = options.now ?? Date.now
    this.#memory = new MemoryCache({ maxEntries: options.maxEntries ?? 500, now: this.#now })
  }

  /** Load recent, unexpired entries from the index (call once, lazily). */
  async warm(limit = 300): Promise<number> {
    if (!this.#db) return 0
    try {
      const now = this.#now()
      const rows = await this.#db.query('cache.load', { now, limit })
      for (const r of rows.toReversed()) this.#memory.set(r.key, r.value, r.expiresAt - now)
      void this.#db.query('cache.prune', { now, maxBytes: MAX_DB_BYTES }).catch(() => undefined)
      return rows.length
    } catch (e) {
      log.warn('cannot warm the marketplace cache', e)
      return 0
    }
  }

  get(key: string): unknown {
    return this.#memory.get(key)
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (!(ttlMs > 0)) return
    this.#memory.set(key, value, ttlMs)
    this.#deleted.delete(key)
    this.#pending.set(key, { value, expiresAt: this.#now() + ttlMs })
    this.#schedule()
  }

  delete(key: string): void {
    this.#memory.delete(key)
    this.#pending.delete(key)
    this.#deleted.add(key)
    this.#schedule()
  }

  clear(): void {
    this.#memory.clear()
    this.#pending.clear()
  }

  #schedule(): void {
    if (this.#timer || !this.#db) return
    this.#timer = setTimeout(() => void this.flush(), FLUSH_MS)
    this.#timer.unref?.()
  }

  /** Write queued entries to the index in one transaction. */
  async flush(): Promise<void> {
    this.#timer = undefined
    if (!this.#db) return
    const entries = [...this.#pending].map(([key, e]) => ({ key, value: e.value, expiresAt: e.expiresAt }))
    const deleted = [...this.#deleted]
    this.#pending = new Map()
    this.#deleted = new Set()
    try {
      if (entries.length > 0) await this.#db.query('cache.put', { entries })
      if (deleted.length > 0) await this.#db.query('cache.delete', { keys: deleted })
    } catch (e) {
      log.warn('cannot persist the marketplace cache', e)
    }
  }
}
