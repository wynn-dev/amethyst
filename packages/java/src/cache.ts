import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JavaRecord } from './types'

/** On-disk shape of a {@link ProbeCache}. */
export interface ProbeCacheFile {
  version: 1
  records: JavaRecord[]
}

export interface ProbeCacheOptions {
  /** Re-probe records older than this even when the binary is unchanged (default 30 days). */
  maxAgeMs?: number
}

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000

/**
 * Probe results keyed by `(realPath, mtimeMs, size)` of the `bin/java` binary, so a rescan only
 * costs one `stat` per candidate. A record is reused only while all three match and it is younger
 * than `maxAgeMs`. Failed probes are cached too (except timeouts, which may be transient), so a
 * broken JVM is not re-spawned on every scan.
 *
 * The cache holds plain records and is safe to persist with {@link ProbeCache.save}.
 */
export class ProbeCache {
  private readonly entries = new Map<string, JavaRecord>()
  private readonly maxAgeMs: number
  /** Lookups answered from the cache / not, since creation. */
  hits = 0
  misses = 0

  constructor(records: Iterable<JavaRecord> = [], options: ProbeCacheOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE
    for (const r of records) this.entries.set(r.realPath, r)
  }

  /** The cached record for this exact binary, or `undefined` when it changed or is stale. */
  get(realPath: string, mtimeMs: number, size: number, now = Date.now()): JavaRecord | undefined {
    const r = this.entries.get(realPath)
    if (r && r.mtimeMs === mtimeMs && r.size === size && now - r.probedAt < this.maxAgeMs) {
      this.hits++
      return r
    }
    this.misses++
    return undefined
  }

  set(record: JavaRecord): void {
    if (record.invalidReason === 'timeout') return
    this.entries.set(record.realPath, record)
  }

  delete(realPath: string): void {
    this.entries.delete(realPath)
  }

  get size(): number {
    return this.entries.size
  }

  records(): JavaRecord[] {
    return [...this.entries.values()]
  }

  toJSON(): ProbeCacheFile {
    return { version: 1, records: this.records() }
  }

  /** Rebuild from {@link toJSON} output. Malformed entries are dropped. */
  static fromJSON(data: unknown, options?: ProbeCacheOptions): ProbeCache {
    const records: JavaRecord[] = []
    if (data && typeof data === 'object' && (data as ProbeCacheFile).version === 1 && Array.isArray((data as ProbeCacheFile).records)) {
      for (const r of (data as ProbeCacheFile).records) if (isRecord(r)) records.push(r)
    }
    return new ProbeCache(records, options)
  }

  /** Load from a JSON file. A missing or corrupt file yields an empty cache. */
  static async load(file: string, options?: ProbeCacheOptions): Promise<ProbeCache> {
    try {
      return ProbeCache.fromJSON(JSON.parse(await readFile(file, 'utf8')), options)
    } catch {
      return new ProbeCache([], options)
    }
  }

  /** Write atomically (temp file + rename). */
  async save(file: string): Promise<void> {
    await writeJsonAtomic(file, this.toJSON())
  }
}

function isRecord(r: unknown): r is JavaRecord {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.path === 'string' &&
    typeof o.realPath === 'string' &&
    typeof o.javaHome === 'string' &&
    typeof o.version === 'string' &&
    typeof o.majorVersion === 'number' &&
    (o.arch === 'arm64' || o.arch === 'x64' || o.arch === 'unknown') &&
    typeof o.mtimeMs === 'number' &&
    typeof o.size === 'number' &&
    typeof o.probedAt === 'number' &&
    typeof o.valid === 'boolean' &&
    typeof o.verified === 'boolean'
  )
}

/** Write JSON to `file` through a temp sibling and rename, so readers never see a partial file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
