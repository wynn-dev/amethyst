// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { DitherBar, DitherProgress } from './Dither'

type Report = (entries: { isIntersecting: boolean }[]) => void
let reports: Report[] = []
let raf: ReturnType<typeof vi.fn<(cb: FrameRequestCallback) => number>>
const restore: (() => void)[] = []

function stubSize(prop: 'clientWidth' | 'clientHeight', value: number) {
  const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
  restore.push(() => (before ? Object.defineProperty(HTMLElement.prototype, prop, before) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]))
}

beforeEach(() => {
  reports = []
  stubSize('clientWidth', 120)
  stubSize('clientHeight', 6)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ color: 'rgb(0, 0, 0)' }) as CSSStyleDeclaration)
  raf = vi.fn<(cb: FrameRequestCallback) => number>(() => 1)
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', vi.fn<(id: number) => void>())
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: Report) {
        reports.push(cb)
      }
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const r of restore.splice(0)) r()
})

describe('DitherProgress', () => {
  it('animates an indeterminate band only while it is on screen', () => {
    render(<DitherProgress label="Loading" />)
    expect(reports).toHaveLength(1)
    expect(raf).not.toHaveBeenCalled()
    act(() => reports[0]!([{ isIntersecting: true }]))
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => reports[0]!([{ isIntersecting: false }]))
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('requests no frames for paused work or a known value', () => {
    render(
      <>
        <DitherBar label="Paused" muted />
        <DitherProgress value={0.4} label="Installing" />
      </>,
    )
    expect(reports).toHaveLength(0)
    expect(raf).not.toHaveBeenCalled()
  })
})
