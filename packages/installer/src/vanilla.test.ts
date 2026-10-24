import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnose, resolveVersion } from '@amethyst/game'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { CancelledError, createTask } from '@amethyst/task'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixture, sha1, startServer, tempDir, type TestServer } from './__fixtures__/helpers'
import { publishMiniVersion } from './__fixtures__/mini'
import { createMetadataClient, installMissing, type MetadataClient, planInstall, runInstall } from './index'

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
  meta = createMetadataClient({ http, endpoints: { mojangManifest: `${server.url}/manifest.json` } })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('planInstall (vanilla)', () => {
  it('lists the steps of a real (trimmed) 1.21.1 JSON with their sizes, without writing anything', async () => {
    const text = fixture('version-1.21.1.trimmed.json')
    const json = JSON.parse(text)
    server.file('/v/1.21.1.json', text)
    server.file('/manifest.json', {
      latest: { release: '1.21.1', snapshot: '1.21.1' },
      versions: [{ id: '1.21.1', type: 'release', url: `${server.url}/v/1.21.1.json`, time: '', releaseTime: '', sha1: sha1(text) }],
    })
    const plan = await planInstall({ minecraft: '1.21.1' }, { root, meta, http })
    const macLibs = json.libraries.filter((l: { name: string }) => !/natives-(linux|windows)/.test(l.name))
    const libBytes = macLibs.reduce((n: number, l: { downloads: { artifact: { size: number } } }) => n + l.downloads.artifact.size, 0)
    expect(plan.versionId).toBe('1.21.1')
    expect(plan.javaMajor).toBe(21)
    expect(plan.needsJava).toBe(false)
    expect(plan.steps).toEqual([
      { id: 'version-json', files: 1 },
      { id: 'client', bytes: json.downloads.client.size, files: 1 },
      // Both macOS LWJGL native jars are kept (rules do not distinguish arches); Linux/Windows are not.
      { id: 'libraries', bytes: libBytes, files: macLibs.length },
      { id: 'assets', bytes: json.assetIndex.size + json.assetIndex.totalSize },
    ])
    expect(macLibs.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(['org.lwjgl:lwjgl:3.3.3:natives-macos', 'org.lwjgl:lwjgl:3.3.3:natives-macos-arm64']))
    expect(plan.totalBytes).toBe(json.downloads.client.size + libBytes + json.assetIndex.size + json.assetIndex.totalSize)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a version JSON that does not match the manifest sha1', async () => {
    const mini = await publishMiniVersion(server, 'tampered')
    ;(mini.manifest.versions[0] as { sha1: string }).sha1 = '0'.repeat(40)
    server.file('/manifest.json', mini.manifest)
    await expect(planInstall({ minecraft: 'tampered' }, { root, meta, http })).rejects.toMatchObject({ code: 'EINSTALL_CHECKSUM' })
  })
})

describe('runInstall (vanilla)', () => {
  it('installs the version JSON, client jar, libraries, natives, log config and assets', async () => {
    const mini = await publishMiniVersion(server)
    const plan = await planInstall({ minecraft: mini.id }, { root, meta, http })
    const snapshots: number[] = []
    const task = createTask('install', (ctx) => runInstall(plan, { root, ctx, http, meta, assetsBaseUrl: `${server.url}/assets/` }), {
      onUpdate: (s) => snapshots.push(s.fraction),
      throttleMs: 0,
    })
    const result = await task.promise
    expect(result).toEqual({ versionId: mini.id, minecraftVersion: mini.id, javaMajor: 21 })
    expect(task.snapshot().children.map((c) => c.name)).toEqual(['version-json', 'client', 'libraries', 'assets'])
    expect(snapshots.at(-1)).toBe(1)

    expect(JSON.parse(await readFile(join(root, 'versions', mini.id, `${mini.id}.json`), 'utf8'))).toEqual(mini.json)
    expect(await exists(join(root, 'versions', mini.id, `${mini.id}.jar`))).toBe(true)
    expect(await Promise.all(mini.expectedLibraries.map((p) => exists(join(root, 'libraries', p))))).toEqual(mini.expectedLibraries.map(() => true))
    expect(await Promise.all(mini.excludedLibraries.map((p) => exists(join(root, 'libraries', p))))).toEqual(mini.excludedLibraries.map(() => false))
    expect(await exists(join(root, 'assets', 'log_configs', 'client-1.xml'))).toBe(true)
    // Hash-named index plus a hard-linked alias under the assets id.
    const hashed = await stat(join(root, 'assets', 'indexes', `${mini.assetIndexSha1}.json`))
    const alias = await stat(join(root, 'assets', 'indexes', `${mini.id}-assets.json`))
    expect(alias.ino).toBe(hashed.ino)
    expect(await Promise.all(mini.objects.map((h) => exists(join(root, 'assets', 'objects', h.slice(0, 2), h))))).toEqual(mini.objects.map(() => true))
    expect(server.hits(`/assets/${mini.objects[0]?.slice(0, 2)}/${mini.objects[0]}`)).toBe(1)
    const lock = JSON.parse(await readFile(join(root, 'versions', mini.id, '.install-lock'), 'utf8'))
    expect(lock).toMatchObject({ schemaVersion: 1, version: mini.id })

    // The result satisfies @amethyst/game's diagnose.
    const resolved = await resolveVersion(join(root, 'versions'), mini.id)
    const issues = await diagnose(resolved, root, { jvmArch: 'arm64', assets: false, hash: 'always' })
    expect(issues.filter((i) => i.problem !== 'unavailable')).toEqual([])

    // Re-running downloads nothing.
    server.requests.length = 0
    await runInstall(await planInstall({ minecraft: mini.id }, { root, meta, http }), { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
    expect(server.requests.filter((p) => p !== '/manifest.json')).toEqual([])
  })

  it('repairs a corrupt client jar on re-run', async () => {
    const mini = await publishMiniVersion(server)
    const plan = await planInstall({ minecraft: mini.id }, { root, meta, http })
    await runInstall(plan, { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
    const jar = join(root, 'versions', mini.id, `${mini.id}.jar`)
    await writeFile(jar, 'garbage')
    await runInstall(plan, { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
    expect(sha1(await readFile(jar))).toBe((mini.json.downloads as { client: { sha1: string } }).client.sha1)
  })

  it('cancels mid-install promptly and leaves no unverified files', async () => {
    const mini = await publishMiniVersion(server, 'slow', { objectDelayMs: 2000, objectCount: 6 })
    const plan = await planInstall({ minecraft: mini.id }, { root, meta, http })
    const task = createTask('install', (ctx) => runInstall(plan, { root, ctx, http, meta, assetsBaseUrl: `${server.url}/assets/` }))
    const started = Date.now()
    setTimeout(() => task.cancel('user'), 300)
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(1900)
    expect(task.snapshot().state).toBe('cancelled')
    expect(await Promise.all(mini.objects.map((h) => exists(join(root, 'assets', 'objects', h.slice(0, 2), h))))).toEqual(mini.objects.map(() => false))
    expect(await exists(join(root, 'versions', mini.id, '.install-lock'))).toBe(false)
  })
})

describe('installMissing', () => {
  it('re-downloads exactly the files diagnose reports', async () => {
    const mini = await publishMiniVersion(server)
    await runInstall(await planInstall({ minecraft: mini.id }, { root, meta, http }), { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
    const [lib0, , lib2] = mini.expectedLibraries as [string, string, string]
    await rm(join(root, 'libraries', lib0))
    await writeFile(join(root, 'libraries', lib2), 'corrupt')
    const resolved = await resolveVersion(join(root, 'versions'), mini.id)
    const issues = (await diagnose(resolved, root, { jvmArch: 'arm64', assets: false, hash: 'always' })).filter((i) => i.problem !== 'unavailable')
    expect(issues.map((i) => i.path).toSorted()).toEqual([join(root, 'libraries', lib0), join(root, 'libraries', lib2)].toSorted())

    server.requests.length = 0
    const result = await installMissing(issues, { root, http })
    expect(result.unresolved).toEqual([])
    expect(result.repaired.toSorted()).toEqual(issues.map((i) => i.path).toSorted())
    expect(server.requests.toSorted()).toEqual([`/libs/${lib0}`, `/libs/${lib2}`].toSorted())
    expect(await diagnose(resolved, root, { jvmArch: 'arm64', assets: false, hash: 'always' }).then((r) => r.filter((i) => i.problem !== 'unavailable'))).toEqual([])
  })

  it('returns issues without a URL as unresolved', async () => {
    const result = await installMissing([{ kind: 'library', name: 'x:y:1:client', path: join(root, 'libraries/x/y.jar'), expected: {}, url: '' }], { root, http })
    expect(result.unresolved).toHaveLength(1)
    expect(result.repaired).toEqual([])
  })
})
