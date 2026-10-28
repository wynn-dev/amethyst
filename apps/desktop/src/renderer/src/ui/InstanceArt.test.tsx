// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { InstanceArt } from './InstanceArt'
import { artFallback, artFor } from './dither-math'

afterEach(cleanup)

describe('InstanceArt', () => {
  it('shows the real icon when there is one', () => {
    const { container } = render(<InstanceArt seed={3} size={18} src="amethyst-asset://data/icon.png" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('amethyst-asset://data/icon.png')
    expect((container.firstElementChild as HTMLElement).style.borderRadius).toBe('5px')
  })

  it('falls back to the seeded flat tone where canvas is unavailable', () => {
    const { container } = render(<InstanceArt seed={3} size={28} />)
    const tile = container.firstElementChild as HTMLElement
    expect(container.querySelector('img')).toBeNull()
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.style.width).toBe('28px')
    expect(tile.style.borderRadius).toBe('7px')
    // happy-dom has no 2D context, so the flat tone stands in for the dither.
    expect(artFallback(artFor(3))).toMatch(/^hsl\(\d+ \d+% 33%\)$/)
    expect(tile.style.background).toBeTruthy()
    expect(tile.style.background).not.toContain('url(')
  })
})
