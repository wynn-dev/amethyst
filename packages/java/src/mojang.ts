import { getDefaultHttpClient, type HttpClient } from '@amethyst/net'
import { JavaError } from './errors'
import { KNOWN_COMPONENTS } from './requirement'
import { checkLinkTarget, safeSegments } from './tar'
import { parseJavaVersion } from './version'

/** Mojang's Java runtime index (all platforms, all components). */
export const MOJANG_RUNTIME_INDEX_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'

/** The index key for Apple Silicon. Always used, even if the launcher itself runs under Rosetta. */
export const MAC_ARM64_PLATFORM = 'mac-os-arm64'

/** A download reference with its hash and size. */
export interface MojangDownload {
  sha1: string
  size: number
  url: string
}

/** One runtime offered by the index for a `(platform, component)`. */
export interface RuntimeIndexEntry {
  platform: string
  component: string
  /** Version name, e.g. `21.0.7`, `8u74-cacert462b08`. */
  version: string
  /** Major parsed from `version`, falling back to the known component table. 0 if unknown. */
  majorVersion: number
  released?: string
  manifest: MojangDownload
}

/** `platform -> component -> entries` (Mojang publishes zero or one entry per pair). */
export type RuntimeIndex = Record<string, Record<string, RuntimeIndexEntry[]>>

const SHA1 = /^[0-9a-f]{40}$/i

function bad(message: string): never {
  throw new JavaError('EBADMANIFEST', message)
}

/** `https:` only; plain `http:` is accepted for loopback hosts (local mirrors and tests). */
function isSecureUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
}

function parseDownload(v: unknown, where: string): MojangDownload {
  if (!v || typeof v !== 'object') bad(`${where}: missing download`)
  const o = v as Record<string, unknown>
  if (typeof o.sha1 !== 'string' || !SHA1.test(o.sha1)) bad(`${where}: invalid sha1`)
  if (typeof o.size !== 'number' || !Number.isSafeInteger(o.size) || o.size < 0) bad(`${where}: invalid size`)
  if (typeof o.url !== 'string' || !isSecureUrl(o.url)) bad(`${where}: invalid url (https required)`)
  return { sha1: o.sha1.toLowerCase(), size: o.size, url: o.url }
}

/** Validate the `all.json` runtime index. Malformed entries are dropped; a malformed root throws. */
export function parseRuntimeIndex(json: unknown): RuntimeIndex {
  if (!json || typeof json !== 'object' || Array.isArray(json)) bad('runtime index is not an object')
  const out: RuntimeIndex = {}
  for (const [platform, components] of Object.entries(json as Record<string, unknown>)) {
    if (!components || typeof components !== 'object' || Array.isArray(components)) continue
    const byComponent: Record<string, RuntimeIndexEntry[]> = {}
    for (const [component, list] of Object.entries(components as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const entries: RuntimeIndexEntry[] = []
      for (const item of list) {
        try {
          const o = item as Record<string, unknown>
          const manifest = parseDownload(o.manifest, `${platform}/${component}`)
          const versionObj = (o.version ?? {}) as Record<string, unknown>
          const version = typeof versionObj.name === 'string' ? versionObj.name : ''
          const entry: RuntimeIndexEntry = {
            platform,
            component,
            version,
            majorVersion: parseJavaVersion(version)?.majorVersion ?? KNOWN_COMPONENTS[component] ?? 0,
            manifest,
          }
          if (typeof versionObj.released === 'string') entry.released = versionObj.released
          entries.push(entry)
        } catch {
          // Skip malformed entries; the rest of the index is still usable.
        }
      }
      byComponent[component] = entries
    }
    out[platform] = byComponent
  }
  if (!out[MAC_ARM64_PLATFORM]) bad(`runtime index has no ${MAC_ARM64_PLATFORM} platform`)
  return out
}

export interface FetchIndexOptions {
  client?: HttpClient
  signal?: AbortSignal
  url?: string
}

/** Download and validate the runtime index. */
export async function fetchRuntimeIndex(options: FetchIndexOptions = {}): Promise<RuntimeIndex> {
  const client = options.client ?? getDefaultHttpClient()
  return client.json(options.url ?? MOJANG_RUNTIME_INDEX_URL, { signal: options.signal, parse: parseRuntimeIndex, maxBytes: 4 * 1024 * 1024 })
}

/** The runtime for a component on a platform (default `mac-os-arm64`), if Mojang ships one. */
export function runtimeFor(index: RuntimeIndex, component: string, platform = MAC_ARM64_PLATFORM): RuntimeIndexEntry | undefined {
  return index[platform]?.[component]?.[0]
}

/** One entry of a component manifest. */
export type RuntimeManifestEntry =
  | { type: 'directory' }
  | { type: 'link'; target: string }
  | { type: 'file'; executable: boolean; raw: MojangDownload; lzma?: MojangDownload }

/** A component manifest: relative path -> entry. */
export interface RuntimeManifest {
  files: Record<string, RuntimeManifestEntry>
}

/** Validate a component manifest (`{ files: { <path>: entry } }`). Unsafe paths throw. */
export function parseRuntimeManifest(json: unknown): RuntimeManifest {
  if (!json || typeof json !== 'object') bad('runtime manifest is not an object')
  const files = (json as Record<string, unknown>).files
  if (!files || typeof files !== 'object' || Array.isArray(files)) bad('runtime manifest has no files')
  const out: Record<string, RuntimeManifestEntry> = {}
  for (const [rawPath, v] of Object.entries(files as Record<string, unknown>)) {
    const path = safeSegments(rawPath).join('/')
    if (!path) bad(`empty path in runtime manifest`)
    const o = (v ?? {}) as Record<string, unknown>
    if (o.type === 'directory') out[path] = { type: 'directory' }
    else if (o.type === 'link') {
      if (typeof o.target !== 'string') bad(`${path}: link without target`)
      out[path] = { type: 'link', target: o.target }
    } else if (o.type === 'file') {
      const downloads = (o.downloads ?? {}) as Record<string, unknown>
      const entry: RuntimeManifestEntry = { type: 'file', executable: o.executable === true, raw: parseDownload(downloads.raw, path) }
      if (downloads.lzma) {
        try {
          entry.lzma = parseDownload(downloads.lzma, `${path} (lzma)`)
        } catch {
          // A broken lzma variant just means downloading raw.
        }
      }
      out[path] = entry
    } else bad(`${path}: unknown entry type ${String(o.type)}`)
  }
  return { files: out }
}

/** A file to place, with both variants when offered. */
export interface PlannedFile {
  path: string
  executable: boolean
  raw: MojangDownload
  lzma?: MojangDownload
}

export interface PlannedLink {
  path: string
  target: string
}

/** What installing a manifest involves, in the order it should be applied. */
export interface RuntimePlan {
  /** Parents first. Includes the parents of files that the manifest did not list. */
  directories: string[]
  files: PlannedFile[]
  links: PlannedLink[]
  /** Sum of decompressed sizes. */
  rawBytes: number
  /** Bytes to download when lzma is used wherever offered. */
  downloadBytes: number
  /** The `bin/java` path inside the plan, if present. */
  javaPath?: string
}

/**
 * Turn a manifest into an install plan. Every link target is checked to stay inside the runtime
 * (relative, `..` only as leading segments). Executable files are flagged so the layout step can
 * set `0755` (this must include `lib/jspawnhelper`).
 */
export function planRuntime(manifest: RuntimeManifest): RuntimePlan {
  const dirs = new Set<string>()
  const addParents = (p: string) => {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const files: PlannedFile[] = []
  const links: PlannedLink[] = []
  let rawBytes = 0
  let downloadBytes = 0
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.type === 'directory') {
      addParents(path)
      dirs.add(path)
    } else if (entry.type === 'file') {
      addParents(path)
      files.push({ path, executable: entry.executable, raw: entry.raw, ...(entry.lzma ? { lzma: entry.lzma } : {}) })
      rawBytes += entry.raw.size
      downloadBytes += entry.lzma ? entry.lzma.size : entry.raw.size
    } else {
      addParents(path)
      const depth = path.split('/').length - 1
      checkLinkTarget(entry.target, depth, path)
      links.push({ path, target: entry.target })
    }
  }
  for (const f of files) if (dirs.has(f.path)) bad(`${f.path} is both a file and a directory`)
  const directories = [...dirs].toSorted((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const java = files.find((f) => /(^|\/)Contents\/Home\/bin\/java$/.test(f.path)) ?? files.find((f) => /(^|\/)bin\/java$/.test(f.path))
  return { directories, files, links, rawBytes, downloadBytes, ...(java ? { javaPath: java.path } : {}) }
}
