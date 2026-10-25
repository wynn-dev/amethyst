# Storage

Everything Amethyst keeps on disk lives under one **data root**:
`~/Library/Application Support/Amethyst` (Electron's `userData`). The main process passes it to
the runtime as `AMETHYST_USER_DATA`; logs go to `~/Library/Logs/Amethyst` (`AMETHYST_LOGS`). The
layout is defined in code in `apps/desktop/src/runtime/layout.ts`; keep the two in sync.

```
Amethyst/
  settings.json            launcher settings (+ .bak)                       JSON document
  instances.json           registry of external ("imported in place") instances (+ .bak)
  library.json             sidebar organisation: pinned instances and folders (+ .bak)
  accounts.json            account records, public fields only (+ .bak)     never holds tokens
  secrets/<hash>.bin       one encrypted credential blob per account (0600)
  index.sqlite             resource index + marketplace cache (+ -wal, -shm) rebuildable cache
  instances/<folder>/      managed instances; each folder is a game directory
    .amethyst/instance.json  the instance's metadata (id, name, runtime, overrides, play time)
    icon.png|jpg|webp|gif|svg  the instance icon (content-sniffed, ≤ 8 MB)
    mods/ resourcepacks/ shaderpacks/ saves/ config/ options.txt …   owned by the game
  minecraft/               shared versions/, libraries/, assets/ (the installer)
    versions/<id>/.install-lock   written when an install finishes; files older than it are trusted by size
    versions/<id>/<id>-natives-<arch>/   natives extracted per JVM architecture
  runtimes/<name>/         Java runtimes installed by Amethyst (Mojang mac-os-arm64 or Azul Zulu)
  java.json                user-added Java paths and hidden (removed) runtimes (+ .bak)
  running-games.json       games still running (instance, pid, process start time), adopted after a runtime restart
  client-id.json           random per-install launcher client id passed as ${clientid} (+ .bak); not the telemetry id
  store/sha1/<aa>/<sha1>   content-addressed blobs (read-only, 0444); store/tmp/ for ingests
  backups/<instance id>/<world folder>/<YYYY-MM-DD_HH-mm-ss>.zip (+ .json sidecar)
  rescued-worlds/<instance> <date>/<world>   worlds moved out of deleted instances
  theme-media/<sha1>.<ext> background images and videos
  skins/<uuid>-<hash>.png  launcher-only skins of offline accounts
  cache/icons/             icons extracted from mods, packs and worlds; mirrors of external instance icons
  cache/meta/<list>.json   version lists (Mojang manifest, Fabric/Quilt/Forge/NeoForge), revalidated in the background
  cache/java-probe.json    Java probe results keyed by binary (path, mtime, size): rescans spawn no JVM
  cache/natives/           the LWJGL 2 arm64 natives manifest (from the natives-lwjgl2-v1 release)
  cache/modpacks/          modpack archives downloaded from URLs and the marketplace
  cache/                   other disposable caches
```

External instances live wherever the user keeps them; Amethyst writes only
`<folder>/.amethyst/instance.json` there, and deleting such an instance only unregisters it.

Modpack installs also keep their state in the instance: `.amethyst/modpack.lock.json` (the files the
pack owns, for updates), `.amethyst/unresolved.json` (blocked CurseForge files still to download by
hand), `.amethyst/backups/modpack-<ts>/` (files replaced or removed by an update, for rollback) and
`.amethyst/staging/` (resumable downloads of an interrupted install).

## JSON documents

`settings.json`, `instances.json`, `library.json`, `accounts.json` and every `instance.json` go through one store
(`runtime/store/json-store.ts`) with these guarantees:

- **Atomic writes.** Data is written to `<file>.<random>.tmp`, fsynced, and renamed over the file. A
  crash at any point leaves the old or the new file, never a truncated one. Leftover `.tmp` files
  are removed on the next load.
- **Backups.** Before each replace the previous good version is copied to `<file>.bak`.
- **Serialised, coalesced writes.** One write per document at a time; while one is in flight only
  the latest value is queued.
- **Unreadable files are never overwritten with defaults.** A file that does not parse is moved to
  `<file>.corrupt-<epoch ms>` and the `.bak` is used; only if that fails too do defaults apply.
  `instance.json` is the exception: an unreadable one is left untouched, the instance is listed as
  `broken`, and `instances.repair` moves it aside before writing a fresh one.
- **Lenient per-field parsing.** An invalid field falls back to its default without discarding the
  rest of the document. Patches from the UI, on the other hand, are validated strictly.
- **Schema versions.** Every document carries `schemaVersion`; older documents are migrated step
  by step on load. A document written by a newer Amethyst is read leniently and copied to
  `<file>.v<N>.bak` before it is first overwritten.

## The SQLite index (`index.sqlite`)

`better-sqlite3` in WAL mode (`synchronous=NORMAL`), owned by one worker thread
(`out/main/db-worker.js`) in the runtime. The runtime sends named, typed queries
(`runtime/db/protocol.ts`), never SQL; writes run as one transaction per message. The worker is
restarted on crash; in-flight queries fail with `EDB_RESTARTED` instead of hanging.

It is a **cache**: deleting it costs a re-scan and some marketplace lookups, nothing else. A file
that fails to open or migrate ("not a database", "malformed", newer schema) is renamed to
`index.sqlite.<epoch>.bak` and recreated. User intent never lives only here.

| Table | Contents |
|---|---|
| `placements` | One row per scanned file or pack folder: path key, folder, inode/size/mtime, parser version, SHA-1, and the parsed `@amethyst/content` scan record. Unchanged files are never re-read. |
| `fingerprints` | CurseForge murmur2 fingerprint by SHA-1. |
| `sources` | Marketplace attribution by SHA-1 (`manifest` from installs beats `hash` from lookups). |
| `lookups` | Negative hash-lookup cache (7 days), so unknown files are not re-queried on every open. |
| `update_checks` | Update-check answers per file, platform and loader/version filter (10 minutes). |
| `http_cache` | Persistent backing of the marketplace clients' response cache (capped at 64 MB). |

## Secrets

Microsoft credentials (the refresh token and the current Minecraft token) are encrypted by the
main process with Electron `safeStorage` (Keychain-backed) and stored as **one blob per account**,
named by a hash of the account id. Each blob also records its account id and is checked on read,
so one account's tokens are never used for another. There is no plaintext fallback: without
encryption the credentials stay in memory for the session. A blob that cannot be decrypted (for
example after the app's signing identity changed) means "sign in again", never a crash. Removing
an account deletes its blob.

## Served files

The renderer never reads files. Local images and videos are served by the main process through
`amethyst-asset://data/<path relative to the data root>` (`main/asset-path.ts`): only image and
video extensions, never `secrets/` or hidden folders, no `..` or encoded separators, and symlinks
must resolve inside the data root. Content-hashed folders (`cache/icons/`, `theme-media/`) are
served as immutable; other URLs carry a `?v=` version.

## Native module

`better-sqlite3` 13 ships N-API prebuilds (`prebuilds/darwin-arm64.node`). N-API is ABI-stable, so
the same binary loads in Node (Vitest) and in Electron's runtime process and workers; no Electron
rebuild is needed. Its install script (an implicit `node-gyp rebuild` that is a no-op when a
prebuild exists) is disabled in `pnpm-workspace.yaml` (`allowBuilds: better-sqlite3: false`). The
smoke test (`AMETHYST_SMOKE=1`) opens the index inside Electron and fails if it cannot.

## Safe to delete

`cache/`, `index.sqlite*` and `store/tmp/` can be deleted while Amethyst is not running. Do not
delete `store/` blobs by hand (installs reuse them; a future "clean up storage" action
garbage-collects unreferenced ones), and never edit `secrets/`.
