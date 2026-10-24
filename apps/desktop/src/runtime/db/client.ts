/**
 * Runtime-side handle on the SQLite worker. Every call is an async message, so the runtime's
 * event loop never waits on SQLite. If the worker crashes, in-flight queries reject with
 * `EDB_RESTARTED` (they are never left hanging) and a fresh worker is started with backoff;
 * after five crashes within a minute the index is reported unavailable (`EDB_UNAVAILABLE`)
 * until the next restart of the runtime. Callers treat the index as a cache and degrade.
 */
import { AppError } from '../util/errors'
import type { DbResponse, QueryArgs, QueryName, QueryResult } from './protocol'

/** The subset of `worker_threads.Worker` the client uses (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): unknown
}

export interface DbReady {
  schemaVersion: number
  /** Corrupt database files that were moved aside while opening. */
  healed: string[]
  openMs: number
}

export interface DbClientOptions {
  /** Called when the worker dies unexpectedly. */
  onCrash?: (error: Error) => void
  /** Base delay before an automatic restart (default 250 ms, doubling per recent crash). */
  restartDelayMs?: number
}

const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES = 5

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class DbClient {
  readonly #spawn: () => WorkerLike
  readonly #options: DbClientOptions
  #worker: WorkerLike | undefined
  #ready: Promise<DbReady> | undefined
  #rejectReady: ((e: unknown) => void) | undefined
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #crashes: number[] = []
  #closed = false
  #restartTimer: ReturnType<typeof setTimeout> | undefined

  constructor(spawn: () => WorkerLike, options: DbClientOptions = {}) {
    this.#spawn = spawn
    this.#options = options
  }

  /** Start the worker (if needed) and wait until the database is open and migrated. */
  open(): Promise<DbReady> {
    return this.#ensure()
  }

  /** Run a named query. */
  async query<K extends QueryName>(q: K, args: QueryArgs<K>): Promise<QueryResult<K>> {
    await this.#ensure()
    const worker = this.#worker
    if (!worker) throw new AppError('EDB_RESTARTED', 'The index worker restarted')
    return new Promise<QueryResult<K>>((resolve, reject) => {
      const id = this.#nextId++
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        worker.postMessage({ t: 'query', id, q, args })
      } catch (e) {
        this.#pending.delete(id)
        reject(e)
      }
    })
  }

  /** Close the database and stop the worker. Later queries reject with `EDB_CLOSED`. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    const worker = this.#worker
    if (!worker) return
    const ready = await this.#ready?.then(
      () => true,
      () => false,
    )
    if (ready) {
      await new Promise<void>((resolve) => {
        const id = this.#nextId++
        const timer = setTimeout(resolve, 2000)
        this.#pending.set(id, {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: () => {
            clearTimeout(timer)
            resolve()
          },
        })
        worker.postMessage({ t: 'close', id })
      })
    }
    this.#worker = undefined
    this.#ready = undefined
    await worker.terminate()
  }

  #ensure(): Promise<DbReady> {
    if (this.#ready) return this.#ready
    if (this.#closed) return Promise.reject(new AppError('EDB_CLOSED', 'The index is closed'))
    const now = Date.now()
    this.#crashes = this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    if (this.#crashes.length >= MAX_CRASHES) {
      return Promise.reject(new AppError('EDB_UNAVAILABLE', 'The resource index keeps crashing and has been disabled for this session'))
    }
    let worker: WorkerLike
    try {
      worker = this.#spawn()
    } catch (e) {
      return Promise.reject(new AppError('EDB_UNAVAILABLE', `Cannot start the index worker: ${String(e)}`, undefined, { cause: e }))
    }
    this.#worker = worker
    const ready = new Promise<DbReady>((resolve, reject) => {
      this.#rejectReady = reject
      worker.on('message', (raw) => {
        const msg = raw as DbResponse
        if (msg?.t === 'ready') {
          this.#rejectReady = undefined
          resolve({ schemaVersion: msg.schemaVersion, healed: msg.healed, openMs: msg.openMs })
        } else if (msg?.t === 'fatal') {
          this.#rejectReady = undefined
          reject(new AppError('EDB_OPEN_FAILED', `Cannot open the resource index: ${msg.error.message}`, { cause: msg.error.code }))
          this.#discard(worker)
        } else if (msg?.t === 'result') {
          const p = this.#pending.get(msg.id)
          if (!p) return
          this.#pending.delete(msg.id)
          if (msg.ok) p.resolve(msg.value)
          else p.reject(Object.assign(new AppError(msg.error.code ?? 'EDB_QUERY', msg.error.message), { name: msg.error.name === 'SqliteError' ? 'SqliteError' : 'AppError' }))
        }
      })
      worker.on('error', (e) => this.#crashed(worker, e))
      worker.on('exit', (code) => this.#crashed(worker, new Error(`The index worker exited with code ${code}`)))
    })
    this.#ready = ready
    // A failed open must not stick: the next call tries again.
    ready.catch(() => {
      if (this.#ready === ready) this.#ready = undefined
    })
    return ready
  }

  #discard(worker: WorkerLike): void {
    if (this.#worker === worker) {
      this.#worker = undefined
      this.#ready = undefined
    }
    try {
      void worker.terminate()
    } catch {
      // already gone
    }
  }

  #crashed(worker: WorkerLike, error: Error): void {
    if (this.#worker !== worker) return
    this.#worker = undefined
    this.#ready = undefined
    this.#rejectReady?.(new AppError('EDB_RESTARTED', error.message))
    this.#rejectReady = undefined
    const failure = new AppError('EDB_RESTARTED', `The index worker stopped: ${error.message}`)
    for (const p of this.#pending.values()) p.reject(failure)
    this.#pending.clear()
    if (this.#closed) return
    this.#crashes.push(Date.now())
    this.#options.onCrash?.(error)
    const delay = (this.#options.restartDelayMs ?? 250) * 2 ** Math.max(0, this.#crashes.length - 1)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.#ensure().catch(() => {})
    }, delay)
    this.#restartTimer.unref?.()
  }
}
