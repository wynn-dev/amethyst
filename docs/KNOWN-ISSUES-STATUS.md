# Known issues: Amethyst status

This is an audit of Amethyst against every entry in [`docs/specs/known-issues.md`](specs/known-issues.md): the cross-cutting lessons, sections 1–11 and the section 12 code-review findings. It also covers the "Pitfalls / bugs observed in the original" list at the end of each spec in `docs/specs/`. `performance.md` and `ui.md` have no such list. Their findings are design rules, covered by the performance sweep and the UI spec's Part C.

Statuses:

- **Fixed-by-design**: the architecture rules the bug out. The evidence points at the mechanism.
- **Fixed+tested**: an existing test covers the case.
- **Gap fixed**: Amethyst had the same or a similar bug, or didn't handle the case. It was fixed in this audit, with a regression test.
- **Gap (left)**: still open. The reason is given under [Left open](#left-open).
- **N/A**: a dropped feature (see [`DECISIONS.md`](specs/DECISIONS.md)), Windows/Linux only, or not applicable to our design.

Evidence paths are relative to the repo root. Tests are written as `file > test name`.

## Summary

| Status | Count |
|---|---|
| Fixed-by-design | 69 |
| Fixed+tested | 137 |
| Gap fixed | 65 |
| Gap (left) | 5 |
| N/A | 20 |
| **Total** | **296** |

The 65 gap fixes include 4 findings that are not numbered entries in the catalogue (the "extra" rows): token redaction in errors, the orphaned-`osascript` hang, NFC pack ids, and the Electron permission handler. Rows marked "partial" were fixed for the reported failure, but something remains open. Those remainders are listed under [Left open](#left-open).

## Cross-cutting lessons (known-issues.md, top)

| # | Lesson | Status | Evidence |
|---|---|---|---|
| X1 | Arch from hardware and the chosen JVM, not the launcher | Fixed-by-design | Arm64-only build (`apps/desktop/electron-builder.yml`), so the app never runs translated. Downloads are pinned to `mac-os-arm64` (`packages/java/src/mojang.ts`) and Zulu `aarch64` (`packages/java/src/zulu.ts`). Natives come from the JVM's arch (`apps/desktop/src/runtime/launch/service.ts`, `choice.java.arch`) |
| X2 | One tested Minecraft version comparator | Gap (left) | The main comparator is `packages/installer/src/minecraft-version.ts` (tested in `meta.test.ts` for 1.x, pre/rc and 26.x). Separate parsers remain in game, java and the renderer. Each one was checked against 26.x |
| X3 | Never save a downloaded file that hasn't been checked | Gap fixed | `packages/net/src/download.ts` rejects empty bodies and HTML pages. `download.test.ts > rejects an empty body unless an empty file is expected`, `> rejects an HTML page served for an unhashed file` |
| X4 | Atomic settings/instance writes; never reset to defaults | Gap fixed | `apps/desktop/src/runtime/store/json-store.ts`: temp file, fsync, `.bak`, rename. An I/O error on read keeps the file. `json-store.test.ts > never moves a good file aside or resets it when reading fails with an I/O error` |
| X5 | Destructive ops planned, confirmed, reversible | Fixed+tested | Trash after rescuing worlds, with a confirmation sheet. `instances.test.ts > deletes to the Trash after rescuing worlds, and only unregisters external instances` |
| X6 | One identity per mod (content hash); atomic update | Gap fixed | `apps/desktop/src/runtime/marketplace/service.ts`: one file per project and per hash, rolled back if the old file can't be removed. `marketplace.test.ts > installing another version of an installed project replaces it, and rolls back when the old file cannot be removed` |
| X7 | Isolate accounts strictly | Gap fixed | Per-account secret blobs (`apps/desktop/src/runtime/accounts/secrets.ts`). A refresh must return the same Minecraft account (`packages/auth/src/microsoft.ts`), and a per-account version counter blocks stale refresh writes. `microsoft.test.ts > rejects refreshed tokens that resolve to a different Minecraft account`, `accounts.test.ts > lets a sign-in win over a refresh that was already running for the same account` |
| X8 | Short, staged, observable launch; output always drained | Gap fixed | Named, timed steps (`runtime/launch/service.ts`). The pre-launch command no longer hangs on held pipes, and the account step is bounded. `prelaunch.test.ts > resolves promptly when the command backgrounds a process that keeps the pipes open`, `launch.test.ts > bounds a hung account refresh with ETIMEOUT, and a cancel during it is immediate` |
| X9 | Idempotent links; opt-in sharing | Fixed-by-design | Instances are isolated (DECISIONS). The link helpers skip links that are already correct (`packages/game/src/assets.ts`, `packages/installer/src/fs-util.ts`) |
| X10 | Scans never loop or block; failures remembered; caches disposable | Gap fixed | Parse errors cached per snapshot (`packages/content/src/scan.ts`). New: per-job timeouts plus crash recovery in the pool, and a mid-session DB rebuild. `pool.test.ts > times out a wedged job with EWORKER_TIMEOUT and replaces its worker`, `db.test.ts > rebuilds the index when a table goes missing or the file is damaged mid-session` |
| X11 | Proper macOS integration | Gap fixed | Microphone and Local Network usage strings plus the audio-input entitlement were missing. `apps/desktop/src/main/packaging.test.ts > lets games ask for the microphone… and the local network…` |
| X12 | Smoke-test the packaged app | Gap fixed (partial) | The smoke steps now have timeouts (`.github/workflows/ci.yml`, `nightly.yml`). `packaging.test.ts > bound every smoke test of the app with a timeout…` |
| X13 | Never fail silently | Gap fixed | A non-cloneable RPC result now answers `ENOTCLONEABLE` instead of hanging (`apps/desktop/src/shared/rpc.ts` `postResponse`). `runtime/rpc.test.ts > answers with ENOTCLONEABLE instead of never answering…` |
| X14 | Sanitize file names in one place | Gap fixed | `apps/desktop/src/runtime/instances/model.ts` `folderNameFor` now uses the shared `sanitizeFileName` (200-byte clamp). `instances.test.ts > maps every display name to a safe folder name through one sanitizer` |
| X15 | Interop round-trip tests | Fixed+tested | `packages/modpack/src/export.test.ts > links known files, embeds the rest, excludes private data, and round-trips`, `> exportCurseForge > links fingerprint matches, embeds the rest, and round-trips` |

## 1. macOS / Apple Silicon

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1377 #913 | Intel Java downloaded on Apple Silicon | Fixed+tested | `packages/java/src/install.ts` `ensureArm64`. `install.test.ts > refuses a runtime that is not arm64 and leaves nothing behind` |
| #441 … #563 | arm64 natives for every LWJGL generation | Fixed+tested | `packages/game/src/natives/lwjgl2.ts`, `natives/table.ts`. `plan.test.ts > 1.5.2 (LWJGL 2.9.0) is covered too`, `> 1.12.2 …`, `> LWJGL … becomes 3.3.1` |
| (inferred) | "Legacy" decided by minor < 19; 26.x rewritten | Fixed+tested | Matches library coordinates, never the version id. `plan.test.ts > 26.3 (year-based id, minor 3 < 19): libraries are used as shipped, nothing is rewritten` |
| #925 #1092 #858 | Unsigned / not notarized | Fixed+tested | Hardened runtime plus notarize in `electron-builder.yml`; codesign/spctl/stapler checks in `nightly.yml`. `packaging.test.ts > signs with the hardened runtime and notarizes` |
| #781 | Microphone permission for voice chat | Gap fixed | Added `NSMicrophoneUsageDescription` and `com.apple.security.device.audio-input` (`apps/desktop/build/entitlements.mac.plist`). `packaging.test.ts > lets games ask for the microphone…` |
| #1765 | Local Network permission | Gap fixed (partial) | Added `NSLocalNetworkUsageDescription`. Same test |
| #1212 #521 | GPU and energy use while idle | Fixed-by-design | Background off by default (`runtime/settings/schema.ts`). Video pauses when hidden, during a game, or under Reduce Motion (`renderer/src/app/BackgroundLayer.tsx`). No full-window backdrop blur |
| #951 #1144 | Traffic lights, drag regions, theme, min size, reset | Fixed-by-design | hiddenInset title bar and minimum size (`apps/desktop/src/main/index.ts`), drag regions and reduce-motion in `styles.css`, live `nativeTheme`. Residual under Left |
| #469 | Cmd+Q "quit unexpectedly" | Gap fixed | Shutdown cancels tasks (`TaskRegistry.cancelAll`), flushes, closes the DB, and is SIGKILLed if it hangs. `main/runtime.test.ts > SIGKILLs a runtime that does not exit in time…`, `registry.test.ts > cancels every running task on quit…`, `launch.test.ts > cancels a launch that is still being prepared when the runtime shuts down` |
| #135 #232 #17 | Blank window / first run stuck | Fixed-by-design | The window opens before the runtime. Cached theme and settings for first paint. The smoke test fails on exceptions |
| #1576 | Asset missing inside the asar | Fixed+tested | `asarUnpack **/*.node`. The packaged smoke in `ci.yml` requires the SQLite worker and electron-updater to load |
| #1562 | Bundler target vs Electron runtime | Fixed-by-design | No target override in `electron.vite.config.ts`, so electron-vite derives it from Electron |
| #792 | Windows "javaw" applied on macOS | Fixed-by-design | Only `bin/java` / `Contents/Home/bin/java` (`runtime/java/service.ts` `javaExecutable`, `packages/java/src/managed.ts`, `discovery.ts`) |
| #1734 | Play waits on a scan of 1,000 schematics; state leaks | Fixed-by-design | The launch pipeline does no content scans. Play state is per instance (`renderer/src/data/instances.ts`) |
| #966 | Silent demo mode | Fixed-by-design | `EACCOUNT_REQUIRED` before launch (`runtime/launch/service.ts`). `--demo` is never passed |

## 2. Launch failures

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #967 #1360 | Pipe buffer fills and freezes the game | Gap fixed | Both pipes are always read. Partial lines are capped at 64 KiB (`packages/game/src/logs.ts` `MAX_PARTIAL_LINE`). `exited` resolves on the child's `exit` plus a bounded drain (`packages/game/src/launch.ts`). `logs.test.ts > bounds an unterminated line…`, `launch.test.ts > keeps draining a very chatty process so it never blocks on a full pipe`, `> resolves exited when a grandchild (an orphaned osascript) still holds stdout open` |
| #1710 #1706 #1004 #1796 | Endless grey progress bar, no stage errors | Gap fixed | Named timed steps. The account refresh was unbounded and ignored Cancel. `launch.test.ts > bounds a hung account refresh with ETIMEOUT…` |
| #588 #302 #724 #764 | Natives extraction / arch mismatch | Fixed+tested | `packages/game/src/natives/extract.ts`: `<id>-natives-<arch>`, temp dir plus manifest plus rename. `extract.test.ts > handles concurrent extraction of the same set`, `> rebuilds the directory when the library set changes…` |
| #731 #756 #1055 #397 | JVM major version does not fit | Fixed-by-design | `packages/java/src/requirement.ts` (javaVersion, Forge 17 pin, exactly 8 before 1.13). `EJAVA_REQUIRED` at launch |
| #840 | Trailing space in the name breaks the path | Fixed+tested | Sanitizer trims trailing dots and spaces (`instances/model.ts`). `instances.test.ts > creates instances from awkward names…` |
| #857 #865 #910 | Multi-word wrapper command | Fixed+tested | `packages/game/src/argv.ts` parses shell-style with no shell. `command.test.ts > sanitises the environment and supports wrappers without a shell` |
| #1385 | Benign non-zero exit shown as a crash | Gap fixed | `runtime/launch/service.ts` `isBenignLegacyExit`. `launch.test.ts > does not report a crash for a legacy (LWJGL 2) game quitting normally with a non-zero code` |
| #584 | Version-id collision launches the wrong version | Fixed-by-design | Reinstalls when the resolved Minecraft version differs from the instance's. OptiFine is dropped |
| #1294 #1379 #877 | options.txt overwritten or escaped | Fixed+tested | Launch never writes options.txt. Line-preserving editor (`packages/content/src/options.ts`). `options.test.ts > round-trips byte for byte` |
| #1606 #1074 | Resolution settings lost | Fixed+tested | Per-instance window override. `command.test.ts > builds the modern 1.21 command (golden) with features…` |

## 3. Install failures

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1261 #1487 #1409 #801 #528 | NeoForge version mapping and sorting (1.21.1 vs 1.21.11, 26.x) | Fixed+tested | `meta.test.ts > NeoForge versioning > filters by exact Minecraft version, never by prefix`, `> sorts semantically with prereleases first` |
| #867 #839 #666 | Install order; loader id mapping | Fixed-by-design | Forge/NeoForge wait for the client jar and libraries (`packages/installer/src/plan.ts`). `modpack/src/read.test.ts > loader mapping > maps CurseForge %s` |
| #685 #730 #1460 #1537 #1457 | Processor failures and hangs | Gap fixed | The processor runner settled only on `close`. `processors.test.ts > spawnProcessor > settles when a grandchild outside the process group keeps the output pipes open` |
| #1118 #985 #416 #1248 #612 | Bad legacy Forge hashes, empty bodies | Fixed-by-design | Any listed checksum is accepted, plus a Maven Central fallback (`installer/src/libraries.ts`). An empty unhashed file is invalid (`files.ts`). At most 3 attempts. The net engine rejects empty bodies. No curated hash table (see Left) |
| #1513 #788 … | OptiFine install | N/A | OptiFine is dropped |
| #300 #1536 | Metadata refresh failures are fatal | Gap fixed | Cached fallback (`meta.test.ts > caches, revalidates with ETag and falls back to the stale copy`). New: an installed Fabric/Quilt profile can be re-planned offline (`fabric.test.ts > re-plans an installed loader version from its local profile when the meta service is down`) |
| #338 #311 #1034 #1352 #1716 | Retries, resume, pause, concurrency | Gap fixed | `download.test.ts > resumes within the same call when the connection drops mid-body`, `> resumes a .part file with Range and If-Range`. New: `> does not re-request the body after a local write failure`. Pause means cancel and keep the `.part` |
| #519 #479 #796 #1274 | "Succeeded" but nothing installed | Fixed-by-design | `.install-lock` is written only after every step settles. Launch diagnoses the files on disk first |
| #655 | Upstream file name changed (`!` dropped) | Fixed-by-design | `packages/content/src/paths.ts` `sanitizeFileName` strips only control characters, separators and leading dots |

## 4. Java detection and download

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1799 #1782 | Java install does nothing | Fixed+tested | `install.test.ts > collects every failed candidate into an InstallError`, `> routes Java 8 to Zulu because Mojang has no arm64 jre-legacy` |
| #1459 #305 | Corrupt Zulu catalog, checksum failures | Fixed+tested | `install.test.ts > fails on a sha256 mismatch without installing anything`, `zulu.test.ts > … refuses to proceed without a sha256` |
| #1348 #1097 #1091 | Java 25 "invalid"; edits revert | Fixed+tested | `metadata.test.ts > parseJavaVersion` (1.8.0_x, 17, 21+LTS, 25, 26-ea) |
| #737 #751 #749 #634 #599 | Duplicates, not found, manual add | Fixed+tested | `discovery.test.ts > finds every source, de-duplicates by realpath and prefers managed / java_home paths`. Manual add is validated (`EJAVA_INVALID`) |

## 5. Microsoft login

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1587 #1657 | Two accounts collapse into one | Gap fixed | `accounts.test.ts > keeps two accounts isolated across switch, removal and re-adding (KI #1587)`. Removal clears the sign-in window's session (`main/auth-window.ts` `clearAuthSession`) |
| #1678 #576 #1705 | Login loops, phantom account, popups | Fixed-by-design | Interactive login only from a user action. Bad records are dropped one at a time. Refresh never opens a window |
| #1239 #1338 #777 #1425 | Short tokens, manual refresh | Fixed+tested | Silent refresh before launch with a 5-minute margin. `session.test.ts > uses a safety margin` |
| #1445 #1442 #739 #1621 #1596 | Raw XErr codes, no 429 backoff | Gap fixed | The Microsoft refresh-token request had no retry. `microsoft.test.ts > retries a rate-limited refresh honouring Retry-After, then succeeds` |
| #1471 #339 #321 #641 #608 #577 #495 | Fragile redirect, device code, step errors | Fixed+tested | PKCE with embedded window, loopback or device code. Typed errors per step. `oauth.test.ts > device code` |
| #1609 | Hyphenated email rejected | Fixed-by-design | No email validation. The login hint is optional (`packages/auth/src/oauth.ts`) |

## 6. Modpack import and export

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #971 #1040 | Update deletes deselected files; partial retry | Gap fixed | Hash-based three-way diff and staged commit (`packages/modpack/src/update.ts`). New: `update.test.ts > never removes a file the new version still lists when CurseForge cannot return it (#971)`, `resolve.test.ts > fails instead of returning an empty plan when CurseForge rejects every id (#971)`, `install.test.ts > touches only the missing files: configs changed since the install are not reverted` |
| #1540 #1742 #1120 #1024 #549 | Import ignores the existing instance; no provenance | Gap fixed | `modpacks.test.ts > resumes an interrupted import of the same pack instead of creating a second instance (#1540)`, `> identifies a local pack file by its fingerprint and records its provenance…`, `ModpackManager preview > reads a pack again when the file at the same path was replaced` |
| #1669 #1269 #1042 | ":" in pack names | Gap fixed | `instances.test.ts > creates instances from awkward names: colons, slashes, trailing dots, emoji, Cyrillic, CJK, 255 bytes` |
| #1555 #958 #869 #263 #1704 | MultiMC/Prism import | Gap fixed | Out of scope, so it must refuse clearly. Content detection now names what the file is. `read.test.ts > says what a non-modpack zip is, detected from its content (#1642, #1555)` |
| #699 #709 #1079 … | mrpack schema, sha512, fileSize, round-trip | Fixed+tested | `export.test.ts > links known files…` (checks sha512 length and fileSize) |
| #1335 #1319 #920 | Export progress negative or stuck | Fixed-by-design | Progress is reported against a known total and the task package clamps it (`packages/task/src/index.ts`). Server export is dropped |
| #1642 #1418 #1154 #677 | Format detection; staged extraction | Gap fixed | Detection by content (`packages/modpack/src/read.ts`), staging then commit (`engine.ts`). Same test as #1555 |
| #1095 | Pack overrides the global memory setting | Fixed+tested | Instances are created with no memory override. `modpacks.test.ts > identifies a local pack file by its fingerprint…` (memory stays inherited) |
| #616 #1161 … | CDN flakiness, resume, manual files | Gap fixed | A CurseForge file with no hash was checked by size only. `install.test.ts > checks a CurseForge file that has no digest by its fingerprint, and never installs a mismatch`. Manual-files list via `resolve.ts` |

## 7. CurseForge / Modrinth

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #740 #712 #760 #816 #761 #759 | Duplicates, old jar left, auto-suffix | Gap fixed | `marketplace.test.ts > installing another version of an installed project replaces it…`, `> does not place a second copy of bytes already in the folder under another name` |
| #1318 #1507 | Fingerprint trusted over provenance | Fixed+tested | `marketplace.test.ts > installs into the store and the instance, records provenance, and checks for updates by hash` |
| #1749 #1761 … | False "outdated", downgrades, deletions | Gap fixed | `marketplace.test.ts > never offers a downgrade, and update checks bypass the version-list cache` |
| #1443 #1461 #1444 #1552 | Empty id lists; null dependency version | Gap fixed | `curseforge.test.ts > matches fingerprints: drops invalid values, de-duplicates, skips empty requests`. New: `renderer/src/data/market.test.ts > reports a required dependency with no compatible version instead of skipping it silently` |
| #1039 #603 #785 #686 #719 #892 | Dependency loader filtering | Gap fixed (partial) | CurseForge asked only for the exact loader. `marketplace.test.ts > lists and checks CurseForge files for every loader a Quilt instance accepts` |
| #1413 #1125 #1713 #1660 #525 | Bulk actions; `.disabled` state | Fixed+tested | `resources.test.ts > enables and disables mods, resource packs and shader packs` |
| #1170 #1153 #280 #1676 #1365 #1375 | Pagination, filters, 26.x default filter | Fixed+tested | `search.test.ts > queries both platforms, merges, and pages independently` |

## 8. Resource linking

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1546 #1428 | EEXIST relink storm | Fixed-by-design | Explicit launch paths. The link helpers no-op when a link is already correct |
| #659 #660 #306 #298 | Shared packs; `.txt` listed as packs | Fixed+tested | Per-instance folders. `scan.test.ts > applies the ignore and extension rules` |
| #1039 #1785 | Invisible sharing semantics | Fixed-by-design | Nothing is shared. Files are placed as APFS clones (`packages/content/src/store.ts`) |
| #963 #912 #1590 #1084 #1246 | Index out of sync with disk | Fixed+tested | FSEvents watcher (`runtime/resources/watcher.ts`). `resources.test.ts > coalesces bursts of watcher events into one rescan per folder` |

## 9. Data loss and corruption

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1345 #1301 #1317 #1338 #691 #678 | Emptied instance.json; settings reset | Gap fixed (partial) | `json-store.test.ts > survives a crash between writing the temp file and renaming it`, `> never overwrites an unreadable file with defaults…`, `> never moves a good file aside or resets it when reading fails with an I/O error` |
| #1334 #968 #906 #832 #1091 #1097 | Override map; reset to global | Fixed+tested | `instances.test.ts > patches with null resets and clears the version pin when the runtime changes` |
| #744 #911 #975 #1492 | Data-directory migration | N/A | The data root is fixed (`docs/STORAGE.md`). There is no migrate feature |
| #1429 #1563 #1538 #663 #833 | SQLite lifecycle, corruption, GC | Gap fixed | `db.test.ts > rebuilds the index when a table goes missing or the file is damaged mid-session` |
| #1431 #1453 | Malformed jar (bad comment length) | Gap fixed | Errors were cached per snapshot (no loop), but such jars were unreadable. `packages/zip/src/reader.ts` now opens them as Java does. `zip/src/index.test.ts > opens jars whose end record has a wrong comment length, as Java does (#1431)` |
| #1363 #478 | Delete leaves files; duplicate names | Gap fixed | `instances.test.ts > keeps names and folders unique across concurrent creations and NFC/NFD spellings`, `> loads each folder once and gives a Finder copy its own id and name` |
| #1665 | Packs disabled by Minecraft after a crash | Gap (left) | No detection or crash-dialog text (UI change) |

## 10. UI freezes and slowness

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1245 #1213 #1207 #1734 | Saves page / instance switch freezes | Fixed+tested | Scans run in the worker pool and can be cancelled per instance. `resources.test.ts > never blocks other calls while a scan runs, and scans are cancellable` |
| #1549 #838 | Processes linger after quit | Gap fixed | `registry.test.ts > cancels every running task on quit…`, `main/runtime.test.ts`, `launch.test.ts > cancels a launch that is still being prepared when the runtime shuts down` |
| #1036 #973 #1150 | Layout loops, GPU lag | Fixed-by-design | No GPU switches. The only ResizeObserver is in the skin viewer. Blur only on small surfaces |
| #1426 #1430 #1446 #1469 | Non-cloneable IPC payloads; abort; resume offset | Gap fixed | `runtime/rpc.test.ts > answers with ENOTCLONEABLE…`, `download.test.ts > aborts mid-stream and cleans up`, `> restarts from zero when a resumed .part turns out to be corrupt` |

## 11. Other

| Issue | Problem | Status | Evidence |
|---|---|---|---|
| #1470 #1127 #768 #284 #427 | Blank or white windows (no error boundary) | Fixed-by-design | Per-view `CatchBoundary` (`renderer/src/app/Shell.tsx`) plus `defaultErrorComponent` (`router.tsx`) |
| #682 #619 #661 #1456 #1562 | Updater fragility | Fixed-by-design | `apps/desktop/src/main/updater.ts`: static GitHub feed, signature plus sha512, background errors retried |
| #1643 | Published packages point at TS sources | N/A | Every package is `private: true` |
| #1787 #792 #780 | Server hosting | N/A | Dropped |

## 12. Defects inferred from the reference source

| Finding | Status | Evidence |
|---|---|---|
| Java arch mislabelled on Apple Silicon | Fixed+tested | `probe.test.ts > trusts the Mach-O header over the release file and picks the native slice of a fat binary` |
| Re-download truncates a good file before verifying | Fixed+tested | `download.test.ts > never touches an existing file until the replacement is verified` |
| A worker crash hangs the UI forever | Gap fixed | `pool.test.ts > rejects in-flight jobs with EWORKER_CRASHED when the worker dies mid-job, then restarts it`, `> times out a wedged job with EWORKER_TIMEOUT and replaces its worker` |
| Stale resource-index rows never cleaned | Fixed+tested | `resources.test.ts > removes index rows of files deleted outside the launcher on the next scan` |
| instance.json writes unserialised and non-atomic | Fixed+tested | `json-store.test.ts > serialises writes and coalesces bursts to the latest value` |
| TLS verification disabled | Fixed-by-design | `packages/net/src/http.ts` hard-codes `rejectUnauthorized: true`. A repo-wide grep finds no override, certificate-error handler or ignore-cert switch |
| Renderer reloads itself on TypeError | Fixed-by-design | `renderer/src/lib/errors.ts` only reports |
| Unbounded memory during long sessions | Fixed+tested | `runtime/launch/log-buffer.ts` ring buffer. `log-buffer.test.ts > stays bounded under a flood and truncates huge lines`. Partial-line cap in `logs.ts` |
| First paint blocked by a remote-config fetch | Fixed-by-design | No remote config. Cached theme (`renderer/src/main.tsx`) |
| macOS editing shortcuts | Fixed-by-design | The Edit menu uses roles (`apps/desktop/src/main/menu.ts`) |

## Pitfalls: accounts.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Login needed a valid email | Fixed-by-design | `prompt=select_account`; login hint only when known (`packages/auth/src/oauth.ts`) |
| 2 | Dead 14-day check, no expiry margin | Fixed+tested | `session.test.ts > uses a safety margin` |
| 3 | Skin 401 read the body twice | Fixed+tested | `minecraft.test.ts > maps upload rejections, reading the body once` |
| 4 | Removal left secrets and cookies | Gap fixed | `accounts.test.ts > does not resurrect secrets when an account is removed during its refresh`, plus the #1587 test (cookies) |
| 5 | Offline custom UUID discarded | Fixed+tested | `offline.test.ts > keeps a custom UUID instead of the derived one` |
| 6 | Offline profiles shared one record | Fixed-by-design | One record per profile (`packages/auth/src/offline.ts`); `remove(id)` deletes only that one |
| 7 | Loopback server bound to all interfaces | Fixed+tested | `loopback.test.ts > binds to 127.0.0.1 only` |
| 8 | No state / PKCE check | Fixed+tested | `loopback.test.ts > ignores requests with the wrong state or a foreign Host header`, `oauth.test.ts > rejects state mismatches, errors and missing codes` |
| 9 | Launch refresh could open a window | Fixed+tested | `accounts.test.ts > never relabels another profile's tokens after a refresh, and never opens a window to recover` |
| 10 | Error classification by class name | Fixed+tested | Structured `code`/`type`. `microsoft.test.ts > serializes errors without secrets` |
| 11 | Xbox avatar step blocked login | Fixed+tested | `microsoft.test.ts > does not block on the optional Xbox profile and takes the XUID from the Minecraft token` |
| 12 | Console-only XSTS Redirect links | Fixed+tested | `microsoft.test.ts > links age verification to an https Redirect` |
| 13 | Entitlement check should be advisory | Fixed+tested | `microsoft.test.ts > treats entitlements as advisory`, `> reports "no profile yet" when the game is owned but has no profile` |
| 14 | Startup race saved an empty account list | Fixed-by-design | Accounts are loaded before the manager is published. Only user actions write. `json-store.test.ts > never overwrites an unreadable file with defaults: moves it aside and recovers the backup` |
| 15 | Non-JWT token treated as invalid | Fixed+tested | `accounts.test.ts > treats an undecryptable blob as "sign in again", never as a crash` |
| 16 | XUID not passed; `clientid` defaulted | Gap (left) | The XUID is passed (`runtime/launch/service.ts`). `${clientid}` is dropped instead of a stable per-install id |
| 17 | Offline mode depended on the OS locale | Fixed+tested | `accounts.test.ts > allows offline accounts only after a Microsoft account (or in developer mode)` |
| extra | Tokens copied into error bodies (IPC and logs) | Gap fixed | `packages/auth/src/errors.ts` `redactSecrets`. `oauth.test.ts > never copies tokens from a malformed token response into the error` |

## Pitfalls: download.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| P1 | TLS verification disabled | Fixed-by-design | `packages/net/src/http.ts` `rejectUnauthorized: true`, not configurable |
| P2 | Part requests not cancelled or awaited | Fixed-by-design | `download.ts`: an internal controller aborts siblings; `allSettled` before close or rm |
| P3 | Batch opens and truncates every file up front | Fixed-by-design | Lazy pool (`packages/net/src/many.ts`). The `.part` file is opened after the response headers |
| P4 | Progress double-counts retries | Fixed-by-design | Per-job progress is reset on retry (`download.ts` `setProgress(job, 0)`) |
| P5 | No backpressure; small libuv pool | Gap fixed | Each 64 KiB write is awaited (BatchWriter). New: the runtime gets `UV_THREADPOOL_SIZE=16` (`apps/desktop/src/main/runtime.ts`). `main/runtime.test.ts > gives the runtime a larger libuv pool so DNS is not starved during installs (download.md P5)` |
| P6 | In-place writes; partials discarded | Fixed+tested | `download.test.ts > never touches an existing file…`, `> resumes a .part file with Range and If-Range` |
| P7 | Retry amplification; slow offline failure | Fixed+tested | `retry.test.ts > fails fast when offline…`, `> bounds retries for transient errors…`. Residual under Left |
| P8 | Integrity only via a second full read | Fixed-by-design | Hash while streaming plus a length check. A second pass only for segmented or resumed files |
| P9 | Trust shortcuts hide corruption | Fixed-by-design | Size-trust is opt-in; only atomically renamed files reach the destination |
| P10 | Checksum helper swallows read errors | Gap fixed | `packages/net/src/hash.ts` propagates errors. Write errors no longer retry: `download.test.ts > does not re-request the body after a local write failure` |
| P11 | Splitting depends on the caller's size | Fixed+tested | `download.test.ts > downloads large files in parallel segments` (no size passed) |
| P12 | Loose task state and cancel semantics | Gap fixed | `packages/task/src/index.test.ts > mapLimit > rejects only after the items already running have settled` |
| P13 | No per-path dedupe across tasks | Gap fixed | `download.test.ts > serializes paths that differ only by case or Unicode normalization` |
| P14 | Unusual 2xx / HTML accepted | Gap fixed | Only 200/206 accepted. New HTML and empty-body tests (X3) |
| P15 | Inconsistent connection defaults | Fixed-by-design | One default (16), clamped 1–64 (`http.ts`, `runtime/settings/schema.ts`) |

## Pitfalls: install.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Forge artifact version guessed | Fixed+tested | `meta.test.ts > splits real artifact versions without guessing suffixes` |
| 2 | Universal-only Forge handled only for 1.4 | Fixed+tested | `meta.test.ts > chooses the install format from meta.json`, `forge.test.ts > merges a universal zip into the vanilla jar for pre-installer builds (md5 fallback)` |
| 3 | Forge list scraped from HTML | Fixed-by-design | Reads `maven-metadata.xml` (`installer/src/meta/client.ts`) |
| 4 | NeoForge prefix bug; 1.20.1 missing | Fixed+tested | `meta.test.ts > lists 1.20.1 from the legacy forge project with its exact published versions` |
| 5 | `maven/` extraction hard-coded | Fixed+tested | Every `maven/` entry, with a traversal guard. `forge.test.ts > NeoForge > plans and installs through the processor workflow` |
| 6 | Processor data handling incomplete | Fixed+tested | `processors.test.ts > resolves every data value form and the built-ins`, `> rejects unknown variables and unsafe coordinates` |
| 7 | Fabric/Quilt and multi-checksums ignored | Fixed+tested | `fabric.test.ts > uses the published sha1 instead of trusting any zip`, `forge.test.ts > installs a legacy (versionInfo) installer, accepting any listed checksum` |
| 8 | No version JSON integrity check | Fixed+tested | `vanilla.test.ts > rejects a version JSON that does not match the manifest sha1` |
| 9 | Unverified installer / executed tools | Gap fixed | `forge.test.ts > fails closed when no sidecar exists…`. New: `> NeoForge > refuses to run a processor library that has no checksum` |
| 10 | Strict flag inverted for libraries | Fixed-by-design | Repair diagnoses with `hash: 'always'` and re-downloads with `replace: true` |
| 11 | Assets trusted by size | Fixed-by-design | Hashed when changed since the lock (`packages/game/src/diagnose.ts`). Repair hashes everything |
| 12 | Stale cache hides new versions | Fixed+tested | `meta.test.ts > refreshes the manifest when a requested id is missing` |
| 13 | One Forge install at a time, launcher-wide | Gap (left) | Single lock key (`installer/src/forge/common.ts`). Slower, never incorrect |
| 14 | OptiFine needs a third-party mirror | N/A | OptiFine is dropped |
| 15 | OptiFine paths differ only by case | N/A | OptiFine is dropped |
| 16 | Fabric/Quilt profile always re-downloaded | Gap fixed | `fabric.test.ts > re-plans an installed loader version from its local profile when the meta service is down` |
| 17 | Leftover temp files never cleaned | Gap fixed | `fs-util.test.ts > writeFileAtomic > cleans up temp files left by crashed installs, keeping those of live processes` |
| 18 | Repair misclassifies processor outputs | Fixed+tested | `vanilla.test.ts > returns issues without a URL as unresolved` |
| 19 | Legacy `jar` / `clientreq` ignored | Fixed-by-design | Ignored on purpose and documented (`installer/src/forge/legacy.ts`) |

## Pitfalls: instances.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Folder rename deferred to start-up | Fixed+tested | `instances.test.ts > renames the folder with the display name, including case-only renames` |
| 2 | macOS treated as case-sensitive | Gap fixed | pathKey comparisons, plus fixes for concurrency, NFD and load dedupe. Tests as for #1363 |
| 3 | Wrong default `.minecraft` path | Fixed-by-design | `Application Support/minecraft` (`packages/java/src/discovery.ts`) |
| 4 | lastVersionId mapping; javaArgs split on spaces | Fixed+tested | `instances.test.ts > imports folders in place or by copy and detects the runtime from version JSONs` |
| 5 | CurseForge allocatedMemory mapped to min | N/A | No CurseForge-app import (migration dropped) |
| 6 | Args edited as one string | Fixed+tested | Stored as arrays. `renderer/src/lib/args.test.ts > splits on whitespace and honours quotes and escapes` |
| 7 | Auto memory only set -Xms | Fixed+tested | `command.test.ts > suggests memory` |
| 8 | Reset to global lost over IPC | Fixed+tested | null sentinel. Test as for #1334 |
| 9 | Version pin vs runtime disagreement | Fixed+tested | The pin is cleared when the runtime changes. Test as for #1334 |
| 10 | Duplicate followed symlinks, copied logs | Fixed+tested | `instances.test.ts > duplicates with fresh identity, keeping content and symlinks but not logs` |
| 11 | Delete raced installs; permanent delete | Fixed-by-design | Queued work rejected, tasks cancelled, busy rechecked under the lock; Trash |
| 12 | Lossy loading; missing externals pruned | Fixed+tested | `instances.test.ts > keeps an unreachable external instance listed as missing instead of pruning it`, `> lists unreadable metadata as broken…` |
| 13 | Cumulative suffixes | Fixed+tested | `instances.test.ts > creates instances with unique names and folders, and reloads them` |
| 14 | Several loaders at once | Fixed+tested | `instances.test.ts > validates input` |
| 15 | Snapshot comparison bug | Fixed-by-design | Weekly ids compared on the full suffix (`installer/src/minecraft-version.ts`) |
| 16 | Icons stored as absolute URLs | Fixed+tested | `instances.test.ts > stores icons by content and tracks play time` |

## Pitfalls: java.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | arm64 reported as x64; arch not saved | Fixed+tested | `probe.test.ts > reads version, vendor and arch from release + Mach-O without spawning` |
| 2 | Natives use the launcher's arch | Fixed-by-design | `runtime/launch/service.ts` uses `choice.java.arch` |
| 3 | No probe timeout | Gap fixed | `process.test.ts > runProcess > settles on timeout even when a grandchild keeps the output pipes open` |
| 4 | `which java` finds only the Apple stub | Fixed-by-design | The stub is dropped by path and by realpath (`discovery.ts`) |
| 5 | Big discovery gaps on macOS | Fixed+tested | `discovery.test.ts > finds every source…` |
| 6 | Double probe every startup | Fixed+tested | `discovery.test.ts > rescans from the probe cache with no new probes` |
| 7 | Cached records shown before they are checked | Gap fixed | `java.test.ts > JavaManager > does not offer cached runtimes whose binary was deleted or replaced before the first scan` |
| 8 | "Remove Java" not sticky | Fixed+tested | `java.test.ts > hides removed runtimes and keeps user-added paths` |
| 9 | chmod 0765 on user JDKs | Fixed+tested | `probe.test.ts > chmods a non-executable binary inside the managed directory` |
| 10 | Hard links instead of symlinks | Fixed+tested | `install.test.ts > installs with lzma, falls back to raw, lays out modes and links, then reuses the install` |
| 11 | lzma ignored | Fixed+tested | Same test, plus `lzma.test.ts` |
| 12 | Every runtime file re-hashed | Fixed+tested | `install.test.ts > verifies quickly, detects damage, and repairs it` |
| 13 | all.json not cached; silent Zulu fallback | Fixed-by-design | Fetched live and schema-checked. The failed attempt is recorded with its reason and logged |
| 14 | Third-party Zulu index; prefers JavaFX | Fixed+tested | `zulu.test.ts > builds the list query for macOS aarch64 GA JREs without JavaFX` |
| 15 | Layout detected by folder name | Fixed-by-design | `managed.ts` `findRuntimeJava` checks which binary exists |
| 16 | Selection ignores arch; tie-break | Fixed+tested | `select.test.ts > never picks an x64 JVM when an arm64 one matches, even a closer one` |
| 17 | Version family assumes 1.x | Fixed+tested | `select.test.ts > classifies version ids, including year-based and snapshot ids` |
| 18 | Fragile version regex; JAVA_*OPTIONS kept | Fixed+tested | `metadata.test.ts > reads -version banners, skipping "Picked up" lines`, `process.test.ts > probeEnv > strips JVM option variables and CLASSPATH` |
| 19 | Arch helper depends on cwd and CLASSPATH | Fixed+tested | `probe.test.ts > spawns with policy "always" even when metadata is complete, with a clean environment` |
| 20 | Zulu symlink targets not checked | Fixed+tested | `tar.test.ts > extractTar > rejects escaping symlink` |

## Pitfalls: launch.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Arch from the launcher, not the JVM | Fixed+tested | `plan.test.ts > planNatives on an x64 (Rosetta) JVM` |
| 2 | LWJGL 2.9.0 missing from the arm64 table | Fixed+tested | `plan.test.ts > 1.5.2 (LWJGL 2.9.0) is covered too` |
| 3 | A null replacement treated as "keep" | Fixed+tested | `plan.test.ts > 1.7.10: … jinput and twitch natives are removed` |
| 4 | "Legacy" = minor < 19; snapshots NaN | Fixed+tested | `plan.test.ts > 26.3 …`, `> decides by the library list, not the version id…` |
| 5 | OS rule uses the Darwin kernel version | Fixed+tested | `rules.test.ts > matches the os version regex against the product version` |
| 6 | Features counted by key presence | Fixed+tested | `rules.test.ts > treats features by value, not by key presence` |
| 7 | Unknown `${var}` left literal | Fixed+tested | `command.test.ts > drops flag/value pairs for empty known variables` |
| 8 | Dock icon lookup wrong | Fixed+tested | Golden 1.21 command test (`… and the dock icon`) |
| 9 | Natives cache weaknesses | Fixed+tested | `extract.test.ts > skips extraction when the directory is verified, and re-extracts a corrupted file` |
| 10 | Middleware errors swallowed | Fixed-by-design | Natives and legacy assets are awaited in the build step; a failure fails the launch |
| 11 | Prepend command quoting | Fixed+tested | `launch.test.ts > passes arguments verbatim, without a shell` |
| 12 | Ready/crash detection on raw chunks | Fixed+tested | `launch.test.ts > streams batched structured events and detects readiness per line`, `logs.test.ts > decodes UTF-8 split across chunks` |
| 13 | Auto memory without -Xmx | Fixed+tested | `command.test.ts > suggests memory` |
| 14 | Pre-1.6 `resources/` mapping | Fixed+tested | `assets.test.ts > honours map_to_resources for pre-1.6…` |
| 15 | Dead 1.4.x asset special case | N/A | No version-id special case. Driven by `version.assets` |
| 16 | Bare `auth_session` before 1.7 | Fixed+tested | `command.test.ts > uses token:<t>:<uuid> sessions for pre-1.7 online play…` |
| 17 | `user_type` always msa | Fixed+tested | `command.test.ts > drops empty optional variables together with their flag` |
| 18 | log4j config not validated | Fixed+tested | `command.test.ts > applies the Log4Shell fallback when Forge disables the vanilla config` |
| 19 | Redact tokens by argument position | Gap fixed | The logged command was redacted already. Game output lines were not. `launch.test.ts > redacts the session token from game output lines` |
| extra | Orphaned `osascript` keeps `launch().exited` pending | Gap fixed | `packages/game/src/launch.ts` resolves on `exit` plus a `drainTimeoutMs` drain, then releases the pipes. `launch.test.ts > resolves exited when a grandchild (an orphaned osascript) still holds stdout open` (fails on the old code) |

## Pitfalls: marketplace.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | TLS verification disabled | Fixed-by-design | Default fetch; `http.ts` `rejectUnauthorized: true` |
| 2 | Renderer-side authenticated proxy | Fixed-by-design | The key exists only in the runtime. The renderer uses typed RPC |
| 3 | Guessed CDN URLs | Fixed+tested | `model.test.ts > keeps a null downloadUrl and points at the file page instead` |
| 4 | Multi-loader search lacks NeoForge | Fixed+tested | `curseforge.test.ts > encodes list parameters and lets them override the single forms` |
| 5 | Empty query parameters sent | Fixed+tested | `curseforge.test.ts > lists mod files with only the given filters` |
| 6 | Server order trusted for "latest" | Fixed+tested | `curseforge.test.ts > picks the newest installable file by date, not server order` |
| 7 | Empty or NaN fingerprints | Fixed+tested | `curseforge.test.ts > matches fingerprints: drops invalid values…` |
| 8 | Batch-killing ids | Gap fixed | `modrinth.test.ts > batches projects, drops malformed ids and chunks by 100`. New: `> rejects project ids that are not an id or slug before building a URL` |
| 9 | Quilt/NeoForge loader expansion missing | Gap fixed | Same fix and test as #1039 |
| 10 | Dependency fallback uses one loader | Gap fixed | The fallback widens loaders on both platforms (`runtime/marketplace/service.ts`) |
| 11 | Cache in renderer localStorage | Fixed-by-design | Persistent cache in the runtime (`runtime/marketplace/cache.ts`) |
| 12 | Relevance means Popularity on CurseForge | Gap (left) | Needs new Discover UI copy |
| 13 | Dedupe needs a mapping database | Fixed+tested | `search.test.ts > interleaves and merges confident duplicates` |
| 14 | Misleading combined total | Fixed-by-design | CurseForge capped at its pageable 10,000 (`marketplace/src/search.ts`) |
| 15 | Fuzzy installed-version matching | Fixed-by-design | Attribution keys only |
| 16 | Deprecated `filter=` parameter | Fixed-by-design | Never sent |

## Pitfalls: modpacks.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Modrinth `env` ignored | Fixed+tested | `resolve.test.ts > skips client-unsupported files and surfaces optional ones as a choice` |
| 2 | client-overrides precedence; case dedupe | Gap fixed | The code was correct but untested. `install.test.ts > keeps one target per APFS path: client-overrides beat overrides beat manifest files` |
| 3 | Override prefix without trailing slash | Fixed+tested | `read.test.ts > reads a root mrpack with overrides…` |
| 4 | CurseForge `required: false` ignored | Fixed+tested | `resolve.test.ts > routes by classId… honours required: false` |
| 5 | Guessed CDN URLs | Fixed+tested | Same test (no forgecdn URL) |
| 6 | Folder chosen from category ids | Fixed+tested | Same test (classId) |
| 7 | CurseForge CDN leaks into mrpack | Gap fixed | `export.test.ts > never links CurseForge CDN URLs in a .mrpack, even with strict mode off (pitfall 7)` |
| 8 | Absolute-path archive URLs go stale | Gap fixed | `ModpackManager preview > reads a pack again when the file at the same path was replaced` |
| 9 | File list read before parsing finished | Fixed-by-design | One shared parse per archive; the plan is built only after read and resolve |
| 10 | Upstream from cached metadata | Fixed+tested | `update.test.ts > applies the diff…` |
| 11 | User changes detected by mtime | Fixed+tested | `update.test.ts > computes the three-way diff from hashes` |
| 12 | CONFLICT rename vs backups | Fixed+tested | `update.test.ts > applies the diff, backs up replaced and removed files…` |
| 13 | Prism NeoForge uid wrong | N/A | Prism import is not implemented and is refused clearly |
| 14 | Instance named `<pack>-<version>` | Fixed+tested | `modpacks.test.ts > imports as one task…` |
| 15 | CurseForge loader id substring parsing | Fixed+tested | `read.test.ts > maps CurseForge neoforge-1.20.1-47.1.84` |
| 16 | Non-zip or BOM inputs give raw errors | Fixed+tested | `read.test.ts > reports friendly errors for non-packs`, `> reads a CurseForge zip with a BOM…` |

## Pitfalls: resources.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Suggested display name unused | Fixed+tested | `resources.test.ts > scans in the worker pool and serves unchanged files from the SQLite cache` |
| 2 | Bytecode scan on every jar | Fixed-by-design | No class walk; `mcmod.info` only without a modern descriptor |
| 3 | Shader detection too strict | Fixed+tested | `packs.test.ts > detects shaders/ without requiring shaders.properties` |
| 4 | Quilt ignores Fabric | Fixed+tested | `analysis.test.ts > accepts Fabric mods on Quilt` |
| 5 | NeoForge 1.20.1 and Forge mods | Gap fixed | `analysis.test.ts > accepts Forge mods on NeoForge for Minecraft 1.20.1 only`, `mods.test.ts > labels a NeoForge 1.20.2-1.20.4 mods.toml … as NeoForge` |
| 6 | Quilt/Fabric dependencies ignored | Fixed+tested | `mods.test.ts > reads dependencies, contributors, provides and environment` |
| 7 | Missing-dependency check by platform ids | Fixed+tested | `resources.test.ts > finds duplicate, missing and incompatible mods` |
| 8 | CurseForge skip-version filter | N/A | No skip-version feature |
| 9 | CurseForge latest by array order | Fixed+tested | `curseforge.test.ts > picks the newest installable file by date, not server order` |
| 10 | Folder pack ids wrong | Fixed+tested | `options.test.ts > matches folder packs found by a scan to their options.txt entry` |
| 11 | options.txt drops new keys | Fixed+tested | `options.test.ts > edits in place and appends new keys` |
| 12 | `.properties` split on every `=` | Fixed+tested | `game-config.test.ts > splits on the first = only, so values containing = survive` |
| 13 | Three shader config files written | Fixed+tested | `resources.test.ts > refuses to pick a shader pack without a shader mod and writes no config files` |
| 14 | NBT strings not Modified UTF-8 (emoji/NUL level.dat) | Fixed+tested | `nbt/src/index.test.ts > encodes NUL as C0 80`, `> uses an unsigned 16-bit length…`, `saves.test.ts > round-trips a world name with emoji and NUL in Modified UTF-8` |
| 15 | Cheats never read | Fixed+tested | `saves.test.ts > reads the fields shown in the UI` |
| 16 | Pre-1.9 worlds fail | Fixed+tested | `saves.test.ts > handles pre-1.9 worlds (no Version, RandomSeed) without throwing` |
| 17 | Advancements metric mislabelled | N/A | No such metric is shown |
| 18 | Save export of the wrong folder | Fixed+tested | `saves.test.ts > exports the folder that contains level.dat…` |
| 19 | Zip-slip on world import | Fixed+tested | `saves.test.ts > refuses zip-slip entries inside the world root and leaves nothing behind` |
| 20 | Inconsistent collision names | Fixed+tested | `saves.test.ts > imports a zip whose level.dat is nested one level deep, with collision-free names` |
| 21 | Destructive deletes; atime sweep | Fixed-by-design | Trash; no atime cleanup; backups pruned by count |
| 22 | Corrupt attribution poisons batches | Gap fixed | `db.test.ts > never stores attribution with malformed platform ids` |
| 23 | Parse errors cached forever | Fixed+tested | `scan.test.ts > does not serve cached parse errors from an older parser version` |
| 24 | Snapshot ignores size; root-relative paths | Fixed-by-design | Absolute normalized keys; size, mtime, inode and parser version |
| 25 | Folder pseudo-hash | Fixed+tested | `scan.test.ts > … without hashing folders`. Residual under Left |
| 26 | Toast storms | Fixed-by-design | Problems are row state; events only on a real row diff |
| 27 | Hard links into instances | Fixed-by-design | The store uses `hardLinks: false`: clone, then copy |
| 28 | Unsanitised upgrade paths | Fixed-by-design | Every install, updates included, goes through `sanitizeFileName` |
| 29 | Swallowed rename errors | Fixed+tested | `resources.test.ts > reports rename failures per file and revalidates, so the UI matches the disk` |
| 30 | Wrong CurseForge category 6945 | N/A | No library cleaner; 6945 is treated as the DataPacks class |
| extra | NFD pack names on disk vs NFC ids in options.txt | Gap fixed | `options.test.ts > uses NFC pack ids (as Java on macOS does) and matches NFD entries`, `resources.test.ts > matches NFD pack names on disk to the NFC ids the game writes, and writes NFC ids` |

## Pitfalls: settings-themes.md

| # | Pitfall | Status | Evidence |
|---|---|---|---|
| 1 | Defaults defined in three places | Gap fixed | `settings.test.ts > is the one source of defaults…` |
| 2 | Runtime state mixed into settings | Fixed-by-design | The schema holds only persisted fields |
| 3 | "Reset all" didn't reset | Fixed+tested | `settings.test.ts > reset restores settings.json defaults and removes the background…` |
| 4 | Export covers only localStorage | N/A | Settings export not shipped |
| 5 | Network fields saved on unmount | Fixed-by-design | Every control saves immediately. Related gap under Left (proxy settings ignored) |
| 6 | TLS verification disabled | Fixed-by-design | `http.ts` `rejectUnauthorized: true` |
| 7 | Auto memory only -Xms | Fixed-by-design | `autoMemory` returns min and max |
| 8 | nativeTheme only at startup | Fixed-by-design | Updated on every theme change (`main/os-services.ts`) |
| 9 | Border identical in light and dark | Fixed-by-design | `light-dark()` separator (`styles.css`) |
| 10 | Inconsistent theme defaults | Fixed+tested | `settings.test.ts > falls back per field when loading` |
| 11 | Palette roles not editable | N/A | Palette editor dropped |
| 12 | Music play order ignored | N/A | Music dropped |
| 13 | One-track shuffle hang | N/A | Music dropped |
| 14 | Font size unbounded | N/A | No font-size control (custom fonts dropped) |
| 15 | Media name collisions | Fixed+tested | `settings.test.ts > imports a background by content…` |
| 16 | Zip-slip in theme import | N/A | Theme import dropped |
| 17 | Stored theme copied onto itself | N/A | Theme store dropped |
| 18 | Arbitrary-path media endpoint; server binding | Gap fixed | `amethyst-asset:` now serves only whitelisted folders, checked again after resolving symlinks. `asset-path.test.ts > serves only the whitelisted folders`, `isServable > applies the same rules to the symlink-resolved path`. Loopback binds to 127.0.0.1 |
| 19 | Desktop wallpaper via AppleScript | N/A | Not implemented |
| 20 | Debug logging left in | Fixed-by-design | No `console.log`; oxlint `no-console` |
| extra | Electron grants every web permission (including the sign-in pages) | Gap fixed | `apps/desktop/src/main/permissions.ts`. `permissions.test.ts` |

## Left open

These are deliberately not fixed in this pass:

- **X2, one comparator.** Merging means moving the comparator into `@amethyst/game` and rewriting callers in installer, java and the renderer. Every existing parser was checked against 26.x, snapshots and pre-releases. The installer comparator also doesn't order weekly snapshots or alpha/beta ids by date.
- **#1665, packs disabled after a crash.** This needs a new exit-state field and new crash-dialog copy, which is a UI change.
- **accounts 16, `${clientid}`.** It is dropped rather than set to a stable per-install id. Wiring this in needs a stored install id.
- **install 13, one Forge install at a time.** It is only slower. A per-Minecraft-version lock needs a concurrency fixture to prove it safe.
- **marketplace 12, "Relevance" hint.** This is new Discover UI copy.
- **Proxy settings ignored.** Found under settings 5. `network.proxyEnabled`, `proxyUrl` and `maxApiConnections` are never read, and `maxConnectionsPerHost` applies only after a restart. The Network pane says the proxy is used. Fixing this needs a proxy-capable agent and live reconfiguration in `packages/net`.

Residuals of rows marked fixed or partial:

- **#1345, settings moved aside.** When `settings.json` is moved aside as corrupt, the user is not notified; it is only logged.
- **#1039, dependencies.**
  - A dependency isn't treated as satisfied by a mod id, so Fabric API can still be added next to QFAPI on Quilt.
  - There is no opt-out for automatic dependency install.
  - Dependencies are installed one level deep.
- **#740, same-name files.** An unrelated file with the same name still gets "(2)". `resources.md` §5.3 asks for that, but the original issue asks for no suffix. That is a product call.
- **#1118, legacy Forge hashes.** There is no curated table of known-bad hashes. Accepting any listed checksum plus the Maven Central fallback covers the reported cases.
- **#685, processor output.** It is not streamed live into the task UI. The task shows the running processor, and a failure keeps its log tail.
- **download P7, no-progress limit.** There is no wall-clock limit on time without progress. Offline errors fail fast, but a host that silently drops connections takes about 100 s per URL.
- **resources 25, folder packs.** Cache records key on the folder's own mtime, so an in-place edit of `pack.mcmeta` is picked up late.
- **#951 / #1144, reset.** There is no "Reset Amethyst" action. `docs/STORAGE.md` doesn't list the updater cache, the Preferences plist or Saved Application State.
- **#1765, Local Network prompt.** The launcher doesn't trigger the prompt ahead of time (LAN features are dropped). It fires on the game's first local-network access.
- **X12, real install and launch in CI.** CI doesn't run one in the packaged app. `scripts/e2e-launch.ts` exists but isn't wired in.
