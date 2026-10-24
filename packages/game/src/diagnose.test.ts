/* oxlint-disable no-await-in-loop -- fixtures are written sequentially */
import { createHash } from 'node:crypto'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_VERSIONS, tempDir } from './__fixtures__/helpers'
import { diagnose } from './diagnose'
import { DEFAULT_LWJGL2_ARM64_SOURCE } from './natives/lwjgl2'
import { mergeVersionChain, resolveVersion } from './resolve'
import type { VersionJson } from './schema'

let root: string
let cleanup: () => Promise<void>
beforeEach(async () => ({ dir: root, cleanup } = await tempDir()))
afterEach(() => cleanup())

const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

async function put(rel: string, data: Buffer | string) {
  const p = path.join(root, rel)
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, data)
  return p
}

const ASSETS = 3500

/** A small but complete synthetic installation with real hashes, plus 3,500 asset objects. */
async function install() {
  const client = Buffer.from('client jar')
  const lib = Buffer.from('library a')
  const fabric = Buffer.from('fabric lib')
  const log = Buffer.from('<Configuration/>')
  const objects: Record<string, { hash: string; size: number }> = {}
  const writes: [string, Buffer][] = []
  for (let i = 0; i < ASSETS; i++) {
    const data = Buffer.from(`asset ${i}`)
    const hash = sha1(data)
    objects[`minecraft/sounds/${i}.ogg`] = { hash, size: data.length }
    writes.push([`assets/objects/${hash.slice(0, 2)}/${hash}`, data])
  }
  // Writing thousands of files one at a time is slow on CI runners; batch them.
  for (let i = 0; i < writes.length; i += 128) {
    await Promise.all(writes.slice(i, i + 128).map(([rel, data]) => put(rel, data)))
  }
  const index = JSON.stringify({ objects })
  await put('assets/indexes/5.json', index)
  await put('versions/1.0/1.0.jar', client)
  await put('libraries/a/b/1/b-1.jar', lib)
  await put('libraries/net/fabricmc/x/2/x-2.jar', fabric)
  await put('assets/log_configs/client-1.12.xml', log)
  const json: VersionJson = {
    id: '1.0',
    mainClass: 'M',
    assets: '5',
    assetIndex: { id: '5', sha1: sha1(index), size: index.length, url: 'https://piston-meta.mojang.com/5.json' },
    downloads: { client: { sha1: sha1(client), size: client.length, url: 'https://piston-data.mojang.com/client.jar' } },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml', sha1: sha1(log), size: log.length, url: 'https://x/client-1.12.xml' } } },
    libraries: [
      { name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', sha1: sha1(lib), size: lib.length, url: 'https://libraries.minecraft.net/a/b/1/b-1.jar' } } },
      { name: 'net.fabricmc:x:2', url: 'https://maven.fabricmc.net/', sha1: sha1(fabric), size: fabric.length },
    ],
  }
  const version = mergeVersionChain([json], { versionsDir: path.join(root, 'versions') })
  return { version, objects }
}

// Fixture setup creates 3,500 files per test; the speed assertion below is what guards diagnose itself.
describe('diagnose', { timeout: 30_000 }, () => {
  it('reports nothing for a complete installation, quickly, with 3,500 assets', async () => {
    const { version } = await install()
    const started = Date.now()
    expect(await diagnose(version, root, { jvmArch: 'arm64' })).toEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports missing, wrong-size and corrupt files with what is needed to repair them', async () => {
    const { version, objects } = await install()
    const lib = await put('libraries/a/b/1/b-1.jar', 'library b') // same size, different content
    await put('versions/1.0/1.0.jar', 'short')
    const { rm } = await import('node:fs/promises')
    await rm(path.join(root, 'libraries/net/fabricmc/x/2/x-2.jar'))
    await rm(path.join(root, 'assets/log_configs/client-1.12.xml'))
    const first = objects['minecraft/sounds/0.ogg'] as { hash: string; size: number }
    await rm(path.join(root, 'assets/objects', first.hash.slice(0, 2), first.hash))
    const second = objects['minecraft/sounds/1.ogg'] as { hash: string; size: number }
    await put(`assets/objects/${second.hash.slice(0, 2)}/${second.hash}`, 'x')

    const issues = await diagnose(version, root, { jvmArch: 'arm64' })
    expect(issues.map((i) => [i.kind, i.name, i.problem])).toEqual([
      ['client', '1.0', 'size'],
      ['library', 'a:b:1', 'hash'],
      ['library', 'net.fabricmc:x:2', 'missing'],
      ['logConfig', 'client-1.12.xml', 'missing'],
      ['asset', 'minecraft/sounds/0.ogg', 'missing'],
      ['asset', 'minecraft/sounds/1.ogg', 'size'],
    ])
    expect(issues[1]).toMatchObject({ path: lib, expected: { sha1: sha1('library a'), size: 9 }, actual: { sha1: sha1('library b') }, url: 'https://libraries.minecraft.net/a/b/1/b-1.jar' })
    expect(issues[2]?.url).toBe('https://maven.fabricmc.net/net/fabricmc/x/2/x-2.jar')
    expect(issues[4]?.url).toBe(`https://resources.download.minecraft.net/${first.hash.slice(0, 2)}/${first.hash}`)
  })

  it('trusts sizes for files older than the install timestamp, and hashes when asked or when changed', async () => {
    const { version, objects } = await install()
    const obj = objects['minecraft/sounds/7.ogg'] as { hash: string; size: number }
    const asset = await put(`assets/objects/${obj.hash.slice(0, 2)}/${obj.hash}`, 'asset X') // same size as 'asset 7'
    const lib = await put('libraries/a/b/1/b-1.jar', 'library b')
    const old = new Date(Date.now() - 60_000)
    await utimes(asset, old, old)
    await utimes(lib, old, old)
    const trustBefore = Date.now() - 30_000

    // Old files are trusted by size.
    expect(await diagnose(version, root, { jvmArch: 'arm64', trustBefore })).toEqual([])
    // Assets are size-only by default, so a same-size corrupt asset needs `always` (or a newer mtime).
    expect((await diagnose(version, root, { jvmArch: 'arm64' })).map((i) => i.kind)).toEqual(['library'])
    expect((await diagnose(version, root, { jvmArch: 'arm64', hash: 'always' })).map((i) => [i.kind, i.problem])).toEqual([
      ['library', 'hash'],
      ['asset', 'hash'],
    ])
    const now = new Date()
    await utimes(asset, now, now)
    expect((await diagnose(version, root, { jvmArch: 'arm64', trustBefore })).map((i) => i.kind)).toEqual(['asset'])
    expect(await diagnose(version, root, { jvmArch: 'arm64', hash: 'never' })).toEqual([])
  })

  it('reports a missing asset index without listing every object', async () => {
    const { version } = await install()
    const { rm } = await import('node:fs/promises')
    await rm(path.join(root, 'assets/indexes/5.json'))
    expect((await diagnose(version, root, { jvmArch: 'arm64' })).map((i) => [i.kind, i.problem, i.url])).toEqual([['assetIndex', 'missing', 'https://piston-meta.mojang.com/5.json']])
  })

  it('reports unavailable arm64 natives and checks replacement artifacts by sha256', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10')
    const placeholder = await diagnose(v, root, { jvmArch: 'arm64', lwjgl2: DEFAULT_LWJGL2_ARM64_SOURCE, assets: false })
    expect(placeholder[0]).toMatchObject({ kind: 'native', problem: 'unavailable', name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx' })

    const jar = Buffer.from('arm64 natives jar')
    const source = { baseUrl: 'https://x/', artifacts: [{ name: 'lwjgl-platform', version: '2.9.1', url: 'a.jar', sha256: sha256(jar), size: jar.length }] }
    await put('libraries/dev/wynn/amethyst/natives/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-macos-arm64.jar', jar)
    const issues = await diagnose(v, root, { jvmArch: 'arm64', lwjgl2: source, assets: false })
    expect(issues.some((i) => i.problem === 'unavailable')).toBe(false)
    expect(issues.some((i) => i.name.startsWith('dev.wynn.amethyst.natives'))).toBe(false)
    expect(issues.find((i) => i.name === 'org.lwjgl.lwjgl:lwjgl:2.9.1')).toMatchObject({ kind: 'library', problem: 'missing' })

    await put('libraries/dev/wynn/amethyst/natives/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-macos-arm64.jar', 'arm64 natives jaR')
    const bad = await diagnose(v, root, { jvmArch: 'arm64', lwjgl2: source, assets: false })
    expect(bad.find((i) => i.name.startsWith('dev.wynn.amethyst.natives'))).toMatchObject({ kind: 'native', problem: 'hash', expected: { sha256: sha256(jar) } })
  })
})
