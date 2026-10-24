/**
 * Java runtimes on macOS (Apple Silicon): discovery, probing, selection and managed installs.
 *
 * {@link discoverJava} scans every place a JVM lives on a Mac (`java_home`, both
 * JavaVirtualMachines folders, Homebrew, SDKMAN, asdf, mise, jenv, Gradle, the Mojang launcher,
 * `JAVA_HOME`, `PATH`, managed and user-added paths), de-duplicates by realpath and probes each
 * with {@link probeJava}. Probing is cheap: the `release` file and the Mach-O header of `bin/java`
 * give the version and the JVM's **real** arch (arm64, x86_64, universal) without spawning it, and
 * a {@link ProbeCache} keyed by `(path, mtime, size)` makes rescans nearly free.
 *
 * {@link selectJava} ranks records for a requirement (arm64 first, exact major, then closest
 * compatible, managed, newest) and explains its choice; {@link javaRequirementFor} derives the
 * requirement from a version JSON and Minecraft version.
 *
 * {@link installJavaRuntime} installs a native runtime: {@link resolveRuntimeFor} picks Mojang's
 * `mac-os-arm64` build when the live index has one, otherwise Azul Zulu. Installs are staged,
 * verified (sha1/sha256), de-quarantined and renamed into place atomically; {@link verifyRuntime}
 * and {@link repairRuntime} keep them healthy.
 *
 * Everything is pure Node (no Electron), cancellable through `AbortSignal`/`TaskContext`, and
 * safe to run in a worker thread.
 */
export { ProbeCache, writeJsonAtomic, type ProbeCacheFile, type ProbeCacheOptions } from './cache'
export { discoverJava, findJavaCandidates, type DiscoverOptions, type JavaCandidate } from './discovery'
export { InstallError, isFatal, JavaError, type InstallAttempt, type JavaErrorCode } from './errors'
export {
  installJavaRuntime,
  installMojangRuntime,
  installZuluRuntime,
  locateJavaBundle,
  repairRuntime,
  type InstallJavaOptions,
  type InstallOptions,
  type InstallResult,
  type JavaInstallRequest,
  type MojangInstallOptions,
  type RepairResult,
  type TransferStats,
  type ZuluInstallOptions,
} from './install'
export { listJavaHomes, parseJavaHomeV, parseJavaHomeX, parsePlist, type JavaHomeEntry, type JavaHomeOptions } from './javahome'
export { decodeLzmaFile, MAX_LZMA_DICT, parseLzmaHeader, type DecodeLzmaOptions, type LzmaHeader } from './lzma'
export { cpuName, machOArch, parseMachOHeader, readMachO, type MachOInfo } from './macho'
export {
  clearQuarantine,
  findRuntimeJava,
  INSTALLED_MANIFEST,
  listManagedRuntimes,
  readInstalledRuntime,
  verifyRuntime,
  type InstalledFile,
  type InstalledRuntime,
  type ManagedRuntime,
  type VerifyOptions,
  type VerifyProblem,
  type VerifyReport,
} from './managed'
export {
  fetchRuntimeIndex,
  MAC_ARM64_PLATFORM,
  MOJANG_RUNTIME_INDEX_URL,
  parseRuntimeIndex,
  parseRuntimeManifest,
  planRuntime,
  runtimeFor,
  type FetchIndexOptions,
  type MojangDownload,
  type PlannedFile,
  type PlannedLink,
  type RuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeManifest,
  type RuntimeManifestEntry,
  type RuntimePlan,
} from './mojang'
export { parseShowSettings, probeJava, type ProbeOptions, type SpawnPolicy } from './probe'
export { detectHost, probeEnv, type HostInfo } from './process'
export { normalizeArch, parseReleaseFile, readReleaseFile, type ReleaseInfo } from './release'
export {
  COMPONENT_FOR_MAJOR,
  defaultMatch,
  javaRequirementFor,
  KNOWN_COMPONENTS,
  matchesMajor,
  minecraftEra,
  type JavaMatch,
  type JavaRequirement,
  type MinecraftEra,
  type RequirementInput,
} from './requirement'
export { arm64Availability, resolveRuntimeFor, type Arm64Availability, type ResolveOptions, type RuntimeChoice } from './resolve'
export {
  compareForRequirement,
  selectJava,
  type JavaGrade,
  type RankedJava,
  type SelectOptions,
  type SelectReason,
  type SelectResult,
} from './select'
export { checkLinkTarget, extractTar, extractTarGz, parsePax, safeSegments, type ExtractTarOptions, type ExtractTarResult, type TarEntryType, type TarExtracted } from './tar'
export type { InvalidReason, JavaArch, JavaRecord, JavaSource } from './types'
export { compareJavaVersions, parseJavaVersion, parseVersionBanner, type JavaVersion } from './version'
export {
  AZUL_API,
  chooseZuluPackage,
  findZuluPackage,
  parseZuluPackage,
  parseZuluPackages,
  zuluListUrl,
  type ZuluFetchOptions,
  type ZuluPackage,
  type ZuluPackageSummary,
  type ZuluPackageType,
  type ZuluQuery,
} from './zulu'
