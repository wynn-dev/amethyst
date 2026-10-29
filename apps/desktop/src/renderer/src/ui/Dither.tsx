import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { cn } from './cn'
import { bandField, drawDither, progressField, withAlpha } from './dither-math'
import { reducedMotion } from './motion'

/*
 * Theme changes (system appearance, the forced appearance, the accent on <html>) redraw canvases,
 * which can't follow CSS colours by themselves.
 */
let themeVersion = 0
const themeListeners = new Set<() => void>()
let stopWatching: (() => void) | null = null

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  if (!stopWatching && typeof document !== 'undefined') {
    const bump = () => {
      themeVersion++
      for (const l of themeListeners) l()
    }
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    scheme?.addEventListener('change', bump)
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(bump) : null
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-appearance'] })
    stopWatching = () => {
      scheme?.removeEventListener('change', bump)
      observer?.disconnect()
    }
  }
  return () => {
    themeListeners.delete(listener)
    if (!themeListeners.size) {
      stopWatching?.()
      stopWatching = null
    }
  }
}

/** A number that changes whenever colours resolved from CSS may have changed. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    subscribeTheme,
    () => themeVersion,
    () => 0,
  )
}

/** The element's CSS size, tracked with a ResizeObserver. */
function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export interface DitherProgressProps {
  /** 0–1. Omit for an indeterminate bar (a dithered band that travels while it is shown). */
  value?: number
  /** Accessible name. Omit when the progress is part of a control that already announces it. */
  label?: string
  /** Dot size in CSS px. */
  cell?: number
  /** Width of the dithered edge in CSS px. */
  soft?: number
  /** Opacity of the dots. */
  alpha?: number
  /** The dot colour, as a text-colour class (`text-accent` by default). */
  tone?: string
  /** Hold the indeterminate band still (paused work). */
  paused?: boolean
  className?: string
}

/**
 * Dithered progress: the fill is drawn as ordered-dither dots in the current text colour, with a
 * soft dithered edge. It fills its box (size it with `className`). Redrawn only when the value,
 * size or theme changes; the indeterminate band animates (at most ~30 fps) only while it is on
 * screen and not `paused`, and stands still under Reduce Motion. No frames are requested otherwise.
 */
export function DitherProgress({ value, label, cell = 1, soft = 18, alpha = 1, tone = 'text-accent', paused = false, className }: DitherProgressProps) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height } = useSize(box)
  const theme = useThemeVersion()
  const determinate = value !== undefined

  useEffect(() => {
    const el = box.current
    const cv = canvas.current
    if (!el || !cv || !width || !height) return
    const colour = withAlpha(getComputedStyle(el).color, alpha)
    if (!colour) return
    const palette = [null, colour]
    if (determinate) {
      drawDither(cv, { width, height, cell, palette, field: progressField(value, width, soft) })
      return
    }
    const band = Math.min(width * 0.4, 120)
    const draw = (t: number) => drawDither(cv, { width, height, cell, palette, field: bandField(((t / 1600) % 1) * 1.6 - 0.3, width, band, soft) })
    if (paused || reducedMotion()) {
      draw(800)
      return
    }
    let raf = 0
    let last = 0
    const tick = (t: number) => {
      // ~30 fps is plenty for a dot pattern and halves the work.
      if (t - last > 32) {
        last = t
        draw(t)
      }
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    // A frame now, so the band shows before the first visibility report.
    draw(performance.now())
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return stop
    }
    // Off screen (scrolled away, in a hidden pane), the loop stops until the bar is visible again.
    const io = new IntersectionObserver((entries) => (entries.at(-1)?.isIntersecting ? start() : stop()))
    io.observe(el)
    return () => {
      io.disconnect()
      stop()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `theme` is the redraw trigger for colours read from CSS
  }, [determinate, value, width, height, cell, soft, alpha, tone, paused, theme])

  return (
    <div
      ref={box}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label && determinate ? Math.round(value * 100) : undefined}
      // `relative` unless the caller positions it (cn doesn't resolve conflicting classes).
      className={cn(/(^|\s)(absolute|fixed)(\s|$)/.test(className ?? '') ? undefined : 'relative', 'overflow-hidden', tone, className)}
    >
      <canvas ref={canvas} aria-hidden className="absolute inset-0 block size-full" />
    </div>
  )
}

/** A dithered progress bar on a faint track (download rows, Activity). `muted` for paused work: grey, and an indeterminate band holds still. */
export function DitherBar({ value, label, muted, className }: { value?: number; label: string; muted?: boolean; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-[2px] bg-fill', className)}>
      <DitherProgress value={value} label={label} cell={2} soft={16} alpha={0.9} tone={muted ? 'text-label-3' : 'text-accent'} paused={muted} className="size-full" />
    </div>
  )
}
