/**
 * Skin image helpers shared by the skin editor, the 2D head and the 3D viewer. Pure functions
 * over bytes and RGBA buffers (no DOM), except `readSkinFile`, which needs `Blob`.
 *
 * Layout facts (minecraft.wiki "Skin"): modern skins are 64×64; legacy skins (before 1.8) are
 * 64×32 and have no second layer except the hat, and no separate left arm or leg (those mirror
 * the right ones). Slim ("Alex") arms are 3 px wide instead of 4.
 */

export type SkinModel = 'classic' | 'slim'

/** Matches the runtime's limit for skin files. Mojang's own limit is lower; it answers with an error. */
export const SKIN_MAX_BYTES = 256 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from a PNG's IHDR chunk, or `null` when the bytes aren't a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null
  // The first chunk must be IHDR: length (4), type (4), width (4), height (4).
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

export type SkinCheck = { ok: true; width: number; height: number; legacy: boolean } | { ok: false; error: string }

/** Validates a skin file by content: a PNG (magic bytes), 64×64 or legacy 64×32, and small. */
export function validateSkinPng(bytes: Uint8Array): SkinCheck {
  if (bytes.length > SKIN_MAX_BYTES) return { ok: false, error: 'This file is too large to be a skin.' }
  const size = readPngSize(bytes)
  if (!size) return { ok: false, error: 'This file isn’t a PNG image.' }
  const { width, height } = size
  if (width !== 64 || (height !== 64 && height !== 32)) {
    return { ok: false, error: `Skins must be 64 × 64 or 64 × 32 pixels. This image is ${width} × ${height}.` }
  }
  return { ok: true, width, height, legacy: height === 32 }
}

export interface SkinFile {
  /** `data:image/png;base64,…`, used for the preview and for `accounts.setSkin({ dataUrl })`. */
  dataUrl: string
  width: number
  height: number
  legacy: boolean
  name: string
}

/** Reads and validates a picked or dropped file. Rejects with a user-facing message. */
export async function readSkinFile(file: Blob & { name?: string }): Promise<SkinFile> {
  if (file.size > SKIN_MAX_BYTES) throw new Error('This file is too large to be a skin.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const check = validateSkinPng(bytes)
  if (!check.ok) throw new Error(check.error)
  return { dataUrl: `data:image/png;base64,${toBase64(bytes)}`, width: check.width, height: check.height, legacy: check.legacy, name: file.name ?? 'skin.png' }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

type Pixels = Uint8Array | Uint8ClampedArray

const alphaAt = (rgba: Pixels, width: number, x: number, y: number) => rgba[(y * width + x) * 4 + 3]!

function areaIs(rgba: Pixels, width: number, x0: number, y0: number, w: number, h: number, test: (r: number, g: number, b: number, a: number) => boolean) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * width + x) * 4
      if (!test(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, rgba[o + 3]!)) return false
    }
  }
  return true
}

/**
 * Guesses the arm model from the pixels. On a slim skin the 4th column of each arm face is
 * unused: transparent, or filled solid black or white by older editors. Legacy 64×32 skins
 * predate slim arms, so they are always classic.
 */
export function detectSkinModel(rgba: Pixels, width: number, height: number): SkinModel {
  if (width !== 64 || height !== 64 || rgba.length < 64 * 64 * 4) return 'classic'
  const unused: [number, number, number, number][] = [
    [50, 16, 2, 4], // right arm: the end of the top/bottom faces
    [54, 20, 2, 12], // right arm: the end of the back face
  ]
  const tests = [(_r: number, _g: number, _b: number, a: number) => a === 0, (r: number, g: number, b: number) => r + g + b === 0, (r: number, g: number, b: number) => r === 255 && g === 255 && b === 255]
  return tests.some((t) => unused.every(([x, y, w, h]) => areaIs(rgba, 64, x, y, w, h, t))) ? 'slim' : 'classic'
}

/**
 * The 8×8 face as RGBA: the head's front face with the hat layer composited on top. Legacy
 * skins with no transparency at all get no hat (their "hat" is usually a solid background).
 */
export function headPixels(rgba: Pixels, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(8 * 8 * 4)
  const legacy = height === width / 2
  const opaqueLegacy = legacy && areaIs(rgba, width, 0, 0, width, height, (_r, _g, _b, a) => a === 255)
  const scale = width / 64
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const face = ((8 + y) * scale * width + (8 + x) * scale) * 4
      const hat = ((8 + y) * scale * width + (40 + x) * scale) * 4
      const o = (y * 8 + x) * 4
      const a = opaqueLegacy ? 0 : rgba[hat + 3]! / 255
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(rgba[hat + c]! * a + rgba[face + c]! * (1 - a))
      out[o + 3] = 255
    }
  }
  return out
}

/** True when the skin has any visible pixel in the face (an all-transparent face means "draw nothing"). */
export function hasFace(rgba: Pixels, width: number): boolean {
  const scale = width / 64
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) if (alphaAt(rgba, width, x * scale, y * scale) > 0) return true
  return false
}

/** Mojang still hands out `http://textures.minecraft.net/…` URLs; the renderer only loads https. */
export function normalizeTextureUrl(url: string): string {
  return url.replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/')
}
