# Spec: Marketplace (Modrinth API v2 and CurseForge API v1)

Status: draft, clean-room behavioural spec
Target: Amethyst (Electron + React, macOS 13+ arm64 only)
Related specs: `resources.md` (hash attribution, update checks, dependency resolution, install placement), `modpacks.md` (modpack search results hand off there)

This spec covers how Amethyst talks to the two content platforms: search, filters, project and version lookup, hash lookup, downloads, caching and rate limiting. All endpoint shapes below come from the public API documentation:

- Modrinth: <https://docs.modrinth.com/api/>
- CurseForge: <https://docs.curseforge.com/rest-api/>

Out of scope: Modrinth publishing and project editing, binding an instance to a published project, download mirrors, the reference launcher's own backend services (including its CurseForge↔Modrinth project-mapping database), and localised descriptions.

---

## 1. Architecture

### 1.1 Where calls happen

- **All marketplace HTTP calls run in the main process** (or a utility process), behind a typed IPC API. The renderer never calls `api.curseforge.com` directly and never sees the CurseForge API key.
  - The reference launcher let its renderer build CurseForge and Modrinth requests, then intercepted every renderer `https` request in the main process to add the `x-api-key` header for `api.curseforge.com`. That works, but it gives the renderer a generic authenticated proxy. A typed API is narrower and easier to cache.
- The main-process client layer has three parts:
  1. **Transport:** Node `fetch` (undici) with timeouts, retries, a User-Agent header and proxy support. It uses Electron's `net`/session proxy settings, or system proxy discovery via `session.resolveProxy`.
  2. **Platform clients:** one each for Modrinth and CurseForge, holding typed request builders and response validators.
  3. **Cache and rate limiter** (§6 and §7).
- Images (icons, gallery) load directly in the renderer from the platform CDNs (`cdn.modrinth.com`, `media.forgecdn.net`). They need no key. Set the CSP `img-src` to allow those hosts. Optionally proxy them through a caching custom protocol for offline use.

### 1.2 Common transport rules

| Concern | Rule |
|---|---|
| TLS | **Always verify certificates.** Never disable verification (see Pitfalls) |
| User-Agent | `Amethyst/<version> (+https://<project-url>; <contact>)` on every request. Modrinth *requires* a uniquely identifying UA and may block generic ones |
| Timeouts | Connect 10 s, headers 20 s, body idle 30 s (search/details). Downloads use the download manager's own policy |
| Retries | Network errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, TLS reset) and HTTP 429/500/502/503/504: up to 3 retries with exponential backoff (0.5 s, 1.5 s, 4 s) plus ±25% jitter. On 429, wait `Retry-After` (or Modrinth's reset header) if present. Never retry other 4xx |
| Redirects | Follow up to 5 |
| Cancellation | Every request accepts an `AbortSignal`. Typing a new search query cancels the in-flight one |
| Errors | Normalise to `{platform, status, code, message, url, retryable}`. Never surface raw HTML error pages |
| Concurrency | Per host: Modrinth 6, CurseForge 4 in flight. Downloads are governed separately |

---

## 2. Modrinth API v2

### 2.1 Basics

- Base URL: `https://api.modrinth.com/v2`
- Authentication: **none** for every read used here. (A personal token or OAuth unlocks follows and collections. See the "maybe" appendix.)
- **Rate limit: 300 requests per minute per IP.** Every response carries these headers:
  - `X-Ratelimit-Limit`
  - `X-Ratelimit-Remaining`
  - `X-Ratelimit-Reset` (seconds until the window resets)

  Exceeding the limit returns HTTP 429. Source: Modrinth API docs, "Ratelimits" section.
- IDs are 8-character base62 strings (`[0-9A-Za-z]{8}`). Project endpoints also accept the **slug** in place of the id. Version endpoints need ids. Validate ids before sending them. One malformed id in a batch (`ids=[...]`) makes the whole request fail with HTTP 400.
- Array query parameters are **JSON-encoded** and then URL-encoded, for example `ids=%5B%22AABBCCDD%22%5D`.

### 2.2 Endpoints used

| Purpose | Request | Notes |
|---|---|---|
| Search | `GET /search?query=&facets=&index=&offset=&limit=` | §2.3 |
| Project | `GET /project/{id\|slug}` | Details page |
| Projects (batch) | `GET /projects?ids=["id1","id2"]` | Decorate installed items. Chunk to keep the URL under about 8 KB (≈ 100 ids) |
| Project versions | `GET /project/{id\|slug}/version?loaders=["fabric"]&game_versions=["1.20.1"]&featured=` | Newest first. Omit filters to get all |
| Version | `GET /version/{id}` | |
| Versions (batch) | `GET /versions?ids=[...]` | |
| Project dependencies | `GET /project/{id}/dependencies` | Returns `{projects: [...], versions: [...]}`. Optional shortcut |
| Team members | `GET /project/{id}/members` | Authors on the details page |
| Version from hash | `GET /version_file/{hash}?algorithm=sha1` | Single lookup |
| Versions from hashes | `POST /version_files` body `{"hashes":[...],"algorithm":"sha1"}` | Returns a map from hash to Version. Missing hashes are simply absent |
| Latest version from hash | `POST /version_file/{hash}/update?algorithm=sha1` body `{"loaders":[...],"game_versions":[...]}` | |
| Latest versions from hashes | `POST /version_files/update` body `{"hashes":[...],"algorithm":"sha1","loaders":[...],"game_versions":[...]}` | Returns a map from hash to the newest matching Version. Used by update checks |
| Category tags | `GET /tag/category` | `[{icon (SVG string), name, project_type, header}]` |
| Loader tags | `GET /tag/loader` | `[{icon, name, supported_project_types}]` |
| Game versions | `GET /tag/game_version` | `[{version, version_type: release\|snapshot\|alpha\|beta, date, major}]` |
| Licenses | `GET /tag/license` | Optional filter |

Hash `algorithm` is `sha1` or `sha512`. Use `sha512` when it is known (mrpack), because it is collision-safe.

### 2.3 Search

Query parameters:

- `query`: free text. It may be empty.
- `index`: sort order, one of `relevance`, `downloads`, `follows`, `newest`, `updated`. Use `relevance` only when `query` is non-empty. Otherwise default to `downloads`.
- `offset`: 0-based.
- `limit`: default 10, **max 100**. Amethyst page sizes are 20, 50 or 100.
- `facets`: a JSON array of arrays. The **outer** array is AND and each **inner** array is OR. Example:

```json
[["project_type:mod"],["versions:1.20.1"],["categories:fabric","categories:quilt"],["categories:technology"]]
```

Facet keys used: `project_type`, `categories` (**loaders are categories in search**), `versions`, `client_side`, `server_side`, `license`, `open_source`. Operators are `:` (equals), `!=`, `>=`, `>`, `<=` and `<`, for example `downloads>1000`.

The response (fields relevant to the UI):

```json
{
  "hits": [{
    "project_id": "AABBCCDD", "project_type": "mod", "slug": "sodium",
    "title": "Sodium", "description": "...", "author": "jellysquid3",
    "categories": ["fabric","optimization"], "display_categories": ["optimization"],
    "versions": ["1.20.1","1.20.4"], "downloads": 123, "follows": 45,
    "icon_url": "https://cdn.modrinth.com/...", "date_created": "...", "date_modified": "...",
    "latest_version": "...", "license": "LGPL-3.0-only",
    "client_side": "required", "server_side": "unsupported",
    "gallery": ["..."], "featured_gallery": "...", "color": 1234567
  }],
  "offset": 0, "limit": 20, "total_hits": 4321
}
```

How Amethyst filters map to facets:

| Filter | Facet |
|---|---|
| Content type | `project_type:mod` / `resourcepack` / `shader` / `modpack`. Datapacks: `project_type:mod` plus `categories:datapack`. (Some API versions also accept `project_type:datapack`; verify against the live API.) |
| Game version | `versions:<mc>`. Default: the selected instance's Minecraft version. The user may clear it |
| Loader | OR group of `categories:<loader>`. Default: the instance loader. **Quilt instances use `["categories:quilt","categories:fabric"]`**. NeoForge on Minecraft 1.20.1 uses `["categories:neoforge","categories:forge"]`. Shaders use shader loaders: `iris`, `optifine`, `canvas`, `vanilla`. Resource packs need no loader facet |
| Categories | Each selected category becomes its own `categories:<name>` group (AND), or a single OR group. Pick one rule and keep it consistent. The reference used one OR group |
| Environment ("client mods" / "server mods") | Client: `[["client_side:required","client_side:optional"],["server_side:optional","server_side:unsupported"]]`. Server: `[["server_side:required","server_side:optional"],["client_side:optional","client_side:unsupported"]]` |
| License | `license:<spdx-id>` (optional) |

Pagination: "load more" (infinite scroll) increments `offset` by `limit` until `offset ≥ total_hits`.

### 2.4 Project and version shapes (subset used)

Project:

```json
{
  "id": "AABBCCDD", "slug": "sodium", "project_type": "mod", "title": "Sodium",
  "description": "short", "body": "markdown long description",
  "client_side": "required", "server_side": "unsupported",
  "categories": [], "additional_categories": [], "loaders": ["fabric","quilt"],
  "game_versions": ["1.20.1"], "versions": ["versionId", "..."],
  "downloads": 1, "followers": 1, "icon_url": "...", "color": 123,
  "license": {"id": "LGPL-3.0-only", "name": "...", "url": null},
  "issues_url": null, "source_url": null, "wiki_url": null, "discord_url": null,
  "donation_urls": [{"id": "patreon", "platform": "Patreon", "url": "..."}],
  "gallery": [{"url": "...", "featured": true, "title": "...", "description": "...", "created": "...", "ordering": 0}],
  "published": "...", "updated": "...", "status": "approved", "team": "teamId"
}
```

Version:

```json
{
  "id": "VVVVVVVV", "project_id": "AABBCCDD", "name": "Sodium 0.5.3",
  "version_number": "mc1.20.1-0.5.3", "changelog": "markdown",
  "version_type": "release", "featured": false, "status": "listed",
  "date_published": "2023-...", "downloads": 1,
  "game_versions": ["1.20.1"], "loaders": ["fabric","quilt"],
  "files": [{
    "url": "https://cdn.modrinth.com/data/.../file.jar",
    "filename": "sodium-fabric-0.5.3.jar", "primary": true, "size": 123,
    "hashes": {"sha1": "...", "sha512": "..."}, "file_type": null
  }],
  "dependencies": [{"project_id": "P1", "version_id": null, "file_name": null, "dependency_type": "required"}]
}
```

`dependency_type` is one of `required`, `optional`, `incompatible` or `embedded`. `version_id` may be null, meaning any compatible version.

**Choosing the file to install from a version:**

1. If the caller asked for a specific `filename`, use it.
2. Otherwise use the file with `primary: true`.
3. If none is primary: prefer `.jar` (mods) or `.mrpack` (modpacks) over `.zip`, else take `files[0]`.
4. Ignore files whose `file_type` marks them as auxiliary (`required-resource-pack`, `optional-resource-pack`, sources jars). Do not install those automatically.

### 2.5 Version list UX

- Default filter: instance Minecraft version plus instance loader (with the Quilt/NeoForge expansions above). A "show all versions" toggle removes the filters.
- Sort newest first by `date_published`. Do not rely on server order.
- Badge each version as release, beta or alpha. Mark the installed version: it matches the attributed `versionId` of a file in the instance, or else a file name match. Mark versions incompatible with the instance (Minecraft version or loader) and ask for confirmation before installing them.
- The default "Install" target is the newest compatible `release`. If no release exists, the newest compatible version, with a "pre-release" warning.

---

## 3. CurseForge API v1

### 3.1 Basics

- Base URL: `https://api.curseforge.com`
- **Every request carries the header `x-api-key: <key>`.** Also send `Accept: application/json`. A missing or invalid key returns HTTP 403.
- **Getting a key:** third-party applications apply through CurseForge's developer console (<https://console.curseforge.com/>) and agree to the CurseForge 3rd-Party API Terms. Amethyst must have its own key.
- **Key handling:**
  - Inject the key at build time from an environment variable or CI secret, into main-process code only. Never commit it, and never expose it to the renderer. The reference also injected it at build time.
  - Assume the key can be extracted from the app bundle, as it can from any desktop app. Rotation must therefore be a config change plus a release.
  - Builds without a key (forks, development) must degrade gracefully: hide CurseForge search, skip fingerprint attribution, and show a "CurseForge unavailable in this build" note. Do not send requests with an empty key.
  - Optional advanced setting: a user-supplied key overrides the built-in one, stored in the macOS Keychain via `safeStorage`.
- **Minecraft `gameId` = 432.**
- **Rate limits are not publicly documented.** Be conservative: at most 4 concurrent requests, batch wherever an endpoint allows it, cache aggressively, and back off on 429 and 5xx. Treat a 403 as a key problem: stop CurseForge calls for the session and show a banner.
- Response envelope: `{"data": ..., "pagination": {"index": 0, "pageSize": 20, "resultCount": 20, "totalCount": 1234}}`. `pagination` appears only on list endpoints.

### 3.2 Enumerations

Class ids (top-level content types for Minecraft):

| Class | id | Amethyst domain |
|---|---|---|
| Mods | 6 | mods |
| Resource Packs | 12 | resourcepacks |
| Worlds | 17 | saves (zip import) |
| Modpacks | 4471 | modpacks (see `modpacks.md`) |
| Shaders | 6552 | shaderpacks |
| Data Packs | 6945 | save datapacks |
| Customization | 4546 | not supported |
| Bukkit Plugins | 5 | not supported |

List them dynamically with `GET /v1/categories?gameId=432&classesOnly=true` and fall back to this table.

`modLoaderType`: 0 Any, 1 Forge, 2 Cauldron, 3 LiteLoader, 4 Fabric, 5 Quilt, 6 NeoForge.

`releaseType`: 1 Release, 2 Beta, 3 Alpha.

`hashes[].algo`: 1 SHA-1, 2 MD5.

`relationType` (file dependencies): 1 EmbeddedLibrary, 2 OptionalDependency, 3 RequiredDependency, 4 Tool, 5 Incompatible, 6 Include.

`sortField` (search): 1 Featured, 2 Popularity, 3 LastUpdated, 4 Name, 5 Author, 6 TotalDownloads, 7 Category, 8 GameVersion, 9 EarlyAccess, 10 FeaturedReleased, 11 ReleasedDate, 12 Rating.

`fileStatus`: 4 Approved and 10 Released are installable. Never offer files with statuses such as 6 MalwareDetected, 7 Deleted or 8 Archived, or files with `isAvailable == false`.

Mod `status`: 4 Approved is normal. 8 Abandoned, 7 Inactive and 9 Deleted get a warning badge.

### 3.3 Endpoints used

| Purpose | Request | Notes |
|---|---|---|
| Search | `GET /v1/mods/search` | §3.4 |
| Mod | `GET /v1/mods/{modId}` | |
| Mods (batch) | `POST /v1/mods` body `{"modIds":[...], "filterPcOnly": true}` | Chunk at about 100 |
| Description | `GET /v1/mods/{modId}/description` | Returns `{"data": "<html>"}`. **Sanitise** (§8) |
| Files of a mod | `GET /v1/mods/{modId}/files?gameVersion=&modLoaderType=&gameVersionTypeId=&index=&pageSize=` | `pageSize` max 50. Only send parameters that have values; do not send empty `gameVersion=` |
| File | `GET /v1/mods/{modId}/files/{fileId}` | |
| Files (batch) | `POST /v1/mods/files` body `{"fileIds":[...]}` | Chunk at about 100 |
| Changelog | `GET /v1/mods/{modId}/files/{fileId}/changelog` | Returns `{"data": "<html>"}`. Sanitise |
| Download URL | `GET /v1/mods/{modId}/files/{fileId}/download-url` | Returns `{"data": "url"}`. Use it when a File's `downloadUrl` is missing from a cached object. It fails or returns empty for distribution-restricted files |
| Fingerprint match | `POST /v1/fingerprints/432` body `{"fingerprints":[uint32...]}` | See `resources.md` §4.3. Never send an empty array |
| Fuzzy fingerprint | `POST /v1/fingerprints/fuzzy/432` | Not needed for v1 |
| Categories | `GET /v1/categories?gameId=432&classId={classId}` | `[{id, name, slug, iconUrl, classId, parentCategoryId, isClass, displayIndex}]` |
| Minecraft versions | `GET /v1/minecraft/version` | Optional. Amethyst can use Mojang's manifest instead |
| Loader versions | `GET /v1/minecraft/modloader` | Optional, used for modpack loader resolution |

### 3.4 Search parameters

| Param | Usage |
|---|---|
| `gameId` | always `432` |
| `classId` | content type (§3.2) |
| `categoryId` or `categoryIds` | category filter. `categoryIds` is a JSON array, up to 10 |
| `gameVersion` or `gameVersions` | Minecraft version. Default: the instance's version |
| `searchFilter` | free text |
| `sortField` + `sortOrder` (`asc`/`desc`) | see the mapping below. Always send `desc` for downloads, popularity and dates |
| `modLoaderType` | a single loader (number) |
| `modLoaderTypes` | several loaders, up to 5. **Verify the exact accepted encoding against the live API before shipping.** The reference sent an unquoted bracketed list of names, which is not valid JSON. Prefer the single `modLoaderType` whenever only one loader is needed |
| `index`, `pageSize` | `pageSize` max **50**. **`index + pageSize` must not exceed 10,000.** Cap the displayed total at 10,000 and stop "load more" at that point |
| `slug` | exact slug lookup (used by URL paste and modpacks) |

Loader filter defaults:

| Instance | CurseForge loader filter |
|---|---|
| Forge | Forge (1) |
| NeoForge | NeoForge (6). On Minecraft 1.20.1 also Forge (1) |
| Fabric | Fabric (4) |
| Quilt | Quilt (5) and Fabric (4) |
| Vanilla | none |

Non-mod classes (resource packs, shaders, worlds) need no loader filter.

### 3.5 Mod and File shapes (subset used)

Mod:

```json
{
  "id": 238222, "gameId": 432, "name": "JEI", "slug": "jei",
  "links": {"websiteUrl": "...", "wikiUrl": "...", "issuesUrl": "...", "sourceUrl": "..."},
  "summary": "short", "status": 4, "downloadCount": 1, "thumbsUpCount": 1,
  "isFeatured": false, "primaryCategoryId": 1, "classId": 6,
  "categories": [{"id": 421, "name": "API and Library", "iconUrl": "..."}],
  "authors": [{"id": 1, "name": "mezz", "url": "..."}],
  "logo": {"thumbnailUrl": "...", "url": "..."},
  "screenshots": [{"title": "...", "description": "...", "thumbnailUrl": "...", "url": "..."}],
  "mainFileId": 1, "latestFiles": [], "latestFilesIndexes": [
    {"gameVersion": "1.20.1", "fileId": 1, "filename": "...", "releaseType": 1, "gameVersionTypeId": 1, "modLoader": 1}
  ],
  "dateCreated": "...", "dateModified": "...", "dateReleased": "...",
  "allowModDistribution": true, "isAvailable": true
}
```

File:

```json
{
  "id": 4712345, "modId": 238222, "displayName": "jei-1.20.1-15.2.0.27",
  "fileName": "jei-1.20.1-forge-15.2.0.27.jar", "releaseType": 1, "fileStatus": 4,
  "isAvailable": true, "fileDate": "2023-...", "fileLength": 1234567,
  "downloadCount": 1, "downloadUrl": "https://edge.forgecdn.net/files/4712/345/...jar",
  "hashes": [{"value": "sha1hex", "algo": 1}, {"value": "md5hex", "algo": 2}],
  "gameVersions": ["1.20.1", "Forge", "NeoForge", "Client", "Server"],
  "sortableGameVersions": [{"gameVersionName": "Forge", "gameVersion": "", "gameVersionTypeId": 68441}],
  "dependencies": [{"modId": 306612, "relationType": 3}],
  "fileFingerprint": 123456789, "serverPackFileId": null
}
```

Interpreting `gameVersions`: the array mixes several kinds of string.

- Minecraft versions match `/^\d+\.\d+(\.\d+)?/`.
- Loader names: `Forge`, `NeoForge`, `Fabric`, `Quilt`, `LiteLoader`, `Rift`.
- Environments: `Client`, `Server`.
- Java versions: `Java 17` and similar.

Classify each entry with explicit rules, compare case-insensitively, and use `sortableGameVersions[].gameVersionName` as a secondary source. Do not treat "starts with a digit" as "Minecraft version", or `Java 8` entries break it the other way round.

### 3.6 Distribution-restricted files (`downloadUrl == null`)

When an author sets `allowModDistribution: false`, the API returns File objects whose `downloadUrl` is `null`. Third-party apps are expected **not** to download these automatically.

- The reference launcher built a guessed CDN URL anyway (`https://edge.forgecdn.net/files/<id/1000>/<id%1000>/<fileName>`, plus a `mediafiles.forgecdn.net` variant). This is undocumented and conflicts with the author's distribution choice and CurseForge's terms. It also computed the path by string slicing, which is wrong for ids whose last three digits have leading zeros (see Pitfalls).
- **Amethyst behaviour:**
  1. Mark such files "manual download required".
  2. Offer "Open on CurseForge" (`https://www.curseforge.com/minecraft/<class-slug>/<mod-slug>/download/<fileId>`), and watch `~/Downloads` for a file with matching `fileName` and SHA-1 or fingerprint, for up to 30 minutes.
  3. When a matching file appears, ingest it into the store and continue the install.
  4. The user can also drag the file onto the dialog.
- The bulk version of this flow (modpacks) is specified in `modpacks.md`.

### 3.7 Choosing a file

- **"Latest compatible" file:** list files with `gameVersion` and `modLoaderType` filters. Drop files that are not installable (`isAvailable == false` or a non-installable status). Optionally keep only `releaseType == 1`. **Sort by `fileDate` descending** and pick the first. Do not rely on response order.
- `latestFilesIndexes` on the Mod object gives a cheap "is there a file for Minecraft X and loader Y" answer for search-result badges. Use it before fetching file lists.

---

## 4. Unified marketplace model

### 4.1 Project entry (renderer view model)

```
ProjectEntry {
  key: string                // "modrinth:<id>" or "curseforge:<id>"
  platform: 'modrinth' | 'curseforge'
  id: string                 // platform id as a string
  slug, title, author, summary, iconUrl
  downloads: number
  followers: number          // Modrinth follows, CurseForge thumbsUpCount
  categories: string[]       // display names
  loaders: string[]
  gameVersions: string[]     // when known
  updatedAt: string
  side?: { client, server }  // Modrinth only
  installed: InstalledRef[]  // files in the current instance attributed to this project
  linked?: ProjectEntry      // the same project on the other platform, if known
}
```

### 4.2 Combined search

- Modrinth and CurseForge each have an on/off toggle. These toggles are launcher-wide preferences.
- Each enabled platform is queried in parallel with the same filters, translated per §2.3 and §3.4.
- **Merging:** interleave the two result lists (Modrinth #1, CurseForge #1, Modrinth #2, …), as the reference did, unless sort is "name", in which case merge-sort by title.
- **Shown total:** the sum of both totals, with CurseForge capped at 10,000.
- **Loading more:** each platform is paged independently. Remember each platform's offset, and stop fetching a platform when it is exhausted.
- **Cross-platform duplicates:** the reference relied on a downloaded project-mapping database (dropped). Amethyst heuristic: treat a Modrinth hit and a CurseForge hit as the same project when the slugs are equal (case-insensitive) **and** the normalised titles are equal, **or** when an installed local file is attributed to both. Show the merged entry once, with both platform badges, and prefer Modrinth data for display (or the user's preferred platform setting). Without a confident match, show both entries.
- **Installed decoration:** for every hit, check the instance's resources for attribution with the same project id and show "Installed" (or "Update available" if the update check produced a plan for it).
- **Local view:** a "Installed" tab lists the instance's own resources, filtered client-side by keyword and ranked by fuzzy similarity of title to keyword (the reference used a Dice coefficient). No network.

### 4.3 Sort mapping

| Amethyst sort | Modrinth `index` | CurseForge `sortField` |
|---|---|---|
| Relevance (default when there is a query) | `relevance` | 2 Popularity (CurseForge has no pure relevance for `searchFilter`; Featured (1) is an alternative) |
| Downloads (default without a query) | `downloads` | 6 TotalDownloads |
| Follows/popularity | `follows` | 2 Popularity |
| Recently updated | `updated` | 3 LastUpdated |
| Newest | `newest` | 11 ReleasedDate |

### 4.4 Filters panel

- **Game version:** a dropdown from Modrinth `GET /tag/game_version` (releases by default, with a toggle for snapshots). It defaults to the instance version and follows the instance when the user has not overridden it. Changing instance resets the filter only if it was still at the previous default.
- **Loader:** single select (Forge, NeoForge, Fabric, Quilt), defaulting to the instance loader. For resource packs and shaders the control is hidden (or shows shader loaders for Modrinth).
- **Categories:** Modrinth categories come from `/tag/category`, filtered by `project_type` and grouped by `header` (`categories`, `features`, `resolutions`, `performance impact`). CurseForge categories come from `/v1/categories?classId=`. The lists are separate per platform, because the taxonomies differ, and a category filter applies only to its own platform.
- **Environment:** Modrinth only (client, server, any).
- **Page size:** 20, 50 or 100, persisted. CurseForge is clamped to 50.
- **Platform toggles:** Modrinth and CurseForge.
- Filter state is reflected in the route or query so that back and forward navigation restore it.

### 4.5 Project details page

| Section | Modrinth | CurseForge |
|---|---|---|
| Header | title, author(s) (`/members`), icon, downloads, followers, updated, license, categories, loaders, client/server side | name, authors, logo, downloadCount, thumbsUpCount, dateModified, categories |
| Description | `body` (Markdown) rendered through a sanitising Markdown renderer | `/description` HTML, sanitised |
| Gallery | `gallery[]` | `screenshots[]` |
| Versions | §2.5 | Files list (§3.7), paged by 50, with the same filters and badges |
| Changelog | `version.changelog` (Markdown) | `/files/{id}/changelog` HTML (sanitised) |
| Dependencies | tree for the selected version (`resources.md` §10.3) | tree for the selected file |
| Links | issues, source, wiki, discord, donations | `links.*` |

Every external link opens in the default browser via `shell.openExternal`, after checking the scheme is `https:` (or `http:`). Never open links in-app.

### 4.6 Install from marketplace

1. Resolve the content type to a domain: Modrinth `project_type` mod→mods, resourcepack→resourcepacks, shader→shaderpacks, modpack→modpacks flow. CurseForge class ids per §3.2. Worlds go to save import and datapacks ask which world.
2. Resolve the file: §2.4 for Modrinth, §3.7 for CurseForge. Read the expected SHA-1 (CurseForge `algo 1`; Modrinth `hashes.sha1`, with `sha512` also known), the size and the download URL(s).
3. Show the dependency plan (`resources.md` §10.3) and conflicts (an existing file from the same project: offer "replace").
4. Download into the store with hash verification, then place it into the instance (`resources.md` §5.2). If the hash is already in the store, skip the download.
5. Record attribution immediately (`sources` table, `confidence = manifest`), so the item shows "Installed" without waiting for a hash lookup.
6. Report progress per file via the task system. Cancellation removes partial `.part` files.
7. Download hosts: Modrinth files come from `cdn.modrinth.com`. CurseForge files come from the `downloadUrl` host (`edge.forgecdn.net` or `mediafiles.forgecdn.net`). Both support HTTP range requests, so resume interrupted downloads when the server returns `Accept-Ranges`.

### 4.7 URL paste and deep links

Accept pasted URLs and resolve them to a project, then open its details page:

- `https://modrinth.com/<type>/<slug>[/version/<id>]`
- `https://www.curseforge.com/minecraft/<class-slug>/<slug>[/files/<fileId>]`

For CurseForge, resolve the slug with `GET /v1/mods/search?gameId=432&classId=<class>&slug=<slug>`.

---

## 5. Hash lookups (summary)

The full behaviour is in `resources.md` §9.4. API-side constraints:

- **Modrinth** `POST /version_files`: up to about 100 to 128 hashes per request. The response omits unknown hashes. The same file can exist in several versions (re-uploads). The API returns one of them, so prefer the version whose `files[]` entry with that hash is `primary`.
- **CurseForge** `POST /v1/fingerprints/432`: the response includes `exactMatches[]` (`file`, `latestFiles`), `exactFingerprints[]`, `partialMatches[]` and `unmatchedFingerprints[]`. Use only exact matches. `isCacheBuilt: false` means CurseForge's index is warming up. Treat that as "try again later", not as "no match".
- Never send duplicate fingerprints in one request. Two local files with the same fingerprint (duplicates) map back to both.

---

## 6. Caching

### 6.1 Layers

1. **In-flight de-duplication:** identical concurrent requests (same method, URL and body) share one promise.
2. **Memory LRU** (main process): about 500 entries or 50 MB.
3. **Persistent cache** (SQLite table in a separate `http-cache.sqlite`, or in the index):
   - columns: key, URL, status, body (compressed), `ETag`, `Last-Modified`, fetched_at, ttl;
   - size cap: 200 MB, with LRU eviction.
4. **Domain data:** attribution and hash results go into the resource index (`resources.md` §6), not the HTTP cache. They are effectively permanent for positive matches, with a negative-cache TTL of 7 days.

### 6.2 TTLs (stale-while-revalidate)

| Data | Fresh for | Serve stale up to | Notes |
|---|---|---|---|
| Tags (categories, loaders, game versions), CurseForge categories | 24 h | 30 d | Needed offline for filters |
| Search results | 5 min | 1 h (offline only) | Keyed by the full normalised filter set plus offset |
| Project / mod details, description, members | 1 h | 7 d | |
| Version lists / file lists | 10 min | 1 d | Update checks always bypass the fresh cache (max-age 0, revalidate) |
| Single version / file by id | 24 h | 30 d | Mostly immutable, but status can change (deleted or archived) |
| Changelog | 24 h | 30 d | |
| Hash → version (`version_files`) | stored in the index | n/a | |
| Latest-from-hash (`/version_files/update`) | 10 min | none | |

Rules:

- When a response has an `ETag` or `Last-Modified`, revalidate with `If-None-Match` or `If-Modified-Since`.
- "Stale-while-revalidate" means: return the cached value immediately, refresh in the background, and push the updated value to subscribers.
- A **manual refresh** (pull-to-refresh or a button) bypasses fresh entries.
- Never cache error responses, except a 404 on project or version lookups, which is cached for 1 h.
- **Offline mode:** when the network is unavailable, serve stale entries regardless of age, mark the UI "offline – showing cached results", and disable install buttons for content that is not in the store.
- The reference cached in the renderer instead: a localStorage-backed stale-while-revalidate cache with a 10-minute de-duplication interval, a 24 h default TTL and 30 s for search results, which was lost or limited by localStorage size. Moving the cache to main makes it shared across windows, larger and inspectable.

---

## 7. Rate limiting

### 7.1 Modrinth

- A client-side token bucket per process: capacity 250 per 60 s (headroom under the 300/min limit) and at most 6 concurrent requests.
- After every response, update the bucket from `X-Ratelimit-Remaining` and `X-Ratelimit-Reset`. If `Remaining` is below 10, delay new requests until the reset.
- On 429: pause **all** Modrinth requests until `X-Ratelimit-Reset` seconds have passed, then retry. If the UI is waiting, show "Modrinth is rate-limiting requests, retrying in N s".
- Prefer batch endpoints (`/projects`, `/versions`, `/version_files`, `/version_files/update`) over one request per item. A 300-mod instance's update check should cost under 10 requests, not 300 or more.
- Note: downloads from `cdn.modrinth.com` are not subject to the API limit, but still need sensible concurrency (6 to 8).

### 7.2 CurseForge

- At most 4 concurrent requests, and a soft cap of about 120 requests per minute. CurseForge does not publish its limits, so these are deliberately conservative.
- Batch: `POST /v1/mods`, `POST /v1/mods/files`, and one fingerprint request per scan.
- Per-mod file listing (update checks) has no batch endpoint. Use concurrency 4 and cache it. Use `latestFilesIndexes` from a batched `POST /v1/mods` first, to skip mods that clearly have no newer file for the target Minecraft version and loader.
- On 429 or 503: exponential backoff starting at 2 s, and honour `Retry-After`.
- On 403: probably a key problem. Disable CurseForge for the session and show a banner.

---

## 8. Security

- **Certificate verification is always on.** Use a corporate-proxy CA only through the OS trust store (Electron uses the macOS Keychain trust automatically).
- **HTML from CurseForge** (descriptions, changelogs) and **Markdown with inline HTML from Modrinth** are untrusted:
  - Sanitise with a strict allow-list: DOMPurify, or a sanitiser that keeps formatting tags, `a[href]` (http/https only), `img[src]` (https only), and tables.
  - Strip `script`, `style` attributes that can hide content off-screen, `iframe` (or allow only YouTube embeds, replaced by a click-to-open thumbnail), forms and event handlers.
  - Render inside the renderer with a CSP that forbids inline script.
- Images in descriptions load from arbitrary hosts. Allow them under `img-src https:`, or proxy them through the main process with size limits.
- Downloaded files are verified against the platform hash **before** placement. A hash mismatch deletes the file, retries once, and then fails with a clear error.
- File names from APIs are sanitised before touching the filesystem (`resources.md` §5.3).
- Never follow a download redirect to a non-https URL.

---

## 9. Error states (UI)

| Situation | UI |
|---|---|
| A platform is unreachable | Banner for that platform only, with the other platform's results still shown, plus a retry button |
| CurseForge key missing or invalid | CurseForge toggle disabled, with a tooltip explaining why |
| Rate limited | Inline "retrying in N s" message. Do not show raw 429 errors |
| Project deleted (404) | Details page shows "This project is no longer available". Installed files keep working. The attribution remains, with a "removed from platform" badge |
| Distribution-restricted CurseForge file | "Manual download required" flow (§3.6) |
| Empty results | Suggest clearing the game-version or loader filters, naming the active ones |

---

## 10. Pitfalls / bugs observed in the original

1. **TLS verification disabled.** The reference's shared HTTP agent was configured not to reject unauthorised certificates (`rejectUnauthorized: false`), so every API call and download was open to man-in-the-middle attacks. Amethyst must keep verification on.
2. **Renderer-side authenticated proxy.** The CurseForge key was added to *any* renderer `https` request to `api.curseforge.com` by a protocol interceptor. It works, but it makes the renderer a confused deputy. Use typed main-process calls.
3. **Guessed CDN URLs for restricted files.** For `downloadUrl == null`, the reference built `edge.forgecdn.net`/`mediafiles.forgecdn.net` URLs by slicing the decimal file id into its first four characters and the remainder. This bypasses the author's distribution setting. It also produces wrong paths when the remainder has leading zeros: file `4000012` must map to `/4000/12/`, not `/4000/012/`. It would also break for ids that do not have exactly 7 digits.
4. **CurseForge multi-loader search.** The `modLoaderTypes` parameter was sent as an unquoted list of names, with a name table that lacked NeoForge, so NeoForge became `undefined` when several loaders were selected.
5. **Empty query parameters.** CurseForge file listing always appended `gameVersion=`, `gameVersionTypeId=`, `index=` and `pageSize=` even when empty. Send only the parameters that have values.
6. **Server order trusted.** "Latest file" was `files[0]`, which assumes the server sorts files newest-first.
7. **Fingerprint requests with bad values.** Empty arrays and `NaN` fingerprints were sent until fixed, causing HTTP 400 "Fingerprints are required." at scale.
8. **Batch-killing ids.** File paths stored as Modrinth version ids made `GET /versions?ids=[...]` fail for the whole batch. Validate ids client-side.
9. **Quilt and NeoForge loader expansion missing.** Searches, update checks and dependency resolution asked only for the instance's exact loader, which hid Fabric mods from Quilt users and Forge mods from NeoForge 1.20.1 users.
10. **Missing-dependency fallback uses one loader.** When resolving a dependency without a pinned version, only the *first* instance loader was used to filter versions.
11. **Cache in renderer localStorage.** The 24 h stale-while-revalidate cache lived in localStorage (size-limited, per-window, opaque). Search results used a 30 s TTL but a 10-minute de-duplication interval, so the effective freshness was unclear.
12. **"Relevance" maps to "Popularity" on CurseForge.** This is unavoidable, but the UI did not tell users that the two platforms rank differently.
13. **Cross-platform de-duplication depends on a proprietary mapping database.** Without it, duplicates appear. Amethyst needs its own heuristic (§4.2).
14. **Displayed totals.** CurseForge totals were silently capped at 10,000 while Modrinth totals were added on top. The combined count misleads.
15. **Fuzzy installed-version matching.** A version counted as "installed" if a local file name equalled the version *name* or *number*, which can false-positive for generic names like `1.0.0`. Prefer attribution and exact file name only.
16. **The `filter` parameter.** The reference always sent Modrinth's deprecated `filter=` parameter, empty. It is harmless, but unnecessary.

---

## Appendix: Maybe (not v1)

**Favourites and collections**

- Local favourites: a star on any project, stored in launcher settings as `platform:id`. A "Favourites" tab lists them (batched `/projects` and `POST /v1/mods` to hydrate).
- Modrinth collections and follows need a Modrinth login (OAuth or personal access token, sent in the `Authorization` header):
  - `GET /user/{id}/collections` (v3 API for collections);
  - follow and unfollow: `POST`/`DELETE /project/{id}/follow`;
  - `GET /user/{id}/follows`.

  The reference supported these. Implement only if a Modrinth account integration is added.

**Other**

- A "server pack" install for CurseForge files with `serverPackFileId` is out of scope, because server hosting is dropped.
