import { useEffect, useRef } from 'react'
import { IdleAnimation, SkinViewer, WalkingAnimation } from 'skinview3d'
import { normalizeTextureUrl } from '@/lib/skin'
import { makeSkin, textureCanvas } from '@/lib/skin-texture'
import type { SkinViewerProps } from './SkinViewer'

/**
 * The WebGL skin viewer (skinview3d, MIT, on three.js). Loaded lazily through `SkinViewer.tsx`, so
 * neither library is ever in the entry chunk.
 *
 * - Drag rotates (orbit); zoom and pan are off so the settings pane keeps scrolling.
 * - Our own frame loop at 30 fps drives the animation. It stops entirely when the viewer is
 *   off-screen, the window is hidden or minimised, `paused` is set, or Reduce Motion is on; then
 *   frames are drawn only on demand (drag, texture change, resize).
 * - Legacy 64×32 skins are converted to the 64×64 layout by skinview3d (mirrored limbs, opaque
 *   hat cleared), and `model` picks 4 px or 3 px arms.
 * - Unmounting disposes every GPU resource and forces the WebGL context to be released at once:
 *   Chromium caps live contexts per process.
 */
export default function SkinViewer3D({ skin, model, cape, animation = 'idle', paused = false, onError, className }: SkinViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)
  const loadsRef = useRef<Promise<void>>(Promise.resolve())
  const stateRef = useRef({ animate: animation !== 'none', paused, onScreen: true, update: () => {} })
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })

  // Create the viewer once; tear it down (and free the context) on unmount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A fresh canvas per viewer: a canvas whose context was released can never get a new one.
    const canvas = document.createElement('canvas')
    canvas.className = 'block size-full cursor-grab touch-none outline-none active:cursor-grabbing'
    host.append(canvas)
    const rect = host.getBoundingClientRect()
    const viewer = new SkinViewer({
      canvas,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      renderPaused: true,
      fov: 38,
      zoom: 0.82,
    })
    viewerRef.current = viewer
    viewer.controls.enableZoom = false
    viewer.controls.enablePan = false
    viewer.playerWrapper.rotation.y = -0.5
    viewer.globalLight.intensity = 3
    viewer.cameraLight.intensity = 0.6

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const state = stateRef.current
    let raf = 0
    let last = 0
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame)
      if (last && t - last < 1000 / 30 - 2) return
      const dt = last ? Math.min((t - last) / 1000, 0.1) : 0
      last = t
      viewer.animation?.update(viewer.playerObject, dt)
      viewer.controls.update()
      viewer.render()
    }
    const update = () => {
      const run = state.animate && !state.paused && state.onScreen && !document.hidden && !reduceMotion.matches
      if (run && !raf) {
        last = 0
        raf = requestAnimationFrame(frame)
      } else if (!run && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    state.update = update
    const renderNow = () => {
      if (!raf && !viewer.disposed) viewer.render()
    }

    viewer.controls.addEventListener('change', renderNow)
    const resize = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return
      viewer.setSize(entry.contentRect.width, entry.contentRect.height)
      renderNow()
    })
    resize.observe(host)
    const visibility = new IntersectionObserver(([entry]) => {
      state.onScreen = entry?.isIntersecting ?? true
      update()
    })
    visibility.observe(host)
    document.addEventListener('visibilitychange', update)
    reduceMotion.addEventListener('change', update)
    update()

    return () => {
      cancelAnimationFrame(raf)
      raf = 0
      state.update = () => {}
      resize.disconnect()
      visibility.disconnect()
      document.removeEventListener('visibilitychange', update)
      reduceMotion.removeEventListener('change', update)
      viewer.controls.removeEventListener('change', renderNow)
      viewer.dispose()
      viewer.renderer.forceContextLoss()
      canvas.remove()
      viewerRef.current = null
    }
  }, [])

  // Animation choice and pausing.
  useEffect(() => {
    const viewer = viewerRef.current
    const state = stateRef.current
    state.animate = animation !== 'none'
    state.paused = paused
    if (viewer) {
      if (animation === 'none') viewer.animation = null
      else if (animation === 'walk' && !(viewer.animation instanceof WalkingAnimation)) viewer.animation = Object.assign(new WalkingAnimation(), { speed: 0.6 })
      else if (animation === 'idle' && !(viewer.animation instanceof IdleAnimation)) viewer.animation = new IdleAnimation()
      viewer.render()
    }
    state.update()
  }, [animation, paused])

  // Skin: loads are serialized, and results for a disposed viewer are dropped.
  useEffect(() => {
    let current = true
    loadsRef.current = loadsRef.current.then(async () => {
      const viewer = viewerRef.current
      if (!current || !viewer || viewer.disposed) return
      try {
        const options = { model: model === 'slim' ? ('slim' as const) : ('default' as const) }
        if (skin) await viewer.loadSkin(normalizeTextureUrl(skin), options)
        else viewer.loadSkin(textureCanvas(makeSkin({ model })), options)
        if (!viewer.disposed) viewer.render()
      } catch (e) {
        if (!current) return
        const bad = e instanceof Error && /Bad skin size/.test(e.message)
        onErrorRef.current?.(bad ? 'Invalid skin image (must be 64 × 64 or 64 × 32).' : 'Couldn’t load the skin.')
      }
    })
    return () => {
      current = false
    }
  }, [skin, model])

  // Cape: chained the same way; `null` removes it from the model.
  useEffect(() => {
    let current = true
    loadsRef.current = loadsRef.current.then(async () => {
      const viewer = viewerRef.current
      if (!current || !viewer || viewer.disposed) return
      try {
        if (cape) await viewer.loadCape(normalizeTextureUrl(cape))
        else viewer.loadCape(null)
        if (!viewer.disposed) viewer.render()
      } catch {
        if (current) onErrorRef.current?.('Couldn’t load the cape.')
      }
    })
    return () => {
      current = false
    }
  }, [cape])

  return <div ref={hostRef} className={className ?? 'size-full'} />
}

