/* oxlint-disable no-await-in-loop -- the benchmark is sequential by design */
/**
 * The benchmark driver (`AMETHYST_BENCH=<out.json>`), loaded lazily by `main/index.ts` and driven
 * by `scripts/bench/run.ts` (see docs/PERFORMANCE.md). It works against the dev build and the
 * packaged app alike, in the seeded data root given as `AMETHYST_BENCH_ROOT`.
 *
 * - `AMETHYST_BENCH_MODE=startup` (default): cold-start timeline only, then quit.
 * - `AMETHYST_BENCH_MODE=full`: also memory, idle CPU (visible, hidden, minimised), IPC traffic
 *   (needs `AMETHYST_IPC_STATS=1`), the Mods tab, scroll frame times, Discover, instance switches,
 *   50 navigations (heap growth), an install and Play → spawn.
 * - `AMETHYST_BENCH_IDLE_MS` (default 60000): length of each idle-CPU window.
 * - `AMETHYST_BENCH_TRACE=<dir>`: record a Chrome trace of the interaction phase.
 * - `AMETHYST_BENCH_HEAP=<dir>`: heap snapshots before and after the 50 navigations.
 * - `AMETHYST_BENCH_T0=<epoch ms>`: when the harness spawned the process (else main's own start).
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { mainMarks } from './bench-marks'
import { openSettingsWindow } from './windows'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.timeOrigin + performance.now()
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

interface SeedInfo {
  largeId: string
  vanillaId: string
  gameFiles: boolean
}

/** Injected into every page of the main window before its scripts (full mode only). */
const PAGE_HOOKS = String.raw`(() => {
  const b = (window.__bench = { commits: 0, fibers: 0, names: {}, longTasks: [], events: [] })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) b.longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) })
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  // React DevTools' hook, reduced to counting commits and the components that rendered in each
  // (DevTools' own heuristic: a fiber with PerformedWork; skip subtrees whose child list was reused).
  const FN = new Set([0, 1, 11, 14, 15])
  const rendered = (root) => {
    let n = 0
    const stack = [root]
    while (stack.length) {
      const f = stack.pop()
      if (FN.has(f.tag) && (f.flags & 1)) {
        n++
        const name = (f.type && (f.type.displayName || f.type.name)) || (f.elementType && (f.elementType.displayName || f.elementType.name)) || '?'
        b.names[name] = (b.names[name] || 0) + 1
      }
      if (f.alternate && f.child === f.alternate.child) continue
      for (let c = f.child; c; c = c.sibling) stack.push(c)
    }
    return n
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { b.commits++; try { b.fibers += rendered(root.current) } catch {} },
  }
  b.reset = () => { b.commits = 0; b.fibers = 0; b.names = {}; b.longTasks = []; b.events = [] }
  b.read = () => ({
    commits: b.commits,
    fibers: b.fibers,
    topComponents: Object.entries(b.names).sort((x, y) => y[1] - x[1]).slice(0, 12),
    longTasks: b.longTasks.slice(),
  })
  /** Navigate and resolve with the ms until 'cond' holds in a frame (or -1 on timeout). */
  b.nav = (hash, cond, timeout = 20000) => new Promise((res) => {
    const t0 = performance.now()
    if (hash !== null) location.hash = hash
    const tick = () => {
      let ok = false
      try { ok = !!cond() } catch {}
      if (ok) return setTimeout(() => res(performance.now() - t0), 0)
      if (performance.now() - t0 > timeout) return res(-1)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  b.frames = (ms) => new Promise((res) => {
    const d = []
    let last = performance.now()
    const start = last
    const tick = (t) => { d.push(t - last); last = t; if (t - start < ms) requestAnimationFrame(tick); else res(d) }
    requestAnimationFrame(tick)
  })
  b.scroll = (el, px, ms) => new Promise((res) => {
    el.scrollTop = 0
    const d = []
    let dir = 1
    let last = 0
    let start = 0
    const tick = (t) => {
      if (!start) { start = last = t } else { d.push(t - last); last = t }
      el.scrollTop += dir * px
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) dir = -1
      else if (el.scrollTop <= 0) dir = 1
      if (t - start < ms) requestAnimationFrame(tick); else res(d)
    }
    requestAnimationFrame(tick)
  })
  b.stats = (d) => {
    const s = d.slice().sort((x, y) => x - y)
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0
    const total = d.reduce((a, x) => a + x, 0)
    return { frames: d.length, fps: d.length / (total / 1000), meanMs: total / d.length, p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: s[s.length - 1] || 0 }
  }
  const onBridge = () => window.amethyst && window.amethyst.on((event, payload) => {
    if (event === 'launch:state' || event === 'resources:scan' || event === 'tasks:update' || event === 'resources:changed') b.events.push({ event, at: performance.now(), state: payload && payload.state, scanning: payload && payload.scanning, kind: payload && payload.kind })
  })
  if (window.amethyst) onBridge(); else queueMicrotask(onBridge)
})()`

type Kind = 'main' | 'renderer' | 'runtime' | 'gpu' | 'other'

interface ProcSample {
  pid: number
  kind: Kind
  name: string
  rssMB: number
  cpuSec: number
  wakeups: number
}

function parseCpuTime(s: string): number {
  // ps `time`: [[dd-]hh:]mm:ss.cc
  const [days, rest] = s.includes('-') ? (s.split('-') as [string, string]) : ['0', s]
  const parts = rest.split(':').map(Number)
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return Number(days) * 86400 + sec
}

async function sampleProcesses(): Promise<ProcSample[]> {
  const metrics = app.getAppMetrics()
  const ps = await run('/bin/ps', ['-o', 'pid=,rss=,time=', '-p', metrics.map((m) => m.pid).join(',')]).catch(() => ({ stdout: '' }))
  const byPid = new Map<number, { rss: number; time: number }>()
  for (const line of ps.stdout.split('\n')) {
    const [pid, rss, time] = line.trim().split(/\s+/)
    if (pid && rss && time) byPid.set(Number(pid), { rss: Number(rss), time: parseCpuTime(time) })
  }
  return metrics.map((m) => {
    const label = `${m.name ?? ''} ${m.serviceName ?? ''}`
    const kind: Kind =
      m.type === 'Browser' ? 'main' : m.type === 'Tab' ? 'renderer' : m.type === 'GPU' ? 'gpu' : m.type === 'Utility' && /Amethyst Runtime/.test(label) ? 'runtime' : 'other'
    const p = byPid.get(m.pid)
    return {
      pid: m.pid,
      kind,
      name: (m.name ?? m.serviceName ?? m.type).trim(),
      rssMB: p ? p.rss / 1024 : m.memory.workingSetSize / 1024,
      cpuSec: m.cpu.cumulativeCPUUsage ?? p?.time ?? 0,
      wakeups: m.cpu.idleWakeupsPerSecond,
    }
  })
}

function byKind(samples: ProcSample[], value: (s: ProcSample) => number) {
  const out: Record<string, number> = { main: 0, renderer: 0, runtime: 0, gpu: 0, other: 0 }
  for (const s of samples) out[s.kind] = (out[s.kind] ?? 0) + value(s)
  out.total = samples.reduce((a, s) => a + value(s), 0)
  for (const k of Object.keys(out)) out[k] = round(out[k] ?? 0)
  return out
}

/**
 * Memory per process kind, in MB: `rss` (resident, counts shared framework pages once per
 * process) and `footprint` (macOS phys_footprint, what Activity Monitor shows as Memory).
 */
async function memoryByKind() {
  const samples = await sampleProcesses()
  const fp = await run('/usr/bin/footprint', ['-f', 'bytes', ...samples.flatMap((s) => ['-p', String(s.pid)])]).catch(() => ({ stdout: '' }))
  const footprints = new Map<number, number>()
  for (const m of fp.stdout.matchAll(/\[(\d+)\]: .*?Footprint: (\d+) B/g)) footprints.set(Number(m[1]), Number(m[2]) / 1048576)
  return { rss: byKind(samples, (s) => s.rssMB), footprint: byKind(samples, (s) => footprints.get(s.pid) ?? 0) }
}

/** IPC counters (from the preload, `AMETHYST_IPC_STATS=1`) as rates, with the heaviest names. */
function ipcRate(ipc: unknown, seconds: number) {
  const s = ipc as { channels: Record<string, { count: number; bytes: number }>; names: Record<string, { count: number; bytes: number }> } | null
  if (!s) return null
  const ch = Object.values(s.channels)
  const count = ch.reduce((a, c) => a + c.count, 0)
  const bytes = ch.reduce((a, c) => a + c.bytes, 0)
  const top = Object.entries(s.names)
    .toSorted((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8)
    .map(([name, v]) => ({ name, count: v.count, bytes: v.bytes }))
  return { messagesPerSec: round(count / seconds, 2), bytesPerSec: round(bytes / seconds, 0), messages: count, bytes, channels: s.channels, top }
}

const h1Is = (name: string) => `[...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === ${JSON.stringify(name)})`

/** CPU % of one core per process kind between two samples. */
function cpuBetween(a: ProcSample[], b: ProcSample[], seconds: number) {
  const before = new Map(a.map((s) => [s.pid, s]))
  const out: Record<string, number> = { main: 0, renderer: 0, runtime: 0, gpu: 0, other: 0, total: 0 }
  for (const s of b) {
    const prev = before.get(s.pid)
    const used = s.cpuSec - (prev?.cpuSec ?? s.cpuSec)
    out[s.kind] = (out[s.kind] ?? 0) + used
    out.total = (out.total ?? 0) + used
  }
  for (const k of Object.keys(out)) out[k] = round(((out[k] ?? 0) / seconds) * 100, 2)
  return out
}

export async function runBench(win: BrowserWindow, outFile: string, done: (ok: boolean) => void): Promise<void> {
  const result: Record<string, unknown> = {
    packaged: app.isPackaged,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() },
    startedAt: new Date().toISOString(),
  }
  const errors: string[] = []
  const contents = win.webContents
  const js = <T>(code: string, wc: WebContents = contents): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const invoke = async <T>(service: string, method: string, args: unknown[] = []): Promise<T> => {
    const r = await js<{ ok: boolean; value?: T; error?: { code?: string; message: string } }>(
      `window.amethyst.invoke(${JSON.stringify(service)}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`,
    )
    if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`)
    return r.value as T
  }
  // `AMETHYST_BENCH_STEPS=a,b`: run only these steps of the full run (quick experiments).
  const only = process.env.AMETHYST_BENCH_STEPS ? new Set(process.env.AMETHYST_BENCH_STEPS.split(',')) : undefined
  const step = async (name: string, fn: () => Promise<unknown>, timeoutMs = 10 * 60_000) => {
    if (only && name !== 'startup' && !only.has(name)) return
    console.warn(`BENCH step ${name}`)
    try {
      const value = await Promise.race([fn(), sleep(timeoutMs).then(() => Promise.reject(new Error(`timed out after ${timeoutMs} ms`)))])
      if (value !== undefined) result[name] = value
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
      console.error(`BENCH ${name} failed`, e)
    }
  }
  const mode = (['full', 'mods'] as const).find((m) => m === process.env.AMETHYST_BENCH_MODE) ?? 'startup'
  const t0 = Number(process.env.AMETHYST_BENCH_T0) || performance.timeOrigin
  const rel = (epoch: number | undefined) => (epoch ? round(epoch - t0) : undefined)
  const seed = (await readFile(join(app.getPath('userData'), '.bench-seed.json'), 'utf8').then(JSON.parse, () => undefined)) as SeedInfo | undefined

  const waitInteractive = () =>
    js<boolean>(`new Promise((res) => {
      const t0 = performance.now()
      const tick = () => {
        if (performance.getEntriesByName('amethyst:home-instances').length && performance.getEntriesByName('amethyst:sidebar-instances').length) return res(true)
        if (performance.now() - t0 > 30000) return res(false)
        setTimeout(tick, 16)
      }
      tick()
    })`)
  const rendererTimeline = () =>
    js<{ origin: number; marks: Record<string, number>; paint: Record<string, number>; nav: Record<string, number> }>(`(() => {
      const marks = {}
      for (const m of performance.getEntriesByType('mark')) marks[m.name.replace('amethyst:', '')] = m.startTime
      const paint = {}
      for (const p of performance.getEntriesByType('paint')) paint[p.name] = p.startTime
      const n = performance.getEntriesByType('navigation')[0]
      return { origin: performance.timeOrigin, marks, paint, nav: n ? { domInteractive: n.domInteractive, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd } : {} }
    })()`)

  try {
    if (!contents.getURL() || contents.isLoading()) await new Promise<void>((r) => contents.once('did-finish-load', () => r()))

    // ---- Cold start ----------------------------------------------------------------------
    await step('startup', async () => {
      if (!(await waitInteractive())) throw new Error('the instance list never rendered')
      await sleep(500)
      const r = await rendererTimeline()
      const ping = await invoke<{ bootMs: number; processStartedAt: number; bootedAt: number; memoryRss: number; heapUsed: number }>('runtime', 'ping')
      const at = (ms: number | undefined) => (ms === undefined ? undefined : rel(r.origin + ms))
      const interactive = Math.max(r.marks['home-instances'] ?? 0, r.marks['sidebar-instances'] ?? 0)
      return {
        mainProcessStart: rel(performance.timeOrigin),
        mainModuleEval: rel(mainMarks['main-start']),
        appReady: rel(mainMarks['app-ready']),
        windowCreated: rel(mainMarks['window-created']),
        runtimeFork: rel(mainMarks['runtime-fork']),
        runtimeProcessStart: rel(ping.processStartedAt),
        runtimeSpawnEvent: rel(mainMarks['runtime-spawn']),
        runtimeBooted: rel(ping.bootedAt),
        runtimeBootMs: round(ping.bootedAt - ping.processStartedAt),
        rendererNavigationStart: rel(r.origin),
        rendererEntryScript: at(r.marks.entry),
        firstPaint: at(r.paint['first-paint']),
        firstContentfulPaint: at(r.paint['first-contentful-paint']),
        readyToShow: rel(mainMarks['ready-to-show']),
        sidebarInstances: at(r.marks['sidebar-instances']),
        homeInstances: at(r.marks['home-instances']),
        interactive: at(interactive),
        domContentLoaded: at(r.nav.domContentLoaded),
      }
    })

    if (mode !== 'startup') await fullRun()
  } catch (e) {
    errors.push(`fatal: ${(e as Error).message}`)
  }

  result.errors = errors
  await mkdir(join(outFile, '..'), { recursive: true }).catch(() => {})
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`)
  console.warn(`BENCH ${outFile} (${errors.length} errors)`)
  done(errors.length === 0)

  async function fullRun() {
    const idleMs = Number(process.env.AMETHYST_BENCH_IDLE_MS) || 60_000
    const dbg = contents.debugger
    dbg.attach('1.3')
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOKS })
    // Experiments: `AMETHYST_BENCH_CSS` is added to every page (e.g. to switch an effect off and compare).
    const css = process.env.AMETHYST_BENCH_CSS
    if (css) {
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.append(s) })`,
      })
    }
    const page = js
    const resetCounters = () => page(`window.__bench.reset(); window.amethyst.ipcStats?.reset(); true`)
    const readCounters = () =>
      page<{ react: unknown; ipc: unknown; events: unknown }>(`({ react: window.__bench.read(), ipc: window.amethyst.ipcStats?.read() ?? null })`)
    const heap = async () => {
      await dbg.sendCommand('HeapProfiler.collectGarbage')
      const usage = (await dbg.sendCommand('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number }
      const dom = (await dbg.sendCommand('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
      const ping = await invoke<{ heapUsed: number; memoryRss: number }>('runtime', 'ping')
      return { rendererHeapMB: round(usage.usedSize / 1048576), domNodes: dom.nodes, jsEventListeners: dom.jsEventListeners, runtimeHeapMB: round(ping.heapUsed / 1048576), runtimeRssMB: round(ping.memoryRss / 1048576) }
    }
    const snapshot = async (file: string) => {
      const chunks: string[] = []
      const onMessage = (_e: unknown, method: string, params: { chunk?: string }) => {
        if (method === 'HeapProfiler.addHeapSnapshotChunk' && params.chunk) chunks.push(params.chunk)
      }
      dbg.on('message', onMessage)
      await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      dbg.off('message', onMessage)
      await writeFile(file, chunks.join(''))
    }
    await dbg.sendCommand('HeapProfiler.enable')

    // A fresh page with the hooks installed: also a warm-runtime renderer start.
    await step('rendererReload', async () => {
      const loaded = new Promise<void>((r) => contents.once('did-finish-load', () => r()))
      const t = now()
      contents.reload()
      await loaded
      await waitInteractive()
      const r = await rendererTimeline()
      const interactive = Math.max(r.marks['home-instances'] ?? 0, r.marks['sidebar-instances'] ?? 0)
      const counters = await readCounters()
      return { reloadToInteractiveMs: round(r.origin + interactive - t), firstContentfulPaintMs: round(r.origin + (r.paint['first-contentful-paint'] ?? 0) - t), react: counters.react }
    })

    const large = seed?.largeId
    const nav = (hash: string | null, cond: string, timeout = 20_000) => page<number>(`window.__bench.nav(${JSON.stringify(hash)}, () => (${cond}), ${timeout})`).then((ms) => round(ms))
    const notLoading = `!document.querySelector('[role=status][aria-label^="Loading"]')`
    const modsRows = `(() => { const g = document.querySelector('[role=grid][aria-label="Mods"]'); return g && g.querySelectorAll('[role=row][aria-rowindex]').length > 10 && g.textContent.includes('Bench Mod') })()`
    const modsIcons = `(() => { const g = document.querySelector('[role=grid][aria-label="Mods"]'); if (!g) return false; const imgs = [...g.querySelectorAll('img')]; return imgs.length > 10 && imgs.every((i) => i.complete) })()`

    win.show()
    win.focus()
    if (mode === 'mods') {
      await modsPhase()
      return
    }
    await sleep(10_000)
    await step('memoryIdle10s', async () => ({ ...(await memoryByKind()), heap: await heap() }))

    // ---- Idle CPU ------------------------------------------------------------------------
    await step('idle', async () => {
      const out: Record<string, unknown> = {}
      for (const state of ['visible', 'hidden', 'minimised'] as const) {
        if (state === 'visible') {
          win.show()
          win.focus()
        } else if (state === 'hidden') win.hide()
        else {
          win.show()
          win.minimize()
        }
        await sleep(2_000)
        await resetCounters()
        const a = await sampleProcesses()
        const t = now()
        await sleep(idleMs)
        const b = await sampleProcesses()
        const seconds = (now() - t) / 1000
        const counters = await readCounters()
        const wakeups: Record<string, number> = {}
        for (const s of b) wakeups[s.kind] = round((wakeups[s.kind] ?? 0) + s.wakeups, 1)
        out[state] = { seconds: round(seconds), cpuPercent: cpuBetween(a, b, seconds), idleWakeupsPerSec: wakeups, ipc: ipcRate(counters.ipc, seconds), react: counters.react }
      }
      win.restore()
      win.show()
      win.focus()
      await sleep(1_000)
      return out
    })

    // A DevTools-protocol trace (JSON, the Performance panel's format) of the interaction phase.
    const tracing = process.env.AMETHYST_BENCH_TRACE
    const traceDone = tracing
      ? new Promise<string>((resolve) => {
          const onMessage = (_e: unknown, method: string, params: { stream?: string }) => {
            if (method !== 'Tracing.tracingComplete' || !params.stream) return
            dbg.off('message', onMessage)
            resolve(params.stream)
          }
          dbg.on('message', onMessage)
        })
      : undefined
    if (tracing) {
      await dbg.sendCommand('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: {
          recordMode: 'recordAsMuchAsPossible',
          includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'v8.execute', 'toplevel', 'loading', '__metadata', ...(process.env.AMETHYST_BENCH_TRACE_JS ? ['disabled-by-default-v8.cpu_profiler'] : [])],
        },
      })
    }
    const stopTrace = async () => {
      if (!tracing || !traceDone) return
      await dbg.sendCommand('Tracing.end')
      const stream = await traceDone
      const parts: string[] = []
      for (;;) {
        const chunk = (await dbg.sendCommand('IO.read', { handle: stream, size: 1 << 20 })) as { data: string; eof: boolean; base64Encoded?: boolean }
        parts.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data)
        if (chunk.eof) break
      }
      await dbg.sendCommand('IO.close', { handle: stream })
      await mkdir(tracing, { recursive: true })
      const file = join(tracing, 'trace.json')
      await writeFile(file, parts.join(''))
      result.traceFile = file
    }

    await modsPhase()

    async function modsPhase() {
      if (!large) return
      await step('modsTab', async () => {
        await nav('#/', h1Is('Home'))
        await resetCounters()
        const firstRows = await nav(`#/instances/${large}/mods`, modsRows, 60_000)
        const firstIcons = await nav(null, modsIcons, 60_000)
        // Wait for any scan of a cold index to settle, then time re-opens.
        const scanDone = await nav(null, `!document.body.textContent.includes('Reading…')`, 120_000)
        const first = await readCounters()
        const warm: number[] = []
        for (let i = 0; i < 3; i++) {
          await nav(`#/instances/${large}/overview`, h1Is('Bench Large'))
          await sleep(300)
          warm.push(await nav(`#/instances/${large}/mods`, modsRows))
        }
        return {
          firstOpenRowsMs: firstRows,
          firstOpenIconsMs: round(firstRows + firstIcons),
          settledMs: scanDone,
          warmOpenMs: warm,
          warmOpenMedianMs: warm.toSorted((a, b) => a - b)[1],
          firstOpenReact: first.react,
          firstOpenIpc: ipcRate(first.ipc, 1),
        }
      })

      await step('modsScroll', async () => {
        await nav(`#/instances/${large}/mods`, modsRows)
        await sleep(1_000)
        const idle = await page(`window.__bench.frames(1000).then(window.__bench.stats)`)
        await resetCounters()
        const a = await sampleProcesses()
        const t = now()
        const frames = await page<{ frames: number }>(
          `window.__bench.scroll(document.querySelector('[role=grid][aria-label="Mods"]'), 40, 5000).then(window.__bench.stats)`,
        )
        const cpu = cpuBetween(a, await sampleProcesses(), (now() - t) / 1000)
        const counters = await readCounters()
        const react = counters.react as { commits: number; fibers: number }
        await sleep(1_000)
        const memory = { ...(await memoryByKind()), heap: await heap() }
        // Background workers started by the scan should not stay resident once idle.
        await sleep(45_000)
        const memoryAfter45s = await memoryByKind()
        return { idleFrames: idle, scroll40pxPerFrame: frames, cpuPercent: cpu, componentsPerFrame: round(react.fibers / Math.max(1, frames.frames)), react, memory, memoryAfter45s }
      })
    }

    // ---- Every route ---------------------------------------------------------------------
    const routes: [string, string][] = [
      ['home', '#/'],
      ['discover', '#/discover?type=modpack'],
      ...(large
        ? (['overview', 'mods', 'resource-packs', 'shaders', 'worlds', 'logs', 'settings'].map((tab) => [`large/${tab}`, `#/instances/${large}/${tab}`]) as [string, string][])
        : []),
      ...(seed?.vanillaId ? ([['vanilla/overview', `#/instances/${seed.vanillaId}/overview`]] as [string, string][]) : []),
    ]
    await step('routes', async () => {
      const out: Record<string, number> = {}
      for (const [name, hash] of routes) {
        out[name] = await nav(hash, `${notLoading} && !!document.querySelector('h1')`)
        await sleep(400)
      }
      return out
    })
    await step('settingsWindow', async () => {
      const t = now()
      const settings = openSettingsWindow('general')
      const createSyncMs = round(now() - t)
      await new Promise<void>((r) => (settings.webContents.isLoading() ? settings.webContents.once('did-finish-load', () => r()) : r()))
      const open = round(now() - t)
      await sleep(1_500)
      const general = await memoryByKind()
      const panes: Record<string, number> = {}
      for (const pane of ['accounts', 'appearance', 'java', 'game', 'network', 'privacy', 'updates', 'advanced', 'about', 'general']) {
        await js(`location.hash = '#/settings/${pane}'; true`, settings.webContents)
        await sleep(1_000)
        panes[pane] = (await memoryByKind()).footprint.gpu ?? 0
      }
      await sleep(2_000)
      const back = await memoryByKind()
      const tc = now()
      settings.close()
      const closeSyncMs = round(now() - tc)
      win.focus()
      return { openMs: open, createSyncMs, closeSyncMs, memoryOnGeneral: general, gpuFootprintPerPane: panes, memoryBackOnGeneral: back }
    })
    await sleep(2_000)
    await step('memoryAfterRoutes', async () => ({ ...(await memoryByKind()), heap: await heap() }))
    // Work started by the routes (scans, icon thumbnails) should not stay resident once idle.
    await step('memoryAfterRoutes40s', async () => {
      await sleep(40_000)
      return memoryByKind()
    })

    // ---- Instance switching --------------------------------------------------------------
    await step('instanceSwitch', async () => {
      const list = await invoke<{ id: string; name: string }[]>('instances', 'list')
      const picks = list.filter((i) => i.name.startsWith('Bench ')).slice(0, 11)
      await resetCounters()
      const times: number[] = []
      for (const inst of picks) times.push(await nav(`#/instances/${inst.id}/overview`, `${h1Is(inst.name)} && ${notLoading}`))
      const counters = await readCounters()
      const sorted = times.slice(1).toSorted((a, b) => a - b)
      return { overviewMs: times, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), react: counters.react }
    })

    // ---- Discover search (network) -------------------------------------------------------
    await step('discoverSearch', async () => {
      const out: Record<string, number> = {}
      await nav('#/', h1Is('Home'))
      for (const q of ['sodium', 'map', 'shader']) {
        out[q] = await nav(`#/discover?type=mod&q=${q}`, `document.querySelectorAll('[aria-label="Results"] [role=listitem]').length > 3`, 30_000)
        await sleep(500)
      }
      return out
    })

    await step('trace', stopTrace)

    // ---- 50 navigations: heap growth -----------------------------------------------------
    await step('navigationSoak', async () => {
      const heapDir = process.env.AMETHYST_BENCH_HEAP
      if (heapDir) await mkdir(heapDir, { recursive: true })
      const cycle = routes.filter(([name]) => name !== 'discover')
      await nav('#/', h1Is('Home'))
      await sleep(1_000)
      const before = await heap()
      if (heapDir) await snapshot(join(heapDir, 'before.heapsnapshot'))
      await resetCounters()
      const t = now()
      for (let i = 0; i < 50; i++) {
        const [, hash] = cycle[i % cycle.length]!
        await nav(hash, `${notLoading} && !!document.querySelector('h1')`)
      }
      const seconds = (now() - t) / 1000
      const counters = await readCounters()
      await nav('#/', h1Is('Home'))
      await sleep(1_000)
      const after = await heap()
      if (heapDir) await snapshot(join(heapDir, 'after.heapsnapshot'))
      return { navigations: 50, seconds: round(seconds), before, after, longTasks: (counters.react as { longTasks: unknown[] }).longTasks, ipc: ipcRate(counters.ipc, seconds) }
    })

    // ---- Install (verifies cached game files) --------------------------------------------
    if (seed?.gameFiles) {
      await step('install', async () => {
        const inst = await invoke<{ id: string }>('instances', 'create', [{ name: 'Bench Install', runtime: { minecraft: '1.21.1' } }])
        await nav('#/', h1Is('Home'))
        await sleep(500)
        // `install` of a version whose files are all present only links it; `repair` then
        // re-hashes every file of it (thousands of assets), a long task tree with real progress.
        const measure = async (method: 'install' | 'repair') => {
          await resetCounters()
          const a = await sampleProcesses()
          const t = now()
          await invoke('install', method, [inst.id])
          const seconds = (now() - t) / 1000
          const b = await sampleProcesses()
          const counters = await readCounters()
          return { seconds: round(seconds, 2), cpuPercent: cpuBetween(a, b, seconds), ipc: ipcRate(counters.ipc, seconds), react: counters.react }
        }
        const install = await measure('install')
        await sleep(500)
        return { ...install, repair: await measure('repair') }
      })

      // ---- Play → spawn --------------------------------------------------------------------
      const vanilla = seed.vanillaId
      await step('playToSpawn', async () => {
        const runs: { spawnMs: number; readyMs: number }[] = []
        for (let i = 0; i < 2; i++) {
          await nav(`#/instances/${vanilla}/overview`, `${h1Is('Bench Vanilla')} && ${notLoading}`)
          await sleep(1_500)
          const r = await page<{ spawnMs: number; readyMs: number; error?: string }>(`new Promise((res) => {
            const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Play' && b.offsetParent)
            if (!btn) return res({ spawnMs: -1, readyMs: -1, error: 'no Play button' })
            const t0 = performance.now()
            let spawnMs = -1
            const off = window.amethyst.on((event, p) => {
              if (event !== 'launch:state') return
              if (p.state === 'running' && spawnMs < 0) spawnMs = performance.now() - t0
              if (p.state === 'running' && p.ready) { off(); res({ spawnMs, readyMs: performance.now() - t0 }) }
              if (p.state === 'failed' || p.state === 'exited') { off(); res({ spawnMs, readyMs: -1, error: p.state + ' ' + (p.code || '') + ' ' + (p.message || '') }) }
            })
            setTimeout(() => { off(); res({ spawnMs, readyMs: -1, error: 'timeout' }) }, 120000)
            btn.click()
          })`)
          if (r.error) errors.push(`playToSpawn: ${r.error}`)
          runs.push({ spawnMs: round(r.spawnMs), readyMs: round(r.readyMs) })
          await invoke('launch', 'kill', [vanilla, { force: true }]).catch(() => {})
          await sleep(4_000)
        }
        return { runs }
      })
    }

    await step('memoryEnd', async () => ({ ...(await memoryByKind()), heap: await heap() }))
    dbg.detach()
  }
}
