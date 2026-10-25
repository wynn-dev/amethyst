/**
 * Instance content: mods, resource packs, shader packs, saves and `options.txt`.
 *
 * - **Mods:** {@link readModMetadata} reads Fabric, Quilt, Forge, NeoForge, legacy Forge
 *   (`mcmod.info`, tweaker manifests) and LiteLoader descriptors from one jar, keeping each
 *   loader's view for multi-loader jars. Malformed descriptors become warnings, never throws.
 * - **Packs:** {@link readResourcePack} (`pack.mcmeta`, text-component descriptions) and
 *   {@link readShaderPack}, for zips and folders alike.
 * - **Saves:** {@link readLevelDat} / {@link listSaves}, world export and import
 *   ({@link exportWorld}, {@link importWorld}) and backups ({@link backupWorld},
 *   {@link restoreBackup}, {@link pruneBackups}).
 * - **Files:** streaming multi-digest {@link hashFile}, the content-addressed
 *   {@link ContentStore} (APFS clone → hard link → copy) and cached folder scans
 *   ({@link scanContentFolder}) that can run in a worker ({@link createScanWorkerHandlers}).
 *
 * Everything is pure Node with no global state, so it can run in the main process or in a
 * `worker_threads` worker. Long operations accept an `AbortSignal` and/or a `TaskContext`.
 * Thrown errors are {@link ContentError}s with a stable `code`.
 */
export { classifyError, ContentError, type ContentErrorCode, type FileProblem, type FileProblemCode } from './errors'
export { hashFile, hashStream, isSha1, MultiHasher, type HashAlgorithm, type HashOptions, type HashResult } from './hash'
export { parseFabricModJson } from './mods/fabric'
export { parseModsToml, type ModsTomlOptions } from './mods/forge'
export { parseLegacyDependencyString, parseLitemodJson, parseMcmodInfo } from './mods/legacy'
export { parseManifest } from './mods/manifest'
export { parseQuiltModJson } from './mods/quilt'
export { readModMetadata, withPreferredLoader, type ReadModOptions } from './mods/read'
export {
  preferredLoaderOrder,
  type DependencyKind,
  type InstanceLoader,
  type LoaderModMetadata,
  type ModDependency,
  type ModLinks,
  type ModLoader,
  type ModMetadata,
  type ModSide,
  type ParseWarning,
  type ParseWarningCode,
} from './mods/types'
export {
  disableResourcePack,
  enableResourcePack,
  GameOptions,
  isFilePackId,
  orderResourcePacks,
  packIdKey,
  packNameFromId,
  parsePackList,
  readOptionsFile,
  resourcePackId,
  serializePackList,
  writeOptionsFile,
} from './options'
export {
  parsePackMcmeta,
  readResourcePack,
  type PackVersion,
  type PackWarning,
  type PackWarningCode,
  type ResourcePackInfo,
} from './packs/resourcepack'
export { readShaderPack, type ShaderPackInfo } from './packs/shaderpack'
export { openPackSource, readPackFile, type PackSource } from './packs/source'
export { flattenTextComponent, stripFormatting } from './packs/text'
export { isPathInside, pathKey, samePath, sanitizeFileName, splitExtension, uniqueName } from './paths'
export {
  exportWorld,
  findWorldRoot,
  importWorld,
  importWorldFolder,
  type ImportedWorld,
  type WorldOperationOptions,
  type WorldRoot,
  type WorldZipResult,
} from './saves/archive'
export {
  backupWorld,
  deleteBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  type BackupInfo,
  type BackupOptions,
  type BackupReason,
  type PruneBackupsOptions,
  type RestoreOptions,
  type RestoreResult,
} from './saves/backup'
export {
  directorySize,
  levelInfoFromNbt,
  listSaves,
  readLevelDat,
  readSave,
  type Difficulty,
  type GameMode,
  type LevelInfo,
  type ReadSaveOptions,
  type SaveInfo,
} from './saves/level'
export {
  createMemoryScanCache,
  isContentFileName,
  PARSER_VERSION,
  scanCacheKey,
  scanContentFolder,
  setEnabled,
  stripDisabled,
  type ContentEntry,
  type ContentKind,
  type MemoryScanCache,
  type ScanCache,
  type ScanCacheRecord,
  type ScanOptions,
  type ScanReaders,
  type ScanResult,
  type ScanStats,
  type SetEnabledOptions,
} from './scan'
export {
  ContentStore,
  type ContentStoreOptions,
  type GcOptions,
  type IngestOptions,
  type IngestResult,
  type PlaceMethod,
  type PlaceOptions,
  type StoreFs,
} from './store'
export {
  createScanWorkerClient,
  createScanWorkerHandlers,
  ScanWorkerError,
  serveScanWorker,
  type MessagePortLike,
  type ScanWorkerClient,
  type ScanWorkerHandlers,
  type ScanWorkerRequest,
  type ScanWorkerResponse,
  type WorkerScanOptions,
} from './worker'
