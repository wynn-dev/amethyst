/**
 * Dev-only end-to-end check of the install and launch services, without Electron or the UI.
 *
 *   pnpm --filter @amethyst/desktop e2e:launch [case …]
 *
 * Drives the runtime managers directly in a temporary data root (or `AMETHYST_E2E_ROOT` to reuse
 * downloads between runs): for each case it creates an instance, installs it, launches it with an
 * offline account, waits for the game-ready signal (or 60 s), kills it, then launches it again to
 * measure click → spawn with everything installed. Needs the network and a display (the game
 * window opens). Cases: vanilla-1.21.1, fabric-1.20.1, forge-1.20.1, vanilla-1.16.5, vanilla-1.12.2,
 * vanilla-1.8.9, vanilla-1.7.10.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_LWJGL2_ARM64_SOURCE } from '@amethyst/game'
import { createMetadataClient } from '@amethyst/installer'
import { createHttpClient, setDefaultHttpClient } from '@amethyst/net'
import type { Events } from '@shared/events'
import type { HostServices, InstanceRuntime, LaunchStarted } from '@shared/services'
import { AccountManager } from '../src/runtime/accounts/service'
import { InstallManager } from '../src/runtime/install/service'
import { InstanceManager } from '../src/runtime/instances/service'
import { JavaManager } from '../src/runtime/java/service'
import { dataLayout } from '../src/runtime/layout'
import { LaunchManager } from '../src/runtime/launch/service'
import { Lwjgl2NativesSource } from '../src/runtime/launch/natives-source'
import { SettingsStore } from '../src/runtime/settings/service'
import { TaskRegistry } from '../src/runtime/tasks/registry'

interface Case {
  name: string
  runtime: Partial<InstanceRuntime> & { minecraft: string }
  /** A typed launch error that counts as a pass (e.g. natives not published yet). */
  acceptError?: string
}

const CASES: Case[] = [
  { name: 'vanilla-1.21.1', runtime: { minecraft: '1.21.1' } },
  // `latest`: the newest stable (Fabric) or recommended (Forge) build, looked up at run time.
  { name: 'fabric-1.20.1', runtime: { minecraft: '1.20.1', fabric: 'latest' } },
  { name: 'forge-1.20.1', runtime: { minecraft: '1.20.1', forge: 'latest' } },
  // TODO(natives): fails with "Failed to create window: GLFW error 65548: Cocoa: Regular windows do
  // not have icons on macOS". The LWJGL 3.3.1 GLFW reports glfwSetWindowIcon as an error and
  // Minecraft 1.13–1.18 treats any GLFW error during start-up as fatal. Needs the patched
  // lwjgl-glfw arm64 build (separate natives agent) wired into packages/game/src/natives/table.ts.
  { name: 'vanilla-1.16.5', runtime: { minecraft: '1.16.5' } },
  // LWJGL 2: the Amethyst-built arm64 natives of the natives-lwjgl2-v1 release.
  { name: 'vanilla-1.12.2', runtime: { minecraft: '1.12.2' } },
  { name: 'vanilla-1.8.9', runtime: { minecraft: '1.8.9' } },
  { name: 'vanilla-1.7.10', runtime: { minecraft: '1.7.10' } },
]

const READY_TIMEOUT_MS = 60_000
/**
 * Output that proves the game got past window and native set-up (OpenAL loaded, textures stitched).
 * The ready markers of LWJGL 2 versions (`LWJGL Version:`) print before the window exists.
 */
const LOADED = /Sound engine started|OpenAL initialized|Created: \d+x\d+(x\d+)? .*atlas/
const LOADED_TIMEOUT_MS = 45_000

interface Result {
  case: string
  installMs?: number
  firstClickToSpawnMs?: number
  firstReadyMs?: number
  clickToSpawnMs?: number
  readyMs?: number
  /** Time from spawn until the game reported sound/textures loaded (warm launch). */
  loadedMs?: number
  ready: boolean
  error?: string
  passed: boolean
}

const out = (line: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`)
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2)
  const cases = wanted.length > 0 ? CASES.filter((c) => wanted.includes(c.name)) : CASES
  const reuse = process.env.AMETHYST_E2E_ROOT
  const root = reuse ? path.resolve(reuse) : await mkdtemp(path.join(tmpdir(), 'amethyst-e2e-'))
  out(`data root: ${root}`)
  const layout = dataLayout(root)

  const listeners = new Set<(event: keyof Events, payload: unknown) => void>()
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
    for (const l of listeners) l(event, payload)
  }
  const tasks = new TaskRegistry(() => {})
  const settings = new SettingsStore(layout, emit)
  await settings.load()
  // Offline accounts without a Microsoft account need developer mode; keep the terminal visible.
  await settings.patch({ general: { developerMode: true }, game: { hideLauncherWhileRunning: false } })

  const http = createHttpClient({ version: 'e2e' })
  setDefaultHttpClient(http)
  const fetchBytes = (url: string, o: { maxBytes: number; signal?: AbortSignal }) => http.bytes(url, o)
  const host: HostServices = {
    encrypt: async () => {
      throw Object.assign(new Error('no keychain in the e2e script'), { code: 'ESECRET_UNAVAILABLE' })
    },
    decrypt: async () => {
      throw Object.assign(new Error('no keychain in the e2e script'), { code: 'ESECRET_UNREADABLE' })
    },
    trash: (p) => rm(p, { recursive: true, force: true }),
    openAuthWindow: async () => {
      throw new Error('not available')
    },
    closeAuthWindow: async () => {},
    clearAuthSession: async () => {},
    openExternal: async () => {},
    setLauncherHidden: async (hidden) => out(`host: launcher ${hidden ? 'hidden' : 'shown'}`),
  }

  const instances = new InstanceManager({ layout, emit, host, tasks, fetchBytes })
  await instances.load()
  const meta = createMetadataClient({ cacheDir: layout.metaCache, maxAgeMs: Number.POSITIVE_INFINITY, http })
  const natives = new Lwjgl2NativesSource({ cacheDir: layout.nativesCache, fallback: DEFAULT_LWJGL2_ARM64_SOURCE, fetchJson: (url, o) => http.json(url, o.signal ? { signal: o.signal } : {}) })
  const telemetry = { capture: () => {}, redact: () => {}, reportError: () => {} }
  const java = new JavaManager({ layout, emit, settings, tasks, instances, http: async () => http })
  const install = new InstallManager({ layout, emit, tasks, settings, instances, java, meta: async () => meta, http: async () => http, natives, telemetry })
  const accounts = new AccountManager({ layout, emit, host, settings, fetchBytes })
  await accounts.load()
  const player = accounts.list().find((a) => a.kind === 'offline') ?? (await accounts.addOffline('AmethystE2E'))
  await accounts.select(player.id)
  const launch = new LaunchManager({
    layout,
    emit,
    settings,
    tasks,
    version: '0.0.0-e2e',
    instances,
    install,
    java,
    accounts: async () => accounts,
    natives,
    http: async () => http,
    host,
    telemetry,
  })
  instances.addHooks({ isBusy: (id) => install.isBusy(id) || launch.isActive(id) })

  // Progress: one line per launch step and state change.
  listeners.add((event, payload) => {
    if (event === 'launch:state') {
      const p = payload as Events['launch:state']
      if (p.state === 'preparing') out(`  · ${p.step}`)
      else if (p.state === 'running') out(`  · running pid ${p.pid}${p.ready ? ' (ready)' : ''}`)
      else if (p.state === 'exited') out(`  · exited code ${p.code} signal ${p.signal} crashed ${p.crashed} killed ${p.killed}${p.crashReportPath ? ` report ${p.crashReportPath}` : ''}`)
      else out(`  · failed ${p.code}: ${p.message}`)
    }
  })

  /** Launch, wait for ready (or exit, or the timeout), kill, wait for exit. */
  const playOnce = async (instanceId: string): Promise<{ started: LaunchStarted; readyMs?: number; loadedMs?: number }> => {
    let resolveState!: (s: 'ready' | 'exited') => void
    const settled = new Promise<'ready' | 'exited'>((r) => (resolveState = r))
    let exited!: () => void
    const exit = new Promise<void>((r) => (exited = r))
    const listener = (event: keyof Events, payload: unknown) => {
      if (event !== 'launch:state') return
      const p = payload as Events['launch:state']
      if (p.instanceId !== instanceId) return
      if (p.state === 'running' && p.ready) resolveState('ready')
      if (p.state === 'exited') {
        resolveState('exited')
        exited()
      }
    }
    listeners.add(listener)
    launch.subscribeLog(instanceId)
    try {
      const started = await launch.launch(instanceId)
      const spawnedAt = Date.now()
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), READY_TIMEOUT_MS).unref())
      const state = await Promise.race([settled, timeout])
      const readyMs = state === 'ready' ? Date.now() - spawnedAt : undefined
      let loadedMs: number | undefined
      let ended = false
      void exit.then(() => (ended = true))
      for (const deadline = Date.now() + LOADED_TIMEOUT_MS; state === 'ready' && !ended && Date.now() < deadline; ) {
        if (launch.getLog(instanceId, { since: 0, limit: 5_000 }).lines.some((l) => LOADED.test(l.text))) {
          loadedMs = Date.now() - spawnedAt
          break
        }
        // oxlint-disable-next-line no-await-in-loop -- polling the log buffer
        await new Promise((r) => setTimeout(r, 250))
      }
      if (state === 'ready' && loadedMs === undefined) {
        const tail = launch.getLog(instanceId, { since: 0, limit: 5_000 }).lines.slice(-15)
        out(`  ! ready but never loaded; last output:\n${tail.map((l) => `      ${l.text.split('\n')[0]}`).join('\n')}`)
      }
      if (state !== 'ready') {
        const tail = launch.getLog(instanceId, { since: 0, limit: 5_000 }).lines.slice(-25)
        out(`  ! no ready signal (${state}); last output:\n${tail.map((l) => `      ${l.text.split('\n')[0]}`).join('\n')}`)
      }
      if (state !== 'exited') {
        await launch.kill(instanceId)
        await Promise.race([exit, new Promise((r) => setTimeout(r, 15_000).unref())])
        if (launch.isActive(instanceId)) {
          await launch.kill(instanceId, { force: true })
          await exit
        }
      }
      return { started, ...(readyMs !== undefined ? { readyMs } : {}), ...(loadedMs !== undefined ? { loadedMs } : {}) }
    } finally {
      listeners.delete(listener)
      launch.unsubscribeLog(instanceId)
    }
  }

  const results: Result[] = []
  for (const c of cases) {
    out(`=== ${c.name}`)
    const result: Result = { case: c.name, ready: false, passed: false }
    results.push(result)
    try {
      const runtime = { ...c.runtime }
      if (runtime.fabric === 'latest') runtime.fabric = (await meta.loaderVersions('fabric')).find((l) => l.stable)?.version ?? ''
      if (runtime.forge === 'latest') {
        const builds = await meta.forgeVersions(runtime.minecraft)
        runtime.forge = (builds.find((b) => b.recommended) ?? builds[0])?.version ?? ''
      }
      out(`  runtime ${JSON.stringify(runtime)}`)
      const inst = await instances.create({ name: `e2e ${c.name}`, runtime })
      const t = Date.now()
      const installed = await install.install(inst.id)
      result.installMs = Date.now() - t
      out(`  installed ${installed.versionId} in ${result.installMs} ms (${(installed.bytes / 1048576).toFixed(0)} MiB)`)

      const first = await playOnce(inst.id)
      result.firstClickToSpawnMs = first.started.clickToSpawnMs
      if (first.readyMs !== undefined) result.firstReadyMs = first.readyMs
      out(`  first launch: click → spawn ${first.started.clickToSpawnMs} ms, ready ${first.readyMs ?? 'no'}`)

      const warm = await playOnce(inst.id)
      result.clickToSpawnMs = warm.started.clickToSpawnMs
      if (warm.readyMs !== undefined) result.readyMs = warm.readyMs
      if (warm.loadedMs !== undefined) result.loadedMs = warm.loadedMs
      result.ready = warm.readyMs !== undefined && first.readyMs !== undefined && warm.loadedMs !== undefined
      result.passed = result.ready
      out(`  warm launch: click → spawn ${warm.started.clickToSpawnMs} ms, ready ${warm.readyMs ?? 'no'}, loaded ${warm.loadedMs ?? 'no'}`)
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'ERROR'
      result.error = `${code}: ${(e as Error).message}`
      result.passed = c.acceptError === code
      out(`  ${result.passed ? 'expected' : 'FAILED'}: ${result.error}`)
    }
  }

  out('=== results')
  for (const r of results) {
    out(
      `${r.passed ? 'PASS' : 'FAIL'} ${r.case.padEnd(15)} install ${r.installMs ?? '-'} ms | first click→spawn ${r.firstClickToSpawnMs ?? '-'} ms, ready +${r.firstReadyMs ?? '-'} ms | warm click→spawn ${r.clickToSpawnMs ?? '-'} ms, ready +${r.readyMs ?? '-'} ms, loaded +${r.loadedMs ?? '-'} ms${r.error ? ` | ${r.error}` : ''}`,
    )
  }
  process.stdout.write(`E2E ${JSON.stringify(results)}\n`)
  tasks.dispose()
  launch.dispose()
  java.dispose()
  await Promise.allSettled([settings.flush(), instances.flush(), accounts.flush(), java.flush()])
  await http.close()
  process.exit(results.every((r) => r.passed) ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
