import { isObject, str, strList, type JsonObject } from '../util/json'
import { normalizeJarPath, personList, type ParserOutput } from './common'
import type { LoaderModMetadata, ModDependency } from './types'

/** `modid@[1.0,)` → `{ modId, range }`. */
function idAtRange(spec: string): { modId: string; range?: string } | undefined {
  const at = spec.indexOf('@')
  const modId = (at === -1 ? spec : spec.slice(0, at)).trim()
  if (modId === '') return undefined
  const range = at === -1 ? undefined : spec.slice(at + 1).trim() || undefined
  return { modId: modId.toLowerCase() === 'forge' ? 'forge' : modId, ...(range ? { range } : {}) }
}

/**
 * Parse a legacy `@Mod(dependencies = "...")` string such as
 * `required-after:forge@[14.23,);after:jei;`. Only `required-*` entries are kept.
 */
export function parseLegacyDependencyString(value: string): ModDependency[] {
  const out: ModDependency[] = []
  for (const part of value.split(';')) {
    const colon = part.indexOf(':')
    if (colon === -1 || !part.slice(0, colon).includes('required')) continue
    const parsed = idAtRange(part.slice(colon + 1))
    if (parsed) out.push({ ...parsed, rangeKind: 'maven', required: true, kind: 'depends' })
  }
  return out
}

function mcmodEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isObject)
  if (isObject(value)) {
    if (Array.isArray(value.modList)) return value.modList.filter(isObject)
    return [value]
  }
  return []
}

/** Parse an already-decoded `mcmod.info` (an array, `{ modListVersion: 2, modList }` or one object). */
export function parseMcmodInfo(value: unknown, file = 'mcmod.info'): ParserOutput<LoaderModMetadata> {
  const entries = mcmodEntries(value)
  const primary = entries.find((e) => str(e.modid) !== undefined)
  const id = primary ? str(primary.modid) : undefined
  if (!primary || id === undefined) return { warnings: [{ file, code: 'invalid-shape', message: `${file} declares no modid` }] }

  const provides: Record<string, string> = {}
  for (const e of entries) {
    const mid = str(e.modid)
    if (mid !== undefined) provides[mid] ??= str(e.version) ?? ''
  }
  const dependencies: ModDependency[] = []
  const seen = new Set<string>()
  for (const spec of [...strList(primary.requiredMods), ...strList(primary.dependencies)]) {
    const parsed = idAtRange(spec)
    if (!parsed || seen.has(parsed.modId)) continue
    seen.add(parsed.modId)
    dependencies.push({ ...parsed, rangeKind: 'maven', required: true, kind: 'depends' })
  }
  const mcversion = str(primary.mcversion)

  const meta: LoaderModMetadata = {
    loader: 'forge',
    source: file,
    id,
    name: str(primary.name),
    version: str(primary.version),
    description: str(primary.description),
    authors: personList(primary.authorList ?? primary.authors),
    icon: normalizeJarPath(str(primary.logoFile)),
    links: { homepage: str(primary.url), update: str(primary.updateJSON) ?? str(primary.updateUrl) },
    environment: 'both',
    dependencies,
    provides,
    minecraftRange: mcversion,
    nestedJars: [],
  }
  return { meta, warnings: [] }
}

/**
 * Metadata for tweaker mods described only by their manifest (`TweakName`, `TweakAuthor`,
 * `TweakVersion`), optionally refined by the JSON named by `TweakMetaFile`.
 */
export function parseTweakerManifest(manifest: Record<string, string>, metaFile: unknown): LoaderModMetadata | undefined {
  const extra = isObject(metaFile) ? metaFile : {}
  const coremod = str(manifest.FMLCorePlugin)
  const coremodId = coremod?.split('.').at(-1)?.replace(/Plugin$/, '')
  const id = str(extra.id) ?? str(manifest.TweakName) ?? (coremodId !== undefined && coremodId !== '' ? coremodId : undefined)
  if (id === undefined) return undefined
  const version = str(extra.version) ?? str(manifest.TweakVersion)
  return {
    loader: 'forge',
    source: 'META-INF/MANIFEST.MF',
    id,
    name: str(extra.name) ?? str(manifest.TweakName),
    version,
    description: str(extra.description),
    authors: extra.authors !== undefined ? personList(extra.authors) : strList(manifest.TweakAuthor),
    links: { homepage: str(extra.url) },
    environment: 'both',
    dependencies: [],
    provides: { [id]: version ?? '' },
    nestedJars: [],
  }
}

/** Parse an already-decoded LiteLoader `litemod.json`. */
export function parseLitemodJson(value: unknown, file = 'litemod.json'): ParserOutput<LoaderModMetadata> {
  const obj = isObject(value) ? value : undefined
  const name = obj ? str(obj.name) : undefined
  if (!obj || name === undefined) return { warnings: [{ file, code: 'invalid-shape', message: 'litemod.json has no "name"' }] }
  const mcversion = str(obj.mcversion)
  const revision = str(obj.revision)
  const version = str(obj.version) ?? (mcversion !== undefined && revision !== undefined ? `${mcversion}:${revision}` : undefined)
  return {
    meta: {
      loader: 'liteloader',
      source: file,
      id: name,
      name,
      version,
      description: str(obj.description),
      authors: strList(obj.author),
      links: {},
      environment: 'client',
      dependencies: [],
      provides: { [name]: version ?? '' },
      minecraftRange: mcversion,
      nestedJars: [],
    },
    warnings: [],
  }
}
