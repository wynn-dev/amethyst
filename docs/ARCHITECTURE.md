# Amethyst architecture

Amethyst is a Minecraft launcher for **macOS 13+ on Apple Silicon**. It is an Electron app
with a React renderer, organised as a pnpm monorepo.

## Clean-room policy

Amethyst is an independent, clean-room implementation. Contributors and agents implementing
features **must not read, copy, or port code from other launchers** (including XMCL, Prism,
MultiMC, HMCL). Work from:

- the behavioural specs in [`docs/specs/`](specs/)
- public documentation: minecraft.wiki, wiki.vg, Mojang piston-meta, Fabric/Quilt meta,
  Forge/NeoForge maven, docs.modrinth.com, docs.curseforge.com, Microsoft identity docs
- observing real data (downloading a version JSON, opening a jar, calling an API)

## Layout

```
apps/desktop          Electron app (main, preload, renderer) built with electron-vite
packages/task         task trees, progress aggregation, cancellation, mapLimit
packages/net          HTTP client + parallel, resumable, checksum-verified downloader
packages/nbt          NBT read/write
packages/zip          zip read/write helpers
packages/content      parsers: mods, resource packs, shader packs, saves, options.txt; hashing
packages/marketplace  Modrinth v2 + CurseForge v1 API clients
packages/auth         Microsoft (MSA → XBL → XSTS → MC) + offline accounts, profiles, skins
packages/game         version JSON model, inheritance resolution, launch (args, classpath, natives)
packages/installer    vanilla, Forge, NeoForge, Fabric, Quilt installers
packages/java         JVM discovery on macOS + Mojang runtime download (mac-os-arm64)
packages/modpack      .mrpack and CurseForge zip import/export
packages/telemetry    consent-gated, scrubbed PostHog telemetry (see docs/PRIVACY.md)
docs/specs            behavioural specs (source of truth for features)
```

Dependency direction (no cycles):

```
task ← net ← {installer, java, modpack, marketplace, auth}
zip ← {content, installer, modpack, game}
nbt ← content
game ← installer
marketplace ← modpack
everything ← apps/desktop (main process only)
```

## Package rules

- **ESM + TypeScript source.** Packages export `./src/index.ts` directly; there is no build step.
  electron-vite bundles them into the main process. Keep `exports` in `package.json` accurate.
- **No Electron imports in `packages/*`.** Packages are pure Node (≥ 24) so they can be tested
  with Vitest and reused in workers. Electron specifics live in `apps/desktop/src`.
- **Never block the event loop.** No `*Sync` fs calls outside startup code. CPU-heavy work
  (hashing many files, unzipping large archives, LZMA) should be streamable and must be safe
  to run inside a `worker_threads` worker.
- **Cancellation everywhere.** Every long-running function accepts an `AbortSignal` (directly
  or via `TaskContext`) and stops promptly when it fires.
- **Progress through `@amethyst/task`.** Long operations accept an optional `TaskContext` and
  report through `ctx.update` / `ctx.child`. Never emit progress more often than needed;
  the task tree already throttles listener notifications.
- **Errors are typed.** Throw `Error` subclasses with a stable `code` string (e.g.
  `ECHECKSUM`, `EXSTS_NO_ACCOUNT`) so the UI can map them to friendly messages.
- **Validate external data.** Treat every API response, version JSON, and archive as untrusted:
  check shapes before use, guard against path traversal (`..`, absolute paths) when extracting.
- **Minimal dependencies.** Prefer Node built-ins (`fetch`/undici, `crypto`,
  `zlib`). Every new dependency needs a reason in the PR.
- **Tests.** Co-locate as `src/**/*.test.ts`. Unit tests must run offline using small fixtures
  in `src/__fixtures__/`. Tests that hit the network are wrapped in
  `describe.runIf(process.env.AMETHYST_NET_TESTS)` and are not run in CI by default.

## Desktop app: process model

Amethyst uses three tiers of processes, so the UI can never be blocked by background work.

```
renderer (React)  ──MessagePort──▶  runtime (utilityProcess)  ──▶  worker_threads
      │                                   │                         (hashing, unzip, SQLite, LZMA)
      └──ipc (window/OS only)──▶  main (Electron)  ◀──host calls──┘
```

- **`src/main`: the Electron main process.** It handles windows, menus, dock, tray, dialogs,
  the updater, and supervising the runtime. Keep it tiny: no domain logic, no fs scanning, no
  network beyond the updater. It serves `MainServices` over `ipcMain` and `HostServices` to the
  runtime (`safeStorage`, `shell.trashItem`, and other Electron-only APIs).
- **`src/runtime`: the runtime utility process.** It owns every domain service: instances,
  installs, downloads, resources, accounts, launch, Java, marketplace, telemetry. Each service
  is registered with `registerService(name, impl)` and pushes events with `emit()`. The main
  process restarts it with backoff if it crashes; renderers get a fresh port automatically, and
  in-flight calls fail with `ERUNTIME_RESTARTED`.
- **Workers.** CPU-bound or blocking work (hashing many files, scanning folders, LZMA, the
  SQLite connection) runs in `worker_threads` that the runtime owns. Pools must recover from
  crashes and support cancellation.
- **`src/preload`.** A single sandboxed CommonJS preload. It receives the runtime port and
  exposes `window.amethyst` (see `shared/rpc.ts`). Calls are routed by service name: names in
  `MAIN_SERVICES` go to main, everything else goes to the runtime.
- **`src/shared`.** The contract shared between processes: `services.ts` (RPC surface),
  `events.ts` (push events) and `rpc.ts` (transport). Nothing else crosses process boundaries.
- **`src/renderer`.** React 19 + Tailwind v4 + Radix primitives. TanStack Router with lazy
  routes, TanStack Query for RPC reads, Zustand for local UI state.

### IPC rules

1. One call per user intent; no chatty polling. Reads are cached by TanStack Query.
2. Push **small change events**, not full state. Large collections (mods, versions) are fetched
   on demand, row-sized, and invalidated by change events. Coalesce events to at most one
   batch per frame.
3. Task progress is pushed as throttled snapshots (4–10 per second per task tree), never polled.
4. Payloads must be structured-cloneable and small; never send file contents over IPC.
   Local images are served through the `amethyst-asset:` protocol, and CDN images are loaded
   directly by the renderer.
5. Every buffer is bounded: game log ring buffers, task history, pending event queues.

### Performance budgets

See [`docs/specs/performance.md`](specs/performance.md) for the full rules. The headline budgets:

- Cold start to interactive ≤ 1000 ms, first paint ≤ 400 ms. Nothing on the paint path waits
  on the network or the runtime.
- Clicking Play to the Java process starting ≤ 500 ms when the version is already installed.
  Launching never waits on optional scans.
- Idle CPU < 0.5 %. No free-running timers; pause background work while the window is hidden.
- Renderer entry ≤ 350 KB compressed JS. Every route and every heavy library (the 3D skin
  viewer, markdown) is lazy-loaded.
- Any list that can exceed 50 rows is virtualised.
- Boot work in the runtime is limited to reading settings and the instance index and opening
  the DB. Everything else is deferred until after first paint and is cancellable.

### Storage

- App data root: `~/Library/Application Support/Amethyst`.
- JSON documents (settings, instances) written atomically (write temp + rename).
- Resource metadata index: `better-sqlite3` in WAL mode, owned by a worker thread in the runtime.
  Writes are batched in transactions.
- Secrets (refresh tokens) encrypted with Electron `safeStorage` (Keychain-backed).

## Releases

Every push to `main` builds a signed and notarized arm64 build and replaces the rolling
`nightly` GitHub release. `electron-updater` reads that release's `latest-mac.yml`.

- `.github/workflows/nightly.yml` stamps the version `0.1.0-nightly.<run_number>`, runs the checks,
  signs (Developer ID, hardened runtime), notarizes and staples the app and the dmg, verifies them
  with `codesign`/`spctl`, smoke-tests the signed app, then deletes and recreates the `nightly`
  release and tag. It never touches any other release.
- `.github/workflows/ci.yml` checks PRs without secrets, including an unsigned `pnpm dist` and a
  smoke test of the packaged app.
- Packaging config is `apps/desktop/electron-builder.yml`; entitlements and the icon live in
  `apps/desktop/build/` (regenerate the icon with `pnpm --filter @amethyst/desktop icon`).
- `pnpm dist` builds an unsigned dmg and zip locally in `apps/desktop/release/`.
- Only modules that must exist at run time go in `apps/desktop` `dependencies` (they ship as
  node_modules inside the asar); everything electron-vite bundles is a `devDependency`.

Telemetry (`packages/telemetry`, served by the runtime's `telemetry` service) is described in
[`docs/PRIVACY.md`](PRIVACY.md).
