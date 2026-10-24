# Amethyst spec: the download subsystem

Status: behavioural specification (clean room). Target: Electron main process (Node.js), macOS 13+ on arm64.

This document covers how the reference launcher downloads files (HTTP transport, concurrency, segmented and ranged
downloads, retries, resume, checksum validation, temp files, progress and tasks, cancellation). It then says what
Amethyst should do. Where the reference behaviour is worth keeping, the spec says so. Where it is weak, the
"Required behaviour for Amethyst" sections replace it, and the reasons are in the final section.

Related specs: `install.md` (which files get downloaded and in what order), `java.md` (Java runtime manifest
downloads; that spec relies on the batch API and verification loop described here).

Out of scope: download mirrors (BMCLAPI and the like). The reference has a whole adaptive "mirror re-roll"
controller for them. Amethyst drops mirrors, but the API **must still accept an ordered list of candidate URLs per
file** so that fallback sources (for example a secondary official host) can be added later without changing the API.

---

## 1. Layering (conceptual)

The reference stacks five layers. Amethyst should keep the same separation:

1. **HTTP transport.** A shared, process-wide HTTP client with per-origin connection pools, timeouts, redirect
   following, transport-level retries, an optional HTTP proxy, and a default `User-Agent`.
2. **Global request gate.** A process-wide limit on how many download requests can be in flight at once. Excess
   requests wait in a FIFO queue.
3. **Single-file download engine.** Given a destination path, one or more candidate URLs, and an optional expected
   size, it writes the bytes to disk, possibly over several parallel byte-range requests. It does **not** check
   content hashes.
4. **Batch download plus verify/repair loop** (the "files task" of an install plan). For a set of files with known
   sha1/size it skips files that are already valid, downloads the rest, re-verifies everything it downloaded, deletes
   failures, and retries with backoff. **This is where integrity is enforced.**
5. **Tasks and progress.** User-visible tasks (for example "Install 1.20.4", "Install libraries", "Install assets"),
   each with a phase and a live progress object. The UI polls them and can cancel them.

---

## 2. HTTP transport (reference behaviour)

- **One shared client** for the whole launcher. It keeps a connection pool per origin (scheme + host + port).
  - Pool size per origin = the user setting "max sockets". The reference uses 64 when the setting is 0 or missing
    (note that the settings model defaults it to 16 in one place and 64 in another, which is inconsistent). The value
    is read live, so changing the setting affects existing pools.
  - Idle pools are closed about 60 s after they drain, if they have no connected, pending, running, queued, or free
    sockets.
- **Timeouts:**
  - TCP+TLS connect timeout: 25 s.
  - Headers timeout (request sent until response headers arrive): 25 s.
  - Body timeout: 10 s. This is an *idle* timeout between body chunks, not a total timeout, so it also works as the
    stall detector for official sources.
  - Happy-eyeballs dual-stack connect (try IPv6 and IPv4 in parallel) with an 850 ms per-attempt delay.
- **Redirects:** followed automatically, up to 5 hops. Progress and error reporting use the final URL after
  redirects. Error telemetry strips query strings (signed CDN URLs) and local paths.
- **Transport-level retries.** A retry layer below the downloader retries automatically:
  - On network error codes: connect/headers/body timeout, connection reset, connection refused, DNS not found,
    network down or unreachable, host down or unreachable, broken pipe, generic socket error.
  - On HTTP statuses 429, 500, 502, 503, 504 (and a non-standard 567).
  - Up to 3 retries, with exponential backoff (about 0.5 s initial, factor 2, capped around 30 s) and support for
    `Retry-After`.
  - If a body was partly received, the retry resumes with `Range: bytes=<received>-`. If the server cannot honour
    that (it returns a full 200, or a `Content-Range` that does not match), the retry layer fails with a distinctive
    "range retry" error, which the downloader handles (§4.4).
- **Headers:** if a request has no `User-Agent`, one is added (launcher name/version). A request that tries to set
  `Proxy-Authorization` itself is rejected.
- **Proxy:** an optional HTTP proxy from settings, or from the `HTTPS_PROXY`/`https_proxy` environment variable.
  HTTPS goes through an HTTP `CONNECT` tunnel, and the TLS handshake then runs over the tunnel socket. Proxy
  credentials go only in the CONNECT request's `Proxy-Authorization: Basic …` header. The proxy can be turned on and
  off, and changed, at runtime. When it changes, the old proxy connection is closed.
- **TLS: the reference disables certificate verification** for every request (both the proxy and the origin
  connectors). See Pitfalls. **Amethyst must verify certificates.**
- **Speed measurement:** every response body chunk adds to process-wide byte counters. "Current speed" is the bytes
  counted since the last sample divided by the elapsed time. The counter resets on every sample, and the UI polls it.

### Required behaviour for Amethyst (transport)

- Use Node's built-in `fetch`/undici, or undici directly, with one shared dispatcher in the main process.
- Keep the timeouts above as defaults, configurable internally. Keep the redirect limit (5) and happy eyeballs.
- **Certificate verification on** (the system default trust store; Electron/Node bundles Mozilla's CA store, which
  is fine for Mojang, Fabric, Forge, NeoForge and Quilt hosts).
- Transport retries: same codes and statuses, 3 retries, honour `Retry-After` (capped at 60 s). **Do not retry
  `ENOTFOUND` more than once.** DNS failure usually means "offline", and retrying it many times leads to very slow
  failures (Pitfalls §P7).
- Proxy support as above (settings and `HTTPS_PROXY`). Also honour `NO_PROXY` (the reference ignores it).
- Pool size per origin: default 16, user-configurable from 1 to 64.

---

## 3. Global request gate

- One process-wide FIFO gate in front of the transport limits **active download requests** (not files) to N, where N
  is the same "max sockets" value. It is re-read on every admission and is never below 1.
- A request that waits in the queue and whose abort signal fires is removed from the queue and fails immediately with
  the abort reason. It never touches the network.
- A slot is released when the request completes, errors, or is upgraded. Released slots are filled in FIFO order.
- Ranged sub-requests of one file (§4.3) go through the **same** gate, so they compete with other files. This cannot
  deadlock, because a parent request finishes its own byte range on its own and does not hold its slot while waiting
  for its children.

Amethyst: keep this. Also make the gate **open files lazily**. A destination file must not be created or opened until
its request has been admitted (Pitfalls §P3).

---

## 4. Single-file download engine

### 4.1 Inputs and outputs

- Inputs: destination absolute path; an ordered list of one or more candidate URLs; optional extra headers; optional
  expected total size in bytes; optional abort signal; optional progress sink; optional range policy (threshold and
  concurrency).
- Output: success, or a failure carrying all per-URL errors (one error, or an aggregate "all URLs failed"), decorated
  with the sanitized URL list, hosts, and destination extension for diagnostics.

### 4.2 File handling (reference)

1. If the signal is already aborted, fail before touching the disk.
2. Open the destination **for writing with truncation** (create it if missing). If the parent directory does not
   exist, create it recursively and retry the open once.
3. All writes are **positional** (write at absolute offset) to the single open descriptor. This is what lets several
   parallel range requests fill different regions of one file.
4. Each received chunk is written straight away at the current offset. Writes are asynchronous, and the handler
   counts pending writes. A response is "done" only when the HTTP response has completed **and** pending writes have
   reached 0. A write error fails the download.
5. On success: close the descriptor. The file is now at its **final path**, because the reference uses no temp file.
6. On failure (after all URLs and retries): close the descriptor and **delete the destination file**. Partial bytes
   are thrown away, so nothing survives across attempts or process restarts.

### 4.3 Segmented (parallel range) download (reference)

- Range policy defaults: threshold T = 5 MiB, concurrency C = 4.
- Splitting happens **only when the caller supplies an expected size greater than T**. In that case the first
  request carries `Range: bytes=0-(T-1)`. Without an expected size the file always downloads as one stream.
- When the first response's headers arrive:
  - **206**: parse `Content-Range: bytes a-b/total`. If `Content-Range` is missing, fail ("206 without
    Content-Range"). The start offset is `a`. The total is `total`, or unknown if it is `*`.
  - **200**: ranges are considered supported if `Accept-Ranges: bytes` is present. The total is `Content-Length`.
  - **≥ 400**: fail with an HTTP error that carries the status code. **1xx** responses are ignored.
  - If ranges are not supported, or the first response already covers the whole file, no extra requests are made.
  - Otherwise the remaining region `[a+len, total-1]` is split. The part size is
    `max(T, floor(remaining / C))`. Parts are cut from the front, and any tail shorter than a full part is merged into
    the last part. If the remaining region is ≤ T, it is one part. The result is at most C extra requests (plus the
    first one). Each extra request goes to the **final, post-redirect URL** with the same headers plus its own
    `Range`, and writes at its own offsets.
  - The file is done when the first request and all part requests have finished.
- Worked example: for a 100 MiB file, the first request covers 0–5 MiB, and the remaining 95 MiB becomes 4 parts of
  about 23.75 MiB each, for 5 connections in total. A 6 MiB file uses 2 connections (5 MiB plus 1 MiB).
- In practice this only applies to large files: client jars, large libraries, Forge installers, and Java runtime
  files over 5 MiB. Assets and most libraries are under the threshold.

### 4.4 Engine-level retry and fallback, per URL (reference)

The engine loops over URLs in order. For each URL:

1. Run the request (with splitting if it applies).
2. On success, stop. The remaining URLs are not tried.
3. On failure, if the signal has been aborted, fail with the abort reason.
4. **Restart from zero, once per URL**, if the failure was the transport's "range retry" error (the server could not
   resume) **or** any part request failed. The file is truncated to 0 bytes, the initial `Range` header is dropped,
   and the same URL is retried as a single full stream. This gives proxies and CDNs that mangle ranges one clean
   chance.
5. **Stream resume, up to 5 times per URL**, if the failure had no HTTP status (a network-level failure), the
   expected size is known, and the first request had written `0 < position < expected` bytes. The same URL is
   retried with `Range: bytes=<position>-`.
6. Otherwise, record the error and move on to the next URL.

If every URL fails, the download fails with all the errors.

### 4.5 Mirror-adaptive controller (reference only; out of scope)

The reference has a second engine mode, used only for its mirror host. It does throughput sampling, a time-to-first-
byte deadline, a stall watchdog, "re-roll" to get a different mirror, a per-origin circuit breaker, a speed and
reputation model saved to disk, and short-delivery detection. Amethyst drops this. However, **two ideas from it are
generally useful and are required in Amethyst** (see §4.6):

- **Short-delivery check:** after a "successful" response, if the bytes written are fewer than the expected end of
  the range or file, treat it as incomplete and resume the missing tail. Without this check the gap stays as zero
  bytes on disk.
- **Range-honesty check:** a ranged sub-request answered with a full 200, or with a 206 that starts at a different
  offset than requested, must be rejected *before* any byte is written. Otherwise it would overwrite the shared file
  at the wrong offsets. Fall back to a whole-file single stream.
- (The 416 rule also applies: if a resume request gets **416 Range Not Satisfiable**, truncate and restart that URL
  from 0, once.)

### 4.6 Required behaviour for Amethyst (engine)

- **Temp file plus atomic rename.** Download to `<dest>.part` in the same directory, and keep a small sidecar
  `<dest>.part.json` with `{url, etag, lastModified, expectedSize, sha1?}`. On success, fsync, then `rename()` to
  `<dest>`. The final path therefore only ever holds a complete file. Never truncate an existing `<dest>` before
  the new bytes have been verified.
- **Resume across attempts and restarts.** If a `.part` file exists and its sidecar matches (same expected
  sha1/size, or the same ETag/Last-Modified for unhashed files), continue it with `Range: bytes=<size>-` and
  `If-Range: <etag or last-modified>`. If the server answers 200, truncate and start over. Use resume only for single
  streams. For segmented downloads, either record the completed segments in the sidecar or start over (starting over
  is acceptable in v1).
- **Inline hashing.** For single-stream downloads, compute sha1 (or the requested algorithm) incrementally as bytes
  arrive, so verification needs no second read of the file. For segmented or resumed downloads, hash the file after
  completion.
- **Length check.** On completion, the bytes written must equal `Content-Length` (single stream), the requested range
  length (segment), or the expected size if one was given. A mismatch counts as a retryable failure.
- **Backpressure.** Pause the response stream while more than about 4 MiB of writes are pending for one file, and
  resume when the backlog drains. Never queue writes without limit (Pitfalls §P5).
- **Part requests must be tied to their parent.** If any part fails, or the parent fails or is cancelled, abort all
  sibling part requests and **wait for their pending writes to settle before** truncating, closing, renaming, or
  deleting the file (Pitfalls §P2).
- Keep the per-URL ladder from §4.4 (one restart-from-zero, at most 5 resumes, then the next URL), but resume from
  the `.part` length instead of an in-memory position.
- A per-destination-path mutex in the engine: two concurrent requests for the same destination share one in-flight
  download (deduplicate by path; if the expected hashes differ, fail fast).
- HTTP 2xx statuses other than 200 and 206 (for example 204) count as failures. 404 and 403 are never retried on the
  same URL.

---

## 5. Batch download plus verify/repair loop

This is the layer that turns "download" into "make these files exist and be correct". In the reference it is the
**files task** of a generic install plan. Everything in `install.md` (version JSON, client jar, libraries, asset
index, asset objects, log config, Java runtime files, Forge installers) runs through it.

### 5.1 File descriptor

Each file entry has:

- `path`: absolute destination path.
- `urls`: ordered candidates (at least one).
- `size`: optional expected size.
- `checksum`: optional `{algorithm, value}`. In practice this is always sha1 for Mojang data, and sometimes sha1 or
  sha256 for maven or meta data.
- `validator`: optional content check, one of `file` (must be a regular file), `json` (must parse as JSON), or `zip`
  (must open as a zip with at least one file entry).
- `trustExistingSize`: if the file already exists with exactly the expected size, accept it without hashing. The
  reference uses this for **asset objects** (thousands of small files) to avoid hashing all of them on every check.
  Newly downloaded content is still hashed.
- `validatedAt`: a timestamp. If the file's mtime is **≤** this value, accept it without hashing. The value comes
  from a per-version "install lock" file (`versions/<id>/.install-lock`, JSON
  `{schemaVersion: 1, version, timestamp}`), written after a fully successful install. Files not touched since the
  last verified install are trusted.
- `replace`: always re-download, ignoring the cached trust above.

### 5.2 Validity check (in this order)

When a file is checked "with cached trust" (the pre-download skip check):

1. If `replace` is set, it is invalid.
2. If the path is missing or is not a regular file, it is invalid.
3. If `validatedAt` is set and `mtime ≤ validatedAt`, it is **valid** (no hashing).
4. If `trustExistingSize` is set and the size matches exactly, it is **valid**.
5. If a checksum is given, hash the file. It is valid if the hashes are equal (hex, lowercase).
6. Otherwise, if a size is given, it is valid if the sizes are equal.
7. Otherwise, it is valid if the size is greater than 0.
8. Then, if a `validator` is given, it must also pass.

The post-download check ("strict") skips steps 1, 3 and 4. A file that has just been downloaded is always fully
verified.

Hashing runs in a worker thread pool. It can run up to 64 hashes at once, and results are cached per (algorithm, path)
for the duration of one diagnose pass.

### 5.3 Loop

1. Remove duplicate entries by `path`. The last one wins.
2. Check every entry with cached trust (in parallel). Only invalid entries stay **pending**. Valid files are skipped
   completely: no request is made and they add no progress.
3. Run up to **5 attempts** while entries are still pending:
   1. If cancelled, stop.
   2. Batch-download all pending entries at the same time (each through the engine, all gated by §3). Every file
      runs to completion or failure **independently**: one failure never cancels the others ("all settled"
      semantics). The batch reports one aggregate error listing every failed path and URL.
   3. Check every pending entry **strictly**. Delete every invalid file.
   4. **Rotate the URL list** of each still-invalid entry (the first URL moves to the end), so the next attempt starts
      from a different candidate.
   5. If entries are still pending and the batch error contains a **terminal** cause, stop and fail at once. Terminal
      causes are: an abort or cancellation, `EPERM`, `EACCES`, `ENOSPC`, or `EROFS`, checked through nested causes and
      aggregates.
   6. Otherwise, wait `round(min(4000, 500·2^attempt) · U(0.75, 1.25))` ms (exponential backoff with ±25 % jitter;
      the wait can be cancelled), then try again.
4. If entries are still pending after the last attempt, fail with the last error, or with "cannot recover N file(s):
   …" if there was none.

Note that this layer catches *content* corruption (a bad hash) that the engine itself cannot detect, and retries it
with a fresh download.

### 5.4 Plan execution around files tasks (context)

An install plan is a list of tasks with ids and `dependsOn` edges. The task kinds are `files`, `java` (run a Java
process, used for Forge processors), and `materialize` (write, copy, link, extract, or merge files transactionally).
Tasks run as soon as their dependencies are done, so independent tasks run in parallel. The plan rejects duplicate
ids and dependency cycles. Each task emits `task-start`, `task-end` (with duration and error), and `file-retry`
(attempt number, delay, pending count) events. Amethyst should keep this plan-and-executor shape. See `install.md`
for what goes in the plans.

### 5.5 Required behaviour for Amethyst (batch)

- Keep the §5.2 trust rules and the §5.3 loop, including the backoff constants and the terminal-error short circuit.
- Use a single files task for thousands of entries (assets), but **do not start thousands of engine calls at once**.
  Feed the gate from a lazy iterator, so that at most N downloads (N = the gate size) exist at any moment, each with
  an open descriptor.
- Write the install-lock timestamp only after every task of the install has succeeded. Use the timestamp from
  **before** the install started, so that files modified during the install are never trusted by mtime alone.
- Progress must not double-count retries (Pitfalls §P4). Track progress per path, not per attempt. When an entry is
  retried, reset that path's progress counter instead of adding a new one.

---

## 6. Progress model

### 6.1 Reference

- **Per-file tracker:** `{url, total, progress}`, read live from the active request. `url` is the final URL after
  redirects. `total` is the server-reported total, or the caller's expected size until headers arrive. `progress` is
  the bytes written to disk: for a segmented file, the first request's written bytes plus every part's written
  bytes. When a URL restarts or falls back, the tracker is re-pointed at the new request, so progress can go
  *backwards*. A `done` flag is set when the request and all its parts have settled.
- **Batch tracker:** aggregates its per-file trackers.
  - `total` is `max(sum of per-file totals, the batch's expected total)`. The batch's expected total is the sum of
    expected sizes, but only if **every** file has one; otherwise it is 0.
  - `progress` is the sum of per-file progress.
  - `url` is the URL of the first file that is not done.
- **Phases:** an installer stage announces a *phase* (`version.json`, `version.jar`, `libraries`,
  `assets.assetIndex`, `assets.assets`, `install` for Java runtime, Forge stages, and so on) with a small payload
  (version id, count, url, size, sha1) and a fresh batch tracker. Phases are strings, and the UI translates them.

### 6.2 Tasks (reference)

- A **flat list** of user-visible tasks. There is no real parent/child tree. A logical install creates several
  sibling tasks (for example the main "install Minecraft X" task plus separate "install libraries" and "install
  assets" tasks, and loader tasks).
- Each task has: a random UUID `id`; a `type` (for example installMinecraft, installLibraries, installAssets,
  installForge, installNeoForge, installFabric, installQuilt, installOptifine, installJava, installProfile); a
  deduplication `key` (for example `<mcVersion>:libraries`); a `state` (Running, Cancelled, Succeeded, Failed); an
  optional serialized `error`; a `substate` (`{type: <current phase>, …phase payload}`); and `progress` (the current
  phase's tracker, `{url?, total, progress}`).
- When a new phase starts, it **replaces** the task's substate and progress. The progress object is a live reference
  that is serialized only when the UI polls.
- A task finishes through a wrapper on its promise: resolving marks it Succeeded, and rejecting marks it Failed (unless
  it was already Cancelled). New tasks go to the front of the list. Finished tasks stay until the UI sends "clear".
- A "tasks active" flag is broadcast to the renderer whenever it changes between none-running and some-running.
- **The renderer polls** the full task list every 250 ms while the flag is true. When the flag becomes false, it
  stops polling after one final poll (plus extra polls at 100 ms and 300 ms to catch the final states).
- Global "network status" (per-origin pool stats plus the aggregate download speed) is a separate poll.

### 6.3 Required behaviour for Amethyst (progress and tasks)

- Keep the per-file and batch trackers, but:
  - **Progress is monotonic per task**. Use bytes per path. On restart, subtract the old bytes from that path's count
    rather than leaving stale counts.
  - Report `filesDone/filesTotal` alongside bytes. Many phases (assets) are dominated by file count, not bytes, and
    `total` is often unknown when sizes are missing.
  - Per-task speed: an exponentially smoothed byte rate (window ≈ 3 s), computed in the main process.
- **Real task tree:** a root task per user action (for example "Install Fabric 0.16 for 1.21.1"), with child tasks
  per stage (version JSON, client jar, libraries, assets, loader, Java). The root's progress is the weighted sum of
  its children (by bytes where known, otherwise equal weights). Cancelling a node cancels its subtree.
- **Push, don't poll:** the main process sends throttled task snapshots (at most every 200 ms, plus immediately on any
  state change) over IPC, as diffs keyed by task id.
- macOS: show aggregate progress for the active root task on the Dock icon (Electron `BrowserWindow.setProgressBar`;
  `-1` clears it). Optionally post a system notification on finish or failure when the window is not focused.
- Task states: `queued | running | succeeded | failed | cancelled`. Every failed task carries a serializable error
  with `{name, message, code?, url? (sanitized), path?, status?}`.

---

## 7. Cancellation

### 7.1 Reference

- Each task owns an abort controller. The UI's "cancel" operation aborts it.
- **On abort, the task state is set to Cancelled at once**, before the work has actually stopped.
- The signal is passed down to: the plan executor (checked before each attempt and during backoff waits), every engine
  call, every HTTP request (the request handler listens and aborts the socket stream), the gate queue (queued
  requests are removed), and every spawned Java processor (killed through the spawn signal).
- When the engine is aborted, it closes the descriptor and deletes the destination, so partial files are not kept.
- Pause and resume do **not** exist (the event types are declared but never implemented).
- "Resume after cancel" only works at file granularity: running the same install again skips files that are already
  valid (§5.2) and downloads the rest from byte 0.

### 7.2 Required behaviour for Amethyst

- Cancellation goes down the task tree. A task becomes `cancelled` only **after** all of its work has settled (no
  in-flight writes, child processes exited), so the UI never shows "cancelled" while bytes are still being written.
- On cancel, **keep `.part` files** so that re-running the install resumes them (§4.6). Clean up orphaned `.part`
  files older than 7 days at startup, or when the user clears caches.
- Optional pause: implement it as cancel-and-keep-partials, with resume being a re-run. No socket-level pausing.
- Cancelling must also stop the verify loop's backoff timers and any queued hash jobs.

---

## 8. Public endpoints

The downloader is endpoint-agnostic. The hosts it hits in practice (see `install.md` and `java.md`) are
`piston-meta.mojang.com`, `piston-data.mojang.com`, `launchermeta.mojang.com`, `launcher.mojang.com`,
`libraries.minecraft.net`, `resources.download.minecraft.net` (asset objects at `/<first 2 hex of sha1>/<sha1>`, see
https://minecraft.wiki/w/Tutorial:Asset_files or the "Assets" section of wiki.vg's Game files page),
`maven.minecraftforge.net`, `files.minecraftforge.net`, `maven.neoforged.net`, `meta.fabricmc.net`,
`maven.fabricmc.net`, `meta.quiltmc.org`, `maven.quiltmc.org`. All of them support HTTP range requests and send
`Content-Length`. Mojang's CDN also sends `ETag`. Range semantics follow RFC 9110 §14 (Range, Content-Range, If-Range,
416).

---

## 9. Pitfalls / bugs observed in the original

**P1. TLS certificate verification is disabled for all traffic.** The shared connector options turn off certificate
rejection for both origin and proxy connections. Any network attacker (public Wi-Fi, a hostile proxy) can intercept
every request: version manifests, Fabric/Forge metadata, auth-adjacent API calls, and, worst of all, **files with no
known hash** (Forge installers fetched by URL, some maven artifacts, OptiFine, update packages). Those files are
executed or put on the classpath. Hash checks protect only files whose hash came from a trusted, unhashed manifest,
and the manifest itself was fetched over unverified TLS. *Amethyst: verify certificates, and never offer a "disable
TLS verification" toggle.*

**P2. Part requests are not cancelled or awaited when the parent or a sibling fails, so writes can land in the wrong
file.** When one part request fails (or the first request fails after spawning parts), the engine immediately
truncates the file and restarts, or gives up, closes the descriptor, and deletes the file. The other part requests
are not aborted, and their queued positional writes are not awaited. They keep writing to the descriptor number
afterwards. After a close, that descriptor number can be **reused by another file opened at the same moment**, which
is very likely during a batch download that opens hundreds of files. The late writes then corrupt an unrelated file
at random offsets. The corruption is usually caught later by sha1 checking (and re-downloaded), but files with no
hash, and files already marked trusted by `trustExistingSize`, can silently stay corrupt. *Amethyst: tie part
requests to an internal abort signal, and await all pending writes before any truncate, close, rename, or unlink.*

**P3. A batch download opens and truncates every destination file up front.** The batch layer starts one engine call
per file at the same moment. Each call opens its file (create plus truncate) right away, before the gate admits its
HTTP request. For an asset install with about 4,000 objects, that means about 4,000 open descriptors and about 4,000
zero-length files on disk while only N requests actually run. Problems: descriptor exhaustion risk (EMFILE, made
worse by the hashing worker opening files at the same time); a crash leaves thousands of empty or partial files;
the large burst of promises and listeners costs memory. *Amethyst: limit concurrency at the engine-call level (lazy
iterator), and open the `.part` file only once a request has been admitted.*

**P4. Batch progress double-counts retries.** On each retry attempt the verify loop calls the batch downloader again
with the *same* batch tracker. The downloader appends **new** per-file trackers for the retried files and leaves the
old trackers (with their old byte counts) in place. Total and progress both grow with every retry, so the progress
bar can jump backwards in percentage or run past 100 %. *Amethyst: track progress per path (§5.5, §6.3).*

**P5. No backpressure on disk writes.** Each received chunk triggers an asynchronous positional write, and the stream
always asks for more data. With fast networks and slow or contended disks (external drives, FileVault, Spotlight
indexing) pending writes and buffered chunks grow without limit, and memory climbs. Positional writes also go through
libuv's small thread pool (4 threads by default; the reference never raises it). That pool is shared with DNS
resolution (`getaddrinfo`), the hashing worker thread's file reads (the pool is process-wide), zlib, and crypto. Saturating it with tiny writes starves
DNS lookups, which then show up as **connect timeouts** and trigger more retries. *Amethyst: apply backpressure (pause
above about 4 MiB pending per file), use larger coalesced writes, and set `UV_THREADPOOL_SIZE` (for example 16) at
process start before any I/O.*

**P6. Partial bytes are thrown away and destinations are written in place.** The engine writes directly to the final
path (truncating any existing file there), and deletes the file on failure. Consequences: (a) a big download (client
jar, Java runtime, a large modpack file) that fails at 95 % restarts from 0 on the next verify attempt or launcher
run; (b) a file that was valid but simply not yet verified is destroyed the moment a re-download starts, and is lost
if that re-download fails; (c) during a download, anything reading the path (a running game instance, another
install task for the same library, a hash job) sees a truncated or growing file. Elsewhere the reference itself adds
a "staged `.pending` file plus rename" helper for one feature (market downloads), which admits the problem. The older
core library had a pending-file option that was later removed. *Amethyst: `.part` plus atomic rename plus
cross-attempt resume (§4.6).*

**P7. Retry amplification makes failures slow.** Retries stack at several levels: transport (3 retries with backoff,
including for DNS-not-found and connection refused), then the engine (1 restart plus up to 5 resumes per URL, for
each URL), then the verify loop (5 attempts with backoff). For an unreachable host with a 25 s connect timeout, one
file can take **well over 5 minutes** to fail, and a batch shows "0 B/s, still running" all that time. Offline users
get no quick feedback. *Amethyst: limit the total time per file (for example a 3-minute wall clock without progress),
fail fast on `ENOTFOUND` and `ENETUNREACH` after one retry, and surface "offline" at the task level. Consider a
single connectivity probe before large installs.*

**P8. Integrity is checked only after the fact, with a second full read.** The engine never hashes. The verify loop
re-reads every downloaded file from disk to hash it (in a worker pool of up to 64 concurrent hashes). For the client
jar plus libraries plus thousands of assets, this doubles disk I/O. A short or "successful" response with fewer bytes
than `Content-Length` is caught only if a hash or size is known. *Amethyst: hash inline for single streams, check
lengths in the engine, and run the second-pass hash only for segmented or resumed files.*

**P9. Trust shortcuts can hide corruption.** (a) Asset objects trust an existing file with the right size without
hashing it. A file of the right length but wrong content (from P2, an interrupted out-of-order positional write, disk
corruption, or user tampering) is never repaired by a normal verify, only by a "strict" diagnose. (b) mtime trust
(`mtime ≤ install timestamp`) breaks when files are copied with preserved timestamps, restored from Time Machine, or
synced, because old mtimes on wrong content get trusted. *Amethyst: keep size-trust for assets in the fast path for
speed, but (1) use only atomically renamed files, which removes most of the size-but-wrong-content cases, and (2)
offer a "Verify game files" action that hashes everything strictly. Also run that strict verify automatically after
a crash whose report suggests corrupted assets or classes (see `launch.md`).*

**P10. The checksum helper swallows read errors.** When hashing a file fails for any reason other than "file not
found" (permission denied, a directory, too many open files), the error is ignored and the digest of whatever was read
(possibly nothing) is returned. The result is a spurious mismatch, followed by deletion and re-download. In the
EMFILE case (see P3) that is a pointless re-download storm; in the EACCES case, a re-download that can never succeed,
classified as a non-terminal error. *Amethyst: propagate hashing I/O errors, and classify EACCES/EPERM as terminal.*

**P11. Segmented download depends on the caller passing a size.** Splitting is triggered by the caller's expected
size, not the server's. Large files whose metadata has no size (most Forge and NeoForge installers, OptiFine, maven
artifacts resolved without a `.sha1`/`.pom`) always download as a single stream, while misreported sizes cause
pointless initial range requests. *Amethyst: decide on splitting after the first response's headers (`Content-Length`
plus `Accept-Ranges: bytes`), whatever the caller supplied.*

**P12. Task state and progress semantics are loose.** A task becomes "Cancelled" as soon as abort is requested,
while work may still be running. Phase changes replace a task's progress object, so the progress bar jumps between
phases. Concurrent phases on the same task (for example the client jar and a loader stage) overwrite each other's
substate (last writer wins). The polled `speed` and `acceptRanges` fields of download progress are declared but
never filled in. The UI polls the entire task list every 250 ms over IPC, even when nothing changed. *Amethyst: a
task tree, push diffs, and monotonic aggregate progress (§6.3).*

**P13. No per-path deduplication across tasks.** Deduplication happens only inside one files task. Two concurrent
installs that share files (two instances on the same Minecraft version, or a version install plus a "repair" pass)
download the same library to the same path at the same time. Both truncate it and both write positionally into it,
interleaved. *Amethyst: a process-wide in-flight map keyed by destination path (§4.6).*

**P14. Unusual 2xx responses are accepted.** Any 2xx other than 200 or 206 (for example 204, or an HTML captive-portal
page served with 200) is written as the file's content. For hashed files the verify loop catches it. For unhashed
files (some metadata JSONs are checked only with the `json` validator) a captive-portal page fails JSON parsing, but
an unhashed jar only needs to be a zip with one entry to pass. *Amethyst: reject non-200/206 statuses; for unhashed
binary artifacts, fetch the maven `.sha1` (or `.sha256`) next to them when available (see `install.md`).*

**P15. Inconsistent defaults for the connection setting.** "Max sockets" defaults to 16 in one part of the settings
model and to 64 in the schema fallback and the network layer. Users therefore get different concurrency depending on
whether a settings file exists. 64 concurrent connections to one origin is also aggressive for Mojang's and Forge's
CDNs and can trigger 429s or resets. *Amethyst: one default (16), clamped to 1–64.*
