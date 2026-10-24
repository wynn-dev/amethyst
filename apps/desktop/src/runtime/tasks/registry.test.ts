/* oxlint-disable no-await-in-loop -- progress is reported step by step on purpose */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Events } from '@shared/events'
import { TaskRegistry } from './registry'

type Batch = Events['tasks:update']

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskRegistry', () => {
  it('throttles snapshots to at most one batch per 100 ms and coalesces tasks', async () => {
    const batches: { at: number; batch: Batch }[] = []
    const registry = new TaskRegistry((batch) => batches.push({ at: Date.now(), batch }), { now: () => Date.now() })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const handles = [1, 2, 3].map((n) =>
      registry.run({ name: 'test.work', params: { n } }, async (ctx) => {
        for (let i = 0; i < 100; i++) {
          ctx.update(i, 100)
          await new Promise((r) => setTimeout(r, 10))
        }
        await gate
        return n
      }),
    )
    // ~1 s of very chatty progress from three tasks.
    await vi.advanceTimersByTimeAsync(1100)
    release()
    await Promise.all(handles.map((h) => h.promise))
    await vi.advanceTimersByTimeAsync(200)

    expect(batches.length).toBeGreaterThan(3)
    for (let i = 1; i < batches.length; i++) {
      expect((batches[i] as { at: number }).at - (batches[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(100)
    }
    // At most ~10 batches per second even with 300 progress reports per second.
    expect(batches.length).toBeLessThanOrEqual(14)
    // A batch carries each changed task once.
    for (const { batch } of batches) expect(new Set(batch.tasks.map((t) => t.id)).size).toBe(batch.tasks.length)
    const last = batches.at(-1)?.batch.tasks ?? []
    expect(last.every((t) => t.state === 'succeeded' && t.fraction === 1)).toBe(true)
    expect(registry.list().map((t) => t.params.n)).toEqual([3, 2, 1])
  })

  it('sends nothing while idle', async () => {
    const emit = vi.fn<(batch: Batch) => void>()
    const registry = new TaskRegistry(emit)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(emit).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })

  it('cancels, dismisses and bounds the history', async () => {
    const batches: Batch[] = []
    const registry = new TaskRegistry((b) => batches.push(b), { maxHistory: 2 })
    const long = registry.run({ name: 'test.long', instanceId: 'i1' }, (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))))
    expect(() => registry.dismiss(long.id)).toThrow(/Cancel/)
    registry.cancel(long.id)
    await expect(long.promise).rejects.toMatchObject({ code: 'ECANCELLED' })
    for (let i = 0; i < 3; i++) await registry.run({ name: 'test.quick' }, async () => i).promise
    await vi.advanceTimersByTimeAsync(200)
    // Four finished tasks, history of two: the oldest two were evicted and announced.
    expect(registry.list()).toHaveLength(2)
    expect(batches.flatMap((b) => b.removed)).toContain(long.id)
    const [newest] = registry.list()
    registry.dismiss(newest?.id ?? '')
    await vi.advanceTimersByTimeAsync(200)
    expect(registry.list()).toHaveLength(1)
    expect(batches.at(-1)?.removed).toEqual([newest?.id])
  })

  it('prunes deep and wide trees', async () => {
    const registry = new TaskRegistry(() => {})
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const handle = registry.run({ name: 'test.tree' }, async (ctx) => {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          ctx.child(`c${i}`, (c) => c.child('grandchild', async () => {
            await gate
          })),
        ),
      )
    })
    await vi.advanceTimersByTimeAsync(0)
    const [view] = registry.list()
    expect(view?.children).toHaveLength(20)
    expect(view?.children[0]?.children).toEqual([])
    release()
    await handle.promise
  })
})
