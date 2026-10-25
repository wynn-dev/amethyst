/* oxlint-disable no-await-in-loop -- icons and worlds are processed one at a time to bound open files */
/**
 * Jobs that run inside the scan worker pool. Every argument and result is plain data. The
 * folder scan uses `@amethyst/content`'s scan-worker handlers with a cache seeded from the SQLite
 * index (sent by the runtime) and returns exactly the records that changed, so the runtime can
 * write them back in one transaction: the index, not the worker, is the cache of record.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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
  readRegularFile,
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
  /** Entry path → icon file name inside `iconsDir`. */
  icons: Record<string, string>
}

export interface ScanSavesResult {
  saves: (SaveInfo & { iconFile?: string })[]
  invalid: { path: string; message: string }[]
}

/** Every job the pool can run. */
export interface ResourceWorkerHandlers {
  scanFolder(args: ScanFolderArgs, signal?: AbortSignal): Promise<ScanFolderResult>
  scanSaves(args: { savesDir: string; iconsDir: string }, signal?: AbortSignal): Promise<ScanSavesResult>
  /** CurseForge murmur2 fingerprints (two streaming passes per file). */
  fingerprints(args: { files: { path: string; sha1: string }[] }, signal?: AbortSignal): Promise<[string, number][]>
  /** Hash a file into the content store. */
  ingest(args: { storeRoot: string; source: string; expectedSha1?: string }, signal?: AbortSignal): Promise<IngestResult>
  importWorld(args: { source: string; savesDir: string }, signal?: AbortSignal): Promise<ImportedWorld>
  /** Zip a world folder to `output`. */
  exportWorld(args: { source: string; output: string }, signal?: AbortSignal): Promise<{ path: string; size: number }>
}

const ICON_MAX_BYTES = 2 * 1024 * 1024
const ICON_EXT = /\.(png|jpe?g|gif|webp)$/i

/** File name of an entry's extracted icon in the icon cache. */
export function iconName(entry: Pick<ContentEntry, 'hashes' | 'path' | 'mtimeMs'>, rel: string): string {
  const ext = (ICON_EXT.exec(rel)?.[0] ?? '.png').toLowerCase()
  if (entry.hashes?.sha1) return `${entry.hashes.sha1}${ext}`
  // Folder packs are not content-hashed: key by path and modification time.
  return `f-${createHash('sha1').update(`${pathKey(entry.path)}:${entry.mtimeMs}`).digest('hex')}${ext}`
}

async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

/** Extract an entry's icon into the icon cache (once per content), returning its file name. */
async function extractIcon(entry: ContentEntry, iconsDir: string): Promise<string | undefined> {
  const rel = entry.mod?.icon ?? entry.resourcePack?.icon
  if (!rel || !ICON_EXT.test(rel) || entry.problem) return undefined
  const name = iconName(entry, rel)
  const target = path.join(iconsDir, name)
  if (await stat(target).catch(() => undefined)) return name
  try {
    const bytes = await readPackFile(entry.path, rel, { maxBytes: ICON_MAX_BYTES })
    await mkdir(iconsDir, { recursive: true })
    await writeAtomic(target, bytes)
    return name
  } catch {
    return undefined
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
      const icons: Record<string, string> = {}
      for (const entry of result.entries) {
        if (signal?.aborted) break
        const name = await extractIcon(entry, iconsDir)
        if (name) icons[entry.path] = name
      }
      return { result, upserts, deletes, icons }
    },

    async scanSaves({ savesDir, iconsDir }, signal) {
      const { saves, invalid } = await listSaves(savesDir, { signal })
      const out: ScanSavesResult['saves'] = []
      for (const save of saves) {
        const item: ScanSavesResult['saves'][number] = { ...save }
        if (save.iconPath) {
          // lstat, and a no-follow read: a symlinked icon.png could point at any file on disk.
          const st = await lstat(save.iconPath).catch(() => undefined)
          if (st?.isFile() && st.size <= ICON_MAX_BYTES) {
            const name = `w-${createHash('sha1').update(`${pathKey(save.path)}:${st.mtimeMs}:${st.size}`).digest('hex')}.png`
            const target = path.join(iconsDir, name)
            if (!(await stat(target).catch(() => undefined))) {
              await readRegularFile(save.iconPath, { maxBytes: ICON_MAX_BYTES, root: save.path })
                .then(async (bytes) => {
                  await mkdir(iconsDir, { recursive: true })
                  await writeAtomic(target, bytes)
                })
                .catch(() => undefined)
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
