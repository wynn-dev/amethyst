/**
 * Applying the theme (B8) to a document: the colour scheme and the accent colour, through the
 * `data-appearance` attribute and the `--accent` CSS variable that every accent token derives
 * from (see styles.css). Main follows `appearance.theme` with `nativeTheme.themeSource`; this is
 * the renderer half.
 */
import type { AppearanceSettings, ThemeMode } from '@shared/services'

/** The default accent (the runtime's default `appearance.accentColor`). */
export const DEFAULT_ACCENT = '#9b5de5'

export const ACCENT_SWATCHES: { label: string; color: string }[] = [
  { label: 'Amethyst', color: DEFAULT_ACCENT },
  { label: 'Blue', color: '#007aff' },
  { label: 'Indigo', color: '#5856d6' },
  { label: 'Pink', color: '#ff2d55' },
  { label: 'Red', color: '#ff3b30' },
  { label: 'Orange', color: '#ff9500' },
  { label: 'Yellow', color: '#e5b000' },
  { label: 'Green', color: '#28a745' },
  { label: 'Graphite', color: '#8e8e93' },
]

/** `#rgb`/`#rrggbb` (any case) → `#rrggbb`, or `null` when it isn't a hex colour. */
export function normalizeHex(value: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const hex = m[1]!.toLowerCase()
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`
}

/**
 * The `--accent` value for a colour: the colour itself in light mode and a lighter mix in dark
 * mode, so it keeps its contrast on dark surfaces. `null` keeps the stylesheet's tuned Amethyst pair.
 */
export function accentValue(color: string): string | null {
  const hex = normalizeHex(color)
  if (!hex || hex === DEFAULT_ACCENT) return null
  return `light-dark(${hex}, color-mix(in srgb, ${hex} 84%, white))`
}

export type ThemeInput = Pick<AppearanceSettings, 'theme' | 'accentColor'>

/** Sets only the accent (also used for the live preview while the colour panel is dragged). */
export function applyAccent(color: string, root: HTMLElement = document.documentElement): void {
  const accent = accentValue(color)
  if (accent) root.style.setProperty('--accent', accent)
  else root.style.removeProperty('--accent')
}

export function applyTheme(theme: ThemeInput, root: HTMLElement = document.documentElement): void {
  if (theme.theme === 'light' || theme.theme === 'dark') root.dataset.appearance = theme.theme
  else delete root.dataset.appearance
  applyAccent(theme.accentColor, root)
}

const CACHE_KEY = 'amethyst:theme'

/** Remembers the theme so the next start paints with it before settings arrive (no flash). */
export function cacheTheme(theme: ThemeInput): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ theme: theme.theme, accentColor: theme.accentColor }))
  } catch {
    // Storage can be unavailable; the theme still applies once settings load.
  }
}

export function readCachedTheme(): ThemeInput | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Partial<ThemeInput> | null
    if (!raw || typeof raw.accentColor !== 'string') return null
    const mode: ThemeMode = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system'
    return { theme: mode, accentColor: raw.accentColor }
  } catch {
    return null
  }
}
