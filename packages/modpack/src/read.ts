/**
 * Opening a pack (`modpacks.md` §2, §3): detect the format, validate the manifest and list the
 * override files. Opening has no side effects; nothing is extracted.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { hashFile } from '@amethyst/content'
import { openZip, type ZipEntryInfo, type ZipReader } from '@amethyst/zip'
import { isAbortError, ModpackError, throwIfAborted } from './errors'
import { loaderFromModrinthKey, normaliseLoaderVersion, parseCurseForgeLoaderId } from './loader'
import { checkPackPath, isJunkEntry, pathKey } from './paths'
import type {
  CurseForgePackFile,
  EnvSupport,
  ModpackFileEntry,
  ModpackLoader,
  ModpackManifest,
  ModpackWarning,
  ModrinthPackFile,
  OverrideEntry,
  OverrideLayer,
} from './types'

/** Download hosts Modrinth allows in packs it hosts (mrpack format documentation). */
export const MODRINTH_ALLOWED_HOSTS: readonly string[] = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']

/** Options for {@link readModpack}. */
export interface ReadModpackOptions {
  signal?: AbortSignal
}

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024

/**
 * Open a `.mrpack` or CurseForge modpack zip and return its normalised manifest.
 *
 * Detection order: `modrinth.index.json` at the root, then under exactly one top-level folder,
 * then a root `manifest.json` with `manifestType: "minecraftModpack"`. A leading UTF-8 BOM is
 * ignored. Files and override entries with unsafe paths (absolute, `..`, NUL, backslash, or
 * under a launcher-owned folder) are dropped with a warning instead of failing the whole pack.
 *
 * @throws {ModpackError} `ENOT_A_FILE`, `ENOT_A_ZIP`, `EUNKNOWN_FORMAT`, `EINVALID_MANIFEST`
 * (with `field`) or `EUNSUPPORTED_FORMAT`.
 */
export async function readModpack(file: string, options: ReadModpackOptions = {}): Promise<ModpackManifest> {
  const { signal } = options
  throwIfAborted(signal)
  const archive = path.resolve(file)
  const st = await stat(archive).catch(() => undefined)
  if (!st?.isFile()) throw new ModpackError('ENOT_A_FILE', `Not a file: ${archive}`)

  let zip: ZipReader
  let entries: readonly ZipEntryInfo[]
  try {
    zip = await openZip(archive)
  } catch (e) {
    throw notAZip(archive, e)
  }
  try {
    try {
      entries = await zip.entries()
    } catch (e) {
      throw notAZip(archive, e)
    }
    const names = new Set(entries.map((e) => e.name))
    const warnings: ModpackWarning[] = []
    let partial: Omit<ModpackManifest, 'archive' | 'sha1'>

    const prefix = names.has('modrinth.index.json') ? '' : nestedModrinthPrefix(entries)
    if (prefix !== undefined) {
      const json = await readJson(zip, `${prefix}modrinth.index.json`, signal)
      partial = parseModrinth(json, prefix, entries, warnings)
    } else if (names.has('manifest.json')) {
      const json = await readJson(zip, 'manifest.json', signal)
      if (!isRecord(json) || json.manifestType !== 'minecraftModpack') {
        throw new ModpackError('EUNKNOWN_FORMAT', 'manifest.json is not a CurseForge modpack manifest (manifestType is not "minecraftModpack")')
      }
      partial = parseCurseForge(json, entries, warnings)
    } else {
      throw new ModpackError('EUNKNOWN_FORMAT', 'The archive contains neither modrinth.index.json nor a CurseForge manifest.json')
    }

    if (!partial.name) {
      partial.name = deriveName(path.basename(archive))
      warnings.push({ code: 'derived-name', message: `The pack has no name; using "${partial.name}" from the file name`, subject: partial.name })
    }
    const { sha1 } = await hashFile(archive, ['sha1'], { signal })
    return { ...partial, archive, sha1 }
  } finally {
    await zip.close()
  }
}

function notAZip(archive: string, e: unknown): unknown {
  if (isAbortError(e)) return e
  const code = (e as { code?: string }).code
  if (code === 'EZIP_MALFORMED') return new ModpackError('ENOT_A_ZIP', `This file isn't a modpack archive: ${path.basename(archive)}`, { cause: e })
  return e
}

/** The single top-level folder holding `modrinth.index.json`, if the zip is laid out that way. */
function nestedModrinthPrefix(entries: readonly ZipEntryInfo[]): string | undefined {
  const tops = new Set<string>()
  for (const e of entries) {
    if (isJunkEntry(e.name)) continue
    const slash = e.name.indexOf('/')
    tops.add(slash < 0 ? e.name : e.name.slice(0, slash + 1))
  }
  if (tops.size !== 1) return undefined
  const [top] = tops as Set<string>
  if (!top?.endsWith('/')) return undefined
  return entries.some((e) => e.name === `${top}modrinth.index.json`) ? top : undefined
}

async function readJson(zip: ZipReader, name: string, signal?: AbortSignal): Promise<unknown> {
  let text: string
  try {
    text = await zip.readText(name, { maxBytes: MAX_MANIFEST_BYTES, signal })
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new ModpackError('EINVALID_MANIFEST', `Cannot read ${name}: ${(e as Error).message}`, { field: name, cause: e })
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown
  } catch (e) {
    throw new ModpackError('EINVALID_MANIFEST', `${name} is not valid JSON`, { field: name, cause: e })
  }
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(field: string, what: string, label: string): ModpackError {
  return new ModpackError('EINVALID_MANIFEST', `${label} ${what}: \`${field}\``, { field })
}

function str(o: Record<string, unknown>, key: string, field: string, label: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw invalid(field, v === undefined ? 'is missing' : 'must be a string', label)
  return v
}

function optStr(o: Record<string, unknown>, key: string, field: string, label: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw invalid(field, 'must be a string', label)
  return v
}

const HEX40 = /^[0-9a-f]{40}$/i
const HEX128 = /^[0-9a-f]{128}$/i

function crcHex(crc: number): string {
  return (crc >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------------------------
// Modrinth
// ---------------------------------------------------------------------------------------------

const MR = 'Modrinth manifest'

function parseEnv(v: unknown, field: string): EnvSupport {
  if (v === undefined || v === null) return 'required'
  if (v === 'required' || v === 'optional' || v === 'unsupported') return v
  throw invalid(field, 'must be "required", "optional" or "unsupported"', MR)
}

function parseModrinth(json: unknown, prefix: string, entries: readonly ZipEntryInfo[], warnings: ModpackWarning[]): Omit<ModpackManifest, 'archive' | 'sha1'> {
  if (!isRecord(json)) throw invalid('', 'is not an object', MR)
  if (json.formatVersion !== 1) throw new ModpackError('EUNSUPPORTED_FORMAT', `Unsupported Modrinth pack format version ${JSON.stringify(json.formatVersion)}`, { field: 'formatVersion' })
  if (json.game !== 'minecraft') throw new ModpackError('EUNSUPPORTED_FORMAT', `Unsupported game ${JSON.stringify(json.game)}`, { field: 'game' })
  const name = str(json, 'name', 'name', MR).trim()
  const version = str(json, 'versionId', 'versionId', MR)
  const summary = optStr(json, 'summary', 'summary', MR)

  const deps = json.dependencies
  if (!isRecord(deps)) throw invalid('dependencies', 'is missing', MR)
  const minecraft = str(deps, 'minecraft', 'dependencies.minecraft', MR)
  let loader: ModpackLoader | null = null
  for (const [key, value] of Object.entries(deps)) {
    if (key === 'minecraft') continue
    const id = loaderFromModrinthKey(key)
    if (!id) {
      warnings.push({ code: 'unknown-dependency', message: `Unknown dependency "${key}" is ignored`, subject: key })
      continue
    }
    if (typeof value !== 'string' || !value.trim()) throw invalid(`dependencies.${key}`, 'must be a version string', MR)
    if (loader) throw invalid(`dependencies.${key}`, `declares a second loader next to ${loader.id}`, MR)
    loader = { id, version: normaliseLoaderVersion(value, minecraft) }
  }

  if (!Array.isArray(json.files)) throw invalid('files', 'must be an array', MR)
  const byKey = new Map<string, ModrinthPackFile>()
  json.files.forEach((raw: unknown, i: number) => {
    const f = `files[${i}]`
    if (!isRecord(raw)) throw invalid(f, 'is not an object', MR)
    const rawPath = str(raw, 'path', `${f}.path`, MR)
    const hashes = raw.hashes
    if (!isRecord(hashes)) throw invalid(`${f}.hashes`, 'is missing', MR)
    const sha1 = str(hashes, 'sha1', `${f}.hashes.sha1`, MR)
    if (!HEX40.test(sha1)) throw invalid(`${f}.hashes.sha1`, 'is not a SHA-1', MR)
    const sha512 = optStr(hashes, 'sha512', `${f}.hashes.sha512`, MR)
    if (sha512 !== undefined && !HEX128.test(sha512)) throw invalid(`${f}.hashes.sha512`, 'is not a SHA-512', MR)
    const size = raw.fileSize
    if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) throw invalid(`${f}.fileSize`, 'must be a non-negative integer', MR)
    if (!Array.isArray(raw.downloads)) throw invalid(`${f}.downloads`, 'must be an array', MR)
    const env = raw.env === undefined || raw.env === null ? undefined : raw.env
    if (env !== undefined && !isRecord(env)) throw invalid(`${f}.env`, 'is not an object', MR)

    const checked = checkPackPath(rawPath)
    if (!checked.ok) {
      warnings.push({ code: 'unsafe-path', message: `Skipped ${JSON.stringify(rawPath)}: ${checked.reason}`, subject: rawPath })
      return
    }
    const downloads: string[] = []
    for (const [j, u] of raw.downloads.entries()) {
      if (typeof u !== 'string') throw invalid(`${f}.downloads[${j}]`, 'must be a string', MR)
      if (isHttpsUrl(u)) downloads.push(u)
    }
    if (downloads.length === 0) {
      warnings.push({ code: 'insecure-url', message: `Skipped ${checked.path}: it has no https download URL`, subject: checked.path })
      return
    }
    const entry: ModrinthPackFile = {
      kind: 'modrinth',
      path: checked.path,
      hashes: sha512 ? { sha1: sha1.toLowerCase(), sha512: sha512.toLowerCase() } : { sha1: sha1.toLowerCase() },
      size: size as number | undefined,
      downloads,
      env: { client: parseEnv(env?.client, `${f}.env.client`), server: parseEnv(env?.server, `${f}.env.server`) },
    }
    const key = pathKey(entry.path)
    if (byKey.has(key)) warnings.push({ code: 'duplicate-path', message: `${entry.path} is listed more than once; the last entry wins`, subject: entry.path })
    byKey.delete(key)
    byKey.set(key, entry)
  })
  const files = [...byKey.values()]
  const overridesDirs = [`${prefix}overrides/`, `${prefix}client-overrides/`]
  const overrides = collectOverrides(entries, [
    { dir: `${prefix}overrides/`, layer: 'overrides' },
    { dir: `${prefix}client-overrides/`, layer: 'client-overrides' },
  ], warnings)
  return { format: 'modrinth', prefix, name, version, summary, minecraft, loader, files, overridesDirs, overrides, warnings }
}

function isHttpsUrl(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------------------------

const CF = 'CurseForge manifest'

function positiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw invalid(field, 'must be a positive integer', CF)
  return v
}

function parseCurseForge(json: Record<string, unknown>, entries: readonly ZipEntryInfo[], warnings: ModpackWarning[]): Omit<ModpackManifest, 'archive' | 'sha1'> {
  if (json.manifestVersion !== 1) {
    warnings.push({ code: 'manifest-version', message: `Unexpected manifestVersion ${JSON.stringify(json.manifestVersion)}; reading it as version 1` })
  }
  const mc = json.minecraft
  if (!isRecord(mc)) throw invalid('minecraft', 'is missing', CF)
  const minecraft = str(mc, 'version', 'minecraft.version', CF)
  if (!Array.isArray(mc.modLoaders)) throw invalid('minecraft.modLoaders', 'is missing', CF)
  let loader: ModpackLoader | null = null
  const loaders = mc.modLoaders as unknown[]
  const primaryIndex = Math.max(0, loaders.findIndex((l) => isRecord(l) && l.primary === true))
  const primary = loaders[primaryIndex]
  if (primary !== undefined) {
    const field = `minecraft.modLoaders[${primaryIndex}].id`
    if (!isRecord(primary)) throw invalid(`minecraft.modLoaders[${primaryIndex}]`, 'is not an object', CF)
    const id = str(primary, 'id', field, CF)
    const parsed = parseCurseForgeLoaderId(id, minecraft)
    if (!parsed) throw invalid(field, `is not a known loader (${JSON.stringify(id)})`, CF)
    loader = parsed
  }

  const name = (optStr(json, 'name', 'name', CF) ?? '').trim()
  const version = optStr(json, 'version', 'version', CF) ?? ''
  const author = optStr(json, 'author', 'author', CF)

  if (!Array.isArray(json.files)) throw invalid('files', 'must be an array', CF)
  const byFile = new Map<number, CurseForgePackFile>()
  json.files.forEach((raw: unknown, i: number) => {
    const f = `files[${i}]`
    if (!isRecord(raw)) throw invalid(f, 'is not an object', CF)
    const projectId = positiveInt(raw.projectID, `${f}.projectID`)
    const fileId = positiveInt(raw.fileID, `${f}.fileID`)
    if (raw.required !== undefined && typeof raw.required !== 'boolean') throw invalid(`${f}.required`, 'must be a boolean', CF)
    const previous = byFile.get(fileId)
    // A file listed twice is required if either listing requires it.
    byFile.set(fileId, { kind: 'curseforge', projectId, fileId, required: raw.required !== false || previous?.required === true })
  })

  const rawOverrides = optStr(json, 'overrides', 'overrides', CF) ?? 'overrides'
  const checked = checkPackPath(rawOverrides.replace(/\/+$/, '') || 'overrides')
  if (!checked.ok) throw invalid('overrides', `is not a safe folder name (${checked.reason})`, CF)
  const dir = `${checked.path}/`
  const overrides = collectOverrides(entries, [{ dir, layer: 'overrides' }], warnings)
  const files: ModpackFileEntry[] = [...byFile.values()]
  return { format: 'curseforge', prefix: '', name, version, author, minecraft, loader, files, overridesDirs: [dir], overrides, warnings }
}

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

/**
 * List the files under each override folder. Folders are matched with their trailing slash
 * (so `overrides-extra/` is not `overrides/`). Later layers replace earlier ones for the same
 * path, compared case- and normalisation-insensitively.
 */
function collectOverrides(entries: readonly ZipEntryInfo[], layers: { dir: string; layer: OverrideLayer }[], warnings: ModpackWarning[]): OverrideEntry[] {
  const byKey = new Map<string, OverrideEntry>()
  for (const { dir, layer } of layers) {
    for (const e of entries) {
      if (e.isDirectory || e.isSymlink || !e.name.startsWith(dir) || isJunkEntry(e.name)) continue
      const rel = e.name.slice(dir.length)
      const checked = checkPackPath(rel)
      if (!checked.ok) {
        warnings.push({ code: 'unsafe-path', message: `Skipped override ${JSON.stringify(e.name)}: ${checked.reason}`, subject: e.name })
        continue
      }
      const key = pathKey(checked.path)
      byKey.delete(key)
      byKey.set(key, { path: checked.path, entry: e.name, layer, size: e.size, crc32: crcHex(e.crc) })
    }
  }
  return [...byKey.values()]
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * A display name from a pack file name: drop the extension and version-like tokens, turn `-`
 * and `_` into spaces and use title case. `All-the-Mods_9-0.2.44.mrpack` → `All The Mods 9`.
 */
export function deriveName(fileName: string): string {
  const stem = fileName.replace(/\.(mrpack|zip)$/i, '')
  const words = stem
    .split(/[-_\s]+/)
    .filter((w) => w && !/^v?\d+(\.\d+)+([+-].*)?$/i.test(w) && !/^(mc)?\d+\.\d+(\.\d+)?$/i.test(w))
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim()
  return name || stem || 'Modpack'
}
