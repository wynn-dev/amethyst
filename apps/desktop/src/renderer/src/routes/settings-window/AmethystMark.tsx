import { useId } from 'react'
import { cn } from '@/ui'

/** The Amethyst app icon: a faceted gem on a rounded-square tile, drawn in SVG. */
export function AmethystMark({ size = 64, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Amethyst" className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b2563" />
          <stop offset="1" stopColor="#1c1030" />
        </linearGradient>
        <linearGradient id={`${id}-gem`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e1c8ff" />
          <stop offset="0.45" stopColor="#a374ee" />
          <stop offset="1" stopColor="#5b2fa8" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${id}-bg)`} />
      <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="rgb(255 255 255 / 0.12)" />
      {/* Crown and pavilion facets */}
      <polygon points="20,16 44,16 54,27 32,54 10,27" fill={`url(#${id}-gem)`} />
      <polygon points="20,16 26,27 10,27" fill="#f0e2ff" opacity="0.75" />
      <polygon points="44,16 54,27 38,27" fill="#6b3dbb" opacity="0.6" />
      <polygon points="26,27 38,27 32,54" fill="#c6a2fb" opacity="0.55" />
      <polygon points="10,27 26,27 32,54" fill="#8c5ad9" opacity="0.5" />
      <polygon points="38,27 54,27 32,54" fill="#4e2496" opacity="0.65" />
      <polygon points="20,16 44,16 38,27 26,27" fill="#d9bcff" opacity="0.7" />
      <polyline points="20,16 44,16 54,27 32,54 10,27 20,16" fill="none" stroke="rgb(255 255 255 / 0.35)" strokeWidth="0.75" strokeLinejoin="round" />
    </svg>
  )
}
