/**
 * NeoForge versioning. NeoForge publishes two maven projects:
 *
 * - `net.neoforged:forge` for Minecraft 1.20.1 only: `1.20.1-47.1.<n>` (and a stray `47.1.82`).
 * - `net.neoforged:neoforge` for everything after:
 *   - 1.20.2 – 1.21.x: `<mcMinor>.<mcPatch>.<build>[-beta]`, e.g. `20.4.237` → 1.20.4,
 *     `21.0.167` → 1.21, `21.1.209` → 1.21.1, `21.11.3` → 1.21.11;
 *   - year-based Minecraft (26.x): `<year>.<drop>.<patch>.<build>[-beta]`, e.g. `26.3.0.97` → 26.3,
 *     `26.1.2.5` → 26.1.2; snapshot builds carry the Minecraft snapshot after `+`, e.g.
 *     `26.1.0.0-alpha.13+snapshot-10` → 26.1-snapshot-10, `…+pre-3` → 26.1-pre-3;
 *   - April Fools specials: `0.<mc id>.<build>[-beta]`, e.g. `0.25w14craftmine.3-beta` → 25w14craftmine.
 *
 * Versions are matched to Minecraft by mapping each one structurally and comparing for equality,
 * never by string prefix (so 1.21 never picks up 1.21.1 builds, and 26.1 never picks up 26.1.2).
 */

/** The two NeoForge maven projects. */
export type NeoForgeProject = 'neoforge' | 'forge'

/** A NeoForge build. */
export interface NeoForgeVersion {
  /** Minecraft version id it targets. */
  minecraft: string
  /** The NeoForge version without any Minecraft prefix, e.g. `21.1.209` or `47.1.106`. */
  version: string
  /** The exact maven version string (`1.20.1-47.1.106` for the legacy project). */
  artifactVersion: string
  project: NeoForgeProject
  /** Alpha/beta builds. */
  prerelease: boolean
}

/**
 * Map a NeoForge maven version to the Minecraft version it targets, or `undefined` when the string
 * does not follow any known scheme.
 */
export function neoForgeMinecraftVersion(artifactVersion: string, project: NeoForgeProject = 'neoforge'): string | undefined {
  const v = artifactVersion.trim()
  if (project === 'forge') {
    if (/^1\.20\.1-47\.\d+\.\d+/.test(v) || /^47\.\d+\.\d+/.test(v)) return '1.20.1'
    return undefined
  }
  const special = /^0\.([0-9a-z_]+)\.\d+(?:-[a-z]+(?:\.\d+)?)?$/i.exec(v)
  if (special) return special[1]
  const year = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc|pre)(?:\.\d+)?)?(?:\+([0-9a-z.-]+))?$/i.exec(v)
  if (year && Number(year[1]) >= 26) {
    const base = Number(year[3]) === 0 ? `${year[1]}.${year[2]}` : `${year[1]}.${year[2]}.${year[3]}`
    return year[5] ? `${base}-${year[5]}` : base
  }
  const legacy = /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc|pre)(?:\.\d+)?)?$/i.exec(v)
  if (legacy) {
    const major = Number(legacy[1])
    if (major < 20 || major > 25) return undefined
    return Number(legacy[2]) === 0 ? `1.${major}` : `1.${major}.${legacy[2]}`
  }
  return undefined
}

function versionParts(v: string): { nums: number[]; pre: string | undefined } {
  const [main = '', ...rest] = v.split('-')
  const pre = rest.length > 0 ? rest.join('-') : undefined
  return { nums: main.split('.').map((n) => (/^\d+$/.test(n) ? Number(n) : -1)), pre }
}

/** Semantic comparison of NeoForge versions: numeric parts first, then prereleases before releases. */
export function compareNeoForgeVersions(a: string, b: string): number {
  const pa = versionParts(a.replace(/^1\.20\.1-/, ''))
  const pb = versionParts(b.replace(/^1\.20\.1-/, ''))
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === undefined) return 1
  if (pb.pre === undefined) return -1
  return pa.pre.localeCompare(pb.pre, 'en', { numeric: true })
}

/**
 * Build {@link NeoForgeVersion}s from the version lists of both projects, newest first. With
 * `minecraft`, only builds that map exactly to it are returned.
 */
export function neoForgeVersionsFrom(lists: { neoforge?: readonly string[]; forge?: readonly string[] }, minecraft?: string): NeoForgeVersion[] {
  const out: NeoForgeVersion[] = []
  for (const project of ['neoforge', 'forge'] as const) {
    for (const artifactVersion of lists[project] ?? []) {
      const mc = neoForgeMinecraftVersion(artifactVersion, project)
      if (!mc || (minecraft !== undefined && mc !== minecraft)) continue
      const version = project === 'forge' ? artifactVersion.replace(/^1\.20\.1-/, '') : artifactVersion
      out.push({ minecraft: mc, version, artifactVersion, project, prerelease: /-(alpha|beta|rc|pre)/i.test(artifactVersion) })
    }
  }
  return out.toSorted((a, b) => compareNeoForgeVersions(b.artifactVersion, a.artifactVersion))
}

/**
 * Which project a user-facing NeoForge version belongs to: `47.x` (optionally with the `1.20.1-`
 * prefix) is the legacy `forge` project, everything else is `neoforge`.
 */
export function neoForgeProjectOf(version: string): NeoForgeProject {
  return /^(1\.20\.1-)?47\./.test(version) ? 'forge' : 'neoforge'
}
