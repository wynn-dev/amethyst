/**
 * Rule evaluation for libraries and arguments (launch.md §3).
 *
 * The architecture is always the **selected JVM's** (an x86_64 JVM under Rosetta must see
 * x86_64 rules and natives), never `process.arch`.
 */
import { execFile } from 'node:child_process'
import { release } from 'node:os'
import type { Rule } from './schema'

/** Architecture of a JVM. Only 64-bit JVMs exist on Apple Silicon; `x86` is accepted for completeness. */
export type JvmArch = 'arm64' | 'x64' | 'x86'

/** The platform rules are evaluated against. */
export interface Platform {
  /** Mojang OS name. Always `osx` on macOS. */
  name: 'osx' | 'windows' | 'linux'
  /** OS product version, e.g. `14.4` (not the Darwin kernel release). */
  version: string
  /** Architecture of the selected JVM. */
  arch: JvmArch
}

/**
 * Launch features. A feature is enabled only when its value is `true` (the original treated a
 * present-but-false key as enabled).
 */
export interface Features {
  is_demo_user?: boolean
  has_custom_resolution?: boolean
  has_quick_plays_support?: boolean
  is_quick_play_singleplayer?: boolean
  is_quick_play_multiplayer?: boolean
  is_quick_play_realms?: boolean
  [name: string]: boolean | undefined
}

/**
 * Normalize an architecture string from any vocabulary (`os.arch`, `java_home -X`, Node, Mojang)
 * to a {@link JvmArch}. Returns `undefined` for unknown values.
 */
export function normalizeArch(arch: string): JvmArch | undefined {
  switch (arch.toLowerCase()) {
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    case 'x64':
    case 'x86_64':
    case 'amd64':
      return 'x64'
    case 'x86':
    case 'ia32':
    case 'i386':
    case 'i686':
      return 'x86'
    default:
      return undefined
  }
}

/** Compare dotted numeric versions (`10.0.17134`). Non-numeric parts compare as 0. */
function compareDotted(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

const regexCache = new Map<string, RegExp | null>()
function safeRegex(source: string): RegExp | null {
  let re = regexCache.get(source)
  if (re === undefined) {
    try {
      re = new RegExp(source)
    } catch {
      re = null
    }
    regexCache.set(source, re)
  }
  return re
}

function osMatches(os: NonNullable<Rule['os']>, platform: Platform): boolean {
  if (os.name !== undefined && os.name !== platform.name) return false
  if (os.version !== undefined) {
    const re = safeRegex(os.version)
    if (!re || !re.test(platform.version)) return false
  }
  if (os.versionRange) {
    if (os.versionRange.min !== undefined && compareDotted(platform.version, os.versionRange.min) < 0) return false
    if (os.versionRange.max !== undefined && compareDotted(platform.version, os.versionRange.max) >= 0) return false
  }
  if (os.arch !== undefined) {
    // Mojang's `x86` means a 32-bit x86 JVM; aliases cover third-party JSON.
    const want = normalizeArch(os.arch)
    if (want === undefined || want !== platform.arch) return false
  }
  return true
}

/**
 * Evaluate a rule list. No rules (or an empty list) means allowed. Otherwise the result starts as
 * disallowed and the last rule that applies decides. A rule applies when its `os` block (if any)
 * and its `features` block (if any) both match.
 */
export function evaluateRules(rules: readonly Rule[] | undefined, platform: Platform, features: Features = {}): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (rule.os && !osMatches(rule.os, platform)) continue
    if (rule.features && !Object.entries(rule.features).every(([k, v]) => (features[k] === true) === v)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

/** True when any rule in the list mentions a feature. */
export function hasFeatureRules(rules: readonly Rule[] | undefined): boolean {
  return !!rules?.some((r) => r.features && Object.keys(r.features).length > 0)
}

/**
 * Map a Darwin kernel release (`os.release()`) to a macOS product version. Used only as a
 * fallback when `sw_vers` is unavailable: Darwin 20–24 are macOS 11–15, Darwin 25+ follows the
 * year-based scheme (Darwin 25 = macOS 26).
 */
export function darwinToMacosVersion(darwinRelease: string): string {
  const major = Number.parseInt(darwinRelease, 10)
  const minor = Number.parseInt(darwinRelease.split('.')[1] ?? '0', 10) || 0
  if (!Number.isFinite(major)) return '0'
  if (major >= 25) return `${major + 1}.${minor}`
  if (major >= 20) return `${major - 9}.${minor}`
  return `10.${major - 4}.${minor}`
}

let productVersion: Promise<string> | undefined

/** macOS product version from `sw_vers -productVersion` (cached), falling back to the kernel release. */
export function macosProductVersion(): Promise<string> {
  productVersion ??= new Promise((resolve) => {
    execFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 }, (err, stdout) => {
      const v = String(stdout ?? '').trim()
      resolve(!err && /^\d+(\.\d+)*$/.test(v) ? v : darwinToMacosVersion(release()))
    })
  })
  return productVersion
}

/** The macOS platform for a JVM of the given architecture. */
export async function macosPlatform(jvmArch: JvmArch | string): Promise<Platform> {
  return { name: 'osx', version: await macosProductVersion(), arch: requireArch(jvmArch) }
}

export function requireArch(arch: JvmArch | string): JvmArch {
  const a = normalizeArch(arch)
  if (!a) throw new TypeError(`Unknown JVM architecture ${JSON.stringify(arch)}`)
  return a
}
