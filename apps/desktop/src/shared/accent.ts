/**
 * The default accent colour, shared by the runtime's settings schema and the renderer's theme.
 *
 * The default is neutral: the label colour, near-black in light mode and near-white in dark mode.
 * It is stored as its light-mode value; for it the renderer keeps the stylesheet's tuned
 * light/dark pair instead of deriving one from the hex (renderer `lib/theme.ts`).
 */
export const DEFAULT_ACCENT = '#1c1c1f'

/** The default before the 2026 redesign (an amethyst purple). */
export const LEGACY_DEFAULT_ACCENT = '#9b5de5'

/**
 * A stored accent as it should be used: the old default reads as the new one, so everyone who
 * never picked an accent moves to the neutral look. `hex` is a normalised `#rrggbb` colour.
 */
export function migrateAccent(hex: string): string {
  return hex === LEGACY_DEFAULT_ACCENT ? DEFAULT_ACCENT : hex
}
