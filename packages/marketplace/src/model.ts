/**
 * Unified marketplace model.
 *
 * {@link MarketProject}, {@link MarketVersion} and {@link MarketFile} let the UI render
 * Modrinth and CurseForge results in one list. The mappers read raw API objects
 * defensively (missing cosmetic fields become empty values), and the tables below translate
 * project types and loaders between the two platforms.
 *
 * A CurseForge "version" is a file: each CurseForge file maps to one {@link MarketVersion}
 * with a single {@link MarketFile}.
 */

import {
  classifyCurseForgeGameVersions,
  CurseForgeClass,
  CurseForgeModLoaderType,
  curseForgeFilePageUrl,
  curseForgeProjectUrl,
  isInstallableCurseForgeFile,
  type CurseForgeFile,
  type CurseForgeMod,
  type CurseForgeModLoaderTypeId,
} from './curseforge'
import type { MarketSource } from './errors'
import type {
  ModrinthDependencyType,
  ModrinthFile,
  ModrinthProject,
  ModrinthSearchHit,
  ModrinthSide,
  ModrinthVersion,
} from './modrinth'
import { num, str, strOrNull, strings } from './validate'

export type { MarketSource } from './errors'

export type MarketProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'world'
export type MarketReleaseType = 'release' | 'beta' | 'alpha'
export type MarketDependencyType = 'required' | 'optional' | 'incompatible' | 'embedded'

export interface MarketProject {
  /** `modrinth:<id>` or `curseforge:<id>`. */
  key: string
  source: MarketSource
  /** Platform id as a string. */
  id: string
  slug: string
  title: string
  /** Primary author; empty when unknown (Modrinth project objects carry only a team id). */
  author: string
  summary: string
  iconUrl: string | null
  projectType: MarketProjectType | null
  downloads: number
  /** Modrinth followers, CurseForge thumbs-up count. */
  followers: number
  /** Display names (Modrinth category names, CurseForge category names). */
  categories: string[]
  /** Lower-case loader ids when known. */
  loaders: string[]
  /** Minecraft versions when known. */
  gameVersions: string[]
  createdAt: string | null
  updatedAt: string | null
  /** Modrinth only. */
  side?: { client: ModrinthSide; server: ModrinthSide }
  /** Project page on the platform's website. */
  websiteUrl: string
  /** Same project on the other platform, set by the combined-search de-duplication. */
  linked?: MarketProject
}

export interface MarketFile {
  source: MarketSource
  /** CurseForge file id; Modrinth files have no id of their own (use `versionId`). */
  id: string | null
  projectId: string
  versionId: string
  fileName: string
  /** Direct download URL, or `null` when CurseForge forbids third-party downloads. */
  url: string | null
  /** Page where the user can download the file by hand (CurseForge), else `null`. */
  websiteUrl: string | null
  /** True when `url` is null: the "Missing files" flow must be used. */
  manualDownloadRequired: boolean
  size: number
  sha1: string | null
  sha512: string | null
  /** CurseForge murmur2 fingerprint (uint32). */
  fingerprint: number | null
  primary: boolean
  /** Modrinth `file_type` (e.g. `required-resource-pack`), `null` for normal files. */
  fileType: string | null
}

export interface MarketDependency {
  projectId: string | null
  versionId: string | null
  fileName: string | null
  type: MarketDependencyType
  /** CurseForge only: the original relation was "Tool" (4), mapped to optional. */
  tool?: boolean
}

export interface MarketVersion {
  /** `modrinth:<versionId>` or `curseforge:<fileId>`. */
  key: string
  source: MarketSource
  id: string
  projectId: string
  name: string
  versionNumber: string
  releaseType: MarketReleaseType
  publishedAt: string
  downloads: number
  gameVersions: string[]
  loaders: string[]
  files: MarketFile[]
  dependencies: MarketDependency[]
  changelog: string | null
  /** False for CurseForge files that are unavailable or not approved/released. */
  installable: boolean
}

// ---------------------------------------------------------------------------------------------
// Type and loader tables
// ---------------------------------------------------------------------------------------------

const CF_CLASS_TO_TYPE: Record<number, MarketProjectType> = {
  [CurseForgeClass.Mods]: 'mod',
  [CurseForgeClass.ResourcePacks]: 'resourcepack',
  [CurseForgeClass.Worlds]: 'world',
  [CurseForgeClass.Modpacks]: 'modpack',
  [CurseForgeClass.Shaders]: 'shader',
  [CurseForgeClass.DataPacks]: 'datapack',
}

/** CurseForge class id → unified type (`null` for unsupported classes). */
export function projectTypeFromCurseForgeClass(classId: number | null | undefined): MarketProjectType | null {
  return classId == null ? null : (CF_CLASS_TO_TYPE[classId] ?? null)
}

/** Unified type → CurseForge class id. */
export function curseForgeClassForProjectType(type: MarketProjectType): number {
  switch (type) {
    case 'mod':
      return CurseForgeClass.Mods
    case 'modpack':
      return CurseForgeClass.Modpacks
    case 'resourcepack':
      return CurseForgeClass.ResourcePacks
    case 'shader':
      return CurseForgeClass.Shaders
    case 'datapack':
      return CurseForgeClass.DataPacks
    case 'world':
      return CurseForgeClass.Worlds
  }
}

/**
 * Modrinth `project_type` → unified type. Datapacks are published as `mod` projects whose only
 * loader is `datapack`, so the loaders (or a search hit's categories) are consulted.
 */
export function projectTypeFromModrinth(projectType: string, loaders: string[] = []): MarketProjectType | null {
  switch (projectType) {
    case 'mod':
      return loaders.includes('datapack') && !loaders.some((l) => MOD_LOADERS.has(l)) ? 'datapack' : 'mod'
    case 'datapack':
    case 'modpack':
    case 'resourcepack':
    case 'shader':
      return projectType
    default:
      return null
  }
}

const MOD_LOADERS = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'liteloader', 'rift', 'modloader'])

const CF_LOADER_NAMES: Record<number, string> = {
  [CurseForgeModLoaderType.Forge]: 'forge',
  [CurseForgeModLoaderType.Cauldron]: 'cauldron',
  [CurseForgeModLoaderType.LiteLoader]: 'liteloader',
  [CurseForgeModLoaderType.Fabric]: 'fabric',
  [CurseForgeModLoaderType.Quilt]: 'quilt',
  [CurseForgeModLoaderType.NeoForge]: 'neoforge',
}

/** CurseForge `modLoaderType` → lower-case loader id (`null` for Any/unknown). */
export function loaderFromCurseForge(type: number | null | undefined): string | null {
  return type == null ? null : (CF_LOADER_NAMES[type] ?? null)
}

/** Lower-case loader id → CurseForge `modLoaderType` (`undefined` when CurseForge lacks it). */
export function curseForgeLoaderType(loader: string): CurseForgeModLoaderTypeId | undefined {
  switch (loader.toLowerCase()) {
    case 'forge':
      return CurseForgeModLoaderType.Forge
    case 'neoforge':
      return CurseForgeModLoaderType.NeoForge
    case 'fabric':
      return CurseForgeModLoaderType.Fabric
    case 'quilt':
      return CurseForgeModLoaderType.Quilt
    case 'liteloader':
      return CurseForgeModLoaderType.LiteLoader
    case 'cauldron':
      return CurseForgeModLoaderType.Cauldron
    default:
      return undefined
  }
}

/**
 * Loaders whose content an instance accepts: Quilt also runs Fabric mods, and NeoForge on
 * Minecraft 1.20.1 also runs Forge mods.
 */
export function expandLoaders(loader: string, minecraftVersion?: string): string[] {
  const l = loader.toLowerCase()
  if (l === 'quilt') return ['quilt', 'fabric']
  if (l === 'neoforge' && minecraftVersion === '1.20.1') return ['neoforge', 'forge']
  return [l]
}

// ---------------------------------------------------------------------------------------------
// Modrinth mappers
// ---------------------------------------------------------------------------------------------

const MODRINTH_SITE = 'https://modrinth.com'

function modrinthUrl(projectType: string, slug: string): string {
  const segment = projectType === 'datapack' || projectType === 'shader' || projectType === 'modpack' || projectType === 'resourcepack'
    ? projectType
    : 'mod'
  return `${MODRINTH_SITE}/${segment}/${encodeURIComponent(slug)}`
}

function side(client: unknown, server: unknown): { client: ModrinthSide; server: ModrinthSide } | undefined {
  if (typeof client !== 'string' && typeof server !== 'string') return undefined
  return { client: (str(client) || 'unknown') as ModrinthSide, server: (str(server) || 'unknown') as ModrinthSide }
}

/** Modrinth search hit → {@link MarketProject}. Loaders are taken from the hit's categories. */
export function modrinthHitToProject(hit: ModrinthSearchHit): MarketProject {
  const categories = strings(hit.categories)
  const loaders = categories.filter((c) => MOD_LOADERS.has(c) || c === 'datapack')
  const display = strings(hit.display_categories)
  const id = str(hit.project_id)
  const slug = str(hit.slug, id)
  return {
    key: `modrinth:${id}`,
    source: 'modrinth',
    id,
    slug,
    title: str(hit.title, slug),
    author: str(hit.author),
    summary: str(hit.description),
    iconUrl: strOrNull(hit.icon_url),
    projectType: projectTypeFromModrinth(str(hit.project_type), categories),
    downloads: num(hit.downloads),
    followers: num(hit.follows),
    categories: (display.length ? display : categories).filter((c) => !loaders.includes(c)),
    loaders,
    gameVersions: strings(hit.versions),
    createdAt: strOrNull(hit.date_created),
    updatedAt: strOrNull(hit.date_modified),
    side: side(hit.client_side, hit.server_side),
    websiteUrl: modrinthUrl(str(hit.project_type), slug),
  }
}

/** Modrinth project → {@link MarketProject}. `author` is empty; fetch team members for it. */
export function modrinthProjectToProject(p: ModrinthProject): MarketProject {
  const loaders = strings(p.loaders)
  const id = str(p.id)
  const slug = str(p.slug, id)
  return {
    key: `modrinth:${id}`,
    source: 'modrinth',
    id,
    slug,
    title: str(p.title, slug),
    author: '',
    summary: str(p.description),
    iconUrl: strOrNull(p.icon_url),
    projectType: projectTypeFromModrinth(str(p.project_type), loaders),
    downloads: num(p.downloads),
    followers: num(p.followers),
    categories: [...strings(p.categories), ...strings(p.additional_categories)],
    loaders,
    gameVersions: strings(p.game_versions),
    createdAt: strOrNull(p.published),
    updatedAt: strOrNull(p.updated),
    side: side(p.client_side, p.server_side),
    websiteUrl: modrinthUrl(str(p.project_type), slug),
  }
}

/** Modrinth file → {@link MarketFile}. */
export function modrinthFileToFile(f: ModrinthFile, v: Pick<ModrinthVersion, 'id' | 'project_id'>): MarketFile {
  const url = strOrNull(f.url)
  const hashes = f.hashes ?? {}
  return {
    source: 'modrinth',
    id: null,
    projectId: str(v.project_id),
    versionId: str(v.id),
    fileName: str(f.filename),
    url,
    websiteUrl: null,
    manualDownloadRequired: url === null,
    size: num(f.size),
    sha1: strOrNull(hashes.sha1),
    sha512: strOrNull(hashes.sha512),
    fingerprint: null,
    primary: f.primary === true,
    fileType: strOrNull(f.file_type),
  }
}

const MR_DEP_TYPES = new Set<ModrinthDependencyType>(['required', 'optional', 'incompatible', 'embedded'])

/** Modrinth version → {@link MarketVersion}. */
export function modrinthVersionToVersion(v: ModrinthVersion): MarketVersion {
  const type = str(v.version_type)
  return {
    key: `modrinth:${str(v.id)}`,
    source: 'modrinth',
    id: str(v.id),
    projectId: str(v.project_id),
    name: str(v.name, str(v.version_number)),
    versionNumber: str(v.version_number),
    releaseType: type === 'beta' || type === 'alpha' ? type : 'release',
    publishedAt: str(v.date_published),
    downloads: num(v.downloads),
    gameVersions: strings(v.game_versions),
    loaders: strings(v.loaders),
    files: (Array.isArray(v.files) ? v.files : []).map((f) => modrinthFileToFile(f, v)),
    dependencies: (Array.isArray(v.dependencies) ? v.dependencies : [])
      .filter((d) => MR_DEP_TYPES.has(d.dependency_type))
      .map((d) => ({
        projectId: strOrNull(d.project_id),
        versionId: strOrNull(d.version_id),
        fileName: strOrNull(d.file_name),
        type: d.dependency_type,
      })),
    changelog: strOrNull(v.changelog),
    installable: v.status === undefined || v.status === 'listed' || v.status === 'unlisted',
  }
}

// ---------------------------------------------------------------------------------------------
// CurseForge mappers
// ---------------------------------------------------------------------------------------------

/** CurseForge mod → {@link MarketProject}. Loaders and versions come from `latestFilesIndexes`. */
export function curseForgeModToProject(m: CurseForgeMod): MarketProject {
  const loaders = new Set<string>()
  const versions = new Set<string>()
  for (const idx of Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes : []) {
    const loader = loaderFromCurseForge(idx.modLoader)
    if (loader) loaders.add(loader)
    if (typeof idx.gameVersion === 'string') versions.add(idx.gameVersion)
  }
  const id = String(m.id)
  return {
    key: `curseforge:${id}`,
    source: 'curseforge',
    id,
    slug: str(m.slug, id),
    title: str(m.name, str(m.slug, id)),
    author: str(m.authors?.[0]?.name),
    summary: str(m.summary),
    iconUrl: strOrNull(m.logo?.thumbnailUrl) ?? strOrNull(m.logo?.url),
    projectType: projectTypeFromCurseForgeClass(m.classId),
    downloads: num(m.downloadCount),
    followers: num(m.thumbsUpCount),
    categories: (Array.isArray(m.categories) ? m.categories : []).map((c) => str(c.name)).filter(Boolean),
    loaders: [...loaders],
    gameVersions: [...versions],
    createdAt: strOrNull(m.dateCreated),
    updatedAt: strOrNull(m.dateModified),
    websiteUrl: curseForgeProjectUrl(m),
  }
}

/**
 * CurseForge file → {@link MarketFile}. A `null` `downloadUrl` stays `null` (never guessed);
 * `websiteUrl` then points at the file's page, which is precise when `mod` is given.
 */
export function curseForgeFileToFile(
  f: CurseForgeFile,
  mod?: Pick<CurseForgeMod, 'id' | 'slug' | 'classId' | 'links'>,
): MarketFile {
  const url = typeof f.downloadUrl === 'string' && f.downloadUrl.startsWith('https://') ? f.downloadUrl : null
  const sha1 = (Array.isArray(f.hashes) ? f.hashes : []).find((h) => h.algo === 1)?.value
  return {
    source: 'curseforge',
    id: String(f.id),
    projectId: String(f.modId),
    versionId: String(f.id),
    fileName: str(f.fileName),
    url,
    websiteUrl: curseForgeFilePageUrl(f, mod),
    manualDownloadRequired: url === null,
    size: num(f.fileLength),
    sha1: sha1 ? sha1.toLowerCase() : null,
    sha512: null,
    fingerprint: typeof f.fileFingerprint === 'number' ? f.fileFingerprint >>> 0 : null,
    primary: true,
    fileType: null,
  }
}

const CF_RELATIONS: Record<number, { type: MarketDependencyType; tool?: boolean }> = {
  1: { type: 'embedded' },
  2: { type: 'optional' },
  3: { type: 'required' },
  4: { type: 'optional', tool: true },
  5: { type: 'incompatible' },
  6: { type: 'embedded' },
}

/** CurseForge file → {@link MarketVersion} with that one file. */
export function curseForgeFileToVersion(
  f: CurseForgeFile,
  mod?: Pick<CurseForgeMod, 'id' | 'slug' | 'classId' | 'links'>,
): MarketVersion {
  const info = classifyCurseForgeGameVersions(f)
  return {
    key: `curseforge:${f.id}`,
    source: 'curseforge',
    id: String(f.id),
    projectId: String(f.modId),
    name: str(f.displayName, str(f.fileName)),
    versionNumber: str(f.displayName, str(f.fileName)),
    releaseType: f.releaseType === 2 ? 'beta' : f.releaseType === 3 ? 'alpha' : 'release',
    publishedAt: str(f.fileDate),
    downloads: num(f.downloadCount),
    gameVersions: info.minecraft,
    loaders: info.loaders,
    files: [curseForgeFileToFile(f, mod)],
    dependencies: (Array.isArray(f.dependencies) ? f.dependencies : []).flatMap((d) => {
      const rel = CF_RELATIONS[d.relationType]
      if (!rel) return []
      const dep: MarketDependency = { projectId: String(d.modId), versionId: null, fileName: null, type: rel.type }
      if (rel.tool) dep.tool = true
      return [dep]
    }),
    changelog: null,
    installable: isInstallableCurseForgeFile(f),
  }
}
