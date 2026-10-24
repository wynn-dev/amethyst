/* oxlint-disable no-await-in-loop -- descriptors and nested jars are read one at a time to bound memory */
import { openZip, type ZipReader } from '@amethyst/zip'
import { isAbortError, throwIfAborted, wrapFsError } from '../errors'
import { parseLenientJson } from '../util/json'
import { parseFabricModJson } from './fabric'
import { parseModsToml } from './forge'
import { parseLitemodJson, parseMcmodInfo, parseTweakerManifest } from './legacy'
import { parseManifest } from './manifest'
import { parseQuiltModJson } from './quilt'
import { preferredLoaderOrder, type InstanceLoader, type LoaderModMetadata, type ModLoader, type ModMetadata, type ParseWarning } from './types'

/** Options for {@link readModMetadata}. */
export interface ReadModOptions {
  /** Instance loader that decides which loader's metadata fills the top-level fields. Default `vanilla`. */
  preferLoader?: InstanceLoader
  /** How many levels of Fabric/Quilt jar-in-jar to follow for provided ids (default 2, 0 disables). */
  nestedDepth?: number
  /** Upper bound for a single descriptor file (default 4 MiB). */
  maxDescriptorBytes?: number
  /** Upper bound for a nested jar read into memory (default 64 MiB). */
  maxNestedJarBytes?: number
  signal?: AbortSignal
}

const DEFAULT_MAX_DESCRIPTOR = 4 * 1024 * 1024
const DEFAULT_MAX_NESTED = 64 * 1024 * 1024
const LEGACY_INFO_FILES = ['mcmod.info', 'cccmod.info', 'neimod.info']

interface Collected {
  byLoader: Partial<Record<ModLoader, LoaderModMetadata>>
  warnings: ParseWarning[]
  implementationVersion?: string
}

interface Ctx {
  zip: ZipReader
  names: Set<string>
  prefix: string
  warnings: ParseWarning[]
  options: Required<Pick<ReadModOptions, 'maxDescriptorBytes' | 'maxNestedJarBytes'>> & { signal?: AbortSignal }
}

/** Read a descriptor as text; problems become warnings and yield `undefined`. */
async function readText(ctx: Ctx, name: string): Promise<string | undefined> {
  if (!ctx.names.has(name)) return undefined
  try {
    return await ctx.zip.readText(name, { maxBytes: ctx.options.maxDescriptorBytes, signal: ctx.options.signal })
  } catch (e) {
    if (isAbortError(e)) throw e
    const code = (e as { code?: string }).code === 'EZIP_TOO_LARGE' ? 'too-large' : 'unreadable'
    ctx.warnings.push({ file: ctx.prefix + name, code, message: e instanceof Error ? e.message : String(e) })
    return undefined
  }
}

async function readJson(ctx: Ctx, name: string): Promise<{ value: unknown } | undefined> {
  const text = await readText(ctx, name)
  if (text === undefined) return undefined
  const parsed = parseLenientJson(text)
  if (!parsed.ok) {
    ctx.warnings.push({ file: ctx.prefix + name, code: 'invalid-json', message: parsed.error })
    return undefined
  }
  return { value: parsed.value }
}

function addWarnings(ctx: Ctx, warnings: ParseWarning[]): void {
  for (const w of warnings) ctx.warnings.push({ ...w, file: ctx.prefix + w.file })
}

/** Collect ids provided by nested jars (recursively, up to `depth` levels). */
async function nestedProvides(ctx: Ctx, jars: string[], depth: number, into: Record<string, string>): Promise<void> {
  if (depth <= 0) return
  for (const jar of jars) {
    throwIfAborted(ctx.options.signal)
    if (!ctx.names.has(jar)) {
      ctx.warnings.push({ file: ctx.prefix + jar, code: 'nested-jar', message: 'Declared nested jar is missing' })
      continue
    }
    let inner: ZipReader | undefined
    try {
      const bytes = await ctx.zip.readBuffer(jar, { maxBytes: ctx.options.maxNestedJarBytes, signal: ctx.options.signal })
      inner = await openZip(bytes)
      const child: Ctx = { ...ctx, zip: inner, names: new Set((await inner.entries()).map((e) => e.name)), prefix: `${ctx.prefix}${jar}!/` }
      for (const [file, parse] of [
        ['fabric.mod.json', parseFabricModJson],
        ['quilt.mod.json', parseQuiltModJson],
      ] as const) {
        const json = await readJson(child, file)
        if (!json) continue
        const out = parse(json.value, file)
        addWarnings(child, out.warnings)
        if (!out.meta) continue
        for (const [id, v] of Object.entries(out.meta.provides)) into[id] ??= v
        await nestedProvides(child, out.meta.nestedJars, depth - 1, into)
      }
    } catch (e) {
      if (isAbortError(e)) throw e
      ctx.warnings.push({ file: ctx.prefix + jar, code: 'nested-jar', message: e instanceof Error ? e.message : String(e) })
    } finally {
      await inner?.close()
    }
  }
}

async function collect(zip: ZipReader, options: ReadModOptions): Promise<Collected> {
  const warnings: ParseWarning[] = []
  const ctx: Ctx = {
    zip,
    names: new Set((await zip.entries()).map((e) => e.name)),
    prefix: '',
    warnings,
    options: {
      maxDescriptorBytes: options.maxDescriptorBytes ?? DEFAULT_MAX_DESCRIPTOR,
      maxNestedJarBytes: options.maxNestedJarBytes ?? DEFAULT_MAX_NESTED,
      signal: options.signal,
    },
  }
  const depth = options.nestedDepth ?? 2
  const byLoader: Collected['byLoader'] = {}

  const manifestText = await readText(ctx, 'META-INF/MANIFEST.MF')
  const manifest = manifestText === undefined ? {} : parseManifest(manifestText)
  const implementationVersion = manifest['Implementation-Version']?.trim() || undefined

  for (const [file, loader, parse] of [
    ['fabric.mod.json', 'fabric', parseFabricModJson],
    ['quilt.mod.json', 'quilt', parseQuiltModJson],
  ] as const) {
    const json = await readJson(ctx, file)
    if (!json) continue
    const out = parse(json.value, file)
    addWarnings(ctx, out.warnings)
    if (!out.meta) continue
    await nestedProvides(ctx, out.meta.nestedJars, depth, out.meta.provides)
    byLoader[loader] = out.meta
  }

  for (const [file, loader] of [
    ['META-INF/mods.toml', 'forge'],
    ['META-INF/neoforge.mods.toml', 'neoforge'],
  ] as const) {
    const text = await readText(ctx, file)
    if (text === undefined) continue
    const out = parseModsToml(text, { loader, file, jarVersion: implementationVersion })
    addWarnings(ctx, out.warnings)
    if (out.meta) byLoader[loader] = out.meta
  }

  // Legacy Forge: only consulted when there is no modern descriptor.
  if (!byLoader.forge) {
    const infoFiles = [...LEGACY_INFO_FILES, ...[...ctx.names].filter((n) => !n.includes('/') && n.endsWith('.info') && !LEGACY_INFO_FILES.includes(n))]
    for (const file of infoFiles) {
      const json = await readJson(ctx, file)
      if (!json) continue
      const out = parseMcmodInfo(json.value, file)
      addWarnings(ctx, out.warnings)
      if (out.meta) {
        byLoader.forge = out.meta
        break
      }
    }
  }
  if (!byLoader.forge && (manifest.TweakName !== undefined || manifest.FMLCorePlugin !== undefined)) {
    const metaFile = manifest.TweakMetaFile?.trim()
    const json = metaFile ? await readJson(ctx, `META-INF/${metaFile}`) : undefined
    const meta = parseTweakerManifest(manifest, json?.value)
    if (meta) byLoader.forge = meta
  }

  const lite = await readJson(ctx, 'litemod.json')
  if (lite) {
    const out = parseLitemodJson(lite.value)
    addWarnings(ctx, out.warnings)
    if (out.meta) byLoader.liteloader = out.meta
  }

  // Sinytra Connector runs Fabric mods on (Neo)Forge and provides Fabric Loader itself.
  const fabricLoaderVersion = manifest['Fabric-Loader-Version']?.trim()
  if (manifest['Automatic-Module-Name']?.trim() === 'org.sinytra.connector' && fabricLoaderVersion) {
    for (const meta of [byLoader.forge, byLoader.neoforge]) if (meta) meta.provides.fabricloader ??= fabricLoaderVersion
  }

  return { byLoader, warnings, implementationVersion }
}

/**
 * Re-derive the top-level fields of `meta` for an instance running `loader`. Use this when the
 * same file is shown in instances with different loaders; `byLoader` is unchanged.
 */
export function withPreferredLoader(meta: Pick<ModMetadata, 'byLoader' | 'warnings' | 'implementationVersion'>, loader: InstanceLoader = 'vanilla'): ModMetadata {
  const order = preferredLoaderOrder(loader)
  const loaders = order.filter((l) => meta.byLoader[l] !== undefined)
  const primaryLoader = loaders[0]
  const p = primaryLoader ? meta.byLoader[primaryLoader] : undefined
  return {
    loaders,
    byLoader: meta.byLoader,
    primaryLoader,
    id: p?.id,
    name: p?.name,
    version: p?.version,
    description: p?.description,
    authors: p?.authors ?? [],
    license: p?.license,
    icon: p?.icon,
    links: p?.links ?? {},
    environment: p?.environment ?? 'both',
    dependencies: p?.dependencies ?? [],
    provides: p?.provides ?? {},
    minecraftRange: p?.minecraftRange,
    loaderRange: p?.loaderRange,
    implementationVersion: meta.implementationVersion,
    warnings: meta.warnings,
  }
}

/**
 * Read every loader's metadata from a mod jar (a path, or an already open {@link ZipReader},
 * which is left open). Each descriptor that is present is parsed independently, so
 * multi-loader jars report all of their loaders. A jar with no known descriptor yields
 * `loaders: []`, which is not an error.
 *
 * Malformed descriptors never throw: they are skipped and reported in `warnings`.
 *
 * @throws {ContentError} `EINVALID_ZIP` when the archive itself cannot be read, `ENOT_FOUND` /
 * `EPERMISSION` for file system errors.
 */
export async function readModMetadata(source: string | ZipReader, options: ReadModOptions = {}): Promise<ModMetadata> {
  throwIfAborted(options.signal)
  let zip: ZipReader | undefined
  try {
    zip = typeof source === 'string' ? await openZip(source) : source
    return withPreferredLoader(await collect(zip, options), options.preferLoader)
  } catch (e) {
    throw wrapFsError(e, typeof source === 'string' ? `Cannot read mod ${source}` : 'Cannot read mod')
  } finally {
    if (typeof source === 'string') await zip?.close()
  }
}
