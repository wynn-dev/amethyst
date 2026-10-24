/**
 * Pinned arm64 replacement artifacts for pre-1.19 versions on an arm64 JVM.
 *
 * Built by hand from Maven Central (`repo1.maven.org/maven2`) and Mojang's library host: every
 * sha1 below was read from the artifact's `.sha1` sidecar and every size from the HTTP
 * `Content-Length`. The LWJGL 3.3.1 values are identical to the ones Mojang's own 1.19 JSON pins
 * on `libraries.minecraft.net`. `natives.net.test.ts` re-checks them against Maven Central.
 *
 * Bump {@link NATIVES_TABLE_REVISION} whenever an entry changes, so cached natives directories
 * and plans are invalidated.
 */

export const NATIVES_TABLE_REVISION = 2

/** One pinned artifact. `path` is relative to `<root>/libraries`. */
export interface PinnedArtifact {
  /** Full maven coordinate, including the classifier. */
  name: string
  path: string
  url: string
  sha1: string
  size: number
}

const CENTRAL = 'https://repo1.maven.org/maven2/'
const MOJANG = 'https://libraries.minecraft.net/'

function pin(repo: string, group: string, artifact: string, version: string, classifier: string | undefined, sha1: string, size: number): PinnedArtifact {
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  const path = `${group.replaceAll('.', '/')}/${artifact}/${version}/${file}`
  return { name: `${group}:${artifact}:${version}${classifier ? `:${classifier}` : ''}`, path, url: repo + path, sha1, size }
}

/** LWJGL release that replaces every LWJGL 3 module older than 3.3.0. 3.3.1 is what Mojang ships with 1.19. */
export const LWJGL3_REPLACEMENT_VERSION = '3.3.1'

/** First LWJGL 3 release whose macOS natives include arm64. Older modules are replaced. */
export const LWJGL3_MIN_ARM64 = '3.3.0'

/** LWJGL 3 modules used by Minecraft 1.13–1.18.2 (and their snapshots), each as `{ jar, nativesArm64 }`. */
export const LWJGL3_ARM64: Readonly<Record<string, { jar: PinnedArtifact; nativesArm64: PinnedArtifact }>> = {
  lwjgl: {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl', '3.3.1', undefined, 'ae58664f88e18a9bb2c77b063833ca7aaec484cb', 724243),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl', '3.3.1', 'natives-macos-arm64', '71d0d5e469c9c95351eb949064497e3391616ac9', 42693),
  },
  'lwjgl-jemalloc': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-jemalloc', '3.3.1', undefined, 'a817bcf213db49f710603677457567c37d53e103', 36601),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-jemalloc', '3.3.1', 'natives-macos-arm64', 'e577b87d8ad2ade361aaea2fcf226c660b15dee8', 103475),
  },
  'lwjgl-openal': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-openal', '3.3.1', undefined, '2623a6b8ae1dfcd880738656a9f0243d2e6840bd', 88237),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-openal', '3.3.1', 'natives-macos-arm64', '23d55e7490b57495320f6c9e1936d78fd72c4ef8', 346125),
  },
  'lwjgl-opengl': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-opengl', '3.3.1', undefined, '831a5533a21a5f4f81bbc51bb13e9899319b5411', 921563),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-opengl', '3.3.1', 'natives-macos-arm64', 'eafe34b871d966292e8db0f1f3d6b8b110d4e91d', 41665),
  },
  // planNatives puts the Amethyst-patched GLFW (glfw.ts) on the classpath instead of these
  // natives; they stay pinned for reference and for natives.net.test.ts.
  'lwjgl-glfw': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-glfw', '3.3.1', undefined, 'cbac1b8d30cb4795149c1ef540f912671a8616d0', 128801),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-glfw', '3.3.1', 'natives-macos-arm64', 'cac0d3f712a3da7641fa174735a5f315de7ffe0a', 129077),
  },
  'lwjgl-stb': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-stb', '3.3.1', undefined, 'b119297cf8ed01f247abe8685857f8e7fcf5980f', 112380),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-stb', '3.3.1', 'natives-macos-arm64', 'fcf073ed911752abdca5f0b00a53cfdf17ff8e8b', 178408),
  },
  'lwjgl-tinyfd': {
    jar: pin(CENTRAL, 'org.lwjgl', 'lwjgl-tinyfd', '3.3.1', undefined, '0ff1914111ef2e3e0110ef2dabc8d8cdaad82347', 6767),
    nativesArm64: pin(CENTRAL, 'org.lwjgl', 'lwjgl-tinyfd', '3.3.1', 'natives-macos-arm64', '972ecc17bad3571e81162153077b4d47b7b9eaa9', 41380),
  },
}

/**
 * `ca.weblite:java-objc-bridge` 1.1: its jar embeds a universal (x86_64 + arm64) `libjcocoa.dylib`
 * and replaces 1.0.0 plus its x86_64-only natives jar. Same file on Maven Central and Mojang's host.
 */
export const OBJC_BRIDGE_ARM64 = pin(CENTRAL, 'ca.weblite', 'java-objc-bridge', '1.1', undefined, '1227f9e0666314f9de41477e3ec277e542ed7f7b', 1330045)
export const OBJC_BRIDGE_MIN = '1.1'

/**
 * JNA 5.10.0 (what Mojang ships with 1.18.2–1.19.2). JNA gained darwin-aarch64 in 5.7.0; older
 * versions (3.4.0, 4.4.0 in 1.8–1.16.5) carry only i386/x86_64 dispatch libraries, and
 * java-objc-bridge 1.1 is built against JNA 5.10.0.
 */
export const JNA_ARM64 = {
  jna: pin(CENTRAL, 'net.java.dev.jna', 'jna', '5.10.0', undefined, '7cf4c87dd802db50721db66947aa237d7ad09418', 1756400),
  'jna-platform': pin(CENTRAL, 'net.java.dev.jna', 'jna-platform', '5.10.0', undefined, 'fbed7d9669dba47714ad0d4f4454290a997aee69', 1343495),
} as const
export const JNA_MIN_ARM64 = '5.7.0'

/** `com.mojang:text2speech` 1.11.3 (1.14–1.18.1), replacing the 1.10.x used by 1.12–1.13.2. Mojang-hosted only. */
export const TEXT2SPEECH_ARM64 = pin(MOJANG, 'com.mojang', 'text2speech', '1.11.3', undefined, 'f378f889797edd7df8d32272c06ca80a1b6b0f58', 13164)
export const TEXT2SPEECH_MIN = '1.11.3'
