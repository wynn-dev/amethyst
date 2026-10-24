/**
 * Java version strings: `1.8.0_512` (legacy scheme, major is the second number), `17.0.15`,
 * `21.0.7+6-LTS`, `25`, `26-ea`, Mojang's `8u74-cacert462b08` and `16.0.1.9.1_3`.
 */

/** A parsed Java version. */
export interface JavaVersion {
  /** The version token as matched, e.g. `1.8.0_512` or `17.0.15`. */
  version: string
  majorVersion: number
  /** Numeric components after normalising the legacy `1.x` scheme, e.g. `[8, 0, 512]`. */
  parts: number[]
}

/**
 * Parse a bare version string (`java.version`, `JAVA_VERSION`, `JVMVersion`). Returns
 * `undefined` when there is no leading number.
 */
export function parseJavaVersion(input: string): JavaVersion | undefined {
  const s = input.trim().replace(/^"|"$/g, '')
  // Mojang's legacy runtime names: 8u74, 8u51-b16.
  const update = /^(\d+)u(\d+)/.exec(s)
  if (update) {
    const major = Number(update[1])
    return { version: update[0], majorVersion: major, parts: [major, 0, Number(update[2])] }
  }
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[._](\d+))?/.exec(s)
  if (!m) return undefined
  const nums = [m[1], m[2], m[3], m[4]].filter((x): x is string => x !== undefined).map(Number)
  const first = nums[0] as number
  if (first === 1 && m[2] !== undefined) {
    // Legacy scheme: 1.8.0_512 -> [8, 0, 512].
    const major = Number(m[2])
    return { version: m[0], majorVersion: major, parts: [major, Number(m[3] ?? 0), Number(m[4] ?? 0)] }
  }
  if (first <= 0) return undefined
  return { version: m[0], majorVersion: first, parts: nums }
}

/**
 * Parse the human-readable banner of `java -version` (stderr first, then stdout). Lines such
 * as `Picked up JAVA_TOOL_OPTIONS: ...` are skipped so they cannot corrupt the match.
 */
export function parseVersionBanner(text: string): JavaVersion | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^Picked up /i.test(line)) continue
    const m = /(?:^|\s)(?:openjdk|java|java version|java_version|JAVA_VERSION)(?:\s+version)?\s*[=\s]\s*"([^"]+)"/i.exec(line)
    if (m?.[1]) return parseJavaVersion(m[1])
  }
  return undefined
}

/** Compare two parsed versions component by component. */
export function compareJavaVersions(a: JavaVersion | readonly number[], b: JavaVersion | readonly number[]): number {
  const pa = 'parts' in a ? a.parts : a
  const pb = 'parts' in b ? b.parts : b
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
