/* oxlint-disable no-await-in-loop -- files are hashed and queued one at a time */
/**
 * Exporting an instance as a Modrinth `.mrpack` or a CurseForge modpack zip (`modpacks.md` §8).
 *
 * The caller passes the user's include list (files or folders). Launcher-owned folders and
 * anything that looks like credentials are never exported; a default exclude list keeps private
 * data (logs, crash reports, screenshots, the server list) out unless the caller overrides it,
 * and `options.txt` is written without keys such as `lastServer`.
 *
 * Mods, resource packs and shader packs that the platform knows (by SHA-1 through
 * `POST /v2/version_files`, or by murmur2 fingerprint through `POST /v1/fingerprints/432`)
 * become download entries; every other file is embedded in the overrides. The archive is
 * streamed to disk entry by entry; files are never buffered whole.
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { curseforgeFingerprint, type CurseForgeClient } from '@amethyst/marketplace'
import type { TaskContext } from '@amethyst/task'
import { createZip } from '@amethyst/zip'
import { isAbortError, ModpackError, throwIfAborted } from './errors'
import { curseForgeLoaderId, MODRINTH_LOADER_KEYS } from './loader'
import { readModpackLock, type ModpackLock, type ModpackLockFile } from './lock'
import { pathKey } from './paths'
import { MODRINTH_ALLOWED_HOSTS } from './read'
import type { ModrinthLookup } from './resolve'
import type { EnvSupport, FileEnv, ModpackLoader } from './types'
import { hashLocal, listFiles, lstatOrUndefined } from './util'

/** Paths that are never exported, whatever the include list says. */
export const NEVER_EXPORT: readonly string[] = [
  '.amethyst/',
  'versions/',
  'libraries/',
  'assets/',
  'natives/',
  'runtimes/',
  'usercache.json',
  'usernamecache.json',
]

/** Excluded by default because they hold private data; pass `exclude` to change. */
export const DEFAULT_EXPORT_EXCLUDES: readonly string[] = ['logs/', 'crash-reports/', 'screenshots/', 'servers.dat', 'servers.dat_old']

/** `options.txt` keys removed on export by default. */
export const DEFAULT_STRIPPED_OPTIONS: readonly string[] = ['lastServer']

/** Base names that look like credentials or keys. */
const SECRET_NAME = /(\.pem|\.key|\.p12|\.pfx|\.jks|\.keystore)$|token|secret|^accounts.*\.json$|^launcher_.*\.json$|^\.ds_store$/i

/** Folders whose files may be linked to a platform instead of embedded. */
const LINKABLE = new Set(['mods', 'resourcepacks', 'shaderpacks'])

/** CurseForge hosts that must never appear in a `.mrpack` (pitfall 7). */
const CURSEFORGE_HOST = /(^|\.)(forgecdn\.net|curseforge\.com)$/i

/** Options shared by both exporters. */
export interface ExportOptions {
  /** Output archive path (`<name>-<version>.mrpack` / `.zip`). An existing file is replaced. */
  output: string
  name: string
  version: string
  author?: string
  /** Modrinth `summary`. */
  summary?: string
  minecraft: string
  loader: ModpackLoader | null
  /** Paths relative to the instance (files, or folders with or without a trailing `/`). */
  include: readonly string[]
  /** Prefix (`dir/`) or exact-path excludes. Default {@link DEFAULT_EXPORT_EXCLUDES}. */
  exclude?: readonly string[]
  /** Paths to embed even when a download link exists. */
  embed?: readonly string[]
  /** Per-path environment; default required/required. */
  env?: Readonly<Record<string, Partial<FileEnv>>>
  /** `options.txt` keys to drop. Default {@link DEFAULT_STRIPPED_OPTIONS}. */
  stripOptions?: readonly string[]
  signal?: AbortSignal
  ctx?: TaskContext
}

/** Options for {@link exportModrinth}. */
export interface ExportModrinthOptions extends ExportOptions {
  /** For `version_files` lookups; without it, only files whose lock entry has a Modrinth URL are linked. */
  modrinth?: ModrinthLookup
  /** Only Modrinth-allowlisted hosts in `downloads` (default true). */
  strict?: boolean
}

/** Options for {@link exportCurseForge}. */
export interface ExportCurseForgeOptions extends ExportOptions {
  curseforge?: Pick<CurseForgeClient, 'matchFingerprints'>
}

/** Why a file was embedded rather than linked. */
export type EmbedReason = 'not-linkable' | 'forced' | 'no-match' | 'disallowed-host' | 'lookup-failed'

/** Result of an export. */
export interface ExportResult {
  path: string
  /** Files written as download entries. */
  linked: string[]
  /** Files embedded in the overrides, with the reason. */
  embedded: { path: string; reason: EmbedReason; size: number }[]
  /** Selected files that were left out by the exclude rules. */
  excluded: string[]
  warnings: string[]
}

interface Candidate {
  path: string
  abs: string
  size: number
  env: FileEnv
  linkable: boolean
}

function normaliseRel(raw: string): string {
  const rel = raw.replaceAll('\\', '/').replace(/^\.\/+/, '')
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.')
  if (rel.startsWith('/') || segments.includes('..') || rel.includes('\0')) {
    throw new ModpackError('EINVALID_ARGUMENT', `Export paths must be relative to the instance: ${JSON.stringify(raw)}`)
  }
  return segments.join('/')
}

function matchesRule(rel: string, rules: readonly string[]): boolean {
  const key = pathKey(rel)
  return rules.some((r) => {
    const rule = pathKey(r)
    return rule.endsWith('/') ? key.startsWith(rule) || `${key}/` === rule : key === rule
  })
}

/** True when `rel` may never be exported (launcher folders, credentials). */
export function isNeverExported(rel: string): boolean {
  if (matchesRule(rel, NEVER_EXPORT)) return true
  return rel.split('/').some((s) => SECRET_NAME.test(s))
}

async function collect(instanceDir: string, options: ExportOptions): Promise<{ files: Candidate[]; excluded: string[] }> {
  const exclude = options.exclude ?? DEFAULT_EXPORT_EXCLUDES
  const seen = new Map<string, string>()
  const excluded: string[] = []
  for (const raw of options.include) {
    const rel = normaliseRel(raw)
    if (rel === '') continue
    const abs = path.join(instanceDir, ...rel.split('/'))
    const st = await lstatOrUndefined(abs)
    if (!st) continue
    const list = st.isDirectory() ? (await listFiles(abs, options.signal)).map((f) => `${rel}/${f}`) : st.isFile() ? [rel] : []
    for (const f of list) seen.set(pathKey(f), f)
  }
  const files: Candidate[] = []
  for (const rel of [...seen.values()].toSorted()) {
    if (isNeverExported(rel) || matchesRule(rel, exclude)) {
      excluded.push(rel)
      continue
    }
    const abs = path.join(instanceDir, ...rel.split('/'))
    const st = await stat(abs)
    const envOverride = Object.entries(options.env ?? {}).find(([p]) => pathKey(p) === pathKey(rel))?.[1]
    const env: FileEnv = { client: envOverride?.client ?? 'required', server: envOverride?.server ?? 'required' }
    const top = pathKey(rel.split('/')[0] ?? '')
    const linkable = rel.includes('/') && LINKABLE.has(top) && /\.(jar|zip)$/i.test(rel) && !matchesRule(rel, options.embed ?? [])
    files.push({ path: rel, abs, size: st.size, env, linkable })
  }
  return { files, excluded }
}

/** `options.txt` without the stripped keys. Line endings and every other line are kept as is. */
export function stripOptionsText(text: string, keys: readonly string[]): string {
  const drop = new Set(keys)
  return text
    .split(/(?<=\n)/)
    .filter((line) => {
      const colon = line.indexOf(':')
      return colon < 0 || !drop.has(line.slice(0, colon).trim())
    })
    .join('')
}

function lockByKey(lock: ModpackLock | undefined): Map<string, ModpackLockFile> {
  return new Map((lock?.files ?? []).map((f) => [pathKey(f.path), f]))
}

function isAllowedUrl(url: string, strict: boolean): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    if (strict) return MODRINTH_ALLOWED_HOSTS.includes(u.hostname)
    return !CURSEFORGE_HOST.test(u.hostname)
  } catch {
    return false
  }
}

function overrideFolder(env: FileEnv, format: 'modrinth' | 'curseforge'): string | null {
  if (env.client === 'unsupported') return format === 'modrinth' ? 'server-overrides' : null
  if (env.server === 'unsupported') return format === 'modrinth' ? 'client-overrides' : 'overrides'
  return 'overrides'
}

const STORED = /\.(jar|zip|png|jpe?g|ogg|gz|xz|mrpack)$/i

async function writeArchive(
  output: string,
  manifestName: string,
  manifest: unknown,
  embedded: { file: Candidate; folder: string }[],
  options: ExportOptions,
): Promise<void> {
  const signal = options.signal ?? options.ctx?.signal
  const zip = createZip(path.resolve(output), { signal })
  try {
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), manifestName)
    const strip = options.stripOptions ?? DEFAULT_STRIPPED_OPTIONS
    for (const { file, folder } of embedded) {
      throwIfAborted(signal)
      const zipPath = `${folder}/${file.path}`
      if (pathKey(file.path) === 'options.txt' && strip.length > 0) {
        zip.addBuffer(Buffer.from(stripOptionsText(await readFile(file.abs, 'utf8'), strip)), zipPath)
      } else {
        zip.addFile(file.abs, zipPath, { compress: !STORED.test(file.path) })
      }
    }
    await zip.finish()
  } catch (e) {
    await zip.abort()
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// Modrinth
// ---------------------------------------------------------------------------------------------

interface MrpackFile {
  path: string
  hashes: { sha1: string; sha512: string }
  env?: { client: EnvSupport; server: EnvSupport }
  downloads: string[]
  fileSize: number
}

/**
 * Export `instanceDir` as a `.mrpack`. Linkable files (under `mods/`, `resourcepacks/`,
 * `shaderpacks/`) are matched by SHA-1: first against the lock's recorded download URLs, then
 * through `version_files`. Matches become `files[]` entries with sha1 + sha512, `fileSize` and
 * `downloads`; everything else is embedded. Client-only files go to `client-overrides/`,
 * server-only ones to `server-overrides/`.
 */
export async function exportModrinth(instanceDir: string, options: ExportModrinthOptions): Promise<ExportResult> {
  const root = path.resolve(instanceDir)
  const signal = options.signal ?? options.ctx?.signal
  throwIfAborted(signal)
  const strict = options.strict ?? true
  const lock = lockByKey(await readModpackLock(root).catch(() => undefined))
  const { files, excluded } = await collect(root, options)
  const warnings: string[] = []
  const result: ExportResult = { path: path.resolve(options.output), linked: [], embedded: [], excluded, warnings }
  if (options.loader && !(options.loader.id in MODRINTH_LOADER_KEYS)) warnings.push(`Unknown loader ${options.loader.id}`)

  const total = files.length
  options.ctx?.update(0, total, 'Hashing files')
  const hashes = new Map<string, { sha1: string; sha512: string }>()
  const urls = new Map<string, string>()
  for (const f of files) {
    if (!f.linkable) continue
    const h = await hashLocal(f.abs, { sha512: true }, signal)
    hashes.set(f.path, { sha1: h.sha1, sha512: h.sha512 as string })
    const known = lock.get(pathKey(f.path))
    const url = known?.hashes.sha1 === h.sha1 ? known.downloads?.find((u) => isAllowedUrl(u, strict)) : undefined
    if (url) urls.set(f.path, url)
  }

  let lookupFailed = false
  const unknown = files.filter((f) => f.linkable && !urls.has(f.path))
  if (options.modrinth && unknown.length > 0) {
    try {
      const found = await options.modrinth.getVersionsFromHashes(unknown.map((f) => (hashes.get(f.path) as { sha1: string }).sha1), 'sha1', { signal })
      for (const f of unknown) {
        const sha1 = (hashes.get(f.path) as { sha1: string }).sha1
        const file = found[sha1]?.files.find((x) => x.hashes.sha1?.toLowerCase() === sha1)
        if (file && isAllowedUrl(file.url, strict)) urls.set(f.path, file.url)
      }
    } catch (e) {
      if (isAbortError(e)) throw e
      lookupFailed = true
      warnings.push('Modrinth could not be reached; unmatched files were embedded')
    }
  }

  const entries: MrpackFile[] = []
  const embedded: { file: Candidate; folder: string }[] = []
  for (const f of files) {
    const url = urls.get(f.path)
    const h = hashes.get(f.path)
    if (url && h) {
      const entry: MrpackFile = { path: f.path, hashes: h, downloads: [url], fileSize: f.size }
      if (f.env.client !== 'required' || f.env.server !== 'required') entry.env = f.env
      entries.push(entry)
      result.linked.push(f.path)
      continue
    }
    const folder = overrideFolder(f.env, 'modrinth') as string
    embedded.push({ file: f, folder })
    const reason: EmbedReason = !f.linkable ? (matchesRule(f.path, options.embed ?? []) ? 'forced' : 'not-linkable') : lookupFailed ? 'lookup-failed' : 'no-match'
    result.embedded.push({ path: f.path, reason, size: f.size })
    const origin = lock.get(pathKey(f.path))?.origin.kind
    if (f.linkable && (origin === 'curseforge' || origin === 'manual')) {
      warnings.push(`${f.path} comes from CurseForge; embedding CurseForge-only files in a Modrinth pack may violate the author's license or Modrinth's rules`)
    }
  }

  const dependencies: Record<string, string> = { minecraft: options.minecraft }
  if (options.loader) dependencies[MODRINTH_LOADER_KEYS[options.loader.id]] = options.loader.version
  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: options.version,
    name: options.name,
    ...(options.summary ? { summary: options.summary } : {}),
    files: entries,
    dependencies,
  }
  options.ctx?.update(0, total, 'Writing archive')
  await writeArchive(options.output, 'modrinth.index.json', manifest, embedded, options)
  options.ctx?.update(total, total)
  return result
}

// ---------------------------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------------------------

/**
 * Export `instanceDir` as a CurseForge modpack zip. Linkable files are matched by the lock's
 * CurseForge ids (same SHA-1), then by exact murmur2 fingerprint through
 * `POST /v1/fingerprints/432`; matches become `files[]` entries, everything else goes into
 * `overrides/`. Server-only files are left out of the client pack. Quilt is written as
 * `quilt-<v>` with a warning, since CurseForge does not support it for modpacks.
 */
export async function exportCurseForge(instanceDir: string, options: ExportCurseForgeOptions): Promise<ExportResult> {
  const root = path.resolve(instanceDir)
  const signal = options.signal ?? options.ctx?.signal
  throwIfAborted(signal)
  const lock = lockByKey(await readModpackLock(root).catch(() => undefined))
  const { files, excluded } = await collect(root, options)
  const warnings: string[] = []
  const result: ExportResult = { path: path.resolve(options.output), linked: [], embedded: [], excluded, warnings }
  if (options.loader?.id === 'quilt') warnings.push('CurseForge does not support Quilt modpacks; the manifest still names quilt')

  const ids = new Map<string, { projectID: number; fileID: number }>()
  const fingerprints = new Map<string, number>()
  for (const f of files) {
    if (!f.linkable || f.env.client === 'unsupported') continue
    const known = lock.get(pathKey(f.path))
    if (known && (known.origin.kind === 'curseforge' || known.origin.kind === 'manual')) {
      const { sha1 } = await hashLocal(f.abs, {}, signal)
      if (known.hashes.sha1 === sha1) {
        ids.set(f.path, { projectID: known.origin.projectId, fileID: known.origin.fileId })
        continue
      }
    }
    fingerprints.set(f.path, await curseforgeFingerprint(() => createReadStream(f.abs, { highWaterMark: 256 * 1024 }), signal))
  }

  let lookupFailed = false
  if (options.curseforge && fingerprints.size > 0) {
    try {
      const res = await options.curseforge.matchFingerprints([...fingerprints.values()], { signal })
      const byFp = new Map<number, { projectID: number; fileID: number }>()
      for (const m of res.exactMatches) byFp.set(m.file.fileFingerprint, { projectID: m.file.modId, fileID: m.file.id })
      for (const [p, fp] of fingerprints) {
        const hit = byFp.get(fp)
        if (hit) ids.set(p, hit)
      }
    } catch (e) {
      if (isAbortError(e)) throw e
      lookupFailed = true
      warnings.push('CurseForge could not be reached; unmatched files were embedded')
    }
  }

  const entries: { projectID: number; fileID: number; required: boolean }[] = []
  const embedded: { file: Candidate; folder: string }[] = []
  let serverOnly = 0
  for (const f of files) {
    const hit = ids.get(f.path)
    if (hit) {
      entries.push({ ...hit, required: true })
      result.linked.push(f.path)
      continue
    }
    const folder = overrideFolder(f.env, 'curseforge')
    if (folder === null) {
      serverOnly++
      continue
    }
    embedded.push({ file: f, folder })
    const reason: EmbedReason = !f.linkable ? (matchesRule(f.path, options.embed ?? []) ? 'forced' : 'not-linkable') : lookupFailed ? 'lookup-failed' : 'no-match'
    result.embedded.push({ path: f.path, reason, size: f.size })
  }
  if (serverOnly > 0) warnings.push(`${serverOnly} server-only file${serverOnly === 1 ? ' was' : 's were'} left out of the client pack`)

  const manifest = {
    minecraft: {
      version: options.minecraft,
      modLoaders: options.loader ? [{ id: curseForgeLoaderId(options.loader), primary: true }] : [],
    },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: options.name,
    version: options.version,
    author: options.author ?? '',
    files: entries,
    overrides: 'overrides',
  }
  await writeArchive(options.output, 'manifest.json', manifest, embedded, options)
  return result
}
