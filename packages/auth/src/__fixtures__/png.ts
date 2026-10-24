import { crc32 } from 'node:zlib'

/** A PNG signature plus a valid IHDR chunk (enough for the dimension check). */
export function pngHeader(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.set([8, 6, 0, 0, 0], 24) // 8-bit RGBA
  buf.writeUInt32BE(crc32(buf.subarray(12, 29)), 29)
  return new Uint8Array(buf)
}
