/**
 * Java "modified UTF-8" as used by `DataInput.readUTF` / `DataOutput.writeUTF`:
 * - U+0000 is encoded as the two bytes `C0 80`, never as a single `00`.
 * - Characters outside the BMP are encoded as a UTF-16 surrogate pair, each surrogate
 *   as its own three-byte sequence (CESU-8 style). There are no four-byte sequences.
 */
import { malformed } from './errors'

const CHUNK = 0x2000

/** Decode modified UTF-8 bytes into a string. Throws `ENBT_MALFORMED` on invalid sequences. */
export function decodeMutf8(bytes: Uint8Array, start: number, end: number): string {
  // Fast path: plain ASCII (no NUL bytes, which are illegal as single bytes).
  let ascii = true
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number
    if (b === 0 || b >= 0x80) {
      ascii = false
      break
    }
  }
  if (ascii) return latin1(bytes, start, end)

  const units: number[] = []
  let out = ''
  let i = start
  while (i < end) {
    const a = bytes[i] as number
    if (a !== 0 && a < 0x80) {
      units.push(a)
      i += 1
    } else if ((a & 0xe0) === 0xc0) {
      if (i + 1 >= end) throw malformed('Truncated modified UTF-8 sequence')
      const b = bytes[i + 1] as number
      if ((b & 0xc0) !== 0x80) throw malformed('Invalid modified UTF-8 continuation byte')
      units.push(((a & 0x1f) << 6) | (b & 0x3f))
      i += 2
    } else if ((a & 0xf0) === 0xe0) {
      if (i + 2 >= end) throw malformed('Truncated modified UTF-8 sequence')
      const b = bytes[i + 1] as number
      const c = bytes[i + 2] as number
      if ((b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80) throw malformed('Invalid modified UTF-8 continuation byte')
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f))
      i += 3
    } else {
      throw malformed(`Invalid modified UTF-8 lead byte 0x${a.toString(16).padStart(2, '0')}`)
    }
    if (units.length >= CHUNK) {
      out += String.fromCharCode(...units)
      units.length = 0
    }
  }
  return out + String.fromCharCode(...units)
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + CHUNK)))
  }
  return out
}

/** Number of bytes `value` occupies in modified UTF-8. */
export function mutf8Length(value: string): number {
  let n = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    n += c !== 0 && c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}

/** Encode `value` into `out` at `offset`; returns the new offset. `out` must have room for {@link mutf8Length} bytes. */
export function encodeMutf8Into(value: string, out: Uint8Array, offset: number): number {
  let o = offset
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c !== 0 && c < 0x80) {
      out[o++] = c
    } else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6)
      out[o++] = 0x80 | (c & 0x3f)
    } else {
      out[o++] = 0xe0 | (c >> 12)
      out[o++] = 0x80 | ((c >> 6) & 0x3f)
      out[o++] = 0x80 | (c & 0x3f)
    }
  }
  return o
}

/** Encode `value` as modified UTF-8 (without the length prefix). */
export function encodeMutf8(value: string): Uint8Array {
  const out = new Uint8Array(mutf8Length(value))
  encodeMutf8Into(value, out, 0)
  return out
}
