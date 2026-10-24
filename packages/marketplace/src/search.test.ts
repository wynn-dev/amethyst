import { describe, expect, it } from 'vitest'
import cfSearch from './__fixtures__/curseforge-search.json'
import mrSearch from './__fixtures__/modrinth-search.json'
import { json, jsonParam, mockFetch } from './__fixtures__/mock-fetch'
import { CurseForgeClient } from './curseforge'
import type { MarketProject } from './model'
import { ModrinthClient } from './modrinth'
import {
  combinedTotal,
  mergeSearchResults,
  normaliseTitle,
  searchMarketplace,
  toCurseForgeSearch,
  toModrinthSearch,
} from './search'

function entry(source: 'modrinth' | 'curseforge', id: string, slug: string, title: string): MarketProject {
  return {
    key: `${source}:${id}`,
    source,
    id,
    slug,
    title,
    author: '',
    summary: '',
    iconUrl: null,
    projectType: 'mod',
    downloads: 0,
    followers: 0,
    categories: [],
    loaders: [],
    gameVersions: [],
    createdAt: null,
    updatedAt: null,
    websiteUrl: '',
  }
}

describe('filter translation', () => {
  it('translates a Quilt mod search for both platforms', () => {
    const filters = { projectType: 'mod' as const, query: 'sodium', gameVersion: '1.20.1', loader: 'quilt', pageSize: 100 }
    expect(toModrinthSearch(filters)).toMatchObject({
      projectType: 'mod',
      gameVersions: ['1.20.1'],
      loaders: ['quilt', 'fabric'],
      index: 'relevance',
      limit: 100,
    })
    expect(toCurseForgeSearch(filters, 40)).toMatchObject({
      classId: 6,
      gameVersion: '1.20.1',
      searchFilter: 'sodium',
      sortField: 2,
      sortOrder: 'desc',
      modLoaderType: undefined,
      modLoaderTypes: [5, 4],
      index: 40,
      pageSize: 50,
    })
  })

  it('maps sorts and skips loaders where they do not apply', () => {
    const rp = { projectType: 'resourcepack' as const, loader: 'fabric', sort: 'name' as const }
    expect(toModrinthSearch(rp)?.loaders).toBeUndefined()
    expect(toModrinthSearch(rp)?.index).toBe('relevance')
    expect(toCurseForgeSearch(rp)).toMatchObject({ classId: 12, sortField: 4, sortOrder: 'asc', modLoaderType: undefined })
    expect(toModrinthSearch({ projectType: 'shader', loader: 'iris' })?.loaders).toEqual(['iris'])
    expect(toCurseForgeSearch({ projectType: 'mod', loader: 'forge' }).modLoaderType).toBe(1)
    expect(toCurseForgeSearch({ projectType: 'mod', sort: 'newest' }).sortField).toBe(11)
    expect(toModrinthSearch({ projectType: 'world' })).toBeNull()
  })
})

describe('mergeSearchResults', () => {
  const mr = [entry('modrinth', 'A', 'sodium', 'Sodium'), entry('modrinth', 'B', 'lithium', 'Lithium')]
  const cf = [
    entry('curseforge', '1', 'jei', 'JEI'),
    entry('curseforge', '2', 'Sodium', 'Sodium!'),
    entry('curseforge', '3', 'lithium', 'Lithium (Fabric)'),
  ]

  it('interleaves and merges confident duplicates', () => {
    const out = mergeSearchResults(mr, cf)
    expect(out.map((p) => p.key)).toEqual(['modrinth:A', 'curseforge:1', 'modrinth:B', 'curseforge:3'])
    expect(out[0]?.linked?.key).toBe('curseforge:2')
  })

  it('merges linked pairs and honours the preferred platform', () => {
    const out = mergeSearchResults(mr, cf, { links: [['B', '3']], prefer: 'curseforge' })
    expect(out.map((p) => p.key)).toEqual(['curseforge:2', 'curseforge:1', 'curseforge:3'])
    expect(out[2]?.linked?.key).toBe('modrinth:B')
  })

  it('sorts by title when sorting by name', () => {
    const out = mergeSearchResults(mr, cf, { sort: 'name' })
    expect(out.map((p) => p.title)).toEqual(['JEI', 'Lithium', 'Lithium (Fabric)', 'Sodium'])
  })

  it('normalises titles and caps the CurseForge total', () => {
    expect(normaliseTitle('Café-Mod!')).toBe('cafemod')
    expect(combinedTotal(5, 25_000)).toBe(10_005)
  })
})

describe('searchMarketplace', () => {
  it('queries both platforms, merges, and pages independently', async () => {
    const mr = mockFetch(() => json(mrSearch))
    const cf = mockFetch(() => json(cfSearch))
    const clients = {
      modrinth: new ModrinthClient({ fetch: mr.fetch, limiter: false, retries: 0 }),
      curseforge: new CurseForgeClient({ apiKey: 'k', fetch: cf.fetch, limiter: false, retries: 0 }),
    }
    const filters = { projectType: 'mod' as const, gameVersion: '1.20.1', loader: 'fabric', pageSize: 3 }
    const page = await searchMarketplace(clients, filters)
    // Sodium is on both platforms (same slug and title): shown once.
    expect(page.items.map((p) => p.key)).toEqual([
      'modrinth:AANobbMI',
      'curseforge:238222',
      'modrinth:P7dR8mSH',
      'modrinth:DPack001',
    ])
    expect(page.items[0]?.linked?.key).toBe('curseforge:394468')
    expect(page.total).toBe(5 + 10_000)
    expect(page.cursor).toEqual({
      modrinth: { offset: 3, total: 5, done: false },
      curseforge: { index: 2, total: 10_000, done: false },
    })
    expect(jsonParam(mr.calls[0]!.url, 'facets')).toEqual([['project_type:mod'], ['versions:1.20.1'], ['categories:fabric']])
    expect(cf.calls[0]!.url.searchParams.get('modLoaderType')).toBe('4')

    const next = await searchMarketplace(clients, filters, {
      ...page.cursor,
      modrinth: { ...page.cursor.modrinth, done: true },
    })
    expect(mr.calls).toHaveLength(1)
    expect(cf.calls[1]!.url.searchParams.get('index')).toBe('2')
    expect(next.items.every((p) => p.source === 'curseforge')).toBe(true)
  })

  it('reports a failing platform without hiding the other, and skips CurseForge without a key', async () => {
    const mr = mockFetch(() => ({ status: 500, text: 'boom' }))
    const page = await searchMarketplace(
      {
        modrinth: new ModrinthClient({ fetch: mr.fetch, limiter: false, retries: 0 }),
        curseforge: new CurseForgeClient({}),
      },
      { projectType: 'mod' },
    )
    expect(page.items).toEqual([])
    expect(page.errors.modrinth).toMatchObject({ code: 'EHTTP', status: 500 })
    expect(page.errors.curseforge).toBeUndefined()
    expect(page.cursor.modrinth).toEqual({ offset: 0, total: 0, done: false })
    expect(page.cursor.curseforge.done).toBe(true)
    expect(page.hasMore).toBe(true)
  })

  it('rejects when cancelled', async () => {
    const controller = new AbortController()
    const mr = mockFetch(() => new Promise(() => {}))
    const p = searchMarketplace(
      { modrinth: new ModrinthClient({ fetch: mr.fetch, limiter: false, retries: 0 }) },
      { projectType: 'mod' },
      undefined,
      { signal: controller.signal },
    )
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
