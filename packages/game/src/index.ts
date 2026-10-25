/**
 * Version JSON model, version resolution and game launch for macOS on Apple Silicon.
 *
 * Typical launch flow:
 *
 * 1. {@link resolveVersion} reads `versions/<id>/<id>.json` and its `inheritsFrom` parents and
 *    merges them (rules are not evaluated yet).
 * 2. Pick a JVM from `javaVersion`, probe its architecture, then {@link planNatives} decides the
 *    libraries for that JVM, substituting arm64 builds for x86_64-only natives.
 * 3. {@link diagnose} lists missing or corrupt files for the installer to repair.
 * 4. {@link extractNatives} and {@link prepareLegacyAssets} prepare the natives directory and the
 *    legacy asset trees.
 * 5. {@link buildLaunchCommand} builds the argv, and {@link launch} spawns and watches the game.
 *
 * Pure Node: no Electron imports. Long operations accept an `AbortSignal` and, where useful, an
 * optional `TaskContext` from `@amethyst/task`. Errors are {@link GameError}s with stable codes.
 */
export { GameError, type GameErrorCode } from './errors'
export {
  parseVersionJson,
  validateVersionJson,
  type Argument,
  type Artifact,
  type AssetIndexRef,
  type DownloadEntry,
  type JavaVersionRef,
  type LibraryJson,
  type LoggingClient,
  type Rule,
  type RuleOs,
  type VersionJson,
} from './schema'
export { compareVersions, formatMavenName, libraryKey, mavenPath, parseMavenName, pathToMaven, type MavenCoordinate } from './maven'
export {
  darwinToMacosVersion,
  evaluateRules,
  macosPlatform,
  macosProductVersion,
  normalizeArch,
  type Features,
  type JvmArch,
  type Platform,
} from './rules'
export { LEGACY_JVM_ARGUMENTS, mergeVersionChain, resolveVersion, type LayerLibrary, type ResolveOptions, type ResolvedVersion } from './resolve'
export {
  dedupeLibraries,
  FORGE_MAVEN,
  MOJANG_LIBRARIES,
  resolveLibraries,
  resolveLibrary,
  type LibraryDownload,
  type ResolveLibrariesResult,
  type ResolvedLibrary,
} from './libraries'
export { planNatives, type NativesIssue, type NativesPlan, type NativesReplacement, type PlanNativesOptions } from './natives/plan'
export {
  AMETHYST_NATIVES_CLASSIFIER,
  AMETHYST_NATIVES_GROUP,
  DEFAULT_LWJGL2_ARM64_SOURCE,
  findLwjgl2Artifact,
  parseLwjgl2Arm64Source,
  REQUIRED_LWJGL2_ARTIFACTS,
  type Lwjgl2Arm64Artifact,
  type Lwjgl2Arm64Source,
  type RequiredLwjgl2Artifact,
} from './natives/lwjgl2'
export {
  DEFAULT_GLFW_ARM64_SOURCE,
  findGlfwArtifact,
  GLFW_PATCHED_ARTIFACT,
  parseGlfwArm64Source,
  type GlfwArm64Artifact,
  type GlfwArm64Source,
} from './natives/glfw'
export {
  JNA_ARM64,
  LWJGL3_ARM64,
  LWJGL3_REPLACEMENT_VERSION,
  NATIVES_TABLE_REVISION,
  OBJC_BRIDGE_ARM64,
  TEXT2SPEECH_ARM64,
  type PinnedArtifact,
} from './natives/table'
export {
  extractNatives,
  NATIVES_MANIFEST,
  NATIVES_SUBDIRS,
  nativesDirectory,
  type ExtractNativesOptions,
  type ExtractNativesResult,
} from './natives/extract'
export {
  assetObjectPath,
  isLegacyAssets,
  parseAssetIndex,
  prepareLegacyAssets,
  readAssetIndex,
  type AssetIndex,
  type AssetObject,
  type PrepareLegacyAssetsOptions,
  type PrepareLegacyAssetsResult,
} from './assets'
export { parseArgs, redactArgs, redactCommand, REDACTED, toArgv } from './argv'
export {
  autoMemory,
  buildLaunchCommand,
  expandArguments,
  isLog4ShellAffected,
  KNOWN_VARIABLES,
  resolveDirs,
  sanitizeEnv,
  substitute,
  type BuildLaunchOptions,
  type GameDirs,
  type LaunchAuth,
  type LaunchCommand,
  type QuickPlay,
  type TemplateVariables,
} from './command'
export { LogParser, parsePlainLine, parseXmlEvent, type LogEvent, type LogLevel } from './logs'
export { launch, READY_MARKERS, type GameProcess, type LaunchProcessOptions, type LaunchResult } from './launch'
export { diagnose, type DiagnoseIssue, type DiagnoseKind, type DiagnoseOptions, type DiagnoseProblem } from './diagnose'
