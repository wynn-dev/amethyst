# Modpacks: behavioural specification

Status: draft for Amethyst (Electron + React, macOS 13+ on Apple Silicon only).
Scope:
- Importing Modrinth `.mrpack` and CurseForge modpack zips.
- Creating an instance from a modpack.
- Resolving the files a pack lists, including CurseForge files that have no download URL.
- Updating an instance to a newer version of its pack.
- Exporting an instance as `.mrpack` and/or a CurseForge zip.

Related specs:
- `instances.md`: the instance model, layout, the `upstream` field and the `.amethyst/` folder.
- `resources.md`: the content-addressed store, hashing (sha1 and the CurseForge murmur2 fingerprint) and linking.
- `marketplace.md`: the Modrinth and CurseForge API clients, API key, caching and rate limits.

Public format references:
- Modrinth modpack format: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack (formerly docs.modrinth.com/docs/modpacks/format_definition)
- CurseForge API: https://docs.curseforge.com/rest-api/
- Prism/MultiMC instance format: https://github.com/MultiMC/Launcher/wiki/Instance-File-Format

---

## 1. Supported inputs

| Format | Import | Export | Priority |
|---|---|---|---|
| Modrinth `.mrpack` (a zip with `modrinth.index.json`) | yes | yes | P0 |
| CurseForge modpack zip (a zip with `manifest.json`, `manifestType: "minecraftModpack"`) | yes | yes | P0 |
| Prism / MultiMC instance export zip (`mmc-pack.json` + `instance.cfg`) | yes | no | P2 |
| "Overrides only" zip (no manifest): contents copied into an existing instance | yes | no | P2 |
| FTB (JSON manifests from the FTB API) | no (see §11) | no | maybe |

Dropped: MCBBS packs, Technic packs, the original's own instance-manifest sharing format, and peer-to-peer sharing.

Sources of a modpack file:
- A local file. The user picks it, drops it on the window, or opens it in Finder with Amethyst. Register the `.mrpack` UTI/extension so double-click works.
- An `https:` URL that the user pastes into an "Import from URL" box.
- A version chosen in the marketplace (`marketplace.md`).

All downloaded packs go to the **modpack cache** at `<root>/modpacks/`. Each URL download gets its **own new subfolder**: `<root>/modpacks/<sha256(url)>-<random>/<filename>`. The cached archive must not change under any staged install that still refers to it by path (§4.3). The original moved to a fresh path per download after it hit this bug. Cached packs are listed in Settings → Storage and can be removed. Auto-prune packs that no instance refers to after 30 days.

---

## 2. Opening a pack (parse step, no side effects)

The UI first *opens* the pack to show a preview (name, version, Minecraft version, loader, file count, icon). It creates an instance only after the user confirms. Opening must not create or change any instance.

1. Make sure it is a regular file. If it is not, show `requireFile`. Compute its **sha1**. Reuse a cached hash if the content store already knows this inode+size+mtime.
2. Open it as a zip. If it is not a zip (users often drop `.rar`, `.7z`, a half-downloaded file or a Forge installer jar), show a friendly "This is not a modpack archive" error. Do **not** treat this as an internal error.
3. **Detect the format**, trying in this order and stopping at the first match:
   1. `modrinth.index.json` at the zip root, so Modrinth.
   2. Exactly one top-level folder containing `modrinth.index.json`, so Modrinth with a prefix. The prefix is that folder. Some third-party tools zip the folder rather than its contents.
   3. `manifest.json` at the root whose `manifestType` is `minecraftModpack`, so CurseForge.
   4. `mmc-pack.json` at the root, or under exactly one top-level folder, so Prism/MultiMC (P2).
   5. Otherwise the zip is invalid as a modpack. Offer "Import as overrides into an existing instance" (P2).
4. Parse JSON tolerantly. **Strip a leading UTF-8 BOM** first: exported manifests often have one and plain `JSON.parse` rejects it. Validate against the shapes in §3. On a validation error, show which field is wrong (for example "CurseForge manifest is missing `minecraft.modLoaders`").
5. Build the **install plan** (§4), meaning the list of target files. Cache it in the resource metadata keyed by the pack's sha1, so re-opening is instant.
6. Identify the **upstream** (where the pack came from):
   - If the pack was downloaded from the marketplace, the marketplace layer has already recorded `{modrinth: {projectId, versionId}}` or `{curseforge: {projectId, fileId}}` against the pack's sha1. Use that.
   - Otherwise, in the background and without blocking the preview:
     - Modrinth packs: send the pack sha1 to `POST https://api.modrinth.com/v2/version_files` with `{"hashes":[sha1],"algorithm":"sha1"}`.
     - CurseForge packs: compute the CurseForge fingerprint (murmur2, see `resources.md`) and query `POST https://api.curseforge.com/v1/fingerprints/432`.
   - Store any exact match as metadata against the sha1. The import then picks it up as the instance's `upstream`.
7. Note that a pack may be opened again while its first parse is still running (for example the user double-clicks). Share one parse per path and give every caller the same result. Do **not** let a caller read an empty file list before parsing finishes. The original's update dialog once read the list too early and marked every existing file for removal.

### 2.1 Preview → instance options

| Instance field | Modrinth | CurseForge |
|---|---|---|
| `name` | `name` | `name` |
| (pack version, shown in the UI and stored on the upstream) | `versionId` | `version` |
| `description` | `summary` | (none) |
| `author` | (none; use the project author from the marketplace if known) | `author` |
| `runtime.minecraft` | `dependencies.minecraft` | `minecraft.version` |
| loader | `dependencies.forge` / `neoforge` / `fabric-loader` / `quilt-loader` | the `minecraft.modLoaders[]` entry with `primary: true` (or the first entry), id `forge-<v>`, `neoforge-<v>`, `fabric-<v>` or `quilt-<v>` |
| `icon` | marketplace project icon, if known | marketplace project icon, if known |
| `upstream` | from §2 step 6 | from §2 step 6 |

Notes:
- The original named instances `<name>-<version>`. Amethyst uses just `<name>` and shows the pack version separately, because the version changes on every update and the name should not. Make the name distinct if it is already taken (`instances.md` §5.2).
- CurseForge NeoForge ids: strip the `neoforge-` prefix. On 1.20.1 the remainder may carry a `1.20.1-` prefix (for example `neoforge-1.20.1-47.1.84`). Normalise it to the form in `instances.md` §3.2.
- Ignore unknown dependency keys in `dependencies`, but surface a warning. If more than one loader key is present, reject the pack as malformed.
- If the pack name is empty, derive one from the file name: drop the extension, drop version-like tokens, turn `-`/`_` into spaces and use title case. Ask the user to confirm the result.
- "Existing instance" detection: before creating, look for an instance whose `upstream` is the **same origin** (same platform and project id; `instances.md` §3.6). If there is none, look for an instance with the same name, compared case-insensitively. If one is found, the preview offers **Update existing instance** (§6) next to **Create new**.

---

## 3. Manifest formats (public)

### 3.1 Modrinth `modrinth.index.json`

```json
{
  "formatVersion": 1,
  "game": "minecraft",
  "versionId": "1.4.2",
  "name": "Example Pack",
  "summary": "Optional short description",
  "files": [
    {
      "path": "mods/sodium-fabric-0.5.8+mc1.20.4.jar",
      "hashes": { "sha1": "…40 hex…", "sha512": "…128 hex…" },
      "env": { "client": "required", "server": "unsupported" },
      "downloads": ["https://cdn.modrinth.com/data/AANobbMI/versions/…/sodium-fabric-0.5.8+mc1.20.4.jar"],
      "fileSize": 1234567
    }
  ],
  "dependencies": {
    "minecraft": "1.20.4",
    "fabric-loader": "0.15.11"
  }
}
```

Folders inside the archive:
- `overrides/`: copied into the instance root for both client and server.
- `client-overrides/`: client only. It **takes precedence over** `overrides/` when both contain the same path.
- `server-overrides/`: server only. Amethyst is a client, so **ignore it** on import.

Rules from the format, which Amethyst must enforce:
- `formatVersion` must be `1` and `game` must be `minecraft`. Otherwise refuse with "unsupported pack format".
- `path` is relative to the instance root. **Reject** any path that is absolute, contains `..` segments, contains a NUL or backslash, or would resolve outside the instance after normalisation. Check this for both `files[].path` and every override entry name (zip-slip). Reject only that file, log it and show it in the result summary; do not reject the whole pack.
- `hashes.sha1` and `hashes.sha512` are required by the spec. Verify sha1 after download, and sha512 when present.
- `downloads` holds one or more https URLs, tried in order. The spec restricts Modrinth-hosted packs to `cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com` and `gitlab.com`. For a pack from anywhere else, allow other https hosts, but show the list of non-allowlisted hosts in the preview ("This pack downloads files from: …"). Never allow `http:` or `file:` here.
- `env.client`:
  - `unsupported`: **skip the file** on the client. The original did not skip these, so it installed server-only mods into client instances.
  - `optional`: show it in the preview as an opt-in checkbox, checked by default. Unchecked optional files are not installed.
  - `required` or missing: install.

### 3.2 CurseForge `manifest.json`

```json
{
  "minecraft": {
    "version": "1.20.1",
    "modLoaders": [{ "id": "forge-47.2.0", "primary": true }]
  },
  "manifestType": "minecraftModpack",
  "manifestVersion": 1,
  "name": "Example CF Pack",
  "version": "2.3.0",
  "author": "someone",
  "files": [
    { "projectID": 238222, "fileID": 4712866, "required": true }
  ],
  "overrides": "overrides"
}
```

- `overrides` names the override folder. It defaults to `overrides`. Normalise it to have exactly one trailing `/`.
- `files[].required: false` means the file is optional or disabled in the pack. Show it as an opt-in in the preview, unchecked by default. If the user opts in, install it; otherwise skip it. The original ignored this flag and installed everything.
- Any `modlist.html` at the root is informational. Ignore it.

### 3.3 Prism / MultiMC zip (P2)

- `mmc-pack.json` has a list of `components`, each with a `uid` and `version`. Map them as in `instances.md` §6.4:
  - `net.minecraft` → minecraft
  - `net.minecraftforge` → forge
  - **`net.neoforged`** → neoforge. The original looked for `net.neoforge`, so it lost NeoForge on Prism packs.
  - `net.fabricmc.fabric-loader` → fabric
  - `net.quiltmc.quilt-loader` → quilt
- `instance.cfg` is INI-like `key=value` (no sections, or a `[General]` section). It supplies the name, notes, JVM args and memory. It supplies commands only when `OverrideCommands=true`.
- Game files live under `.minecraft/` (MultiMC) or `minecraft/` (Prism) inside the zip, possibly under one more top-level folder.
- `patches/<uid>.json` files that override `mainClass` or libraries need a merged standalone version JSON. Hand that off to the installer spec. If the installer cannot handle the patches, refuse the import with a clear message rather than producing an instance that will not launch.

---

## 4. Building the install plan

The **install plan** is a list of target files. Each entry has:
- `path`: relative to the instance root, using `/` separators.
- `hashes`: any of `sha1`, `sha512`, `md5`, `crc32`.
- `size`: optional.
- `sources`: ordered, typed sources, one of:
  - `https:<url>`
  - `archive:<packSha1>:<entryName>`: an entry in a cached pack zip, found through the pack's sha1 in the store or modpack cache.
  - `store:<sha1>`: already in the content store.
- `modrinth: {projectId, versionId}` or `curseforge: {projectId, fileId}`: optional market references.
- `optional`: boolean.
- `enabled`: boolean, for optional files.

Amethyst uses typed sources in place of the original's ad-hoc URL schemes, which were `zip:///<abs path>?entry=…`, `zip://<sha1>/<entry>`, `file://…` and `peer://…`. Always refer to the pack by its **hash** and find the file path at install time. The original's absolute-path URLs went stale when a cached pack was moved, and it had to rewrite them.

### 4.1 Files from the manifest

- **Modrinth**: one plan entry per `files[]` item that survives the `env` filter. Sources are the `downloads` in order. Hashes are taken as given. Size is `fileSize`.
- **CurseForge**: the manifest lists only ids, so resolve them through the API:
  1. Collect the distinct `fileID`s and call `POST https://api.curseforge.com/v1/mods/files` with `{"fileIds":[…]}` in **batches** (for example 100 ids per batch). If a batch fails with HTTP 400 (CurseForge rejects a whole batch when any id is invalid or deleted), **split the batch in half and retry each half**. A single bad id therefore drops only that file. Report dropped ids as "file no longer exists on CurseForge".
  2. Collect the distinct `modId`s from the results and call `POST https://api.curseforge.com/v1/mods` with `{"modIds":[…]}`, using the same batching and bisection. This gives each project's **`classId`**, `slug`, `links.websiteUrl`, `allowModDistribution` and name.
  3. Choose the target folder from `classId` (public CurseForge class ids for Minecraft, gameId 432):

     | classId | Class | Target |
     |---|---|---|
     | 6 | Mods | `mods/` |
     | 12 | Resource Packs | `resourcepacks/` |
     | 6552 | Shaders | `shaderpacks/` |
     | 6945 | Data Packs | not auto-installable (data packs belong to a world). Put the file in `.amethyst/datapacks-pending/` and list it in the result so the user can add it to a world. |
     | 17 | Worlds | `saves/`, extracted into `saves/<zip base name>/`. Verify the zip contains a `level.dat`. |
     | 4546 Customization, 4559 Addons, other | Guess: a `.jar` or a zip with `META-INF/` goes to `mods/`, a zip with `pack.mcmeta` goes to `resourcepacks/`, anything else is unresolved. |

     The original mapped from hard-coded lists of *category* ids (`primaryCategoryId`), which goes stale whenever CurseForge adds categories. Use `classId`.
  4. Path is `<folder>/<file.fileName>`. Hashes come from `file.hashes[]`, where `algo: 1` is sha1 and `algo: 2` is md5. Also keep `file.fileFingerprint` (murmur2) for verification. Size is `fileLength`.
  5. Sources: if `file.downloadUrl` is non-null, use it. If it is **null**, the author has disallowed third-party distribution (`allowModDistribution: false`). Mark the entry **blocked** (§5.3) and add no URL. The original built `edge.forgecdn.net` / `mediafiles.forgecdn.net` URLs from the file id and name in this case. That works today, but it bypasses the author's opt-out and the CurseForge API terms, and the CDN may close it at any time. Do not do this by default (see Pitfalls).
  6. CurseForge files have no sha512, so verify sha1 (or md5, or the fingerprint).
  7. If the API is unreachable (offline, or 403 from a missing or invalid API key), fail the preview with a clear "Couldn't contact CurseForge" message and a Retry button. Do not build a partial plan without saying so.

### 4.2 Files from overrides

For each zip entry under the override prefix(es), skipping directory entries, `__MACOSX/` and `.DS_Store`:
- Path is the entry name minus the prefix. Match prefixes **including the trailing slash**: the original's Modrinth matcher tested for `overrides` without the slash, so an entry like `overrides-extra/…` was mangled.
- Hashes are the entry's **crc32** from the zip central directory. No full hash is needed; it is checked on extraction.
- Size is the uncompressed size.
- Source is `archive:<packSha1>:<entryName>`.

### 4.3 Merging and precedence

1. Start with the manifest files.
2. Add `overrides/` entries. An override with the same path as a manifest file replaces the manifest file (override files are the pack author's explicit content).
3. Add `client-overrides/` entries, which replace both of the above.
4. **Deduplicate paths case-insensitively and NFC-normalised**, because APFS is usually case-insensitive. The last writer wins, following the precedence above. The original deduplicated only on Windows, so a mac install could hold two entries for the same physical file and the result depended on ordering.
5. Drop entries whose path fails the safety check (§3.1).
6. Drop entries whose path falls under launcher-owned or dangerous locations: `.amethyst/`, `versions/`, `libraries/`, `assets/`, `runtimes/`. Log each drop.

---

## 5. Applying an install plan to an instance

The same engine handles: new-instance import, update (§6), adding market files to an instance, and resuming an interrupted install.

### 5.1 Staging pipeline

1. Take the per-instance mutex. Register an "on remove" handler that aborts this install (`instances.md` §5.5).
2. Create the staging workspace `.amethyst/staging/<operationId>/`. Persist an operation record (`.amethyst/staging/<operationId>.json`) holding the plan, the per-file status and the backup folder. This record is what makes the install **resumable** after a crash or quit.
3. Work out each file's **operation** against the instance (§6.2 has the full update algorithm; for a fresh install every file is `add`).
4. Materialise each `add` file into the workspace, trying sources in this order:
   1. **Already in workspace** with matching hash (a resumed install): done.
   2. **Content store** hit by sha1 (`resources.md`): hard-link (or APFS clone, or copy) from the store. Mods, resource packs and shader packs are always stored by sha1, so packs that share mods cost no extra disk space.
   3. **Archive entry**: extract from the cached pack zip and verify crc32 (and sha1 if known).
   4. **HTTPS**: download with the shared download manager (`download.md`). It handles concurrency limits, retries with backoff, mirror order (the `downloads` order) and resume. Verify sha1 (and sha512 if given). After a successful download, add mods, resource packs and shader packs to the content store and record their market metadata (Modrinth or CurseForge ids) against the sha1.
   5. Otherwise the file is **unresolved** (§5.3).

   Run downloads, extraction and linking in parallel with bounded concurrency. Report progress as one task with sub-phases (resolve, download, extract, link) and counts plus bytes.
5. **Commit** once every resolvable file is ready:
   1. Back up files that will be overwritten or removed (`backup-add`, `backup-remove`, and `remove` when backups are enabled) into `.amethyst/backups/<timestamp>-<operationId>/<path>`. Never overwrite an existing backup: if the target exists with different content, add a `.1`, `.2`, … suffix. Copy with `COPYFILE_EXCL`.
   2. Move workspace files into place with `rename`, which is atomic on the same volume. Record each committed path in the operation record as it is moved.
   3. Delete files whose operation is `remove`/`backup-remove`, then remove directories left empty by those deletions.
   4. If any step fails mid-commit, roll back: restore from the backups the files already replaced, and remove the newly placed files that had no previous version. Leave the operation record so the install can be resumed.
6. Write the new **lock** (`.amethyst/lock.json`, §6.1) for upstream-based installs. Write `.amethyst/unresolved.json` if any files are unresolved, or delete it if none are. Delete the workspace and the operation record.
7. Release the mutex.

Guards:
- Before commit, and periodically during long downloads, check that the instance directory still exists and is the same directory (same inode). If it is gone, abort cleanly. The user may have deleted it, or moved it in Finder.
- Cancellation: an abort signal stops downloads and extraction. A cancelled install keeps its workspace and operation record. The instance shows "Install incomplete: Resume / Discard". **Discard** deletes the workspace and the operation record and leaves the instance as it was before the install.
- On start-up, scan instances for leftover operation records. Show "Resume" and do not auto-resume.

### 5.2 After files: game version

Once files are committed (or in parallel, since they are independent), make sure the game version for the instance's `runtime` is installed (`instances.md` §8 and the installer spec). If it fails, the instance shows "Install" in place of "Play". The modpack files stay installed.

### 5.3 Unresolved and blocked files

A file is unresolved when no source worked. Causes include a CurseForge file without a `downloadUrl`, a dead URL, a hash mismatch on every source, or an API lookup that failed.

After the install, if `.amethyst/unresolved.json` is non-empty, open the **Missing files** dialog automatically. Open it only when the list goes from empty to non-empty, not on every visit to the instance. For each file, show the file name, target folder, reason, and the project name if known.

**CurseForge blocked files**, modelled on Prism's flow:
- Show **Open download page**. The page is `<mod.links.websiteUrl>/download/<fileId>`, or `https://www.curseforge.com/minecraft/<class-slug>/<mod.slug>/download/<fileId>`, opened in the user's default browser.
- **Watch `~/Downloads`**, or a folder the user picks, while the dialog is open. When a new file shows up whose name matches, or whose sha1/md5/fingerprint matches the expected hash, take it in: verify, add to the store, place it in the instance, and tick it off. On macOS, reading `~/Downloads` triggers a TCC consent prompt. Explain why before the first access.
- Also accept drag-and-drop of the downloaded files onto the dialog.

Other unresolved files:
- **Retry**.
- **Search alternatives**: look the sha1 up on Modrinth (`POST /v2/version_files`). Failing that, search Modrinth or CurseForge by a name derived from the file name: strip the extension and the loader and version tokens, and split CamelCase. Let the user pick a replacement. A replacement found by name has a different hash, so verify against the **replacement's** hashes.
- **Ignore**: remove the file from the unresolved list.

The original wrote the unresolved list to a file in the instance and showed it in a dialog with these same choices, except for the Downloads watcher.

Launching with unresolved files is allowed, but show a warning ("3 files are missing; the game may crash").

---

## 6. Modpack update

### 6.1 Lock file

`.amethyst/lock.json` records which files the current pack version **owns**:

```json
{
  "schemaVersion": 1,
  "upstream": { "kind": "modrinth", "projectId": "AbCdEf12", "versionId": "XyZ98765", "packSha1": "…" },
  "installedAt": 1717000000000,
  "files": [ { "path": "mods/a.jar", "hashes": { "sha1": "…" }, "size": 123 } ]
}
```

Write it after each successful upstream install. Files that the user added later are absent from `files`. That is how user content is told apart from pack content.

Legacy fallback (an instance with `upstream` but no lock, for example one imported from another launcher): if the cached install plan for `upstream.packSha1`, or for the upstream ids, is still in the store metadata, use its file list as the lock. If it is not, treat the old file set as empty. In that case every pack file that already exists on disk with a different hash becomes `backup-add`, so nothing is silently overwritten.

### 6.2 Three-way file diff

Inputs:
- `old`: the lock's files
- `new`: the new plan's files
- the instance's current files on disk

For each path in `old ∪ new`, compare paths case-insensitively and NFC-normalised:

| On disk? | User changed it? (see below) | In `new`? | Operation |
|---|---|---|---|
| no | — | yes | `add` |
| no | — | no | nothing |
| yes | no | yes, same content as `new` | `keep` |
| yes | no | yes, different | `add` (overwrite; it is pack-owned and untouched) |
| yes | no | no | `remove` (the pack dropped it) |
| yes | yes | yes, same content as `new` | `keep` (no backup needed) |
| yes | yes | yes, different | `backup-add` (back up the user's version, then write the new one) |
| yes | yes | no | `backup-remove` (back up, then remove) |
| yes | unknown (no old record of this path) | yes, different | `backup-add` |

Notes on the table:
- **User changed it?**: the on-disk content differs from the `old` lock entry. Compare by the strongest hash both sides have: sha512, then sha1, then crc32. If neither side has a hash, compare by size. If even that is not possible, the answer is unknown.
- **Same content as `new`**: compared by the strongest available hash.
- **Case-only rename** (the same path ignoring case, but different case in `new`): always `add`, so the file ends up with the new casing. Use a two-step rename.

Files on disk that appear in neither `old` nor `new` are user files. **Never touch them.**

The original decided "user changed it?" by comparing file mtime with the lock's install timestamp. That is cheap, but wrong when tools rewrite configs or when copies keep their mtime. **Use content hashes** of the files that `old` lists. That is a bounded set, and sha1 runs fast in a worker. Keep mtime only as a cache key for the hashes.

Amethyst does **not** rename conflicting user mods to `name.CONFLICT.<hash>.jar`, as an older design note in the original described. A user's modified copy is always moved to `backups/`, which is what the original actually did.

### 6.3 Update flow (UI)

1. **Check for updates**, on opening the instance page (throttled to once every 6 hours per instance) or manually.
   - Modrinth: `GET https://api.modrinth.com/v2/project/{projectId}/version`, optionally filtered with `game_versions=["<mc>"]` (filtering is a user toggle: "only show versions for my Minecraft version"). Versions are newest first.
   - CurseForge: `GET https://api.curseforge.com/v1/mods/{modId}/files`, with paging, sorted by `fileDate` descending.
   - "Update available" means the newest listed version differs from `upstream.versionId`/`fileId` **and** was published after it. A version list that includes older entries is not an update.
   - Show a badge and the changelog: Modrinth `changelog` (Markdown), or CurseForge `GET /v1/mods/{modId}/files/{fileId}/changelog` (HTML, which must be sanitised before display).
2. The user picks a target version: newer, older (a downgrade, which uses the same algorithm), or a re-install of the current one (a repair).
3. Download that version's pack into the modpack cache. Open it (§2) and wait for the full file list.
4. **Same-origin check**: the new pack's upstream must have the same platform and project as the instance's. If it does not, refuse with "This instance follows a different modpack".
5. Compute the diff (§6.2) and show the **preview**:
   - A file tree coloured by operation (add, remove, keep, backup-add, backup-remove), with counts and a "hide unchanged" toggle.
   - Every non-`keep` row has a checkbox, checked by default. Unchecking a row excludes that change.
   - Runtime changes appear as a banner, for example "Minecraft 1.20.1 → 1.20.4, Fabric 0.15.7 → 0.15.11".
   - A note says that "Backed-up files are saved in `.amethyst/backups/…`", with a link that reveals the folder in Finder.
6. On confirm:
   1. Apply the selected operations through §5.
   2. In the same instance edit, set the new `runtime`, set `upstream` to the **target** version (taken from the user's choice, not from cached metadata; see Pitfalls) with its `packSha1`, and **clear `versionId`** (`instances.md` §5.3).
   3. Write the new lock.
   4. Install the game version (§5.2).
7. If the user unchecked some changes, write the lock as the *new* pack's file list anyway, so the deselected files count as "user deviations" on the next update. The original behaved the same way. Tell the user about it in the preview.

**Rollback**: offer "Restore previous version" for 7 days. Re-running the update with the previous upstream version reverses the operations (adds become removes and the other way around), and backed-up user files are restored from the matching `backups/` folder. Back-up files stay where they are even after a rollback, so delete old backup folders through Settings → Storage, or after 30 days.

---

## 7. Creating an instance from a modpack (end to end)

1. Open the pack (§2) and show the preview dialog. The fields are editable: name, icon, and optional/opt-in files. Memory, Java and similar settings stay at their defaults, and the user can edit them in the dialog.
2. If an existing instance matches (§2.1), offer to update it instead (§6).
3. Create the instance (`instances.md` §5.2) with the previewed options and the upstream (including `packSha1`). Do **not** apply the "link shared folders" preferences that the manual-create dialog remembers.
4. Install the plan (§5) and write the lock.
5. Install the game version (§5.2).
6. Select the new instance and show the result summary: files installed, skipped (env/unsafe), unresolved, and datapacks pending.

If step 4 fails or is cancelled, keep the instance and show "Install incomplete: Resume / Discard". Pressing **Create** again in the same dialog resumes the install; it must not create a second instance.

---

## 8. Export

### 8.1 Dialog

Defaults are stored per instance in `.amethyst/export.json`:

- Name: the instance name. Version: the last exported version, else `1.0.0`. Author: the instance author.
- Output formats: **Modrinth `.mrpack`** (default on) and **CurseForge zip** (default off).
- **Strict Modrinth mode**, default on: only URLs on the Modrinth-allowed hosts may appear in `downloads`. Any other file is embedded.
- Output folder: last used, else `~/Downloads`.
- **File picker**: a tree of the instance files, with the last selection remembered.
  - Pre-select `mods/`, `config/`, `defaultconfigs/`, `kubejs/`, `resourcepacks/`, `shaderpacks/` and `options.txt`.
  - Do **not** pre-select `saves/`, `screenshots/`, `logs/`, `crash-reports/`, `servers.dat` or `.amethyst/`.
  - Never offer these at all: `.amethyst/`, `versions/`, `libraries/`, `assets/`, `natives/`, `.DS_Store`, `usercache.json`, `usernamecache.json`, `launcher_*.json`, and any file whose path looks like credentials or keys (`*.pem`, `*.key`, `*.p12`, `*token*`, `*secret*`, `accounts*.json`).
  - Show a warning badge on `servers.dat` and on world folders ("may contain private server addresses or player data").
- **Per-file options**:
  - "Embed file", which forces it into overrides even when a download link exists.
  - Environment: client and server, each `required`, `optional` or `unsupported`. Default `required`/`required`. Prefill from the mod's own metadata when known, for example Fabric's `environment: client` maps to server `unsupported`.
- **Linkage preview** for Modrinth: "N of M mods will be linked; K will be embedded", with a reason per embedded file (no Modrinth match, the only URL is on a disallowed host, or the file is missing). The pack size estimate shows the embedded bytes.

### 8.2 Classifying each selected file

For files under `mods/`, `resourcepacks/` and `shaderpacks/` that are not forced to embed:

1. Look up market metadata by sha1. Check the lock first, then the content store.
2. **Modrinth output**:
   - If the file has a Modrinth reference and at least one allowed download URL (in strict mode: allowlisted hosts only; in non-strict mode: any https host except CurseForge CDNs), add a `files[]` entry with `path`, `hashes` (sha1 **and sha512**, computed if missing), `downloads`, `fileSize`, and `env` (omitted when it is `required`/`required`).
   - Otherwise, query `POST /v2/version_files` with the sha1. On a match, use the matching file's URL and record the reference in the store for next time.
   - Otherwise, embed the file in overrides, but first check its origin. If the only known source is CurseForge, warn: "Embedding CurseForge-only files in a Modrinth pack may violate the author's license or Modrinth's rules". Let the user exclude it. The original embedded these silently, and its CDN denylist misspelled the CurseForge host (see Pitfalls).
3. **CurseForge output**:
   - If the file has a CurseForge reference, add `{projectID, fileID, required: true}`.
   - Otherwise, compute the murmur2 fingerprint and batch-query `POST /v1/fingerprints/432`. Use exact matches only, and record each match.
   - Otherwise, embed the file in `overrides/`.
4. All other files are embedded.

Embedding destination by environment:
- client `unsupported` (server only): Modrinth `server-overrides/`. For CurseForge, leave the file out of the client zip, and if any such files exist, also write a separate `<name>-<version>-server.zip`.
- server `unsupported` (client only): Modrinth `client-overrides/`, CurseForge `overrides/`.
- otherwise: `overrides/` in both formats.

### 8.3 Writing archives

- Modrinth manifest:
  - `formatVersion: 1`, `game: "minecraft"`, `versionId` = version, `name`, `summary` = description.
  - `dependencies`: `minecraft` plus the one loader key (`forge`, `neoforge`, `fabric-loader` or `quilt-loader`).
  - OptiFine cannot be expressed. Warn about it, and suggest including OptiFine's jar as an embedded file only if its license allows.
- CurseForge manifest:
  - `manifestType: "minecraftModpack"`, `manifestVersion: 1`, `name`, `version`, `author`, `overrides: "overrides"`.
  - `minecraft.version`, and `minecraft.modLoaders: [{ id: "<loader>-<version>", primary: true }]` with exactly one primary loader.
  - CurseForge does not support Quilt for modpacks. Warn and still write `quilt-<v>`.
- Output names: `<name>-<version>.mrpack` and `<name>-<version>.zip`, with file-name-unsafe characters replaced by `_`. If a file with that name exists, ask whether to overwrite it.
- Write each zip to `<output>.partial` and rename on success. Show progress as one task with byte counts. Cancelling deletes the partial file.
- Do **not** add launcher-specific sidecar files to the archive by default. The original added its own JSON with window size, auto-join server and similar; other launchers ignore it. If a sidecar is wanted later, call it `amethyst.json` and make it opt-in.
- When done, reveal the file in Finder (unless the caller disables that), and save the chosen options to `.amethyst/export.json`.

---

## 9. Error model

| Code | When | UI |
|---|---|---|
| `notAFile` | The path is a directory or missing | "Choose a modpack file" |
| `notAZip` | The zip failed to open | "This file isn't a modpack archive (.mrpack or .zip)" |
| `unknownFormat` | No manifest detected | Offer "import as overrides" (P2) |
| `invalidManifest` | Schema validation failed | Show the field path |
| `unsupportedFormat` | Modrinth `formatVersion` ≠ 1, or `game` ≠ minecraft | Message |
| `marketUnavailable` | The CurseForge or Modrinth API failed during plan building | Retry |
| `differentUpstream` | Same-origin check failed during an update | Message |
| `installIncomplete` | Some files unresolved, or a cancel or crash | Resume / Discard; Missing files dialog |
| `diskFull` / `permission` | ENOSPC / EACCES / EPERM | Message with the path; keep the operation resumable |

These are expected user-facing conditions. Do not report them to telemetry as crashes.

---

## 10. Performance targets

- Opening a 300-file pack: the preview appears in under 1 s when the plan is cached. For CurseForge packs, under 5 s on a normal connection (two batched API calls).
- Installing a 300-mod pack whose files are all in the store: under 10 s, since it is mostly linking.
- Hash computations run in a worker thread or process and must never block the main process.

---

## 11. FTB (maybe)

The original also installed FTB packs from the FTB modpacks API. That was JSON manifests listing files with URLs, sha1 and target paths, and the update diff ran directly between the old and new version manifests. If this is added later, map it onto the same install plan (§4) and update engine (§6), with an `upstream` of `{kind: "ftb", packId, versionId}`. It is out of scope for v1.

---

## Pitfalls / bugs observed in the original

1. **Modrinth `env` was ignored on import.** Files marked `client: unsupported` were installed into client instances, and `optional` files could not be opted out of.
2. **`client-overrides` precedence was not enforced.** Override and manifest files with the same path were all kept. They were deduplicated only on Windows (case-insensitively), so on macOS the result depended on zip entry order.
3. **The Modrinth override prefix was matched without its trailing slash** (`overrides` rather than `overrides/`), so the entry name of anything like `overrides-foo/` was mangled.
4. **CurseForge `required: false` was ignored.** Optional files were always installed.
5. **CurseForge files with no `downloadUrl` were downloaded anyway** from guessed `edge.forgecdn.net`/`mediafiles.forgecdn.net` URLs. That goes against the author's distribution opt-out and the API terms, and it breaks without warning if the CDN path changes.
6. **The CurseForge folder was chosen from hard-coded `primaryCategoryId` lists**, not `classId`. Data packs were sent to `resourcepacks/`, and new categories fell through to a filename guess.
7. **The CDN denylist for Modrinth exports listed `media.forgecdn.net`, but the guessed CurseForge URLs use `mediafiles.forgecdn.net`.** In non-strict mode, CurseForge CDN links could leak into `.mrpack` manifests. CurseForge-only jars were also embedded in mrpacks without warning.
8. **Absolute-path zip URLs** in cached plans went stale when the cached pack file was moved. A later fix rewrote them on reopen. Refer to packs by content hash.
9. **The pack's file list was read before async parsing finished**, so the update preview proposed removing every file. A later fix added waiting with a hard 90-second timeout, which then fails on slow CurseForge lookups.
10. **After an update, `upstream` came from the new pack's cached metadata, not the user's chosen version.** If that metadata had not been resolved yet, the instance could lose its upstream or keep a stale one. The pinned version id was not cleared when the loader changed.
11. **User modifications were detected by mtime against the install time.** Copying an instance (which keeps mtimes), or games and mods rewriting configs on first run, gave wrong backup and overwrite decisions.
12. **The update design doc described renaming conflicting files to `*.CONFLICT.<hash>.jar`, but the code moved them to a backups folder.** Do not rely on the design doc.
13. **The Prism/MultiMC NeoForge component uid was mapped as `net.neoforge`.** Prism uses `net.neoforged`, so NeoForge Prism packs imported as vanilla or Forge.
14. **New instances were named `<pack>-<version>`.** Each update left a stale version in the instance name.
15. **CurseForge mod loader ids were parsed by fixed-length substring after a `startsWith` check.** Nothing normalised a loader version that carries a Minecraft prefix (possible for the 1.20.1 NeoForge fork). Normalise as in §2.1 and test with real manifests.
16. **Non-zip drops (`.rar`, `.7z`, half downloads, Forge installers) and manifests with a BOM surfaced as raw internal errors** until they were special-cased. Handle both from the start (§2).
