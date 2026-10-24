import { describe, expect, it } from 'vitest'
import { FIXTURE_VERSIONS, TEST_GLFW_SOURCE, TEST_LWJGL2_SOURCE } from '../__fixtures__/helpers'
import { resolveVersion } from '../resolve'
import { DEFAULT_GLFW_ARM64_SOURCE, parseGlfwArm64Source, type GlfwArm64Source } from './glfw'
import { DEFAULT_LWJGL2_ARM64_SOURCE, parseLwjgl2Arm64Source, REQUIRED_LWJGL2_ARTIFACTS } from './lwjgl2'
import { planNatives, type NativesPlan } from './plan'

const plan = async (id: string, jvmArch: string, lwjgl2 = TEST_LWJGL2_SOURCE, glfw: GlfwArm64Source = TEST_GLFW_SOURCE) =>
  planNatives(await resolveVersion(FIXTURE_VERSIONS, id), { jvmArch, lwjgl2, glfw })

const PATCHED_GLFW = 'dev.wynn.amethyst.natives:lwjgl-glfw-patched:3.3.1:natives-macos-arm64'

/** Names of the libraries that matter for natives: LWJGL, jinput, objc bridge, text2speech, twitch, JNA. */
const relevant = (p: NativesPlan) =>
  p.libraries.map((l) => `${l.isNative ? 'extract ' : ''}${l.name}`).filter((n) => /lwjgl|jinput|objc|text2speech|twitch|jna|amethyst/.test(n))

describe('planNatives on an arm64 JVM', () => {
  it('1.7.10: LWJGL 2 natives come from the Amethyst build; jinput and twitch natives are removed', async () => {
    const p = await plan('1.7.10', 'arm64')
    expect(p.ok).toBe(true)
    expect(p.lwjgl).toBe(2)
    expect(relevant(p)).toEqual([
      'com.paulscode:librarylwjglopenal:20100824',
      'net.java.jinput:jinput:2.0.5',
      'org.lwjgl.lwjgl:lwjgl:2.9.1',
      'org.lwjgl.lwjgl:lwjgl_util:2.9.1',
      'tv.twitch:twitch:5.16',
      'extract dev.wynn.amethyst.natives:lwjgl-platform:2.9.1:natives-macos-arm64',
    ])
    const native = p.extract[0]
    expect(native?.download).toEqual({
      path: 'dev/wynn/amethyst/natives/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-macos-arm64.jar',
      url: 'https://example.invalid/natives/lwjgl-platform-2.9.1-natives-macos-arm64.jar',
      sha256: '0'.repeat(63) + '2',
      size: 100,
    })
    expect(p.replacements.map((r) => [r.from, r.to])).toEqual([
      ['org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', 'dev.wynn.amethyst.natives:lwjgl-platform:2.9.1:natives-macos-arm64'],
      ['net.java.jinput:jinput-platform:2.0.5:natives-osx', null],
      ['tv.twitch:twitch-platform:5.16:natives-osx', null],
    ])
  })

  it('1.7.10 with the placeholder manifest reports ENATIVES_UNAVAILABLE instead of crashing later', async () => {
    const p = await plan('1.7.10', 'arm64', DEFAULT_LWJGL2_ARM64_SOURCE)
    expect(p.ok).toBe(false)
    expect(p.issues).toEqual([
      {
        code: 'ENATIVES_UNAVAILABLE',
        library: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx',
        message: 'No arm64 build of LWJGL 2.9.1 natives is available (needed by Minecraft 1.7.10)',
      },
    ])
    expect(p.extract).toEqual([])
  })

  it('1.5.2 (LWJGL 2.9.0) is covered too', async () => {
    const p = await plan('1.5.2', 'arm64')
    expect(p.ok).toBe(true)
    expect(p.extract.map((l) => l.name)).toEqual(['dev.wynn.amethyst.natives:lwjgl-platform:2.9.0:natives-macos-arm64'])
  })

  it('1.12.2: LWJGL 2.9.2 nightly, objc bridge 1.1, text2speech 1.11.3, JNA 5.10.0', async () => {
    const p = await plan('1.12.2', 'arm64')
    expect(p.ok).toBe(true)
    expect(relevant(p)).toEqual([
      'net.java.dev.jna:jna:5.10.0',
      'net.java.dev.jna:platform:3.4.0',
      'com.paulscode:librarylwjglopenal:20100824',
      'net.java.jinput:jinput:2.0.5',
      'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822',
      'org.lwjgl.lwjgl:lwjgl_util:2.9.2-nightly-20140822',
      'com.mojang:text2speech:1.11.3',
      'ca.weblite:java-objc-bridge:1.1',
      'extract dev.wynn.amethyst.natives:lwjgl-platform:2.9.2-nightly-20140822:natives-macos-arm64',
    ])
    expect(p.libraries.find((l) => l.name === 'ca.weblite:java-objc-bridge:1.1')?.download.sha1).toBe('1227f9e0666314f9de41477e3ec277e542ed7f7b')
  })

  for (const [id, from] of [['1.13.2', '3.1.6'], ['1.16.5', '3.2.1'], ['1.18.2', '3.2.1']] as const) {
    it(`${id}: LWJGL ${from} becomes 3.3.1 with natives-macos-arm64 on the classpath, and the patched GLFW`, async () => {
      const p = await plan(id, 'arm64')
      expect(p.ok).toBe(true)
      expect(p.issues).toEqual([])
      expect(p.lwjgl).toBe(3)
      expect(p.extract).toEqual([])
      const lwjgl = p.libraries.filter((l) => l.coordinate.group === 'org.lwjgl')
      expect(new Set(lwjgl.map((l) => l.coordinate.version))).toEqual(new Set(['3.3.1']))
      const modules = id === '1.13.2' ? ['lwjgl', 'lwjgl-jemalloc', 'lwjgl-openal', 'lwjgl-opengl', 'lwjgl-glfw', 'lwjgl-stb'] : ['lwjgl', 'lwjgl-jemalloc', 'lwjgl-openal', 'lwjgl-opengl', 'lwjgl-glfw', 'lwjgl-stb', 'lwjgl-tinyfd']
      // Every module's official arm64 natives except GLFW's, which the patched jar replaces.
      expect(lwjgl.map((l) => l.name).toSorted()).toEqual(
        modules.flatMap((m) => (m === 'lwjgl-glfw' ? [`org.lwjgl:${m}:3.3.1`] : [`org.lwjgl:${m}:3.3.1`, `org.lwjgl:${m}:3.3.1:natives-macos-arm64`])).toSorted(),
      )
      expect(lwjgl.every((l) => l.download.url.startsWith('https://repo1.maven.org/maven2/org/lwjgl/') && l.download.sha1?.length === 40)).toBe(true)
      const glfw = p.libraries.filter((l) => l.name === PATCHED_GLFW)
      expect(glfw).toHaveLength(1)
      expect(glfw[0]).toMatchObject({
        isNative: false,
        download: {
          path: 'dev/wynn/amethyst/natives/lwjgl-glfw-patched/3.3.1/lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar',
          url: 'https://example.invalid/glfw/lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar',
          sha256: TEST_GLFW_SOURCE.artifacts[0]?.sha256,
          size: 62116,
        },
      })
      expect(p.classpath.map((l) => l.name)).toContain(PATCHED_GLFW)
      expect(p.replacements.filter((r) => r.to === PATCHED_GLFW).map((r) => r.from)).toEqual([`org.lwjgl:lwjgl-glfw:${from}`, `org.lwjgl:lwjgl-glfw:${from}:natives-macos`])
      expect(p.libraries.some((l) => l.coordinate.classifier === 'natives-macos')).toBe(false)
      expect(p.libraries.find((l) => l.coordinate.artifact === 'java-objc-bridge')?.coordinate.version).toBe('1.1')
      expect(p.libraries.filter((l) => l.coordinate.artifact === 'java-objc-bridge')).toHaveLength(1)
    })
  }

  it('1.16.5 without a patched GLFW build reports ENATIVES_UNAVAILABLE once', async () => {
    const p = await plan('1.16.5', 'arm64', TEST_LWJGL2_SOURCE, DEFAULT_GLFW_ARM64_SOURCE)
    expect(p.ok).toBe(false)
    expect(p.issues).toEqual([
      {
        code: 'ENATIVES_UNAVAILABLE',
        library: 'org.lwjgl:lwjgl-glfw:3.2.1',
        message: 'No patched arm64 GLFW for LWJGL 3.3.1 is available; Minecraft 1.16.5 cannot open its window with the official build',
      },
    ])
    expect(p.libraries.some((l) => l.coordinate.artifact.startsWith('lwjgl-glfw') && l.coordinate.classifier !== undefined)).toBe(false)
  })

  it('1.16.5: JNA 4.4.0 is upgraded; 1.18.2 keeps text2speech 1.12.4 and JNA 5.10.0', async () => {
    const a = await plan('1.16.5', 'arm64')
    expect(a.libraries.find((l) => l.coordinate.artifact === 'jna')?.coordinate.version).toBe('5.10.0')
    const b = await plan('1.18.2', 'arm64')
    expect(b.libraries.find((l) => l.coordinate.artifact === 'text2speech')?.coordinate.version).toBe('1.12.4')
    expect(b.libraries.find((l) => l.coordinate.artifact === 'jna')?.source).toBe('1.18.2')
  })

  for (const id of ['1.19.4', '1.21']) {
    it(`${id}: used as shipped (with the official GLFW, even without a patched build)`, async () => {
      const p = await plan(id, 'arm64', TEST_LWJGL2_SOURCE, DEFAULT_GLFW_ARM64_SOURCE)
      expect(p.ok).toBe(true)
      expect(p.replacements).toEqual([])
      expect(p.warnings).toEqual([])
      expect(p.extract).toEqual([])
      expect(p.libraries.some((l) => l.name.endsWith(':natives-macos-arm64'))).toBe(true)
    })
  }

  it('1.21: lwjgl-freetype keeps its odd natives-macos-patch jar and gets nothing synthesised', async () => {
    const p = await plan('1.21', 'arm64')
    expect(p.libraries.filter((l) => l.coordinate.artifact === 'lwjgl-freetype').map((l) => l.coordinate.classifier)).toEqual([undefined, 'natives-macos-arm64', 'natives-macos-patch'])
  })

  it('Forge and Fabric layers get the same replacements as their vanilla base', async () => {
    const forge = await plan('1.12.2-forge-14.23.5.2859', 'arm64')
    expect(forge.ok).toBe(true)
    expect(forge.extract.map((l) => l.name)).toEqual(['dev.wynn.amethyst.natives:lwjgl-platform:2.9.2-nightly-20140822:natives-macos-arm64'])
    const fabric = await plan('fabric-loader-0.16.14-1.16.5', 'arm64')
    expect(fabric.libraries.find((l) => l.name === 'org.lwjgl:lwjgl:3.3.1')).toBeDefined()
  })

  it('the escape hatch keeps the originals and warns', async () => {
    const p = planNatives(await resolveVersion(FIXTURE_VERSIONS, '1.16.5'), { jvmArch: 'arm64', replace: false })
    expect(p.replacements).toEqual([])
    expect(p.warnings[0]).toContain('will not start')
    expect(p.extract.map((l) => l.name)).toContain('org.lwjgl:lwjgl:3.2.1:natives-macos')
  })
})

describe('planNatives on an x64 (Rosetta) JVM', () => {
  const cases: [string, string[]][] = [
    ['1.7.10', ['org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', 'net.java.jinput:jinput-platform:2.0.5:natives-osx', 'tv.twitch:twitch-platform:5.16:natives-osx']],
    ['1.12.2', ['org.lwjgl.lwjgl:lwjgl-platform:2.9.2-nightly-20140822:natives-osx', 'net.java.jinput:jinput-platform:2.0.5:natives-osx', 'ca.weblite:java-objc-bridge:1.0.0:natives-osx']],
    ['1.16.5', ['org.lwjgl:lwjgl:3.2.1:natives-macos', 'org.lwjgl:lwjgl-jemalloc:3.2.1:natives-macos', 'org.lwjgl:lwjgl-openal:3.2.1:natives-macos', 'org.lwjgl:lwjgl-opengl:3.2.1:natives-macos', 'org.lwjgl:lwjgl-glfw:3.2.1:natives-macos', 'org.lwjgl:lwjgl-stb:3.2.1:natives-macos', 'org.lwjgl:lwjgl-tinyfd:3.2.1:natives-macos', 'ca.weblite:java-objc-bridge:1.0.0:natives-osx']],
    ['1.18.2', ['org.lwjgl:lwjgl:3.2.1:natives-macos', 'org.lwjgl:lwjgl-jemalloc:3.2.1:natives-macos', 'org.lwjgl:lwjgl-openal:3.2.1:natives-macos', 'org.lwjgl:lwjgl-opengl:3.2.1:natives-macos', 'org.lwjgl:lwjgl-glfw:3.2.1:natives-macos', 'org.lwjgl:lwjgl-stb:3.2.1:natives-macos', 'org.lwjgl:lwjgl-tinyfd:3.2.1:natives-macos', 'ca.weblite:java-objc-bridge:1.0.0:natives-osx']],
    ['1.19.4', []],
    ['1.21', []],
  ]
  for (const [id, natives] of cases) {
    it(`${id}: original natives, no replacements`, async () => {
      const p = await plan(id, 'x86_64', DEFAULT_LWJGL2_ARM64_SOURCE)
      expect(p.jvmArch).toBe('x64')
      expect(p.ok).toBe(true)
      expect(p.replacements).toEqual([])
      expect(p.extract.map((l) => l.name)).toEqual(natives)
      expect(p.warnings).toContain('Using an x86_64 JVM: the game runs translated by Rosetta 2')
    })
  }

  it('rejects unknown architectures', async () => {
    await expect(plan('1.21', 'ppc')).rejects.toThrow(TypeError)
  })
})

describe('GLFW manifest', () => {
  it('validates untrusted manifests', () => {
    expect(parseGlfwArm64Source(TEST_GLFW_SOURCE)).toEqual(TEST_GLFW_SOURCE)
    const a = TEST_GLFW_SOURCE.artifacts[0]
    expect(() => parseGlfwArm64Source(null)).toThrow(TypeError)
    expect(() => parseGlfwArm64Source({ baseUrl: 'http://x/', artifacts: [] })).toThrow(/https/)
    expect(() => parseGlfwArm64Source({ baseUrl: 'https://x/', artifacts: [{ ...a, sha256: 'abc' }] })).toThrow(/sha256/)
    expect(() => parseGlfwArm64Source({ baseUrl: 'https://x/', artifacts: [{ ...a, size: 0 }] })).toThrow(/size/)
    expect(() => parseGlfwArm64Source({ baseUrl: 'https://x/', artifacts: [{ ...a, url: 'http://evil/x.jar' }] })).toThrow(/https/)
    expect(parseGlfwArm64Source({ baseUrl: 'https://x/', artifacts: [{ ...a, sha256: 'AB'.repeat(32) }] }).artifacts[0]?.sha256).toBe('ab'.repeat(32))
  })

  it('the placeholder default has no artifacts until a natives-lwjgl3-glfw release is pinned', () => {
    expect(DEFAULT_GLFW_ARM64_SOURCE.baseUrl).toMatch(/^https:\/\/github\.com\/wynn-dev\/amethyst\/releases\/download\/natives-lwjgl3-glfw-v\d+\/$/)
    expect(DEFAULT_GLFW_ARM64_SOURCE.artifacts).toEqual([])
  })
})

describe('LWJGL 2 manifest', () => {
  it('validates untrusted manifests', () => {
    expect(parseLwjgl2Arm64Source(TEST_LWJGL2_SOURCE).artifacts).toHaveLength(3)
    expect(() => parseLwjgl2Arm64Source({ baseUrl: 'http://x/', artifacts: [] })).toThrow(/https/)
    expect(() => parseLwjgl2Arm64Source({ baseUrl: 'https://x/', artifacts: [{ ...TEST_LWJGL2_SOURCE.artifacts[0], sha256: 'abc' }] })).toThrow(/sha256/)
    expect(() => parseLwjgl2Arm64Source({ baseUrl: 'https://x/', artifacts: [{ ...TEST_LWJGL2_SOURCE.artifacts[0], url: 'http://evil/x.jar' }] })).toThrow(/https/)
  })

  it('lists exactly the artifacts CI must build', () => {
    expect(REQUIRED_LWJGL2_ARTIFACTS.filter((a) => a.required).map((a) => `${a.name}:${a.version}`)).toEqual([
      'lwjgl-platform:2.9.0',
      'lwjgl-platform:2.9.1-nightly-20131017',
      'lwjgl-platform:2.9.1-nightly-20131120',
      'lwjgl-platform:2.9.1',
      'lwjgl-platform:2.9.2-nightly-20140822',
    ])
  })
})
