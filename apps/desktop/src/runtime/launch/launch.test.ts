import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameProcess, LaunchCommand, LaunchResult, LogEvent, NativesPlan } from '@amethyst/game'
import type { JavaRecord } from '@amethyst/java'
import type { Events } from '@shared/events'
import { defaultSettings } from '../settings/schema'
import { dataLayout, type DataLayout } from '../layout'
import { InstanceManager } from '../instances/service'
import { JavaManager } from '../java/service'
import { TaskRegistry } from '../tasks/registry'
import { AppError } from '../util/errors'
import { isBenignLegacyExit, LaunchManager, type GameApi, type LaunchDeps } from './service'

let root: string
let layout: DataLayout
let events: { event: keyof Events; payload: unknown }[]

const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  events.push({ event, payload })
}
const states = (instanceId?: string) =>
  events.filter((e) => e.event === 'launch:state' && (!instanceId || (e.payload as Events['launch:state']).instanceId === instanceId)).map((e) => e.payload as Events['launch:state'])
const steps = (instanceId?: string) => states(instanceId).flatMap((s) => (s.state === 'preparing' ? [s.step] : []))

const JAVA: JavaRecord = {
  path: '/opt/java/bin/java',
  realPath: '/opt/java/bin/java',
  javaHome: '/opt/java',
  version: '21.0.5',
  majorVersion: 21,
  arch: 'arm64',
  source: 'managed',
  managed: true,
  valid: true,
  verified: true,
  mtimeMs: 1,
  size: 1,
  probedAt: Date.now(),
}

const requirement = { component: 'java-runtime-delta', majorVersion: 21, match: { kind: 'atLeast' as const, major: 21 }, okay: { kind: 'any' as const } }

function modernJson(id: string) {
  return { id, type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '17', libraries: [], downloads: { client: { url: 'https://example.invalid/client.jar', sha1: 'a'.repeat(40), size: 10 } }, javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }, arguments: { game: [], jvm: [] } }
}

function legacyJson(id: string) {
  return {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name}',
    assets: '1.8',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
    downloads: { client: { url: 'https://example.invalid/client.jar', sha1: 'b'.repeat(40), size: 10 } },
    libraries: [
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.2-nightly-20140822',
        natives: { linux: 'natives-linux', osx: 'natives-osx', windows: 'natives-windows' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          classifiers: {
            'natives-osx': {
              path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.2-nightly-20140822/lwjgl-platform-2.9.2-nightly-20140822-natives-osx.jar',
              sha1: 'c'.repeat(40),
              size: 10,
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.2-nightly-20140822/lwjgl-platform-2.9.2-nightly-20140822-natives-osx.jar',
            },
          },
        },
      },
    ],
  }
}

async function writeVersion(json: { id: string }, installed = true): Promise<void> {
  const dir = path.join(layout.minecraft, 'versions', json.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${json.id}.json`), JSON.stringify(json))
  if (installed) await writeFile(path.join(dir, '.install-lock'), JSON.stringify({ schemaVersion: 1, version: json.id, timestamp: Date.now() }))
}

/** A fake game process the test ends by calling `exit`. */
function fakeProcess(options: { onLog?: (e: LogEvent[]) => void; onReady?: () => void }) {
  let resolve!: (r: LaunchResult) => void
  const exited = new Promise<LaunchResult>((r) => (resolve = r))
  const startedAt = Date.now()
  let killed = false
  const exit = (r: Partial<LaunchResult> = {}) =>
    resolve({ exitCode: 0, signal: null, crashed: false, killed, ready: true, durationMs: Date.now() - startedAt, ...r })
  const proc: GameProcess = {
    pid: 4242,
    startedAt,
    ready: false,
    exited,
    kill: async () => {
      killed = true
      exit({ exitCode: null, signal: 'SIGTERM', killed: true })
      return exited
    },
  }
  return { proc, exit, log: (lines: string[]) => options.onLog?.(lines.map((message) => ({ time: Date.now(), level: 'INFO', message, stream: 'stdout', format: 'plain' }))), ready: () => options.onReady?.() }
}

interface Harness {
  launch: LaunchManager
  instances: InstanceManager
  tasks: TaskRegistry
  installCalls: string[]
  game: { current?: ReturnType<typeof fakeProcess> }
  calls: string[]
  deps: LaunchDeps
}

async function harness(overrides: Partial<LaunchDeps> = {}, game: Partial<GameApi> = {}): Promise<Harness> {
  const tasks = new TaskRegistry(() => {}, { intervalMs: 0 })
  const host = { trash: async (p: string) => rm(p, { recursive: true, force: true }) }
  const instances = new InstanceManager({ layout, emit, host, tasks })
  await instances.load()
  const settings = { value: defaultSettings() }
  const installCalls: string[] = []
  const calls: string[] = []
  const current: Harness['game'] = {}
  const plan = { ok: true, issues: [], warnings: [], jvmArch: 'arm64', libraries: [], classpath: [], extract: [], replacements: [], revision: 1, platform: { name: 'osx', version: '13.0', arch: 'arm64' } } as unknown as NativesPlan
  const command: LaunchCommand = { java: JAVA.path, args: [], wrapper: [], cwd: root, env: {}, secrets: [], warnings: [], natives: plan, nativesDir: root, classpath: [], features: {} }
  const deps: LaunchDeps = {
    layout,
    emit,
    settings,
    tasks,
    version: '1.0.0',
    instances,
    install: {
      isBusy: () => false,
      install: async (id) => {
        installCalls.push(id)
        await writeVersion(modernJson('1.21.1'))
        return { versionId: '1.21.1', durationMs: 1, bytes: 0 }
      },
    },
    java: {
      requirementFor: async () => requirement,
      forLaunch: async () => ({ java: JAVA, requirement, installed: false, result: { java: JAVA, reason: 'exact-major', message: '', rosetta: false, ranked: [] } }),
    },
    accounts: async () => ({
      list: () => [{ id: 'offline:1', kind: 'offline', name: 'Steve', uuid: '1', selected: true, status: 'ok', avatarUrl: null, skin: null, cape: null }],
      sessionForLaunch: async () => {
        calls.push('session')
        return { id: 'offline:1', kind: 'offline', username: 'Steve', uuid: '00000000-0000-0000-0000-000000000001', accessToken: 'tok', accessTokenExpiresAt: Infinity, skins: [], capes: [] }
      },
    }),
    natives: { get: async () => ({ baseUrl: 'https://example.invalid/', artifacts: [] }) },
    http: async () => ({}) as never,
    host: { setLauncherHidden: async (hidden) => void calls.push(hidden ? 'hide' : 'show') },
    telemetry: { capture: ((event: string) => void calls.push(`telemetry:${event}`)) as never, redact: (v: string) => void calls.push(`redact:${v}`), reportError: () => {} },
    game: {
      planNatives: (() => plan) as never,
      diagnose: async () => [],
      extractNatives: async () => ({ dir: root, extracted: false, files: [] }),
      prepareLegacyAssets: async () => ({ linked: 0, existing: 0, missing: [], rejected: [] }),
      buildLaunchCommand: async () => command,
      launch: async (_cmd, options) => {
        calls.push('spawn')
        current.current = fakeProcess(options ?? {})
        return current.current.proc
      },
      ...game,
    },
    logBatchMs: 0,
    ...overrides,
  }
  return { launch: new LaunchManager(deps), instances, tasks, installCalls, game: current, calls, deps }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-launch-'))
  layout = dataLayout(path.join(root, 'data'))
  events = []
})

afterEach(async () => {
  // Let pending play-time writes land before removing the folder.
  await new Promise((r) => setTimeout(r, 20))
  await rm(root, { recursive: true, force: true })
})

/** Accounts whose session refresh never settles. */
const hung = () =>
  Promise.resolve({
    list: () => [{ id: 'm:1', kind: 'microsoft', name: 'A', uuid: '1', selected: true, status: 'ok', avatarUrl: null, skin: null, cape: null }],
    sessionForLaunch: () => new Promise<never>(() => {}),
  }) as never

describe('LaunchManager pipeline', () => {
  it('runs the steps in order and reports running, ready and exit', async () => {
    const h = await harness()
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'A', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })

    const started = await h.launch.launch(inst.id)
    expect(started.pid).toBe(4242)
    expect(started.clickToSpawnMs).toBeGreaterThanOrEqual(0)
    expect(steps(inst.id)).toEqual(['resolve', 'java', 'natives', 'verify', 'account', 'build', 'spawn'])
    expect(h.installCalls).toEqual([])
    expect(h.instances.get(inst.id).activity).toBe('running')
    expect(h.launch.listRunning()).toMatchObject([{ instanceId: inst.id, phase: 'running', pid: 4242 }])
    expect(h.calls).toContain('redact:Steve')
    expect(h.calls).toContain('telemetry:launch_started')
    expect(h.calls).toContain('telemetry:perf_launch')

    h.game.current?.ready()
    expect(states(inst.id).at(-1)).toMatchObject({ state: 'running', ready: true })
    expect(h.calls).toContain('hide')

    h.game.current?.exit({ exitCode: 0 })
    await vi.waitFor(() => expect(states(inst.id).at(-1)).toMatchObject({ state: 'exited', code: 0, crashed: false }))
    expect(h.instances.get(inst.id).activity).toBe('idle')
    expect(h.calls).toContain('show')
    expect(h.calls).toContain('telemetry:launch_exited')
    await vi.waitFor(() => expect(h.instances.get(inst.id).lastPlayedAt).toBeGreaterThan(0))
    expect(h.launch.listRunning()).toEqual([])
  })

  it('does not report a crash for a legacy (LWJGL 2) game quitting normally with a non-zero code', async () => {
    const lwjgl2Plan = { ok: true, issues: [], warnings: [], jvmArch: 'arm64', lwjgl: 2, libraries: [], classpath: [], extract: [], replacements: [], revision: 1, platform: { name: 'osx', version: '13.0', arch: 'arm64' } } as unknown as NativesPlan
    const h = await harness({}, { planNatives: (() => lwjgl2Plan) as never })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'Old', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await h.launch.launch(inst.id)
    h.game.current?.exit({ exitCode: 255, crashed: true, ready: true })
    await vi.waitFor(() => expect(states(inst.id).at(-1)).toMatchObject({ state: 'exited', code: 255, crashed: false }))

    // A crash report printed to the output still counts.
    await h.launch.launch(inst.id)
    h.game.current?.log(['---- Minecraft Crash Report ----', '// Oops.'])
    h.game.current?.exit({ exitCode: 255, crashed: true, ready: true })
    await vi.waitFor(() => expect(states(inst.id).at(-1)).toMatchObject({ state: 'exited', code: 255, crashed: true }))

    const base: LaunchResult = { exitCode: 1, signal: null, crashed: true, killed: false, ready: true, durationMs: 1 }
    expect(isBenignLegacyExit(base, 2)).toBe(true)
    expect(isBenignLegacyExit(base, 3)).toBe(false)
    expect(isBenignLegacyExit({ ...base, ready: false }, 2)).toBe(false)
    expect(isBenignLegacyExit({ ...base, crashReportPath: '/x/crash-reports/a.txt' }, 2)).toBe(false)
    expect(isBenignLegacyExit({ ...base, hsErrPath: '/x/hs_err_pid1.log' }, 2)).toBe(false)
    expect(isBenignLegacyExit({ ...base, nativeLoadError: 'architecture' }, 2)).toBe(false)
    expect(isBenignLegacyExit({ ...base, exitCode: null, signal: 'SIGSEGV' }, 2)).toBe(false)
  })

  it('installs first when the version is missing, and repairs before spawning', async () => {
    const issue = { kind: 'asset' as const, name: 'a', path: path.join(root, 'x'), problem: 'missing' as const, expected: { sha1: 'a'.repeat(40) }, url: 'https://example.invalid/a' }
    const installMissing = vi.fn<() => Promise<{ repaired: string[]; unresolved: never[] }>>(async () => ({ repaired: [issue.path], unresolved: [] }))
    const h = await harness({}, { diagnose: async () => [issue], installMissing: installMissing as never })
    const inst = await h.instances.create({ name: 'B', runtime: { minecraft: '1.21.1' } })
    await h.launch.launch(inst.id)
    expect(steps(inst.id)).toEqual(['resolve', 'install', 'java', 'natives', 'verify', 'repair', 'account', 'build', 'spawn'])
    expect(h.installCalls).toEqual([inst.id])
    expect(installMissing).toHaveBeenCalledOnce()
    expect(h.tasks.list().some((t) => t.name === 'launch.repair' && t.state === 'succeeded')).toBe(true)
    h.game.current?.exit()
    await vi.waitFor(() => expect(states(inst.id).at(-1)?.state).toBe('exited'))
    await h.instances.flush()
  })

  it('runs the pre-launch command and fails with EPRELAUNCH_FAILED on a non-zero exit', async () => {
    const preLaunch = vi.fn<() => Promise<{ code: number; stderr: string }>>(async () => ({ code: 3, stderr: 'nope' }))
    const h = await harness({ preLaunch })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'C', runtime: { minecraft: '1.21.1' }, overrides: { preLaunchCommand: 'exit 3' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await expect(h.launch.launch(inst.id)).rejects.toMatchObject({ code: 'EPRELAUNCH_FAILED' })
    expect(steps(inst.id)).toEqual(['resolve', 'java', 'natives', 'verify', 'account', 'prelaunch'])
    expect(states(inst.id).at(-1)).toMatchObject({ state: 'failed', code: 'EPRELAUNCH_FAILED' })
    expect(h.calls).not.toContain('spawn')
    expect(h.instances.get(inst.id).activity).toBe('idle')
  })

  it('fails with EJAVA_REQUIRED (with the major) when no Java can be provided', async () => {
    const tasks = new TaskRegistry(() => {}, { intervalMs: 0 })
    const settings = { value: defaultSettings() }
    const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
    await instances.load()
    const java = new JavaManager({
      layout,
      emit,
      settings,
      tasks,
      instances,
      http: async () => ({}) as never,
      api: {
        listManagedRuntimes: async () => [],
        installJavaRuntime: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND piston-meta.mojang.com'), { code: 'EHTTP' })
        },
      },
    })
    const h = await harness({ instances, tasks, java })
    await writeVersion(modernJson('1.21.1'))
    const inst = await instances.create({ name: 'D', runtime: { minecraft: '1.21.1' } })
    await instances.update(inst.id, { versionId: '1.21.1' })
    const error = await h.launch.launch(inst.id).catch((e: AppError) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'EJAVA_REQUIRED', details: { major: 21 } })
    expect(steps(inst.id)).toEqual(['resolve', 'java'])
    expect(states(inst.id).at(-1)).toMatchObject({ state: 'failed', code: 'EJAVA_REQUIRED' })
    expect(tasks.list().some((t) => t.name === 'java.install' && t.state === 'failed')).toBe(true)
  })

  it('fails with ENATIVES_UNAVAILABLE for LWJGL 2 when the natives manifest is unavailable', async () => {
    const { planNatives } = await import('@amethyst/game')
    const h = await harness(
      { natives: { get: async () => Promise.reject(new AppError('ENATIVES_UNAVAILABLE', 'Apple Silicon natives are not available right now')) } },
      { planNatives },
    )
    await writeVersion(legacyJson('1.8.9'))
    const inst = await h.instances.create({ name: 'E', runtime: { minecraft: '1.8.9' } })
    await h.instances.update(inst.id, { versionId: '1.8.9' })
    await expect(h.launch.launch(inst.id)).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
    expect(steps(inst.id)).toEqual(['resolve', 'java', 'natives'])
    expect(states(inst.id).at(-1)).toMatchObject({ state: 'failed', code: 'ENATIVES_UNAVAILABLE' })
  })

  it('fails with ENATIVES_UNAVAILABLE when the manifest lacks the needed artifact', async () => {
    const { planNatives } = await import('@amethyst/game')
    const h = await harness({}, { planNatives })
    await writeVersion(legacyJson('1.8.9'))
    const inst = await h.instances.create({ name: 'F', runtime: { minecraft: '1.8.9' } })
    await h.instances.update(inst.id, { versionId: '1.8.9' })
    const error = await h.launch.launch(inst.id).catch((e: AppError) => e)
    expect(error).toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
    expect((error as AppError).message).toMatch(/2\.9\.2-nightly-20140822/)
  })

  it('cancels a launch that is still preparing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = await harness({}, { diagnose: async () => (await gate, []) })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'G', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    const p = h.launch.launch(inst.id)
    await vi.waitFor(() => expect(steps(inst.id)).toContain('verify'))
    expect(h.launch.listRunning()).toMatchObject([{ phase: 'preparing', step: 'verify' }])
    await h.launch.kill(inst.id)
    release()
    await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' })
    expect(h.calls).not.toContain('spawn')
  })

  it('bounds a hung account refresh with ETIMEOUT, and a cancel during it is immediate', async () => {
    const h = await harness({ accounts: hung, accountTimeoutMs: 50 })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'T', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await expect(h.launch.launch(inst.id)).rejects.toMatchObject({ code: 'ETIMEOUT' })
    expect(states(inst.id).at(-1)).toMatchObject({ state: 'failed', code: 'ETIMEOUT' })

    const h2 = await harness({ accounts: hung, accountTimeoutMs: 60_000 })
    const p = h2.launch.launch(inst.id)
    await vi.waitFor(() => expect(steps(inst.id).at(-1)).toBe('account'))
    await h2.launch.kill(inst.id)
    await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' })
    expect(h2.calls).not.toContain('spawn')
  })

  it('cancels a launch that is still being prepared when the runtime shuts down', async () => {
    const h = await harness({ accounts: hung, accountTimeoutMs: 60_000 })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'Q', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    const p = h.launch.launch(inst.id)
    await vi.waitFor(() => expect(steps(inst.id).at(-1)).toBe('account'))
    h.launch.dispose()
    await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' })
    expect(h.calls).not.toContain('spawn')
  })
})

describe('LaunchManager logs', () => {
  it('buffers output, pages it, and pushes batches only while subscribed', async () => {
    const h = await harness({ logCapacity: 50 })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'L', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await h.launch.launch(inst.id)
    const game = h.game.current as ReturnType<typeof fakeProcess>

    game.log(['unseen 1', 'unseen 2'])
    await new Promise((r) => setTimeout(r, 5))
    expect(events.some((e) => e.event === 'launch:log')).toBe(false)

    h.launch.subscribeLog(inst.id)
    game.log(['hello', 'world'])
    await vi.waitFor(() => expect(events.some((e) => e.event === 'launch:log')).toBe(true))
    const batch = events.find((e) => e.event === 'launch:log')?.payload as Events['launch:log']
    expect(batch.lines.map((l) => l.text)).toEqual(['hello', 'world'])
    expect(batch.lines.map((l) => l.seq)).toEqual([2, 3])

    game.log(Array.from({ length: 100 }, (_, i) => `flood ${i}`))
    const page = h.launch.getLog(inst.id, { since: 0 })
    expect(page.lines).toHaveLength(50)
    expect(page.dropped).toBe(54)
    expect(page.lines.at(-1)?.text).toBe('flood 99')
    expect(h.launch.getLog(inst.id, { since: page.nextSeq }).lines).toEqual([])

    h.launch.unsubscribeLog(inst.id)
    game.exit()
    await vi.waitFor(() => expect(states(inst.id).at(-1)?.state).toBe('exited'))
    // The log of the last run stays readable after the exit.
    expect(h.launch.getLog(inst.id).running).toBe(false)
    expect(h.launch.getLog(inst.id).lines.length).toBe(50)
  })

  it('redacts the session token from game output lines', async () => {
    const secret = 'eyJsecretAccessToken123'
    const session = `token:${secret}:0123abcd`
    const plan = { ok: true, issues: [], warnings: [], jvmArch: 'arm64', libraries: [], classpath: [], extract: [], replacements: [], revision: 1, platform: { name: 'osx', version: '13.0', arch: 'arm64' } } as unknown as NativesPlan
    const command: LaunchCommand = { java: JAVA.path, args: ['--accessToken', secret], wrapper: [], cwd: root, env: {}, secrets: [secret, session], warnings: [], natives: plan, nativesDir: root, classpath: [], features: {} }
    const h = await harness({}, { buildLaunchCommand: async () => command })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'R', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await h.launch.launch(inst.id)
    h.launch.subscribeLog(inst.id)
    h.game.current?.log([`(Session ID is ${session})`, `args: --accessToken ${secret} --version 1.21.1`])
    await vi.waitFor(() => expect(events.some((e) => e.event === 'launch:log')).toBe(true))
    const batch = events.find((e) => e.event === 'launch:log')?.payload as Events['launch:log']
    const pushed = batch.lines.map((l) => l.text)
    const buffered = h.launch.getLog(inst.id).lines.map((l) => l.text)
    for (const texts of [pushed, buffered]) {
      expect(texts.join('\n')).not.toContain(secret)
      expect(texts).toEqual(['(Session ID is <redacted>)', 'args: --accessToken <redacted> --version 1.21.1'])
    }
    h.game.current?.exit()
  })
})

describe('busy hooks', () => {
  it('refuses to rename or delete an instance while its game runs', async () => {
    const h = await harness()
    h.instances.addHooks({ isBusy: (id) => h.launch.isActive(id) })
    await writeVersion(modernJson('1.21.1'))
    const inst = await h.instances.create({ name: 'Busy', runtime: { minecraft: '1.21.1' } })
    await h.instances.update(inst.id, { versionId: '1.21.1' })
    await h.launch.launch(inst.id)
    await expect(h.instances.rename(inst.id, 'Other')).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(h.instances.delete(inst.id)).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(h.launch.launch(inst.id)).rejects.toMatchObject({ code: 'EBUSY' })
    h.game.current?.exit()
    await vi.waitFor(() => expect(h.launch.isActive(inst.id)).toBe(false))
    await expect(h.instances.rename(inst.id, 'Other')).resolves.toMatchObject({ name: 'Other' })
  })
})
