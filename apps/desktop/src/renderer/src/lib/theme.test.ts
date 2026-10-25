// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { accentValue, applyTheme, cacheTheme, DEFAULT_ACCENT, normalizeHex, readCachedTheme } from './theme'

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

  it('keeps the stylesheet’s tuned pair for the default accent, and ignores invalid colours', () => {
    document.documentElement.style.setProperty('--accent', 'red')
    applyTheme({ theme: 'system', accentColor: DEFAULT_ACCENT })
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    expect(accentValue('not a colour')).toBeNull()
    expect(normalizeHex('#AbC')).toBe('#aabbcc')
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
