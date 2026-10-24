import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallPlan, InstallResult, RunInstallOptions } from '@amethyst/installer'
import type { Events } from '@shared/events'
import { dataLayout, type DataLayout } from '../layout'
import { InstanceManager } from '../instances/service'
import { defaultSettings } from '../settings/schema'
import { TaskRegistry } from '../tasks/registry'
import { InstallManager, touchInstallLock } from './service'

let root: string
let layout: DataLayout
const emit = <K extends keyof Events>(_event: K, _payload: Events[K]) => {}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-install-'))
  layout = dataLayout(root)
})
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20))
  await rm(root, { recursive: true, force: true })
})

const plan = (versionId: string): InstallPlan => ({
  request: { minecraft: '1.20.1', loader: { kind: 'forge', version: '47.3.0' } },
  minecraft: { id: '1.20.1' },
  versionId,
  steps: [{ id: 'client', bytes: 1000, files: 1 }, { id: 'processors', needsJava: true }],
  totalBytes: 1000,
  javaMajor: 17,
  needsJava: true,
})

async function setup() {
  const tasks = new TaskRegistry(() => {}, { intervalMs: 0 })
  const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
  await instances.load()
  let finish!: () => void
  const gate = new Promise<void>((r) => (finish = r))
  const javaFor: number[] = []
  const runInstall = vi.fn<(p: InstallPlan, o: RunInstallOptions) => Promise<InstallResult>>(async (p, o) => {
    // Processors ask for a Java of the plan's major.
    await o.resolveJava?.(p.javaMajor)
    await gate
    const dir = path.join(layout.minecraft, 'versions', p.versionId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '.install-lock'), JSON.stringify({ schemaVersion: 1, version: p.versionId, timestamp: 1 }))
    return { versionId: p.versionId, minecraftVersion: '1.20.1', javaMajor: 17, loader: { kind: 'forge', version: '47.3.0' } }
  })
  const captured: unknown[][] = []
  const manager = new InstallManager({
    layout,
    emit,
    tasks,
    settings: { value: defaultSettings() },
    instances,
    java: {
      pathForMajor: async (major) => {
        javaFor.push(major)
        return `/java${major}/bin/java`
      },
      choose: async () => ({ result: { reason: 'no-valid-java', message: '', rosetta: false, ranked: [] }, policy: 'auto', willInstall: true }),
      requirementFor: async () => ({ component: 'java-runtime-gamma', majorVersion: 17, match: { kind: 'exact', major: 17 }, okay: { kind: 'any' } }),
    },
    meta: async () => ({}) as never,
    http: async () => ({}) as never,
    natives: { get: async () => ({ baseUrl: 'https://example.invalid/', artifacts: [] }) },
    telemetry: { capture: ((...args: unknown[]) => void captured.push(args)) as never },
    api: { planInstall: vi.fn<() => Promise<InstallPlan>>(async () => plan('1.20.1-forge-47.3.0')), runInstall },
  })
  instances.addHooks({ isBusy: (id) => manager.isBusy(id) })
  return { manager, instances, tasks, finish, runInstall, javaFor, captured }
}

describe('InstallManager', () => {
  it('runs as a task, keeps the instance busy, links the version and reports telemetry', async () => {
    const { manager, instances, tasks, finish, runInstall, javaFor, captured } = await setup()
    const inst = await instances.create({ name: 'Forge', runtime: { minecraft: '1.20.1', forge: '47.3.0' } })

    const p = manager.install(inst.id)
    const joined = manager.install(inst.id)
    await vi.waitFor(() => expect(runInstall).toHaveBeenCalledOnce())
    expect(manager.isBusy(inst.id)).toBe(true)
    expect(instances.get(inst.id).activity).toBe('installing')
    expect(manager.isVersionBusy('1.20.1-forge-47.3.0')).toBe(true)
    await expect(instances.rename(inst.id, 'Renamed')).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(instances.delete(inst.id)).rejects.toMatchObject({ code: 'EBUSY' })
    expect((await manager.status(inst.id)).installing).toBe(true)

    finish()
    const [a, b] = await Promise.all([p, joined])
    expect(a).toEqual(b)
    expect(a.versionId).toBe('1.20.1-forge-47.3.0')
    expect(runInstall).toHaveBeenCalledOnce()
    expect(javaFor).toEqual([17])
    expect(instances.get(inst.id)).toMatchObject({ versionId: '1.20.1-forge-47.3.0', activity: 'idle' })
    expect(await manager.status(inst.id)).toEqual({ versionId: '1.20.1-forge-47.3.0', installed: true, installing: false })
    expect(tasks.list().find((t) => t.name === 'install.run')).toMatchObject({ state: 'succeeded', instanceId: inst.id, params: { minecraft: '1.20.1', loader: 'forge' } })
    expect(captured[0]).toEqual(['install_completed', expect.objectContaining({ loader: 'forge', mcVersion: '1.20.1' })])
    await expect(instances.rename(inst.id, 'Renamed')).resolves.toMatchObject({ name: 'Renamed' })
  })

  it('does not link a version when the runtime changed during the install', async () => {
    const { manager, instances, finish } = await setup()
    const inst = await instances.create({ name: 'Changing', runtime: { minecraft: '1.20.1', forge: '47.3.0' } })
    const p = manager.install(inst.id)
    await vi.waitFor(() => expect(manager.isBusy(inst.id)).toBe(true))
    await instances.update(inst.id, { runtime: { forge: '47.3.1' } })
    finish()
    await p
    expect(instances.get(inst.id).versionId).toBe('')
  })

  it('moves the install lock forward after a repair', async () => {
    const dir = path.join(layout.minecraft, 'versions', 'v')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '.install-lock'), JSON.stringify({ schemaVersion: 1, version: 'v', timestamp: 5 }))
    await touchInstallLock(layout.minecraft, 'v')
    const lock = JSON.parse(await readFile(path.join(dir, '.install-lock'), 'utf8'))
    expect(lock).toMatchObject({ schemaVersion: 1, version: 'v' })
    expect(lock.timestamp).toBeGreaterThan(Date.now() - 5_000)
  })
})
