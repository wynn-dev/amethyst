/**
 * Applying the theme (B8) to a document: the colour scheme and the accent colour, through the
 * `data-appearance` attribute and the `--accent` CSS variable that every accent token derives
 * from (see styles.css). Main follows `appearance.theme` with `nativeTheme.themeSource`; this is
 * the renderer half.
 */
import type { AppearanceSettings, ThemeMode } from '@shared/services'
import { DEFAULT_ACCENT, migrateAccent } from '@shared/accent'

/** The default accent (the runtime's default `appearance.accentColor`): neutral. */
export { DEFAULT_ACCENT }

export const ACCENT_SWATCHES: { label: string; color: string }[] = [
  { label: 'Neutral', color: DEFAULT_ACCENT },
  { label: 'Blue', color: '#007aff' },
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

/** A stored accent, normalised and migrated (the old purple default reads as neutral), or `null`. */
export function resolveAccent(value: string): string | null {
  const hex = normalizeHex(value)
  return hex && migrateAccent(hex)
}

/** True for the neutral default, which uses the stylesheet's light/dark pair. */
export const isNeutralAccent = (value: string) => (resolveAccent(value) ?? DEFAULT_ACCENT) === DEFAULT_ACCENT

/**
 * The `--accent` value for a colour: the colour itself in light mode and a lighter mix in dark
 * mode, so it keeps its contrast on dark surfaces. `null` keeps the stylesheet's neutral pair.
 */
export function accentValue(color: string): string | null {
  const hex = resolveAccent(color)
  if (!hex || hex === DEFAULT_ACCENT) return null
  return `light-dark(${hex}, color-mix(in srgb, ${hex} 84%, white))`
}

const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio between two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** `weight` of `hex` mixed with black, as `#rrggbb`. */
function darken(hex: string, weight: number): string {
  return `#${channels(hex)
    .map((c) => Math.round(c * weight).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Text on accent fills must reach WCAG AA for normal text. */
const MIN_CONTRAST = 4.5

/**
 * The surface colour behind accent-filled controls and the text colour on it: white text on the
 * accent, darkened just enough to reach 4.5:1 while keeping its hue; for accents too light for
 * that (yellow, orange), the accent itself with black text.
 */
export function accentFill(color: string): { fill: string; on: string } {
  const hex = resolveAccent(color) ?? DEFAULT_ACCENT
  for (let weight = 1; weight >= 0.7; weight -= 0.02) {
    const fill = weight === 1 ? hex : darken(hex, weight)
    if (contrastRatio(fill, '#ffffff') >= MIN_CONTRAST) return { fill, on: '#fff' }
  }
  return { fill: hex, on: '#000' }
}

export type ThemeInput = Pick<AppearanceSettings, 'theme' | 'accentColor'>

const ACCENT_VARS = ['--accent', '--accent-fill', '--on-accent', '--accent-switch', '--on-accent-switch']

/** Sets only the accent (also used for the live preview while the colour panel is dragged). */
export function applyAccent(color: string, root: HTMLElement = document.documentElement): void {
  const accent = accentValue(color)
  if (accent) {
    const { fill, on } = accentFill(color)
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-fill', fill)
    root.style.setProperty('--on-accent', on)
    // A coloured accent also colours switch tracks (neutral ones stay grey).
    root.style.setProperty('--accent-switch', fill)
    root.style.setProperty('--on-accent-switch', '#fff')
  } else {
    for (const name of ACCENT_VARS) root.style.removeProperty(name)
  }
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
    return { theme: mode, accentColor: resolveAccent(raw.accentColor) ?? DEFAULT_ACCENT }
  } catch {
    return null
  }
}
