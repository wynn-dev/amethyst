import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Events } from '@shared/events'
import { dataLayout, type DataLayout } from '../layout'
import { TaskRegistry } from '../tasks/registry'
import { InstanceManager } from './service'

let root: string
let trash: string
let layout: DataLayout
let events: Events['instances:changed'][]
let trashed: string[]

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

function manager(): InstanceManager {
  return new InstanceManager({
    layout,
    emit: (event, payload) => {
      if (event === 'instances:changed') events.push(payload as Events['instances:changed'])
    },
    host: {
      trash: async (p) => {
        trashed.push(p)
        await rename(p, path.join(trash, `${path.basename(p)}-${trashed.length}`))
      },
    },
    tasks: new TaskRegistry(() => {}),
  })
}

const exists = (p: string) => lstat(p).then(() => true, () => false)

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-inst-'))
  trash = await mkdtemp(path.join(tmpdir(), 'amethyst-trash-'))
  layout = dataLayout(path.join(root, 'data'))
  events = []
  trashed = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(trash, { recursive: true, force: true })
})

describe('InstanceManager', () => {
  it('creates instances with unique names and folders, and reloads them', async () => {
    const m = manager()
    await m.load()
    const a = await m.create({ name: 'My Pack', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    const b = await m.create({ name: 'my pack', runtime: { minecraft: '1.20.1' } })
    const c = await m.create({ runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    expect(a.name).toBe('My Pack')
    expect(b.name).toBe('my pack (2)')
    expect(c.name).toBe('1.21.1-fabric0.16.5')
    expect(path.basename(a.path)).toBe('My Pack')
    expect(path.basename(b.path)).toBe('my pack (2)')
    expect(a.loader).toEqual({ kind: 'fabric', version: '0.16.5' })
    expect(await readdir(a.path)).toEqual(expect.arrayContaining(['.amethyst', 'mods', 'resourcepacks', 'shaderpacks']))
    expect(events.flatMap((e) => e.added)).toEqual([a.id, b.id, c.id])

    const again = manager()
    expect(await again.load()).toBe(3)
    expect(again.get(a.id)).toMatchObject({ name: 'My Pack', runtime: { minecraft: '1.21.1', fabric: '0.16.5' }, state: 'ok' })
  })

  it('validates input', async () => {
    const m = manager()
    await m.load()
    await expect(m.create({ name: 'x', runtime: { minecraft: '' } })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await expect(m.create({ name: 'x', runtime: { minecraft: '1.20.1', forge: '47.2.0', fabric: '0.15.0' } })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await expect(m.create({ name: 'a\u0000b', runtime: { minecraft: '1.20.1' } })).rejects.toMatchObject({ code: 'EINVALID_NAME' })
    await expect(m.create({ name: '.hidden', runtime: { minecraft: '1.20.1' } })).rejects.toMatchObject({ code: 'EINVALID_NAME' })
  })

  it('patches with null resets and clears the version pin when the runtime changes', async () => {
    const m = manager()
    await m.load()
    const inst = await m.create({ name: 'P', runtime: { minecraft: '1.20.1' }, overrides: { jvmArgs: ['-Dfoo="a b"'], memory: { mode: 'manual', minMB: 1024, maxMB: 4096 } } })
    let d = await m.update(inst.id, { versionId: '1.20.1', description: 'hello' })
    expect(d).toMatchObject({ versionId: '1.20.1', description: 'hello' })
    d = await m.update(inst.id, { runtime: { forge: '47.2.0' }, overrides: { jvmArgs: null }, description: null })
    expect(d.versionId).toBe('')
    expect(d.runtime.forge).toBe('47.2.0')
    expect(d.overrides).toEqual({ memory: { mode: 'manual', minMB: 1024, maxMB: 4096 } })
    expect(d.description).toBe('')
    await expect(m.update(inst.id, { createdAt: 5 } as never)).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await expect(m.update(inst.id, { overrides: { memory: { mode: 'manual', minMB: 8000, maxMB: 1000 } } })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    const disk = JSON.parse(await readFile(path.join(d.path, '.amethyst', 'instance.json'), 'utf8'))
    expect(disk).toMatchObject({ schemaVersion: 1, id: inst.id, runtime: { forge: '47.2.0' } })
    expect(disk.overrides).not.toHaveProperty('jvmArgs')
  })

  it('renames the folder with the display name, including case-only renames', async () => {
    const m = manager()
    await m.load()
    const inst = await m.create({ name: 'Alpha', runtime: { minecraft: '1.21' } })
    await writeFile(path.join(inst.path, 'mods', 'a.jar'), 'jar')
    const renamed = await m.rename(inst.id, 'Beta: Remix')
    expect(renamed.id).toBe(inst.id)
    expect(path.basename(renamed.path)).toBe('Beta_ Remix')
    expect(await exists(inst.path)).toBe(false)
    expect(await readFile(path.join(renamed.path, 'mods', 'a.jar'), 'utf8')).toBe('jar')

    const lower = await m.rename(inst.id, 'beta_ remix')
    expect(await readdir(layout.instances)).toEqual(['beta_ remix'])
    expect(lower.path).toBe(path.join(layout.instances, 'beta_ remix'))

    await m.create({ name: 'Gamma', runtime: { minecraft: '1.21' } })
    await expect(m.rename(inst.id, 'GAMMA')).rejects.toMatchObject({ code: 'ENAME_TAKEN', details: { suggestion: 'GAMMA (2)' } })
    // The metadata moved with the folder and survives a reload.
    const again = manager()
    await again.load()
    expect(again.get(inst.id)).toMatchObject({ name: 'beta_ remix', path: lower.path })
  })

  it('duplicates with fresh identity, keeping content and symlinks but not logs', async () => {
    const m = manager()
    await m.load()
    const src = await m.create({ name: 'Src', runtime: { minecraft: '1.21' }, upstream: { kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'BBBBBBBB' } })
    await m.markOpened(src.id)
    await writeFile(path.join(src.path, 'mods', 'm.jar'), 'mod')
    await mkdir(path.join(src.path, 'saves', 'World'), { recursive: true })
    await writeFile(path.join(src.path, 'saves', 'World', 'level.dat'), 'lvl')
    await mkdir(path.join(src.path, 'logs'))
    await writeFile(path.join(src.path, 'logs', 'latest.log'), 'log')
    await mkdir(path.join(src.path, '.amethyst', 'staging'), { recursive: true })
    await symlink('/tmp', path.join(src.path, 'linked'))

    const copy = await m.duplicate(src.id)
    expect(copy.id).not.toBe(src.id)
    expect(copy.name).toBe('Src (2)')
    expect(copy.upstream).toEqual(src.upstream)
    expect(copy.playTimeMs).toBe(0)
    expect(await readFile(path.join(copy.path, 'mods', 'm.jar'), 'utf8')).toBe('mod')
    expect(await readFile(path.join(copy.path, 'saves', 'World', 'level.dat'), 'utf8')).toBe('lvl')
    expect(await exists(path.join(copy.path, 'logs'))).toBe(false)
    expect(await exists(path.join(copy.path, '.amethyst', 'staging'))).toBe(false)
    expect(await readlink(path.join(copy.path, 'linked'))).toBe('/tmp')
    const meta = JSON.parse(await readFile(path.join(copy.path, '.amethyst', 'instance.json'), 'utf8'))
    expect(meta.id).toBe(copy.id)
  })

  it('deletes to the Trash after rescuing worlds, and only unregisters external instances', async () => {
    const m = manager()
    await m.load()
    const inst = await m.create({ name: 'Doomed', runtime: { minecraft: '1.21' } })
    await mkdir(path.join(inst.path, 'saves', 'Precious'), { recursive: true })
    await writeFile(path.join(inst.path, 'saves', 'Precious', 'level.dat'), 'x')
    const result = await m.delete(inst.id)
    expect(result.trashed).toBe(true)
    expect(result.rescuedWorlds).toHaveLength(1)
    expect(await readFile(path.join(result.rescuedWorlds[0]?.path ?? '', 'level.dat'), 'utf8')).toBe('x')
    expect(trashed).toEqual([inst.path])
    expect(m.list()).toEqual([])
    expect(events.at(-1)).toEqual({ added: [], updated: [], removed: [inst.id] })

    const ext = path.join(root, 'elsewhere', '.minecraft')
    await mkdir(path.join(ext, 'mods'), { recursive: true })
    await writeFile(path.join(ext, 'mods', 'x.jar'), 'jar')
    const imported = await m.import({ path: ext, mode: 'in-place', runtime: { minecraft: '1.12.2', forge: '14.23.5.2860' } })
    expect(imported.external).toBe(true)
    expect((await m.delete(imported.id)).trashed).toBe(false)
    expect(await exists(path.join(ext, 'mods', 'x.jar'))).toBe(true)
    expect(trashed).toHaveLength(1)
  })

  it('imports folders in place or by copy and detects the runtime from version JSONs', async () => {
    const m = manager()
    await m.load()
    const src = path.join(root, 'game')
    await mkdir(path.join(src, 'versions', '1.20.4'), { recursive: true })
    await mkdir(path.join(src, 'versions', 'fabric-loader-0.15.11-1.20.4'), { recursive: true })
    await writeFile(path.join(src, 'versions', '1.20.4', '1.20.4.json'), JSON.stringify({ id: '1.20.4' }))
    await writeFile(
      path.join(src, 'versions', 'fabric-loader-0.15.11-1.20.4', 'fabric-loader-0.15.11-1.20.4.json'),
      JSON.stringify({ id: 'fabric-loader-0.15.11-1.20.4', inheritsFrom: '1.20.4', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11' }] }),
    )
    await mkdir(path.join(src, 'mods'))
    await writeFile(path.join(src, 'mods', 'a.jar'), 'a')
    await writeFile(path.join(src, 'launcher_profiles.json'), '{}')

    const candidate = await m.inspectFolder(src)
    expect(candidate).toMatchObject({ check: 'ok', kind: 'game-dir', modCount: 1, runtime: { minecraft: '1.20.4', fabric: '0.15.11' } })
    expect((await m.inspectFolder('/')).check).toBe('is-volume-root')
    expect((await m.inspectFolder(path.join(root, 'nope'))).check).toBe('missing')

    const copied = await m.import({ path: src, mode: 'copy', runtime: { minecraft: '1.20.4', fabric: '0.15.11' } })
    expect(copied.external).toBe(false)
    expect(await readFile(path.join(copied.path, 'mods', 'a.jar'), 'utf8')).toBe('a')
    expect(await exists(path.join(copied.path, 'versions'))).toBe(false)
    expect(await exists(path.join(copied.path, 'launcher_profiles.json'))).toBe(false)
    expect((await m.inspectFolder(copied.path)).check).toBe('inside-managed-root')

    const inPlace = await m.import({ path: src, mode: 'in-place', runtime: { minecraft: '1.20.4', fabric: '0.15.11' } })
    expect((await m.inspectFolder(src)).check).toBe('already-registered')
    const again = manager()
    await again.load()
    expect(again.get(inPlace.id)).toMatchObject({ external: true, path: src, state: 'ok' })
  })

  it('lists unreadable metadata as broken without touching it, and repairs on request', async () => {
    const m = manager()
    await m.load()
    const inst = await m.create({ name: 'Fragile', runtime: { minecraft: '1.21' } })
    const meta = path.join(inst.path, '.amethyst', 'instance.json')
    await writeFile(meta, '{"id": "trunc')
    const reloaded = manager()
    await reloaded.load()
    const [row] = reloaded.list()
    expect(row).toMatchObject({ state: 'broken', name: 'Fragile' })
    expect(await readFile(meta, 'utf8')).toBe('{"id": "trunc')
    expect(() => reloaded.resolve(row?.id ?? '')).toThrow(/damaged/)
    const repaired = await reloaded.repair(row?.id ?? '', { minecraft: '1.21.1' })
    expect(repaired).toMatchObject({ state: 'ok', runtime: { minecraft: '1.21.1' } })
    expect((await readdir(path.dirname(meta))).some((n) => n.startsWith('instance.json.corrupt-'))).toBe(true)
  })

  it('stores icons by content and tracks play time', async () => {
    const m = manager()
    await m.load()
    const src = path.join(root, 'pic.bin')
    await writeFile(src, PNG)
    const inst = await m.create({ name: 'Iconic', runtime: { minecraft: '1.21' }, icon: { path: src } })
    expect(inst.iconUrl).toMatch(/^amethyst-asset:\/\/data\/instances\/Iconic\/icon\.png\?v=\d+$/)
    const cleared = await m.setIcon(inst.id, null)
    expect(cleared.iconUrl).toBeNull()
    expect(await exists(path.join(inst.path, 'icon.png'))).toBe(false)
    await m.recordPlaySession(inst.id, 1000, 61_000)
    await m.recordPlaySession(inst.id, 100_000, 50_000)
    expect(m.get(inst.id)).toMatchObject({ playTimeMs: 60_000, lastPlayedAt: 100_000 })
  })
})
