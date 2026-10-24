# Spec: Instance Resources (mods, resource packs, shader packs, saves)

Status: draft, clean-room behavioural spec
Target: Amethyst (Electron + React, macOS 13+ arm64 only)
Related specs: `instances.md` (instance layout and runtime versions), `marketplace.md` (Modrinth and CurseForge API usage), `modpacks.md` (bulk install through manifests)

This document says what the resource subsystem must do. It does not say how the reference launcher's code is organised. Where this spec describes the reference launcher's behaviour, it does so to explain a design choice or to warn about a bug. Amethyst is free to (and in several places should) do it differently.

---

## 1. Scope and vocabulary

| Term | Meaning |
|---|---|
| **Domain** | A category of instance content that lives in a fixed sub-folder of the instance's game directory: `mods`, `resourcepacks`, `shaderpacks`, `saves`. (Datapacks live inside a save, see §11.6.) |
| **Resource** | One file (or, for packs, one folder) in a domain folder that the launcher recognises and indexes. |
| **Placement** | The fact that a resource with content hash *H* exists at path *P*. One hash can have many placements, for example the same mod in five instances. |
| **Store** | Amethyst's content-addressed blob directory. Section 5 explains why the reference launcher has no such store. |
| **Index** | The persistent database (SQLite) that holds hashes, parsed metadata, marketplace attribution and placements. |
| **Source / attribution** | The marketplace identity of a file. For Modrinth this is `{projectId, versionId}`. For CurseForge it is `{projectId (modId), fileId}`. |

Out of scope for this spec: schematic/blueprint browsing, the shared-world "link save as dedicated-server world" feature (server hosting is dropped), mod groups/folders as a UI organisation feature (optional, see Appendix B), and the community "project mapping" database that the reference launcher downloads from its own infrastructure (dropped).

---

## 2. Functional requirements (summary)

1. List the contents of each domain folder of the active instance. Every entry shows a parsed name, version, icon, description, authors, loader(s), enabled state and marketplace attribution.
2. Keep that list live. Files added, removed, renamed or replaced outside the launcher (in Finder, by the game, or by another tool) must appear within about 1 second, without a manual refresh.
3. Install files into an instance from local paths (drag-and-drop or file picker) and from the marketplace. Content that is already on disk is de-duplicated by hash.
4. Enable and disable mods by renaming them with a `.disabled` suffix. Enable and disable resource packs and shader packs by editing the game's options files, because the game decides which packs are active.
5. Uninstall (delete) resources.
6. Attribute local files to Modrinth/CurseForge projects by hash: SHA-1 for Modrinth, the murmur2 fingerprint for CurseForge.
7. Check for updates and produce an upgrade plan.
8. Check dependencies: local mod-id compatibility, missing required dependencies, and dependency trees for marketplace installs.
9. Saves: list them with `level.dat` metadata, and support rename, duplicate, delete, import (folder or zip), export (zip or folder), backup and restore, plus per-save datapacks.
10. Surface broken files (corrupt zip, unreadable) per path, without repeating the same notification on every refresh.

---

## 3. On-disk layout

### 3.1 Instance folders (owned by the game)

```
<instance>/
  mods/                 *.jar, *.jar.disabled, (legacy) *.litemod, *.zip
  resourcepacks/        *.zip or folders containing pack.mcmeta
  shaderpacks/          *.zip or folders containing shaders/
  saves/<world>/        level.dat, icon.png, region/, datapacks/, ...
  options.txt           contains the resourcePacks:[...] list (enabled packs + order)
  optionsshaders.txt    OptiFine: shaderPack=<name>
  config/iris.properties     Iris: shaderPack=<name>, enableShaders=true|false
  config/oculus.properties   Oculus (Forge port of Iris): same keys
```

The launcher must never require these folders to exist. It creates a domain folder only when it first writes to it (or when it first starts watching it).

### 3.2 Launcher data (owned by Amethyst)

Recommended layout under `~/Library/Application Support/Amethyst/`:

```
index.sqlite                 resource index (WAL mode)
store/sha1/<aa>/<sha1>       content-addressed blobs (§5)
icons/<sha1-of-image>        content-addressed icon cache, served via a custom protocol
shared/resourcepacks/        optional global pools (§5.5)
shared/shaderpacks/
shared/saves/
backups/<instance-id>/<world>/<timestamp>.zip   world backups (§11.5)
```

Keep the index database in the app-data folder, not inside a user-movable "game data" folder. The reference launcher made the same choice. Its rows held absolute (or root-relative) paths that become stale if the data root moves, so the index is treated as a rebuildable cache, not a source of truth.

---

## 4. Hashing

### 4.1 SHA-1 (primary identity)

- Every regular file is identified by the lowercase hex SHA-1 of its bytes. This is the key Modrinth's hash endpoints accept, and CurseForge also reports it (`hashes[].algo == 1`).
- Stream-hash files. The reference launcher read files under about 1.3 MB fully into memory and streamed larger ones. That is an implementation detail.
- Hash on a worker thread or in a utility process (`worker_threads`), never in the Electron main thread. Hashing and parsing use a bounded concurrency pool. The reference used 64 concurrent hash jobs and 16 parse jobs per watched folder, which is too many for the file-descriptor limit unless retries exist. Recommendation: 8 to 16 concurrent hashes on Apple Silicon. Prioritise the currently visible domain: mods first, then resource packs, then shader packs.
- **Also compute SHA-512 lazily.** Modrinth's `.mrpack` index provides SHA-512 and Modrinth's hash endpoints accept `algorithm=sha512`. Compute it when importing an mrpack or when exporting one, then store it next to SHA-1.

### 4.2 Folder resources

Unpacked resource and shader packs are folders. The reference launcher gave a folder a pseudo-hash: SHA-1 over the recursive file names plus their modification times, skipping `.DS_Store`. This is not a content hash. It changes whenever any file is touched, and it never matches a marketplace hash. Amethyst should:

- treat folders as *unhashed* resources keyed by path;
- never send folder pseudo-hashes to a marketplace;
- re-read `pack.mcmeta`/`pack.png` when the folder's top-level mtime changes.

### 4.3 CurseForge fingerprint (murmur2)

CurseForge identifies files by a 32-bit "fingerprint". The public API accepts it at `POST /v1/fingerprints/{gameId}` (documented at <https://docs.curseforge.com/rest-api/#get-fingerprints-matches>). The algorithm is the public-domain MurmurHash2 (Austin Appleby), 32-bit variant, with these normalisation rules:

1. Read the entire file as bytes.
2. **Remove** every byte equal to `0x09` (tab), `0x0A` (LF), `0x0D` (CR) or `0x20` (space). Remove them everywhere in the file, including binary data inside the jar. This is not trimming.
3. Run MurmurHash2-32 over the remaining bytes with **seed = 1**. Use the standard constants `m = 0x5BD1E995` and `r = 24`. The initial hash is `seed XOR length`, where `length` is the length **after** whitespace removal. Process 4-byte little-endian blocks, then the 1 to 3 tail bytes, then the final avalanche (`h ^= h >>> 13; h *= m; h ^= h >>> 15`).
4. Treat the result as an **unsigned** 32-bit integer and send it as a JSON number. Never send a negative value. Do all multiplications with 32-bit wrap-around (`Math.imul` in JS).

Implementation notes:

- The input length must be known before hashing starts. Either buffer the whole file (simple, and fine for files up to a few hundred MB) or make two streaming passes (count non-whitespace bytes, then hash).
- Compute fingerprints for every non-folder file in mods, resource packs, shader packs and world zips. CurseForge fingerprints all project files.
- Add a unit-test vector set. Generate it from a known-good public implementation (for example, the CurseForge-compatible implementations in open-source tools such as packwiz) and from real files with known `fileFingerprint` values returned by the API.
- Cache the fingerprint in the index next to SHA-1. It is expensive, and the hash never changes for given bytes.
- Never send an empty array, zero or non-finite values. CurseForge answers HTTP 400 "Fingerprints are required." The reference launcher hit this at scale.

### 4.4 Snapshot validity (avoid re-hashing)

To avoid re-hashing unchanged files on every launch, cache `(path → {inode, size, mtimeMs, sha1})`. A cached hash is reused only if inode, size **and** mtime all match. The reference compared only inode and "cached mtime ≥ current mtime", and ignored size. This misses in-place rewrites that preserve mtime. If they differ, re-hash.

Hard links share an inode. When one placement is re-hashed, the result applies to every placement with the same inode.

---

## 5. Content-addressed store and links

### 5.1 What the reference launcher does

The reference launcher has **no dedicated blob store**. Its approach is:

- Files live directly in instance folders.
- A path snapshot table maps every known file path (relative to the launcher's data root) to its inode, mtime, detected type and SHA-1.
- **De-duplication at install time.** Before downloading a marketplace file whose SHA-1 is known (or derivable from a recorded download URI), it looks for an existing placement with that hash anywhere under the data root, re-verifies that file's hash, and **hard-links** it into the destination. It downloads only when no placement is found.
- Local imports from outside the instance are hard-linked into the domain folder, with a 1.5 s timeout. On timeout or a cross-device error (`EXDEV`) it falls back to a byte copy.
- Resource packs, shader packs and saves can optionally be pooled. The instance's whole domain folder is replaced by a **directory symlink** to a global shared folder. When it links, existing files are merged into the pool, and name clashes get a `-<timestamp>` suffix.
- Before launch, any resource pack named in `options.txt` (and the active shader pack) that is missing from the instance folder but exists in the global pool is hard-linked into the instance.

The weakness of this design: when the last placement of a hash is deleted, the content is gone. A later re-install must download again, and there is no garbage-collection concept.

### 5.2 Amethyst store design (recommended)

```
store/sha1/<first two hex chars>/<full sha1>     immutable blob, mode 0444
```

Rules:

1. **Ingest.** Write the downloaded or imported bytes to `store/tmp/<random>` and verify the hash against the expected value. Then `rename` into place atomically. If the target already exists, discard the temporary file.
2. **Place.** Materialise the blob at `<instance>/<domain>/<fileName>` with **APFS clonefile**: Node's `fs.copyFile(src, dst, fs.constants.COPYFILE_FICLONE)`, which on macOS maps to `clonefile(2)`. This gives copy-on-write behaviour with no extra disk usage, and the two files are independent. If the instance is on another volume or the volume is not APFS, fall back to a plain copy.
   - Do not hard-link by default. A hard link shares the inode, so a mod or tool that rewrites a jar in place (rare, but some updaters do it) silently corrupts the store and every other instance. Also, macOS Finder's "Get Info" sizes and Time Machine handle hard links in surprising ways.
   - **Do not symlink individual mod jars.** Java module/jar loaders in Forge/NeoForge have had bugs with symlinked mod files, and some mods resolve their own path.
3. **Record** the placement in the index (`path, sha1, inode, size, mtimeMs`).
4. **Garbage collection.** A blob is collectable when no placement references it and it has not been referenced for N days (default 14). Run GC on demand and at most weekly in the background. Never collect blobs that an in-progress install refers to. Clones do not keep link counts, so placements are the only reference truth. This is why the placement table must be updated by the folder watcher (§8) as well as by launcher operations.
5. **Reuse on install.** Before downloading, look up the expected SHA-1 (from the Modrinth version file, the CurseForge `hashes`, or the mrpack index) in the store. Before trusting an existing blob, re-verify size and, optionally, the hash.
6. **Files the user drops into a folder by hand** do not need to go into the store immediately. They are indexed in place. A "compact storage" maintenance action may later ingest them.

### 5.3 Name collisions on placement

- Sanitise the destination file name. Remove path separators, NUL, `:` and leading dots. Clamp the length to 255 bytes UTF-8. Never use a marketplace-provided file name unsanitised. A malicious `fileName` such as `../../x.jar` must not escape the domain folder.
- If `<domain>/<name>` already exists with the **same** hash, the operation is a no-op. If it exists with a **different** hash, replace it only when the operation is an explicit update of that file. Otherwise write `<stem> (2).<ext>`.
- Downloads go to `<dest>.part` (Amethyst) and are renamed into place only after the hash is verified. The watcher must ignore `*.part`. The reference used a `.pending` suffix for the same reason.

### 5.4 Uninstall

Uninstalling deletes the placement (file) and the placement row. The blob stays until GC. Reject (and log) any path that resolves outside `<instance>/<domain>/`. If deletion fails (file busy, permission denied), revalidate the folder so the UI shows reality.

### 5.5 Shared pools (optional, low priority)

Mirror the reference feature only if users ask for it. In that mode an instance's `resourcepacks`, `shaderpacks` or `saves` folder can be a directory symlink to `shared/<domain>`:

- **Link:** if the folder is missing, create the symlink. Otherwise move each entry into the pool (use `<name>-<epoch ms>.<ext>` on collision; delete entries that were themselves symlinks), remove the folder, then create the symlink.
- **Unlink:** remove the symlink and create an empty real folder. The content stays in the pool.
- Detection compares the resolved link target with the pool path.
- Saves pooling is risky: two instances running different game versions can upgrade a world irreversibly. If you implement it, show a warning.

---

## 6. The index (SQLite)

### 6.1 Requirements

- One database file, WAL journal mode, owned by the main process (or a dedicated utility process). The renderer never opens it.
- **Self-healing.** If opening or migrating fails with a corruption-class error ("file is not a database", "database disk image is malformed", "no such table", "unable to open"), rename the file to `index.sqlite.<epoch>.bak` and start fresh. Retry up to 3 times. The index is a cache: everything in it can be rebuilt by re-scanning and re-querying marketplaces, except user-only data (see 6.3).
- **Parser-version column.** Every parsed-metadata row records the version of the parser that produced it. Raising the parser version marks rows stale so they are re-parsed lazily. The reference launcher instead needed one-off migrations to wipe cached parse errors after it upgraded its zip reader. Avoid that.
- Validate attribution before writing it. A Modrinth id is 8 characters of `[0-9A-Za-z]`. CurseForge ids are positive integers. Reject anything else. In the reference, file paths leaked into the version-id column, and one bad id makes Modrinth reject a whole batch with HTTP 400.

### 6.2 Suggested schema (Amethyst's own design)

| Table | Columns | Notes |
|---|---|---|
| `blobs` | `sha1` PK, `sha512` NULL, `size`, `murmur2` NULL, `kind` (`mod`/`resourcepack`/`shaderpack`/`world`/`unknown`), `display_name`, `meta_json` (normalised metadata, §7), `icon_ref` NULL, `parser_version`, `parse_error` NULL, `parsed_at` | One row per distinct content |
| `placements` | `path` PK (absolute, NFC-normalised), `sha1` NULL (NULL for folders), `inode`, `size`, `mtime_ms`, `instance_id`, `domain`, `last_seen_at` | Rebuilt by scans |
| `sources` | `sha1`, `platform` (`modrinth`/`curseforge`), `project_id`, `version_id` (Modrinth version id or CF file id as text), `resolved_at`, `confidence` (`hash`/`manual`/`manifest`) | PK `(sha1, platform)` |
| `lookups` | `sha1`, `platform`, `checked_at`, `found` (bool) | Negative cache, so unmatched files are not re-queried on every open (§9.4) |
| `icons` | `image_sha1` PK, `mime`, `width`, `height` | Files live in `icons/` |

The reference stored marketplace attribution, generic "uris" (such as `modrinth:<project>:<version>`, `curseforge:<mod>:<file>`, `fabric:<id>:<version>`, and download URLs) and icons in side tables keyed by SHA-1, and kept one JSON column per loader type. Amethyst does not need the URI table if `sources` and the store exist.

### 6.3 Data that must survive index loss

Anything that is user intent (pinned versions, "ignore update for this mod", per-file notes) must **not** live only in `index.sqlite`. Put it in the instance's own metadata file (see `instances.md`) so it survives index resets and travels with exported instances.

---

## 7. Metadata parsing

### 7.1 General rules

- Parse on a worker. Open jar or zip files with a tolerant zip reader. It must accept ZIP64 single-disk archives, archives with a slightly malformed end-of-central-directory comment length, and archives with data before the first local header (some packs are concatenated or self-extracting). The reference had to fork its zip library to accept ZIP64 and lenient-EOCD archives, which tools like PackSquash produce.
- Strip a leading UTF-8 BOM (`U+FEFF`) from every text metadata file before parsing.
- One file can carry **several** loaders' metadata. Common cases are a jar with both `fabric.mod.json` and `META-INF/mods.toml` (Architectury/multi-loader builds), and a Quilt jar that also ships `fabric.mod.json`. Run every applicable parser and keep each successful result under its own key. Do not stop at the first success.
- A parser that finds nothing is not an error. A file whose zip cannot be opened **is** an error (§7.9).
- Icons are extracted as raw bytes, stored content-addressed in `icons/`, and exposed to the renderer through a custom protocol such as `amethyst-icon://<sha1>`. Raw bytes must not travel over IPC.

Which parsers run, by domain and extension:

| Domain | Accepted names | Parsers |
|---|---|---|
| mods | `*.jar`, `*.zip`, `*.litemod`, each optionally followed by `.disabled` | Fabric, Quilt, Forge (mods.toml), NeoForge (neoforge.mods.toml), legacy Forge (mcmod.info / manifest / bytecode), LiteLoader (optional) |
| resourcepacks | `*.zip`, folders | resource pack |
| shaderpacks | `*.zip`, folders | shader pack |

Ignore files ending in `.part`, `.pending`, `.tmp`, `.DS_Store`, `.backup`, `.gitkeep`, `.gitignore`, `.rartemp` or `.txt`. Also ignore any file whose extension (after stripping `.disabled`) is not on the domain's accepted list. Mods leave `.toml`, `.json`, `.cfg` and `.properties` files in these folders, and the reference showed noisy "cannot read" errors for them until it added this rule. Hidden files (leading `.`) are ignored.

### 7.2 Fabric: `fabric.mod.json`

Spec: <https://wiki.fabricmc.net/documentation:fabric_mod_json_spec>. Location: the jar root.

Fields to extract:

```json
{
  "schemaVersion": 1,
  "id": "examplemod",
  "version": "1.2.3+mc1.20.1",
  "name": "Example Mod",
  "description": "...",
  "authors": ["Alice", {"name": "Bob", "contact": {}}],
  "contact": {"homepage": "...", "issues": "...", "sources": "..."},
  "license": "MIT",
  "icon": "assets/examplemod/icon.png",
  "environment": "*",
  "depends": {"fabricloader": ">=0.15", "minecraft": "~1.20.1", "fabric-api": "*"},
  "recommends": {}, "suggests": {}, "breaks": {}, "conflicts": {},
  "provides": ["example_alias"],
  "jars": [{"file": "META-INF/jars/lib.jar"}]
}
```

Behaviour:

- Parse leniently. Fabric Loader's own reader tolerates things that strict `JSON.parse` rejects, so real mods ship such files. Escape raw control characters inside strings before retrying a failed parse.
- `authors` and `contributors` entries are either strings or `{name}` objects. Some mods wrongly use a single string instead of an array, so normalise both shapes. `license` is a string or an array.
- `icon` is either a path string or an object mapping size to path. For the object form, pick the largest size of at most 256, or else the largest available.
- `environment` is `"*"`, `"client"` or `"server"`, and defaults to `"*"`. It maps to the side badge (§7.10).
- **Nested jars.** For each `jars[].file`, read the nested jar's own `fabric.mod.json` (one level deep is enough, two is better) and record those ids as *provided* mod ids. This matters for dependency checks, because Fabric API bundles dozens of modules. The top-level mod remains the "primary" entry.
- Version strings may be non-semver. Keep them verbatim.

### 7.3 Quilt: `quilt.mod.json`

Spec: <https://github.com/QuiltMC/rfcs/blob/main/specification/0002-quilt.mod.json.md>.

```json
{
  "schema_version": 1,
  "quilt_loader": {
    "group": "org.example",
    "id": "example_mod",
    "version": "1.0.0",
    "provides": ["alias"],
    "metadata": {
      "name": "Example", "description": "...",
      "contributors": {"Alice": "Owner"},
      "contact": {"homepage": "...", "issues": "...", "sources": "..."},
      "license": "MIT",
      "icon": "assets/example/icon.png"
    },
    "depends": ["quilt_loader", {"id": "minecraft", "versions": ">=1.20"}],
    "breaks": [],
    "jars": ["META-INF/jars/lib.jar"]
  },
  "minecraft": {"environment": "*"}
}
```

Behaviour:

- `depends` and `breaks` entries are a string id (`"modid"` or `"maven.group:modid"`), an object `{id, versions?, optional?, reason?, unless?}`, or an array of those. Within `depends` an array means any one of them satisfies the dependency. Within `breaks` an array means all must match.
- `contributors` is a map from name to role (or roles). Use the keys as authors. Prefer `Owner` roles first.
- `license` is a string, an array, or an object `{name, id, url}`.
- `icon` is a string or a size-to-path map. Pick the same way as for Fabric.
- The environment `dedicated_server` maps to the server side.
- **Quilt loads Fabric mods.** When the instance runs Quilt, treat Fabric metadata as first-class (§7.10 and §10). The reference did not do this (see Pitfalls).

### 7.4 Forge (1.13+): `META-INF/mods.toml`

Spec: <https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/>.

```toml
modLoader = "javafml"
loaderVersion = "[47,)"
license = "MIT"
issueTrackerURL = "https://..."
clientSideOnly = false            # optional, newer Forge

[[mods]]
modId = "examplemod"
version = "${file.jarVersion}"
displayName = "Example Mod"
description = '''...'''
logoFile = "logo.png"
authors = "Alice, Bob"
displayURL = "https://..."
updateJSONURL = "https://..."
credits = "..."
provides = ["alias"]              # optional

[[dependencies.examplemod]]
modId = "forge"
mandatory = true                  # older format
type = "required"                 # newer format: required|optional|incompatible|discouraged
versionRange = "[47,)"
ordering = "NONE"
side = "BOTH"
```

Behaviour:

- One file may declare several `[[mods]]`. The first is primary and the others are provided ids.
- **`${file.jarVersion}` placeholder.** If `version` is literally `${file.jarVersion}`, substitute `Implementation-Version` from `META-INF/MANIFEST.MF`. If that is also absent, show `?`.
- Top-level `authors`, `displayURL` and `updateJSONURL` act as fallbacks for per-mod values.
- Dependencies are keyed by mod id. Newer files use `type` (`required`, `optional`, `incompatible`, `discouraged`) instead of `mandatory`. Support both: `mandatory=true` or `type="required"` means required.
- The Minecraft range comes from the dependency on `minecraft`. The loader range comes from the dependency on `forge`, or `loaderVersion` as a fallback.
- `logoFile` is resolved relative to the jar root.
- **OptiFine** ships a `mods.toml` with id `optifine`. Override its version and Minecraft version from the class constants described in §7.6.

### 7.5 NeoForge: `META-INF/neoforge.mods.toml`

The format is identical to mods.toml (<https://docs.neoforged.net/docs/gettingstarted/modfiles>). NeoForge 20.5+ reads only `neoforge.mods.toml`. Earlier NeoForge (the 1.20.1 era) reads `mods.toml`. Record NeoForge metadata separately from Forge metadata:

- `neoforge.mods.toml` present: the file is a NeoForge mod.
- Only `mods.toml` present: the file is a Forge mod. It may also run on NeoForge for Minecraft 1.20.1, and §10.3 must account for that.
- The dependency on `neoforge` (or `loaderVersion`) gives the loader range.

### 7.6 Legacy Forge (1.12.2 and older)

Try these sources in order and merge them:

1. **`mcmod.info`** (JSON) at the jar root. The shape is an array, or `{ "modListVersion": 2, "modList": [...] }`, or a single object. Fields: `modid`, `name`, `description`, `version`, `mcversion`, `url`, `updateUrl`, `updateJSON`, `authorList` (older files use `authors`), `credits`, `logoFile`, `parent`, `requiredMods`, `dependencies`, `dependants`, `useDependencyInformation`. Some mods ship invalid JSON with raw newlines. Retry after escaping control characters. Also check `cccmod.info`, `neimod.info`, and as a last resort any `*.info` file at the root.
2. **`META-INF/MANIFEST.MF`.** Parse `Key: Value` lines (continuation lines start with one space). Tweaker mods use `TweakName`, `TweakAuthor`, `TweakVersion` and `TweakMetaFile`. A `TweakMetaFile` points to a JSON file under `META-INF/` with `id`, `name`, `version`, `authors`, `description` and `url`. `FMLCorePlugin` names a coremod class.
3. **Bytecode scan (expensive).** Only when none of the above produced a mod id, scan `.class` files for the `@Mod` annotation (`Lnet/minecraftforge/fml/common/Mod;` or `Lcpw/mods/fml/common/Mod;`) and read its `modid`/`value`, `name`, `version`, `dependencies`, `acceptedMinecraftVersions`, `clientSideOnly` and `serverSideOnly`. Recognise OptiFine by a `Config` class (in the default package, `net/optifine/` or `notch/net/optifine/`) with static constants `OF_NAME`, `MC_VERSION`, `OF_EDITION` and `OF_RELEASE`. Its version is `<edition>_<release>`, and it is client-only.
   - The reference ran the full bytecode walk on **every** Forge-domain parse, even for modern mods.toml jars and Fabric jars. That is a major cost on large modpacks. Amethyst must make it conditional.
4. **Fallbacks.** A coremod class name ending in `Plugin` gives a mod id equal to the class simple name minus `Plugin`. A jar that references `net/minecraftforge` or `cpw/mods/fml` types but declares no id gets the file stem as its id.
5. If nothing identifies the file as a Forge mod, the Forge parser records nothing. This is not an error.

Legacy dependency strings (from `@Mod.dependencies`) look like `required-after:forge@[14.23,);after:jei;`. Split on `;`. Keep entries whose prefix contains `required`. The id comes after `:` and the optional range after `@`. Normalise `Forge` to `forge`.

### 7.7 LiteLoader (optional)

`litemod.json` at the root contains `name`, `version`, `mcversion`, `revision`, `author` and `description`. If `version` is missing, use `<mcversion>:<revision>`. This is very low priority, because LiteLoader stopped at Minecraft 1.12.2.

### 7.8 Resource packs: `pack.mcmeta` and `pack.png`

Reference: <https://minecraft.wiki/w/Resource_pack#Contents> and <https://minecraft.wiki/w/Pack_format>.

```json
{
  "pack": {
    "pack_format": 34,
    "supported_formats": [32, 34],
    "description": "My pack"
  }
}
```

Behaviour:

- Read `pack.mcmeta` at the archive or folder root. If it is missing, the entry is "not a valid resource pack". Still list it, flagged as invalid. If the root contains exactly one folder that holds a `pack.mcmeta`, flag "pack is nested one level too deep". This is a very common user error.
- Parse JSON leniently. The game uses Gson's lenient mode, so authors put raw newlines inside the description. If strict parsing fails, escape raw control characters inside strings and retry. If that fails too, report the original error.
- `description` is a string **or** a JSON text component (an object or array with `text`, `color`, `bold`, `extra`, `translate` and so on). Render text components with formatting. Also render legacy `§` colour codes in strings.
- `pack_format` is an integer. `supported_formats` (1.20.2+) is an integer, an array `[min, max]` or an object `{min_inclusive, max_inclusive}`. Newer versions (1.21.9+) may use `min_format`/`max_format`, possibly as `[major, minor]` arrays. Parse all of these forms defensively. Map formats to Minecraft version ranges with a bundled table taken from the wiki's pack-format page. Compare against the instance's Minecraft version to show "made for an older/newer version".
- Icon: `pack.png` at the root (any size, usually 64 to 512 px square).
- Enabled state and order are **not** properties of the file. They come from `options.txt` (§9.2).

### 7.9 Shader packs

There is no metadata file. A zip or folder counts as a shader pack when it contains a `shaders/` directory at the root. The reference required `shaders/shaders.properties`, but many valid packs have no such file (see Pitfalls). Optional extras:

- Display name: the file stem.
- `shaders/shaders.properties` may hold profile and screen options. Parsing it is not required.
- Iris/OptiFine-specific dimension folders such as `shaders/world-1/` are irrelevant here.

A shader pack whose zip cannot be opened is a broken file (§7.11). A zip without `shaders/` is listed with a warning: "not a shader pack (no shaders/ folder)". If its root holds a single folder that contains `shaders/`, warn "pack is nested too deep".

### 7.10 Normalised mod view (what the UI consumes)

Each mod file becomes one record with these fields:

| Field | Derivation |
|---|---|
| `modId` | from the *preferred* metadata (see below). Fallback: file name plus the first 4 hex characters of the SHA-1, so that unparsed files never collide |
| `name`, `version`, `description`, `authors[]`, `links{home, issues, sources, update}`, `license` | preferred metadata. Missing name: file name. Missing version: `?` |
| `loaders[]` | every loader whose metadata parsed: `fabric`, `quilt`, `forge`, `neoforge`, `liteloader` |
| `provides{id→version}` | ids of all mods (including nested jars, Forge `[[mods]]` extras, `provides` aliases) mapped to their versions. Special aliases: `fabric_api` ↔ `fabric-api` ↔ `fabric`. A Sinytra Connector jar (manifest `Automatic-Module-Name: org.sinytra.connector`) provides `fabricloader` at its `Fabric-Loader-Version` |
| `dependencies[]` | `{modId, range, rangeKind: maven|semver, required: bool, kind: depends|breaks|recommends}` per loader |
| `side` | `client`, `server` or `both`, from Fabric/Quilt `environment`, Forge `clientSideOnly`/`side`, or (if attributed) Modrinth `client_side`/`server_side` |
| `enabled` | `!fileName.endsWith('.disabled')` |
| `source` | Modrinth and/or CurseForge attribution |
| `icon` | icon URL |

**Preferred metadata order** depends on the instance's loader:

- Fabric instance: Fabric > Quilt > Forge > NeoForge > LiteLoader
- Quilt instance: Quilt > Fabric > Forge > NeoForge > LiteLoader
- Forge instance: Forge > NeoForge > Fabric > Quilt > LiteLoader
- NeoForge instance: NeoForge > Forge > Fabric > Quilt > LiteLoader
- Vanilla: Forge > Fabric > Quilt > NeoForge > LiteLoader

### 7.11 Parse errors

Classify parse failures into these codes:

| Code | Cause |
|---|---|
| `invalid-zip` | bad end-of-central-directory record, comment length, signature or truncated file |
| `multi-disk-zip` | spanning archive |
| `bad-central-directory` | invalid central directory header |
| `size-mismatch` | stored entry's compressed and uncompressed sizes differ |
| `not-found` | file vanished between event and parse |
| `permission-denied` | `EACCES`/`EPERM` |

How to handle them:

- Record the code on the blob's row (keyed by SHA-1) or on the placement (if hashing itself failed).
- **Do not re-parse** a file whose hash, size and mtime are unchanged and that already has a recorded error. Show the cached error instead. Re-parse when the parser version increases.
- Expose `errors[] = {path, code}` in the domain state. Clear an entry when the path disappears or later parses successfully.
- Show the user one notification per broken path per session, with "Reveal in Finder" and "Delete" actions. Do not re-notify on every refocus or reconnect. The reference had a long-standing toast-spam bug here.
- Expected user-file problems (the codes above) are not telemetry-worthy errors. Unexpected exceptions are.

---

## 8. Watching folders

### 8.1 Lifecycle

- Watch domain folders only for instances that the UI is currently showing (the selected instance) and for any running instance. Stop watching when the instance is deselected and no window shows it. The reference also tied watchers to instance deletion.
- Before starting a watcher, run a **full revalidation**:
  1. List the folder at depth 1. Apply the ignore and extension rules from §7.1.
  2. For each entry: if the cached placement is valid (§4.4), reuse its hash and metadata. Otherwise queue it for hash and parse.
  3. Delete placements for paths under this folder that no longer exist.
  4. Emit the full list.
- Use FSEvents. Chokidar (with Node's FSEvents-backed `fs.watch`) or `@parcel/watcher` are both fine. Settings:
  - depth 1 for mods, resourcepacks and shaderpacks; for saves, watch only `saves/*/level.dat` and the immediate children of `saves/`;
  - follow symlinks (needed for shared pools);
  - ignore permission errors, and ignore `EBUSY`/`EPERM` watcher errors;
  - wait for writes to finish (stability threshold about 300 ms) so half-copied jars are not parsed.
- Coalesce change events per path. If three events arrive for one path within the debounce window, the file is processed once.
- Batch UI updates. Emit "upsert/remove" deltas to the renderer at most every 250 to 500 ms. The reference used 500 ms.

### 8.2 Events

| FS event | Action |
|---|---|
| add / change (file) | Look up the placement by path, or by inode for renames. If it is valid, reuse it. Otherwise hash, then look up the blob by SHA-1 and parse if it is unknown or the parser version is stale. Emit upsert. Clear any error for the path. |
| unlink | Delete the placement and emit remove. Clear any error for the path. |
| rename (`x.jar` → `x.jar.disabled`) | Arrives as unlink + add. The inode lookup makes the add cheap, with no re-hash. |
| unlinkDir of the domain folder itself | Emit an empty list. Re-create the watcher when the folder reappears. |

### 8.3 Concurrency and retry

- Hash and parse jobs go through a queue with bounded concurrency (8 to 16) and **de-duplication by path**. Two queued jobs for the same path merge.
- Retry `EMFILE`/`EBUSY` up to 5 times with a random 1 to 3 s back-off. Treat `ENOENT` during processing as a removal.
- Raise the process file-descriptor soft limit at startup (on macOS the default is 256). Electron apps can call `setrlimit` through a small native helper. Otherwise keep concurrency well below the limit.

### 8.4 Pausing while the game runs

While the instance's game is running, keep watching mods, resourcepacks and shaderpacks, which rarely change at runtime. **Defer** save re-reads: the game rewrites `level.dat` every autosave (about every 5 minutes, plus on pause). Queue `level.dat` changes and process them when the game exits. The reference did this too.

---

## 9. Enabling and disabling

### 9.1 Mods: `.disabled` suffix

- Disable: rename `X` to `X.disabled`, where `X` must be a direct child of `<instance>/mods/` and must not already end with `.disabled`. Enable: the reverse.
- Mod loaders ignore files with an unknown extension, which is why this convention works across Forge, NeoForge, Fabric and Quilt and is shared by other launchers.
- If the target name already exists (for example `X` exists while enabling `X.disabled`), do not overwrite it. Ask the user, or rename to `X (2)`.
- **Cascade (recommended UX, as in the reference):**
  - Enabling a mod also enables any currently disabled mods that provide its required dependency ids, when no enabled provider already exists. Apply this transitively.
  - Disabling a mod also disables dependency mods that no other enabled mod still requires. Apply this transitively.
  - Show the cascade list in a confirmation dialog before applying it. The reference applied it silently.
- Disabled mods are excluded from update checks but are still shown and attributable.
- Watch out for mods named `*.jar.disabled.disabled`. Disabling twice must be prevented. Enabling strips exactly one suffix.

### 9.2 Resource packs: `options.txt`

- `options.txt` holds `resourcePacks:["vanilla","file/MyPack.zip","file/Folder Pack"]`. This is a JSON array on one line, **bottom-to-top priority**: later entries override earlier ones. Packs placed there by mods (`fabric`, `mod_resources`, `programmer_art`, `high_contrast`, or any entry containing `:` or not prefixed `file/`) must be preserved untouched. `incompatibleResourcePacks:[...]` lists packs the player accepted despite a format mismatch. Preserve it, and add to it when enabling a mismatched pack.
- The UI shows enabled packs top-first, which is the **reverse** of the file order. The bottom entry should be `vanilla`.
- The id for a launcher-managed pack is `file/<exact name on disk>`. This is the zip file name including `.zip`, or the folder name **without** any added extension.
- Enable: add the id to the top-priority end (the end of the array) and write the file. Disable: remove the id. Reorder: rewrite the array.
- Writing `options.txt`:
  - Read and parse it as `key:value` lines. Keep unknown keys and key order. Change only the keys being edited. **Add keys that do not exist yet.** The reference only updated keys already present (see Pitfalls).
  - Encode `resourcePacks` and `incompatibleResourcePacks` as JSON arrays on one line.
  - Write atomically (temporary file plus rename).
  - Refuse to write while the game is running. The game rewrites `options.txt` on exit and would clobber the edit. Queue the edit and apply it after exit.
- Reading a truncated or garbled `resourcePacks` value (other tools' partial writes): salvage the quoted strings with a tolerant scan. Otherwise treat it as empty. Never crash.
- If `options.txt` does not exist **and** the instance has a default-options mod config (`config/yosbr/options.txt`, `config/defaultoptions/`), do not create one, because those mods only apply defaults when it is absent. Otherwise it is fine to create one (the reference seeded `lang:<system locale>`).
- When enabling a pack that exists in the shared pool but not in the instance, place it first (§5.5).

### 9.3 Shader packs: per shader mod

Exactly one shader pack is active at a time. Where the selection lives depends on the shader mod:

| Shader mod | Detection | File | Keys |
|---|---|---|---|
| OptiFine (standalone instance runtime or as a mod) / OptiFabric | instance `optifine` runtime version, or a mod with id `optifine`/`optifabric` | `<instance>/optionsshaders.txt` | `shaderPack=<file name>` (empty or `OFF` means off) |
| Iris (Fabric/Quilt/NeoForge) | mod id `iris` | `<instance>/config/iris.properties` | `shaderPack=<file name>`, `enableShaders=true|false` |
| Oculus (Forge) | mod id `oculus` | `<instance>/config/oculus.properties` | same as Iris |

Behaviour:

- Only count **enabled** mods when detecting the shader mod.
- If no shader mod is detected, the shader pack page still works but shows "No shader loader installed". The reference wrote all three files in that case. Amethyst should write nothing and offer to install Iris (Fabric/Quilt/NeoForge) or Oculus (Forge) from the marketplace.
- `.properties` files: keep every other line verbatim, including comments. Escape non-ASCII as `\uXXXX` on write and decode on read. Split each line on the **first** `=` only.
- Selecting "None" sets `shaderPack=` empty (and `enableShaders=false` for Iris/Oculus).
- The same rule about not writing while the game is running applies.

### 9.4 Marketplace attribution (by hash)

Run attribution:

- right after a local import;
- when the domain view opens or regains focus, but only for files that are unattributed and have no fresh negative-cache entry. Refresh all attribution at most every 30 minutes per instance. The reference used the same throttle;
- on demand ("Refresh metadata").

Algorithm:

1. Collect the regular, unattributed files.
2. **Modrinth:** `POST https://api.modrinth.com/v2/version_files` with `{"hashes":[sha1...], "algorithm":"sha1"}`, in chunks of up to 100 to 128 hashes. The response maps each hash to a version. Record `{projectId: version.project_id, versionId: version.id}`. Hashes missing from the response are "not on Modrinth" and go into the negative cache with a TTL of 7 days.
3. **CurseForge:** compute murmur2 fingerprints (§4.3), drop non-positive values and de-duplicate, then `POST https://api.curseforge.com/v1/fingerprints/432` with `{"fingerprints":[...]}`. For each `exactMatches[]` entry, match back by `file.fileFingerprint` first, then by `file.hashes[algo==1].value == sha1`. Record `{projectId: file.modId, fileId: file.id}`. Unmatched entries go into the negative cache.
4. Write the results to `sources` and push a batched metadata update to the UI.
5. Errors: a 4xx other than 404 means a configuration problem (bad API key and so on). Log it once and stop retrying for this session. 5xx and network errors fail soft, and the next trigger retries.

The two platform lookups run in parallel and independently.

---

## 10. Dependency resolution and compatibility

### 10.1 Local compatibility check (offline)

Build a **runtime map** of `id → version`:

- `minecraft`, `java` (major version of the selected JRE), and the loader as `forge`, `neoforge`, `fabricloader`, `quilt_loader`;
- plus every enabled mod's `provides` map.

For every enabled mod and the dependency list of its active loader:

- Look up the dependency's id in the runtime map. If it is absent, the dependency is **missing**: an error if required, ignored if optional.
- Check the range:
  - Forge/NeoForge ranges use Maven version-range syntax (`[1.0,2.0)`, `[1.20.1]`, `(,1.5]`, comma-separated unions). Compare with Maven `ComparableVersion` semantics.
  - Fabric ranges use Fabric's semver-like predicates (`*`, `>=0.15.0`, `~1.20`, `^1.2`, `1.20.x`, space-separated AND, arrays meaning OR). See Fabric's version-predicate documentation.
  - Quilt `versions` uses the same predicate style.
  - The result is `true`, `false` or `maybe`. Use `maybe` when either side does not parse, or when the version is just outside a bound by a single component. The reference used `maybe` that way to avoid false alarms from sloppy ranges.
- **Breaks/conflicts** (Fabric `breaks`, Quilt `breaks`, Forge `type="incompatible"`): a present and matching mod is an error.
- **Duplicates:** two or more enabled mods with the same `modId` is an error ("duplicate mod"), shown with both file names.
- **Loader mismatch:** an enabled mod with none of its loaders in the instance's *accepted loader set* gets a warning. Accepted loader sets:
  - Forge instance: `forge`, plus `fabric` if Sinytra Connector is present;
  - NeoForge instance: `neoforge`, plus `forge` when Minecraft ≤ 1.20.1;
  - Fabric instance: `fabric`;
  - Quilt instance: `quilt` and `fabric`.

Show per-mod badges and an instance-level "N problems" summary. Never block launching.

### 10.2 Missing-dependency check (online)

1. Refresh attribution (§9.4).
2. **Modrinth:** for attributed mods, fetch their versions by hash (`POST /v2/version_files`). For each `dependencies[]` entry with `dependency_type == "required"` whose `project_id` is not among the instance's attributed projects **and** not satisfied by mod id locally (§10.1):
   - if it has a `version_id`, fetch it (`GET /v2/versions?ids=[...]`, batched);
   - otherwise list the project's versions filtered by the instance loader(s) and Minecraft version, and take the newest. Prefer `release` over `beta` over `alpha` within the newest Minecraft-compatible set.
3. **CurseForge:** for mods attributed only to CurseForge, fetch their files (`POST /v1/mods/files`). For each dependency with `relationType == 3` (required) not present: `GET /v1/mods/{modId}/files?gameVersion=<mc>&modLoaderType=<loader>&pageSize=50`, then choose the newest file whose `gameVersions` include the instance's Minecraft version and loader (sort by `fileDate` descending; do not trust response order).
4. De-duplicate the plan **by project**. Use a key like `modrinth:<id>` or `curseforge:<id>`, and treat a Modrinth project and a CurseForge project as the same when a local mod-id match links them. Two versions of one mod must never be installed.
5. Show a plan dialog listing each dependency, the mod that requires it, and its source. The user confirms before anything is installed.

Important: step 2 must also accept a dependency as satisfied when a local, unattributed jar provides the mod id. In the reference, only platform project ids counted, so a hand-installed Fabric API was reported as missing (see Pitfalls).

### 10.3 Dependency tree for a marketplace install

When the user installs version *V* of project *P*:

- **Modrinth:** walk *V*'s `dependencies` recursively.
  - Skip `incompatible` entries. Do not recurse into `embedded` entries.
  - Show `optional` entries unchecked by default, and do not recurse into them.
  - For each child, fetch the project (for name and icon) and its versions filtered by *V*'s `loaders` and `game_versions`, then choose `version_id` if specified, else the newest.
  - Keep a visited set by `project_id` to break cycles.
  - Effective type propagates from the root: a required dependency of a required dependency is required, and a required dependency of an optional dependency is optional.
  - If no compatible version exists for a **required** child, show it as an unresolved requirement and do not fail the whole tree. A dependency may have `version_id: null`, meaning "any".
- **CurseForge:** the same idea with `dependencies[].relationType`:
  - `3` Required: recurse;
  - `2` Optional: show, do not recurse;
  - `1` EmbeddedLibrary and `6` Include: skip;
  - `5` Incompatible: warn if installed;
  - `4` Tool: treat like optional.
  - Choose files filtered by the instance Minecraft version and loader, and fall back to "Any" loader only when the child file is loader-agnostic.
- Before showing the plan, remove dependencies already satisfied locally (by attribution or mod id).

### 10.4 Unused library detection (optional)

The reference offered a "clean up libraries" action:

1. Find enabled mods that no other enabled mod depends on.
2. Keep those whose Modrinth project has the category `library`, or whose CurseForge mod is in category 421 ("API and Library").
3. Propose disabling them (not deleting).

This is optional, and only safe as a suggestion: some libraries are used by mods that do not declare the dependency.

---

## 11. Saves

### 11.1 Discovery

- A save is any **directory** directly under `<instance>/saves/` that contains `level.dat`. Skip hidden entries. Directories without `level.dat` are listed as "not a world" only in a diagnostics view.
- A save may be a symlink (shared pool). Show a "linked" badge with the target.
- Thumbnail: `<save>/icon.png` (64×64, written by the game). Use a placeholder if it is absent.
- Size on disk is computed lazily in the background. It can be slow for big worlds.

### 11.2 NBT essentials

Minecraft Java stores `level.dat` as **gzip-compressed, big-endian Named Binary Tag** data. Reference: <https://minecraft.wiki/w/NBT_format> and <https://wiki.vg/NBT>.

Tag ids:

| Id | Tag | Payload |
|---|---|---|
| 0 | End | none (terminates a Compound) |
| 1 | Byte | int8 |
| 2 | Short | int16 BE |
| 3 | Int | int32 BE |
| 4 | Long | int64 BE (use `BigInt` in JS) |
| 5 | Float | IEEE-754 float32 BE |
| 6 | Double | IEEE-754 float64 BE |
| 7 | Byte_Array | int32 length + bytes |
| 8 | String | **uint16** length + **Modified UTF-8** bytes |
| 9 | List | element tag id (1 byte) + int32 length + payloads (empty lists may use element type End) |
| 10 | Compound | sequence of named tags (`tagId, name(String), payload`) until End |
| 11 | Int_Array | int32 length + int32 BE values |
| 12 | Long_Array | int32 length + int64 BE values |

A file is one named root tag: `tagId=10`, a name (usually empty), then the payload.

Implementation requirements:

- **Compression detection:** the first bytes `1F 8B` mean gzip, `78 xx` means zlib, anything else is uncompressed. `level.dat` and `playerdata/*.dat` are gzip. Region chunk payloads are zlib (usually). `servers.dat` is uncompressed.
- **Modified UTF-8:** NUL is encoded as `C0 80`, and supplementary characters are encoded as two 3-byte surrogates (CESU-8 style). The decoder and encoder must implement this exactly. Standard UTF-8 encoders produce the wrong byte length for strings containing emoji or NUL, and the result is corrupt files (see Pitfalls). The length prefix is the **unsigned** 16-bit byte length. Reject strings over 65535 bytes on write.
- **Round-trip fidelity:** when editing, preserve each tag's original type. For example, `Difficulty` must remain a Byte and not become an Int. Represent values with explicit type tags, or keep a parallel schema produced at read time. Unknown tags must survive unchanged. Preserve key order.
- Longs must be read as 64-bit integers (`BigInt`), never as JS numbers. Seeds exceed 2^53.
- Never write `level.dat` while the game is running. Write `level.dat.tmp`, rename the old file to `level.dat_old` (the game's own convention), then rename the new file to `level.dat`.

### 11.3 `level.dat` fields shown

All fields are under the root compound's `Data` compound. Reference: <https://minecraft.wiki/w/Java_Edition_level_format#level.dat_format>. Treat **every** field as optional, because formats changed across versions.

| UI field | NBT path | Type | Notes |
|---|---|---|---|
| World name | `Data.LevelName` | String | Separate from the folder name |
| Game version | `Data.Version.Name` | String | Only present from 1.9 on. Absent: show "pre-1.9" or unknown. Do **not** throw |
| Data version | `Data.DataVersion` / `Data.Version.Id` | Int | Used to warn "world was saved by a newer game version than this instance" |
| Snapshot flag | `Data.Version.Snapshot` | Byte | |
| Game mode | `Data.GameType` | Int | 0 Survival, 1 Creative, 2 Adventure, 3 Spectator |
| Hardcore | `Data.hardcore` | Byte | |
| Difficulty | `Data.Difficulty` | Byte | 0 Peaceful, 1 Easy, 2 Normal, 3 Hard. May be absent or relocated in newest versions, so check the wiki per version |
| Difficulty locked | `Data.DifficultyLocked` | Byte | |
| Cheats | `Data.allowCommands` | Byte | The reference hard-coded this to false (see Pitfalls) |
| Seed | `Data.WorldGenSettings.seed` (1.16+), else `Data.RandomSeed` | Long | Show as a signed 64-bit decimal string |
| Last played | `Data.LastPlayed` | Long | Unix epoch milliseconds |
| Play time | `Data.Time` | Long | Total game ticks (÷20 gives seconds). `DayTime` is the time of day |
| Spawn | `Data.SpawnX/Y/Z` | Int | Optional detail view |
| Game rules | `Data.GameRules` | Compound of strings | Optional detail view |
| Mod list (Forge) | `FML` / `fml` root sibling compound | | Optional "world was last opened with these mods" |

Derived: the advancement count. The reference showed the number of JSON files in `advancements/`, which is the number of **players** with advancement data and not the number of advancements (see Pitfalls). If shown, compute per-player completed advancements by counting entries with `"done": true` in `advancements/<uuid>.json`, or drop the metric.

### 11.4 Operations

All operations require the game for that instance not to be running, or else warn and offer to wait.

| Operation | Behaviour |
|---|---|
| **Rename** | Two separate things: the *folder name* (rename the directory; sanitise; must not collide) and the *world name* (`Data.LevelName` in level.dat). Offer both, defaulting to changing both |
| **Edit metadata** | Allowed edits: world name, difficulty, cheats (`allowCommands`), seed (writing to whichever of `WorldGenSettings.seed`/`RandomSeed` exists), game mode. Preserve types (§11.2) |
| **Duplicate** | Recursive copy (APFS clone per file via `COPYFILE_FICLONE`) to `<name> (copy)` or `<name> (2)`, either in the same instance or into one or more other instances. Update `LevelName` in the copy to match |
| **Delete** | Move to the macOS Trash (`shell.trashItem`). Do not `rm -rf`. Worlds are irreplaceable |
| **Import (folder)** | Source must contain `level.dat` at its root. If the folder is inside the shared pool, optionally link instead of copying. Otherwise copy (clone) |
| **Import (zip)** | Open the archive. Find the **shallowest** entry named `level.dat` (`level.dat` at the root, or `<dir>/level.dat`, and so on). Its parent is the world root. Extract only entries under that root, stripping the prefix. **Zip-slip guard:** reject any entry whose normalised destination escapes the target folder. Skip `__MACOSX/` and `.DS_Store`. Destination name: sanitised zip stem, with ` (n)` on collision, using the same base consistently |
| **Import from CurseForge "Worlds"** | Download the file (class id 17), then use the zip import. Record attribution in a sidecar `.amethyst-source.json` inside the world. The reference used a `.curseforge` file with `{projectId, fileId}`; reading that file is optional, for compatibility |
| **Export (zip)** | Zip the world as a **single top-level folder** named after the world folder. Most tools, and Minecraft Realms uploads, accept either layout, but a top-level folder avoids exploding into the user's Downloads. Exclude `session.lock`. Use deflate level 6. Exclude backup sidecars |
| **Export (folder)** | Copy the world folder to the chosen destination |

### 11.5 Backup and restore (Amethyst feature)

The reference launcher had no dedicated backup feature. Clone and export are its closest equivalents. Amethyst should provide:

- **Back up now:** export as zip to `backups/<instance-id>/<world-folder>/<YYYY-MM-DD_HH-mm-ss>.zip`, writing to `.part` and then renaming. Show progress, and allow cancelling.
- **Automatic backup** (setting, off by default): before launching an instance whose world was last saved by an *older* Minecraft data version than the instance's version (detected via `DataVersion`), offer a backup. This is the classic "upgrading destroyed my world" scenario.
- **Retention:** keep the last N backups per world (default 5) and delete older ones.
- **Restore:** extract into the saves folder under a new name (`<world> (restored <date>)`) by default. An "overwrite" mode first moves the current world to the Trash.
- Backups survive instance deletion unless the user opts in to deleting them.

### 11.6 Datapacks (per save)

- Location: `<save>/datapacks/`. Entries are `.zip` files or folders, each with `pack.mcmeta` (the same parsing as resource packs, §7.8) and an optional `pack.png`.
- List, import (copy a zip or folder in), delete (Trash), and install from the marketplace. Modrinth datapacks are projects whose versions carry the loader `datapack`. CurseForge uses class id 6945.
- The game enables datapacks inside `level.dat` (`Data.DataPacks.Enabled` / `Disabled` lists). Showing that state is optional. Editing it is out of scope for v1.
- Marketplace attribution for datapacks: store it in the index by SHA-1 like other files. The reference used hidden sidecars `.<file>.modrinth` and `.<file>.curseforge`. Amethyst does not need them.

---

## 12. Update checking

### 12.1 Inputs and settings (per instance, per domain)

- `releaseOnly` (default **true**): ignore beta and alpha versions.
- `policy`: `modrinth-first` (default), `curseforge-first`, `modrinth-only`, `curseforge-only`. Each mod is checked against exactly one platform: the first one in policy order for which it has attribution.
- `onlyIfCurrentMatchesMc` (the reference called it "skip version"): only consider mods whose **currently installed** version lists the instance's Minecraft version. This is useful after the user changes the instance's Minecraft version.
- Store these in the instance metadata (not in renderer localStorage as the reference did), so they survive reinstalls.

### 12.2 Algorithm

1. Refresh attribution (§9.4).
2. Candidates are enabled, attributed, regular files in the domain. Disabled mods are excluded.
3. **Modrinth:** `POST /v2/version_files/update` with `{"hashes":[...], "algorithm":"sha1", "loaders":[...], "game_versions":["<mc>"]}`.
   - Loaders: for mods, the instance's loader. For Quilt instances send `["quilt","fabric"]`. For a NeoForge 1.20.1 instance send `["neoforge","forge"]`. For resource packs and shader packs, omit loaders (resource packs use the `minecraft` loader; shaders use `iris`, `optifine`, `canvas` and so on).
   - The response maps each hash to its newest compatible version. If `releaseOnly` and the returned version is not `release`, list the project's versions (`GET /v2/project/{id}/version?loaders=..&game_versions=..`) and take the newest with `version_type == "release"`.
   - If the chosen version id differs from the installed `versionId`, it is an update.
4. **CurseForge:** for each candidate (with bounded concurrency of about 4 to 8): `GET /v1/mods/{modId}/files?gameVersion=<mc>&modLoaderType=<n>`, using `modLoaderType=0` (Any) for non-mod domains. Filter `releaseType == 1` if `releaseOnly`. Sort by `fileDate` descending and pick the first. If its `id` differs from the installed `fileId`, it is an update.
5. Build an **upgrade plan**: `[{oldFile: {path, sha1}, newFile: {fileName, url(s), sha1, size, source}}]`. Key the plan by project, so the same mod is never planned twice.
6. Apply the plan only after confirmation, as one transaction per file:
   1. download to the store (verify the hash);
   2. place the new file;
   3. delete the old file;
   4. if the old file was disabled, the new one is placed disabled too.
   Show per-file progress. A failure leaves the old file in place.
7. Recompute the plan when the mod list changes. Drop plan entries whose old file vanished.

Optional: when the user changes the instance's Minecraft version, offer to (a) update mods that have a compatible version and (b) disable the rest.

---

## 13. Renderer contract (IPC)

The main process owns all state. For each `(instanceId, domain)` it exposes:

- `watch(instanceId, domain)`: returns a snapshot `{files: ResourceView[], errors: {path, code}[]}` plus a subscription that delivers batched deltas `{upserts[], removes[], metadataUpdates[]}`.
- Commands:
  - `install(instanceId, domain, sourcePaths[])`
  - `installFromMarket(instanceId, domain, {platform, projectId, versionOrFileId})`
  - `uninstall(instanceId, domain, paths[])`
  - `setEnabled(instanceId, paths[], enabled)` (mods)
  - `setResourcePackOrder(instanceId, ids[])`
  - `setShaderPack(instanceId, name|null)`
  - `refreshAttribution(instanceId, domain)`
  - `checkUpdates(instanceId, domain, options)`
  - `applyPlan(instanceId, plan)`
  - `revealInFinder(path)`
- Saves:
  - `watchSaves(instanceId)`
  - `renameSave`, `editSave`, `duplicateSave`, `deleteSave`, `importSave`, `exportSave`, `backupSave`, `listBackups`, `restoreBackup`
  - datapack list, import and delete
- Every path argument is validated in main: it must resolve inside the instance's domain folder.

Throttle `ResourceView` arrays on the renderer side (about 500 ms) for large mod lists (300+). Never send full metadata blobs that the list view does not render. Fetch details on demand.

---

## 14. Non-functional requirements

- First open of a 300-mod instance with a cold index: listing appears immediately with file names, metadata fills in progressively, and everything is complete in under 30 s on an M1.
- Warm open (index hot, nothing changed): complete list in under 500 ms.
- No main-thread blocking over 50 ms during scans.
- Memory: never hold more than one jar fully in memory per worker, except during murmur2 fingerprinting, which needs the whole file. Cap that at the worker count.

---

## 15. Pitfalls / bugs observed in the original

1. **The suggested display name is never used.** The parser pipeline only assigns the parser-suggested name inside a branch that runs when a name already exists, so parsers never set it. Every resource's `name` falls back to the file name. Amethyst should take the display name from the preferred metadata (§7.10).
2. **The bytecode scan runs on every jar.** The legacy-Forge class walk ran for every mod file, including modern mods.toml and Fabric jars, which made cold scans of big packs slow. Make it a last resort.
3. **Shader pack detection is too strict.** It required `shaders/shaders.properties`. Many valid packs lack it, so they showed no metadata and could not be told apart from junk zips.
4. **Quilt and Fabric interop are ignored.** In a Quilt instance, Fabric-only mods were flagged loader-incompatible, and Modrinth/CurseForge update and dependency queries asked only for `quilt` files. Treat Fabric as accepted on Quilt.
5. **The NeoForge 1.20.1 case.** Forge-only (mods.toml) mods were flagged incompatible on NeoForge even for Minecraft 1.20.1, where NeoForge still loads them.
6. **Quilt dependencies are never extracted** for compatibility checks, and only the first Fabric metadata entry's `depends` was used. Nested-jar dependencies, `breaks` and `recommends` were ignored.
7. **The missing-dependency check counts only platform project ids.** A required dependency installed by hand (no attribution) was reported missing and proposed for re-install.
8. **A bad CurseForge "skip version" filter.** The filter put *file ids* into the ignore set and then compared it against *project ids*, so it never worked for CurseForge.
9. **CurseForge "latest" means the first array element.** It trusted response order instead of sorting by `fileDate`.
10. **Resource pack folder ids are wrong.** The id was built as `file/<name>.zip` even for unzipped folder packs, so enabled folder packs never matched their `options.txt` entry.
11. **`options.txt` edits drop new keys.** When the file existed, only keys already present were written (except `resourcePacks`), so setting a never-before-set option was silently ignored.
12. **`.properties` files are split on every `=`.** Values containing `=` were truncated.
13. **With no shader mod, three files are written.** The original wrote `optionsshaders.txt`, `iris.properties` and `oculus.properties`, polluting instances.
14. **NBT string encoding is broken.** The writer computed a Modified-UTF-8 byte length but wrote standard UTF-8 bytes, so strings with emoji or NUL produced corrupt `level.dat` files (for example after renaming a world to a name with an emoji). The reader used a signed 16-bit length and a standard UTF-8 decoder.
15. **The cheats field is never read.** `allowCommands` was ignored and always shown as false.
16. **Pre-1.9 worlds fail to parse.** `Version.Name` was dereferenced unconditionally, so worlds without a `Version` compound disappeared from the list.
17. **The "advancements" metric is mislabelled.** It counted advancement *files* (players), not advancements.
18. **Save export probably exports the wrong folder.** The export source path appears to omit the `saves/` segment (instance root + world name), which zips the wrong directory or fails.
19. **Zip-slip on world import.** Zip entries were joined to the destination without containment checks.
20. **Import name collisions use inconsistent bases.** The first candidate stripped the extension, and later candidates kept it (`World.zip (1)`).
21. **Destructive deletes.** Save deletion used a recursive `rm`, not the Trash. Separately, cached world zips under the shared saves folder were auto-deleted at startup when their **access time** was more than 3 days old. atime is unreliable on APFS, where it is often not updated, so this is both surprising and possibly destructive.
22. **Corrupt attribution poisons batches.** File paths leaked into the stored Modrinth version id, and one invalid id made Modrinth reject the whole batch with HTTP 400. The fix was a startup sweep. Validate before writing instead.
23. **Parse errors are cached forever.** Errors were cached per path with no parser version, so a zip-library upgrade required migrations to clear stale errors. A JSON-plugin bug also stored the literal string `"null"` as an error code.
24. **Snapshot validity ignores size and is keyed to the data root.** It used inode plus "cached mtime ≥ file mtime", and paths were stored relative to the launcher data root, so instances outside the root had `../` paths, and moving the root invalidated everything.
25. **Folder pseudo-hash.** Folder resources were hashed by names and mtimes, so the hash changed whenever any file was touched.
26. **Toast storms.** The same broken file was re-reported on every revalidation, renderer reconnect or window focus until a dedupe layer was added.
27. **Hard links into instances.** A tool that rewrites a jar in place silently changes every hard-linked copy. The 1.5 s link timeout with silent fallback to copy also made behaviour non-deterministic.
28. **Unsanitised upgrade paths.** Paths built from CurseForge `fileName` or Modrinth `filename` were used unsanitised in some update and dependency plan paths. Only the direct market install path sanitised names.
29. **Swallowed rename errors.** Enable/disable errors were swallowed (enable silently, disable only logged), so the UI could show a state that did not match the disk until the watcher caught up.
30. **Wrong CurseForge category id.** The library cleaner checked CurseForge category id 6945, which is the *datapack class id*, not a category. Its "library" detection was therefore partly wrong.

---

## Appendix A: Public format references

- Fabric `fabric.mod.json`: <https://wiki.fabricmc.net/documentation:fabric_mod_json_spec>
- Quilt `quilt.mod.json`: <https://github.com/QuiltMC/rfcs/blob/main/specification/0002-quilt.mod.json.md>
- Forge `mods.toml`: <https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/>
- NeoForge `neoforge.mods.toml`: <https://docs.neoforged.net/docs/gettingstarted/modfiles>
- Legacy `mcmod.info`: <https://docs.minecraftforge.net/en/1.12.x/gettingstarted/structuring/#mcmodinfo>
- Resource pack and `pack.mcmeta`: <https://minecraft.wiki/w/Resource_pack>, pack formats: <https://minecraft.wiki/w/Pack_format>
- Options file: <https://minecraft.wiki/w/Options.txt>
- NBT: <https://minecraft.wiki/w/NBT_format>, <https://wiki.vg/NBT>
- Level format: <https://minecraft.wiki/w/Java_Edition_level_format>
- Modrinth version-file endpoints: <https://docs.modrinth.com/api/operations/versionsfromhashes/>, <https://docs.modrinth.com/api/operations/getlatestversionsfromhashes/>
- CurseForge fingerprints: <https://docs.curseforge.com/rest-api/#get-fingerprints-matches>
- MurmurHash2 (public domain): <https://github.com/aappleby/smhasher>

## Appendix B: Maybe (not v1)

- **Mod groups:** user-defined folders or tags for organising long mod lists in the UI. Store them in instance metadata by SHA-1 and file name.
- **Favourites/collections** of marketplace projects across instances (see `marketplace.md`).
- **Resource pack preview:** render pack textures or models.
- **Region/chunk tools** for worlds (map preview, chunk delete/copy). The reference has these, and they are large features.
