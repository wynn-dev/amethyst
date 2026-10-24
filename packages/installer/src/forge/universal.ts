/* oxlint-disable no-await-in-loop -- zip entries are copied in order */
import { stat } from 'node:fs/promises'
import { createZip, openZip, type ZipReader } from '@amethyst/zip'
import { InstallError } from '../errors'
import { ensureFiles, type EnsureFilesResult, isValidZip } from '../files'
import { checkVersionId, pathExists, versionJarPath, versionJsonPath, writeJsonAtomic } from '../fs-util'
import { layerLibrarySpecs } from '../libraries'
import { platformOf, signalOf, step } from '../options'
import type { RawVersionJson } from '../version-json'
import type { ForgeInstallOptions } from './common'
import { artifactPath, downloadVerifiedArtifact, type ForgeArtifact } from './installer-jar'

/**
 * Libraries that pre-installer FML (1.3.2 – 1.5.1) downloaded at first start from servers that are
 * long gone. sha1s verified against the Forge maven and Maven Central `.sha1` sidecars.
 */
export const LEGACY_FML_LIBRARIES = [
  { name: 'com.google.guava:guava:12.0.1', sha1: 'b8e78b9af7bf45900e14c6f958486b6ca682195f' },
  { name: 'net.sourceforge.argo:argo:2.25', sha1: 'bb672829fde76cb163004752b86b0484bd0a7f4b' },
  { name: 'org.ow2.asm:asm-all:4.0', sha1: '2518725354c7a6a491a323249b9e86846b00df09' },
  { name: 'org.bouncycastle:bcprov-jdk15on:1.47', sha1: 'b6f5d9926b0afbde9f4dbe3db88c5247be7794bb' },
] as const

/** Result of a universal-zip install. */
export interface UniversalInstallResult {
  versionId: string
  libraries: EnsureFilesResult
}

/**
 * Merge `vanillaJar` and `forgeZip` into `dest`: vanilla entries first, then Forge's, a later entry
 * with the same name winning; every `META-INF` entry is dropped (this strips the jar signature).
 */
export async function mergeJars(vanillaJar: string, forgeZip: string, dest: string, signal?: AbortSignal): Promise<void> {
  const readers: ZipReader[] = []
  try {
    const vanilla = await openZip(vanillaJar)
    readers.push(vanilla)
    const forge = await openZip(forgeZip)
    readers.push(forge)
    const sources = new Map<string, ZipReader>()
    for (const reader of [vanilla, forge]) {
      for (const e of await reader.entries()) {
        if (e.isDirectory || e.isSymlink || /^META-INF/i.test(e.name)) continue
        sources.set(e.name, reader)
      }
    }
    const writer = createZip(dest, { signal })
    try {
      for (const [name, reader] of sources) writer.addBuffer(await reader.readBuffer(name, { signal }), name)
      await writer.finish()
    } catch (e) {
      await writer.abort()
      throw e
    }
  } finally {
    await Promise.all(readers.map((r) => r.close()))
  }
}

/**
 * Install a Forge build that has no installer (Minecraft 1.1 – 1.5.1): download the verified
 * universal (or, for the oldest builds, client) zip, merge it over the vanilla client jar into
 * `libraries/net/minecraftforge/forge/<v>/forge-<v>.jar`, and write
 * `versions/<mc>-forge-<build>/<mc>-forge-<build>.json` with LaunchWrapper as the main class and
 * the FML runtime libraries that old FML can no longer download itself.
 *
 * Best effort: whether old FML also needs these libraries under `<gameDir>/lib/` has not been
 * verified with a real launch (see `install.md` §4.2).
 */
export async function installUniversal(
  artifact: ForgeArtifact,
  file: { classifier: string; extension: string; md5?: string },
  minecraft: string,
  build: string,
  options: ForgeInstallOptions,
): Promise<UniversalInstallResult> {
  const signal = signalOf(options)
  const { root } = options
  const vanillaJar = versionJarPath(root, minecraft)
  if (!(await pathExists(vanillaJar))) throw new InstallError('EINSTALL_NOT_FOUND', `Minecraft ${minecraft} must be installed first`, { path: vanillaJar })
  const { path: universal } = await step(options.ctx, 'download', 1, (ctx) =>
    downloadVerifiedArtifact(artifact, file.classifier, file.extension, { root, http: options.http, signal, ctx, md5: file.md5 }),
  )
  const merged = artifactPath(root, artifact, '')
  const fresh = async () => {
    if (!(await isValidZip(merged))) return false
    const [m, a, b] = await Promise.all([stat(merged), stat(universal), stat(vanillaJar)])
    return m.mtimeMs >= a.mtimeMs && m.mtimeMs >= b.mtimeMs
  }
  if (!(await fresh())) await step(options.ctx, 'merge', 2, () => mergeJars(vanillaJar, universal, merged, signal))

  const versionId = checkVersionId(`${minecraft}-forge-${build}`)
  const json: RawVersionJson = {
    id: versionId,
    inheritsFrom: options.base ?? minecraft,
    type: 'release',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    arguments: { game: [], jvm: ['-Dminecraft.applet.TargetDirectory=${game_directory}'] },
    libraries: [
      { name: `${artifact.group}:${artifact.artifact}:${artifact.version}`, downloads: { artifact: { url: '' } } },
      ...LEGACY_FML_LIBRARIES.map((l) => ({ name: l.name, url: artifact.repository, sha1: l.sha1 })),
    ],
  }
  await writeJsonAtomic(versionJsonPath(root, versionId), json)
  const specs = layerLibrarySpecs(root, json, platformOf(options))
  for (const spec of specs) if (spec.path === merged) spec.validator = 'zip'
  const libraries = await step(options.ctx, 'libraries', 1, (ctx) => ensureFiles(specs, { signal, ctx, http: options.http, trustedBefore: options.trustedBefore }))
  return { versionId, libraries }
}
