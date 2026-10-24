import type { NbtCompound, NbtTag } from './types'

/** Plain JS rendering of an NBT value, see {@link toPlain}. */
export type NbtPlain = number | bigint | string | NbtPlain[] | NbtPlainObject
/** Plain JS rendering of a compound. */
export interface NbtPlainObject {
  [key: string]: NbtPlain
}

/** Options for {@link toPlain}. */
export interface ToPlainOptions {
  /**
   * How to render longs (TAG_Long and TAG_Long_Array elements):
   * `bigint` (default, lossless), `number` (lossy above 2^53), or decimal `string`.
   */
  longs?: 'bigint' | 'number' | 'string'
}

/**
 * Convert a tag into plain JS values for read-only use (display, JSON-ish inspection).
 * Numeric widths are erased, typed arrays become arrays and compounds become objects.
 * The result is lossy: use the typed model to modify and write files.
 */
export function toPlain(tag: NbtCompound, options?: ToPlainOptions): NbtPlainObject
export function toPlain(tag: NbtTag, options?: ToPlainOptions): NbtPlain
export function toPlain(tag: NbtTag, options: ToPlainOptions = {}): NbtPlain {
  const long = (v: bigint): number | bigint | string =>
    options.longs === 'number' ? Number(v) : options.longs === 'string' ? v.toString() : v
  const convert = (t: NbtTag): NbtPlain => {
    switch (t.type) {
      case 'byte':
      case 'short':
      case 'int':
      case 'float':
      case 'double':
      case 'string':
        return t.value
      case 'long':
        return long(t.value)
      case 'byteArray':
      case 'intArray':
        return Array.from(t.value)
      case 'longArray':
        return Array.from(t.value, long)
      case 'list':
        return t.value.map(convert)
      case 'compound':
        // Object.fromEntries defines own properties, so a "__proto__" key cannot alter the prototype.
        return Object.fromEntries(Array.from(t.value, ([k, v]) => [k, convert(v)]))
    }
  }
  return convert(tag)
}
