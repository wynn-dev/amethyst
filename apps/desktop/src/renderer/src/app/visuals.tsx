import { memo } from 'react'
import { InstanceArt } from '@/ui/InstanceArt'
import { artFor } from '@/ui/dither-math'
import { cn } from '@/ui/cn'

/**
 * The icon of an instance or project: its real icon when known, otherwise seeded dithered art
 * (ui/InstanceArt). `hue` is any stable number derived from the subject's id; `label` is kept for
 * callers but no longer drawn (the placeholder carries no letter).
 */
export const BlockIcon = memo(function BlockIcon({
  hue,
  size = 20,
  className,
  src,
}: {
  hue: number
  label: string
  size?: number
  className?: string
  /** Real icon URL when known (`amethyst-asset:` or CDN). Loaded lazily. */
  src?: string
}) {
  return <InstanceArt seed={hue} size={size} src={src} className={className} />
})

/** A flat, dark, muted backdrop from the placeholder-art tones (never purple), for cards with light text. */
export function heroTone(seed: number, lightness: number): string {
  const { hue, sat } = artFor(seed)
  return `hsl(${hue} ${Math.round(sat * 0.6)}% ${lightness}%)`
}

// 8×8 face: 0 hair, 1 skin, 2 shade, 3 eye white, 4 iris, 5 mouth
const FACE = ['00000000', '00000000', '01111110', '11111111', '13411431', '11122111', '11255211', '21111112']
const PIXELS = FACE.flatMap((row, y) => [...row].map((c, x) => ({ key: y * 8 + x, x, y, c: Number(c) })))

/** A pixel-art player head generated from a hue, standing in for the real skin face. */
export const PlayerHead = memo(function PlayerHead({ hue: seed, size = 20, className }: { hue: number; size?: number; className?: string }) {
  // The same muted, never-purple tones as the placeholder art.
  const hue = artFor(seed).hue
  const hair = `hsl(${hue} 42% 28%)`
  const skin = `hsl(${(hue + 25) % 360} 38% 66%)`
  const shade = `hsl(${(hue + 25) % 360} 32% 56%)`
  const fill = [hair, skin, shade, '#fff', `hsl(${(hue + 180) % 360} 55% 45%)`, `hsl(${hue} 30% 22%)`]
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cn('shrink-0 rounded-[3px] shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)]', className)}
    >
      {PIXELS.map((p) => <rect key={p.key} x={p.x} y={p.y} width={1} height={1} fill={fill[p.c]} />)}
    </svg>
  )
})

/** `relative` unless the caller already positions the element (Tailwind can't merge the two). */
export const positioned = (className?: string) => (/(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className ?? '') ? undefined : 'relative')

const units = ['B', 'KB', 'MB', 'GB', 'TB']
export function formatBytes(n: number): string {
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`
  return String(n)
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now
  const abs = Math.abs(diff)
  if (abs < 60_000) return 'just now'
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day')
  if (abs < 365 * 86_400_000) return rtf.format(Math.round(diff / (30 * 86_400_000)), 'month')
  return rtf.format(Math.round(diff / (365 * 86_400_000)), 'year')
}

const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })
export const formatDate = (ts: number) => dateFmt.format(ts)

export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 60_000) return 'less than a minute'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h === 0) return `${m} min`
  return m ? `${h} hr ${m} min` : `${h} hr`
}
