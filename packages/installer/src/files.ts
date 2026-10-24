/* oxlint-disable no-await-in-loop -- download attempts are sequential by design */
import { readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type DownloadItem, downloadMany, hashFile, type HttpClient } from '@amethyst/net'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { openZip } from '@amethyst/zip'
import { InstallError } from './errors'

/**
 * A file that must exist and be valid: the installer's unit of work. Mirrors the "file descriptor"
 * of `download.md` §5.1.
 */
export interface FileSpec {
  /** Absolute destination path. */
  path: string
  /** Candidate URLs, in order. Empty for files that are produced locally (installer jars, processors). */
  urls: string[]
  /** Expected size in bytes, when known. */
  size?: number
  sha1?: string
  /** Legacy Forge `checksums`: the file is valid if it matches any of these sha1 values. */
  sha1Any?: string[]
  sha256?: string
  /** Content check for files without a checksum: `zip` must open with at least one entry, `json` must parse. */
  validator?: 'zip' | 'json'
  /** Accept an existing file of exactly `size` bytes without hashing (asset objects). */
  trustSize?: boolean
  /** Always hash, even when the file is older than `trustedBefore` (the client jar). */
  alwaysHash?: boolean
  /** Short label for progress and error messages, e.g. a maven coordinate. */
  name?: string
}

/** Options for {@link ensureFiles}. */
export interface EnsureFilesOptions {
  signal?: AbortSignal
  /** Byte progress is reported here (through `downloadMany`). */
  ctx?: TaskContext
  http?: HttpClient
  /** Parallel downloads (default 16). */
  concurrency?: number
  /** Re-download every file, ignoring what is on disk (but still verify the new bytes). */
  replace?: boolean
  /**
   * The `.install-lock` timestamp (ms). Existing files whose mtime is at or before it are trusted
   * without hashing, except those marked {@link FileSpec.alwaysHash}.
   */
  trustedBefore?: number
}

/** Outcome of {@link ensureFiles}. */
export interface EnsureFilesResult {
  /** Files fetched from the network. */
  downloaded: number
  /** Files that were already valid. */
  skipped: number
  /** Bytes received. */
  bytes: number
}

const ATTEMPTS = 3

async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const st = await stat(path)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw e
  }
}

/** True when `path` opens as a zip with at least one file entry. */
export async function isValidZip(path: string): Promise<boolean> {
  try {
    const zip = await openZip(path)
    try {
      return (await zip.entries()).some((e) => !e.isDirectory)
    } finally {
      await zip.close()
    }
  } catch {
    return false
  }
}

async function isValidJson(path: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(path, 'utf8'))
    return true
  } catch {
    return false
  }
}

/** Why a file is invalid, or `undefined` when it is valid. */
export interface FileProblem {
  reason: 'missing' | 'size' | 'checksum' | 'content'
  expected?: string
  actual?: string
}

/**
 * Check one file against its spec, in the order of `download.md` §5.2 (without the mtime trust):
 * existence, `trustSize`, checksum (any of `sha1Any`), size, then the content validator.
 * Returns `undefined` when the file is valid.
 */
export async function checkFile(spec: FileSpec, signal?: AbortSignal): Promise<FileProblem | undefined> {
  const st = await statFile(spec.path)
  if (!st) return { reason: 'missing' }
  const size = spec.size !== undefined && spec.size >= 0 ? spec.size : undefined
  if (spec.trustSize && size !== undefined && st.size === size) return undefined
  if (size !== undefined && st.size !== size) return { reason: 'size', expected: String(size), actual: String(st.size) }
  if (spec.sha256) {
    const actual = await hashFile(spec.path, 'sha256', signal)
    if (actual !== spec.sha256.toLowerCase()) return { reason: 'checksum', expected: spec.sha256, actual }
  } else if (spec.sha1 || spec.sha1Any?.length) {
    const accepted = [spec.sha1, ...(spec.sha1Any ?? [])].filter((s): s is string => !!s).map((s) => s.toLowerCase())
    const actual = await hashFile(spec.path, 'sha1', signal)
    if (!accepted.includes(actual)) return { reason: 'checksum', expected: accepted.join(' | '), actual }
  } else if (size === undefined && st.size === 0) {
    return { reason: 'size', expected: '> 0', actual: '0' }
  }
  if (spec.validator === 'zip' && !(await isValidZip(spec.path))) return { reason: 'content', expected: 'zip' }
  if (spec.validator === 'json' && !(await isValidJson(spec.path))) return { reason: 'content', expected: 'json' }
  return undefined
}

/** Files whose single checksum lets `downloadMany` do the whole skip/verify job. */
function isSimple(spec: FileSpec): boolean {
  return !!(spec.sha1 || spec.sha256) && !spec.sha1Any?.length && spec.validator !== 'json'
}

function toItem(spec: FileSpec, urls: string[], existing: DownloadItem['existing']): DownloadItem {
  const item: DownloadItem = { url: urls, dest: spec.path, existing }
  if (spec.size !== undefined && spec.size >= 0) item.size = spec.size
  if (spec.sha256) item.checksum = { algorithm: 'sha256', value: spec.sha256 }
  else if (spec.sha1 && !spec.sha1Any?.length) item.checksum = { algorithm: 'sha1', value: spec.sha1 }
  return item
}

function problemError(spec: FileSpec, problem: FileProblem): InstallError {
  const label = spec.name ?? spec.path
  if (problem.reason === 'missing' && spec.urls.length === 0) {
    return new InstallError('EINSTALL_FILE_INVALID', `${label} is missing and has no download URL (it should come from an installer)`, { path: spec.path })
  }
  if (problem.reason === 'checksum') {
    return new InstallError('EINSTALL_CHECKSUM', `${label}: expected ${problem.expected}, got ${problem.actual}`, { path: spec.path })
  }
  const detail = problem.expected ? ` (expected ${problem.expected}${problem.actual ? `, got ${problem.actual}` : ''})` : ''
  return new InstallError('EINSTALL_FILE_INVALID', `${label} is invalid: ${problem.reason}${detail}`, { path: spec.path })
}

/**
 * Make every file in `specs` exist and be valid, downloading only what is missing or wrong.
 *
 * Duplicate paths are collapsed (the last spec wins). Files with a single checksum go straight to
 * `downloadMany`, which skips valid ones and verifies new bytes. Files without one (or with legacy
 * multi-checksums) are checked here first, downloaded when invalid, then re-validated; a file that
 * still fails is deleted and retried from the next URL, up to three attempts. Files without URLs
 * must already be valid. Byte progress goes to `ctx`.
 *
 * @throws {InstallError} `EINSTALL_FILE_INVALID` / `EINSTALL_CHECKSUM` when a file cannot be made
 * valid; `DownloadError` (`EDOWNLOAD`) from `@amethyst/net` for network failures; the abort reason
 * on cancellation.
 */
export async function ensureFiles(specs: Iterable<FileSpec>, options: EnsureFilesOptions = {}): Promise<EnsureFilesResult> {
  const signal = options.signal ?? options.ctx?.signal
  const byPath = new Map<string, FileSpec>()
  for (const spec of specs) byPath.set(resolve(spec.path), { ...spec, path: resolve(spec.path) })
  let list = [...byPath.values()]
  const result: EnsureFilesResult = { downloaded: 0, skipped: 0, bytes: 0 }

  if (options.trustedBefore !== undefined && !options.replace) {
    const before = options.trustedBefore
    const trusted = await mapLimit(
      list,
      32,
      async (spec) => {
        if (spec.alwaysHash) return false
        const st = await statFile(spec.path)
        return !!st && st.mtimeMs <= before && (spec.size === undefined || spec.size < 0 || st.size === spec.size)
      },
      signal,
    )
    result.skipped += trusted.filter(Boolean).length
    list = list.filter((_, i) => !trusted[i])
  }

  // Files the downloader cannot judge on its own: check them here.
  const custom = list.filter((s) => !isSimple(s) || s.urls.length === 0)
  const customValid = await mapLimit(
    custom,
    16,
    async (s) => !(options.replace && s.urls.length > 0) && (await checkFile(s, signal)) === undefined,
    signal,
  )
  const pendingCustom: FileSpec[] = []
  for (const [i, spec] of custom.entries()) {
    if (customValid[i]) {
      result.skipped++
      continue
    }
    if (spec.urls.length === 0) {
      const problem = (await checkFile(spec, signal)) ?? { reason: 'missing' as const }
      throw problemError(spec, problem)
    }
    pendingCustom.push(spec)
  }

  const simple = list.filter((s) => isSimple(s) && s.urls.length > 0)
  const urls = new Map<FileSpec, string[]>([...simple, ...pendingCustom].map((s) => [s, [...s.urls]]))
  let pending: FileSpec[] = [...simple, ...pendingCustom]
  for (let attempt = 0; pending.length > 0; attempt++) {
    const items = pending.map((s) => toItem(s, urls.get(s) ?? s.urls, options.replace || !isSimple(s) ? 'replace' : s.trustSize ? 'trust-size' : 'verify'))
    const stats = await downloadMany(items, {
      signal,
      ctx: options.ctx,
      client: options.http,
      concurrency: options.concurrency,
    })
    result.bytes += stats.bytes
    result.downloaded += stats.files
    result.skipped += stats.skipped
    // Simple files were fully verified by the downloader; re-validate the rest.
    const toCheck = pending.filter((s) => !isSimple(s))
    const problems = await mapLimit(toCheck, 16, (s) => checkFile(s, signal), signal)
    const failed: { spec: FileSpec; problem: FileProblem }[] = []
    for (const [i, spec] of toCheck.entries()) {
      const problem = problems[i]
      if (problem) failed.push({ spec, problem })
    }
    const [first] = failed
    if (!first) break
    await Promise.all(failed.map(({ spec }) => rm(spec.path, { force: true })))
    result.downloaded -= failed.length
    if (attempt + 1 >= ATTEMPTS) throw problemError(first.spec, first.problem)
    for (const { spec } of failed) {
      const u = urls.get(spec) ?? []
      if (u.length > 1) u.push(u.shift() as string)
    }
    pending = failed.map((f) => f.spec)
  }
  return result
}
