/**
 * Path helpers that follow macOS file system semantics. APFS volumes are case-insensitive and
 * normalisation-insensitive by default, so `Mods/Café.jar` (NFD) and `mods/café.jar` (NFC) name
 * the same file. Compare and de-duplicate paths through {@link pathKey}, never with `===`.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'

/** A comparison key for a path or file name: NFC-normalised and lower-cased. */
export function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase()
}

/** True when `a` and `b` name the same entry on a case- and normalisation-insensitive volume. */
export function samePath(a: string, b: string): boolean {
  return pathKey(path.resolve(a)) === pathKey(path.resolve(b))
}

/** True when `child` is inside `parent` (or equal to it), compared with {@link pathKey}. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(pathKey(path.resolve(parent)), pathKey(path.resolve(child)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const MAX_NAME_BYTES = 255

/**
 * Make an untrusted name (marketplace file name, zip stem, world name) safe to use as a single
 * path component: removes path separators, NUL and other control characters, `:`, and leading
 * dots, trims whitespace and clamps the UTF-8 length to 255 bytes. Returns `fallback` when
 * nothing usable is left.
 */
export function sanitizeFileName(name: string, fallback = 'unnamed'): string {
  let out = name
    .normalize('NFC')
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '_')
    .trim()
    .replace(/^[.\s]+/, '')
  if (Buffer.byteLength(out) > MAX_NAME_BYTES) {
    const { stem, ext } = splitExtension(out)
    const extBytes = Buffer.byteLength(ext)
    let s = stem
    while (s.length > 0 && Buffer.byteLength(s) + extBytes > MAX_NAME_BYTES) s = [...s].slice(0, -1).join('')
    out = s + ext
  }
  return out === '' || out === '..' ? fallback : out
}

/** Split `name.ext` into `{ stem: 'name', ext: '.ext' }`. Names without a dot (or dot-files) have no extension. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * Choose a name inside `dir` that collides with no existing entry (compared with
 * {@link pathKey}): `base`, then `<stem> (2)<ext>`, `<stem> (3)<ext>` and so on. The same stem
 * is used for every candidate. Pass `extension: false` for folders whose names contain dots.
 */
export async function uniqueName(dir: string, base: string, options: { extension?: boolean; reserved?: Iterable<string> } = {}): Promise<string> {
  const taken = new Set<string>()
  try {
    for (const entry of await readdir(dir)) taken.add(pathKey(entry))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  for (const r of options.reserved ?? []) taken.add(pathKey(r))
  const { stem, ext } = options.extension === false ? { stem: base, ext: '' } : splitExtension(base)
  let candidate = base
  for (let n = 2; taken.has(pathKey(candidate)); n++) candidate = `${stem} (${n})${ext}`
  return candidate
}
