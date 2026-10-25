/**
 * Amethyst-built, patched GLFW for LWJGL 3.3.1 on an arm64 JVM (Minecraft 1.13–1.18).
 *
 * Those versions get LWJGL 3.3.1 on Apple Silicon (see `table.ts`). Its official GLFW (a GLFW 3.4
 * development snapshot) reports an error from `glfwSetWindowIcon` on macOS, and Minecraft before
 * 1.19 treats any GLFW error during window creation as fatal, so the game never opens a window.
 * A CI workflow in this repository (`natives/lwjgl3-glfw`) rebuilds the same GLFW source with that
 * call made a silent no-op and publishes it on a GitHub release (`natives-lwjgl3-glfw-v<N>`). The
 * jar replaces `org.lwjgl:lwjgl-glfw:3.3.1:natives-macos-arm64` on the classpath and has the same
 * layout (`macos/arm64/org/lwjgl/glfw/libglfw.dylib` plus its `.sha1`), so LWJGL's own loader
 * extracts and loads it.
 *
 * The app pins the release's sha256 through a {@link GlfwArm64Source} manifest, which is
 * injectable so tests, CI and future releases can supply their own.
 */

/** One published artifact: a classpath natives jar holding `macos/arm64/org/lwjgl/glfw/libglfw.dylib`. */
export interface GlfwArm64Artifact {
  /** Artifact family: `lwjgl-glfw`. */
  name: string
  /** The LWJGL version it is built for (the version of the `lwjgl-glfw` Java jar), e.g. `3.3.1`. */
  version: string
  /** Absolute URL, or a URL relative to {@link GlfwArm64Source.baseUrl}. */
  url: string
  sha256: string
  size: number
}

export interface GlfwArm64Source {
  /** Base for relative artifact URLs, e.g. the release download prefix (ends with `/`). */
  baseUrl: string
  artifacts: readonly GlfwArm64Artifact[]
}

/** Artifact id of the local copy under `<root>/libraries/dev/wynn/amethyst/natives/` (group `AMETHYST_NATIVES_GROUP`). */
export const GLFW_PATCHED_ARTIFACT = 'lwjgl-glfw-patched'

/**
 * The pinned `natives-lwjgl3-glfw-v1` release (its `manifest.json`), built by
 * `.github/workflows/natives-lwjgl3-glfw.yml`. Pinned by sha256 so launches work offline once the
 * jar is cached. Bump this when a new release is published.
 */
export const DEFAULT_GLFW_ARM64_SOURCE: GlfwArm64Source = Object.freeze({
  baseUrl: 'https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl3-glfw-v1/',
  artifacts: Object.freeze([
    Object.freeze({
      name: 'lwjgl-glfw',
      version: '3.3.1',
      url: 'lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar',
      sha256: '5556c6c0fea6373e837dbbfd5b2e2a219464cbcd16ff120df7e098c1968c34e9',
      size: 63442,
    }),
  ]) as readonly GlfwArm64Artifact[],
})

/** Find the patched GLFW built for `lwjglVersion`. */
export function findGlfwArtifact(source: GlfwArm64Source, lwjglVersion: string): GlfwArm64Artifact | undefined {
  return source.artifacts.find((a) => a.name === 'lwjgl-glfw' && a.version === lwjglVersion)
}

/** Resolve an artifact URL against the source's base URL. */
export function glfwArtifactUrl(source: GlfwArm64Source, artifact: GlfwArm64Artifact): string {
  return new URL(artifact.url, source.baseUrl).toString()
}

/**
 * Validate an untrusted manifest (for example the `manifest.json` of a release) and return it
 * typed. Artifact URLs must be https (absolute, or relative to an https `baseUrl`).
 *
 * @throws {TypeError} naming the first invalid field.
 */
export function parseGlfwArm64Source(raw: unknown): GlfwArm64Source {
  const what = 'GLFW natives manifest'
  if (typeof raw !== 'object' || raw === null) throw new TypeError(`${what} must be an object`)
  const { baseUrl, artifacts } = raw as { baseUrl?: unknown; artifacts?: unknown }
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) throw new TypeError(`${what}: baseUrl must be an https URL`)
  if (!Array.isArray(artifacts)) throw new TypeError(`${what}: artifacts must be an array`)
  const out = artifacts.map((a: unknown, i): GlfwArm64Artifact => {
    const x = a as Partial<GlfwArm64Artifact> | null
    const where = `${what}: artifacts[${i}]`
    if (!x || typeof x !== 'object') throw new TypeError(`${where} must be an object`)
    if (typeof x.name !== 'string' || !/^[\w.-]+$/.test(x.name)) throw new TypeError(`${where}.name is invalid`)
    if (typeof x.version !== 'string' || !/^[\w.+-]+$/.test(x.version)) throw new TypeError(`${where}.version is invalid`)
    if (typeof x.url !== 'string' || x.url === '') throw new TypeError(`${where}.url is invalid`)
    if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(x.sha256)) throw new TypeError(`${where}.sha256 must be 64 hex characters`)
    if (typeof x.size !== 'number' || !Number.isInteger(x.size) || x.size <= 0) throw new TypeError(`${where}.size must be a positive integer`)
    if (new URL(x.url, baseUrl).protocol !== 'https:') throw new TypeError(`${where}.url must be https`)
    return { name: x.name, version: x.version, url: x.url, sha256: x.sha256.toLowerCase(), size: x.size }
  })
  return { baseUrl, artifacts: out }
}
