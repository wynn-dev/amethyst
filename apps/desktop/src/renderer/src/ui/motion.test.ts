import { describe, expect, it } from 'vitest'
import { SNAPPY, SPRING, invert, spring } from './motion'

const points = (easing: string) => easing.slice('linear('.length, -1).split(', ').map(Number)

describe('springs', () => {
  it('samples from 0 to 1, overshooting only when under-damped', () => {
    const ui = points(SPRING.easing)
    expect(ui[0]).toBe(0)
    expect(ui.at(-1)).toBe(1)
    expect(Math.max(...ui)).toBeGreaterThan(1)
    const sheet = points(SNAPPY.easing)
    expect(Math.max(...sheet)).toBeLessThanOrEqual(1)
    expect(points(spring(400, 60).easing).every((v, i, a) => i === 0 || v >= a[i - 1]!)).toBe(true)
  })

  it('settles in about half a second (UI) and a third (sheets)', () => {
    expect(SPRING.duration).toBe(508)
    expect(SNAPPY.duration).toBe(316)
  })

  it('matches the CSS tokens, so CSS and script motion feel the same', async () => {
    // Read the stylesheet from disk (CSS imports are stubbed in tests; `node:fs` is untyped in the web project).
    const fs = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync: (path: URL, encoding: 'utf8') => string }
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toContain(`--ease-spring: ${SPRING.easing};`)
    expect(css).toContain(`--ease-snappy: ${SNAPPY.easing};`)
    expect(css).toContain(`--duration-spring: ${SPRING.duration}ms;`)
    expect(css).toContain(`--duration-snappy: ${SNAPPY.duration}ms;`)
  })
})

describe('invert', () => {
  it('maps the destination box back onto the source box', () => {
    const from = { left: 10, top: 20, width: 18, height: 18 }
    const to = { left: 100, top: 40, width: 36, height: 36 }
    expect(invert(from, to)).toBe('translate(-90px, -20px) scale(0.5, 0.5)')
    expect(invert({ left: 0, top: 0, width: 100, height: 20 }, { left: 0, top: 0, width: 200, height: 80 }, false)).toBe('translate(0px, 0px) scale(0.5, 0.25)')
  })
})
