/**
 * The manifest of Amethyst-built arm64 natives for LWJGL 2 era versions (Minecraft 1.12.2 and
 * older), published by this repository's CI on the `natives-lwjgl2-v1` GitHub release.
 *
 * `@amethyst/game` pins that release's artifacts and sha256s (`DEFAULT_LWJGL2_ARM64_SOURCE`), which
 * the runtime passes as the `fallback`: launches use the cached manifest, else the pinned one, at
 * once and offline, while the release manifest is revalidated in the background (at most daily)
 * and cached under `cache/natives/`. Without a fallback, the first use waits for the fetch and a
 * failure is `ENATIVES_UNAVAILABLE` with a clear message (never a crash). A manifest that lacks
 * the artifact a version needs also ends in `ENATIVES_UNAVAILABLE` (from the natives plan).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseLwjgl2Arm64Source, type Lwjgl2Arm64Source } from '@amethyst/game'
import { logger } from '../log'
import { AppError, errorMessage, isAbortError } from '../util/errors'

const log = logger('natives')

/** The GitHub release the LWJGL 2 arm64 natives are published on. */
export const LWJGL2_NATIVES_TAG = 'natives-lwjgl2-v1'

/** The release's manifest (a `Lwjgl2Arm64Source`: base URL plus artifacts with sha256 and size). */
export const LWJGL2_NATIVES_MANIFEST_URL = `https://github.com/wynn-dev/amethyst/releases/download/${LWJGL2_NATIVES_TAG}/manifest.json`

const MAX_AGE_MS = 24 * 3600_000
/** After a failed fetch, do not try again for this long (each launch would otherwise wait for it). */
const RETRY_AFTER_MS = 5 * 60_000

interface CacheFile {
  v: 1
  url: string
  fetchedAt: number
  source: Lwjgl2Arm64Source
}

export interface NativesSourceOptions {
  cacheDir: string
  fetchJson: (url: string, options: { signal?: AbortSignal }) => Promise<unknown>
  url?: string
  /** Used at once when there is no fresh cached manifest (the pinned release). */
  fallback?: Lwjgl2Arm64Source
  now?: () => number
}

export class Lwjgl2NativesSource {
  readonly #o: NativesSourceOptions
  readonly #url: string
  readonly #now: () => number
  #memory: CacheFile | undefined
  #failedAt = -Infinity
  #lastError = ''
  #inflight: Promise<Lwjgl2Arm64Source> | undefined

  constructor(options: NativesSourceOptions) {
    this.#o = options
    this.#url = options.url ?? LWJGL2_NATIVES_MANIFEST_URL
    this.#now = options.now ?? Date.now
  }

  get #file(): string {
    return path.join(this.#o.cacheDir, 'lwjgl2-arm64.json')
  }

  async #readCache(): Promise<CacheFile | undefined> {
    if (this.#memory) return this.#memory
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<CacheFile>
      if (raw.v !== 1 || raw.url !== this.#url || typeof raw.fetchedAt !== 'number') return undefined
      this.#memory = { v: 1, url: this.#url, fetchedAt: raw.fetchedAt, source: parseLwjgl2Arm64Source(raw.source) }
      return this.#memory
    } catch {
      return undefined
    }
  }

  async #writeCache(entry: CacheFile): Promise<void> {
    this.#memory = entry
    try {
      await mkdir(this.#o.cacheDir, { recursive: true })
      const tmp = `${this.#file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(entry))
      await rename(tmp, this.#file)
    } catch (e) {
      log.warn('cannot cache the LWJGL 2 natives manifest', e)
    }
  }

  /**
   * The manifest: cached (younger than a day) or fetched. A stale cache is used when the fetch
   * fails. Throws `ENATIVES_UNAVAILABLE` when there is nothing to use.
   */
  get(signal?: AbortSignal): Promise<Lwjgl2Arm64Source> {
    this.#inflight ??= this.#get(signal).finally(() => (this.#inflight = undefined))
    return this.#inflight
  }

  async #get(signal?: AbortSignal): Promise<Lwjgl2Arm64Source> {
    const cached = await this.#readCache()
    if (cached && this.#now() - cached.fetchedAt < MAX_AGE_MS) return cached.source
    const fallback = this.#o.fallback
    if (fallback) {
      // Never make a launch wait for GitHub: use what we have and revalidate in the background.
      if (this.#now() - this.#failedAt >= RETRY_AFTER_MS) void this.#fetch().catch(() => {})
      return cached?.source ?? fallback
    }
    if (this.#now() - this.#failedAt < RETRY_AFTER_MS) {
      if (cached) return cached.source
      throw this.#unavailable(this.#lastError)
    }
    try {
      return await this.#fetch(signal)
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e
      if (cached) return cached.source
      throw this.#unavailable(this.#lastError)
    }
  }

  async #fetch(signal?: AbortSignal): Promise<Lwjgl2Arm64Source> {
    try {
      const source = parseLwjgl2Arm64Source(await this.#o.fetchJson(this.#url, signal ? { signal } : {}))
      await this.#writeCache({ v: 1, url: this.#url, fetchedAt: this.#now(), source })
      return source
    } catch (e) {
      if (!(isAbortError(e) || signal?.aborted)) {
        this.#failedAt = this.#now()
        this.#lastError = errorMessage(e)
        log.warn(`cannot fetch the LWJGL 2 natives manifest (${this.#url}): ${this.#lastError}`)
      }
      throw e
    }
  }

  #unavailable(reason: string): AppError {
    return new AppError(
      'ENATIVES_UNAVAILABLE',
      'Apple Silicon natives for Minecraft 1.12.2 and older are not available right now, so this version cannot start. Check your connection and try again later.',
      { reason: 'manifest-unavailable', url: this.#url, cause: reason },
    )
  }
}
