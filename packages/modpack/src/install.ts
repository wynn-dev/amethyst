/* oxlint-disable no-await-in-loop -- files on disk are compared one at a time */
/**
 * Installing a resolved pack into an instance (`modpacks.md` §5, §7).
 */
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { ModpackError, throwIfAborted } from './errors'
import {
  assertSameInstance,
  buildTargets,
  cleanupOperation,
  commitChanges,
  diskState,
  instanceIdentity,
  lockEntry,
  newBackupDir,
  operationId,
  sameContent,
  stageTargets,
  withInstanceMutex,
  writeJournal,
  writeRecord,
  writeUnresolved,
  type CommitChange,
  type EngineHooks,
  type FetchOptions,
  type StageTarget,
} from './engine'
import { readModpackLock, writeModpackLock, type ModpackLock, type ModpackLockFile } from './lock'
import { matchManualFiles, type RejectedManualFile } from './manual'
import { pathKey } from './paths'
import type { ManualDownload, ModpackManifest, ModpackUpstream, ResolvedModpack } from './types'
import type { LocalHashes } from './util'

/** Options for {@link installModpack}. */
export interface InstallOptions extends FetchOptions {
  /** The instance root (the game directory). Created if missing. */
  instanceDir: string
  /**
   * Paths of the optional files to install. Defaults to each optional file's
   * `defaultSelected` (Modrinth optional: on; CurseForge `required: false`: off).
   */
  selectedOptional?: readonly string[]
  /** Files the user downloaded by hand for blocked CurseForge files; matched by hash. */
  manualFiles?: readonly string[]
  /**
   * Act only on these pack paths (e.g. the missing files a manual download fills in). Every
   * other file is left exactly as it is on disk and keeps its entry in the existing lock, so
   * configs the user changed since the install (or rows excluded from an update) are never
   * reverted to the pack's version.
   */
  only?: readonly string[]
  /** Recorded in the lock, e.g. `{ kind: 'modrinth', projectId, versionId }`. */
  upstream?: ModpackUpstream
  /** @internal Test hooks. */
  hooks?: EngineHooks
}

/** Result of {@link installModpack}. */
export interface InstallResult {
  /** Paths written into the instance. */
  installed: string[]
  /** Paths that were already present with the right content. */
  kept: string[]
  /** Paths whose previous (different) content was moved to the backup folder. */
  backedUp: string[]
  /** Backup folder id under `.amethyst/backups/` (for {@link rollbackModpackOperation}). */
  backupId: string
  /** Blocked files still missing; listed in `.amethyst/unresolved.json`. */
  unresolved: ManualDownload[]
  /** User-supplied manual files that matched nothing. */
  rejectedManualFiles: RejectedManualFile[]
  /** Optional files left out. */
  deselected: string[]
  lock: ModpackLock
}

/** Resolve the effective optional selection. */
export function selectionFor(resolved: ResolvedModpack, selected: readonly string[] | undefined): (f: { path: string; defaultSelected: boolean }) => boolean {
  if (!selected) return (f) => f.defaultSelected
  const keys = new Set(selected.map(pathKey))
  return (f) => keys.has(pathKey(f.path))
}

/** Swap `none` sources of blocked files for the user's matching manual files. */
export async function applyManualFiles(
  targets: StageTarget[],
  files: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<RejectedManualFile[]> {
  const blocked = targets.filter((t) => t.source.type === 'none' && t.manual)
  if (!files?.length) return []
  const { matched, rejected } = await matchManualFiles(files, blocked.map((t) => t.manual as ManualDownload), signal)
  for (const m of matched) {
    const t = blocked.find((b) => b.manual === m.expected)
    if (t) t.source = { type: 'manual', file: m.file }
  }
  return rejected
}

/**
 * Install `resolved` into `instanceDir`.
 *
 * Every file is staged and verified first (resuming the workspace of an earlier interrupted
 * attempt, then trying the content store, the pack archive, manual files and HTTPS); only then
 * is anything moved into the instance. Files already present with the right content are kept.
 * Existing files with different content are moved to `.amethyst/backups/modpack-<ts>/`. On
 * success the lock (`.amethyst/modpack.lock.json`) is written. Blocked CurseForge files that the
 * user has not supplied yet do not stop the install: they are listed in `unresolved` and in
 * `.amethyst/unresolved.json`; call again with `manualFiles` to add them.
 *
 * @throws {ModpackError} `EINSTALL_INCOMPLETE` (with `failed`) when any file could not be
 * fetched. Nothing in the instance changed; calling again resumes. `ECOMMIT` when moving files
 * failed (rolled back), `EINSTANCE_GONE`, or an abort error when cancelled (resumable).
 */
export async function installModpack(manifest: ModpackManifest, resolved: ResolvedModpack, options: InstallOptions): Promise<InstallResult> {
  const instanceDir = path.resolve(options.instanceDir)
  const signal = options.signal ?? options.ctx?.signal
  throwIfAborted(signal)
  await mkdir(instanceDir, { recursive: true })
  return withInstanceMutex(instanceDir, async () => {
    const identity = await instanceIdentity(instanceDir)
    const previousLock = await readModpackLock(instanceDir).catch(() => undefined)
    const built = buildTargets(manifest, resolved, selectionFor(resolved, options.selectedOptional))
    const onlyKeys = options.only ? new Set(options.only.map(pathKey)) : undefined
    const targets = onlyKeys ? built.targets.filter((t) => onlyKeys.has(pathKey(t.path))) : built.targets
    const deselected = onlyKeys && previousLock ? previousLock.deselected : built.deselected
    const rejectedManualFiles = await applyManualFiles(targets, options.manualFiles, signal)

    const opId = operationId('install', manifest.sha1)
    await writeRecord(instanceDir, { schemaVersion: 1, id: opId, kind: 'install', packSha1: manifest.sha1, createdAt: Date.now(), state: 'staging' })

    // Compare with what is already there.
    const kept = new Map<string, LocalHashes | undefined>()
    const toStage: StageTarget[] = []
    const unresolved: ManualDownload[] = []
    const run = async <T>(name: string, fn: () => Promise<T>) => (options.ctx ? options.ctx.child(name, () => fn()) : fn())
    await run('check', async () => {
      for (const t of targets) {
        throwIfAborted(signal)
        const disk = await diskState(instanceDir, t.path, [t.hashes], signal)
        if (disk.exists && (disk.dir ? t.kind === 'world' : t.kind === 'file' && sameContent(t.hashes, t.size, disk.hashes))) {
          kept.set(t.path, disk.dir ? undefined : disk.hashes)
          continue
        }
        if (t.source.type === 'none') {
          if (t.manual) unresolved.push(t.manual)
          continue
        }
        toStage.push(t)
      }
    })

    const { staged, failed } = await (options.ctx
      ? options.ctx.child('stage', (ctx) => stageTargets(instanceDir, opId, toStage, { ...options, ctx }), { weight: 4 })
      : stageTargets(instanceDir, opId, toStage, options))
    if (failed.length > 0) {
      throw new ModpackError('EINSTALL_INCOMPLETE', `${failed.length} file${failed.length === 1 ? '' : 's'} could not be downloaded; nothing was changed. Retry to resume.`, { failed })
    }
    throwIfAborted(signal)
    await assertSameInstance(instanceDir, identity)

    const backupId = path.posix.basename(await newBackupDir(instanceDir))
    const backupRel = `.amethyst/backups/${backupId}`
    const changes: CommitChange[] = staged.map((s) => ({ path: s.target.path, action: 'place', kind: s.target.kind, staged: s.staged }))
    await writeRecord(instanceDir, {
      schemaVersion: 1,
      id: opId,
      kind: 'install',
      packSha1: manifest.sha1,
      createdAt: Date.now(),
      state: 'committing',
      backupDir: backupRel,
      changes: changes.map(({ path: p, action, kind }) => ({ path: p, action, kind })),
    })
    const commit = () => commitChanges(instanceDir, opId, backupRel, changes, options.hooks)
    const backedUp = await (options.ctx ? options.ctx.child('commit', commit) : commit())

    const stagedByPath = new Map(staged.map((s) => [s.target.path, s.hashes]))
    const lockFiles: ModpackLockFile[] = []
    for (const t of targets) {
      if (kept.has(t.path)) lockFiles.push(lockEntry(t, kept.get(t.path)))
      else if (stagedByPath.has(t.path)) lockFiles.push(lockEntry(t, stagedByPath.get(t.path)))
    }
    if (onlyKeys && previousLock) {
      // A partial install keeps the lock entries of everything it did not touch.
      const touched = new Set(lockFiles.map((f) => pathKey(f.path)))
      lockFiles.unshift(...previousLock.files.filter((f) => !touched.has(pathKey(f.path))))
    }
    const lock: ModpackLock = {
      schemaVersion: 1,
      source: manifest.format,
      upstream: options.upstream ? { ...options.upstream, packSha1: manifest.sha1 } : onlyKeys ? previousLock?.upstream : undefined,
      pack: { name: manifest.name, version: manifest.version, sha1: manifest.sha1, minecraft: manifest.minecraft, loader: manifest.loader },
      installedAt: Date.now(),
      files: lockFiles,
      deselected,
    }
    await writeJournal(path.join(instanceDir, ...backupRel.split('/')), {
      schemaVersion: 1,
      kind: 'install',
      createdAt: Date.now(),
      packSha1: manifest.sha1,
      previousLock: previousLock ?? null,
      changes: staged.map((s) => ({
        path: s.target.path,
        action: 'place',
        kind: s.target.kind,
        hadPrevious: backedUp.includes(s.target.path),
        placedSha1: s.target.kind === 'file' ? s.hashes.sha1 : undefined,
      })),
    })
    await writeModpackLock(instanceDir, lock)
    await writeUnresolved(instanceDir, unresolved)
    await cleanupOperation(instanceDir, opId)
    return {
      installed: staged.map((s) => s.target.path),
      kept: [...kept.keys()],
      backedUp,
      backupId,
      unresolved,
      rejectedManualFiles,
      deselected,
      lock,
    }
  })
}
