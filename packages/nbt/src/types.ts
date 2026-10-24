/**
 * Typed, lossless model of Java Edition NBT values.
 *
 * Every tag is a plain object with a `type` discriminant. Numeric widths are kept explicit
 * (`byte` vs `int` vs `double`), longs are `bigint`, and array tags use typed arrays, so
 * reading and re-writing a file reproduces it byte for byte (modulo compression).
 */

/** Name of an NBT tag type. `end` only appears as the element type of an empty list. */
export type NbtType =
  | 'end'
  | 'byte'
  | 'short'
  | 'int'
  | 'long'
  | 'float'
  | 'double'
  | 'byteArray'
  | 'string'
  | 'list'
  | 'compound'
  | 'intArray'
  | 'longArray'

/** Tag type names indexed by their on-disk id (0–12). */
export const NBT_TYPES: readonly NbtType[] = [
  'end',
  'byte',
  'short',
  'int',
  'long',
  'float',
  'double',
  'byteArray',
  'string',
  'list',
  'compound',
  'intArray',
  'longArray',
]

/** On-disk id (0–12) for each tag type name. */
export const NBT_TAG_IDS: Readonly<Record<NbtType, number>> = Object.freeze(
  Object.fromEntries(NBT_TYPES.map((t, i) => [t, i])) as Record<NbtType, number>,
)

/** TAG_Byte: signed 8-bit integer. */
export interface NbtByte {
  type: 'byte'
  value: number
}
/** TAG_Short: signed 16-bit integer. */
export interface NbtShort {
  type: 'short'
  value: number
}
/** TAG_Int: signed 32-bit integer. */
export interface NbtInt {
  type: 'int'
  value: number
}
/** TAG_Long: signed 64-bit integer. */
export interface NbtLong {
  type: 'long'
  value: bigint
}
/** TAG_Float: IEEE-754 single precision. */
export interface NbtFloat {
  type: 'float'
  value: number
}
/** TAG_Double: IEEE-754 double precision. */
export interface NbtDouble {
  type: 'double'
  value: number
}
/** TAG_Byte_Array. */
export interface NbtByteArray {
  type: 'byteArray'
  value: Int8Array
}
/** TAG_String (modified UTF-8 on disk, at most 65535 encoded bytes). */
export interface NbtString {
  type: 'string'
  value: string
}
/**
 * TAG_List: a homogeneous list. `elementType` is kept even for empty lists so it round-trips;
 * it must be `end` only when the list is empty.
 */
export interface NbtList<T extends NbtTag = NbtTag> {
  type: 'list'
  elementType: NbtType
  value: T[]
}
/** TAG_Compound: named tags in insertion order. */
export interface NbtCompound {
  type: 'compound'
  value: Map<string, NbtTag>
}
/** TAG_Int_Array. */
export interface NbtIntArray {
  type: 'intArray'
  value: Int32Array
}
/** TAG_Long_Array. */
export interface NbtLongArray {
  type: 'longArray'
  value: BigInt64Array
}

/** Any NBT tag except TAG_End. */
export type NbtTag =
  | NbtByte
  | NbtShort
  | NbtInt
  | NbtLong
  | NbtFloat
  | NbtDouble
  | NbtByteArray
  | NbtString
  | NbtList
  | NbtCompound
  | NbtIntArray
  | NbtLongArray

/** The tag interface for a given type name, e.g. `NbtTagOf<'int'>` is {@link NbtInt}. */
export type NbtTagOf<K extends NbtTag['type']> = Extract<NbtTag, { type: K }>

/** Compression applied around the NBT payload. */
export type NbtCompression = 'gzip' | 'zlib' | 'none'

/** A decoded NBT document: the root compound and its name (usually `""`). */
export interface NbtFile {
  name: string
  root: NbtCompound
}

/** Result of {@link readNbt}: the document plus the compression that was detected. */
export interface NbtReadResult extends NbtFile {
  compression: NbtCompression
}

/** Convenience constructors for building tags by hand. */
export const nbt = {
  byte: (value: number): NbtByte => ({ type: 'byte', value }),
  short: (value: number): NbtShort => ({ type: 'short', value }),
  int: (value: number): NbtInt => ({ type: 'int', value }),
  long: (value: bigint | number): NbtLong => ({ type: 'long', value: BigInt(value) }),
  float: (value: number): NbtFloat => ({ type: 'float', value: Math.fround(value) }),
  double: (value: number): NbtDouble => ({ type: 'double', value }),
  string: (value: string): NbtString => ({ type: 'string', value }),
  byteArray: (value: Int8Array | ArrayLike<number>): NbtByteArray => ({
    type: 'byteArray',
    value: value instanceof Int8Array ? value : Int8Array.from(value),
  }),
  intArray: (value: Int32Array | ArrayLike<number>): NbtIntArray => ({
    type: 'intArray',
    value: value instanceof Int32Array ? value : Int32Array.from(value),
  }),
  longArray: (value: BigInt64Array | ArrayLike<bigint>): NbtLongArray => ({
    type: 'longArray',
    value: value instanceof BigInt64Array ? value : BigInt64Array.from(value),
  }),
  /** Build a list. The element type is inferred from the first element unless given (`end` when empty). */
  list: <T extends NbtTag>(value: T[], elementType?: NbtType): NbtList<T> => ({
    type: 'list',
    elementType: elementType ?? value[0]?.type ?? 'end',
    value,
  }),
  /** Build a compound from an object or an iterable of `[key, tag]` pairs (order is preserved). */
  compound: (entries: Record<string, NbtTag> | Iterable<readonly [string, NbtTag]> = {}): NbtCompound => ({
    type: 'compound',
    value: new Map(Symbol.iterator in entries ? (entries as Iterable<readonly [string, NbtTag]>) : Object.entries(entries)),
  }),
}
