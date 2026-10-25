/* oxlint-disable no-await-in-loop -- files on disk are compared one at a time */
/**
 * Updating an instance to another version of its pack (`modpacks.md` §6).
 *
 * {@link planModpackUpdate} computes a three-way diff between the lock (what the installed
 * version owns), the new version's files and what is on disk now, using **content hashes**,
 * never mtimes. {@link applyModpackUpdate} stages every new file first and touches the instance
 * only once all of them are ready; replaced and removed files are moved to
 * `.amethyst/backups/modpack-<ts>/`, and {@link rollbackModpackUpdate} reverses it.
 *
 * Invariants (known issues #971/#1040):
 * - Files on disk that neither the old lock nor the new pack lists are user files and are never touched.
 * - Optional files the user deselected stay deselected.
 * - A row the user excludes from the plan is left exactly as it is.
 * - A failed download leaves the instance unchanged.
 */
import path from 'node:path'
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
  rollbackModpackOperation,
  sameContent,
  stageTargets,
  withInstanceMutex,
  writeJournal,
  writeRecord,
  writeUnresolved,
  type CommitChange,
  type EngineHooks,
  type FetchOptions,
  type RollbackResult,
  type StageTarget,
} from './engine'
import { applyManualFiles } from './install'
import { writeModpackLock, type ModpackLock, type ModpackLockFile } from './lock'
import type { RejectedManualFile } from './manual'
import { pathKey } from './paths'
import type { ManualDownload, ModpackLoader, ModpackManifest, ModpackUpstream, ResolvedModpack } from './types'
import type { LocalHashes } from './util'

/** What applying the plan does to one path. */
export type UpdateAction = 'add' | 'update' | 'remove' | 'keep' | 'conflict'

/**
 * Why a path is a conflict. The default resolution backs up the user's copy, then:
 * - `modified-replaced`: the user changed a pack file that the new version changes too → write the new one.
 * - `modified-removed`: the user changed a pack file that the new version drops → remove it.
 * - `unmanaged-replaced`: a file the lock does not know is in the way of a new pack file → write the new one.
 */
export type ConflictKind = 'modified-replaced' | 'modified-removed' | 'unmanaged-replaced'

/** One row of the update preview. */
export interface UpdateChange {
  path: string
  action: UpdateAction
  conflict?: ConflictKind
  /** The new version of the file (absent for removals). */
  target?: StageTarget
  /** The old lock entry, when the lock knows the path. */
  previous?: ModpackLockFile
  /** Hashes of the file on disk at plan time (absent when missing or a folder). */
  disk?: LocalHashes
}

/** Output of {@link planModpackUpdate}; pass it to {@link applyModpackUpdate}. */
export interface ModpackUpdatePlan {
  instanceDir: string
  manifest: ModpackManifest
  resolved: ResolvedModpack
  previousLock: ModpackLock | undefined
  add: UpdateChange[]
  update: UpdateChange[]
  remove: UpdateChange[]
  keep: UpdateChange[]
  conflicts: UpdateChange[]
  /** Optional files of the new version that will not be installed. */
  deselected: string[]
  /** Blocked files that will need a manual download. */
  manualDownloads: ManualDownload[]
  /** Minecraft / loader change, for the preview banner. */
  runtime: { from: { minecraft: string; loader: ModpackLoader | null } | null; to: { minecraft: string; loader: ModpackLoader | null } }
}

/** Options for {@link planModpackUpdate}. */
export interface PlanUpdateOptions {
  /**
   * Optional files to install. Default: optional files installed before stay installed, files
   * deselected before stay deselected, and new optional files use their default.
   */
  selectedOptional?: readonly string[]
  signal?: AbortSignal
}

/**
 * Compute the update diff. `lock` may be undefined (an instance with no lock): then every pack
 * file that already exists with different content becomes a `conflict` (`unmanaged-replaced`)
 * so nothing is overwritten without a backup.
 */
export async function planModpackUpdate(
  lock: ModpackLock | undefined,
  newManifest: ModpackManifest,
  resolved: ResolvedModpack,
  instanceDir: string,
  options: PlanUpdateOptions = {},
): Promise<ModpackUpdatePlan> {
  const dir = path.resolve(instanceDir)
  const { signal } = options
  throwIfAborted(signal)
  const oldByKey = new Map((lock?.files ?? []).map((f) => [pathKey(f.path), f]))
  const wasDeselected = new Set((lock?.deselected ?? []).map(pathKey))
  const chosen = options.selectedOptional ? new Set(options.selectedOptional.map(pathKey)) : undefined
  const isSelected = (f: { path: string; defaultSelected: boolean }) => {
    const key = pathKey(f.path)
    if (chosen) return chosen.has(key)
    if (oldByKey.has(key)) return true
    if (wasDeselected.has(key)) return false
    return f.defaultSelected
  }
  const { targets, deselected } = buildTargets(newManifest, resolved, isSelected)
  const newByKey = new Map(targets.map((t) => [pathKey(t.path), t]))

  const plan: ModpackUpdatePlan = {
    instanceDir: dir,
    manifest: newManifest,
    resolved,
    previousLock: lock,
    add: [],
    update: [],
    remove: [],
    keep: [],
    conflicts: [],
    deselected,
    manualDownloads: [],
    runtime: {
      from: lock ? { minecraft: lock.pack.minecraft, loader: lock.pack.loader } : null,
      to: { minecraft: newManifest.minecraft, loader: newManifest.loader },
    },
  }

  // CurseForge files the new version still lists but the API could not return: never remove them.
  const stillListed = new Set(resolved.skipped.flatMap((s) => (s.reason === 'missing-on-curseforge' && s.fileId !== undefined ? [s.fileId] : [])))
  const listedButUnavailable = (f: ModpackLockFile | undefined) => (f?.origin.kind === 'curseforge' || f?.origin.kind === 'manual') && stillListed.has(f.origin.fileId)

  const keys = new Set([...oldByKey.keys(), ...newByKey.keys()])
  for (const key of keys) {
    throwIfAborted(signal)
    const target = newByKey.get(key)
    const previous = oldByKey.get(key)
    const rel = (target ?? previous)!.path
    const isWorld = target?.kind === 'world' || previous?.kind === 'world'
    const disk = await diskState(dir, previous?.path ?? rel, [target?.hashes ?? {}, previous?.hashes ?? {}], signal)
    const row: UpdateChange = { path: rel, action: 'keep', target, previous }

    if (!disk.exists) {
      if (!target) continue
      row.action = 'add'
    } else if (disk.dir || isWorld) {
      // Worlds are user data once installed: add them when missing, never replace or remove them.
      if (!target) continue
      row.action = 'keep'
    } else {
      row.disk = disk.hashes
      const userChanged = previous ? !sameContent(previous.hashes, previous.size || undefined, disk.hashes) : undefined
      if (target) {
        const caseRename = previous !== undefined && previous.path !== target.path
        const same = sameContent(target.hashes, target.size, disk.hashes)
        if (same && !caseRename) row.action = 'keep'
        else if (userChanged === false || (same && caseRename)) row.action = 'update'
        else {
          row.action = 'conflict'
          row.conflict = userChanged === true ? 'modified-replaced' : 'unmanaged-replaced'
        }
      } else if (listedButUnavailable(previous)) {
        row.action = 'keep'
      } else if (userChanged === false) {
        row.action = 'remove'
      } else {
        row.action = 'conflict'
        row.conflict = 'modified-removed'
      }
    }
    if (target?.source.type === 'none' && target.manual && row.action !== 'keep') plan.manualDownloads.push(target.manual)
    const bucket = { add: plan.add, update: plan.update, remove: plan.remove, keep: plan.keep, conflict: plan.conflicts }[row.action]
    bucket.push(row)
  }
  return plan
}

/** Options for {@link applyModpackUpdate}. */
export interface ApplyUpdateOptions extends FetchOptions {
  /** Paths of plan rows the user unchecked; they are left exactly as they are. */
  exclude?: readonly string[]
  /** Files the user downloaded by hand for blocked CurseForge files. */
  manualFiles?: readonly string[]
  /** The **target** version chosen by the user; recorded in the new lock. */
  upstream?: ModpackUpstream
  /** @internal Test hooks. */
  hooks?: EngineHooks
}

/** Result of {@link applyModpackUpdate}. */
export interface UpdateResult {
  /** Backup folder id under `.amethyst/backups/`; pass it to {@link rollbackModpackUpdate}. */
  backupId: string
  added: string[]
  updated: string[]
  removed: string[]
  /** Paths whose previous content was moved to the backup folder. */
  backedUp: string[]
  /** Rows skipped because the user excluded them. */
  excluded: string[]
  /** Blocked files that are still missing. */
  unresolved: ManualDownload[]
  rejectedManualFiles: RejectedManualFile[]
  lock: ModpackLock
}

/**
 * Apply an update plan. All new files are staged and verified first; if any cannot be fetched,
 * nothing in the instance changes (`EINSTALL_INCOMPLETE`, resumable by calling again). Then
 * replaced and removed files are moved to the backup folder and the new files are moved in;
 * a failure there rolls everything back (`ECOMMIT`). Finally the new lock is written. Rows the
 * user excluded still appear in the new lock as the pack's files (`modpacks.md` §6.3.7), so they
 * count as user deviations on the next update.
 */
export async function applyModpackUpdate(plan: ModpackUpdatePlan, options: ApplyUpdateOptions = {}): Promise<UpdateResult> {
  const instanceDir = plan.instanceDir
  const signal = options.signal ?? options.ctx?.signal
  throwIfAborted(signal)
  return withInstanceMutex(instanceDir, async () => {
    const identity = await instanceIdentity(instanceDir)
    const excluded = new Set((options.exclude ?? []).map(pathKey))
    const isExcluded = (c: UpdateChange) => excluded.has(pathKey(c.path))
    const rows = [...plan.add, ...plan.update, ...plan.conflicts, ...plan.remove]
    const active = rows.filter((c) => !isExcluded(c))
    const placing = active.filter((c) => c.target && c.action !== 'remove' && c.conflict !== 'modified-removed')
    const removing = active.filter((c) => c.action === 'remove' || c.conflict === 'modified-removed')

    // Fresh copies so manual-file matching does not mutate the plan.
    const targets = placing.map((c) => ({ ...(c.target as StageTarget) }))
    const rejectedManualFiles = await applyManualFiles(targets, options.manualFiles, signal)
    const unresolved = targets.filter((t) => t.source.type === 'none').map((t) => t.manual).filter((m): m is ManualDownload => m !== undefined)
    const toStage = targets.filter((t) => t.source.type !== 'none')

    const opId = operationId('update', plan.manifest.sha1)
    await writeRecord(instanceDir, { schemaVersion: 1, id: opId, kind: 'update', packSha1: plan.manifest.sha1, createdAt: Date.now(), state: 'staging' })
    const { staged, failed } = await (options.ctx
      ? options.ctx.child('stage', (ctx) => stageTargets(instanceDir, opId, toStage, { ...options, ctx }), { weight: 4 })
      : stageTargets(instanceDir, opId, toStage, options))
    if (failed.length > 0) {
      throw new ModpackError('EINSTALL_INCOMPLETE', `${failed.length} file${failed.length === 1 ? '' : 's'} could not be downloaded; the instance was not changed. Retry to resume.`, { failed })
    }
    throwIfAborted(signal)
    await assertSameInstance(instanceDir, identity)

    const backupId = path.posix.basename(await newBackupDir(instanceDir))
    const backupRel = `.amethyst/backups/${backupId}`
    const stagedKeys = new Set(staged.map((s) => pathKey(s.target.path)))
    // A case-only rename removes the old spelling before writing the new one.
    const renamed = placing.filter((c) => c.previous && c.target && c.previous.path !== c.target.path && stagedKeys.has(pathKey(c.path)))
    const changes: CommitChange[] = [
      ...[...removing, ...renamed].map((c): CommitChange => ({ path: c.previous?.path ?? c.path, action: 'remove', kind: 'file' })),
      ...staged.map((s): CommitChange => ({ path: s.target.path, action: 'place', kind: s.target.kind, staged: s.staged })),
    ]
    await writeRecord(instanceDir, {
      schemaVersion: 1,
      id: opId,
      kind: 'update',
      packSha1: plan.manifest.sha1,
      createdAt: Date.now(),
      state: 'committing',
      backupDir: backupRel,
      changes: changes.map(({ path: p, action, kind }) => ({ path: p, action, kind })),
    })
    const commit = () => commitChanges(instanceDir, opId, backupRel, changes, options.hooks)
    const backedUp = await (options.ctx ? options.ctx.child('commit', commit) : commit())

    // New lock: the new pack's file list, with the hashes now on disk where we know them.
    const stagedByKey = new Map(staged.map((s) => [pathKey(s.target.path), s.hashes]))
    const files: ModpackLockFile[] = []
    for (const c of [...plan.add, ...plan.update, ...plan.conflicts, ...plan.keep]) {
      if (!c.target && c.action === 'keep' && c.previous) files.push(c.previous)
      if (!c.target || c.conflict === 'modified-removed') continue
      const key = pathKey(c.path)
      const local = stagedByKey.get(key) ?? (c.action === 'keep' ? c.disk : undefined)
      if (!local && c.target.source.type === 'none' && !isExcluded(c)) continue
      if (!local && !c.target.hashes.sha1 && !c.target.hashes.crc32 && !c.target.hashes.sha512 && !c.target.hashes.md5) continue
      files.push(lockEntry(c.target, local))
    }
    const lock: ModpackLock = {
      schemaVersion: 1,
      source: plan.manifest.format,
      // The upstream is the version the user chose, never cached metadata (pitfall 10).
      upstream: options.upstream ? { ...options.upstream, packSha1: plan.manifest.sha1 } : plan.previousLock?.upstream,
      pack: {
        name: plan.manifest.name,
        version: plan.manifest.version,
        sha1: plan.manifest.sha1,
        minecraft: plan.manifest.minecraft,
        loader: plan.manifest.loader,
      },
      installedAt: Date.now(),
      files,
      deselected: plan.deselected,
    }

    await writeJournal(path.join(instanceDir, ...backupRel.split('/')), {
      schemaVersion: 1,
      kind: 'update',
      createdAt: Date.now(),
      packSha1: plan.manifest.sha1,
      previousLock: plan.previousLock ?? null,
      changes: changes.map((c) => ({
        path: c.path,
        action: c.action,
        kind: c.kind,
        hadPrevious: backedUp.includes(c.path),
        placedSha1: c.action === 'place' && c.kind === 'file' ? stagedByKey.get(pathKey(c.path))?.sha1 : undefined,
      })),
    })
    await writeModpackLock(instanceDir, lock)
    await writeUnresolved(instanceDir, unresolved)
    await cleanupOperation(instanceDir, opId)

    const placedKeys = new Set(staged.map((s) => pathKey(s.target.path)))
    const pick = (list: UpdateChange[]) => list.filter((c) => placedKeys.has(pathKey(c.path))).map((c) => c.path)
    return {
      backupId,
      added: pick(plan.add),
      updated: [...pick(plan.update), ...pick(plan.conflicts)],
      removed: removing.map((c) => c.path),
      backedUp,
      excluded: rows.filter(isExcluded).map((c) => c.path),
      unresolved,
      rejectedManualFiles,
      lock,
    }
  })
}

/**
 * Restore the state before an update ("Restore previous version"): files the update placed are
 * removed (set aside if the user changed them since), backed-up files are restored, and the
 * previous lock is written back. Backup files stay in place.
 */
export function rollbackModpackUpdate(instanceDir: string, backupId: string, options: { signal?: AbortSignal } = {}): Promise<RollbackResult> {
  return rollbackModpackOperation(path.resolve(instanceDir), backupId, options)
}
