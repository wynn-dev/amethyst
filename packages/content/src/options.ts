/**
 * `options.txt` reading and writing. The file is a list of `key:value` lines; unknown keys,
 * their order and any other lines are preserved exactly, so the launcher only changes what it
 * edits.
 */
import { readFile } from 'node:fs/promises'
import { wrapFsError } from './errors'
import { writeFileAtomic } from './util/fs'

type Line = { kind: 'entry'; key: string; value: string } | { kind: 'raw'; text: string }

/** A parsed `options.txt`. Edits keep every untouched line verbatim; new keys are appended. */
export class GameOptions {
  readonly #lines: Line[]
  readonly #eol: string
  readonly #trailingNewline: boolean

  private constructor(lines: Line[], eol: string, trailingNewline: boolean) {
    this.#lines = lines
    this.#eol = eol
    this.#trailingNewline = trailingNewline
  }

  /** Parse the text of an `options.txt`. Never throws; lines without a `:` are kept as-is. */
  static parse(text: string): GameOptions {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const eol = body.includes('\r\n') ? '\r\n' : '\n'
    const trailingNewline = body === '' || body.endsWith('\n')
    const rawLines = body.split(/\r?\n/)
    if (trailingNewline) rawLines.pop()
    const lines = rawLines.map((raw): Line => {
      const colon = raw.indexOf(':')
      return colon > 0 ? { kind: 'entry', key: raw.slice(0, colon), value: raw.slice(colon + 1) } : { kind: 'raw', text: raw }
    })
    return new GameOptions(lines, eol, trailingNewline)
  }

  /** An empty options file. */
  static empty(): GameOptions {
    return GameOptions.parse('')
  }

  #find(key: string) {
    return this.#lines.find((l): l is Extract<Line, { kind: 'entry' }> => l.kind === 'entry' && l.key === key)
  }

  /** The raw value of `key` (everything after the first `:`), or `undefined`. */
  get(key: string): string | undefined {
    return this.#find(key)?.value
  }

  has(key: string): boolean {
    return this.#find(key) !== undefined
  }

  /** Set `key`, replacing its value in place, or appending a new line when it does not exist yet. */
  set(key: string, value: string | number | boolean): this {
    if (key === '' || key.includes(':') || /[\r\n]/.test(key)) throw new RangeError(`Invalid options key ${JSON.stringify(key)}`)
    const v = String(value)
    if (/[\r\n]/.test(v)) throw new RangeError(`Option values cannot contain line breaks (${key})`)
    const line = this.#find(key)
    if (line) line.value = v
    else this.#lines.push({ kind: 'entry', key, value: v })
    return this
  }

  /** Remove `key` (every occurrence). */
  delete(key: string): boolean {
    let removed = false
    for (let i = this.#lines.length - 1; i >= 0; i--) {
      const l = this.#lines[i] as Line
      if (l.kind === 'entry' && l.key === key) {
        this.#lines.splice(i, 1)
        removed = true
      }
    }
    return removed
  }

  /** Keys in file order. */
  keys(): string[] {
    return this.#lines.flatMap((l) => (l.kind === 'entry' ? [l.key] : []))
  }

  /** All entries as an ordered list of `[key, value]`. */
  entries(): [string, string][] {
    return this.#lines.flatMap((l): [string, string][] => (l.kind === 'entry' ? [[l.key, l.value]] : []))
  }

  /** Serialise back to text, using the original line endings. */
  toString(): string {
    const text = this.#lines.map((l) => (l.kind === 'entry' ? `${l.key}:${l.value}` : l.text)).join(this.#eol)
    return this.#trailingNewline && this.#lines.length > 0 ? text + this.#eol : text
  }

  /** `resourcePacks` as a list (bottom-to-top priority: later entries override earlier ones). */
  get resourcePacks(): string[] {
    return parsePackList(this.get('resourcePacks'))
  }

  set resourcePacks(ids: readonly string[]) {
    this.set('resourcePacks', serializePackList(ids))
  }

  /** `incompatibleResourcePacks`: packs the player accepted despite a format mismatch. */
  get incompatibleResourcePacks(): string[] {
    return parsePackList(this.get('incompatibleResourcePacks'))
  }

  set incompatibleResourcePacks(ids: readonly string[]) {
    this.set('incompatibleResourcePacks', serializePackList(ids))
  }
}

/**
 * Parse a pack list value such as `["vanilla","file/x.zip"]`. Truncated or garbled values
 * (partial writes by other tools) are salvaged by collecting the complete quoted strings.
 * Never throws; a missing or hopeless value is an empty list.
 */
export function parsePackList(value: string | undefined): string[] {
  if (value === undefined) return []
  const v = value.trim()
  if (v === '') return []
  try {
    const parsed: unknown = JSON.parse(v)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // Fall through to the tolerant scan.
  }
  const out: string[] = []
  for (const m of v.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      out.push(JSON.parse(`"${m[1] as string}"`) as string)
    } catch {
      out.push(m[1] as string)
    }
  }
  return out
}

/** Encode a pack list as the one-line JSON array the game writes. */
export function serializePackList(ids: readonly string[]): string {
  return JSON.stringify([...ids])
}

/**
 * The `options.txt` id of a launcher-managed resource pack: `file/<exact name on disk>`. For a
 * zip that is the file name including `.zip`; for a folder pack it is the folder name as is,
 * **without** any added extension.
 */
export function resourcePackId(nameOnDisk: string): string {
  return `file/${nameOnDisk}`
}

/** True for ids of packs in the instance's `resourcepacks/` folder (as opposed to built-in or mod packs). */
export function isFilePackId(id: string): boolean {
  return id.startsWith('file/')
}

/** Inverse of {@link resourcePackId}: the name on disk, or `undefined` for non-file ids. */
export function packNameFromId(id: string): string | undefined {
  return isFilePackId(id) ? id.slice('file/'.length) : undefined
}

/**
 * Enable a pack: move it to the top-priority end of the list (the end of the array). Other
 * entries, including built-in and mod-provided packs, are preserved untouched. Adds `vanilla`
 * at the bottom when the list was empty, as the game does.
 */
export function enableResourcePack(list: readonly string[], id: string): string[] {
  const out = list.filter((x) => x !== id)
  if (out.length === 0) out.push('vanilla')
  out.push(id)
  return out
}

/** Disable a pack: remove its id from the list. */
export function disableResourcePack(list: readonly string[], id: string): string[] {
  return list.filter((x) => x !== id)
}

/**
 * Reorder the enabled file packs. `topFirst` lists file pack ids as the UI shows them
 * (highest priority first); non-file entries keep their positions relative to the start and
 * file entries are rewritten after them in priority order.
 */
export function orderResourcePacks(list: readonly string[], topFirst: readonly string[]): string[] {
  const others = list.filter((x) => !isFilePackId(x))
  return [...others, ...topFirst.toReversed()]
}

/** Read `options.txt`. A missing file yields an empty {@link GameOptions}. */
export async function readOptionsFile(file: string): Promise<GameOptions> {
  try {
    return GameOptions.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return GameOptions.empty()
    throw wrapFsError(e, `Cannot read ${file}`)
  }
}

/** Write `options.txt` atomically (temporary file + rename). Do not call while the game is running. */
export async function writeOptionsFile(file: string, options: GameOptions): Promise<void> {
  try {
    await writeFileAtomic(file, options.toString())
  } catch (e) {
    throw wrapFsError(e, `Cannot write ${file}`)
  }
}
