# Performance Review of the Reference Launcher (XMCL): Design Rules for Amethyst

This is a code-level performance review of the reference launcher, X Minecraft Launcher (XMCL) v0.72.0. Each finding comes with a recommended design for Amethyst (Electron + React, macOS 13+ on Apple Silicon only).

**Clean-room note.** Findings are written as prose. File paths into the reference tree (`/Users/weishanglu/src/_ref/xmcl`) are given as internal evidence only. No reference code is reproduced. Recommended designs describe behaviour and structure, not the original implementation.

**Method.**
- Static reading of the reference source: main process (`xmcl-electron-app/main`), runtime (`xmcl-runtime`), shared packages (`packages/*`), preload bridges, and the Vue renderer (`xmcl-keystone-ui`).
- Measurements of the published `app-0.72.0-mac-arm64.asar` release artifact: file sizes, and which renderer assets the entry HTML loads eagerly.
- No profiler was run. Impact estimates are order-of-magnitude judgements for an M1/M2-class Mac with a typical user library (10–30 instances, 100–400 mods in the active instance, a few thousand files under the data root).

**Impact scale.**
- **High**: users can see it (jank over 100 ms, startup delayed by 0.5 s or more, freezes, memory growing by hundreds of MB, battery drain).
- **Medium**: measurable waste that adds up under load.
- **Low**: hygiene.

---

## 0. Executive summary

The reference architecture has a single process doing everything. The Electron main process hosts the whole runtime: about 45 services and 45 plugins, the resource database (synchronous SQLite), the HTTP download engine, every file-system watcher, the game-process log pipeline, and a proxy for every HTTP request the renderer makes. Most of the performance problems follow from that. Any slow piece of work in the main process (a SQL query, a burst of download chunks, a chatty game log) also stalls IPC replies, window events, and the asset loading that the UI needs to paint.

Second, the renderer root eagerly subscribes to every per-instance data domain at startup and whenever the selected instance changes. Mods, resource packs, shader packs, saves, server list, options, install status, Java, versions, users, and several network catalogs are all loaded no matter which page is open. It then re-validates all of them on every window focus event.

The ten highest-value changes for Amethyst, in priority order:

1. Move the runtime out of the Electron main process into a Node **utility process**, and keep the main process for windows, menus, and OS integration only. (Sections 1, 3, 4)
2. Run SQLite **off any event loop that serves UI or IPC**: a dedicated worker with batched transactions and prepared statements. (R1, R3)
3. Make data subscriptions **route-scoped and lazy**. Never scan a domain that no visible view needs. (S5, I5)
4. Replace whole-object state mirroring with **versioned, coalesced patches** sent at most once per frame, plus selector-based subscriptions in React. (I2, I3, V3)
5. Stop proxying renderer HTTP through main-process JavaScript. Serve the app bundle from a **privileged custom scheme with code cache**, and serve content-addressed images with immutable cache headers. (S6, I7, R8)
6. Cut the renderer's **eager payload** from about 4.6 MB to under 1 MB: lazy routes, no 3D/AI/markdown libraries in the entry chunk, and subset icon fonts or SVG sprites. (S4)
7. Build the download engine with **bounded memory**: backpressure, temp file plus atomic rename, hashing while streaming, HTTP/2 where available, and modest per-origin concurrency. (D2–D4)
8. Use one **bounded hashing/parsing worker pool** that reads each file once and computes every digest in a single pass. It must survive crashes and support cancellation. (R5)
9. **Bound every buffer tied to game-session or task lifetime** (logs, task history, pending promises). Batch game output to the UI. (M1, M2, I4)
10. Set an **energy budget**: no always-on intervals, pause everything while hidden or occluded, no animated or blurred full-window effects by default. (Sections 5–6)

---

## 1. App startup path

### S1. A monolithic main bundle is parsed and run on every boot. Impact: High (cold start)

**Evidence.**
- The release asar has a single main-process bundle, `index.js`, of **6.0 MB**. It is CommonJS, whitespace- and syntax-minified with names kept, and has no code splitting.
- Every service class and every plugin is statically imported from `xmcl-electron-app/main/definedServices.ts` and `definedPlugins.ts`. So all of it is compiled and its module top-levels run before the first window exists. That includes multiplayer/WebRTC, Bedrock, the AI agent, and authlib/Ely.by, which have nothing to do with showing a window.
- Services are created lazily on first IPC call (`xmcl-runtime/service/pluginServicesHandler.ts`, which is good). But all ~45 plugins run inside the `LauncherApp` constructor (`xmcl-runtime/app/LauncherApp.ts`).
- Those plugins do real work at boot:
  - open the SQLite database and run migrations;
  - run a full-table "sweep corrupted refs" pass (`xmcl-runtime/resource/pluginResourceWorker.ts`);
  - build the OpenTelemetry SDK (`infra/plugins/telemetry.ts`);
  - build the undici agent and start a 1 Hz sampler (`network/pluginNetworkInterface.ts`);
  - load flights;
  - read disk info;
  - start a localhost HTTP server.
- The asar also ships an **8.4 MB** WebRTC native module and a **1.2 MB** FFI native module. They are wired in through bundler lazy-init wrappers, but they live in the same bundle graph.
- There is no V8 code cache or snapshot for the main bundle, so every launch parses and compiles from scratch.

**Recommendation for Amethyst.**
- Use three tiers of main-side code:
  - (a) a **tiny main-process entry** (target under 300 KB) that creates the window, menus, and tray, and starts the runtime;
  - (b) a **runtime utility process** (`utilityProcess.fork`) that holds the domain services;
  - (c) **workers** for CPU-bound work.
- Code-split the runtime by feature. Load each feature module on first use through a registry (dynamic `import()`). Loading must not depend on plugin side effects.
- Boot-time work in the runtime is limited to: reading settings, reading the instance index, and opening the DB (opening only, with migrations at most). Everything else, including telemetry, catalog refresh, Java rescan, and corruption sweeps, is deferred until after first paint plus idle time (e.g. `requestIdleCallback`-style scheduling in the runtime, or a 2–5 s delay), and is cancellable.
- Enable V8 compile caching for the main and utility entries (Node's module compile cache, or `v8.Script` cached data stored under the app's cache directory). Measure with and without.
- Native modules are imported only by the feature that needs them, and never at boot.

### S2. Remote configuration sits on the critical render path. Impact: High on first run, Low afterwards

**Evidence.**
- The renderer HTML loads a **blocking classic script** from `http://launcher/flights` in `<head>`, before the app bundle (`xmcl-keystone-ui/src/index.html`).
- The main-process handler for that URL waits for the flights promise (`xmcl-runtime/infra/plugins/flights.ts`).
- When there is no cached flights file (first run, or after a cache wipe), that promise races a network fetch against a **2 s timeout**. The HTML parser, and therefore first paint, can be blocked for up to 2 s.
- Every outgoing HTTPS request proxied through the main process also awaits the flights registry entry (`xmcl-runtime/app/pluginApiFallback.ts`). This is cheap once resolved, but it is on the critical path at boot.

**Recommendation.**
- Feature flags must never block paint. Ship built-in defaults in the bundle.
- Apply cached remote values synchronously from local storage, through the preload, before React mounts. Fetch fresh values in the background and apply them on next launch (or live, only for flags that are safe to change at runtime).
- Never put a network round trip between `app.whenReady()` and first paint.

### S3. Window creation waits on serial file I/O. Impact: Medium

**Evidence.** `LauncherApp.onEngineReady` and `ElectronController.createAppWindow` (`xmcl-electron-app/main/ElectronController.ts`) do the following in sequence before `new BrowserWindow`:
1. read `apps.json` (the "installed app manifest");
2. possibly install a remote app manifest;
3. wait for the bootstrap signal, which needs `setup()` to read the `root` pointer file and run migration checks;
4. read the window-size tracker config;
5. load the full settings object.

The window does set `backgroundColor` and `show:false`, and shows on `ready-to-show`. That part is good.

**Recommendation.**
- Create the `BrowserWindow` as soon as `whenReady` resolves. Use the last-known bounds read synchronously from a tiny JSON file, or a default.
- Load the renderer at once. Do settings, data root resolution, and migrations in parallel in the runtime, and stream them to the renderer when ready.
- Drop the pluggable remote "app manifest" indirection entirely. Amethyst ships one UI.

### S4. The renderer's eager payload is about 4.6 MB. Impact: High (time to interactive, memory)

**Evidence (measured from the release asar).**
- The entry HTML references **68 assets totalling about 4.58 MB** through `<script>` and `modulepreload`.
- The entry chunk alone is **2.84 MB**. It contains three.js (the `WebGLRenderer` symbol appears 47 times) and AI-agent code. The router statically imports Home, Mod, ResourcePack, Save, ShaderPack, Store, Setting, Me, and the multiplayer view (`xmcl-keystone-ui/src/windows/main/router.ts`), and `App.vue` statically imports the agent composable.
- Further eager assets:
  - the Vuetify `VApp` chunk, 440 KB;
  - CSS of about 480 KB (index 210 KB, Vuetify 191 KB, VApp 80 KB);
  - a 280 KB Material Symbols font and Roboto fonts.
- Across 106 chunks there is about 9.1 MB of renderer JavaScript.
- Sourcemaps are referenced, though shipped externally.
- Locales are split per language, which is good. But the minifier keeps all class and function names, which inflates the output.

**Recommendation.**
- Entry budget: at most **350 KB of compressed JS and 60 KB of CSS** for the shell and the home route. Every other route is `React.lazy` with a route-level `Suspense` and prefetching while idle.
- Heavy optional libraries (3D skin viewer, block renderer, markdown, charting, any AI SDK) load only inside the component that uses them. CI fails the build if they show up in the entry chunk (bundle-analyzer manifest check).
- Icons: use an SVG sprite or per-icon React components, tree-shaken. No full icon fonts.
- Fonts: use the macOS system font (`-apple-system`/SF Pro). Bundle no Roboto.
- Production builds minify names (keep names only in dev) and strip sourcemap URLs from shipped files. Upload sourcemaps to the crash backend instead.

### S5. The root renderer context eagerly loads every instance domain. Impact: High (startup and instance-switch jank)

**Evidence.**
- The main window's root context (`xmcl-keystone-ui/src/windows/main/Context.ts`) runs, on mount and again whenever the selected instance changes, the composables for:
  - users, Java, local versions, instances, instance version and Java resolution;
  - options, saves, server info, resource packs, mods, shader packs, blueprints (gated), and install status;
  - launch task, mod upgrade, install instructions;
  - Modrinth and CurseForge catalog tags and categories;
  - the latest Minecraft release, the XMCL account, local collections, and more.
- Each of these calls a `watch…` service method. In the runtime that **starts a chokidar watcher and a full directory scan** for that domain (`xmcl-runtime/instance/AbstractInstanceDomainService.ts`, `InstanceSavesService.ts`, `InstanceOptionsService.ts`, `InstanceServerInfoService.ts`, `instanceIO/InstanceInstallService.ts`).
- So the first frame of the home page starts about 8 directory scans plus hashing and parsing of any new or changed files. A mods folder with 300 jars and no snapshot rows means 300 hash jobs and 300 zip parses before the mod list settles.
- This matches the issue reports: "freeze on instance switch" (#1245) and "Play button spins with 1,000 schematics" (#1734).

**Recommendation.**
- **Subscriptions belong to views.** A domain query (mods, saves, packs, …) is opened by the route or component that displays it, and closed (with a short grace period, e.g. 10 s) when that view unmounts.
- The home page needs only the instance summary: name, version, loader, mod *count*, last played. That summary is precomputed by the runtime and stored in the instance index.
- The launch path reads only the version JSON, libraries, and Java. It never waits on content scans (see known-issues #1734).
- Switching instances cancels in-flight scans for the previous instance (AbortSignal propagated into the worker pool).

### S6. Renderer assets are served through main-process JavaScript. Impact: Medium (startup), Medium (ongoing)

**Evidence.**
- The UI is loaded from `http://xmcl.runtime/index.html`. The session intercepts **all `http` and `https`** requests with `protocol.handle` (`xmcl-electron-app/main/ElectronSession.ts`).
- Each app asset is served by opening a Node read stream, converting it to a WHATWG stream, and setting the MIME type through a long if-else chain. Every one of the 68 eager assets costs a main-process JavaScript round trip.
- No `Cache-Control` or ETag headers are set. That probably prevents Chromium from reusing its HTTP and V8 code caches across launches. (Not verified with tracing. Treat it as a strong suspicion.)

**Recommendation.**
- Register one privileged custom scheme, e.g. `amethyst://app/`, with `standard`, `secure`, `supportFetchAPI`, and **`codeCache: true`**. Serve the bundle straight from the asar with long-lived immutable caching for hashed filenames.
- Do not intercept `http`/`https` at all (see I7).
- Measure the V8 code-cache hit rate on second launch with `chrome://tracing` (the `v8.compile` events).

### S7. JVMs are spawned on every boot to re-validate Java. Impact: Medium (CPU spike, about 0.5–2 s of background CPU)

**Evidence.**
- When `JavaService` initializes (`xmcl-runtime/java/JavaService.ts`), it re-validates every cached Java, one after another, by running the binary.
- It then scans the common locations and, **in parallel**, runs every discovered Java again to detect its architecture (`java/detectJVMArch.ts` runs a helper class). It also rewrites that helper class file to the app data directory on every init.
- With 4–6 JDKs, that is 8–12 JVM start-ups, each roughly 100–300 ms of CPU and 30–60 MB of transient memory, on every launcher start.
- Separately, the arch probe reports the JVM *data model* ("64"), which the code maps to x64. On Apple Silicon this mislabels arm64 JDKs. That is a correctness bug, recorded in known-issues.

**Recommendation.**
- Identify Java runtimes **without running them** where possible. Read `<home>/release` (JAVA_VERSION, IMPLEMENTOR, OS_ARCH) and the Mach-O header of `bin/java` for the CPU type.
- Cache results keyed by `(realpath, inode, mtime)`. Re-validate only when that key changes. Run the JVM only as a fallback, at most 2 in parallel, after first paint.

### S8. The database is opened, migrated, and swept on the main thread at boot. Impact: Medium

**Evidence.**
- `pluginResourceWorker.ts` opens `resources.sqlite` through synchronous `node:sqlite` in the main process, with `locking_mode=EXCLUSIVE` and WAL. It runs migrations with up to three retry/rename cycles, then launches a full-table corrupted-reference sweep.
- All of this is synchronous inside the main event loop (see R1).

**Recommendation.**
- Open the DB in its own worker (R1). Run migrations once per schema version. Gate corruption sweeps behind a schema-version or "last swept" marker, so they run in idle time at most once per version upgrade.

---

## 2. IPC design and chattiness

### I1. A generic string-dispatched RPC with per-call tracing. Impact: Low–Medium

**Evidence.**
- The renderer calls `service-call(serviceKey, methodName, ...args)` (`xmcl-electron-app/preload/service.ts`). The main process looks up the service, creates it lazily, and invokes the method by name (`xmcl-runtime/service/pluginServicesHandler.ts`).
- Every call is wrapped in an OpenTelemetry span and emits a `service-call-end` event. Errors are serialized through an async normalizer.
- There is no schema validation, so non-cloneable payloads fail at runtime (known-issues #1430). There is no cancellation and no request coalescing.

**Recommendation.**
- Use a **typed RPC contract** shared between packages, with zod or valibot schemas validated at the boundary in dev and test (sampled in production). Calls take an AbortSignal (cancellation forwarded as a message).
- Identical in-flight read queries are deduplicated.
- Tracing is sampled (e.g. 1–5 %), not done on every call.

### I2. State mirroring copies whole objects three times and sends one message per mutation. Impact: High under load

**Evidence.**
- When a service returns a "state object", the main process serializes it with a JSON round trip (`ServiceStateManager.serializeAndTrack` in `xmcl-runtime/service/ServiceStateManager.ts`). Electron's structured clone copies it again, and the preload/context-bridge boundary copies it a third time.
- After that, **every mutation method call** on the main-side state emits one `commit` IPC message to every tracked client (`ServiceStateContainer.track`). There is no frame-level coalescing. Some producers batch on their own; the resource watcher uses a 500 ms aggregator.
- The renderer applies the mutation and then triggers the *whole* state ref (`xmcl-keystone-ui/src/composables/syncableState.ts`), so every derived computed recomputes.
- The design also lets the renderer invoke *any* mutation on main-side state through a generic `commit` channel. That is a correctness and security smell.

**Recommendation.**
- Use **versioned snapshots plus patches**. Each query has a monotonically increasing version. The runtime sends `{queryId, fromVersion, toVersion, ops[]}` coalesced to at most one message per 16–50 ms per query.
- If the renderer misses a version, it requests a fresh snapshot.
- Renderer state lives in a store with **selector subscriptions** (e.g. `useSyncExternalStore`, or a small store like Zustand with per-key selectors), so only components whose slice changed re-render.
- The renderer never mutates runtime state directly. It sends *commands* (intent), and the runtime emits patches.

### I3. Mutation payloads are oversized and fan out to every domain. Impact: Medium–High

**Evidence.**
- Resource-list mutations carry **entire resource objects**: path, hashes, every loader's parsed metadata, icons, URIs, and marketplace references (`packages/resource/core/watchResourcesDirectory.ts`, `xmcl-runtime-api/src/entities/resource.ts`).
- Marketplace metadata updates are published on a shared event bus. *Every* watched directory subscribes to it and pushes a batch-update mutation into its own state, whether or not the hashes are relevant. Each of those is then sent over IPC.
- Applying a batch update in the state class scans the whole file list for every update (nested loops). Upserts and removals use `findIndex` over the whole list per operation.

**Recommendation.**
- Wire payloads are **view models, not domain records**. A mod row needs about 10 fields (id, file name, display name, version, loader(s), enabled, icon URL, project refs, problem flags). Full metadata is fetched on demand when a detail panel opens.
- Index records by stable id (`Map<id, row>`), so patches are O(1) per op.
- Route metadata updates only to the queries that contain the affected content hashes (a reverse index from hash to query ids in the runtime).

### I4. Service events are broadcast to all windows. This includes game output per chunk. Impact: Medium–High while playing

**Evidence.**
- Every `emit` on a service broadcasts a `service-event` to **every BrowserWindow** whether or not anyone listens (`xmcl-runtime/service/Service.ts`, `ElectronController.broadcast`).
- The launch service emits a `minecraft-stdout`/`minecraft-stderr` event **for every pipe chunk** of game output (`xmcl-runtime/launch/LaunchService.ts`). Each chunk is first decoded through a worker round trip, logged to the launcher log, and stored.
- A modded client can produce thousands of lines per second during loading, and all of them become IPC traffic plus renderer work even when the log view is closed.

**Recommendation.**
- Events are **topic subscriptions**. The runtime keeps per-window subscriber sets and sends nothing for topics nobody subscribed to.
- Game output goes into a **ring buffer** in the runtime, for example the last 20k lines or 8 MB. The log view subscribes and receives batched appends (at most 10 per second, each up to N lines). When the view opens, it pulls the tail.
- Decode once in the runtime with a streaming decoder (`TextDecoder` with `stream:true`). Use UTF-8 by default on macOS and sniff legacy encodings only if decoding fails. No worker round trip per chunk.

### I5. Every window focus re-validates every state. Impact: High (CPU on every Cmd-Tab)

**Evidence.**
- The renderer registers a global listener on `focus` and `visibilitychange` that calls `revalidate()` on **every live state** (`syncableState.ts`).
- In the runtime, revalidating a resource domain means: `readdir` plus `stat` of every entry, a SQL query with a LIKE filter and an inode IN-list, a second SQL query for all resources with an icon subquery, and an O(n²) reconciliation (`watchResourcesDirectory.ts`, `createRevalidateFunction`).
- With about 8 live domains and a 300-mod instance, every Cmd-Tab back to the launcher triggers thousands of syscalls and several synchronous SQLite queries on the main thread. File watchers already exist, so this is a belt-and-braces cost paid constantly.

**Recommendation.**
- Trust the watcher (FSEvents on macOS). Re-validate only:
  - (a) on watcher error or overflow;
  - (b) after system wake (`powerMonitor` `resume`);
  - (c) when the user explicitly refreshes;
  - (d) when the data root is on a volume where FSEvents is unreliable (network or external volumes, detected via `statfs`).
- When a re-validation does happen, it is incremental: compare `(name, size, mtime, inode)` against the in-memory index, with no DB query unless something changed.

### I6. Task progress is polled every 250 ms and returns unbounded history. Impact: Medium

**Evidence.**
- While any task runs, the renderer polls `task-poll` every 250 ms (`xmcl-keystone-ui/src/composables/taskManager.ts`).
- The main process returns **every task created this session**, including completed ones, with each task's full sub-state, until the user presses "clear" (`xmcl-runtime/infra/plugins/task.ts`).
- The renderer replaces its whole task list on every poll.

**Recommendation.**
- Push, not poll. The runtime publishes task patches (progress deltas throttled to 4–10 Hz per task, state transitions sent immediately).
- Completed tasks move to a capped history (e.g. the last 50) after a short delay. Subtask detail is fetched only when a task's detail panel is open.

### I7. All renderer HTTP(S) traffic is proxied through main-process JavaScript. Impact: High while browsing the store

**Evidence.**
- `ElectronSession.getSession` installs `protocol.handle('http')` and `protocol.handle('https')`. Every request from the UI goes through the main-process handler chain (`xmcl-runtime/app/LauncherProtocolHandler.ts`, which runs a list of interceptors filtered per request), then `net.fetch` with an undici fallback (`xmcl-electron-app/main/ElectronLauncherApp.ts`), then back through Node↔WHATWG stream conversions (`xmcl-runtime/app/pluginCommonProtocol.ts`). That covers Modrinth and CurseForge API calls and every project icon and gallery image from their CDNs.
- One store page with 40 results and 40 icons is about 80 main-process round trips and stream conversions, competing with downloads and SQLite on the same thread.
- The maintainers had to suppress "controller already closed" errors from aborted streams (#1446), a sign of how fragile the pipeline is.

**Recommendation.**
- The renderer fetches public CDN images **directly** through Chromium's network stack, with HTTP cache and `loading="lazy"`.
- API calls that need secrets (the CurseForge API key) go through a **narrow typed RPC** in the runtime, which caches responses (in memory plus an on-disk cache with stale-while-revalidate). They do not go through a generic HTTP interceptor.
- Never intercept `http`/`https` schemes globally.

### I8. Every renderer console message is forwarded to the main log. Impact: Low

**Evidence.** `ElectronController.setupBrowserLogger` forwards every renderer `console-message` into the main-process logger. The logger formats it with a sensitive-data filter and writes it to a file and to stdout (`xmcl-runtime/infra/plugins/log_consumer.ts`).

**Recommendation.** The renderer logs to its own rotating file through a batched preload channel, at warn level or above in production. No synchronous stdout mirroring in packaged builds.

### I9. State lifetime is tied to garbage collection. Impact: Medium (leaks, non-determinism)

**Evidence.**
- The preload keeps renderer-side states in `WeakRef`s and tells the main process to `unref` from a `FinalizationRegistry` callback (`xmcl-electron-app/preload/service.ts`).
- Main-side watchers therefore live until the renderer happens to garbage-collect.
- Commits that arrive for an id the renderer no longer holds are queued in a `pendingCommits` map and never drained, which is a slow leak.

**Recommendation.** Subscription lifetime is **explicit**: React effect cleanup sends `unsubscribe`. The runtime keeps reference counts per window, applies a grace timer, and runs cleanup when a window is destroyed. Updates for unknown subscriptions are dropped, not queued.

---

## 3. Resource scanning, hashing, workers, and SQLite

### R1. Synchronous SQLite runs on the Electron main thread. Impact: High

**Evidence.**
- The resource database uses Node's `DatabaseSync` behind a Kysely dialect (`packages/sqlite/NodeSqliteDialect.ts`, `xmcl-runtime/resource/pluginResourceWorker.ts`). The comment there explicitly says the DB "now runs in the normal runtime process", i.e. the Electron main process.
- Every query, including the revalidation queries with LIKE filters and large IN-lists and the JSON-array icon subqueries, **blocks the main event loop**. That stalls IPC replies, window move and resize handling, protocol responses, and download stream handling.

**Recommendation.**
- Run SQLite in a **dedicated worker thread** inside the runtime utility process, with:
  - one writer connection and optional read connections;
  - prepared statements cached per query shape;
  - all writes **batched into explicit transactions** (one transaction per scan batch);
  - `journal_mode=WAL`, `synchronous=NORMAL` (the DB is a rebuildable cache), and a sensible `cache_size` and `mmap_size`.
- Use the better-sqlite3 or `node:sqlite` API inside the worker only. The rest of the runtime talks to it with async messages.

### R2. Inefficient and partly incorrect revalidation queries. Impact: Medium (plus a correctness bug)

**Evidence.**
- Revalidation fetches snapshot rows with "domained path LIKE `<absolute directory>%`" OR "inode IN (…)" (`packages/resource/core/watchResourcesDirectory.ts`).
- But the stored domained path is *relative to the data root* (`packages/resource/core/takeSnapshot.ts`). So the LIKE branch never matches, and stale rows are never cleaned this way. (The instance-removal path does use the relative form.)
- LIKE with a leading literal still cannot use the primary-key index unless case-sensitive LIKE is configured. So with large tables this risks a full scan in addition to the IN-list.

**Recommendation.** Store `(root_id, dir_rel, file_name)` as separate indexed columns and query by exact `dir_rel = ?`. Garbage-collect rows for missing files in the same transaction as the scan. Add a regression test showing that deleting a file removes its row.

### R3. Per-file, fire-and-forget, unbatched writes. Impact: Medium

**Evidence.**
- Each new file snapshot issues a select-by-inode and then separate upsert statements (`takeSnapshot.ts`). Metadata, URIs, and icons are written separately (`core/upsertMetadata.ts`, `core/getOrParseMetadata.ts`).
- These run in auto-commit mode, without awaiting, from up to 16 concurrent queue jobs per watched directory.
- A first scan of 300 mods costs well over 1,000 individual implicit transactions.

**Recommendation.** Scan results are collected in memory and flushed in **one transaction per batch** (e.g. every 100 files or 250 ms). Writes are awaited, and their errors surface on the scan job.

### R4. O(n²) reconciliation in hot paths. Impact: Medium at around 500 or more files

**Evidence.**
- During revalidation, each touched file runs a linear search over the current file list.
- The state update class does a `findIndex` per op and a nested loop for batch updates (`xmcl-runtime-api/src/entities/resource.ts`).
- The renderer then re-maps *all* resources into view models on every update and recomputes conflicts and compatibility over the whole list (`xmcl-keystone-ui/src/composables/instanceMods.ts`).

**Recommendation.** Keep keyed maps (`path → row`, `hash → rows`) on both sides. Patches carry ids, and derived computations (duplicates, missing dependencies, loader compatibility) are incremental, recomputed only for changed rows and their dependants.

### R5. Worker design: one thread, 64-way I/O fan-out, whole-file reads, no crash handling. Impact: High (memory spikes, hangs)

**Evidence.**
- A single lazily created "CPUWorker" (`xmcl-runtime/resource/resource.worker.ts`, `packages/worker/index.ts`) handles hashing, file-type sniffing, mod parsing, CurseForge fingerprinting, and checksums, with a **hashing concurrency of 64** inside one thread.
- The CurseForge fingerprint and CRC32 paths **read the entire file into memory** (`xmcl-runtime/resource/fingerprint.ts`), and the fingerprint is computed in a separate pass from SHA-1 and file-type sniffing. Parsing opens the zip again. A single jar is therefore read 2–3 times.
- Large modpack archives (hundreds of MB) times 64 in flight can mean gigabytes of transient buffers.
- The worker proxy registers **only a message handler, with no `error` or `exit` handler**. If the worker crashes (OOM, native fault), every pending promise stays unresolved forever. That is a plausible cause of "spinner forever" reports.
- The worker is terminated after 60 s idle, so the next burst pays its spawn and parse cost again (a 520 KB bundle).
- Everything shares libuv's default 4-thread pool with download file writes and DNS lookups. `UV_THREADPOOL_SIZE` is never raised.

**Recommendation.**
- Use a **worker pool** of `max(2, min(4, cores/2))` threads for CPU work. I/O concurrency is bounded globally (e.g. 8 files in flight).
- Make the pool robust: per-job timeouts, worker restart on crash, and rejection of all in-flight jobs with a typed error.
- **Single pass per file**: one streaming read feeds SHA-1, SHA-512 (when needed for mrpack), the CurseForge murmur2 fingerprint, and file-type sniffing at the same time, with chunked processing for the whitespace-normalised fingerprint. Zip metadata is read through the central directory (random access), not by inflating the whole archive.
- Jobs carry a priority (visible instance first) and an AbortSignal.
- Set `UV_THREADPOOL_SIZE` (e.g. 8–16) at utility-process start, or better, keep heavy file I/O inside the workers.
- Keep the pool warm while the app is in the foreground and shrink it to zero after 5 minutes in the background.

### R6. Folder-type resources are hashed by recursively walking their whole tree. Impact: Medium

**Evidence.** Directory resources (unzipped resource or shader packs, blueprint folders) get a "hash" by recursively stat-ing every file and hashing names plus mtimes (`packages/resource/core/hashResource.ts`). This repeats whenever the snapshot is invalid.

**Recommendation.** Identify folder resources by `(inode, dir mtime)` plus a manifest file (`pack.mcmeta`, shader properties). Do a deep walk only on explicit request (export or verify).

### R7. Too many watchers per instance, with expensive options. Impact: Medium

**Evidence.**
- Each instance switch creates chokidar watchers for:
  - mods, resource packs, and shader packs (with `followSymlinks` and `alwaysStat`, and a 16-way job queue each);
  - saves (depth 2), plus a datapacks watcher per save;
  - options, server info, and install status (depth 2 over the instance root);
  - mod groups.
- A versions watcher (depth 2) runs globally.
- chokidar v4 uses `fs.watch`, which on macOS sets up one FSEvents stream per watched path.

**Recommendation.**
- Use **one FSEvents watcher per instance root** (via `@parcel/watcher` or `fsevents` directly, which delivers coalesced, recursive events), plus one for the shared data root. Events are routed to domain handlers by relative path.
- Apply a 100–250 ms debounce and coalesce events per path.
- Unwatched domains incur no cost.

### R8. Icon pipeline: full-size images, double reads, no caching. Impact: Medium (memory, scroll jank)

**Evidence.**
- Mod and pack icons extracted from archives are stored full size in a content-addressed directory (`xmcl-runtime/infra/image_store.ts`).
- Serving one (`infra/plugins/image_store.ts`) does an existence check, **reads the whole file into memory to sniff the type, then opens a second stream** to send it, with no cache headers, all in main-process JavaScript.
- 119 `<img>`/`v-img` usages exist in the renderer, and only 5 use `loading="lazy"` or `decoding="async"`.

**Recommendation.**
- When ingesting, downscale icons to 64 px and 128 px WebP or PNG thumbnails in the worker. Store the MIME type in the DB.
- Serve thumbnails from the custom scheme with `Cache-Control: immutable` (the key is a content hash).
- In React, every list image uses `loading="lazy"`, `decoding="async"`, and explicit width and height.

---

## 4. Download engine

The reference engine gets several things right, and Amethyst should keep them:
- a shared undici `Agent` with per-origin keep-alive pools;
- retry interceptors with resumable range requests;
- segmented downloads for large files (5 MB segments, up to 4);
- an adaptive controller that re-rolls slow or stalled mirrors;
- a global concurrency gate.

The problems:

### D1. All download bytes flow through the Electron main thread. Impact: High during installs

**Evidence.** The undici agent, the file handlers, and the speed monitors all live in the main process (`xmcl-runtime/network/pluginNetworkInterface.ts`, `packages/file-transfer/*`). A modpack install with a few thousand files at 50–100 MB/s is tens of thousands of `onData` callbacks per second on the same loop that serves the UI.

**Recommendation.** The download engine lives in the runtime utility process, or in its own worker for very large installs. The UI receives aggregate progress at 4–10 Hz.

### D2. Per-origin connection counts are excessive, with no HTTP/2. Impact: Medium

**Evidence.**
- The default is **64 connections per origin** (patched into undici's pool internals by reflection). Pools are HTTP/1.1 only, with no `allowH2`.
- `graceful-fs` is globally monkey-patched at boot (`xmcl-electron-app/main/index.ts`). This is presumably to absorb the EMFILE errors that this level of fan-out produces.
- The big download origins (Mojang's asset and piston CDNs, Modrinth's CDN) generally negotiate HTTP/2. Confirm per origin with ALPN during implementation. 64 parallel TLS handshakes per origin waste CPU and invite 429s (which the retry config explicitly expects).

**Recommendation.**
- Default to **HTTP/2 multiplexing where supported** (one or two connections with about 100 streams). For HTTP/1.1, use 6–8 connections per origin and a global limit of about 32 in-flight files.
- Base adaptive concurrency on measured throughput (AIMD), not a fixed 64.
- Raise the process fd limit at start-up rather than monkey-patching `fs`.

### D3. No backpressure from disk. Impact: Medium–High (memory growth on slow disks or external drives)

**Evidence.** The file handler issues one positional `fs.write` per received chunk and **always returns true** to undici, so the socket is never paused (`packages/file-transfer/file_handler.ts`). If the disk or the 4-thread libuv pool falls behind (external HDD, FileVault plus a busy SSD, concurrent hashing), pending chunk buffers pile up without bound across all connections.

**Recommendation.**
- Cap in-flight bytes per file (e.g. 4 MB) and globally (e.g. 64 MB).
- When the cap is reached, return `false` from `onData` (pause) and resume once writes drain.
- Coalesce small chunks into 256 KB–1 MB writes.

### D4. Writes go straight to the destination, and hashing re-reads the file. Impact: Medium (I/O plus a corruption risk)

**Evidence.**
- Downloads open the **final destination path with truncate** (`packages/file-transfer/download.ts`, `openFd`), and delete it on failure.
- A valid existing file is destroyed the moment a re-download starts. A crash mid-download leaves a partial file at the real path.
- Validation then re-reads the whole file in the worker to compute its checksum (`packages/installer/installManifest.ts`), doubling disk reads for large installs. A modern asset index is roughly 400–700 MB.

**Recommendation.**
- Download to `<dest>.part-<id>` in the same directory and **hash while streaming** (incremental SHA-1 or SHA-512 per segment, combined in order).
- Verify size and hash, `fsync` for durable user data (not for caches), then `rename` atomically.
- Keep resume metadata alongside the `.part` file.
- Existing files are checked by `(size, mtime)` against a validation cache before falling back to a hash.

### D5. Always-on sampling timers and stacked handler wrappers. Impact: Low (energy)

**Evidence.** A 1 Hz download-performance sampler and a 60 s telemetry timer run for the whole session, even when idle (they are unref'd, but still wake the process). Every request is wrapped in two or three speed-tracking handlers.

**Recommendation.** Start sampling only while transfers are active, using one aggregate counter, and stop it when the queue drains.

### D6. TLS verification is disabled. Impact: N/A for performance (security)

**Evidence.** The connector options set certificate verification off for both proxy and request TLS (`pluginNetworkInterface.ts`).

**Recommendation.** Never do this. Integrity of libraries and JREs depends on TLS plus hashes. Recorded in known-issues.

---

## 5. Renderer rendering

### V1. What is already right

The mod, resource-pack, shader-pack, and save lists share a virtualised list base (`xmcl-keystone-ui/src/components/MarketBase.vue`, using `@tanstack/vue-virtual`), and the log view is virtualised. Amethyst must keep virtualisation for every list that can exceed about 50 rows.

### V2. Lists that are not virtualised. Impact: Medium

**Evidence.**
- The project-version dropdown in the marketplace detail renders every version in one `v-for` (`components/MarketProjectDetail.vue`). Popular projects have hundreds to thousands of versions.
- The Java list, skin library, store entry grid, Bedrock version list, and several big-picture lists are also plain `v-for`.

**Recommendation.** Use one shared `VirtualList`/`VirtualGrid` component (TanStack Virtual for React). Version pickers are searchable comboboxes with virtualised results and server-side paging where the API supports it.

### V3. Reactivity granularity. Impact: Medium

**Evidence.** States are held in `shallowRef` and re-triggered as a whole on every mutation (`syncableState.ts`). Mods are re-mapped in full on each batch, and conflict, compatibility, and dependency checks are recomputed over the full list (`composables/instanceMods.ts`). The authors use `markRaw` to limit deep reactivity, which is good, but the work per update is still O(n), sometimes O(n²).

**Recommendation.**
- Normalised stores keyed by id, with selector subscriptions.
- Row components are memoised on row identity and version.
- Heavy derivations (dependency graph, compatibility) run in the runtime and arrive as precomputed flags. Where they must run in the UI, they go in a Web Worker.

### V4. Images and visual effects. Impact: Medium–High (GPU and energy; ties to known-issues #1212 and #521)

**Evidence.**
- The renderer has about 75 blur or backdrop-filter usages, optional video backgrounds (`views/AppBackground.vue`), and three.js/Vanta animated backgrounds whose code sits in the entry chunk.
- Few images are lazy.

**Recommendation.**
- Use flat surfaces by default. If translucency is wanted, use native macOS vibrancy on the window (`vibrancy: 'sidebar'` / `under-window`), which the compositor handles cheaply, instead of CSS backdrop blur over large areas.
- Animated backgrounds are opt-in, capped at 30 fps, paused when hidden or occluded or when reduce-motion is set, and loaded lazily.

### V5. The error handler reloads the whole window. Impact: High when triggered (a full cold restart of the UI and re-subscription storm)

**Evidence.** The renderer's Vue `errorHandler` and `warnHandler` **reload the page** for any error or warning message containing "TypeError" (`xmcl-keystone-ui/src/windows/main/index.ts`). One recurring bug becomes a reload loop that repeats the full startup cost.

**Recommendation.** Use route-level React error boundaries with a fallback UI and a "reload view" action. Never reload automatically. Limit crash reporting to the first occurrence per session.

### V6. CSS and fonts. Impact: Low–Medium

**Evidence.** About 480 KB of CSS from Vuetify, UnoCSS utilities, and app styles, with a global px→rem rewrite. Full Material Symbols and Roboto font files.

**Recommendation.** Use a utility-first CSS setup with purge (Tailwind or UnoCSS) plus a small component library, aiming for under 60 KB of CSS on the entry route. Use system fonts and SVG icons.

---

## 6. Background polling and timers

**Evidence (renderer).**
- Task polling every 250 ms while any task runs (I6).
- Minecraft-friends polling every 60 s (it checks visibility).
- Server-card refresh intervals.
- A Bedrock running-status check every 2 s on the launch button.
- A memory read-out every 2 s in Java memory settings.
- A notifier countdown every 250 ms.
- A **module-level tooltip sweep every 5 s for the whole session** (`directives/sharedTooltip.ts`).
- A big-picture clock every 1 s.
- Focus and visibility revalidation storms (I5).

**Evidence (main).**
- The 1 Hz download sampler and 60 s telemetry timer (D5).
- A 4 s download-snapshot logger (dev builds or behind a flag).
- Worker idle timers.

**Impact.** Low–Medium on CPU, Medium on energy. Each wake-up stops macOS from coalescing timers and keeps the app out of low-power states. That fits the battery and GPU reports.

**Recommendation for Amethyst.**
- **No `setInterval` in production code** outside one central scheduler. The scheduler:
  - pauses everything when the window is hidden, minimised, or occluded (Electron fires `hide`/`minimize` and `document.visibilityState` changes; occlusion via `backgroundThrottling` stays enabled);
  - aligns timers to coarse buckets of at least 1 s;
  - lets each subscription state its maximum staleness instead of polling at a fixed rate.
- Replace polling with push wherever the runtime owns the data.
- Lint rule: forbid raw `setInterval`, and forbid `setTimeout` loops over 1 Hz, in `apps/*`.

---

## 7. Memory leaks and unbounded growth

| # | Evidence | Impact | Amethyst design |
|---|---|---|---|
| M1 | While the game runs, the launch service keeps (a) an array of one promise per stdout/stderr chunk, and (b) **every stderr line**, until the game exits (`xmcl-runtime/launch/LaunchService.ts`). A multi-hour session with a chatty mod pack grows by tens to hundreds of MB. | High | Bounded ring buffer (lines and bytes). Crash analysis reads the on-disk `latest.log` or crash report after exit. Never retain per-chunk promises. Use a serialised decode stream instead. |
| M2 | The task list is never pruned unless the user presses "clear". Each poll returns all tasks with sub-states (I6). | Medium | Capped history, with subtasks dropped once a task completes. |
| M3 | The preload's `pendingCommits` map buffers commits for ids it no longer holds, forever (I9). | Low–Medium | Drop unknown-subscription updates. |
| M4 | A worker crash leaves every pending request unresolved, along with its closures and buffers (R5). The UI spins forever. | High when it happens | Pool supervisor rejects in-flight jobs and restarts the worker. |
| M5 | Download write buffers are unbounded with no backpressure (D3). | Medium–High | Byte caps and pausing. |
| M6 | Watcher lifetime depends on renderer GC timing (I9). Many instance switches can keep watchers alive for several instances. | Medium | Explicit ref-counted subscriptions with grace timers. Watchers are torn down when the window closes. |
| M7 | Every protocol response is a Node↔WHATWG stream conversion. Aborted requests leave dangling readers (#1446 noise). | Low–Medium | Do not proxy HTTP (I7). |

**Required test.** A soak test opens the app, switches between 10 instances 100 times, browses 20 store pages, runs a fake "game" that prints 5k lines per second for 30 minutes, and installs a 300-mod pack. It asserts that runtime and renderer heap stay within budget and that the watcher count returns to baseline.

---

## 8. Electron configuration

| Setting | Reference | Assessment | Amethyst |
|---|---|---|---|
| `sandbox` / `contextIsolation` | Main window: `sandbox:true`, `contextIsolation:true`. Other windows rely on Electron defaults. | Good for the main window. | Set explicitly on **every** window: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`. |
| `webviewTag` | `true` on the main window. No `<webview>` usage found. | An unnecessary process type and attack surface. | `false`. |
| `spellcheck` | Default (on). | Wasted work and dictionary loading in a launcher. | `spellcheck:false`, except in free-text fields if wanted. |
| `backgroundThrottling` | Default (on). | Correct. | Keep it on for the main window. Pause our own scheduler on hide (Section 6). |
| V8 snapshot / code cache | None for main. The renderer is served over an intercepted http scheme with no cache headers. | Pays full parse and compile cost on every launch. | Privileged custom scheme with `codeCache:true`. Node compile cache for main and utility. Evaluate an Electron V8 startup snapshot only if cold start is still over budget. |
| Process model | Everything in main. | The root cause of most jank. | Main (UI shell) + runtime `utilityProcess` + worker pool + DB worker. |
| Session interception | `protocol.handle` on `http` and `https`. | Routes all renderer network traffic through main JavaScript. | No interception. One custom scheme for app assets and thumbnails. |
| Application menu | Set to `null` on all platforms (`ElectronLauncherApp.setup`). | On macOS this removes the standard Edit menu, which Electron relies on for Cmd+C/V/X/A/Z in text fields (to verify against the reference build). | A proper macOS menu built from roles (App, Edit, View, Window, Help). |
| Electron fuses | Not configured. | Hygiene and security; also lets us skip unused code paths. | Turn off `RunAsNode`, `EnableNodeCliInspectArguments`, and `EnableNodeOptionsEnvironmentVariable`. Turn on `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`. |
| Bundling target | Previous regressions from an unpinned target (#1562). | Correctness. | Pin the esbuild/Vite target to the bundled Electron's Chromium and Node versions. |
| Native modules | 8.4 MB WebRTC plus an FFI module shipped. | Size and load-time risk. | arm64-only builds. Ship only the native modules Amethyst actually uses, loaded lazily. |
| GPU / transparency | Vibrancy optional, CSS blur heavy. | Energy. | Native vibrancy if used. No full-window CSS blur. |

---

## 9. Performance budget and design rules for Amethyst (prioritised)

These are release-blocking budgets, measured on the slowest supported machine class (an 8 GB M1 MacBook Air) with a "large profile" fixture: 30 instances, 400 mods in the active instance, 2,000 schematics, 50 saves, 6 JDKs. CI runs them as packaged-app E2E benchmarks with traces kept as artifacts.

### Budgets

1. **Cold start to first paint at or under 400 ms. Cold start to interactive (home route usable, Play enabled for a ready instance) at or under 1,000 ms.** Warm start to interactive at or under 600 ms. No network on the critical path. First run with no network must reach the setup screen within the same budget.
2. **Main-process event loop: no task over 16 ms at the 99th percentile, none over 50 ms ever**, measured during a 300-mod scan plus a 1 GB install plus a game emitting 5k log lines per second.
3. **Renderer: no long task over 50 ms** during navigation, instance switch, or list scroll. Scroll stays at 60 fps (120 Hz on ProMotion where possible) on a 5,000-row list.
4. **Instance switch: header and summary at or under 100 ms**. The content list for the visible tab streams in within 300 ms from cache. Background re-validation never blocks interaction.
5. **Launch path: from Play click to `java` spawn at or under 500 ms** for an already-installed instance, independent of content-folder size.
6. **Idle cost** (window visible, no tasks): CPU under 0.5 %, no timer wake-ups more often than 1 per 10 s, GPU at about 0 %, "Low" Energy Impact. Hidden or minimised: no renderer work at all.
7. **Memory:** idle total RSS (all launcher processes) at or under 350 MB. Runtime heap at or under 150 MB at idle. Renderer JS heap at or under 120 MB. No growth over 10 % across the soak test. Download buffers at or under 64 MB in flight.
8. **Bundle:** renderer entry at or under 350 KB of compressed JS and 60 KB of CSS. Main entry at or under 300 KB. Total app download at or under 120 MB (arm64 only).

### Design rules

1. **The main-thread rule.** The Electron main process does windows, menus, dialogs, tray, protocol registration, and OS integration only. It never does file scanning, hashing, SQLite, HTTP downloads, zip work, or game-process I/O. Those live in the runtime utility process and its workers.
2. **The worker rule.** CPU-bound or whole-file work (hashing, parsing, zip, fingerprints, image thumbnails, NBT) runs in a supervised pool with bounded concurrency, priorities, cancellation, timeouts, and crash recovery. One read per file feeds every digest.
3. **The SQLite rule.** One DB worker owns the connection. Prepared statements, batched transactions, explicit indexes for every query shape, `EXPLAIN QUERY PLAN` tests in CI for hot queries. The DB is a cache and can be rebuilt from disk at any time.
4. **IPC rules.**
   - (a) Typed, schema-validated contracts. No string method dispatch and no generic mutation channel.
   - (b) Commands go up, versioned patches come down, coalesced to at most one message per query per frame.
   - (c) Payloads are view models, at most about 1 KB per row. Detail is fetched on demand.
   - (d) Topic subscriptions only. No broadcast to all windows.
   - (e) No polling where the runtime owns the data.
   - (f) Every request is cancellable.
   - (g) A per-message size warning in dev above 256 KB.
5. **Subscription lifetime rule.** Data subscriptions are created by the views that render them and released on unmount (with a grace period). Nothing domain-specific is subscribed at the app root except the instance index, settings, and active tasks.
6. **Watcher rule.** One recursive FSEvents watcher per instance root plus one for the shared root, debounced. No re-validation on focus. Re-validate on wake, on watcher overflow, and on explicit refresh only.
7. **List virtualisation rule.** Any list or grid that can exceed 50 items is virtualised with the shared component. Images in lists are lazy, async-decoded, thumbnail-sized, and served with immutable caching.
8. **Lazy-loaded routes rule.** Every route except the shell and home is `React.lazy`. Heavy libraries (3D, markdown, charts, editors) load only inside the component that uses them. A CI check fails the build if listed heavy modules appear in the entry chunk.
9. **Network rule.** The renderer fetches public CDN assets directly. Authenticated or keyed APIs go through typed runtime calls with caching. No global HTTP interception. TLS verification is always on.
10. **Download rule.** Temp file plus streaming hash plus atomic rename. Byte-capped backpressure. HTTP/2 preferred, and a modest number of HTTP/1.1 connections per origin with adaptive concurrency. Progress to the UI at 4–10 Hz.
11. **Bounded-buffer rule.** Every buffer whose size depends on time or input (logs, tasks, history, queues, caches) has an explicit cap and an eviction policy, documented next to its declaration.
12. **Energy rule.** No raw `setInterval`. One scheduler that pauses when hidden. No always-on animation. Native vibrancy instead of CSS backdrop blur. Respect reduce-motion.
13. **Error-handling rule.** Error boundaries per route. Never reload the window automatically.
14. **Measurement rule.** Performance budgets are enforced in CI on the packaged arm64 app with the large-profile fixture. Each PR that touches runtime, IPC, or list code attaches a trace diff. Regressions over 10 % against budget block the merge.
