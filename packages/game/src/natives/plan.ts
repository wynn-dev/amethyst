/**
 * The per-launch natives plan (launch.md §12.3): which libraries a version uses for the selected
 * JVM, with Apple Silicon replacements applied when that JVM is arm64.
 *
 * Matching is by artifact family and version range, never by exact strings, so snapshots,
 * loader JSON and third-party JSON are covered too. With an x86_64 JVM (Rosetta) nothing is
 * replaced and the original natives are used.
 */
import { dedupeLibraries, resolveLibraries, type ResolvedLibrary } from '../libraries'
import { compareVersions, formatMavenName, libraryKey, mavenPath, type MavenCoordinate } from '../maven'
import type { ResolvedVersion } from '../resolve'
import { requireArch, type JvmArch, type Platform } from '../rules'
import {
  AMETHYST_NATIVES_CLASSIFIER,
  AMETHYST_NATIVES_GROUP,
  DEFAULT_LWJGL2_ARM64_SOURCE,
  findLwjgl2Artifact,
  lwjgl2ArtifactUrl,
  type Lwjgl2Arm64Source,
} from './lwjgl2'
import {
  JNA_ARM64,
  JNA_MIN_ARM64,
  LWJGL3_ARM64,
  LWJGL3_MIN_ARM64,
  NATIVES_TABLE_REVISION,
  OBJC_BRIDGE_ARM64,
  OBJC_BRIDGE_MIN,
  TEXT2SPEECH_ARM64,
  TEXT2SPEECH_MIN,
  type PinnedArtifact,
} from './table'

export interface PlanNativesOptions {
  /** Architecture of the selected JVM (`arm64`, `x64`, or an alias such as `aarch64`/`x86_64`). */
  jvmArch: JvmArch | string
  /** macOS product version for `os.version` rules. Defaults to `13.0` (the minimum supported). */
  osVersion?: string
  /** Where the Amethyst-built LWJGL 2 arm64 natives come from. Defaults to the pinned manifest. */
  lwjgl2?: Lwjgl2Arm64Source
  /**
   * The "replace natives" escape hatch (on by default). When false, an arm64 JVM gets the
   * original x86_64-only natives and a warning.
   */
  replace?: boolean
}

/** A native library the plan could not provide for this JVM. The launch cannot succeed. */
export interface NativesIssue {
  code: 'ENATIVES_UNAVAILABLE'
  /** The original library coordinate. */
  library: string
  message: string
}

export interface NativesReplacement {
  /** Original coordinate. */
  from: string
  /** Replacement coordinate, or `null` when the library was removed. */
  to: string | null
  reason: string
}

export interface NativesPlan {
  jvmArch: JvmArch
  platform: Platform
  /** Final library list: classpath libraries in merged order, then old-style natives. */
  libraries: ResolvedLibrary[]
  /** `libraries` without old-style natives, in classpath order. */
  classpath: ResolvedLibrary[]
  /** Old-style natives to extract into the natives directory. */
  extract: ResolvedLibrary[]
  replacements: NativesReplacement[]
  /** Non-empty means the version cannot run on this JVM (see `ok`). */
  issues: NativesIssue[]
  warnings: string[]
  /** False when any native library is unavailable for this JVM. */
  ok: boolean
  /** LWJGL generation found in the version (after replacement), if any. */
  lwjgl?: 2 | 3
  /** Table revision, so caches keyed by the plan can be invalidated. */
  revision: number
}

const AMETHYST = 'amethyst'

function pinned(p: PinnedArtifact): ResolvedLibrary {
  const [group, artifact, version, classifier] = p.name.split(':') as [string, string, string, string | undefined]
  const coordinate: MavenCoordinate = classifier ? { group, artifact, version, classifier, extension: 'jar' } : { group, artifact, version, extension: 'jar' }
  return { name: p.name, coordinate, download: { path: p.path, url: p.url, sha1: p.sha1, size: p.size }, isNative: false, source: AMETHYST }
}

const isMacNativesClassifier = (c: string | undefined): boolean => c === 'natives-macos' || c === 'natives-osx' || c === 'natives-macos-patch'

/**
 * Plan the libraries for `version` on a JVM of `options.jvmArch`.
 *
 * Never throws for missing arm64 builds: those are reported in `issues` with
 * `code: 'ENATIVES_UNAVAILABLE'` and `ok: false`, so the UI can explain the problem before the
 * game dies with an `UnsatisfiedLinkError`.
 */
export function planNatives(version: Pick<ResolvedVersion, 'libraries' | 'minecraftVersion'>, options: PlanNativesOptions): NativesPlan {
  const jvmArch = requireArch(options.jvmArch)
  const platform: Platform = { name: 'osx', version: options.osVersion ?? '13.0', arch: jvmArch }
  const { libraries: original, warnings } = resolveLibraries(version, platform)
  const replacements: NativesReplacement[] = []
  const issues: NativesIssue[] = []
  const mc = version.minecraftVersion

  const needsArm64Work = original.some((l) => isLegacyArm64Problem(l))
  if (jvmArch !== 'arm64' || options.replace === false) {
    if (jvmArch === 'arm64' && needsArm64Work) {
      warnings.push(`Native library replacement is off: Minecraft ${mc} ships x86_64-only natives and will not start on an arm64 JVM`)
    }
    if (jvmArch === 'x64') warnings.push('Using an x86_64 JVM: the game runs translated by Rosetta 2')
    return finish(jvmArch, platform, original, replacements, issues, warnings)
  }

  const source = options.lwjgl2 ?? DEFAULT_LWJGL2_ARM64_SOURCE
  const present = new Set(original.map((l) => libraryKey(l.coordinate)))
  const out: ResolvedLibrary[] = []
  const replace = (from: ResolvedLibrary, to: ResolvedLibrary[], reason: string) => {
    if (to.length === 0) replacements.push({ from: from.name, to: null, reason })
    for (const t of to) replacements.push({ from: from.name, to: t.name, reason })
    out.push(...to)
  }
  const unavailable = (lib: ResolvedLibrary, message: string) => issues.push({ code: 'ENATIVES_UNAVAILABLE', library: lib.name, message })

  for (const lib of original) {
    const { group, artifact, version: v, classifier } = lib.coordinate

    // LWJGL 2 natives → Amethyst-built arm64 jars. The Java jars (lwjgl, lwjgl_util) stay.
    if (group === 'org.lwjgl.lwjgl' && artifact === 'lwjgl-platform' && lib.isNative) {
      const a = findLwjgl2Artifact(source, 'lwjgl-platform', v)
      if (a) replace(lib, [amethystNative('lwjgl-platform', v, source, a)], 'LWJGL 2 natives are x86_64-only; using the Amethyst arm64 build')
      else unavailable(lib, `No arm64 build of LWJGL ${v} natives is available (needed by Minecraft ${mc})`)
      continue
    }
    if (group === 'net.java.jinput' && artifact === 'jinput-platform' && lib.isNative) {
      const a = findLwjgl2Artifact(source, 'jinput-platform', v)
      if (a) replace(lib, [amethystNative('jinput-platform', v, source, a)], 'jinput natives are x86_64-only; using the Amethyst arm64 build')
      else replace(lib, [], 'jinput natives are x86_64-only and only needed for controllers; removed')
      continue
    }

    // LWJGL 3 before 3.3.0 → 3.3.1 jars plus natives-macos-arm64 on the classpath.
    if (group === 'org.lwjgl' && compareVersions(v, LWJGL3_MIN_ARM64) < 0) {
      const entry = LWJGL3_ARM64[artifact]
      if (!classifier && !lib.isNative) {
        if (entry) replace(lib, [pinned(entry.jar), pinned(entry.nativesArm64)], `LWJGL ${v} has no arm64 natives; upgraded to ${entry.jar.name.split(':')[2]}`)
        else unavailable(lib, `No arm64 replacement is known for LWJGL module ${artifact} ${v}`)
        continue
      }
      if (lib.isNative || isMacNativesClassifier(classifier)) {
        if (entry) replace(lib, [pinned(entry.nativesArm64)], `LWJGL ${v} natives are x86_64-only`)
        else unavailable(lib, `No arm64 replacement is known for LWJGL module ${artifact} ${v} natives`)
        continue
      }
    }

    // LWJGL 3.3+: natives load from the classpath; make sure an arm64 jar is there.
    if (group === 'org.lwjgl') {
      let current = lib
      if (lib.isNative) {
        current = { ...lib, isNative: false }
        replace(lib, [current], 'LWJGL 3.3+ natives load from the classpath')
      } else {
        out.push(lib)
      }
      if (isMacNativesClassifier(classifier) && classifier !== 'natives-macos-patch' && !present.has(`${group}:${artifact}:natives-macos-arm64`)) {
        const coordinate: MavenCoordinate = { group, artifact, version: v, classifier: 'natives-macos-arm64', extension: 'jar' }
        const p = mavenPath(coordinate)
        out.push({ name: formatMavenName(coordinate), coordinate, download: { path: p, url: `https://repo1.maven.org/maven2/${p}` }, isNative: false, source: AMETHYST })
        present.add(libraryKey(coordinate))
        warnings.push(`Added ${formatMavenName(coordinate)} from Maven Central (not pinned; verify with its .sha1 sidecar)`)
      }
      continue
    }

    if (group === 'ca.weblite' && artifact === 'java-objc-bridge' && compareVersions(v, OBJC_BRIDGE_MIN) < 0) {
      if (lib.isNative) replace(lib, [], 'java-objc-bridge 1.0 natives are x86_64-only; 1.1 embeds a universal library')
      else replace(lib, [pinned(OBJC_BRIDGE_ARM64)], 'java-objc-bridge 1.1 embeds a universal libjcocoa.dylib')
      continue
    }
    if (group === 'com.mojang' && artifact === 'text2speech') {
      if (lib.isNative) replace(lib, [], 'text2speech natives are not used on macOS')
      else if (compareVersions(v, TEXT2SPEECH_MIN) < 0) replace(lib, [pinned(TEXT2SPEECH_ARM64)], `text2speech ${v} upgraded for the arm64 objc bridge`)
      else out.push(lib)
      continue
    }
    if (group === 'tv.twitch' && (artifact === 'twitch-platform' || artifact === 'twitch-external-platform') && lib.isNative) {
      replace(lib, [], 'Twitch natives are x86_64-only and the service is defunct')
      continue
    }
    if (group === 'net.java.dev.jna' && (artifact === 'jna' || artifact === 'jna-platform') && !classifier && compareVersions(v, JNA_MIN_ARM64) < 0) {
      replace(lib, [pinned(JNA_ARM64[artifact])], `JNA ${v} has no darwin-aarch64 dispatch library`)
      continue
    }

    if (lib.isNative) warnings.push(`Native library ${lib.name} is not in the arm64 table and may be x86_64-only`)
    out.push(lib)
  }

  return finish(jvmArch, platform, dedupeLibraries(out), replacements, issues, warnings)
}

function amethystNative(name: string, version: string, source: Lwjgl2Arm64Source, a: { url: string; sha256: string; size: number }): ResolvedLibrary {
  const coordinate: MavenCoordinate = { group: AMETHYST_NATIVES_GROUP, artifact: name, version, classifier: AMETHYST_NATIVES_CLASSIFIER, extension: 'jar' }
  return {
    name: formatMavenName(coordinate),
    coordinate,
    download: { path: mavenPath(coordinate), url: lwjgl2ArtifactUrl(source, { ...a, name, version }), sha256: a.sha256, size: a.size },
    isNative: true,
    extractExclude: ['META-INF/'],
    source: AMETHYST,
  }
}

/** True for libraries that cannot load on an arm64 JVM as shipped. */
function isLegacyArm64Problem(lib: ResolvedLibrary): boolean {
  const { group, artifact, version } = lib.coordinate
  if (group === 'org.lwjgl.lwjgl' && artifact === 'lwjgl-platform') return true
  return group === 'org.lwjgl' && compareVersions(version, LWJGL3_MIN_ARM64) < 0
}

function finish(
  jvmArch: JvmArch,
  platform: Platform,
  libraries: ResolvedLibrary[],
  replacements: NativesReplacement[],
  issues: NativesIssue[],
  warnings: string[],
): NativesPlan {
  let lwjgl: 2 | 3 | undefined
  if (libraries.some((l) => l.coordinate.group === 'org.lwjgl')) lwjgl = 3
  else if (libraries.some((l) => l.coordinate.group === 'org.lwjgl.lwjgl')) lwjgl = 2
  return {
    jvmArch,
    platform,
    libraries,
    classpath: libraries.filter((l) => !l.isNative),
    extract: libraries.filter((l) => l.isNative),
    replacements,
    issues,
    warnings,
    ok: issues.length === 0,
    lwjgl,
    revision: NATIVES_TABLE_REVISION,
  }
}
