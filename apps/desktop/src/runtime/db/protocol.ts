/**
 * The typed query protocol between the runtime and the SQLite worker. The runtime never sends
 * SQL: it names a query from {@link DbQueries} and passes plain arguments; the worker runs a
 * prepared statement (writes inside one transaction per message) and answers.
 */

export type Platform = 'modrinth' | 'curseforge'

/** Marketplace attribution of a content hash. */
export interface SourceRow {
  sha1: string
  platform: Platform
  projectId: string
  versionId: string
  confidence: 'hash' | 'manifest' | 'manual'
  resolvedAt: number
}

/** A cached update-check answer. `result` is `null` when the file is up to date or unknown. */
export interface UpdateCheckRow {
  sha1: string
  platform: Platform
  filter: string
  result: unknown
  checkedAt: number
}

/** Every query: its arguments and its result. */
export interface DbQueries {
  /** Scan-cache records (`[key, record]`) of every entry directly inside `dir` (a pathKey). */
  'placements.listDir': { args: { dir: string }; result: [string, unknown][] }
  /** Upsert and delete scan-cache records of one folder in one transaction. */
  'placements.apply': {
    args: { dir: string; upserts: [string, { ino: number; size: number; mtimeMs: number; parserVersion: number; sha1?: string; record: unknown }][]; deletes: string[]; now: number }
    result: { upserted: number; deleted: number }
  }
  /** Forget every record under a folder (an instance was deleted). `prefix` is a pathKey. */
  'placements.deleteUnder': { args: { prefix: string }; result: { deleted: number } }
  'fingerprints.get': { args: { sha1s: string[] }; result: [string, number][] }
  'fingerprints.put': { args: { entries: [string, number][] }; result: null }
  'sources.get': { args: { sha1s: string[] }; result: SourceRow[] }
  'sources.put': { args: { rows: SourceRow[] }; result: null }
  /** The hashes among `sha1s` with a negative lookup newer than `since`. */
  'lookups.fresh': { args: { sha1s: string[]; platform: Platform; since: number }; result: string[] }
  'lookups.put': { args: { sha1s: string[]; platform: Platform; now: number }; result: null }
  /** Cached update checks newer than `since`. */
  'updates.get': { args: { keys: { sha1: string; platform: Platform; filter: string }[]; since: number }; result: UpdateCheckRow[] }
  'updates.put': { args: { rows: UpdateCheckRow[] }; result: null }
  /** Non-expired cache entries (most recent first, at most `limit`). */
  'cache.load': { args: { now: number; limit: number }; result: { key: string; value: unknown; expiresAt: number }[] }
  'cache.put': { args: { entries: { key: string; value: unknown; expiresAt: number }[] }; result: null }
  'cache.delete': { args: { keys: string[] }; result: null }
  /** Drop expired entries, then the soonest-expiring ones until at most `maxBytes` remain. */
  'cache.prune': { args: { now: number; maxBytes: number }; result: { deleted: number } }
  'meta.stats': { args: Record<string, never>; result: { placements: number; sources: number; cache: number; schemaVersion: number } }
}

export type QueryName = keyof DbQueries
export type QueryArgs<K extends QueryName> = DbQueries[K]['args']
export type QueryResult<K extends QueryName> = DbQueries[K]['result']

/** Runtime → worker. */
export type DbRequest = { t: 'query'; id: number; q: QueryName; args: unknown } | { t: 'close'; id: number }

/** Worker → runtime. */
export type DbResponse =
  | { t: 'ready'; schemaVersion: number; healed: string[]; openMs: number }
  | { t: 'fatal'; error: { name: string; message: string; code?: string } }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: { name: string; message: string; code?: string } }

/** Passed to the worker as `workerData`. */
export interface DbWorkerData {
  file: string
}
