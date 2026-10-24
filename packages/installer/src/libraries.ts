import { join } from 'node:path'
import {
  FORGE_MAVEN,
  GameError,
  type LibraryJson,
  type Platform,
  resolveLibraries,
  resolveLibrary,
  resolveVersion,
  type ResolvedLibrary,
  type ResolvedVersion,
  type VersionJson,
} from '@amethyst/game'
import type { HttpClient } from '@amethyst/net'
import { mapLimit } from '@amethyst/task'
import { InstallError } from './errors'
import type { FileSpec } from './files'
import { safeJoin } from './fs-util'
import { joinUrl } from './maven'
import { fetchSidecarHash } from './sidecar'

export const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2/'

/**
 * Upgrade plain-HTTP repository URLs (old Forge and Mojang JSON) to HTTPS, and the retired
 * `files.minecraftforge.net/maven` host to the current Forge maven. Loopback URLs (local mirrors,
 * tests) are left alone.
 */
export function secureUrl(url: string): string {
  const u = url.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, FORGE_MAVEN)
  if (!u.startsWith('http://') || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)) return u
  return `https://${u.slice('http://'.length)}`
}

/**
 * Candidate URLs for a library: its own URL (upgraded to HTTPS), then the Forge maven for
 * Forge artifacts, then Maven Central for the scala/typesafe artifacts that old Forge profiles
 * reference. An empty list means the file must be produced locally (Forge/NeoForge installers).
 */
export function libraryUrls(lib: Pick<ResolvedLibrary, 'name' | 'download'>): string[] {
  if (!lib.download.url) return []
  const urls = [secureUrl(lib.download.url)]
  const add = (u: string) => {
    if (!urls.includes(u)) urls.push(u)
  }
  if (lib.name.includes('forge')) add(joinUrl(FORGE_MAVEN, lib.download.path))
  if (/^(org\.scala-lang|com\.typesafe)[.:]/.test(lib.name)) add(joinUrl(MAVEN_CENTRAL, lib.download.path))
  return urls
}

/** Turn a resolved library into a {@link FileSpec} under `<root>/libraries`. */
export function libraryFileSpec(root: string, lib: ResolvedLibrary): FileSpec {
  const d = lib.download
  const spec: FileSpec = { path: safeJoin(join(root, 'libraries'), d.path), urls: libraryUrls(lib), name: lib.name }
  if (d.size !== undefined) spec.size = d.size
  if (d.sha1Alternatives?.length) spec.sha1Any = [...(d.sha1 ? [d.sha1] : []), ...d.sha1Alternatives]
  else if (d.sha1) spec.sha1 = d.sha1
  if (d.sha256) spec.sha256 = d.sha256
  if (!spec.sha1 && !spec.sha1Any && !spec.sha256) spec.validator = 'zip'
  return spec
}

/**
 * For libraries published without a hash (Quilt profiles, some Fabric and legacy Forge entries),
 * fetch the maven `.sha1` sidecar of the first URL so the download can still be verified. When the
 * sidecar is unavailable the spec keeps its `zip` validator. Mutates and returns `specs`.
 */
export async function fillMissingHashes(specs: FileSpec[], http: HttpClient | undefined, signal?: AbortSignal): Promise<FileSpec[]> {
  const missing = specs.filter((s) => !s.sha1 && !s.sha256 && !s.sha1Any && s.urls.length > 0)
  await mapLimit(
    missing,
    8,
    async (spec) => {
      const hash = await fetchSidecarHash(spec.urls[0] as string, 'sha1', { http, signal }).catch(() => undefined)
      if (signal?.aborted) return
      if (hash) {
        spec.sha1 = hash
        delete spec.validator
      }
    },
    signal,
  )
  return specs
}

/**
 * Resolve an installed version with `@amethyst/game` (reading its `inheritsFrom` chain), mapping
 * game errors to installer errors.
 *
 * @throws {InstallError} `EINSTALL_NOT_FOUND` when a JSON in the chain is missing,
 * `EINSTALL_BAD_METADATA` when one is invalid.
 */
export async function resolveInstalled(root: string, id: string, signal?: AbortSignal): Promise<ResolvedVersion> {
  try {
    return await resolveVersion(join(root, 'versions'), id, { signal })
  } catch (e) {
    if (e instanceof GameError) {
      throw new InstallError(e.code === 'EVERSION_MISSING' ? 'EINSTALL_NOT_FOUND' : 'EINSTALL_BAD_METADATA', e.message, { cause: e })
    }
    throw e
  }
}

/** The file specs of one layer's own libraries (no parents), e.g. a freshly written loader profile. */
export function layerLibrarySpecs(root: string, json: Pick<VersionJson, 'id' | 'libraries'>, platform: Platform): FileSpec[] {
  const layer = (json.libraries ?? []).map((library) => ({ library, source: json.id }))
  return resolveLibraries(layer, platform).libraries.map((lib) => libraryFileSpec(root, lib))
}

/**
 * The file specs of an install profile's processor libraries. Unlike version libraries these are
 * **not** de-duplicated by `group:artifact`: different processors need different versions of the
 * same artifact (Forge 1.20.1 uses srgutils 0.4.3, 0.4.9 and 0.5.6 side by side).
 */
export function toolLibrarySpecs(root: string, libraries: readonly LibraryJson[], platform: Platform): FileSpec[] {
  const byPath = new Map<string, FileSpec>()
  for (const library of libraries) {
    let lib: ResolvedLibrary | null
    try {
      lib = resolveLibrary(library, platform, 'install_profile')
    } catch (e) {
      throw new InstallError('EINSTALL_BAD_INSTALLER', `install profile library ${library.name}: ${(e as Error).message}`, { cause: e })
    }
    if (lib) byPath.set(lib.download.path, libraryFileSpec(root, lib))
  }
  return [...byPath.values()]
}

/** The file specs of every library a resolved version needs on `platform` (de-duplicated, child wins). */
export function versionLibrarySpecs(root: string, version: ResolvedVersion, platform: Platform): FileSpec[] {
  return resolveLibraries(version, platform).libraries.map((lib) => libraryFileSpec(root, lib))
}
