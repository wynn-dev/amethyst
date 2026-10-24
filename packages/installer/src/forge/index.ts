import { openZip } from '@amethyst/zip'
import { InstallError } from '../errors'
import { createMetadataClient, type MetadataClient } from '../meta/client'
import { forgeInstallKind } from '../meta/forge'
import { neoForgeProjectOf } from '../meta/neoforge'
import { signalOf, step } from '../options'
import { type ForgeInstallOptions, forgeMutex } from './common'
import { downloadVerifiedArtifact, type ForgeArtifact } from './installer-jar'
import { installLegacy } from './legacy'
import { installModern } from './modern'
import { isLegacyProfile } from './profile'
import type { RunProcessorsResult } from './processors'
import { installUniversal } from './universal'

/** Options for {@link installForge} and {@link installNeoForge}. */
export interface InstallForgeOptions extends ForgeInstallOptions {
  /** Metadata client (a fresh one with default endpoints otherwise). */
  meta?: MetadataClient
}

/** Which historical format an install used. */
export type ForgeFormat = 'universal' | 'legacy' | 'modern'

/** Result of a Forge/NeoForge install. */
export interface ForgeInstallResult {
  /** The version id written, e.g. `1.20.1-forge-47.3.0`, `neoforge-21.1.209`, `1.7.10-Forge10.13.4.1614-1.7.10`. */
  versionId: string
  minecraft: string
  format: ForgeFormat
  /** Present for the modern format. */
  processors?: RunProcessorsResult
}

/**
 * Install from an installer jar that has **already been verified** (see
 * `downloadVerifiedArtifact`): reads `install_profile.json` and dispatches to the legacy
 * (`versionInfo`) or modern (`version.json` + processors) flow.
 *
 * @throws {InstallError} `EINSTALL_BAD_INSTALLER` when the jar has no usable profile.
 */
export async function installFromInstaller(installerPath: string, artifact: ForgeArtifact, minecraft: string, options: ForgeInstallOptions): Promise<ForgeInstallResult> {
  const zip = await openZip(installerPath).catch((e: unknown) => {
    throw new InstallError('EINSTALL_BAD_INSTALLER', `${installerPath} is not a valid jar`, { cause: e, path: installerPath })
  })
  try {
    let raw: unknown
    try {
      raw = JSON.parse(await zip.readText('install_profile.json'))
    } catch (e) {
      throw new InstallError('EINSTALL_BAD_INSTALLER', `${installerPath} has no valid install_profile.json`, { cause: e, path: installerPath })
    }
    if (isLegacyProfile(raw)) {
      const r = await installLegacy(zip, installerPath, raw, options)
      return { versionId: r.versionId, minecraft, format: 'legacy' }
    }
    const r = await installModern(zip, installerPath, artifact, raw, options)
    return { versionId: r.versionId, minecraft: r.profile.minecraft, format: 'modern', processors: r.processors }
  } finally {
    await zip.close()
  }
}

/**
 * Install Forge `version` (the build, e.g. `47.3.0`, or the exact maven version) for `minecraft`.
 *
 * The exact artifact version is looked up in `maven-metadata.xml` (never guessed) and the install
 * format is chosen from the build's `meta.json`: builds without an installer (1.1 – 1.5.1) are
 * merged into the vanilla jar; others run their installer's legacy or modern flow. The installer
 * is verified against the maven's `.sha256`/`.sha1` sidecar (or, if neither exists, Forge's md5)
 * **before** it is opened, and the install fails closed otherwise. Only one Forge/NeoForge install
 * runs at a time. The vanilla version must already be installed.
 */
export async function installForge(minecraft: string, version: string, options: InstallForgeOptions): Promise<ForgeInstallResult> {
  const signal = signalOf(options)
  const meta = options.meta ?? createMetadataClient({ http: options.http })
  const entry = (await meta.forgeVersions(minecraft, { signal })).find((v) => v.version === version || v.artifactVersion === version)
  if (!entry) throw new InstallError('EINSTALL_NOT_FOUND', `Forge ${version} for Minecraft ${minecraft} does not exist`)
  const artifact: ForgeArtifact = { group: 'net.minecraftforge', artifact: 'forge', version: entry.artifactVersion, repository: meta.endpoints.forgeMaven }
  const file = forgeInstallKind(await meta.forgeFiles(entry.artifactVersion, { signal }))
  return forgeMutex.run(
    'forge',
    async () => {
      if (file.kind === 'universal') {
        const r = await installUniversal(artifact, file, minecraft, entry.version, options)
        return { versionId: r.versionId, minecraft, format: 'universal' as const }
      }
      const { path } = await step(options.ctx, 'installer', 1, (ctx) =>
        downloadVerifiedArtifact(artifact, 'installer', 'jar', { root: options.root, http: options.http, signal, ctx, md5: file.md5 }),
      )
      return installFromInstaller(path, artifact, minecraft, options)
    },
    signal,
  )
}

/**
 * Install NeoForge `version` (e.g. `21.1.209`, `26.3.0.97`, or `47.1.106`/`1.20.1-47.1.106` for
 * 1.20.1, which lives in the legacy `net.neoforged:forge` project). The exact published version is
 * taken from the maven metadata. The installer must have a `.sha256`/`.sha1` sidecar; otherwise
 * the install fails closed. Then the modern installer flow runs.
 */
export async function installNeoForge(version: string, options: InstallForgeOptions): Promise<ForgeInstallResult> {
  const signal = signalOf(options)
  const meta = options.meta ?? createMetadataClient({ http: options.http })
  const project = neoForgeProjectOf(version)
  const entry = (await meta.neoForgeVersions(project === 'forge' ? '1.20.1' : undefined, { signal })).find(
    (v) => v.project === project && (v.version === version || v.artifactVersion === version),
  )
  if (!entry) throw new InstallError('EINSTALL_NOT_FOUND', `NeoForge ${version} does not exist`)
  const artifact: ForgeArtifact = { group: 'net.neoforged', artifact: project, version: entry.artifactVersion, repository: meta.endpoints.neoForgeMaven }
  return forgeMutex.run(
    'forge',
    async () => {
      const { path } = await step(options.ctx, 'installer', 1, (ctx) => downloadVerifiedArtifact(artifact, 'installer', 'jar', { root: options.root, http: options.http, signal, ctx }))
      return installFromInstaller(path, artifact, entry.minecraft, options)
    },
    signal,
  )
}
