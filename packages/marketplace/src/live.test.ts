import { describe, expect, it } from 'vitest'
import { modrinthHitToProject, modrinthVersionToVersion } from './model'
import { ModrinthClient } from './modrinth'

// Hits the real Modrinth API. Run with AMETHYST_NET_TESTS=1 pnpm test.
describe.runIf(process.env.AMETHYST_NET_TESTS)('Modrinth (live)', () => {
  const client = new ModrinthClient({ version: 'test' })

  it('searches with facets', async () => {
    const res = await client.search({ query: 'sodium', projectType: 'mod', loaders: ['fabric'], limit: 5 })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits.map(modrinthHitToProject).some((p) => p.slug === 'sodium')).toBe(true)
  }, 30_000)

  it('lists versions and resolves a file hash back to its version', async () => {
    const versions = await client.getProjectVersions('sodium', { loaders: ['fabric'], gameVersions: ['1.20.1'] })
    expect(versions.length).toBeGreaterThan(0)
    const v = modrinthVersionToVersion(versions[0]!)
    const sha1 = v.files.find((f) => f.primary)?.sha1
    expect(sha1).toBeTruthy()
    const map = await client.getVersionsFromHashes([sha1!])
    expect(map[sha1!]?.project_id).toBe(v.projectId)
  }, 30_000)

  it('reads tags', async () => {
    const [categories, loaders, gameVersions] = await Promise.all([
      client.getCategories(),
      client.getLoaders(),
      client.getGameVersions(),
    ])
    expect(categories.length).toBeGreaterThan(0)
    expect(loaders.some((l) => l.name === 'fabric')).toBe(true)
    expect(gameVersions.some((g) => g.version === '1.20.1')).toBe(true)
  }, 30_000)
})
