import { parse as parseToml } from 'smol-toml'
import { isObject, str, type JsonObject } from '../util/json'
import { normalizeJarPath, type ParserOutput } from './common'
import type { LoaderModMetadata, ModDependency, ModSide } from './types'

const JAR_VERSION = '${file.jarVersion}'

/** Replace every `${file.jarVersion}` with the manifest version, or `?` when there is none. */
function substitute(v: string | undefined, jarVersion: string | undefined): string | undefined {
  return v?.replaceAll(JAR_VERSION, jarVersion ?? '?')
}

function side(v: unknown): ModSide | undefined {
  const s = str(v)?.toUpperCase()
  if (s === 'CLIENT') return 'client'
  if (s === 'SERVER') return 'server'
  if (s === 'BOTH') return 'both'
  return undefined
}

/** `authors` may be a string or (rarely) an array of strings. */
function authorList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => s !== undefined)
  const s = str(v)
  if (s === undefined) return []
  return s
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
}

function forgeDependencies(table: unknown, jarVersion: string | undefined): ModDependency[] {
  const list = Array.isArray(table) ? table : isObject(table) ? [table] : []
  const out: ModDependency[] = []
  for (const d of list) {
    if (!isObject(d)) continue
    const modId = str(d.modId)
    if (modId === undefined) continue
    const type = str(d.type)?.toLowerCase()
    const range = substitute(str(d.versionRange), jarVersion)
    const depSide = side(d.side)
    const base = { modId, ...(range !== undefined && range !== '*' ? { range } : {}), rangeKind: 'maven' as const, ...(depSide ? { side: depSide } : {}) }
    if (type === 'incompatible') out.push({ ...base, required: false, kind: 'breaks' })
    else if (type === 'discouraged') out.push({ ...base, required: false, kind: 'conflicts' })
    else out.push({ ...base, required: type === 'required' || (type === undefined && d.mandatory === true), kind: 'depends' })
  }
  return out
}

/** Options for {@link parseModsToml}. */
export interface ModsTomlOptions {
  /** `neoforge` for `META-INF/neoforge.mods.toml`, `forge` for `META-INF/mods.toml`. */
  loader: 'forge' | 'neoforge'
  /** Path of the descriptor inside the jar, used in warnings. */
  file: string
  /** `Implementation-Version` from the manifest, substituted for `${file.jarVersion}`. */
  jarVersion?: string
}

/**
 * Parse a Forge `mods.toml` or NeoForge `neoforge.mods.toml`. The first `[[mods]]` entry is
 * primary; the others become provided ids. Malformed TOML yields a warning, never a throw.
 */
export function parseModsToml(text: string, options: ModsTomlOptions): ParserOutput<LoaderModMetadata> {
  const { loader, file, jarVersion } = options
  let doc: JsonObject
  try {
    doc = parseToml(text.replace(/^﻿/, '')) as JsonObject
  } catch (e) {
    return { warnings: [{ file, code: 'invalid-toml', message: e instanceof Error ? e.message.split('\n')[0] ?? e.message : String(e) }] }
  }
  const mods = Array.isArray(doc.mods) ? doc.mods.filter(isObject) : []
  const primary = mods.find((m) => str(m.modId) !== undefined)
  const id = primary ? str(primary.modId) : undefined
  if (!primary || id === undefined) {
    return { warnings: [{ file, code: 'invalid-shape', message: `${file} declares no [[mods]] entry with a modId` }] }
  }

  const version = substitute(str(primary.version), jarVersion)
  const provides: Record<string, string> = {}
  for (const m of mods) {
    const mid = str(m.modId)
    if (mid === undefined) continue
    const v = substitute(str(m.version), jarVersion) ?? ''
    provides[mid] ??= v
    if (Array.isArray(m.provides)) for (const alias of m.provides) if (typeof alias === 'string' && alias !== '') provides[alias] ??= v
  }

  const depTable = isObject(doc.dependencies) ? doc.dependencies : {}
  const dependencies = forgeDependencies(depTable[id], jarVersion)
  const findRange = (ids: string[]) => dependencies.find((d) => d.kind === 'depends' && ids.includes(d.modId))
  const mcDep = findRange(['minecraft'])
  const loaderDep = findRange(loader === 'neoforge' ? ['neoforge'] : ['forge'])
  // `clientSideOnly` is a newer top-level key; some mods put it on the [[mods]] entry instead.
  const clientOnly = doc.clientSideOnly === true || primary.clientSideOnly === true

  const meta: LoaderModMetadata = {
    loader,
    source: file,
    id,
    name: str(primary.displayName),
    version,
    description: str(primary.description),
    authors: authorList(primary.authors ?? doc.authors),
    license: str(doc.license) ?? str(primary.license),
    icon: normalizeJarPath(str(primary.logoFile) ?? str(doc.logoFile)),
    links: {
      homepage: str(primary.displayURL) ?? str(doc.displayURL),
      issues: str(doc.issueTrackerURL) ?? str(primary.issueTrackerURL),
      update: str(primary.updateJSONURL) ?? str(doc.updateJSONURL),
    },
    environment: clientOnly ? 'client' : 'both',
    dependencies,
    provides,
    minecraftRange: mcDep ? (mcDep.range ?? '*') : undefined,
    loaderRange: loaderDep ? (loaderDep.range ?? '*') : str(doc.loaderVersion),
    nestedJars: [],
  }
  return { meta, warnings: [] }
}
