import { memo, useMemo } from 'react'
import { cn } from './cn'
import { artFallback, artFor, drawDither, FIELDS, ramp, type ArtSpec } from './dither-math'

/** Generated art, as data URLs, by spec, size and pixel ratio: drawn once, shared by every tile. */
const cache = new Map<string, string | null>()

function artUrl(spec: ArtSpec, size: number): string | null {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  const key = `${spec.hue},${spec.sat},${spec.field},${size},${dpr}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let url: string | null = null
  try {
    const canvas = document.createElement('canvas')
    // Larger tiles use 2px dots, so the texture reads the same at every size.
    const cell = size >= 48 ? 2 : 1
    if (drawDither(canvas, { width: size, height: size, cell, palette: ramp(spec.hue, spec.sat), field: FIELDS[spec.field] }, dpr)) url = canvas.toDataURL()
  } catch {
    url = null
  }
  cache.set(key, url)
  return url
}

/** Tile corner radius for a size (16 → 4, 18 → 5, 28 → 7, 32 → 8). */
export const artRadius = (size: number) => Math.max(4, Math.round(size * 0.25))

const ring = 'pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_0.5px_light-dark(rgb(0_0_0/0.12),rgb(255_255_255/0.14))]'

export interface InstanceArtProps {
  /** Any number derived from the subject (e.g. a hue hashed from its id); picks tone and motif. */
  seed: number
  size: number
  /** The real icon, when there is one. It always wins over generated art. */
  src?: string
  className?: string
}

/**
 * The art tile of an instance or project: its real icon when it has one, otherwise a seeded,
 * muted, ordered-dither tile (never purple). Both get the same radius and inner hairline.
 */
export const InstanceArt = memo(function InstanceArt({ seed, size, src, className }: InstanceArtProps) {
  const spec = useMemo(() => artFor(seed), [seed])
  const url = useMemo(() => (src ? null : artUrl(spec, size)), [src, spec, size])
  const style = { width: size, height: size, borderRadius: artRadius(size) }
  if (src) {
    return (
      <span data-art aria-hidden className={cn('relative inline-block shrink-0 overflow-hidden', className)} style={style}>
        <img src={src} alt="" loading="lazy" decoding="async" width={size} height={size} className="block size-full object-cover" />
        <span className={ring} />
      </span>
    )
  }
  return (
    <span
      data-art
      aria-hidden
      className={cn('relative inline-block shrink-0 overflow-hidden', className)}
      style={{ ...style, background: url ? `url(${url}) 0 0 / 100% 100%` : artFallback(spec) }}
    >
      <span className={ring} />
    </span>
  )
})
