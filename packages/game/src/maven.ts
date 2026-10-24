/**
 * Maven coordinate helpers: `group:artifact:version[:classifier][@ext]` ⇄
 * `group/as/dirs/artifact/version/artifact-version[-classifier].ext`.
 */

export interface MavenCoordinate {
  group: string
  artifact: string
  version: string
  classifier?: string
  /** File extension without the dot. Defaults to `jar`. */
  extension: string
}

const SAFE_SEGMENT = /^[^/\\\0]+$/

function checkSegment(s: string, what: string, name: string): void {
  if (!SAFE_SEGMENT.test(s) || s === '.' || s === '..') throw new TypeError(`Invalid maven ${what} in ${JSON.stringify(name)}`)
}

/**
 * Parse a maven coordinate. Rejects empty parts and anything that would produce a path
 * outside the repository (`..`, slashes, NUL), since names come from untrusted JSON.
 */
export function parseMavenName(name: string): MavenCoordinate {
  let base = name
  let extension = 'jar'
  const at = name.lastIndexOf('@')
  if (at !== -1) {
    base = name.slice(0, at)
    extension = name.slice(at + 1)
  }
  const parts = base.split(':')
  if (parts.length < 3 || parts.length > 4) throw new TypeError(`Invalid maven coordinate ${JSON.stringify(name)}`)
  const [group, artifact, version, classifier] = parts as [string, string, string, string | undefined]
  checkSegment(artifact, 'artifact', name)
  checkSegment(version, 'version', name)
  checkSegment(extension, 'extension', name)
  for (const g of group.split('.')) checkSegment(g, 'group', name)
  if (classifier !== undefined) checkSegment(classifier, 'classifier', name)
  return classifier ? { group, artifact, version, classifier, extension } : { group, artifact, version, extension }
}

/** Format a coordinate back to `group:artifact:version[:classifier][@ext]` (`@jar` is omitted). */
export function formatMavenName(c: MavenCoordinate): string {
  const base = [c.group, c.artifact, c.version, ...(c.classifier ? [c.classifier] : [])].join(':')
  return c.extension === 'jar' ? base : `${base}@${c.extension}`
}

/** Relative repository path, always with `/` separators. */
export function mavenPath(coordinate: string | MavenCoordinate): string {
  const c = typeof coordinate === 'string' ? parseMavenName(coordinate) : coordinate
  const file = `${c.artifact}-${c.version}${c.classifier ? `-${c.classifier}` : ''}.${c.extension}`
  return [...c.group.split('.'), c.artifact, c.version, file].join('/')
}

/**
 * Reverse of {@link mavenPath}: the last three segments are artifact, version and file name; the
 * rest is the group. Returns `undefined` when the file name does not start with `artifact-version`.
 */
export function pathToMaven(repoPath: string): MavenCoordinate | undefined {
  const segments = repoPath.replaceAll('\\', '/').split('/').filter(Boolean)
  if (segments.length < 4) return undefined
  const file = segments.at(-1) as string
  const version = segments.at(-2) as string
  const artifact = segments.at(-3) as string
  const group = segments.slice(0, -3).join('.')
  const prefix = `${artifact}-${version}`
  if (!file.startsWith(prefix)) return undefined
  const rest = file.slice(prefix.length)
  const dot = rest.lastIndexOf('.')
  if (dot === -1) return undefined
  const extension = rest.slice(dot + 1)
  const middle = rest.slice(0, dot)
  if (middle !== '' && !middle.startsWith('-')) return undefined
  const classifier = middle.slice(1)
  return classifier ? { group, artifact, version, classifier, extension } : { group, artifact, version, extension }
}

/**
 * Library identity used for de-duplication: `group:artifact[:classifier]`. The version is not
 * part of the key, so a child layer that declares another version replaces the parent's.
 */
export function libraryKey(c: MavenCoordinate): string {
  return c.classifier ? `${c.group}:${c.artifact}:${c.classifier}` : `${c.group}:${c.artifact}`
}

/**
 * Compare two version strings segment by segment (`.`, `-`, `_` and `+` separate segments; numeric
 * segments compare numerically and sort after alphabetic qualifiers at the same position).
 * Good enough for library versions such as `3.2.1`, `3.3.0-SNAPSHOT` and `2.9.2-nightly-20140822`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_+]/)
  const pb = b.split(/[.\-_+]/)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return y !== undefined && /^\d+$/.test(y) ? -1 : 1
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (nx !== ny) {
      return nx ? 1 : -1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
