import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GameError, parseAssetIndex, type ResolvedVersion } from '@amethyst/game'
import type { TaskContext } from '@amethyst/task'
import { InstallError } from './errors'
import { ensureFiles, type EnsureFilesResult, type FileSpec } from './files'
import { hardLink, safeJoin, versionJarPath, versionJsonPath } from './fs-util'
import { fillMissingHashes, resolveInstalled, versionLibrarySpecs } from './libraries'
import { joinUrl } from './maven'
import { ASSETS_BASE_URL, type InstallOptions, platformOf, settleAll, signalOf, step, weightOf } from './options'
import { checkVersionJson, type RawVersionJson } from './version-json'

/** Where a vanilla version JSON comes from: a manifest v2 entry (or the same fields). */
export interface VersionJsonSource {
  id: string
  url: string
  /** sha1 of the JSON, from the v2 manifest. The download is verified against it. */
  sha1: string
}

/**
 * Make `versions/<id>/<id>.json` exist and match the manifest sha1, downloading it when it is
 * missing, unparseable or different (Mojang occasionally re-publishes JSON). Without a `source`
 * the local file must already be valid (offline re-install).
 *
 * @throws {InstallError} `EINSTALL_NOT_FOUND` when there is neither a source nor a local file,
 * `EINSTALL_BAD_METADATA` when the JSON is invalid.
 */
export async function installVersionJson(id: string, source: VersionJsonSource | undefined, options: InstallOptions): Promise<RawVersionJson> {
  const path = versionJsonPath(options.root, id)
  if (source) {
    await ensureFiles([{ path, urls: [source.url], sha1: source.sha1, validator: 'json', name: `${id}.json` }], {
      signal: signalOf(options),
      http: options.http,
      ctx: options.ctx,
    })
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new InstallError('EINSTALL_NOT_FOUND', `version ${id} is not installed and no download source was given`, { path })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    throw new InstallError('EINSTALL_BAD_METADATA', `${path} is not valid JSON`, { path, cause: e })
  }
  return checkVersionJson(value, path)
}

/** The client jar of a resolved version: `versions/<mc>/<mc>.jar`, always fully hashed. */
export function clientJarSpec(root: string, version: Pick<ResolvedVersion, 'minecraftVersion' | 'downloads'>): FileSpec | undefined {
  const client = version.downloads.client
  if (!client?.url) return undefined
  const spec: FileSpec = { path: versionJarPath(root, version.minecraftVersion), urls: [client.url], alwaysHash: true, name: `${version.minecraftVersion}.jar` }
  if (client.sha1) spec.sha1 = client.sha1.toLowerCase()
  else spec.validator = 'zip'
  if (client.size !== undefined) spec.size = client.size
  return spec
}

/** The asset index (stored under its sha1, `assets/indexes/<sha1>.json`) and the log4j config. */
export function assetMetadataSpecs(root: string, version: Pick<ResolvedVersion, 'assets' | 'assetIndex' | 'logging'>): { index?: FileSpec; logConfig?: FileSpec } {
  const out: { index?: FileSpec; logConfig?: FileSpec } = {}
  const assets = join(root, 'assets')
  const ref = version.assetIndex
  if (ref?.url) {
    const name = ref.sha1 ? ref.sha1.toLowerCase() : version.assets
    const index: FileSpec = { path: safeJoin(assets, 'indexes', `${name}.json`), urls: [ref.url], validator: 'json', name: `asset index ${version.assets}` }
    if (ref.sha1) index.sha1 = ref.sha1.toLowerCase()
    if (ref.size !== undefined) index.size = ref.size
    out.index = index
  }
  const file = version.logging?.client?.file
  if (file?.url) {
    const log: FileSpec = { path: safeJoin(assets, 'log_configs', file.id), urls: [file.url], name: file.id }
    if (file.sha1) log.sha1 = file.sha1.toLowerCase()
    if (file.size !== undefined) log.size = file.size
    out.logConfig = log
  }
  return out
}

/** Bytes the assets step will download at most (index + objects), from `assetIndex.totalSize`. */
export function assetBytes(version: Pick<ResolvedVersion, 'assetIndex'>): number {
  return (version.assetIndex?.size ?? 0) + (version.assetIndex?.totalSize ?? 0)
}

/**
 * Download the client jar of a resolved version.
 */
export async function installClientJar(version: ResolvedVersion, options: InstallOptions): Promise<EnsureFilesResult> {
  const spec = clientJarSpec(options.root, version)
  if (!spec) throw new InstallError('EINSTALL_BAD_METADATA', `version ${version.id} has no client download`)
  return ensureFiles([spec], { signal: signalOf(options), ctx: options.ctx, http: options.http, trustedBefore: options.trustedBefore })
}

/**
 * Download every library of a resolved version (all layers, de-duplicated, rules evaluated for
 * `options.platform`). Libraries published without a hash get their maven `.sha1` sidecar.
 * Libraries with no URL (produced by a Forge/NeoForge installer) must already exist.
 */
export async function installLibraries(version: ResolvedVersion, options: InstallOptions & { skipLocal?: boolean }): Promise<EnsureFilesResult> {
  const signal = signalOf(options)
  let specs = versionLibrarySpecs(options.root, version, platformOf(options))
  if (options.skipLocal) specs = specs.filter((s) => s.urls.length > 0)
  await fillMissingHashes(specs, options.http, signal)
  return ensureFiles(specs, { signal, ctx: options.ctx, http: options.http, concurrency: options.concurrency, trustedBefore: options.trustedBefore })
}

/**
 * Download the asset index (hash-named, with a hard-linked `<assets id>.json` alias that the game
 * and older tools read), the log4j config and every asset object (`assets/objects/<hh>/<hash>`).
 * Existing objects of the right size are trusted; new downloads are always hashed.
 */
export async function installAssets(version: ResolvedVersion, options: InstallOptions): Promise<EnsureFilesResult> {
  const signal = signalOf(options)
  const { index, logConfig } = assetMetadataSpecs(options.root, version)
  const meta = [index, logConfig].filter((s): s is FileSpec => !!s)
  const base = { signal, http: options.http, trustedBefore: options.trustedBefore }
  const total: EnsureFilesResult = { downloaded: 0, skipped: 0, bytes: 0 }
  const add = (r: EnsureFilesResult) => {
    total.downloaded += r.downloaded
    total.skipped += r.skipped
    total.bytes += r.bytes
  }
  if (meta.length > 0) add(await ensureFiles(meta, base))
  if (!index) return total

  const alias = safeJoin(join(options.root, 'assets'), 'indexes', `${version.assets}.json`)
  if (alias !== index.path) await hardLink(index.path, alias)

  let parsed
  try {
    parsed = parseAssetIndex(await readFile(index.path, 'utf8'), index.path)
  } catch (e) {
    if (e instanceof GameError) throw new InstallError('EINSTALL_BAD_METADATA', e.message, { cause: e, path: index.path })
    throw e
  }
  const assetsBase = options.assetsBaseUrl ?? ASSETS_BASE_URL
  const seen = new Set<string>()
  const objects: FileSpec[] = []
  for (const { hash, size } of Object.values(parsed.objects)) {
    if (seen.has(hash)) continue
    seen.add(hash)
    const rel = `${hash.slice(0, 2)}/${hash}`
    objects.push({ path: join(options.root, 'assets', 'objects', hash.slice(0, 2), hash), urls: [joinUrl(assetsBase, rel)], sha1: hash, size, trustSize: true })
  }
  add(await ensureFiles(objects, { ...base, ctx: options.ctx, concurrency: options.concurrency }))
  return total
}

/** Options for {@link installVanilla}. */
export interface InstallVanillaOptions extends InstallOptions {
  /** Manifest entry for the version. Without it, `versions/<id>/<id>.json` must already exist. */
  source?: VersionJsonSource
}

/**
 * Install a vanilla version: the version JSON first, then the client jar, libraries and assets in
 * parallel (each a weighted child task of `ctx`). All branches are awaited even when one fails; the
 * first failure is then thrown. Idempotent: valid files are skipped, bad ones replaced.
 *
 * @returns the resolved version.
 */
export async function installVanilla(id: string, options: InstallVanillaOptions): Promise<ResolvedVersion> {
  await step(options.ctx, 'version-json', 1, (ctx) => installVersionJson(id, options.source, { ...options, ctx }), { version: id })
  const version = await resolveInstalled(options.root, id, signalOf(options))
  await installVanillaFiles(version, options)
  return version
}

/** The parallel part of {@link installVanilla}: client jar, libraries and assets of `version`. */
export async function installVanillaFiles(version: ResolvedVersion, options: InstallOptions): Promise<void> {
  const ctx: TaskContext | undefined = options.ctx
  const libBytes = versionLibrarySpecs(options.root, version, platformOf(options)).reduce((n, s) => n + (s.size ?? 0), 0)
  await settleAll([
    step(ctx, 'client', weightOf(version.downloads.client?.size), (c) => installClientJar(version, { ...options, ctx: c }), { version: version.minecraftVersion }),
    step(ctx, 'libraries', weightOf(libBytes), (c) => installLibraries(version, { ...options, ctx: c })),
    step(ctx, 'assets', weightOf(assetBytes(version)), (c) => installAssets(version, { ...options, ctx: c }), { assets: version.assets }),
  ])
}
