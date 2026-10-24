import { createHash } from 'node:crypto'
import { readdir, readFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveScanWorker, type ScanWorkerHandlers } from '@amethyst/content'
import type { CurseForgeClient, ModrinthClient, ModrinthVersion } from '@amethyst/marketplace'
import { createZip } from '@amethyst/zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbClient } from '../db/client'
import { fakeWorker, testDbClient } from '../db/test-utils'
import { InstanceManager } from '../instances/service'
import { dataLayout, type DataLayout } from '../layout'
import { WorkerPool } from '../resources/pool'
import { ResourceManager } from '../resources/service'
import { createResourceWorkerHandlers, type ResourceWorkerHandlers } from '../resources/worker-handlers'
import { defaultSettings } from '../settings/schema'
import { TaskRegistry } from '../tasks/registry'
import { MarketplaceManager } from './service'

let root: string
let layout: DataLayout
let db: DbClient
let pool: WorkerPool<ResourceWorkerHandlers>
let server: Server
let baseUrl: string
let jar: Buffer
const tasks = new TaskRegistry(() => {})
const emit = () => {}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex')

function version(id: string, file: { name: string; bytes: Buffer }, overrides: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return {
    id,
    project_id: 'PROJ0001',
    name: `Version ${id}`,
    version_number: id,
    version_type: 'release',
    date_published: '2026-01-01T00:00:00Z',
    downloads: 1,
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    files: [{ url: `${baseUrl}/${file.name}`, filename: file.name, primary: true, size: file.bytes.length, hashes: { sha1: sha1(file.bytes) } }],
    dependencies: [],
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-market-'))
  layout = dataLayout(root)
  db = testDbClient(path.join(root, 'index.sqlite')).client
  pool = new WorkerPool<ResourceWorkerHandlers>(() => fakeWorker((port) => serveScanWorker(port, createResourceWorkerHandlers() as unknown as ScanWorkerHandlers)), { size: 1, idleMs: 0 })
  const src = path.join(root, 'src.jar')
  await mkdir(path.dirname(src), { recursive: true })
  const z = createZip(src)
  z.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'sodium', version: '0.6.0', name: 'Sodium' })), 'fabric.mod.json')
  await z.finish()
  jar = await readFile(src)
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': jar.length })
    res.end(jar)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  pool.dispose()
  await db.close()
  await new Promise((r) => server.close(r))
  await rm(root, { recursive: true, force: true })
})

describe('MarketplaceManager', () => {
  it('installs into the store and the instance, records provenance, and checks for updates by hash', async () => {
    const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
    await instances.load()
    const inst = await instances.create({ name: 'Market', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const trashed: string[] = []
    const resources = new ResourceManager({ layout, emit, host: { trash: async (p) => void trashed.push(p) }, instances, db, pool, tasks, settings: { value: defaultSettings() } })

    const v1 = version('VERSION1', { name: 'sodium-0.6.0.jar', bytes: jar })
    const latestCalls: unknown[] = []
    const modrinth = {
      getVersion: async (id: string) => {
        if (id !== 'VERSION1') throw new Error('unknown')
        return v1
      },
      getProject: async () => ({ id: 'PROJ0001', slug: 'sodium', project_type: 'mod', title: 'Sodium', loaders: ['fabric'] }),
      getVersionsFromHashes: async () => ({}),
      getLatestVersionsFromHashes: async (hashes: string[], filter: unknown) => {
        latestCalls.push({ hashes, filter })
        return Object.fromEntries(hashes.map((h) => [h, version('VERSION2', { name: 'sodium-0.6.1.jar', bytes: jar }, { date_published: '2026-02-01T00:00:00Z', version_number: '0.6.1' })]))
      },
    } as unknown as ModrinthClient
    const curseforge = { isAvailable: () => false } as unknown as CurseForgeClient
    const market = new MarketplaceManager({ version: 'test', db, instances, resources, pool, tasks, host: { trash: async (p) => void trashed.push(p) }, modrinth, curseforge })

    expect(market.status()).toEqual({ modrinth: true, curseforge: false, curseforgeReason: 'no-key' })
    const result = await market.install({ instanceId: inst.id, platform: 'modrinth', projectId: 'PROJ0001', versionId: 'VERSION1' })
    expect(result).toEqual({ resource: { kind: 'mods', id: 'sodium-0.6.0.jar' }, manual: [] })
    expect(await readdir(path.join(inst.path, 'mods'))).toEqual(['sodium-0.6.0.jar'])
    expect(await resources.store.has(sha1(jar))).toBe(true)

    const rows = (await resources.list(inst.id, 'mods')).items
    expect(rows[0]).toMatchObject({ name: 'Sodium', source: { platform: 'modrinth', projectId: 'PROJ0001', versionId: 'VERSION1' } })
    expect(market.status().curseforge).toBe(false)
    expect(resources.knownSources(inst.id)).toEqual(new Set(['modrinth:PROJ0001']))

    const updates = await market.checkUpdates(inst.id, 'mods')
    expect(updates).toEqual([
      {
        resourceId: 'sodium-0.6.0.jar',
        fileName: 'sodium-0.6.0.jar',
        platform: 'modrinth',
        projectId: 'PROJ0001',
        currentVersionId: 'VERSION1',
        latest: { versionId: 'VERSION2', name: 'Version VERSION2', versionNumber: '0.6.1', releaseType: 'release', publishedAt: '2026-02-01T00:00:00Z', fileName: 'sodium-0.6.1.jar' },
      },
    ])
    expect(latestCalls).toEqual([{ hashes: [sha1(jar)], filter: { loaders: ['fabric'], gameVersions: ['1.21.1'] } }])
    // The answer is cached in the index for ten minutes.
    await market.checkUpdates(inst.id, 'mods')
    expect(latestCalls).toHaveLength(1)
    resources.dispose()
  })

  it('reports files CurseForge does not let us download', async () => {
    const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
    await instances.load()
    const inst = await instances.create({ name: 'CF', runtime: { minecraft: '1.20.1', forge: '47.2.0' } })
    const resources = new ResourceManager({ layout, emit, host: { trash: async () => {} }, instances, db, pool, tasks, settings: { value: defaultSettings() } })
    const curseforge = {
      isAvailable: () => true,
      getFile: async () => ({
        id: 555,
        modId: 42,
        isAvailable: true,
        displayName: 'Restricted 1.0',
        fileName: 'restricted.jar',
        releaseType: 1,
        fileStatus: 4,
        hashes: [{ value: 'a'.repeat(40), algo: 1 }],
        fileDate: '2026-01-01T00:00:00Z',
        fileLength: 10,
        downloadUrl: null,
        gameVersions: ['1.20.1', 'Forge'],
        dependencies: [],
        fileFingerprint: 1,
      }),
      getMod: async () => ({ id: 42, name: 'Restricted', slug: 'restricted', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/restricted' } }),
    } as unknown as CurseForgeClient
    const market = new MarketplaceManager({ version: 'test', db, instances, resources, pool, tasks, host: { trash: async () => {} }, modrinth: {} as ModrinthClient, curseforge })
    const result = await market.install({ instanceId: inst.id, platform: 'curseforge', projectId: '42', versionId: '555' })
    expect(result.resource).toBeNull()
    expect(result.manual).toEqual([{ projectId: '42', fileId: '555', fileName: 'restricted.jar', websiteUrl: expect.stringContaining('curseforge.com'), sha1: 'a'.repeat(40), size: 10 }])
    resources.dispose()
  })
})
