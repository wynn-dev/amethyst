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

/** The GitHub release the Amethyst-built LWJGL 2 arm64 natives are published on. */
export const LWJGL2_ARM64_RELEASE_TAG = 'natives-lwjgl2-v1'

const pinned = (name: string, version: string, sha256: string, size: number): Lwjgl2Arm64Artifact =>
  Object.freeze({ name, version, url: `${name}-${version}-natives-osx-arm64.jar`, sha256, size })

/**
 * The pinned manifest of the `natives-lwjgl2-v1` release (`manifest.json` there), so LWJGL 2
 * versions launch without fetching it. Every jar is verified by sha256 before use. The jars carry
 * their licences under `META-INF/`, which extraction skips.
 */
export const DEFAULT_LWJGL2_ARM64_SOURCE: Lwjgl2Arm64Source = Object.freeze({
  baseUrl: `https://github.com/wynn-dev/amethyst/releases/download/${LWJGL2_ARM64_RELEASE_TAG}/`,
  artifacts: Object.freeze([
    pinned('lwjgl-platform', '2.9.0', '8828a272251e35fa6bac65e2201f3bb1fd25525012754c9f2f307f946dd0949d', 711714),
    pinned('lwjgl-platform', '2.9.1-nightly-20131017', 'e63caf9b9fe95d0c1bf7d077505aa471f8b37c03fae56726c36560e6d630f719', 713399),
    pinned('lwjgl-platform', '2.9.1-nightly-20131120', '50db657d6517ef94b4b2f8820394752d26bda2bef9cb1736518a41ed2e3b48a4', 714207),
    pinned('lwjgl-platform', '2.9.1', '50db657d6517ef94b4b2f8820394752d26bda2bef9cb1736518a41ed2e3b48a4', 714207),
    pinned('lwjgl-platform', '2.9.2-nightly-20140822', '05b05974c0c8ac735dd09683dbb6d98b882b0806b9102f582b0d57b36a92e8f4', 716930),
    pinned('jinput-platform', '2.0.5', '5834fd1f79c4f904aac70b40f1989d32614b082da5cc16f1b1b3f999e6e0ba83', 6712),
  ]) as readonly Lwjgl2Arm64Artifact[],
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

/**
 * Limit an untrusted manifest (fetched from the release, or read from its on-disk cache) to the
 * pinned artifacts. A remote entry is used only when its family, version, sha256 and size match a
 * pinned one, so it can at most move where a pinned jar is downloaded from, never change which
 * bytes run. Pinned artifacts the remote manifest lacks (or lists differently) keep their pinned
 * entry, so the result always holds exactly the pinned set.
 */
export function restrictLwjgl2ToPinned(source: Lwjgl2Arm64Source, trusted: Lwjgl2Arm64Source = DEFAULT_LWJGL2_ARM64_SOURCE): Lwjgl2Arm64Source {
  const artifacts = trusted.artifacts.map((p): Lwjgl2Arm64Artifact => {
    const remote = source.artifacts.find((a) => a.name === p.name && a.version === p.version && a.sha256.toLowerCase() === p.sha256 && a.size === p.size)
    if (!remote) return { ...p, url: lwjgl2ArtifactUrl(trusted, p) }
    return { ...p, url: lwjgl2ArtifactUrl(source, remote) }
  })
  return { baseUrl: trusted.baseUrl, artifacts }
}
