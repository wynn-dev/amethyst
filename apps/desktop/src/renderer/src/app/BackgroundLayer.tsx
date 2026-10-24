import { useEffect, useRef } from 'react'
import { useSettings } from '@/data/settings'

/**
 * Optional theme background (B8): an image or a muted video under the content, with dim and blur.
 * Off by default. The video pauses while the window is hidden and never plays under Reduce Motion;
 * Reduce Transparency hides the layer entirely (handled in CSS).
 */
export function BackgroundLayer() {
  const { background } = useSettings()
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = video.current
    if (!el) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => {
      if (document.hidden || reduce.matches) el.pause()
      else el.play().catch(() => {})
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    reduce.addEventListener('change', sync)
    // TODO(wire): also pause while a game launched by Amethyst is running, and in Low Power Mode.
    return () => {
      document.removeEventListener('visibilitychange', sync)
      reduce.removeEventListener('change', sync)
    }
  }, [background.kind, background.url])

  if (background.kind === 'none' || !background.url) return null
  const fit = background.fit === 'fill' ? 'object-cover' : 'object-contain'
  const style = { filter: background.blur ? `blur(${background.blur}px)` : undefined, transform: background.blur ? 'scale(1.06)' : undefined }
  return (
    <div aria-hidden className="bg-layer pointer-events-none absolute inset-0 -z-0 overflow-hidden">
      {background.kind === 'image' ? (
        <img src={background.url} alt="" decoding="async" className={`size-full ${fit}`} style={style} />
      ) : (
        <video ref={video} src={background.url} muted={background.volume === 0} loop playsInline className={`size-full ${fit}`} style={style} />
      )}
      {/* Dim is enforced at a minimum so text over the background stays legible (B15). */}
      <div className="absolute inset-0 bg-window" style={{ opacity: Math.max(0.35, background.dim / 100) }} />
    </div>
  )
}
