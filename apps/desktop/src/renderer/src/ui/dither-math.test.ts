import { describe, expect, it } from 'vitest'
import { ART_TONES, BAYER8, FIELDS, artFor, bayer, bandField, ditherLevel, drawDither, progressField, ramp, withAlpha } from './dither-math'

/** The share of dots turned on over one 8×8 tile for tone `t`. */
function share(t: number) {
  let on = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) on += ditherLevel(t, 2, x, y)
  return on / 64
}

describe('Bayer thresholds', () => {
  it('covers 64 distinct thresholds strictly inside (0, 1), and tiles every 8 cells', () => {
    expect(BAYER8).toHaveLength(64)
    expect(new Set(BAYER8).size).toBe(64)
    expect(Math.min(...BAYER8)).toBeGreaterThan(0)
    expect(Math.max(...BAYER8)).toBeLessThan(1)
    expect(bayer(0, 0)).toBe(0.5 / 64)
    expect(bayer(8, 16)).toBe(bayer(0, 0))
    expect(bayer(3, 5)).toBe(bayer(11, 13))
  })

  it('turns a tone into a proportional share of dots', () => {
    expect(share(0)).toBe(0)
    expect(share(1)).toBe(1)
    expect(share(0.25)).toBe(0.25)
    expect(share(0.5)).toBe(0.5)
    // Out-of-range tones clamp.
    expect(share(-3)).toBe(0)
    expect(share(7)).toBe(1)
  })

  it('picks between the two nearest colours of a longer palette', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const level = ditherLevel(0.5, 6, x, y) // 2.5 of 5 steps
        expect([2, 3]).toContain(level)
      }
    }
    expect(ditherLevel(1, 6, 0, 0)).toBe(5)
  })
})

describe('palettes and art', () => {
  it('ramps one hue from dark to light', () => {
    const r = ramp(105, 32)
    expect(r).toHaveLength(6)
    expect(r[0]).toBe('hsl(105 32% 13%)')
    expect(r[5]).toBe('hsl(105 32% 80%)')
  })

  it('never generates purple or magenta art, and stays muted', () => {
    for (const [hue, sat] of ART_TONES) {
      expect(hue < 250 || hue > 335).toBe(true)
      expect(sat).toBeLessThanOrEqual(45)
    }
    for (let seed = 0; seed < 720; seed++) {
      const a = artFor(seed)
      expect(a.hue < 250 || a.hue > 335).toBe(true)
      expect(Object.keys(FIELDS)).toContain(a.field)
    }
  })

  it('is stable per seed and varies across seeds', () => {
    expect(artFor(42)).toEqual(artFor(42))
    expect(artFor(-42)).toEqual(artFor(42))
    const distinct = new Set(Array.from({ length: 60 }, (_, i) => JSON.stringify(artFor(i))))
    expect(distinct.size).toBeGreaterThan(30)
  })

  it('keeps every motif finite over the unit square', () => {
    for (const field of Object.values(FIELDS)) {
      for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) expect(Number.isFinite(field(i / 10, j / 10))).toBe(true)
    }
  })
})

describe('progress fields', () => {
  it('fills up to the value with a soft edge, and fills completely at 100%', () => {
    const half = progressField(0.5, 200, 20)
    expect(half(0.1, 0.5)).toBeGreaterThan(1)
    expect(half(0.9, 0.5)).toBeLessThan(0)
    expect(progressField(1, 200, 20)(1, 0.5)).toBeGreaterThanOrEqual(1)
    expect(progressField(0, 200, 20)(0.5, 0.5)).toBeLessThan(0)
  })

  it('draws an indeterminate band around its centre', () => {
    const band = bandField(0.5, 200, 60, 20)
    expect(band(0.5, 0.5)).toBeGreaterThan(1)
    expect(band(0, 0.5)).toBeLessThan(0)
    expect(band(1, 0.5)).toBeLessThan(0)
  })
})

describe('withAlpha', () => {
  it('reads the colour forms getComputedStyle returns', () => {
    expect(withAlpha('rgb(236, 236, 239)')).toBe('rgb(236 236 239 / 1)')
    expect(withAlpha('rgba(10, 20, 30, 0.5)', 0.5)).toBe('rgb(10 20 30 / 0.25)')
    expect(withAlpha('rgb(10 20 30 / 0.4)')).toBe('rgb(10 20 30 / 0.4)')
    expect(withAlpha('color(srgb 1 0.5 0)', 0.3)).toBe('rgb(255 128 0 / 0.3)')
    expect(withAlpha('#1c1c1f', 0.9)).toBe('rgb(28 28 31 / 0.9)')
    expect(withAlpha('light-dark(red, blue)')).toBeNull()
    expect(withAlpha('')).toBeNull()
  })
})

describe('drawDither', () => {
  it('reports when there is no 2D context, and sizes the backing store for the pixel ratio', () => {
    const calls: string[] = []
    const ctx = {
      fillStyle: '',
      clearRect: () => calls.push('clear'),
      fillRect: () => calls.push('fill'),
    }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    expect(drawDither(canvas, { width: 10, height: 4, cell: 2, palette: [null, 'red'], field: () => 1 }, 2)).toBe(true)
    expect([canvas.width, canvas.height]).toEqual([20, 8])
    // 5 × 2 cells, all on: one clear and ten dots; transparent cells are never filled.
    expect(calls.filter((c) => c === 'fill')).toHaveLength(10)
    calls.length = 0
    drawDither(canvas, { width: 10, height: 4, cell: 2, palette: [null, 'red'], field: () => 0 }, 2)
    expect(calls).toEqual(['clear'])
    const none = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement
    expect(drawDither(none, { width: 4, height: 4, cell: 1, palette: ['red'], field: () => 0 }, 1)).toBe(false)
  })
})
