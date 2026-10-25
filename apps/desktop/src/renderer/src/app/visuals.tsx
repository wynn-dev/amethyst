import { memo } from 'react'
import { cn } from '@/ui/cn'

/**
 * Generated block-style icon used until an instance or project has a real icon. Cheap: pure CSS,
 * no images, so long virtualised lists never decode bitmaps.
 */
export const BlockIcon = memo(function BlockIcon({
  hue,
  label,
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
  const radius = Math.max(4, Math.round(size * 0.24))
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={size}
        height={size}
        className={cn('shrink-0 object-cover', className)}
        style={{ borderRadius: radius }}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold text-white', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.46),
        background: `linear-gradient(160deg, hsl(${hue} 62% 62%), hsl(${(hue + 28) % 360} 58% 40%))`,
        boxShadow: 'inset 0 0 0 0.5px rgb(0 0 0 / 0.18), inset 0 1px 0 rgb(255 255 255 / 0.25)',
        textShadow: '0 1px 1px rgb(0 0 0 / 0.25)',
      }}
    >
      <span
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(45deg, #000 25%, transparent 25%, transparent 75%, #000 75%), linear-gradient(45deg, #000 25%, transparent 25%, transparent 75%, #000 75%)',
          backgroundSize: `${size / 4}px ${size / 4}px`,
          backgroundPosition: `0 0, ${size / 8}px ${size / 8}px`,
        }}
      />
      <span className="relative leading-none">{label.trim().charAt(0).toUpperCase()}</span>
    </span>
  )
})

// 8×8 face: 0 hair, 1 skin, 2 shade, 3 eye white, 4 iris, 5 mouth
const FACE = ['00000000', '00000000', '01111110', '11111111', '13411431', '11122111', '11255211', '21111112']
const PIXELS = FACE.flatMap((row, y) => [...row].map((c, x) => ({ key: y * 8 + x, x, y, c: Number(c) })))

/** A pixel-art player head generated from a hue, standing in for the real skin face. */
export const PlayerHead = memo(function PlayerHead({ hue, size = 20, className }: { hue: number; size?: number; className?: string }) {
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

/** Placeholder artwork (screenshots, gallery images) until real images are wired. */
export function ArtTile({ hue, className, label }: { hue: number; className?: string; label?: string }) {
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(positioned(className), 'overflow-hidden', className)}
      style={{
        background: `linear-gradient(180deg, hsl(${(hue + 190) % 360} 60% 72%) 0%, hsl(${(hue + 200) % 360} 55% 82%) 52%, hsl(${hue} 42% 44%) 52%, hsl(${(hue + 20) % 360} 38% 30%) 100%)`,
      }}
    >
      <div className="absolute bottom-[48%] left-[12%] h-[22%] w-[18%] rounded-t-sm" style={{ background: `hsl(${hue} 30% 32%)` }} />
      <div className="absolute bottom-[48%] left-[34%] h-[34%] w-[10%]" style={{ background: `hsl(${(hue + 100) % 360} 35% 36%)` }} />
      <div className="absolute top-[12%] right-[16%] size-[10%] rounded-full bg-white/80" />
    </div>
  )
}

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
