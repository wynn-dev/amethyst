import { isAbortError, throwIfAborted } from '../errors'
import { int, isObject, parseLenientJson } from '../util/json'
import { openPackSource, type PackSource } from './source'
import { flattenTextComponent, stripFormatting } from './text'

/** A pack format version. Formats before 1.21.9 have no minor component (`minor: 0`). */
export interface PackVersion {
  major: number
  minor: number
}

/** Warnings about a pack that is listed but not (fully) usable. */
export type PackWarningCode = 'missing-mcmeta' | 'missing-shaders' | 'nested-too-deep' | 'invalid-mcmeta' | 'unreadable'

/** A non-fatal problem with a resource or shader pack. */
export interface PackWarning {
  code: PackWarningCode
  message: string
}

/** What `pack.mcmeta` and `pack.png` say about a resource pack (or datapack). */
export interface ResourcePackInfo {
  format: 'zip' | 'folder'
  /** False when `pack.mcmeta` is missing or unusable. The pack is still listed. */
  valid: boolean
  /** `pack.pack_format`, when present. */
  packFormat?: number
  /**
   * The supported range, combining `pack_format`, `supported_formats` (int, `[min, max]` or
   * `{ min_inclusive, max_inclusive }`) and the newer `min_format` / `max_format` (int or
   * `[major, minor]`).
   */
  formats?: { min: PackVersion; max: PackVersion }
  /** Description with `§` formatting codes (text components are flattened). */
  description: string
  /** Description without formatting codes. */
  descriptionPlain: string
  /** `pack.png` when the pack has one (relative to the pack root). */
  icon?: string
  /** When the real pack root is one folder deeper (a very common mistake), that folder's name. */
  nestedRoot?: string
  warnings: PackWarning[]
}

function packVersion(v: unknown): PackVersion | undefined {
  const n = int(v)
  if (n !== undefined) return { major: n, minor: 0 }
  if (Array.isArray(v)) {
    const major = int(v[0])
    if (major === undefined) return undefined
    return { major, minor: int(v[1]) ?? 0 }
  }
  return undefined
}

function formatRange(pack: Record<string, unknown>): { min: PackVersion; max: PackVersion } | undefined {
  const base = packVersion(pack.pack_format)
  let min: PackVersion | undefined
  let max: PackVersion | undefined
  const sf = pack.supported_formats
  if (int(sf) !== undefined) {
    min = max = { major: int(sf) as number, minor: 0 }
  } else if (Array.isArray(sf)) {
    min = packVersion(sf[0])
    max = packVersion(sf[1] ?? sf[0])
  } else if (isObject(sf)) {
    min = packVersion(sf.min_inclusive)
    max = packVersion(sf.max_inclusive)
  }
  min = packVersion(pack.min_format) ?? min
  max = packVersion(pack.max_format) ?? max
  min ??= base ?? max
  max ??= base ?? min
  if (!min || !max) return undefined
  return { min, max }
}

/** Parse the text of a `pack.mcmeta` (lenient JSON). */
export function parsePackMcmeta(text: string): Omit<ResourcePackInfo, 'format' | 'icon' | 'nestedRoot'> {
  const parsed = parseLenientJson(text)
  if (!parsed.ok) {
    return { valid: false, description: '', descriptionPlain: '', warnings: [{ code: 'invalid-mcmeta', message: parsed.error }] }
  }
  const pack = isObject(parsed.value) && isObject(parsed.value.pack) ? parsed.value.pack : undefined
  if (!pack) {
    return { valid: false, description: '', descriptionPlain: '', warnings: [{ code: 'invalid-mcmeta', message: 'pack.mcmeta has no "pack" object' }] }
  }
  const description = flattenTextComponent(pack.description)
  const packFormat = int(pack.pack_format)
  return {
    valid: true,
    ...(packFormat !== undefined ? { packFormat } : {}),
    formats: formatRange(pack),
    description,
    descriptionPlain: stripFormatting(description),
    warnings: [],
  }
}

/** When the root holds exactly one folder and `marker(folder)` is true, that folder's name. */
export async function nestedRootWith(source: PackSource, marker: (dir: string) => Promise<boolean>): Promise<string | undefined> {
  const root = (await source.rootEntries()).filter((n) => n !== '__MACOSX/' && n !== '.DS_Store')
  const [only] = root
  if (root.length !== 1 || !only?.endsWith('/')) return undefined
  const dir = only.slice(0, -1)
  return (await marker(dir)) ? dir : undefined
}

/** Read a resource pack's metadata from an open {@link PackSource}. */
export async function readResourcePackFrom(source: PackSource): Promise<ResourcePackInfo> {
  const icon = (await source.hasFile('pack.png')) ? 'pack.png' : undefined
  if (!(await source.hasFile('pack.mcmeta'))) {
    const nestedRoot = await nestedRootWith(source, (d) => source.hasFile(`${d}/pack.mcmeta`))
    return {
      format: source.format,
      valid: false,
      description: '',
      descriptionPlain: '',
      ...(icon ? { icon } : {}),
      ...(nestedRoot !== undefined ? { nestedRoot } : {}),
      warnings: [
        nestedRoot !== undefined
          ? { code: 'nested-too-deep', message: `The pack is nested one folder too deep (inside "${nestedRoot}")` }
          : { code: 'missing-mcmeta', message: 'Not a valid resource pack: pack.mcmeta is missing' },
      ],
    }
  }
  let text: string
  try {
    const buf = await source.readBuffer('pack.mcmeta', 1024 * 1024)
    text = buf.toString('utf8')
  } catch (e) {
    if (isAbortError(e)) throw e
    return {
      format: source.format,
      valid: false,
      description: '',
      descriptionPlain: '',
      ...(icon ? { icon } : {}),
      warnings: [{ code: 'unreadable', message: e instanceof Error ? e.message : String(e) }],
    }
  }
  return { format: source.format, ...parsePackMcmeta(text), ...(icon ? { icon } : {}) }
}

/**
 * Read a resource pack (zip or folder): `pack.mcmeta` (format range and description) and
 * whether `pack.png` exists. Missing or malformed metadata is reported in `warnings` with
 * `valid: false`; it never throws for those.
 *
 * @throws {ContentError} `EINVALID_ZIP`, `ENOT_FOUND` or `EPERMISSION` when the pack cannot be opened.
 */
export async function readResourcePack(packPath: string, options: { signal?: AbortSignal } = {}): Promise<ResourcePackInfo> {
  throwIfAborted(options.signal)
  const source = await openPackSource(packPath)
  try {
    return await readResourcePackFrom(source)
  } finally {
    await source.close()
  }
}
