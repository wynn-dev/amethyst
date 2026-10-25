/**
 * Validation for the `amethyst-asset:` protocol, kept free of Electron imports so it can be unit
 * tested. Only image and video files inside the data root are ever served:
 *
 * - the URL must be `amethyst-asset://data/<segments>`;
 * - every segment is decoded once and must not be empty, `.`/`..`, hidden (leading `.`), or
 *   contain a separator or NUL (so `%2e%2e`, `%2f` and `..%5c` tricks fail);
 * - only the folders in `SERVED_FOLDERS` are served (never secrets, game files, Java runtimes,
 *   backups or the content store);
 * - only extensions in `ASSET_TYPES` are allowed (no JSON, databases or encrypted blobs);
 * - after resolving symlinks the real path must pass the same checks against the real data root
 *   (`isServable`), so a link inside a served folder cannot expose any other file.
 */
import path from 'node:path'
import { ASSET_HOST, ASSET_SCHEME, ASSET_TYPES } from '@shared/paths'

/**
 * The only folders of the data root the protocol serves (lower-case path prefixes): extracted
 * and mirrored icons, instance folders (their icons), background media and offline skins.
 */
const SERVED_FOLDERS: readonly (readonly string[])[] = [['cache', 'icons'], ['instances'], ['theme-media'], ['skins']]

export type AssetResolution = { ok: true; path: string; mime: string; immutable: boolean } | { ok: false; status: 400 | 403 | 404 }

/** Folders whose files are content-addressed (their names change when the content does). */
const IMMUTABLE_PREFIXES = ['cache/icons/', 'theme-media/']

/** `child` is `parent` or inside it (plain string comparison of resolved paths). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Map an asset URL to a file path under `dataRoot`, or the HTTP status to answer with. */
export function resolveAssetPath(dataRoot: string, url: string): AssetResolution {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, status: 400 }
  }
  if (u.protocol !== `${ASSET_SCHEME}:` || u.hostname !== ASSET_HOST || u.username || u.password || u.port) return { ok: false, status: 400 }
  const raw = u.pathname.split('/').slice(1)
  if (raw.length === 1 && raw[0] === '') return { ok: false, status: 404 }
  const segments: string[] = []
  for (const s of raw) {
    let decoded: string
    try {
      decoded = decodeURIComponent(s)
    } catch {
      return { ok: false, status: 400 }
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.startsWith('.') || /[/\\\0]/.test(decoded)) return { ok: false, status: 403 }
    segments.push(decoded)
  }
  if (segments.length === 0) return { ok: false, status: 404 }
  const mime = servableMime(segments)
  if (!mime) return { ok: false, status: 403 }
  const root = path.resolve(dataRoot)
  const file = path.resolve(root, ...segments)
  if (!isInside(root, file)) return { ok: false, status: 403 }
  const rel = segments.join('/')
  return { ok: true, path: file, mime, immutable: IMMUTABLE_PREFIXES.some((p) => rel.startsWith(p)) }
}

/** The MIME type of a data-root-relative path the protocol may serve, or `undefined`. */
function servableMime(segments: readonly string[]): string | undefined {
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return undefined
  const lower = segments.map((s) => s.toLowerCase())
  if (!SERVED_FOLDERS.some((prefix) => lower.length > prefix.length && prefix.every((p, i) => lower[i] === p))) return undefined
  return ASSET_TYPES[path.extname(lower.at(-1) as string)]
}

/**
 * The real (symlink-resolved) file may be served: inside the real data root, in a served folder,
 * not hidden, and with a media extension.
 */
export function isServable(realRoot: string, realFile: string): boolean {
  if (!isInside(realRoot, realFile)) return false
  return servableMime(path.relative(realRoot, realFile).split(path.sep)) !== undefined
}

/**
 * Parse a single-range `Range: bytes=…` header against a file size. `null` when absent (serve
 * the whole file), `'invalid'` when it cannot be satisfied (answer 416).
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return 'invalid'
  const [, a, b] = m
  if (a === '' && b === '') return 'invalid'
  let start: number
  let end: number
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'
  return { start, end }
}
