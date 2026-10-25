/**
 * Registry of running task trees (`@amethyst/task`) and a bounded history of finished ones.
 *
 * Progress is pushed, never polled: every tree reports through `onUpdate`, the registry marks it
 * dirty, and one timer flushes all dirty trees as a single `tasks:update` batch at most every
 * `intervalMs` (100 ms, so at most 10 batches per second however many tasks run). No timer runs
 * while nothing changes. Snapshots are pruned to two levels and 20 children per node.
 */
import { createTask, type TaskContext, type TaskHandle, type TaskSnapshot } from '@amethyst/task'
import type { Events } from '@shared/events'
import type { TasksService, TaskView } from '@shared/services'
import { AppError } from '../util/errors'

export interface TaskMeta {
  /** Stable machine name, e.g. `instances.duplicate`. */
  name: string
  params?: Record<string, string | number>
  instanceId?: string
  /** Default true. */
  cancellable?: boolean
}

export interface TaskRegistryOptions {
  /** Finished tasks kept in the history (default 50). */
  maxHistory?: number
  /** Minimum time between two `tasks:update` batches (default 100 ms). */
  intervalMs?: number
  now?: () => number
}

interface Entry {
  meta: TaskMeta
  handle: TaskHandle<unknown>
  snapshot: TaskSnapshot
  finished: boolean
}

const MAX_CHILDREN = 20
const MAX_DEPTH = 2
const FINISHED = new Set(['succeeded', 'failed', 'cancelled'])

function pruneChildren(children: TaskSnapshot[]): TaskSnapshot[] {
  if (children.length <= MAX_CHILDREN) return children
  const running = children.filter((c) => c.state === 'running')
  const rest = children.filter((c) => c.state !== 'running')
  return [...running, ...rest.slice(-Math.max(0, MAX_CHILDREN - running.length))].slice(0, MAX_CHILDREN)
}

function toView(s: TaskSnapshot, meta: TaskMeta | undefined, depth = 0): TaskView {
  return {
    id: s.id,
    name: s.name,
    params: { ...s.params },
    instanceId: meta?.instanceId ?? null,
    state: s.state,
    fraction: Number.isFinite(s.fraction) ? s.fraction : 0,
    progress: s.progress,
    total: s.total,
    message: s.message ?? null,
    error: s.error ? { code: s.error.code ?? s.error.name, message: s.error.message } : null,
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    cancellable: depth === 0 ? (meta?.cancellable ?? true) && !FINISHED.has(s.state) : false,
    children: depth + 1 >= MAX_DEPTH ? [] : pruneChildren(s.children).map((c) => toView(c, undefined, depth + 1)),
  }
}

export class TaskRegistry {
  readonly #emit: (payload: Events['tasks:update']) => void
  readonly #maxHistory: number
  readonly #intervalMs: number
  readonly #now: () => number
  /** Insertion order = start order. */
  readonly #entries = new Map<string, Entry>()
  readonly #dirty = new Set<string>()
  readonly #removed = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #lastFlush = -Infinity

  constructor(emit: (payload: Events['tasks:update']) => void, options: TaskRegistryOptions = {}) {
    this.#emit = emit
    this.#maxHistory = Math.max(0, options.maxHistory ?? 50)
    this.#intervalMs = Math.max(0, options.intervalMs ?? 100)
    this.#now = options.now ?? Date.now
  }

  /** Start a task tree. Its result is `handle.promise`; progress is published automatically. */
  run<T>(meta: TaskMeta, fn: (ctx: TaskContext) => Promise<T>, options: { signal?: AbortSignal } = {}): TaskHandle<T> {
    let id = ''
    const handle = createTask(meta.name, fn, {
      params: meta.params,
      signal: options.signal,
      throttleMs: this.#intervalMs,
      onUpdate: (snapshot) => {
        const entry = this.#entries.get(id)
        if (!entry) return
        entry.snapshot = snapshot
        if (!entry.finished && FINISHED.has(snapshot.state)) {
          entry.finished = true
          this.#trimHistory()
        }
        this.#markDirty(id)
      },
    })
    id = handle.id
    this.#entries.set(id, { meta, handle: handle as TaskHandle<unknown>, snapshot: handle.snapshot(), finished: false })
    this.#markDirty(id)
    return handle
  }

  /** Convenience: run a task and await its result. */
  async runAndWait<T>(meta: TaskMeta, fn: (ctx: TaskContext) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    return this.run(meta, fn, options).promise
  }

  list(): TaskView[] {
    return [...this.#entries.values()].toReversed().map((e) => toView(e.snapshot, e.meta))
  }

  cancel(id: string): void {
    const entry = this.#entries.get(id)
    if (!entry) throw new AppError('ENOT_FOUND', `Task ${id} not found`)
    if (entry.meta.cancellable === false) throw new AppError('EINVALID_ARGUMENT', 'This task cannot be cancelled')
    entry.handle.cancel('Cancelled by the user')
  }

  /** Cancel every running task working on an instance (e.g. before deleting it). */
  cancelForInstance(instanceId: string): Promise<unknown>[] {
    const out: Promise<unknown>[] = []
    for (const e of this.#entries.values()) {
      if (e.meta.instanceId === instanceId && !e.finished) {
        e.handle.cancel('The instance is being removed')
        out.push(e.handle.promise.catch(() => {}))
      }
    }
    return out
  }

  /**
   * Cancel every running task (quit): their abort signals stop the helper processes they spawned
   * (Forge processors, pre-launch commands, `cp`, Java probes), which would otherwise outlive the
   * runtime. Games are not tasks and keep running. Resolves when all have settled.
   */
  cancelAll(reason = 'Amethyst is quitting'): Promise<void> {
    const out: Promise<unknown>[] = []
    for (const e of this.#entries.values()) {
      if (e.finished) continue
      e.handle.cancel(reason)
      out.push(e.handle.promise.catch(() => {}))
    }
    return Promise.all(out).then(() => {})
  }

  dismiss(id: string): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    if (!entry.finished) throw new AppError('EBUSY', 'Cancel the task before dismissing it')
    this.#remove(id)
  }

  clearFinished(): void {
    for (const [id, e] of this.#entries) if (e.finished) this.#remove(id)
  }

  /** Stop the flush timer (shutdown). */
  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #remove(id: string): void {
    this.#entries.delete(id)
    this.#dirty.delete(id)
    this.#removed.add(id)
    this.#schedule()
  }

  #trimHistory(): void {
    const finished = [...this.#entries.entries()].filter(([, e]) => e.finished)
    for (const [id] of finished.slice(0, Math.max(0, finished.length - this.#maxHistory))) this.#remove(id)
  }

  #markDirty(id: string): void {
    this.#dirty.add(id)
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) return
    const wait = Math.max(0, this.#intervalMs - (this.#now() - this.#lastFlush))
    this.#timer = setTimeout(() => this.#flush(), wait)
  }

  #flush(): void {
    this.#timer = undefined
    this.#lastFlush = this.#now()
    const tasks: TaskView[] = []
    for (const id of this.#dirty) {
      const e = this.#entries.get(id)
      if (e) tasks.push(toView(e.snapshot, e.meta))
    }
    const removed = [...this.#removed]
    this.#dirty.clear()
    this.#removed.clear()
    if (tasks.length > 0 || removed.length > 0) this.#emit({ tasks, removed })
  }
}

/** The RPC facade. */
export function tasksService(registry: TaskRegistry): TasksService {
  return {
    list: async () => registry.list(),
    cancel: async (id) => registry.cancel(id),
    dismiss: async (id) => registry.dismiss(id),
    clearFinished: async () => registry.clearFinished(),
  }
}
