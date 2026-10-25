/**
 * The SQLite side of the index: opens (and if needed heals) the database and answers
 * {@link DbQueries}. Synchronous by nature (better-sqlite3), so it only ever runs inside the DB
 * worker thread; tests drive it directly.
 */
import { renameSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { DbQueries, QueryName, SourceRow, UpdateCheckRow } from './protocol'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

type Db = Database.Database
type Handler<K extends QueryName> = (args: DbQueries[K]['args']) => DbQueries[K]['result']
export type QueryHandlers = { [K in QueryName]: Handler<K> }

const CORRUPTION = /file is not a database|database disk image is malformed|no such table|unable to open database|SQLITE_CORRUPT|SQLITE_NOTADB/i

/** True for errors that mean the file is damaged or its schema is missing: the cache must be rebuilt. */
export function isCorruption(e: unknown): boolean {
  const code = (e as { code?: unknown }).code
  return (typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB' || code === 'SQLITE_CANTOPEN')) || CORRUPTION.test(String((e as Error)?.message ?? e))
}

function configure(db: Db): void {
  db.pragma('journal_mode = WAL')
  // The index is a rebuildable cache: NORMAL is durable enough under WAL and much faster.
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -16000')
  db.pragma('mmap_size = 67108864')
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > SCHEMA_VERSION) throw new Error(`index.sqlite has schema ${current}, newer than ${SCHEMA_VERSION}; no such table may exist`)
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  // Touch every table once, so a damaged file fails here rather than on the first real query.
  db.prepare('SELECT count(*) FROM placements').get()
}

export interface OpenResult {
  db: Db
  /** Files that were moved aside because they were corrupt. */
  healed: string[]
}

/**
 * Open the database in WAL mode and migrate it. A corrupt (or newer, or unopenable) file is
 * renamed to `<file>.<epoch>.bak` together with its `-wal`/`-shm` and a fresh one is created,
 * up to three times.
 */
export function openDatabase(file: string, options: { now?: () => number } = {}): OpenResult {
  const healed: string[] = []
  const now = options.now ?? Date.now
  for (let attempt = 0; ; attempt++) {
    let db: Db | undefined
    try {
      db = new Database(file)
      configure(db)
      migrate(db)
      return { db, healed }
    } catch (e) {
      try {
        db?.close()
      } catch {
        // ignore
      }
      if (file === ':memory:' || attempt >= 3 || !isCorruption(e)) throw e
      const moved = quarantineDatabase(file, `${now()}${attempt ? `-${attempt}` : ''}`)
      if (moved) healed.push(moved)
    }
  }
}

/** Rename `file` (and its `-wal`/`-shm`) to `<file>.<stamp>.bak`; returns the new main path, if it existed. */
export function quarantineDatabase(file: string, stamp: string): string | undefined {
  let moved: string | undefined
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      renameSync(`${file}${suffix}`, `${file}.${stamp}.bak${suffix}`)
      if (suffix === '') moved = `${file}.${stamp}.bak`
    } catch {
      // A missing -wal/-shm is fine.
    }
  }
  return moved
}

/** Platform id shapes. Attribution is validated before it is stored, so one corrupt id (a leaked path) cannot poison later batch requests. */
const SOURCE_IDS: Record<string, RegExp> = { modrinth: /^[0-9A-Za-z]{8}$/, curseforge: /^[1-9][0-9]{0,11}$/ }

/** True when a source row's project and version ids look like real ids of its platform. */
export function isValidSource(r: Pick<SourceRow, 'platform' | 'projectId' | 'versionId'>): boolean {
  const re = SOURCE_IDS[r.platform]
  return re !== undefined && typeof r.projectId === 'string' && typeof r.versionId === 'string' && re.test(r.projectId) && re.test(r.versionId)
}

const json = (v: unknown) => JSON.stringify(v)
const parse = (s: string): unknown => JSON.parse(s)

/** Prepare every statement once and return the query handlers. */
export function createQueryHandlers(db: Db): QueryHandlers {
  const s = {
    listDir: db.prepare<[string], { key: string; record: string }>('SELECT key, record FROM placements WHERE dir = ?'),
    upsertPlacement: db.prepare(
      `INSERT INTO placements (key, dir, ino, size, mtime_ms, parser_version, sha1, record, seen_at)
       VALUES (@key, @dir, @ino, @size, @mtimeMs, @parserVersion, @sha1, @record, @now)
       ON CONFLICT(key) DO UPDATE SET dir = excluded.dir, ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms,
         parser_version = excluded.parser_version, sha1 = excluded.sha1, record = excluded.record, seen_at = excluded.seen_at`,
    ),
    deletePlacement: db.prepare<[string]>('DELETE FROM placements WHERE key = ?'),
    deleteUnder: db.prepare<[string, number, string]>('DELETE FROM placements WHERE dir = ? OR substr(dir, 1, ?) = ?'),
    getFingerprint: db.prepare<[string], { murmur2: number }>('SELECT murmur2 FROM fingerprints WHERE sha1 = ?'),
    putFingerprint: db.prepare<[string, number]>('INSERT OR REPLACE INTO fingerprints (sha1, murmur2) VALUES (?, ?)'),
    getSources: db.prepare<[string], { sha1: string; platform: string; project_id: string; version_id: string; confidence: string; resolved_at: number }>(
      'SELECT * FROM sources WHERE sha1 = ?',
    ),
    putSource: db.prepare(
      `INSERT INTO sources (sha1, platform, project_id, version_id, confidence, resolved_at) VALUES (@sha1, @platform, @projectId, @versionId, @confidence, @resolvedAt)
       ON CONFLICT(sha1, platform) DO UPDATE SET project_id = excluded.project_id, version_id = excluded.version_id,
         confidence = excluded.confidence, resolved_at = excluded.resolved_at
       WHERE sources.confidence <> 'manifest' OR excluded.confidence <> 'hash'`,
    ),
    deleteLookup: db.prepare<[string, string]>('DELETE FROM lookups WHERE sha1 = ? AND platform = ?'),
    freshLookup: db.prepare<[string, string, number], { sha1: string }>('SELECT sha1 FROM lookups WHERE sha1 = ? AND platform = ? AND checked_at > ?'),
    putLookup: db.prepare<[string, string, number]>('INSERT OR REPLACE INTO lookups (sha1, platform, checked_at) VALUES (?, ?, ?)'),
    getUpdate: db.prepare<[string, string, string, number], { result: string | null; checked_at: number }>(
      'SELECT result, checked_at FROM update_checks WHERE sha1 = ? AND platform = ? AND filter = ? AND checked_at > ?',
    ),
    putUpdate: db.prepare<[string, string, string, string | null, number]>(
      'INSERT OR REPLACE INTO update_checks (sha1, platform, filter, result, checked_at) VALUES (?, ?, ?, ?, ?)',
    ),
    loadCache: db.prepare<[number, number], { key: string; value: string; expires_at: number }>(
      'SELECT key, value, expires_at FROM http_cache WHERE expires_at > ? ORDER BY expires_at DESC LIMIT ?',
    ),
    putCache: db.prepare<[string, string, number, number]>('INSERT OR REPLACE INTO http_cache (key, value, expires_at, size) VALUES (?, ?, ?, ?)'),
    deleteCache: db.prepare<[string]>('DELETE FROM http_cache WHERE key = ?'),
    pruneExpired: db.prepare<[number]>('DELETE FROM http_cache WHERE expires_at <= ?'),
    cacheBytes: db.prepare<[], { total: number | null }>('SELECT sum(size) AS total FROM http_cache'),
    cacheOldest: db.prepare<[number], { key: string; size: number }>('SELECT key, size FROM http_cache ORDER BY expires_at ASC LIMIT ?'),
    count: (table: string) => db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`),
  }
  const counts = { placements: s.count('placements'), sources: s.count('sources'), cache: s.count('http_cache') }

  const tx = <A extends unknown[], R>(fn: (...a: A) => R) => db.transaction(fn)

  const apply = tx((args: DbQueries['placements.apply']['args']) => {
    let upserted = 0
    let deleted = 0
    for (const [key, r] of args.upserts) {
      s.upsertPlacement.run({ key, dir: args.dir, ino: r.ino, size: r.size, mtimeMs: r.mtimeMs, parserVersion: r.parserVersion, sha1: r.sha1 ?? null, record: json(r.record), now: args.now })
      upserted++
    }
    for (const key of args.deletes) deleted += s.deletePlacement.run(key).changes
    return { upserted, deleted }
  })

  const putSources = tx((rows: SourceRow[]) => {
    for (const r of rows) {
      if (!isValidSource(r)) continue
      s.putSource.run(r)
      s.deleteLookup.run(r.sha1, r.platform)
    }
  })

  const putUpdates = tx((rows: UpdateCheckRow[]) => {
    for (const r of rows) s.putUpdate.run(r.sha1, r.platform, r.filter, r.result === null || r.result === undefined ? null : json(r.result), r.checkedAt)
  })

  const putCache = tx((entries: DbQueries['cache.put']['args']['entries']) => {
    for (const e of entries) {
      const text = json(e.value)
      s.putCache.run(e.key, text, e.expiresAt, text.length)
    }
  })

  return {
    'placements.listDir': ({ dir }) => s.listDir.all(dir).map((r) => [r.key, parse(r.record)] as [string, unknown]),
    'placements.apply': (args) => apply(args),
    'placements.deleteUnder': ({ prefix }) => {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`
      return { deleted: s.deleteUnder.run(prefix.replace(/\/$/, ''), p.length, p).changes }
    },
    'fingerprints.get': ({ sha1s }) =>
      sha1s.flatMap((h) => {
        const row = s.getFingerprint.get(h)
        return row ? [[h, row.murmur2] as [string, number]] : []
      }),
    'fingerprints.put': tx(({ entries }: { entries: [string, number][] }) => {
      for (const [h, n] of entries) s.putFingerprint.run(h, n)
      return null
    }),
    'sources.get': ({ sha1s }) =>
      sha1s.flatMap((h) =>
        s.getSources.all(h).map(
          (r): SourceRow => ({
            sha1: r.sha1,
            platform: r.platform as SourceRow['platform'],
            projectId: r.project_id,
            versionId: r.version_id,
            confidence: r.confidence as SourceRow['confidence'],
            resolvedAt: r.resolved_at,
          }),
        ),
      ),
    'sources.put': ({ rows }) => {
      putSources(rows)
      return null
    },
    'lookups.fresh': ({ sha1s, platform, since }) => sha1s.filter((h) => s.freshLookup.get(h, platform, since) !== undefined),
    'lookups.put': tx(({ sha1s, platform, now }: { sha1s: string[]; platform: string; now: number }) => {
      for (const h of sha1s) s.putLookup.run(h, platform, now)
      return null
    }),
    'updates.get': ({ keys, since }) =>
      keys.flatMap((k) => {
        const row = s.getUpdate.get(k.sha1, k.platform, k.filter, since)
        return row ? [{ ...k, result: row.result === null ? null : parse(row.result), checkedAt: row.checked_at }] : []
      }),
    'updates.put': ({ rows }) => {
      putUpdates(rows)
      return null
    },
    'cache.load': ({ now, limit }) => s.loadCache.all(now, limit).map((r) => ({ key: r.key, value: parse(r.value), expiresAt: r.expires_at })),
    'cache.put': ({ entries }) => {
      putCache(entries)
      return null
    },
    'cache.delete': tx(({ keys }: { keys: string[] }) => {
      for (const k of keys) s.deleteCache.run(k)
      return null
    }),
    'cache.prune': tx(({ now, maxBytes }: { now: number; maxBytes: number }) => {
      let deleted = s.pruneExpired.run(now).changes
      let total = s.cacheBytes.get()?.total ?? 0
      while (total > maxBytes) {
        const batch = s.cacheOldest.all(100)
        if (batch.length === 0) break
        for (const row of batch) {
          if (total <= maxBytes) break
          s.deleteCache.run(row.key)
          total -= row.size
          deleted++
        }
      }
      return { deleted }
    }),
    'meta.stats': () => ({
      placements: counts.placements.get()?.n ?? 0,
      sources: counts.sources.get()?.n ?? 0,
      cache: counts.cache.get()?.n ?? 0,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
    }),
  }
}
