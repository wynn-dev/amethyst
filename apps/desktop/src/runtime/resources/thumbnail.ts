/**
 * PNG thumbnails for the icon cache, in plain JS (runs in the scan workers).
 *
 * Mod and pack icons are often 256–1024 px, but lists draw them at 20–44 pt. Chromium decodes a
 * PNG at its full size, so a list of 400 mods could hold hundreds of MB of decoded bitmaps and
 * spend its frames decoding. Icons larger than {@link THUMBNAIL_SIZE} are box-filtered down to it
 * (premultiplied alpha, so transparent edges do not darken) and re-encoded; smaller ones, and
 * anything this decoder does not handle (interlaced PNGs, other formats), are kept as they are.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** Longest side of a thumbnail, in px: 2× the largest place an icon is drawn (44 pt). */
export const THUMBNAIL_SIZE = 128

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_SIDE = 8192
const MAX_PIXELS = 4096 * 4096

interface Png {
  width: number
  height: number
  /** RGBA, 8 bits per channel. */
  rgba: Uint8Array
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Decode a non-interlaced PNG to RGBA8, or `undefined` when it is not one this decoder handles. */
export function decodePng(bytes: Uint8Array): Png | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return undefined
  let width = 0
  let height = 0
  let depth = 0
  let color = -1
  let palette: Buffer | undefined
  let trns: Buffer | undefined
  const idat: Buffer[] = []
  for (let o = 8; o + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    if (o + 12 + len > buf.length) return undefined
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8] ?? 0
      color = data[9] ?? -1
      if (data[12] !== 0) return undefined // Adam7 interlacing: keep the original
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + len
  }
  const channels = CHANNELS[color]
  if (!channels || !width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return undefined
  if (![1, 2, 4, 8, 16].includes(depth) || (color === 3 && (!palette || depth === 16)) || ((color === 2 || color === 4 || color === 6) && depth < 8)) return undefined

  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, bitsPerPixel >> 3)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height })
  } catch {
    return undefined
  }
  if (raw.length < (stride + 1) * height) return undefined

  // Undo the per-row filters in place.
  const rows = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp]! : 0
      const b = y > 0 ? rows[up + x]! : 0
      const c = x >= bpp && y > 0 ? rows[up + x - bpp]! : 0
      const v = raw[src + x]!
      let out: number
      switch (filter) {
        case 0:
          out = v
          break
        case 1:
          out = v + a
          break
        case 2:
          out = v + b
          break
        case 3:
          out = v + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          return undefined
      }
      rows[dst + x] = out & 0xff
    }
  }

  // Expand every pixel to RGBA8.
  const rgba = new Uint8Array(width * height * 4)
  const sample = (row: number, i: number): number => {
    // The i-th sample of a row, scaled to 8 bits (16-bit samples keep their high byte).
    if (depth === 8) return rows[row + i]!
    if (depth === 16) return rows[row + i * 2]!
    const bit = i * depth
    const v = (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
    return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1))
  }
  const raw16 = (row: number, i: number): number => (depth === 16 ? (rows[row + i * 2]! << 8) | rows[row + i * 2 + 1]! : -1)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let r: number
      let g: number
      let b: number
      let a = 255
      if (color === 3) {
        const i = sample(row, x)
        r = palette![i * 3] ?? 0
        g = palette![i * 3 + 1] ?? 0
        b = palette![i * 3 + 2] ?? 0
        a = trns && i < trns.length ? trns[i]! : 255
      } else if (color === 0 || color === 4) {
        r = g = b = sample(row, x * channels)
        if (color === 4) a = sample(row, x * 2 + 1)
        else if (trns && trns.length >= 2) {
          const key = trns.readUInt16BE(0)
          const v = depth === 16 ? raw16(row, x) : depth === 8 ? rows[row + x]! : Math.round((r * ((1 << depth) - 1)) / 255)
          if (v === key) a = 0
        }
      } else {
        r = sample(row, x * channels)
        g = sample(row, x * channels + 1)
        b = sample(row, x * channels + 2)
        if (color === 6) a = sample(row, x * 4 + 3)
        else if (trns && trns.length >= 6) {
          const kr = trns.readUInt16BE(0)
          const kg = trns.readUInt16BE(2)
          const kb = trns.readUInt16BE(4)
          const hit = depth === 16 ? raw16(row, x * 3) === kr && raw16(row, x * 3 + 1) === kg && raw16(row, x * 3 + 2) === kb : r === kr && g === kg && b === kb
          if (hit) a = 0
        }
      }
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = a
    }
  }
  return { width, height, rgba }
}

/** Box-filter weights of `src` samples for `dst` outputs (exact pixel coverage). */
function weights(src: number, dst: number): { start: number; w: Float64Array }[] {
  const scale = src / dst
  const out: { start: number; w: Float64Array }[] = []
  for (let i = 0; i < dst; i++) {
    const lo = i * scale
    const hi = lo + scale
    const start = Math.floor(lo)
    const end = Math.min(src, Math.ceil(hi))
    const w = new Float64Array(end - start)
    for (let s = start; s < end; s++) w[s - start] = (Math.min(hi, s + 1) - Math.max(lo, s)) / scale
    out.push({ start, w })
  }
  return out
}

/** Downscale RGBA8 with a separable box filter on premultiplied alpha. */
export function downscale(png: Png, width: number, height: number): Png {
  const { width: sw, height: sh, rgba: src } = png
  // Horizontal pass into premultiplied floats.
  const wx = weights(sw, width)
  const mid = new Float64Array(width * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < width; x++) {
      const { start, w } = wx[x]!
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < w.length; k++) {
        const o = (y * sw + start + k) * 4
        const alpha = src[o + 3]! * w[k]!
        r += src[o]! * alpha
        g += src[o + 1]! * alpha
        b += src[o + 2]! * alpha
        a += alpha
      }
      const m = (y * width + x) * 4
      mid[m] = r
      mid[m + 1] = g
      mid[m + 2] = b
      mid[m + 3] = a
    }
  }
  const wy = weights(sh, height)
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const { start, w } = wy[y]!
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < w.length; k++) {
        const m = ((start + k) * width + x) * 4
        r += mid[m]! * w[k]!
        g += mid[m + 1]! * w[k]!
        b += mid[m + 2]! * w[k]!
        a += mid[m + 3]! * w[k]!
      }
      const o = (y * width + x) * 4
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a))
        out[o + 1] = Math.min(255, Math.round(g / a))
        out[o + 2] = Math.min(255, Math.round(b / a))
      }
      out[o + 3] = Math.min(255, Math.round(a))
    }
  }
  return { width, height, rgba: out }
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

/** Encode RGBA8 as a PNG (Paeth-filtered rows, which suit icons). */
export function encodePng({ width, height, rgba }: Png): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1)
    raw[o] = 4
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const a = x >= 4 ? rgba[i - 4]! : 0
      const b = y > 0 ? rgba[i - stride]! : 0
      const c = x >= 4 && y > 0 ? rgba[i - stride - 4]! : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      raw[o + 1 + x] = (rgba[i]! - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

/**
 * The bytes to store for an icon: a PNG thumbnail at most `size` px on its longest side, or the
 * original bytes when it is already that small or cannot be decoded here.
 */
export function iconThumbnail(bytes: Uint8Array, size = THUMBNAIL_SIZE): Uint8Array {
  const png = decodePng(bytes)
  if (!png || Math.max(png.width, png.height) <= size) return bytes
  const scale = size / Math.max(png.width, png.height)
  const thumb = downscale(png, Math.max(1, Math.round(png.width * scale)), Math.max(1, Math.round(png.height * scale)))
  return encodePng(thumb)
}
