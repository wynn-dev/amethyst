/**
 * Installers for Minecraft, Forge, NeoForge, Fabric and Quilt.
 *
 * The usual flow is {@link planInstall} (metadata only: resolves versions, lists steps with their
 * sizes) followed by {@link runInstall} (downloads, writes version JSONs, runs Forge/NeoForge
 * processors, writes `.install-lock`). Each stage is also exported on its own:
 * {@link installVanilla}, {@link installFabricLike}, {@link installForge}, {@link installNeoForge}.
 * {@link installMissing} and {@link repairVersion} fix what `@amethyst/game`'s `diagnose` reports.
 *
 * Every installer takes `{ root, signal?, ctx?, http? }`, reports progress through weighted child
 * tasks of `ctx`, and is idempotent: verified files are skipped and bad ones replaced. Every file
 * is checksum-verified when a checksum exists (maven `.sha1` sidecars are fetched for loader
 * libraries that publish none); executable installer jars **must** verify or the install fails
 * closed. Metadata comes from {@link createMetadataClient}, which caches and validates the Mojang
 * manifest v2, Fabric/Quilt meta, and the Forge/NeoForge mavens.
 *
 * Pure Node: no Electron imports. Errors are {@link InstallError}s with stable codes.
 */
export { InstallError, ProcessorError, ProcessorOutputError, type InstallErrorCode } from './errors'
export { checkFile, ensureFiles, isValidZip, type EnsureFilesOptions, type EnsureFilesResult, type FileProblem, type FileSpec } from './files'
export { ASSETS_BASE_URL, defaultPlatform, type InstallOptions } from './options'
export { compareMinecraftVersions, parseMinecraftVersion, requiredJavaMajor, type ParsedMinecraftVersion } from './minecraft-version'
export { checkVersionJson, parseVersionManifest, type ManifestVersion, type RawVersionJson, type VersionManifest } from './version-json'
export { fetchSidecarHash, parseSidecar, requireSidecarHash, type SidecarAlgorithm, type VerifiedHash } from './sidecar'
export { fillMissingHashes, layerLibrarySpecs, libraryFileSpec, libraryUrls, resolveInstalled, toolLibrarySpecs, versionLibrarySpecs } from './libraries'

export { MetadataCache, type CacheGetOptions, type CacheResult, type MetadataCacheOptions } from './meta/cache'
export {
  createMetadataClient,
  DEFAULT_ENDPOINTS,
  type MetaCallOptions,
  type MetadataClient,
  type MetadataClientOptions,
  type MetadataEndpoints,
} from './meta/client'
export {
  fabricLikeVersionId,
  parseLoaderGameVersions,
  parseLoaderProfile,
  parseLoaderVersions,
  type FabricLikeKind,
  type LoaderGameVersion,
  type LoaderVersion,
} from './meta/fabric'
export {
  forgeInstallKind,
  forgeVersionsFrom,
  parseForgeArtifactVersion,
  parseForgeFiles,
  parseForgePromotions,
  parseMavenMetadata,
  type ForgeFiles,
  type ForgeInstallKind,
  type ForgeVersion,
} from './meta/forge'
export {
  compareNeoForgeVersions,
  neoForgeMinecraftVersion,
  neoForgeProjectOf,
  neoForgeVersionsFrom,
  type NeoForgeProject,
  type NeoForgeVersion,
} from './meta/neoforge'

export {
  assetMetadataSpecs,
  clientJarSpec,
  installAssets,
  installClientJar,
  installLibraries,
  installVanilla,
  installVanillaFiles,
  installVersionJson,
  type InstallVanillaOptions,
  type VersionJsonSource,
} from './vanilla'
export { installFabricLike, type InstallFabricLikeOptions, type LoaderInstallResult } from './fabric'

export { type ForgeInstallOptions } from './forge/common'
export { installForge, installFromInstaller, installNeoForge, type ForgeFormat, type ForgeInstallResult, type InstallForgeOptions } from './forge/index'
export { artifactCoordinate, artifactPath, artifactUrl, downloadVerifiedArtifact, type ForgeArtifact, type VerifiedDownloadOptions } from './forge/installer-jar'
export { installModern, rerunStoredProfile, type ModernInstallResult } from './forge/modern'
export { installLegacy, type LegacyInstallResult } from './forge/legacy'
export { installUniversal, LEGACY_FML_LIBRARIES, mergeJars, type UniversalInstallResult } from './forge/universal'
export {
  isLegacyProfile,
  parseLegacyProfile,
  parseModernProfile,
  type LegacyProfile,
  type ModernProfile,
  type Processor,
  type ProfileData,
} from './forge/profile'
export {
  buildVariables,
  libraryPathOf,
  processorOutputs,
  readMainClass,
  resolveDataValue,
  runProcessors,
  spawnProcessor,
  substituteArgument,
  type ProcessorInvocation,
  type ProcessorOutput,
  type ProcessorRunner,
  type ProcessorRunOptions,
  type ProcessorRunResult,
  type RunProcessorsOptions,
  type RunProcessorsResult,
  type Side,
  type VariableContext,
} from './forge/processors'

export {
  installMissing,
  issueFileSpec,
  repairVersion,
  type InstallMissingResult,
  type MissingFile,
  type RepairOptions,
  type RepairResult,
} from './repair'
export {
  planInstall,
  runInstall,
  type InstallLock,
  type InstallPlan,
  type InstallRequest,
  type InstallResult,
  type LoaderKind,
  type PlanOptions,
  type PlannedLoader,
  type PlanStep,
  type PlanStepId,
  type RunInstallOptions,
} from './plan'
