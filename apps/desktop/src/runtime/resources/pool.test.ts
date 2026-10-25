import { serveScanWorker, type ScanWorkerHandlers } from '@amethyst/content'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeWorker, type FakeWorker } from '../db/test-utils'
import { WorkerPool, type PoolOptions } from './pool'

/** Jobs of the test pool: `echo` answers at once, `hang` never settles (and ignores cancellation). */
interface TestHandlers {
  echo(args: { value: number }): Promise<number>
  hang(args: Record<string, never>): Promise<never>
  slow(args: { ms: number }): Promise<string>
}

const handlers = {
  echo: async ({ value }: { value: number }) => value,
  hang: () => new Promise<never>(() => {}),
  slow: ({ ms }: { ms: number }) => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms)),
}

let pool: WorkerPool<TestHandlers> | undefined
const workers: FakeWorker[] = []
const terminated: FakeWorker[] = []

function makePool(options: Partial<PoolOptions> = {}): WorkerPool<TestHandlers> {
  pool = new WorkerPool<TestHandlers>(
    () => {
      const w = fakeWorker((port) => serveScanWorker(port, handlers as unknown as ScanWorkerHandlers))
      const terminate = w.terminate.bind(w)
      w.terminate = () => {
        terminated.push(w)
        return terminate()
      }
      workers.push(w)
      return w
    },
    { size: 1, idleMs: 0, ...options },
  )
  return pool
}

afterEach(() => {
  pool?.dispose()
  pool = undefined
  workers.length = 0
  terminated.length = 0
})

describe('WorkerPool supervision', () => {
  it('rejects in-flight jobs with EWORKER_CRASHED when the worker dies mid-job, then restarts it', async () => {
    const p = makePool()
    const job = p.call('hang', {})
    const other = p.call('hang', {})
    expect(workers).toHaveLength(1)
    workers[0]?.crash(134)
    await expect(job).rejects.toMatchObject({ code: 'EWORKER_CRASHED' })
    await expect(other).rejects.toMatchObject({ code: 'EWORKER_CRASHED' })
    // The next job gets a fresh worker and succeeds.
    await expect(p.call('echo', { value: 7 })).resolves.toBe(7)
    expect(p.spawned).toBe(2)
  })

  it('times out a wedged job with EWORKER_TIMEOUT and replaces its worker', async () => {
    const p = makePool({ timeoutMs: 30 })
    await expect(p.call('hang', {})).rejects.toMatchObject({ code: 'EWORKER_TIMEOUT' })
    expect(terminated).toEqual([workers[0]])
    expect(p.size).toBe(0)
    await expect(p.call('echo', { value: 1 })).resolves.toBe(1)
    expect(p.spawned).toBe(2)
  })

  it('honours per-method deadlines (0 disables the timeout)', async () => {
    const p = makePool({ timeoutMs: 20, timeouts: { slow: 0 } })
    await expect(p.call('slow', { ms: 60 })).resolves.toBe('done')
    expect(terminated).toEqual([])
  })

  it('replaces a worker that never acknowledges a cancelled job', async () => {
    const p = makePool({ timeoutMs: 0, cancelGraceMs: 30 })
    const controller = new AbortController()
    const job = p.call('hang', {}, controller.signal)
    controller.abort()
    await expect(job).rejects.toMatchObject({ code: 'ECANCELLED' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(terminated).toEqual([workers[0]])
    await expect(p.call('echo', { value: 2 })).resolves.toBe(2)
    expect(p.spawned).toBe(2)
  })

  it('keeps a worker that acknowledges cancellation', async () => {
    const p = makePool({ timeoutMs: 0, cancelGraceMs: 30 })
    const controller = new AbortController()
    const job = p.call('slow', { ms: 5 }, controller.signal)
    controller.abort()
    await expect(job).rejects.toMatchObject({ code: 'ECANCELLED' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(terminated).toEqual([])
    await expect(p.call('echo', { value: 3 })).resolves.toBe(3)
    expect(p.spawned).toBe(1)
  })
})
