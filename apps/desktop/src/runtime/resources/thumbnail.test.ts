import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { THUMBNAIL_SIZE, decodePng, encodePng, iconThumbnail } from './thumbnail'

function rgbaImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4)
  return { width, height, rgba }
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** A palette PNG (colour type 3) at `depth` bits with a tRNS entry making index 0 transparent. */
function palettePng(width: number, height: number, depth: 1 | 2 | 4 | 8, index: (x: number, y: number) => number, interlace = 0): Buffer {
  const stride = Math.ceil((width * depth) / 8)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth
      raw[y * (stride + 1) + 1 + (bit >> 3)]! |= index(x, y) << (8 - depth - (bit & 7))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = 3
  ihdr[12] = interlace
  const plte = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', Buffer.from([0])), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

describe('icon thumbnails', () => {
  it('round-trips RGBA through the encoder and decoder', () => {
    const img = rgbaImage(37, 21, (x, y) => [x * 7, y * 11, (x * y) & 255, 128 + (x & 127)])
    const back = decodePng(encodePng(img))
    expect(back?.width).toBe(37)
    expect(back?.height).toBe(21)
    expect(Buffer.from(back!.rgba).equals(Buffer.from(img.rgba))).toBe(true)
  })

  it('decodes low bit-depth palette images with transparency', () => {
    const png = decodePng(palettePng(5, 3, 2, (x) => x % 3))
    expect(png?.width).toBe(5)
    expect([...png!.rgba.subarray(0, 12)]).toEqual([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255])
  })

  it(`shrinks large icons to at most ${THUMBNAIL_SIZE} px and keeps the aspect ratio`, () => {
    const big = encodePng(rgbaImage(512, 256, (x, y) => [x & 255, y & 255, 90, 255]))
    const thumb = decodePng(iconThumbnail(big))
    expect(thumb?.width).toBe(THUMBNAIL_SIZE)
    expect(thumb?.height).toBe(THUMBNAIL_SIZE / 2)
  })

  it('keeps pixel art exact when the scale is a whole number', () => {
    // 16×16 pixel art scaled up 32× (512 px): every thumbnail pixel covers one art pixel's block.
    const art = (x: number, y: number): [number, number, number, number] => ((x + y) % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])
    const big = encodePng(rgbaImage(512, 512, (x, y) => art(x >> 5, y >> 5)))
    const thumb = decodePng(iconThumbnail(big))!
    for (const [x, y] of [
      [0, 0],
      [8, 0],
      [127, 127],
      [64, 72],
    ] as const) {
      expect([...thumb.rgba.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)]).toEqual(art(x >> 3, y >> 3))
    }
  })

  it('does not darken colours next to transparent pixels', () => {
    const big = encodePng(rgbaImage(256, 256, (x) => (x % 2 ? [255, 255, 255, 0] : [200, 100, 50, 255])))
    const thumb = decodePng(iconThumbnail(big))!
    expect([...thumb.rgba.subarray(0, 4)]).toEqual([200, 100, 50, 128])
  })

  it('leaves small, interlaced and non-PNG icons untouched', () => {
    const small = encodePng(rgbaImage(64, 64, () => [1, 2, 3, 255]))
    expect(iconThumbnail(small)).toBe(small)
    const interlaced = palettePng(300, 300, 8, () => 1, 1)
    expect(iconThumbnail(interlaced)).toBe(interlaced)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    expect(iconThumbnail(jpeg)).toBe(jpeg)
    const truncated = encodePng(rgbaImage(300, 300, () => [1, 2, 3, 255])).subarray(0, 60)
    expect(iconThumbnail(truncated)).toBe(truncated)
  })
})
