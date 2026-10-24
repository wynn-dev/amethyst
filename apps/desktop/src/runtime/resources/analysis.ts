/**
 * Load-time problems among an instance's enabled mods (the Problems sheet): duplicate mod ids,
 * required dependencies nobody provides, mods for another loader and declared conflicts.
 *
 * Deliberately conservative: version ranges are not evaluated (a wrong guess would tell people to
 * remove working mods), and ids the loader or Minecraft itself provide never count as missing.
 */
import type { ContentEntry, ModDependency } from '@amethyst/content'
import type { LoaderKind, ModAnalysis, ResourceRow } from '@shared/services'

export interface AnalyzedMod {
  row: ResourceRow
  entry?: ContentEntry
}

/** Ids provided by the game, Java or a loader rather than by a mod file. */
const BUILT_IN = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'quilt_loader',
  'quilt-loader',
  'forge',
  'fml',
  'javafml',
  'lowcodefml',
  'neoforge',
  'neoforged',
  'mixinextras',
])

/** Loaders whose mods an instance loader can run. */
function compatibleLoaders(loader: LoaderKind): Set<string> {
  switch (loader) {
    case 'quilt':
      return new Set(['quilt', 'fabric'])
    case 'fabric':
      return new Set(['fabric'])
    case 'forge':
      return new Set(['forge'])
    case 'neoforge':
      return new Set(['neoforge'])
  }
}

const LOADER_NAMES: Record<string, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', liteloader: 'LiteLoader' }

/** Fabric API and QSL ship their modules as nested jars: a module id is provided by the bundle. */
function bundled(modId: string, provided: Set<string>): boolean {
  if ((modId.startsWith('fabric-') || modId === 'fabric') && (provided.has('fabric-api') || provided.has('fabric') || provided.has('quilted_fabric_api'))) return true
  if (modId.startsWith('quilt_') && (provided.has('qsl') || provided.has('quilted_fabric_api'))) return true
  return false
}

export function analyzeMods(mods: AnalyzedMod[], loader: LoaderKind | null): ModAnalysis {
  const out: ModAnalysis = { duplicates: [], missing: [], incompatible: [], dependents: {}, broken: [] }
  // Who provides which id (mod ids, `provides` aliases).
  const providers = new Map<string, string[]>()
  const add = (id: string, rowId: string) => {
    const key = id.toLowerCase()
    const list = providers.get(key) ?? []
    if (!list.includes(rowId)) list.push(rowId)
    providers.set(key, list)
  }
  for (const m of mods) {
    const meta = m.entry?.mod
    if (!meta) continue
    if (meta.id) add(meta.id, m.row.id)
    for (const alias of Object.keys(meta.provides)) add(alias, m.row.id)
  }
  const provided = new Set(providers.keys())

  // Duplicates: the same mod id twice, or byte-identical files.
  const byModId = new Map<string, string[]>()
  for (const m of mods) {
    const id = m.entry?.mod?.id?.toLowerCase()
    if (id) byModId.set(id, [...(byModId.get(id) ?? []), m.row.id])
  }
  const reported = new Set<string>()
  for (const [modId, ids] of byModId) {
    if (ids.length < 2) continue
    out.duplicates.push({ modId, ids })
    for (const id of ids) reported.add(id)
  }
  const bySha = new Map<string, string[]>()
  for (const m of mods) if (m.row.sha1 && !reported.has(m.row.id)) bySha.set(m.row.sha1, [...(bySha.get(m.row.sha1) ?? []), m.row.id])
  for (const ids of bySha.values()) if (ids.length > 1) out.duplicates.push({ modId: mods.find((m) => m.row.id === ids[0])?.entry?.mod?.id ?? ids[0] ?? '', ids })

  const allowed = loader ? compatibleLoaders(loader) : undefined
  for (const m of mods) {
    const meta = m.entry?.mod
    if (!meta) continue
    // Another loader's mod (only when the jar declares loaders at all).
    if (allowed && meta.loaders.length > 0 && !meta.loaders.some((l) => allowed.has(l))) {
      const names = meta.loaders.map((l) => LOADER_NAMES[l] ?? l).join(' / ')
      out.incompatible.push({ id: m.row.id, reason: 'loader', message: `Made for ${names}` })
      continue
    }
    const satisfied = (d: ModDependency): boolean => {
      const id = d.modId.toLowerCase()
      return BUILT_IN.has(id) || provided.has(id) || bundled(id, provided) || (d.alternatives ?? []).some(satisfied)
    }
    for (const d of meta.dependencies) {
      const id = d.modId.toLowerCase()
      if (d.kind === 'depends') {
        for (const p of providers.get(id) ?? []) if (p !== m.row.id) (out.dependents[p] ??= []).push(m.row.id)
        if (d.required && !satisfied(d)) out.missing.push({ id: m.row.id, modId: d.modId, ...(d.range ? { range: d.range } : {}) })
      } else if (d.kind === 'breaks' && !BUILT_IN.has(id)) {
        const other = (providers.get(id) ?? []).find((p) => p !== m.row.id)
        if (other) out.incompatible.push({ id: m.row.id, reason: 'conflict', message: `Does not work together with ${d.modId}`, with: other })
      }
    }
  }
  return out
}
