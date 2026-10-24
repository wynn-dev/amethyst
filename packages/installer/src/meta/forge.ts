/**
 * Forge version metadata from the official maven: `maven-metadata.xml` lists every published
 * artifact version, `promotions_slim.json` marks the latest/recommended builds, and the per-version
 * `meta.json` lists which classifiers exist (used to choose the install format).
 */
import { InstallError } from '../errors'

/** A Forge build as published on the maven. */
export interface ForgeVersion {
  /** Minecraft version id, e.g. `1.20.1` or `1.7.10-pre4`. */
  minecraft: string
  /** The Forge build, e.g. `47.3.0`. */
  version: string
  /**
   * The exact maven version string, e.g. `1.7.10-10.13.4.1614-1.7.10`. Always taken from
   * `maven-metadata.xml`, never guessed.
   */
  artifactVersion: string
  latest: boolean
  recommended: boolean
}

/** Forge `meta.json`: classifier → extension → md5. */
export interface ForgeFiles {
  classifiers: Record<string, Record<string, string>>
}

/** How a Forge build is installed. */
export type ForgeInstallKind =
  /** `installer.jar` exists: legacy (`versionInfo`) or modern (`version.json` + processors), decided by reading it. */
  | 'installer'
  /** Only a `universal`/`client` zip exists (Minecraft 1.1–1.5.1): merged into the vanilla jar. */
  | 'universal'

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Parse a maven `maven-metadata.xml` and return its `<version>` list in document order.
 *
 * @throws {InstallError} `EINSTALL_BAD_METADATA` when there is no `<versioning>` block or no versions.
 */
export function parseMavenMetadata(xml: string): string[] {
  const versioning = /<versioning>([\s\S]*?)<\/versioning>/.exec(xml)
  if (!versioning?.[1]) throw new InstallError('EINSTALL_BAD_METADATA', 'maven-metadata.xml has no <versioning> block')
  const versions = [...versioning[1].matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map((m) =>
    (m[1] as string).replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e] ?? ''),
  )
  if (versions.length === 0) throw new InstallError('EINSTALL_BAD_METADATA', 'maven-metadata.xml lists no versions')
  return versions
}

/**
 * Split a Forge maven version into Minecraft version, Forge build and optional suffix:
 * `1.20.1-47.3.0`, `1.7.10-10.13.4.1614-1.7.10`, `1.10-12.18.0.2000-1.10.0`,
 * `1.7.10_pre4-10.12.2.1149-prerelease`, `26.3-66.1.0`.
 * Returns `undefined` for strings that do not have this shape.
 */
export function parseForgeArtifactVersion(artifactVersion: string): { minecraft: string; version: string; suffix?: string } | undefined {
  const m = /^(\d+(?:\.\d+)*(?:_pre\d*)?)-(\d+(?:\.\d+)+)(?:-(.+))?$/.exec(artifactVersion)
  if (!m) return undefined
  const minecraft = (m[1] as string).replace('_pre', '-pre')
  return m[3] ? { minecraft, version: m[2] as string, suffix: m[3] } : { minecraft, version: m[2] as string }
}

/** Validate `promotions_slim.json` and return its `promos` map (`<mc>-latest` → build). */
export function parseForgePromotions(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || typeof (value as { promos?: unknown }).promos !== 'object') {
    throw new InstallError('EINSTALL_BAD_METADATA', 'promotions_slim.json has no promos')
  }
  const promos: Record<string, string> = {}
  for (const [k, v] of Object.entries((value as { promos: Record<string, unknown> }).promos)) {
    if (typeof v === 'string') promos[k] = v
  }
  return promos
}

/** Validate a Forge `meta.json`. */
export function parseForgeFiles(value: unknown): ForgeFiles {
  const classifiers = (value as { classifiers?: unknown } | null)?.classifiers
  if (typeof classifiers !== 'object' || classifiers === null) throw new InstallError('EINSTALL_BAD_METADATA', 'Forge meta.json has no classifiers')
  const out: ForgeFiles = { classifiers: {} }
  for (const [name, exts] of Object.entries(classifiers)) {
    if (typeof exts !== 'object' || exts === null) continue
    const entry: Record<string, string> = {}
    for (const [ext, md5] of Object.entries(exts)) if (typeof md5 === 'string') entry[ext] = md5
    out.classifiers[name] = entry
  }
  return out
}

function compareBuild(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Combine the maven version list and promotions into {@link ForgeVersion}s, newest build first.
 * When `minecraft` is given only builds for exactly that Minecraft version are returned.
 */
export function forgeVersionsFrom(artifactVersions: readonly string[], promos: Record<string, string>, minecraft?: string): ForgeVersion[] {
  const out: ForgeVersion[] = []
  for (const artifactVersion of artifactVersions) {
    const parsed = parseForgeArtifactVersion(artifactVersion)
    if (!parsed || (minecraft !== undefined && parsed.minecraft !== minecraft)) continue
    out.push({
      minecraft: parsed.minecraft,
      version: parsed.version,
      artifactVersion,
      latest: promos[`${parsed.minecraft}-latest`] === parsed.version,
      recommended: promos[`${parsed.minecraft}-recommended`] === parsed.version,
    })
  }
  return out.toSorted((a, b) => compareBuild(b.version, a.version))
}

/**
 * Choose the install path from `meta.json`: `installer` when an installer jar is published,
 * `universal` when only a universal (or, for 1.1–1.2.x, client) zip exists.
 *
 * @throws {InstallError} `EINSTALL_UNSUPPORTED` when neither exists.
 */
export function forgeInstallKind(files: ForgeFiles): { kind: ForgeInstallKind; classifier: string; extension: string; md5?: string } {
  const installer = files.classifiers.installer
  if (installer?.jar) return { kind: 'installer', classifier: 'installer', extension: 'jar', md5: installer.jar }
  for (const classifier of ['universal', 'client']) {
    const exts = files.classifiers[classifier]
    const extension = exts?.zip ? 'zip' : exts?.jar ? 'jar' : undefined
    if (exts && extension) return { kind: 'universal', classifier, extension, md5: exts[extension] }
  }
  throw new InstallError('EINSTALL_UNSUPPORTED', 'this Forge build publishes neither an installer nor a universal archive')
}
