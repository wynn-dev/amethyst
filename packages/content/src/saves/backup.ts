/* oxlint-disable no-await-in-loop -- backups are listed and removed one at a time */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { openZip, type ZipReader } from '@amethyst/zip'
import { ContentError, throwIfAborted, wrapFsError } from '../errors'
import { sanitizeFileName } from '../paths'
import { int, isObject, parseLenientJson, str } from '../util/json'
import { writeFileAtomic } from '../util/fs'
import { combinedSignal, extractWorld, renameIntoFreeName, zipWorld, type ImportedWorld, type WorldOperationOptions } from './archive'
import { readLevelDat } from './level'

/**
 * Why a backup was taken. Everything except `manual` is an automatic backup, which
 * {@link pruneBackups} may delete.
 */
export type BackupReason = 'manual' | 'pre-launch' | 'pre-version-change' | 'pre-modpack-update' | 'pre-restore'

/** One world backup: a zip plus its JSON sidecar. */
export interface BackupInfo {
  /** Backup id: the file stem, e.g. `2026-10-24_13-05-09`. */
  id: string
  /** Absolute path of the zip. */
  path: string
  /** World folder name the backup was taken from. */
  world: string
  /** `LevelName` at backup time. */
  worldName?: string
  reason: BackupReason | 'unknown'
  automatic: boolean
  /** Creation time in Unix epoch milliseconds. */
  createdAt: number
  /** Zip size in bytes. */
  size: number
  uncompressedSize?: number
  fileCount?: number
  dataVersion?: number
  versionName?: string
  /** Files that vanished while the backup was taken (the game was running). */
  skipped?: number
}

/** Options for {@link backupWorld}. */
export interface BackupOptions extends WorldOperationOptions {
  /** Default `manual`. */
  reason?: BackupReason
  /** Clock override for tests. */
  now?: Date
}

const SIDECAR_VERSION = 1
const REASONS: ReadonlySet<string> = new Set<BackupReason>(['manual', 'pre-launch', 'pre-version-change', 'pre-modpack-update', 'pre-restore'])

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD_HH-mm-ss` in local time. */
export function backupStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

const sidecarPath = (zip: string) => zip.replace(/\.zip$/i, '.json')

/**
 * Back up a world to `<backupsDir>/<world folder>/<YYYY-MM-DD_HH-mm-ss>.zip` with a JSON sidecar
 * (`.json`, same stem) recording the reason, creation time, world name and size. Safe to run
 * while the game is running: `session.lock` is skipped, the world is snapshotted with APFS
 * clones before compressing, and files that vanish are listed as skipped. The zip appears only
 * once complete. `backupsDir` is normally `<appData>/backups/<instance id>`.
 *
 * @throws {ContentError} `ENOT_A_WORLD` when `saveDir` has no `level.dat`.
 */
export async function backupWorld(saveDir: string, backupsDir: string, options: BackupOptions = {}): Promise<BackupInfo> {
  const signal = combinedSignal(options)
  throwIfAborted(signal)
  const reason = options.reason ?? 'manual'
  const world = path.basename(saveDir)
  let level
  try {
    level = await readLevelDat(path.join(saveDir, 'level.dat'))
  } catch (e) {
    if (e instanceof ContentError && e.code === 'ENOT_FOUND') throw new ContentError('ENOT_A_WORLD', `${saveDir} has no level.dat`, { cause: e })
    throw e
  }
  const dir = path.join(backupsDir, sanitizeFileName(world, 'world'))
  await mkdir(dir, { recursive: true })
  const now = options.now ?? new Date()
  const stamp = backupStamp(now)
  let id = stamp
  for (let n = 2; await lstat(path.join(dir, `${id}.zip`)).catch(() => undefined); n++) id = `${stamp}-${n}`
  const zipPath = path.join(dir, `${id}.zip`)

  const result = await zipWorld(saveDir, zipPath, options)
  const info: BackupInfo = {
    id,
    path: zipPath,
    world,
    ...(level.levelName !== undefined ? { worldName: level.levelName } : {}),
    reason,
    automatic: reason !== 'manual',
    createdAt: now.getTime(),
    size: result.size,
    uncompressedSize: result.uncompressedSize,
    fileCount: result.fileCount,
    ...(level.dataVersion !== undefined ? { dataVersion: level.dataVersion } : {}),
    ...(level.versionName !== undefined ? { versionName: level.versionName } : {}),
    skipped: result.skipped.length,
  }
  try {
    const { path: _p, id: _i, automatic: _a, ...sidecar } = info
    await writeFileAtomic(sidecarPath(zipPath), `${JSON.stringify({ schemaVersion: SIDECAR_VERSION, ...sidecar, createdAt: new Date(info.createdAt).toISOString() }, null, 2)}\n`)
  } catch (e) {
    await rm(zipPath, { force: true })
    throw wrapFsError(e, 'Cannot write backup metadata')
  }
  return info
}

async function readBackup(zipPath: string, world: string): Promise<BackupInfo | undefined> {
  const st = await stat(zipPath).catch(() => undefined)
  if (!st?.isFile()) return undefined
  const id = path.basename(zipPath).replace(/\.zip$/i, '')
  const base: BackupInfo = { id, path: zipPath, world, reason: 'unknown', automatic: false, createdAt: st.mtimeMs, size: st.size }
  const text = await readFile(sidecarPath(zipPath), 'utf8').catch(() => undefined)
  if (text === undefined) return base
  const parsed = parseLenientJson(text)
  if (!parsed.ok || !isObject(parsed.value)) return base
  const j = parsed.value
  const reason = str(j.reason)
  const created = typeof j.createdAt === 'string' ? Date.parse(j.createdAt) : int(j.createdAt)
  const known = reason !== undefined && REASONS.has(reason) ? (reason as BackupReason) : 'unknown'
  return {
    ...base,
    world: str(j.world) ?? world,
    ...(str(j.worldName) !== undefined ? { worldName: str(j.worldName) } : {}),
    reason: known,
    automatic: known !== 'manual' && known !== 'unknown',
    createdAt: created !== undefined && Number.isFinite(created) ? created : base.createdAt,
    ...(int(j.uncompressedSize) !== undefined ? { uncompressedSize: int(j.uncompressedSize) } : {}),
    ...(int(j.fileCount) !== undefined ? { fileCount: int(j.fileCount) } : {}),
    ...(int(j.dataVersion) !== undefined ? { dataVersion: int(j.dataVersion) } : {}),
    ...(str(j.versionName) !== undefined ? { versionName: str(j.versionName) } : {}),
    ...(int(j.skipped) !== undefined ? { skipped: int(j.skipped) } : {}),
  }
}

/**
 * List backups under `backupsDir`, newest first. Pass `world` (a world folder name) to list
 * one world only. Zips without a sidecar are listed with reason `unknown`; in-progress
 * temporary files are ignored. A missing folder yields an empty list.
 */
export async function listBackups(backupsDir: string, world?: string): Promise<BackupInfo[]> {
  const worlds =
    world !== undefined
      ? [sanitizeFileName(world, 'world')]
      : (await readdir(backupsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  const out: BackupInfo[] = []
  for (const w of worlds) {
    const dir = path.join(backupsDir, w)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith('.') || !name.toLowerCase().endsWith('.zip')) continue
      const info = await readBackup(path.join(dir, name), w)
      if (info) out.push(info)
    }
  }
  return out.toSorted((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
}

/** Delete a backup zip and its sidecar. Deleting a backup that is already gone is not an error. */
export async function deleteBackup(backup: string | BackupInfo): Promise<void> {
  const zipPath = typeof backup === 'string' ? backup : backup.path
  if (!zipPath.toLowerCase().endsWith('.zip')) throw new ContentError('EINVALID_ARGUMENT', `Not a backup: ${zipPath}`)
  await rm(zipPath, { force: true })
  await rm(sidecarPath(zipPath), { force: true })
}

/** Options for {@link pruneBackups}. */
export interface PruneBackupsOptions {
  /** Automatic backups to keep per world (newest first). Default 5. */
  keep?: number
  /** Only prune this world folder. */
  world?: string
  /** Also count and delete manual backups. Default false: manual backups are never pruned. */
  includeManual?: boolean
}

/** Delete all but the `keep` newest automatic backups of each world. Returns the deleted backups. */
export async function pruneBackups(backupsDir: string, options: PruneBackupsOptions = {}): Promise<BackupInfo[]> {
  const keep = Math.max(0, options.keep ?? 5)
  const all = await listBackups(backupsDir, options.world)
  const perWorld = new Map<string, BackupInfo[]>()
  for (const b of all) {
    if (!b.automatic && !options.includeManual) continue
    const list = perWorld.get(b.world) ?? []
    list.push(b)
    perWorld.set(b.world, list)
  }
  const removed: BackupInfo[] = []
  for (const list of perWorld.values()) {
    for (const b of list.slice(keep)) {
      await deleteBackup(b)
      removed.push(b)
    }
  }
  return removed
}

/** Options for {@link restoreBackup}. */
export interface RestoreOptions extends WorldOperationOptions {
  /**
   * `replace` (default): swap the restored world in for `<savesDir>/<world>`.
   * `copy`: restore next to it as `<world> (restored YYYY-MM-DD HH-mm)`.
   */
  mode?: 'replace' | 'copy'
  /** Target folder name. Defaults to the backup's world folder. */
  name?: string
  /**
   * Called with the previous world (renamed to `<name>.before-restore`) once the restore has
   * succeeded. Defaults to deleting it; the app passes a move-to-Trash function instead.
   * If it throws, the previous world is left in place and its path is returned.
   */
  disposePrevious?: (dir: string) => Promise<void>
}

/** Result of {@link restoreBackup}. */
export interface RestoreResult extends ImportedWorld {
  /** Set when the previous world was kept (because `disposePrevious` failed). */
  previousPath?: string
}

/**
 * Restore a backup into `savesDir`. The archive is extracted into a hidden temporary folder
 * first and its `level.dat` verified. In `replace` mode the current world is then renamed to
 * `<name>.before-restore`, the restored folder is renamed into place, and only after that
 * succeeds is the previous world disposed of. If any step fails the previous world is put
 * back. The game must not be running.
 *
 * @throws {ContentError} `ENOT_A_WORLD` when the backup holds no valid world.
 */
export async function restoreBackup(backup: string | BackupInfo, savesDir: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const signal = combinedSignal(options)
  throwIfAborted(signal)
  const info = typeof backup === 'string' ? await readBackup(backup, path.basename(path.dirname(backup))) : backup
  if (!info) throw new ContentError('ENOT_FOUND', `Backup not found: ${String(backup)}`)
  await mkdir(savesDir, { recursive: true })
  const temp = path.join(savesDir, `.restore-${randomBytes(6).toString('hex')}`)
  let zip: ZipReader | undefined
  try {
    zip = await openZip(info.path)
    await extractWorld(zip, temp, options)
    await zip.close()
    zip = undefined
    const level = await readLevelDat(path.join(temp, 'level.dat'))
    const name = sanitizeFileName(options.name ?? info.world, 'World')

    if (options.mode === 'copy') {
      const d = new Date()
      const target = await renameIntoFreeName(temp, savesDir, `${name} (restored ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())})`)
      return { path: target, folderName: path.basename(target), level }
    }

    const target = path.join(savesDir, name)
    const exists = (await lstat(target).catch(() => undefined)) !== undefined
    let previous: string | undefined
    if (exists) {
      previous = path.join(savesDir, `${name}.before-restore`)
      // A leftover from an earlier failed restore must not be overwritten.
      for (let n = 2; await lstat(previous).catch(() => undefined); n++) previous = path.join(savesDir, `${name}.before-restore-${n}`)
      await rename(target, previous)
    }
    try {
      await rename(temp, target)
    } catch (e) {
      if (previous) await rename(previous, target).catch(() => {})
      throw e
    }
    const result: RestoreResult = { path: target, folderName: name, level }
    if (previous) {
      try {
        await (options.disposePrevious ?? ((dir: string) => rm(dir, { recursive: true, force: true })))(previous)
      } catch {
        result.previousPath = previous
      }
    }
    return result
  } catch (e) {
    throw wrapFsError(e, `Cannot restore backup ${info.path}`)
  } finally {
    await zip?.close()
    await rm(temp, { recursive: true, force: true })
  }
}
