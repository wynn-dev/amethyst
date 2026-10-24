/**
 * Fabric (`meta.fabricmc.net/v2`) and Quilt (`meta.quiltmc.org/v3`) metadata. Both services share
 * the same shape: a game version list, a loader version list, and a ready-made launcher profile
 * (a version JSON with `inheritsFrom`) per game/loader pair.
 */
import { InstallError } from '../errors'
import { checkVersionJson, type RawVersionJson } from '../version-json'

/** Fabric or Quilt. */
export type FabricLikeKind = 'fabric' | 'quilt'

/** A game version supported by the loader. */
export interface LoaderGameVersion {
  version: string
  stable: boolean
}

/** A loader release. */
export interface LoaderVersion {
  version: string
  /** Maven coordinate of the loader jar. */
  maven: string
  /** Fabric marks stability explicitly; for Quilt, versions without a `-beta`/`-pre` tag are stable. */
  stable: boolean
  /** Quilt publishes the loader jar's sha1 and size. */
  sha1?: string
  size?: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function badList(what: string): never {
  throw new InstallError('EINSTALL_BAD_METADATA', `${what} is not a valid version list`)
}

/** Validate a `/versions/game` response. */
export function parseLoaderGameVersions(value: unknown): LoaderGameVersion[] {
  if (!Array.isArray(value)) badList('game version list')
  return value.map((v) => {
    if (!isObject(v) || typeof v.version !== 'string') badList('game version list')
    return { version: v.version, stable: v.stable === true }
  })
}

/** Validate a `/versions/loader` response (also accepts the `/versions/loader/<mc>` shape, `{loader: ...}`). */
export function parseLoaderVersions(value: unknown): LoaderVersion[] {
  if (!Array.isArray(value)) badList('loader version list')
  return value.map((raw) => {
    const v = isObject(raw) && isObject(raw.loader) ? raw.loader : raw
    if (!isObject(v) || typeof v.version !== 'string' || typeof v.maven !== 'string') badList('loader version list')
    const out: LoaderVersion = {
      version: v.version,
      maven: v.maven,
      stable: typeof v.stable === 'boolean' ? v.stable : !/-(alpha|beta|pre|rc)/i.test(v.version),
    }
    const hashes = isObject(v.hashes) ? v.hashes : undefined
    if (typeof hashes?.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(hashes.sha1)) out.sha1 = hashes.sha1.toLowerCase()
    if (typeof v.file_size === 'number') out.size = v.file_size
    return out
  })
}

/**
 * Validate a launcher profile JSON: it must be a version JSON that inherits from `minecraft`.
 *
 * @throws {InstallError} `EINSTALL_BAD_METADATA` otherwise.
 */
export function parseLoaderProfile(value: unknown, minecraft: string, kind: FabricLikeKind): RawVersionJson {
  const json = checkVersionJson(value, `${kind} profile`)
  if (json.inheritsFrom !== minecraft) {
    throw new InstallError('EINSTALL_BAD_METADATA', `${kind} profile inherits from ${String(json.inheritsFrom)}, expected ${minecraft}`)
  }
  if (typeof json.mainClass !== 'string' || json.mainClass === '') throw new InstallError('EINSTALL_BAD_METADATA', `${kind} profile has no mainClass`)
  return json
}

/** The version id Amethyst gives a Fabric/Quilt install: `<base>-fabric<loader>` / `<base>-quilt<loader>`. */
export function fabricLikeVersionId(kind: FabricLikeKind, base: string, loader: string): string {
  return `${base}-${kind}${loader}`
}
