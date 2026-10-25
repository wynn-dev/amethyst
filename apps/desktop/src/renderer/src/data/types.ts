/**
 * Renderer-side view models. Each domain hook in this folder maps the service results from
 * `shared/services.ts` onto these shapes in one place (e.g. `data/instances.ts`).
 */
import type { InstanceOverrides, InstanceRuntime, LaunchStep } from '@shared/services'

export type LoaderKind = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'
export type Source = 'modrinth' | 'curseforge' | 'local'

export type InstanceState =
  | { kind: 'idle' }
  /** Progress comes from the instance's install task (`useInstanceTask`), so rows re-render alone. */
  | { kind: 'installing'; progress?: number; taskId?: string }
  | { kind: 'launching'; step?: LaunchStep }
  | { kind: 'running'; pid: number; since: number; ready?: boolean }
  | { kind: 'problem'; message: string }

export interface InstanceSummary {
  id: string
  name: string
  /** Icon: an `amethyst-asset:` URL, or undefined for the generated block icon. */
  iconUrl?: string
  /** Hue (0–360) for the generated icon. */
  iconHue: number
  minecraft: string
  loader: { kind: LoaderKind; version?: string }
  folderId?: string
  pinned: boolean
  state: InstanceState
  lastPlayedAt?: number
  playTimeMs: number
  createdAt: number
  /** The folder lives outside the data root (imported in place). */
  external?: boolean
  /** Set when the instance came from a modpack. */
  upstream?: { source: Exclude<Source, 'local'>; projectId: string; projectName: string; version: string; latestVersion?: string }
}

export interface InstanceFolder {
  id: string
  name: string
  expanded: boolean
}

export interface InstanceDetail extends InstanceSummary {
  path: string
  /** Free text (the instance description; also the modpack summary on export). */
  notes: string
  author: string
  homepageUrl: string
  runtime: InstanceRuntime
  /** Linked installed version id, `''` when none. */
  versionId: string
  /** Per-instance launch overrides; absent keys inherit the global game settings. */
  overrides: InstanceOverrides
}

export interface InstanceIssue {
  id: string
  severity: 'warning' | 'error'
  title: string
  description?: string
  action?: { label: string; run: () => void }
}

export interface ModFile {
  id: string
  name: string
  version: string
  fileName: string
  author: string
  description: string
  enabled: boolean
  source: Source
  update?: { version: string }
  side: 'client' | 'server' | 'both'
  sizeBytes: number
  addedAt: number
  hue: number
  sha1: string
  dependencies: { id: string; name: string; satisfied: boolean }[]
  dependents: string[]
  problem?: 'duplicate' | 'missing-dependency' | 'incompatible'
  folder?: string
}

export interface ResourcePack {
  id: string
  name: string
  description: string
  enabled: boolean
  /** Position in the load order (0 = top = highest priority); undefined when not enabled. */
  order?: number
  packFormat: number
  compatible: boolean
  madeFor?: string
  sizeBytes: number
  source: Source
  hue: number
}

export interface ShaderPack {
  id: string
  name: string
  active: boolean
  sizeBytes: number
  source: Source
  hue: number
}

export interface World {
  id: string
  name: string
  gameMode: 'survival' | 'creative' | 'adventure' | 'spectator' | 'hardcore'
  lastPlayedAt: number
  version: string
  sizeBytes: number
  seed: string
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard'
  cheats: boolean
  datapacks: { id: string; name: string; enabled: boolean }[]
  hue: number
}

export interface LogFile {
  id: string
  kind: 'live' | 'log' | 'crash'
  name: string
  createdAt: number
  sizeBytes: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  /** Unique row key (`<seq>` or `<seq>.<continuation line>`). */
  id: string
  /** Sequence number within the run. */
  n: number
  time: string
  level: LogLevel
  thread: string
  source: string
  text: string
}

export interface CrashSummary {
  exitCode: number
  headline: string
  suspects: { modId: string; name: string }[]
}

export interface Account {
  id: string
  kind: 'microsoft' | 'offline'
  name: string
  uuid: string
  status: 'ok' | 'expired' | 'needs-sign-in'
  active: boolean
  /** Hue for the generated head avatar (used when there is no skin). */
  hue: number
  /** Xbox gamerpic (`https:`), when known. */
  avatarUrl?: string
  /** Active skin texture URL (`https:` or `amethyst-asset:`), when not the default. */
  skinUrl?: string
}

export type TaskState = 'running' | 'paused' | 'queued' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskSnapshot {
  id: string
  title: string
  /** Current step, e.g. "Downloading libraries". */
  subtitle?: string
  kind: 'install' | 'download' | 'modpack' | 'java' | 'update' | 'export' | 'verify' | 'copy' | 'backup'
  /** Stable machine name from the runtime, e.g. `install.run`. */
  name?: string
  /** Show a Cancel button. */
  cancellable?: boolean
  state: TaskState
  /** 0–1, undefined when indeterminate. */
  progress?: number
  bytesDone?: number
  bytesTotal?: number
  etaMs?: number
  startedAt: number
  finishedAt?: number
  error?: { message: string; details: string; code?: string }
  children: { id: string; title: string; state: TaskState; progress?: number }[]
  instanceId?: string
}

export type ProjectType = 'modpack' | 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'world'

export interface ProjectHit {
  id: string
  source: Exclude<Source, 'local'>
  type: ProjectType
  title: string
  author: string
  summary: string
  downloads: number
  follows: number
  updatedAt: number
  categories: string[]
  gameVersions: string[]
  loaders: LoaderKind[]
  hue: number
  installed?: 'installed' | 'update'
  /** When a target instance is set. */
  compatible?: boolean
}

export interface ProjectDetail extends ProjectHit {
  body: string
  links: { label: string; url: string }[]
  versions: ProjectVersion[]
  gallery: { id: string; hue: number; title: string }[]
  alsoOn?: Exclude<Source, 'local'>
  license: string
}

export interface ProjectVersion {
  id: string
  name: string
  channel: 'release' | 'beta' | 'alpha'
  gameVersions: string[]
  loaders: LoaderKind[]
  publishedAt: number
  downloads: number
}

export interface JavaRuntime {
  /** The `bin/java` path (the runtime's identity). */
  id: string
  version: string
  major: number
  vendor: string
  arch: 'arm64' | 'x86_64' | 'unknown'
  path: string
  /** The JDK/JRE home (for Show in Finder). */
  home: string
  source: 'managed' | 'system' | 'added'
  valid: boolean
  invalidReason?: string
}

export interface GameVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releasedAt: number
  installed?: boolean
}

export interface LoaderVersion {
  version: string
  recommended?: boolean
  latest?: boolean
}

export interface HomeUpdate {
  id: string
  text: string
  instanceId: string
  tab: 'mods' | 'overview'
}
