import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDefaultHttpClient, HttpError, type HttpClient, sanitizeUrl } from '@amethyst/net'
import { InstallError } from '../errors'
import { writeJsonAtomic } from '../fs-util'

/** Options for {@link MetadataCache}. */
export interface MetadataCacheOptions {
  /** Directory for persisted lists (`<dir>/<name>.json`). Without it, caching is in-memory only. */
  cacheDir?: string
  /** How long a cached list is used without revalidating (default 10 minutes). */
  maxAgeMs?: number
  http?: HttpClient
  /** Clock override for tests. */
  now?: () => number
}

/** Per-request options of {@link MetadataCache.get}. */
export interface CacheGetOptions {
  /** Revalidate now even if the cached copy is fresh. */
  force?: boolean
  signal?: AbortSignal
  /** Treat the response as JSON (default) or plain text (XML). */
  format?: 'json' | 'text'
  /** Max response size (default 32 MiB). */
  maxBytes?: number
}

/** Where a cached value came from. */
export interface CacheResult<T> {
  data: T
  /** When the data was last confirmed by the server (ms since epoch). */
  fetchedAt: number
  /** True when a refresh failed and an older copy was returned instead. */
  stale: boolean
}

interface Entry {
  v: 1
  url: string
  etag?: string
  lastModified?: string
  fetchedAt: number
  data: unknown
}

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/**
 * A small conditional-request cache for remote version lists.
 *
 * A cached list younger than `maxAgeMs` is returned directly. Older (or forced) lists are
 * revalidated with `If-None-Match`/`If-Modified-Since`: a `304` keeps the cached copy, a `200`
 * replaces it once the new data passes `parse`. A response that fails validation never overwrites a
 * good cache, and when the server cannot be reached the stale copy is returned (`stale: true`).
 * Persisted entries are re-validated with `parse` when loaded, so a corrupted cache file is ignored.
 */
export class MetadataCache {
  readonly #memory = new Map<string, Entry>()
  readonly #inflight = new Map<string, Promise<CacheResult<unknown>>>()
  readonly #options: MetadataCacheOptions

  constructor(options: MetadataCacheOptions = {}) {
    this.#options = options
  }

  get http(): HttpClient {
    return this.#options.http ?? getDefaultHttpClient()
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  async #load<T>(name: string, url: string, parse: (raw: unknown) => T): Promise<Entry | undefined> {
    const mem = this.#memory.get(name)
    if (mem && mem.url === url) return mem
    if (!this.#options.cacheDir) return undefined
    try {
      const entry = JSON.parse(await readFile(join(this.#options.cacheDir, `${name}.json`), 'utf8')) as Entry
      if (entry?.v !== 1 || entry.url !== url || typeof entry.fetchedAt !== 'number') return undefined
      entry.data = parse(entry.data)
      this.#memory.set(name, entry)
      return entry
    } catch {
      return undefined
    }
  }

  async #store(name: string, entry: Entry): Promise<void> {
    this.#memory.set(name, entry)
    if (this.#options.cacheDir) await writeJsonAtomic(join(this.#options.cacheDir, `${name}.json`), entry).catch(() => {})
  }

  /**
   * Get the list `name` from `url`. `parse` receives the decoded JSON (or text) and must return
   * JSON-serialisable data or throw; what it returns is what gets cached.
   */
  get<T>(name: string, url: string, parse: (raw: unknown) => T, options: CacheGetOptions = {}): Promise<CacheResult<T>> {
    const key = `${name}\0${options.force ? 'force' : ''}`
    let p = this.#inflight.get(key)
    if (!p) {
      p = this.#get(name, url, parse, options).finally(() => this.#inflight.delete(key))
      this.#inflight.set(key, p)
    }
    return p as Promise<CacheResult<T>>
  }

  async #get<T>(name: string, url: string, parse: (raw: unknown) => T, options: CacheGetOptions): Promise<CacheResult<T>> {
    const cached = await this.#load(name, url, parse)
    const maxAge = this.#options.maxAgeMs ?? 10 * 60_000
    if (cached && !options.force && this.#now() - cached.fetchedAt < maxAge) {
      return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: false }
    }
    const headers: Record<string, string> = {}
    if (cached?.etag) headers['if-none-match'] = cached.etag
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified
    if (options.format !== 'text') headers.accept = 'application/json'
    try {
      const res = await this.http.request(url, { headers, signal: options.signal })
      const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > maxBytes) {
          res.body.on('error', () => {})
          res.body.destroy()
          throw new Error(`${url} exceeds ${maxBytes} bytes`)
        }
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      const data = parse(options.format === 'text' ? text : JSON.parse(text))
      const entry: Entry = { v: 1, url, fetchedAt: this.#now(), data }
      const etag = header(res.headers.etag)
      const lastModified = header(res.headers['last-modified'])
      if (etag) entry.etag = etag
      if (lastModified) entry.lastModified = lastModified
      await this.#store(name, entry)
      return { data, fetchedAt: entry.fetchedAt, stale: false }
    } catch (e) {
      if (cached && e instanceof HttpError && e.status === 304) {
        cached.fetchedAt = this.#now()
        await this.#store(name, cached)
        return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: false }
      }
      if (options.signal?.aborted) throw e
      if (cached) return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: true }
      if (e instanceof SyntaxError) throw new InstallError('EINSTALL_BAD_METADATA', `invalid JSON from ${sanitizeUrl(url)}`, { cause: e, url: sanitizeUrl(url) })
      throw e
    }
  }
}
