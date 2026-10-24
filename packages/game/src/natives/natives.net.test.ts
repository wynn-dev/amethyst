import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { JNA_ARM64, LWJGL3_ARM64, OBJC_BRIDGE_ARM64, TEXT2SPEECH_ARM64, type PinnedArtifact } from './table'

const pinned: PinnedArtifact[] = [
  ...Object.values(LWJGL3_ARM64).flatMap((m) => [m.jar, m.nativesArm64]),
  OBJC_BRIDGE_ARM64,
  ...Object.values(JNA_ARM64),
  TEXT2SPEECH_ARM64,
]

describe.runIf(process.env.AMETHYST_NET_TESTS)('pinned arm64 replacement artifacts (network)', () => {
  for (const a of pinned) {
    it(`${a.name} resolves with the pinned sha1 and size`, { timeout: 60_000 }, async () => {
      expect(a.url.endsWith(a.path)).toBe(true)
      const sidecar = await fetch(`${a.url}.sha1`)
      expect(sidecar.ok).toBe(true)
      expect((await sidecar.text()).trim().slice(0, 40).toLowerCase()).toBe(a.sha1)
      const res = await fetch(a.url)
      expect(res.ok).toBe(true)
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.length).toBe(a.size)
      expect(createHash('sha1').update(body).digest('hex')).toBe(a.sha1)
      // natives-macos-arm64 jars must really contain arm64 macOS libraries.
      expect(!a.name.endsWith(':natives-macos-arm64') || body.includes(Buffer.from('macos/arm64/'))).toBe(true)
    })
  }
})
