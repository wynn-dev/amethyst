import { resolve } from 'node:path'
import { defaultMatch, type JavaMatch, matchesMajor } from './requirement'
import type { JavaArch, JavaRecord } from './types'
import { parseJavaVersion, compareJavaVersions } from './version'

/** How well a JVM fits a requirement. */
export type JavaGrade = 'matched' | 'okay' | 'bad'

/**
 * Why {@link selectJava} chose what it chose:
 * - `pinned`: the instance's pinned Java (used whatever its grade).
 * - `preferred`: the global preferred Java, which matches.
 * - `exact-major`: the best JVM of exactly the required major.
 * - `compatible-major`: no exact major; the closest newer compatible one.
 * - `rosetta-only`: only x86_64 JVMs match; the game will run under Rosetta.
 * - `no-valid-java`: nothing valid is installed.
 * - `no-match`: valid JVMs exist but none matches; `suggestion` holds the best "okay" one.
 */
export type SelectReason = 'pinned' | 'preferred' | 'exact-major' | 'compatible-major' | 'rosetta-only' | 'no-valid-java' | 'no-match'

export interface SelectOptions {
  /** Required major (from the version JSON). */
  major: number
  /** Override the match predicate (default: `>= major` from 16, exactly `major` below). */
  match?: JavaMatch
  /** Predicate for the `okay` grade (default: same as `match`). */
  okay?: JavaMatch
  /** Architecture to rank first (default `'arm64'`). */
  preferArch?: JavaArch
  /** The instance's pinned Java path, used if it is valid. */
  pinnedPath?: string
  /** The global preferred Java path, used if it matches. */
  preferredPath?: string
}

export interface RankedJava {
  java: JavaRecord
  grade: JavaGrade
}

export interface SelectResult {
  java?: JavaRecord
  grade?: JavaGrade
  reason: SelectReason
  /** One sentence for the UI. */
  message: string
  /** The selected JVM is x86_64: warn about Rosetta and evaluate natives rules for x86_64. */
  rosetta: boolean
  /** The pinned path was given but is missing or invalid; selection fell back to auto. */
  pinnedUnavailable?: boolean
  /** With `no-match`: the best `okay` JVM the user could choose explicitly. */
  suggestion?: JavaRecord
  /** Every valid record, best first, with its grade. */
  ranked: RankedJava[]
}

function isOpenJ9(r: JavaRecord): boolean {
  return /openj9/i.test(r.path) || /openj9/i.test(r.vmName ?? '') || /openj9/i.test(r.vendor ?? '')
}

function versionParts(r: JavaRecord): number[] {
  return parseJavaVersion(r.version)?.parts ?? [r.majorVersion]
}

function describe(r: JavaRecord): string {
  return `Java ${r.version || r.majorVersion} (${r.arch}${r.vendor ? `, ${r.vendor}` : ''})`
}

function samePath(r: JavaRecord, p: string): boolean {
  const abs = resolve(p)
  return r.path === abs || r.realPath === abs
}

/**
 * Order JVMs for a requirement (§6.3): the preferred arch first and the other arch last (an x64
 * JVM never outranks an arm64 one), then exact major, then the closest newer major, then
 * managed over external, then verified, then the highest version, with OpenJ9 last.
 */
export function compareForRequirement(major: number, preferArch: JavaArch = 'arm64'): (a: JavaRecord, b: JavaRecord) => number {
  const archRank = (r: JavaRecord) => (r.arch === preferArch ? 0 : r.arch === 'unknown' ? 1 : 2)
  const distance = (r: JavaRecord) => (r.majorVersion === major ? 0 : r.majorVersion > major ? r.majorVersion - major : 1000 + major - r.majorVersion)
  return (a, b) =>
    archRank(a) - archRank(b) ||
    distance(a) - distance(b) ||
    Number(b.managed) - Number(a.managed) ||
    Number(b.verified) - Number(a.verified) ||
    compareJavaVersions(versionParts(b), versionParts(a)) ||
    Number(isOpenJ9(a)) - Number(isOpenJ9(b))
}

/**
 * Pick the Java for a launch from probed records and say why.
 *
 * Only valid records are considered. A valid pinned Java always wins (graded so the UI can warn).
 * Otherwise the global preferred Java wins if it matches; otherwise the best match by
 * {@link compareForRequirement}. When nothing matches, no Java is returned (the caller offers an
 * install) and the best "okay" JVM is given as `suggestion`.
 */
export function selectJava(installed: readonly JavaRecord[], options: SelectOptions): SelectResult {
  const preferArch = options.preferArch ?? 'arm64'
  const match = options.match ?? defaultMatch(options.major)
  const okay = options.okay ?? match
  const grade = (r: JavaRecord): JavaGrade => (matchesMajor(match, r.majorVersion) ? 'matched' : matchesMajor(okay, r.majorVersion) ? 'okay' : 'bad')
  const compare = compareForRequirement(options.major, preferArch)
  const valid = installed.filter((r) => r.valid && r.majorVersion > 0)
  const gradeRank: Record<JavaGrade, number> = { matched: 0, okay: 1, bad: 2 }
  const ranked = valid.map((java) => ({ java, grade: grade(java) })).toSorted((a, b) => gradeRank[a.grade] - gradeRank[b.grade] || compare(a.java, b.java))
  const done = (java: JavaRecord, reason: SelectReason, message: string, g: JavaGrade, extra: Partial<SelectResult> = {}): SelectResult => ({
    java,
    grade: g,
    reason,
    message: java.arch === 'x64' ? `${message} It runs under Rosetta 2 (x86_64).` : message,
    rosetta: java.arch === 'x64',
    ranked,
    ...extra,
  })

  let pinnedUnavailable: boolean | undefined
  if (options.pinnedPath) {
    const pinned = valid.find((r) => samePath(r, options.pinnedPath as string))
    if (pinned) {
      const g = grade(pinned)
      const note = g === 'matched' ? '' : ` It does not match the required Java ${options.major}.`
      return done(pinned, 'pinned', `Using the Java pinned for this instance: ${describe(pinned)}.${note}`, g)
    }
    pinnedUnavailable = true
  }
  const extra = pinnedUnavailable ? { pinnedUnavailable } : {}

  const matched = ranked.filter((r) => r.grade === 'matched').map((r) => r.java)
  if (options.preferredPath) {
    const preferred = matched.find((r) => samePath(r, options.preferredPath as string))
    // The preferred Java must not drag the launch onto Rosetta when a native match exists.
    if (preferred && !(preferred.arch !== preferArch && matched[0]?.arch === preferArch)) {
      return done(preferred, 'preferred', `Using your preferred ${describe(preferred)}.`, 'matched', extra)
    }
  }

  const best = matched[0]
  if (best) {
    if (best.arch !== preferArch && best.arch !== 'unknown') {
      return done(best, 'rosetta-only', `Only an ${best.arch} Java matches Java ${options.major}: ${describe(best)}.`, 'matched', extra)
    }
    if (best.majorVersion === options.major) return done(best, 'exact-major', `${describe(best)} matches the required Java ${options.major}.`, 'matched', extra)
    return done(best, 'compatible-major', `No Java ${options.major} found; ${describe(best)} is compatible.`, 'matched', extra)
  }

  if (valid.length === 0) {
    return { reason: 'no-valid-java', message: `No working Java is installed. Java ${options.major} is required.`, rosetta: false, ranked, ...extra }
  }
  const suggestion = ranked.find((r) => r.grade === 'okay')?.java
  return {
    reason: 'no-match',
    message: `None of the installed Java versions matches the required Java ${options.major}.`,
    rosetta: false,
    ranked,
    ...(suggestion ? { suggestion } : {}),
    ...extra,
  }
}
