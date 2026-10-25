# Performance

This is the performance sweep of the feature-complete app: how it is measured, the numbers
before and after, what was fixed and what is left. The budgets are the ones in
[ARCHITECTURE.md](ARCHITECTURE.md#performance-budgets) and [specs/performance.md](specs/performance.md) §9.

## Method

### The harness

```sh
pnpm build && pnpm dist                       # the dev build (out/) and the unsigned packaged app
pnpm --filter @amethyst/desktop bench         # both targets, ~25 min
pnpm --filter @amethyst/desktop bench --quick --target dev
pnpm --filter @amethyst/desktop bench --compare /tmp/before/summary.json
```

- `scripts/bench/run.ts` drives everything. It builds the seeded data root, then per target runs one
  warm-up start (discarded), five cold starts, one full run on a **cold resource index** (the SQLite
  index and icon cache deleted) and one Mods-tab run on the now **warm index**. It writes every
  run's JSON and a `summary.json` to `--out` (default `/tmp/amethyst-bench-results`) and prints
  the table below. `--trace` records a DevTools trace of the interaction phase (summarise it with
  `scripts/bench/trace-summary.ts`), `--heap` writes heap snapshots around the 50 navigations,
  `--cpu-prof` writes a CPU profile of the runtime's main thread (`AMETHYST_RUNTIME_CPU_PROF`,
  through the inspector, since Electron utility processes ignore `--cpu-prof`). `--mods-only` and `--steps a,b` run a slice
  for quick experiments; `AMETHYST_BENCH_CSS` injects CSS into the page (that is how the table
  header's backdrop blur was singled out).
- `AMETHYST_BENCH=<out.json>` is the in-app driver (`src/main/bench.ts`, loaded lazily; inert
  otherwise). Like the smoke test it also works in the packaged app, always in the data root given
  as `AMETHYST_BENCH_ROOT` and with logs inside it, never the user's.
- `AMETHYST_IPC_STATS=1` makes the preload count every message and its JSON size through the
  bridge, per channel and per method or event (`window.amethyst.ipcStats`). Off, it costs one
  `undefined` check per message.
- Startup marks: `performance.mark('amethyst:…')` in the renderer (`entry`, `sidebar-instances`,
  `home-instances`), `mainMark()` in main (`main-start`, `app-ready`, `window-created`,
  `runtime-fork`, `ready-to-show`) and `runtime.ping` (process start and boot end). Everything is
  relative to the moment the harness spawned the process.
- Re-renders are counted with a minimal React DevTools hook injected before the page loads
  (commits, and the components that rendered in each, DevTools' own heuristic). Long tasks come
  from a `longtask` PerformanceObserver.
- Memory is reported as **footprint** (macOS `phys_footprint`, what Activity Monitor calls
  Memory, from `/usr/bin/footprint`) per process kind. RSS is reported too, but it counts the
  shared Electron framework pages once per process (~600 MB for an idle app that really uses
  ~280 MB), so the budgets are read against footprint. CPU is cumulative CPU time per process
  over the window, as % of one core.

### The seeded data root

`scripts/bench/seed.ts`, deterministic, built once into `/tmp/amethyst-bench-seed`: 60 instances
(Fabric 1.20.1 and vanilla 1.21.1, a few small mods in some), and **Bench Large** with 400 Fabric
mods (real jars built with `@amethyst/zip`: `fabric.mod.json`, dependencies, class files, icons of
64–1024 px in typical proportions), 200 resource packs (`pack.mcmeta`, `pack.png`, textures) and
50 worlds (gzip NBT `level.dat`, icon, region data). Game files, Java runtimes and metadata are
cloned from `/tmp/amethyst-e2e-root` (APFS clones), so the install, repair and Play steps run
offline against real files.

### What is measured

| | |
|---|---|
| Cold start | spawn → main module evaluated → app ready → window → FCP → `ready-to-show` → instance list rendered (sidebar and Home); runtime fork → process start → boot done |
| Memory | footprint per process 10 s after start, after visiting every route (all instance tabs, Discover, Home, the Settings window with every pane), 40 s later, after the Mods scroll and 45 s later; renderer JS heap, DOM nodes and listeners after forced GC |
| Idle CPU | 60 s each with the window visible, hidden and minimised; idle wake-ups; IPC and React commits in each window |
| IPC | per second and per message name: idle, Mods tab open, 50 navigations, install and repair |
| Mods tab | first open on a cold index (400 jars hashed and parsed), first open on a warm index, re-open; time to rows and to icons |
| Scrolling | the 400-mod table scrolled 40 px per frame for 5 s: frame times from `requestAnimationFrame`, long tasks, components rendered per frame, renderer and GPU CPU |
| Interaction | instance switch (overview header of 11 instances), Discover search render (network), 50 route navigations (heap growth, listener growth, long tasks), Play click → `launch:state running` |
| Bundle | the renderer entry (`scripts/bundle-size.mjs`) |

Environment: Apple M5 Pro (18 cores, 48 GB), macOS 27.0.1, 120 Hz display, Electron 45.0.0.
Other agents were running builds and E2E drivers on the same machine during some runs, so
treat differences under ~5 % (and single-digit milliseconds) as noise.

## Results

The packaged app, before and after (`--compare`, medians of five cold starts). The dev build
(`electron .` on `out/`) gives the same numbers within noise.

| Metric | Budget | Before | After |
|---|---:|---:|---:|
| **Cold start**: first contentful paint | ≤ 400 ms | 259 ms | 255 ms |
| Cold start: `ready-to-show` | | 202 ms | 203 ms |
| **Cold start: interactive** (instance list rendered) | ≤ 1000 ms | 261 ms | 263 ms |
| Cold start: main module evaluated | | 86 ms | 87 ms |
| Runtime boot (process start → ready) | | 50 ms | 51 ms |
| Runtime booted (from spawn) | | 249 ms | 250 ms |
| **Idle footprint, all processes** (10 s after start) | ≤ 350 MB | 284 MB | 281 MB |
| — main / renderer / runtime / GPU | | 48 / 61 / 57 / 111 MB | 48 / 60 / 56 / 110 MB |
| Idle RSS, all processes (for reference) | | 608 MB | 612 MB |
| Footprint after visiting every route | ≤ 350 MB | 307 MB | 281 MB |
| Footprint 40 s after the routes | ≤ 350 MB | n/a | 245 MB |
| **Footprint after scrolling 400 mods, then 45 s idle** | ≤ 350 MB | **497 MB** | **267 MB** |
| — GPU right after the scroll | | 333 MB | 217 MB |
| — runtime 45 s after the scroll | | 55 MB | 40 MB |
| Renderer JS heap after routes | ≤ 120 MB | 9 MB | 9 MB |
| Runtime JS heap after routes | ≤ 150 MB | 12 MB | 12 MB |
| **Idle CPU**, visible / hidden / minimised | < 0.5 % | 0.3 / 0.1 / 0.1 % | 0.3 / 0.1 / 0.1 % |
| Idle IPC and React commits | 0 | 0 msg/s, 0 commits | 0 msg/s, 0 commits |
| Mods tab, first open, cold index (400 jars) | ≤ 300 ms from cache | 449 ms | **237 ms** |
| Mods tab, first open, warm index | ≤ 300 ms | 53 ms (icons 64 ms) | 52 ms (icons 68 ms) |
| Mods tab, re-open | | 24 ms | 25 ms |
| **Mods scroll**: fps / p95 frame / worst frame | 60+ fps, no task > 50 ms | 120 / 8.4 / 10.4 ms | 120 / 8.8 / 10.4 ms |
| Mods scroll: components rendered per frame | | **966** | **47** |
| Mods scroll: renderer / GPU CPU | | 52 / 15 % | 36 / 14 % |
| Long tasks > 50 ms (scroll, 50 navigations) | 0 | 0 | 0 |
| Instance switch, median / worst | ≤ 100 ms | 8 / 13 ms | 8 / 14 ms |
| Discover search render (network, cached after the first) | | 23 ms | 20 ms |
| 50 navigations: renderer heap / listener growth | < 10 % | +0.5 MB / 0 | +0.4 MB / 0 |
| Repair (re-hash every file of 1.21.1): IPC | 4–10 task batches/s | 31 msg/s, 73 KB/s | 30 msg/s, 72 KB/s |
| **Play click → Java spawned** (installed version) | ≤ 500 ms | 54 ms | 54 ms |
| Renderer entry JS / CSS (gzip) | ≤ 350 / 60 KB | 215 / 12.6 KB | 215 / 12.6 KB |

Every budget is met after the sweep. Before it, the one budget that was missed was memory: after
scrolling the Mods tab the app sat at ~500 MB of footprint, most of it GPU textures held for a
translucent table header.

## What was fixed

1. **Table rows re-rendered on every scroll frame** (`ui/VirtualList.tsx`). `TableRow` was
   memoised, but every frame passed it a new `style` object, a new filtered column array, new
   callbacks and a new context-menu wrapper, and the wrapper evaluated the row's whole menu on
   every render. Scrolling the 400-mod list rendered ~966 components per frame (every visible row,
   its Radix context menu, checkbox and popper providers). Rows now get plain props (`top`,
   `height`, `rowKey`), stable callbacks (`useLatest`), memoised visible columns, and the context
   menu lives inside the memo; `ContextMenu` builds its entries only while open (`ui/Menu.tsx`).
   The Resource Packs and Worlds tabs memoise their columns like Mods already did. Result: 47
   components per frame (only rows entering the window), renderer CPU while scrolling 52 → 36 %.
   Test: `VirtualList.test.tsx` "re-renders only the rows that changed, and builds row menus only
   when one opens".
2. **The sticky table header's backdrop blur held ~200 MB of GPU memory** (`ui/VirtualList.tsx`).
   Found by bisecting effects with `AMETHYST_BENCH_CSS`: with `backdrop-blur-xl` on the sticky
   header inside the scroller, the GPU process kept ~330 MB after a scroll and ~300 MB a minute
   later; without it, ~215 MB and ~80 MB. Isolating the scroller (`will-change`, `contain`) did not
   help. The header is now opaque `bg-window` instead of 90 % `bg-window` plus blur, a 10 %
   see-through that is hardly visible; it is the only visual change of the sweep.
3. **Mod and pack icons were cached and served at full size** (`runtime/resources/thumbnail.ts`,
   `worker-handlers.ts`). Icons of 256–1024 px were drawn at 20–44 pt, so the renderer decoded up
   to 4 MB per icon. The scan workers now store icons larger than 128 px as 128 px thumbnails (a
   small PNG decoder, premultiplied box filter and encoder in plain JS, ~20 ms for a 1024 px icon;
   pixel art scaled by whole numbers stays exact). The icon cache for the seed went from 101 MB to
   25 MB. Cache names carry a `-t128` tag, so full-size icons cached by earlier builds are never
   reused, and the quick listing only points at icons that are actually in the cache.
4. **Icon extraction was on the critical path of a cold scan.** `scanFolder` extracted every
   missing icon, one after the other, before returning any row. It now returns the rows with the
   icons already cached; missing icons are extracted afterwards by `extractIcons` jobs spread over
   the worker pool, and the rows that got one are announced as changed. First open of a 400-mod
   folder on a cold index: 449 → 237 ms to rows (icons stream in right after).
5. **Unreadable icons were re-read on every scan.** An icon that could not be extracted (missing
   from the jar, corrupt, over the size limit) was tried again on every rescan of the folder. A
   `<name>.none` marker (names are content-addressed) now records it, and the read limit is 8 MB
   since the result is shrunk anyway. Test: `resources.test.ts` "rescanning an unchanged folder
   hashes nothing and never retries an icon that cannot be read" (the existing warm-scan test
   already asserts zero hashing for unchanged files).
6. **Scan workers stayed resident for 5 minutes after the last job** (`runtime/index.ts`). They
   grow while hashing and making thumbnails; they now stop 30 s after the last job (respawning one
   costs ~30 ms). The runtime is back to ~40–50 MB footprint shortly after browsing content.

## Checked and found fine

- **Startup.** Interactive at ~260 ms, FCP ~255 ms; nothing on the paint path waits for the
  runtime (the instance list arrives before the first paint), main evaluates its bundle in ~50 ms
  after process start, the runtime boots in ~50 ms (settings, instance index, DB open in parallel)
  and every heavy service is lazy. No long tasks during the renderer start.
- **Idle.** 0 IPC messages, 0 React commits, ~0.3 % CPU visible and ~0.1 % hidden or minimised,
  about one wake-up per second per process (Electron's own). No `setInterval` outside the updater's
  4-hourly check and the manual-download poll that only runs while that sheet is open.
- **IPC.** Events are small; `tasks:update` is throttled to 10 batches per second with pruned
  trees; the heaviest traffic is `resources.list` pages (~30 KB per 100 rows) when a list opens.
- **Leaks.** 50 navigations: +0.4 MB renderer heap, no DOM listener or node growth, no long tasks;
  the heap snapshots before and after are the same size (23 MB).
  Runtime heap stays at ~12–17 MB. Watchers: one per open instance, at most four, released 2 s
  after the last view unmounts.
- **The runtime's event loop.** A CPU profile across a cold 400-mod scan plus every route shows
  the runtime main thread busy for under 100 ms in 12.6 s (most of it compiling lazily loaded
  service chunks): hashing, parsing, thumbnails and SQLite all run in workers.
- **Scans and SQLite.** A rescan of an unchanged folder hashes and parses nothing (size, mtime,
  inode and parser version match the index); index writes are one transaction per folder in the DB
  worker; no sync fs calls outside startup code.
- **Bundle.** Entry 215 KB gzip of JS (budget 350); the 3D skin viewer and markdown are lazy.
- **Launch.** Play → spawn ~54 ms on an installed version.

## Measured and not adopted

- **V8 compile cache for main and the runtime** (`NODE_COMPILE_CACHE` / `module.enableCompileCache`).
  It works under Electron 45, but saved ≤ 4 ms of the 50 ms runtime boot and nothing measurable in
  main, whose start is dominated by Electron itself. Not worth a bootstrap entry.
- **Renderer code cache.** Chromium does not cache code for `file://` pages, so the renderer
  compiles its ~650 KB of JS on every start. Serving the bundle from a privileged custom scheme
  with `codeCache: true` would fix that, but it changes the page origin (and with it localStorage,
  where first-run state and view preferences live) for a gain bounded by the ~50 ms between
  navigation start and the entry script.

## What remains

- **Closing the Settings window blocks the main thread for ~100 ms** (`BrowserWindow.close()` on
  a vibrancy window, measured by the harness; the only main-thread task over 50 ms in the traces).
  It happens once per close, while the window animates out.
- **Opening the Accounts pane of Settings** raises GPU footprint to ~340 MB while Settings is
  open (the 3D skin viewer); it drops back when the pane is left and the window closed.
- **Instance visits refetch more than they need.** `markOpened` emits `instances:changed`, which
  refetches the whole instance list (~16 KB for 60 instances), the instance detail, its install
  status and its Java recommendation on every visit. Cheap today (switches take ~8 ms), but an
  event that says which fields changed would avoid it.
- **Old full-size icons stay in `cache/icons`** after the upgrade until the cache is cleared; nothing
  references them.
- **Renderer footprint right after a long scroll** is ~190 MB (decoded images and DOM churn); it
  falls back to ~85 MB within a minute.
- **The install path is only measured offline.** With all files cached, install and repair finish
  in ~0.5 s and send ~30 msg/s; a real download install is bounded by the 10 Hz task throttle, but
  its IPC rate is not in the table.
- **Measurement rule (specs §9 rule 14)** is not automated: the harness is a local tool, not a CI
  job. Running it on CI needs a macOS runner with the E2E cache and ~25 minutes.
