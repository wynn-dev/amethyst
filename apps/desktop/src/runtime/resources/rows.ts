/** Turn scan results into the small rows (and on-demand details) the renderer receives. */
import { pathKey, stripDisabled, stripFormatting, type ContentEntry, type SaveInfo } from '@amethyst/content'
import { assetUrl } from '@shared/paths'
import type { LoaderKind, ResourceDetail, ResourceKind, ResourceProblem, ResourceRow, ResourceSource } from '@shared/services'

const LOADER_KINDS = new Set<string>(['forge', 'neoforge', 'fabric', 'quilt'])

/** Row id: the case-folded file name without `.disabled`, stable across enable/disable. */
export function resourceId(fileName: string, kind: ResourceKind): string {
  return pathKey(kind === 'mods' ? stripDisabled(fileName) : fileName)
}

const stem = (name: string) => name.replace(/\.(jar|zip|litemod)$/i, '')

function problemOf(entry: ContentEntry): ResourceProblem | null {
  if (entry.problem) return { code: entry.problem.code, message: entry.problem.message }
  const pack = entry.resourcePack ?? entry.shaderPack
  if (pack?.nestedRoot) return { code: 'nested-too-deep', message: `The pack is inside the folder “${pack.nestedRoot}”; move its contents up one level` }
  if (pack && !pack.valid) return { code: 'not-a-pack', message: entry.kind === 'shaderpacks' ? 'Not a shader pack (no shaders/ folder)' : 'Not a resource pack (no pack.mcmeta)' }
  return null
}

export interface RowExtras {
  iconFile?: string
  source?: ResourceSource | null
  pending?: boolean
}

export function entryRow(id: string, entry: ContentEntry, extras: RowExtras = {}): ResourceRow {
  const mod = entry.mod
  const description = mod?.description ?? entry.resourcePack?.descriptionPlain ?? ''
  const formats = entry.resourcePack?.formats
  return {
    ...(mod ? { side: mod.environment } : {}),
    ...(formats ? { packFormats: { min: formats.min.major, max: formats.max.major } } : {}),
    id,
    kind: entry.kind,
    fileName: entry.fileName,
    name: mod?.name?.trim() || stem(entry.baseName),
    version: mod?.version ?? '',
    summary: stripFormatting(description).replace(/\s+/g, ' ').trim().slice(0, 200),
    authors: (mod?.authors ?? []).slice(0, 3),
    iconUrl: extras.iconFile ? assetUrl(`cache/icons/${extras.iconFile}`) : null,
    enabled: entry.enabled ?? entry.kind === 'mods',
    loaders: (mod?.loaders ?? []).filter((l): l is LoaderKind => LOADER_KINDS.has(l)),
    isDirectory: entry.isDirectory,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    sha1: entry.hashes?.sha1 ?? null,
    source: extras.source ?? null,
    problem: problemOf(entry),
    pending: extras.pending ?? false,
  }
}

/** A placeholder row for a file that is listed but not scanned yet. */
export function pendingRow(id: string, kind: ResourceKind, fileName: string, info: { size: number; mtimeMs: number; isDirectory: boolean; enabled: boolean }): ResourceRow {
  return {
    id,
    kind,
    fileName,
    name: kind === 'mods' ? stem(stripDisabled(fileName)) : stem(fileName),
    version: '',
    summary: '',
    authors: [],
    iconUrl: null,
    enabled: info.enabled,
    loaders: [],
    isDirectory: info.isDirectory,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha1: null,
    source: null,
    problem: null,
    pending: true,
  }
}

export function saveRow(id: string, save: SaveInfo & { iconFile?: string }, mtimeMs: number): ResourceRow {
  const level = save.level
  return {
    id,
    kind: 'saves',
    fileName: save.folderName,
    name: level.levelName?.trim() || save.folderName,
    version: level.versionName ?? '',
    summary: '',
    authors: [],
    iconUrl: save.iconFile ? assetUrl(`cache/icons/${save.iconFile}`) : null,
    enabled: true,
    loaders: [],
    isDirectory: true,
    size: save.sizeBytes ?? 0,
    mtimeMs,
    sha1: null,
    source: null,
    problem: null,
    pending: false,
    world: {
      levelName: level.levelName ?? save.folderName,
      ...(level.versionName ? { versionName: level.versionName } : {}),
      ...(level.gameMode ? { gameMode: level.gameMode } : {}),
      hardcore: level.hardcore === true,
      cheats: level.cheats === true,
      ...(level.lastPlayed !== undefined ? { lastPlayed: level.lastPlayed } : {}),
    },
  }
}

export function entryDetail(row: ResourceRow, entry: ContentEntry | undefined, save: SaveInfo | undefined): ResourceDetail {
  const mod = entry?.mod
  const pack = entry?.resourcePack
  const warnings = [...(mod?.warnings ?? []).map((w) => w.message), ...(pack?.warnings ?? []).map((w) => w.message), ...(entry?.shaderPack?.warnings ?? []).map((w) => w.message)]
  const detail: ResourceDetail = {
    ...row,
    path: entry?.path ?? save?.path ?? '',
    description: mod?.description ?? pack?.descriptionPlain ?? '',
    allAuthors: mod?.authors ?? [],
    links: { ...(mod?.links.homepage ? { homepage: mod.links.homepage } : {}), ...(mod?.links.issues ? { issues: mod.links.issues } : {}), ...(mod?.links.sources ? { sources: mod.links.sources } : {}) },
    dependencies: (mod?.dependencies ?? []).map((d) => ({ modId: d.modId, ...(d.range ? { range: d.range } : {}), required: d.required, kind: d.kind })),
    provides: { ...mod?.provides },
    warnings,
  }
  if (mod?.id) detail.modId = mod.id
  if (mod?.license) detail.license = mod.license
  if (mod) detail.side = mod.environment
  if (mod?.minecraftRange) detail.minecraftRange = mod.minecraftRange
  if (pack?.formats) detail.packFormats = { min: pack.formats.min.major, max: pack.formats.max.major }
  if (save) {
    detail.worldDetail = {
      ...(save.level.seed ? { seed: save.level.seed } : {}),
      ...(save.level.difficulty ? { difficulty: save.level.difficulty } : {}),
      ...(save.level.dataVersion !== undefined ? { dataVersion: save.level.dataVersion } : {}),
      ...(save.sizeBytes !== undefined ? { sizeBytes: save.sizeBytes } : {}),
    }
  }
  return detail
}

/** Whether two rows differ (cheap structural comparison of small objects). */
export function rowChanged(a: ResourceRow | undefined, b: ResourceRow): boolean {
  return a === undefined || JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * Load-order positions of enabled resource packs from the `options.txt` list (bottom to top
 * priority): 0 is the top. Keyed by the file name on disk.
 */
export function packOrder(enabledList: readonly string[]): Map<string, number> {
  // Keyed by NFC name: callers look up with `fileName.normalize('NFC')` (APFS may hold NFD names).
  const files = enabledList.filter((id) => id.startsWith('file/')).map((id) => id.slice('file/'.length).normalize('NFC'))
  const out = new Map<string, number>()
  files.forEach((name, i) => out.set(name, files.length - 1 - i))
  return out
}
