import { isObject, str } from '../util/json'
import type { ModSide, ParseWarning } from './types'

/** Result of a single descriptor parser. */
export interface ParserOutput<T> {
  meta?: T
  warnings: ParseWarning[]
}

/** Strip a leading `/` or `./` so icon paths match zip entry names. */
export function normalizeJarPath(p: string | undefined): string | undefined {
  if (p === undefined) return undefined
  const out = p.replaceAll('\\', '/').replace(/^(\.\/|\/)+/, '')
  return out === '' ? undefined : out
}

/**
 * Pick an icon from a path string or a `{ "<size>": path }` map: the largest size not above
 * 256, or else the largest available.
 */
export function pickIcon(v: unknown): string | undefined {
  if (typeof v === 'string') return normalizeJarPath(str(v))
  if (!isObject(v)) return undefined
  const sized = Object.entries(v)
    .map(([k, p]) => ({ size: Number.parseInt(k, 10), path: str(p) }))
    .filter((e): e is { size: number; path: string } => Number.isFinite(e.size) && e.path !== undefined)
    .toSorted((a, b) => a.size - b.size)
  const fitting = sized.filter((e) => e.size <= 256)
  return normalizeJarPath((fitting.at(-1) ?? sized.at(-1))?.path)
}

/** Fabric/Quilt `environment` to a side. */
export function sideFromEnvironment(v: unknown): ModSide {
  const env = str(v)?.toLowerCase()
  if (env === 'client') return 'client'
  if (env === 'server' || env === 'dedicated_server') return 'server'
  return 'both'
}

/** Join a version predicate (string or array of alternatives) into one string. */
export function joinRange(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v)
  if (Array.isArray(v)) {
    const parts = v.map(joinRange).filter((s): s is string => s !== undefined)
    return parts.length > 0 ? parts.join(' || ') : undefined
  }
  if (isObject(v)) {
    // Quilt allows `{ "any": [...] }` and `{ "all": [...] }` constraint objects.
    if (Array.isArray(v.any)) return joinRange(v.any)
    if (Array.isArray(v.all)) {
      const parts = v.all.map(joinRange).filter((s): s is string => s !== undefined)
      return parts.length > 0 ? parts.join(' ') : undefined
    }
  }
  return undefined
}

/** Names from a list of `"name"` strings or `{ name }` objects (or a single such value). */
export function personList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : v === undefined ? [] : [v]
  const out: string[] = []
  for (const item of items) {
    const name = isObject(item) ? str(item.name) : str(item)
    if (name !== undefined) out.push(name)
  }
  return out
}

/** `license` as a string, an array of strings or `{ name, id }` objects. */
export function licenseText(v: unknown): string | undefined {
  const items = Array.isArray(v) ? v : [v]
  const parts = items.map((l) => (isObject(l) ? (str(l.name) ?? str(l.id)) : str(l))).filter((s): s is string => s !== undefined)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Fabric/Quilt aliases that refer to the same mod. */
const FABRIC_API_ALIASES = ['fabric-api', 'fabric_api', 'fabric']

/** Add the well-known alias ids of `id` (Fabric API's three spellings) to `provides`. */
export function addAliases(provides: Record<string, string>, id: string, version: string): void {
  if (FABRIC_API_ALIASES.includes(id)) for (const alias of FABRIC_API_ALIASES) provides[alias] ??= version
}
