/* oxlint-disable no-await-in-loop -- entries and path components are processed sequentially by design */
import { lstat, readlink } from 'node:fs/promises'
import path from 'node:path'
import { ZipError } from './errors'

/**
 * Split a zip entry name into safe relative segments, or throw `EZIP_UNSAFE_PATH`.
 * Rejects absolute paths (`/x`, `C:x`), `..` segments and NUL bytes; drops empty and `.` segments.
 */
export function entrySegments(name: string): string[] {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.includes('\0')) throw unsafe(name, 'contains a NUL byte')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw unsafe(name, 'is an absolute path')
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) throw unsafe(name, 'contains a ".." segment')
  return segments
}

/** Validate a path that the writer will store in an archive; returns it normalized with forward slashes. */
export function validateZipPath(zipPath: string): string {
  const segments = entrySegments(zipPath)
  if (segments.length === 0 || /[\\/]$/.test(zipPath)) throw unsafe(zipPath, 'is not a file path')
  return segments.join('/')
}

export function unsafe(name: string, why: string): ZipError {
  return new ZipError('EZIP_UNSAFE_PATH', `Zip entry ${JSON.stringify(name)} ${why}`)
}

/** True when `child` is `root` or lies beneath it (both absolute, normalized). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const MAX_LINK_HOPS = 40

/**
 * Resolve the relative path `segments` against the physical directory `base`, following
 * symlinks that already exist on disk component by component (so `link/..` means the parent of
 * the link's target, as the OS would see it). Components that do not exist yet are appended
 * lexically. `base` must itself be a symlink-free absolute path.
 */
export async function resolvePhysical(base: string, segments: readonly string[], hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw new ZipError('EZIP_UNSAFE_PATH', 'Too many levels of symbolic links')
  let current = base
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      current = path.dirname(current)
      continue
    }
    const next = path.join(current, seg)
    const st = await lstat(next).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return undefined
      throw e
    })
    if (st === undefined) return path.resolve(next, ...segments.slice(i + 1))
    if (st.isSymbolicLink()) {
      const target = await readlink(next)
      current = await resolvePhysical(path.isAbsolute(target) ? '/' : current, target.split(/[\\/]/), hops + 1)
    } else {
      current = next
    }
  }
  return current
}
