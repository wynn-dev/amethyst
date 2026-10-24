# Amethyst spec: installing game versions and mod loaders

Status: behavioural specification for a clean-room implementation. Target: macOS 13+ on Apple Silicon only.

This document covers:

- vanilla installs (version JSON, client jar, libraries, assets);
- Forge in all of its historical installer formats;
- NeoForge;
- Fabric and Quilt;
- OptiFine;
- the pre-launch "diagnose and repair" pass.

For how each file is fetched and verified, see `download.md`. For Java runtimes, see `java.md`. For how the result is launched, see `launch.md`. Directory names (`<root>/versions`, `<root>/libraries`, `<root>/assets`) follow `launch.md` §1.

Out of scope: dedicated-server installs, LabyMod, download mirrors (BMCLAPI and the like), and Windows/Linux.

Public references:

- Mojang version manifest (v2 adds a per-version sha1): https://piston-meta.mojang.com/mc/game/version_manifest_v2.json. The older v1 is https://launchermeta.mojang.com/mc/game/version_manifest.json.
- Version JSON: https://minecraft.wiki/w/Client.json
- Assets: https://minecraft.wiki/w/Tutorials/Game_assets. Objects are at `https://resources.download.minecraft.net/<hh>/<sha1>`.
- Forge:
  - maven: https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml
  - promotions: https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json
  - per-version file list: `https://files.minecraftforge.net/net/minecraftforge/forge/<version>/meta.json`
  - installer source: https://github.com/MinecraftForge/Installer (the `install_profile.json` spec, the processors, and the `{DATA}` and `[artifact]` substitution)
- NeoForge:
  - maven: https://maven.neoforged.net/releases/net/neoforged/neoforge/
  - version API: https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge
  - installer source: https://github.com/neoforged/LegacyInstaller
- Fabric meta: https://meta.fabricmc.net/ (`/v2/versions/loader`, `/v2/versions/game`, `/v2/versions/loader/<mc>/<loader>/profile/json`)
- Quilt meta: https://meta.quiltmc.org/ (`/v3/versions/loader`, `/v3/versions/loader/<mc>/<loader>/profile/json`)
- OptiFine: https://optifine.net/downloads. There is no API and no checksums.

---

## 1. Execution model (how the original structures an install)

The original separates **planning** from **executing**. Amethyst SHOULD do the same: it makes resume, repair and testing straightforward.

**Plan.** A plan is a list of tasks. Each task has an id and optional dependencies (`dependsOn`). Tasks run concurrently unless one depends on another. Duplicate ids and dependency cycles are rejected. There are three task kinds:

1. **files**: a list of file descriptors, each with:
   - `path`;
   - an ordered list of candidate `urls`;
   - optional `size`;
   - optional `checksum {algorithm, value}`;
   - optional `validator` (`file`, `zip` or `json`);
   - the flags `trustExistingSize` and `replace`;
   - `validatedAt`, a timestamp.

   Executing this kind:
   1. De-duplicate the descriptors by path.
   2. Drop the ones that are already valid.
   3. Download the rest, then re-validate them.
   4. Retry with rotated URLs.

   The validity rules and retry policy are in `download.md` §5.
2. **java**: run one or more Java command lines.
   - The commands come as a list of alternative "strategies". Each strategy is a sequence of commands, and strategies are tried in order.
   - The task declares `outputs`, each with an optional sha1 and validator.
   - The task is **skipped** when every declared output is already valid. A task can opt out of this skip when some of its commands write directories that cannot be validated.
   - After a strategy runs, its outputs are validated. If any is invalid, all outputs are deleted and the next strategy is tried.
3. **materialize**: deterministic filesystem operations, applied as a transaction:
   - write a file (text or base64);
   - create a directory;
   - chmod;
   - copy;
   - hard-link;
   - remove;
   - extract one zip entry to a path;
   - merge several zips into one;
   - extract a whole zip or tar.gz, with an optional strip-components count.

   How the transaction works:
   - Every target is first produced at `<target>.install-<pid>-<random>`.
   - Existing targets are moved aside to `<target>.backup-<pid>-<random>`.
   - Then the new files are renamed into place.
   - The declared outputs are validated.
     - If they all pass: delete the backups (commit).
     - If any fails: delete the new files and restore the backups (rollback).

**Workflow.** A workflow is a state machine that yields one plan at a time. The rule is that `next()` may **read** what previous stages produced but must not download, spawn or write; only executing a plan has side effects. This is how multi-stage installers are expressed: "download the installer → read it → extract → download the tool libraries → run processors → download the final libraries". A limit of 32 stages guards against loops.

**Locks.** All locks are in-process mutexes.

| Lock | Scope |
|---|---|
| per instance | Instance install requests. |
| per version id | Repairs and reinstalls. |
| per Java component | Java installs. |
| one global "libraries" lock | Every Forge/NeoForge workflow. |
| per Minecraft version "forge post-process" lock | Forge/NeoForge post-processing. |

The combined effect is that only one Forge/NeoForge install runs at a time, launcher-wide.

**Install lock file.** When an instance version has been installed or repaired successfully, the original writes `<root>/versions/<id>/.install-lock` = `{schemaVersion: 1, version: <id>, timestamp: <ms>}`. Later diagnosis passes this timestamp to every check. **A file whose mtime ≤ timestamp is trusted without hashing.** This is what makes the pre-launch check fast.

---

## 2. Metadata sources and caching

### 2.1 Cache policy (original)

Every remote list is cached as JSON under `<appData>/version-metadata/<name>.json`, as `{source, etag, lastModified, data}`. The lists are: Minecraft, Forge per MC version, NeoForge per MC version, Fabric, Quilt and OptiFine.

| Situation | Behaviour |
|---|---|
| Cache hit | Return the cached data **immediately** ("stale-while-revalidate") and start a background revalidation. The revalidation sends `If-None-Match`/`If-Modified-Since` to the source that produced the cache. A `304` keeps the cache. A `200` overwrites it and broadcasts the new list. |
| Cache miss | Race all sources and keep the first valid response. |
| Forced refresh | Block, using the conditional request first. |

A response that fails schema validation never overwrites a good cache. If every source fails and a cache exists, the stale cache is returned.

> Pitfall: the instance installer looks a Minecraft version up in this cache. A version released after the cache was written is "not found" on the first attempt, even though revalidation is already fetching it. Amethyst MUST do a blocking refresh whenever a requested id is missing from the cached list (see §11).

### 2.2 Sources

| List | Original source | Amethyst |
|---|---|---|
| Minecraft versions | `launchermeta.mojang.com/mc/game/version_manifest.json` (v1) | Use **v2** (`piston-meta…/version_manifest_v2.json`). Each entry has `sha1` (of the version JSON) and `complianceLevel`. Verify the version JSON against that sha1. |
| Forge versions for MC `x` | Scrapes the HTML page `files.minecraftforge.net/net/minecraftforge/forge/index_<x>.html` for version, date, type (latest/recommended) and per-file md5/sha1/path. | Use the public JSON/XML instead: `maven-metadata.xml` for all versions (filter by the `<mc>-` prefix), `promotions_slim.json` for the `<mc>-latest`/`<mc>-recommended` flags, and per-version `meta.json` for the available classifiers (`installer`, `universal`, `client`, with md5) to choose the install path (§4.1). Get the installer sha1 from `<artifact>.jar.sha1` on the maven. |
| NeoForge versions for MC `x` | The maven API list, filtered by a prefix computed from `x` (§5). | Same API, with the corrected prefix rule (§5.1). |
| Fabric | `meta.fabricmc.net/v2/versions/loader` and `/v2/versions/game` | Same. |
| Quilt | `meta.quiltmc.org/v3/versions/loader` and `/v3/versions/game` | Same. |
| OptiFine | BMCLAPI only (out of scope), with a fallback that scrapes the downloads page in a hidden browser window | See §8. |

---

## 3. Vanilla install

**Input:** a Minecraft version entry from the manifest: `{id, url, sha1 (v2), type, releaseTime}`.

### 3.1 Steps and ordering

1. **Version JSON.** If `<root>/versions/<id>/<id>.json` cannot be resolved (missing or unparseable), download it from `url` with:
   - `replace = true`: discard any existing file without trusting it;
   - validator `json`: it must parse.

   The original has no checksum here. Amethyst MUST check the v2 manifest's `sha1`. The JSON is downloaded only when the local file is unusable; a valid local file is never refreshed. Mojang does occasionally re-publish JSON for old versions. A "Re-download version metadata" repair action SHOULD exist.
2. Then the following run **in parallel**:
   - **(a) Client jar.**
     - Source: `downloads.client` of the merged version.
     - Target: `<root>/versions/<minecraftVersion>/<minecraftVersion>.jar`.
     - The file has a sha1 and size, and validator `zip`.
     - It is **always fully hashed**, never trusted by mtime. The reason: Forge/NeoForge processors consume it, and a restored or tampered file could carry an old mtime.
   - **(b) Libraries.** Every resolved library of the version (`launch.md` §4), after rules. For each library:
     - **path:** `<root>/libraries/<download.path>`;
     - **size:** `download.size`, where `-1` means unknown;
     - **checksum:** sha1 if known;
     - **validator:** `zip` when there is no sha1;
     - **candidate URLs:**
       1. the library's own `url`;
       2. for names containing `forge`, the Forge maven (`https://maven.minecraftforge.net/<path>`);
       3. for any library whose name contains none of `mojang`, `minecraft`, `forge`, `fabric` or `optifine`, the Forge maven as well, as a generic fallback;
       4. the core library also lists Maven Central `https://repo1.maven.org/maven2/<path>` as a fallback.
     - When more than 2 URLs result, the list is **doubled** (repeated once) to give extra retries.
     - Old-style natives are downloaded the same way (they are just jars).
   - **(c) Assets** (§3.2).
   - **(d) Java.** The Java runtime the version needs is resolved or installed (`java.md`). It is only *needed* by later loader layers.
3. Loader layers (§4–§8), in order.
4. **Final libraries pass.** If a loader layer produced a new version id, resolve it and run the libraries step again for the merged result. This picks up loader libraries.
5. Write `.install-lock` for the final id.

Errors: all the parallel branches are awaited even if one fails. The first error from the primary chain wins; otherwise the first failing side branch is reported.

### 3.2 Assets

1. **Asset metadata** (one plan with a dependent alias step):
   - **Log config.** If `logging.client.file` exists: `<root>/assets/log_configs/<file.id>`, from its `url`, with sha1 and size.
   - **Asset index.**
     - Path: `<root>/assets/indexes/<assetIndex.sha1>.json`. The original names indexes by **hash**.
     - URL: `assetIndex.url`, with sha1 and size, validator `json`.
   - **Alias.** If the sha1 differs from the `assets` id, materialise a **hard link** `<root>/assets/indexes/<assets>.json` → the hashed file. This depends on the index step. Older tools and the legacy-assets step read `<assets>.json`.
2. **Asset objects.** Parse the index. For every `objects[name] = {hash, size}` create a file descriptor:
   - path `<root>/assets/objects/<hash[0..2]>/<hash>`;
   - URL `https://resources.download.minecraft.net/<hash[0..2]>/<hash>`;
   - size;
   - sha1 = the hash;
   - **`trustExistingSize = true`**: an existing file of the right size is accepted without hashing. Newly downloaded files are still hashed.

   Asset object paths are content-addressed and shared by every version. That is why the de-duplication by path matters: one modern index has about 4,000 objects.
3. **Legacy virtual and resources trees** are not built at install time. They are built at launch (`launch.md` §8).

---

## 4. Forge

### 4.1 Choosing the install path

There are four historical formats. The original chooses between them as follows.

| Format | Minecraft range (public facts) | How to detect | Original behaviour |
|---|---|---|---|
| A. Universal zip, no installer | ≤ 1.5.1 (and the 1.4.x line) | `meta.json` lists only `universal` (`zip`) and no `installer` | Used **only when the MC version starts with `1.4.`**. Other pre-installer versions try the installer and fail. |
| B. Legacy installer | 1.5.2 to 1.12.2 (builds before about 14.23.5.2851) | The installer jar has `install_profile.json` with `install` + `versionInfo`, and no `version.json` | Supported. |
| C. Modern installer, spec 0 (1.12.2 late builds and 1.13–1.16) and spec 1 (1.17+) | — | The installer jar has `install_profile.json` **and** `version.json` | Supported, with processors. |

Amethyst MUST detect the format from `meta.json` (or by checking which artifacts exist), not from a version-prefix guess.

**Artifact version string.** The original guesses it:

- for MC minor 7–8: `<mc>-<forge>-<mc>`;
- otherwise: `<mc>-<forge>`, unless the given forge version already starts with the MC version.

Public maven data shows this is wrong in many cases:

- `1.8-11.14.4.1577` has no suffix, but `1.8-11.14.0.1237-1.8` has one;
- `1.7.10-10.13.0.1150` has no suffix;
- `1.10.2-12.18.0.2001-1.10.0` has a different suffix;
- `1.9-12.16.1.1938-1.9.0` likewise.

Amethyst MUST look the exact string up in `maven-metadata.xml`: take the entry whose middle component equals the Forge build.

**Download.**

- Installer: `libraries/net/minecraftforge/forge/<v>/forge-<v>-installer.jar`.
- Universal (format A): `forge-<v>-universal.zip`.
- URL: `https://maven.minecraftforge.net/net/minecraftforge/forge/<v>/<file>`.
- sha1: from the scraped listing when available; the validator is `zip`.

Amethyst MUST fetch the `.sha1` sidecar when the listing gives none. Forge's `meta.json` provides md5, which is acceptable as a second choice.

**Java for the installer.** Use the merged version's required Java (`javaVersion.majorVersion`), installed on demand. Do not use "any Java". On Apple Silicon this is the arm64 runtime (`java.md`).

**Proxy.** If a user HTTP proxy is configured, processors are started with `-Dhttp.proxyHost/-Dhttp.proxyPort/-Dhttps.proxyHost/-Dhttps.proxyPort`. If the proxy URL has no host and port, `-Djava.net.useSystemProxies=true` is used instead.

### 4.2 Format A: universal zip (1.4.x in the original)

1. Download the universal zip.
2. Materialise `libraries/net/minecraftforge/forge/<v>/forge-<v>.jar` as a **merged zip**:
   - first all entries of the vanilla client jar `<root>/versions/<mc>/<mc>.jar`;
   - then all entries of the universal zip;
   - a later entry with the same name wins (Forge's patched classes override vanilla);
   - every `META-INF*` entry is excluded, which strips the jar signature.
   - Validator `zip`.
3. Write `versions/<mc>-forge-<v>/<mc>-forge-<v>.json` with:
   - `inheritsFrom: <mc>`;
   - `mainClass: net.minecraft.launchwrapper.Launch`;
   - JVM argument `-Dminecraft.applet.TargetDirectory=${game_directory}`;
   - libraries:
     - the merged forge jar (by coordinate);
     - the FML runtime libraries that old FML otherwise downloads at first start. Those servers are long gone. The libraries are guava 12.0.1, argo 2.25, asm-all 4.0 and bcprov-jdk15on 1.47, with fixed sha1s, hosted on the Forge maven and on a third-party archive of the old FML library set.
4. Download the libraries of the new version.

Amethyst: support this for every MC version whose Forge builds have no installer (1.1–1.5.1), not only 1.4.x.

Old FML looks for its libraries in `<gameDir>/lib/` by file name and sha1, not on the classpath. Verify with a real 1.4.7 launch whether the libraries must *also* be placed in `<gameDir>/lib/`.

### 4.3 Format B: legacy installer (`versionInfo`)

1. Download the installer jar.
2. Read `install_profile.json`:
   - `install.filePath` is the name of the universal jar inside the installer;
   - `versionInfo` is a complete version JSON. For 1.7.10 it uses `minecraftArguments` with `--tweakClass cpw.mods.fml.common.launcher.FMLTweaker`, plus `inheritsFrom`, `jar` and the libraries.
3. Find the Forge library in `versionInfo.libraries`: the name starts with `net.minecraftforge:forge` or `net.minecraftforge:minecraftforge`.
   - If it is missing, fail with **BadForgeInstallerJar**.
4. Materialise, in one transaction:
   - extract the universal jar entry to that library's maven path under `<root>/libraries`;
   - write `versionInfo` (with an optional id override and an `inheritsFrom` override) to `versions/<id>/<id>.json`. The id is the installer's, for example `1.7.10-Forge10.13.4.1614-1.7.10`.
5. Download the libraries of the new version. Points specific to this format:
   - Libraries carry `url` (a maven base; old profiles use `http://files.minecraftforge.net/maven/`, Amethyst SHOULD rewrite it to `https://maven.minecraftforge.net/`), `checksums` (a list) and `clientreq`/`serverreq`.
   - The original uses only `checksums[0]`. Forge's own installer accepts a file if it matches **any** listed checksum. Amethyst MUST do the same.
   - Libraries without `url` come from `libraries.minecraft.net`, for example `net.minecraft:launchwrapper:1.12` and `lzma:lzma:0.0.1`.
   - `clientreq`/`serverreq` are ignored, so every listed library is installed and put on the classpath. That matches what the vanilla launcher does with these JSON.
   - Some very old profiles reference `.pack.xz`-only artifacts. At the time of writing the Forge maven serves the plain jars, for example `org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar`. Amethyst need not implement pack200/xz, but SHOULD fall back to Maven Central for `org.scala-lang`/`com.typesafe` artifacts.

### 4.4 Format C: modern installer with processors

This is a multi-stage workflow. One Forge/NeoForge install runs at a time (§1).

**Stage 0: installer.** Download the installer jar (§4.1).

**Stage 1: read and unpack.** Open the jar and locate:

- `install_profile.json` (required);
- `version.json` (required for format C);
- the optional entries:
  - `maven/net/minecraftforge/forge/<v>/forge-<v>.jar`
  - `…/forge-<v>-universal.jar`
  - `…/forge-<v>-shim.jar`
  - `data/client.lzma`
  - `data/server.lzma`
  - `data/run.sh`, `data/run.bat`, `data/unix_args.txt`, `data/win_args.txt`, `data/user_jvm_args.txt`

Then materialise, in one transaction:

1. Extract each present `maven/...` jar to `<root>/libraries/<path minus the leading "maven/">`.
   - Libraries in the profile and `version.json` that have an **empty URL** are expected to be provided this way (Forge installer convention).
   - The original only recognises these three exact Forge paths. Amethyst MUST instead extract **every** entry under `maven/` to the library tree, which also covers NeoForge and future layouts.
2. Extract `data/client.lzma` to the library path of the coordinate `<installerGroup>:<installerArtifact>:<installerVersion>:clientdata@lzma`. Do the same for `data/server.lzma` with `serverdata`. The coordinate is derived from the installer jar's own maven path.
3. Rewrite the profile's `data`:
   - `data.INSTALLER = {client: "[<group>:<artifact>:<version>:installer]", server: same}`;
   - for every side whose `data.BINPATCH` points at an in-jar path that was just extracted (`/data/client.lzma`), replace it with the `[...:clientdata@lzma]` coordinate. Some NeoForge builds ship a single `client.lzma` that both sides reference (21.1.x still ships both files); the mapping is by path, so either layout works.
4. Extract the `data/*` script and argument files into the installer's library directory. They are only used by servers.
5. Write the modified `install_profile.json` to `versions/<id>/install_profile.json`, with `version` set to the final id and `minecraft` filled in. Repair uses this file.
6. Write `version.json` as `versions/<id>/<id>.json`, with the id and `inheritsFrom` overrides. `inheritsFrom` is the base (vanilla id, or the layer below) when composing.

**Stage 2: tool inputs.**

- Collect the resolved `profile.libraries`: the processors' jars and dependencies, each with sha1/size/url.
- For each processor (after side filtering and substitution, below) ask the **processor resolver** whether the launcher can handle it natively. The original handles exactly one:

  > `--task DOWNLOAD_MOJMAPS --version <v> --side <side> --output <path>` (unless `--sanitize` is present): instead of running Java, download `downloads.<side>_mappings` from `versions/<v>/<v>.json` (with url, sha1 and size) directly to `<path>`, and drop the processor.

- Download all of these files.

**Stage 3: run processors.**

1. **Side filter.** A processor with `sides` runs only if the list contains the install side (`client`).
2. **Variables.** Build a per-side table:
   - `SIDE` = `client`;
   - `MINECRAFT_JAR` = `<root>/versions/<profile.minecraft>/<profile.minecraft>.jar`;
   - `MINECRAFT_VERSION` = `profile.minecraft`;
   - `ROOT` = `<root>`;
   - `LIBRARY_DIR` = `<root>/libraries`;
   - every `data` key, with its value for the side transformed like this:
     - `[group:artifact:version[:classifier][@ext]]` becomes the absolute library path;
     - `'literal'` should become the literal **without quotes**. The original does not strip the quotes here. It only works because quoted values are used in `outputs`, where quotes are stripped later. Amethyst MUST strip them.
     - `/path/in/installer` is an entry inside the installer jar. Forge's installer extracts it to a temp file and substitutes that path. The original handles only `BINPATCH` this way (step 3 of stage 1). Amethyst MUST extract any such data entry (to `<root>/libraries/<installer dir>/<entry name>` or a temp dir) and substitute the path.
3. **Arguments.** For each argument:
   - if it is `[coordinate]`, replace it with the library path;
   - then replace every `{NAME}` with the variable's side value.
   - An unknown `{NAME}` becomes an empty string in the original. Amethyst MUST fail the install with a clear error instead. Forge's installer errors too.
4. **Outputs.**
   - The processor's `outputs` map `{path-template: sha1-template}` is substituted the same way, and quotes are stripped from values.
   - If an argument `--output <x>` or `--out-jar <x>` names a file not already listed, `x` is added as an output **without a checksum**.
     - `--output` is skipped when `x` is a directory: it ends with `/`, or equals `ROOT` or `LIBRARY_DIR`, or the task is `BUNDLER_EXTRACT` with `--libraries`/`--all`.
   - Outputs named `*mappings.tsrg` have their checksum **ignored**: later processors legitimately rewrite them.
   - `.jar`/`.zip` outputs get the `zip` validator (it must open and have at least one entry).
5. **Command per processor:**
   - the main class comes from `Main-Class` in the processor jar's `META-INF/MANIFEST.MF`;
     - if the jar cannot be read: **PostProcessBadJar**;
     - if there is no main class: **PostProcessNoMainClass**;
   - the classpath is `processor.classpath` + `processor.jar`, each as a library path, joined with `:`;
   - the command is `java [proxy flags] -cp <cp> <main> <args...>`.
6. **Strategies:**
   1. **Batch.** Run every processor inside one JVM using a tiny helper class. The helper loads each processor in its own class loader and calls its `main`. Each invocation is passed as a base64 string of NUL-separated fields: `main class`, `classpath count`, the classpath entries, then the arguments.
      - This saves one JVM start per processor, roughly 5–10 s on a full Forge install.
      - The helper class file is written to the app data directory before the run and deleted afterwards.
   2. **Fallback.** Run each processor as its own JVM, sequentially.
7. **Skip and validate.**
   - If every processor declares tracked outputs and all of them are already valid, skip stage 3.
   - After a strategy runs, if any output is invalid, delete all outputs and try the next strategy.
   - Failure carries the exit code, the signal, and the first 4 KiB of stderr: **PostProcessFailed**, or **PostProcessValidationFailed** `{file, expect, actual}`.

**Stage 4: final libraries.** Resolve the new version (merged with its parent) and download all of its libraries.

**Version id.** The id comes from `version.json`, for example `1.20.1-forge-47.3.0`, `neoforge-21.1.77`, or `1.12.2-forge-14.23.5.2860`.

### 4.5 Diagnosing a Forge/NeoForge install (used by repair)

If `versions/<id>/install_profile.json` exists, the install is "broken" if any of these fail:

- a profile library fails its sha1;
- a processor output for the client side is missing or fails its sha1;
- a checksum-less `.jar`/`.zip` output does not open as a non-empty zip (the binary patcher can silently emit an empty 22-byte zip when its lzma input is corrupt).

There is one exception: if the **only** problem is a corrupted `mappings.tsrg`, the install is considered fine.

Repair re-runs the whole modern workflow (§4.4) for that Forge/NeoForge version. Already-valid outputs make the processor stage a no-op.

---

## 5. NeoForge

### 5.1 Versioning and listing

These are public facts about the NeoForge maven:

| MC | Maven coordinate | Version form | Example |
|---|---|---|---|
| 1.20.1 | `net.neoforged:forge` | `1.20.1-47.1.<n>` | `1.20.1-47.1.106` |
| 1.20.2 … 1.21.x | `net.neoforged:neoforge` | `<mcMinor>.<mcPatch>.<build>[-beta]`. A missing MC patch counts as `0`. | MC 1.21 → `21.0.x`; MC 1.21.1 → `21.1.x`; MC 1.20.4 → `20.4.x` |
| 26.x (year-based) | `net.neoforged:neoforge` | `<year>.<drop>.<patch>.<build>[-beta]`. A missing MC patch counts as `0`. | MC 26.3 → `26.3.0.97` |
| April-fools/snapshot specials | `net.neoforged:neoforge` | for example `0.25w14craftmine.<n>-beta` | |

**Listing.** `GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge` returns `{isSnapshot, versions:[...]}`. The original filters by the prefix:

- MC `1.A.B` → `A.B.`;
- MC `1.A` → `A.`;
- any other MC version → `<mc>.`.

The `1.A` form is a **bug**: MC 1.21 matches every `21.*` build (1.21.1, 1.21.4 …). For year-based versions, `26.3` likewise matches `26.3.1.*`.

Amethyst's prefix rule:

- `1.A` → `A.0.`;
- `1.A.B` → `A.B.`;
- `Y.N` → `Y.N.0.`;
- `Y.N.P` → `Y.N.P.`.

For 1.20.1, list `net/neoforged/forge` (same API path with `forge`) and keep the versions starting `1.20.1-`.

### 5.2 Install

1. Determine the project:
   - if the version starts with `47.` or `1.20.1-47.`, the project is `forge` and the published version is `1.20.1-<v>` (unless the prefix is already present);
   - otherwise the project is `neoforge`.
2. Installer URL: `https://maven.neoforged.net/releases/net/neoforged/<project>/<v>/<project>-<v>-installer.jar`.
3. Before downloading:
   - fetch `<url>.sha1`. Accept either a bare 40-hex digest or `<digest>  <filename>`;
   - `HEAD` the URL for `Content-Length`.
   - Both are optional. If they are unavailable, the download proceeds unverified, with the `zip` validator only.
   - Amethyst SHOULD refuse to run processors from an unverified installer unless the user confirms. This is a security consideration: the installer's tools run as code.
4. Local path: `<root>/libraries/net/neoforged/<project>/<v>/<project>-<v>-installer.jar`.
5. Run the same workflow as §4.4.

NeoForge's `version.json` carries `--fml.neoForgeVersion` in its game arguments, which is how installed versions are recognised (§9).

---

## 6. Fabric

1. **Lists:**
   - `GET /v2/versions/loader` gives `[{separator, build, maven, version, stable}]`;
   - `GET /v2/versions/game` gives `[{version, stable}]`;
   - per game version: `GET /v2/versions/loader/<mc>`.
2. **Profile.**
   - Download `GET /v2/versions/loader/<mc>/<loader>/profile/json` to a checkpoint file `<root>/versions/.install/fabric-<mc>-<loader>-client.json` (validator `json`, `replace`).
   - The profile is a ready-made version JSON:
     - `id` (for example `fabric-loader-0.16.14-1.21.4`);
     - `inheritsFrom: <mc>`;
     - `mainClass: net.fabricmc.loader.impl.launch.knot.KnotClient`;
     - `arguments.jvm` (for example `-DFabricMcEmu= net.minecraft.client.main.Main `);
     - `libraries`: name, maven `url`, and `md5`/`sha1`/`sha256`/`sha512`/`size`.
3. **Write the version.**
   - Override the `id`:
     - with no base layer: `<mc>-fabric<loader>`, for example `1.21.4-fabric0.16.14`;
     - when stacked on another layer: `<base>-fabric<loader>`, and `inheritsFrom` is set to the base.
   - Write it to `versions/<id>/<id>.json`, then delete the checkpoint.
4. **Libraries** are downloaded in the final libraries pass (§3.1 step 4). They use the legacy-library code path (`launch.md` §4.2 case 4), with URL = `url + maven path`.

   > The original ignores the per-library `sha1`/`size` that Fabric publishes, so Fabric libraries are only checked for "is a non-empty zip". Amethyst MUST use them.

Fabric does not need the client jar or Java at install time. It can run while the jar is still downloading.

---

## 7. Quilt

This is identical to Fabric, with these differences:

- the meta base is `https://meta.quiltmc.org`, with **v3** paths: `/v3/versions/loader`, `/v3/versions/game`, `/v3/versions/loader/<mc>/<loader>/profile/json`;
- the checkpoint is `versions/.install/quilt-<mc>-<loader>-client.json`;
- the id is `<mc>-quilt<loader>` (or `<base>-quilt<loader>`).

Quilt meta exposes `hashes.sha1` and `file_size` on loader entries; use them when present.

---

## 8. OptiFine

### 8.1 Version list and download source (original)

The version list and the download come only from BMCLAPI (`/optifine/versionList` and `/optifine/<mc>/<type>/<patch>`), a third-party mirror that is **out of scope** for Amethyst.

- When the user's settings forbid mirrors, the original *lists* versions by loading `https://optifined.net/downloads` in a hidden browser window (desktop Chrome user agent, 15 s timeout, window pooled for 60 s) and scraping it. Note the domain: `optifined.net` is not the official `optifine.net`; its links point to `optifine.net`.
- The download then fails with **OptifineNoMirrorError** ("OptiFine can only be downloaded from the BMCLAPI mirror").

The scraper reads:

- `h2` headings → MC version, with the `Minecraft ` prefix removed;
- per table row:
  - `.colFile` → name `OptiFine HD U I5` → type `HD_U`, patch `I5` (the rest joined with `_`);
  - `.colForge` → the compatible Forge build, with the `Forge ` prefix removed;
  - `.colMirror a@href` → the mirror page URL.
- On the mirror page (`adloadx?f=…`), the real link is the anchor matching `downloadx?f=…&x=…` (a short-lived token).

### 8.2 Amethyst source decision

OptiFine has no API, no checksums, and download links are HTTP with a short-lived token. Amethyst MUST pick one of the following and treat it as a product decision:

1. **User-supplied jar (recommended baseline).** The user drags in an `OptiFine_<mc>_HD_U_<patch>.jar` downloaded in their browser. Amethyst identifies it by reading `net/optifine/Config.class` (§8.3).
2. **Official site flow.** Open `https://optifine.net/downloads` (HTTPS) in a visible or hidden window and follow `adloadx` → `downloadx` exactly as above.
   - Pin the host to `optifine.net`.
   - Upgrade to HTTPS.
   - Treat the file as untrusted until it passes the §8.3 identity check.
   - Show the user that it came from optifine.net.
   - Never use look-alike domains.

### 8.3 Installing as a library ("OptiFine as a version layer")

**Inputs:** the OptiFine jar (the original stores it at `<root>/libraries/optifine/OptiFine/<mc>_<type>_<patch>/OptiFine-<mc>_<type>_<patch>-universal.jar`), the Java executable, and optionally a base version (Forge).

1. Open the jar and find the config class: `net/optifine/Config.class`, `Config.class` (older) or `notch/net/optifine/Config.class`.
   - If none exists: **BadOptifineJar**.
2. Parse the class file's **constant fields** `MC_VERSION` (for example `1.12.2`), `OF_EDITION` (`HD_U`) and `OF_RELEASE` (`G5`). These are `static final String` constants with a ConstantValue attribute, so a minimal class-file reader is enough. `editionRelease = OF_EDITION + "_" + OF_RELEASE`.
3. If `launchwrapper-of.txt` exists, its content is the OptiFine LaunchWrapper version `L`, and `launchwrapper-of-<L>.jar` is inside the jar.
4. Generate the version JSON:
   - `id` = `<mc>-Optifine_<editionRelease>`;
   - `inheritsFrom` = `<mc>`;
   - `type` = `release`;
   - `mainClass` = `net.minecraft.launchwrapper.Launch`;
   - `minimumLauncherVersion` = 21;
   - `arguments.game` = `["--tweakClass", "optifine.OptiFineTweaker"]`, or `optifine.OptiFineForgeTweaker` when installing over Forge;
   - `arguments.jvm` = `[]`;
   - `libraries` = `[ optifine:launchwrapper-of:<L> | net.minecraft:launchwrapper:1.12 , optifine:Optifine:<mc>_<editionRelease> ]`.
5. Materialise:
   - the version JSON;
   - the extracted `launchwrapper-of-<L>.jar` to `libraries/optifine/launchwrapper-of/<L>/launchwrapper-of-<L>.jar`, if present.
6. Run the **patcher** (a java task):

   ```
   java -cp <optifine jar> optifine.Patcher <root>/versions/<mc>/<mc>.jar <optifine jar> <root>/libraries/optifine/Optifine/<mc>_<er>/Optifine-<mc>_<er>.jar
   ```

   The output must be a valid zip. The task is skipped if the output already exists and is valid.
7. **Stacking on a base** (for example Forge):
   - re-read the generated JSON;
   - set `inheritsFrom = <base>` and `id = <base>-Optifine-<mc>_<type>_<patch>`;
   - if the base contains a Forge library, replace the game arguments with `--tweakClass optifine.OptiFineForgeTweaker` and copy the base's `mainClass`;
   - if the base is Fabric, the original only logs a warning ("might not work").
   - Write the result as a new version.

macOS note: `libraries/optifine/OptiFine/` (the installer download) and `libraries/optifine/Optifine/` (the patched output) differ only by case. On the default case-insensitive APFS volume they are **the same directory**. That works only because the file names differ. Amethyst SHOULD use one canonical casing.

### 8.4 Installing as a mod

For Forge, or Fabric with OptiFabric: copy the OptiFine jar into `<gameDir>/mods/OptiFine-<mc>_<type>_<patch>.jar` (validator `zip`).

---

## 9. Composing an instance version (layers)

An instance declares a runtime, for example:

```json
{ "minecraft": "1.20.1", "forge": "47.3.0", "optifine": "HD_U_I6" }
```

The full set of fields is `minecraft` plus optional `forge` | `neoForged` | `fabricLoader` | `quiltLoader` | `optifine`.

**Recognising installed versions.** A resolved version's identity ("header") is derived from its libraries and arguments:

| Field | Derived from |
|---|---|
| `minecraft` | `minecraftVersion` |
| `forge` | The version of `net.minecraftforge:{forge,fmlloader,minecraftforge}`, minus the MC prefix |
| `neoForged` | The value after `--fml.neoForgeVersion` in the game arguments; or, when a `net.neoforged.fancymodloader` library is present, `<mc>-<--fml.forgeVersion value>` |
| `fabric` | The version of `net.fabricmc:fabric-loader` |
| `quilt` | The version of `org.quiltmc:quilt-loader` |
| `optifine` | The version of `optifine:Optifine`/`OptiFine`, minus the part before the first `_` |

A local version **matches** a runtime when:

- the MC versions are equal;
- **each** loader field is either set and equal on both sides, or absent on both sides.

Forge comparison tolerates the `<mc>-` prefix and the `-<mc>` suffix.

**Order of layers** for a fresh install:

1. `forge` **or** `neoForged` (mutually exclusive, Forge first).
2. Then `optifine` (on top of Forge/NeoForge or vanilla), **else** `fabricLoader`, **else** `quiltLoader`.
   - Fabric and Quilt layers are created only when there is no Forge/NeoForge.
   - OptiFine plus Fabric is not composed as a layer; that combination is "OptiFine as a mod" (§8.4).

For each layer:

- if a local version already matches the runtime *up to that layer*, the layer is "use existing";
- otherwise the layer is installed with the previous layer's id as its base.
  - When the base is plain vanilla, no explicit base is passed and the installer's own `inheritsFrom` is kept.

Forge, NeoForge and OptiFine layers wait for the client jar, the vanilla libraries and Java (§3.1). Fabric and Quilt do not.

---

## 10. Pre-launch diagnose and repair

### 10.1 Entry point (original `installInstance`)

1. **Pick a local version.**
   - If the instance names a version id and that version matches the runtime, use it.
   - Otherwise use the first local version that matches.
2. **If a local version is found:**
   - Resolve it.
     - If its JSON is missing, forget it and do a fresh install.
   - Diagnose it (§10.2).
   - If there is no issue, return immediately.
   - Otherwise run a **repair** (§10.3).
3. **If none is found:** do a fresh install (§3 + §9).
4. In every successful case, write `.install-lock` (repairs included) and return the version id.

Diagnoses are cached for 30 s per `side:version`, and per-file checksums are deduplicated while running. Both caches are cleared when any install starts or ends.

### 10.2 Diagnosis

The diagnosis takes the `.install-lock` timestamp. A file with mtime ≤ timestamp is trusted, except for the client jar, which the installer always hashes.

| Check | Rule | Issue recorded |
|---|---|---|
| Client jar | Exists and sha1 matches `downloads.client.sha1` | `jar` |
| install_profile | §4.5 | `profile` |
| Libraries with a sha1 | sha1 must match | collected |
| Libraries without a sha1 | Must open as a zip and every entry must be walkable | collected |
| Libraries in the `optifine` group | — | `optifine = <version>` |
| `net.minecraftforge:forge` with classifier `client` or none | — | `forge = {minecraft, version}` |
| All other libraries | — | `libraries` |
| Asset index (`<sha1>.json`) | Must match its sha1 | `assetsIndex` (the objects are not checked then) |
| Asset objects, normal mode | **Size only**. Hashing happens only when the size differs, or when a timestamp exists and the file is newer than it. | `assets` |
| Asset objects, strict mode | Full hash | `assets` |

**The "strict" flag is inverted for libraries** (Pitfalls): strict mode does a size-only check, and normal mode hashes.

### 10.3 Repair

This is a targeted fix with the same parallelism as a fresh install:

- **`jar`:** re-download the client jar.
- **`libraries`:** re-download those libraries, except OptiFine and Forge client libraries, which are rebuilt by their installers below.
- **`assetsIndex`:** re-download the index and then all objects.
- **`assets` only:** re-download just those objects.
- **`profile`:**
  - if the runtime is Forge or NeoForge, re-run that installer workflow;
  - otherwise run the profile workflow alone (stages 2–4 of §4.4) with the stored `install_profile.json`.
- **`optifine`:** re-run the OptiFine install.
- **`forge` with no profile:** re-run the Forge install.
- Afterwards, if the final id changed or the profile was rebuilt, run a final libraries pass.

"Reinstall" (user-triggered) is diagnose in strict mode with no timestamp, followed by repair.

---

## 11. Resume, verification and skip semantics (summary)

| Item | Skipped when | Verified by | Notes |
|---|---|---|---|
| Version JSON | It resolves locally | Parsing only (original). Amethyst: v2 manifest sha1. | `replace` on download, so a broken file is never trusted. |
| Client jar | sha1 matches | Always a full sha1 | Validator `zip`. |
| Library with sha1 | mtime ≤ lock timestamp, or sha1 matches | sha1 | |
| Library without sha1 | mtime ≤ lock timestamp, or the size equals the known size, or it is a non-empty file that opens as a zip | Zip open | |
| Asset object | Size equals the expected size (trusted), or the sha1 matches | sha1 on new downloads | |
| Asset index / log config | mtime ≤ lock timestamp, or sha1 matches | sha1 | |
| Forge installer | sha1 matches when known, else the zip opens | sha1 / zip | |
| Processor stage | Every declared output is valid | sha1 / zip / non-empty | Not skippable when a processor has only directory outputs. |
| OptiFine patch | Output zip is valid | Zip | No checksum available. |
| Fabric/Quilt profile | Never (always re-fetched) | JSON parse | Only the version JSON write is idempotent. |

**Resume** is at **file granularity**. An interrupted install leaves completed files, which the next run accepts by checksum or size. Partially downloaded files are discarded (see `download.md` §4.2: no `.part` resume). Materialise steps are transactional, so a crash leaves either the old state or the new one, plus stray `*.install-*`/`*.backup-*` files that nothing cleans up (Pitfalls).

Amethyst additions:

- On startup, delete stray `*.install-<pid>-*` and `*.backup-<pid>-*` files whose pid is not running.
- For a requested Minecraft id that is missing from the cached manifest, refresh the manifest before failing.

---

## 12. Pitfalls / bugs observed in the original

1. **The Forge artifact version is guessed.** The minor-7/8 suffix rule produces 404s for builds such as `1.8-11.14.4.1577`, `1.7.10-10.13.0.1150` and `1.10.2-12.18.0.2001-1.10.0`. Use `maven-metadata.xml`.
2. **Universal-only Forge is handled only for `1.4.*`.** 1.1–1.3.x and 1.5.0–1.5.1 (universal only, per `meta.json`) try a non-existent installer.
3. **The Forge version list is scraped from HTML.** It is fragile and slow. Public JSON/XML exists (§2.2).
4. **The NeoForge prefix bug.** MC `1.21` lists every 21.x build, and `26.N` lists `26.N.P` builds of later patches. 1.20.1 NeoForge is not listed from the official source at all, only via the mirror.
5. **Installer `maven/` extraction is hard-coded to three Forge paths.** Any other embedded artifact (other NeoForge layouts, future installers) is never extracted. Libraries with empty URLs then fail to download.
6. **Processor data handling is incomplete:**
   - quoted `'literal'` data values keep their quotes;
   - `/path` data values other than BINPATCH are passed as raw in-jar paths;
   - unknown `{VAR}` silently becomes an empty string.

   Each of these makes a future installer fail with a confusing tool error rather than a clear one.
7. **Fabric/Quilt library hashes are ignored** (only `checksums[0]` is read, a legacy field). Legacy Forge `checksums` beyond the first are ignored too.
8. **No integrity check on the version JSON** (v1 manifest, no sha1). A truncated-but-valid JSON or a tampered one is accepted.
9. **The NeoForge installer may be unverified.** If the `.sha1` sidecar or the HEAD request fails, the installer jar, whose tools are executed, is accepted on a zip check alone. Forge installers without a scraped sha1 are the same. Together with the TLS-verification issue in `download.md`, this is a code-execution risk.
10. **The strict/non-strict flag is inverted for libraries.** "Reinstall" (strict) checks libraries by size only, while the normal pre-launch path hashes them. Reinstall is therefore *weaker* than a normal diagnose for libraries.
11. **Asset objects are trusted by size.** A corrupted asset of the right size is never repaired unless the user forces a strict diagnose.
12. **The stale-while-revalidate cache can hide brand-new versions** on the first try (§2.1).
13. **One Forge/NeoForge install at a time, launcher-wide** (global libraries lock). Two instances installing different Forge versions are serialised.
14. **OptiFine cannot be installed at all without the third-party mirror.** The version-list fallback scrapes a look-alike domain (`optifined.net`) instead of `optifine.net`.
15. **OptiFine paths differ only by case** (`OptiFine/` vs `Optifine/`). They collide on case-insensitive APFS. It works only because the file names differ.
16. **The Fabric/Quilt checkpoint file is always re-downloaded** (`replace`). This is harmless but means installs need the network even when the version already exists, except when the layer is "use existing".
17. **Leftover materialise temp and backup files** (`*.install-*`, `*.backup-*`) after a crash or kill are never cleaned up.
18. **Repair's `forge` issue detection** keys on `net.minecraftforge:forge` with classifier `client` or none. Any processor-produced artifact that a version JSON lists as a library with no URL falls into the generic `libraries` bucket instead. Repair then tries to *download* it in parallel with the profile re-run, and fails. Current NeoForge (21.x) JSON does not list its `:client` artifact, so this hits only older or third-party JSON. Amethyst MUST classify "library with no URL that is a processor output" as a `profile` issue.
19. **The legacy-installer `jar` field is ignored**, and `clientreq`/`serverreq` are ignored. This is acceptable today, but document it.
