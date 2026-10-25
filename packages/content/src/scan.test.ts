import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeZip, tempDir } from './__fixtures__/build'
import {
  createMemoryScanCache,
  createScanWorkerClient,
  createScanWorkerHandlers,
  isContentFileName,
  PARSER_VERSION,
  readModMetadata,
  scanCacheKey,
  scanContentFolder,
  serveScanWorker,
  setEnabled,
  type ScanReaders,
} from './index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const fabricJar = (dir: string, name: string, id: string, version = '1.0') =>
  makeZip(path.join(dir, name), { 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, version, name: id.toUpperCase() }) })

/** Readers that count calls while delegating to the real implementations. */
function countingReaders() {
  const counts = { mod: 0, hash: 0 }
  const readers: Partial<ScanReaders> = {
    mod: async (file, options) => {
      counts.mod++
      return readModMetadata(file, options)
    },
    hash: async (file, algorithms, options) => {
      counts.hash++
      const { hashFile } = await import('./hash')
      return hashFile(file, algorithms, options)
    },
  }
  return { counts, readers }
}

describe('isContentFileName', () => {
  it('applies the ignore and extension rules', () => {
    expect(isContentFileName('a.jar', 'mods', false)).toBe(true)
    expect(isContentFileName('a.jar.disabled', 'mods', false)).toBe(true)
    expect(isContentFileName('old.litemod', 'mods', false)).toBe(true)
    for (const n of ['a.jar.part', 'notes.txt', 'config.toml', '.hidden.jar', '.DS_Store', 'x.json', '.jar', 'a.jar.tmp']) {
      expect(isContentFileName(n, 'mods', false)).toBe(false)
    }
    expect(isContentFileName('folder', 'mods', true)).toBe(false)
    expect(isContentFileName('Folder Pack', 'resourcepacks', true)).toBe(true)
    expect(isContentFileName('pack.zip.disabled', 'resourcepacks', false)).toBe(false)
  })
})

describe('scanContentFolder', () => {
  it('only hashes and parses files that changed (300 mods)', async () => {
    const mods = path.join(tmp, 'mods')
    await mkdir(mods)
    await Promise.all(Array.from({ length: 300 }, (_, i) => fabricJar(mods, `mod-${String(i).padStart(3, '0')}.jar`, `mod${i}`)))
    await writeFile(path.join(mods, 'readme.txt'), 'ignored')
    await writeFile(path.join(mods, 'download.jar.part'), 'ignored')
    const cache = createMemoryScanCache()
    const { counts, readers } = countingReaders()

    const cold = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(cold.stats).toEqual({ total: 300, cached: 0, parsed: 300, hashed: 300, failed: 0 })
    expect(counts).toEqual({ mod: 300, hash: 300 })
    expect(cold.entries[0]).toMatchObject({ fileName: 'mod-000.jar', enabled: true, cached: false, mod: { id: 'mod0', name: 'MOD0' } })
    expect(cold.entries[0]?.hashes?.sha1).toMatch(/^[0-9a-f]{40}$/)

    const warm = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(warm.stats).toMatchObject({ total: 300, cached: 300, parsed: 0, hashed: 0 })
    expect(counts).toEqual({ mod: 300, hash: 300 })
    expect(warm.entries.map((e) => e.mod?.id)).toEqual(cold.entries.map((e) => e.mod?.id))

    // Replace one file and disable another: only the replaced file is re-read.
    await fabricJar(mods, 'mod-010.jar', 'mod10', '2.0-with-a-longer-version')
    await setEnabled(path.join(mods, 'mod-020.jar'), false)
    const after = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(after.stats).toMatchObject({ total: 300, parsed: 1, hashed: 1, cached: 299 })
    expect(counts).toEqual({ mod: 301, hash: 301 })
    expect(after.entries.find((e) => e.fileName === 'mod-010.jar')?.mod?.version).toBe('2.0-with-a-longer-version')
    expect(after.entries.find((e) => e.baseName === 'mod-020.jar')).toMatchObject({ fileName: 'mod-020.jar.disabled', enabled: false, cached: true })
  })

  it('hashes with several digests and only re-hashes when a new digest is requested', async () => {
    const mods = path.join(tmp, 'mods')
    const file = await fabricJar(mods, 'a.jar', 'a')
    const cache = createMemoryScanCache()
    const { counts, readers } = countingReaders()
    await scanContentFolder(mods, 'mods', { cache, readers })
    const both = await scanContentFolder(mods, 'mods', { cache, readers, hashes: ['sha1', 'sha512'] })
    expect(counts).toEqual({ mod: 1, hash: 2 })
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(file)
    expect(both.entries[0]?.hashes).toEqual({
      sha1: createHash('sha1').update(bytes).digest('hex'),
      sha512: createHash('sha512').update(bytes).digest('hex'),
    })
  })

  it('records and caches problems for broken files', async () => {
    const mods = path.join(tmp, 'mods')
    await mkdir(mods)
    await writeFile(path.join(mods, 'broken.jar'), 'not a zip at all')
    const cache = createMemoryScanCache()
    const { counts, readers } = countingReaders()
    const first = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(first.entries[0]).toMatchObject({ fileName: 'broken.jar', problem: { code: 'invalid-zip' } })
    expect(first.stats.failed).toBe(1)
    const second = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(second.entries[0]).toMatchObject({ problem: { code: 'invalid-zip' }, cached: true })
    expect(counts.mod).toBe(1)
  })

  it('finds cached records of NFD-named files under NFC / other-case keys (APFS semantics)', async () => {
    const mods = path.join(tmp, 'mods')
    await mkdir(mods)
    await fabricJar(mods, 'Cafe\u0301Mod.jar', 'cafe')
    expect((await readdir(mods))[0]).toBe('Cafe\u0301Mod.jar')
    const { counts, readers } = countingReaders()
    const first = await scanContentFolder(mods, 'mods', { cache: createMemoryScanCache(), readers })
    const entry = first.entries[0]
    // The index stores records under keys built from NFC (e.g. a marketplace file name) in any case.
    const key = scanCacheKey(path.join(tmp, 'MODS', 'CAF\u00c9MOD.JAR'))
    expect(key).toBe(scanCacheKey(entry?.path ?? ''))
    const { hashes, mod, size, mtimeMs, ino } = entry as NonNullable<typeof entry>
    const cache = createMemoryScanCache([[key, { size, mtimeMs, ino, parserVersion: PARSER_VERSION, ...(hashes ? { hashes } : {}), ...(mod ? { mod } : {}) }]])
    const second = await scanContentFolder(mods, 'mods', { cache, readers })
    expect(second.entries[0]).toMatchObject({ cached: true, fileName: 'Cafe\u0301Mod.jar', mod: { id: 'cafe' } })
    expect(counts).toEqual({ mod: 1, hash: 1 })
  })

  it('does not serve cached parse errors from an older parser version', async () => {
    const mods = path.join(tmp, 'mods')
    await mkdir(mods)
    const file = await fabricJar(mods, 'fixed.jar', 'fixed')
    const { size, mtimeMs, ino } = await (await import('node:fs/promises')).stat(file)
    const stale = { size, mtimeMs, ino, parserVersion: PARSER_VERSION - 1, problem: { code: 'invalid-zip' as const, message: 'old zip reader' } }
    const { counts, readers } = countingReaders()
    const result = await scanContentFolder(mods, 'mods', { cache: createMemoryScanCache([[scanCacheKey(file), stale]]), readers })
    expect(result.entries[0]).toMatchObject({ cached: false, mod: { id: 'fixed' } })
    expect(result.entries[0]?.problem).toBeUndefined()
    expect(counts.mod).toBe(1)
  })

  it('re-derives the preferred loader for cached multi-loader mods', async () => {
    const mods = path.join(tmp, 'mods')
    await makeZip(path.join(mods, 'multi.jar'), {
      'fabric.mod.json': '{"id":"multi","name":"Fabric name"}',
      'META-INF/mods.toml': '[[mods]]\nmodId="multi"\ndisplayName="Forge name"\n',
    })
    const cache = createMemoryScanCache()
    expect((await scanContentFolder(mods, 'mods', { cache, preferLoader: 'forge' })).entries[0]?.mod?.name).toBe('Forge name')
    const warm = await scanContentFolder(mods, 'mods', { cache, preferLoader: 'fabric' })
    expect(warm.entries[0]).toMatchObject({ cached: true, mod: { name: 'Fabric name', primaryLoader: 'fabric' } })
  })

  it('scans resource and shader packs, zips and folders, without hashing folders', async () => {
    const rp = path.join(tmp, 'resourcepacks')
    await makeZip(path.join(rp, 'A.zip'), { 'pack.mcmeta': '{"pack":{"pack_format":34,"description":{"text":"Zip","color":"red"}}}' })
    await mkdir(path.join(rp, 'Folder'), { recursive: true })
    await writeFile(path.join(rp, 'Folder', 'pack.mcmeta'), '{"pack":{"pack_format":34,"description":"Folder"}}')
    const scan = await scanContentFolder(rp, 'resourcepacks', {})
    expect(scan.entries.map((e) => [e.fileName, e.isDirectory, e.hashes !== undefined, e.resourcePack?.description, e.packId, e.enabled])).toEqual([
      ['A.zip', false, true, '§cZip', 'file/A.zip', undefined],
      ['Folder', true, false, 'Folder', 'file/Folder', undefined],
    ])

    const sp = path.join(tmp, 'shaderpacks')
    await makeZip(path.join(sp, 'BSL.zip'), { 'shaders/final.fsh': '' })
    await makeZip(path.join(sp, 'Other.zip'), { 'shaders/final.fsh': '' })
    const shaders = await scanContentFolder(sp, 'shaderpacks', { activeShaderPack: 'BSL.zip' })
    expect(shaders.entries.map((e) => [e.fileName, e.enabled, e.shaderPack?.valid])).toEqual([
      ['BSL.zip', true, true],
      ['Other.zip', false, true],
    ])
  })

  it('returns an empty list for a missing folder and honours abort', async () => {
    expect((await scanContentFolder(path.join(tmp, 'nope'), 'mods')).entries).toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(scanContentFolder(tmp, 'mods', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('setEnabled', () => {
  it('toggles the .disabled suffix and never overwrites', async () => {
    const mods = path.join(tmp, 'mods')
    const file = await fabricJar(mods, 'a.jar', 'a')
    const disabled = await setEnabled(file, false)
    expect(disabled).toBe(path.join(mods, 'a.jar.disabled'))
    expect(await setEnabled(disabled, false)).toBe(disabled) // no double .disabled
    expect(await setEnabled(disabled, true)).toBe(file)
    expect(await setEnabled(file, true)).toBe(file)

    await setEnabled(file, false)
    await fabricJar(mods, 'a.jar', 'a-new')
    await expect(setEnabled(path.join(mods, 'a.jar.disabled'), true)).rejects.toMatchObject({ code: 'EEXIST' })
    const renamed = await setEnabled(path.join(mods, 'a.jar.disabled'), true, { onConflict: 'rename' })
    expect(path.basename(renamed)).toBe('a (2).jar')
    expect((await readdir(mods)).toSorted()).toEqual(['a (2).jar', 'a.jar'])
    await expect(setEnabled(path.join(mods, 'missing.jar'), false)).rejects.toMatchObject({ code: 'ENOT_FOUND' })
  })

  it('strips exactly one suffix from doubly disabled files', async () => {
    const mods = path.join(tmp, 'mods')
    await mkdir(mods)
    const file = path.join(mods, 'b.jar.disabled.disabled')
    await writeFile(file, 'x')
    expect(path.basename(await setEnabled(file, true))).toBe('b.jar.disabled')
  })
})

describe('scan worker', () => {
  it('handlers keep their own cache between scans', async () => {
    const mods = path.join(tmp, 'mods')
    await fabricJar(mods, 'a.jar', 'a')
    const handlers = createScanWorkerHandlers()
    expect((await handlers.scan({ dir: mods, kind: 'mods' })).stats.parsed).toBe(1)
    expect((await handlers.scan({ dir: mods, kind: 'mods' })).stats.cached).toBe(1)
    const { records } = await handlers.exportCache()
    expect(records).toHaveLength(1)
    const fresh = createScanWorkerHandlers()
    await fresh.importCache({ records })
    expect((await fresh.scan({ dir: mods, kind: 'mods' })).stats.cached).toBe(1)
    // Separate handler sets do not share state.
    expect((await createScanWorkerHandlers().scan({ dir: mods, kind: 'mods' })).stats.parsed).toBe(1)
  })

  it('serves requests over a MessagePort with structured-cloned results and errors', async () => {
    const mods = path.join(tmp, 'mods')
    await fabricJar(mods, 'a.jar', 'a')
    const { port1, port2 } = new MessageChannel()
    const stop = serveScanWorker(port2)
    const client = createScanWorkerClient(port1)
    try {
      const result = await client.call('scan', { dir: mods, kind: 'mods', options: { hashes: ['sha1'] } })
      expect(result.entries[0]).toMatchObject({ fileName: 'a.jar', mod: { id: 'a' } })
      const hashed = await client.call('hashFile', { path: path.join(mods, 'a.jar'), algorithms: ['sha1', 'sha512'] })
      expect(Object.keys(hashed).toSorted()).toEqual(['sha1', 'sha512', 'size'])
      await expect(client.call('readMod', { path: path.join(tmp, 'missing.jar') })).rejects.toMatchObject({ name: 'ContentError', code: 'ENOT_FOUND' })
      const controller = new AbortController()
      controller.abort()
      await expect(client.call('scan', { dir: mods, kind: 'mods' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      client.dispose()
      stop()
      port1.close()
      port2.close()
    }
  })
})
