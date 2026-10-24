/**
 * Which Java majors a Minecraft version accepts (`docs/specs/java.md` §6.1).
 */

/** How installed majors are matched against a requirement. */
export type JavaMatch =
  | { kind: 'exact'; major: number }
  | { kind: 'atLeast'; major: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'oneOf'; majors: number[] }
  | { kind: 'any' }

/** What a version needs: the install target plus the match and "okay" predicates. */
export interface JavaRequirement {
  /** Mojang component to install (`jre-legacy`, `java-runtime-delta`...). Empty = install manually. */
  component: string
  majorVersion: number
  /** Installed JVMs that fully satisfy the requirement. */
  match: JavaMatch
  /** JVMs that probably work; used to label a pinned Java and to suggest one. */
  okay: JavaMatch
}

/** Mojang runtime components and their Java majors. Used only when no index is at hand. */
export const KNOWN_COMPONENTS: Readonly<Record<string, number>> = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-gamma-snapshot': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
}

/** The preferred component for a major, e.g. 17 -> `java-runtime-gamma`. */
export const COMPONENT_FOR_MAJOR: Readonly<Record<number, string>> = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-gamma',
  21: 'java-runtime-delta',
  25: 'java-runtime-epsilon',
}

/** `true` when `major` satisfies `match`. */
export function matchesMajor(match: JavaMatch, major: number): boolean {
  switch (match.kind) {
    case 'exact':
      return major === match.major
    case 'atLeast':
      return major >= match.major
    case 'range':
      return major >= match.min && major <= match.max
    case 'oneOf':
      return match.majors.includes(major)
    case 'any':
      return major > 0
  }
}

/** The default match for a required major: forward-compatible from 16, strict below. */
export function defaultMatch(major: number): JavaMatch {
  return major >= 16 ? { kind: 'atLeast', major } : { kind: 'exact', major }
}

/** Minecraft eras that decide the fallback requirement when no version JSON is available. */
export type MinecraftEra = 'pre-1.13' | '1.13-1.16' | '1.17+'

/**
 * Classify a Minecraft version id: `1.12.2`, `1.16.5`, `1.21.4`, year-based `26.1` and
 * `26.1-snapshot-2`, weekly snapshots like `24w14a`, and `1.18-pre1`-style pre-releases.
 * Returns `undefined` for ids it cannot place (old alpha/beta ids are `pre-1.13`).
 */
export function minecraftEra(id: string): MinecraftEra | undefined {
  const s = id.trim()
  const snap = /^(\d{2})w(\d{2})[a-z~]?/.exec(s)
  if (snap) {
    const year = Number(snap[1])
    const week = Number(snap[2])
    // 1.13 snapshots began with 17w43a; 1.17 snapshots with 20w45a.
    if (year < 17 || (year === 17 && week < 43)) return 'pre-1.13'
    if (year < 20 || (year === 20 && week < 45)) return '1.13-1.16'
    return '1.17+'
  }
  if (/^[abc]\d|^(?:rd|inf)-/.test(s)) return 'pre-1.13'
  const m = /^(\d+)\.(\d+)/.exec(s)
  if (!m) return undefined
  const first = Number(m[1])
  const minor = Number(m[2])
  if (first >= 2) return '1.17+'
  if (first !== 1) return undefined
  if (minor < 13) return 'pre-1.13'
  if (minor <= 16) return '1.13-1.16'
  return '1.17+'
}

export interface RequirementInput {
  /** The resolved version JSON's `javaVersion` (after `inheritsFrom` merging). */
  javaVersion?: { component?: string; majorVersion: number }
  /** The Minecraft version id, for the fallback tiers and the Forge pin. */
  minecraftVersion?: string
  /** The instance uses Forge (not NeoForge). */
  forge?: boolean
  /** Pack-supplied allow-list (MultiMC/Prism `compatibleJavaMajors`). */
  compatibleJavaMajors?: readonly number[]
}

function componentOf(major: number, given?: string): string {
  return given || COMPONENT_FOR_MAJOR[major] || ''
}

function forgeNeeds17(mc: string | undefined): boolean {
  const m = mc ? /^1\.(\d+)(?:\.(\d+))?/.exec(mc) : null
  if (!m) return false
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  return minor === 18 || minor === 19 || (minor === 20 && patch <= 4)
}

/**
 * Compute the Java requirement for a version (§6.1): the pack allow-list wins, then the Forge 17
 * pin for 1.18 - 1.20.4, then the version JSON's `javaVersion` (forward-compatible from 16,
 * exact below), then a fallback by Minecraft era.
 */
export function javaRequirementFor(input: RequirementInput): JavaRequirement {
  const era = input.minecraftVersion ? minecraftEra(input.minecraftVersion) : undefined
  const okay: JavaMatch = era === 'pre-1.13' ? { kind: 'range', min: 8, max: 11 } : { kind: 'any' }
  const req = input.javaVersion

  const allowed = input.compatibleJavaMajors?.filter((n) => Number.isInteger(n) && n > 0)
  if (allowed && allowed.length > 0) {
    const majors = [...new Set(allowed)].toSorted((a, b) => a - b)
    const match: JavaMatch = { kind: 'oneOf', majors }
    if (req && majors.includes(req.majorVersion)) return { component: componentOf(req.majorVersion, req.component), majorVersion: req.majorVersion, match, okay: match }
    const known = majors.find((n) => COMPONENT_FOR_MAJOR[n])
    const major = known ?? (majors[0] as number)
    return { component: known ? componentOf(known) : '', majorVersion: major, match, okay: match }
  }

  if (input.forge && forgeNeeds17(input.minecraftVersion) && (!req || req.majorVersion === 17)) {
    return { component: req?.component || 'java-runtime-gamma', majorVersion: 17, match: { kind: 'exact', major: 17 }, okay }
  }

  if (req) return { component: componentOf(req.majorVersion, req.component), majorVersion: req.majorVersion, match: defaultMatch(req.majorVersion), okay }

  switch (era) {
    case 'pre-1.13':
      return { component: 'jre-legacy', majorVersion: 8, match: { kind: 'exact', major: 8 }, okay }
    case '1.13-1.16':
      return { component: 'jre-legacy', majorVersion: 8, match: { kind: 'range', min: 8, max: 16 }, okay }
    default:
      // 1.17+ and unknown ids: modern versions always ship a javaVersion, so this is a guess.
      return { component: 'java-runtime-alpha', majorVersion: 16, match: { kind: 'atLeast', major: 16 }, okay }
  }
}
