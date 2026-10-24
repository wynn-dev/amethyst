import { isObject, str, strList, type JsonObject } from '../util/json'
import { addAliases, joinRange, licenseText, normalizeJarPath, personList, pickIcon, sideFromEnvironment, type ParserOutput } from './common'
import type { DependencyKind, LoaderModMetadata, ModDependency } from './types'

const RELATIONS: [key: string, kind: DependencyKind, required: boolean][] = [
  ['depends', 'depends', true],
  ['recommends', 'recommends', false],
  ['suggests', 'suggests', false],
  ['breaks', 'breaks', false],
  ['conflicts', 'conflicts', false],
]

function fabricDependencies(obj: JsonObject): ModDependency[] {
  const out: ModDependency[] = []
  for (const [key, kind, required] of RELATIONS) {
    const map = obj[key]
    if (!isObject(map)) continue
    for (const [modId, range] of Object.entries(map)) {
      if (modId.trim() === '') continue
      const r = joinRange(range)
      out.push({ modId, ...(r !== undefined && r !== '*' ? { range: r } : {}), rangeKind: 'semver', required, kind })
    }
  }
  return out
}

/**
 * Parse an already-decoded `fabric.mod.json`. Nested jars are listed in `nestedJars` but not
 * opened here. Returns no metadata (and a warning) when the shape has no usable `id`.
 */
export function parseFabricModJson(value: unknown, file = 'fabric.mod.json'): ParserOutput<LoaderModMetadata> {
  // Very old (schema 0) files may hold an array of mods; the first is primary.
  const list = Array.isArray(value) ? value.filter(isObject) : isObject(value) ? [value] : []
  const obj = list[0]
  const id = obj ? str(obj.id) : undefined
  if (!obj || id === undefined) {
    return { warnings: [{ file, code: 'invalid-shape', message: 'fabric.mod.json has no "id"' }] }
  }
  const version = str(obj.version)
  const provides: Record<string, string> = { [id]: version ?? '' }
  addAliases(provides, id, version ?? '')
  for (const alias of strList(obj.provides)) provides[alias] ??= version ?? ''
  for (const extra of list.slice(1)) {
    const extraId = str(extra.id)
    if (extraId !== undefined) provides[extraId] ??= str(extra.version) ?? ''
  }

  const contact = isObject(obj.contact) ? obj.contact : {}
  const dependencies = fabricDependencies(obj)
  const depends = isObject(obj.depends) ? obj.depends : {}
  const minecraftRange = joinRange(depends.minecraft)
  const loaderRange = joinRange(depends.fabricloader)
  const nestedJars = Array.isArray(obj.jars)
    ? obj.jars.map((j) => normalizeJarPath(isObject(j) ? str(j.file) : undefined)).filter((p): p is string => p !== undefined)
    : []

  const meta: LoaderModMetadata = {
    loader: 'fabric',
    source: file,
    id,
    name: str(obj.name),
    version,
    description: str(obj.description),
    authors: [...personList(obj.authors), ...personList(obj.contributors)],
    license: licenseText(obj.license),
    icon: pickIcon(obj.icon),
    links: { homepage: str(contact.homepage), issues: str(contact.issues), sources: str(contact.sources) },
    environment: sideFromEnvironment(obj.environment),
    dependencies,
    provides,
    minecraftRange,
    loaderRange,
    nestedJars,
  }
  return { meta, warnings: [] }
}
