/* oxlint-disable no-await-in-loop -- fixtures are written sequentially */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_ASSETS, tempDir } from './__fixtures__/helpers'
import { assetObjectPath, isLegacyAssets, parseAssetIndex, prepareLegacyAssets, readAssetIndex } from './assets'

let root: string
let cleanup: () => Promise<void>
beforeEach(async () => ({ dir: root, cleanup } = await tempDir()))
afterEach(() => cleanup())

const assetsDir = () => path.join(root, 'assets')

/** Install an index fixture and fake objects for all (or some) of its entries. */
async function install(id: string, skip: string[] = []) {
  const text = await readFile(path.join(FIXTURE_ASSETS, `${id}.json`), 'utf8')
  await mkdir(path.join(assetsDir(), 'indexes'), { recursive: true })
  await writeFile(path.join(assetsDir(), 'indexes', `${id}.json`), text)
  const index = parseAssetIndex(text)
  for (const [name, obj] of Object.entries(index.objects)) {
    if (skip.includes(name)) continue
    const p = assetObjectPath(assetsDir(), obj.hash)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, Buffer.alloc(obj.size, 1))
  }
  return index
}

describe('prepareLegacyAssets', () => {
  it('builds assets/virtual/legacy with hard links', async () => {
    await install('legacy')
    const r = await prepareLegacyAssets({ assetsDir: assetsDir(), assets: 'legacy' })
    expect(r.virtualDir).toBe(path.join(assetsDir(), 'virtual', 'legacy'))
    expect(r.resourcesDir).toBeUndefined()
    expect(r).toMatchObject({ linked: 4, existing: 0, missing: [], rejected: [] })
    const linked = await stat(path.join(r.virtualDir as string, 'sounds/random/click.ogg'))
    const object = await stat(assetObjectPath(assetsDir(), '2fe092579d9637e2d160319820ee08e60a237bb7'))
    expect(linked.ino).toBe(object.ino)
    // Idempotent.
    expect(await prepareLegacyAssets({ assetsDir: assetsDir(), assets: 'legacy' })).toMatchObject({ linked: 0, existing: 4 })
  })

  it('honours map_to_resources for pre-1.6 by populating <gameDir>/resources too', async () => {
    await install('pre-1.6', ['music/calm1.ogg'])
    const gameDir = path.join(root, 'instance')
    const r = await prepareLegacyAssets({ assetsDir: assetsDir(), assets: 'pre-1.6', gameDir })
    expect(r.resourcesDir).toBe(path.join(gameDir, 'resources'))
    expect(r.linked).toBe(6)
    expect(r.missing).toEqual(['music/calm1.ogg'])
    expect((await stat(path.join(gameDir, 'resources', 'newsound/step/grass1.ogg'))).size).toBe(7468)
    expect((await stat(path.join(assetsDir(), 'virtual', 'pre-1.6', 'READ_ME_I_AM_VERY_IMPORTANT'))).isFile()).toBe(true)
  })

  it('replaces wrong-sized files and rejects traversal names', async () => {
    const index = await install('legacy')
    const target = path.join(assetsDir(), 'virtual', 'legacy', 'sounds/random/click.ogg')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'short')
    index.objects['../../escape.txt'] = { hash: '2fe092579d9637e2d160319820ee08e60a237bb7', size: 7046 }
    const r = await prepareLegacyAssets({ assetsDir: assetsDir(), assets: 'legacy', index })
    expect(r.rejected).toEqual(['../../escape.txt'])
    expect((await stat(target)).size).toBe(7046)
    await expect(stat(path.join(root, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does nothing for modern indexes', async () => {
    await install('17')
    expect(isLegacyAssets('17', (await readAssetIndex(assetsDir(), { assets: '17' })).index)).toBe(false)
    expect(await prepareLegacyAssets({ assetsDir: assetsDir(), assets: '17' })).toEqual({ linked: 0, existing: 0, missing: [], rejected: [] })
  })

  it('reports a missing or malformed index', async () => {
    await expect(prepareLegacyAssets({ assetsDir: assetsDir(), assets: 'legacy' })).rejects.toMatchObject({ code: 'EASSET_INDEX' })
    expect(() => parseAssetIndex('{"objects":{"a":{"hash":"zz","size":1}}}')).toThrow(/invalid hash/)
  })

  it('falls back to the hash-named index file', async () => {
    const text = await readFile(path.join(FIXTURE_ASSETS, 'legacy.json'), 'utf8')
    const sha1 = '770572e819335b6c0a053f8378ad88eda189fc14'
    await mkdir(path.join(assetsDir(), 'indexes'), { recursive: true })
    await writeFile(path.join(assetsDir(), 'indexes', `${sha1}.json`), text)
    const r = await readAssetIndex(assetsDir(), { assets: 'legacy', assetIndex: { id: 'legacy', sha1 } })
    expect(r.path.endsWith(`${sha1}.json`)).toBe(true)
  })
})
