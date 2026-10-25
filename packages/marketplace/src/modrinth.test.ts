import { describe, expect, it } from 'vitest'
import project from './__fixtures__/modrinth-project.json'
import search from './__fixtures__/modrinth-search.json'
import versions from './__fixtures__/modrinth-versions.json'
import { json, jsonParam, mockFetch } from './__fixtures__/mock-fetch'
import { isMarketplaceError } from './errors'
import {
  buildModrinthFacets,
  buildModrinthSearchQuery,
  ModrinthClient,
  pickModrinthFile,
  type ModrinthVersion,
} from './modrinth'

const sha1 = (n: number) => n.toString(16).padStart(40, '0')

function client(handler: Parameters<typeof mockFetch>[0]) {
  const mock = mockFetch(handler)
  const c = new ModrinthClient({ version: '1.2.3', fetch: mock.fetch, limiter: false, retries: 0 })
  return { c, calls: mock.calls }
}

describe('Modrinth search encoding', () => {
  it('builds AND-of-OR facet groups', () => {
    expect(
      buildModrinthFacets({
        projectType: 'mod',
        gameVersions: ['1.20.1'],
        loaders: ['quilt', 'fabric'],
        categories: ['technology', 'storage'],
        license: 'MIT',
        facets: [['downloads>1000'], []],
      }),
    ).toEqual([
      ['project_type:mod'],
      ['versions:1.20.1'],
      ['categories:quilt', 'categories:fabric'],
      ['categories:technology', 'categories:storage'],
      ['license:MIT'],
      ['downloads>1000'],
    ])
  })

  it('maps datapacks and environments, and rejects worlds', () => {
    expect(buildModrinthFacets({ projectType: 'datapack', environment: 'client' })).toEqual([
      ['project_type:mod'],
      ['categories:datapack'],
      ['client_side:required', 'client_side:optional'],
      ['server_side:optional', 'server_side:unsupported'],
    ])
    expect(buildModrinthFacets({ environment: 'server' })).toEqual([
      ['server_side:required', 'server_side:optional'],
      ['client_side:optional', 'client_side:unsupported'],
    ])
    expect(() => buildModrinthFacets({ projectType: 'world' })).toThrow(/no world/)
  })

  it('defaults the index by query and clamps limit and offset', () => {
    expect(buildModrinthSearchQuery({ query: '  ' })).toEqual({
      query: undefined,
      facets: undefined,
      index: 'downloads',
      offset: 0,
      limit: 20,
    })
    expect(buildModrinthSearchQuery({ query: 'sodium', limit: 500, offset: -3 })).toMatchObject({
      query: 'sodium',
      index: 'relevance',
      limit: 100,
      offset: 0,
    })
    expect(buildModrinthSearchQuery({ query: 'x', index: 'newest' }).index).toBe('newest')
  })

  it('sends JSON-encoded facets and the User-Agent', async () => {
    const { c, calls } = client(() => json(search))
    const res = await c.search({ query: 'sodium', projectType: 'shader', loaders: ['iris'], offset: 20, limit: 50 })
    expect(res.hits).toHaveLength(3)
    const call = calls[0]!
    expect(call.url.origin + call.url.pathname).toBe('https://api.modrinth.com/v2/search')
    expect(call.url.searchParams.get('query')).toBe('sodium')
    expect(call.url.searchParams.get('index')).toBe('relevance')
    expect(call.url.searchParams.get('offset')).toBe('20')
    expect(call.url.searchParams.get('limit')).toBe('50')
    expect(call.url.search).toContain('facets=%5B%5B%22project_type%3Ashader%22%5D')
    expect(jsonParam(call.url, 'facets')).toEqual([['project_type:shader'], ['categories:iris']])
    expect(call.url.searchParams.has('filter')).toBe(false)
    expect(call.headers['user-agent']).toBe('wynn-dev/amethyst/1.2.3')
    expect(c.userAgent).toBe('wynn-dev/amethyst/1.2.3')
  })
})

describe('ModrinthClient endpoints', () => {
  it('gets a project by slug', async () => {
    const { c, calls } = client(() => json(project))
    const p = await c.getProject('sodium')
    expect(p.id).toBe('AANobbMI')
    expect(calls[0]!.url.pathname).toBe('/v2/project/sodium')
  })

  it('rejects project ids that are not an id or slug before building a URL', async () => {
    const { c, calls } = client(() => json(project))
    for (const bad of ['..', '.', '', 'a/b', 'x']) {
      // oxlint-disable-next-line no-await-in-loop -- one bad id at a time
      await expect(c.getProject(bad)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
      // oxlint-disable-next-line no-await-in-loop
      await expect(c.getProjectVersions(bad)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
      // oxlint-disable-next-line no-await-in-loop
      await expect(c.getProjectDependencies(bad)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
      // oxlint-disable-next-line no-await-in-loop
      await expect(c.getTeamMembers(bad)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    }
    expect(calls).toHaveLength(0)
  })

  it('batches projects, drops malformed ids and chunks by 100', async () => {
    const { c, calls } = client((call) => {
      const ids = jsonParam(call.url, 'ids') as string[]
      return json(ids.map((id) => ({ ...project, id })))
    })
    const ids = Array.from({ length: 150 }, (_, i) => `id${String(i).padStart(6, '0')}`)
    const res = await c.getProjects([...ids, 'bad id/with spaces', ids[0]!])
    expect(res).toHaveLength(150)
    expect(calls.map((x) => (jsonParam(x.url, 'ids') as string[]).length)).toEqual([100, 50])
  })

  it('validates version ids before calling the API', async () => {
    const { c, calls } = client((call) => json((jsonParam(call.url, 'ids') as string[]).map((id) => ({ ...versions[0], id }))))
    expect(await c.getVersions(['abcdEFGH', 'mods/x.jar', 'short'])).toHaveLength(1)
    expect(jsonParam(calls[0]!.url, 'ids')).toEqual(['abcdEFGH'])
    await expect(c.getVersion('nope')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    expect(await c.getVersions(['x'])).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('filters project versions and sorts newest first', async () => {
    const { c, calls } = client(() => json(versions))
    const list = await c.getProjectVersions('AANobbMI', { loaders: ['quilt', 'fabric'], gameVersions: ['1.20.1'] })
    expect(list.map((v) => v.id)).toEqual(['abcdEFGH', 'oldVer01'])
    const url = calls[0]!.url
    expect(url.pathname).toBe('/v2/project/AANobbMI/version')
    expect(jsonParam(url, 'loaders')).toEqual(['quilt', 'fabric'])
    expect(jsonParam(url, 'game_versions')).toEqual(['1.20.1'])
    expect(url.searchParams.has('featured')).toBe(false)
  })

  it('looks up versions by hash (single and bulk)', async () => {
    const { c, calls } = client((call) => {
      if (call.method === 'GET') return json(versions[1])
      const body = call.body as { hashes: string[] }
      return json(Object.fromEntries(body.hashes.slice(0, 2).map((h) => [h, versions[1]])))
    })
    const single = await c.getVersionFromHash(sha1(1).toUpperCase())
    expect(single.id).toBe('abcdEFGH')
    expect(calls[0]!.url.pathname).toBe(`/v2/version_file/${sha1(1)}`)
    expect(calls[0]!.url.searchParams.get('algorithm')).toBe('sha1')

    const hashes = Array.from({ length: 130 }, (_, i) => sha1(i + 1))
    const map = await c.getVersionsFromHashes([...hashes, 'not-a-hash', hashes[0]!])
    const posts = calls.filter((x) => x.method === 'POST')
    expect(posts.map((p) => p.url.pathname)).toEqual(['/v2/version_files', '/v2/version_files'])
    expect(posts.map((p) => (p.body as { hashes: string[] }).hashes.length)).toEqual([100, 30])
    expect((posts[0]!.body as { algorithm: string }).algorithm).toBe('sha1')
    expect(posts[0]!.headers['content-type']).toBe('application/json')
    expect(Object.keys(map)).toHaveLength(4)
  })

  it('sends loaders and game versions for bulk update lookups', async () => {
    const { c, calls } = client((call) =>
      call.url.pathname.startsWith('/v2/version_files') ? json({ [sha1(5)]: versions[1] }) : json(versions[1]),
    )
    const map = await c.getLatestVersionsFromHashes([sha1(5)], { loaders: ['quilt', 'fabric'], gameVersions: ['1.20.1'] })
    expect(map[sha1(5)]?.id).toBe('abcdEFGH')
    expect(calls[0]!.url.pathname).toBe('/v2/version_files/update')
    expect(calls[0]!.body).toEqual({
      hashes: [sha1(5)],
      algorithm: 'sha1',
      loaders: ['quilt', 'fabric'],
      game_versions: ['1.20.1'],
    })
    const one = await c.getLatestVersionFromHash(sha1(5), { algorithm: 'sha1' })
    expect(one.id).toBe('abcdEFGH')
    expect(calls[1]!.url.pathname).toBe(`/v2/version_file/${sha1(5)}/update`)
    expect(calls[1]!.body).toEqual({})
  })

  it('reads dependencies, members and tags', async () => {
    const { c, calls } = client((call) => {
      switch (call.url.pathname) {
        case '/v2/project/AANobbMI/dependencies':
          return json({ projects: [project], versions: [versions[0]] })
        case '/v2/project/AANobbMI/members':
          return json([{ team_id: 't', user: { id: 'u', username: 'jelly' }, role: 'Owner' }])
        case '/v2/tag/category':
          return json([{ icon: '<svg/>', name: 'technology', project_type: 'mod', header: 'categories' }])
        case '/v2/tag/loader':
          return json([{ icon: '<svg/>', name: 'fabric', supported_project_types: ['mod'] }])
        case '/v2/tag/game_version':
          return json([{ version: '1.20.1', version_type: 'release', date: '2023-06-12T00:00:00Z', major: false }])
        default:
          return json({}, {}, 404)
      }
    })
    expect((await c.getProjectDependencies('AANobbMI')).projects[0]?.id).toBe('AANobbMI')
    expect((await c.getTeamMembers('AANobbMI'))[0]?.user.username).toBe('jelly')
    expect((await c.getCategories())[0]?.name).toBe('technology')
    expect((await c.getLoaders())[0]?.name).toBe('fabric')
    expect((await c.getGameVersions())[0]?.version).toBe('1.20.1')
    expect(calls).toHaveLength(5)
  })

  it('maps 404 and malformed bodies to typed errors', async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith('/gone')
        ? { status: 404, text: '{"error":"not_found","description":"the requested route does not exist"}' }
        : { text: '<html>oops</html>' },
    )
    const notFound = await c.getProject('gone').catch((e: unknown) => e)
    expect(isMarketplaceError(notFound, 'ENOT_FOUND')).toBe(true)
    expect(notFound).toMatchObject({ status: 404, platform: 'modrinth', url: 'https://api.modrinth.com/v2/project/gone' })
    await expect(c.getProject('sodium')).rejects.toMatchObject({ code: 'EBAD_RESPONSE' })
  })

  it('rejects responses with the wrong shape', async () => {
    const { c } = client(() => json({ hits: 'nope' }))
    await expect(c.search()).rejects.toMatchObject({ code: 'EBAD_RESPONSE' })
  })
})

describe('pickModrinthFile', () => {
  const v = versions[1] as unknown as ModrinthVersion
  it('prefers the named file, then primary, then jar, skipping auxiliary files', () => {
    expect(pickModrinthFile(v)?.filename).toBe('sodium-0.5.3.jar')
    expect(pickModrinthFile(v, 'sodium-sources.jar')?.filename).toBe('sodium-sources.jar')
    const noPrimary = { files: v.files.map((f) => ({ ...f, primary: false })) }
    expect(pickModrinthFile(noPrimary)?.filename).toBe('sodium-0.5.3.jar')
    expect(pickModrinthFile({ files: [] })).toBeUndefined()
  })
})
