/**
 * Amethyst-built arm64 natives for LWJGL 2 era versions (Minecraft ≤ 1.12.2).
 *
 * No arm64 builds of LWJGL 2's `lwjgl-platform` natives exist upstream, so a CI workflow in
 * this repository builds them from public source and publishes them on a GitHub release
 * (`natives-*` tag). The app pins their sha256 through an {@link Lwjgl2Arm64Source} manifest,
 * which is injectable so tests, CI and future releases can supply their own.
 */

/** One published artifact: a jar holding flat arm64 (or universal) dylibs. */
export interface Lwjgl2Arm64Artifact {
  /** Artifact family: `lwjgl-platform` or `jinput-platform`. */
  name: string
  /** The *original* upstream version it replaces, e.g. `2.9.2-nightly-20140822`. */
  version: string
  /** Absolute URL, or a URL relative to {@link Lwjgl2Arm64Source.baseUrl}. */
  url: string
  sha256: string
  size: number
}

export interface Lwjgl2Arm64Source {
  /** Base for relative artifact URLs, e.g. the release download prefix (ends with `/`). */
  baseUrl: string
  artifacts: readonly Lwjgl2Arm64Artifact[]
}

/** Maven group used for the local copies under `<root>/libraries`, so they never collide with upstream files. */
export const AMETHYST_NATIVES_GROUP = 'dev.wynn.amethyst.natives'

/** Classifier of the Amethyst-built jars. */
export const AMETHYST_NATIVES_CLASSIFIER = 'natives-macos-arm64'

/**
 * Placeholder manifest until the CI job publishes the first `natives-lwjgl2-*` release. With no
 * artifacts, plans for LWJGL 2 versions on an arm64 JVM report `ENATIVES_UNAVAILABLE`.
 */
export const DEFAULT_LWJGL2_ARM64_SOURCE: Lwjgl2Arm64Source = Object.freeze({
  baseUrl: 'https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-1/',
  artifacts: Object.freeze([]) as readonly Lwjgl2Arm64Artifact[],
})

/** An artifact the LWJGL 2 CI job must build, with the Minecraft versions that need it. */
export interface RequiredLwjgl2Artifact {
  name: 'lwjgl-platform' | 'jinput-platform'
  version: string
  /** Files the jar must contain at its root (flat), built for arm64. */
  files: readonly string[]
  /** First and last Mojang version ids (manifest order) that use it on macOS. */
  minecraft: { first: string; last: string; releases: string }
  /** When false, the plan drops the original natives instead of failing if the artifact is missing. */
  required: boolean
}

/**
 * Every LWJGL 2 era native artifact that Mojang's version JSON selects on macOS, from a scan of all
 * 920 entries of `version_manifest_v2.json` (rules evaluated for macOS 14). Versions not listed
 * (`2.9.1-nightly-20130708-debug3`, `2.9.4-nightly-20150209`) are disallowed on modern macOS.
 */
export const REQUIRED_LWJGL2_ARTIFACTS: readonly RequiredLwjgl2Artifact[] = [
  { name: 'lwjgl-platform', version: '2.9.0', files: ['liblwjgl.dylib', 'openal.dylib'], minecraft: { first: 'rd-132211', last: '13w41b', releases: '1.0–1.6.4, plus all classic/indev/infdev/alpha/beta' }, required: true },
  { name: 'lwjgl-platform', version: '2.9.1-nightly-20131017', files: ['liblwjgl.dylib', 'openal.dylib'], minecraft: { first: '13w42a', last: '1.7.2', releases: '1.7.2' }, required: true },
  { name: 'lwjgl-platform', version: '2.9.1-nightly-20131120', files: ['liblwjgl.dylib', 'openal.dylib'], minecraft: { first: '13w47a', last: '1.7.4', releases: '1.7.3–1.7.4' }, required: true },
  { name: 'lwjgl-platform', version: '2.9.1', files: ['liblwjgl.dylib', 'openal.dylib'], minecraft: { first: '14w02a', last: '1.8-pre2', releases: '1.7.5–1.7.10' }, required: true },
  { name: 'lwjgl-platform', version: '2.9.2-nightly-20140822', files: ['liblwjgl.dylib', 'openal.dylib'], minecraft: { first: '1.8-pre3', last: '1.12.2', releases: '1.8–1.12.2' }, required: true },
  { name: 'jinput-platform', version: '2.0.5', files: ['libjinput-osx.jnilib'], minecraft: { first: 'rd-132211', last: '1.12.2', releases: '1.0–1.12.2 (controllers only)' }, required: false },
]

/** Find the arm64 artifact for an upstream native library, matching family and exact version. */
export function findLwjgl2Artifact(source: Lwjgl2Arm64Source, name: string, version: string): Lwjgl2Arm64Artifact | undefined {
  return source.artifacts.find((a) => a.name === name && a.version === version)
}

/** Resolve an artifact URL against the source's base URL. */
export function lwjgl2ArtifactUrl(source: Lwjgl2Arm64Source, artifact: Lwjgl2Arm64Artifact): string {
  return new URL(artifact.url, source.baseUrl).toString()
}

/**
 * Validate an untrusted manifest (for example one fetched from a release) and return it typed.
 *
 * @throws {TypeError} naming the first invalid field.
 */
export function parseLwjgl2Arm64Source(raw: unknown): Lwjgl2Arm64Source {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('LWJGL 2 natives manifest must be an object')
  const { baseUrl, artifacts } = raw as { baseUrl?: unknown; artifacts?: unknown }
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) throw new TypeError('LWJGL 2 natives manifest: baseUrl must be an https URL')
  if (!Array.isArray(artifacts)) throw new TypeError('LWJGL 2 natives manifest: artifacts must be an array')
  const out = artifacts.map((a: unknown, i): Lwjgl2Arm64Artifact => {
    const x = a as Partial<Lwjgl2Arm64Artifact> | null
    const where = `LWJGL 2 natives manifest: artifacts[${i}]`
    if (!x || typeof x !== 'object') throw new TypeError(`${where} must be an object`)
    if (typeof x.name !== 'string' || !/^[\w.-]+$/.test(x.name)) throw new TypeError(`${where}.name is invalid`)
    if (typeof x.version !== 'string' || !/^[\w.+-]+$/.test(x.version)) throw new TypeError(`${where}.version is invalid`)
    if (typeof x.url !== 'string' || x.url === '') throw new TypeError(`${where}.url is invalid`)
    if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(x.sha256)) throw new TypeError(`${where}.sha256 must be 64 hex characters`)
    if (typeof x.size !== 'number' || !Number.isInteger(x.size) || x.size <= 0) throw new TypeError(`${where}.size must be a positive integer`)
    const url = new URL(x.url, baseUrl)
    if (url.protocol !== 'https:') throw new TypeError(`${where}.url must be https`)
    return { name: x.name, version: x.version, url: x.url, sha256: x.sha256.toLowerCase(), size: x.size }
  })
  return { baseUrl, artifacts: out }
}
