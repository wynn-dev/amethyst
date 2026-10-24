import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { compress } from 'lzma1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES, put, sha1, tempDir } from './__fixtures__/helpers'
import { decodeLzmaFile, parseLzmaHeader } from './lzma'
import { parseReleaseFile } from './release'

let dir: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ dir, cleanup } = await tempDir())
})
afterEach(() => cleanup())

/** Compressible but non-trivial content, generated in-test (no binary fixture needed). */
function sample(size: number): Buffer {
  const words = ['java', 'runtime', 'arm64', 'minecraft', 'amethyst', 'lzma']
  const parts: string[] = []
  let length = 0
  for (let i = 0; length < size; i++) {
    const word = `${words[i % words.length]}${(i * 7919) % 1000}`
    parts.push(word)
    length += word.length + 1
  }
  return Buffer.from(parts.join(' ').slice(0, size))
}

describe('decodeLzmaFile', () => {
  it('stream-decodes an .lzma file and verifies size and sha1', async () => {
    const data = Buffer.concat([sample(300_000), randomBytes(20_000)])
    const packed = compress(data, 6)
    await put(join(dir, 'a.lzma'), packed)
    const written = await decodeLzmaFile(join(dir, 'a.lzma'), join(dir, 'a'), { size: data.length, sha1: sha1(data) })
    expect(written).toBe(data.length)
    expect((await readFile(join(dir, 'a'))).equals(data)).toBe(true)
  })

  it('decodes a real Mojang lzma blob (java-runtime-delta mac-os-arm64 release file)', async () => {
    // Fetched from https://piston-data.mojang.com/v1/objects/5e6e2a6c0ab11a9237766184b6fea176e4cba978/release
    // (the `lzma` download of jre.bundle/Contents/Home/release; raw sha1 e12db204..., 1051 bytes).
    const out = join(dir, 'release')
    await decodeLzmaFile(join(FIXTURES, 'mojang-delta-release.lzma'), out, { size: 1051, sha1: 'e12db2048e5d88567ec3e4413eaa74f141fc343b' })
    const release = parseReleaseFile(await readFile(out, 'utf8'))
    expect(release.JAVA_VERSION).toBe('21.0.7')
    // Mojang's release files carry no OS_ARCH, which is why the Mach-O header is checked.
    expect(release.OS_ARCH).toBeUndefined()
  })

  it('rejects wrong sha1, wrong size and corrupt input without leaving files behind', async () => {
    const data = sample(50_000)
    await put(join(dir, 'b.lzma'), compress(data, 3))
    await expect(decodeLzmaFile(join(dir, 'b.lzma'), join(dir, 'b'), { sha1: '0'.repeat(40) })).rejects.toMatchObject({ code: 'ELZMA' })
    await expect(decodeLzmaFile(join(dir, 'b.lzma'), join(dir, 'b'), { size: 10 })).rejects.toMatchObject({ code: 'ELZMA' })
    await expect(decodeLzmaFile(join(dir, 'b.lzma'), join(dir, 'b'), { size: data.length + 1 })).rejects.toMatchObject({ code: 'ELZMA' })
    const packed = compress(data, 3)
    await put(join(dir, 'trunc.lzma'), packed.subarray(0, packed.length >> 1))
    await expect(decodeLzmaFile(join(dir, 'trunc.lzma'), join(dir, 't'))).rejects.toMatchObject({ code: 'ELZMA' })
    await put(join(dir, 'html.lzma'), '<html>502 Bad Gateway</html>')
    await expect(decodeLzmaFile(join(dir, 'html.lzma'), join(dir, 'h'))).rejects.toMatchObject({ code: 'ELZMA' })
    const left = await Promise.all(['b', 'b.lzpart', 't', 't.lzpart', 'h'].map((f) => stat(join(dir, f)).then(() => f, () => undefined)))
    expect(left.filter(Boolean)).toEqual([])
  })

  it('stops when aborted', async () => {
    await put(join(dir, 'c.lzma'), compress(sample(400_000), 1))
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(decodeLzmaFile(join(dir, 'c.lzma'), join(dir, 'c'), { signal: controller.signal })).rejects.toThrow('stop')
  })
})

describe('parseLzmaHeader', () => {
  it('reads Mojang-style headers and rejects hostile ones', async () => {
    const real = parseLzmaHeader(await readFile(join(FIXTURES, 'mojang-delta-release.lzma')))
    expect(real).toEqual({ lc: 3, lp: 0, pb: 2, dictSize: 8 * 1024 * 1024 })
    const huge = Buffer.from([0x5d, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(() => parseLzmaHeader(huge)).toThrow(/dictionary too large/)
    expect(() => parseLzmaHeader(Buffer.from([0xff, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/properties/)
    expect(() => parseLzmaHeader(Buffer.alloc(4))).toThrow(/truncated/)
    // lzma1 records the known size in the header.
    expect(parseLzmaHeader(Buffer.from(compress(Buffer.from('hello'), 1))).uncompressedSize).toBe(5)
  })
})
