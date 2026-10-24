/**
 * The modpack lock (`.amethyst/modpack.lock.json`, `modpacks.md` §6.1) records which files the
 * installed pack version owns, with their hashes and origins. Files the user adds later are
 * absent from it; that is how user content is told apart from pack content on update.
 */
import path from 'node:path'
import { ModpackError } from './errors'
import type { FileHashes, FileOrigin, ModpackFormat, ModpackLoader, ModpackUpstream } from './types'
import { readJsonFile, writeJsonAtomic } from './util'

/** Lock location relative to the instance root. */
export const LOCK_FILE = '.amethyst/modpack.lock.json'

/** One file owned by the pack. */
export interface ModpackLockFile {
  path: string
  /** Normally has `sha1`; also `sha512`, `md5` or `crc32` when the pack supplied them. */
  hashes: FileHashes
  size: number
  origin: FileOrigin
  /** Download URLs the pack gave for it (used by export to link instead of embed). */
  downloads?: string[]
  /** The pack lists the file as optional (and the user kept it). */
  optional?: boolean
  /** `world`: a folder extracted from a world zip; the hashes are those of the zip. */
  kind?: 'file' | 'world'
}

/** Contents of the lock file. */
export interface ModpackLock {
  schemaVersion: 1
  source: ModpackFormat
  upstream?: ModpackUpstream
  pack: { name: string; version: string; sha1: string; minecraft: string; loader: ModpackLoader | null }
  installedAt: number
  files: ModpackLockFile[]
  /** Optional files the user chose not to install. They stay deselected on update. */
  deselected: string[]
}

/** Absolute lock path of an instance. */
export function lockPath(instanceDir: string): string {
  return path.join(instanceDir, ...LOCK_FILE.split('/'))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate an untrusted lock value. Entries without a path or any hash are dropped.
 *
 * @throws {ModpackError} `EINVALID_ARGUMENT` when the value is not a schema-1 lock.
 */
export function parseModpackLock(value: unknown): ModpackLock {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.pack) || !Array.isArray(value.files)) {
    throw new ModpackError('EINVALID_ARGUMENT', 'The modpack lock file is not a schema 1 lock')
  }
  const files: ModpackLockFile[] = []
  for (const f of value.files as unknown[]) {
    if (!isRecord(f) || typeof f.path !== 'string' || !isRecord(f.hashes)) continue
    const hashes: FileHashes = {}
    for (const k of ['sha1', 'sha512', 'md5', 'crc32'] as const) {
      const h = f.hashes[k]
      if (typeof h === 'string' && /^[0-9a-f]+$/i.test(h)) hashes[k] = h.toLowerCase()
    }
    if (Object.keys(hashes).length === 0) continue
    files.push({
      path: f.path,
      hashes,
      size: typeof f.size === 'number' ? f.size : 0,
      origin: isRecord(f.origin) ? (f.origin as FileOrigin) : { kind: 'url' },
      downloads: Array.isArray(f.downloads) ? f.downloads.filter((u): u is string => typeof u === 'string' && u.startsWith('https://')) : undefined,
      optional: f.optional === true ? true : undefined,
      kind: f.kind === 'world' ? 'world' : undefined,
    })
  }
  const pack = value.pack
  return {
    schemaVersion: 1,
    source: value.source === 'curseforge' ? 'curseforge' : 'modrinth',
    upstream: isRecord(value.upstream) ? (value.upstream as ModpackUpstream) : undefined,
    pack: {
      name: String(pack.name ?? ''),
      version: String(pack.version ?? ''),
      sha1: String(pack.sha1 ?? ''),
      minecraft: String(pack.minecraft ?? ''),
      loader: isRecord(pack.loader) ? (pack.loader as unknown as ModpackLoader) : null,
    },
    installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0,
    files,
    deselected: Array.isArray(value.deselected) ? value.deselected.filter((p): p is string => typeof p === 'string') : [],
  }
}

/**
 * Read an instance's lock. Resolves undefined when there is none.
 *
 * @throws {ModpackError} `EINVALID_ARGUMENT` when the file exists but is corrupt. The file is
 * left untouched.
 */
export async function readModpackLock(instanceDir: string): Promise<ModpackLock | undefined> {
  let raw: unknown
  try {
    raw = await readJsonFile(lockPath(instanceDir))
  } catch (e) {
    throw new ModpackError('EINVALID_ARGUMENT', 'The modpack lock file is corrupt', { cause: e })
  }
  return raw === undefined ? undefined : parseModpackLock(raw)
}

/** Write an instance's lock atomically. */
export async function writeModpackLock(instanceDir: string, lock: ModpackLock): Promise<void> {
  await writeJsonAtomic(lockPath(instanceDir), lock)
}
