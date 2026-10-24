/** Mod loaders whose metadata format is understood. */
export type ModLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'liteloader'

/** Which side a mod must be installed on. */
export type ModSide = 'client' | 'server' | 'both'

/** Relationship kinds. `depends` covers required and optional (Forge `type="optional"`) dependencies. */
export type DependencyKind = 'depends' | 'recommends' | 'suggests' | 'breaks' | 'conflicts'

/** One declared relationship to another mod. */
export interface ModDependency {
  /** Target mod id (Quilt `maven.group:` prefixes are stripped). */
  modId: string
  /** Version range verbatim. Fabric/Quilt OR-alternatives are joined with ` || `. Absent means any. */
  range?: string
  /** `maven` for Forge/NeoForge ranges (`[1.0,2.0)`), `semver` for Fabric/Quilt predicates. */
  rangeKind: 'maven' | 'semver'
  /** True when the game refuses to start without it (only meaningful for `depends`). */
  required: boolean
  kind: DependencyKind
  /** Forge/NeoForge `side` of the dependency. */
  side?: ModSide
  /** Quilt "any of": the dependency is satisfied by this entry or any alternative. */
  alternatives?: ModDependency[]
}

/** Links declared by the mod. */
export interface ModLinks {
  homepage?: string
  issues?: string
  sources?: string
  /** Forge `updateJSONURL`. */
  update?: string
}

/** Metadata read from one loader's descriptor file. */
export interface LoaderModMetadata {
  loader: ModLoader
  /** The descriptor this came from, e.g. `fabric.mod.json` or `META-INF/mods.toml`. */
  source: string
  id: string
  name?: string
  /** Version verbatim (may be non-semver). `${file.jarVersion}` is already substituted. */
  version?: string
  description?: string
  authors: string[]
  license?: string
  /** Icon path inside the jar (no leading `/`). */
  icon?: string
  links: ModLinks
  environment: ModSide
  dependencies: ModDependency[]
  /**
   * Every mod id this file makes available, mapped to its version: the primary id, `provides`
   * aliases, additional Forge `[[mods]]` and nested (jar-in-jar) mods.
   */
  provides: Record<string, string>
  /** Version range of the `minecraft` dependency, if declared. */
  minecraftRange?: string
  /** Version range of the loader itself (`fabricloader`, `forge`, `neoforge`, Forge `loaderVersion`). */
  loaderRange?: string
  /** Paths of nested jars declared by the descriptor (Fabric/Quilt `jars`). */
  nestedJars: string[]
}

/** Why a descriptor could not be (fully) used. Parsing never throws for these. */
export type ParseWarningCode = 'invalid-json' | 'invalid-toml' | 'invalid-shape' | 'too-large' | 'unreadable' | 'nested-jar'

/** A non-fatal problem found while parsing a descriptor. */
export interface ParseWarning {
  /** Path inside the archive (nested jars are written as `outer.jar!/inner.json`). */
  file: string
  code: ParseWarningCode
  message: string
}

/**
 * Unified metadata for one mod file. The top-level fields come from the preferred loader
 * entry (see {@link preferredLoaderOrder}); `byLoader` holds every loader's own view, since
 * multi-loader jars (Architectury, Quilt + Fabric) carry several descriptors.
 */
export interface ModMetadata {
  /** Every loader whose descriptor parsed, in {@link preferredLoaderOrder} order. Empty for unknown jars. */
  loaders: ModLoader[]
  byLoader: Partial<Record<ModLoader, LoaderModMetadata>>
  /** Loader of the entry the top-level fields were taken from. */
  primaryLoader?: ModLoader
  id?: string
  name?: string
  version?: string
  description?: string
  authors: string[]
  license?: string
  icon?: string
  links: ModLinks
  environment: ModSide
  dependencies: ModDependency[]
  provides: Record<string, string>
  minecraftRange?: string
  loaderRange?: string
  /** `Implementation-Version` from `META-INF/MANIFEST.MF`, if present. */
  implementationVersion?: string
  warnings: ParseWarning[]
}

/** Instance loader used to choose the preferred metadata. `vanilla` means none. */
export type InstanceLoader = ModLoader | 'vanilla'

const ORDERS: Record<InstanceLoader, readonly ModLoader[]> = {
  fabric: ['fabric', 'quilt', 'forge', 'neoforge', 'liteloader'],
  quilt: ['quilt', 'fabric', 'forge', 'neoforge', 'liteloader'],
  forge: ['forge', 'neoforge', 'fabric', 'quilt', 'liteloader'],
  neoforge: ['neoforge', 'forge', 'fabric', 'quilt', 'liteloader'],
  liteloader: ['liteloader', 'forge', 'fabric', 'quilt', 'neoforge'],
  vanilla: ['forge', 'fabric', 'quilt', 'neoforge', 'liteloader'],
}

/** Order in which loader metadata is preferred for an instance running `loader` (spec §7.10). */
export function preferredLoaderOrder(loader: InstanceLoader = 'vanilla'): readonly ModLoader[] {
  return ORDERS[loader]
}
