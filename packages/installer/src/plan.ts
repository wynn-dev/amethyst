import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { HttpClient } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import { InstallError } from './errors'
import { installFabricLike } from './fabric'
import type { ForgeInstallOptions } from './forge/common'
import { type ForgeFormat, installForge, installNeoForge } from './forge/index'
import { artifactUrl, type ForgeArtifact } from './forge/installer-jar'
import { versionJsonPath, writeJsonAtomic } from './fs-util'
import { layerLibrarySpecs, resolveInstalled } from './libraries'
import { createMetadataClient, type MetadataClient } from './meta/client'
import { type FabricLikeKind, fabricLikeVersionId, parseLoaderProfile } from './meta/fabric'
import { forgeInstallKind } from './meta/forge'
import { neoForgeProjectOf } from './meta/neoforge'
import { requiredJavaMajor } from './minecraft-version'
import { platformOf, settleAll, signalOf, step, weightOf, type InstallOptions } from './options'
import { assetBytes, installAssets, installClientJar, installLibraries, installVersionJson, type VersionJsonSource } from './vanilla'
import { checkVersionJson, type RawVersionJson } from './version-json'
import { join } from 'node:path'

/** Mod loaders the installer supports. */
export type LoaderKind = 'fabric' | 'quilt' | 'forge' | 'neoforge'

/** What to install. */
export interface InstallRequest {
  /** Minecraft version id, e.g. `1.21.1` or `26.3`. */
  minecraft: string
  /** Optional loader layered over vanilla. `version` is the loader's own version (`0.16.14`, `47.3.0`, `21.1.209`). */
  loader?: { kind: LoaderKind; version: string }
}

/** Identifies a plan step (also the name of the child task `runInstall` reports it under). */
export type PlanStepId = 'version-json' | 'client' | 'libraries' | 'assets' | 'loader' | 'processors' | 'loader-libraries'

/** One step of an install, for showing an accurate progress bar before anything starts. */
export interface PlanStep {
  id: PlanStepId
  /** Bytes the step downloads at most, when known (already-valid files are skipped at run time). */
  bytes?: number
  /** Number of files, when known. */
  files?: number
  /** The step runs Java (Forge/NeoForge processors). */
  needsJava?: boolean
}

/** Resolved details of the loader layer. Plain data, structured-cloneable. */
export type PlannedLoader =
  | { kind: FabricLikeKind; version: string; profile: RawVersionJson }
  | { kind: 'forge'; version: string; artifactVersion: string; format: 'universal' | 'installer' }
  | { kind: 'neoforge'; version: string; artifactVersion: string }

/**
 * An install plan: ordered steps with their sizes, plus everything resolved from metadata so that
 * {@link runInstall} does not need to look it up again. Plain data (structured-cloneable), so it
 * can cross the IPC boundary.
 */
export interface InstallPlan {
  request: InstallRequest
  minecraft: {
    id: string
    /** Manifest entry; absent when planning offline from an installed version JSON. */
    source?: VersionJsonSource
  }
  loader?: PlannedLoader
  /**
   * The version id the install will produce. Exact for vanilla, Fabric, Quilt and NeoForge; for
   * Forge it follows Forge's naming and the real id is returned by {@link runInstall}.
   */
  versionId: string
  steps: PlanStep[]
  /** Sum of the known step sizes. */
  totalBytes: number
  /** Java major the version needs (for launching and, when `needsJava`, for processors). */
  javaMajor: number
  /** Whether a Java executable must be passed to {@link runInstall}. */
  needsJava: boolean
}

/** Options for {@link planInstall}. */
export interface PlanOptions extends Pick<InstallOptions, 'root' | 'http' | 'platform' | 'signal'> {
  meta?: MetadataClient
}

async function headSize(http: HttpClient, url: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const res = await http.request(url, { method: 'HEAD', signal, retry: { retries: 1 } })
    await res.body.dump().catch(() => {})
    const n = Number(res.headers['content-length'])
    return Number.isFinite(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

async function loadVanillaJson(id: string, options: PlanOptions, meta: MetadataClient): Promise<{ json: RawVersionJson; source?: VersionJsonSource }> {
  const signal = options.signal
  let source: VersionJsonSource | undefined
  try {
    const entry = await meta.minecraftVersion(id, { signal })
    source = { id: entry.id, url: entry.url, sha1: entry.sha1 }
  } catch (e) {
    if (signal?.aborted) throw e
    // Offline or unknown: fall back to an installed copy below.
    if (e instanceof InstallError && e.code === 'EINSTALL_NOT_FOUND') {
      const local = await readFile(versionJsonPath(options.root, id), 'utf8').catch(() => undefined)
      if (!local) throw e
    }
  }
  if (source) {
    // Prefer an installed copy that matches the manifest; otherwise fetch it into memory.
    const local = await readFile(versionJsonPath(options.root, id)).catch(() => undefined)
    if (local && createHash('sha1').update(local).digest('hex') === source.sha1.toLowerCase()) {
      return { json: checkVersionJson(JSON.parse(local.toString('utf8')), id), source }
    }
    const bytes = await meta.http.bytes(source.url, { signal })
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    if (sha1 !== source.sha1.toLowerCase()) {
      throw new InstallError('EINSTALL_CHECKSUM', `version JSON ${id}: expected sha1 ${source.sha1}, got ${sha1}`, { url: source.url })
    }
    return { json: checkVersionJson(JSON.parse(bytes.toString('utf8')), id), source }
  }
  const text = await readFile(versionJsonPath(options.root, id), 'utf8').catch(() => {
    throw new InstallError('EINSTALL_NOT_FOUND', `Minecraft ${id} is not installed and the version manifest is unavailable`)
  })
  return { json: checkVersionJson(JSON.parse(text), id) }
}

/**
 * The Fabric/Quilt launcher profile from the meta service. When the service cannot be reached, a
 * valid copy already installed as `versions/<versionId>/<versionId>.json` is used instead, so an
 * existing loader version can be installed for another instance while offline.
 */
async function loadLoaderProfile(kind: FabricLikeKind, minecraft: string, loader: string, versionId: string, options: PlanOptions, meta: MetadataClient): Promise<RawVersionJson> {
  try {
    return await meta.loaderProfile(kind, minecraft, loader, { signal: options.signal })
  } catch (e) {
    if (options.signal?.aborted) throw e
    const local = await readFile(versionJsonPath(options.root, versionId), 'utf8').catch(() => undefined)
    if (local === undefined) throw e
    try {
      return parseLoaderProfile(JSON.parse(local), minecraft, kind)
    } catch {
      throw e
    }
  }
}

const sumSizes = (specs: { size?: number }[]) => specs.reduce((n, s) => n + (s.size ?? 0), 0)

/**
 * Plan an install: resolve the Minecraft version (manifest v2, verified sha1) and the loader
 * (profile, maven metadata, install format), and list the steps with their sizes where known.
 * Planning reads metadata only; it writes nothing to disk.
 *
 * @throws {InstallError} `EINSTALL_NOT_FOUND` for unknown versions, `EINSTALL_UNSUPPORTED` for
 * builds that cannot be installed, metadata errors otherwise.
 */
export async function planInstall(request: InstallRequest, options: PlanOptions): Promise<InstallPlan> {
  const signal = options.signal
  const meta = options.meta ?? createMetadataClient({ http: options.http })
  const platform = platformOf(options)
  const { json, source } = await loadVanillaJson(request.minecraft, options, meta)
  const libs = layerLibrarySpecs(options.root, json, platform)
  const steps: PlanStep[] = [
    { id: 'version-json', files: 1 },
    { id: 'client', bytes: json.downloads?.client?.size, files: 1 },
    { id: 'libraries', bytes: sumSizes(libs), files: libs.length },
    { id: 'assets', bytes: assetBytes({ assetIndex: json.assetIndex }) },
  ]
  let versionId = request.minecraft
  let loader: PlannedLoader | undefined
  let needsJava = false
  const kind = request.loader?.kind
  const version = request.loader?.version ?? ''
  if (kind === 'fabric' || kind === 'quilt') {
    versionId = fabricLikeVersionId(kind, request.minecraft, version)
    const profile = await loadLoaderProfile(kind, request.minecraft, version, versionId, options, meta)
    const loaderLibs = layerLibrarySpecs(options.root, profile, platform)
    loader = { kind, version, profile }
    steps.push({ id: 'loader', files: 1 }, { id: 'loader-libraries', bytes: sumSizes(loaderLibs), files: loaderLibs.length })
  } else if (kind === 'forge') {
    const entry = (await meta.forgeVersions(request.minecraft, { signal })).find((v) => v.version === version || v.artifactVersion === version)
    if (!entry) throw new InstallError('EINSTALL_NOT_FOUND', `Forge ${version} for Minecraft ${request.minecraft} does not exist`)
    const file = forgeInstallKind(await meta.forgeFiles(entry.artifactVersion, { signal }))
    const artifact: ForgeArtifact = { group: 'net.minecraftforge', artifact: 'forge', version: entry.artifactVersion, repository: meta.endpoints.forgeMaven }
    loader = { kind, version: entry.version, artifactVersion: entry.artifactVersion, format: file.kind }
    needsJava = file.kind === 'installer'
    versionId = `${request.minecraft}-forge-${entry.version}`
    steps.push({ id: 'loader', bytes: await headSize(meta.http, artifactUrl(artifact, file.classifier, file.extension), signal), files: 1 })
    if (needsJava) steps.push({ id: 'processors', needsJava: true })
    steps.push({ id: 'loader-libraries' })
  } else if (kind === 'neoforge') {
    const project = neoForgeProjectOf(version)
    const entry = (await meta.neoForgeVersions(project === 'forge' ? '1.20.1' : undefined, { signal })).find(
      (v) => v.project === project && (v.version === version || v.artifactVersion === version),
    )
    if (!entry) throw new InstallError('EINSTALL_NOT_FOUND', `NeoForge ${version} does not exist`)
    if (entry.minecraft !== request.minecraft) {
      throw new InstallError('EINSTALL_UNSUPPORTED', `NeoForge ${version} is for Minecraft ${entry.minecraft}, not ${request.minecraft}`)
    }
    const artifact: ForgeArtifact = { group: 'net.neoforged', artifact: project, version: entry.artifactVersion, repository: meta.endpoints.neoForgeMaven }
    loader = { kind, version: entry.version, artifactVersion: entry.artifactVersion }
    needsJava = true
    versionId = project === 'forge' ? `${request.minecraft}-forge-${entry.version}` : `neoforge-${entry.version}`
    steps.push(
      { id: 'loader', bytes: await headSize(meta.http, artifactUrl(artifact, 'installer'), signal), files: 1 },
      { id: 'processors', needsJava: true },
      { id: 'loader-libraries' },
    )
  }
  return {
    request,
    minecraft: source ? { id: request.minecraft, source } : { id: request.minecraft },
    ...(loader ? { loader } : {}),
    versionId,
    steps,
    totalBytes: steps.reduce((n, s) => n + (s.bytes ?? 0), 0),
    javaMajor: requiredJavaMajor(json),
    needsJava,
  }
}

/** Options for {@link runInstall}. */
export interface RunInstallOptions extends ForgeInstallOptions {
  meta?: MetadataClient
  /**
   * Java for Forge/NeoForge processors: a path, or a function that returns (and may install) a
   * runtime for the plan's `javaMajor`. Required when `plan.needsJava`.
   */
  java?: string
  resolveJava?: (major: number, signal?: AbortSignal) => Promise<string>
}

/** Result of {@link runInstall}. */
export interface InstallResult {
  /** The installed version id; link the instance to it. */
  versionId: string
  minecraftVersion: string
  /** Java major needed to launch it (from the merged version JSON). */
  javaMajor: number
  loader?: { kind: LoaderKind; version: string; format?: ForgeFormat }
}

/** The `.install-lock` file written after a successful install. */
export interface InstallLock {
  schemaVersion: 1
  version: string
  /**
   * When the install finished (ms). Files not modified since are trusted by later diagnoses
   * (sizes only, no hashing), so it must not be earlier than the files this install wrote.
   */
  timestamp: number
}

/**
 * Execute a plan: the vanilla version JSON first, then the client jar, libraries and assets, with
 * the loader layered on top (Fabric/Quilt run alongside the vanilla downloads; Forge/NeoForge wait
 * for the client jar and libraries, while assets keep downloading). A final libraries pass covers
 * the merged chain, and `versions/<id>/.install-lock` is written with the start time.
 *
 * Every stage is a weighted child task of `options.ctx` (weights follow the plan's byte sizes).
 * Idempotent: re-running skips valid files and repairs bad ones. Cancelling stops downloads and
 * processors promptly.
 */
export async function runInstall(plan: InstallPlan, options: RunInstallOptions): Promise<InstallResult> {
  const startedAt = Date.now()
  const signal = signalOf(options)
  const ctx: TaskContext | undefined = options.ctx
  const weight = (id: PlanStepId) => weightOf(plan.steps.find((s) => s.id === id)?.bytes)
  const mc = plan.minecraft.id
  const meta = options.meta ?? createMetadataClient({ http: options.http })

  await step(ctx, 'version-json', 1, (c) => installVersionJson(mc, plan.minecraft.source, { ...options, ctx: c }), { version: mc })
  const vanilla = await resolveInstalled(options.root, mc, signal)
  const client = step(ctx, 'client', weight('client'), (c) => installClientJar(vanilla, { ...options, ctx: c }), { version: mc })
  const libraries = step(ctx, 'libraries', weight('libraries'), (c) => installLibraries(vanilla, { ...options, ctx: c }))
  const assets = step(ctx, 'assets', weight('assets'), (c) => installAssets(vanilla, { ...options, ctx: c }), { assets: vanilla.assets })

  let versionId = mc
  let format: ForgeFormat | undefined
  const loader = plan.loader
  const loaderWeight = weight('loader') + (plan.needsJava ? 20 : 0)
  let loaderTask: Promise<unknown> = Promise.resolve()
  if (loader && (loader.kind === 'fabric' || loader.kind === 'quilt')) {
    loaderTask = step(ctx, 'loader', loaderWeight, async (c) => {
      versionId = (await installFabricLike(loader.kind, mc, loader.version, { ...options, ctx: c, meta, profile: loader.profile })).versionId
    }, { kind: loader.kind, version: loader.version })
  } else if (loader && (loader.kind === 'forge' || loader.kind === 'neoforge')) {
    const forgeLoader = loader
    // Forge/NeoForge processors consume the client jar and need the vanilla libraries.
    loaderTask = settleAll([client, libraries]).then(() =>
      step(ctx, 'loader', loaderWeight, async (c) => {
        let java = options.java
        if (!java && options.resolveJava && plan.needsJava) java = await options.resolveJava(plan.javaMajor, signal)
        const forgeOptions = { ...options, ctx: c, meta, java }
        const r =
          forgeLoader.kind === 'forge' ? await installForge(mc, forgeLoader.artifactVersion, forgeOptions) : await installNeoForge(forgeLoader.artifactVersion, forgeOptions)
        versionId = r.versionId
        format = r.format
      }, { kind: loader.kind, version: loader.version }),
    )
  }
  await settleAll([client, libraries, assets, loaderTask])

  // Final libraries pass over the merged chain (picks up anything a loader layer added).
  const merged = await resolveInstalled(options.root, versionId, signal)
  if (versionId !== mc) await step(ctx, 'loader-libraries', 1, (c) => installLibraries(merged, { ...options, ctx: c }))
  // The finish time, not the start: everything this install downloaded is older than it, so a
  // pre-launch diagnose trusts those files by size instead of re-hashing thousands of assets.
  const lock: InstallLock = { schemaVersion: 1, version: versionId, timestamp: Math.max(Date.now(), startedAt) }
  await writeJsonAtomic(join(options.root, 'versions', versionId, '.install-lock'), lock)
  const result: InstallResult = { versionId, minecraftVersion: mc, javaMajor: requiredJavaMajor(merged, mc) }
  if (loader) result.loader = format ? { kind: loader.kind, version: loader.version, format } : { kind: loader.kind, version: loader.version }
  return result
}
