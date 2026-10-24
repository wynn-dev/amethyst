/* oxlint-disable no-await-in-loop -- rename retries are sequential by nature */
/**
 * Content folder scanning with an injectable snapshot cache, plus `.disabled` toggling for mods.
 */
import { link, lstat, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { classifyError, ContentError, isAbortError, throwIfAborted, type FileProblem } from './errors'
import { hashFile, type HashAlgorithm } from './hash'
import { readModMetadata, withPreferredLoader, type ReadModOptions } from './mods/read'
import type { InstanceLoader, ModMetadata } from './mods/types'
import { resourcePackId } from './options'
import { pathKey, splitExtension } from './paths'
import { readResourcePack, type ResourcePackInfo } from './packs/resourcepack'
import { readShaderPack, type ShaderPackInfo } from './packs/shaderpack'

/** Content folders that can be scanned. */
export type ContentKind = 'mods' | 'resourcepacks' | 'shaderpacks'

/**
 * Version of the parsers' output. Bump it whenever parsing changes so cached results (and
 * cached parse errors) are recomputed.
 */
export const PARSER_VERSION = 1

/** One listed file or folder. Plain data: safe to structured-clone across threads. */
export interface ContentEntry {
  /** Absolute path. */
  path: string
  /** File name as on disk (including any `.disabled`). */
  fileName: string
  /** File name without the `.disabled` suffix. */
  baseName: string
  kind: ContentKind
  isDirectory: boolean
  /**
   * Mods: false when the name ends with `.disabled`. Packs: whether the pack is active
   * according to `enabledPacks` / `activeShaderPack`, or `undefined` when those were not given.
   */
  enabled: boolean | undefined
  size: number
  mtimeMs: number
  ino: number
  /** Digests of the file (absent for folders, which are not content-hashed). */
  hashes?: Partial<Record<HashAlgorithm, string>>
  mod?: ModMetadata
  resourcePack?: ResourcePackInfo
  shaderPack?: ShaderPackInfo
  /** Resource packs: the `options.txt` id (`file/<name on disk>`). */
  packId?: string
  /** Set when the file could not be read (corrupt zip, permission denied, ...). */
  problem?: FileProblem
  /** True when hashes and metadata came from the cache without touching the file's contents. */
  cached: boolean
}

/** What the cache remembers about one path. Plain data. */
export interface ScanCacheRecord {
  size: number
  mtimeMs: number
  ino: number
  parserVersion: number
  hashes?: Partial<Record<HashAlgorithm, string>>
  mod?: ModMetadata
  resourcePack?: ResourcePackInfo
  shaderPack?: ShaderPackInfo
  problem?: FileProblem
}

type MaybePromise<T> = T | Promise<T>

/**
 * Snapshot cache used by {@link scanContentFolder}. Keys come from {@link scanCacheKey}. A
 * record is reused only when size, mtime, inode and parser version all match the file.
 * The app backs this with its SQLite index; {@link createMemoryScanCache} is an in-memory one.
 */
export interface ScanCache {
  get(key: string): MaybePromise<ScanCacheRecord | undefined>
  set(key: string, record: ScanCacheRecord): MaybePromise<void>
  delete?(key: string): MaybePromise<void>
  /**
   * Optional lookup by inode, so a renamed file (`x.jar` → `x.jar.disabled`, which keeps its
   * inode) is not re-hashed. The record must still match size, mtime and parser version.
   */
  getByInode?(ino: number): MaybePromise<ScanCacheRecord | undefined>
}

/** A Map-backed {@link ScanCache} whose records can be exported and re-imported. */
export interface MemoryScanCache extends ScanCache {
  readonly size: number
  entries(): [string, ScanCacheRecord][]
  clear(): void
}

/** Cache key for a path: case- and normalisation-insensitive, as on APFS. */
export function scanCacheKey(filePath: string): string {
  return pathKey(path.resolve(filePath))
}

/** Create an in-memory {@link ScanCache}, optionally seeded with exported records. */
export function createMemoryScanCache(initial?: Iterable<readonly [string, ScanCacheRecord]>): MemoryScanCache {
  const map = new Map<string, ScanCacheRecord>()
  const byInode = new Map<number, string>()
  const set = (key: string, record: ScanCacheRecord) => {
    map.set(key, record)
    byInode.set(record.ino, key)
  }
  for (const [key, record] of initial ?? []) set(key, record)
  return {
    get: (key) => map.get(key),
    set,
    delete: (key) => {
      const record = map.get(key)
      map.delete(key)
      if (record && byInode.get(record.ino) === key) byInode.delete(record.ino)
    },
    getByInode: (ino) => {
      const key = byInode.get(ino)
      return key === undefined ? undefined : map.get(key)
    },
    get size() {
      return map.size
    },
    entries: () => [...map.entries()],
    clear: () => {
      map.clear()
      byInode.clear()
    },
  }
}

/** Injectable readers, so tests (and alternative backends) can observe or replace parsing. */
export interface ScanReaders {
  mod: (file: string, options: ReadModOptions) => Promise<ModMetadata>
  resourcePack: (file: string, options: { signal?: AbortSignal }) => Promise<ResourcePackInfo>
  shaderPack: (file: string, options: { signal?: AbortSignal }) => Promise<ShaderPackInfo>
  hash: (file: string, algorithms: readonly HashAlgorithm[], options: { signal?: AbortSignal }) => Promise<Partial<Record<HashAlgorithm, string>> & { size: number }>
}

/** Options for {@link scanContentFolder}. */
export interface ScanOptions {
  cache?: ScanCache
  /** Digests to compute for files (default `['sha1']`). Folders are never hashed. */
  hashes?: readonly HashAlgorithm[]
  /** Files hashed and parsed at the same time (default 8). */
  concurrency?: number
  /** Instance loader deciding which metadata fills a mod's top-level fields. */
  preferLoader?: InstanceLoader
  /** Resource packs: the `resourcePacks` list from `options.txt`, to fill `enabled`. */
  enabledPacks?: readonly string[]
  /** Shader packs: the active pack's file name (`shaderPack=` value), to fill `enabled`. */
  activeShaderPack?: string | null
  signal?: AbortSignal
  /** Progress in entries processed. */
  ctx?: TaskContext
  readers?: Partial<ScanReaders>
}

/** Counters describing how much work a scan did. */
export interface ScanStats {
  /** Entries listed. */
  total: number
  /** Entries served entirely from the cache. */
  cached: number
  /** Entries whose metadata was parsed. */
  parsed: number
  /** Files that were hashed. */
  hashed: number
  /** Entries with a `problem`. */
  failed: number
}

/** Result of {@link scanContentFolder}. */
export interface ScanResult {
  dir: string
  kind: ContentKind
  /** Entries sorted by file name. */
  entries: ContentEntry[]
  stats: ScanStats
}

const DISABLED = '.disabled'
const IGNORED_SUFFIXES = ['.part', '.pending', '.tmp', '.backup', '.rartemp', '.txt']
const IGNORED_NAMES = new Set(['.ds_store', '.gitkeep', '.gitignore', 'thumbs.db'])
const EXTENSIONS: Record<ContentKind, readonly string[]> = {
  mods: ['.jar', '.zip', '.litemod'],
  resourcepacks: ['.zip'],
  shaderpacks: ['.zip'],
}

/** Strip exactly one `.disabled` suffix. */
export function stripDisabled(fileName: string): string {
  return fileName.toLowerCase().endsWith(DISABLED) ? fileName.slice(0, -DISABLED.length) : fileName
}

/**
 * Whether a directory entry belongs in a content folder listing: hidden files, temporary or
 * partial downloads, notes and files with other extensions (mods leave `.toml`, `.json` and
 * `.cfg` files around) are ignored. Folders count only for resource and shader packs.
 */
export function isContentFileName(fileName: string, kind: ContentKind, isDirectory: boolean): boolean {
  const lower = fileName.toLowerCase()
  if (lower.startsWith('.') || IGNORED_NAMES.has(lower)) return false
  if (IGNORED_SUFFIXES.some((s) => lower.endsWith(s))) return false
  if (isDirectory) return kind !== 'mods'
  const base = kind === 'mods' ? stripDisabled(lower) : lower
  return EXTENSIONS[kind].some((ext) => base.endsWith(ext) && base.length > ext.length)
}

const defaultReaders: ScanReaders = {
  mod: readModMetadata,
  resourcePack: readResourcePack,
  shaderPack: readShaderPack,
  hash: (file, algorithms, options) => hashFile(file, algorithms, options),
}

interface Listed {
  fileName: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  ino: number
}

async function listFolder(dir: string, kind: ContentKind, signal: AbortSignal | undefined): Promise<Listed[]> {
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: Listed[] = []
  await mapLimit(
    dirents,
    16,
    async (d) => {
      const p = path.join(dir, d.name)
      // Follow symlinks (shared pools); entries that vanish or cannot be stat'ed are skipped.
      const st = await stat(p).catch(() => undefined)
      if (!st || !(st.isFile() || st.isDirectory())) return
      if (!isContentFileName(d.name, kind, st.isDirectory())) return
      out.push({ fileName: d.name, path: p, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino })
    },
    signal,
  )
  return out.toSorted((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
}

const sameSnapshot = (r: ScanCacheRecord, l: Listed) => r.size === l.size && r.mtimeMs === l.mtimeMs && r.ino === l.ino && r.parserVersion === PARSER_VERSION

/**
 * List a content folder (`mods`, `resourcepacks` or `shaderpacks`) with metadata, hashes and
 * enabled state. Unchanged entries (same size, mtime, inode and parser version in `cache`)
 * are returned from the cache without opening the file; only new or changed files are hashed
 * and parsed, with bounded concurrency. Unreadable files are listed with a `problem` (and
 * that result is cached too, so broken files are not re-read every time). A missing folder
 * yields an empty list.
 *
 * Hashing and unzipping stream; the function holds no global state and is safe to run inside
 * a `worker_threads` worker (see `createScanWorkerHandlers`).
 */
export async function scanContentFolder(dir: string, kind: ContentKind, options: ScanOptions = {}): Promise<ScanResult> {
  const signals = [options.signal, options.ctx?.signal].filter((s): s is AbortSignal => s !== undefined)
  const signal = signals.length <= 1 ? signals[0] : AbortSignal.any(signals)
  throwIfAborted(signal)
  const readers = { ...defaultReaders, ...options.readers }
  const algorithms: HashAlgorithm[] = [...new Set<HashAlgorithm>(options.hashes ?? ['sha1'])]
  const stats: ScanStats = { total: 0, cached: 0, parsed: 0, hashed: 0, failed: 0 }
  const listed = await listFolder(dir, kind, signal)
  stats.total = listed.length
  options.ctx?.update(0, listed.length)
  const enabledPacks = options.enabledPacks ? new Set(options.enabledPacks) : undefined

  const entries = await mapLimit(
    listed,
    Math.max(1, options.concurrency ?? 8),
    async (item): Promise<ContentEntry> => {
      const key = scanCacheKey(item.path)
      const previous = await options.cache?.get(key)
      let valid = previous !== undefined && sameSnapshot(previous, item) ? previous : undefined
      if (!valid && options.cache?.getByInode && !item.isDirectory) {
        const moved = await options.cache.getByInode(item.ino)
        if (moved && sameSnapshot(moved, item)) valid = moved
      }
      const record: ScanCacheRecord = valid ? { ...valid } : { size: item.size, mtimeMs: item.mtimeMs, ino: item.ino, parserVersion: PARSER_VERSION }
      // Renamed files found by inode must be re-recorded under their new path.
      let dirty = valid !== undefined && valid !== previous

      const needsHash = !item.isDirectory && !record.problem && algorithms.some((a) => record.hashes?.[a] === undefined)
      const needsParse = !valid
      const readContents = needsHash || needsParse
      if (readContents) {
        dirty = true
        try {
          if (needsHash) {
            const result = await readers.hash(item.path, algorithms, { signal })
            const digests: Partial<Record<HashAlgorithm, string>> = { ...record.hashes }
            for (const a of algorithms) if (typeof result[a] === 'string') digests[a] = result[a]
            record.hashes = digests
            stats.hashed++
          }
          if (needsParse) {
            stats.parsed++
            if (kind === 'mods') record.mod = await readers.mod(item.path, { signal, preferLoader: options.preferLoader })
            else if (kind === 'resourcepacks') record.resourcePack = await readers.resourcePack(item.path, { signal })
            else record.shaderPack = await readers.shaderPack(item.path, { signal })
          }
        } catch (e) {
          if (isAbortError(e)) throw e
          record.problem = classifyError(e)
        }
      }
      // A file that vanished mid-scan is not worth remembering.
      if (dirty && record.problem?.code !== 'not-found') await options.cache?.set(key, record)
      if (!readContents) stats.cached++
      if (record.problem) stats.failed++
      options.ctx?.advance(1)

      const baseName = kind === 'mods' ? stripDisabled(item.fileName) : item.fileName
      const entry: ContentEntry = {
        path: item.path,
        fileName: item.fileName,
        baseName,
        kind,
        isDirectory: item.isDirectory,
        enabled: undefined,
        size: item.size,
        mtimeMs: item.mtimeMs,
        ino: item.ino,
        cached: !readContents,
      }
      if (record.hashes) entry.hashes = record.hashes
      if (record.problem) entry.problem = record.problem
      if (kind === 'mods') {
        entry.enabled = baseName === item.fileName
        if (record.mod) entry.mod = needsParse ? record.mod : withPreferredLoader(record.mod, options.preferLoader)
      } else if (kind === 'resourcepacks') {
        entry.packId = resourcePackId(item.fileName)
        if (enabledPacks) entry.enabled = enabledPacks.has(entry.packId)
        if (record.resourcePack) entry.resourcePack = record.resourcePack
      } else {
        if (options.activeShaderPack !== undefined) entry.enabled = options.activeShaderPack !== null && options.activeShaderPack === item.fileName
        if (record.shaderPack) entry.shaderPack = record.shaderPack
      }
      return entry
    },
    signal,
  )
  return { dir, kind, entries, stats }
}

/** Options for {@link setEnabled}. */
export interface SetEnabledOptions {
  /**
   * What to do when the target name already exists: `error` (default, `EEXIST`) or `rename`
   * to the first free `<stem> (2)<ext>` name.
   */
  onConflict?: 'error' | 'rename'
}

/**
 * Enable or disable a mod by renaming it: disabling appends `.disabled`, enabling strips
 * exactly one `.disabled`. Already being in the requested state is a no-op. The rename never
 * overwrites an existing file (it uses link + unlink, which fails atomically on conflicts).
 * Returns the new path.
 *
 * @throws {ContentError} `EEXIST` when the target exists (and `onConflict` is `error`),
 * `ENOT_FOUND` when the file is missing.
 */
export async function setEnabled(filePath: string, enabled: boolean, options: SetEnabledOptions = {}): Promise<string> {
  const dir = path.dirname(filePath)
  const name = path.basename(filePath)
  const isDisabled = stripDisabled(name) !== name
  if (enabled !== isDisabled) {
    if (!(await lstat(filePath).catch(() => undefined))) throw new ContentError('ENOT_FOUND', `${filePath} does not exist`)
    return filePath
  }
  let targetName = enabled ? stripDisabled(name) : `${name}${DISABLED}`
  if (targetName === '') throw new ContentError('EINVALID_ARGUMENT', `Cannot enable ${filePath}`)
  const st = await lstat(filePath).catch(() => undefined)
  if (!st) throw new ContentError('ENOT_FOUND', `${filePath} does not exist`)

  for (let attempt = 0; ; attempt++) {
    const target = path.join(dir, targetName)
    try {
      if (st.isFile()) {
        await link(filePath, target)
        await unlink(filePath)
      } else {
        // Symlinks and folders cannot be hard-linked: check, then rename.
        if (await lstat(target).catch(() => undefined)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        await rename(filePath, target)
      }
      return target
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        if (options.onConflict !== 'rename' || attempt >= 5) throw new ContentError('EEXIST', `${target} already exists`, { cause: e })
        targetName = await freeName(dir, targetName)
        continue
      }
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EMLINK') {
        // File systems without hard links: fall back to a checked rename.
        if (await lstat(target).catch(() => undefined)) {
          if (options.onConflict !== 'rename' || attempt >= 5) throw new ContentError('EEXIST', `${target} already exists`, { cause: e })
          targetName = await freeName(dir, targetName)
          continue
        }
        await rename(filePath, target)
        return target
      }
      throw e
    }
  }
}

/** First free `<stem> (n)<ext>` name, keeping a trailing `.disabled` after the extension. */
async function freeName(dir: string, name: string): Promise<string> {
  const base = stripDisabled(name)
  const suffix = name.slice(base.length)
  const { stem, ext } = splitExtension(base)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}${suffix}`
    if (!(await lstat(path.join(dir, candidate)).catch(() => undefined))) return candidate
  }
}
