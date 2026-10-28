/**
 * Modrinth `.mrpack` and CurseForge modpack import, update and export.
 *
 * The pipeline (`docs/specs/modpacks.md`):
 *
 * 1. {@link readModpack} opens a pack (no side effects): detects the format, validates the
 *    manifest, maps the loader and lists override files, dropping unsafe paths.
 * 2. {@link resolveModpackFiles} turns manifest entries into installable files. CurseForge ids
 *    are looked up in bisecting batches and routed by `classId`; files without a download URL
 *    become {@link ManualDownload}s (never guessed CDN URLs). Modrinth `env.client` is honoured
 *    and optional files are surfaced as a choice.
 * 3. {@link installModpack} stages and verifies everything, then commits atomically and writes
 *    the lock (`.amethyst/modpack.lock.json`). Interrupted installs resume from the workspace.
 *    {@link matchManualFiles} / {@link watchForManualFiles} accept hand-downloaded files by hash.
 * 4. {@link planModpackUpdate} computes a hash-based three-way diff (lock, new pack, disk);
 *    {@link applyModpackUpdate} applies it only after every download succeeded, backing up
 *    replaced and removed files, and {@link rollbackModpackUpdate} reverses it.
 * 5. {@link exportModrinth} / {@link exportCurseForge} stream an instance into a pack, linking
 *    files the platform knows and embedding the rest, with private data excluded.
 *
 * Pure Node: no Electron imports. Errors are {@link ModpackError}s with a stable `code`.
 */
export { abortError, isModpackError, ModpackError, type ModpackErrorCode, type ModpackErrorDetails } from './errors'
export { deriveName, MODRINTH_ALLOWED_HOSTS, readModpack, type ReadModpackOptions } from './read'
export { curseForgeLoaderId, loaderFromModrinthKey, MODRINTH_LOADER_KEYS, normaliseLoaderVersion, parseCurseForgeLoaderId } from './loader'
export { checkPackPath, RESERVED_ROOTS, type PathCheck } from './paths'
export {
  lookupInBatches,
  modrinthIdsFromUrl,
  resolveModpackFiles,
  type CurseForgeLookup,
  type ModrinthLookup,
  type ResolveOptions,
} from './resolve'
export { installModpack, type InstallOptions, type InstallResult } from './install'
export {
  discardIncompleteOperation,
  listIncompleteOperations,
  recoverInterruptedCommits,
  rollbackModpackOperation,
  waitForCommits,
  type BackupJournal,
  type EngineHooks,
  type FetchOptions,
  type IncompleteOperation,
  type RollbackResult,
  type StageSource,
  type StageTarget,
} from './engine'
export { LOCK_FILE, lockPath, parseModpackLock, readModpackLock, writeModpackLock, type ModpackLock, type ModpackLockFile } from './lock'
export {
  matchManualFiles,
  watchForManualFiles,
  type ManualFileMatch,
  type ManualFileWatcher,
  type RejectedManualFile,
  type WatchManualOptions,
} from './manual'
export {
  applyModpackUpdate,
  planModpackUpdate,
  rollbackModpackUpdate,
  type ApplyUpdateOptions,
  type ConflictKind,
  type ModpackUpdatePlan,
  type PlanUpdateOptions,
  type UpdateAction,
  type UpdateChange,
  type UpdateResult,
} from './update'
export {
  DEFAULT_EXPORT_EXCLUDES,
  DEFAULT_STRIPPED_OPTIONS,
  exportCurseForge,
  exportModrinth,
  isNeverExported,
  NEVER_EXPORT,
  stripOptionsText,
  type EmbedReason,
  type ExportCurseForgeOptions,
  type ExportModrinthOptions,
  type ExportOptions,
  type ExportResult,
} from './export'
export type * from './types'
