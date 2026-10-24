# Amethyst spec: resolving and launching a Minecraft version

Status: behavioural specification for a clean-room implementation. Target: macOS 13+ on Apple Silicon (arm64) only.

This document describes how the reference launcher (called "the original" below) turns a version id into a running Java process, and what Amethyst must do differently. It covers:

- resolving version JSON and the `inheritsFrom` chain;
- evaluating rules;
- libraries, natives and the classpath;
- argument templating;
- assets and the log4j configuration;
- spawning the process and watching it;
- detecting crashes;
- the Apple Silicon problem of old LWJGL natives.

Related specs: `install.md` (how the files get on disk), `java.md` (which JVM is chosen), `download.md` (the downloader).

Primary public references (verify against these, not against the original):

- Version JSON format: https://minecraft.wiki/w/Client.json
- Launching, arguments and legacy session format: https://minecraft.wiki/w/Tutorials/Launching (also the wiki.vg archive "Game files" and "Launching the game" pages at https://minecraft.wiki/w/Minecraft_Wiki:Projects/wiki.vg_merge)
- Version manifest: https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
- Asset index format and legacy/virtual assets: https://minecraft.wiki/w/Tutorials/Game_assets (see `virtual` and `map_to_resources`)
- Mojang log4j configuration files: these are referenced by `logging.client` in each version JSON, for example https://piston-data.mojang.com/v1/objects/bd65e7d2e3c237be76cfbef4c2405033d7f91521/client-1.12.xml
- LWJGL 3 natives layout and `SharedLibraryExtractPath`: https://www.lwjgl.org/guide and the javadoc of `org.lwjgl.system.Configuration`

---

## 1. Directory model

The original separates **shared resources** from **instance game directories**.

**Shared resource root** (`<root>`). This is a launcher-managed directory and can be relocated by the user. It contains:

| Path | Contents |
|---|---|
| `<root>/versions/<id>/<id>.json` | Version JSON. The directory name MUST equal `<id>`. |
| `<root>/versions/<id>/<id>.jar` | Client jar. In practice only present for vanilla ids; see §6. |
| `<root>/versions/<id>/<id>-natives/` | Extracted old-style natives (default natives directory). |
| `<root>/versions/<id>/install_profile.json` | Forge/NeoForge only. Used for repair. |
| `<root>/versions/<id>/.install-lock` | `{schemaVersion:1, version, timestamp}`. See `install.md`. |
| `<root>/versions/<id>/server.json` | Server profile. Server side is out of scope here. |
| `<root>/libraries/<maven path>` | Libraries. |
| `<root>/assets/indexes/<name>.json` | Asset indexes. The original stores them under the index **sha1** and creates an alias under the `assets` id. |
| `<root>/assets/objects/<hh>/<sha1>` | Asset objects (`hh` = the first two hex characters of the sha1). |
| `<root>/assets/virtual/<assets-id>/...` | Legacy virtual asset tree. |
| `<root>/assets/log_configs/<file id>` | log4j configuration XML. |

**Instance game directory** (`gameDir`). There is one per instance. It is the process cwd and `${game_directory}`. Saves, mods, config, `options.txt`, `logs/` and `crash-reports/` live here.

When an instance is created, the original symlinks `gameDir/libraries` and `gameDir/versions` to the shared ones. It renames a pre-existing real directory to `<name>.bk` (or `<name><epoch>.bk`) first. Some mods and old Forge builds look for `libraries/` relative to the game directory. Amethyst SHOULD keep this behaviour: macOS symlinks always work, so there is no Windows-style fallback to worry about.

For 1.4.x-based versions, the original additionally links a few loader cache folders into the game directory. See the Pitfalls section: that code is effectively dead.

---

## 2. Resolving a version id

### 2.1 Walking the chain

Input: a version id `V` and the root.

1. Read `<root>/versions/V/V.json`.
   - If the read fails, raise **MissingVersionJson** `{version, path}`. The original also attaches a listing of the files in that version directory, to help diagnosis.
2. Parse the JSON.
   - If it is invalid, raise **CorruptedVersionJson** `{version, json: <raw text>}`.
3. Normalise the file on its own (§2.2) and push it onto a list.
4. If the file has `inheritsFrom`, check that id against every id already in the list.
   - If it is already present, raise **CircularDependencies** `{version, chain: [...ids, offending id]}`.
   - Otherwise recurse into that id.

The result is the list `[leaf, ..., root]`. `inheritances` is the list of ids in that order. `pathChain` is the list of version directories in that order.

The `id` field inside a JSON file is trusted only for the parent lookups. The folder name is authoritative for which file to read.

### 2.2 Normalising a single file

The following happens per file, before merging.

**Libraries.** Each library is resolved against the platform (§3, §4). Libraries whose rules disallow it are dropped here, so they never reach the merge.

**Legacy arguments.** If the file has no `arguments` but has a `minecraftArguments` string, the file is "legacy":

- `game` arguments = `minecraftArguments` split on single spaces. Quoted values are not supported. Mojang's legacy strings never contain quotes.
- `jvm` arguments are synthesised to match what the vanilla launcher did for legacy versions:
  - a Windows-only heap-dump flag;
  - Windows-10-only `-Dos.name` and `-Dos.version`;
  - `-Djava.library.path=${natives_directory}`;
  - `-Dminecraft.launcher.brand=${launcher_name}`;
  - `-Dminecraft.launcher.version=${launcher_version}`;
  - `-cp`, `${classpath}`.

  On macOS only the last five survive. Legacy versions do **not** get `-XstartOnFirstThread`, which is correct: LWJGL 2 must not run with it.
- The file is marked **replace**: when merged, its argument lists replace (rather than append to) the lists accumulated from its parents. This is how a legacy Forge or OptiFine JSON can restate the full argument string, including `--tweakClass`.

**Modern arguments.** If the file has `arguments`, `jvm` and `game` are taken as given. Missing lists become empty.

**JVM argument pre-filter.** JVM arguments that are objects whose rules contain **no `features` key** are evaluated now against the platform (OS name, version and arch only). They are dropped if disallowed. Arguments with feature rules, and all game arguments, are kept for evaluation at launch time (§7.2).

### 2.3 Merging the chain

The merge processes files **from root to leaf**. A later (child) value overrides an earlier (parent) value.

| Field | Merge rule |
|---|---|
| `id` | The leaf's id (the requested id). |
| `minecraftVersion` | Taken from the **root** file: `clientVersion` if present (a third-party convention), else `_minecraftVersion` (another third-party convention), else the root's `id`. |
| `mainClass` | The last non-empty value. **BadVersionJson** `{missing: 'MainClass'}` if none. |
| `assets`, `assetIndex`, `type`, `releaseTime`, `time`, `javaVersion` | The last non-empty value. The default `javaVersion` is `{component: 'jre-legacy', majorVersion: 8}`. |
| `logging` | The last **present** value. An empty object `{}` counts as present. Modern Forge's `version.json` declares `"logging": {}` on purpose, to switch off the vanilla log4j config, because Forge ships its own. Amethyst MUST keep this: an empty child object disables the parent's config. |
| `compatibleJavaMajors` | The last defined value. This is a pack-supplied allow-list; see `java.md`. |
| `downloads` | Merged per key (`client`, `server`, `client_mappings`, ...). The child wins per key. |
| `minimumLauncherVersion` | The maximum. |
| `arguments.jvm`, `arguments.game` | Appended (parent first, then child), unless the child is "replace" (§2.2), in which case the child's lists replace the accumulated ones. |
| `libraries` | Deduplicated (§2.4). |
| `minecraftDirectory` | The root directory that the files were read from. |

### 2.4 Library de-duplication and order

- **Key.** The key is `groupId:artifactId`. If the library has a classifier, `-<classifier>;` is appended to the key.
  - The version is **not** part of the key. A child that declares a different version of the same artifact therefore replaces the parent's entry. This is required: Fabric, Forge and others ship newer ASM, Guava and so on than vanilla.
  - Old-style native entries are kept in a separate map from normal libraries.
- **Order.** The position of an entry is that of its **first** occurrence in the root-to-leaf walk; its value is that of its **last** occurrence. The final list is all normal libraries in that order, followed by all old-style natives.
- Amethyst MUST reproduce this key and the "child wins" rule. For ordering, Amethyst SHOULD keep the original's order: root libraries first, then child-only libraries. Mod loaders that need their libraries earlier on the classpath (LaunchWrapper-era Forge, for example) rely on de-duplication rather than on order.

---

## 3. Rule evaluation

Rules appear on libraries and on argument objects. Each rule is `{action: allow|disallow, os?: {name?, version?, arch?}, features?: {name: bool}}`.

The algorithm (it matches the vanilla launcher):

1. No `rules`, or an empty array, means **allowed**.
2. Otherwise start with **disallowed**. Walk the rules in order.
   - A rule *applies* if:
     - its `os` block (if any) matches;
     - **and** its `features` block (if any) matches.
   - When a rule applies, set the result to that rule's action. The last applicable rule wins.
3. **The `os` block** matches when all of the following hold:
   - `name` equals the platform name. On macOS this is `osx`. Mojang only uses `osx`, `windows` and `linux`.
   - `version`, if present, is a regex that matches the OS version.
   - `arch`, if present, equals the architecture. Mojang uses only `x86`, meaning a 32-bit x86 JVM.
4. **The `features` block** matches when every listed feature has the required truth value. A feature listed as `true` must be enabled. A feature listed as `false` must be disabled.

Platform inputs. These are differences that Amethyst MUST get right:

| Input | Original | Amethyst |
|---|---|---|
| `name` | `osx` | `osx` |
| `version` | The Darwin **kernel** release (`os.release()`, for example `23.4.0`). This is wrong: the vanilla launcher matches Java's `os.version` (the macOS product version, for example `10.5.8` or `14.4`). It only works by accident today, because the only macOS version rule is `^10\.5\.\d$`. | Use the macOS product version (`sw_vers -productVersion`). |
| `arch` | The **launcher process** arch (`arm64`). The rule value `x86` is mapped to Node's `ia32` before comparing. | Use the **selected JVM's** arch (`arm64` or `x86_64`, see `java.md`). Treat `x86` as matching only a 32-bit x86 JVM, which never happens on Apple Silicon. |

Mojang's `os.arch` vocabulary is currently only `x86`. Amethyst SHOULD also accept `arm64`/`aarch64` and `x86_64`/`amd64` (as aliases) for third-party JSON.

**Features** known in Mojang JSON:

- `is_demo_user`
- `has_custom_resolution`
- `has_quick_plays_support`
- `is_quick_play_singleplayer`
- `is_quick_play_multiplayer`
- `is_quick_play_realms`

A feature is "enabled" when the launcher sets it to `true`. In the original, a feature counts as enabled if its **key is present** in the features object, even when its value is `false`. Amethyst MUST use the value.

---

## 4. Resolving one library

The input is a library object from version JSON. The output is a resolved library: a maven coordinate split into `groupId`, `artifactId`, `version`, `classifier` and `type` (extension, default `jar`), plus a download `{path, url, sha1, size}`, a flag `isNative`, and an optional `extractExclude`.

### 4.1 Maven coordinates and paths

- The name format is `group:artifact:version[:classifier][@ext]`.
- The path is `group/with/slashes/artifact/version/artifact-version[-classifier].ext`.
- Snapshot versions (ending `-SNAPSHOT`) use the same path. The original does not resolve timestamped snapshot file names.
- The reverse (path → coordinate) is also needed by the installer. It takes the last three path segments as file, version and artifact; the rest is the group. The classifier is whatever lies between `artifact-version-` and the extension.

### 4.2 Cases, evaluated in this order

1. **Rules.** If `rules` disallow the library on this platform, drop it.
2. **Old-style natives** (the library has a `natives` map).
   - If `natives[platform.name]` (`natives.osx`) is absent, drop the library.
   - Otherwise take the classifier from that map. Replace `${arch}` inside it with the platform's bitness. Mojang only uses `${arch}` for Windows (`natives-windows-${arch}` → `32`/`64`). The original computes it as "arch string minus its first character", which yields `rm64` on arm64. That is harmless on macOS, but Amethyst MUST map it to `64`.
   - The download is `downloads.classifiers[classifier]` if present. Otherwise it is synthesised:
     - path from the coordinate `name:classifier`;
     - url `https://libraries.minecraft.net/<path>`;
     - sha1 empty;
     - size `-1`.
   - The resolved name is `name:classifier`, with `isNative = true`, and `extractExclude = extract.exclude`.
3. **Modern libraries** (the library has `downloads`).
   - If `downloads.artifact` is missing, the original throws "Corrupted library". It is better to drop the library with a warning, because some third-party JSON has classifier-only entries.
   - If the artifact has no `url`, default it:
     - for group `net.minecraftforge`, use `https://files.minecraftforge.net/maven/<path>`;
     - otherwise use `https://libraries.minecraft.net/<path>`.
     - Amethyst SHOULD use `https://maven.minecraftforge.net/` for Forge.
   - If the artifact has no `path`, use the maven path.
   - New-style natives (classifiers like `natives-macos`, `natives-macos-arm64`, `natives-macos-patch`) are **ordinary** libraries in this branch. They go on the classpath and are not extracted (§5.2).
4. **Legacy/maven-only libraries** (only `name`, optional `url`, `checksums`, `clientreq`, `serverreq`).
   - The URL is `(url or https://libraries.minecraft.net/) + path`.
   - sha1 is `checksums[0]`, or empty.
   - size is `-1`.
   - **Amethyst addition:** Fabric and Quilt meta emit this shape with top-level `sha1`, `sha256`, `size` and `md5` fields. The original ignores them, so Fabric libraries are never hash-checked. Amethyst MUST use `sha1` and `size` when present.

---

## 5. Natives

### 5.1 Old-style natives (LWJGL 2, LWJGL 3 before 3.3, jinput, objc-bridge, text2speech, twitch)

These are libraries with `isNative = true`. Their jars must be **extracted** into the natives directory. The JVM finds them through `-Djava.library.path=${natives_directory}`.

**Natives directory.** The default is `<root>/versions/<id>/<id>-natives`. It is keyed by the resolved (leaf) id, and the same directory is shared by every instance that uses that version.

**Extraction rules.** For every entry of every native jar:

- Skip directories.
- Skip entries whose path starts with any `extract.exclude` prefix (usually `META-INF/`).
- Skip any path containing `META-INF/`.
- Skip `*.sha1` and `*.git` files.
- **Platform sub-folder filter.** If the entry path contains `/`:
  - Keep it only if its first segment equals the platform name (`osx`) and its second segment equals the arch, with `ia32` mapped to `x86`.
  - Flat entries (no `/`) are always kept.
  - Note: LWJGL 3.3 jars use `macos/arm64/...`. Those entries would be rejected here, which is fine because they are never extracted (§5.2).
- Write the entry to `<natives>/<basename(entry)>`. Paths are **flattened** to the basename.

**Cache file.** `<natives>/.json` records:

- `libraries`: the sorted list of native library names;
- `entries`: a list of `{file, name, sha1}`, one per extracted file, where `name` is the library that produced it.

**On each launch:**

1. If `.json` exists and its library list equals the current one:
   - Verify each recorded file's sha1.
   - A library counts as "valid" if **any** of its files verify.
   - Re-extract only the libraries that are not valid.
2. Otherwise:
   - Extract everything.
   - Compute the sha1s.
   - Rewrite `.json`.

Extraction errors from several jars are combined into one aggregate error.

**Amethyst requirements:**

- Extract to a temp directory and rename it into place. Alternatively, hold a per-natives-directory lock: two instances that share a version can launch at the same time.
- A library is valid only if **all** of its files verify.
- Clear the directory when the library set changes, so stale x86 dylibs do not linger.
- Fail the launch on extraction errors. The original's middleware runner swallows them (Pitfalls).

### 5.2 New-style natives (LWJGL 3.3+, Minecraft 1.19 and later)

- Mojang lists `org.lwjgl:<module>:<v>:natives-macos` (x86_64) **and** `...:natives-macos-arm64` as separate libraries. Both carry the rule "allow on osx", with no arch condition.
- Both go on the **classpath**. LWJGL 3.3 picks `macos/<arch>/...` at run time and extracts it to `-Dorg.lwjgl.system.SharedLibraryExtractPath`. The vanilla JSON points that path at `${natives_directory}`. Since 26.x, Mojang uses sub-folders: `${natives_directory}/lwjgl`, `/jna`, `/netty` and `/java`.
- Nothing is extracted by the launcher, but the natives directory must exist and be writable.
- Some versions ship odd classifiers. For example, 1.21.4 has `lwjgl-freetype:...:natives-macos-patch` and no plain `natives-macos`. Treat them like any other classpath jar.

---

## 6. Classpath

The classpath is built in this order:

1. Every resolved library with `isNative = false`, in merged order (§2.4), as `<root>/libraries/<download.path>`.
2. The client jar of the **root** Minecraft version: `<root>/versions/<minecraftVersion>/<minecraftVersion>.jar`.
3. Any extra classpath entries the caller supplies (none in normal use).

Entries are joined with `:`.

Notes:

- **The root's jar, not the leaf's.** Loader versions (for example `1.20.1-forge-47.3.0`) have no jar of their own. The vanilla launcher would copy the parent jar into `versions/<leaf>/<leaf>.jar`, but the original does not.
  - Because of this, the JVM template `${version_name}` is set to `minecraftVersion` (§7.3). Forge 1.17+ passes `-DignoreList=...,${version_name}.jar` to hide the vanilla jar from its module layer. That filter only matches if `${version_name}.jar` equals the basename of the jar actually on the classpath.
  - Amethyst MUST keep these two choices consistent.
- **The `jar` field is ignored.** If a third-party JSON names a different jar via `jar`, the original ignores it.
- **Missing download paths.** Before launch, every non-native library with no `download.path` is given its maven path. If that is also empty, the launch fails with `launchBadVersion`.
- **No classpath de-duplication.** Because of §2.4, the same file can appear twice only if two coordinates map to the same path. That does not happen in practice.

---

## 7. Command line

### 7.1 Exact order of the original (client)

1. `java` executable.
   - On Windows, `javaw` is preferred if it is executable. On macOS no `javaw` exists, so this is always `java`.
2. macOS only:
   - `-Xdock:name=<gameName>`, where `gameName` is "Minecraft" by default;
   - `-Xdock:icon=<path>` if an icon was found.
   - The original looks up `icons/minecraft.icns` or `minecraft/icons/minecraft.icns` at the **top level** of the asset index JSON instead of under `objects`, so it never finds one (Pitfalls). Amethyst MUST look under `objects` and pass `assets/objects/<hh>/<hash>`.
3. `-Xms<min>M`, `-Xmx<max>M`, each only if set (§11.3).
4. *(Optional Forge flags `-Dfml.ignoreInvalidMinecraftCertificates=true` and `-Dfml.ignorePatchDiscrepancies=true`. The original never sets them from the UI.)*
5. Version JVM arguments: rules evaluated (§3) and templated (§7.3).
   - The log4j argument (§9) is appended at the end of this group.
6. `-DlibraryDirectory=<root>/libraries`, unless some earlier argument already starts with `-DlibraryDirectory`. Forge 1.17+ declares it itself.
7. The user's extra JVM arguments.
   - If the user supplied **no list at all**, the original adds a default list: `-Xmx2G` (dropped if a max memory was set), `-XX:+UnlockExperimentalVMOptions`, `-XX:+UseG1GC`, `-XX:G1NewSizePercent=20`, `-XX:G1ReservePercent=20`, `-XX:MaxGCPauseMillis=50`, `-XX:G1HeapRegionSize=32M`.
   - If the user supplied an **empty list**, nothing is added. The UI always supplies a list, so in practice the defaults never apply.
8. `mainClass`.
9. Version game arguments, rules evaluated and templated.
10. The user's extra game arguments.
11. Quick play and server arguments (§7.4).
12. Resolution (§7.5).
13. `--demo` if the account has no id, no selected profile and no username.
14. A *string* "prepend command" is **appended at the end**. This bug is reachable only through the library API. The app always passes an array (§11.1), which is correctly put before the java executable.

User JVM arguments come after the version's `-cp <classpath>`. That is legal: the JVM treats everything before the main class as options, and a later `-Xmx` overrides an earlier one.

### 7.2 Evaluating argument entries

- **A string entry** is kept as is.
- **An object entry `{rules, value}`** is evaluated with §3 against the platform and the enabled features.
  - If allowed, `value` is added. `value` may be a string or a list of strings; a list is spliced in.
  - If disallowed, the entry is dropped.
- **Features.** The original passes **no features at all** at run time. Every feature-gated argument (`--demo`, `--width/--height`, the `--quickPlay*` arguments) is therefore dropped, and the equivalent arguments are appended manually (§7.4, §7.5).
- **Amethyst.** Amethyst SHOULD instead set the features properly and let the JSON place the arguments:
  - `has_custom_resolution` when a resolution is configured;
  - `is_demo_user` for demo accounts;
  - `has_quick_plays_support` plus the specific `is_quick_play_*` feature when a quick-play target is given.

  Append arguments manually only for versions whose JSON lacks the feature-gated entry (for example, `--server`/`--port` on versions before 1.20).

### 7.3 Template substitution

Every `${name}` occurrence inside an argument string is replaced. In the original:

- The match is lazy, so a single argument can contain several placeholders.
- If the value is missing **or falsy** (empty string, 0), the placeholder is left **verbatim**.
- JVM arguments and game arguments use **two different tables**. A JVM argument that mentions a game variable stays literal, and the reverse.

Amethyst MUST use one table for both, and handle unknown or empty variables as described below.

| Variable | Used in | Value (original) | Amethyst notes |
|---|---|---|---|
| `natives_directory` | jvm | Natives dir (§5.1) | Ensure the sub-folders (`java`, `jna`, `lwjgl`, `netty`) can be created. Pre-create them for 26.x. |
| `launcher_name` | jvm | `XMCL (<appVersion>)` (or a user override) | `Amethyst` |
| `launcher_version` | jvm | Same string as the name (or a user override) | The app version. |
| `classpath` | jvm | §6 | |
| `classpath_separator` | jvm | `:` | |
| `library_directory` | jvm | `<root>/libraries` | Forge/NeoForge `-p` module path uses it. |
| `version_name` | jvm | **`minecraftVersion`** (§6) | Keep (jar basename). |
| `version_name` | game | The leaf `id`, or a user "version name" override | Note the different value from jvm. Keep. |
| `game_directory` | both | Absolute `gameDir` | |
| `assets_root` | game | `<root>/assets` | |
| `game_assets` | game | `<root>/assets/virtual/<assets id>` | Used by ≤1.6 versions (§8). |
| `assets_index_name` | game | The asset index **sha1** (the original stores indexes by hash), falling back to the `assets` id | Either works as long as `assets/indexes/<value>.json` exists. Hash naming avoids collisions when Mojang re-publishes an index under the same id. |
| `auth_player_name` | game | Profile name, default `Steve` | |
| `auth_uuid` | game | Profile id (no dashes). Random if absent. | |
| `auth_access_token` | game | Token. A random UUID without dashes if absent. | |
| `auth_session` | game | Same as the access token | Pre-1.7 versions expect `token:<accessToken>:<uuid>` for online play (see minecraft.wiki "Launching"). Amethyst SHOULD use that form for online accounts and the bare token for offline. |
| `user_type` | game | Always `msa` | `msa` for Microsoft accounts, `legacy` for offline. |
| `user_properties` | game | `{}` | Must be the JSON `{}`. 1.7.x crashes on an empty string. |
| `version_type` | game | The merged `type` (or a user override) | |
| `resolution_width`, `resolution_height` | game | `-1` unless a resolution is given | |
| `clientid` | game | **not provided** → the literal `${clientid}` reaches the game | See below. |
| `auth_xuid` | game | **not provided** → literal | See below. |
| `quickPlayPath`, `quickPlaySingleplayer`, `quickPlayMultiplayer`, `quickPlayRealms` | game | not provided (the arguments are dropped with their features) | Fill them when the feature is enabled. |
| `path` | logging argument | Absolute path of the log config | §9. |

**Unknown or empty values (Amethyst).** If a placeholder resolves to nothing and the argument consists only of that placeholder, and the previous argument is a `--flag`, drop **both**. Apply this to `clientid`, `auth_xuid`, `quickPlayPath` and the `quickPlay*` variables. Otherwise leave the text as is and log a warning. Never pass a literal `${...}` to the game for a known variable.

### 7.4 Quick play and direct connect (original)

**Server.** If a server `{host, port}` is given, the original appends **both**:

- `--quickPlayMultiplayer host[:port]`;
- `--server host` and, if a port is given, `--port <port>`.

Older versions ignore the unknown `--quickPlay*` option, because Minecraft's option parser accepts unrecognised options. 1.20+ receives both styles.

**World.** If a world (save folder name) is given, the original appends `--quickPlaySingleplayer <folder>`. Versions before 1.20 ignore it silently.

**Amethyst:**

- 1.20+ (feature present in the JSON): use only quick play.
- Before 1.20: use only `--server`/`--port`.
- Hide "launch into world" for versions without quick-play support.

### 7.5 Resolution (original)

If a resolution is configured and no `--width` is already present on the command line:

- `--fullscreen` if fullscreen is set;
- otherwise `--height H`, then `--width W` (each only if set).

---

## 8. Assets at launch time

- **Index naming.** The installer writes the index as `assets/indexes/<sha1>.json` and links (hard links) `<assets id>.json` to it. On startup, the version list scan also creates the `<sha1>.json` alias if only `<id>.json` exists.
- **Virtual (legacy) assets.** If `assets` is `legacy` or starts with `pre-`:
  1. Read `assets/indexes/<assets>.json`.
  2. For each object `name → {hash}`, hard-link `assets/objects/<hh>/<hash>` to `assets/virtual/<assets>/<name>`.
  3. Create parent directories as needed. An existing target (`EEXIST`) is fine.
  - This runs before every launch. `${game_assets}` points to `assets/virtual/<assets>`.
  - Public format: the `legacy` index has `"virtual": true`; `pre-1.6` has `"map_to_resources": true`.
- **`map_to_resources`** (pre-1.6). The vanilla launcher copies the objects into `<gameDir>/resources/<name>`. The original does **not** do this; it only builds `virtual/pre-1.6`. Amethyst SHOULD honour `map_to_resources` by populating `<gameDir>/resources` as well, with hard links or clones. Verify by launching b1.7.3 and 1.5.2 with sound.
- **Hard links** require the assets directory and the virtual tree to be on the same volume. They always are under `<root>`. On APFS, Amethyst MAY use `clonefile` instead.
- **Before launch the original does NOT verify assets** (that check is commented out). Verification happens in the install/repair step that runs before each launch (see `install.md`, "Pre-launch diagnose").

---

## 9. log4j configuration

If the merged version has `logging.client`:

1. The file `assets/log_configs/<logging.client.file.id>` is downloaded by the installer, with a sha1 check.
2. At launch, **if that file exists**, `logging.client.argument` (for example `-Dlog4j.configurationFile=${path}`) is templated with `${path}` = the absolute file path and appended after the version JVM arguments.
3. If the file is missing, the argument is silently skipped.

Why it matters:

- These Mojang configs (`client-1.7.xml`, `client-1.12.xml`, `client-1.21.2.xml`) are the official Log4Shell (CVE-2021-44228) mitigation for 1.7–1.18. They either filter `${...}` messages or use `%msg{nolookups}`.
- They also switch the console appender to an XML layout (`<log4j:Event ...><log4j:Message><![CDATA[...]]></log4j:Message></log4j:Event>`), which is what the launcher sees on stdout.
- They write `logs/latest.log` relative to the cwd, which is why the cwd must be `gameDir`.

Amethyst requirements:

- If `logging.client` is declared but the file is missing or invalid, re-download it before launch. Never launch silently without it.
- For versions 1.7–1.18.0 whose merged `logging` is absent or empty (some third-party JSON, and modern Forge, which disables it on purpose), add `-Dlog4j2.formatMsgNoLookups=true`. This is harmless for log4j ≥ 2.10. For older log4j it does nothing; mention that in logs.
- Parse the XML event stream from stdout into structured log lines (level, logger, thread, time, message, throwable). Fall back to raw text for versions or loaders that print plain text.

---

## 10. Pre-launch pipeline (original order)

The UI's launch command (`instance.launch`) does the following:

1. **Install/repair.** Ask the installer to make the instance's version complete (`install.md` §"Instance install entry point"). This diagnoses, using the install timestamp to skip hashing unchanged files, and repairs only what is broken. The result is the concrete version id.
2. **Race check.** Re-read the instance. If its version or runtime changed meanwhile, abort with "Instance changed while preparing launch". If the installer chose a different id, persist it.
3. **Resolve the version** (§2), then run the **post-resolve hooks**. The only relevant hook is the native replacer (§12).
4. **Refresh the account** (a token refresh). Failures are logged, not fatal.
5. **Choose Java** (`java.md` §6).
6. **Build launch options** from instance and global settings (§11.3).
7. **Launch service:**
   1. Resolve the version again (with hooks).
      - If that fails: `launchNoVersionInstalled`.
   2. Check the Java path.
      - If it is empty: `launchNoProperJava`.
   3. Run the **pre-launch command** if configured (§11.2).
   4. Get the access token from secure storage (failures ignored).
   5. Run the middlewares, in registration order:
      1. `java-validation`: re-probe the Java and possibly reinstall it (`java.md` §6.4). This is the only middleware whose failure always aborts.
      2. `check-assets`: fill in missing library `download.path` (§6). The asset check itself is disabled.
      3. `check-natives`: extract natives (§5.1).
      4. *(server exposure: out of scope)*
      5. `link-assets`: virtual assets (§8).
      6. `sync-language`: if enabled, write `lang:<code>` into `gameDir/options.txt`, creating it if missing. The original maps the UI locale to a Minecraft language code; i18n is out of scope.
      7. *(resource-pack and shader-pack linking into the instance: covered by the instances spec, not here)*

      Each middleware's exception is **logged and swallowed** unless it is a `LaunchException`. Amethyst MUST fail the launch on natives, assets or link errors.
   6. Spawn (§11).

---

## 11. Spawning the process

### 11.1 Process parameters (original)

- **Command:** `argv[0]` = java path, then the arguments of §7.
- **Prepend command.** If the user configured one (a wrapper such as `gamemoderun`; on macOS for example `caffeinate -i`), the string is split shell-style: whitespace separates words; `"..."` and `'...'` group them; no escapes. The words are put before the java path.
- **Shell.** When a prepend command is present, the original spawns with `shell: true` and wraps **every** argument in double quotes, with no escaping. Pitfalls: `$`, backticks and `"` inside arguments are interpreted by `/bin/sh`.
- **cwd:** `gameDir`. It is created if missing.
- **env:** the launcher's full environment, plus the global env settings, plus the per-instance env. Instance settings override global ones.
- **detached: true.** The game gets its own process group and survives the launcher quitting. The launcher also calls `unref()` so it does not wait for the child.
- **stdio:** stdout and stderr are piped; stdin is a pipe (it is only used for servers).
- **Output decoding.** The first output chunk is passed to an encoding detector. All later chunks are decoded with the detected encoding (UTF-8 if unsure). On macOS the output is effectively always UTF-8.

**Amethyst requirements:**

- **Never use a shell.**
  - Resolve the prepend command's argv yourself.
  - Spawn `[...prepend, java, ...args]` directly with `execvp` semantics.
  - Use `$PATH` from a login-shell probe (Finder-launched apps have a minimal `PATH`).
- **Sanitise the environment.** Remove `ELECTRON_*`, `NODE_OPTIONS`, `DYLD_*` and `JAVA_TOOL_OPTIONS`/`_JAVA_OPTIONS`. If the user set the `JAVA_*` variables explicitly in instance env, keep them but show them in the launch log.
- Keep `detached` and the separate process group. Record the pgid so a force kill can signal the whole group.
- Write the full command line to the launch log with the access token (and any `--accessToken` value) **redacted**. The original redacts only the `accessToken` field of its options dump.

### 11.2 Pre-launch command

The pre-launch command is an optional user string.

- The original runs it with `shell: true` and `cwd = gameDir`, and waits for it to exit.
- Its stdout and stderr go to the launcher log.
- If it exits non-zero, the launch aborts with `launchPreExecuteCommandFailed`, which includes the stderr.
- It has no timeout.

Amethyst MAY keep the shell here, since the command is explicitly user-authored. It SHOULD add a timeout that the user can cancel.

### 11.3 Memory and JVM options (original UI logic)

Settings are per instance, falling back to global.

`assignMemory` has three modes:

- **`true`**:
  - `-Xms` is set to `minMemory` if it is > 0.
  - `-Xmx` is set to `maxMemory` if it is > 0.
- **`'auto'`**:
  - `-Xms` = 1024 + 1024 × floor(mods / 25), plus 512 if the fractional part of mods/25 is > 0.5. With 0 mods it is 1024.
  - **No `-Xmx`**, so the JVM default applies (¼ of physical RAM). See Pitfalls.
- **otherwise**: neither flag is set.

Other options:

- `vmOptions` and `mcOptions` are string lists. Empty strings are filtered out.
- `env` comes from global settings merged with the instance's.

Amethyst: the "auto" mode SHOULD set `-Xmx` from physical RAM and mod count, and SHOULD set `-Xms` ≤ `-Xmx`. Validate that `Xms ≤ Xmx` before spawning.

### 11.4 Detecting spawn failure

The child counts as not started if it has no pid after `spawn`. The original then waits up to 1 s for an `error` event:

| Error | Mapped to |
|---|---|
| `ENOENT` from spawn | `launchInvalidJavaPath` |
| `EPERM` thrown synchronously | `launchJavaNoPermission` |
| anything else (`name` set to `LaunchSpawnProcessError`) | rethrown |
| no error after 1 s | `launchSpawnProcessFailed` |

---

## 12. Apple Silicon: old LWJGL natives

### 12.1 The problem

Minecraft versions before 1.19 ship macOS natives built for **x86_64 only**:

- LWJGL 2 `lwjgl-platform` (`liblwjgl.dylib`, `openal.dylib`);
- LWJGL 3.1.6 and 3.2.1 `natives-macos`;
- jinput (`libjinput-osx.jnilib`);
- `java-objc-bridge` 1.0.0 (`libjcocoa.dylib`);
- twitch.

An arm64 JVM cannot load them. The game dies early with `UnsatisfiedLinkError ... (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))`.

There are two ways out:

- run an **x86_64 JVM under Rosetta 2**, which uses the original natives;
- keep an **arm64 JVM** and **substitute arm64 builds** of the native libraries.

The original does the second.

### 12.2 What the original does

There is a post-resolve hook, controlled by the setting `replaceNatives`:

| Value | Meaning |
|---|---|
| `'legacy-only'` (default) | Replace only for "legacy" versions. |
| `'all'` | Apply to all versions. |
| `false` | Off. |

**Trigger:**

- The hook runs only when the **launcher process** is darwin + arm64. It does not check which JVM was chosen.
- A version is "legacy" when `parseInt(minecraftVersion.split('.')[1]) < 19`. With `'all'`, every version qualifies.

**Procedure.** For each library of the resolved version, in place, keeping its position:

1. **Lookup key:**
   - for a native library: `group:artifact:version:natives`;
   - otherwise: its full maven name.
2. Look the key up in a static table: the `osx-arm64` section of a data file taken from HMCL's `natives.json` (HMCL is GPL-3.0; the original ships that file with its GPL licence).
3. If the table entry is a library object, resolve it with the normal rules (§4) for platform `osx`/`arm64` and **replace** the original library with the result.
4. If the entry is `null` or the key is absent, keep the original library unchanged. In HMCL, `null` means "remove the library"; the original misreads it (Pitfalls).

**The `osx-arm64` table covers exactly these keys:**

| Original library (key) | Replacement | Where it ends up |
|---|---|---|
| `org.lwjgl.lwjgl:lwjgl-platform:2.9.1-nightly-20130708-debug3:natives`, `…:2.9.1:natives`, `…:2.9.2-nightly-20140822:natives` | `org.glavo.hmcl:lwjgl2-natives:2.9.3-rc1` with `natives.osx = "osx-arm64"`, `extract.exclude = ["META-INF/"]` | Native, extracted. The jar holds flat `liblwjgl.dylib` and `openal.dylib` (arm64). Download URL: `https://repo1.maven.org/maven2/org/glavo/hmcl/lwjgl2-natives/2.9.3-rc1-osx-arm64/lwjgl2-natives-2.9.3-rc1-osx-arm64.jar`. On Maven Central the *version* is `2.9.3-rc1-osx-arm64`; the local path uses `2.9.3-rc1/…-osx-arm64.jar`. |
| `org.lwjgl:{lwjgl,lwjgl-jemalloc,lwjgl-openal,lwjgl-opengl,lwjgl-stb,lwjgl-tinyfd}:{3.1.6,3.2.1}` (Java jars) | The same artifacts at `3.3.1` from Maven Central | Classpath |
| `org.lwjgl:lwjgl-glfw:{3.1.6,3.2.1}` | `org.glavo.hmcl.mmachina:lwjgl-glfw:3.3.1-mmachina.1` (a patched GLFW binding, Maven Central) | Classpath |
| `org.lwjgl:<each of the above>:{3.1.6,3.2.1}:natives` | `org.lwjgl:<artifact>:3.3.1:natives-macos-arm64` from `libraries.minecraft.net` | **Classpath** (not extracted): LWJGL 3.3 self-extracts |
| `ca.weblite:java-objc-bridge:1.0.0` | `org.glavo.hmcl.mmachina:java-objc-bridge:1.1.0-mmachina.1` | Classpath |
| `ca.weblite:java-objc-bridge:1.0.0:natives` | `null` (intended: remove) | Original keeps the x86 natives |
| `com.mojang:text2speech:1.10.3` | `com.mojang:text2speech:1.11.3` | Classpath |
| `com.mojang:text2speech:{1.10.3,1.11.3,1.12.4}:natives`, `net.java.jinput:jinput-platform:2.0.5:natives` | `null` | Original keeps them |

All replacement artifacts are downloaded by the normal library install path, with sha1s taken from the table.

**Which Mojang versions this fixes, per the macOS rules in the vanilla JSON:**

| Minecraft | macOS LWJGL in vanilla JSON | Covered by original? |
|---|---|---|
| ≤ 1.6.4 (all `pre-1.6`/`legacy` versions, including alpha, beta and classic) | `lwjgl-platform` **2.9.0** (2.9.1-nightly-…-debug3 only on macOS 10.5) | **No**: 2.9.0 is not in the table. These versions crash on an arm64 JVM. |
| 1.7.x | 2.9.1 | Yes |
| 1.8–1.12.2 | 2.9.2-nightly-20140822 (2.9.4-nightly is disallowed on osx) | Yes |
| 1.13–1.13.2 | 3.1.6 | Yes |
| 1.14–1.18.2 | 3.2.1 (3.2.2 is disallowed on osx) | Yes |
| 1.19+, 26.x | 3.3.1+ with official `natives-macos-arm64` | Not needed |

Snapshots and third-party JSON that use other LWJGL versions (for example 3.2.2 or 3.3.0, or MultiMC/Prism component JSON) are not covered.

### 12.3 What Amethyst must do (robust approach)

1. **Decide per launch, from the JVM.** Read the selected JVM's real architecture (`java.md` §3). Rule evaluation and replacement both use the JVM arch, not the launcher's.
   - With an **x86_64 JVM** (Rosetta), do **not** replace anything. Evaluate rules with arch `x86_64`. Warn the user that the game runs translated.
   - With an **arm64 JVM**, apply the replacement below. This is the default, since `java.md` installs arm64 runtimes, including Zulu 8.
2. **Match by family and version range, not by exact strings:**
   - **LWJGL 2:** any `org.lwjgl.lwjgl:lwjgl-platform:*` native. Replace with an arm64 LWJGL 2 natives jar.
     - Include **2.9.0**, so that all versions ≤ 1.6.4 are covered.
     - Keep the `org.lwjgl.lwjgl:lwjgl`/`lwjgl_util` Java jars as they are.
     - Verify that the 2.9.3-based natives load with 2.9.0/2.9.1 Java classes (JNI symbol compatibility) by launching 1.5.2, 1.6.4 and 1.7.10. If 2.9.0 fails, also replace the Java jars with the matching 2.9.3 build.
   - **LWJGL 3 before 3.3.0:** for every `org.lwjgl:*` module, upgrade the Java jar to a single 3.3.x version.
     - Use 3.3.1 to match the tested HMCL set; it is the earliest release with official macOS arm64 natives. Use the patched GLFW build for `lwjgl-glfw`.
     - Replace each old native entry with the `natives-macos-arm64` classifier jar **on the classpath**.
     - Remove the old `natives-macos` (x86) entries entirely.
     - Make sure `-XstartOnFirstThread` is present. It is, because 1.13+ JSON has it.
   - **`ca.weblite:java-objc-bridge` before 1.1:** upgrade it, and **remove** its old natives entry.
   - **`net.java.jinput:jinput-platform` natives:** remove them. Controller support is optional, and LWJGL 2 only loads jinput when a game creates controllers. If that is wrong for some version, the failure is non-fatal: LWJGL logs it.
   - **`com.mojang:text2speech` natives:** remove them. On macOS the narrator goes through the objc bridge. Upgrade 1.10.3 to 1.11.3.
   - **`tv.twitch:twitch-platform` / `twitch-external-platform` natives (1.7–1.8):** remove them. There is no arm64 build, and the Twitch service is defunct.
   - Treat a `null` table value as **remove**.
3. **Data source.** Build the table yourself from public Maven artifacts. HMCL's `natives.json` (GPL-3.0, compatible with Amethyst's licence) MAY be used as input, but take it from upstream HMCL, not from the original.
   - Store the table as versioned data with sha1 and size for every artifact.
   - Verify the sha1s against the Maven `.sha1` sidecars when building the table.
4. **Natives directory isolation.** Use a natives directory keyed by `(version id, jvm arch, replacement table version)`, for example `versions/<id>/<id>-natives-arm64`. Switching between Rosetta and native JVMs, or toggling the setting, must never mix dylibs.
5. **The toggle stays.** Keep the setting (on by default, "pre-1.19 only"). It acts as an escape hatch. If a user turns it off with an arm64 JVM selected, warn that pre-1.19 versions will not start.
6. **Diagnostics.** If the game exits early and stderr/stdout matches `incompatible architecture` or `UnsatisfiedLinkError`, show a targeted message:
   - "This version needs Apple Silicon natives; enable replacement", or
   - "choose an arm64 Java".
7. **Test matrix** (all on an arm64 JVM): b1.7.3, 1.5.2, 1.6.4, 1.7.10, 1.8.9, 1.12.2, 1.12.2 Forge, 1.13.2, 1.16.5 (+ Forge, + Fabric), 1.18.2, 1.19, 1.20.1, 1.21.x, latest 26.x. For each, check the window, sound (OpenAL), text input, fullscreen toggle and narrator.

---

## 13. Watching the process

### 13.1 Events (original)

| Event | Payload | When |
|---|---|---|
| `minecraft-start` | pid, launchId (a new UUID), operationId, minecraft version, all options, startTime | Immediately after spawn |
| `minecraft-stdout` / `minecraft-stderr` | pid, decoded text chunk | Per chunk |
| `minecraft-window-ready` | pid, launchId | Fired once, when "ready" text is seen (§13.2) |
| `minecraft-exit` | code, signal, crashReport, crashReportLocation, duration, errorLog (all stderr lines), stdLog (stdout lines seen before "ready") | On exit |

The original also keeps:

- an in-memory map `pid → {options, process, side, ready, launchId, gameLogAmbiguous}`;
- a persistent **launch history** per game directory: begin, ready and complete records with exit code, crash flags, log paths, and the last 1 MiB of combined output prefixed `[stdout]`/`[stderr]`.

If two running processes share the same `gameDir`, both are marked `gameLogAmbiguous`, and log files are then not attributed to either.

### 13.2 "Window ready" heuristic (original)

Any stdout chunk containing one of the following marks the window as ready (once):

- `Missing metadata in pack`
- `Registering resource reload listener`
- `Reloading ResourceManager`
- `LWJGL Version: `
- `OpenAL initialized.`
- ` Preparing level `

Matching is per **raw chunk**, so a marker split across two chunks is missed. Amethyst MUST match per **line** (or per parsed log4j event). As a fallback, it SHOULD mark the game ready when the process has been alive for N seconds and has created `logs/latest.log`.

### 13.3 Crash detection and location (original)

The original scans **stdout chunks**:

- A chunk containing `---- Minecraft Crash Report ----` sets `crashReport` to **that chunk** (not the whole report).
- A chunk containing `Crash report saved to:` sets `crashReportLocation`.
  - Minecraft prints `#@!@# Game crashed! Crash report saved to: #@!@# <path>`. The path is the text after the second marker, with the newline removed and trimmed.
- A chunk containing `Crash report saved to ` (no colon; older versions) is treated the same way.
- A chunk containing `Failed to start the minecraft server` sets `crashReport` (server side).

On exit:

- If `crashReport` is set and the code is 0, the code is forced to 1.
- `crashReportLocation` is cut after the last `.txt`.
- The run is "crashed" if the code ≠ 0, or a report was seen, or a location was seen.
- `logs/latest.log` and `logs/debug.log` are attributed to the run if their mtime lies in `[start, end + 2 s]` and the log is not ambiguous.

Where crash artefacts are on disk:

- `gameDir/crash-reports/crash-<yyyy-MM-dd_HH.mm.ss>-client.txt` is the vanilla crash report. Forge and Fabric write to the same folder; Fabric may also write `crash-reports/crash-...-fml.txt`-style files.
- `gameDir/hs_err_pid<pid>.log` is the **JVM native crash**. The cwd is `gameDir`, so it lands there. This is very relevant to the Apple Silicon natives problem. The original never looks for it.
- `gameDir/logs/latest.log` and `debug.log` (newer versions) are the logs.

**Amethyst requirements:**

- Line-buffer both streams.
- Capture the whole crash report: from the header line to the end of the report block, or simply read the saved file once its path is known.
- On a non-zero exit with no report path, look for the newest `crash-reports/*.txt` with mtime ≥ start, and for `hs_err_pid<pid>.log`.
- Treat signals as crashes:
  - `SIGKILL` that Amethyst sent is "killed by user", not a crash;
  - `SIGABRT` or `SIGSEGV` is a native crash.

### 13.4 Stopping the game (original)

- **Normal stop:** `SIGTERM` to the child process.
- **Force stop:** `SIGKILL` to the child pid only.
- **Servers:** they get `/stop\n` on stdin when ready. Out of scope.

Amethyst: force stop SHOULD signal the whole process group, since the child was spawned detached. This covers wrapper commands such as `caffeinate`, which would otherwise keep the game alive.

---

## 14. Errors surfaced to the UI (original names; keep the semantics)

| Error | Meaning |
|---|---|
| `launchNoVersionInstalled` | The version cannot be resolved. |
| `launchNoProperJava` | No Java was given, or the JVM cannot start. |
| `launchInvalidJavaPath` | The java executable does not exist. |
| `launchJavaNoPermission` | The java executable is not executable. |
| `launchBadVersion` | A library has no path. |
| `launchPreExecuteCommandFailed` | The pre-launch command failed. |
| `launchSpawnProcessFailed` | The child was not created. |
| `LaunchGeneralError` | Any other launch failure (generic error renamed). |
| `MissingVersionJson`, `CorruptedVersionJson`, `BadVersionJson`, `CircularDependencies` | Resolution errors (§2). |

---

## 15. Pitfalls / bugs observed in the original

1. **Arch comes from the launcher process, not the JVM.** Rule evaluation (§3) and the native replacer (§12.2) both use the launcher's arch.
   - If the user picks an x86_64 JVM (an old Mojang `jre-legacy` or a Homebrew x64 JDK), the replacer still swaps in arm64 dylibs and the game crashes.
   - Conversely, a Rosetta-translated launcher would never replace anything.
2. **LWJGL 2.9.0 is missing from the arm64 table.** Every version ≤ 1.6.4 fails on an arm64 JVM, including all alpha, beta and classic versions.
3. **A `null` replacement is treated as "keep".** HMCL's meaning is "remove". So x86-only jinput, objc-bridge and text2speech natives are still extracted on arm64. This is mostly harmless today, but `libjcocoa.dylib` (x86) sits on `java.library.path` next to an objc-bridge 1.1 jar, and that is fragile.
4. **"Legacy" means `minor < 19` of the second version component.** For year-based versions (`26.1` → minor `1`), every new version counts as legacy. That is harmless only because no 26.x library is in the table. Snapshot ids (`24w14a`) parse as `NaN`, so they are never legacy, even when they use LWJGL 3.2.
5. **The OS version rule uses the Darwin kernel release** instead of the macOS product version (§3). It is correct today only by accident.
6. **Feature flags count by key presence.** A feature given as `false` still counts as enabled. At run time no features are passed at all, so the JSON-driven `--width`, `--demo` and `--quickPlay*` are always dropped and re-added by hand. Both `--server` and `--quickPlayMultiplayer` are passed.
7. **Templating leaves unknown variables literal.** `${clientid}` and `${auth_xuid}` reach the game as literal text. Falsy values (an empty string, `0`) also stay literal. JVM and game variables live in separate tables.
8. **Dock icon lookup reads the wrong JSON level**, so `-Xdock:icon` is never passed and the Dock shows the generic Java icon.
9. **Natives cache weaknesses:**
   - a library is "valid" if any one of its files verifies;
   - nothing is cleaned when the library set changes;
   - extraction is not atomic;
   - the directory is shared by concurrent launches of the same version with no lock.
10. **Middleware errors are swallowed.** Natives extraction or asset linking can fail and the game still launches, then crashes with a misleading error.
11. **Prepend command quoting.** It uses a shell with naive double-quote wrapping. Arguments containing `$`, a backtick or `"` are mangled or interpreted by the shell. The `${clientid}` literal from item 7 is expanded by `sh` to an empty string. The string form of the prepend command is appended at the end instead of prepended (library API only).
12. **Ready and crash detection works on raw chunks.**
    - Markers split across chunks are missed.
    - The "crash report" is only the chunk that contained the header.
    - `hs_err_pid*.log` is never checked.
    - Encoding is guessed once from the first chunk.
13. **Auto memory sets `-Xms` and no `-Xmx`.** With many mods, `-Xms` can exceed the JVM's default max heap. That fails at startup ("Initial heap size set to a larger value than the maximum heap size") on low-RAM Macs, for example 8 GB with 200+ mods: Xms 9 GB vs a default Xmx of 2 GB.
14. **The legacy-assets `resources/` mapping for pre-1.6 is not implemented.** Sounds and music may be missing in very old versions.
15. **The 1.4.x special case in the asset middleware is effectively dead code.** It returns early unless the root id starts with `1.4.`, and then links Fabric and Quilt cache directories that cannot exist for 1.4.
16. **`auth_session` is passed as the bare token** for pre-1.7 versions, instead of `token:<token>:<uuid>`.
17. **`user_type` is always `msa`**, even for offline accounts.
18. **No validation that the log4j config was applied.** A missing config silently drops the Log4Shell mitigation for 1.7–1.18.
19. **The full option set is logged with only the `accessToken` field redacted.** The game command line (which contains `--accessToken <token>`) is not built at that point, but any later logging of arguments would leak the token. Amethyst MUST redact by argument position, not only by field name.
