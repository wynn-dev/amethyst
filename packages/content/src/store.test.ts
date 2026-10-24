import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/build'
import { ContentStore, hashFile, hashStream, isPathInside, pathKey, samePath, sanitizeFileName, type StoreFs } from './index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

const digest = (algo: string, data: Uint8Array) => createHash(algo).update(data).digest('hex')

describe('hashing', () => {
  it('computes several digests in one streaming pass', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 0xab)
    const file = path.join(tmp, 'big.bin')
    await fsp.writeFile(file, data)
    let progressCalls = 0
    const result = await hashFile(file, ['sha1', 'sha512', 'md5'], { onProgress: () => progressCalls++ })
    expect(result).toEqual({ size: data.length, sha1: digest('sha1', data), sha512: digest('sha512', data), md5: digest('md5', data) })
    expect(progressCalls).toBeGreaterThan(1)
    expect(Object.keys(await hashFile(file))).toEqual(['size', 'sha1'])
  })

  it('hashes streams and honours abort', async () => {
    expect(await hashStream(Readable.from([Buffer.from('ab'), Buffer.from('c')]), ['sha256'])).toEqual({ size: 3, sha256: digest('sha256', Buffer.from('abc')) })
    const controller = new AbortController()
    controller.abort()
    await expect(hashFile(path.join(tmp, 'x'), ['sha1'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(hashFile(path.join(tmp, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('macOS path semantics', () => {
  it('compares case- and normalisation-insensitively', () => {
    const nfd = 'Café/Mods.jar'
    const nfc = 'café/mods.jar'
    expect(pathKey(nfd)).toBe(pathKey(nfc))
    expect(samePath(`/x/${nfd}`, `/x/${nfc}`)).toBe(true)
    expect(isPathInside('/Users/A/Instances', '/users/a/instances/One/mods')).toBe(true)
    expect(isPathInside('/a/b', '/a/bc')).toBe(false)
  })

  it('sanitises untrusted file names', () => {
    expect(sanitizeFileName('../../x.jar')).toBe('_.._x.jar')
    expect(sanitizeFileName('.hidden:name\u0000')).toBe('hidden_name_')
    expect(sanitizeFileName('...')).toBe('unnamed')
    const long = sanitizeFileName(`${'é'.repeat(200)}.jar`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long.endsWith('.jar')).toBe(true)
  })
})

describe('ContentStore', () => {
  const content = Buffer.from('mod jar bytes')
  const sha1 = digest('sha1', content)

  it('ingests files and streams into store/sha1/ab/<sha1>', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    const src = path.join(tmp, 'a.jar')
    await fsp.writeFile(src, content)
    const first = await store.ingest(src, { algorithms: ['sha512'] })
    expect(first).toEqual({ sha1, sha512: digest('sha512', content), size: content.length, existed: false })
    const blob = store.pathOf(sha1)
    expect(blob).toBe(path.join(tmp, 'store', 'sha1', sha1.slice(0, 2), sha1))
    expect(((await fsp.stat(blob)).mode & 0o777).toString(8)).toBe('444')
    expect(await store.ingest(Readable.from([content]))).toMatchObject({ sha1, existed: true })
    expect(await store.has(sha1)).toBe(true)
    expect(await store.has(sha1, 1)).toBe(false)
    expect(await fsp.readdir(path.join(tmp, 'store', 'tmp'))).toEqual([])
  })

  it('verifies the expected hash and size', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    await expect(store.ingest(Readable.from([content]), { expectedSha1: '0'.repeat(40) })).rejects.toMatchObject({ code: 'ECHECKSUM' })
    await expect(store.ingest(Readable.from([content]), { expectedSize: 1 })).rejects.toMatchObject({ code: 'ECHECKSUM' })
    await expect(store.ingest(Readable.from([content]), { expectedSha1: 'nope' })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    expect(await store.has(sha1)).toBe(false)
    expect(await fsp.readdir(path.join(tmp, 'store', 'tmp'))).toEqual([])
  })

  it('places with clone, then falls back to a hard link, then to a copy', async () => {
    const calls: string[] = []
    const failingClone: Partial<StoreFs> = {
      clone: async () => {
        calls.push('clone')
        throw Object.assign(new Error('clone not supported'), { code: 'ENOTSUP' })
      },
      copyFile: async (src, dest) => {
        calls.push('copy')
        await fsp.copyFile(src, dest)
      },
    }
    const linkStore = new ContentStore(path.join(tmp, 'store'), { fs: failingClone })
    await linkStore.ingest(Readable.from([content]))
    const linked = await linkStore.place(sha1, path.join(tmp, 'inst1', 'mods', 'a.jar'))
    expect(linked.method).toBe('hardlink')
    expect(calls).toEqual(['clone'])
    expect((await fsp.stat(linked.path)).ino).toBe((await fsp.stat(linkStore.pathOf(sha1))).ino)

    calls.length = 0
    const copyStore = new ContentStore(path.join(tmp, 'store'), {
      fs: {
        ...failingClone,
        link: async () => {
          calls.push('link')
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
        },
      },
    })
    const copied = await copyStore.place(sha1, path.join(tmp, 'inst2', 'mods', 'a.jar'))
    expect(copied.method).toBe('copy')
    expect(calls).toEqual(['clone', 'link', 'copy'])
    expect(await fsp.readFile(copied.path)).toEqual(content)
    expect(((await fsp.stat(copied.path)).mode & 0o777).toString(8)).toBe('644')

    calls.length = 0
    const noLinks = new ContentStore(path.join(tmp, 'store'), { fs: failingClone, hardLinks: false })
    expect((await noLinks.place(sha1, path.join(tmp, 'inst3', 'a.jar'))).method).toBe('copy')
    expect(calls).toEqual(['clone', 'copy'])
    // No temporary files are left next to the placements.
    expect(await fsp.readdir(path.join(tmp, 'inst2', 'mods'))).toEqual(['a.jar'])
  })

  it('places a readable file with whatever method the volume supports', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    await store.ingest(Readable.from([content]))
    const placed = await store.place(sha1, path.join(tmp, 'mods', 'a.jar'))
    expect(['clone', 'hardlink', 'copy']).toContain(placed.method)
    expect(await fsp.readFile(placed.path)).toEqual(content)
  })

  // macOS temp folders are on APFS, where cloning must work.
  it.runIf(process.platform === 'darwin')('makes real APFS clones on macOS, independent of the blob', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    await store.ingest(Readable.from([content]))
    const placed = await store.place(sha1, path.join(tmp, 'mods', 'a.jar'))
    expect(placed.method).toBe('clone')
    expect((await fsp.stat(placed.path)).ino).not.toBe((await fsp.stat(store.pathOf(sha1))).ino)
    await fsp.writeFile(placed.path, 'changed')
    expect(await fsp.readFile(store.pathOf(sha1))).toEqual(content)
  })

  it('refuses to overwrite unless asked, and reports missing blobs', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    await store.ingest(Readable.from([content]))
    const dest = path.join(tmp, 'mods', 'a.jar')
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, 'other')
    await expect(store.place(sha1, dest)).rejects.toMatchObject({ code: 'EEXIST' })
    await store.place(sha1, dest, { overwrite: true })
    expect(await fsp.readFile(dest)).toEqual(content)
    await expect(store.place('f'.repeat(40), path.join(tmp, 'x.jar'))).rejects.toMatchObject({ code: 'ENOT_FOUND' })
  })

  it('garbage-collects unreferenced blobs', async () => {
    const store = new ContentStore(path.join(tmp, 'store'))
    const a = await store.ingest(Readable.from([Buffer.from('a')]))
    const b = await store.ingest(Readable.from([Buffer.from('b')]))
    expect((await store.gc([a.sha1.toUpperCase()], { dryRun: true })).removed).toEqual([b.sha1])
    expect(await store.has(b.sha1)).toBe(true)
    expect((await store.gc([b.sha1], { minAgeMs: 60_000 })).removed).toEqual([])
    const result = await store.gc([a.sha1])
    expect(result).toEqual({ removed: [b.sha1], freedBytes: 1 })
    expect(await store.has(a.sha1)).toBe(true)
    expect(await store.has(b.sha1)).toBe(false)
  })
})
