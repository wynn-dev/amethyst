import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GlfwArm64Source } from '../natives/glfw'
import type { Lwjgl2Arm64Source } from '../natives/lwjgl2'

/** `versions` directory holding trimmed real version JSON (Mojang, Fabric meta, Forge/NeoForge installers). */
export const FIXTURE_VERSIONS = fileURLToPath(new URL('./versions', import.meta.url))
export const FIXTURE_ASSETS = fileURLToPath(new URL('./assets', import.meta.url))
export const FIXTURE_LOGS = fileURLToPath(new URL('./logs', import.meta.url))

export async function tempDir(prefix = 'amethyst-game-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  // Resolve /var → /private/var so paths reported by child processes compare equal.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const fakeSha = (n: number) => n.toString(16).padStart(64, '0')

/** A complete fake LWJGL 2 arm64 manifest, as the CI release would publish it. */
export const TEST_LWJGL2_SOURCE: Lwjgl2Arm64Source = {
  baseUrl: 'https://example.invalid/natives/',
  artifacts: [
    { name: 'lwjgl-platform', version: '2.9.0', url: 'lwjgl-platform-2.9.0-natives-macos-arm64.jar', sha256: fakeSha(1), size: 100 },
    { name: 'lwjgl-platform', version: '2.9.1', url: 'lwjgl-platform-2.9.1-natives-macos-arm64.jar', sha256: fakeSha(2), size: 100 },
    { name: 'lwjgl-platform', version: '2.9.2-nightly-20140822', url: 'lwjgl-platform-2.9.2-nightly-20140822-natives-macos-arm64.jar', sha256: fakeSha(3), size: 100 },
  ],
}

/** A fake patched-GLFW manifest, as the `natives-lwjgl3-glfw` CI release would publish it. */
export const TEST_GLFW_SOURCE: GlfwArm64Source = {
  baseUrl: 'https://example.invalid/glfw/',
  artifacts: [{ name: 'lwjgl-glfw', version: '3.3.1', url: 'lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar', sha256: fakeSha(0x61f3), size: 62116 }],
}
