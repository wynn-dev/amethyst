import { describe, expect, it } from 'vitest'
import {
  countFingerprintBytes,
  curseforgeFingerprint,
  curseforgeFingerprintSync,
  FingerprintHasher,
} from './fingerprint'

/**
 * Independent reference: strip whitespace into a new array, then textbook MurmurHash2-32
 * using BigInt arithmetic (no Math.imul, no streaming state) so it shares no code paths with
 * the implementation under test.
 */
function reference(bytes: Uint8Array, seed = 1n): number {
  const M = 0x5bd1e995n
  const MASK = 0xffffffffn
  const mul = (a: bigint, b: bigint) => (a * b) & MASK
  const d = [...bytes].filter((b) => b !== 9 && b !== 10 && b !== 13 && b !== 32)
  let len = d.length
  let h = (seed ^ BigInt(len)) & MASK
  let i = 0
  while (len >= 4) {
    let k = BigInt(d[i]!) | (BigInt(d[i + 1]!) << 8n) | (BigInt(d[i + 2]!) << 16n) | (BigInt(d[i + 3]!) << 24n)
    k = mul(k, M)
    k ^= k >> 24n
    k = mul(k, M)
    h = mul(h, M) ^ k
    i += 4
    len -= 4
  }
  if (len === 3) h ^= BigInt(d[i + 2]!) << 16n
  if (len >= 2) h ^= BigInt(d[i + 1]!) << 8n
  if (len >= 1) {
    h ^= BigInt(d[i]!)
    h = mul(h, M)
  }
  h ^= h >> 13n
  h = mul(h, M)
  h ^= h >> 15n
  return Number(h)
}

const enc = (s: string) => new TextEncoder().encode(s)

/** Small deterministic PRNG so the "random" buffers are reproducible. */
function randomBytes(n: number, seed: number, whitespaceBias = false): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = whitespaceBias && x % 4 === 0 ? [9, 10, 13, 32][x % 3]! : x & 0xff
  }
  return out
}

async function* chunked(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}

describe('curseforge fingerprint (murmur2, seed 1, whitespace stripped)', () => {
  // Hand-checked: empty input gives h = 1, avalanche → 0x5bd15e36.
  const vectors: [string, number][] = [
    ['', 1540447798],
    ['a', 626045324],
    ['ab', 1692487918],
    ['abc', 1621425345],
    ['abcd', 3376380438],
    ['Hello, World!', 1961219979],
    ['hello world\r\n\t', 2824650221],
    ['The quick brown fox jumps over the lazy dog', 3751777527],
  ]

  it.each(vectors)('fingerprint(%j) = %i', (input, expected) => {
    expect(curseforgeFingerprintSync(enc(input))).toBe(expected)
    expect(reference(enc(input))).toBe(expected)
  })

  it('hashes bytes 0..255', () => {
    expect(curseforgeFingerprintSync(Uint8Array.from({ length: 256 }, (_, i) => i))).toBe(2094645347)
  })

  it('ignores tab, LF, CR and space everywhere', () => {
    expect(curseforgeFingerprintSync(enc(' a\tb\nc\rd '))).toBe(curseforgeFingerprintSync(enc('abcd')))
    expect(curseforgeFingerprintSync(enc(' \t\r\n'))).toBe(curseforgeFingerprintSync(new Uint8Array()))
    // Other control bytes are kept.
    expect(curseforgeFingerprintSync(enc('a\vb'))).not.toBe(curseforgeFingerprintSync(enc('ab')))
  })

  it('matches the reference on random buffers of every tail length', () => {
    for (let n = 0; n < 70; n++) {
      const data = randomBytes(n * 7 + (n % 4), n + 1, n % 2 === 0)
      const result = curseforgeFingerprintSync(data)
      expect(result).toBe(reference(data))
      expect(Number.isInteger(result) && result >= 0 && result <= 0xffffffff).toBe(true)
    }
  })

  it('is independent of chunk boundaries (one-shot stream and two-pass factory)', async () => {
    const data = randomBytes(10_000, 42, true)
    const expected = reference(data)
    const sizes = [1, 3, 4, 5, 1000, 65536]
    const results = await Promise.all([
      ...sizes.map((size) => curseforgeFingerprint(chunked(data, size))),
      ...sizes.map((size) => curseforgeFingerprint(() => chunked(data, size))),
      curseforgeFingerprint(data),
    ])
    expect(results).toEqual(results.map(() => expected))
  })

  it('accepts Node Buffers', async () => {
    await expect(curseforgeFingerprint(Buffer.from('Hello, World!'))).resolves.toBe(1961219979)
  })

  it('incremental hasher validates the declared length', () => {
    const data = enc('abc def')
    expect(countFingerprintBytes(data)).toBe(6)
    expect(new FingerprintHasher(6).update(data.subarray(0, 2)).update(data.subarray(2)).digest()).toBe(reference(data))
    expect(() => new FingerprintHasher(5).update(data).digest()).toThrow(/length mismatch/)
    expect(() => new FingerprintHasher(-1)).toThrow(RangeError)
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(curseforgeFingerprint(() => chunked(enc('abc'), 1), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
