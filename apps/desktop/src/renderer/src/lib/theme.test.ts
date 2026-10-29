// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_DEFAULT_ACCENT } from '@shared/accent'
import { ACCENT_SWATCHES, accentFill, accentValue, applyTheme, cacheTheme, contrastRatio, DEFAULT_ACCENT, isNeutralAccent, normalizeHex, readCachedTheme } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.appearance
  localStorage.clear()
})

describe('theme application', () => {
  it('sets the accent CSS variable, with a lighter variant for dark mode', () => {
    applyTheme({ theme: 'system', accentColor: '#007AFF' })
    const value = document.documentElement.style.getPropertyValue('--accent')
    expect(value).toContain('#007aff')
    expect(value).toMatch(/^light-dark\(#007aff, color-mix\(in srgb, #007aff \d+%, white\)\)$/)
  })

  it('defaults to the neutral accent, offered first as “Neutral”, with no purple swatch', () => {
    expect(ACCENT_SWATCHES[0]).toEqual({ label: 'Neutral', color: DEFAULT_ACCENT })
    expect(ACCENT_SWATCHES.map((a) => a.label)).not.toContain('Amethyst')
    // Indigo reads as purple next to the neutral UI.
    expect(ACCENT_SWATCHES.map((a) => a.label)).not.toContain('Indigo')
    expect(ACCENT_SWATCHES.map((a) => a.color)).not.toContain('#5856d6')
    expect(ACCENT_SWATCHES.map((a) => a.color)).not.toContain(LEGACY_DEFAULT_ACCENT)
    expect(isNeutralAccent(DEFAULT_ACCENT)).toBe(true)
    expect(isNeutralAccent('#007aff')).toBe(false)
  })

  it('treats the old purple default as the neutral default (cached and live)', () => {
    expect(isNeutralAccent('#9B5DE5')).toBe(true)
    applyTheme({ theme: 'system', accentColor: '#007aff' })
    applyTheme({ theme: 'system', accentColor: LEGACY_DEFAULT_ACCENT })
    for (const name of ['--accent', '--accent-fill', '--on-accent', '--accent-switch']) expect(document.documentElement.style.getPropertyValue(name)).toBe('')
    cacheTheme({ theme: 'dark', accentColor: LEGACY_DEFAULT_ACCENT })
    expect(readCachedTheme()).toEqual({ theme: 'dark', accentColor: DEFAULT_ACCENT })
  })

  it('keeps the stylesheet’s tuned pair for the default accent, and ignores invalid colours', () => {
    document.documentElement.style.setProperty('--accent', 'red')
    applyTheme({ theme: 'system', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    expect(accentValue('not a colour')).toBeNull()
    expect(normalizeHex('#AbC')).toBe('#aabbcc')
  })

  it('keeps text on accent fills at 4.5:1 or better for every swatch', () => {
    for (const { color } of ACCENT_SWATCHES) {
      const { fill, on } = accentFill(color)
      expect({ color, ratio: contrastRatio(fill, on === '#fff' ? '#ffffff' : '#000000') >= 4.5 }).toEqual({ color, ratio: true })
    }
    // Light accents keep their colour and switch to dark text instead of turning muddy.
    expect(accentFill('#e5b000')).toEqual({ fill: '#e5b000', on: '#000' })
    // Accents that already pass are used as they are.
    expect(accentFill('#5856d6')).toEqual({ fill: '#5856d6', on: '#fff' })
    applyTheme({ theme: 'system', accentColor: '#ff9500' })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#000')
    // A coloured accent also colours switch tracks.
    expect(document.documentElement.style.getPropertyValue('--accent-switch')).toBe('#ff9500')
    applyTheme({ theme: 'system', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.style.getPropertyValue('--accent-fill')).toBe('')
  })

  it('forces light or dark, and follows the system otherwise', () => {
    applyTheme({ theme: 'dark', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.dataset.appearance).toBe('dark')
    applyTheme({ theme: 'light', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.dataset.appearance).toBe('light')
    applyTheme({ theme: 'system', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.dataset.appearance).toBeUndefined()
  })

  it('caches the theme for the next start', () => {
    expect(readCachedTheme()).toBeNull()
    cacheTheme({ theme: 'dark', accentColor: '#ff9500' })
    expect(readCachedTheme()).toEqual({ theme: 'dark', accentColor: '#ff9500' })
  })
})
