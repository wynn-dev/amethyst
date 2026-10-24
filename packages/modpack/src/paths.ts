/**
 * Path rules for files that a pack wants to place in an instance (`modpacks.md` §3.1, §4.3).
 *
 * Every path from a manifest or an override entry is untrusted. {@link checkPackPath} returns
 * the normalised relative path, or a reason when the path must be dropped. Paths are compared
 * through {@link pathKey} (NFC + lower case) because APFS is case- and
 * normalisation-insensitive.
 */
import path from 'node:path'
import { pathKey } from '@amethyst/content'

export { pathKey }

/** Top-level folders the launcher owns; packs may never write into them. */
export const RESERVED_ROOTS: readonly string[] = ['.amethyst', 'versions', 'libraries', 'assets', 'runtimes']

/** Result of {@link checkPackPath}. */
export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Validate a relative path from a pack. Rejects empty paths, absolute paths (`/x`, `C:x`), NUL
 * bytes, backslashes, `..` segments and paths under {@link RESERVED_ROOTS}. Empty and `.`
 * segments are dropped; the result always uses `/` separators and is NFC-normalised.
 */
export function checkPackPath(raw: unknown): PathCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty path' }
  if (raw.includes('\0')) return { ok: false, reason: 'contains a NUL byte' }
  if (raw.includes('\\')) return { ok: false, reason: 'contains a backslash' }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || path.isAbsolute(raw)) return { ok: false, reason: 'is an absolute path' }
  const segments = raw.normalize('NFC').split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) return { ok: false, reason: 'contains a ".." segment' }
  if (segments.length === 0) return { ok: false, reason: 'empty path' }
  const root = pathKey(segments[0] as string)
  if (RESERVED_ROOTS.includes(root)) return { ok: false, reason: `writes into the launcher-owned folder ${segments[0]}/` }
  return { ok: true, path: segments.join('/') }
}

/** Absolute path of `rel` (a checked pack path) inside `root`. */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'))
  const back = path.relative(root, abs)
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`Path escapes the instance: ${rel}`)
  return abs
}

/** True for the zip entries that never carry content: `__MACOSX/` and `.DS_Store`. */
export function isJunkEntry(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store')
}
