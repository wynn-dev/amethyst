/**
 * Ordered (Bayer 8×8) dithering: the texture behind progress (the Play pill, download bars) and
 * the placeholder art of instances and projects without an icon (docs/design/mockup.html).
 *
 * A *field* maps a cell's normalised position (0–1 on each axis, at the cell centre) to a tone
 * (0–1); the tone picks between the two nearest colours of a *palette*, thresholded by the Bayer
 * matrix, so gradients become stable dot patterns rather than blends. Everything here is pure
 * except `drawDither`, which paints a canvas once per call (never per frame unless the caller
 * animates).
 */

/** The 8×8 Bayer matrix, as thresholds in (0, 1). */
export const BAYER8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51,
  19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64)

/** The threshold at cell `(x, y)`; the matrix tiles every 8 cells. */
export const bayer = (x: number, y: number): number => BAYER8[(y & 7) * 8 + (x & 7)]!

/**
 * The palette index for tone `t` (clamped to 0–1) at cell `(x, y)` of a palette of `levels`
 * colours: the lower of the two nearest colours, or the upper one when the fractional part beats
 * the cell's threshold.
 */
export function ditherLevel(t: number, levels: number, x: number, y: number): number {
  const n = levels - 1
  const v = (t < 0 ? 0 : t > 1 ? 1 : t) * n
  const base = Math.floor(v)
  return Math.min(n, base + (v - base > bayer(x, y) ? 1 : 0))
}

/** A tone field over normalised coordinates. */
export type Field = (x: number, y: number) => number

/** Six tones of one hue, dark to light: the palette of placeholder art. */
export const ramp = (hue: number, sat: number): string[] => [13, 22, 33, 47, 63, 80].map((l) => `hsl(${hue} ${sat}% ${l}%)`)

/** Placeholder art motifs (from the mockup): landscape, gear, slab, sky, orb and bands. */
export const FIELDS = {
  grass: (x, y) => (y < 0.3 ? 0.95 - y * 0.5 : 0.42 - (y - 0.3) * 0.45 + Math.sin(x * 11) * 0.04),
  gear: (x, y) => {
    const dx = x - 0.5
    const dy = y - 0.5
    const r = Math.hypot(dx, dy)
    return r < 0.14 ? 0.12 : 1.02 - r * 1.45 + Math.cos(Math.atan2(dy, dx) * 8) * 0.07
  },
  slab: (x, y) => 0.9 - (x * 0.4 + y * 0.7) + ((Math.floor(x * 3) + Math.floor(y * 3)) % 2 ? 0.06 : 0),
  sky: (x, y) => (y > 0.68 ? 0.3 - (y - 0.68) * 0.8 : 0.9 - y * 0.55 + (Math.hypot(x - 0.68, y - 0.3) < 0.13 ? 0.35 : 0)),
  orb: (x, y) => 1.05 - Math.hypot(x - 0.32, y - 0.28) * 1.3,
  band: (x, y) => 0.85 - y * 0.75 + Math.sin(x * 6) * 0.05,
} satisfies Record<string, Field>

export type FieldName = keyof typeof FIELDS
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[]

/**
 * Muted tones for placeholder art: greens, earth, slate, sky and stone. Deliberately no purple
 * or magenta (hues 250–335), and low saturation, so generated art never competes with real icons.
 */
export const ART_TONES: readonly (readonly [hue: number, sat: number])[] = [
  [105, 32],
  [24, 44],
  [220, 12],
  [198, 34],
  [40, 32],
  [160, 22],
  [14, 36],
  [210, 20],
  [84, 26],
  [182, 22],
  [32, 14],
]

export interface ArtSpec {
  hue: number
  sat: number
  field: FieldName
}

/** The placeholder art for a seed (e.g. a hue derived from an id): a tone and a motif. */
export function artFor(seed: number): ArtSpec {
  const s = Math.abs(Math.trunc(seed)) || 0
  const [hue, sat] = ART_TONES[s % ART_TONES.length]!
  return { hue, sat, field: FIELD_NAMES[Math.floor(s / ART_TONES.length) % FIELD_NAMES.length]! }
}

/** A flat colour standing in for the art where canvas is unavailable. */
export const artFallback = ({ hue, sat }: ArtSpec): string => `hsl(${hue} ${sat}% 33%)`

/**
 * A progress field along x: full up to `value`, with a dithered edge `soft` px wide, over a bar
 * `width` px wide. The edge is pushed out by its own width so 100% fills the bar completely.
 */
export function progressField(value: number, width: number, soft: number): Field {
  const p = Math.max(0, Math.min(1, value)) * (1 + soft / Math.max(1, width))
  return (x) => ((p - x) * width) / soft + 0.5
}

/** An indeterminate field: a soft band `band` px wide centred at `at` (0–1, may overshoot). */
export function bandField(at: number, width: number, band: number, soft: number): Field {
  return (x) => 0.5 + (band / 2 - Math.abs(x - at) * width) / soft
}

/**
 * Parses a computed CSS colour (`rgb()`, `rgba()`, `color(srgb …)` or `#rrggbb`) and returns it
 * with its alpha multiplied by `alpha`, as `rgb(r g b / a)`; `null` when it can't be read.
 * Canvas `fillStyle` gets this rather than `color-mix()`/`light-dark()`, which only CSS resolves.
 */
export function withAlpha(color: string, alpha = 1): string | null {
  const c = color.trim()
  let rgb: number[] | undefined
  let a = 1
  const hex = /^#([0-9a-f]{6})$/i.exec(c)
  if (hex) rgb = [0, 2, 4].map((i) => Number.parseInt(hex[1]!.slice(i, i + 2), 16))
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      rgb = parts.slice(0, 3)
      if (parts.length > 3) a = parts[3]!
    }
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(c)
  if (srgb) {
    const parts = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      rgb = parts.slice(0, 3).map((v) => v * 255)
      if (parts.length > 3) a = parts[3]!
    }
  }
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))))
  return `rgb(${r} ${g} ${b} / ${+(a * alpha).toFixed(3)})`
}

export interface DitherSpec {
  /** CSS size in px. */
  width: number
  height: number
  /** Cell size in CSS px (1 = one dot per CSS pixel). */
  cell: number
  /** Colours from tone 0 to tone 1; `null` leaves those cells transparent. */
  palette: readonly (string | null)[]
  field: Field
}

/**
 * Paints `spec` on `canvas` at the device pixel ratio (the backing store is resized only when the
 * size changes). Cells are batched per colour. Returns false when there is no 2D context
 * (tests, or a lost context), so callers can fall back to a flat colour.
 */
export function drawDither(canvas: HTMLCanvasElement, spec: DitherSpec, dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1): boolean {
  const { width, height, cell, palette, field } = spec
  const W = Math.max(1, Math.round(width * dpr))
  const H = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W
    canvas.height = H
  }
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return false
  const cols = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const levels = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) levels[y * cols + x] = ditherLevel(field((x + 0.5) / cols, (y + 0.5) / rows), palette.length, x, y)
  const s = cell * dpr
  ctx.clearRect(0, 0, W, H)
  palette.forEach((colour, level) => {
    if (!colour) return
    ctx.fillStyle = colour
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] !== level) continue
      const x = i % cols
      const y = (i - x) / cols
      ctx.fillRect(Math.floor(x * s), Math.floor(y * s), Math.ceil(s), Math.ceil(s))
    }
  })
  return true
}
