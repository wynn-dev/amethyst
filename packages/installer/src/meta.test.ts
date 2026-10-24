import { rm } from 'node:fs/promises'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixture, fixtureJson, startServer, tempDir, type TestServer } from './__fixtures__/helpers'
import {
  compareMinecraftVersions,
  compareNeoForgeVersions,
  createMetadataClient,
  fabricLikeVersionId,
  forgeInstallKind,
  forgeVersionsFrom,
  MetadataCache,
  neoForgeMinecraftVersion,
  neoForgeVersionsFrom,
  parseForgeArtifactVersion,
  parseForgeFiles,
  parseForgePromotions,
  parseLoaderProfile,
  parseLoaderVersions,
  parseMavenMetadata,
  parseSidecar,
  parseVersionManifest,
  requiredJavaMajor,
} from './index'

describe('Minecraft versions', () => {
  it('orders classic, year-based and pre-release ids', () => {
    const ids = ['26.1', '1.21.11', '1.21.9', '26.1.2', '1.21', '1.21-rc-1', '26.4-snapshot-5', '26.3', '1.20.5-pre1']
    expect(ids.toSorted(compareMinecraftVersions)).toEqual(['1.20.5-pre1', '1.21-rc-1', '1.21', '1.21.9', '1.21.11', '26.1', '26.1.2', '26.3', '26.4-snapshot-5'])
  })

  it('derives the required Java', () => {
    expect(requiredJavaMajor({ id: 'x', javaVersion: { majorVersion: 21 } })).toBe(21)
    expect(requiredJavaMajor({ id: '1.12.2' })).toBe(8)
    expect(requiredJavaMajor({ id: '1.17.1' })).toBe(16)
    expect(requiredJavaMajor({ id: '1.20.4' })).toBe(17)
    expect(requiredJavaMajor({ id: '1.20.5' })).toBe(21)
    expect(requiredJavaMajor({ id: '26.1' })).toBe(25)
    expect(requiredJavaMajor({ id: 'fabric-loader-x' }, '1.21.1')).toBe(21)
    expect(requiredJavaMajor({ id: '24w14a' })).toBe(21)
  })
})

describe('Mojang manifest', () => {
  it('validates the trimmed live manifest, including year-based ids', () => {
    const m = parseVersionManifest(fixtureJson('mojang-manifest.json'))
    expect(m.latest.release).toBe('26.3')
    expect(m.versions.map((v) => v.id)).toContain('26.4-snapshot-5')
    expect(m.versions.every((v) => /^[0-9a-f]{40}$/.test(v.sha1))).toBe(true)
  })

  it('rejects malformed manifests', () => {
    expect(() => parseVersionManifest({ latest: {}, versions: [{ id: 'x' }] })).toThrow(expect.objectContaining({ code: 'EINSTALL_BAD_METADATA' }))
  })
})

describe('Forge metadata', () => {
  const versions = parseMavenMetadata(fixture('forge-maven-metadata.xml'))
  const promos = parseForgePromotions(fixtureJson('forge-promotions.json'))

  it('splits real artifact versions without guessing suffixes', () => {
    expect(parseForgeArtifactVersion('1.20.1-47.3.0')).toEqual({ minecraft: '1.20.1', version: '47.3.0' })
    expect(parseForgeArtifactVersion('1.7.10-10.13.4.1614-1.7.10')).toEqual({ minecraft: '1.7.10', version: '10.13.4.1614', suffix: '1.7.10' })
    expect(parseForgeArtifactVersion('1.10-12.18.0.2000-1.10.0')).toEqual({ minecraft: '1.10', version: '12.18.0.2000', suffix: '1.10.0' })
    expect(parseForgeArtifactVersion('1.7.10_pre4-10.12.2.1149-prerelease')).toMatchObject({ minecraft: '1.7.10-pre4', version: '10.12.2.1149' })
    expect(parseForgeArtifactVersion('26.3-66.1.0')).toEqual({ minecraft: '26.3', version: '66.1.0' })
  })

  it('lists builds per Minecraft version from maven-metadata.xml with promotion flags', () => {
    const v1710 = forgeVersionsFrom(versions, promos, '1.7.10')
    expect(v1710[0]).toMatchObject({ version: '10.13.4.1614', artifactVersion: '1.7.10-10.13.4.1614-1.7.10', latest: true, recommended: true })
    const v18 = forgeVersionsFrom(versions, promos, '1.8')
    // The suffix differs between builds of the same Minecraft version: it is read, never guessed.
    expect(v18.find((v) => v.version === '11.14.4.1577')?.artifactVersion).toBe('1.8-11.14.4.1577')
    expect(v18.find((v) => v.version === '11.14.0.1237')?.artifactVersion).toBe('1.8-11.14.0.1237-1.8')
    expect(forgeVersionsFrom(versions, promos, '1.20.1').map((v) => v.version)[0]).toBe('47.3.39')
    expect(forgeVersionsFrom(versions, promos, '26.3').length).toBeGreaterThan(0)
    // Builds are sorted newest first numerically, not lexically.
    const builds = forgeVersionsFrom(versions, promos, '1.20.1').map((v) => v.version)
    expect(builds.indexOf('47.3.10')).toBeLessThan(builds.indexOf('47.3.7'))
  })

  it('chooses the install format from meta.json', () => {
    expect(forgeInstallKind(parseForgeFiles({ classifiers: { universal: { zip: 'a' }, src: { zip: 'b' } } }))).toMatchObject({ kind: 'universal', classifier: 'universal', extension: 'zip', md5: 'a' })
    expect(forgeInstallKind(parseForgeFiles({ classifiers: { client: { zip: 'c' }, server: { zip: 'd' } } }))).toMatchObject({ kind: 'universal', classifier: 'client' })
    expect(forgeInstallKind(parseForgeFiles({ classifiers: { installer: { jar: 'e' }, universal: { jar: 'f' } } }))).toMatchObject({ kind: 'installer', md5: 'e' })
    expect(() => forgeInstallKind(parseForgeFiles({ classifiers: { src: { zip: 'x' } } }))).toThrow(expect.objectContaining({ code: 'EINSTALL_UNSUPPORTED' }))
  })

  it('rejects metadata without versions', () => {
    expect(() => parseMavenMetadata('<html>oops</html>')).toThrow(expect.objectContaining({ code: 'EINSTALL_BAD_METADATA' }))
  })
})

describe('NeoForge versioning', () => {
  it.each([
    ['20.2.3-beta', '1.20.2'],
    ['20.4.237', '1.20.4'],
    ['21.0.167', '1.21'],
    ['21.1.209', '1.21.1'],
    ['21.10.64', '1.21.10'],
    ['21.11.3', '1.21.11'],
    ['26.1.0.12', '26.1'],
    ['26.1.1.3', '26.1.1'],
    ['26.1.2.5', '26.1.2'],
    ['26.3.0.97', '26.3'],
    ['26.3.0.75-beta', '26.3'],
    ['26.1.0.0-alpha.13+snapshot-10', '26.1-snapshot-10'],
    ['26.1.0.0-alpha.15+pre-3', '26.1-pre-3'],
    ['0.25w14craftmine.3-beta', '25w14craftmine'],
  ])('maps %s to Minecraft %s', (version, mc) => {
    expect(neoForgeMinecraftVersion(version)).toBe(mc)
  })

  it('maps the 1.20.1 forge project', () => {
    expect(neoForgeMinecraftVersion('1.20.1-47.1.106', 'forge')).toBe('1.20.1')
    expect(neoForgeMinecraftVersion('47.1.82', 'forge')).toBe('1.20.1')
    expect(neoForgeMinecraftVersion('garbage')).toBeUndefined()
  })

  const lists = {
    neoforge: parseMavenMetadata(fixture('neoforge-maven-metadata.xml')),
    forge: parseMavenMetadata(fixture('neoforge-forge-maven-metadata.xml')),
  }

  it('filters by exact Minecraft version, never by prefix', () => {
    const v121 = neoForgeVersionsFrom(lists, '1.21')
    expect(v121.length).toBeGreaterThan(0)
    expect(v121.every((v) => v.version.startsWith('21.0.'))).toBe(true)
    const v1211 = neoForgeVersionsFrom(lists, '1.21.1')
    expect(v1211.every((v) => v.version.startsWith('21.1.'))).toBe(true)
    expect(neoForgeVersionsFrom(lists, '1.21.11').every((v) => v.version.startsWith('21.11.'))).toBe(true)
    const v261 = neoForgeVersionsFrom(lists, '26.1')
    expect(v261.length).toBeGreaterThan(0)
    expect(v261.every((v) => v.version.startsWith('26.1.0.') && !v.version.includes('+'))).toBe(true)
    expect(neoForgeVersionsFrom(lists, '26.1.2').every((v) => v.version.startsWith('26.1.2.'))).toBe(true)
  })

  it('lists 1.20.1 from the legacy forge project with its exact published versions', () => {
    const v = neoForgeVersionsFrom(lists, '1.20.1')
    expect(v.every((x) => x.project === 'forge')).toBe(true)
    expect(v[0]).toMatchObject({ version: '47.1.106', artifactVersion: '1.20.1-47.1.106' })
    expect(v.find((x) => x.version === '47.1.82')?.artifactVersion).toBe('47.1.82')
  })

  it('sorts semantically with prereleases first', () => {
    expect(['21.1.10', '21.1.9', '21.1.10-beta'].toSorted(compareNeoForgeVersions)).toEqual(['21.1.9', '21.1.10-beta', '21.1.10'])
    const v263 = neoForgeVersionsFrom(lists, '26.3')
    expect(v263[0]?.version).toBe('26.3.0.97')
    expect(v263.find((v) => v.version === '26.3.0.75-beta')?.prerelease).toBe(true)
  })
})

describe('Fabric and Quilt metadata', () => {
  it('parses loader lists and profiles', () => {
    const fabric = parseLoaderVersions(fixtureJson('fabric-loader.json'))
    expect(fabric[0]).toMatchObject({ maven: expect.stringMatching(/^net\.fabricmc:fabric-loader:/), stable: expect.any(Boolean) })
    const quilt = parseLoaderVersions(fixtureJson('quilt-loader.json'))
    expect(quilt[0]?.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(quilt[0]?.stable).toBe(false) // betas are not stable
    const profile = parseLoaderProfile(fixtureJson('fabric-profile-1.21.1.json'), '1.21.1', 'fabric')
    expect(profile.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(() => parseLoaderProfile(fixtureJson('fabric-profile-1.21.1.json'), '1.20.1', 'fabric')).toThrow(expect.objectContaining({ code: 'EINSTALL_BAD_METADATA' }))
    expect(fabricLikeVersionId('quilt', '1.21.1', '0.30.1')).toBe('1.21.1-quilt0.30.1')
  })
})

describe('sidecars', () => {
  it('accepts bare and named digests and rejects HTML', () => {
    const h = 'ec49fcb434d93fdbd615a0f29388b613c7df13f2'
    expect(parseSidecar(h, 'sha1')).toBe(h)
    expect(parseSidecar(`${h.toUpperCase()}  neoforge-21.1.209-installer.jar\n`, 'sha1')).toBe(h)
    expect(parseSidecar('<html></html>', 'sha1')).toBeUndefined()
    expect(parseSidecar(h, 'sha256')).toBeUndefined()
  })
})

describe('metadata client', () => {
  let server: TestServer
  let http: HttpClient
  let dir: string

  beforeAll(async () => {
    server = await startServer()
    http = createHttpClient({ retry: { retries: 0 } })
  })
  afterAll(async () => {
    await http.close()
    await server.close()
  })
  beforeEach(async () => {
    dir = await tempDir()
    server.requests.length = 0
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('caches, revalidates with ETag and falls back to the stale copy', async () => {
    let etagHits = 0
    let down = false
    server.route('/manifest.json', (req, res) => {
      if (down) {
        res.statusCode = 503
        res.end()
        return
      }
      if (req.headers['if-none-match'] === '"v1"') {
        etagHits++
        res.statusCode = 304
        res.end()
        return
      }
      res.setHeader('etag', '"v1"')
      res.end(fixture('mojang-manifest.json'))
    })
    let now = 1000
    const meta = createMetadataClient({ http, cacheDir: dir, maxAgeMs: 100, now: () => now, endpoints: { mojangManifest: `${server.url}/manifest.json` } })
    expect((await meta.minecraftManifest()).stale).toBe(false)
    await meta.minecraftManifest()
    expect(server.hits('/manifest.json')).toBe(1)
    now += 1000
    await meta.minecraftManifest()
    expect(etagHits).toBe(1)
    // A new client reads the persisted cache.
    down = true
    now += 1000
    const fresh = createMetadataClient({ http, cacheDir: dir, maxAgeMs: 100, now: () => now, endpoints: { mojangManifest: `${server.url}/manifest.json` } })
    const r = await fresh.minecraftManifest()
    expect(r.stale).toBe(true)
    expect(r.data.latest.release).toBe('26.3')
  })

  it('never lets an invalid response overwrite a good cache', async () => {
    let body: string = fixture('mojang-manifest.json')
    server.route('/m2.json', (_req, res) => res.end(body))
    const cache = new MetadataCache({ http, maxAgeMs: 0 })
    await cache.get('m', `${server.url}/m2.json`, parseVersionManifest)
    body = '{"latest":{},"versions":[]}'
    const r = await cache.get('m', `${server.url}/m2.json`, parseVersionManifest)
    expect(r.stale).toBe(true)
    expect(r.data.versions.length).toBeGreaterThan(0)
  })

  it('refreshes the manifest when a requested id is missing', async () => {
    const manifest = fixtureJson<{ versions: { id: string }[] }>('mojang-manifest.json')
    const older = { ...manifest, versions: manifest.versions.filter((v) => v.id !== '26.4-snapshot-5') }
    let served = older
    server.route('/m3.json', (_req, res) => res.end(JSON.stringify(served)))
    const meta = createMetadataClient({ http, maxAgeMs: 60_000, endpoints: { mojangManifest: `${server.url}/m3.json` } })
    await meta.minecraftManifest()
    served = manifest
    expect((await meta.minecraftVersion('26.4-snapshot-5')).id).toBe('26.4-snapshot-5')
    await expect(meta.minecraftVersion('9.9.9')).rejects.toMatchObject({ code: 'EINSTALL_NOT_FOUND' })
  })

  it('lists Forge and NeoForge versions from maven metadata', async () => {
    server.file('/forge/net/minecraftforge/forge/maven-metadata.xml', fixture('forge-maven-metadata.xml'))
    server.file('/files/promotions_slim.json', fixture('forge-promotions.json'))
    server.file('/neo/net/neoforged/neoforge/maven-metadata.xml', fixture('neoforge-maven-metadata.xml'))
    server.file('/neo/net/neoforged/forge/maven-metadata.xml', fixture('neoforge-forge-maven-metadata.xml'))
    const meta = createMetadataClient({
      http,
      endpoints: { forgeMaven: `${server.url}/forge/`, forgeFiles: `${server.url}/files/`, neoForgeMaven: `${server.url}/neo/` },
    })
    const forge = await meta.forgeVersions('1.12.2')
    expect(forge[0]).toMatchObject({ version: '14.23.5.2864', latest: true, recommended: false })
    expect((await meta.neoForgeVersions('1.21.1')).every((v) => v.minecraft === '1.21.1')).toBe(true)
    expect((await meta.neoForgeVersions('1.20.1'))[0]?.project).toBe('forge')
    expect(server.hits('/neo/net/neoforged/neoforge/maven-metadata.xml')).toBe(1)
  })
})
