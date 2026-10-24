# Instances — behavioural specification

Status: draft for Amethyst (Electron + React, macOS 13+ on Apple Silicon only).
Scope: the instance model, its on-disk layout, how instances are created, edited,
duplicated, deleted, grouped and imported, and how an instance's version
requirements are matched to an installed game version.
Related specs: `resources.md` (mods/packs/saves in an instance), `modpacks.md`
(instances created from modpacks, plus modpack updates), `settings-themes.md`
(global defaults that instance fields override). Installing the game, Java
selection and building the launch command each get their own spec.

---

## 1. Concepts

- **Instance**: a self-contained Minecraft *game directory* (what the game sees as
  `--gameDir`), plus launcher metadata describing what to run in it: the Minecraft
  version, an optional mod loader, Java and memory overrides, and so on. Every
  instance has its own `mods/`, `config/`, `saves/`, `options.txt` and so on.
- **Shared game data root** (the "root"): one folder that holds the heavy,
  shareable artefacts used by every instance: `versions/`, `libraries/`,
  `assets/`, Java runtimes, the content-addressed resource store (see
  `resources.md`), the modpack download cache, and optional shared
  `saves/`/`resourcepacks/`/`shaderpacks/` folders. Instances never duplicate
  these artefacts.
- **Managed instance**: an instance whose folder is inside `<root>/instances/`.
  The launcher owns the folder name and may rename or delete the folder.
- **External (linked) instance**: an instance whose folder is somewhere else (for
  example an existing `.minecraft`-style folder the user pointed us at). The
  launcher writes its metadata into the folder, but never renames or deletes the
  folder. "Delete" only unregisters it.
- **Runtime requirements**: the set of desired component versions (Minecraft plus
  at most one primary loader, plus optional OptiFine). This is the source of
  truth for what the instance runs.
- **Pinned version id**: an optional, explicit id of an installed version folder
  (`<root>/versions/<id>/<id>.json`). It exists so that an instance can use a
  hand-made or imported version JSON whose id can't be derived from the
  requirements (for example a Prism/MultiMC merged version). The pin is advisory:
  it is used only while it still satisfies the runtime requirements (see §8).

## 2. Paths (macOS)

| Purpose | Default path |
|---|---|
| Launcher app data (launcher-level state, never moved) | `~/Library/Application Support/Amethyst/` |
| Game data root (user-configurable at first run / in settings) | `~/Library/Application Support/Amethyst/` (same as app data by default) |
| Managed instances | `<root>/instances/<folder>/` |
| Instance registry (external paths, groups) | `<appData>/instances.json` |

- The root location is stored in a small pointer file in app data, so it can be
  moved. The instance registry stays in app data and does not move with the
  root. Managed instances are recorded **relative to `<root>/instances`** so
  that moving the root doesn't break them. External instances are recorded as
  absolute paths.
- Reject a root, or an external instance path, that is a volume root (`/`,
  `/Volumes/X`), the user's home folder itself, or a path inside the app bundle.
  The original refused drive roots after users picked them by mistake and
  scanning them produced a storm of errors.
- Warn when the root is on a non-APFS or network volume. Hard links and
  symlinks may not work there, so the content-addressed store falls back to
  copying (see `resources.md`).

## 3. Instance model

Amethyst keeps instance metadata in its own JSON file (§4). The fields below
are named for Amethyst. The original had the same concepts under different
names. Every field is optional on read: an unknown or invalid value falls back
to its default **per field**, so one bad field never discards the whole file
(see Pitfalls).

### 3.1 Identity and presentation

| Field | Type | Default | Notes |
|---|---|---|---|
| `schemaVersion` | integer | `1` | For future migrations. |
| `name` | string | required at creation | Display name. Leading and trailing whitespace is trimmed. It also decides the managed folder name (§5.2). |
| `author` | string | the signed-in player's name at creation, else `""` | Shown in the UI and used as the default author on modpack export. |
| `description` | string | `""` | Free text. Becomes the modpack summary on export. |
| `icon` | string | `""` | One of: empty (use a generated or default icon), a **relative path inside the instance folder** (normally `icon.png` / `icon.webp` / `icon.svg`), or an absolute `https:` URL (kept only until it is fetched; see §5.4). |
| `homepageUrl` | string | `""` | For example the modpack's project page. Informational only. |

### 3.2 Runtime requirements

`runtime` object. Each value is a string, and an empty string means "not used".

| Field | Example | Notes |
|---|---|---|
| `minecraft` | `1.20.1`, `24w14a` | Required. If it is empty at creation, use the latest release from the Mojang version manifest. |
| `forge` | `47.2.0` | The Forge version **without** the Minecraft prefix. For older Forge, accept and normalise forms like `1.7.10-10.13.4.1614-1.7.10` to `10.13.4.1614` (§8.3). |
| `neoforge` | `20.4.237`, `47.1.84` | The NeoForge version. For the 1.20.1 NeoForge fork, versions look like `47.1.x`. |
| `fabric` | `0.15.11` | The Fabric loader version. |
| `quilt` | `0.26.0` | The Quilt loader version. |
| `optifine` | `HD_U_I6` | The OptiFine edition without the Minecraft prefix. Also accept `1.20.1_HD_U_I6` and strip the prefix. |

Rules:
- At most one of `forge`, `neoforge`, `fabric`, `quilt` may be non-empty. The UI
  enforces this. On read, if several are set, keep the first in the order
  forge > neoforge > fabric > quilt and log a warning. (The original quietly
  allowed combinations and its installer then ignored some of them.)
- `optifine` may be combined with nothing or with `forge`. With Forge it is
  installed as a mod jar in `mods/`. On its own it is installed as a version
  layer. Combining it with Fabric or Quilt needs a third-party shim and is not
  supported. Reject it in the UI.
- LabyMod, LiteLoader and Bedrock are out of scope.

### 3.3 Version pin

| Field | Type | Default | Notes |
|---|---|---|---|
| `versionId` | string | `""` | An optional pinned installed version id (§1, §8). The launcher updates it after a successful install so later launches skip the search. |

### 3.4 Java and launch overrides

For every override field, **absent means "use the global setting"**. The UI
shows a "use global" toggle per field, and turning it on removes the field from
the file (see Pitfalls about `undefined` across IPC).

| Field | Type | Global counterpart | Notes |
|---|---|---|---|
| `javaPath` | string (absolute path to a `java` executable) | global Java / auto-select | Validate that it exists, is executable and is **arm64 or universal**. Warn when it is x86_64 (it runs under Rosetta 2, slowly). If the pinned Java no longer resolves at launch, fall back to auto-selection and warn. Don't fail with ENOENT (the original learned this the hard way). |
| `memory.mode` | `"auto" \| "manual"` (absent means global) | global memory mode | See §3.5. |
| `memory.minMB` | integer ≥ 0 | global min | Used only in manual mode. 0 means don't pass `-Xms`. |
| `memory.maxMB` | integer > 0 | global max | Used only in manual mode. |
| `jvmArgs` | string[] | global JVM args | **Store as an array of argv tokens.** The editor must parse shell-like quoting (`-Dfoo="a b"` becomes one token). Don't split on spaces. |
| `gameArgs` | string[] | global game args | Same parsing rules. |
| `env` | `Record<string,string>` | global env | Merged on top of the global env (the instance wins per key). |
| `wrapperCommand` | string | global wrapper | A command prepended to the java invocation (for example `/usr/bin/caffeinate -i`). |
| `preLaunchCommand` | string | global pre-launch | Run (and awaited) before the JVM starts, with cwd set to the instance folder. A non-zero exit aborts the launch and shows the command's output. |
| `window` | `{ width?: int>0, height?: int>0, fullscreen?: bool }` | global resolution | Passed as `--width/--height/--fullscreen`. |
| `autoJoinServer` | `{ host: string, port?: int (default 25565), name?: string } \| null` | none | When set, the game connects to this server on start (`--quickPlayMultiplayer host:port` on 1.20+, `--server/--port` on older versions). `name` disambiguates entries in `servers.dat` with the same host. `null` or absent means off. |
| `hideLauncherOnLaunch` | bool | global | |
| `showLogWindow` | bool | global | |
| `skipAssetVerification` | bool | global "fast launch" | Skip the asset and library hash check before launch. |

### 3.5 Memory resolution (at launch)

1. `mode` is the instance value if present, else the global value.
2. **manual**: pass `-Xms<min>m` only when min > 0, and `-Xmx<max>m` only when
   max > 0. If min > max, the UI blocks saving. The launcher clamps min to max
   at launch and warns.
3. **auto** (new, deliberately unlike the original): compute **both** values.
   Suggested heuristic: `max = clamp(2048 + 512 × ceil(modCount / 25), 2048,
   min(physicalRAM × 0.5, 16384))` MB and `min = min(1024, max)`. `modCount` is
   the number of enabled jars in `mods/`. Keep at least 4 GB free for macOS
   unified memory.
4. **global-default with no explicit memory**: pass nothing and let the JVM
   choose.

The original's auto mode computed only `-Xms` from the mod count and left
`-Xmx` to the JVM default (¼ of RAM). On a heavily modded pack this can start
the JVM with `-Xms` above its default maximum, and the JVM refuses to start. See
Pitfalls.

### 3.6 Provenance

| Field | Type | Notes |
|---|---|---|
| `upstream` | tagged union, or absent | Where the instance's content came from. Used for modpack update checks (`modpacks.md`). Variants: `{ kind: "modrinth", projectId, versionId, packSha1? }` and `{ kind: "curseforge", projectId: number, fileId: number, packSha1? }`. Validate the ids: Modrinth ids are 8-character base62 (`[0-9A-Za-z]{8}`), and CurseForge ids are positive integers. Drop invalid values on read. |

Two upstreams are **the same origin** when they have the same `kind` and the same
`projectId`. The version or file id may differ.

### 3.7 Timestamps and play time

All times are milliseconds since the epoch.

| Field | When it is set |
|---|---|
| `createdAt` | At creation (and on duplicate, the copy gets a fresh value). Never edited afterwards. |
| `lastOpenedAt` | Whenever the user selects the instance in the UI. |
| `lastPlayedAt` | When the game process starts for this instance. |
| `playTimeMs` | When the game process exits, add `exitTime - startTime` (ms). Ignore negative values and values above 7 days per session (clock jumps). Write atomically. If the launcher crashes during a session, the time from that session is lost. Optionally checkpoint every 5 minutes to a per-session file. |

These fields are **not** user-editable, and edits that come through the generic
edit API must not change them (except from the internal play-time tracker).

## 4. On-disk layout

```
<root>/
  instances/
    My Pack/                       ← managed instance folder (= game directory)
      .amethyst/                   ← launcher-owned metadata, hidden from the game
        instance.json              ← the model in §3
        lock.json                  ← content lock: files owned by the upstream modpack (modpacks.md)
        pending.json               ← staged, not-yet-applied file changes (optional feature)
        unresolved.json            ← files from the last install that could not be downloaded
        export.json                ← remembered modpack export preferences (modpacks.md)
        mod-groups.json            ← optional UI grouping of mods (resources.md)
        staging/<operationId>/     ← temporary workspace for installs (deleted on success)
        backups/<timestamp>-<op>/  ← files replaced or removed by a modpack update
      icon.png                     ← instance icon (any image extension, or .svg)
      mods/  config/  resourcepacks/  shaderpacks/  saves/  screenshots/
      logs/  crash-reports/  options.txt  servers.dat  …   ← normal game files
  versions/  libraries/  assets/  runtimes/  store/  modpacks/
  saves/  resourcepacks/  shaderpacks/   ← optional shared folders (see §5.6)
<appData>/instances.json
```

Design decisions (and how they differ from the original):

- The original put its metadata files directly in the instance root
  (`instance.json`, a lock file, a pending-install file, an unresolved-files list,
  a modpack-export metadata file, mod-group files, and hidden staging and backup
  folders). Amethyst gathers them under `.amethyst/` so that the game, file
  browsers and exports have a single thing to ignore.
- **`instance.json` is the only file that makes a folder an instance.** A folder
  under `instances/` without a readable `.amethyst/instance.json` is ignored at
  load and listed in a "broken instances" notice with a "repair" action (§6.1).
  The original quietly dropped such folders.
- Writes to `instance.json`, `lock.json` and `instances.json` are **atomic**:
  write a temp file in the same folder, `fsync`, then `rename`. Writes to each
  file are serialised through a per-file queue.

### 4.1 `instances.json` (registry)

```json
{
  "schemaVersion": 1,
  "external": ["/Users/me/Games/Old Minecraft"],
  "groups": [
    { "id": "g-1", "name": "Modded", "color": "#8e6cff", "members": ["My Pack", "/Users/me/Games/Old Minecraft"] }
  ],
  "order": ["My Pack", "g-1", "Vanilla 1.21"]
}
```

- A member reference is either a managed folder name (relative) or an absolute
  external path.
- `order` is the sidebar ordering of top-level items: ungrouped instances and
  groups. Instances not listed anywhere are appended, sorted by `lastOpenedAt`
  with the most recent first.
- The selected instance is renderer UI state (persist it in the renderer's
  local storage or in settings). On start-up, if the remembered instance no
  longer exists or fails to load, select the first instance in order.

## 5. Operations

All mutating operations on one instance are serialised by a **per-instance async
mutex**. Delete takes it exclusively and cancels queued work (§5.5).

### 5.1 Load all instances (start-up)

1. Read `instances.json` (if it is missing or corrupt, treat it as empty and keep
   a `.corrupt-<ts>` copy).
2. List the children of `<root>/instances/` and skip names starting with `.`
   (those are soft-deleted instances, §5.5). Add the `external` paths.
   Deduplicate by real path, comparing with `fs.realpath`, case-insensitively
   and NFC-normalised (APFS is usually case-insensitive and
   normalisation-insensitive).
3. Load each instance in parallel: it must be a directory with a readable
   `.amethyst/instance.json`. Parse it leniently per field (§3). Resolve a
   relative `icon` against the instance folder.
4. External paths that no longer exist stay in the registry. Show them as
   "missing" with Locate… and Remove actions. Don't drop them silently: the drive
   may just be unmounted. (The original pruned them.)
5. Emit the instance list to the renderer.

Do **not** rename folders at load time. The original renamed a managed folder to
match the display name during start-up loading (§5.3 explains why Amethyst
renames at edit time instead).

### 5.2 Create

Input: the model fields (`name` is required. Everything else is optional),
plus an optional target path (making the instance external) and optional
"link to shared folder" flags (§5.6).

1. **Name.** If the user left the name empty, generate a placeholder from the
   runtime: `<minecraft>` followed by `-<loader><version>` when a loader is set,
   and `-optifine<ver>` when OptiFine is set. Make the name distinct among
   existing display names (compare case-insensitively) by adding ` (2)`, ` (3)`
   and so on to the **base** name. (The original appended to the previous
   attempt, producing names like `x-1-2`.)
2. **Validate the name** for use as a macOS folder name: not empty after
   trimming; no `/` or `:` (Finder shows `:` as `/`) and no NUL; not `.` or `..`;
   doesn't start with `.` (it would be hidden, and that marks a soft delete);
   at most 255 UTF-8 bytes. A trailing space or dot is allowed on macOS but
   trimmed for portability.
3. **Folder.** Managed: `<root>/instances/<sanitised name>`, where sanitising
   replaces invalid characters with `_`. If that path exists (compare
   case-insensitively), use the first free `<name> (2)`, `<name> (3)`, and so
   on. External: the chosen folder must exist or be creatable, mustn't already
   be registered, and mustn't be inside `<root>/instances` or the root's shared
   folders.
4. Create the folder plus `mods/`, `resourcepacks/`, `shaderpacks/` and
   `.amethyst/`.
5. Set `createdAt = lastOpenedAt = now`, `playTimeMs = 0` and `lastPlayedAt = 0`.
   If `runtime.minecraft` is empty, fill it with the latest release.
6. **Icon** (§5.4).
7. Write `instance.json` atomically, update `instances.json` if the instance is
   external, then emit "instance added".
8. Return the instance path. **Don't** install the game version at this point.
   The version is installed lazily at first launch, or explicitly through
   "Install" (that belongs to the installer spec). The UI may start a background
   install right after creation.

Failure handling: if any step after folder creation fails, remove the folder we
created (only if it was empty before we created it) and surface the error. When
creation is followed by a file install (modpacks), the instance is kept even if
the file install fails, so the user can retry the install. Retrying the same
dialog must resume that instance's install, not create a second instance (the
original handled this).

### 5.3 Edit

Input: a partial model plus the instance path.

- The renderer sends **`null` to mean "reset to global / remove this field"**.
  Electron's structured clone drops object keys whose value is `undefined`, so
  an `undefined` reset never reaches the main process. The main process turns
  `null` into "delete the key". Echo state changes back to renderers with the
  same `null` convention.
- Validate against the schema. Reject unknown keys and changes to
  `createdAt`/`playTimeMs`/`lastPlayedAt` from the UI. Ignore a `path` key.
- Compute a deep diff against the current model. If nothing changed, do
  nothing (no write).
- **Rename** (managed instances only): when `name` changes, work out the new
  sanitised folder name. If it differs from the current folder (ignoring case,
  NFC), and the target is free, and the instance isn't running or installing,
  then rename the folder **as part of this edit**. Afterwards update the group
  references and the selected-instance pointer, and emit "instance moved
  old → new". If the target is taken, keep the old folder name and apply only
  the display name (and tell the user). A case-only rename on case-insensitive
  APFS needs a two-step rename through a temporary name.
  (The original deferred folder renames until the next launcher start-up. That
  changed paths behind the user's back and left the renderer's remembered
  selection dangling. Its duplicate-name check also built the new path from the
  raw, unsanitised name.)
- **Runtime change**: clear `versionId` whenever any `runtime` value changes,
  unless the same edit also sets `versionId`. Changing the loader doesn't touch
  `mods/`. The UI should warn that existing mods may be incompatible.
- Persist atomically and emit "instance edited" with the diff.

### 5.4 Icons

Accepted inputs: a local image file, an `https:` URL, a `data:image/...` URL, or
the icon of a marketplace project or modpack.

- Always **copy the image into the instance folder** as `icon.<ext>`. Pick the
  extension from the sniffed content type (png, jpg, webp, gif, svg), not from
  the name. Then store the relative path. This keeps instances portable and
  self-contained.
- Limit: 8 MB. Refuse content that isn't an image. Downloads use the normal
  HTTP client with a timeout.
- SVG: allowed, but render it **only** through `<img src>` (never inline it in
  the DOM). That stops embedded scripts from running.
- The renderer shows icons through a privileged custom protocol (for example
  `amethyst-media://instance/<encoded path>/icon.png`) that serves only files
  inside registered instance folders. Don't expose arbitrary file reads. The
  original used an internal `http://launcher/media?path=<absolute path>` style
  URL.
- If storing the icon fails, the instance is still created without an icon and
  the error is reported.
- With an empty icon, the UI shows a default image chosen by loader type
  (vanilla grass block, Forge, NeoForge, Fabric, Quilt).

### 5.5 Delete

Input: the instance path and `keepFiles: boolean` (the dialog checkbox "Also
delete files", checked by default for managed instances).

1. Acquire the per-instance mutex **exclusively**. Before waiting for it:
   - reject queued operations that are waiting for the lock;
   - call every registered "on remove" handler. Active installs register
     handlers that abort their work. Wait (with `allSettled`) until those
     installs have stopped writing.
   The original fixed several races where deletion ran while an install was
   still writing into the folder, leading to ENOENT/EBUSY storms. Hold strong
   references to the handlers: the original once used weak references and they
   were garbage-collected mid-install.
2. Refuse while the game is running from this instance (offer to kill it
   first).
3. **External instance**: remove it from the registry only. Never touch the
   files.
4. **Managed instance, delete files**:
   a. **Rescue saves**: for each world in `saves/` that is a real directory (not
      a symlink, and the `saves/` folder itself isn't a link to the shared
      saves folder), move it into `<root>/saves/`. On a name clash, use
      `<world>-<timestamp>`. Tell the user how many worlds were rescued and
      where they went. (The original did this silently. Amethyst should say so
      in the confirmation dialog: "Worlds will be moved to the shared saves
      folder.")
   b. Move the folder to the **macOS Trash** (`shell.trashItem`) rather than
      deleting it permanently. Fall back to recursive delete (with retries)
      only if trashing fails. Never follow symlinks while deleting (linked
      `resourcepacks/` and similar must not take the shared folder with them).
   c. If removal fails with anything except ENOENT, keep the instance in state
      and show the error so the user can retry.
5. **Managed instance, keep files**: rename the folder to `.<name>` (hidden),
   which the loader skips. Provide a "Restore hidden instances" action in
   settings.
6. Emit "instance removed". If it was selected, select the previous instance
   in order (or none).

### 5.6 Shared folders

Per instance, the user can link `saves/`, `resourcepacks/` or `shaderpacks/`, and
also `options.txt` and `servers.dat`, to the root's shared copy. This lets one
set of worlds or packs follow the user across instances.

- **Link**: if the instance folder exists, move each child into the shared
  folder. On a name clash, rename to `<base>-<timestamp><ext>`. Child entries
  that are themselves links are dropped. Then replace the folder with a
  **symlink** to the shared folder.
- **Unlink**: remove the symlink and create an empty real folder. Content stays
  in the shared folder.
- Report the link state in the UI (folder chip "linked").
- New-instance dialog: remembered checkboxes for which folders to link. Apply
  them only to manually created instances, never to modpack imports. Each link
  is applied independently. A failure leaves an ordinary folder and shows a
  notification for that folder.
- When creating the link, check the symlink target, and repair stale links that
  point at an old root location.

### 5.7 Duplicate

1. New display name: the source name made distinct (§5.2 step 1). New folder:
   as in create.
2. Create the new instance from a deep copy of the source model, with fresh
   timestamps, play time reset, and **`upstream` and `lock.json` copied** so
   that modpack updates still work on the copy.
3. Copy the files as a cancellable task with progress:
   - Skip `.amethyst/staging`, `.amethyst/backups`, `.DS_Store`, and the root
     shared trees (`versions/`, `libraries/`, `assets/`) if they are present in
     an imported folder.
   - `mods/`, `resourcepacks/`, `shaderpacks/` files: **hard-link** when the
     source and destination are on the same volume (same `st_dev`), else copy.
     On APFS, prefer `fs.copyFile` with `COPYFILE_FICLONE` (copy-on-write
     clone) for every other file. That makes duplicates near-instant and free in
     disk space.
   - **Symlinked folders** (shared links, §5.6) are recreated as symlinks, not
     followed. The original followed them and copied the shared content into
     the new instance. That broke sharing and risked infinite recursion on
     link cycles.
   - Missing source files (ENOENT) are skipped quietly. Other per-file failures
     are collected and reported **once** at the end as a partial-failure error
     listing the paths. (The original learned to do this after a single
     duplicate produced hundreds of error events.)
4. On cancel, delete the partially created copy.

### 5.8 Validate an instance path

Used for "Add existing folder" and when restoring a remembered selection.
Return one of: `ok`, `missing`, `not-a-directory`, `no-permission` (macOS TCC:
Desktop, Documents, Downloads and removable volumes may need user consent),
`already-registered`, `inside-managed-root`, `is-volume-root`, or `bad`
(unreadable `instance.json`).

## 6. Importing an existing `.minecraft`-style folder

Two user flows. Both start with "Add instance → Import existing folder…" and
show a folder picker. Default the picker to the official launcher folder:
**`~/Library/Application Support/minecraft`** (on macOS there is **no leading
dot**. The original pointed at `<appData>/.minecraft`, which doesn't exist on
macOS).

### 6.1 Detect

Given a folder, classify it:

| Signal | Kind |
|---|---|
| `.amethyst/instance.json` | Already an Amethyst instance: register it as external (or offer repair if it is unreadable). |
| `launcher_profiles.json` | Official launcher data folder. It may define several profiles. |
| `mods/`, `saves/`, `options.txt`, `config/` without the above | A plain game directory: treat it as one instance. |
| `instance.cfg` + `mmc-pack.json` (Prism/MultiMC instance), `profile.json` (Modrinth App profile), `minecraftinstance.json` (CurseForge app instance) | Other launchers' instances. Optional, behind an "Import from other launcher" entry. Field mappings are in §6.4. |

Show a preview listing each detected instance (name, Minecraft version, loader,
mod count, size) with checkboxes, plus a mode choice:

- **Use in place** (external instance): register the folder, write
  `.amethyst/instance.json` into it, and leave the files where they are. This is
  best for big folders. The user is told that Amethyst will create a hidden
  `.amethyst` folder there.
- **Copy into Amethyst** (managed instance): create a managed instance and copy
  the game files (clone or copy as in §5.7). The source stays untouched.

### 6.2 Official launcher folder (`launcher_profiles.json`)

Public format (abridged):

```json
{
  "profiles": {
    "a1b2…": {
      "name": "Fabric 1.20.4",
      "type": "custom",
      "lastVersionId": "fabric-loader-0.15.11-1.20.4",
      "gameDir": "/Users/me/mc/fabric",
      "javaDir": "/Library/Java/…/bin/java",
      "javaArgs": "-Xmx4G -XX:+UseG1GC",
      "resolution": { "width": 1280, "height": 720 },
      "icon": "Grass" ,
      "created": "2024-01-01T00:00:00.000Z",
      "lastUsed": "2024-05-01T00:00:00.000Z"
    }
  }
}
```

For each profile:
- Name: `name`. If it is empty, use the type (`latest-release` → "Latest release",
  `latest-snapshot` → "Latest snapshot").
- Game directory: `gameDir` if set, else the launcher folder itself. Several
  profiles may share one directory. In "use in place" mode, a shared directory
  can only become one instance, so ask the user which profile wins.
- **Runtime**: resolve `lastVersionId` properly. It may be the special
  `latest-release`/`latest-snapshot` (use the manifest's latest), a vanilla id,
  or a loader version id (for example `fabric-loader-0.15.11-1.20.4` or
  `1.20.1-forge-47.2.0`). Read `<folder>/versions/<id>/<id>.json`, walk
  `inheritsFrom`, and derive the requirements with the detection in §8.2.
  Also pin `versionId` to that id. (The original copied `lastVersionId`
  straight into the Minecraft version field, so loader profiles became bogus
  Minecraft versions.)
- `javaDir` becomes `javaPath` (only if it exists and is a macOS
  arm64/universal Java; otherwise drop it and warn).
- `javaArgs`: tokenise shell-style. Extract `-Xmx`/`-Xms` into the manual
  memory fields and keep the rest as `jvmArgs`.
- `resolution` becomes `window`.
- `created`/`lastUsed` become `createdAt`/`lastPlayedAt` when they parse.
- **Shared artefacts**: offer to copy `versions/`, `libraries/` and `assets/`
  from the source into the root with **no overwrite** (`copy passively`).
  Assets and libraries are content-addressed or immutable, so existing files
  win. Prefer APFS clones. This lets the imported profiles launch offline. Skip
  the source's `runtime/` (Mojang's bundled Java), because Amethyst manages its
  own Java.
- When copying a profile's game directory into a managed instance, exclude
  `versions/`, `libraries/`, `assets/`, `runtime/`, `launcher_*.json`,
  `launcher_accounts*.json`, `usercache.json`, `usernamecache.json`,
  `webcache2/` and `logs/` (logs are optional).

### 6.3 Plain game directory

Create one instance named after the folder. Runtime detection, best effort:
1. If `versions/` is present inside, use the most recently modified version JSON
   (§8.2).
2. Else infer the loader from the mods: if `mods/*.jar` contain
   `fabric.mod.json` → Fabric; `quilt.mod.json` → Quilt;
   `META-INF/neoforge.mods.toml` → NeoForge; `META-INF/mods.toml` or
   `mcmod.info` → Forge. Infer the Minecraft version from the mods' declared
   dependency ranges (see `resources.md`). Then **ask the user to confirm** the
   versions before saving.
3. Else leave `minecraft` set to the latest release and ask.

### 6.4 Other launchers (optional, lower priority)

| Source | Instance root | Mapping notes |
|---|---|---|
| Prism / MultiMC (`~/Library/Application Support/PrismLauncher/instances/<x>`) | game dir = `<x>/.minecraft` or `<x>/minecraft` | `mmc-pack.json` components: `net.minecraft` → minecraft, `net.minecraftforge` → forge, `net.neoforged` → neoforge, `net.fabricmc.fabric-loader` → fabric, `net.quiltmc.quilt-loader` → quilt. In `instance.cfg`: `name`, `notes` → description, `JvmArgs` → jvmArgs, `MinMemAlloc`/`MaxMemAlloc` → memory (MB). `PreLaunchCommand`/`WrapperCommand` are used only when `OverrideCommands=true`. Instances with custom component patches (`patches/*.json` overriding `mainClass`/libraries) need a merged standalone version JSON, which is the installer spec's job. |
| Modrinth App (`~/Library/Application Support/ModrinthApp/profiles/<x>`; older builds used `com.modrinth.theseus`) | `<x>` | `profile.json`: `metadata.name`, `metadata.game_version`, `metadata.loader` + `metadata.loader_version.id`, `metadata.icon`, and `metadata.linked_data.{project_id,version_id}` → Modrinth upstream (validate the ids). Newer app versions keep this data in a SQLite `app.db` instead, so detect and read that, or report "unsupported version". |
| CurseForge app (`~/Documents/curseforge/minecraft/Instances/<x>`) | `<x>` | `minecraftinstance.json`: `name`, `baseModLoader`/`manifest.minecraft` → runtime, `projectID`+`fileID` → CurseForge upstream, `allocatedMemory` → **max** memory (the original mapped it to *min*), `lastPlayed`. |

Importing shared libraries and assets from these launchers follows §6.2's
no-overwrite rule.

## 7. Grouping and ordering (sidebar)

- Groups have an id, a name, a colour (hex) and an ordered member list. An
  instance belongs to at most one group.
- Drag-and-drop reorders instances and groups, and moves instances into or out
  of groups. Changes save `instances.json` (debounced to about 300 ms).
- Renaming or moving an instance (§5.3) rewrites its references in groups and
  order. Deleting an instance removes them, and an empty group remains until it
  is deleted explicitly.

## 8. Matching instance requirements to an installed version

### 8.1 Installed version summary

For each folder `<root>/versions/<id>/` that contains `<id>.json`, build a
summary by resolving the version (merging the `inheritsFrom` chain, parent
first). The summary has `{ id, minecraft, forge, neoforge, fabric, quilt,
optifine, inheritanceChain }`. Cache summaries and invalidate them by mtime.
Rebuild them when `versions/` changes (use an fs watcher).

Corrupt or missing JSON: leave the version out of the summary list and list it
under "broken versions" in the versions settings page.

### 8.2 Loader detection from a resolved version (public version-JSON facts)

- **minecraft**: the id at the root of the inheritance chain (the version
  without `inheritsFrom`). Prefer an explicit client version field if one is
  present.
- **forge**: a library with group `net.minecraftforge` and artifact `forge`,
  `fmlloader` or `minecraftforge`. Take its version and strip the Minecraft
  prefix and suffix (§8.3).
- **neoforge**: the value after `--fml.neoForgeVersion` in the game arguments.
  Otherwise, if any library has group `net.neoforged.fancymodloader` and the game
  arguments contain `--fml.forgeVersion <v>`, it is the 1.20.1 NeoForge fork,
  with version `<minecraft>-<v>`. Normalise both forms to the bare NeoForge
  version used in §3.2.
- **fabric**: library `net.fabricmc:fabric-loader:<v>`.
- **quilt**: library `org.quiltmc:quilt-loader:<v>`.
- **optifine**: library `optifine:OptiFine:<mc>_<edition>` (artifact name case
  varies: `OptiFine`/`Optifine`). The edition is the part after the first `_`.

### 8.3 Version-string normalisation

- Forge: compare the requirement `R` with the detected `D` after removing a
  leading `<mc>-` and a trailing `-<mc>` from `D`. If a `-` is still present,
  it matches when `R` equals either side of the first `-`. Otherwise it matches
  when `R == D`. Example: R=`10.13.4.1614`, D=`1.7.10-10.13.4.1614-1.7.10` →
  match.
- OptiFine: strip the `<mc>_` prefix from either side before comparing.
- Everything else: exact string equality.

### 8.4 Selection algorithm

Given the instance's `runtime` and optional `versionId`:

1. If `versionId` is set and installed, and its summary **satisfies** the
   runtime, use it.
2. Otherwise pick the first installed summary that satisfies the runtime, in a
   **deterministic** order: prefer an id equal to the expected generated id
   (`<mc>`, `<mc>-forge-<v>`, and so on, as the installer names them), then the
   most recently installed. The original's order was effectively the scan
   order.
3. "Satisfies" means `minecraft` is equal, and **for every loader slot**: if
   the requirement is non-empty, the summary has the same value (normalised);
   if the requirement is empty, the summary must **not** have that loader. (A
   vanilla requirement must never match a Fabric version.)
4. If nothing matches, the version is **not installed**. The UI shows "Install"
   instead of "Play" (or installs automatically when Play is pressed). After a
   successful install, set `versionId` to the resulting id.
5. If the pinned `versionId` exists but **doesn't** satisfy the runtime, ignore
   it for selection and show a non-blocking "Instance version mismatch" notice
   offering "Use requirements" (clear the pin) or "Adopt version" (rewrite
   `runtime` from the pinned version's summary). The original only logged this
   mismatch, and its UI path chose the pin by id without checking it against
   the runtime, so the UI and the launch path could disagree (see Pitfalls).
6. Before launching, check the picked version quickly (does the JSON parse, and
   are the client jar and libraries present?). If the check fails, run a repair
   install. Missing JSON at that point means the summary was stale: remove it
   and fall through to step 4.

Concurrency: if the instance's `runtime` or `versionId` changes while a
resolve or install is in flight, discard the result. Don't apply it to the
edited instance.

## 9. Renderer / IPC surface (behavioural)

Main-process operations: `list()` (returns a snapshot plus a change stream),
`create(opts)`, `edit(path, patch)`, `duplicate(path)`, `delete(path,
{keepFiles})`, `validatePath(path)`, `detectImport(folder)`,
`import(selection, mode)`, `setGroups(groups, order)`, `linkShared(path,
folder)`, `unlinkShared(path, folder)`, `resolveVersion(path)`.
Events: `added`, `edited(diff with null-for-removed)`, `moved(from,to)`,
`removed`, `taskProgress(kind, path, progress)`.

Renderer state must treat each instance object as **immutable**: replace the
object on every edit. The original mutated objects in place inside a
non-reactive wrapper, so deep watchers never fired and the UI went stale.

## 10. Apple Silicon notes relevant to instances

- Minecraft ≤ 1.18 ships LWJGL natives without macOS arm64 builds. Launching
  them natively needs arm64 replacements for the LWJGL natives (installer and
  launch specs). Otherwise it needs an x86_64 Java under Rosetta 2. The
  instance's `javaPath` validator should explain this when a user pins an x64
  Java for a modern version (it is unnecessary there and slower), or an arm64
  Java for an old version without native replacement.
- Java major version requirements still come from the version JSON
  (`javaVersion.majorVersion`). The instance override is only a pin.

---

## Pitfalls / bugs observed in the original

1. **Folder rename deferred to start-up.** Renaming an instance changed only
   the display name. The folder was renamed at the next launcher start, while
   instances were being loaded. Paths changed silently, and remembered selections
   or external references broke. The duplicate-name check also compared against a
   path built from the unsanitised name.
2. **macOS treated as case-sensitive.** Case-insensitive dedupe and
   case-only-rename handling ran only on Windows. On default APFS (which is
   case-insensitive), `Mods/Foo.jar` and `mods/foo.jar` collide. Instance
   folder names that differ only in case also collide.
3. **Wrong default `.minecraft` path on macOS** (`Application Support/.minecraft`
   instead of `Application Support/minecraft`).
4. **Vanilla profile import mapped `lastVersionId` straight to the Minecraft
   version**, so Fabric/Forge profiles became nonsense versions. `javaArgs`
   was split on single spaces, which broke quoted arguments.
5. **CurseForge-app import put `allocatedMemory` into the *minimum* memory
   field.**
6. **JVM and game arguments edited as one space-separated string** and split
   on spaces. Arguments containing quoted spaces were mangled.
7. **Auto memory only set `-Xms`**, leaving `-Xmx` at the JVM default. On large
   packs the JVM could refuse to start (initial heap larger than maximum heap).
8. **Reset-to-global didn't persist** for a long time: `undefined` doesn't
   survive Electron IPC. The fix was a `null` sentinel in both directions. Build
   that in from day one.
9. **Version-pin vs runtime disagreement**: the UI resolved the pinned id
   without checking it against the runtime, while the launch path did check.
   After a modpack update changed the loader, the UI could show the old version.
   A runtime/version mismatch was only logged, never surfaced.
10. **Duplicate followed symlinks** (shared `saves/`/`resourcepacks/` links were
    copied as real folders) and copied logs and crash reports. Early versions
    raised one error event per missing file.
11. **Delete raced with installs** (different locks), and remove handlers were
    held by weak references and garbage-collected mid-install. Deletion is
    permanent (no Trash), and moving saves to the shared folder happened
    silently.
12. **Lenient-but-lossy loading**: an `instance.json` that failed to parse
    dropped the instance from the list without telling the user. Missing
    external instances were pruned from the registry permanently.
13. **Placeholder name generation** appended suffixes cumulatively
    (`name-1-2-3`).
14. **Several loaders could be set at once**, and the installer then quietly
    picked one (OptiFine excluded Fabric/Quilt at install time).
15. **Snapshot comparison bug**: the original's snapshot-ordering helper used the
    first argument's suffix letter for both sides, so `24w14a` vs `24w14b`
    compared as equal. Write unit tests for version ordering.
16. **Icons referenced by absolute media URLs** in older data. They broke when
    instances moved, which was later fixed by storing relative paths. Store
    relative paths from the start.
