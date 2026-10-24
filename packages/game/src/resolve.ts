/* oxlint-disable no-await-in-loop -- the inheritsFrom chain is walked sequentially */
/**
 * Resolving a version id: reading `versions/<id>/<id>.json`, following `inheritsFrom`, and
 * merging the chain root → leaf (launch.md §2).
 *
 * Rules are **not** evaluated here, because the JVM (and therefore the architecture) is chosen
 * after resolution, from the merged `javaVersion`. Libraries keep their layer order and are
 * evaluated and de-duplicated by {@link resolveLibraries} once the platform is known.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { GameError, throwIfAborted } from './errors'
import type { Argument, AssetIndexRef, DownloadEntry, JavaVersionRef, LibraryJson, LoggingClient, VersionJson } from './schema'
import { parseVersionJson } from './schema'

/** A library as declared by one layer of the chain, before rules are evaluated. */
export interface LayerLibrary {
  library: LibraryJson
  /** Id of the version JSON that declared it. */
  source: string
}

/** The merged view of a version and all of its parents. */
export interface ResolvedVersion {
  /** The requested (leaf) id. */
  id: string
  /** The underlying Minecraft version (root layer), e.g. `1.20.1` for `1.20.1-forge-47.4.28`. */
  minecraftVersion: string
  /** Ids from leaf to root. */
  inheritances: string[]
  /** Version directories from leaf to root. */
  pathChain: string[]
  /** The `versions` directory the chain was read from. */
  versionsDir: string
  mainClass: string
  /** The `assets` id (falls back to `assetIndex.id`, then `legacy`). */
  assets: string
  assetIndex?: AssetIndexRef
  type: string
  releaseTime?: string
  time?: string
  javaVersion: JavaVersionRef
  /**
   * The last *present* logging block. `{}` (modern Forge) disables the parent's config;
   * `undefined` means no layer declared one.
   */
  logging?: { client?: LoggingClient }
  compatibleJavaMajors?: number[]
  /** Merged per key; the child wins. */
  downloads: Record<string, DownloadEntry>
  minimumLauncherVersion: number
  arguments: {
    game: Argument[]
    jvm: Argument[]
    /** 26.x+: JVM options the vanilla launcher uses when the user configured none. */
    defaultUserJvm?: Argument[]
  }
  /** True when the effective game arguments come from a legacy `minecraftArguments` string. */
  legacyArguments: boolean
  /** Libraries of every layer, root first, in declaration order. Not yet evaluated or de-duplicated. */
  libraries: LayerLibrary[]
  /** The individual layers, leaf first. */
  layers: VersionJson[]
}

/** JVM arguments the vanilla launcher synthesised for legacy versions (the macOS subset). */
export const LEGACY_JVM_ARGUMENTS: readonly string[] = [
  '-Djava.library.path=${natives_directory}',
  '-Dminecraft.launcher.brand=${launcher_name}',
  '-Dminecraft.launcher.version=${launcher_version}',
  '-cp',
  '${classpath}',
]

const DEFAULT_JAVA: JavaVersionRef = { component: 'jre-legacy', majorVersion: 8 }

function checkId(id: string, from?: string): void {
  if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
    throw new GameError('EVERSION_INVALID', `Invalid version id ${JSON.stringify(id)}${from ? ` (inheritsFrom of ${from})` : ''}`, { version: id })
  }
}

export interface ResolveOptions {
  signal?: AbortSignal
}

/**
 * Read a version and its `inheritsFrom` ancestors from `versionsDir` and merge them.
 *
 * @throws {GameError} `EVERSION_MISSING` (with `details.version` = the id that is missing, which
 * may be a parent, and `details.files` listing what is in its folder), `EVERSION_CORRUPT`,
 * `EVERSION_INVALID`, or `EVERSION_CYCLE` (with `details.chain`).
 */
export async function resolveVersion(versionsDir: string, id: string, options: ResolveOptions = {}): Promise<ResolvedVersion> {
  const layers: VersionJson[] = []
  const pathChain: string[] = []
  const ids: string[] = []
  let current: string | undefined = id
  let from: string | undefined
  while (current !== undefined) {
    throwIfAborted(options.signal)
    checkId(current, from)
    if (ids.includes(current)) {
      throw new GameError('EVERSION_CYCLE', `Circular inheritsFrom: ${[...ids, current].join(' → ')}`, { version: id, chain: [...ids, current] })
    }
    const dir = path.join(versionsDir, current)
    const file = path.join(dir, `${current}.json`)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (e) {
      const files = await readdir(dir).catch(() => [] as string[])
      throw new GameError(
        'EVERSION_MISSING',
        `Version ${current} is not installed${current === id ? '' : ` (required by ${from})`}`,
        { version: current, requestedBy: from, path: file, files },
        { cause: e },
      )
    }
    const json = parseVersionJson(text, current)
    layers.push(json)
    pathChain.push(dir)
    ids.push(current)
    from = current
    current = json.inheritsFrom
  }
  return mergeVersionChain(layers, { versionsDir, ids, pathChain })
}

function nonEmpty<T>(v: T | undefined | null | ''): v is T {
  return v !== undefined && v !== null && v !== ''
}

/**
 * Merge already-parsed layers (leaf first) as described in launch.md §2.3. Exposed so the
 * installer can merge in-memory JSON without writing it first.
 */
export function mergeVersionChain(
  layers: readonly VersionJson[],
  context: { versionsDir: string; ids?: readonly string[]; pathChain?: readonly string[] },
): ResolvedVersion {
  if (layers.length === 0) throw new TypeError('mergeVersionChain needs at least one layer')
  const ids = context.ids ?? layers.map((l) => l.id)
  const leafId = ids[0] as string
  const rootIndex = layers.length - 1
  const root = layers[rootIndex] as VersionJson
  const rootId = ids[rootIndex] as string

  let mainClass: string | undefined
  let assets: string | undefined
  let assetIndex: AssetIndexRef | undefined
  let type: string | undefined
  let releaseTime: string | undefined
  let time: string | undefined
  let javaVersion: JavaVersionRef | undefined
  let logging: ResolvedVersion['logging']
  let compatibleJavaMajors: number[] | undefined
  let minimumLauncherVersion = 0
  let defaultUserJvm: Argument[] | undefined
  let legacyArguments = false
  const downloads: Record<string, DownloadEntry> = {}
  let game: Argument[] = []
  let jvm: Argument[] = []
  const libraries: LayerLibrary[] = []

  for (let i = rootIndex; i >= 0; i--) {
    const layer = layers[i] as VersionJson
    const layerId = ids[i] as string
    if (nonEmpty(layer.mainClass)) mainClass = layer.mainClass
    if (nonEmpty(layer.assets)) assets = layer.assets
    if (layer.assetIndex) assetIndex = layer.assetIndex
    if (nonEmpty(layer.type)) type = layer.type
    if (nonEmpty(layer.releaseTime)) releaseTime = layer.releaseTime
    if (nonEmpty(layer.time)) time = layer.time
    if (layer.javaVersion) javaVersion = layer.javaVersion
    if (layer.logging !== undefined) logging = layer.logging
    if (layer.compatibleJavaMajors !== undefined) compatibleJavaMajors = layer.compatibleJavaMajors
    if (layer.minimumLauncherVersion !== undefined) minimumLauncherVersion = Math.max(minimumLauncherVersion, layer.minimumLauncherVersion)
    if (layer.downloads) Object.assign(downloads, layer.downloads)

    if (layer.arguments) {
      game = [...game, ...(layer.arguments.game ?? [])]
      jvm = [...jvm, ...(layer.arguments.jvm ?? [])]
      if (layer.arguments['default-user-jvm']) defaultUserJvm = layer.arguments['default-user-jvm']
    } else if (nonEmpty(layer.minecraftArguments)) {
      // Legacy layers restate the whole command line, so they replace what the parents built.
      game = layer.minecraftArguments.split(' ').filter((a) => a !== '')
      jvm = [...LEGACY_JVM_ARGUMENTS]
      legacyArguments = true
    }

    for (const library of layer.libraries ?? []) libraries.push({ library, source: layerId })
  }

  if (!mainClass) throw new GameError('EVERSION_INVALID', `Version ${leafId} has no mainClass`, { version: leafId, missing: 'mainClass' })

  return {
    id: leafId,
    // oxlint-disable-next-line no-underscore-dangle -- third-party field name
    minecraftVersion: root.clientVersion || root._minecraftVersion || rootId,
    inheritances: [...ids],
    pathChain: [...(context.pathChain ?? ids.map((i) => path.join(context.versionsDir, i)))],
    versionsDir: context.versionsDir,
    mainClass,
    assets: assets ?? assetIndex?.id ?? 'legacy',
    assetIndex,
    type: type ?? 'release',
    releaseTime,
    time,
    javaVersion: javaVersion ?? DEFAULT_JAVA,
    logging,
    compatibleJavaMajors,
    downloads,
    minimumLauncherVersion,
    arguments: defaultUserJvm ? { game, jvm, defaultUserJvm } : { game, jvm },
    legacyArguments,
    libraries,
    layers: [...layers],
  }
}
