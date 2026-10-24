/**
 * Schema of `index.sqlite`, the resource index. It is a rebuildable cache: losing it costs a
 * re-scan and some marketplace lookups, never user data. `MIGRATIONS[n]` upgrades
 * `PRAGMA user_version` from `n` to `n + 1`.
 */
export const MIGRATIONS: readonly string[] = [
  // 0 → 1
  `
  -- One row per scanned file or pack folder: the @amethyst/content scan-cache record.
  CREATE TABLE placements (
    key TEXT PRIMARY KEY,          -- pathKey(absolute path): NFC + lower case, as APFS compares
    dir TEXT NOT NULL,             -- pathKey(parent folder)
    ino INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    parser_version INTEGER NOT NULL,
    sha1 TEXT,                     -- NULL for folders and unreadable files
    record TEXT NOT NULL,          -- JSON ScanCacheRecord (hashes, parsed metadata, problem)
    seen_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX placements_dir ON placements(dir);
  CREATE INDEX placements_sha1 ON placements(sha1) WHERE sha1 IS NOT NULL;

  -- CurseForge murmur2 fingerprints by content hash (expensive to compute, never change).
  CREATE TABLE fingerprints (
    sha1 TEXT PRIMARY KEY,
    murmur2 INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Marketplace attribution by content hash.
  CREATE TABLE sources (
    sha1 TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('modrinth', 'curseforge')),
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('hash', 'manifest', 'manual')),
    resolved_at INTEGER NOT NULL,
    PRIMARY KEY (sha1, platform)
  ) WITHOUT ROWID;

  -- Negative cache: hashes a platform did not know, so they are not re-queried on every open.
  CREATE TABLE lookups (
    sha1 TEXT NOT NULL,
    platform TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (sha1, platform)
  ) WITHOUT ROWID;

  -- Update-check results per (file, platform, loader/game-version filter).
  CREATE TABLE update_checks (
    sha1 TEXT NOT NULL,
    platform TEXT NOT NULL,
    filter TEXT NOT NULL,
    result TEXT,                   -- JSON of the newest version, NULL when up to date / unknown
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (sha1, platform, filter)
  ) WITHOUT ROWID;

  -- Persistent marketplace response cache (backs the in-memory LRU).
  CREATE TABLE http_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    size INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX http_cache_expires ON http_cache(expires_at);
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length
