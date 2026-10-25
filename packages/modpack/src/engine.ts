/* oxlint-disable no-await-in-loop -- commit and rollback move files one at a time, in order, by design */
/**
 * The apply engine shared by install and update (`modpacks.md` §5).
 *
 * 1. **Stage**: every file to place is materialised in `.amethyst/staging/<operationId>/files/`
 *    (from the workspace of an earlier attempt, the content store, the pack archive, a manual
 *    download, or HTTPS) and verified. An operation record next to the workspace
 *    (`.amethyst/staging/<operationId>.json`) makes the operation resumable.
 * 2. **Commit**: only after every file is staged. Each file being replaced or removed is first
 *    moved into the backup folder (`.amethyst/backups/modpack-<timestamp>/<path>`), then the
 *    staged file is renamed into place (atomic on one volume). If anything fails, the commit is
 *    rolled back from the file system state, so the instance is never left half-updated.
 * 3. **Finish**: the backup folder gets a `backup.json` journal used by
 *    {@link rollbackModpackOperation}; the workspace and the operation record are deleted.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ContentStore } from '@amethyst/content'
import { curseforgeFingerprint } from '@amethyst/marketplace'
import { DownloadError, downloadMany, type Checksum, type DownloadItem, type DownloadManyOptions } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import { openZip, type ZipReader } from '@amethyst/zip'
import { isAbortError, messageOf, ModpackError, throwIfAborted } from './errors'
import { lockPath, writeModpackLock, type ModpackLock, type ModpackLockFile } from './lock'
import { pathKey, resolveInside } from './paths'
import type { FileHashes, FileOrigin, ManualDownload, ModpackManifest, ResolvedFile, ResolvedModpack } from './types'
import { compareHashes, fileTimestamp, hashFor, hashLocal, lstatOrUndefined, pruneEmptyParents, readJsonFile, writeJsonAtomic, type LocalHashes } from './util'

/** Where a staged file comes from. `none`: a blocked file nobody supplied (unresolved). */
export type StageSource =
  | { type: 'download'; urls: string[] }
  | { type: 'archive'; archive: string; entry: string }
  | { type: 'manual'; file: string }
  | { type: 'none' }

/** One file the operation wants in the instance. */
export interface StageTarget {
  path: string
  hashes: FileHashes
  size?: number
  source: StageSource
  origin: FileOrigin
  optional: boolean
  kind: 'file' | 'world'
  /** The resolved file, for blocked files (manual download details). */
  manual?: ManualDownload
  /** CurseForge murmur2 fingerprint: verifies a download when the API gave no digest. */
  fingerprint?: number
}

/** Options shared by install and update for fetching files. */
export interface FetchOptions {
  /** Content store: consulted before downloading, and fed with downloaded mods and packs. */
  store?: ContentStore
  /** Passed to `downloadMany` (`client`, `retry`, `concurrency`, ...). */
  download?: Omit<DownloadManyOptions, 'signal' | 'ctx' | 'failFast'>
  signal?: AbortSignal
  ctx?: TaskContext
}

/** Test-only hooks. @internal */
export interface EngineHooks {
  /** Called before each file is moved into the instance during commit. Throw to simulate a failure. */
  beforeCommitFile?: (relPath: string) => void | Promise<void>
}

const AMETHYST = '.amethyst'
const STAGING = `${AMETHYST}/staging`
const BACKUPS = `${AMETHYST}/backups`
const UNRESOLVED = `${AMETHYST}/unresolved.json`
const STORE_FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks'])

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/** The install's file set: resolved files (selection applied) plus overrides, which replace files at the same path. */
export function buildTargets(
  manifest: ModpackManifest,
  resolved: ResolvedModpack,
  isSelected: (file: ResolvedFile) => boolean,
): { targets: StageTarget[]; deselected: string[] } {
  if (resolved.packSha1 !== manifest.sha1) throw new ModpackError('EINVALID_ARGUMENT', 'The resolved files belong to a different pack')
  const byKey = new Map<string, StageTarget>()
  const deselected: string[] = []
  for (const f of resolved.files) {
    if (f.optional && !isSelected(f)) {
      deselected.push(f.path)
      continue
    }
    const manual = f.blocked ? resolved.manualDownloads.find((m) => pathKey(m.path) === pathKey(f.path)) : undefined
    byKey.set(pathKey(f.path), {
      path: f.path,
      hashes: { ...f.hashes },
      size: f.size,
      source: f.blocked ? { type: 'none' } : { type: 'download', urls: [...f.downloads] },
      origin: f.origin,
      optional: f.optional,
      kind: f.kind ?? 'file',
      manual,
      ...(f.fingerprint === undefined ? {} : { fingerprint: f.fingerprint }),
    })
  }
  for (const o of manifest.overrides) {
    const key = pathKey(o.path)
    byKey.delete(key)
    byKey.set(key, {
      path: o.path,
      hashes: { crc32: o.crc32 },
      size: o.size,
      source: { type: 'archive', archive: manifest.archive, entry: o.entry },
      origin: { kind: 'override', layer: o.layer },
      optional: false,
      kind: 'file',
    })
  }
  return { targets: [...byKey.values()], deselected }
}

/** Hash what is on disk at `rel`, enough to compare with every hash set in `against`. Undefined when missing. */
export async function diskState(
  instanceDir: string,
  rel: string,
  against: FileHashes[],
  signal?: AbortSignal,
): Promise<{ exists: false } | { exists: true; dir: true } | { exists: true; dir: false; hashes: LocalHashes }> {
  const abs = resolveInside(instanceDir, rel)
  const st = await lstatOrUndefined(abs)
  if (!st) return { exists: false }
  if (st.isDirectory()) return { exists: true, dir: true }
  const want: FileHashes = {}
  for (const h of against) Object.assign(want, h)
  const hashes = await hashLocal(abs, { sha512: !!want.sha512, md5: !!want.md5 }, signal)
  return { exists: true, dir: false, hashes }
}

/** True when the local hashes match `expected` (by the strongest shared digest, else by size). */
export function sameContent(expected: FileHashes, size: number | undefined, local: LocalHashes): boolean {
  const cmp = compareHashes(expected, local)
  if (cmp !== undefined) return cmp
  return size !== undefined && size === local.size
}

// ---------------------------------------------------------------------------------------------
// Operation records
// ---------------------------------------------------------------------------------------------

/** One planned change of a commit. `place` writes a staged file; `remove` deletes the existing one. */
export interface PlannedChange {
  path: string
  action: 'place' | 'remove'
  kind: 'file' | 'world'
}

/** Persisted state of an install or update that has not finished. */
export interface OperationRecord {
  schemaVersion: 1
  id: string
  kind: 'install' | 'update'
  packSha1: string
  createdAt: number
  state: 'staging' | 'committing'
  /** Backup folder, relative to the instance (set when committing). */
  backupDir?: string
  changes?: PlannedChange[]
}

/** An incomplete operation found in an instance (crash, cancel or failed download). */
export interface IncompleteOperation {
  id: string
  kind: 'install' | 'update'
  packSha1: string
  createdAt: number
  state: 'staging' | 'committing'
}

function recordPath(instanceDir: string, id: string): string {
  return path.join(instanceDir, ...STAGING.split('/'), `${id}.json`)
}

function workspacePath(instanceDir: string, id: string): string {
  return path.join(instanceDir, ...STAGING.split('/'), id)
}

function stagedPath(workspace: string, rel: string): string {
  return resolveInside(path.join(workspace, 'files'), rel)
}

/** Operation id for an install/update of a pack: stable across attempts so a retry resumes. */
export function operationId(kind: 'install' | 'update', packSha1: string): string {
  return `${kind}-${packSha1.slice(0, 16)}`
}

export async function writeRecord(instanceDir: string, record: OperationRecord): Promise<void> {
  await writeJsonAtomic(recordPath(instanceDir, record.id), record)
}

async function readRecord(instanceDir: string, id: string): Promise<OperationRecord | undefined> {
  const raw = (await readJsonFile(recordPath(instanceDir, id)).catch(() => undefined)) as OperationRecord | undefined
  return raw && raw.schemaVersion === 1 && raw.id === id ? raw : undefined
}

/** List install/update operations that were interrupted. Show "Resume / Discard"; never auto-resume. */
export async function listIncompleteOperations(instanceDir: string): Promise<IncompleteOperation[]> {
  const dir = path.join(instanceDir, ...STAGING.split('/'))
  const names = await readdir(dir).catch(() => [] as string[])
  const out: IncompleteOperation[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const r = await readRecord(instanceDir, name.slice(0, -5))
    if (r) out.push({ id: r.id, kind: r.kind, packSha1: r.packSha1, createdAt: r.createdAt, state: r.state })
  }
  return out
}

/**
 * Discard an interrupted operation: undo a half-done commit (restoring backed-up files and
 * removing newly placed ones), then delete the workspace and the record. The instance is left
 * as it was before the operation.
 */
export async function discardIncompleteOperation(instanceDir: string, id: string): Promise<void> {
  return withInstanceMutex(instanceDir, async () => {
    const r = await readRecord(instanceDir, id)
    if (r?.state === 'committing' && r.changes && r.backupDir) {
      await rollbackFromDisk(instanceDir, workspacePath(instanceDir, id), path.join(instanceDir, r.backupDir), r.changes)
    }
    await cleanupOperation(instanceDir, id)
  })
}

export async function cleanupOperation(instanceDir: string, id: string): Promise<void> {
  await rm(workspacePath(instanceDir, id), { recursive: true, force: true })
  await rm(recordPath(instanceDir, id), { force: true })
  await pruneEmptyParents(instanceDir, path.join(instanceDir, ...STAGING.split('/'), 'x'))
}

// ---------------------------------------------------------------------------------------------
// Mutex and instance identity
// ---------------------------------------------------------------------------------------------

const mutexes = new Map<string, Promise<unknown>>()

/** Run `fn` while holding the per-instance modpack mutex (in-process). Calls queue in order. */
export async function withInstanceMutex<T>(instanceDir: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(path.resolve(instanceDir))
  const previous = mutexes.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  mutexes.set(key, tail)
  try {
    return await run
  } finally {
    if (mutexes.get(key) === tail) mutexes.delete(key)
  }
}

/** Device + inode of the instance folder, to notice it being deleted or replaced mid-operation. */
export async function instanceIdentity(instanceDir: string): Promise<string> {
  const st = await stat(instanceDir).catch(() => undefined)
  if (!st?.isDirectory()) throw new ModpackError('EINSTANCE_GONE', `The instance folder is missing: ${instanceDir}`)
  return `${st.dev}:${st.ino}`
}

export async function assertSameInstance(instanceDir: string, identity: string): Promise<void> {
  const now = await instanceIdentity(instanceDir).catch(() => undefined)
  if (now !== identity) throw new ModpackError('EINSTANCE_GONE', `The instance folder was moved or deleted: ${instanceDir}`)
}

// ---------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------

/** A file ready in the workspace. */
export interface StagedFile {
  target: StageTarget
  /** Absolute path in the workspace (a folder for worlds). */
  staged: string
  /** Hashes of the staged file (of the zip, for worlds). */
  hashes: LocalHashes
}

function verify(target: StageTarget, local: LocalHashes): string | undefined {
  if (target.size !== undefined && target.size !== local.size) return `size mismatch: expected ${target.size} bytes, got ${local.size}`
  for (const k of ['sha512', 'sha1', 'md5', 'crc32'] as const) {
    const want = target.hashes[k]
    const got = local[k]
    if (want && got && want.toLowerCase() !== got) return `${k} mismatch: expected ${want.toLowerCase()}, got ${got}`
  }
  return undefined
}

/**
 * Downloads must be checked against something stronger than their size (known issues lesson 3).
 * When the target has no digest at all (a CurseForge file the API listed without hashes), check
 * its murmur2 fingerprint; with neither, refuse the file.
 */
async function verifyUndigested(target: StageTarget, file: string, signal?: AbortSignal): Promise<string | undefined> {
  const { sha1, sha512, md5, crc32 } = target.hashes
  if (sha1 || sha512 || md5 || crc32) return undefined
  if (target.fingerprint === undefined) return 'no checksum to verify the download against'
  const got = await curseforgeFingerprint(() => createReadStream(file, { highWaterMark: 256 * 1024 }), signal)
  return got === target.fingerprint ? undefined : `fingerprint mismatch: expected ${target.fingerprint}, got ${got}`
}

async function reuseStaged(target: StageTarget, staged: string, signal?: AbortSignal): Promise<LocalHashes | undefined> {
  if (target.kind !== 'file') return undefined
  const st = await lstatOrUndefined(staged)
  if (!st?.isFile()) return undefined
  const local = await hashFor(staged, target.hashes, signal)
  if (verify(target, local) === undefined && compareHashes(target.hashes, local) === true) return local
  await rm(staged, { force: true })
  return undefined
}

/**
 * Stage `targets` into the operation's workspace. Returns the staged files and the targets that
 * failed (with a reason). Targets with source `none` are neither staged nor failed.
 */
export async function stageTargets(
  instanceDir: string,
  opId: string,
  targets: readonly StageTarget[],
  options: FetchOptions,
): Promise<{ staged: StagedFile[]; failed: { path: string; reason: string }[] }> {
  const signal = options.signal ?? options.ctx?.signal
  const workspace = workspacePath(instanceDir, opId)
  const staged: StagedFile[] = []
  const failed: { path: string; reason: string }[] = []
  const fail = (t: StageTarget, e: unknown) => {
    if (isAbortError(e)) throw e
    failed.push({ path: t.path, reason: typeof e === 'string' ? e : messageOf(e) })
  }
  await mkdir(path.join(workspace, 'files'), { recursive: true })

  // 1. Archive entries, grouped per archive so each zip is opened once.
  const byArchive = new Map<string, StageTarget[]>()
  for (const t of targets) if (t.source.type === 'archive') byArchive.set(t.source.archive, [...(byArchive.get(t.source.archive) ?? []), t])
  for (const [archive, list] of byArchive) {
    let zip: ZipReader | undefined
    try {
      zip = await openZip(archive)
      for (const t of list) {
        throwIfAborted(signal)
        const dest = stagedPath(workspace, t.path)
        try {
          const reused = await reuseStaged(t, dest, signal)
          if (reused) {
            staged.push({ target: t, staged: dest, hashes: reused })
            continue
          }
          await mkdir(path.dirname(dest), { recursive: true })
          const tmp = `${dest}.tmp`
          await pipeline(await zip.openStream((t.source as { entry: string }).entry, { signal }), createWriteStream(tmp), signal ? { signal } : {})
          const local = await hashFor(tmp, t.hashes, signal)
          const bad = verify(t, local)
          if (bad) {
            await rm(tmp, { force: true })
            fail(t, `corrupt pack entry: ${bad}`)
            continue
          }
          await rename(tmp, dest)
          staged.push({ target: t, staged: dest, hashes: local })
        } catch (e) {
          fail(t, e)
        }
      }
    } catch (e) {
      for (const t of list) if (!staged.some((s) => s.target === t) && !failed.some((f) => f.path === t.path)) fail(t, e)
    } finally {
      await zip?.close()
    }
  }
  options.ctx?.update(staged.length, targets.length)

  // 2. Manual files supplied by the user.
  for (const t of targets) {
    if (t.source.type !== 'manual') continue
    const isWorld = t.kind === 'world'
    const dest = isWorld ? path.join(workspace, 'worlds', `${t.path.replaceAll('/', '_')}.zip`) : stagedPath(workspace, t.path)
    try {
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(t.source.file, `${dest}.tmp`)
      const local = await hashFor(`${dest}.tmp`, t.hashes, signal)
      const bad = verify(t, local)
      if (bad) {
        await rm(`${dest}.tmp`, { force: true })
        fail(t, `manual file ${t.source.file}: ${bad}`)
        continue
      }
      await rename(`${dest}.tmp`, dest)
      staged.push(isWorld ? { target: t, staged: await extractWorld(dest, stagedPath(workspace, t.path), signal), hashes: local } : { target: t, staged: dest, hashes: local })
    } catch (e) {
      fail(t, e)
    }
  }

  // 3. Downloads: workspace from an earlier attempt, then the store, then HTTPS.
  const downloads: { t: StageTarget; dest: string }[] = []
  for (const t of targets) {
    if (t.source.type !== 'download') continue
    const isWorld = t.kind === 'world'
    const dest = isWorld ? path.join(workspace, 'worlds', `${t.path.replaceAll('/', '_')}.zip`) : stagedPath(workspace, t.path)
    try {
      const reused = await reuseStaged(t, dest, signal)
      if (reused) {
        staged.push({ target: t, staged: dest, hashes: reused })
        continue
      }
      const sha1 = t.hashes.sha1
      if (!isWorld && options.store && sha1 && (await options.store.has(sha1, t.size))) {
        await options.store.place(sha1, dest, { overwrite: true, signal })
        const local = await hashFor(dest, t.hashes, signal)
        const bad = verify(t, local)
        if (!bad) {
          staged.push({ target: t, staged: dest, hashes: local })
          continue
        }
        await rm(dest, { force: true })
      }
      if (t.source.urls.length === 0) fail(t, 'no download URL')
      else downloads.push({ t, dest })
    } catch (e) {
      fail(t, e)
    }
  }

  if (downloads.length > 0) {
    const items: DownloadItem[] = downloads.map(({ t, dest }) => {
      const checksum: Checksum | undefined = t.hashes.sha512
        ? { algorithm: 'sha512', value: t.hashes.sha512 }
        : t.hashes.sha1
          ? { algorithm: 'sha1', value: t.hashes.sha1 }
          : undefined
      return { url: (t.source as { urls: string[] }).urls, dest, size: t.size, checksum }
    })
    const failedDest = new Map<string, string>()
    const run = (ctx?: TaskContext) => downloadMany(items, { ...options.download, signal, ctx }).catch((e: unknown) => {
      if (!(e instanceof DownloadError)) throw e
      for (const f of e.failures) failedDest.set(path.resolve(f.item.dest), f.error.message)
    })
    if (options.ctx) await options.ctx.child('download', (c) => run(c), { weight: 4 })
    else await run()

    for (const { t, dest } of downloads) {
      const reason = failedDest.get(path.resolve(dest))
      if (reason) {
        fail(t, reason)
        continue
      }
      try {
        const local = await hashFor(dest, t.hashes, signal)
        const bad = verify(t, local) ?? (await verifyUndigested(t, dest, signal))
        if (bad) {
          await rm(dest, { force: true })
          fail(t, bad)
          continue
        }
        if (t.kind === 'world') {
          staged.push({ target: t, staged: await extractWorld(dest, stagedPath(workspace, t.path), signal), hashes: local })
          continue
        }
        const top = t.path.split('/')[0] ?? ''
        if (options.store && STORE_FOLDERS.has(top)) {
          await options.store.ingest(dest, { expectedSha1: local.sha1, signal }).catch((e: unknown) => {
            if (isAbortError(e)) throw e
          })
        }
        staged.push({ target: t, staged: dest, hashes: local })
      } catch (e) {
        fail(t, e)
      }
    }
  }
  return { staged, failed }
}

/** Extract a world zip into `destDir`, rooted at its shallowest `level.dat`. */
async function extractWorld(zipFile: string, destDir: string, signal?: AbortSignal): Promise<string> {
  const zip = await openZip(zipFile)
  try {
    const entries = await zip.entries()
    let best: string | undefined
    for (const e of entries) {
      if (e.isDirectory || e.name.startsWith('__MACOSX/')) continue
      if (e.name === 'level.dat' || e.name.endsWith('/level.dat')) {
        const prefix = e.name.slice(0, -'level.dat'.length)
        if (best === undefined || prefix.split('/').length < best.split('/').length) best = prefix
      }
    }
    if (best === undefined) throw new Error('the world zip has no level.dat')
    const prefix = best
    await rm(destDir, { recursive: true, force: true })
    await zip.extractTo(destDir, {
      filter: (e) => e.name.startsWith(prefix) && !e.name.startsWith('__MACOSX/'),
      strip: prefix === '' ? 0 : prefix.split('/').length - 1,
      signal,
    })
    return destDir
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------------------------
// Commit and rollback
// ---------------------------------------------------------------------------------------------

/** A change to commit. `staged` is required for `place`. */
export interface CommitChange extends PlannedChange {
  staged?: string
}

/** Pick a fresh backup folder `.amethyst/backups/modpack-<timestamp>[-n]` (relative path). */
export async function newBackupDir(instanceDir: string): Promise<string> {
  const base = `${BACKUPS}/modpack-${fileTimestamp()}`
  let rel = base
  for (let n = 1; await lstatOrUndefined(path.join(instanceDir, ...rel.split('/'))); n++) rel = `${base}-${n}`
  return rel
}

/**
 * Undo a commit using what is on disk: a change whose staged file is gone and whose target
 * exists was placed, so the target is removed; a backed-up file is moved back.
 */
async function rollbackFromDisk(instanceDir: string, workspace: string, backupDir: string, changes: readonly PlannedChange[]): Promise<void> {
  for (const c of changes.toReversed()) {
    const target = resolveInside(instanceDir, c.path)
    const backup = resolveInside(backupDir, c.path)
    if (c.action === 'place') {
      const stagedGone = !(await lstatOrUndefined(stagedPath(workspace, c.path)))
      if (stagedGone && (await lstatOrUndefined(target))) await rm(target, { recursive: true, force: true })
    }
    if (await lstatOrUndefined(backup)) {
      await mkdir(path.dirname(target), { recursive: true })
      await rename(backup, target)
    }
  }
}

/**
 * Move `changes` into the instance. Existing files at changed paths are moved into `backupRel`
 * first. On any failure everything is rolled back and `ECOMMIT` is thrown.
 *
 * @returns paths whose previous version was backed up.
 */
export async function commitChanges(
  instanceDir: string,
  opId: string,
  backupRel: string,
  changes: readonly CommitChange[],
  hooks: EngineHooks | undefined,
  ctx?: TaskContext,
): Promise<string[]> {
  const workspace = workspacePath(instanceDir, opId)
  const backupDir = path.join(instanceDir, ...backupRel.split('/'))
  const backedUp: string[] = []
  let done = 0
  try {
    for (const c of changes) {
      await hooks?.beforeCommitFile?.(c.path)
      const target = resolveInside(instanceDir, c.path)
      if (await lstatOrUndefined(target)) {
        const backup = resolveInside(backupDir, c.path)
        await mkdir(path.dirname(backup), { recursive: true })
        await rename(target, backup)
        backedUp.push(c.path)
      }
      if (c.action === 'place') {
        if (!c.staged) throw new Error(`Nothing staged for ${c.path}`)
        await mkdir(path.dirname(target), { recursive: true })
        await rename(c.staged, target)
      } else {
        await pruneEmptyParents(instanceDir, target)
      }
      ctx?.update(++done, changes.length)
    }
  } catch (e) {
    await rollbackFromDisk(instanceDir, workspace, backupDir, changes)
    for (const c of changes) await pruneEmptyParents(instanceDir, resolveInside(instanceDir, c.path))
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
    // Nothing is committed any more: a later resume re-stages what the rollback consumed.
    const record = await readRecord(instanceDir, opId)
    if (record) await writeRecord(instanceDir, { ...record, state: 'staging', backupDir: undefined, changes: undefined })
    throw new ModpackError('ECOMMIT', `Couldn't apply the modpack files; all changes were rolled back: ${messageOf(e)}`, { cause: e })
  }
  return backedUp
}

// ---------------------------------------------------------------------------------------------
// Journal and explicit rollback
// ---------------------------------------------------------------------------------------------

/** `backup.json` inside a backup folder: what an operation did, for {@link rollbackModpackOperation}. */
export interface BackupJournal {
  schemaVersion: 1
  kind: 'install' | 'update'
  createdAt: number
  packSha1: string
  previousLock: ModpackLock | null
  changes: { path: string; action: 'place' | 'remove'; kind: 'file' | 'world'; hadPrevious: boolean; placedSha1?: string }[]
  rolledBackAt?: number
}

export async function writeJournal(backupDir: string, journal: BackupJournal): Promise<void> {
  await writeJsonAtomic(path.join(backupDir, 'backup.json'), journal)
}

/** Result of {@link rollbackModpackOperation}. */
export interface RollbackResult {
  /** Paths restored from the backup. */
  restored: string[]
  /** Placed files removed again. */
  removed: string[]
  /** Placed files the user changed since; moved to `<backup>/rollback-displaced/` instead of deleted. */
  displaced: string[]
}

/**
 * Reverse a finished install or update recorded in `.amethyst/backups/<backupId>/backup.json`:
 * placed files are removed (or set aside when the user changed them since), backed-up files are
 * copied back, and the previous lock is restored. Backup files stay where they are.
 *
 * @throws {ModpackError} `EINVALID_ARGUMENT` when there is no journal for `backupId`.
 */
export async function rollbackModpackOperation(instanceDir: string, backupId: string, options: { signal?: AbortSignal } = {}): Promise<RollbackResult> {
  return withInstanceMutex(instanceDir, async () => {
    const backupDir = resolveInside(path.join(instanceDir, ...BACKUPS.split('/')), backupId)
    const journal = (await readJsonFile(path.join(backupDir, 'backup.json')).catch(() => undefined)) as BackupJournal | undefined
    if (!journal || journal.schemaVersion !== 1 || !Array.isArray(journal.changes)) {
      throw new ModpackError('EINVALID_ARGUMENT', `No modpack backup named ${backupId}`)
    }
    const result: RollbackResult = { restored: [], removed: [], displaced: [] }
    for (const c of journal.changes.toReversed()) {
      throwIfAborted(options.signal)
      const target = resolveInside(instanceDir, c.path)
      if (c.action === 'place') {
        const st = await lstatOrUndefined(target)
        if (st) {
          const unchanged = st.isFile() && c.placedSha1 !== undefined && (await hashLocal(target, {}, options.signal)).sha1 === c.placedSha1
          if (unchanged) {
            await rm(target, { force: true })
            result.removed.push(c.path)
          } else {
            const aside = resolveInside(path.join(backupDir, 'rollback-displaced'), c.path)
            await mkdir(path.dirname(aside), { recursive: true })
            await rm(aside, { recursive: true, force: true })
            await rename(target, aside)
            result.displaced.push(c.path)
          }
        }
      }
      if (c.hadPrevious) {
        const backup = resolveInside(backupDir, c.path)
        if (await lstatOrUndefined(backup)) {
          await mkdir(path.dirname(target), { recursive: true })
          await cp(backup, target, { recursive: true, force: true })
          result.restored.push(c.path)
        }
      } else {
        await pruneEmptyParents(instanceDir, target)
      }
    }
    if (journal.previousLock) await writeModpackLock(instanceDir, journal.previousLock)
    else await rm(lockPath(instanceDir), { force: true })
    await writeJournal(backupDir, { ...journal, rolledBackAt: Date.now() })
    return result
  })
}

// ---------------------------------------------------------------------------------------------
// Lock and unresolved list
// ---------------------------------------------------------------------------------------------

/** Lock entry for a target, using the best hashes we know. */
export function lockEntry(t: StageTarget, local?: LocalHashes): ModpackLockFile {
  const hashes: FileHashes = { ...t.hashes }
  if (local) {
    hashes.sha1 = local.sha1
    if (t.kind === 'file') hashes.crc32 = local.crc32
    if (local.sha512) hashes.sha512 = local.sha512
  }
  const entry: ModpackLockFile = { path: t.path, hashes, size: local?.size ?? t.size ?? 0, origin: t.origin }
  if (t.source.type === 'download' && t.source.urls.length > 0) entry.downloads = [...t.source.urls]
  if (t.optional) entry.optional = true
  if (t.kind === 'world') entry.kind = 'world'
  return entry
}

/** Write `.amethyst/unresolved.json`, or delete it when nothing is unresolved. */
export async function writeUnresolved(instanceDir: string, files: readonly ManualDownload[]): Promise<void> {
  const file = path.join(instanceDir, ...UNRESOLVED.split('/'))
  if (files.length === 0) await rm(file, { force: true })
  else await writeJsonAtomic(file, { schemaVersion: 1, files })
}
