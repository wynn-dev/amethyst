/**
 * A small supervised pool of scan workers speaking the `@amethyst/content` scan-worker protocol
 * (`{ id, method, args }` / `{ id, cancel: true }` → `{ id, ok, value | error }`).
 *
 * - Workers start lazily, up to `size`, and jobs go to the least busy one.
 * - A crashed worker rejects its in-flight jobs with `EWORKER_CRASHED` (nothing hangs) and is
 *   replaced on the next job.
 * - Cancellation crosses the thread boundary as a message; the caller's promise rejects at once.
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
}

export interface PoolOptions {
  size: number
  /** Stop all workers after this long without jobs (default 5 minutes; 0 disables). */
  idleMs?: number
}

export class WorkerPool<H extends { [K in keyof H]: AnyHandler }> {
  readonly #spawn: () => WorkerLike
  readonly #size: number
  readonly #idleMs: number
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
  }

  call<K extends keyof H>(method: K, args: Args<H[K]>, signal?: AbortSignal): Promise<Result<H[K]>> {
    if (this.#disposed) return Promise.reject(new AppError('EWORKER_CLOSED', 'The worker pool is closed'))
    if (signal?.aborted) return Promise.reject(new AppError('ECANCELLED', 'Cancelled'))
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    const slot = this.#pick()
    const id = this.#nextId++
    return new Promise<Result<H[K]>>((resolve, reject) => {
      const onAbort = () => {
        if (!slot.pending.has(id)) return
        slot.pending.delete(id)
        slot.busy--
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
          signal?.removeEventListener('abort', onAbort)
          resolve(v as Result<H[K]>)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      slot.busy++
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        slot.worker.postMessage({ id, method, args })
      } catch (e) {
        slot.pending.delete(id)
        slot.busy--
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
    const slot: Slot = { worker, busy: 0, pending: new Map() }
    worker.on('message', (raw) => {
      const msg = raw as ScanWorkerResponse
      const p = typeof msg === 'object' && msg !== null ? slot.pending.get(msg.id) : undefined
      if (!p) return
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
