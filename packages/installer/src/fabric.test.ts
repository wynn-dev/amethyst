import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildZip, bytes, fixtureJson, sha1, startServer, tempDir, type TestServer } from './__fixtures__/helpers'
import { publishMiniVersion } from './__fixtures__/mini'
import { createMetadataClient, installFabricLike, type MetadataClient, planInstall, runInstall } from './index'

let server: TestServer
let http: HttpClient
let root: string
let meta: MetadataClient

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

beforeAll(async () => {
  server = await startServer()
  http = createHttpClient({ retry: { retries: 0 } })
})
afterAll(async () => {
  await http.close()
  await server.close()
})
beforeEach(async () => {
  root = await tempDir()
  server.requests.length = 0
  meta = createMetadataClient({
    http,
    endpoints: { mojangManifest: `${server.url}/manifest.json`, fabricMeta: `${server.url}/fabric/v2/`, quiltMeta: `${server.url}/quilt/v3/` },
  })
})
afterEach(() => rm(root, { recursive: true, force: true }))

/** Publish a jar at `<maven>/<path>` and return it. */
async function publishJar(maven: string, path: string, seed: number): Promise<Buffer> {
  const jar = await buildZip({ [`c${seed}.class`]: bytes(200, seed) })
  server.file(`${maven}${path}`, jar)
  return jar
}

/** The real Fabric profile, with its libraries swapped for local jars of the same shape. */
async function publishFabricProfile(mc: string, loader: string, options: { corrupt?: boolean } = {}) {
  const real = fixtureJson<{ libraries: { name: string }[] } & Record<string, unknown>>('fabric-profile-1.21.1.json')
  const maven = '/fabric-maven/'
  const asm = await publishJar(maven, 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar', 1)
  const loaderJar = await publishJar(maven, `net/fabricmc/fabric-loader/${loader}/fabric-loader-${loader}.jar`, 2)
  server.file(`${maven}net/fabricmc/fabric-loader/${loader}/fabric-loader-${loader}.jar.sha1`, sha1(loaderJar))
  const profile = {
    ...real,
    id: `fabric-loader-${loader}-${mc}`,
    inheritsFrom: mc,
    libraries: [
      // Fabric publishes sha1/size for most libraries…
      { name: 'org.ow2.asm:asm:9.10.1', url: `${server.url}${maven}`, sha1: options.corrupt ? '0'.repeat(40) : sha1(asm), size: asm.length },
      // …but not for the loader itself: the maven sidecar is used instead.
      { name: `net.fabricmc:fabric-loader:${loader}`, url: `${server.url}${maven}` },
    ],
  }
  server.file(`/fabric/v2/versions/loader/${mc}/${loader}/profile/json`, profile)
  return profile
}

describe('installFabricLike', () => {
  it('writes the Fabric profile with inheritsFrom and installs its verified libraries', async () => {
    const profile = await publishFabricProfile('1.21.1', '0.20.1')
    const result = await installFabricLike('fabric', '1.21.1', '0.20.1', { root, http, meta })
    expect(result.versionId).toBe('1.21.1-fabric0.20.1')
    const written = JSON.parse(await readFile(join(root, 'versions', result.versionId, `${result.versionId}.json`), 'utf8'))
    expect(written).toEqual({ ...profile, id: '1.21.1-fabric0.20.1', inheritsFrom: '1.21.1' })
    expect(written.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(written.arguments.jvm).toEqual(['-DFabricMcEmu= net.minecraft.client.main.Main '])
    expect(await exists(join(root, 'libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar'))).toBe(true)
    expect(await exists(join(root, 'libraries/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar'))).toBe(true)
    expect(server.hits('/fabric-maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar.sha1')).toBe(1)
  })

  it('stacks on a base id', async () => {
    await publishFabricProfile('1.21.1', '0.20.1')
    const result = await installFabricLike('fabric', '1.21.1', '0.20.1', { root, http, meta, base: 'custom-1.21.1' })
    expect(result.versionId).toBe('custom-1.21.1-fabric0.20.1')
    const written = JSON.parse(await readFile(join(root, 'versions', result.versionId, `${result.versionId}.json`), 'utf8'))
    expect(written.inheritsFrom).toBe('custom-1.21.1')
  })

  it('uses the published sha1 instead of trusting any zip', async () => {
    await publishFabricProfile('1.21.1', '0.20.1', { corrupt: true })
    await expect(installFabricLike('fabric', '1.21.1', '0.20.1', { root, http, meta })).rejects.toMatchObject({ code: 'EDOWNLOAD' })
    expect(await exists(join(root, 'libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar'))).toBe(false)
  })

  it('writes a Quilt profile and verifies hash-less libraries by sidecar or as zips', async () => {
    const real = fixtureJson<Record<string, unknown>>('quilt-profile-1.21.1.json')
    const maven = '/quilt-maven/'
    const loaderJar = await publishJar(maven, 'org/quiltmc/quilt-loader/0.30.1/quilt-loader-0.30.1.jar', 3)
    server.file(`${maven}org/quiltmc/quilt-loader/0.30.1/quilt-loader-0.30.1.jar.sha1`, `${sha1(loaderJar)}  quilt-loader-0.30.1.jar\n`)
    await publishJar(maven, 'org/quiltmc/hashed/1.21.1/hashed-1.21.1.jar', 4) // no sidecar: zip check only
    const profile = {
      ...real,
      libraries: [
        { name: 'org.quiltmc:quilt-loader:0.30.1', url: `${server.url}${maven}` },
        { name: 'org.quiltmc:hashed:1.21.1', url: `${server.url}${maven}` },
      ],
    }
    server.file('/quilt/v3/versions/loader/1.21.1/0.30.1/profile/json', profile)
    const result = await installFabricLike('quilt', '1.21.1', '0.30.1', { root, http, meta })
    expect(result.versionId).toBe('1.21.1-quilt0.30.1')
    const written = JSON.parse(await readFile(join(root, 'versions', result.versionId, `${result.versionId}.json`), 'utf8'))
    expect(written).toMatchObject({ id: '1.21.1-quilt0.30.1', inheritsFrom: '1.21.1', mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient' })
    expect(result.libraries.downloaded).toBe(2)

    // An HTML error page served with 200 is rejected, not saved as a library.
    server.file(`${maven}org/quiltmc/hashed/1.21.1/hashed-1.21.1.jar`, '<html>maintenance</html>')
    await rm(join(root, 'libraries/org/quiltmc/hashed/1.21.1/hashed-1.21.1.jar'))
    await expect(installFabricLike('quilt', '1.21.1', '0.30.1', { root, http, meta })).rejects.toMatchObject({ code: 'EINSTALL_FILE_INVALID' })
    expect(await exists(join(root, 'libraries/org/quiltmc/hashed/1.21.1/hashed-1.21.1.jar'))).toBe(false)
  })
})

describe('runInstall with Fabric', () => {
  it('layers Fabric over vanilla and returns the loader version id', async () => {
    const mini = await publishMiniVersion(server, 'mini-f')
    await publishFabricProfile('mini-f', '0.20.1')
    const plan = await planInstall({ minecraft: 'mini-f', loader: { kind: 'fabric', version: '0.20.1' } }, { root, meta, http })
    expect(plan.versionId).toBe('mini-f-fabric0.20.1')
    expect(plan.steps.map((s) => s.id)).toEqual(['version-json', 'client', 'libraries', 'assets', 'loader', 'loader-libraries'])
    expect(plan.steps.find((s) => s.id === 'loader-libraries')).toMatchObject({ files: 2 })
    const result = await runInstall(plan, { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
    expect(result).toEqual({ versionId: 'mini-f-fabric0.20.1', minecraftVersion: 'mini-f', javaMajor: 21, loader: { kind: 'fabric', version: '0.20.1' } })
    expect(await exists(join(root, 'versions', mini.id, `${mini.id}.jar`))).toBe(true)
    expect(await exists(join(root, 'versions', 'mini-f-fabric0.20.1', '.install-lock'))).toBe(true)
  })

  it('re-plans an installed loader version from its local profile when the meta service is down', async () => {
    await publishMiniVersion(server, 'mini-o')
    await publishFabricProfile('mini-o', '0.20.2')
    const plan = await planInstall({ minecraft: 'mini-o', loader: { kind: 'fabric', version: '0.20.2' } }, { root, meta, http })
    await runInstall(plan, { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })

    server.route('/fabric/v2/versions/loader/mini-o/0.20.2/profile/json', (_req, res) => {
      res.statusCode = 503
      res.end()
    })
    const again = await planInstall({ minecraft: 'mini-o', loader: { kind: 'fabric', version: '0.20.2' } }, { root, meta, http })
    expect(again.versionId).toBe('mini-o-fabric0.20.2')
    expect(again.loader).toMatchObject({ kind: 'fabric', version: '0.20.2', profile: { id: 'mini-o-fabric0.20.2', inheritsFrom: 'mini-o' } })
    await expect(runInstall(again, { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })).resolves.toMatchObject({ versionId: 'mini-o-fabric0.20.2' })

    // Without a local copy the failure is reported as before.
    await expect(planInstall({ minecraft: 'mini-o', loader: { kind: 'fabric', version: '0.20.3' } }, { root, meta, http })).rejects.toThrow('HTTP 404')
  })
})
