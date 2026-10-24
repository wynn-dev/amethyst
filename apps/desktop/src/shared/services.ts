/**
 * The RPC surface. Methods must be async and take/return structured-cloneable data only.
 *
 * `RuntimeServices` live in the runtime utility process; `MainServices` live in the Electron
 * main process and cover only window/OS integration. `HostServices` are Electron-only APIs
 * the runtime borrows from main (never exposed to the renderer).
 *
 * Conventions used by every domain below:
 *
 * - **Rows vs details.** `list`-style calls return small, flat *row* objects (about 1 KB each)
 *   meant for virtualised lists. Fetch the full object with the matching `get` call when a
 *   detail view opens.
 * - **Change events, not state.** Mutations push small `…:changed` events (see `events.ts`)
 *   carrying ids or changed keys. Refetch (or patch your cache) on receipt; never poll.
 * - **`null` clears a field.** Structured clone drops `undefined` keys, so patches use `null`
 *   to mean "reset to the default / global value / remove". Keys that are left out are not
 *   touched.
 * - **Errors** reject with `{ name, message, code }` (plus optional structured `details`); map
 *   `code` to UI text. Common codes: `EINVALID_ARGUMENT`, `ENOT_FOUND`, `EBUSY`, `ECANCELLED`,
 *   `EUNAVAILABLE`, `ERUNTIME_RESTARTED`.
 * - **Long work** (copies, installs, backups) runs as a task (see {@link TasksService}); the call
 *   resolves when the work is done, and progress arrives through `tasks:update`.
 * - **Local files are never sent over IPC.** Images are referenced by `amethyst-asset://` URLs
 *   (see `shared/paths.ts`), remote images by their `https:` CDN URL.
 */
import type { Consent, EventProps, RendererEventName } from '@amethyst/telemetry/events'

export type { Consent as TelemetryConsent, RendererEventName } from '@amethyst/telemetry/events'

// =============================================================================================
// App and runtime status
// =============================================================================================

/** Versions shown on the About page. */
export interface AppInfo {
  /** Amethyst's own version. */
  version: string
  /** Bundled Electron, Chromium and Node versions. */
  electron: string
  chrome: string
  node: string
}

/** App-level information, served by the main process. */
export interface AppService {
  getInfo(): Promise<AppInfo>
}

/** Health of the runtime's SQLite index (a cache: the app keeps working without it). */
export interface IndexStatus {
  /** The index opened and migrated. */
  ok: boolean
  /** `PRAGMA user_version` of the open index. */
  schemaVersion?: number
  /** Why the index is unavailable, when it is. */
  error?: string
}

/** Diagnostics of the runtime process itself. */
export interface RuntimeStatusService {
  /** Liveness plus boot health (`bootMs`: process start to services ready). Waits for boot to finish. */
  ping(): Promise<{ pid: number; uptimeMs: number; memoryRss: number; bootMs: number; index: IndexStatus }>
}

// =============================================================================================
// Shared helpers
// =============================================================================================

/** A field-level patch: `undefined`/absent leaves a key alone, `null` resets it. */
export type Patch<T> = { [K in keyof T]?: T[K] | null }

/** A deep patch for nested settings objects. `null` at any level resets that subtree. */
export type DeepPatch<T> = {
  [K in keyof T]?: (T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPatch<T[K]> : T[K]) | null
}

/** Mod loaders an instance can run. `null` loader means vanilla. */
export type LoaderKind = 'forge' | 'neoforge' | 'fabric' | 'quilt'

/** Where marketplace content comes from. */
export type MarketPlatform = 'modrinth' | 'curseforge'

// =============================================================================================
// Settings
// =============================================================================================

/** `light`/`dark` force a scheme; `system` follows macOS appearance live. */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * Theme settings (the kept subset of the theme system: mode, accent, background and blur).
 * Colours are `#RRGGBB`.
 */
export interface AppearanceSettings {
  /** Colour scheme. The window chrome should follow it too (`nativeTheme.themeSource`). Default `system`. */
  theme: ThemeMode
  /** Accent colour for buttons, links, selection and focus rings. Default `#9b5de5`. */
  accentColor: string
  /** A full-window image or video behind the UI. */
  background: {
    /** What is drawn behind the UI. Default `none`. */
    kind: 'none' | 'image' | 'video'
    /**
     * The media file, relative to the data root (always inside `theme-media/`), or `null`.
     * Set it with {@link SettingsService.setBackground}; render it with `assetUrl(file)`.
     */
    file: string | null
    /** CSS object-fit. Default `cover`. */
    fit: 'cover' | 'contain'
    /** Gaussian blur on the background media in px, 0–30. Default 0. */
    blur: number
    /** Draw the translucent surface colour over the media on pages other than Home. Default true. */
    overlay: boolean
  }
  /** Backdrop blur in px (0–30) behind cards and the sidebar. Defaults 20 and 4. */
  blur: { card: number; sidebar: number }
  /** macOS window vibrancy (needs a window restart). Default false. */
  vibrancy: boolean
}

/** Global launch defaults. Every field can be overridden per instance. */
export interface GameSettings {
  /** Which Java runs the game. */
  java: {
    /**
     * How Java is chosen when the instance does not pin one:
     * - `auto`: an Amethyst-managed runtime matching the version's required major (downloaded if missing);
     * - `prefer-installed`: a compatible arm64 JDK already on the Mac first, else `auto`;
     * - `custom`: `path` when it is compatible, else `auto`.
     * Default `auto`.
     */
    policy: 'auto' | 'prefer-installed' | 'custom'
    /** Absolute path of a `java` executable used by the `custom` policy, `''` when unset. */
    path: string
  }
  /** Heap size. */
  memory: {
    /** `unassigned`: let the JVM decide. `auto`: computed from mod count and RAM. `manual`: min/max below. */
    mode: 'unassigned' | 'auto' | 'manual'
    /** `-Xms` in MB for manual mode; 0 omits it. Must not exceed `maxMB` when both are set. */
    minMB: number
    /** `-Xmx` in MB for manual mode; 0 omits it. */
    maxMB: number
  }
  /** Extra JVM arguments as argv tokens (never split on spaces). */
  jvmArgs: string[]
  /** Extra game arguments as argv tokens. */
  gameArgs: string[]
  /** Extra environment variables for the game process. */
  env: Record<string, string>
  /** Command placed before the java executable, e.g. `/usr/bin/caffeinate -i`. `''` when unset. */
  wrapperCommand: string
  /** Shell command run (and awaited) in the instance folder before launch. `''` when unset. */
  preLaunchCommand: string
  /** Default window size. 0 means "game default". */
  resolution: { width: number; height: number; fullscreen: boolean }
  /** Skip the asset/library integrity check before launch ("fast launch"). Default false. */
  skipVerification: boolean
  /** Hide the launcher window while the game runs. Default true. */
  hideLauncherWhileRunning: boolean
  /** Open the live game log when the game starts. Default false. */
  openLogOnStart: boolean
  /**
   * Swap LWJGL and other natives for arm64 builds: `legacy-only` (Minecraft below 1.19, the
   * default), `all`, or `off` (old versions then need an x86_64 Java under Rosetta).
   */
  replaceArm64Natives: 'legacy-only' | 'all' | 'off'
}

/** Launcher-wide settings, persisted in `settings.json`. */
export interface Settings {
  /** General preferences. */
  general: {
    /** Extra diagnostics, raw error details, offline accounts without a Microsoft account. */
    developerMode: boolean
    /** Mask e-mail addresses and account names in the UI. */
    streamerMode: boolean
    /** Accelerator for the command palette; `''` means the built-in default (⌘K). */
    commandPaletteShortcut: string
  }
  /** Theme. */
  appearance: AppearanceSettings
  /** Launch defaults that instances can override. */
  game: GameSettings
  /** HTTP behaviour for downloads and API calls. */
  network: {
    /** Use `proxyUrl` (kept when turned off). Default false. */
    proxyEnabled: boolean
    /** `scheme://host:port`, `''` when unset. */
    proxyUrl: string
    /** Concurrent connections per host for file downloads, 1–64. Default 16. */
    maxConnectionsPerHost: number
    /** Concurrent API requests (Modrinth/CurseForge/Mojang), 1–32. Default 8. */
    maxApiConnections: number
  }
  /** Launcher updates (applied by the main process's updater). */
  updates: {
    /** Download available updates in the background. Default false. */
    autoDownload: boolean
    /** Install a downloaded update when the app quits. Default false. */
    installOnQuit: boolean
    /** Offer pre-release builds. Default false. */
    includePrereleases: boolean
  }
  /** Telemetry consent (both off by default; see DECISIONS). */
  privacy: {
    /** "Share usage data". */
    usageData: boolean
    /** "Send crash reports". */
    crashReports: boolean
    /** True once the first-run consent prompt has been answered. */
    prompted: boolean
  }
  /** World backups. */
  backups: {
    /** Back up worlds automatically before version or modpack changes. Default true. */
    automatic: boolean
    /** Automatic backups kept per world (manual backups are never pruned). 1–100, default 5. */
    keep: number
  }
}

/** A patch for {@link Settings}. `null` at any key resets it (and everything below) to the default. */
export type SettingsPatch = DeepPatch<Settings>

/** Well-known folders, for "Show in Finder" buttons. All absolute. */
export interface DataPaths {
  /** `~/Library/Application Support/Amethyst`. */
  dataRoot: string
  /** Managed instance folders. */
  instances: string
  /** World backups. */
  backups: string
  /** Log files (`~/Library/Logs/Amethyst`). */
  logs: string
}

/** Facts about the Mac, for the memory settings UI. */
export interface SystemInfo {
  /** Physical memory. */
  totalMemoryMB: number
  /** Memory free right now. */
  freeMemoryMB: number
  /** Logical CPU cores. */
  cpuCount: number
}

/** Global settings (runtime). */
export interface SettingsService {
  /** The current settings (always complete; invalid or missing fields read as defaults). */
  get(): Promise<Settings>
  /**
   * Apply a deep patch and persist it. The whole patch is validated first; any invalid value
   * rejects with `EINVALID_SETTINGS` (`details.keys` lists the offending dotted keys) and
   * nothing is applied. Emits `settings:changed` with the keys that actually changed.
   */
  patch(patch: SettingsPatch): Promise<Settings>
  /** Restore every setting to its default (accounts, instances and the data root are untouched). */
  reset(): Promise<Settings>
  /**
   * Use an image or video file as the background: the file is type-checked by its content,
   * copied (APFS clone) into `theme-media/` and set as `appearance.background`. `null` clears the
   * background and deletes the previous copy. Rejects with `EUNSUPPORTED_MEDIA`.
   */
  setBackground(source: { path: string } | null): Promise<Settings>
  /** Where things live on disk. */
  getPaths(): Promise<DataPaths>
  /** Memory and CPU facts for the memory slider. */
  getSystemInfo(): Promise<SystemInfo>
}

// =============================================================================================
// Instances
// =============================================================================================

/** Desired component versions. `''` means "not used". At most one loader is non-empty. */
export interface InstanceRuntime {
  /** Minecraft version id, e.g. `1.21.1` or `24w14a`. Required. */
  minecraft: string
  /** Forge version without the Minecraft prefix, e.g. `47.2.0`. */
  forge: string
  /** NeoForge version, e.g. `21.1.65`. */
  neoforge: string
  /** Fabric Loader version, e.g. `0.16.5`. */
  fabric: string
  /** Quilt Loader version. */
  quilt: string
}

/** A server the game joins on start. */
export interface AutoJoinServer {
  /** Host name or IP address. */
  host: string
  /** Default 25565. */
  port?: number
  /** Distinguishes `servers.dat` entries with the same host. */
  name?: string
}

/**
 * Per-instance overrides of {@link GameSettings}. An absent key means "use the global setting";
 * in an {@link InstancePatch} send `null` to remove an override.
 */
export interface InstanceOverrides {
  /** Absolute path of a `java` executable (arm64 or universal preferred). */
  javaPath?: string
  /** Heap size; `minMB` must not exceed `maxMB` when both are non-zero. */
  memory?: { mode: 'auto' | 'manual'; minMB: number; maxMB: number }
  /** JVM arguments as argv tokens. */
  jvmArgs?: string[]
  /** Game arguments as argv tokens. */
  gameArgs?: string[]
  /** Merged over the global env; the instance wins per key. */
  env?: Record<string, string>
  /** Command placed before java. */
  wrapperCommand?: string
  /** Shell command run in the instance folder before launch. */
  preLaunchCommand?: string
  /** Window size or fullscreen. */
  window?: { width?: number; height?: number; fullscreen?: boolean }
  /** Join this server when the game starts. */
  autoJoinServer?: AutoJoinServer
  /** Hide the launcher while this instance runs. */
  hideLauncherOnLaunch?: boolean
  /** Open the game log when this instance starts. */
  showLogWindow?: boolean
  /** Skip the asset and library check before launch. */
  skipAssetVerification?: boolean
}

/** Where an instance's content came from (modpack update checks). */
export type InstanceUpstream =
  | { kind: 'modrinth'; projectId: string; versionId: string; packSha1?: string }
  | { kind: 'curseforge'; projectId: number; fileId: number; packSha1?: string }

/** Health of an instance entry in the index. */
export type InstanceState =
  /** Loaded normally. */
  | 'ok'
  /** An external (linked) folder that is not reachable, e.g. an unmounted drive. */
  | 'missing'
  /** The folder exists but `.amethyst/instance.json` is unreadable. Offer {@link InstancesService.repair}. */
  | 'broken'

/** One row of the instance list. */
export interface InstanceSummary {
  /** Stable id; survives renames and folder moves. */
  id: string
  /** Display name (unique, case-insensitively). */
  name: string
  /** Whether the instance can be used; see {@link InstanceState}. */
  state: InstanceState
  /** `amethyst-asset://` URL of the icon, or `null` for the default (pick it by `loader`). */
  iconUrl: string | null
  /** Minecraft version, `''` if unknown (broken/missing instances). */
  minecraft: string
  /** The loader and its version, or `null` for vanilla. */
  loader: { kind: LoaderKind; version: string } | null
  /** True when the folder lives outside the data root (imported "in place"). */
  external: boolean
  /** When the instance was created (epoch ms). */
  createdAt: number
  /** Last time the user selected it (epoch ms; drives "recent" sorting). */
  lastOpenedAt: number
  /** Last game start (epoch ms), 0 when never played. */
  lastPlayedAt: number
  /** Total time the game ran, in ms. */
  playTimeMs: number
}

/** Everything about one instance, for the detail and edit views. */
export interface InstanceDetail extends InstanceSummary {
  /** Absolute folder path (the game directory). */
  path: string
  /** Default author for modpack export. */
  author: string
  /** Free text; the modpack summary on export. */
  description: string
  /** `https:` page of the instance's modpack, `''` when none. */
  homepageUrl: string
  /** What the instance runs. */
  runtime: InstanceRuntime
  /** Pinned installed version id, `''` when none. */
  versionId: string
  /** Per-instance launch settings; absent keys use the global {@link GameSettings}. */
  overrides: InstanceOverrides
  /** The modpack this instance came from, if any. */
  upstream: InstanceUpstream | null
}

/** An image to use as an instance icon. Images are type-checked by content and capped at 8 MB. */
export type IconSource = { path: string } | { url: string } | { dataUrl: string }

/** Input for {@link InstancesService.create}. */
export interface CreateInstanceInput {
  /** Display name. Empty: generated from the runtime (e.g. `1.21.1-fabric0.16.5`). Made unique. */
  name?: string
  /** The Minecraft version is required; at most one loader. */
  runtime: Partial<InstanceRuntime> & { minecraft: string }
  author?: string
  description?: string
  /** Copied into the instance folder; a failure leaves the instance without an icon. */
  icon?: IconSource
  overrides?: InstanceOverrides
  /** Modpack origin (set by modpack imports). */
  upstream?: InstanceUpstream
}

/**
 * Editable instance fields. `null` removes overrides and resets other fields to empty.
 * Timestamps and play time are not editable. Changing `runtime` clears `versionId` unless the
 * same patch sets it.
 */
export interface InstancePatch {
  /** A new display name; managed folders are renamed to match (see {@link InstancesService.rename}). */
  name?: string
  author?: string | null
  description?: string | null
  homepageUrl?: string | null
  /** Components to change; `null` or `''` removes a loader. */
  runtime?: Partial<InstanceRuntime>
  versionId?: string | null
  /** Per override: a value sets it, `null` returns to the global setting. */
  overrides?: Patch<InstanceOverrides>
  upstream?: InstanceUpstream | null
}

/** Result of validating a folder for "Import existing folder". */
export type FolderCheck =
  /** Can be imported. */
  | 'ok'
  | 'missing'
  | 'not-a-directory'
  /** macOS privacy protection (Desktop, Documents, removable volumes) or file permissions block access. */
  | 'no-permission'
  /** Already an instance in Amethyst. */
  | 'already-registered'
  /** Inside Amethyst's own data folder. */
  | 'inside-managed-root'
  /** A disk root (`/`, `/Volumes/X`) or the home folder itself. */
  | 'is-volume-root'
  /** Inside an application bundle. */
  | 'inside-app-bundle'
  /** `.amethyst/instance.json` exists but cannot be read. */
  | 'bad'

/** What {@link InstancesService.inspectFolder} found in a folder. */
export interface ImportCandidate {
  /** The resolved folder. */
  path: string
  /** Whether it can be imported. */
  check: FolderCheck
  /** `amethyst`: already an Amethyst instance. `game-dir`: a plain `.minecraft`-style folder. `empty`: nothing recognisable. */
  kind: 'amethyst' | 'game-dir' | 'empty'
  /** Suggested display name (folder name or the stored name). */
  name: string
  /** Best-effort runtime detected from `versions/` or the stored instance. Ask the user to confirm. */
  runtime: Partial<InstanceRuntime> | null
  /** Jars in `mods/`. */
  modCount: number
  /** Worlds in `saves/`. */
  worldCount: number
}

/** Input for {@link InstancesService.import}. */
export interface ImportInstanceInput {
  /** Absolute folder path. */
  path: string
  /** `in-place`: register the folder where it is. `copy`: clone it into the managed `instances/` folder. */
  mode: 'in-place' | 'copy'
  /** Display name; default the folder's (or stored) name. Made unique. */
  name?: string
  /** Required unless the folder is already an Amethyst instance. */
  runtime?: Partial<InstanceRuntime> & { minecraft: string }
}

/** Options for {@link InstancesService.delete}. */
export interface DeleteInstanceOptions {
  /**
   * Managed instances: move every world in `saves/` to `rescued-worlds/` before the folder goes to
   * the Trash. Default true. External instances are only unregistered; their files are never touched.
   */
  rescueWorlds?: boolean
}

/** What {@link InstancesService.delete} did. */
export interface DeleteInstanceResult {
  /** False for external instances (unregistered only). */
  trashed: boolean
  /** Worlds moved out of the instance, with their new absolute paths. */
  rescuedWorlds: { name: string; path: string }[]
}

/** The instance index and instance operations (runtime). */
export interface InstancesService {
  /** Every known instance as a summary row, most recently opened first. */
  list(): Promise<InstanceSummary[]>
  /** One instance in full. Rejects with `ENOT_FOUND`. */
  get(id: string): Promise<InstanceDetail>
  /** Create a managed instance (the game version is installed later, at first launch). */
  create(input: CreateInstanceInput): Promise<InstanceDetail>
  /** Apply a patch. A changed `name` renames the folder too (see {@link rename}). */
  update(id: string, patch: InstancePatch): Promise<InstanceDetail>
  /**
   * Change the display name and, for managed instances, move the folder to match (when the new
   * folder name is free and the instance is not busy). Rejects with `EBUSY` while it is running.
   */
  rename(id: string, name: string): Promise<InstanceDetail>
  /**
   * Copy an instance (APFS clones, so it is near-instant and takes no extra space). The copy gets
   * a fresh id, timestamps and play time, and keeps `upstream`. Runs as a cancellable task.
   */
  duplicate(id: string, name?: string): Promise<InstanceDetail>
  /** Move a managed instance to the macOS Trash (rescuing worlds), or unregister an external one. */
  delete(id: string, options?: DeleteInstanceOptions): Promise<DeleteInstanceResult>
  /** Classify a folder before importing it. Never writes anything. */
  inspectFolder(path: string): Promise<ImportCandidate>
  /** Register an existing folder (in place) or copy it in. */
  import(input: ImportInstanceInput): Promise<InstanceDetail>
  /** Rewrite a `broken` instance's metadata from scratch (the unreadable file is kept as `.corrupt-<ts>`). */
  repair(id: string, runtime: Partial<InstanceRuntime> & { minecraft: string }): Promise<InstanceDetail>
  /** Set (or with `null`, remove) the icon. The image is copied into the instance folder. */
  setIcon(id: string, icon: IconSource | null): Promise<InstanceDetail>
  /** Record that the user selected the instance (sorting by recency). */
  markOpened(id: string): Promise<void>
}

// =============================================================================================
// Resources (mods, resource packs, shader packs, worlds) and world backups
// =============================================================================================

/** The content folders of an instance. */
export type ResourceKind = 'mods' | 'resourcepacks' | 'shaderpacks' | 'saves'

/** Why a file could not be read. Expected user-file problems, shown once per file. */
export interface ResourceProblem {
  /** Stable code: zip damage, a vanished or unreadable file, or a pack without its marker file. */
  code: 'invalid-zip' | 'multi-disk-zip' | 'bad-central-directory' | 'size-mismatch' | 'not-found' | 'permission-denied' | 'not-a-pack' | 'nested-too-deep' | 'unknown'
  /** Technical detail for tooltips and diagnostics. */
  message: string
}

/** Marketplace attribution of a file (from install provenance or a hash lookup). */
export interface ResourceSource {
  platform: MarketPlatform
  /** Modrinth project id, or the CurseForge mod id as a string. */
  projectId: string
  /** Modrinth version id, or the CurseForge file id as a string. */
  versionId: string
}

/** One row in a content list. Small and flat; fetch {@link ResourceDetail} for the rest. */
export interface ResourceRow {
  /**
   * Stable id within `(instance, kind)`: the case-folded file name without `.disabled`, so a row
   * keeps its id when it is enabled or disabled.
   */
  id: string
  /** The folder the row belongs to. */
  kind: ResourceKind
  /** Name on disk (including any `.disabled`). */
  fileName: string
  /** Display name from the metadata, falling back to the file name. */
  name: string
  /** Version string, `''` when unknown. */
  version: string
  /** First 200 characters of the description, formatting codes stripped. */
  summary: string
  /** First three authors. */
  authors: string[]
  /** `amethyst-asset://` URL of the icon, or `null`. */
  iconUrl: string | null
  /**
   * Mods: not `.disabled`. Resource packs: listed in `options.txt`. Shader packs: the active pack.
   * Worlds: always true.
   */
  enabled: boolean
  /** Mods: every loader whose metadata parsed. */
  loaders: LoaderKind[]
  /** Unpacked resource/shader packs and worlds are folders. */
  isDirectory: boolean
  /** File size in bytes (0 for folders and worlds). */
  size: number
  /** Last modification (epoch ms; for worlds, of `level.dat`). */
  mtimeMs: number
  /** SHA-1 of the file (`null` for folders and while it is still being hashed). */
  sha1: string | null
  /** Marketplace attribution, once known. */
  source: ResourceSource | null
  /** Set when the file is broken or not what its folder expects. */
  problem: ResourceProblem | null
  /** True while the file is listed but not yet hashed and parsed (first scan of a cold index). */
  pending: boolean
  /** Worlds only. */
  world?: {
    /** `LevelName` from `level.dat` (separate from the folder name). */
    levelName: string
    /** e.g. `1.21.1`; absent for pre-1.9 worlds. */
    versionName?: string
    gameMode?: 'survival' | 'creative' | 'adventure' | 'spectator'
    hardcore: boolean
    /** Commands allowed (`allowCommands`). */
    cheats: boolean
    /** Epoch ms. */
    lastPlayed?: number
  }
}

/** Query for {@link ResourcesService.list}. */
export interface ResourceQuery {
  /** Default 0. */
  offset?: number
  /** Default 200, at most 1000. */
  limit?: number
  /** Case-insensitive substring match on name, file name and authors. */
  search?: string
  /** Default `name`. */
  sort?: 'name' | 'fileName' | 'modified' | 'size'
  /** Only enabled (`true`) or disabled (`false`) rows. */
  enabled?: boolean
}

/** A page of rows. */
export interface ResourcePage {
  /** The requested slice. */
  items: ResourceRow[]
  /** Rows matching the query (before paging). */
  total: number
  /** A scan of this folder is running; more `resources:changed` events will follow. */
  scanning: boolean
  /** Increases whenever the list changes; compare with `resources:changed.revision`. */
  revision: number
}

/** A dependency declared by a mod. */
export interface ResourceDependency {
  /** Target mod id. */
  modId: string
  /** Version range verbatim (Maven syntax for Forge/NeoForge, predicates for Fabric/Quilt). */
  range?: string
  /** The game refuses to start without it. */
  required: boolean
  kind: 'depends' | 'recommends' | 'suggests' | 'breaks' | 'conflicts'
}

/** Full information about one resource. */
export interface ResourceDetail extends ResourceRow {
  /** Absolute path (for "Reveal in Finder"). */
  path: string
  /** Full description, formatting codes stripped. */
  description: string
  /** Every author. */
  allAuthors: string[]
  license?: string
  /** Links declared by the mod. Open them in the browser after checking the scheme. */
  links: { homepage?: string; issues?: string; sources?: string }
  /** Mod id from the metadata. */
  modId?: string
  /** Where the mod must be installed. */
  side?: 'client' | 'server' | 'both'
  /** Relationships declared by the preferred loader's metadata. */
  dependencies: ResourceDependency[]
  /** Mod ids (and aliases) this file provides, with versions. */
  provides: Record<string, string>
  /** The Minecraft versions the mod declares (verbatim range). */
  minecraftRange?: string
  /** Resource packs: the supported pack formats. */
  packFormats?: { min: number; max: number }
  /** Non-fatal metadata problems, e.g. "pack is nested one level too deep". */
  warnings: string[]
  /** Worlds: seed, difficulty and other `level.dat` details. */
  worldDetail?: { seed?: string; difficulty?: string; dataVersion?: number; sizeBytes?: number }
}

/** Result of a bulk operation: the ids that succeeded and the ones that failed. */
export interface BulkResult {
  /** Row ids (for `add`: the new rows) that succeeded. */
  done: string[]
  /** What failed, with a stable code. For `add`, `id` is the source path. */
  failed: { id: string; code: string; message: string }[]
}

/** One world backup. */
export interface BackupRow {
  /** `<world folder>/<stamp>`; pass it back to restore or delete. */
  id: string
  /** World folder the backup was taken from. */
  world: string
  /** `LevelName` at backup time. */
  worldName: string
  /** Why it was taken. */
  reason: 'manual' | 'pre-launch' | 'pre-version-change' | 'pre-modpack-update' | 'pre-restore' | 'unknown'
  /** Automatic backups are pruned to the `backups.keep` setting; manual ones never are. */
  automatic: boolean
  /** Epoch ms. */
  createdAt: number
  /** Zip size in bytes. */
  size: number
  /** Game version that last saved the world. */
  versionName?: string
}

/** Instance content folders and world backups (runtime). */
export interface ResourcesService {
  /**
   * List one content folder. Never waits for hashing: on a cold index the first page lists file
   * names immediately (`pending: true`) and a background scan fills in metadata, announced by
   * `resources:changed`. Unchanged files are served from the index without being read.
   */
  list(instanceId: string, kind: ResourceKind, query?: ResourceQuery): Promise<ResourcePage>
  /** One resource in full. Rejects with `ENOT_FOUND`. */
  get(instanceId: string, kind: ResourceKind, id: string): Promise<ResourceDetail>
  /**
   * Keep this instance's folders live: starts one debounced, coalescing file watcher. Call when
   * the instance's view mounts and {@link unwatch} when it unmounts (reference-counted; at most a
   * few instances are watched at once, the least recently opened is dropped first).
   */
  watch(instanceId: string): Promise<void>
  /** Release one {@link watch} reference; the watcher stops shortly after the last one. */
  unwatch(instanceId: string): Promise<void>
  /** Re-read a folder now (e.g. a "Refresh" button). */
  refresh(instanceId: string, kind: ResourceKind): Promise<void>
  /** Cancel every running scan of this instance. Other calls are never blocked by scans. */
  cancelScans(instanceId: string): Promise<void>
  /**
   * Enable or disable: mods are renamed (`.disabled`), resource packs are added to or removed
   * from `options.txt`, and for shader packs enabling one makes it the active pack (only one can
   * be). Worlds cannot be disabled.
   */
  setEnabled(instanceId: string, kind: ResourceKind, ids: string[], enabled: boolean): Promise<BulkResult>
  /** Move files (or world folders) to the macOS Trash. */
  delete(instanceId: string, kind: ResourceKind, ids: string[]): Promise<BulkResult>
  /**
   * Add local files: jars and packs are stored once in the content store and cloned into the
   * folder; worlds may be zips or folders. Name clashes get ` (2)`; identical files are skipped.
   */
  add(instanceId: string, kind: ResourceKind, paths: string[]): Promise<BulkResult>
  /** "Add from another instance…": copy the given rows of `fromInstanceId` into `instanceId`. */
  addFromInstance(instanceId: string, kind: ResourceKind, fromInstanceId: string, ids: string[]): Promise<BulkResult>
  /** Back up a world (zip under `backups/<instance id>/<world>/`). Runs as a task. */
  createBackup(instanceId: string, worldId: string): Promise<BackupRow>
  /** Backups of one world, or of every world of the instance, newest first. */
  listBackups(instanceId: string, worldId?: string): Promise<BackupRow[]>
  /**
   * Restore a backup. `copy` (default) restores next to the world as `<world> (restored <date>)`;
   * `replace` swaps it in and moves the current world to the Trash. Rejects with `EBUSY` while the
   * game is running.
   */
  restoreBackup(instanceId: string, backupId: string, mode?: 'copy' | 'replace'): Promise<{ worldId: string }>
  deleteBackup(instanceId: string, backupId: string): Promise<void>
  /** Delete old automatic backups beyond `keep` (default: the `backups.keep` setting). Returns the deleted ids. */
  pruneBackups(instanceId: string, keep?: number): Promise<string[]>
}

// =============================================================================================
// Marketplace (Modrinth and CurseForge)
// =============================================================================================

/** Which platforms work in this build. CurseForge is hidden without an API key. */
export interface MarketStatus {
  /** Always true (no key needed). */
  modrinth: boolean
  /** False without an API key in this build, or after CurseForge rejected the key. */
  curseforge: boolean
  /** Why CurseForge is off: no key in this build, or the key was rejected this session. */
  curseforgeReason?: 'no-key' | 'forbidden'
}

/** Kinds of marketplace projects. */
export type MarketProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'world'

/** Search input. Filters that one platform does not support are ignored for it. */
export interface MarketSearchQuery {
  /** Free text. */
  query?: string
  /** What to search for (required). */
  projectType: MarketProjectType
  /** Minecraft version filter, e.g. the instance's. */
  gameVersion?: string
  /** Instance loader; Quilt also finds Fabric content and NeoForge 1.20.1 also finds Forge content. */
  loader?: string
  /** Modrinth category names (applies to Modrinth only). */
  modrinthCategories?: string[]
  /** CurseForge category ids, up to 10 (applies to CurseForge only). */
  curseforgeCategoryIds?: number[]
  /** Modrinth only. */
  environment?: 'client' | 'server'
  /** Default: `relevance` with a query, else `downloads`. */
  sort?: 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest' | 'name'
  /** 20, 50 or 100 (CurseForge caps at 50). */
  pageSize?: number
  /** Restrict to platforms (default: every available one). */
  platforms?: MarketPlatform[]
  /** Mark rows already installed in this instance. */
  instanceId?: string
}

/** Opaque paging cursor; pass back the one from the previous page. */
export interface MarketCursor {
  /** Modrinth paging state. */
  modrinth: { offset: number; total: number; done: boolean }
  /** CurseForge paging state. */
  curseforge: { index: number; total: number; done: boolean }
}

/** One search result. */
export interface MarketProjectRow {
  /** `modrinth:<id>` or `curseforge:<id>`. */
  key: string
  platform: MarketPlatform
  /** Platform id (Modrinth id or CurseForge mod id as a string). */
  id: string
  slug: string
  title: string
  /** Primary author, `''` when unknown. */
  author: string
  /** One-line description. */
  summary: string
  /** CDN URL (load it directly), or `null`. */
  iconUrl: string | null
  projectType: MarketProjectType | null
  downloads: number
  /** Modrinth followers, CurseForge thumbs-up. */
  followers: number
  /** Display names of the categories. */
  categories: string[]
  /** Lower-case loader ids. */
  loaders: string[]
  /** ISO date of the last update. */
  updatedAt: string | null
  /** The project page on the platform's site (open in the browser). */
  websiteUrl: string
  /** The same project on the other platform, when detected. */
  linked: { platform: MarketPlatform; id: string } | null
  /** Set when `query.instanceId` was given: a file of this project is in the instance. */
  installed: boolean
}

export interface MarketSearchPage {
  /** Interleaved results of both platforms (duplicates merged). */
  items: MarketProjectRow[]
  /** Modrinth total plus CurseForge total (capped at 10 000). */
  total: number
  /** Pass back to load the next page. */
  cursor: MarketCursor
  hasMore: boolean
  /** Per-platform failures; the other platform's results are still returned. */
  errors: Partial<Record<MarketPlatform, { code: string; message: string }>>
}

/** A project page. `body` is untrusted Markdown (Modrinth) or HTML (CurseForge): sanitise it. */
export interface MarketProjectDetail extends MarketProjectRow {
  /** The long description. */
  body: string
  bodyFormat: 'markdown' | 'html'
  /** Minecraft versions the project supports. */
  gameVersions: string[]
  /** License name, when known. */
  license: string | null
  /** External links (open in the browser after checking the scheme). */
  links: { issues?: string; source?: string; wiki?: string; discord?: string }
  /** Screenshots (CDN URLs). */
  gallery: { url: string; title: string | null }[]
  /** ISO date of the first release. */
  createdAt: string | null
}

/** One installable version (a CurseForge "file" is a version with one file). */
export interface MarketVersionRow {
  /** Modrinth version id, or the CurseForge file id. */
  id: string
  platform: MarketPlatform
  projectId: string
  /** Display name of the version. */
  name: string
  /** Version string, e.g. `mc1.21-0.6.0`. */
  versionNumber: string
  releaseType: 'release' | 'beta' | 'alpha'
  /** ISO date. */
  publishedAt: string
  downloads: number
  /** Minecraft versions this version supports. */
  gameVersions: string[]
  /** Loaders this version supports. */
  loaders: string[]
  /** The file that would be installed. */
  file: { fileName: string; size: number; sha1: string | null } | null
  /** CurseForge files whose author blocks third-party downloads. */
  manualDownloadRequired: boolean
  /** Declared dependencies (a `null` version means "any compatible"). */
  dependencies: { projectId: string | null; versionId: string | null; type: 'required' | 'optional' | 'incompatible' | 'embedded' }[]
}

/** Filters for {@link MarketplaceService.getVersions}. */
export interface MarketVersionQuery {
  /** Only versions for this Minecraft version. */
  gameVersion?: string
  /** Only versions for this loader (expanded like {@link MarketSearchQuery.loader}). */
  loader?: string
  /** CurseForge paging (50 per page). */
  page?: number
}

/** A file the user must download by hand from the CurseForge website. */
export interface ManualDownload {
  /** CurseForge mod id. */
  projectId: string
  /** CurseForge file id. */
  fileId: string
  /** Expected file name (watch `~/Downloads` for it). */
  fileName: string
  /** The page with the download button (opens in the browser). */
  websiteUrl: string
  /** Expected SHA-1, to verify the file the user brings back. */
  sha1: string | null
  /** Expected size in bytes. */
  size: number
}

/** What to install where. */
export interface MarketInstallInput {
  instanceId: string
  platform: MarketPlatform
  /** Modrinth project id, or CurseForge mod id. */
  projectId: string
  /** Modrinth version id, or CurseForge file id. */
  versionId: string
  /** Replace this existing resource (an update): the old file goes to the Trash; disabled state is kept. */
  replaces?: { kind: ResourceKind; id: string }
}

/** What {@link MarketplaceService.install} did. */
export interface MarketInstallResult {
  /** The installed row id in its folder, or `null` when a manual download is required. */
  resource: { kind: ResourceKind; id: string } | null
  /** Files to fetch by hand (the "Missing files" dialog). */
  manual: ManualDownload[]
}

/** An available update for an installed file. */
export interface UpdateCandidate {
  /** The installed row. */
  resourceId: string
  fileName: string
  /** The platform the file was checked against (its provenance, else Modrinth, else CurseForge). */
  platform: MarketPlatform
  projectId: string
  /** The installed version (Modrinth version id or CurseForge file id). */
  currentVersionId: string
  /** The newest compatible version; install it with `install({ ..., replaces })`. */
  latest: { versionId: string; name: string; versionNumber: string; releaseType: 'release' | 'beta' | 'alpha'; publishedAt: string; fileName: string }
}

/** Modrinth and CurseForge (runtime). Errors carry `details.platform`, `details.status` and `details.retryable`. */
export interface MarketplaceService {
  /** Which platforms are usable. */
  getStatus(): Promise<MarketStatus>
  /** Combined search; each platform pages independently through `cursor`. */
  search(query: MarketSearchQuery, cursor?: MarketCursor): Promise<MarketSearchPage>
  /** A project page (`projectId` may be a Modrinth slug). */
  getProject(platform: MarketPlatform, projectId: string): Promise<MarketProjectDetail>
  /** Versions newest first, filtered by game version and loader. */
  getVersions(platform: MarketPlatform, projectId: string, query?: MarketVersionQuery): Promise<MarketVersionRow[]>
  /** Changelog of one version (Markdown for Modrinth, HTML for CurseForge; sanitise it). */
  getChangelog(platform: MarketPlatform, projectId: string, versionId: string): Promise<string>
  /**
   * Download (hash-verified, de-duplicated through the content store) and place one version into
   * an instance, recording its attribution. Files CurseForge does not allow us to download are
   * returned in `manual`. Runs as a task.
   */
  install(input: MarketInstallInput): Promise<MarketInstallResult>
  /**
   * Check enabled files of one folder for updates by hash (Modrinth bulk lookup, CurseForge
   * fingerprints). Results are cached for 10 minutes unless `fresh`.
   */
  checkUpdates(instanceId: string, kind: ResourceKind, options?: { releaseOnly?: boolean; fresh?: boolean }): Promise<UpdateCandidate[]>
}

// =============================================================================================
// Accounts
// =============================================================================================

/** Whether each kind of login can be offered. */
export interface AccountsStatus {
  /** Unavailable when the build has no Azure client id. */
  microsoft: { available: boolean; reason?: 'no-client-id' }
  /** Offline accounts need a Microsoft account first (or developer mode). */
  offlineAllowed: boolean
}

/** Account health. */
export type AccountStatus =
  /** Usable. */
  | 'ok'
  /** The Minecraft token expired; it is refreshed silently before launch. */
  | 'expired'
  /** Credentials are unusable (revoked, or unreadable after a Keychain change): log in again. */
  | 'needs-sign-in'

/** Public account fields only. Tokens never leave the runtime. */
export interface AccountRow {
  /** Local account id (Microsoft: the Minecraft services account id; offline: `offline:<uuid>`). */
  id: string
  kind: 'microsoft' | 'offline'
  /** Player name. */
  name: string
  /** Profile UUID. */
  uuid: string
  /** The account used to launch. */
  selected: boolean
  status: AccountStatus
  /** Xbox gamerpic (`https:`), or `null`. */
  avatarUrl: string | null
  /** Active skin: `https:` (Mojang) or `amethyst-asset://` (offline, launcher-only), or `null` for the default. */
  skin: { url: string; model: 'classic' | 'slim' } | null
  /** Active cape, or `null`. */
  cape: { id: string; url: string } | null
}

/** An account with its owned skins and capes, for the skin editor. */
export interface AccountDetail extends AccountRow {
  /** Skins on the Mojang profile (Microsoft accounts). */
  skins: { id: string; url: string; model: 'classic' | 'slim'; active: boolean }[]
  /** Capes the profile owns (Microsoft accounts); only these can be equipped. */
  capes: { id: string; url: string; alias: string | null; active: boolean }[]
  /** Microsoft sign-in hint (e-mail), when known. Hide it in streamer mode. */
  loginHint: string | null
}

/**
 * How to run the Microsoft sign-in: an embedded window (default), the system browser with a
 * loopback redirect (passkeys, password managers), or a device code shown in the app.
 */
export type MicrosoftLoginMethod = 'window' | 'browser' | 'device-code'

/** A skin image. PNG only, 64×64 or 64×32. */
export type SkinSource = { path: string } | { dataUrl: string } | { url: string }

/** Microsoft and offline accounts (runtime). */
export interface AccountsService {
  /** Which kinds of sign-in can be offered. */
  getStatus(): Promise<AccountsStatus>
  /** Every account, selected first. Never blocks on the network. */
  list(): Promise<AccountRow[]>
  /** One account with its skins and capes. */
  get(id: string): Promise<AccountDetail>
  /**
   * Interactive Microsoft sign-in. Progress (device code, browser URL) arrives as
   * `accounts:login` events. Resolves with the new (selected) account. Only one sign-in runs at a
   * time; a new one cancels the previous. Errors carry auth codes (e.g. `EXSTS_NO_ACCOUNT`,
   * `EMSA_APP_NOT_APPROVED`, `EMC_NOT_OWNED`) and `details.link` for help pages.
   * Pass `accountId` to sign in again to an existing account (a different account is rejected).
   */
  loginMicrosoft(options?: { method?: MicrosoftLoginMethod; accountId?: string }): Promise<AccountRow>
  /** Abort a running sign-in. */
  cancelLogin(): Promise<void>
  /** Add an offline profile (3–16 of `[A-Za-z0-9_]`), optionally with a custom UUID. */
  addOffline(name: string, uuid?: string): Promise<AccountRow>
  /** Remove an account and delete its stored credentials. */
  remove(id: string): Promise<void>
  /** Make this the account used to launch. */
  select(id: string): Promise<void>
  /**
   * Refresh the Minecraft token silently (never opens a window). Concurrent calls share one
   * refresh. `force` refreshes even a fresh token. Rejects with `reauth` errors when the user must
   * sign in again (the account then shows `needs-sign-in`).
   */
  refresh(id: string, options?: { force?: boolean }): Promise<AccountRow>
  /** Upload a skin (Microsoft) or set the launcher-only skin (offline). */
  setSkin(id: string, source: SkinSource, model: 'classic' | 'slim'): Promise<AccountDetail>
  /** Revert to the default skin. */
  resetSkin(id: string): Promise<AccountDetail>
  /** Equip an owned cape, or hide the cape with `null`. Microsoft accounts only. */
  setCape(id: string, capeId: string | null): Promise<AccountDetail>
}

// =============================================================================================
// Tasks
// =============================================================================================

/** Lifecycle of a task. */
export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** A snapshot of a task tree, pruned for the UI (at most two levels and 20 children per node). */
export interface TaskView {
  /** Pass to {@link TasksService.cancel} / {@link TasksService.dismiss}. */
  id: string
  /** Stable machine name, e.g. `instances.duplicate`, `market.install`. Map it to text in the UI. */
  name: string
  /** Parameters for the UI text, e.g. `{ name: 'My Pack' }`. */
  params: Record<string, string | number>
  /** The instance the task works on, if any. */
  instanceId: string | null
  state: TaskState
  /** Overall completion in [0, 1]. */
  fraction: number
  /** Progress in the task's own units (bytes, files, steps), out of `total` (0 when unknown). */
  progress: number
  total: number
  /** Current step, when the task reports one. */
  message: string | null
  /** Why it failed. */
  error: { code: string; message: string } | null
  /** Epoch ms. */
  startedAt: number | null
  endedAt: number | null
  /** Show a Cancel button (root tasks that are still running). */
  cancellable: boolean
  /** Sub-tasks (pruned). */
  children: TaskView[]
}

/** Running tasks and their recent history (runtime). Progress arrives as `tasks:update` events. */
export interface TasksService {
  /** Running tasks and the recent history (bounded), newest first. */
  list(): Promise<TaskView[]>
  /** Request cancellation of a running task (and its children). */
  cancel(id: string): Promise<void>
  /** Remove a finished task from the history. */
  dismiss(id: string): Promise<void>
  /** Remove every finished task from the history. */
  clearFinished(): Promise<void>
}

// =============================================================================================
// Registries
// =============================================================================================

/** Services in the runtime utility process (reached over the renderer's MessagePort). */
export interface RuntimeServices {
  runtime: RuntimeStatusService
  settings: SettingsService
  instances: InstancesService
  resources: ResourcesService
  marketplace: MarketplaceService
  accounts: AccountsService
  tasks: TasksService
  telemetry: TelemetryService
}

/** An error from another process, reduced to structured-cloneable fields. */
export interface ReportedError {
  name: string
  message: string
  stack?: string
}

/**
 * Consent-gated telemetry (see docs/PRIVACY.md). Both toggles are off until the user opts in;
 * while off, nothing is sent or queued.
 */
export interface TelemetryService {
  getConsent(): Promise<Consent>
  /** Persist and apply immediately. Revoking deletes anything still queued. */
  setConsent(consent: Consent): Promise<Consent>
  /** Capture one of the few events the renderer may send. Invalid events are dropped. */
  capture<E extends RendererEventName>(event: E, props: EventProps<E>): Promise<void>
  /** Report an uncaught renderer error (`window.onerror` / `unhandledrejection`). */
  reportError(error: ReportedError): Promise<void>
}

export type UpdaterState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; percent: number; version?: string }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

/** In-app updates from the rolling nightly release (electron-updater). Disabled in dev builds. */
export interface UpdaterService {
  getState(): Promise<UpdaterState>
  /** Check now (downloads automatically when an update exists). Resolves with the state after the check. */
  check(): Promise<UpdaterState>
  /** Restart into the downloaded update. Throws `ENOUPDATE` unless the state is `ready`. */
  quitAndInstall(): Promise<void>
}

/** Services in the Electron main process (window and OS integration only). */
export interface MainServices {
  app: AppService
  updater: UpdaterService
}

/** Names routed to main by the preload; everything else goes to the runtime. */
export const MAIN_SERVICES = ['app', 'updater'] as const satisfies readonly (keyof MainServices)[]

/** Everything the renderer can call (`api.<service>.<method>()`). */
export type Services = RuntimeServices & MainServices

/** Electron-only APIs the runtime borrows from main. Never exposed to the renderer. */
export interface HostServices {
  /** Encrypt with the OS keychain via Electron safeStorage. Returns base64. Rejects with `ESECRET_UNAVAILABLE` when encryption is not available. */
  encrypt(plain: string): Promise<string>
  /** Decrypt a value produced by `encrypt`. Throws `ESECRET_UNREADABLE` when the key changed. */
  decrypt(cipher: string): Promise<string>
  /** Move a file or folder to the macOS Trash. */
  trash(path: string): Promise<void>
  /**
   * Open `url` in a modal sign-in window (separate persistent session partition) and resolve
   * with the first navigation or redirect whose URL matches `redirectUri` (scheme, port and
   * path; loopback hosts are interchangeable). The navigation itself is cancelled. Rejects with
   * `ECANCELLED` when the user closes the window or {@link closeAuthWindow} is called, and with
   * `EAUTH_WINDOW` when the page fails to load.
   */
  openAuthWindow(url: string, redirectUri: string): Promise<string>
  /** Close the sign-in window, if open (its pending `openAuthWindow` rejects with `ECANCELLED`). */
  closeAuthWindow(): Promise<void>
  /** Open an `https:` URL in the default browser. Other schemes are rejected. */
  openExternal(url: string): Promise<void>
}
