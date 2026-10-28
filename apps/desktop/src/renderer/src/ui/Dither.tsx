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
  /** Opacity of the dots (the colour is the element's text colour, `text-accent` by default). */
  alpha?: number
  className?: string
}

/**
 * Dithered progress: the fill is drawn as ordered-dither dots in the current text colour, with a
 * soft dithered edge. It fills its box (size it with `className`). Redrawn only when the value,
 * size or theme changes; the indeterminate band animates only while it is on screen, and stands
 * still under Reduce Motion.
 */
export function DitherProgress({ value, label, cell = 1, soft = 18, alpha = 1, className }: DitherProgressProps) {
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
    if (reducedMotion()) {
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
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `theme` is the redraw trigger for colours read from CSS
  }, [determinate, value, width, height, cell, soft, alpha, theme])

  return (
    <div
      ref={box}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label && determinate ? Math.round(value * 100) : undefined}
      className={cn('relative overflow-hidden text-accent', className)}
    >
      <canvas ref={canvas} aria-hidden className="absolute inset-0 block size-full" />
    </div>
  )
}

/** A dithered progress bar on a faint track (download rows, Activity). */
export function DitherBar({ value, label, className }: { value?: number; label: string; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-[2px] bg-fill', className)}>
      <DitherProgress value={value} label={label} cell={2} soft={16} alpha={0.9} className="size-full" />
    </div>
  )
}
