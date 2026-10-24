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
  with Vitest and reused in workers. Electron specifics live in `apps/desktop/src/main`.
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

## Desktop app

- `src/main`: services (instances, resources, install, launch, accounts, java, settings,
  telemetry, updater). Services are registered on the RPC server by name.
- `src/preload`: a single sandboxed CommonJS preload exposing `window.amethyst` (see `shared/rpc.ts`).
- `src/shared`: types shared by main and renderer: `services.ts` (RPC surface), `events.ts`
  (push events). These are the only contract between processes.
- `src/renderer`: React 19 + Tailwind v4 + Radix primitives. TanStack Router (lazy routes),
  TanStack Query for RPC reads, Zustand for local UI state.

### IPC rules

1. One `invoke` per user intent; no chatty polling. Reads are cached by TanStack Query.
2. The main process pushes **events**, not full state. Large collections (mods, versions) are
   fetched on demand and invalidated by small change events.
3. Task progress is pushed as throttled snapshots (≤ 10/s per task tree).
4. Payloads must be structured-cloneable and small; never send file contents over IPC.
   Images are served through the `amethyst-asset:` protocol.

### Storage

- App data root: `~/Library/Application Support/Amethyst`.
- JSON documents (settings, instances) written atomically (write temp + rename).
- Resource metadata index: `better-sqlite3` in WAL mode, accessed only from the main process
  (or a dedicated worker).
- Secrets (refresh tokens) encrypted with Electron `safeStorage` (Keychain-backed).

## Releases

Every push to `main` builds a signed and notarized arm64 build and replaces the rolling
`nightly` GitHub release. `electron-updater` reads that release's `latest-mac.yml`.
