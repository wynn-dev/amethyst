import { readFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeMutf8,
  decodeNbt,
  detectCompression,
  encodeMutf8,
  encodeNbt,
  nbt,
  NbtError,
  readNbt,
  toPlain,
  writeNbt,
  type NbtCompound,
  type NbtTag,
} from './index'

const MALFORMED = expect.objectContaining({ name: 'NbtError', code: 'ENBT_MALFORMED' })
const INVALID = expect.objectContaining({ name: 'NbtError', code: 'ENBT_INVALID' })

const fixture = (name: string) => readFile(new URL(`./__fixtures__/${name}`, import.meta.url))

/** A compound containing every tag type, including edge values. */
function everyTag(): NbtCompound {
  return nbt.compound({
    byteMin: nbt.byte(-128),
    byteMax: nbt.byte(127),
    shortMin: nbt.short(-32768),
    shortMax: nbt.short(32767),
    intMin: nbt.int(-2147483648),
    intMax: nbt.int(2147483647),
    longMin: nbt.long(-(2n ** 63n)),
    longMax: nbt.long(2n ** 63n - 1n),
    float: nbt.float(3.14159),
    floatNegZero: nbt.float(-0),
    floatInf: nbt.float(Infinity),
    double: nbt.double(Math.PI),
    doubleNaN: nbt.double(Number.NaN),
    byteArray: nbt.byteArray([0, 1, -1, 127, -128]),
    emptyByteArray: nbt.byteArray([]),
    string: nbt.string('hello'),
    emptyString: nbt.string(''),
    unicode: nbt.string('nul\u0000 é ✦ 😀 \u{10FFFF}'),
    listOfInts: nbt.list([nbt.int(1), nbt.int(2)]),
    emptyList: nbt.list([]),
    emptyTypedList: nbt.list([], 'compound'),
    listOfLists: nbt.list([nbt.list([nbt.string('a')]), nbt.list([])]),
    listOfCompounds: nbt.list([nbt.compound({ a: nbt.byte(1) }), nbt.compound()]),
    nested: nbt.compound({ deeper: nbt.compound({ x: nbt.double(-0.5) }) }),
    intArray: nbt.intArray([-2147483648, 0, 2147483647]),
    longArray: nbt.longArray([-(2n ** 63n), 0n, 2n ** 63n - 1n]),
    // Integer-like keys must keep insertion order (plain objects would reorder them).
    '2': nbt.byte(2),
    '1': nbt.byte(1),
    ['__proto__']: nbt.string('not a prototype'),
  } as Record<string, NbtTag>)
}

describe('round trip', () => {
  it('preserves every tag type exactly', async () => {
    const root = everyTag()
    for (const compression of ['none', 'gzip', 'zlib'] as const) {
      const bytes = await writeNbt({ name: 'root name', root }, { compression })
      const back = await readNbt(bytes)
      expect(back.compression).toBe(compression)
      expect(back.name).toBe('root name')
      expect(back.root).toEqual(root)
      expect([...back.root.value.keys()]).toEqual([...root.value.keys()])
      // Re-encoding gives identical bytes.
      expect(encodeNbt(back)).toEqual(encodeNbt({ name: 'root name', root }))
    }
  })

  it('keeps numeric widths and typed arrays', () => {
    const back = decodeNbt(encodeNbt({ root: everyTag() })).root.value
    expect(back.get('byteMax')).toEqual({ type: 'byte', value: 127 })
    expect(back.get('longMin')?.value).toBe(-(2n ** 63n))
    expect(back.get('byteArray')?.value).toBeInstanceOf(Int8Array)
    expect(back.get('intArray')?.value).toBeInstanceOf(Int32Array)
    expect(back.get('longArray')?.value).toBeInstanceOf(BigInt64Array)
    expect(back.get('float')?.value).toBe(Math.fround(3.14159))
    expect(Object.is(back.get('floatNegZero')?.value, -0)).toBe(true)
    expect(back.get('emptyTypedList')).toEqual({ type: 'list', elementType: 'compound', value: [] })
    expect(back.get('__proto__')).toEqual({ type: 'string', value: 'not a prototype' })
  })

  it('defaults the root name to an empty string', () => {
    const bytes = encodeNbt({ root: nbt.compound() })
    expect([...bytes]).toEqual([0x0a, 0x00, 0x00, 0x00])
    expect(decodeNbt(bytes).name).toBe('')
  })

  it('does not alias the input buffer', () => {
    const bytes = encodeNbt({ root: nbt.compound({ b: nbt.byteArray([1, 2, 3]) }) })
    const decoded = decodeNbt(bytes)
    bytes.fill(0)
    expect(Array.from(decoded.root.value.get('b')?.value as Int8Array)).toEqual([1, 2, 3])
  })
})

describe('compression detection', () => {
  const raw = encodeNbt({ root: nbt.compound({ a: nbt.int(1) }) })

  it('detects gzip, zlib and raw', async () => {
    expect(detectCompression(gzipSync(raw))).toBe('gzip')
    expect(detectCompression(await writeNbt({ root: nbt.compound() }, { compression: 'zlib' }))).toBe('zlib')
    expect(detectCompression(raw)).toBe('none')
    expect(detectCompression(new Uint8Array())).toBe('none')
  })

  it('honours a forced compression', async () => {
    await expect(readNbt(raw, { compression: 'gzip' })).rejects.toMatchObject({ code: 'ENBT_MALFORMED' })
  })

  it('rejects corrupt streams and decompression bombs', async () => {
    const gz = gzipSync(raw)
    await expect(readNbt(gz.subarray(0, gz.length - 6))).rejects.toMatchObject({ code: 'ENBT_MALFORMED' })
    const bomb = gzipSync(Buffer.alloc(1024 * 1024))
    await expect(readNbt(bomb, { maxDecompressedBytes: 1024 })).rejects.toMatchObject({ code: 'ENBT_MALFORMED' })
  })
})

describe('modified UTF-8', () => {
  it('encodes NUL as C0 80', () => {
    expect([...encodeMutf8('\u0000')]).toEqual([0xc0, 0x80])
    expect(decodeMutf8(Uint8Array.of(0x61, 0xc0, 0x80, 0x62), 0, 4)).toBe('a\u0000b')
  })

  it('encodes supplementary characters as surrogate pairs (6 bytes)', () => {
    const bytes = encodeMutf8('😀')
    expect([...bytes]).toEqual([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80])
    expect(decodeMutf8(bytes, 0, bytes.length)).toBe('😀')
  })

  it('handles 2- and 3-byte BMP characters and lone surrogates', () => {
    for (const s of ['é', '߿', 'ࠀ', '✦', '￿', '\ud800', 'x\udc00y']) {
      const bytes = encodeMutf8(s)
      expect(decodeMutf8(bytes, 0, bytes.length)).toBe(s)
    }
    expect([...encodeMutf8('é')]).toEqual([0xc3, 0xa9])
  })

  it('round-trips long strings across chunk boundaries', () => {
    const s = 'aé✦😀'.repeat(5000)
    const bytes = encodeMutf8(s)
    expect(decodeMutf8(bytes, 0, bytes.length)).toBe(s)
  })

  it('rejects invalid sequences', () => {
    const bad = [[0x00], [0x80], [0xf0, 0x9f, 0x98, 0x80], [0xc3], [0xe2, 0x9c], [0xc3, 0x41]]
    for (const b of bad) {
      expect(() => decodeMutf8(Uint8Array.from(b), 0, b.length)).toThrow(NbtError)
    }
  })

  it('uses an unsigned 16-bit length for strings of 32768–65535 encoded bytes', () => {
    // 40,000 bytes would read back as a negative length with a signed 16-bit reader.
    const value = `${'a'.repeat(39_990)}\u0000😀`
    const bytes = encodeNbt({ root: nbt.compound({ s: nbt.string(value) }) })
    const at = 1 + 2 + 1 + 2 + 1 // root type, empty root name, child type, child name length, 's'
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(at)).toBe(39_990 + 2 + 6)
    expect(decodeNbt(bytes).root.value.get('s')).toEqual({ type: 'string', value })
    const max = 'a'.repeat(65_535)
    expect(decodeNbt(encodeNbt({ root: nbt.compound({ s: nbt.string(max) }) })).root.value.get('s')).toEqual({ type: 'string', value: max })
  })

  it('rejects strings longer than 65535 encoded bytes on write', () => {
    expect(() => encodeNbt({ root: nbt.compound({ s: nbt.string('✦'.repeat(21846)) }) })).toThrow(
      expect.objectContaining({ code: 'ENBT_INVALID' }),
    )
    expect(() => encodeNbt({ root: nbt.compound({ s: nbt.string('a'.repeat(65535)) }) })).not.toThrow()
  })
})

describe('level.dat fixture', () => {
  it('reads a handcrafted gzip level.dat', async () => {
    const bytes = await fixture('level.dat')
    const file = await readNbt(bytes)
    expect(file.compression).toBe('gzip')
    expect(file.name).toBe('')
    const data = file.root.value.get('Data')
    expect(data?.type).toBe('compound')

    const plain = toPlain(file.root)
    expect(plain).toMatchObject({
      Data: {
        DataVersion: 3955,
        LevelName: 'Amethyst ✦ Test 😀',
        LastPlayed: 1729800000000n,
        RandomSeed: -4530634556500121041n,
        allowCommands: 1,
        SpawnZ: -16,
        BorderSize: 5.9999968e7,
        Version: { Id: 3955, Name: '1.21.1', Series: 'main', Snapshot: 0 },
        DataPacks: { Enabled: ['vanilla', 'file/nul\u0000pack'], Disabled: [] },
        GameRules: { doDaylightCycle: 'true' },
        Player: { Pos: [0.5, 64, -15.5], Rotation: [90, 0], Inventory: [], UUID: [1, -2, 3, -4], Air: 300 },
        ServerBrands: ['vanilla'],
      },
    })
    expect(toPlain(file.root, { longs: 'string' })).toMatchObject({ Data: { RandomSeed: '-4530634556500121041' } })
    expect(toPlain(file.root, { longs: 'number' })).toMatchObject({ Data: { LastPlayed: 1729800000000 } })

    const dataTag = file.root.value.get('Data') as NbtCompound
    expect(dataTag.value.get('Difficulty')).toEqual({ type: 'byte', value: 2 })
    expect(dataTag.value.get('BorderSize')?.type).toBe('double')
    const player = dataTag.value.get('Player') as NbtCompound
    expect(player.value.get('Inventory')).toEqual({ type: 'list', elementType: 'compound', value: [] })
    expect(player.value.get('Rotation')).toMatchObject({ elementType: 'float' })
  })

  it('re-encodes the fixture byte for byte', async () => {
    const bytes = await fixture('level.dat')
    const file = await readNbt(bytes)
    expect(encodeNbt(file)).toEqual(gunzipSync(bytes))
  })
})

/** `depth` nested compounds, counting the root. */
function nestedCompounds(depth: number): Uint8Array {
  const head = [0x0a, 0, 0]
  for (let i = 1; i < depth; i++) head.push(0x0a, 0, 0)
  return Uint8Array.from([...head, ...Array.from({ length: depth }, () => 0)])
}

describe('malformed input', () => {
  it('rejects empty and truncated input at every offset', () => {
    const good = encodeNbt({ root: everyTag() })
    expect(() => decodeNbt(new Uint8Array())).toThrow(MALFORMED)
    for (let i = 0; i < good.length; i++) expect(() => decodeNbt(good.subarray(0, i))).toThrow(MALFORMED)
  })

  it('rejects a non-compound root and unknown tag ids', () => {
    expect(() => decodeNbt(Uint8Array.of(0x01, 0x00, 0x00, 0x05))).toThrow(MALFORMED)
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00))).toThrow(MALFORMED)
  })

  it('rejects negative and oversized lengths before allocating', () => {
    // byte array with length -1
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0, 0, 0x07, 0, 1, 0x61, 0xff, 0xff, 0xff, 0xff, 0))).toThrow(MALFORMED)
    // int array claiming 2^30 elements
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0, 0, 0x0b, 0, 1, 0x61, 0x40, 0, 0, 0, 0))).toThrow(MALFORMED)
    // list of longs claiming 1000 elements
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0, 0, 0x09, 0, 1, 0x61, 0x04, 0, 0, 0x03, 0xe8, 0))).toThrow(MALFORMED)
    // list of compounds claiming more elements than bytes left
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0, 0, 0x09, 0, 1, 0x61, 0x0a, 0x7f, 0xff, 0xff, 0xff, 0))).toThrow(MALFORMED)
    // list of TAG_End with a non-zero length
    expect(() => decodeNbt(Uint8Array.of(0x0a, 0, 0, 0x09, 0, 1, 0x61, 0x00, 0, 0, 0, 1, 0))).toThrow(MALFORMED)
  })

  it('caps nesting depth at 512', () => {
    expect(() => decodeNbt(nestedCompounds(512))).not.toThrow()
    expect(() => decodeNbt(nestedCompounds(513))).toThrow(MALFORMED)
    expect(() => decodeNbt(nestedCompounds(20), { maxDepth: 10 })).toThrow(NbtError)

    // Lists count too: a root containing 600 nested lists.
    const lists = [0x0a, 0, 0, 0x09, 0, 0]
    for (let i = 0; i < 600; i++) lists.push(0x09, 0, 0, 0, 1)
    expect(() => decodeNbt(Uint8Array.from(lists))).toThrow(/deeper than 512/)
  })
})

describe('writer validation', () => {
  it('rejects out-of-range and mistyped values', () => {
    expect(() => encodeNbt({ root: nbt.compound({ a: nbt.byte(128) }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: nbt.short(1.5) }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: nbt.int(2 ** 31) }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: { type: 'long', value: 2n ** 63n } }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: { type: 'long', value: 1 } as unknown as NbtTag }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: { type: 'byteArray', value: [1, 2] } as unknown as NbtTag }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: { type: 'bogus', value: 1 } as unknown as NbtTag }) })).toThrow(INVALID)
  })

  it('rejects heterogeneous and inconsistent lists', () => {
    expect(() => encodeNbt({ root: nbt.compound({ a: nbt.list<NbtTag>([nbt.int(1), nbt.byte(1)]) }) })).toThrow(INVALID)
    expect(() => encodeNbt({ root: nbt.compound({ a: { type: 'list', elementType: 'end', value: [nbt.int(1)] } }) })).toThrow(INVALID)
  })

  it('rejects cyclic structures via the depth limit', () => {
    const a = nbt.compound()
    a.value.set('self', a)
    expect(() => encodeNbt({ root: a })).toThrow(INVALID)
  })
})

describe.runIf(process.env.AMETHYST_BENCH)('benchmark', () => {
  it('reads and writes a ~1 MB compound', async () => {
    const items: NbtCompound[] = []
    for (let i = 0; i < 9000; i++) {
      items.push(
        nbt.compound({
          id: nbt.string(`minecraft:item_${i}`),
          Count: nbt.byte(i % 64),
          Slot: nbt.int(i),
          tag: nbt.compound({ Damage: nbt.short(i % 1000), seed: nbt.long(BigInt(i) * 7919n), pos: nbt.intArray([i, i, i]) }),
        }),
      )
    }
    const root = nbt.compound({ items: nbt.list(items), blob: nbt.longArray(new BigInt64Array(20000)) })
    const raw = encodeNbt({ root })
    expect(raw.length).toBeGreaterThan(1_000_000)
    const rounds = 20
    let t = performance.now()
    for (let i = 0; i < rounds; i++) decodeNbt(raw)
    const decodeMs = (performance.now() - t) / rounds
    t = performance.now()
    for (let i = 0; i < rounds; i++) encodeNbt({ root })
    const encodeMs = (performance.now() - t) / rounds
    const gz = await writeNbt({ root }, { compression: 'gzip' })
    t = performance.now()
    await readNbt(gz)
    const gzipReadMs = performance.now() - t
    console.warn(
      `nbt bench (${(raw.length / 1e6).toFixed(2)} MB): decode ${decodeMs.toFixed(1)} ms, encode ${encodeMs.toFixed(1)} ms, gzip read ${gzipReadMs.toFixed(1)} ms`,
    )
  })
})
