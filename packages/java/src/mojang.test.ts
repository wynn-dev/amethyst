import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES } from './__fixtures__/helpers'
import { parseRuntimeIndex, parseRuntimeManifest, planRuntime, runtimeFor } from './mojang'
import { arm64Availability, resolveRuntimeFor } from './resolve'

const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'))

describe('runtime index', () => {
  it('parses the (trimmed) live index and builds the arm64 availability table', async () => {
    const index = parseRuntimeIndex(await json('mojang-all.json'))
    expect(arm64Availability(index)).toEqual([
      { component: 'jre-legacy', majorVersion: 8, x64: '8u74-cacert462b08' },
      { component: 'java-runtime-alpha', majorVersion: 16, x64: '16.0.1.9.1_3' },
      { component: 'java-runtime-beta', majorVersion: 17, x64: '17.0.15' },
      { component: 'java-runtime-gamma', majorVersion: 17, arm64: '17.0.15', x64: '17.0.15' },
      { component: 'java-runtime-gamma-snapshot', majorVersion: 17, arm64: '17.0.15', x64: '17.0.15' },
      { component: 'java-runtime-delta', majorVersion: 21, arm64: '21.0.7', x64: '21.0.7' },
      { component: 'java-runtime-epsilon', majorVersion: 25, arm64: '25.0.1', x64: '25.0.1' },
    ])
    expect(runtimeFor(index, 'java-runtime-delta')?.manifest).toEqual({
      sha1: '78b4178415da0ae9c738e65dd66ac57e4c8a4bcc',
      size: expect.any(Number),
      url: 'https://piston-meta.mojang.com/v1/packages/78b4178415da0ae9c738e65dd66ac57e4c8a4bcc/manifest.json',
    })
    expect(runtimeFor(index, 'jre-legacy')).toBeUndefined()
    expect(runtimeFor(index, 'jre-legacy', 'mac-os')?.majorVersion).toBe(8)
  })

  it('rejects a malformed index and drops malformed entries', () => {
    expect(() => parseRuntimeIndex('<html>')).toThrow(/not an object/)
    expect(() => parseRuntimeIndex({ linux: {} })).toThrow(/mac-os-arm64/)
    const index = parseRuntimeIndex({ 'mac-os-arm64': { a: [{ manifest: { sha1: 'zz', size: 1, url: 'https://x' } }], b: 'nope' } })
    expect(index['mac-os-arm64']).toEqual({ a: [] })
  })
})

describe('resolveRuntimeFor (against the live index fixture)', () => {
  it('uses Mojang arm64 where it exists and Zulu for Java 8 and explicit Java 16', async () => {
    const index = parseRuntimeIndex(await json('mojang-all.json'))
    const pick = (major: number, extra = {}) => {
      const c = resolveRuntimeFor(major, { index, ...extra })
      return c.source === 'mojang' ? `mojang:${c.component}` : `zulu:${c.majorVersion}`
    }
    expect(pick(8)).toBe('zulu:8')
    expect(pick(8, { component: 'jre-legacy' })).toBe('zulu:8')
    expect(pick(16, { component: 'java-runtime-alpha' })).toBe('mojang:java-runtime-gamma')
    expect(pick(16, { substitute16: false })).toBe('zulu:16')
    expect(pick(17, { component: 'java-runtime-beta' })).toBe('mojang:java-runtime-gamma')
    expect(pick(17)).toBe('mojang:java-runtime-gamma')
    expect(pick(17, { component: 'java-runtime-gamma-snapshot' })).toBe('mojang:java-runtime-gamma-snapshot')
    expect(pick(21)).toBe('mojang:java-runtime-delta')
    expect(pick(25)).toBe('mojang:java-runtime-epsilon')
    expect(pick(11)).toBe('zulu:11')
    expect(pick(21, { forceZulu: true })).toBe('zulu:21')
    expect(resolveRuntimeFor(21, {}).source).toBe('zulu')
    expect(resolveRuntimeFor(8, { index }).reason).toMatch(/no Apple Silicon build of Java 8/)
  })
})

describe('component manifest', () => {
  it('plans a (trimmed) real mac-os-arm64 manifest', async () => {
    const plan = planRuntime(parseRuntimeManifest(await json('mojang-manifest-delta.json')))
    expect(plan.javaPath).toBe('jre.bundle/Contents/Home/bin/java')
    expect(plan.directories[0]).toBe('jre.bundle')
    expect(plan.directories).toContain('jre.bundle/Contents/Home/legal/java.compiler')
    expect(plan.files.filter((f) => f.executable).map((f) => f.path)).toEqual([
      'jre.bundle/Contents/Home/bin/java',
      'jre.bundle/Contents/Home/bin/keytool',
      'jre.bundle/Contents/Home/lib/jspawnhelper',
    ])
    // lib/jvm.cfg has no lzma variant in the live manifest; everything else here does.
    expect(plan.files.filter((f) => !f.lzma).map((f) => f.path)).toEqual(['jre.bundle/Contents/Home/lib/jvm.cfg'])
    expect(plan.links).toEqual([{ path: 'jre.bundle/Contents/Home/legal/java.compiler/LICENSE', target: '../java.base/LICENSE' }])
    expect(plan.rawBytes).toBe(plan.files.reduce((n, f) => n + f.raw.size, 0))
    expect(plan.downloadBytes).toBeLessThan(plan.rawBytes)
    const java = plan.files.find((f) => f.path === plan.javaPath)!
    expect(java.raw.sha1).toBe('294165112e5d8b27e8f247928f1e63304bfd590e')
    expect(java.lzma?.sha1).toBe('d55e243b9b96d3ef10a284292556683f68bce69c')
  })

  it('rejects unsafe paths and escaping links', () => {
    const file = { type: 'file', downloads: { raw: { sha1: 'a'.repeat(40), size: 1, url: 'https://x/y' } } }
    expect(() => parseRuntimeManifest({ files: { '../evil': file } })).toThrow(/traversal/)
    expect(() => parseRuntimeManifest({ files: { '/abs': file } })).toThrow(/absolute/)
    expect(() => planRuntime(parseRuntimeManifest({ files: { 'a/link': { type: 'link', target: '../../etc/passwd' } } }))).toThrow(/escapes/)
    expect(() => planRuntime(parseRuntimeManifest({ files: { link: { type: 'link', target: '/etc/passwd' } } }))).toThrow(/unsafe symlink/)
    expect(() => parseRuntimeManifest({ files: { x: { type: 'fifo' } } })).toThrow(/unknown entry type/)
    expect(() => parseRuntimeManifest({ files: { x: { type: 'file', downloads: {} } } })).toThrow(/missing download/)
    // A broken lzma variant is ignored rather than fatal.
    const m = parseRuntimeManifest({ files: { x: { ...file, downloads: { ...file.downloads, lzma: { sha1: 'bad' } } } } })
    expect(m.files.x).toMatchObject({ type: 'file', executable: false })
    expect((m.files.x as { lzma?: unknown }).lzma).toBeUndefined()
  })
})
