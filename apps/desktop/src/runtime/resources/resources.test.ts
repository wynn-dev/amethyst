/* oxlint-disable no-await-in-loop -- files are written in order on purpose */
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveScanWorker, type ScanWorkerHandlers } from '@amethyst/content'
import { nbt, writeNbt } from '@amethyst/nbt'
import { createZip } from '@amethyst/zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Events } from '@shared/events'
import type { DbClient } from '../db/client'
import { fakeWorker, testDbClient } from '../db/test-utils'
import { InstanceManager } from '../instances/service'
import { dataLayout, type DataLayout } from '../layout'
import { defaultSettings } from '../settings/schema'
import { TaskRegistry } from '../tasks/registry'
import { WorkerPool } from './pool'
import { ResourceManager } from './service'
import { decodePng, encodePng } from './thumbnail'
import { routeChange } from './watcher'
import { createResourceWorkerHandlers, type ResourceWorkerHandlers, type ScanFolderResult } from './worker-handlers'

let root: string
let layout: DataLayout
let db: DbClient
let pool: WorkerPool<ResourceWorkerHandlers>
let instances: InstanceManager
let events: { event: keyof Events; payload: unknown }[]
let trashed: string[]
const tasks = new TaskRegistry(() => {})
const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  events.push({ event, payload })
}

async function jar(file: string, entries: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const z = createZip(file)
  for (const [name, data] of Object.entries(entries)) z.addBuffer(Buffer.from(data), name)
  await z.finish()
}
const fabricJar = (file: string, id: string, name = id.toUpperCase()) => jar(file, { 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', name, authors: ['A', 'B', 'C', 'D'] }) })

async function world(dir: string, levelName: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const data = await writeNbt({ root: nbt.compound({ Data: nbt.compound({ LevelName: nbt.string(levelName), Version: nbt.compound({ Name: nbt.string('1.21.1') }), GameType: nbt.int(1) }) }) }, { compression: 'gzip' })
  await writeFile(path.join(dir, 'level.dat'), data)
}

/** The pool, with every scanFolder result recorded. */
function recordingPool(calls: { method: string; result?: unknown }[], gate?: Promise<void>): Pick<WorkerPool<ResourceWorkerHandlers>, 'call'> {
  return {
    call: async (method, args, signal) => {
      if (gate && method === 'scanFolder') await gate
      const result = await pool.call(method, args, signal)
      calls.push({ method: String(method), result })
      return result
    },
  }
}

function manager(options: { pool?: Pick<WorkerPool<ResourceWorkerHandlers>, 'call'>; watchFactory?: ConstructorParameters<typeof ResourceManager>[0]['watchFactory'] } = {}): ResourceManager {
  return new ResourceManager({
    layout,
    emit,
    host: {
      trash: async (p) => {
        trashed.push(p)
        await rm(p, { recursive: true, force: true })
      },
    },
    instances,
    db,
    pool: options.pool ?? pool,
    tasks,
    settings: { value: defaultSettings() },
    ...(options.watchFactory ? { watchFactory: options.watchFactory } : {}),
    debounceMs: 20,
    releaseGraceMs: 0,
  })
}

const exists = (p: string) => lstat(p).then(() => true, () => false)

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-res-'))
  layout = dataLayout(root)
  events = []
  trashed = []
  db = testDbClient(path.join(root, 'index.sqlite')).client
  pool = new WorkerPool<ResourceWorkerHandlers>(() => fakeWorker((port) => serveScanWorker(port, createResourceWorkerHandlers() as unknown as ScanWorkerHandlers)), { size: 2, idleMs: 0 })
  instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
  await instances.load()
})

afterEach(async () => {
  pool.dispose()
  await db.close()
  await rm(root, { recursive: true, force: true })
})

describe('routeChange', () => {
  it('routes file events to the folders they affect', () => {
    expect(routeChange('mods/a.jar')).toEqual(['mods'])
    expect(routeChange('mods/a.jar.part')).toEqual([])
    expect(routeChange('resourcepacks/Pack/pack.mcmeta')).toEqual(['resourcepacks'])
    expect(routeChange('resourcepacks/Pack/assets/x.png')).toEqual([])
    expect(routeChange('saves/World/level.dat')).toEqual(['saves'])
    expect(routeChange('saves/World/region/r.0.0.mca')).toEqual([])
    expect(routeChange('options.txt')).toEqual(['resourcepacks'])
    expect(routeChange('config/iris.properties')).toEqual(['shaderpacks'])
    expect(routeChange('logs/latest.log')).toEqual([])
    expect(routeChange(null)).toEqual(['mods', 'resourcepacks', 'shaderpacks', 'saves'])
  })
})

describe('ResourceManager', () => {
  it('scans in the worker pool and serves unchanged files from the SQLite cache', async () => {
    const inst = await instances.create({ name: 'Modded', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const mods = path.join(inst.path, 'mods')
    await fabricJar(path.join(mods, 'sodium.jar'), 'sodium', 'Sodium')
    await fabricJar(path.join(mods, 'lithium.jar.disabled'), 'lithium')
    await writeFile(path.join(mods, 'broken.jar'), 'not a zip')
    await writeFile(path.join(mods, 'notes.txt'), 'ignored')

    const calls: { method: string; result?: unknown }[] = []
    const first = manager({ pool: recordingPool(calls) })
    const cold = await first.list(inst.id, 'mods')
    expect(cold.items.map((r) => [r.id, r.pending])).toEqual([
      ['broken.jar', true],
      ['lithium.jar', true],
      ['sodium.jar', true],
    ])
    await first.refresh(inst.id, 'mods')
    const warm = await first.list(inst.id, 'mods')
    expect(warm.items.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, pending: r.pending, problem: r.problem?.code ?? null }))).toEqual([
      { id: 'broken.jar', name: 'broken', enabled: true, pending: false, problem: 'invalid-zip' },
      { id: 'lithium.jar', name: 'LITHIUM', enabled: false, pending: false, problem: null },
      { id: 'sodium.jar', name: 'Sodium', enabled: true, pending: false, problem: null },
    ])
    const sodium = warm.items.find((r) => r.id === 'sodium.jar')
    expect(sodium?.authors).toEqual(['A', 'B', 'C'])
    expect(sodium?.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(events.some((e) => e.event === 'resources:changed')).toBe(true)
    expect((await db.query('meta.stats', {})).placements).toBe(3)

    // A fresh runtime (empty memory, same index): rows are complete immediately and nothing is re-read.
    calls.length = 0
    const second = manager({ pool: recordingPool(calls) })
    const instant = await second.list(inst.id, 'mods')
    expect(instant.items.filter((r) => r.pending)).toEqual([])
    expect(instant.items.map((r) => r.name)).toEqual(['broken', 'LITHIUM', 'Sodium'])
    await second.refresh(inst.id, 'mods')
    const scan = calls.find((c) => c.method === 'scanFolder')?.result as ScanFolderResult
    expect(scan.result.stats).toMatchObject({ total: 3, cached: 3, hashed: 0, parsed: 0 })
    expect(scan.upserts).toEqual([])

    // Renaming keeps the inode: the record moves without re-hashing.
    await rename(path.join(mods, 'sodium.jar'), path.join(mods, 'sodium.jar.disabled'))
    calls.length = 0
    await second.refresh(inst.id, 'mods')
    const moved = calls.find((c) => c.method === 'scanFolder')?.result as ScanFolderResult
    expect(moved.result.stats.hashed).toBe(0)
    expect(moved.deletes).toHaveLength(1)
    expect((await second.list(inst.id, 'mods')).items.find((r) => r.id === 'sodium.jar')?.enabled).toBe(false)
    first.dispose()
    second.dispose()
  })

  it('caches mod icons as thumbnails and only lists icons that are in the cache', async () => {
    const inst = await instances.create({ name: 'Icons', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const size = 512
    const rgba = new Uint8Array(size * size * 4).fill(200)
    const z = createZip(path.join(inst.path, 'mods', 'big.jar'))
    z.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'big', version: '1.0.0', icon: 'assets/big/icon.png' })), 'fabric.mod.json')
    z.addBuffer(encodePng({ width: size, height: size, rgba }), 'assets/big/icon.png')
    await z.finish()

    const first = manager()
    await first.list(inst.id, 'mods')
    await first.refresh(inst.id, 'mods')
    const iconUrl = (await first.list(inst.id, 'mods')).items[0]?.iconUrl
    expect(iconUrl).toMatch(/-t128\.png$/)
    const [icon] = await readdir(layout.icons)
    const thumb = decodePng(await readFile(path.join(layout.icons, icon!)))
    expect([thumb?.width, thumb?.height]).toEqual([128, 128])
    first.dispose()

    // A fresh runtime lists the cached icon at once; without the cache file it lists none until the scan re-extracts it.
    const second = manager()
    expect((await second.list(inst.id, 'mods')).items[0]?.iconUrl).toBe(iconUrl)
    second.dispose()
    await rm(layout.icons, { recursive: true })
    const third = manager()
    expect((await third.list(inst.id, 'mods')).items[0]?.iconUrl).toBeNull()
    await third.refresh(inst.id, 'mods')
    expect((await third.list(inst.id, 'mods')).items[0]?.iconUrl).toBe(iconUrl)
    third.dispose()
  })

  it('rescanning an unchanged folder hashes nothing and never retries an icon that cannot be read', async () => {
    const inst = await instances.create({ name: 'No Icon', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await jar(path.join(inst.path, 'mods', 'ghost.jar'), { 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'ghost', version: '1.0.0', icon: 'assets/ghost/icon.png' }) })
    const calls: { method: string; result?: unknown }[] = []
    const m = manager({ pool: recordingPool(calls) })
    await m.list(inst.id, 'mods')
    await m.refresh(inst.id, 'mods')
    expect(calls.filter((c) => c.method === 'extractIcons')).toHaveLength(1)
    expect((await m.list(inst.id, 'mods')).items[0]?.iconUrl).toBeNull()

    calls.length = 0
    await m.refresh(inst.id, 'mods')
    const scan = calls.find((c) => c.method === 'scanFolder')?.result as ScanFolderResult
    expect(scan.result.stats).toMatchObject({ total: 1, cached: 1, hashed: 0, parsed: 0 })
    expect(scan.missingIcons).toEqual([])
    expect(calls.map((c) => c.method)).toEqual(['scanFolder'])
    m.dispose()
  })

  it('enables and disables mods, resource packs and shader packs', async () => {
    const inst = await instances.create({ name: 'Toggle', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await fabricJar(path.join(inst.path, 'mods', 'a.jar'), 'a')
    await fabricJar(path.join(inst.path, 'mods', 'iris.jar'), 'iris')
    await jar(path.join(inst.path, 'resourcepacks', 'Faithful.zip'), { 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: 'x' } }) })
    await jar(path.join(inst.path, 'shaderpacks', 'BSL.zip'), { 'shaders/final.fsh': 'void main(){}' })
    await writeFile(path.join(inst.path, 'options.txt'), 'fov:0.5\nresourcePacks:["vanilla"]\n')
    const m = manager()

    expect(await m.setEnabled(inst.id, 'mods', ['a.jar'], false)).toEqual({ done: ['a.jar'], failed: [] })
    expect(await exists(path.join(inst.path, 'mods', 'a.jar.disabled'))).toBe(true)
    expect((await m.list(inst.id, 'mods')).items.find((r) => r.id === 'a.jar')?.enabled).toBe(false)
    await m.setEnabled(inst.id, 'mods', ['a.jar'], true)
    expect(await exists(path.join(inst.path, 'mods', 'a.jar'))).toBe(true)

    await m.setEnabled(inst.id, 'resourcepacks', ['faithful.zip'], true)
    expect(await readFile(path.join(inst.path, 'options.txt'), 'utf8')).toBe('fov:0.5\nresourcePacks:["vanilla","file/Faithful.zip"]\n')
    expect((await m.list(inst.id, 'resourcepacks')).items[0]?.enabled).toBe(true)

    await m.setEnabled(inst.id, 'shaderpacks', ['bsl.zip'], true)
    expect(await readFile(path.join(inst.path, 'config', 'iris.properties'), 'utf8')).toBe('shaderPack=BSL.zip\nenableShaders=true\n')
    expect((await m.list(inst.id, 'shaderpacks')).items[0]?.enabled).toBe(true)
    await expect(m.setEnabled(inst.id, 'saves', [], true)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    m.dispose()
  })

  it('reports rename failures per file and revalidates, so the UI matches the disk', async () => {
    const inst = await instances.create({ name: 'Gone', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await fabricJar(path.join(inst.path, 'mods', 'a.jar'), 'a')
    await fabricJar(path.join(inst.path, 'mods', 'b.jar'), 'b')
    const m = manager()
    await m.refresh(inst.id, 'mods')
    await rm(path.join(inst.path, 'mods', 'a.jar'))
    expect(await m.setEnabled(inst.id, 'mods', ['a.jar', 'b.jar'], false)).toEqual({ done: ['b.jar'], failed: [{ id: 'a.jar', code: 'ENOT_FOUND', message: expect.any(String) }] })
    expect((await m.list(inst.id, 'mods')).items.map((r) => [r.id, r.enabled])).toEqual([['b.jar', false]])
    m.dispose()
  })

  it('refuses to pick a shader pack without a shader mod and writes no config files', async () => {
    const inst = await instances.create({ name: 'NoShaderMod', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await jar(path.join(inst.path, 'shaderpacks', 'BSL.zip'), { 'shaders/final.fsh': 'void main(){}' })
    const m = manager()
    await expect(m.setEnabled(inst.id, 'shaderpacks', ['bsl.zip'], true)).rejects.toMatchObject({ code: 'ENO_SHADER_LOADER' })
    for (const f of ['optionsshaders.txt', 'config/iris.properties', 'config/oculus.properties']) expect(await exists(path.join(inst.path, f))).toBe(false)
    m.dispose()
  })

  it('coalesces bursts of watcher events into one rescan per folder', async () => {
    const inst = await instances.create({ name: 'Watched', runtime: { minecraft: '1.21.1' } })
    await fabricJar(path.join(inst.path, 'mods', 'a.jar'), 'a')
    let fire: ((rel: string | null) => void) | undefined
    let closed = 0
    const calls: { method: string }[] = []
    const m = manager({
      pool: recordingPool(calls),
      watchFactory: (_dir, onEvent) => {
        fire = onEvent
        return { close: () => closed++ }
      },
    })
    await m.list(inst.id, 'mods')
    await m.refresh(inst.id, 'mods')
    await m.watch(inst.id)
    await new Promise((r) => setTimeout(r, 50))
    calls.length = 0

    // Write the files first: under a loaded test run, writing between events can outlast the
    // 20 ms debounce and split the burst.
    for (let i = 0; i < 3; i++) await fabricJar(path.join(inst.path, 'mods', `new${i}.jar`), `n${i}`)
    for (let i = 0; i < 50; i++) {
      fire?.(`mods/new${i % 3}.jar`)
      fire?.('logs/latest.log')
    }
    await new Promise((r) => setTimeout(r, 150))
    // 100 raw events, one scan of mods; nothing for logs or for folders nobody listed.
    expect(calls.filter((c) => c.method === 'scanFolder')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'scanSaves')).toHaveLength(0)
    expect((await m.list(inst.id, 'mods')).items.map((r) => r.id)).toEqual(['a.jar', 'new0.jar', 'new1.jar', 'new2.jar'])
    const changed = events.findLast((e) => e.event === 'resources:changed')?.payload as Events['resources:changed']
    expect(changed.changed.toSorted()).toEqual(['new0.jar', 'new1.jar', 'new2.jar'])

    await m.unwatch(inst.id)
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
    m.dispose()
  })

  it('moves the watcher with the folder when an instance is renamed', async () => {
    const inst = await instances.create({ name: 'Before', runtime: { minecraft: '1.21.1' } })
    const watched: string[] = []
    const closed: string[] = []
    const m = manager({
      watchFactory: (dir) => {
        watched.push(dir)
        return { close: () => closed.push(dir) }
      },
    })
    await m.watch(inst.id)
    const renamed = await instances.rename(inst.id, 'After')
    expect(closed).toEqual([inst.path])
    expect(watched).toEqual([inst.path, renamed.path])
    m.dispose()
  })

  it('never blocks other calls while a scan runs, and scans are cancellable', async () => {
    const inst = await instances.create({ name: 'Slow', runtime: { minecraft: '1.21.1' } })
    await fabricJar(path.join(inst.path, 'mods', 'a.jar'), 'a')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const m = manager({ pool: recordingPool([], gate) })
    const page = await m.list(inst.id, 'mods')
    expect(page.scanning).toBe(true)
    // Other folders and the instance itself answer while the mods scan is stuck.
    expect((await m.list(inst.id, 'resourcepacks')).total).toBe(0)
    expect(instances.get(inst.id).name).toBe('Slow')
    await m.cancelScans(inst.id)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect((await m.list(inst.id, 'mods')).items[0]?.pending).toBe(true)
    m.dispose()
  })

  it('adds files through the content store, skipping identical ones, and deletes to the Trash', async () => {
    const inst = await instances.create({ name: 'Adder', runtime: { minecraft: '1.21.1' } })
    const other = await instances.create({ name: 'Other', runtime: { minecraft: '1.21.1' } })
    const src = path.join(root, 'downloads', 'cool mod.jar')
    await fabricJar(src, 'cool')
    const m = manager()
    expect(await m.add(inst.id, 'mods', [src])).toEqual({ done: ['cool mod.jar'], failed: [] })
    expect(await m.add(inst.id, 'mods', [src])).toEqual({ done: ['cool mod.jar'], failed: [] })
    expect(await readdir(path.join(inst.path, 'mods'))).toEqual(['cool mod.jar'])
    const rows = (await m.list(inst.id, 'mods')).items
    expect(await m.store.has(rows[0]?.sha1 ?? '')).toBe(true)
    const bad = await m.add(inst.id, 'mods', [path.join(root, 'nope.jar'), 'relative.jar'])
    expect(bad.failed.map((f) => f.code)).toEqual(['ENOENT', 'EINVALID_ARGUMENT'])

    expect(await m.addFromInstance(other.id, 'mods', inst.id, ['cool mod.jar'])).toEqual({ done: ['cool mod.jar'], failed: [] })
    expect(await readdir(path.join(other.path, 'mods'))).toEqual(['cool mod.jar'])

    expect(await m.delete(inst.id, 'mods', ['cool mod.jar', 'ghost.jar'])).toMatchObject({ done: ['cool mod.jar'], failed: [{ id: 'ghost.jar', code: 'ENOT_FOUND' }] })
    expect(trashed).toEqual([path.join(inst.path, 'mods', 'cool mod.jar')])
    expect((await m.list(inst.id, 'mods')).total).toBe(0)
    m.dispose()
  })

  it('lists worlds and backs them up, restores and prunes', async () => {
    const inst = await instances.create({ name: 'Worlds', runtime: { minecraft: '1.21.1' } })
    await world(path.join(inst.path, 'saves', 'My World'), 'Castle')
    const m = manager()
    await m.list(inst.id, 'saves')
    await m.refresh(inst.id, 'saves')
    const [row] = (await m.list(inst.id, 'saves')).items
    expect(row).toMatchObject({ id: 'my world', name: 'Castle', version: '1.21.1', world: { levelName: 'Castle', gameMode: 'creative', hardcore: false } })

    const backup = await m.createBackup(inst.id, 'my world')
    expect(backup).toMatchObject({ world: 'My World', worldName: 'Castle', reason: 'manual', automatic: false })
    expect(backup.id).toMatch(/^My World\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)
    expect(await m.listBackups(inst.id, 'my world')).toHaveLength(1)

    const restored = await m.restoreBackup(inst.id, backup.id)
    expect(restored.worldId).toMatch(/^my world \(restored /)
    expect((await m.list(inst.id, 'saves')).total).toBe(2)
    await expect(m.restoreBackup(inst.id, '../../etc/passwd')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await expect(m.deleteBackup(inst.id, 'My World/../../x')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })

    await m.deleteBackup(inst.id, backup.id)
    expect(await m.listBackups(inst.id)).toEqual([])

    const out = path.join(root, 'exports', 'Castle.zip')
    await mkdir(path.dirname(out), { recursive: true })
    const exported = await m.exportWorld(inst.id, 'my world', out)
    expect(exported.path).toBe(out)
    expect(exported.size).toBeGreaterThan(0)
    await expect(m.exportWorld(inst.id, 'my world', path.join(inst.path, 'saves', 'My World', 'x.zip'))).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await expect(m.exportWorld(inst.id, 'ghost', out)).rejects.toMatchObject({ code: 'ENOT_FOUND' })
    m.dispose()
  })

  it('sets deleted files aside for Undo, then sends them to the Trash', async () => {
    const inst = await instances.create({ name: 'Undo', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await fabricJar(path.join(inst.path, 'mods', 'a.jar'), 'a')
    await fabricJar(path.join(inst.path, 'mods', 'b.jar.disabled'), 'b')
    const m = new ResourceManager({
      layout,
      emit,
      host: { trash: async (p) => void trashed.push(p) },
      instances,
      db,
      pool,
      tasks,
      settings: { value: defaultSettings() },
      undoGraceMs: 60,
    })
    await m.refresh(inst.id, 'mods')
    const first = await m.delete(inst.id, 'mods', ['a.jar', 'b.jar'], { undoable: true })
    expect(first.done).toEqual(['a.jar', 'b.jar'])
    expect(first.undoToken).toMatch(/^[0-9a-f]{16}$/)
    expect((await m.list(inst.id, 'mods')).total).toBe(0)
    expect(trashed).toEqual([])

    // Undo restores both files under their names, the disabled one still disabled.
    expect(await m.undoDelete(inst.id, first.undoToken ?? '')).toEqual({ done: ['a.jar', 'b.jar'], failed: [] })
    expect((await readdir(path.join(inst.path, 'mods'))).toSorted()).toEqual(['a.jar', 'b.jar.disabled'])
    expect((await m.list(inst.id, 'mods')).items.map((r) => [r.id, r.enabled])).toEqual([
      ['a.jar', true],
      ['b.jar', false],
    ])
    await expect(m.undoDelete(inst.id, first.undoToken ?? '')).rejects.toMatchObject({ code: 'ENOT_FOUND' })

    // Without Undo, the window ends and the files go to the Trash under their own names.
    const second = await m.delete(inst.id, 'mods', ['a.jar'], { undoable: true })
    await new Promise((r) => setTimeout(r, 150))
    expect(trashed.map((p) => path.basename(p))).toEqual(['a.jar'])
    await expect(m.undoDelete(inst.id, second.undoToken ?? '')).rejects.toMatchObject({ code: 'ENOT_FOUND' })
    expect(await exists(path.join(inst.path, '.amethyst', 'trash', second.undoToken ?? ''))).toBe(false)

    // A plain delete trashes at once and offers nothing to undo.
    expect(await m.delete(inst.id, 'mods', ['b.jar'])).toMatchObject({ done: ['b.jar'], undoToken: null })
    m.dispose()
  })

  it('orders resource packs through options.txt and pages with filters', async () => {
    const inst = await instances.create({ name: 'Packs', runtime: { minecraft: '1.21.1' } })
    const packs = path.join(inst.path, 'resourcepacks')
    for (const name of ['A.zip', 'B.zip', 'C.zip']) await jar(path.join(packs, name), { 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: name } }) })
    await writeFile(path.join(inst.path, 'options.txt'), 'resourcePacks:["vanilla","file/A.zip"]\n')
    const m = manager()
    await m.refresh(inst.id, 'resourcepacks')
    await m.setPackOrder(inst.id, ['c.zip', 'a.zip'])
    expect(await readFile(path.join(inst.path, 'options.txt'), 'utf8')).toBe('resourcePacks:["vanilla","file/A.zip","file/C.zip"]\n')
    const rows = (await m.list(inst.id, 'resourcepacks')).items
    expect(rows.map((r) => [r.id, r.enabled, r.order ?? null, r.packFormats?.min ?? null])).toEqual([
      ['a.zip', true, 1, 34],
      ['b.zip', false, null, 34],
      ['c.zip', true, 0, 34],
    ])
    await expect(m.setPackOrder(inst.id, ['ghost.zip'])).rejects.toMatchObject({ code: 'ENOT_FOUND' })

    expect((await m.list(inst.id, 'resourcepacks', { direction: 'desc' })).items.map((r) => r.id)).toEqual(['c.zip', 'b.zip', 'a.zip'])
    expect((await m.list(inst.id, 'resourcepacks', { ids: ['b.zip', 'c.zip'] })).total).toBe(2)
    expect((await m.list(inst.id, 'resourcepacks', { sources: ['modrinth'] })).total).toBe(0)
    expect((await m.list(inst.id, 'resourcepacks', { sources: ['local'], offset: 1, limit: 1 })).items.map((r) => r.id)).toEqual(['b.zip'])
    m.dispose()
  })

  it('matches NFD pack names on disk to the NFC ids the game writes, and writes NFC ids', async () => {
    const inst = await instances.create({ name: 'Unicode', runtime: { minecraft: '1.21.1' } })
    const packs = path.join(inst.path, 'resourcepacks')
    const mcmeta = { 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: 'x' } }) }
    await jar(path.join(packs, 'Cafe\u0301.zip'), mcmeta)
    await jar(path.join(packs, 'Nin\u0303o.zip'), mcmeta)
    await writeFile(path.join(inst.path, 'options.txt'), 'resourcePacks:["vanilla","file/Caf\u00e9.zip"]\n')
    // The quick listing (from the index) and the full scan agree.
    const quick = manager()
    await quick.refresh(inst.id, 'resourcepacks')
    quick.dispose()
    const m = manager()
    const rows = (await m.list(inst.id, 'resourcepacks')).items
    expect(rows.filter((r) => !r.pending).map((r) => [r.id, r.enabled, r.order ?? null])).toEqual([
      ['caf\u00e9.zip', true, 0],
      ['ni\u00f1o.zip', false, null],
    ])
    await m.setEnabled(inst.id, 'resourcepacks', ['ni\u00f1o.zip'], true)
    expect(await readFile(path.join(inst.path, 'options.txt'), 'utf8')).toBe('resourcePacks:["vanilla","file/Caf\u00e9.zip","file/Ni\u00f1o.zip"]\n')
    await m.setEnabled(inst.id, 'resourcepacks', ['caf\u00e9.zip'], false)
    expect(await readFile(path.join(inst.path, 'options.txt'), 'utf8')).toBe('resourcePacks:["vanilla","file/Ni\u00f1o.zip"]\n')
    m.dispose()
  })

  it('removes index rows of files deleted outside the launcher on the next scan', async () => {
    const inst = await instances.create({ name: 'Stale', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const mods = path.join(inst.path, 'mods')
    await fabricJar(path.join(mods, 'a.jar'), 'a')
    await fabricJar(path.join(mods, 'b.jar'), 'b')
    const m = manager()
    await m.refresh(inst.id, 'mods')
    expect((await db.query('meta.stats', {})).placements).toBe(2)
    await rm(path.join(mods, 'a.jar'))
    // A new file may reuse the freed inode: it must not inherit a.jar's metadata.
    await fabricJar(path.join(mods, 'c.jar'), 'c')
    await m.refresh(inst.id, 'mods')
    expect((await db.query('meta.stats', {})).placements).toBe(2)
    expect((await m.list(inst.id, 'mods')).items.map((r) => [r.id, r.name])).toEqual([
      ['b.jar', 'B'],
      ['c.jar', 'C'],
    ])
    m.dispose()
  })

  it('finds duplicate, missing and incompatible mods', async () => {
    const inst = await instances.create({ name: 'Problems', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const mods = path.join(inst.path, 'mods')
    const fabric = (file: string, json: object) => jar(path.join(mods, file), { 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, version: '1.0.0', ...json }) })
    await fabric('lib.jar', { id: 'lib' })
    await fabric('lib-old.jar', { id: 'lib', version: '0.9.0' })
    await fabric('needs.jar', { id: 'needs', depends: { lib: '*', minecraft: '1.21.x', fabricloader: '>=0.15', 'fabric-api': '*', ghost: '*' } })
    await fabric('api-user.jar', { id: 'apiuser', depends: { 'fabric-api-base': '*' } })
    await fabric('fabric-api.jar', { id: 'fabric-api' })
    await fabric('enemy.jar', { id: 'enemy', breaks: { needs: '*' } })
    await writeFile(path.join(mods, 'damaged.jar'), 'not a zip')
    await jar(path.join(mods, 'forge-only.jar'), { 'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="forgeonly"\nversion="1.0"\n' })
    const m = manager()
    await m.refresh(inst.id, 'mods')
    const a = await m.analyze(inst.id)
    expect(a.duplicates).toEqual([{ modId: 'lib', ids: ['lib-old.jar', 'lib.jar'] }])
    expect(a.missing).toEqual([{ id: 'needs.jar', modId: 'ghost' }])
    expect(a.incompatible.map((i) => [i.id, i.reason, i.with ?? null])).toEqual([
      ['enemy.jar', 'conflict', 'needs.jar'],
      ['forge-only.jar', 'loader', null],
    ])
    expect(a.dependents['lib.jar']).toEqual(['needs.jar'])
    expect(a.dependents['fabric-api.jar']).toEqual(['needs.jar'])
    expect(a.broken.map((b) => b.id)).toEqual(['damaged.jar'])
    m.dispose()
  })
})
