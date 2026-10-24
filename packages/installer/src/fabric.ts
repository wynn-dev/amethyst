import { ensureFiles, type EnsureFilesResult } from './files'
import { checkVersionId, versionJsonPath, writeJsonAtomic } from './fs-util'
import { fillMissingHashes, layerLibrarySpecs } from './libraries'
import { createMetadataClient, type MetadataClient } from './meta/client'
import { type FabricLikeKind, fabricLikeVersionId } from './meta/fabric'
import { type InstallOptions, platformOf, signalOf, step } from './options'
import type { RawVersionJson } from './version-json'

/** Options for {@link installFabricLike}. */
export interface InstallFabricLikeOptions extends InstallOptions {
  /** Metadata client (a fresh one with default endpoints otherwise). */
  meta?: MetadataClient
  /**
   * Version id to inherit from. Defaults to the Minecraft version; set it when stacking on another
   * layer. The written id becomes `<base>-fabric<loader>` / `<base>-quilt<loader>`.
   */
  base?: string
  /** A profile fetched earlier (by {@link planInstall}); otherwise it is fetched now. */
  profile?: RawVersionJson
}

/** Result of a loader install. */
export interface LoaderInstallResult {
  /** The id written to `versions/<id>/<id>.json`. */
  versionId: string
  /** What the libraries step did. */
  libraries: EnsureFilesResult
}

/**
 * Install Fabric or Quilt for `minecraft`: fetch the launcher profile from the meta service, write
 * it as `versions/<id>/<id>.json` with `inheritsFrom` set to the base, then download the profile's
 * own libraries, verified by their published sha1/size or, failing that, the maven `.sha1` sidecar.
 *
 * Neither the client jar nor Java is needed. The vanilla base must be installed separately (see
 * {@link runInstall}) before the version can be launched.
 */
export async function installFabricLike(kind: FabricLikeKind, minecraft: string, loader: string, options: InstallFabricLikeOptions): Promise<LoaderInstallResult> {
  const signal = signalOf(options)
  const base = options.base ?? minecraft
  const versionId = checkVersionId(fabricLikeVersionId(kind, base, loader))
  const profile =
    options.profile ??
    (await step(options.ctx, 'profile', 1, () => (options.meta ?? createMetadataClient({ http: options.http })).loaderProfile(kind, minecraft, loader, { signal })))
  const json: RawVersionJson = { ...profile, id: versionId, inheritsFrom: base }
  await writeJsonAtomic(versionJsonPath(options.root, versionId), json)

  const specs = layerLibrarySpecs(options.root, json, platformOf(options))
  const libraries = await step(options.ctx, 'libraries', Math.max(1, specs.length), async (ctx) => {
    await fillMissingHashes(specs, options.http, signal)
    return ensureFiles(specs, { signal, ctx, http: options.http, concurrency: options.concurrency, trustedBefore: options.trustedBefore })
  })
  return { versionId, libraries }
}
