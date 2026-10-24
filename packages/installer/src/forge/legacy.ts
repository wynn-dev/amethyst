import { join } from 'node:path'
import type { ZipReader } from '@amethyst/zip'
import { InstallError } from '../errors'
import { ensureFiles, type EnsureFilesResult } from '../files'
import { checkVersionId, safeJoin, versionJsonPath, writeJsonAtomic } from '../fs-util'
import { fillMissingHashes, layerLibrarySpecs } from '../libraries'
import { coordinatePath } from '../maven'
import { platformOf, signalOf, step } from '../options'
import type { RawVersionJson } from '../version-json'
import { extractEntry, type ForgeInstallOptions } from './common'
import { parseLegacyProfile } from './profile'

/** Result of a legacy (`versionInfo`) install. */
export interface LegacyInstallResult {
  versionId: string
  libraries: EnsureFilesResult
}

/**
 * Install from a legacy installer jar (Forge 1.5.2 – 1.12.2 before the processor era):
 * extract the universal jar (`install.filePath`) to the Forge library's maven path, write
 * `versionInfo` as `versions/<id>/<id>.json` (with `inheritsFrom` set, since some old profiles are
 * standalone), then download its libraries. Library URLs on the retired `files.minecraftforge.net`
 * host are rewritten to the current maven, and a file matching **any** listed legacy checksum is
 * accepted. `clientreq`/`serverreq` are ignored (every library is installed, like the vanilla
 * launcher does), and so is the `jar` field.
 *
 * @throws {InstallError} `EINSTALL_BAD_INSTALLER` when `versionInfo` has no Forge library or the
 * universal jar is missing from the installer.
 */
export async function installLegacy(zip: ZipReader, installerPath: string, rawProfile: unknown, options: ForgeInstallOptions): Promise<LegacyInstallResult> {
  const signal = signalOf(options)
  const { root } = options
  const profile = parseLegacyProfile(rawProfile)
  const info = profile.versionInfo
  const versionId = checkVersionId(info.id)
  const forgeLib = (info.libraries ?? []).find((l) => /^net\.minecraftforge:(minecraft)?forge:/.test(l.name))
  if (!forgeLib) throw new InstallError('EINSTALL_BAD_INSTALLER', `${installerPath}: versionInfo lists no Forge library`, { path: installerPath })
  if (!(await zip.has(profile.install.filePath))) {
    throw new InstallError('EINSTALL_BAD_INSTALLER', `${installerPath} does not contain ${profile.install.filePath}`, { path: installerPath })
  }
  const forgePath = safeJoin(join(root, 'libraries'), coordinatePath(forgeLib.name))
  await step(options.ctx, 'unpack', 1, () => extractEntry(zip, profile.install.filePath, forgePath, signal))

  const json: RawVersionJson = { ...info, id: versionId, inheritsFrom: options.base ?? info.inheritsFrom ?? profile.install.minecraft }
  await writeJsonAtomic(versionJsonPath(root, versionId), json)

  const specs = layerLibrarySpecs(root, json, platformOf(options))
  // The Forge jar itself came from the installer: validate it locally, never download it.
  for (const spec of specs) {
    if (spec.path === forgePath) {
      spec.urls = []
      delete spec.sha1
      delete spec.sha1Any
      spec.validator = 'zip'
    }
  }
  const libraries = await step(options.ctx, 'libraries', Math.max(1, specs.length), async (ctx) => {
    await fillMissingHashes(specs, options.http, signal)
    return ensureFiles(specs, { signal, ctx, http: options.http, concurrency: options.concurrency })
  })
  return { versionId, libraries }
}
