import { getDefaultHttpClient, type HttpClient } from '@amethyst/net'
import { JavaError } from './errors'

/** Base of Azul's public metadata API. */
export const AZUL_API = 'https://api.azul.com/metadata/v1/zulu/packages'

export type ZuluPackageType = 'jre' | 'jdk'

/** One item of the package list (`GET /zulu/packages/?...`). */
export interface ZuluPackageSummary {
  packageUuid: string
  name: string
  downloadUrl: string
  /** e.g. `[8, 0, 512]`. */
  javaVersion: number[]
  /** e.g. `[8, 98, 0, 107]`. */
  distroVersion: number[]
  latest: boolean
}

/** Package details (`GET /zulu/packages/<uuid>`), with the sha256 needed to verify the archive. */
export interface ZuluPackage extends ZuluPackageSummary {
  sha256: string
  /** Approximate archive size: Azul rounds it (observed to the nearest 100 bytes). Verify by sha256. */
  size: number
  packageType: ZuluPackageType
  archiveType: string
  os: string
  arch: string
  javafx: boolean
}

export interface ZuluQuery {
  major: number
  packageType?: ZuluPackageType
  /** Default `false`: Minecraft does not need JavaFX and those builds are about twice the size. */
  javafx?: boolean
}

/** The list query for a major: macOS, aarch64, tar.gz, GA, CA (free) builds, latest only. */
export function zuluListUrl(query: ZuluQuery, base = AZUL_API): string {
  const params = new URLSearchParams({
    java_version: String(query.major),
    os: 'macos',
    arch: 'aarch64',
    archive_type: 'tar.gz',
    java_package_type: query.packageType ?? 'jre',
    javafx_bundled: String(query.javafx ?? false),
    release_status: 'ga',
    availability_types: 'CA',
    latest: 'true',
    page_size: '100',
  })
  return `${base}/?${params}`
}

function numbers(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n >= 0) ? (v as number[]) : undefined
}

function isAzulUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'azul.com' || u.hostname.endsWith('.azul.com'))
  } catch {
    return false
  }
}

function parseSummary(item: unknown, allowAnyHost: boolean): ZuluPackageSummary | undefined {
  if (!item || typeof item !== 'object') return undefined
  const o = item as Record<string, unknown>
  const javaVersion = numbers(o.java_version)
  const distroVersion = numbers(o.distro_version) ?? []
  if (typeof o.package_uuid !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(o.package_uuid)) return undefined
  if (typeof o.name !== 'string' || typeof o.download_url !== 'string' || !javaVersion) return undefined
  if (!allowAnyHost && !isAzulUrl(o.download_url)) return undefined
  return { packageUuid: o.package_uuid, name: o.name, downloadUrl: o.download_url, javaVersion, distroVersion, latest: o.latest === true }
}

/** Validate a package list response. Malformed items are dropped. */
export function parseZuluPackages(json: unknown, options: { allowAnyHost?: boolean } = {}): ZuluPackageSummary[] {
  if (!Array.isArray(json)) throw new JavaError('EBADMANIFEST', 'Azul package list is not an array')
  return json.map((item) => parseSummary(item, options.allowAnyHost ?? false)).filter((p): p is ZuluPackageSummary => p !== undefined)
}

function compareNums(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Pick the package to install for a major. Several items can carry `latest: true`, so the
 * candidates (right major, a `.tar.gz` for `macosx_aarch64`) are sorted by `java_version`, then
 * `distro_version`, descending, and the first is taken.
 */
export function chooseZuluPackage(packages: readonly ZuluPackageSummary[], major: number): ZuluPackageSummary | undefined {
  const fit = packages.filter((p) => p.javaVersion[0] === major && p.name.endsWith('.tar.gz') && /macosx?_aarch64/.test(p.name))
  return fit.toSorted((a, b) => compareNums(b.javaVersion, a.javaVersion) || compareNums(b.distroVersion, a.distroVersion))[0]
}

/** Validate package details. A missing or malformed sha256 is an error: the install must not proceed. */
export function parseZuluPackage(json: unknown, options: { allowAnyHost?: boolean } = {}): ZuluPackage {
  const summary = parseSummary(json, options.allowAnyHost ?? false)
  if (!summary) throw new JavaError('EBADMANIFEST', 'Azul package details are malformed')
  const o = json as Record<string, unknown>
  if (typeof o.sha256_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(o.sha256_hash)) throw new JavaError('EBADMANIFEST', `Azul package ${summary.name} has no sha256`)
  if (typeof o.size !== 'number' || !Number.isSafeInteger(o.size) || o.size <= 0) throw new JavaError('EBADMANIFEST', `Azul package ${summary.name} has no size`)
  const pkg: ZuluPackage = {
    ...summary,
    sha256: o.sha256_hash.toLowerCase(),
    size: o.size,
    packageType: o.java_package_type === 'jdk' ? 'jdk' : 'jre',
    archiveType: typeof o.archive_type === 'string' ? o.archive_type : '',
    os: typeof o.os === 'string' ? o.os : '',
    arch: typeof o.arch === 'string' ? o.arch : '',
    javafx: o.javafx_bundled === true,
  }
  if (pkg.os && pkg.os !== 'macos') throw new JavaError('EBADMANIFEST', `Azul package ${pkg.name} is for ${pkg.os}`)
  if (pkg.arch && pkg.arch !== 'arm' && pkg.arch !== 'aarch64') throw new JavaError('EBADMANIFEST', `Azul package ${pkg.name} is for ${pkg.arch}`)
  if (pkg.archiveType && pkg.archiveType !== 'tar.gz') throw new JavaError('EBADMANIFEST', `Azul package ${pkg.name} is a ${pkg.archiveType}`)
  return pkg
}

export interface ZuluFetchOptions {
  client?: HttpClient
  signal?: AbortSignal
  /** API base (tests). Non-Azul download hosts are accepted only when this is overridden. */
  apiBase?: string
  /** Try a JDK when no JRE exists for the major (default `true`). */
  allowJdk?: boolean
  javafx?: boolean
}

/**
 * Find the newest GA Zulu build for `major` on macOS aarch64 and fetch its details (sha256,
 * size). Prefers a JRE and falls back to a JDK. Throws `ENORUNTIME` when Azul has neither.
 */
export async function findZuluPackage(major: number, options: ZuluFetchOptions = {}): Promise<ZuluPackage> {
  const client = options.client ?? getDefaultHttpClient()
  const base = options.apiBase ?? AZUL_API
  const allowAnyHost = options.apiBase !== undefined
  const types: ZuluPackageType[] = options.allowJdk === false ? ['jre'] : ['jre', 'jdk']
  for (const packageType of types) {
    // oxlint-disable-next-line no-await-in-loop -- the JDK query only runs when no JRE exists
    const list = await client.json(zuluListUrl({ major, packageType, javafx: options.javafx }, base), {
      signal: options.signal,
      parse: (v) => parseZuluPackages(v, { allowAnyHost }),
    })
    const choice = chooseZuluPackage(list, major)
    if (!choice) continue
    // oxlint-disable-next-line no-await-in-loop
    return client.json(`${base}/${encodeURIComponent(choice.packageUuid)}`, { signal: options.signal, parse: (v) => parseZuluPackage(v, { allowAnyHost }) })
  }
  throw new JavaError('ENORUNTIME', `Azul publishes no Zulu ${major} build for macOS aarch64`)
}
