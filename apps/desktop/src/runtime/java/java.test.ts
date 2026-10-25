import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { javaRequirementFor, ProbeCache, type JavaRecord } from '@amethyst/java'
import type { Events } from '@shared/events'
import type { Settings } from '@shared/services'
import { dataLayout, type DataLayout } from '../layout'
import { InstanceManager } from '../instances/service'
import { defaultSettings } from '../settings/schema'
import { TaskRegistry } from '../tasks/registry'
import { JavaManager, type JavaApi } from './service'

let root: string
let layout: DataLayout
let events: Events['java:changed'][]
const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  if (event === 'java:changed') events.push(payload as Events['java:changed'])
}

const record = (p: string, major: number, extra: Partial<JavaRecord> = {}): JavaRecord => ({
  path: p,
  realPath: p,
  javaHome: path.dirname(path.dirname(p)),
  version: `${major}.0.1`,
  majorVersion: major,
  arch: 'arm64',
  source: 'homebrew',
  managed: false,
  valid: true,
  verified: true,
  mtimeMs: 1,
  size: 1,
  probedAt: Date.now(),
  ...extra,
})

const SYSTEM_21 = record('/opt/homebrew/opt/openjdk@21/bin/java', 21)
const MANAGED_21 = record('/data/runtimes/java-runtime-delta/bin/java', 21, { managed: true, source: 'managed' })
const ROSETTA_17 = record('/Library/Java/JavaVirtualMachines/x64-17/Contents/Home/bin/java', 17, { arch: 'x64', source: 'system' })

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-java-'))
  layout = dataLayout(root)
  events = []
})
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20))
  await rm(root, { recursive: true, force: true })
})

async function setup(records: JavaRecord[], settingsPatch: Partial<Settings['game']['java']> = {}, api: Partial<JavaApi> = {}) {
  const tasks = new TaskRegistry(() => {}, { intervalMs: 0 })
  const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
  await instances.load()
  const settings = { value: defaultSettings() }
  Object.assign(settings.value.game.java, settingsPatch)
  const discoverJava = vi.fn<JavaApi['discoverJava']>(async () => records)
  const installJavaRuntime = vi.fn<JavaApi['installJavaRuntime']>(async (request) => {
    const java = record(`/data/runtimes/new-${request.majorVersion}/bin/java`, request.majorVersion, { managed: true, source: 'managed' })
    return { java, runtime: {} as never, reused: false, choice: { source: 'zulu', majorVersion: request.majorVersion, reason: '' } }
  })
  const java = new JavaManager({
    layout,
    emit,
    settings,
    tasks,
    instances,
    http: async () => ({}) as never,
    api: {
      discoverJava,
      listManagedRuntimes: async () => [],
      probeJava: async (p) => records.find((r) => r.path === p) ?? record(p, 21, { managed: true, source: 'managed' }),
      installJavaRuntime,
      ...api,
    },
  })
  await java.rescan()
  return { java, instances, tasks, discoverJava, installJavaRuntime, settings }
}

const req21 = javaRequirementFor({ javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }, minecraftVersion: '1.21.1' })

describe('JavaManager', () => {
  it('lists discovered runtimes and announces scans', async () => {
    const { java, discoverJava } = await setup([SYSTEM_21, MANAGED_21])
    expect(discoverJava).toHaveBeenCalledWith(expect.objectContaining({ runtimesDir: layout.runtimes, spawn: 'fallback' }))
    expect((await java.list()).map((r) => [r.path, r.managed])).toEqual([
      [MANAGED_21.path, true],
      [SYSTEM_21.path, false],
    ])
    expect(events).toEqual([{ scanning: true }, { scanning: false }])
  })

  it('auto uses a managed runtime, prefer-installed a system JDK, custom its path', async () => {
    const auto = await setup([SYSTEM_21, MANAGED_21])
    expect((await auto.java.choose({ requirement: req21 })).result.java?.path).toBe(MANAGED_21.path)

    const preferInstalled = await setup([SYSTEM_21, MANAGED_21], { policy: 'prefer-installed' })
    expect((await preferInstalled.java.choose({ requirement: req21 })).result.java?.path).toBe(SYSTEM_21.path)

    const custom = await setup([SYSTEM_21, MANAGED_21], { policy: 'custom', path: SYSTEM_21.path })
    expect((await custom.java.choose({ requirement: req21 })).result).toMatchObject({ reason: 'preferred', java: { path: SYSTEM_21.path } })
  })

  it('honours a pinned path, and falls back when it is gone', async () => {
    const { java } = await setup([SYSTEM_21, MANAGED_21])
    expect(await java.choose({ requirement: req21, pinnedPath: SYSTEM_21.path })).toMatchObject({ policy: 'pinned', result: { reason: 'pinned' } })
    const fallback = await java.choose({ requirement: req21, pinnedPath: '/nope/bin/java' })
    expect(fallback.result).toMatchObject({ pinnedUnavailable: true, java: { path: MANAGED_21.path } })
  })

  it('installs a managed runtime when only a Rosetta JVM matches', async () => {
    const { java, installJavaRuntime, tasks } = await setup([ROSETTA_17], { policy: 'prefer-installed' })
    const req17 = javaRequirementFor({ javaVersion: { majorVersion: 17 }, minecraftVersion: '1.20.1' })
    expect((await java.choose({ requirement: req17 })).willInstall).toBe(true)
    const choice = await java.forLaunch({ requirement: req17 })
    expect(choice.installed).toBe(true)
    expect(choice.java.path).toBe('/data/runtimes/new-17/bin/java')
    expect(installJavaRuntime).toHaveBeenCalledWith(expect.objectContaining({ majorVersion: 17 }), expect.objectContaining({ runtimesDir: layout.runtimes }))
    expect(tasks.list().find((t) => t.name === 'java.install')?.state).toBe('succeeded')
  })

  it('throws EJAVA_REQUIRED with the major when nothing can be installed', async () => {
    const { java } = await setup([], {}, {
      installJavaRuntime: async () => {
        throw new Error('offline')
      },
    })
    await expect(java.forLaunch({ requirement: req21 })).rejects.toMatchObject({ code: 'EJAVA_REQUIRED', details: { major: 21 } })
  })

  it('picks or installs an exact major for Forge processors', async () => {
    const { java, installJavaRuntime } = await setup([SYSTEM_21])
    expect(await java.pathForMajor(21)).toBe(SYSTEM_21.path)
    expect(await java.pathForMajor(17)).toBe('/data/runtimes/new-17/bin/java')
    expect(installJavaRuntime).toHaveBeenCalledOnce()
  })

  it('does not offer cached runtimes whose binary was deleted or replaced before the first scan', async () => {
    const kept = path.join(root, 'jdk-21', 'bin', 'java')
    const changed = path.join(root, 'jdk-17', 'bin', 'java')
    await mkdir(path.dirname(kept), { recursive: true })
    await mkdir(path.dirname(changed), { recursive: true })
    await writeFile(kept, 'x')
    await writeFile(changed, 'x')
    const [a, b] = await Promise.all([stat(kept), stat(changed)])
    const cached = [
      record(kept, 21, { mtimeMs: a.mtimeMs, size: a.size }),
      record(changed, 17, { mtimeMs: b.mtimeMs, size: b.size + 1 }),
      record(path.join(root, 'deleted', 'bin', 'java'), 25),
    ]
    await new ProbeCache(cached).save(layout.javaProbeCache)
    const java = new JavaManager({
      layout,
      emit,
      settings: { value: defaultSettings() },
      tasks: new TaskRegistry(() => {}, { intervalMs: 0 }),
      instances: { resolve: () => ({}) as never },
      http: async () => ({}) as never,
    })
    expect((await java.list()).map((r) => r.path)).toEqual([kept])
  })

  it('hides removed runtimes and keeps user-added paths', async () => {
    const { java } = await setup([SYSTEM_21, MANAGED_21])
    await java.removePath(SYSTEM_21.path)
    expect((await java.list()).map((r) => r.path)).toEqual([MANAGED_21.path])
    const second = await setup([SYSTEM_21, MANAGED_21])
    // The hidden set is persisted and passed to discovery.
    expect(second.discoverJava).toHaveBeenCalledWith(expect.objectContaining({ hidden: [SYSTEM_21.path] }))
  })
})
