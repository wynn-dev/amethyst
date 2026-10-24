/**
 * Minimal shape checks for untrusted API responses.
 *
 * The validators check what the clients and mappers rely on (ids, arrays, envelopes) and
 * throw a plain `Error` otherwise; the transport converts that into
 * `MarketplaceError('EBAD_RESPONSE')`. Optional fields are read defensively by the mappers
 * instead of being validated up front, so an API adding or dropping a cosmetic field does
 * not break the launcher.
 */

export type Rec = Record<string, unknown>

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function record(v: unknown, what: string): Rec {
  if (!isRecord(v)) throw new Error(`${what} is not an object`)
  return v
}

export function array(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not an array`)
  return v
}

/** Asserts `v` is an object whose `key` is a string or a number (an id). */
export function withId<T>(v: unknown, what: string, key = 'id'): T {
  const o = record(v, what)
  const id = o[key]
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`${what}.${key} is missing`)
  return o as T
}

export function arrayOf<T>(v: unknown, what: string, item: (x: unknown, what: string) => T): T[] {
  return array(v, what).map((x, i) => item(x, `${what}[${i}]`))
}

/** CurseForge wraps payloads as `{ data, pagination? }`. */
export function cfData(v: unknown): unknown {
  const o = record(v, 'response')
  if (!('data' in o)) throw new Error('response.data is missing')
  return o.data
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
