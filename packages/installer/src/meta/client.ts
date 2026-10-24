import type { HttpClient } from '@amethyst/net'
import { InstallError } from '../errors'
import { joinUrl } from '../maven'
import { type ManifestVersion, parseVersionManifest, type RawVersionJson, type VersionManifest } from '../version-json'
import { type CacheResult, MetadataCache, type MetadataCacheOptions } from './cache'
import {
  type FabricLikeKind,
  type LoaderGameVersion,
  type LoaderVersion,
  parseLoaderGameVersions,
  parseLoaderProfile,
  parseLoaderVersions,
} from './fabric'
import {
  type ForgeFiles,
  type ForgeVersion,
  forgeVersionsFrom,
  parseForgeFiles,
  parseForgePromotions,
  parseMavenMetadata,
} from './forge'
import { type NeoForgeProject, type NeoForgeVersion, neoForgeVersionsFrom } from './neoforge'

/** Base URLs of every metadata source. Override them to point at mirrors of your own or a test server. */
export interface MetadataEndpoints {
  /** Mojang version manifest v2. */
  mojangManifest: string
  /** Fabric meta v2 base. */
  fabricMeta: string
  /** Quilt meta v3 base. */
  quiltMeta: string
  /** Forge maven root (artifacts live at `net/minecraftforge/forge/...`). */
  forgeMaven: string
  /** Forge files site root (promotions and per-version `meta.json`). */
  forgeFiles: string
  /** NeoForge releases maven root (artifacts live at `net/neoforged/...`). */
  neoForgeMaven: string
}

/** The public endpoints. */
export const DEFAULT_ENDPOINTS: Readonly<MetadataEndpoints> = Object.freeze({
  mojangManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://meta.fabricmc.net/v2/',
  quiltMeta: 'https://meta.quiltmc.org/v3/',
  forgeMaven: 'https://maven.minecraftforge.net/',
  forgeFiles: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
  neoForgeMaven: 'https://maven.neoforged.net/releases/',
})

/** Options for {@link createMetadataClient}. */
export interface MetadataClientOptions extends MetadataCacheOptions {
  endpoints?: Partial<MetadataEndpoints>
}

/** Per-call options. */
export interface MetaCallOptions {
  /** Revalidate now instead of using a fresh cached copy. */
  force?: boolean
  signal?: AbortSignal
}

/** Cached, validated access to every version list the installer needs. */
export interface MetadataClient {
  readonly endpoints: Readonly<MetadataEndpoints>
  readonly http: HttpClient
  /** The Mojang version manifest v2. */
  minecraftManifest(options?: MetaCallOptions): Promise<CacheResult<VersionManifest>>
  /**
   * Look up one Minecraft version. When the id is missing from the cached manifest, the manifest is
   * refreshed (blocking) before giving up, so brand-new releases are found on the first try.
   *
   * @throws {InstallError} `EINSTALL_NOT_FOUND` when the id does not exist.
   */
  minecraftVersion(id: string, options?: MetaCallOptions): Promise<ManifestVersion>
  /** Game versions Fabric/Quilt support. */
  loaderGameVersions(kind: FabricLikeKind, options?: MetaCallOptions): Promise<LoaderGameVersion[]>
  /** All Fabric/Quilt loader versions, newest first (as the services order them). */
  loaderVersions(kind: FabricLikeKind, options?: MetaCallOptions): Promise<LoaderVersion[]>
  /** The launcher profile for a game/loader pair (not cached: it embeds a timestamp). */
  loaderProfile(kind: FabricLikeKind, minecraft: string, loader: string, options?: MetaCallOptions): Promise<RawVersionJson>
  /** Forge builds, newest first; only those for `minecraft` when given. */
  forgeVersions(minecraft?: string, options?: MetaCallOptions): Promise<ForgeVersion[]>
  /** One Forge build's file list (`meta.json`). Cached for a long time: published builds never change. */
  forgeFiles(artifactVersion: string, options?: MetaCallOptions): Promise<ForgeFiles>
  /** NeoForge builds, newest first; only those for `minecraft` when given (1.20.1 comes from the `forge` project). */
  neoForgeVersions(minecraft?: string, options?: MetaCallOptions): Promise<NeoForgeVersion[]>
}

/**
 * Create a {@link MetadataClient}. Lists are cached in memory (and in `cacheDir` when given) and
 * revalidated with conditional requests once older than `maxAgeMs`; a failed refresh falls back to
 * the cached copy. Every response is validated before use.
 */
export function createMetadataClient(options: MetadataClientOptions = {}): MetadataClient {
  const endpoints: MetadataEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints }
  const cache = new MetadataCache(options)
  const filesCache = new MetadataCache({ ...options, maxAgeMs: 7 * 24 * 60 * 60_000 })
  const loaderBase = (kind: FabricLikeKind) => (kind === 'fabric' ? endpoints.fabricMeta : endpoints.quiltMeta)

  const client: MetadataClient = {
    endpoints,
    get http() {
      return cache.http
    },
    minecraftManifest(o = {}) {
      return cache.get('minecraft', endpoints.mojangManifest, parseVersionManifest, o)
    },
    async minecraftVersion(id, o = {}) {
      let entry = (await client.minecraftManifest(o)).data.versions.find((v) => v.id === id)
      if (!entry && !o.force) entry = (await client.minecraftManifest({ ...o, force: true })).data.versions.find((v) => v.id === id)
      if (!entry) throw new InstallError('EINSTALL_NOT_FOUND', `Minecraft ${id} does not exist`)
      return entry
    },
    async loaderGameVersions(kind, o = {}) {
      return (await cache.get(`${kind}-game`, joinUrl(loaderBase(kind), 'versions/game'), parseLoaderGameVersions, o)).data
    },
    async loaderVersions(kind, o = {}) {
      return (await cache.get(`${kind}-loader`, joinUrl(loaderBase(kind), 'versions/loader'), parseLoaderVersions, o)).data
    },
    async loaderProfile(kind, minecraft, loader, o = {}) {
      const url = joinUrl(loaderBase(kind), `versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loader)}/profile/json`)
      const value = await cache.http.json(url, { signal: o.signal })
      return parseLoaderProfile(value, minecraft, kind)
    },
    async forgeVersions(minecraft, o = {}) {
      const [versions, promos] = await Promise.all([
        cache.get('forge-maven', joinUrl(endpoints.forgeMaven, 'net/minecraftforge/forge/maven-metadata.xml'), (raw) => parseMavenMetadata(String(raw)), {
          ...o,
          format: 'text',
        }),
        cache.get('forge-promotions', joinUrl(endpoints.forgeFiles, 'promotions_slim.json'), parseForgePromotions, o).catch(() => undefined),
      ])
      return forgeVersionsFrom(versions.data, promos?.data ?? {}, minecraft)
    },
    async forgeFiles(artifactVersion, o = {}) {
      const url = joinUrl(endpoints.forgeFiles, `${encodeURIComponent(artifactVersion)}/meta.json`)
      return (await filesCache.get(`forge-files-${artifactVersion.replace(/[^\w.-]/g, '_')}`, url, parseForgeFiles, o)).data
    },
    async neoForgeVersions(minecraft, o = {}) {
      const list = (project: NeoForgeProject) =>
        cache.get(`neoforge-${project}`, joinUrl(endpoints.neoForgeMaven, `net/neoforged/${project}/maven-metadata.xml`), (raw) => parseMavenMetadata(String(raw)), {
          ...o,
          format: 'text',
        })
      const needForge = minecraft === undefined || minecraft === '1.20.1'
      const needNeo = minecraft !== '1.20.1'
      // When listing everything, an unavailable legacy 1.20.1 list does not hide the main one.
      const forgeList = needForge ? list('forge').catch((e: unknown) => (needNeo && !o.signal?.aborted ? undefined : Promise.reject(e))) : undefined
      const [neo, forge] = await Promise.all([needNeo ? list('neoforge') : undefined, forgeList])
      return neoForgeVersionsFrom({ neoforge: neo?.data, forge: forge?.data }, minecraft)
    },
  }
  return client
}
