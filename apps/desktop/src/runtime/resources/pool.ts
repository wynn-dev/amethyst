/**
 * A small supervised pool of scan workers speaking the `@amethyst/content` scan-worker protocol
 * (`{ id, method, args }` / `{ id, cancel: true }` → `{ id, ok, value | error }`).
 *
 * - Workers start lazily, up to `size`, and jobs go to the least busy one.
 * - A crashed worker rejects its in-flight jobs with `EWORKER_CRASHED` (nothing hangs) and is
 *   replaced on the next job.
 * - Cancellation crosses the thread boundary as a message; the caller's promise rejects at once.
 * - Every job has a deadline (`timeoutMs`, per method in `timeouts`). A job that misses it rejects
 *   with `EWORKER_TIMEOUT` and its worker is terminated (it may be wedged in a parse loop or a
 *   native call that never yields) and replaced on the next job.
 * - Idle workers are stopped after `idleMs` (no CPU or memory cost while nothing is scanned).
 */
import type { ScanWorkerResponse } from '@amethyst/content'
import type { WorkerLike } from '../db/client'
import { AppError } from '../util/errors'

type AnyHandler = (args: never, signal?: AbortSignal) => Promise<unknown>
type Args<F> = F extends (args: infer A, signal?: AbortSignal) => Promise<unknown> ? A : never
type Result<F> = F extends (args: never, signal?: AbortSignal) => Promise<infer R> ? R : never

interface Slot {
  worker: WorkerLike
  busy: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>
  /** Cancelled jobs the worker has not acknowledged yet (it answers every job, even cancelled ones). */
  cancelled: Set<number>
}

export interface PoolOptions {
  size: number
  /** Stop all workers after this long without jobs (default 5 minutes; 0 disables). */
  idleMs?: number
  /** Deadline of one job (default 10 minutes; 0 disables). */
  timeoutMs?: number
  /** Per-method deadlines overriding `timeoutMs` (0 disables, e.g. for user tasks with a Cancel button). */
  timeouts?: Partial<Record<string, number>>
  /** How long a worker may take to acknowledge a cancelled job before it is replaced (default 30 s). */
  cancelGraceMs?: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_CANCEL_GRACE_MS = 30_000

export class WorkerPool<H extends { [K in keyof H]: AnyHandler }> {
  readonly #spawn: () => WorkerLike
  readonly #size: number
  readonly #idleMs: number
  readonly #timeoutMs: number
  readonly #timeouts: Partial<Record<string, number>>
  readonly #cancelGraceMs: number
  readonly #slots: Slot[] = []
  #nextId = 1
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  /** Number of workers started so far (diagnostics and tests). */
  spawned = 0

  constructor(spawn: () => WorkerLike, options: PoolOptions) {
    this.#spawn = spawn
    this.#size = Math.max(1, options.size)
    this.#idleMs = options.idleMs ?? 5 * 60_000
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#timeouts = options.timeouts ?? {}
    this.#cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
  }

  call<K extends keyof H>(method: K, args: Args<H[K]>, signal?: AbortSignal): Promise<Result<H[K]>> {
    if (this.#disposed) return Promise.reject(new AppError('EWORKER_CLOSED', 'The worker pool is closed'))
    if (signal?.aborted) return Promise.reject(new AppError('ECANCELLED', 'Cancelled'))
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    const slot = this.#pick()
    const id = this.#nextId++
    const timeoutMs = this.#timeouts[String(method)] ?? this.#timeoutMs
    return new Promise<Result<H[K]>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        signal?.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
      }
      const onAbort = () => {
        if (!slot.pending.has(id)) return
        if (timer) clearTimeout(timer)
        slot.pending.delete(id)
        slot.busy--
        // A worker that never acknowledges the cancel is wedged: replace it so later jobs do not queue behind it.
        slot.cancelled.add(id)
        const grace = setTimeout(() => {
          if (slot.cancelled.has(id)) this.#retire(slot, new AppError('EWORKER_CRASHED', 'A scan worker stopped responding and was restarted'))
        }, this.#cancelGraceMs)
        grace.unref?.()
        try {
          slot.worker.postMessage({ id, cancel: true })
        } catch {
          // worker gone
        }
        reject(new AppError('ECANCELLED', 'Cancelled'))
        this.#maybeIdle()
      }
      slot.pending.set(id, {
        resolve: (v) => {
          settle()
          resolve(v as Result<H[K]>)
        },
        reject: (e) => {
          settle()
          reject(e)
        },
      })
      slot.busy++
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const p = slot.pending.get(id)
          if (!p) return
          slot.pending.delete(id)
          slot.busy--
          p.reject(new AppError('EWORKER_TIMEOUT', `The scan worker did not finish ${String(method)} within ${Math.round(timeoutMs / 1000)} s`))
          // The worker may never yield again: replace it rather than queueing more work behind it.
          this.#retire(slot, new AppError('EWORKER_CRASHED', 'A scan worker was restarted after another job timed out'))
          this.#maybeIdle()
        }, timeoutMs)
        timer.unref?.()
      }
      try {
        slot.worker.postMessage({ id, method, args })
      } catch (e) {
        slot.pending.delete(id)
        slot.busy--
        settle()
        reject(e)
      }
    })
  }

  /** Terminate every worker; in-flight jobs reject. */
  dispose(): void {
    this.#disposed = true
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    for (const slot of this.#slots.splice(0)) this.#kill(slot, new AppError('EWORKER_CLOSED', 'The worker pool is closed'))
  }

  get size(): number {
    return this.#slots.length
  }

  #pick(): Slot {
    const idle = this.#slots.find((s) => s.busy === 0)
    if (idle) return idle
    if (this.#slots.length < this.#size) return this.#start()
    return this.#slots.reduce((a, b) => (b.busy < a.busy ? b : a))
  }

  #start(): Slot {
    const worker = this.#spawn()
    this.spawned++
    const slot: Slot = { worker, busy: 0, pending: new Map(), cancelled: new Set() }
    worker.on('message', (raw) => {
      const msg = raw as ScanWorkerResponse
      if (typeof msg !== 'object' || msg === null) return
      const p = slot.pending.get(msg.id)
      if (!p) {
        slot.cancelled.delete(msg.id)
        return
      }
      slot.pending.delete(msg.id)
      slot.busy--
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new AppError(msg.error.code ?? (msg.error.name === 'AbortError' ? 'ECANCELLED' : 'EWORKER_JOB'), msg.error.message, msg.error.problem ? { problem: msg.error.problem } : undefined))
      this.#maybeIdle()
    })
    const crashed = (error: Error) => {
      const i = this.#slots.indexOf(slot)
      if (i < 0) return
      this.#slots.splice(i, 1)
      const failure = new AppError('EWORKER_CRASHED', `A scan worker stopped: ${error.message}`)
      for (const p of slot.pending.values()) p.reject(failure)
      slot.pending.clear()
    }
    worker.on('error', crashed)
    worker.on('exit', (code) => crashed(new Error(`exit code ${code}`)))
    this.#slots.push(slot)
    return slot
  }

  /** Take a slot out of the pool and terminate its worker; its other jobs reject with `error`. */
  #retire(slot: Slot, error: Error): void {
    const i = this.#slots.indexOf(slot)
    if (i < 0) return
    this.#slots.splice(i, 1)
    this.#kill(slot, error)
  }

  #kill(slot: Slot, error: Error): void {
    for (const p of slot.pending.values()) p.reject(error)
    slot.pending.clear()
    try {
      void slot.worker.terminate()
    } catch {
      // already gone
    }
  }

  #maybeIdle(): void {
    if (this.#idleMs <= 0 || this.#disposed || this.#slots.some((s) => s.busy > 0)) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#slots.some((s) => s.busy > 0)) return
      for (const slot of this.#slots.splice(0)) this.#kill(slot, new AppError('EWORKER_CLOSED', 'Idle worker stopped'))
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }
}
