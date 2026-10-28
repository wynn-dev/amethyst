/**
 * Motion: spring curves, the Reduce Motion check, and the two morphs the UI uses — a FLIP
 * "flight" (an element arrives from where its source was) and "grow from trigger" (a floating
 * surface scales out of the control that opened it). CSS transitions use the same springs through
 * the `ease-spring` / `ease-snappy` tokens and `--duration-spring` / `--duration-snappy`
 * (styles.css), which are zero under Reduce Motion.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface Spring {
  /** A CSS `linear()` easing that samples the spring. */
  easing: string
  /** Settling time in ms (within 0.2% of rest). */
  duration: number
}

/**
 * Samples a unit-mass spring (`stiffness`, `damping`) from 0 to 1 into a CSS `linear()` curve,
 * the same generator as the mockup. Under-damped springs overshoot slightly; critically damped
 * ones don't.
 */
export function spring(stiffness: number, damping: number, samples = 32): Spring {
  const w = Math.sqrt(stiffness)
  const z = damping / (2 * w)
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - z * z))
  const f = (t: number) => (z < 1 ? 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t)) : 1 - Math.exp(-w * t) * (1 + w * t))
  let settle = 0
  for (let t = 0; t < 4; t += 1 / 500) if (Math.abs(1 - f(t)) > 0.002) settle = t
  const points: number[] = []
  for (let i = 0; i <= samples; i++) points.push(+f((settle * i) / samples).toFixed(3))
  points[samples] = 1
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(settle * 1000) }
}

/** The UI spring: indicators, the Play morph, flights. Matches `--ease-spring`. */
export const SPRING = spring(240, 24)
/** The sheet spring: popovers and the palette growing from their trigger. Matches `--ease-snappy`. */
export const SNAPPY = spring(420, 38)
/** Leaving: quick and accelerating. Matches `--ease-exit`. */
export const EXIT_EASING = 'cubic-bezier(0.4, 0, 0.8, 0.4)'

/** True when the user asked for less motion (System Settings → Accessibility → Display). */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

type Box = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

/** The transform that maps `to` onto `from` (FLIP's "invert" step), with the origin top-left. */
export function invert(from: Box, to: Box, uniform = true): string {
  const sx = from.width / (to.width || 1)
  const sy = uniform ? sx : from.height / (to.height || 1)
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${+sx.toFixed(4)}, ${+sy.toFixed(4)})`
}

const animatable = (el: Element): el is HTMLElement => typeof (el as HTMLElement).animate === 'function'

/**
 * FLIP: plays `el` from the box `from` (e.g. the sidebar tile that was clicked) to where it is
 * now, on the UI spring. Under Reduce Motion it fades in instead.
 */
export function flyFrom(el: HTMLElement, from: Box): Animation | null {
  if (!animatable(el)) return null
  if (reducedMotion()) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 })
  const to = el.getBoundingClientRect()
  if (!to.width || !from.width) return null
  return el.animate([{ transformOrigin: '0 0', transform: invert(from, to) }, { transformOrigin: '0 0', transform: 'none' }], { duration: SPRING.duration, easing: SPRING.easing })
}

/**
 * Grows a floating surface out of the control that opened it (translate + non-uniform scale on
 * the sheet spring), with its contents fading in just after. Reduce Motion: a short fade.
 */
export function growFrom(el: HTMLElement, trigger: Box, content?: HTMLElement | null): Animation | null {
  if (!animatable(el)) return null
  if (reducedMotion()) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 })
  const to = el.getBoundingClientRect()
  if (!to.width || !trigger.width) return null
  content?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay: 70, fill: 'backwards' })
  return el.animate(
    [
      { transformOrigin: '0 0', transform: invert(trigger, to, false), opacity: 0.4 },
      { transformOrigin: '0 0', transform: 'none', opacity: 1 },
    ],
    { duration: SNAPPY.duration, easing: SNAPPY.easing },
  )
}

/*
 * Flight sources: a control that starts a navigation marks the element the destination should
 * fly in from (the sidebar tile of an instance); the destination takes it once. Nothing is marked
 * for keyboard shortcuts or the palette, so those just switch.
 */
const sources = new Map<string, Box>()

export const flight = {
  mark(key: string, el: Element | null | undefined): void {
    if (el) sources.set(key, el.getBoundingClientRect())
  },
  take(key: string): Box | undefined {
    const box = sources.get(key)
    sources.clear()
    return box
  },
}

/**
 * A selection indicator that slides between items (sidebar rows, tabs). Returns a ref for the
 * indicator element, which must be absolutely positioned at the container's top-left and carry
 * the transition (`transition-[transform,width,height] ease-spring duration-(--duration-spring)`).
 * It is placed on the element matching `selector` inside `container` whenever `key` changes,
 * without animating the first placement or placements caused by resizing. Hidden when nothing
 * matches.
 */
export function useSlidingIndicator(container: RefObject<HTMLElement | null>, selector: string, key: unknown): RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const box = container.current
    const ind = ref.current
    if (!box || !ind) return
    const place = (animate: boolean) => {
      const target = box.querySelector<HTMLElement>(selector)
      if (!target) {
        ind.style.opacity = '0'
        ind.dataset.placed = ''
        return
      }
      const c = box.getBoundingClientRect()
      const r = target.getBoundingClientRect()
      const instant = !animate || !ind.dataset.placed
      if (instant) ind.style.transition = 'none'
      ind.style.opacity = '1'
      ind.style.transform = `translate(${r.left - c.left + box.scrollLeft}px, ${r.top - c.top + box.scrollTop}px)`
      ind.style.width = `${r.width}px`
      ind.style.height = `${r.height}px`
      if (instant) {
        void ind.offsetWidth
        ind.style.transition = ''
      }
      ind.dataset.placed = '1'
    }
    place(true)
    if (typeof ResizeObserver === 'undefined') return
    // Re-place without animating when the layout really changes (not on the observer's first call,
    // which would cancel the slide that just started).
    const target = box.querySelector<HTMLElement>(selector)
    const size = () => `${box.clientWidth}x${box.clientHeight}:${target?.offsetLeft},${target?.offsetTop},${target?.offsetWidth}x${target?.offsetHeight}`
    let last = size()
    const ro = new ResizeObserver(() => {
      const now = size()
      if (now === last) return
      last = now
      place(false)
    })
    ro.observe(box)
    if (target) ro.observe(target)
    return () => ro.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` (the selection) is the re-placement trigger
  }, [container, selector, key])
  return ref
}
