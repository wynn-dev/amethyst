/* oxlint-disable no-await-in-loop -- icons and worlds are processed one at a time to bound open files */
/**
 * Jobs that run inside the scan worker pool. Every argument and result is plain data. The
 * folder scan uses `@amethyst/content`'s scan-worker handlers with a cache seeded from the SQLite
 * index (sent by the runtime) and returns exactly the records that changed, so the runtime can
 * write them back in one transaction: the index, not the worker, is the cache of record.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ContentStore,
  createScanWorkerHandlers,
  exportWorld,
  importWorld,
  importWorldFolder,
  listSaves,
  pathKey,
  readPackFile,
  scanCacheKey,
  type ContentEntry,
  type ContentKind,
  type IngestResult,
  type ImportedWorld,
  type SaveInfo,
  type ScanCacheRecord,
  type ScanResult,
  type ScanWorkerHandlers,
  type WorkerScanOptions,
} from '@amethyst/content'
import { curseforgeFingerprint } from '@amethyst/marketplace'
import { THUMBNAIL_SIZE, iconThumbnail } from './thumbnail'

/** A scan-cache record as stored in the index (`placements` row). */
export interface PlacementUpsert {
  ino: number
  size: number
  mtimeMs: number
  parserVersion: number
  sha1?: string
  record: ScanCacheRecord
}

export interface ScanFolderArgs {
  dir: string
  kind: ContentKind
  options: WorkerScanOptions
  /** Cached records of this folder from the index. */
  records: [string, ScanCacheRecord][]
  /** Where extracted icons go (`<data>/cache/icons`). */
  iconsDir: string
}

export interface ScanFolderResult {
  result: ScanResult
  upserts: [string, PlacementUpsert][]
  deletes: string[]
  /** Entry path → icon file name inside `iconsDir`, for icons already in the cache. */
  icons: Record<string, string>
  /** Icons to extract with `extractIcons`. */
  missingIcons: IconJob[]
}

/** One icon to extract: the archive, the icon's path inside it and its cache file name. */
export interface IconJob {
  path: string
  rel: string
  name: string
}

export interface ScanSavesResult {
  saves: (SaveInfo & { iconFile?: string })[]
  invalid: { path: string; message: string }[]
}

/** Every job the pool can run. */
export interface ResourceWorkerHandlers {
  scanFolder(args: ScanFolderArgs, signal?: AbortSignal): Promise<ScanFolderResult>
  /** Extract icons into the cache as thumbnails; resolves with entry path → file name of those written. */
  extractIcons(args: { jobs: IconJob[]; iconsDir: string }, signal?: AbortSignal): Promise<Record<string, string>>
  scanSaves(args: { savesDir: string; iconsDir: string }, signal?: AbortSignal): Promise<ScanSavesResult>
  /** CurseForge murmur2 fingerprints (two streaming passes per file). */
  fingerprints(args: { files: { path: string; sha1: string }[] }, signal?: AbortSignal): Promise<[string, number][]>
  /** Hash a file into the content store. */
  ingest(args: { storeRoot: string; source: string; expectedSha1?: string }, signal?: AbortSignal): Promise<IngestResult>
  importWorld(args: { source: string; savesDir: string }, signal?: AbortSignal): Promise<ImportedWorld>
  /** Zip a world folder to `output`. */
  exportWorld(args: { source: string; output: string }, signal?: AbortSignal): Promise<{ path: string; size: number }>
}

/** World icons are copied as they are. */
const ICON_MAX_BYTES = 2 * 1024 * 1024
/** Mod and pack icons are read whole, then shrunk to a thumbnail. */
const ICON_SOURCE_MAX_BYTES = 8 * 1024 * 1024
const ICON_EXT = /\.(png|jpe?g|gif|webp)$/i
/** Suffix of the marker for content without a usable icon. */
const NO_ICON = '.none'

/**
 * File name of an entry's extracted icon in the icon cache. The `-t128` tag marks icons stored as
 * thumbnails (see `thumbnail.ts`); full-size icons cached by older versions are never reused.
 */
export function iconName(entry: Pick<ContentEntry, 'hashes' | 'path' | 'mtimeMs'>, rel: string): string {
  const ext = (ICON_EXT.exec(rel)?.[0] ?? '.png').toLowerCase()
  const tag = `-t${THUMBNAIL_SIZE}`
  if (entry.hashes?.sha1) return `${entry.hashes.sha1}${tag}${ext}`
  // Folder packs are not content-hashed: key by path and modification time.
  return `f-${createHash('sha1').update(`${pathKey(entry.path)}:${entry.mtimeMs}`).digest('hex')}${tag}${ext}`
}

async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

/** The icon an entry would have in the cache, if it has one. */
function iconOf(entry: ContentEntry): IconJob | undefined {
  const rel = entry.mod?.icon ?? entry.resourcePack?.icon
  if (!rel || !ICON_EXT.test(rel) || entry.problem) return undefined
  return { path: entry.path, rel, name: iconName(entry, rel) }
}

/**
 * Extract one icon into the icon cache as a thumbnail; false when the archive has no usable icon.
 * That outcome is remembered with an empty `<name>.none` marker (names are content-addressed), so
 * a missing, oversized or corrupt icon is not read again on every scan.
 */
async function extractIcon(job: IconJob, iconsDir: string, signal?: AbortSignal): Promise<boolean> {
  await mkdir(iconsDir, { recursive: true }).catch(() => undefined)
  try {
    const bytes = await readPackFile(job.path, job.rel, { maxBytes: ICON_SOURCE_MAX_BYTES })
    await writeAtomic(path.join(iconsDir, job.name), iconThumbnail(bytes))
    return true
  } catch {
    if (!signal?.aborted) await writeFile(path.join(iconsDir, `${job.name}${NO_ICON}`), '').catch(() => undefined)
    return false
  }
}

/** Create the handlers (one set per worker). */
export function createResourceWorkerHandlers(): ResourceWorkerHandlers & Record<string, unknown> {
  const base: ScanWorkerHandlers = createScanWorkerHandlers()
  return {
    ...base,
    async scanFolder({ dir, kind, options, records, iconsDir }, signal) {
      // A private cache per job, seeded from the index, so concurrent scans never interfere.
      const handlers = createScanWorkerHandlers()
      await handlers.importCache({ records })
      const imported = new Map(records)
      const result = await handlers.scan({ dir, kind, options }, signal)
      const { records: after } = await handlers.exportCache()
      const present = new Set(result.entries.map((e) => scanCacheKey(e.path)))
      const upserts = after
        .filter(([key, record]) => imported.get(key) !== record && present.has(key))
        .map(([key, record]): [string, PlacementUpsert] => [
          key,
          { ino: record.ino, size: record.size, mtimeMs: record.mtimeMs, parserVersion: record.parserVersion, ...(record.hashes?.sha1 ? { sha1: record.hashes.sha1 } : {}), record },
        ])
      const deletes = records.map(([key]) => key).filter((key) => !present.has(key))
      // Icons already in the cache are listed now; missing ones are extracted by separate
      // `extractIcons` jobs, so new rows never wait for thumbnails.
      const cached = await readdir(iconsDir).then((names) => new Set(names), () => new Set<string>())
      const icons: Record<string, string> = {}
      const missingIcons: IconJob[] = []
      for (const entry of result.entries) {
        const job = iconOf(entry)
        if (!job) continue
        if (cached.has(job.name)) icons[entry.path] = job.name
        else if (!cached.has(`${job.name}${NO_ICON}`)) missingIcons.push(job)
      }
      return { result, upserts, deletes, icons, missingIcons }
    },

    async extractIcons({ jobs, iconsDir }, signal) {
      const done: Record<string, string> = {}
      for (const job of jobs) {
        if (signal?.aborted) break
        if (await extractIcon(job, iconsDir, signal)) done[job.path] = job.name
      }
      return done
    },

    async scanSaves({ savesDir, iconsDir }, signal) {
      const { saves, invalid } = await listSaves(savesDir, { signal })
      const out: ScanSavesResult['saves'] = []
      for (const save of saves) {
        const item: ScanSavesResult['saves'][number] = { ...save }
        if (save.iconPath) {
          const st = await stat(save.iconPath).catch(() => undefined)
          if (st && st.size <= ICON_MAX_BYTES) {
            const name = `w-${createHash('sha1').update(`${pathKey(save.path)}:${st.mtimeMs}:${st.size}`).digest('hex')}.png`
            const target = path.join(iconsDir, name)
            if (!(await stat(target).catch(() => undefined))) {
              await mkdir(iconsDir, { recursive: true })
              await copyFile(save.iconPath, `${target}.tmp`).then(() => rename(`${target}.tmp`, target)).catch(() => undefined)
            }
            if (await stat(target).catch(() => undefined)) item.iconFile = name
          }
        }
        out.push(item)
      }
      return { saves: out, invalid }
    },

    async fingerprints({ files }, signal) {
      const out: [string, number][] = []
      for (const f of files) {
        if (signal?.aborted) break
        try {
          const st = await stat(f.path)
          // murmur2 needs the whole length up front: small files are buffered, big ones streamed twice.
          const fp = st.size <= 64 * 1024 * 1024 ? await curseforgeFingerprint(await readFile(f.path), signal) : await curseforgeFingerprint(() => createReadStream(f.path), signal)
          out.push([f.sha1, fp])
        } catch {
          // Unreadable files simply get no fingerprint.
        }
      }
      return out
    },

    ingest: ({ storeRoot, source, expectedSha1 }, signal) => new ContentStore(storeRoot).ingest(source, { signal, ...(expectedSha1 ? { expectedSha1 } : {}) }),

    async importWorld({ source, savesDir }, signal) {
      const st = await stat(source)
      return st.isDirectory() ? importWorldFolder(source, savesDir, { signal }) : importWorld(source, savesDir, { signal })
    },

    async exportWorld({ source, output }, signal) {
      const result = await exportWorld(source, output, { signal })
      return { path: result.zipPath, size: result.size }
    },
  }
}
