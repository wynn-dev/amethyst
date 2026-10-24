/**
 * The normalised modpack model shared by reading, resolving, installing, updating and exporting.
 */

/** Archive format of a pack. */
export type ModpackFormat = 'modrinth' | 'curseforge'

/** Mod loaders a pack can require. */
export type LoaderId = 'forge' | 'neoforge' | 'fabric' | 'quilt'

/** A loader requirement with a bare version (no Minecraft prefix), e.g. `{ id: 'neoforge', version: '47.1.84' }`. */
export interface ModpackLoader {
  id: LoaderId
  version: string
}

/** Modrinth environment support for one side. */
export type EnvSupport = 'required' | 'optional' | 'unsupported'

/** Client and server environment support of a file. */
export interface FileEnv {
  client: EnvSupport
  server: EnvSupport
}

/** Hex digests, lower case. `crc32` is the zip central-directory value (unsigned, as hex). */
export interface FileHashes {
  sha1?: string
  sha512?: string
  md5?: string
  crc32?: string
}

/** A `files[]` entry of a Modrinth pack (`modrinth.index.json`). */
export interface ModrinthPackFile {
  kind: 'modrinth'
  /** Checked relative path with `/` separators. */
  path: string
  hashes: FileHashes & { sha1: string }
  size?: number
  /** https URLs, tried in order. */
  downloads: string[]
  env: FileEnv
}

/** A `files[]` entry of a CurseForge pack. The path is only known after resolving the ids. */
export interface CurseForgePackFile {
  kind: 'curseforge'
  projectId: number
  fileId: number
  /** `required: false` means the pack lists the file as optional (opt-in, unchecked by default). */
  required: boolean
}

/** One manifest file entry. */
export type ModpackFileEntry = ModrinthPackFile | CurseForgePackFile

/** Which overrides folder an entry comes from. `client-overrides` wins over `overrides`. */
export type OverrideLayer = 'overrides' | 'client-overrides'

/** One file from an overrides folder, after precedence and de-duplication. */
export interface OverrideEntry {
  /** Checked path relative to the instance root. */
  path: string
  /** Full zip entry name inside the pack. */
  entry: string
  layer: OverrideLayer
  size: number
  /** CRC-32 from the central directory, as 8 lower-case hex digits. */
  crc32: string
}

/** Something about the pack that the preview should mention, but that did not stop the read. */
export interface ModpackWarning {
  code:
    | 'unsafe-path'
    | 'insecure-url'
    | 'unknown-dependency'
    | 'external-host'
    | 'duplicate-path'
    | 'derived-name'
    | 'manifest-version'
  message: string
  /** The offending path or key, when there is one. */
  subject?: string
}

/** A pack opened by {@link readModpack}. Opening has no side effects. */
export interface ModpackManifest {
  format: ModpackFormat
  /** Absolute path of the archive. */
  archive: string
  /** SHA-1 of the archive, used as the pack's identity (`upstream.packSha1`). */
  sha1: string
  /** Folder prefix inside the zip (`''`, or `'Pack/'` for a zipped folder). */
  prefix: string
  name: string
  /** Modrinth `versionId`, CurseForge `version`. */
  version: string
  author?: string
  summary?: string
  minecraft: string
  loader: ModpackLoader | null
  files: ModpackFileEntry[]
  /** Override folder names inside the archive (with the prefix), each ending in `/`. */
  overridesDirs: string[]
  /** Override files, precedence applied (`client-overrides/` beats `overrides/`). */
  overrides: OverrideEntry[]
  warnings: ModpackWarning[]
}

/** Where a managed file came from; recorded in the lock. */
export type FileOrigin =
  | { kind: 'modrinth'; projectId?: string; versionId?: string }
  | { kind: 'curseforge'; projectId: number; fileId: number }
  | { kind: 'url' }
  | { kind: 'override'; layer: OverrideLayer }
  | { kind: 'manual'; projectId: number; fileId: number }

/** A file the install will place (or that needs a manual download). */
export interface ResolvedFile {
  path: string
  hashes: FileHashes
  size?: number
  /** https URLs in order. Empty for blocked CurseForge files. */
  downloads: string[]
  /** The user may opt out of (Modrinth `optional`) or into (CurseForge `required: false`) this file. */
  optional: boolean
  /** Initial checkbox state for optional files. Always true for required files. */
  defaultSelected: boolean
  /** True when the author disallows third-party downloads: the user must fetch it by hand. */
  blocked: boolean
  origin: FileOrigin
  /** CurseForge murmur2 fingerprint, when known. */
  fingerprint?: number
  /** `world`: a zip extracted into `saves/<name>/`. Default: a plain file. */
  kind?: 'file' | 'world'
  /** Display name (project name when known, else the file name). */
  name: string
}

/** A file whose author blocks third-party downloads; the user downloads it from `websiteUrl`. */
export interface ManualDownload {
  /** Project name. */
  name: string
  fileName: string
  /** The file's download page on curseforge.com. */
  websiteUrl: string
  sha1?: string
  md5?: string
  size: number
  /** Target path in the instance. */
  path: string
  projectId: number
  fileId: number
}

/** Why a manifest file is not part of the install. */
export interface SkippedFile {
  /** Target path when known; otherwise `curseforge:<projectId>/<fileId>`. */
  path: string
  reason: 'env-unsupported' | 'missing-on-curseforge' | 'unknown-class' | 'unsafe-path' | 'datapack'
  message: string
}

/** An optional file the user can toggle in the preview. */
export interface OptionalChoice {
  path: string
  name: string
  defaultSelected: boolean
}

/** Output of {@link resolveModpackFiles}. */
export interface ResolvedModpack {
  format: ModpackFormat
  packSha1: string
  /** Every installable file, including optional and blocked ones. Overrides are not listed. */
  files: ResolvedFile[]
  /** The optional files, as a user choice. */
  optional: OptionalChoice[]
  /** Blocked CurseForge files that must be downloaded by hand. */
  manualDownloads: ManualDownload[]
  /** CurseForge data packs (class 6945) placed in `.amethyst/datapacks-pending/` for the user to add to a world. */
  datapacks: ResolvedFile[]
  skipped: SkippedFile[]
  /** Download hosts outside Modrinth's allowlist, for the preview's "This pack downloads files from" note. */
  externalHosts: string[]
}

/** Where an instance's pack came from (`instances.md` §3.6). */
export type ModpackUpstream =
  | { kind: 'modrinth'; projectId: string; versionId: string; packSha1?: string }
  | { kind: 'curseforge'; projectId: number; fileId: number; packSha1?: string }
