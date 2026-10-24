import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionManifest } from '@amethyst/installer'
import type { Events } from '@shared/events'
import { dataLayout, type DataLayout } from '../layout'
import { InstanceManager } from '../instances/service'
import { TaskRegistry } from '../tasks/registry'
import { VersionsManager, type VersionsMeta } from './service'

let root: string
let layout: DataLayout
let events: Events['versions:changed'][]
const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  if (event === 'versions:changed') events.push(payload as Events['versions:changed'])
}

const manifest = (ids: string[]): VersionManifest => ({
  latest: { release: ids[0] as string, snapshot: ids[0] as string },
  versions: ids.map((id) => ({ id, type: id.includes('w') ? 'snapshot' : 'release', url: `https://example.invalid/${id}.json`, time: '', releaseTime: '2024-01-01T00:00:00Z', sha1: 'a'.repeat(40) })),
})

/** A metadata client whose cached answers and forced refreshes are scripted. */
function fakeMeta() {
  let cached = manifest(['1.21.1', '24w14a', '1.20.1'])
  let remote = cached
  const calls: string[] = []
  let gate: Promise<void> = Promise.resolve()
  const meta: VersionsMeta = {
    minecraftManifest: vi.fn<(o?: { force?: boolean }) => Promise<{ data: VersionManifest; fetchedAt: number; stale: boolean }>>(async (o) => {
      calls.push(o?.force ? 'manifest:force' : 'manifest')
      if (o?.force) {
        await gate
        cached = remote
      }
      return { data: cached, fetchedAt: 0, stale: false }
    }),
    loaderGameVersions: vi.fn<VersionsMeta['loaderGameVersions']>(async () => [{ version: '1.21.1', stable: true }]),
    loaderVersions: vi.fn<VersionsMeta['loaderVersions']>(async () => [
      { version: '0.16.5', maven: 'net.fabricmc:fabric-loader:0.16.5', stable: true },
      { version: '0.16.4', maven: 'net.fabricmc:fabric-loader:0.16.4', stable: true },
    ]),
    forgeVersions: vi.fn<VersionsMeta['forgeVersions']>(async () => [{ minecraft: '1.20.1', version: '47.3.0', artifactVersion: '1.20.1-47.3.0', latest: true, recommended: true }]),
    neoForgeVersions: vi.fn<VersionsMeta['neoForgeVersions']>(async () => [{ minecraft: '1.21.1', version: '21.1.65', artifactVersion: '21.1.65', project: 'neoforge' as const, prerelease: false }]),
  }
  return {
    meta,
    calls,
    setRemote: (ids: string[]) => (remote = manifest(ids)),
    hold: () => {
      let release!: () => void
      gate = new Promise((r) => (release = r))
      return release
    },
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-versions-'))
  layout = dataLayout(root)
  events = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function manager(meta: VersionsMeta) {
  const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks: new TaskRegistry(() => {}) })
  await instances.load()
  const metaFactory = vi.fn<() => Promise<VersionsMeta>>(async () => meta)
  return { versions: new VersionsManager({ layout, emit, instances, meta: metaFactory }), metaFactory, instances }
}

describe('VersionsManager', () => {
  it('touches nothing until a list is requested (never on the boot path)', async () => {
    const f = fakeMeta()
    const { metaFactory } = await manager(f.meta)
    await new Promise((r) => setTimeout(r, 10))
    expect(metaFactory).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
  })

  it('serves the cached list at once and revalidates it in the background', async () => {
    const f = fakeMeta()
    const { versions } = await manager(f.meta)
    const release = f.hold()
    f.setRemote(['1.21.2', '1.21.1', '24w14a', '1.20.1'])

    const first = await versions.listMinecraft()
    // Answered from the cache although the refresh is still blocked on the "network".
    expect(first.items.map((v) => v.id)).toEqual(['1.21.1', '1.20.1'])
    expect(first.stale).toBe(true)
    expect(f.calls).toEqual(['manifest', 'manifest:force'])
    expect(events).toEqual([])

    release()
    await vi.waitFor(() => expect(events).toEqual([{ lists: ['minecraft'] }]))
    const second = await versions.listMinecraft({ types: ['release', 'snapshot'] })
    expect(second.items.map((v) => v.id)).toEqual(['1.21.2', '1.21.1', '24w14a', '1.20.1'])
    expect(second.stale).toBe(false)
    // Fresh now: no second background refresh.
    expect(f.calls.filter((c) => c === 'manifest:force')).toHaveLength(1)
  })

  it('lists loader builds per Minecraft version', async () => {
    const f = fakeMeta()
    const { versions } = await manager(f.meta)
    expect((await versions.listLoaders('fabric', '1.21.1')).items).toEqual([
      { version: '0.16.5', stable: true, recommended: false, latest: true },
      { version: '0.16.4', stable: true, recommended: false, latest: false },
    ])
    expect((await versions.listLoaders('fabric', '1.7.10')).items).toEqual([])
    expect((await versions.listLoaders('forge', '1.20.1')).items).toEqual([{ version: '47.3.0', stable: true, recommended: true, latest: true }])
    expect((await versions.listLoaders('neoforge', '1.21.1')).items[0]).toMatchObject({ version: '21.1.65', stable: true })
  })

  it('lists installed versions and refuses to delete used ones', async () => {
    const f = fakeMeta()
    const { versions, instances } = await manager(f.meta)
    const write = async (id: string, json: object, lock = true) => {
      const dir = path.join(layout.minecraft, 'versions', id)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, ...json }))
      if (lock) await writeFile(path.join(dir, '.install-lock'), '{}')
    }
    await write('1.20.1', {})
    await write('1.20.1-forge-47.3.0', { inheritsFrom: '1.20.1', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.3.0' }] })
    await write('1.19.4', {}, false)
    const inst = await instances.create({ name: 'F', runtime: { minecraft: '1.20.1', forge: '47.3.0' } })
    await instances.update(inst.id, { versionId: '1.20.1-forge-47.3.0' })

    const rows = await versions.listInstalled()
    expect(rows.map((r) => [r.id, r.minecraft, r.loader?.kind ?? null, r.complete, r.usedBy.length, r.children])).toEqual([
      ['1.19.4', '1.19.4', null, false, 0, []],
      ['1.20.1', '1.20.1', null, true, 1, ['1.20.1-forge-47.3.0']],
      ['1.20.1-forge-47.3.0', '1.20.1', 'forge', true, 1, []],
    ])
    await expect(versions.deleteInstalled('1.20.1-forge-47.3.0')).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(versions.deleteInstalled('1.20.1')).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(versions.deleteInstalled('../x')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
    await versions.deleteInstalled('1.19.4')
    expect((await versions.listInstalled()).map((r) => r.id)).toEqual(['1.20.1', '1.20.1-forge-47.3.0'])
    expect(events.at(-1)).toEqual({ lists: ['installed', 'minecraft'] })
  })
})
