/**
 * The architecture a JVM actually runs as. `'x64'` on Apple Silicon means Rosetta 2.
 * `'unknown'` is used only when neither the Mach-O header, the `release` file nor a spawn
 * could tell (for example a shell-script wrapper whose probe failed).
 */
export type JavaArch = 'arm64' | 'x64' | 'unknown'

/** Where a candidate was discovered. Used for de-duplication priority and for the UI. */
export type JavaSource =
  | 'managed'
  | 'java_home'
  | 'system'
  | 'user'
  | 'homebrew'
  | 'homebrew-intel'
  | 'sdkman'
  | 'asdf'
  | 'mise'
  | 'jenv'
  | 'gradle'
  | 'mojang-launcher'
  | 'java-home-env'
  | 'path'
  | 'manual'

/**
 * Why a record is not usable:
 * - `missing`: the executable does not exist.
 * - `not-executable`: it exists but is not executable by us.
 * - `bad-cpu-type`: an x86_64 JVM and Rosetta 2 is not installed (`EBADARCH`, errno 86).
 * - `timeout`: the probe JVM did not answer in time.
 * - `unparseable`: nothing told us the version.
 * - `spawn-failed`: the JVM exited with an error or could not be started.
 */
export type InvalidReason = 'missing' | 'not-executable' | 'bad-cpu-type' | 'timeout' | 'unparseable' | 'spawn-failed'

/**
 * A probed Java runtime, identified by the absolute path of its `bin/java` executable.
 * Every field is structured-cloneable and meant to be persisted as-is.
 */
export interface JavaRecord {
  /** Absolute path to `bin/java` as discovered (the "nicest" path when several alias one file). */
  path: string
  /** `realpath(path)`: the identity used for de-duplication and the probe cache. */
  realPath: string
  /** The JDK/JRE home (the directory containing `bin/`). */
  javaHome: string
  /** The version as reported, e.g. `1.8.0_512`, `17.0.15`, `25`. Empty when unknown. */
  version: string
  /** 8, 16, 17, 21, 25... `0` when unknown. */
  majorVersion: number
  /** The JVM's real architecture (Mach-O header first, then `release`/`os.arch`). */
  arch: JavaArch
  /** Architectures present in the `bin/java` Mach-O, e.g. `['arm64']` or `['x86_64', 'arm64']`. */
  machO?: string[]
  /** `IMPLEMENTOR` / `java.vendor`, e.g. `Azul Systems, Inc.`. */
  vendor?: string
  /** `java.vm.name` when a spawn ran, e.g. `OpenJDK 64-Bit Server VM` or `Eclipse OpenJ9 VM`. */
  vmName?: string
  source: JavaSource
  /** Installed by Amethyst under the managed runtimes directory. */
  managed: boolean
  /** The record looks usable: exists, executable, version and arch known. */
  valid: boolean
  /**
   * A JVM spawn (`-XshowSettings:properties -version`) confirmed the version and arch for this
   * exact binary (same mtime/size). Cheap probes leave it `false`; pre-launch validation should
   * probe with `spawn: 'always'` so the chosen runtime is verified before the game starts.
   */
  verified: boolean
  invalidReason?: InvalidReason
  /** `bin/java` modification time and size, the probe cache key. */
  mtimeMs: number
  size: number
  /** When this record was produced (ms since epoch). */
  probedAt: number
}
