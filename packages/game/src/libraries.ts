/**
 * Resolving library entries against a platform (launch.md §4) and de-duplicating them across
 * layers (§2.4).
 */
import { formatMavenName, libraryKey, mavenPath, parseMavenName, type MavenCoordinate } from './maven'
import type { LayerLibrary, ResolvedVersion } from './resolve'
import { evaluateRules, type Platform } from './rules'
import type { Artifact, LibraryJson } from './schema'

export const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/'
export const FORGE_MAVEN = 'https://maven.minecraftforge.net/'

/** Where a library comes from and how to verify it. */
export interface LibraryDownload {
  /** Path relative to `<root>/libraries`, `/`-separated. */
  path: string
  /**
   * Download URL. An empty string means "not downloadable": the file is produced locally by a
   * loader installer (Forge/NeoForge declare their patched jars this way).
   */
  url: string
  sha1?: string
  /** Other acceptable sha1 values (legacy Forge `checksums`). */
  sha1Alternatives?: string[]
  /** Used by Amethyst-built artifacts, which are pinned by sha256. */
  sha256?: string
  /** Size in bytes, when known. */
  size?: number
}

export interface ResolvedLibrary {
  /** Full coordinate including the classifier (natives: `name:natives-osx`). */
  name: string
  coordinate: MavenCoordinate
  download: LibraryDownload
  /** Old-style natives: extracted into the natives directory instead of going on the classpath. */
  isNative: boolean
  /** Entry prefixes to skip while extracting (usually `META-INF/`). */
  extractExclude?: string[]
  /** Id of the layer that declared it, or `amethyst` for an arm64 replacement. */
  source: string
}

export interface ResolveLibrariesResult {
  libraries: ResolvedLibrary[]
  /** Entries that were dropped because they are malformed (never because of rules). */
  warnings: string[]
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** Old Forge profiles point at a dead http host; use the current HTTPS maven. */
function rewriteRepo(url: string): string {
  return url.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, FORGE_MAVEN)
}

function fromArtifact(artifact: Artifact, coordinate: MavenCoordinate, fallbackUrl: string): LibraryDownload {
  const p = artifact.path || mavenPath(coordinate)
  const download: LibraryDownload = { path: p, url: artifact.url === undefined ? fallbackUrl + p : rewriteRepo(artifact.url) }
  if (artifact.sha1) download.sha1 = artifact.sha1.toLowerCase()
  if (artifact.size !== undefined && artifact.size >= 0) download.size = artifact.size
  return download
}

/**
 * Resolve one library for `platform`. Returns `null` when its rules disallow it, or when it is an
 * old-style native library without an entry for this OS.
 *
 * @throws {TypeError} for an invalid maven name or a modern library without `downloads.artifact`.
 */
export function resolveLibrary(lib: LibraryJson, platform: Platform, source = ''): ResolvedLibrary | null {
  if (!evaluateRules(lib.rules, platform)) return null
  const base = parseMavenName(lib.name)

  if (lib.natives) {
    const raw = lib.natives[platform.name]
    if (!raw) return null
    // `${arch}` is the JVM bitness (only used by Windows classifiers).
    const classifier = raw.replaceAll('${arch}', platform.arch === 'x86' ? '32' : '64')
    const coordinate: MavenCoordinate = { ...base, classifier }
    const repo = lib.url ? withSlash(rewriteRepo(lib.url)) : MOJANG_LIBRARIES
    const artifact = lib.downloads?.classifiers?.[classifier]
    const download = artifact ? fromArtifact(artifact, coordinate, repo) : { path: mavenPath(coordinate), url: repo + mavenPath(coordinate) }
    const out: ResolvedLibrary = { name: formatMavenName(coordinate), coordinate, download, isNative: true, source }
    if (lib.extract?.exclude) out.extractExclude = [...lib.extract.exclude]
    return out
  }

  if (lib.downloads) {
    const artifact = lib.downloads.artifact
    if (!artifact) throw new TypeError(`Library ${lib.name} has downloads but no downloads.artifact`)
    const fallback = base.group === 'net.minecraftforge' || base.group.startsWith('net.minecraftforge.') ? FORGE_MAVEN : MOJANG_LIBRARIES
    return { name: lib.name, coordinate: base, download: fromArtifact(artifact, base, fallback), isNative: false, source }
  }

  // Maven-only shape: legacy Forge (`url`, `checksums`) and Fabric/Quilt (`url`, `sha1`, `size`).
  const p = mavenPath(base)
  const download: LibraryDownload = { path: p, url: withSlash(rewriteRepo(lib.url || MOJANG_LIBRARIES)) + p }
  const sha1 = lib.sha1 ?? lib.checksums?.[0]
  if (sha1) download.sha1 = sha1.toLowerCase()
  if (lib.checksums && lib.checksums.length > 1) download.sha1Alternatives = lib.checksums.slice(1).map((c) => c.toLowerCase())
  if (lib.sha256) download.sha256 = lib.sha256.toLowerCase()
  if (lib.size !== undefined && lib.size >= 0) download.size = lib.size
  return { name: lib.name, coordinate: base, download, isNative: false, source }
}

/**
 * De-duplicate resolved libraries: the key is `group:artifact[:classifier]` (no version), the
 * position is that of the first occurrence and the value that of the last, so a child layer's
 * version replaces its parent's in place. Old-style natives are kept in a separate map and listed
 * after all classpath libraries.
 */
export function dedupeLibraries(libraries: Iterable<ResolvedLibrary>): ResolvedLibrary[] {
  const normal = new Map<string, ResolvedLibrary>()
  const natives = new Map<string, ResolvedLibrary>()
  for (const lib of libraries) {
    const map = lib.isNative ? natives : normal
    map.set(libraryKey(lib.coordinate), lib)
  }
  return [...normal.values(), ...natives.values()]
}

/**
 * Evaluate every layer's libraries against `platform` (rules first, so per-OS duplicates such as
 * LWJGL 3.2.1/3.2.2 never collide) and de-duplicate them. Malformed entries are dropped with a
 * warning instead of failing the launch.
 */
export function resolveLibraries(version: Pick<ResolvedVersion, 'libraries'> | readonly LayerLibrary[], platform: Platform): ResolveLibrariesResult {
  const entries = Array.isArray(version) ? (version as readonly LayerLibrary[]) : (version as Pick<ResolvedVersion, 'libraries'>).libraries
  const warnings: string[] = []
  const resolved: ResolvedLibrary[] = []
  for (const { library, source } of entries) {
    try {
      const lib = resolveLibrary(library, platform, source)
      if (lib) resolved.push(lib)
    } catch (e) {
      warnings.push(`Ignoring library ${JSON.stringify(library.name)} from ${source}: ${(e as Error).message}`)
    }
  }
  return { libraries: dedupeLibraries(resolved), warnings }
}
