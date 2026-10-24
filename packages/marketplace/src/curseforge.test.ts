import { describe, expect, it } from 'vitest'
import files from './__fixtures__/curseforge-files.json'
import search from './__fixtures__/curseforge-search.json'
import { json, mockFetch } from './__fixtures__/mock-fetch'
import {
  buildCurseForgeSearchQuery,
  clampCurseForgePage,
  classifyCurseForgeGameVersions,
  CurseForgeClient,
  CurseForgeModLoaderType,
  CurseForgeSortField,
  pickLatestCurseForgeFile,
  type CurseForgeFile,
} from './curseforge'

const fileList = files.data as unknown as CurseForgeFile[]

function client(handler: Parameters<typeof mockFetch>[0], ...key: [apiKey?: string]) {
  const apiKey = key.length ? key[0] : 'test-key'
  const mock = mockFetch(handler)
  const c = new CurseForgeClient({ apiKey, version: '1.2.3', fetch: mock.fetch, limiter: false, retries: 0 })
  return { c, calls: mock.calls }
}

describe('CurseForge without an API key', () => {
  it.each([undefined, '', '   '])('is unavailable and never calls fetch (key %j)', async (key) => {
    const { c, calls } = client(() => json({ data: [] }), key)
    expect(c.isAvailable()).toBe(false)
    await expect(c.searchMods({ searchFilter: 'jei' })).rejects.toMatchObject({
      name: 'MarketplaceError',
      code: 'ECF_NO_KEY',
      platform: 'curseforge',
    })
    await expect(c.getMod(1)).rejects.toMatchObject({ code: 'ECF_NO_KEY' })
    await expect(c.matchFingerprints([1])).rejects.toMatchObject({ code: 'ECF_NO_KEY' })
    expect(calls).toHaveLength(0)
  })

  it('disables itself for the session after a 403', async () => {
    const { c, calls } = client(() => ({ status: 403, text: 'Forbidden' }))
    expect(c.isAvailable()).toBe(true)
    await expect(c.getMod(1)).rejects.toMatchObject({ code: 'ECF_FORBIDDEN', status: 403 })
    expect(c.isAvailable()).toBe(false)
    await expect(c.getMod(2)).rejects.toMatchObject({ code: 'ECF_FORBIDDEN' })
    expect(calls).toHaveLength(1)
  })
})

describe('CurseForge search encoding', () => {
  it('sends only parameters with values and defaults sortOrder to desc', () => {
    expect(
      buildCurseForgeSearchQuery({
        classId: 6,
        gameVersion: '1.20.1',
        searchFilter: ' jei ',
        sortField: CurseForgeSortField.TotalDownloads,
        modLoaderType: CurseForgeModLoaderType.Forge,
      }),
    ).toEqual({
      gameId: 432,
      classId: 6,
      categoryId: undefined,
      categoryIds: undefined,
      gameVersion: '1.20.1',
      gameVersions: undefined,
      searchFilter: 'jei',
      sortField: 6,
      sortOrder: 'desc',
      modLoaderType: 1,
      modLoaderTypes: undefined,
      gameVersionTypeId: undefined,
      authorId: undefined,
      primaryAuthorId: undefined,
      slug: undefined,
      index: 0,
      pageSize: 20,
    })
  })

  it('encodes list parameters and lets them override the single forms', () => {
    const q = buildCurseForgeSearchQuery({
      categoryId: 5,
      categoryIds: Array.from({ length: 12 }, (_, i) => i + 1),
      gameVersion: '1.19',
      gameVersions: ['1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5'],
      modLoaderType: CurseForgeModLoaderType.Forge,
      modLoaderTypes: [CurseForgeModLoaderType.Quilt, CurseForgeModLoaderType.Fabric, CurseForgeModLoaderType.NeoForge],
    })!
    expect(q.categoryId).toBeUndefined()
    expect(JSON.parse(q.categoryIds as string)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(q.gameVersion).toBeUndefined()
    expect(JSON.parse(q.gameVersions as string)).toEqual(['1.20.1', '1.20.2', '1.20.3', '1.20.4'])
    expect(q.modLoaderType).toBeUndefined()
    expect(q.modLoaderTypes).toBe('[Quilt,Fabric,NeoForge]')
    // A single entry in modLoaderTypes collapses to modLoaderType.
    const single = buildCurseForgeSearchQuery({ modLoaderTypes: [CurseForgeModLoaderType.NeoForge] })!
    expect(single.modLoaderType).toBe(6)
    expect(single.modLoaderTypes).toBeUndefined()
  })

  it('respects the 50 page size and the 10 000 result window', () => {
    expect(clampCurseForgePage(0, 100)).toEqual({ index: 0, pageSize: 50 })
    expect(clampCurseForgePage(9980, 50)).toEqual({ index: 9980, pageSize: 20 })
    expect(clampCurseForgePage(10_000, 50)).toBeNull()
    expect(buildCurseForgeSearchQuery({ index: 12_000 })).toBeNull()
  })

  it('calls /v1/mods/search with the key and stops past the window', async () => {
    const { c, calls } = client(() => json(search))
    const page = await c.searchMods({ classId: 6, searchFilter: 'sodium', pageSize: 50, index: 9990 })
    expect(page.data).toHaveLength(2)
    expect(page.pagination.totalCount).toBe(25000)
    const call = calls[0]!
    expect(call.url.origin + call.url.pathname).toBe('https://api.curseforge.com/v1/mods/search')
    expect(call.headers['x-api-key']).toBe('test-key')
    expect(call.headers.accept).toBe('application/json')
    expect(call.headers['user-agent']).toBe('wynn-dev/amethyst/1.2.3')
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      gameId: '432',
      classId: '6',
      searchFilter: 'sodium',
      index: '9990',
      pageSize: '10',
    })
    const past = await c.searchMods({ index: 10_000 })
    expect(past.data).toEqual([])
    expect(calls).toHaveLength(1)
  })
})

describe('CurseForgeClient endpoints', () => {
  it('lists mod files with only the given filters', async () => {
    const { c, calls } = client(() => json(files))
    await c.getModFiles(238222)
    await c.getModFiles(238222, { gameVersion: '1.20.1', modLoaderType: CurseForgeModLoaderType.Any, index: 50 })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ pageSize: '50' })
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({
      gameVersion: '1.20.1',
      modLoaderType: '0',
      index: '50',
      pageSize: '50',
    })
  })

  it('batches mods and files with POST bodies', async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === '/v1/mods' ? json({ data: search.data }) : json({ data: files.data }),
    )
    expect(await c.getMods([238222, 394468, 238222, -1, Number.NaN])).toHaveLength(2)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ modIds: [238222, 394468], filterPcOnly: true })
    expect(await c.getFiles([4000012, 4712345])).toHaveLength(3)
    expect(calls[1]!.url.pathname).toBe('/v1/mods/files')
    expect(calls[1]!.body).toEqual({ fileIds: [4000012, 4712345] })
    expect(await c.getMods([])).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('reads single objects, HTML strings, categories and Minecraft metadata', async () => {
    const { c, calls } = client((call) => {
      const p = call.url.pathname
      if (p === '/v1/mods/238222') return json({ data: search.data[1] })
      if (p === '/v1/mods/238222/description') return json({ data: '<p>JEI</p>' })
      if (p === '/v1/mods/238222/files/4712345') return json({ data: files.data[1] })
      if (p === '/v1/mods/238222/files/4712345/changelog') return json({ data: '<ul></ul>' })
      if (p === '/v1/categories') return json({ data: [{ id: 6, gameId: 432, name: 'Mods', slug: 'mc-mods', isClass: true }] })
      if (p === '/v1/minecraft/version') return json({ data: [{ id: 1, versionString: '1.20.1' }] })
      if (p === '/v1/minecraft/modloader') return json({ data: [{ name: 'forge-47.2.0', gameVersion: '1.20.1' }] })
      return { status: 404, text: '' }
    })
    expect((await c.getMod(238222)).slug).toBe('jei')
    expect(await c.getModDescription(238222)).toBe('<p>JEI</p>')
    expect((await c.getFile(238222, 4712345)).id).toBe(4712345)
    expect(await c.getFileChangelog(238222, 4712345)).toBe('<ul></ul>')
    expect((await c.getCategories({ classesOnly: true }))[0]?.slug).toBe('mc-mods')
    expect(Object.fromEntries(calls[4]!.url.searchParams)).toEqual({ gameId: '432', classesOnly: 'true' })
    expect((await c.getMinecraftVersions())[0]?.versionString).toBe('1.20.1')
    expect((await c.getModLoaders({ version: '1.20.1' }))[0]?.name).toBe('forge-47.2.0')
    expect(calls[6]!.url.searchParams.get('version')).toBe('1.20.1')
  })

  it('returns null download URLs for restricted files without disabling the client', async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith('/4000012/download-url') ? { status: 403, text: '' } : json({ data: '' }),
    )
    await expect(c.getFileDownloadUrl(238222, 4000012)).resolves.toBeNull()
    await expect(c.getFileDownloadUrl(238222, 1)).resolves.toBeNull()
    expect(c.isAvailable()).toBe(true)
  })

  it('matches fingerprints: drops invalid values, de-duplicates, skips empty requests', async () => {
    const normal = files.data[1]
    const { c, calls } = client(() =>
      json({
        data: {
          isCacheBuilt: true,
          exactMatches: [{ id: 238222, file: normal, latestFiles: [normal] }],
          exactFingerprints: [123456789],
          partialMatches: [],
          partialMatchFingerprints: {},
          installedFingerprints: [],
          unmatchedFingerprints: [42],
        },
      }),
    )
    const empty = await c.matchFingerprints([0, -5, Number.NaN, 1.5, 2 ** 32])
    expect(empty.exactMatches).toEqual([])
    expect(calls).toHaveLength(0)

    const res = await c.matchFingerprints([123456789, 42, 123456789, 0, 0xffffffff])
    expect(calls[0]!.url.pathname).toBe('/v1/fingerprints/432')
    expect(calls[0]!.body).toEqual({ fingerprints: [123456789, 42, 0xffffffff] })
    expect(res.exactMatches[0]?.file.fileFingerprint).toBe(123456789)
    expect(res.unmatchedFingerprints).toEqual([42])
    expect(res.isCacheBuilt).toBe(true)
  })

  it('reports a cold fingerprint cache', async () => {
    const { c } = client(() => json({ data: { isCacheBuilt: false, exactMatches: [] } }))
    expect((await c.matchFingerprints([7])).isCacheBuilt).toBe(false)
  })
})

describe('CurseForge file helpers', () => {
  it('picks the newest installable file by date, not server order', () => {
    expect(pickLatestCurseForgeFile(fileList)?.id).toBe(4712345)
    expect(pickLatestCurseForgeFile(fileList, { releaseOnly: true })?.id).toBe(4000012)
    expect(pickLatestCurseForgeFile([])).toBeUndefined()
  })

  it('classifies the mixed gameVersions list', () => {
    expect(classifyCurseForgeGameVersions(fileList[0]!)).toEqual({
      minecraft: ['1.20.1'],
      loaders: ['forge', 'neoforge'],
      environments: ['client', 'server'],
      java: ['Java 17'],
      other: [],
    })
    expect(classifyCurseForgeGameVersions({ gameVersions: ['Java 8', '1.12.2', 'Quilt', '1.21-Snapshot'] })).toMatchObject({
      minecraft: ['1.12.2', '1.21-Snapshot'],
      loaders: ['quilt'],
      java: ['Java 8'],
    })
  })
})
