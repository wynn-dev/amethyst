/**
 * Building the list of files a pack installs (`modpacks.md` §4.1).
 *
 * - Modrinth: files come straight from the manifest. `env.client` decides whether a file is
 *   skipped (`unsupported`), optional (`optional`, checked by default) or required.
 * - CurseForge: the manifest lists only ids. They are looked up in batches through
 *   `POST /v1/mods/files` and `POST /v1/mods`; a batch that CurseForge rejects (it answers 400
 *   to a whole batch when one id is invalid) is split in half and retried, so one bad id only
 *   drops that file. The target folder comes from the project's `classId`. Files with
 *   `downloadUrl: null` are **blocked**: they become {@link ManualDownload}s and no URL is ever
 *   guessed for them (`DECISIONS.md`).
 */
import path from 'node:path'
import { sanitizeFileName } from '@amethyst/content'
import {
  CurseForgeClass,
  curseForgeFilePageUrl,
  isMarketplaceError,
  type CurseForgeClient,
  type CurseForgeFile,
  type CurseForgeMod,
  type ModrinthClient,
} from '@amethyst/marketplace'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { isAbortError, messageOf, ModpackError, throwIfAborted } from './errors'
import { checkPackPath, pathKey } from './paths'
import { MODRINTH_ALLOWED_HOSTS } from './read'
import type { FileOrigin, ManualDownload, ModpackManifest, OptionalChoice, ResolvedFile, ResolvedModpack, SkippedFile } from './types'

/** The part of {@link ModrinthClient} used here (mockable). */
export type ModrinthLookup = Pick<ModrinthClient, 'getVersionsFromHashes'>

/** The part of {@link CurseForgeClient} used here (mockable). */
export type CurseForgeLookup = Pick<CurseForgeClient, 'getFiles' | 'getMods'>

/** Options for {@link resolveModpackFiles}. */
export interface ResolveOptions {
  /** Optional: annotates Modrinth files with project/version ids when their URL does not reveal them. */
  modrinth?: ModrinthLookup
  /** Required for CurseForge packs. */
  curseforge?: CurseForgeLookup
  /** Ids per CurseForge request (default 100). */
  batchSize?: number
  signal?: AbortSignal
  ctx?: TaskContext
}

/**
 * Resolve the manifest's files into installable entries.
 *
 * @throws {ModpackError} `EMARKET_UNAVAILABLE` when CurseForge cannot be reached, has no API
 * key or rejects it. A partial plan is never returned silently.
 */
export async function resolveModpackFiles(manifest: ModpackManifest, options: ResolveOptions = {}): Promise<ResolvedModpack> {
  const signal = options.signal ?? options.ctx?.signal
  throwIfAborted(signal)
  return manifest.format === 'modrinth' ? resolveModrinth(manifest, options, signal) : resolveCurseForge(manifest, options, signal)
}

function finish(manifest: ModpackManifest, files: ResolvedFile[], extra: Partial<ResolvedModpack>): ResolvedModpack {
  const optional: OptionalChoice[] = files.filter((f) => f.optional).map((f) => ({ path: f.path, name: f.name, defaultSelected: f.defaultSelected }))
  return {
    format: manifest.format,
    packSha1: manifest.sha1,
    files,
    optional,
    manualDownloads: extra.manualDownloads ?? [],
    datapacks: extra.datapacks ?? [],
    skipped: extra.skipped ?? [],
    externalHosts: extra.externalHosts ?? [],
  }
}

// ---------------------------------------------------------------------------------------------
// Modrinth
// ---------------------------------------------------------------------------------------------

const CDN_PATH = /^\/data\/([0-9A-Za-z]{8})\/versions\/([0-9A-Za-z]{8})\//

/** Project and version ids from a `cdn.modrinth.com/data/<project>/versions/<version>/...` URL. */
export function modrinthIdsFromUrl(url: string): { projectId: string; versionId: string } | undefined {
  try {
    const u = new URL(url)
    if (u.hostname !== 'cdn.modrinth.com') return undefined
    const m = CDN_PATH.exec(u.pathname)
    return m ? { projectId: m[1] as string, versionId: m[2] as string } : undefined
  } catch {
    return undefined
  }
}

async function resolveModrinth(manifest: ModpackManifest, options: ResolveOptions, signal?: AbortSignal): Promise<ResolvedModpack> {
  const files: ResolvedFile[] = []
  const skipped: SkippedFile[] = []
  const hosts = new Set<string>()
  for (const f of manifest.files) {
    if (f.kind !== 'modrinth') continue
    if (f.env.client === 'unsupported') {
      skipped.push({ path: f.path, reason: 'env-unsupported', message: `${f.path} is server-only` })
      continue
    }
    for (const u of f.downloads) {
      const host = new URL(u).hostname
      if (!MODRINTH_ALLOWED_HOSTS.includes(host)) hosts.add(host)
    }
    const ids = f.downloads.map(modrinthIdsFromUrl).find((x) => x !== undefined)
    const origin: FileOrigin = ids ? { kind: 'modrinth', ...ids } : { kind: 'url' }
    const optional = f.env.client === 'optional'
    files.push({
      path: f.path,
      hashes: { ...f.hashes },
      size: f.size,
      downloads: [...f.downloads],
      optional,
      defaultSelected: true,
      blocked: false,
      origin,
      name: path.posix.basename(f.path),
    })
  }

  // Best effort: learn project/version ids for files hosted elsewhere. Failures are ignored.
  const unknown = files.filter((f) => f.origin.kind === 'url' && f.hashes.sha1)
  if (options.modrinth && unknown.length > 0) {
    try {
      const found = await options.modrinth.getVersionsFromHashes(unknown.map((f) => f.hashes.sha1 as string), 'sha1', { signal })
      for (const f of unknown) {
        const v = found[f.hashes.sha1 as string]
        if (v) f.origin = { kind: 'modrinth', projectId: v.project_id, versionId: v.id }
      }
    } catch (e) {
      if (isAbortError(e)) throw e
    }
  }
  return finish(manifest, files, { skipped, externalHosts: [...hosts].toSorted() })
}

// ---------------------------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------------------------

/** True when CurseForge rejected the batch itself (bad or deleted id), so bisecting can isolate it. */
function isBatchRejection(e: unknown): boolean {
  if (isMarketplaceError(e)) {
    if (e.code === 'ENOT_FOUND' || e.code === 'EBAD_RESPONSE') return true
    return e.code === 'EHTTP' && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429
  }
  const status = (e as { status?: unknown } | undefined)?.status
  return status === 400 || status === 404
}

/**
 * Fetch `ids` in batches of `size`. A rejected batch is split in half and each half retried,
 * down to single ids, which are then reported as failed. Other errors abort the lookup.
 */
export async function lookupInBatches<T>(
  ids: readonly number[],
  size: number,
  fetchBatch: (ids: number[]) => Promise<T[]>,
  signal?: AbortSignal,
): Promise<{ results: T[]; failed: number[] }> {
  const results: T[] = []
  const failed: number[] = []
  const run = async (batch: number[]): Promise<void> => {
    throwIfAborted(signal)
    try {
      results.push(...(await fetchBatch(batch)))
    } catch (e) {
      if (isAbortError(e) || !isBatchRejection(e)) throw e
      if (batch.length === 1) {
        failed.push(batch[0] as number)
        return
      }
      const mid = Math.ceil(batch.length / 2)
      await run(batch.slice(0, mid))
      await run(batch.slice(mid))
    }
  }
  const batches: number[][] = []
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size))
  await mapLimit(batches, 4, (b) => run(b), signal)
  return { results, failed }
}

function unavailable(e: unknown): unknown {
  if (isAbortError(e) || e instanceof ModpackError) return e
  return new ModpackError('EMARKET_UNAVAILABLE', `Couldn't contact CurseForge: ${messageOf(e)}`, { cause: e })
}

/** Target folder for a CurseForge class, or undefined when it must be guessed. */
function folderForClass(classId: number | null | undefined): string | undefined {
  switch (classId) {
    case CurseForgeClass.Mods:
      return 'mods'
    case CurseForgeClass.ResourcePacks:
      return 'resourcepacks'
    case CurseForgeClass.Shaders:
      return 'shaderpacks'
    case CurseForgeClass.Worlds:
      return 'saves'
    case CurseForgeClass.DataPacks:
      return '.amethyst/datapacks-pending'
    default:
      return undefined
  }
}

function cfHashes(file: CurseForgeFile): { sha1?: string; md5?: string } {
  const out: { sha1?: string; md5?: string } = {}
  for (const h of file.hashes ?? []) {
    if (typeof h?.value !== 'string') continue
    if (h.algo === 1 && /^[0-9a-f]{40}$/i.test(h.value)) out.sha1 = h.value.toLowerCase()
    if (h.algo === 2 && /^[0-9a-f]{32}$/i.test(h.value)) out.md5 = h.value.toLowerCase()
  }
  return out
}

async function resolveCurseForge(manifest: ModpackManifest, options: ResolveOptions, signal?: AbortSignal): Promise<ResolvedModpack> {
  const cf = options.curseforge
  if (!cf) throw new ModpackError('EMARKET_UNAVAILABLE', "Couldn't contact CurseForge: no CurseForge client is configured")
  const size = Math.max(1, Math.floor(options.batchSize ?? 100))
  const entries = manifest.files.filter((f) => f.kind === 'curseforge')
  const ctx = options.ctx
  ctx?.update(0, 2, 'Looking up files on CurseForge')

  let files: { results: CurseForgeFile[]; failed: number[] }
  let mods: { results: CurseForgeMod[]; failed: number[] }
  try {
    files = await lookupInBatches(
      entries.map((e) => e.fileId),
      size,
      (ids) => cf.getFiles(ids, { signal }),
      signal,
    )
    ctx?.update(1, 2, 'Looking up projects on CurseForge')
    const modIds = [...new Set(files.results.map((f) => f.modId))]
    mods = await lookupInBatches(modIds, size, (ids) => cf.getMods(ids, { signal }), signal)
    ctx?.update(2, 2)
  } catch (e) {
    throw unavailable(e)
  }
  // Every lookup rejected is an API failure, not a pack whose files all vanished: a plan built
  // from it would drop (and an update would remove) every file (known issue #971).
  if ((files.failed.length > 0 && files.results.length === 0) || (mods.failed.length > 0 && mods.results.length === 0)) {
    throw new ModpackError('EMARKET_UNAVAILABLE', "Couldn't contact CurseForge: it returned none of the pack's files. Try again later.")
  }

  const fileById = new Map(files.results.map((f) => [f.id, f]))
  const modById = new Map(mods.results.map((m) => [m.id, m]))
  const out: ResolvedFile[] = []
  const skipped: SkippedFile[] = []
  const manualDownloads: ManualDownload[] = []
  const datapacks: ResolvedFile[] = []
  const seen = new Map<string, number>()

  for (const entry of entries) {
    const ref = `curseforge:${entry.projectId}/${entry.fileId}`
    const file = fileById.get(entry.fileId)
    if (!file) {
      skipped.push({ path: ref, reason: 'missing-on-curseforge', message: `File ${entry.fileId} of project ${entry.projectId} no longer exists on CurseForge`, fileId: entry.fileId })
      continue
    }
    const mod = modById.get(file.modId)
    const fileName = sanitizeFileName(String(file.fileName ?? ''), `${file.id}.jar`)
    let folder = folderForClass(mod?.classId)
    if (folder === undefined) {
      // Customization, add-ons and unknown classes: only a jar can be placed with confidence.
      if (/\.jar$/i.test(fileName)) folder = 'mods'
      else {
        skipped.push({ path: ref, reason: 'unknown-class', message: `Cannot tell where ${fileName} belongs (class ${mod?.classId ?? 'unknown'})` })
        continue
      }
    }
    const isWorld = folder === 'saves'
    const target = isWorld ? `saves/${sanitizeFileName(fileName.replace(/\.zip$/i, ''), `world-${file.id}`)}` : `${folder}/${fileName}`
    const checked = folder.startsWith('.amethyst/') ? { ok: true as const, path: target } : checkPackPath(target)
    if (!checked.ok) {
      skipped.push({ path: ref, reason: 'unsafe-path', message: `Skipped ${target}: ${checked.reason}` })
      continue
    }
    const hashes = cfHashes(file)
    const downloadUrl = typeof file.downloadUrl === 'string' && file.downloadUrl.startsWith('https://') ? file.downloadUrl : null
    const blocked = downloadUrl === null
    const name = mod?.name ?? file.displayName ?? fileName
    const resolved: ResolvedFile = {
      path: checked.path,
      hashes,
      size: typeof file.fileLength === 'number' ? file.fileLength : undefined,
      downloads: downloadUrl ? [downloadUrl] : [],
      optional: !entry.required,
      defaultSelected: entry.required,
      blocked,
      origin: blocked ? { kind: 'manual', projectId: file.modId, fileId: file.id } : { kind: 'curseforge', projectId: file.modId, fileId: file.id },
      fingerprint: typeof file.fileFingerprint === 'number' ? file.fileFingerprint : undefined,
      kind: isWorld ? 'world' : 'file',
      name,
    }
    const key = pathKey(resolved.path)
    const dup = seen.get(key)
    if (dup !== undefined) out.splice(dup, 1, resolved)
    else {
      seen.set(key, out.length)
      out.push(resolved)
    }
    if (folder === '.amethyst/datapacks-pending') datapacks.push(resolved)
    if (blocked) {
      manualDownloads.push({
        name,
        fileName,
        websiteUrl: curseForgeFilePageUrl(file, mod),
        sha1: hashes.sha1,
        md5: hashes.md5,
        size: file.fileLength,
        path: resolved.path,
        projectId: file.modId,
        fileId: file.id,
      })
    }
  }
  return finish(manifest, out, { skipped, manualDownloads, datapacks })
}
