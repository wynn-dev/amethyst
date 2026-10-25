import { describe, expect, it } from 'vitest'
import { detectSkinModel, hasFace, headPixels, normalizeTextureUrl, readPngSize, readSkinFile, SKIN_MAX_BYTES, validateSkinPng } from './skin'
import { makeCape, makeSkin } from './skin-texture'

/** The PNG signature and an IHDR chunk; validation reads no further. */
function pngHeader(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24) // 8-bit RGBA
  return bytes
}

describe('skin PNG validation', () => {
  it('accepts 64×64 and legacy 64×32 PNGs', () => {
    expect(validateSkinPng(pngHeader(64, 64))).toEqual({ ok: true, width: 64, height: 64, legacy: false })
    expect(validateSkinPng(pngHeader(64, 32))).toEqual({ ok: true, width: 64, height: 32, legacy: true })
  })

  it('rejects other sizes with the actual size in the message', () => {
    for (const [w, h] of [
      [128, 128],
      [64, 48],
      [32, 32],
      [32, 64],
    ] as const) {
      expect(validateSkinPng(pngHeader(w, h))).toEqual({ ok: false, error: expect.stringContaining(`${w} × ${h}`) })
    }
  })

  it('checks the content, not the name: non-PNG bytes are refused', () => {
    const jpeg = new Uint8Array(64).fill(0)
    jpeg.set([0xff, 0xd8, 0xff])
    expect(validateSkinPng(jpeg)).toEqual({ ok: false, error: 'This file isn’t a PNG image.' })
    expect(readPngSize(new Uint8Array(4))).toBeNull()
    const noIhdr = pngHeader(64, 64)
    noIhdr.set([0x49, 0x44, 0x41, 0x54], 12) // IDAT first
    expect(readPngSize(noIhdr)).toBeNull()
  })

  it('refuses files over the size limit', () => {
    expect(validateSkinPng(pngHeader(64, 64, SKIN_MAX_BYTES)).ok).toBe(false)
  })

  it('reads a picked file into a data URL', async () => {
    const file = Object.assign(new Blob([pngHeader(64, 32) as BlobPart], { type: 'image/png' }), { name: 'old.png' })
    const read = await readSkinFile(file)
    expect(read).toMatchObject({ width: 64, height: 32, legacy: true, name: 'old.png' })
    expect(read.dataUrl.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true)
    await expect(readSkinFile(new Blob([pngHeader(100, 100) as BlobPart]))).rejects.toThrow('100 × 100')
  })
})

describe('skin pixels', () => {
  it('detects slim and classic arms', () => {
    expect(detectSkinModel(makeSkin({ model: 'classic' }).data, 64, 64)).toBe('classic')
    expect(detectSkinModel(makeSkin({ model: 'slim' }).data, 64, 64)).toBe('slim')
    // Legacy skins predate slim arms.
    expect(detectSkinModel(makeSkin({ legacy: true }).data, 64, 32)).toBe('classic')
  })

  it('composites the hat over the face', () => {
    const skin = makeSkin()
    const face = headPixels(skin.data, 64, 64)
    expect(face).toHaveLength(8 * 8 * 4)
    expect(hasFace(skin.data, 64)).toBe(true)
    // Put an opaque red hat pixel over the face's top-left corner.
    const data = new Uint8ClampedArray(skin.data)
    data.set([255, 0, 0, 255], (8 * 64 + 40) * 4)
    expect([...headPixels(data, 64, 64).subarray(0, 4)]).toEqual([255, 0, 0, 255])
  })

  it('ignores the solid hat of an opaque legacy skin', () => {
    // Fully opaque 64×32 with a solid black hat area: the face must show through.
    const legacy = makeSkin({ legacy: true })
    const data = new Uint8ClampedArray(legacy.data)
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.set([0, 0, 0, 255], i)
    const face = headPixels(data, 64, 32)
    const original = (8 * 64 + 8) * 4
    expect([...face.subarray(0, 3)]).toEqual([...legacy.data.subarray(original, original + 3)])
  })

  it('generates a 64×32 cape and legacy skin', () => {
    expect(makeCape()).toMatchObject({ width: 64, height: 32 })
    expect(makeSkin({ legacy: true }).data).toHaveLength(64 * 32 * 4)
  })

  it('upgrades Mojang texture URLs to https', () => {
    expect(normalizeTextureUrl('http://textures.minecraft.net/texture/abc')).toBe('https://textures.minecraft.net/texture/abc')
    expect(normalizeTextureUrl('amethyst-asset://data/skins/a.png')).toBe('amethyst-asset://data/skins/a.png')
  })
})
