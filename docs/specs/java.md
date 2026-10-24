# Java runtime management (macOS 13+, Apple Silicon)

Status: behavioural specification for Amethyst. It was derived from the observable behaviour of the reference launcher (XMCL) and checked against public sources. It is not a description of the reference launcher's code. Wherever this spec says "the original", it describes behaviour that you can verify by running it. Wherever it says "Amethyst MUST/SHOULD", it states a requirement for the rewrite.

Primary sources to verify against:

- Mojang Java runtime index: `https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json`. The per-component manifests are served from `piston-meta.mojang.com` and the file objects from `piston-data.mojang.com`.
- Version JSON `javaVersion` field: https://minecraft.wiki/w/Client.json, plus the version JSONs listed in `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`.
- Minecraft Java requirements: https://minecraft.wiki/w/Tutorials/Update_Java
- Azul Zulu metadata API: https://api.azul.com/metadata/v1/docs/swagger (endpoint `https://api.azul.com/metadata/v1/zulu/packages/`).
- `java_home(1)`: `man java_home` on macOS.
- JDK `release` file and `-XshowSettings:properties`: the OpenJDK `java` tool docs (https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html).

---

## 1. Data model

A **Java record** is identified by the absolute path of its `java` executable (not by JAVA_HOME). Fields:

| field | meaning |
|---|---|
| `path` | absolute path to the `bin/java` executable. This is the identity key. |
| `version` | the version string as parsed (e.g. `1.8.0_452`, `17.0.15`, `25`) |
| `majorVersion` | an integer: 8, 16, 17, 21, 25 and so on. For `1.x` strings, the major version is `x`. |
| `valid` | whether the last probe succeeded. Not persisted in the original. |
| `arch` | the JVM architecture. Display-only in the original, and not persisted (see Pitfalls). Amethyst MUST persist it and use it. |

Amethyst SHOULD also persist `vendor`, `javaHome`, `source` (where the record was discovered), `managed` (whether the launcher installed it), and the binary's `mtime`/`size`. These let it skip a re-probe when nothing has changed.

A **Java requirement** (taken from the version JSON) is the pair `{ component, majorVersion }`, for example `{ "component": "java-runtime-delta", "majorVersion": 21 }`. `component` names a Mojang runtime component.

Known components and majors:

| component | major | notes |
|---|---|---|
| `jre-legacy` | 8 | used by every version up to 1.16.5. Mojang back-filled it into old version JSONs. |
| `java-runtime-alpha` | 16 | 1.17 – 1.17.1 |
| `java-runtime-beta` | 17 | some 1.18-era snapshots |
| `java-runtime-gamma` | 17 | 1.18 – 1.20.4 |
| `java-runtime-gamma-snapshot` | 17 | snapshot channel |
| `java-runtime-delta` | 21 | 1.20.5 (24w14a) and later |
| `java-runtime-epsilon` | 25 | the newest line (26.x). Always trust the JSON. |
| `minecraft-java-exe` | – | Windows only. Ignore it. |

Do not hard-code a mapping from Minecraft version to Java version where the version JSON is available. The JSON's `javaVersion` is authoritative.

---

## 2. Discovery of installed JVMs

### 2.1 What the original scans on macOS

At startup, and whenever the user presses "refresh", the original builds a list of candidate executables. The list is the union of:

1. `/Library/Java/JavaVirtualMachines/<each entry>/Contents/Home/bin/java`
2. `$JAVA_HOME/bin/java`, when the env var is set in the launcher process.
3. `/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java`. This is the old Oracle Java 8 browser plug-in, which is x86_64-only.
4. The output of `which java`.
5. Every managed runtime folder under `<dataRoot>/jre/<component>` (see §5.5 for the executable path inside each).
6. Every record already present in the persisted cache (`java.json` in app data).
7. Any path the user adds manually.

Candidates that do not exist are dropped. Candidates are deduplicated by **inode**, so two paths that resolve to the same file count once. Each remaining candidate is then probed (§3).

It does NOT scan: `~/Library/Java/JavaVirtualMachines` (the user-level location used by IntelliJ and others), `/usr/libexec/java_home`, Homebrew, SDKMAN (on macOS), asdf, mise, jenv, Gradle toolchains, or other launchers' runtime folders.

### 2.2 Required discovery sources for Amethyst

Amethyst MUST scan everything in the list below. Probes MUST run in parallel with a small concurrency limit of about 4, and each probe MUST have a timeout (§3.4).

| source | how to enumerate | resulting executable |
|---|---|---|
| `java_home` | run `/usr/libexec/java_home -X`. It prints an XML plist array of dicts with keys `JVMHomePath`, `JVMArch` (`arm64`/`x86_64`), `JVMVersion`, `JVMVendor`, `JVMName`, `JVMBundleID`, `JVMEnabled`. Parse the plist. Do not parse `-V`, whose human-readable list goes to **stderr** and whose format is not a contract. Exit code 1 with "Unable to find any JVMs" means there are none. | `<JVMHomePath>/bin/java` |
| system bundles | `/Library/Java/JavaVirtualMachines/*/Contents/Home` | `…/bin/java` |
| user bundles | `~/Library/Java/JavaVirtualMachines/*/Contents/Home` | `…/bin/java` |
| Homebrew (arm64 prefix) | `/opt/homebrew/opt/openjdk*/libexec/openjdk.jdk/Contents/Home` and `/opt/homebrew/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home`. Also check casks (Temurin, Zulu and others), which install into `/Library/Java/JavaVirtualMachines` and so are already covered. | `…/bin/java` |
| Homebrew (Intel prefix) | `/usr/local/opt/openjdk*/libexec/openjdk.jdk/Contents/Home`. These builds are x86_64 and need Rosetta. | `…/bin/java` |
| SDKMAN | `~/.sdkman/candidates/java/*`. Skip the `current` symlink, or deduplicate it by inode. | `<dir>/bin/java` |
| asdf | `~/.asdf/installs/java/*` | `<dir>/bin/java` |
| mise | `~/.local/share/mise/installs/java/*` | `<dir>/bin/java` |
| jenv | `~/.jenv/versions/*`. These are symlinks to the real homes; deduplicate them. | `<dir>/bin/java` |
| Gradle toolchains | `~/.gradle/jdks/*` (sometimes `*/Contents/Home`) | `…/bin/java` |
| Mojang launcher runtimes | `~/Library/Application Support/minecraft/runtime/<component>/<platform>/<component>/jre.bundle/Contents/Home`, where `<platform>` is `mac-os-arm64` or `mac-os` | `…/bin/java` |
| `JAVA_HOME` | see the note below | `$JAVA_HOME/bin/java` |
| managed | `<dataRoot>/jre/*` (§5.5) | per-layout |
| cache + manual | persisted records | as stored |

For every directory-based source, accept both layouts. A directory `X` may contain `bin/java` directly, or it may contain `Contents/Home/bin/java`.

Environment note: an Electron app launched from Finder or the Dock does NOT inherit the user's shell environment. `JAVA_HOME` is usually unset, and `PATH` is the minimal `/usr/bin:/bin:/usr/sbin:/sbin`. As a result, `which java` from the app almost always returns `/usr/bin/java`, which is the Apple **stub**. Amethyst MUST NOT probe `/usr/bin/java` as a candidate. When no JDK is installed, the stub prints "Unable to locate a Java Runtime", exits non-zero, and may show a system "install Java" dialog. When a JDK is installed, it silently forwards to whichever JDK `java_home` picks, so its identity changes as the user installs JDKs. The `java_home -X` source already covers the same set of JDKs, deterministically.

Deduplication: after resolving symlinks with realpath, deduplicate by `(dev, inode)`. When two records share a real file, keep the "nicest" path in this order: the managed path, then a `java_home` path, then the first one found.

---

## 3. Probing a candidate (validation, version, arch)

### 3.1 What the original does

1. It checks that the path is executable (`access` with X_OK).
   - ENOENT means "not existed". The record is marked invalid.
   - EACCES/EPERM: it tries to chmod the file to mode `0765` and treats a successful chmod as OK. Otherwise the result is "no permission". (This mutates user-owned JDKs, and the mode is odd. Amethyst MUST NOT do this outside its own managed directory.)
2. It runs `<java> -version` with no timeout. It parses **stderr first, then stdout**. Most JVMs print to stderr, but some wrappers print to stdout.
3. The version parse rules (reproduce these):
   - The text must contain a token `openjdk`, `java`, `java version` or `java_version`, preceded by start-of-line or whitespace and followed by whitespace or `=`. Otherwise the text is rejected.
   - The parser looks for the first `A.B.C` with an optional `_N` suffix. If `A` is `1`, then major = `B`, version = the whole match (e.g. `1.8.0_452` gives 8), and patch = `N`. Otherwise major = `A` and patch = `C` (e.g. `17.0.15` gives 17).
   - If there is no dotted triple, a fallback accepts a major-only form such as `openjdk version "25"`, `java version "25"`, or `JAVA_VERSION="25"`. That gives major 25, patch −1.
4. Architecture: the original writes a tiny helper class into the app-data folder and runs it with that folder as the working directory. The helper prints a JSON object containing `java.version`, `java.vendor`, `java.home`, `java.vm.specification.version`, `sun.arch.data.model`, `os.name`, `os.arch` and `os.version`. The original then maps **`sun.arch.data.model`** to `"x64"` for 64 and `"x86"` for 32. This means an arm64 JVM is reported as `x64`. `os.arch` is ignored.
5. If `-version` cannot be parsed but the binary exists, the original reads `<home>/release`, where `home` is the grandparent of the binary. If `JAVA_VERSION="…"` parses, it records the version but marks the record **invalid**. Otherwise it records version `""`, major 0, invalid.

### 3.2 Amethyst probe (required)

Use a single spawn per candidate:

`<java> -XshowSettings:properties -version`

This prints every system property to **stderr**, in the form `    key = value`, followed by the normal version banner. It is supported on Java 7 and later, so it works for every runtime we care about, and it needs no helper class. Extract:

- `java.version` (e.g. `1.8.0_452`, `17.0.15`, `25`): use it to compute `version` and `majorVersion` with the rules in §3.1.3. As a fallback, use `java.specification.version` (`1.8`, `17`): if it starts with `1.`, take the part after the dot, otherwise take the integer.
- `os.arch`: `aarch64` means arm64. `x86_64` or `amd64` means x64 (this is a Rosetta JVM).
- `java.vendor`, `java.vm.name` (e.g. "OpenJ9" detection), `java.home`, `java.runtime.version`.

A cheaper pre-check that needs no spawn: read `<home>/release` and use its `JAVA_VERSION`, `OS_ARCH` (`aarch64`/`x86_64`), `IMPLEMENTOR` and `JAVA_RUNTIME_VERSION`. You can also read the Mach-O header of the binary. The magic `0xFEEDFACF` with cputype `0x0100000C` is arm64, and cputype `0x01000007` is x86_64. The magic `0xCAFEBABE` is a fat/universal binary. **Caution:** `0xCAFEBABE` is also the magic number of Java class files, so do not use it alone to identify a file type. Use these values to fill the cache and the UI quickly, but a record only becomes `valid` after a successful spawn.

### 3.3 Classification

| outcome | record state |
|---|---|
| path missing | invalid (`NotExisted`). Keep it in the list if the user added it manually, and show it as missing. |
| not executable | invalid (`NoPermission`). If the path is inside the managed directory, chmod it to 0755 and retry once. |
| spawn fails with `EBADARCH` (errno 86, "Bad CPU type") | invalid. The reason is "x86_64 JVM but Rosetta 2 is not installed". |
| spawn succeeds, version parsed | valid |
| spawn succeeds, unparseable | invalid. Keep the `release` file version for display. |
| timeout | invalid. Kill the process. |

### 3.4 Timeouts and environment for the probe

- Timeout: 10 s per probe, which is generous enough for a cold start on a spinning disk.
- Strip `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS` and `CLASSPATH` from the probe's environment. The first three cause the JVM to print a "Picked up …" line before the banner, which can confuse the version regex. `CLASSPATH` breaks helper-class approaches.
- Do not set the working directory to a location the user can write to and that contains class files.

---

## 4. Persistence and refresh

Original behaviour:

- The cache file is `<appData>/java.json`, with the shape `{ "all": [ { "path", "version", "majorVersion" } ] }`. It is rewritten on every state change. `valid` and `arch` are not persisted.
- On start, every cached entry is loaded **as valid** before it is re-checked. Then a refresh runs.
  1. **Re-validate the cache**: stat each cached path, skip duplicate inodes, and re-run the `-version` probe and the arch helper for each one.
  2. **Rescan** all discovery sources (§2.1), even when the cache was non-empty. This means every cached JVM is spawned at least twice per launcher start.
  3. Check managed folders: probe any managed runtime not already known.
- Records are merged by `path`. Removing a record removes it only from the list. If it is still on disk, the next scan finds it again.

Amethyst requirements:

- Persist the full record, including `arch`, `vendor`, `source`, `managed`, and the binary's `mtime` and `size`.
- On startup, show the cached records immediately. Re-probe a record only if its binary's `mtime` or `size` changed, or if the record is older than N days. Run discovery in the background.
- Keep a persisted "hidden paths" set, so that a JVM the user removed is not re-added by discovery.
- Refresh triggers: app start, the user pressing refresh, after a managed install finishes, and before launch for the selected path only (§6.4).

---

## 5. Installing a runtime

### 5.1 Inputs

The input is a requirement `{ component, majorVersion }`. If `component` is empty, as can happen with some pack-supplied majors (§6.2), the original refuses to auto-install and tells the user to pick a local Java.

### 5.2 Candidate order (original)

1. **Official (Mojang)**: tried first, unless a force-Zulu flag is set (§5.4).
2. **Zulu (Azul)**: always added last as the fallback.

Each candidate installs into its own folder:

- Official: `<dataRoot>/jre/<component>`
- Zulu: `<dataRoot>/jre/<component>-zulu`

The candidates are tried in order. After a candidate's install succeeds, its executable is validated: first the executable bit, then the full probe from §3. If the probe yields a record, that record is the result. If anything fails, a diagnostic error is recorded, the next candidate is tried, and the last error is thrown if all fail. Concurrent installs of the same `(component, forceZulu)` are serialised by a per-key mutex. The UI task key is `java-<major>-<component>`.

### 5.3 Official runtime from the Mojang index

**Step A: the index.** GET `all.json` (URL at the top of this document). Its top-level keys are platform names: `gamecore`, `linux`, `linux-i386`, `mac-os`, `mac-os-arm64`, `windows-arm64`, `windows-x64` and `windows-x86`. Each platform maps component names to an array with **zero or one** entries:

```json
{
  "availability": { "group": 3671, "progress": 100 },
  "manifest": {
    "sha1": "e0c8d5ccfe8cfb38075ff1b7f6352d7b03fd7868",
    "size": 97689,
    "url": "https://piston-meta.mojang.com/v1/packages/e0c8d5ccfe8cfb38075ff1b7f6352d7b03fd7868/manifest.json"
  },
  "version": { "name": "17.0.15", "released": "2025-05-19T08:26:07+00:00" }
}
```

On Apple Silicon, the original chooses `mac-os-arm64` and takes element `[0]` of the component's array. If the array is empty or missing, or if the index fetch fails, the official candidate is **silently skipped** and only Zulu remains. The original does not fall back to the x86_64 `mac-os` runtime on arm64. `availability` is ignored.

**The current state of `mac-os-arm64`** (checked October 2026 against the live index):

| component | mac-os-arm64 | mac-os (x64) |
|---|---|---|
| `jre-legacy` (8) | **empty** | 8u74 |
| `java-runtime-alpha` (16) | **empty** | 16.0.1 |
| `java-runtime-beta` (17) | **empty** | 17.0.15 |
| `java-runtime-gamma` (17) | 17.0.15 | 17.0.15 |
| `java-runtime-gamma-snapshot` | 17.0.15 | 17.0.15 |
| `java-runtime-delta` (21) | 21.0.7 | 21.0.7 |
| `java-runtime-epsilon` (25) | 25.0.1 | 25.0.1 |

So on Apple Silicon, every Minecraft version up to 1.17.1, plus the beta-era snapshots, can **only** get a native runtime from a third party. Amethyst MUST NOT hard-code this table. It must re-check the index at install time.

**Step B: the component manifest.** Download `manifest.url` to `<dest>/manifest.json`. Verify it against `manifest.sha1` and `manifest.size`, and check that it parses as JSON. If a valid copy already exists, skip the download. The shape is `{ "files": { "<relative path>": entry } }`. Each entry has one of three forms:

```json
{ "type": "directory" }
{ "type": "link", "target": "../java.base/LICENSE" }
{ "type": "file", "executable": true,
  "downloads": {
    "raw":  { "sha1": "58f0…cb91", "size": 84752, "url": "https://piston-data.mojang.com/v1/objects/58f0…cb91/java" },
    "lzma": { "sha1": "5c9e…9609", "size": 7157,  "url": "https://piston-data.mojang.com/v1/objects/5c9e…9609/java" } } }
```

Observed facts about the macOS arm64 manifests (Java 17, 21 and 25):

- There are about 440 entries: about 145 files, about 87 directories and about 208 links.
- Every path is rooted at `jre.bundle/` (a macOS bundle). The bundle contains `jre.bundle/Contents/Info.plist`, `Contents/MacOS/libjli.dylib`, `Contents/_CodeSignature/CodeResources`, and the JDK home at `jre.bundle/Contents/Home/` (with `bin/`, `conf/`, `legal/`, `lib/` and `release`).
- About 29 to 31 files are `executable: true`. These are everything in `Home/bin/` plus `Home/lib/jspawnhelper`. `jspawnhelper` MUST be executable, or `Runtime.exec`/`ProcessBuilder` inside the game fails.
- Every link's `target` is **relative to the link's own directory**. In current manifests, every target resolves to a regular `file` entry. All of them are files under `legal/`. There are no links to directories and no chains of links. Do not rely on this staying true.
- `lzma` is present for most files but not all (e.g. 135 of 142). `raw.sha1` is the hash of the decompressed content. `lzma.sha1` is the hash of the compressed blob. Using lzma reduces the download size by about 10 to 30% (e.g. Java 17: about 95 MB raw versus about 69 MB using lzma where available).

**Step C: the files.** For every `file` entry, the target is `<dest>/<relative path>`, with the raw URL, its sha1 and its size. A file that already exists with a matching sha1 is skipped (the original hashes every existing file on every run). Downloads use the shared downloader (see `download.md`) with retries: 5 attempts, exponential backoff from 500 ms up to 4 s with ±25% jitter, URL rotation, and an immediate stop on abort, EPERM, EACCES, ENOSPC or EROFS.

The original **ignores `lzma` entirely** and always downloads `raw`. (The older core library had an optional lzma mode. In that mode, if the raw file was absent it downloaded `<path>.lzma`, verified the compressed sha1, and decompressed. It did not re-verify the decompressed output against `raw.sha1`.)

**Step D: the layout.** This runs after all files are present and is applied as one transaction:

- `directory` entries: create the directory.
- executable files: set the mode to `0755`. The original copies the file to a temp file, chmods it, and moves it back.
- `link` entries: the original creates a **hard link**, `<dest>/<path>` pointing to `dirname(<dest>/<path>)/<target>`. Mojang's own launcher creates **symbolic links**. Amethyst SHOULD create relative symlinks with the exact `target` string. Create links after all files exist, and process link-to-link chains in dependency order (or do a second pass).
- The original applies all of these as one transaction. Each operation writes to a temp sibling. Existing paths are moved to backups. On any error, everything is rolled back. On success, the backups are deleted.

**Step E: the executable path.** For official runtimes it is `<dest>/jre.bundle/Contents/Home/bin/java`. The `<dest>/manifest.json` file stays alongside it as the record of what was installed.

Amethyst additions:

- Use `lzma` when it is offered. Download it, stream-decompress it (LZMA "alone" format, i.e. `.lzma`, not `.xz`), and verify the **decompressed** bytes against `raw.sha1` and `raw.size` before an atomic rename into place. If the lzma download or its verification fails, fall back to `raw`.
- Fast verify: after a successful install, also write `<dest>/.amethyst-installed.json`, containing the manifest sha1 and a map of `path → {size, mtime}`. On later checks, re-hash only the files whose size or mtime differs. Do a full re-hash only for an explicit "repair".
- Do not set or clear quarantine attributes. Files written by Node `fs` are not quarantined unless the app's Info.plist enables `LSFileQuarantineEnabled`, and Amethyst MUST NOT enable it. The Mojang and Azul binaries are signed, and that signature is embedded in each Mach-O, so copying or linking preserves it.

### 5.4 Zulu fallback (original)

- **Index source.** The original ships a bundled JSON index of Zulu builds and stores a copy at `<appData>/zulu.json`. At startup it re-downloads the index from a GitHub-hosted static file belonging to the original project, sending `If-Modified-Since: <modified>`. It accepts the new copy only if it passes schema validation **and** every component key has at least one build. Otherwise the cached copy (or the bundled one) is kept.
- **Index shape.** `{ "modified": "<HTTP date>", "<component>": [ { features[], architecture, os, sha256, size, url } ] }`. `os` is one of `win32`/`linux`/`darwin`. `architecture` is one of `x64`/`arm64`/`ia32`. `features` can contain `javafx` and/or `musl`.
- **Builds the original pins for darwin/arm64:**
  - `jre-legacy`: Zulu 8.86 / 8u452
  - `alpha`: Zulu 16.30 / 16.0.1
  - `beta`: Zulu 17.30 / 17.0.1
  - `gamma` and `gamma-snapshot`: Zulu 17.44 / 17.0.8
  - `delta`: Zulu 21.34 / 21.0.3
  - `epsilon`: Zulu 25.34 / 25.0.3
  - All of these are `.tar.gz` JREs hosted on `static.azul.com` or `cdn.azul.com`. Every component except `alpha` also has a **JavaFX** variant.
- **Selection.** Filter by `os == darwin` and `architecture == arm64`. Drop any build tagged `musl`. **Prefer a build with the `javafx` feature** if one exists, and otherwise take the first match. If nothing matches, try the bundled index. If that also fails, the error is "No zulu jre found for darwin arm64 (type=…; tried cache=N, bundled=M)".
- **Download.** Fetch the archive to `<dest>/<archive basename>` and verify its sha256 and size. Only `.zip` and `.tar.gz` are accepted.
- **Extraction.** Extract into a temp directory with **strip-components = 1**, then swap it into `<dest>` and delete the archive. Tar entry modes are applied, and symlinks are recreated as symlinks with their original link names. Entries with absolute names or `..` segments are skipped. Symlink targets are not checked for escaping the destination.
- **Executable path.** `<dest>/bin/java`. Azul's macOS tarballs contain a top-level directory named after the build, with a `zulu-<N>.jre/Contents/Home/` bundle inside it. Next to the bundle are **symlinks** `bin`, `release`, `LICENSE` and `man`, which point into `zulu-<N>.jre/Contents/Home/`. After stripping one component, `<dest>/bin/java` works through that symlink. The original treats any managed folder whose name ends in `zulu` as having this layout, and every other managed folder as having the Mojang `jre.bundle` layout.
- **Forcing Zulu.** A remote feature flag ("force Zulu") or an explicit request skips the official candidate. When a managed runtime at `jre/<component>-zulu` breaks, the launch self-heal (§6.4) reinstalls it with force-Zulu.

### 5.5 Managed folder layout summary

```
<dataRoot>/jre/
  java-runtime-delta/            # Mojang
    manifest.json
    jre.bundle/Contents/Home/bin/java
  jre-legacy-zulu/               # Azul (strip 1)
    bin -> zulu-8.jre/Contents/Home/bin
    release -> zulu-8.jre/Contents/Home/release
    zulu-8.jre/Contents/Home/...
```

Folders whose names begin with `.` are ignored. The component is derived from the folder name, minus the `-zulu` suffix.

### 5.6 Amethyst Zulu source (required change)

Do not depend on the original project's GitHub static file. Use one of these two sources:

1. **The Azul Metadata API, live.** Query `GET https://api.azul.com/metadata/v1/zulu/packages/?java_version=<major>&os=macos&arch=aarch64&archive_type=tar.gz&java_package_type=jre&javafx_bundled=false&release_status=ga&availability_types=CA&latest=true`. The response is an array of `{ package_uuid, name, download_url, java_version:[8,0,512], distro_version:[…], latest, … }`. Note that more than one item can come back with `latest: true`. Sort by `java_version` in descending order and take the first. Then call `GET https://api.azul.com/metadata/v1/zulu/packages/<package_uuid>` to obtain `sha256_hash` and `size`. The sha256 is required, and the install MUST NOT proceed without it.
2. **A pinned index that Amethyst ships**, in the same shape as §5.4, updated at release time. Use the live API only to refresh it.

Recommendation: use (1), with (2) as the offline fallback. Default to **non-JavaFX** builds. Minecraft does not need JavaFX, and the JavaFX builds are about 2× larger. Add an opt-in setting for JavaFX. Note that Eclipse Temurin publishes no macOS/aarch64 build of Java 8, which is why Zulu (or Liberica, or Corretto) is needed for `jre-legacy`.

### 5.7 Amethyst policy for components missing on arm64

| requirement | Amethyst action |
|---|---|
| `jre-legacy` (8) | Install Zulu 8 arm64. Do not install the x64 Mojang runtime by default, because it would force Rosetta and break the arm64 natives strategy described in `launch.md`. |
| `java-runtime-alpha` (16) | Prefer installing (or reusing) the **arm64 `java-runtime-gamma` (17)** from Mojang. Minecraft 1.17.x runs on 17, and §6.1 already treats any Java of 16 or later as matching a requirement of 16 or later. Offer Zulu 16 only if the user explicitly asks for 16. *(Verify against Forge 1.17.1 and Fabric for 1.17.)* |
| `java-runtime-beta` (17) | Use `java-runtime-gamma` (the same major version). |
| anything else that is absent from `mac-os-arm64` | Zulu with the same major version. |
| Zulu also lacks it | Report the failure to the user and offer "choose a local Java". Never fall back to x64 silently. An explicit "use Rosetta (x86_64) runtime" setting MAY exist. If it does, Amethyst must check for Rosetta first (`/usr/bin/arch -x86_64 /usr/bin/true` exits 0, or `/Library/Apple/usr/libexec/oah/libRosettaRuntime` exists). The launch must then evaluate library rules for x86_64 (see `launch.md`). |

Also detect whether the launcher itself is running translated: `sysctl.proc_translated` is 1 under Rosetta. Even then, still pick the `mac-os-arm64` key. (The original picks its platform key from the launcher process's own arch, so if it ran under Rosetta it would install x64 runtimes.)

---

## 6. Choosing the Java for a launch

### 6.1 The requirement and the match predicate (original rules, reproduce them)

Inputs: the Minecraft version string, an optional Forge version, the **resolved** version (after the `inheritsFrom` merge, the last `javaVersion` in the chain wins, and the default is `{jre-legacy, 8}`), and the optional `compatibleJavaMajors` list (supplied by MultiMC/Prism packs).

1. **Pack allow-list.** If `compatibleJavaMajors` is present, the match is "major ∈ list", and "okay" means the same thing. The install target becomes the version's own `javaVersion` if its major is in the list. Otherwise it is the smallest listed major that has a known component (8 → `jre-legacy`, 16 → `alpha`, 17 → `gamma`, 21 → `delta`, 25 → `epsilon`). Otherwise it is the smallest listed major with an empty component, which means "install it manually".
2. **The Forge 17 pin.** For Forge on MC 1.18.x, 1.19.x, or 1.20 to 1.20.4, when the version's `javaVersion` is absent or is 17: the requirement is exactly 17, and the component defaults to `gamma`. Forge's bytecode tooling in those versions breaks on newer JDKs.
3. **The general case.** Let `req` be the version's `javaVersion`.
   - If `req.major ≥ 16`, the match is `major ≥ req.major` (forward-compatible).
   - If `req.major < 16`, the match is `major == req.major` (strict, because legacy Minecraft relies on Java 8 internals).
   - The fallback (when `req` is absent, i.e. the version is not installed yet) depends on the Minecraft minor version:
     - < 1.13: match 8. "Okay" is 8 to 11. The default target is `jre-legacy`.
     - 1.13 to 1.16: match 8 to 16. Anything counts as "okay". The default target is `jre-legacy`.
     - ≥ 1.17: match ≥ 16. Anything counts as "okay". The default target is `alpha`.
   - Note that the "okay" tiers above apply even when `req` is present. Only `match` is overridden.

### 6.2 Selecting among installed JVMs (original)

- Consider only valid records.
- Partition them into **matched**, **okay** and **bad**.
- If any record matched:
  - If the global "preferred Java" setting points to a matched record, use it.
  - Otherwise sort the matched records so that paths containing `openj9` (case-insensitive) come last, and take the first. Apart from that, order is simply discovery and insertion order.
- If nothing matched, auto-selection yields **no Java**, even when "okay" candidates exist. The "okay" and "bad" grades are used only to label a JVM that the user pinned.
- The instance's **pinned Java** (`instance.java`) is re-probed at launch:
  - If it resolves and is valid, it is used regardless of quality. The UI warns "incompatible" when its grade is not *matched*, and the user can dismiss that warning per instance (the dismissal is stored in local storage, keyed by instance and path).
  - If the pinned Java does not resolve, the launcher falls back to the auto-selected one.
- If the end result is still no Java, the launch is blocked with the error `launchNoProperJava`. The UI shows a "missing Java" status with an action that installs the computed `javaVersion` target (§5).

### 6.3 Amethyst selection requirements

Follow §6.1 and §6.2, with these changes:

- **Architecture ranking.** Among the matched records, prefer `arch == arm64`. An x64 JVM MUST be ranked below every arm64 JVM, and is used only if it is the only match or if the user pinned it. When an x64 JVM is selected, the launch MUST evaluate library and natives rules for x86_64, and the UI should warn that the game is running under Rosetta. (The original always evaluates the rules with the launcher's own arch. See Pitfalls.)
- **Tie-break.** Among records of equal architecture, prefer exact-major over newer-major, then managed over external, then the highest version, then OpenJ9 last. Exact-major first matters because, for example, some Forge or old mods break on Java 25 even when 21 is required.
- **Version-string parsing for new Minecraft.** The fallback branch in §6.1.3 must handle year-based versions (`26.1`, `26.1-snapshot-…`) and snapshot ids (`24w14a`). Treat any version whose first number is ≥ 2 (i.e. not `1.x`) as "≥ 1.17". For snapshot ids, use the version JSON if it is present, and otherwise the manifest's release time.
- Auto-install: when no matched record exists, offer one-click install, following §5.7 for the target component. Proceed without asking if the user has enabled "auto-install Java".

### 6.4 Pre-launch validation (original, reproduce it)

Immediately before spawning the game:

1. Re-probe the chosen executable (§3).
2. If the probe fails **and** the path lies inside `<dataRoot>/jre/<folder>`, then:
   - work out the component (the folder name minus `-zulu`) and whether it was a Zulu install;
   - take the target `{component, majorVersion}` from the version's `javaVersion`, or else from the cached record's major;
   - remove the stale record, reinstall (forcing Zulu if it was Zulu), and switch the launch to the new path.
3. If the probe still fails, map the failure to one of the user-facing errors: `launchInvalidJavaPath` (missing), `launchJavaNoPermission` (not executable) or `launchNoProperJava` (exists but the JVM cannot start). Abort the launch.

For tools that need any Java but are not the game (for example, running a Forge installer for an old version), the original picks "any valid Java 8, else the first valid one". For modern Forge and NeoForge installs, it requires exactly the version's `javaVersion.majorVersion` and auto-installs it if it is missing. Amethyst MUST use the version's requirement for installers, not "Java 8 first".

---

## 7. Errors and telemetry-level diagnostics

When a managed install yields an executable that cannot be used, the original builds a diagnostic with these fields:

- the phase: `download-or-extract` (the binary is absent), `permission` (it exists but is not executable), or `parse-or-spawn` (it exists and is executable, but there is no version);
- the install source: `official`, `zulu` or `official-then-zulu`;
- the component and major version;
- whether the executable exists, and its size;
- the file counts of the `bin` folder and the root folder;
- whether a `release` file is present, and its `JAVA_VERSION`;
- the probe's exit code, signal, and stdout/stderr. Any `/Users/...` paths in these are redacted, and each is truncated to 1 KiB.

Amethyst SHOULD produce the same structure for its logs. It should add the binary's Mach-O arch and the `EBADARCH` case.

---

## 8. Pitfalls / bugs observed in the original

1. **arm64 JVMs are reported as `x64`.** The architecture comes from `sun.arch.data.model`, which is "64" on both arm64 and x86_64, and `os.arch` is ignored. On Apple Silicon this makes Rosetta and native JVMs indistinguishable. The value is also used only for display, and is never persisted (the cache schema drops it). As a result it is re-detected with an extra spawn on every startup.
2. **Natives and rules are evaluated with the launcher's arch, not the JVM's.** The launch passes the Electron process's arch (always arm64 here) as the platform. If the user picks an x86_64 JDK, arm64 natives are extracted for an x86_64 JVM, and the game crashes with an `UnsatisfiedLinkError`. Amethyst must evaluate the rules with the selected JVM's arch.
3. **No timeout on `java -version` or the arch helper.** A hung or prompting binary, such as the `/usr/bin/java` stub or a JVM on a network volume, blocks discovery indefinitely. Discovery also spawns every candidate concurrently, with no limit.
4. **`which java` from a GUI app finds only the Apple stub.** Finder-launched apps have a minimal `PATH` and no `JAVA_HOME`. The stub's reported version changes as the user installs JDKs, it is a separate inode from the real binary (so it is never deduplicated), and with no JDK it may trigger a system install dialog.
5. **Big discovery gaps on macOS.** The original never consults `java_home`, `~/Library/Java/JavaVirtualMachines`, Homebrew, SDKMAN (its SDKMAN path is only used on Linux, and even there it is built from an unevaluated home-directory reference, so it can never match), asdf or mise. It does still probe the obsolete Oracle applet-plugin path, which is x86_64-only.
6. **Every startup does a double probe.** It re-validates the cache, then rescans everything regardless. A user with N JDKs pays roughly 2N to 3N JVM spawns at every launch. The helper class is also rewritten to app data on every start.
7. **Cached records are shown as valid before they are checked.** For a moment the UI can offer a deleted JDK. Combined with item 6, the state flips during startup.
8. **"Remove Java" is not sticky.** Removed JVMs are rediscovered on the next scan.
9. **chmod of user JDKs to `0765`.** When a JDK is not executable, the original tries to change the mode of files it does not own. The mode makes the file group-writable and is not executable by group. Restrict chmod to the managed directory, and use `0755`.
10. **Hard links instead of symlinks for runtime `link` entries.** This differs from Mojang's launcher. It fails for directory targets, and for a link whose target is another link that has not been created yet. Either case would abort and roll back the whole layout transaction. (The older core library passed the link arguments in reverse order and swallowed the error, so links were never created at all. It also never set executable bits, so `jspawnhelper` was not executable.)
11. **`lzma` downloads are ignored.** The original always downloads raw, which costs about 10 to 30% extra bandwidth.
12. **Every existing runtime file is re-hashed on every install or repair.** That is about 145 SHA-1s per component, with no size/mtime fast path.
13. **The `all.json` index is not cached.** It is fetched on every install. If it fails, the official candidate is silently dropped and Zulu is used, with no message to the user. `availability` is ignored, and only `[0]` is considered.
14. **The Zulu index comes from a third-party GitHub file**, pinned to old builds (for example 17.0.8 and 21.0.3). The JavaFX variant is preferred whenever it exists, which roughly doubles the download for no Minecraft benefit.
15. **Managed layout detection by folder name.** "Ends with `zulu`" picks the Zulu layout, and every other folder is assumed to use the Mojang `jre.bundle` layout. A user-renamed folder breaks this. Detect the layout by checking which executable actually exists.
16. **Selection ignores architecture, and the `okay` tier is not used for auto-select.** With only an "okay" Java installed (for example Java 11 for MC 1.12), auto-select reports *no Java* and pushes a download. The tie-break among matches is insertion order. So a Java 25 can be chosen for a version requiring 21, ahead of an installed 21.
17. **Version-family detection assumes `1.x`.** The not-installed fallback in §6.1.3 parses the Minecraft "minor" number. A year-based version (`26.1`) has minor 1, so it falls into the "< 1.13, needs Java 8" branch. Snapshot ids parse unpredictably. The "okay" tiers are wrong for those versions even when `javaVersion` is known.
18. **Fragile version regex.** It takes the first `A.B.C` anywhere in the output, so a `Picked up JAVA_TOOL_OPTIONS: …1.2.3…` line placed before the banner corrupts the parse. Its minor-digit capture keeps only the last digit (harmless for real JVMs, but sloppy). The original does not strip the `JAVA_*OPTIONS` environment variables when probing.
19. **The arch helper depends on its working directory and the default classpath.** A user-level `CLASSPATH` environment variable breaks it, so arch is reported as unknown.
20. **Zulu extraction does not validate symlink targets.** A link could point outside the destination. Azul archives are trusted, but this should still be checked. Extraction also swallows `symlink` errors, which can leave the `bin` link missing so that the only error the user sees is "executable not found".
