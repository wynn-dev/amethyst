import { invalid } from './errors'
import { encodeMutf8Into, mutf8Length } from './mutf8'
import { DEFAULT_MAX_DEPTH } from './reader'
import { NBT_TAG_IDS, type NbtCompound, type NbtList, type NbtTag, type NbtType } from './types'

const INT32_MIN = -0x80000000
const INT32_MAX = 0x7fffffff

class Writer {
  buf = new Uint8Array(1024)
  view = new DataView(this.buf.buffer)
  pos = 0

  reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.reserve(1)
    this.buf[this.pos++] = v
  }

  i32(v: number): void {
    this.reserve(4)
    this.view.setInt32(this.pos, v)
    this.pos += 4
  }

  string(value: unknown, what: string): void {
    if (typeof value !== 'string') throw invalid(`${what} must be a string`)
    const len = mutf8Length(value)
    if (len > 0xffff) throw invalid(`${what} is ${len} bytes in modified UTF-8; the maximum is 65535`)
    this.reserve(2 + len)
    this.view.setUint16(this.pos, len)
    this.pos = encodeMutf8Into(value, this.buf, this.pos + 2)
  }

  payload(tag: NbtTag, depth: number): void {
    switch (tag.type) {
      case 'byte':
        this.reserve(1)
        this.view.setInt8(this.pos, checkInt(tag.value, -0x80, 0x7f, 'byte'))
        this.pos += 1
        return
      case 'short':
        this.reserve(2)
        this.view.setInt16(this.pos, checkInt(tag.value, -0x8000, 0x7fff, 'short'))
        this.pos += 2
        return
      case 'int':
        this.i32(checkInt(tag.value, INT32_MIN, INT32_MAX, 'int'))
        return
      case 'long':
        this.reserve(8)
        this.view.setBigInt64(this.pos, checkLong(tag.value))
        this.pos += 8
        return
      case 'float':
        this.reserve(4)
        this.view.setFloat32(this.pos, checkNumber(tag.value, 'float'))
        this.pos += 4
        return
      case 'double':
        this.reserve(8)
        this.view.setFloat64(this.pos, checkNumber(tag.value, 'double'))
        this.pos += 8
        return
      case 'byteArray': {
        const a = tag.value
        if (!(a instanceof Int8Array)) throw invalid('byteArray value must be an Int8Array')
        this.i32(a.length)
        this.reserve(a.length)
        this.buf.set(new Uint8Array(a.buffer, a.byteOffset, a.length), this.pos)
        this.pos += a.length
        return
      }
      case 'string':
        this.string(tag.value, 'string value')
        return
      case 'intArray': {
        const a = tag.value
        if (!(a instanceof Int32Array)) throw invalid('intArray value must be an Int32Array')
        this.i32(a.length)
        this.reserve(a.length * 4)
        for (let i = 0; i < a.length; i++, this.pos += 4) this.view.setInt32(this.pos, a[i] as number)
        return
      }
      case 'longArray': {
        const a = tag.value
        if (!(a instanceof BigInt64Array)) throw invalid('longArray value must be a BigInt64Array')
        this.i32(a.length)
        this.reserve(a.length * 8)
        for (let i = 0; i < a.length; i++, this.pos += 8) this.view.setBigInt64(this.pos, a[i] as bigint)
        return
      }
      case 'list':
        this.list(tag, depth + 1)
        return
      case 'compound':
        this.compound(tag, depth + 1)
        return
      default:
        throw invalid(`Unknown tag type ${JSON.stringify((tag as { type: unknown }).type)}`)
    }
  }

  list(tag: NbtList, depth: number): void {
    if (depth > DEFAULT_MAX_DEPTH) throw invalid(`NBT nested deeper than ${DEFAULT_MAX_DEPTH}`)
    const { elementType, value } = tag
    if (!Array.isArray(value)) throw invalid('list value must be an array')
    const id = tagId(elementType)
    if (elementType === 'end' && value.length > 0) throw invalid('Non-empty list cannot have element type end')
    this.u8(id)
    this.i32(value.length)
    for (const item of value) {
      if (item?.type !== elementType) throw invalid(`List of ${elementType} contains a ${String(item?.type)} tag`)
      this.payload(item, depth)
    }
  }

  compound(tag: NbtCompound, depth: number): void {
    if (depth > DEFAULT_MAX_DEPTH) throw invalid(`NBT nested deeper than ${DEFAULT_MAX_DEPTH}`)
    if (!(tag.value instanceof Map)) throw invalid('compound value must be a Map')
    for (const [key, child] of tag.value) {
      const id = tagId(child?.type)
      if (id === 0) throw invalid(`Compound key ${JSON.stringify(key)} holds a TAG_End`)
      this.u8(id)
      this.string(key, 'compound key')
      this.payload(child, depth)
    }
    this.u8(0)
  }
}

function tagId(type: unknown): number {
  const id = typeof type === 'string' && Object.hasOwn(NBT_TAG_IDS, type) ? NBT_TAG_IDS[type as NbtType] : undefined
  if (id === undefined) throw invalid(`Unknown tag type ${JSON.stringify(type)}`)
  return id
}

function checkInt(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${what} value ${String(v)} is not an integer in [${min}, ${max}]`)
  }
  return v
}

function checkLong(v: unknown): bigint {
  if (typeof v !== 'bigint' || BigInt.asIntN(64, v) !== v) throw invalid(`long value ${String(v)} is not a 64-bit signed bigint`)
  return v
}

function checkNumber(v: unknown, what: string): number {
  if (typeof v !== 'number') throw invalid(`${what} value must be a number`)
  return v
}

/**
 * Encode a document as uncompressed NBT: a named root compound (name defaults to `""`).
 *
 * Throws {@link NbtError} with code `ENBT_INVALID` when a value cannot be represented.
 */
export function encodeNbt(file: { name?: string; root: NbtCompound }): Buffer {
  const w = new Writer()
  if (file.root?.type !== 'compound') throw invalid('Root tag must be a compound')
  w.u8(NBT_TAG_IDS.compound)
  w.string(file.name ?? '', 'root name')
  w.compound(file.root, 1)
  return Buffer.from(w.buf.buffer, 0, w.pos)
}
