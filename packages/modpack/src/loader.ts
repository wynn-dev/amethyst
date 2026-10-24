/**
 * Mapping between the loader notations of the two pack formats and Amethyst's
 * `{ id, version }` form (`modpacks.md` §2.1, `instances.md` §3.2).
 *
 * - Modrinth: one `dependencies` key out of `forge`, `neoforge`, `fabric-loader`, `quilt-loader`.
 * - CurseForge: `minecraft.modLoaders[].id` of the form `forge-47.2.0`, `neoforge-20.4.237`,
 *   `fabric-0.15.11` or `quilt-0.26.0`. The entry with `primary: true` wins, else the first.
 *
 * Versions are normalised to the bare loader version: a leading `<minecraft>-` (seen on the
 * 1.20.1 NeoForge fork, `neoforge-1.20.1-47.1.84`) and a trailing `-<minecraft>` (old Forge,
 * `1.7.10-10.13.4.1614-1.7.10`) are removed.
 */
import type { LoaderId, ModpackLoader } from './types'

/** `dependencies` key in `modrinth.index.json` for each loader. */
export const MODRINTH_LOADER_KEYS: Readonly<Record<LoaderId, string>> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric-loader',
  quilt: 'quilt-loader',
}

const BY_MODRINTH_KEY = new Map<string, LoaderId>(Object.entries(MODRINTH_LOADER_KEYS).map(([id, key]) => [key, id as LoaderId]))

/** The loader for a Modrinth `dependencies` key, or undefined for `minecraft` and unknown keys. */
export function loaderFromModrinthKey(key: string): LoaderId | undefined {
  return BY_MODRINTH_KEY.get(key)
}

/** Strip a `<minecraft>-` prefix and a `-<minecraft>` suffix from a loader version. */
export function normaliseLoaderVersion(version: string, minecraft: string): string {
  let v = version.trim()
  if (minecraft) {
    if (v.startsWith(`${minecraft}-`)) v = v.slice(minecraft.length + 1)
    if (v.endsWith(`-${minecraft}`)) v = v.slice(0, -(minecraft.length + 1))
  }
  return v
}

/**
 * Parse a CurseForge loader id (`forge-47.2.0`, `neoforge-1.20.1-47.1.84`, ...). Returns
 * undefined for unknown loaders or an empty version. The id prefix is matched up to the first
 * `-`, so `neoforge-` is never mistaken for `forge-`.
 */
export function parseCurseForgeLoaderId(id: string, minecraft: string): ModpackLoader | undefined {
  const dash = id.indexOf('-')
  if (dash <= 0) return undefined
  const name = id.slice(0, dash).toLowerCase()
  if (name !== 'forge' && name !== 'neoforge' && name !== 'fabric' && name !== 'quilt') return undefined
  const version = normaliseLoaderVersion(id.slice(dash + 1), minecraft)
  return version ? { id: name, version } : undefined
}

/** The CurseForge `modLoaders[].id` for a loader. */
export function curseForgeLoaderId(loader: ModpackLoader): string {
  return `${loader.id}-${loader.version}`
}
