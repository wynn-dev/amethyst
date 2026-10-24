// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createToastStore, MAX_VISIBLE } from './toast-store'
import { ToastViewport } from './Toast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('toast store', () => {
  it('keeps at most three toasts, newest first', () => {
    const store = createToastStore()
    for (let i = 1; i <= 5; i++) store.show({ title: `Toast ${i}` })
    expect(store.getSnapshot()).toHaveLength(MAX_VISIBLE)
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['Toast 5', 'Toast 4', 'Toast 3'])
  })

  it('merges duplicates into ×N instead of stacking them', () => {
    const store = createToastStore()
    store.show({ kind: 'error', title: 'Download failed' })
    store.show({ title: 'Other' })
    store.show({ kind: 'error', title: 'Download failed' })
    const [first, second] = store.getSnapshot()
    expect(store.getSnapshot()).toHaveLength(2)
    expect(first).toMatchObject({ title: 'Download failed', count: 2 })
    expect(second?.title).toBe('Other')
  })

  it('caps actions at two and uses longer timeouts for problems', () => {
    const store = createToastStore()
    const noop = () => {}
    store.show({ kind: 'warning', title: 'W', actions: [{ label: 'A', onClick: noop }, { label: 'B', onClick: noop }, { label: 'C', onClick: noop }] })
    store.show({ kind: 'success', title: 'S' })
    const [s, w] = store.getSnapshot()
    expect(w?.actions).toHaveLength(2)
    expect(w?.duration).toBe(10_000)
    expect(s?.duration).toBe(5_000)
  })
})

describe('ToastViewport', () => {
  it('renders the stack in a live region and dismisses on its timer', () => {
    vi.useFakeTimers()
    const store = createToastStore()
    render(<ToastViewport store={store} />)
    act(() => {
      store.show({ title: 'One' })
      store.show({ kind: 'error', title: 'Two' })
    })
    expect(screen.getByRole('list').getAttribute('aria-live')).toBe('polite')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(5_100))
    expect(screen.queryByText('One')).toBeNull()
    expect(screen.getByText('Two')).toBeTruthy()
  })

  it('pauses dismissal while hovered', () => {
    vi.useFakeTimers()
    const store = createToastStore()
    render(<ToastViewport store={store} />)
    act(() => {
      store.show({ title: 'Stay' })
    })
    fireEvent.mouseEnter(screen.getByRole('list'))
    act(() => vi.advanceTimersByTime(20_000))
    expect(screen.getByText('Stay')).toBeTruthy()
    fireEvent.mouseLeave(screen.getByRole('list'))
    act(() => vi.advanceTimersByTime(5_100))
    expect(screen.queryByText('Stay')).toBeNull()
  })
})
