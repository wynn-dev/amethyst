/** Lenient field readers for untrusted JSON: each returns `undefined` when the value has the wrong shape. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})

export const readString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export const readBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** An integer within `[min, max]`. */
export function readInt(v: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
}

/** A finite number within `[min, max]`. */
export function readNumber(v: unknown, min = -Infinity, max = Infinity): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
}

export function readOneOf<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined
}

/** An array of strings (`undefined` if anything else is in it). */
export function readStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : undefined
}

/** A `Record<string, string>`. */
export function readStringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') return undefined
    out[k] = x
  }
  return out
}

/** `#rgb` / `#rrggbb` colours, normalised to lower-case `#rrggbb`. */
export function readColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return undefined
  const hex = (m[1] as string).toLowerCase()
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`
}
