/* oxlint-disable no-await-in-loop, no-console -- a sequential CLI that reports on stdout */
/**
 * The repeatable benchmark (docs/PERFORMANCE.md).
 *
 *   pnpm --filter @amethyst/desktop bench [options]
 *
 *   --target dev|packaged|both   which build to run (default both; build first: `pnpm build`, `pnpm dist`)
 *   --starts <n>                 cold starts per target (default 5; the median is reported)
 *   --idle-ms <ms>               length of each idle-CPU window (default 60000)
 *   --quick                      3 starts, 15 s idle windows
 *   --no-full                    cold starts only
 *   --mods-only                  only the Mods-tab run (warm index), for quick iterations
 *   --steps <a,b>                only these steps of one full run (warm index), e.g. settingsWindow
 *   --out <dir>                  results (default /tmp/amethyst-bench-results)
 *   --compare <summary.json>     print a before/after table against an earlier summary
 *   --trace                      record a Chrome trace of the interaction phase (full run)
 *   --heap                       write heap snapshots before/after the 50 navigations
 *   --cpu-prof                   write a V8 CPU profile of the runtime (dev target only)
 *   --reseed                     rebuild the seeded data root
 *   --verbose                    stream the app's output
 *
 * Per target: one warm-up start (discarded), N cold starts (`AMETHYST_BENCH_MODE=startup`), one
 * full run on a cold resource index (`full`: memory, idle CPU, IPC, Mods tab first scan, scroll,
 * routes, switching, Discover, 50 navigations, install, Play → spawn), and one Mods-tab run on the
 * now-warm index (`mods`). The seeded root is `/tmp/amethyst-bench-seed` (`AMETHYST_BENCH_SEED`),
 * built from `scripts/bench/seed.ts`; game files are cloned from `AMETHYST_E2E_CACHE` or
 * `/tmp/amethyst-e2e-root` when present.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { seedDataRoot } from './seed'

const appDir = path.resolve(import.meta.dirname, '../..')
const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: 'both' },
    starts: { type: 'string' },
    'idle-ms': { type: 'string' },
    quick: { type: 'boolean', default: false },
    'no-full': { type: 'boolean', default: false },
    'mods-only': { type: 'boolean', default: false },
    steps: { type: 'string' },
    out: { type: 'string', default: '/tmp/amethyst-bench-results' },
    compare: { type: 'string' },
    trace: { type: 'boolean', default: false },
    heap: { type: 'boolean', default: false },
    'cpu-prof': { type: 'boolean', default: false },
    reseed: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
})
const starts = Number(args.starts ?? (args.quick ? 3 : 5))
const idleMs = Number(args['idle-ms'] ?? (args.quick ? 15_000 : 60_000))
const out = path.resolve(args.out)

type Target = 'dev' | 'packaged'
const binaries: Record<Target, { bin: string; args: string[] }> = {
  // `electron` resolves to its binary's path (downloading it on first use).
  dev: { bin: createRequire(path.join(appDir, 'package.json'))('electron') as string, args: [appDir] },
  packaged: { bin: path.join(appDir, 'release/mac-arm64/Amethyst.app/Contents/MacOS/Amethyst'), args: [] },
}

async function launch(target: Target, root: string, mode: 'startup' | 'full' | 'mods', file: string, extraEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const { bin, args: binArgs } = binaries[target]
  const env: Record<string, string | undefined> = {
    ...process.env,
    AMETHYST_BENCH: file,
    AMETHYST_BENCH_ROOT: root,
    AMETHYST_BENCH_MODE: mode,
    AMETHYST_BENCH_IDLE_MS: String(idleMs),
    AMETHYST_DISABLE_UPDATES: '1',
    ...(mode === 'startup' ? {} : { AMETHYST_IPC_STATS: '1' }),
    ...extraEnv,
  }
  delete env.ELECTRON_RUN_AS_NODE
  await rm(file, { force: true })
  env.AMETHYST_BENCH_T0 = String(Date.now())
  const child = spawn(bin, binArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const onData = (d: Buffer) => {
    log += d.toString()
    if (args.verbose) process.stderr.write(d)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), mode === 'startup' ? 90_000 : 30 * 60_000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  if (!existsSync(file)) throw new Error(`${target} ${mode}: no result (exit ${code})\n${log.slice(-4000)}`)
  const result = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  if ((result.errors as string[]).length) console.warn(`  ${target} ${mode} errors: ${(result.errors as string[]).join('; ')}`)
  return result
}

/** Make a run start from the same state: no leftovers from an earlier run's install. */
async function resetRoot(root: string, coldIndex: boolean): Promise<void> {
  for (const name of await readdir(path.join(root, 'instances')).catch(() => [] as string[])) {
    if (name.startsWith('Bench Install')) await rm(path.join(root, 'instances', name), { recursive: true, force: true })
  }
  if (coldIndex) {
    for (const f of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) await rm(path.join(root, f), { force: true })
    await rm(path.join(root, 'cache', 'icons'), { recursive: true, force: true })
  }
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).toSorted((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : undefined
}

function bundleSize(): { eagerJsKB?: number; eagerCssKB?: number } {
  const r = spawnSync(process.execPath, [path.join(appDir, 'scripts/bundle-size.mjs')], { encoding: 'utf8' })
  const m = /Eager JS: ([\d.]+) KB gzip.*Eager CSS: ([\d.]+) KB gzip/.exec(r.stdout)
  return m ? { eagerJsKB: Number(m[1]), eagerCssKB: Number(m[2]) } : {}
}

type Json = Record<string, any>

/** The headline numbers, flat, for the before/after table. */
function summarise(startups: Json[], full: Json | undefined, mods: Json | undefined): Record<string, number | undefined> {
  const s = (k: string) => median(startups.map((r) => r.startup?.[k]))
  const idle = full?.idle ?? {}
  return {
    'start: first contentful paint (ms)': s('firstContentfulPaint'),
    'start: ready-to-show (ms)': s('readyToShow'),
    'start: interactive, instance list (ms)': s('interactive'),
    'start: main module evaluated (ms)': s('mainModuleEval'),
    'start: runtime booted (ms)': s('runtimeBooted'),
    'runtime boot, process start to ready (ms)': s('runtimeBootMs'),
    'memory idle 10 s, footprint: main (MB)': full?.memoryIdle10s?.footprint?.main,
    'memory idle 10 s, footprint: renderer (MB)': full?.memoryIdle10s?.footprint?.renderer,
    'memory idle 10 s, footprint: runtime (MB)': full?.memoryIdle10s?.footprint?.runtime,
    'memory idle 10 s, footprint: GPU (MB)': full?.memoryIdle10s?.footprint?.gpu,
    'memory idle 10 s, footprint: total (MB)': full?.memoryIdle10s?.footprint?.total,
    'memory idle 10 s, RSS: total (MB)': full?.memoryIdle10s?.rss?.total,
    'memory after all routes, footprint: total (MB)': full?.memoryAfterRoutes?.footprint?.total,
    'memory after all routes, footprint: renderer (MB)': full?.memoryAfterRoutes?.footprint?.renderer,
    'memory after all routes, footprint: runtime (MB)': full?.memoryAfterRoutes?.footprint?.runtime,
    'memory 40 s after the routes, footprint: runtime (MB)': full?.memoryAfterRoutes40s?.footprint?.runtime,
    'memory 40 s after the routes, footprint: total (MB)': full?.memoryAfterRoutes40s?.footprint?.total,
    'renderer JS heap after routes (MB)': full?.memoryAfterRoutes?.heap?.rendererHeapMB,
    'runtime JS heap after routes (MB)': full?.memoryAfterRoutes?.heap?.runtimeHeapMB,
    'idle CPU visible (% of a core)': idle.visible?.cpuPercent?.total,
    'idle CPU hidden (% of a core)': idle.hidden?.cpuPercent?.total,
    'idle CPU minimised (% of a core)': idle.minimised?.cpuPercent?.total,
    'idle IPC visible (msg/s)': idle.visible?.ipc?.messagesPerSec,
    'idle React commits visible (per min)': idle.visible ? (idle.visible.react.commits / idle.visible.seconds) * 60 : undefined,
    'install (files present): duration (s)': full?.install?.seconds,
    'repair (re-hash every file): duration (s)': full?.install?.repair?.seconds,
    'repair: IPC (msg/s)': full?.install?.repair?.ipc?.messagesPerSec,
    'repair: IPC (KB/s)': full?.install?.repair?.ipc ? full.install.repair.ipc.bytesPerSec / 1024 : undefined,
    'repair: React commits (per s)': full?.install?.repair ? full.install.repair.react.commits / full.install.repair.seconds : undefined,
    'repair: renderer CPU (% of a core)': full?.install?.repair?.cpuPercent?.renderer,
    'Mods tab: first open, cold index, rows (ms)': full?.modsTab?.firstOpenRowsMs,
    'Mods tab: first open, cold index, scan settled (ms)': full?.modsTab ? full.modsTab.firstOpenRowsMs + full.modsTab.settledMs : undefined,
    'Mods tab: first open, warm index, rows (ms)': mods?.modsTab?.firstOpenRowsMs,
    'Mods tab: first open, warm index, icons (ms)': mods?.modsTab?.firstOpenIconsMs,
    'Mods tab: re-open (ms)': mods?.modsTab?.warmOpenMedianMs,
    'Mods scroll: fps': mods?.modsScroll?.scroll40pxPerFrame?.fps,
    'Mods scroll: p95 frame (ms)': mods?.modsScroll?.scroll40pxPerFrame?.p95Ms,
    'Mods scroll: worst frame (ms)': mods?.modsScroll?.scroll40pxPerFrame?.maxMs,
    'Mods scroll: long tasks': mods?.modsScroll?.react?.longTasks?.length,
    'Mods scroll: components rendered per frame': mods?.modsScroll?.componentsPerFrame,
    'Mods scroll: renderer CPU (% of a core)': mods?.modsScroll?.cpuPercent?.renderer,
    'Mods scroll: GPU CPU (% of a core)': mods?.modsScroll?.cpuPercent?.gpu,
    'after Mods scroll, footprint: renderer (MB)': mods?.modsScroll?.memory?.footprint?.renderer,
    'after Mods scroll, footprint: GPU (MB)': mods?.modsScroll?.memory?.footprint?.gpu,
    'after Mods scroll, footprint: runtime (MB)': mods?.modsScroll?.memory?.footprint?.runtime,
    'after Mods scroll + 45 s idle, footprint: runtime (MB)': mods?.modsScroll?.memoryAfter45s?.footprint?.runtime,
    'after Mods scroll + 45 s idle, footprint: total (MB)': mods?.modsScroll?.memoryAfter45s?.footprint?.total,
    'instance switch: median (ms)': full?.instanceSwitch?.medianMs,
    'instance switch: worst (ms)': full?.instanceSwitch?.maxMs,
    'Discover search render (ms, network)': median(Object.values(full?.discoverSearch ?? {}) as number[]),
    '50 navigations: renderer heap growth (MB)': full?.navigationSoak ? full.navigationSoak.after.rendererHeapMB - full.navigationSoak.before.rendererHeapMB : undefined,
    '50 navigations: DOM listener growth': full?.navigationSoak ? full.navigationSoak.after.jsEventListeners - full.navigationSoak.before.jsEventListeners : undefined,
    '50 navigations: long tasks > 50 ms': full?.navigationSoak?.longTasks?.length,
    'Play click to spawn (ms)': median((full?.playToSpawn?.runs ?? []).map((r: Json) => r.spawnMs).filter((x: number) => x > 0)),
  }
}

const fmt = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? 'n/a' : Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))

async function main() {
  await mkdir(out, { recursive: true })
  const root = path.resolve(process.env.AMETHYST_BENCH_SEED ?? '/tmp/amethyst-bench-seed')
  const cache = process.env.AMETHYST_E2E_CACHE ?? '/tmp/amethyst-e2e-root'
  console.log(`seeding ${root}${existsSync(cache) ? ` (game files from ${cache})` : ''}…`)
  const seed = await seedDataRoot({ root, cache, force: args.reseed })
  console.log(`seed v${seed.version}: large ${seed.largeId}, game files ${seed.gameFiles ? 'yes' : 'no (install and Play are skipped)'}`)

  const targets: Target[] = args.target === 'both' ? ['dev', 'packaged'] : [args.target as Target]
  const summaries: Record<string, Record<string, number | undefined>> = {}
  const bundle = bundleSize()
  for (const target of targets) {
    if (!existsSync(binaries[target].bin) || (target === 'dev' && !existsSync(path.join(appDir, 'out/main/index.js')))) {
      console.warn(`skipping ${target}: build it first (${target === 'dev' ? 'pnpm build' : 'pnpm dist'})`)
      continue
    }
    const dir = path.join(out, target)
    await mkdir(dir, { recursive: true })
    if (args['mods-only']) {
      await resetRoot(root, false)
      const mods = await launch(target, root, 'mods', path.join(dir, 'mods.json'))
      summaries[target] = Object.fromEntries(Object.entries(summarise([], undefined, mods)).filter(([, v]) => v !== undefined))
      continue
    }
    if (args.steps) {
      await resetRoot(root, false)
      const full = await launch(target, root, 'full', path.join(dir, 'full.json'), { AMETHYST_BENCH_STEPS: args.steps })
      summaries[target] = Object.fromEntries(Object.entries(summarise([], full, undefined)).filter(([, v]) => v !== undefined))
      continue
    }
    console.log(`\n[${target}] warm-up start`)
    await resetRoot(root, false)
    await launch(target, root, 'startup', path.join(dir, 'warmup.json'))
    const startups: Json[] = []
    for (let i = 0; i < starts; i++) {
      const r = await launch(target, root, 'startup', path.join(dir, `startup-${i}.json`))
      startups.push(r)
      const st = r.startup as Json | undefined
      console.log(`[${target}] start ${i + 1}/${starts}: FCP ${fmt(st?.firstContentfulPaint)} ms, interactive ${fmt(st?.interactive)} ms, runtime ${fmt(st?.runtimeBooted)} ms`)
    }
    let full: Json | undefined
    let mods: Json | undefined
    if (!args['no-full']) {
      console.log(`[${target}] full run (cold index, ${Math.round(idleMs / 1000)} s idle windows)…`)
      await resetRoot(root, true)
      const extra: Record<string, string> = {}
      if (args.trace) extra.AMETHYST_BENCH_TRACE = path.join(dir, 'trace')
      if (args.heap) extra.AMETHYST_BENCH_HEAP = path.join(dir, 'heap')
      if (args['cpu-prof'] && target === 'dev') extra.AMETHYST_RUNTIME_CPU_PROF = path.join(dir, 'cpu-prof')
      full = await launch(target, root, 'full', path.join(dir, 'full.json'), extra)
      console.log(`[${target}] Mods tab run (warm index)…`)
      await resetRoot(root, false)
      mods = await launch(target, root, 'mods', path.join(dir, 'mods.json'))
    }
    summaries[target] = { ...summarise(startups, full, mods), 'renderer entry JS (KB gzip)': bundle.eagerJsKB, 'renderer entry CSS (KB gzip)': bundle.eagerCssKB }
  }
  await writeFile(path.join(out, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), starts, idleMs, summaries }, null, 2)}\n`)

  const before = args.compare ? (JSON.parse(await readFile(args.compare, 'utf8')) as { summaries: typeof summaries }).summaries : undefined
  for (const [target, summary] of Object.entries(summaries)) {
    console.log(`\n### ${target}\n`)
    console.log(before ? '| Metric | Before | After |\n|---|---:|---:|' : '| Metric | Value |\n|---|---:|')
    for (const [k, v] of Object.entries(summary)) console.log(before ? `| ${k} | ${fmt(before[target]?.[k])} | ${fmt(v)} |` : `| ${k} | ${fmt(v)} |`)
  }
  console.log(`\nresults in ${out}`)
}

await main()
