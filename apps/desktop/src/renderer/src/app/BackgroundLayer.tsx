import { useEffect, useRef, type CSSProperties } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { backgroundUrl, useAppearance } from '@/data/appearance'
import { api, subscribe } from '@/lib/rpc'
import { cn } from '@/ui'

/**
 * Optional theme background (B8): an image or a muted video under the content. Off by default.
 *
 * - The media comes from the data root through `amethyst-asset://` (settings.setBackground).
 * - `overlay` draws the window colour over it on every page except Home, so text stays legible.
 * - The video pauses while the window is hidden or minimised, while a game runs, and never plays
 *   under Reduce Motion (it shows its first frame). Reduce Transparency hides the layer (CSS).
 */
export function BackgroundLayer() {
  const appearance = useAppearance()
  const { kind, fit, blur, overlay } = appearance.background
  const url = backgroundUrl(appearance)
  const home = useRouterState({ select: (s) => s.location.pathname === '/' })
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = video.current
    if (!el || kind !== 'video' || !url) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    const running = new Set<string>()
    let live = true
    const sync = () => {
      if (document.hidden || reduce.matches || running.size > 0) el.pause()
      else el.play().catch(() => {})
    }
    const unsubscribe = subscribe('launch:state', (e) => {
      if (e.state === 'preparing' || e.state === 'running') running.add(e.instanceId)
      else running.delete(e.instanceId)
      sync()
    })
    api.launch.listRunning().then(
      (games) => {
        if (!live) return
        for (const g of games) running.add(g.instanceId)
        sync()
      },
      () => {},
    )
    sync()
    document.addEventListener('visibilitychange', sync)
    reduce.addEventListener('change', sync)
    return () => {
      live = false
      unsubscribe()
      document.removeEventListener('visibilitychange', sync)
      reduce.removeEventListener('change', sync)
      el.pause()
    }
  }, [kind, url])

  if (!url) return null
  const mediaClass = cn('size-full', fit === 'contain' ? 'object-contain' : 'object-cover')
  // Scaling hides the soft, transparent edge that a CSS blur leaves at the borders.
  const style: CSSProperties | undefined = blur ? { filter: `blur(${blur}px)`, transform: 'scale(1.06)' } : undefined
  return (
    <div aria-hidden className="bg-layer pointer-events-none absolute inset-0 -z-0 overflow-hidden">
      {kind === 'image' ? (
        <img src={url} alt="" decoding="async" className={mediaClass} style={style} />
      ) : (
        <video ref={video} src={url} muted loop playsInline preload="auto" disablePictureInPicture className={mediaClass} style={style} />
      )}
      {/* Content pages get the tint (if on); Home always gets a light wash so the toolbar title stays legible. */}
      {overlay && !home ? <div className="absolute inset-0 bg-window opacity-[0.82]" /> : <div className="absolute inset-0 bg-window opacity-40" />}
    </div>
  )
}
