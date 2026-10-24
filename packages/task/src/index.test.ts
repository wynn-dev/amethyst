import { describe, expect, it, vi } from 'vitest'
import { CancelledError, createTask, mapLimit, type TaskSnapshot } from './index'

describe('createTask', () => {
  it('aggregates weighted child progress', async () => {
    let mid = 0
    const task = createTask('root', async (ctx) => {
      await ctx.child('a', async (c) => c.update(10, 10), { weight: 3 })
      await ctx.child('b', async (c) => {
        c.update(5, 10)
        mid = task.snapshot().fraction
      })
    })
    await task.promise
    expect(mid).toBeCloseTo((3 * 1 + 1 * 0.5) / 4)
    expect(task.snapshot().fraction).toBe(1)
    expect(task.snapshot().state).toBe('succeeded')
  })

  it('marks failures and propagates the error', async () => {
    const task = createTask('root', async (ctx) => {
      await ctx.child('bad', async () => {
        throw new Error('boom')
      })
    })
    await expect(task.promise).rejects.toThrow('boom')
    const snap = task.snapshot()
    expect(snap.state).toBe('failed')
    expect(snap.children[0]?.error?.message).toBe('boom')
  })

  it('cancels cooperatively', async () => {
    const task = createTask('root', async (ctx) => {
      await new Promise((r) => setTimeout(r, 20))
      ctx.throwIfAborted()
    })
    task.cancel()
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError)
    expect(task.snapshot().state).toBe('cancelled')
  })

  it('throttles update notifications', async () => {
    vi.useFakeTimers()
    const onUpdate = vi.fn<(snapshot: TaskSnapshot) => void>()
    const task = createTask(
      'root',
      async (ctx) => {
        for (let i = 0; i < 1000; i++) ctx.update(i, 1000)
      },
      { onUpdate, throttleMs: 100 },
    )
    await task.promise
    vi.runAllTimers()
    vi.useRealTimers()
    expect(onUpdate.mock.calls.length).toBeLessThan(5)
  })
})

describe('mapLimit', () => {
  it('respects the concurrency limit and keeps order', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBe(2)
  })
})
