/* oxlint-disable no-await-in-loop -- installer entries are extracted one at a time */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ZipReader } from '@amethyst/zip'
import { InstallError } from '../errors'
import { ensureFiles, type EnsureFilesResult, type FileSpec } from '../files'
import { checkVersionId, pathExists, safeJoin, versionJarPath, versionJsonPath, writeJsonAtomic } from '../fs-util'
import { fillMissingHashes, layerLibrarySpecs, toolLibrarySpecs } from '../libraries'
import { coordinatePath } from '../maven'
import { platformOf, signalOf, step } from '../options'
import { checkVersionJson, type RawVersionJson } from '../version-json'
import { extractEntry, type ForgeInstallOptions } from './common'
import { artifactCoordinate, type ForgeArtifact } from './installer-jar'
import { type ModernProfile, parseModernProfile, type Processor } from './profile'
import {
  buildVariables,
  libraryDirOf,
  type ProcessorOutput,
  resolveDataValue,
  runProcessors,
  type RunProcessorsResult,
  type VariableContext,
} from './processors'

/** Result of a modern (processor-based) install. */
export interface ModernInstallResult {
  versionId: string
  profile: ModernProfile
  processors: RunProcessorsResult
  libraries: EnsureFilesResult
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * Handles `--task DOWNLOAD_MOJMAPS` without Java: the mappings are the vanilla version's
 * `downloads.<side>_mappings`, fetched with their sha1 (`install.md` §4.4 stage 2).
 */
function mojmapsHandler(options: ForgeInstallOptions) {
  return async (_processor: Processor, args: string[], _outputs: ProcessorOutput[]): Promise<boolean> => {
    if (argValue(args, '--task') !== 'DOWNLOAD_MOJMAPS' || args.includes('--sanitize')) return false
    const version = argValue(args, '--version')
    const side = argValue(args, '--side') ?? 'client'
    const output = argValue(args, '--output')
    if (!version || !output) return false
    const json = JSON.parse(await readFile(versionJsonPath(options.root, version), 'utf8')) as RawVersionJson
    const mappings = json.downloads?.[`${side}_mappings`]
    if (!mappings?.url || !mappings.sha1) return false
    const spec: FileSpec = { path: output, urls: [mappings.url], sha1: mappings.sha1, name: `${version} ${side} mappings` }
    if (mappings.size !== undefined) spec.size = mappings.size
    await ensureFiles([spec], { http: options.http, signal: signalOf(options) })
    return true
  }
}

/**
 * Install from a modern installer jar (`install_profile.json` + `version.json`, spec 0 or 1), in the
 * stages of `install.md` §4.4:
 *
 * 1. Extract every `maven/` entry into `<root>/libraries` and every in-jar `data` file
 *    (`/data/client.lzma` becomes `<installer coordinate>:clientdata@lzma`), then write
 *    `versions/<id>/install_profile.json` (with rewritten `data`, used by repair) and
 *    `versions/<id>/<id>.json` (with `inheritsFrom`).
 * 2. Download the processor libraries and the version's downloadable libraries.
 * 3. Run the client processors (skipping those whose outputs are valid) with `options.java`.
 * 4. Verify every library of the new version, including the ones the processors produced.
 *
 * The vanilla version (`versions/<mc>/<mc>.json` and its client jar) must already be installed.
 * The installer jar must already be verified (see `downloadVerifiedArtifact`).
 */
export async function installModern(zip: ZipReader, installerPath: string, artifact: ForgeArtifact, rawProfile: unknown, options: ForgeInstallOptions): Promise<ModernInstallResult> {
  const signal = signalOf(options)
  const { root } = options
  const libraryDir = libraryDirOf(root)
  const profile = parseModernProfile(rawProfile)
  const jsonEntry = (profile.json ?? '/version.json').replace(/^\/+/, '')
  let versionJson: RawVersionJson
  try {
    versionJson = checkVersionJson(JSON.parse(await zip.readText(jsonEntry)), `${installerPath}!/${jsonEntry}`)
  } catch (e) {
    throw new InstallError('EINSTALL_BAD_INSTALLER', `installer has no valid ${jsonEntry}: ${(e as Error).message}`, { cause: e, path: installerPath })
  }
  const versionId = checkVersionId(versionJson.id)
  const minecraft = profile.minecraft
  const minecraftJar = versionJarPath(root, minecraft)
  if (!(await pathExists(minecraftJar))) {
    throw new InstallError('EINSTALL_NOT_FOUND', `Minecraft ${minecraft} must be installed before ${versionId}`, { path: minecraftJar })
  }

  // Stage 1: unpack.
  await step(options.ctx, 'unpack', 1, async () => {
    const entries = await zip.entries()
    for (const e of entries) {
      if (e.isDirectory || !e.name.startsWith('maven/') || e.name.length <= 'maven/'.length) continue
      await extractEntry(zip, e.name, safeJoin(libraryDir, e.name.slice('maven/'.length)), signal)
    }
  })

  const installerCoord = (classifier: string, ext = 'jar') => `[${artifactCoordinate(artifact, classifier, ext)}]`
  const data = structuredClone(profile.data ?? {})
  const extracted = new Map<string, string>()
  for (const [key, value] of Object.entries(data)) {
    for (const side of ['client', 'server'] as const) {
      const v = value[side]
      if (!v.startsWith('/')) continue
      const entry = v.replace(/^\/+/, '')
      if (!(await zip.has(entry))) {
        if (side === 'client') throw new InstallError('EINSTALL_BAD_INSTALLER', `data.${key} refers to ${v}, which is not in the installer`, { path: installerPath })
        continue
      }
      // `/data/client.lzma` → `<group>:<artifact>:<version>:clientdata@lzma`; other entries next to the installer.
      const lzma = /^data\/(client|server)\.lzma$/.exec(entry)
      const coord = lzma ? installerCoord(`${lzma[1]}data`, 'lzma') : undefined
      const dest = coord ? safeJoin(libraryDir, coordinatePath(coord.slice(1, -1))) : safeJoin(dirname(installerPath), entry)
      if (!extracted.has(entry)) {
        await extractEntry(zip, entry, dest, signal)
        extracted.set(entry, dest)
      }
      value[side] = coord ?? `'${dest}'`
    }
  }
  data.INSTALLER = { client: installerCoord('installer'), server: installerCoord('installer') }

  const inheritsFrom = options.base ?? minecraft
  const storedProfile: ModernProfile = { ...profile, version: versionId, minecraft, data }
  delete storedProfile.icon
  await writeJsonAtomic(join(root, 'versions', versionId, 'install_profile.json'), storedProfile)
  const finalJson: RawVersionJson = { ...versionJson, id: versionId, inheritsFrom }
  await writeJsonAtomic(versionJsonPath(root, versionId), finalJson)

  // Stage 2: tool libraries plus the version's downloadable libraries.
  const platform = platformOf(options)
  const toolSpecs = toolLibrarySpecs(root, profile.libraries ?? [], platform)
  const versionSpecs = layerLibrarySpecs(root, finalJson, platform)
  await step(options.ctx, 'libraries', Math.max(1, toolSpecs.length), async (ctx) => {
    const specs = [...toolSpecs, ...versionSpecs.filter((s) => s.urls.length > 0)]
    await fillMissingHashes(specs, options.http, signal)
    return ensureFiles(specs, { signal, ctx, http: options.http, concurrency: options.concurrency })
  })

  // Stage 3: processors.
  const variables = buildVariables(data, {
    side: 'client',
    root,
    libraryDir,
    minecraftJar,
    minecraftVersion: minecraft,
    installer: installerPath,
  })
  const processors = await step(options.ctx, 'processors', Math.max(1, (profile.processors ?? []).length * 4), (ctx) =>
    runProcessors({
      processors: profile.processors ?? [],
      variables,
      libraryDir,
      cwd: root,
      side: 'client',
      java: options.java,
      jvmArgs: options.jvmArgs,
      runner: options.runner,
      timeoutMs: options.processorTimeoutMs,
      signal,
      ctx,
      onLog: options.onProcessorLog,
      handleNatively: mojmapsHandler(options),
    }),
  )

  // Stage 4: every library of the new layer must now be valid, including processor products.
  const libraries = await step(options.ctx, 'verify', 1, (ctx) => ensureFiles(versionSpecs, { signal, ctx, http: options.http, concurrency: options.concurrency }))
  return { versionId, profile: storedProfile, processors, libraries }
}

/**
 * Re-run stages 2–3 from the `versions/<id>/install_profile.json` written by an earlier install
 * (repair of processor outputs, `install.md` §10.3 `profile`). Valid outputs make processors no-ops.
 *
 * @throws {InstallError} `EINSTALL_NOT_FOUND` when the version has no stored profile.
 */
export async function rerunStoredProfile(versionId: string, options: ForgeInstallOptions): Promise<RunProcessorsResult> {
  const signal = signalOf(options)
  const { root } = options
  const libraryDir = libraryDirOf(root)
  const path = join(root, 'versions', checkVersionId(versionId), 'install_profile.json')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    throw new InstallError('EINSTALL_NOT_FOUND', `${versionId} has no stored install profile`, { path, cause: e })
  }
  const profile = parseModernProfile(raw)
  const toolSpecs = toolLibrarySpecs(root, profile.libraries ?? [], platformOf(options))
  await fillMissingHashes(toolSpecs, options.http, signal)
  await ensureFiles(toolSpecs, { signal, http: options.http, concurrency: options.concurrency })
  const ctx: VariableContext = {
    side: 'client',
    root,
    libraryDir,
    minecraftJar: versionJarPath(root, profile.minecraft),
    minecraftVersion: profile.minecraft,
    installer: '',
  }
  // The stored profile records the installer as a coordinate (stage 1 rewrote `data.INSTALLER`).
  const installer = profile.data?.INSTALLER?.client
  if (installer) ctx.installer = resolveDataValue(installer, ctx)
  const variables = buildVariables(profile.data, ctx)
  return runProcessors({
    processors: profile.processors ?? [],
    variables,
    libraryDir,
    cwd: root,
    java: options.java,
    jvmArgs: options.jvmArgs,
    runner: options.runner,
    timeoutMs: options.processorTimeoutMs,
    signal,
    ctx: options.ctx,
    onLog: options.onProcessorLog,
    handleNatively: mojmapsHandler(options),
  })
}
