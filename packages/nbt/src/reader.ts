import { malformed } from './errors'
import { decodeMutf8 } from './mutf8'
import { NBT_TYPES, type NbtCompound, type NbtFile, type NbtList, type NbtTag, type NbtType } from './types'

/** Default maximum nesting depth of compounds and lists, matching Minecraft. */
export const DEFAULT_MAX_DEPTH = 512

/** Options for {@link decodeNbt}. */
export interface DecodeOptions {
  /** Maximum nesting depth of compounds/lists. Defaults to 512. */
  maxDepth?: number
}

/** Smallest possible encoded size of one payload of each type; used to sanity-check list lengths. */
const MIN_SIZE: Record<NbtType, number> = {
  end: 0,
  byte: 1,
  short: 2,
  int: 4,
  long: 8,
  float: 4,
  double: 8,
  byteArray: 4,
  string: 2,
  list: 5,
  compound: 1,
  intArray: 4,
  longArray: 4,
}

class Reader {
  pos = 0
  readonly view: DataView

  constructor(
    readonly bytes: Uint8Array,
    readonly maxDepth: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw malformed(`Unexpected end of NBT data at offset ${this.pos} (need ${n} bytes, ${this.bytes.length - this.pos} left)`)
    }
  }

  u8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  tagType(): NbtType {
    const at = this.pos
    const id = this.u8()
    const type = NBT_TYPES[id]
    if (type === undefined) throw malformed(`Unknown tag id ${id} at offset ${at}`)
    return type
  }

  length(elementSize: number): number {
    this.need(4)
    const n = this.view.getInt32(this.pos)
    if (n < 0) throw malformed(`Negative length ${n} at offset ${this.pos}`)
    this.pos += 4
    // Sanity check before allocating anything: the elements must fit in what is left.
    if (n * elementSize > this.bytes.length - this.pos) {
      throw malformed(`Length ${n} at offset ${this.pos - 4} exceeds remaining data`)
    }
    return n
  }

  string(): string {
    this.need(2)
    const len = this.view.getUint16(this.pos)
    this.pos += 2
    this.need(len)
    const s = decodeMutf8(this.bytes, this.pos, this.pos + len)
    this.pos += len
    return s
  }

  payload(type: NbtType, depth: number): NbtTag {
    const v = this.view
    switch (type) {
      case 'byte':
        this.need(1)
        return { type, value: v.getInt8(this.pos++) }
      case 'short': {
        this.need(2)
        const value = v.getInt16(this.pos)
        this.pos += 2
        return { type, value }
      }
      case 'int': {
        this.need(4)
        const value = v.getInt32(this.pos)
        this.pos += 4
        return { type, value }
      }
      case 'long': {
        this.need(8)
        const value = v.getBigInt64(this.pos)
        this.pos += 8
        return { type, value }
      }
      case 'float': {
        this.need(4)
        const value = v.getFloat32(this.pos)
        this.pos += 4
        return { type, value }
      }
      case 'double': {
        this.need(8)
        const value = v.getFloat64(this.pos)
        this.pos += 8
        return { type, value }
      }
      case 'byteArray': {
        const n = this.length(1)
        const value = new Int8Array(n)
        value.set(new Int8Array(this.bytes.buffer, this.bytes.byteOffset + this.pos, n))
        this.pos += n
        return { type, value }
      }
      case 'string':
        return { type, value: this.string() }
      case 'intArray': {
        const n = this.length(4)
        const value = new Int32Array(n)
        for (let i = 0; i < n; i++, this.pos += 4) value[i] = v.getInt32(this.pos)
        return { type, value }
      }
      case 'longArray': {
        const n = this.length(8)
        const value = new BigInt64Array(n)
        for (let i = 0; i < n; i++, this.pos += 8) value[i] = v.getBigInt64(this.pos)
        return { type, value }
      }
      case 'list':
        return this.list(depth + 1)
      case 'compound':
        return this.compound(depth + 1)
      case 'end':
        throw malformed(`Unexpected TAG_End at offset ${this.pos - 1}`)
    }
  }

  list(depth: number): NbtList {
    if (depth > this.maxDepth) throw malformed(`NBT nested deeper than ${this.maxDepth}`)
    const elementType = this.tagType()
    const n = this.length(MIN_SIZE[elementType])
    if (elementType === 'end' && n > 0) throw malformed(`List of TAG_End with non-zero length ${n}`)
    const value: NbtTag[] = Array.from({ length: n })
    for (let i = 0; i < n; i++) value[i] = this.payload(elementType, depth)
    return { type: 'list', elementType, value }
  }

  compound(depth: number): NbtCompound {
    if (depth > this.maxDepth) throw malformed(`NBT nested deeper than ${this.maxDepth}`)
    const value = new Map<string, NbtTag>()
    for (;;) {
      const type = this.tagType()
      if (type === 'end') break
      const name = this.string()
      value.set(name, this.payload(type, depth))
    }
    return { type: 'compound', value }
  }
}

/**
 * Decode uncompressed NBT bytes whose root is a named compound (the Java Edition file layout).
 * Trailing bytes after the root compound are ignored.
 *
 * Throws {@link NbtError} with code `ENBT_MALFORMED` for any invalid input.
 */
export function decodeNbt(bytes: Uint8Array, options: DecodeOptions = {}): NbtFile {
  const r = new Reader(bytes, options.maxDepth ?? DEFAULT_MAX_DEPTH)
  const type = r.tagType()
  if (type !== 'compound') throw malformed(`Root tag must be a compound, got ${type}`)
  const name = r.string()
  return { name, root: r.compound(1) }
}
