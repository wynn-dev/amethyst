import { describe, expect, it } from 'vitest'
import { pngHeader } from './__fixtures__/png'
import { MAX_SKIN_BYTES, readPngDimensions, validateSkinPng } from './png'

describe('readPngDimensions', () => {
  it('reads IHDR width and height', () => {
    expect(readPngDimensions(pngHeader(64, 32))).toEqual({ width: 64, height: 32 })
    expect(readPngDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('works on a subarray view', () => {
    const outer = new Uint8Array(40)
    outer.set(pngHeader(64, 64), 7)
    expect(readPngDimensions(outer.subarray(7))).toEqual({ width: 64, height: 64 })
  })

  it('rejects non-PNG data, truncation and corrupt IHDR', () => {
    expect(readPngDimensions(new TextEncoder().encode('GIF89a not a png at all, definitely'))).toBeUndefined()
    expect(readPngDimensions(pngHeader(64, 64).subarray(0, 30))).toBeUndefined()
    const corrupt = pngHeader(64, 64)
    corrupt[19] = 65 // width changed without fixing the CRC
    expect(readPngDimensions(corrupt)).toBeUndefined()
  })
})

describe('validateSkinPng', () => {
  it('accepts 64×64 and 64×32', () => {
    expect(validateSkinPng(pngHeader(64, 64))).toEqual({ width: 64, height: 64 })
    expect(validateSkinPng(pngHeader(64, 32))).toEqual({ width: 64, height: 32 })
  })

  it.each([
    [pngHeader(128, 128), 'ESKIN_BAD_DIMENSIONS'],
    [pngHeader(32, 64), 'ESKIN_BAD_DIMENSIONS'],
    [new Uint8Array(100), 'ESKIN_INVALID_PNG'],
    [new Uint8Array(MAX_SKIN_BYTES + 1), 'ESKIN_TOO_LARGE'],
  ])('rejects bad input (%#)', (bytes, code) => {
    expect(() => validateSkinPng(bytes)).toThrow(expect.objectContaining({ code }))
  })
})
