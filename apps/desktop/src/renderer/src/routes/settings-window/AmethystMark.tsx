import { cn } from '@/ui'

/** The Amethyst app icon (build/icon.svg): a faceted crystal in flat greys on a near-black tile. */
export function AmethystMark({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Amethyst" className={cn('shrink-0', className)}>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#121214" />
      <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="rgb(255 255 255 / 0.1)" />
      {/* Crown and pavilion facets */}
      <polygon points="20,16 44,16 38,27 26,27" fill="#d4d4d8" />
      <polygon points="20,16 26,27 10,27" fill="#f4f4f5" />
      <polygon points="44,16 38,27 54,27" fill="#a1a1aa" />
      <polygon points="10,27 26,27 32,54" fill="#b4b4bb" />
      <polygon points="26,27 38,27 32,54" fill="#71717a" />
      <polygon points="38,27 54,27 32,54" fill="#3f3f46" />
      <polyline points="20,16 44,16 54,27 32,54 10,27 20,16" fill="none" stroke="rgb(255 255 255 / 0.3)" strokeWidth="0.75" strokeLinejoin="round" />
      <line x1="10" y1="27" x2="54" y2="27" stroke="rgb(255 255 255 / 0.3)" strokeWidth="0.75" />
    </svg>
  )
}
