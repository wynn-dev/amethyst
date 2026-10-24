import { isObject, str, type JsonObject } from '../util/json'
import { addAliases, joinRange, licenseText, normalizeJarPath, pickIcon, sideFromEnvironment, type ParserOutput } from './common'
import type { DependencyKind, LoaderModMetadata, ModDependency } from './types'

/** `maven.group:modid` → `modid`. */
function bareId(id: string): string {
  const colon = id.lastIndexOf(':')
  return colon === -1 ? id : id.slice(colon + 1)
}

function single(entry: unknown, kind: DependencyKind): ModDependency | undefined {
  if (typeof entry === 'string') {
    const id = str(entry)
    return id === undefined ? undefined : { modId: bareId(id), rangeKind: 'semver', required: kind === 'depends', kind }
  }
  if (!isObject(entry)) return undefined
  const id = str(entry.id)
  if (id === undefined) return undefined
  const range = joinRange(entry.versions)
  return {
    modId: bareId(id),
    ...(range !== undefined && range !== '*' ? { range } : {}),
    rangeKind: 'semver',
    required: kind === 'depends' && entry.optional !== true,
    kind,
  }
}

/** A Quilt relation list. In `depends` an array entry means "any of"; in `breaks` it means "all of". */
function relations(v: unknown, kind: DependencyKind): ModDependency[] {
  if (!Array.isArray(v)) return []
  const out: ModDependency[] = []
  for (const entry of v) {
    if (Array.isArray(entry)) {
      const options = entry.map((e) => single(e, kind)).filter((d): d is ModDependency => d !== undefined)
      const [first, ...rest] = options
      if (!first) continue
      if (kind === 'breaks') out.push(...options)
      else out.push(rest.length > 0 ? { ...first, alternatives: rest } : first)
      continue
    }
    const dep = single(entry, kind)
    if (dep) out.push(dep)
  }
  return out
}

const roles = (r: unknown) => (Array.isArray(r) ? r.map(String) : [String(r)])

function contributors(v: unknown): string[] {
  if (!isObject(v)) return []
  const entries = Object.entries(v).filter(([name]) => name.trim() !== '')
  // Owners first, otherwise keep declaration order.
  const owners = entries.filter(([, r]) => roles(r).some((role) => role.toLowerCase() === 'owner'))
  const others = entries.filter((e) => !owners.includes(e))
  return [...owners, ...others].map(([name]) => name.trim())
}

function findRange(deps: ModDependency[], ids: string[]): string | undefined {
  for (const d of deps) if (d.kind === 'depends' && ids.includes(d.modId)) return d.range ?? '*'
  return undefined
}

/** Parse an already-decoded `quilt.mod.json`. */
export function parseQuiltModJson(value: unknown, file = 'quilt.mod.json'): ParserOutput<LoaderModMetadata> {
  const root = isObject(value) ? value : undefined
  const ql: JsonObject | undefined = root && isObject(root.quilt_loader) ? root.quilt_loader : undefined
  const id = ql ? str(ql.id) : undefined
  if (!root || !ql || id === undefined) {
    return { warnings: [{ file, code: 'invalid-shape', message: 'quilt.mod.json has no "quilt_loader.id"' }] }
  }
  const md = isObject(ql.metadata) ? ql.metadata : {}
  const contact = isObject(md.contact) ? md.contact : {}
  const version = str(ql.version)
  const provides: Record<string, string> = { [id]: version ?? '' }
  addAliases(provides, id, version ?? '')
  if (Array.isArray(ql.provides)) {
    for (const p of ql.provides) {
      const pid = isObject(p) ? str(p.id) : str(p)
      if (pid !== undefined) provides[bareId(pid)] ??= (isObject(p) ? str(p.version) : undefined) ?? version ?? ''
    }
  }
  const dependencies = [...relations(ql.depends, 'depends'), ...relations(ql.breaks, 'breaks')]
  const mc = isObject(root.minecraft) ? root.minecraft : {}
  const nestedJars = Array.isArray(ql.jars) ? ql.jars.map((j) => normalizeJarPath(str(j))).filter((p): p is string => p !== undefined) : []

  const meta: LoaderModMetadata = {
    loader: 'quilt',
    source: file,
    id,
    name: str(md.name),
    version,
    description: str(md.description),
    authors: contributors(md.contributors),
    license: licenseText(md.license),
    icon: pickIcon(md.icon),
    links: { homepage: str(contact.homepage), issues: str(contact.issues), sources: str(contact.sources) },
    environment: sideFromEnvironment(mc.environment),
    dependencies,
    provides,
    minecraftRange: findRange(dependencies, ['minecraft']),
    loaderRange: findRange(dependencies, ['quilt_loader']),
    nestedJars,
  }
  return { meta, warnings: [] }
}
