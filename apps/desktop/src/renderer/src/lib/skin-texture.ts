/**
 * Procedural skin and cape textures: the viewer's default character (Amethyst ships no Mojang
 * textures), and deterministic test skins for screenshots and tests. Pure: returns RGBA pixels.
 */
import type { SkinModel } from './skin'

export interface Texture {
  width: number
  height: number
  data: Uint8ClampedArray
}

type RGBA = readonly [number, number, number, number]

export interface SkinPalette {
  skin: RGBA
  hair: RGBA
  shirt: RGBA
  trim: RGBA
  pants: RGBA
  shoes: RGBA
  eyes: RGBA
}

/** The default character: an amethyst hoodie. */
export const DEFAULT_PALETTE: SkinPalette = {
  skin: [226, 180, 146, 255],
  hair: [74, 50, 38, 255],
  shirt: [124, 77, 196, 255],
  trim: [196, 160, 240, 255],
  pants: [46, 52, 84, 255],
  shoes: [58, 58, 64, 255],
  eyes: [70, 110, 200, 255],
}

const WHITE: RGBA = [250, 250, 250, 255]

function shade([r, g, b, a]: RGBA, f: number): RGBA {
  return [Math.round(r * f), Math.round(g * f), Math.round(b * f), a]
}

function painter(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4)
  const fill = (x: number, y: number, w: number, h: number, c: RGBA) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) data.set(c, (yy * width + xx) * 4)
    }
  }
  return { data, fill }
}

/**
 * Paints one arm at `(ox, oy)` (the top-left of its 16×16 block in the texture). Classic arms are
 * 4 px wide, slim arms 3 px; the slim layout leaves the last columns of the block empty.
 */
function arm(fill: (x: number, y: number, w: number, h: number, c: RGBA) => void, ox: number, oy: number, w: number, p: SkinPalette) {
  fill(ox + 4, oy, w, 4, p.shirt) // top
  fill(ox + 4 + w, oy, w, 4, p.skin) // bottom (the hand)
  const faces = 4 + w + 4 + w
  fill(ox, oy + 4, faces, 8, p.shirt) // sleeves
  fill(ox, oy + 11, faces, 1, p.trim) // cuff
  fill(ox, oy + 12, faces, 4, p.skin) // hands
  fill(ox, oy + 4, 4, 8, shade(p.shirt, 0.86)) // outer side, a little darker
}

function leg(fill: (x: number, y: number, w: number, h: number, c: RGBA) => void, ox: number, oy: number, p: SkinPalette) {
  fill(ox + 4, oy, 4, 4, p.pants)
  fill(ox + 8, oy, 4, 4, p.shoes)
  fill(ox, oy + 4, 16, 9, p.pants)
  fill(ox, oy + 13, 16, 3, p.shoes)
  fill(ox, oy + 4, 4, 9, shade(p.pants, 0.86))
}

/** A 64×64 skin (or a 64×32 legacy one, which is always classic). */
export function makeSkin(options: { model?: SkinModel; legacy?: boolean; palette?: SkinPalette } = {}): Texture {
  const p = options.palette ?? DEFAULT_PALETTE
  const legacy = options.legacy ?? false
  const w = !legacy && options.model === 'slim' ? 3 : 4
  const height = legacy ? 32 : 64
  const { data, fill } = painter(64, height)

  // Head (8×8×8): faces at y 0–16, x 0–32.
  fill(8, 0, 16, 8, p.skin) // top + bottom
  fill(0, 8, 32, 8, p.skin) // right, front, left, back
  fill(8, 0, 8, 8, p.hair) // top
  fill(0, 8, 8, 3, p.hair) // right side
  fill(16, 8, 8, 3, p.hair) // left side
  fill(24, 8, 8, 7, p.hair) // back
  fill(0, 11, 2, 2, p.hair)
  fill(22, 11, 2, 2, p.hair)
  // Face (front, x 8–16, y 8–16).
  fill(8, 8, 8, 2, p.hair)
  fill(8, 10, 1, 1, p.hair)
  fill(15, 10, 1, 1, p.hair)
  fill(9, 12, 1, 1, WHITE)
  fill(10, 12, 1, 1, p.eyes)
  fill(13, 12, 1, 1, p.eyes)
  fill(14, 12, 1, 1, WHITE)
  fill(11, 13, 2, 1, shade(p.skin, 0.82)) // nose
  fill(11, 14, 2, 1, shade(p.skin, 0.62)) // mouth

  // Body (8×12×4): faces at y 16–32, x 16–40.
  fill(20, 16, 16, 4, p.shirt)
  fill(16, 20, 24, 12, p.shirt)
  fill(16, 20, 4, 12, shade(p.shirt, 0.86))
  fill(28, 20, 4, 12, shade(p.shirt, 0.86))
  fill(22, 20, 4, 1, p.trim) // collar
  fill(23, 21, 2, 1, p.trim)
  fill(23, 23, 2, 5, p.trim) // zip
  fill(16, 31, 24, 1, shade(p.pants, 0.7)) // belt

  arm(fill, 40, 16, w, p) // right arm
  leg(fill, 0, 16, p) // right leg
  if (!legacy) {
    arm(fill, 32, 48, w, p) // left arm
    leg(fill, 16, 48, p) // left leg
  }
  return { width: 64, height, data }
}

/** A 64×32 cape: a solid colour with a diamond emblem on the outer face. */
export function makeCape(color: RGBA = [52, 92, 196, 255], emblem: RGBA = [244, 208, 92, 255]): Texture {
  const { data, fill } = painter(64, 32)
  fill(0, 0, 22, 17, shade(color, 0.8))
  fill(1, 1, 10, 16, color) // outer face (seen from behind)
  fill(12, 1, 10, 16, shade(color, 0.7)) // inner face
  for (let i = 0; i < 4; i++) fill(5 - i, 5 + i, 2 + i * 2, 1, emblem)
  for (let i = 0; i < 3; i++) fill(3 + i, 9 + i, 6 - i * 2, 1, emblem)
  return { width: 64, height: 32, data }
}

/** Puts generated pixels on a canvas (DOM only). skinview3d accepts a canvas as a texture source. */
export function textureCanvas(texture: Texture): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = texture.width
  canvas.height = texture.height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(texture.data), texture.width, texture.height), 0, 0)
  return canvas
}

/** A `data:image/png` URL of generated pixels (DOM only). */
export function textureDataUrl(texture: Texture): string {
  return textureCanvas(texture).toDataURL('image/png')
}
