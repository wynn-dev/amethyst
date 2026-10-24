import { MAC_ARM64_PLATFORM, type RuntimeIndex, type RuntimeIndexEntry } from './mojang'
import { COMPONENT_FOR_MAJOR, KNOWN_COMPONENTS } from './requirement'

/** One row of the Apple Silicon availability table built from the live index. */
export interface Arm64Availability {
  component: string
  majorVersion: number
  /** Version Mojang ships for `mac-os-arm64`, if any. */
  arm64?: string
  /** Version Mojang ships for Intel `mac-os`, if any (never installed by default). */
  x64?: string
}

/** Components that exist only for other platforms. */
const IGNORED_COMPONENTS = new Set(['minecraft-java-exe'])

/**
 * Build the availability table from a live index. As of October 2026 `jre-legacy` (8),
 * `java-runtime-alpha` (16) and `java-runtime-beta` (17) are empty for `mac-os-arm64`; gamma,
 * gamma-snapshot (17), delta (21) and epsilon (25) are native. Never hard-code this: Mojang may
 * add or drop builds at any time.
 */
export function arm64Availability(index: RuntimeIndex): Arm64Availability[] {
  const arm = index[MAC_ARM64_PLATFORM] ?? {}
  const intel = index['mac-os'] ?? {}
  const names = new Set([...Object.keys(arm), ...Object.keys(intel)].filter((c) => !IGNORED_COMPONENTS.has(c)))
  const rows: Arm64Availability[] = []
  for (const component of names) {
    const a = arm[component]?.[0]
    const x = intel[component]?.[0]
    const row: Arm64Availability = { component, majorVersion: a?.majorVersion || x?.majorVersion || KNOWN_COMPONENTS[component] || 0 }
    if (a) row.arm64 = a.version
    if (x) row.x64 = x.version
    rows.push(row)
  }
  return rows.toSorted((p, q) => p.majorVersion - q.majorVersion || p.component.localeCompare(q.component))
}

/** Where a managed runtime for a major should come from. */
export type RuntimeChoice =
  | { source: 'mojang'; component: string; majorVersion: number; version: string; entry: RuntimeIndexEntry; reason: string }
  | { source: 'zulu'; majorVersion: number; reason: string }

export interface ResolveOptions {
  /** The live Mojang index. Without it (fetch failed), Zulu is chosen and the reason says why. */
  index?: RuntimeIndex
  /** The component the version JSON names; used when Mojang ships it for arm64. */
  component?: string
  /**
   * Install Mojang's arm64 Java 17 when 16 is required and has no arm64 build (default `true`).
   * Minecraft 1.17.x runs on 17, and 16+ requirements are forward-compatible.
   */
  substitute16?: boolean
  /** Skip Mojang entirely (self-heal of a broken Zulu install, or a user setting). */
  forceZulu?: boolean
}

function mojang(entry: RuntimeIndexEntry, reason: string): RuntimeChoice {
  return { source: 'mojang', component: entry.component, majorVersion: entry.majorVersion, version: entry.version, entry, reason }
}

/**
 * Decide the source for a runtime of `major` on Apple Silicon (§5.7): Mojang's `mac-os-arm64`
 * build when the index has one for the component or major, Mojang's arm64 Java 17 for a Java 16
 * requirement, otherwise Azul Zulu for the same major. The x86_64 Mojang runtime is never chosen.
 */
export function resolveRuntimeFor(major: number, options: ResolveOptions = {}): RuntimeChoice {
  if (options.forceZulu) return { source: 'zulu', majorVersion: major, reason: 'Zulu was requested explicitly.' }
  const arm = options.index?.[MAC_ARM64_PLATFORM]
  if (!arm) return { source: 'zulu', majorVersion: major, reason: 'The Mojang runtime index is unavailable, so Azul Zulu is used.' }
  const named = options.component ? arm[options.component]?.[0] : undefined
  if (named && (named.majorVersion === major || named.majorVersion === 0)) return mojang(named, `Mojang ships ${named.component} ${named.version} for Apple Silicon.`)

  const preferred = COMPONENT_FOR_MAJOR[major]
  const sameMajor = Object.values(arm)
    .map((list) => list[0])
    .filter((e): e is RuntimeIndexEntry => e !== undefined && e.majorVersion === major && !IGNORED_COMPONENTS.has(e.component))
    .toSorted((a, b) => Number(b.component === preferred) - Number(a.component === preferred) || Number(a.component.includes('snapshot')) - Number(b.component.includes('snapshot')))
  if (sameMajor[0]) return mojang(sameMajor[0], `Mojang ships Java ${major} (${sameMajor[0].component} ${sameMajor[0].version}) for Apple Silicon.`)

  if (major === 16 && options.substitute16 !== false) {
    const gamma = arm['java-runtime-gamma']?.[0] ?? Object.values(arm).map((l) => l[0]).find((e) => e?.majorVersion === 17)
    if (gamma) return mojang(gamma, `Mojang ships no Java 16 for Apple Silicon; Minecraft 1.17 runs on Java 17 (${gamma.component} ${gamma.version}).`)
  }

  const missing = options.component ?? preferred
  return {
    source: 'zulu',
    majorVersion: major,
    reason: `Mojang ships no Apple Silicon build of Java ${major}${missing ? ` (${missing})` : ''}, so Azul Zulu ${major} is used.`,
  }
}
