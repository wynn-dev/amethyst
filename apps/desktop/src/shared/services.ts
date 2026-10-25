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
  /** Translucent (vibrancy) sidebar; off paints it solid. Default true. */
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
/** `settings.json` could not be read at startup and was moved aside. */
export interface SettingsNotice {
  /** `recovered`: the last good copy (`.bak`) was used. `reset`: nothing was readable, so the defaults are in use. */
  kind: 'recovered' | 'reset'
  /** Where the unreadable file was kept. */
  corruptPath: string
}

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
  /**
   * The pending one-time notice about the settings file, or `null`. The first caller takes it, so
   * only one window shows it. `settings:notice` announces a new one.
   */
  takeNotice(): Promise<SettingsNotice | null>
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

/**
 * What the launcher is doing with an instance right now (in-memory, never persisted):
 * `installing` (its game version is being installed or repaired), `launching` (the launch
 * pipeline runs), `running` (the game process is alive). While it is not `idle` the instance
 * cannot be renamed or deleted (`EBUSY`).
 */
export type InstanceActivity = 'idle' | 'installing' | 'launching' | 'running'

/** One row of the instance list. */
export interface InstanceSummary {
  /** Stable id; survives renames and folder moves. */
  id: string
  /** Display name (unique, case-insensitively). */
  name: string
  /** Whether the instance can be used; see {@link InstanceState}. */
  state: InstanceState
  /** Live activity; changes are announced through `instances:changed` (`updated`). */
  activity: InstanceActivity
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
  /** Contains Amethyst's own data folder (for example `~/Library`). */
  | 'contains-data-root'
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
  /**
   * Launch settings of an Amethyst instance folder that importing removes because they run code
   * (pre-launch or wrapper command, Java path, agent-style JVM arguments, `DYLD_*`-style env).
   * Each entry describes one setting.
   */
  removedLaunchSettings?: string[]
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
  /** How the sidebar organises instances: pins and folders. Changes are announced as `library:changed`. */
  getLayout(): Promise<LibraryLayout>
  /** Pin or unpin an instance (pinned instances are listed first). */
  setPinned(id: string, pinned: boolean): Promise<LibraryLayout>
  /** Create a sidebar folder (1–64 characters; made unique). */
  createFolder(name: string): Promise<LibraryFolder>
  /** Rename a folder or persist its expanded state. Rejects with `ENOT_FOUND`. */
  updateFolder(id: string, patch: { name?: string; expanded?: boolean }): Promise<LibraryLayout>
  /** Remove a folder; its instances move back to the top level. */
  deleteFolder(id: string): Promise<LibraryLayout>
  /** Put an instance in a folder, or with `null` back at the top level. */
  moveToFolder(id: string, folderId: string | null): Promise<LibraryLayout>
}

/** A sidebar folder of instances (named only; no colours). */
export interface LibraryFolder {
  id: string
  name: string
  /** Disclosure state, persisted. */
  expanded: boolean
}

/** Sidebar organisation, stored launcher-wide in `library.json` (never inside instance folders). */
export interface LibraryLayout {
  /** In display order. */
  folders: LibraryFolder[]
  /** Pinned instance ids, in pin order. */
  pinned: string[]
  /** Instance id → folder id. Instances not listed are at the top level. */
  folderOf: Record<string, string>
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
  /** Mods: where the mod must be installed, once parsed. */
  side?: 'client' | 'server' | 'both'
  /** Resource packs: the supported pack formats (`pack.mcmeta`), once parsed. */
  packFormats?: { min: number; max: number }
  /** Enabled resource packs: position in the load order, 0 = top (highest priority). */
  order?: number
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
  /** Default `asc` for `name`/`fileName`, `desc` (newest, largest first) for `modified`/`size`. */
  direction?: 'asc' | 'desc'
  /** Only enabled (`true`) or disabled (`false`) rows. */
  enabled?: boolean
  /** Only these row ids (e.g. the rows with an update or a problem). */
  ids?: string[]
  /** Only rows attributed to these platforms; `local` means no attribution. */
  sources?: (MarketPlatform | 'local')[]
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

/** What {@link ResourcesService.delete} did. */
export interface DeleteResult extends BulkResult {
  /**
   * With `undoable`, the files wait (inside the instance's `.amethyst/trash/`) for about 30 s
   * before they go to the macOS Trash: pass this to {@link ResourcesService.undoDelete} to put
   * them back. `null` when nothing can be undone.
   */
  undoToken: string | null
}

/** Load-time problems among an instance's enabled mods, for the Problems sheet. */
export interface ModAnalysis {
  /** Enabled mods that share a mod id (or are identical files): keep one. */
  duplicates: { modId: string; ids: string[] }[]
  /** Required dependencies that no enabled mod provides. */
  missing: { id: string; modId: string; range?: string }[]
  /** Mods for another loader, or declaring a conflict with another enabled mod (`with`). */
  incompatible: { id: string; reason: 'loader' | 'conflict'; message: string; with?: string }[]
  /** Row id → ids of the enabled mods that require it. */
  dependents: Record<string, string[]>
  /** Files that are damaged or not mods at all (enabled or not). */
  broken: { id: string; message: string }[]
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
  /**
   * Move files (or world folders) to the macOS Trash. With `undoable`, they are first set aside
   * for about 30 s so {@link undoDelete} can restore them (then they go to the Trash).
   */
  delete(instanceId: string, kind: ResourceKind, ids: string[], options?: { undoable?: boolean }): Promise<DeleteResult>
  /** Put back the files of an undoable {@link delete}. Rejects with `ENOT_FOUND` once they went to the Trash. */
  undoDelete(instanceId: string, undoToken: string): Promise<BulkResult>
  /**
   * Set the enabled resource packs and their load order (`ids` top first: the first one wins).
   * Packs not listed are disabled; built-in and mod packs in `options.txt` are kept. Rejects with
   * `EBUSY` while the game runs.
   */
  setPackOrder(instanceId: string, ids: string[]): Promise<void>
  /** Duplicate, missing-dependency and incompatibility problems among the enabled mods. */
  analyze(instanceId: string): Promise<ModAnalysis>
  /** Zip a world to `output` (an absolute path from a save panel). Runs as a task. */
  exportWorld(instanceId: string, worldId: string, output: string): Promise<{ path: string; size: number }>
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
// Game versions (Minecraft and loader version lists, installed versions)
// =============================================================================================

/** Minecraft version kinds, as published in Mojang's manifest. */
export type MinecraftVersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

/** One Minecraft version from the manifest. */
export interface MinecraftVersionRow {
  /** e.g. `1.21.1`, `24w14a`, `26.1`. */
  id: string
  type: MinecraftVersionType
  /** ISO date. */
  releaseTime: string
  /** A complete install exists in the shared `minecraft/versions` folder. */
  installed: boolean
}

/** Metadata freshness, shown as "stale since …" when a refresh failed. */
export interface ListFreshness {
  /** When the list was last confirmed by its server (epoch ms), 0 when unknown. */
  fetchedAt: number
  /** True when the cached copy is older than the refresh interval (a background refresh runs; `versions:changed` follows). */
  stale: boolean
}

/** Filter for {@link VersionsService.listMinecraft}. */
export interface MinecraftVersionQuery {
  /** Version types to include. `old` means `old_beta` and `old_alpha`. Default `['release']`. */
  types?: ('release' | 'snapshot' | 'old')[]
}

export interface MinecraftVersionList extends ListFreshness {
  /** Newest first (manifest order). */
  items: MinecraftVersionRow[]
  latest: { release: string; snapshot: string }
}

/** One loader build for a Minecraft version. */
export interface LoaderVersionRow {
  /** The loader's own version (`0.16.5`, `47.3.0`, `21.1.65`), as stored in {@link InstanceRuntime}. */
  version: string
  /** Fabric/Quilt stable flag; Forge/NeoForge builds are stable unless they are pre-releases. */
  stable: boolean
  /** Forge "recommended" promotion. */
  recommended: boolean
  /** The newest build for this Minecraft version. */
  latest: boolean
}

export interface LoaderVersionList extends ListFreshness {
  /** Newest first. Empty when the loader does not support the Minecraft version. */
  items: LoaderVersionRow[]
}

/** A version folder in the shared `minecraft/versions`. */
export interface InstalledVersionRow {
  /** Folder name and version id, e.g. `1.20.1-forge-47.3.0` or `fabric-loader-0.16.5-1.21.1`. */
  id: string
  /** The Minecraft version at the root of its `inheritsFrom` chain (`''` when unreadable). */
  minecraft: string
  /** The loader layer, if any. */
  loader: { kind: LoaderKind; version: string } | null
  /** The parent version id (`inheritsFrom`), or `null`. */
  inheritsFrom: string | null
  /** An install finished (`.install-lock` exists). */
  complete: boolean
  /** Instances whose `versionId` is this version (or inherits from it). Such versions cannot be deleted. */
  usedBy: string[]
  /** Other installed versions that inherit from this one. */
  children: string[]
  /** Size of the version folder itself (JSON, jar, natives); shared libraries and assets are not counted. */
  sizeBytes: number
}

/** Minecraft and loader version lists and the installed versions (runtime). */
export interface VersionsService {
  /**
   * Minecraft versions from Mojang's manifest. Served from the on-disk cache (`cache/meta/`) when
   * there is one, even a stale one; a stale list is refreshed in the background and
   * `versions:changed` follows. Only the very first call (no cache yet) waits for the network.
   * Rejects with the network error then.
   */
  listMinecraft(query?: MinecraftVersionQuery): Promise<MinecraftVersionList>
  /** Builds of `loader` for `minecraft`, newest first. Same caching as {@link listMinecraft}. */
  listLoaders(loader: LoaderKind, minecraft: string): Promise<LoaderVersionList>
  /** Revalidate every cached list now (a "Refresh" button). Emits `versions:changed`. */
  refresh(): Promise<void>
  /** Version folders in the shared `minecraft/versions`, sorted by id. */
  listInstalled(): Promise<InstalledVersionRow[]>
  /**
   * Delete an installed version folder. Rejects with `EBUSY` when an instance uses it, another
   * installed version inherits from it, or an install or game is running. Shared libraries and
   * assets are kept. Emits `versions:changed` (`installed`).
   */
  deleteInstalled(id: string): Promise<void>
}

// =============================================================================================
// Java
// =============================================================================================

/** One Java runtime known to Amethyst. */
export interface JavaRow {
  /** Absolute `bin/java` path (the identity passed back to {@link JavaService.removePath}). */
  path: string
  /** The JDK/JRE home. */
  javaHome: string
  /** As reported, e.g. `1.8.0_412`, `21.0.5`. `''` when unknown. */
  version: string
  /** 8, 17, 21… 0 when unknown. */
  majorVersion: number
  /** The JVM's real architecture. `x64` runs under Rosetta 2. */
  arch: 'arm64' | 'x64' | 'unknown'
  /** `IMPLEMENTOR`, e.g. `Azul Systems, Inc.`, or `null`. */
  vendor: string | null
  /** Where it was found (`managed`, `java_home`, `homebrew`, `sdkman`, `user`, …). */
  source: string
  /** Installed by Amethyst under `runtimes/`. */
  managed: boolean
  /** Added by the user with {@link JavaService.addPath}. */
  userAdded: boolean
  /** Usable: exists, executable, version and arch known. */
  valid: boolean
  /** Why it is not usable: `missing`, `not-executable`, `bad-cpu-type`, `timeout`, `unparseable`, `spawn-failed`. */
  invalidReason: string | null
}

/** Why a Java was (or was not) picked; see `@amethyst/java` `SelectReason`. */
export type JavaChoiceReason = 'pinned' | 'preferred' | 'exact-major' | 'compatible-major' | 'rosetta-only' | 'no-valid-java' | 'no-match'

/** The Java an instance would launch with right now. */
export interface JavaRecommendation {
  /** The Java major the instance's version needs. */
  major: number
  /** The effective policy (`game.java.policy`, or `pinned` when the instance overrides `javaPath`). */
  policy: GameSettings['java']['policy'] | 'pinned'
  /** The selected runtime, or `null` when none matches. */
  java: JavaRow | null
  reason: JavaChoiceReason
  /** One sentence for the UI. */
  message: string
  /** The selected runtime runs under Rosetta 2. */
  rosetta: boolean
  /** The instance pins a Java that is missing or invalid; auto-selection was used instead. */
  pinnedUnavailable: boolean
  /** No suitable runtime is installed: launching installs a managed one (Mojang/Zulu) for `major`. */
  willInstall: boolean
}

/** Java discovery, managed runtimes and per-instance selection (runtime). */
export interface JavaService {
  /**
   * Every known runtime from the persisted probe cache (never spawns a JVM). Discovery runs
   * lazily once after startup and on {@link rescan}; `java:changed` announces new results.
   */
  list(): Promise<JavaRow[]>
  /** Rediscover now (cheap: unchanged JDKs are not re-probed). Resolves with the new list. */
  rescan(): Promise<JavaRow[]>
  /**
   * Add a runtime by path (a `bin/java`, a JDK home or a `.jdk` bundle). It is probed right away;
   * rejects with `EJAVA_INVALID` (`details.reason`) when it cannot be used.
   */
  addPath(path: string): Promise<JavaRow>
  /** Forget a user-added path, or hide a discovered runtime so rescans do not bring it back. */
  removePath(path: string): Promise<void>
  /**
   * Install an Amethyst-managed arm64 runtime for a Java major (Mojang's `mac-os-arm64` build
   * when one exists, else Azul Zulu), as a `java.install` task. Resolves with the new runtime.
   */
  installRuntime(major: number): Promise<JavaRow>
  /** Which Java `instanceId` would launch with, and why (honours `game.java.*` and the instance's `javaPath`). */
  recommend(instanceId: string): Promise<JavaRecommendation>
}

// =============================================================================================
// Installing an instance's game version
// =============================================================================================

/** What installing an instance's runtime involves. */
export interface InstallPlanView {
  /** The version id the install produces (Forge ids are final only after the install). */
  versionId: string
  minecraft: string
  loader: { kind: LoaderKind; version: string } | null
  /** Ordered steps with their download sizes when known. */
  steps: { id: string; bytes: number | null; files: number | null; needsJava: boolean }[]
  /** Sum of the known step sizes (an upper bound: valid files are skipped). */
  totalBytes: number
  /** Java major needed to launch (and to run Forge/NeoForge processors). */
  javaMajor: number
  /** Forge/NeoForge processors will run (a Java of `javaMajor` is selected or installed first). */
  needsJava: boolean
}

/** Install state of an instance's game version. */
export interface InstallStatus {
  /** The linked version id (`versionId` of the instance), `''` when none. */
  versionId: string
  /** The linked version is installed completely (its `.install-lock` exists). Shows "Play" vs "Install". */
  installed: boolean
  /** An install or repair of this instance is running. */
  installing: boolean
}

/** What {@link InstallService.install} did. */
export interface InstallOutcome {
  /** The installed version id, now linked to the instance. */
  versionId: string
  durationMs: number
  /** Bytes downloaded. */
  bytes: number
}

/** What {@link InstallService.repair} found and fixed. */
export interface RepairOutcome {
  versionId: string
  /** Problems found before repairing. */
  found: number
  /** Files re-downloaded. */
  repaired: number
  /** Problems left (e.g. natives with no arm64 build). */
  remaining: { name: string; problem: string; message: string | null }[]
  /** Forge/NeoForge processors were re-run. */
  reranProcessors: boolean
}

/**
 * Installs the game version of an instance (Minecraft plus its loader) into the shared
 * `minecraft/` folder (runtime). Installs and repairs run as tasks (`install.run`,
 * `install.repair`) with byte-weighted progress; one install per instance at a time (a second
 * call joins the running one). While one runs, the instance cannot be renamed or deleted.
 */
export interface InstallService {
  /** Plan without writing anything (metadata only). Rejects with `EINSTALL_NOT_FOUND` for unknown versions. */
  plan(instanceId: string): Promise<InstallPlanView>
  /** Whether the instance's version is installed. Cheap (a few `stat`s). */
  status(instanceId: string): Promise<InstallStatus>
  /**
   * Install (or re-verify) the instance's runtime and link the resulting version id to it.
   * Forge/NeoForge processors run with a Java of the right major, installed when missing.
   */
  install(instanceId: string): Promise<InstallOutcome>
  /** Check every file of the linked version (full hashes) and re-download or rebuild what is broken. */
  repair(instanceId: string): Promise<RepairOutcome>
  /**
   * "Change Version…": back up the instance's worlds first (`pre-version-change`, when
   * `backups.automatic` is on), switch the instance to `runtime` (a loader key left out is
   * removed), then install it. One call per user intent; progress arrives through `tasks:update`.
   * Rejects with `EBUSY` while the instance runs or installs.
   */
  changeVersion(instanceId: string, runtime: Partial<InstanceRuntime> & { minecraft: string }): Promise<InstallOutcome & { backedUpWorlds: number }>
}

// =============================================================================================
// Launching the game
// =============================================================================================

/** Where to go once the game starts. Versions without quick play only support `multiplayer`. */
export type QuickPlayTarget = { type: 'multiplayer'; host: string; port?: number } | { type: 'singleplayer'; world: string } | { type: 'realms'; realm: string }

/** Options for {@link LaunchService.launch}. */
export interface LaunchOptions {
  /** Join this server (shorthand for a `multiplayer` quick play). Wins over the instance's auto-join server. */
  server?: { host: string; port?: number }
  /** Quick play target (1.20+; older versions get `--server` for multiplayer, other targets are ignored). */
  quickPlay?: QuickPlayTarget
  /** Launch with this account instead of the selected one. */
  accountId?: string
}

/** Pipeline steps reported by `launch:state` while preparing. */
export type LaunchStep =
  /** Reading the instance and its version. */
  | 'resolve'
  /** Installing the game version (first launch, or after a runtime change). */
  | 'install'
  /** Choosing (and if needed installing) Java. */
  | 'java'
  /** Planning natives for the JVM's architecture (and fetching the LWJGL 2 arm64 natives manifest). */
  | 'natives'
  /** Checking files (sizes; hashes only for recent or suspect files). */
  | 'verify'
  /** Re-downloading missing or broken files (a visible `launch.repair` task). */
  | 'repair'
  /** Refreshing the account session. */
  | 'account'
  /** Running the user's pre-launch command. */
  | 'prelaunch'
  /** Extracting natives and building the command line. */
  | 'build'
  /** Starting the Java process. */
  | 'spawn'

/** The state of a launch, pushed as `launch:state`. */
export type LaunchState =
  | { state: 'preparing'; step: LaunchStep }
  /** The process runs. Sent again with `ready: true` once the game window is up. */
  | { state: 'running'; pid: number; startedAt: number; ready: boolean }
  | {
      state: 'exited'
      /** Exit code, or `null` when killed by a signal. */
      code: number | null
      signal: string | null
      /** Crashed (abnormal exit, crash report or JVM crash log). False when the user stopped it. */
      crashed: boolean
      /** Stopped through {@link LaunchService.kill}. */
      killed: boolean
      /** The crash report (or JVM `hs_err` log) of this run; open it with {@link LaunchService.openCrashReport}. */
      crashReportPath: string | null
      durationMs: number
      /** Native library load failure seen in the output (wrong architecture or missing library). */
      nativeLoadError: 'architecture' | 'unsatisfied-link' | null
    }
  /**
   * The launch failed before the game started. Typed codes the UI turns into prompts:
   * `EJAVA_REQUIRED` (`details.major`: install that Java), `ENATIVES_UNAVAILABLE` (no arm64
   * natives for this version yet), `EACCOUNT_REQUIRED`, `ESIGN_IN_REQUIRED`, `EPRELAUNCH_FAILED`,
   * `EINSTALL_*`, `EVERSION_*`, `ELAUNCH_*`, `ECANCELLED`.
   */
  | { state: 'failed'; code: string; message: string }

/** What {@link LaunchService.launch} resolves with once the process runs. */
export interface LaunchStarted {
  /** Identifies this run in `launch:state` / `launch:log`. */
  launchId: string
  pid: number
  startedAt: number
  /** Time from the call to the process starting. */
  clickToSpawnMs: number
}

/** A game that is preparing or running. */
export interface RunningGame {
  instanceId: string
  launchId: string
  /** `preparing` until the process starts. */
  phase: 'preparing' | 'running'
  /** The current step while preparing. */
  step: LaunchStep | null
  /** 0 while preparing. */
  pid: number
  startedAt: number
  ready: boolean
}

/** One line of game output. */
export interface GameLogLine {
  /** Increasing per run; page with {@link LaunchService.getLog} `since`. */
  seq: number
  /** Epoch ms. */
  time: number
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
  stream: 'stdout' | 'stderr'
  thread: string | null
  logger: string | null
  /** The message (at most 8 KB), with any stack trace appended on following lines. */
  text: string
}

/** A page of the game log. */
export interface GameLogPage {
  /** The run the lines belong to (`null` when the instance never ran this session). */
  launchId: string | null
  /** At most `limit` lines after `since`, oldest first. */
  lines: GameLogLine[]
  /** Pass as `since` to get the following lines. */
  nextSeq: number
  /** Lines older than the buffer (the last 5,000 lines are kept per instance). */
  dropped: number
  running: boolean
}

/** A crash report's text (bounded). */
export interface CrashReport {
  path: string
  /** `crash-report` (Minecraft) or `jvm` (`hs_err_pid*.log`). */
  kind: 'crash-report' | 'jvm'
  /** The first 512 KB. */
  text: string
  truncated: boolean
}

/**
 * Launching and watching the game (runtime). One game per instance at a time. Progress and the
 * outcome are pushed as `launch:state`; output as `launch:log` while a log view is subscribed.
 */
export interface LaunchService {
  /**
   * Run the launch pipeline (see {@link LaunchStep}) and start the game. Resolves once the process
   * runs; rejects with the same typed error that `launch:state` `failed` carries. Never prompts:
   * missing pieces become typed errors (e.g. `EJAVA_REQUIRED` with `details.major`).
   * Rejects with `EBUSY` when the instance is already running, launching or installing.
   */
  launch(instanceId: string, options?: LaunchOptions): Promise<LaunchStarted>
  /** Stop the game (SIGTERM to its process group, SIGKILL after 10 s, or at once with `force`), or cancel a launch that is still preparing. */
  kill(instanceId: string, options?: { force?: boolean }): Promise<void>
  /** Games preparing or running. */
  listRunning(): Promise<RunningGame[]>
  /** Page through the last run's output (kept after exit until the next launch of the instance). */
  getLog(instanceId: string, options?: { since?: number; limit?: number }): Promise<GameLogPage>
  /** Start pushing `launch:log` for this instance (reference-counted; call when the log view mounts). */
  subscribeLog(instanceId: string): Promise<void>
  /** Release one {@link subscribeLog} reference. */
  unsubscribeLog(instanceId: string): Promise<void>
  /** The crash report (or JVM crash log) of the instance's last run. Rejects with `ENOT_FOUND`. */
  openCrashReport(instanceId: string): Promise<CrashReport>
}

// =============================================================================================
// Modpacks
// =============================================================================================

/** A pack file to import: a local `.mrpack`/CurseForge zip, or an `https:` URL to one. */
export type ModpackSource = { path: string } | { url: string }

/** What opening a pack shows before anything is created. */
export interface ModpackPreview {
  format: 'modrinth' | 'curseforge'
  name: string
  /** The pack's own version string. */
  version: string
  author: string | null
  summary: string | null
  minecraft: string
  loader: { kind: LoaderKind; version: string } | null
  /** Files listed by the manifest. */
  fileCount: number
  /** Files in the override folders. */
  overrideCount: number
  /** Non-fatal problems (unsafe paths dropped, unknown keys…). */
  warnings: string[]
  /** An instance that already follows this pack (same upstream project, else same name): offer "Update" instead. */
  existingInstanceId: string | null
}

/** A CurseForge file the author does not allow launchers to download. */
export interface ModpackManualFile {
  /** Project name. */
  name: string
  fileName: string
  /** The download page (open it in the browser). */
  websiteUrl: string
  /** Where it goes in the instance. */
  path: string
  size: number
  projectId: number
  fileId: number
}

/** Input for {@link ModpackService.import}. */
export interface ModpackImportInput {
  source: ModpackSource
  /** Instance name; default the pack name (made unique). */
  name?: string
  /** Optional files to install (paths); default each file's default selection. */
  selectedOptional?: string[]
  /** Resume an incomplete import into this instance instead of creating a new one. */
  instanceId?: string
}

/** What an import did. */
export interface ModpackImportResult {
  /** The instance; also the id for {@link ModpackService.watchManualDownloads} / {@link ModpackService.provideManualFile}. */
  instanceId: string
  /** Files placed in the instance. */
  installed: number
  /** Files the manifest lists that were skipped (server-only, unsafe paths…). */
  skipped: number
  /** Blocked CurseForge files still missing: show the "Missing files" dialog. */
  manual: ModpackManualFile[]
  /** The game version could not be installed (the files are in place; "Install" replaces "Play"). */
  runtimeError: { code: string; message: string } | null
}

/** An available modpack update. */
export interface ModpackUpdateInfo {
  instanceId: string
  platform: MarketPlatform
  projectId: string
  /** The installed pack version (Modrinth version id, CurseForge file id). */
  currentVersionId: string
  /** The newest version, newer than the installed one. */
  latest: { versionId: string; name: string; versionNumber: string; publishedAt: string; gameVersions: string[] }
}

/** One change of an update plan. */
export interface ModpackChangeRow {
  path: string
  action: 'add' | 'update' | 'remove' | 'conflict'
  /** Conflicts: the user changed the file (`modified-*`), or a file the pack never owned is in the way. */
  conflict: 'modified-replaced' | 'modified-removed' | 'unmanaged-replaced' | null
}

/** An update preview. Changes not excluded on apply are performed. */
export interface ModpackUpdatePlanView {
  /** Pass to {@link ModpackService.applyUpdate} (valid for 30 minutes). */
  planId: string
  instanceId: string
  target: { versionId: string; name: string }
  changes: ModpackChangeRow[]
  /** Files left as they are. */
  unchanged: number
  /** Blocked files of the new version that will need a manual download. */
  manual: ModpackManualFile[]
  /** `Minecraft 1.20.1 → 1.20.4` style runtime change, or `null`. */
  runtime: { from: { minecraft: string; loader: { kind: LoaderKind; version: string } | null } | null; to: { minecraft: string; loader: { kind: LoaderKind; version: string } | null } } | null
}

/** What applying an update did. */
export interface ModpackUpdateResult {
  /** Pass to {@link ModpackService.rollback} to restore the previous version. */
  backupId: string
  added: number
  updated: number
  removed: number
  manual: ModpackManualFile[]
  runtimeError: { code: string; message: string } | null
}

/** Input for {@link ModpackService.export}. */
export interface ModpackExportInput {
  format: 'mrpack' | 'curseforge'
  /** Absolute output file path (from a save dialog). */
  output: string
  /** Default the instance name. */
  name?: string
  /** Default `1.0.0`. */
  version?: string
  /** Relative paths (files or folders) to include; default mods, resource packs, shader packs, config and options.txt. */
  include?: string[]
  /** Prefix (`dir/`) or exact excludes; default logs, crash reports, screenshots and servers.dat. */
  exclude?: string[]
}

/** A top-level entry of an instance folder, for the export include picker. */
export interface ExportFileRow {
  /** Relative path; folders end with `/`, as {@link ModpackExportInput.include} expects. */
  path: string
  isDirectory: boolean
  /** Bytes (folders: the sum of their files, capped by a scan budget). */
  size: number
  /** Files (folders: how many inside). */
  files: number
  /** Included unless the user changes it (mods, packs, config, options.txt…). */
  defaultSelected: boolean
}

/** What an export wrote. */
export interface ModpackExportResult {
  path: string
  /** Files written as download links. */
  linked: number
  /** Files embedded in the archive. */
  embedded: number
  warnings: string[]
}

/** Modpack import, update and export (runtime). Long operations run as tasks. */
export interface ModpackService {
  /** Open a pack for the preview dialog. Nothing is created (URLs are downloaded to the cache). */
  preview(source: ModpackSource): Promise<ModpackPreview>
  /**
   * Import a pack as one `modpack.import` task: read → resolve the files (CurseForge ids through
   * the API) → create the instance → install its game version and the files (in parallel).
   * Blocked CurseForge files come back in `manual`. If the file install fails or is cancelled the
   * instance stays (call again with `instanceId` to resume).
   */
  import(input: ModpackImportInput): Promise<ModpackImportResult>
  /** Download a modpack version from Modrinth/CurseForge and import it (records `upstream`). */
  installFromMarket(input: { platform: MarketPlatform; projectId: string; versionId: string; name?: string }): Promise<ModpackImportResult>
  /**
   * Watch `~/Downloads` for the instance's missing manual files (macOS asks the user for access
   * the first time). Matches are verified by hash, placed in the instance, and announced as
   * `modpack:manual`. Stops by itself when nothing is missing, on {@link stopWatchingManualDownloads}, or after 30 minutes.
   */
  watchManualDownloads(instanceId: string): Promise<ModpackManualFile[]>
  stopWatchingManualDownloads(instanceId: string): Promise<void>
  /**
   * A file the user dropped or picked: matched by hash against the missing files of `instanceId`
   * (or of every instance with missing files) and placed. Resolves with what is still missing.
   */
  provideManualFile(path: string, instanceId?: string): Promise<{ matched: boolean; instanceId: string | null; manual: ModpackManualFile[] }>
  /** The instance's missing manual files (from `.amethyst/unresolved.json`). */
  listManualFiles(instanceId: string): Promise<ModpackManualFile[]>
  /** Check the instance's upstream pack for a newer version (`null`: up to date or no upstream). */
  checkUpdate(instanceId: string): Promise<ModpackUpdateInfo | null>
  /** Download `versionId` of the instance's pack and diff it against the instance (a `modpack.plan-update` task). */
  planUpdate(instanceId: string, versionId: string): Promise<ModpackUpdatePlanView>
  /**
   * Apply a plan (a `modpack.update` task): stage everything, back up replaced and removed files,
   * commit, update the instance's runtime and upstream, then install the game version. `exclude`
   * lists change paths to leave alone. Worlds are backed up first when automatic backups are on.
   */
  applyUpdate(planId: string, options?: { exclude?: string[] }): Promise<ModpackUpdateResult>
  /** Restore the files (and lock) from before the update `backupId`. */
  rollback(instanceId: string, backupId: string): Promise<void>
  /** Write the instance as a `.mrpack` or CurseForge zip (a `modpack.export` task). */
  export(instanceId: string, input: ModpackExportInput): Promise<ModpackExportResult>
  /** The instance folder's top-level entries with sizes, for the export include picker. */
  listExportFiles(instanceId: string): Promise<ExportFileRow[]>
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
  versions: VersionsService
  java: JavaService
  install: InstallService
  launch: LaunchService
  modpacks: ModpackService
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

/** A file type filter for open and save panels. */
export interface FileFilter {
  name: string
  /** Extensions without the dot, e.g. `['jar']`. */
  extensions: string[]
}

/** Window chrome and Dock integration (main process). */
export interface WindowService {
  /** Follow the app's theme in native chrome and vibrancy (`nativeTheme.themeSource`). */
  setThemeSource(theme: ThemeMode): Promise<void>
  /** Dock progress bar in [0, 1]; `null` hides it. */
  setDockProgress(fraction: number | null): Promise<void>
  /** Dock badge (e.g. failed tasks); `''` clears it. */
  setDockBadge(text: string): Promise<void>
  /** Show and focus the main window (e.g. when the game crashed while the launcher was hidden). */
  focusMain(): Promise<void>
  /** The main window's selection, so the native Instance menu can be enabled to match (B13). Other windows' calls are ignored. */
  setMenuContext(context: import('./menu').MenuContext): Promise<void>
}

/** Finder and browser integration (main process). Paths must be absolute. */
export interface ShellService {
  /** Reveal a file or folder in Finder. Rejects with `ENOT_FOUND` when it does not exist. */
  showItemInFolder(path: string): Promise<void>
  /** Open a folder in Finder (folders only; files are revealed instead). */
  openFolder(path: string): Promise<void>
  /** Open an `https:` URL in the default browser. Other schemes reject with `EINVALID_ARGUMENT`. */
  openExternal(url: string): Promise<void>
}

/** Options for {@link DialogService.open}. */
export interface OpenDialogOptions {
  title?: string
  /** Pick folders instead of files. */
  directory?: boolean
  multiple?: boolean
  /** File type filters, e.g. `[{ name: 'Images', extensions: ['png', 'jpg'] }]`. */
  filters?: FileFilter[]
  /** Also allow choosing packages (`.app`, `.jdk` bundles) as folders. */
  treatPackagesAsDirectories?: boolean
}

/** Native open panels, attached to the calling window (main process). */
export interface DialogService {
  /** The chosen absolute paths, or an empty array when cancelled. */
  open(options: OpenDialogOptions): Promise<string[]>
  /** A save panel; the chosen absolute path, or `null` when cancelled. */
  saveFile(options?: { title?: string; defaultName?: string; filters?: FileFilter[] }): Promise<string | null>
}

/** Services in the Electron main process (window and OS integration only). */
export interface MainServices {
  app: AppService
  updater: UpdaterService
  window: WindowService
  shell: ShellService
  dialog: DialogService
}

/** Names routed to main by the preload; everything else goes to the runtime. */
export const MAIN_SERVICES = ['app', 'updater', 'window', 'shell', 'dialog'] as const satisfies readonly (keyof MainServices)[]

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
  /** Sign the sign-in window out: clear its partition's cookies and storage (on account removal). */
  clearAuthSession(): Promise<void>
  /** Open an `https:` URL in the default browser. Other schemes are rejected. */
  openExternal(url: string): Promise<void>
  /**
   * Hide every launcher window while a game runs ("hide launcher while playing"), or show them
   * again. The launch service calls it; main keeps the app in the Dock so it can be reopened.
   */
  setLauncherHidden(hidden: boolean): Promise<void>
  /**
   * Use this proxy (`http://`, `https://` or `socks5://` host and port) for Electron's own
   * traffic (the sign-in window and remote images), or go direct with `null`. Loopback and
   * local names always go direct.
   */
  setProxy(url: string | null): Promise<void>
}
