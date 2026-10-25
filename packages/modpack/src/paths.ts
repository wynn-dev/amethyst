/**
 * Path rules for files that a pack wants to place in an instance (`modpacks.md` §3.1, §4.3).
 *
 * Every path from a manifest or an override entry is untrusted. {@link checkPackPath} returns
 * the normalised relative path, or a reason when the path must be dropped. Paths are compared
 * through {@link pathKey} (NFC + lower case) because APFS is case- and
 * normalisation-insensitive.
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathKey } from '@amethyst/content'
import { ModpackError } from './errors'

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

/**
 * Guards writes against symlinked folders inside the instance (`mods/` → `~/Documents`, a
 * symlinked `.amethyst/`, ...). {@link resolveInside} only checks the path as a string; this
 * checks the folders on disk: the nearest existing parent of every target must really be inside
 * the instance. Verified folders are cached for the guard's lifetime (one operation).
 */
export class Containment {
  readonly #root: string
  #realRoot: Promise<string> | undefined
  readonly #ok = new Set<string>()

  constructor(root: string) {
    this.#root = path.resolve(root)
  }

  /** `resolveInside(root, rel)`, after checking that writing there stays inside the root. */
  async resolve(rel: string): Promise<string> {
    const abs = resolveInside(this.#root, rel)
    await this.check(abs)
    return abs
  }

  /** Throw `EUNSAFE_PATH` when the nearest existing parent folder of `abs` resolves outside the root. */
  async check(abs: string): Promise<void> {
    this.#realRoot ??= realpath(this.#root)
    const realRoot = await this.#realRoot
    let dir = path.dirname(abs)
    while (!this.#ok.has(dir)) {
      let real: string
      try {
        // oxlint-disable-next-line no-await-in-loop -- walks up a few folders at most
        real = await realpath(dir)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if ((code === 'ENOENT' || code === 'ENOTDIR') && dir.length > this.#root.length) {
          dir = path.dirname(dir)
          continue
        }
        throw e
      }
      const back = path.relative(realRoot, real)
      if (back.startsWith('..') || path.isAbsolute(back)) {
        throw new ModpackError('EUNSAFE_PATH', `${path.relative(this.#root, dir) || '.'} is a link to a folder outside the instance (${real}); refusing to write through it`)
      }
      this.#ok.add(dir)
      break
    }
  }
}

/** True for the zip entries that never carry content: `__MACOSX/` and `.DS_Store`. */
export function isJunkEntry(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store')
}
