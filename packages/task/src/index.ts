/**
 * Hierarchical tasks with weighted progress aggregation and cooperative cancellation.
 *
 * A task tree is created with {@link createTask}. Work functions receive a {@link TaskContext}
 * and report progress in their own units (bytes, files, steps). Parent progress is the
 * weighted average of its children's fractions plus its own directly reported progress.
 *
 * Listeners are notified through a throttled callback, so reporting progress on every
 * chunk is cheap: snapshots are produced at most once per `throttleMs`.
 */

export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskSnapshot {
  id: string
  name: string
  /** Optional structured parameters for the UI, e.g. `{ version: '1.21.1' }`. */
  params?: Record<string, string | number>
  state: TaskState
  /** Progress in the task's own units. */
  progress: number
  total: number
  /** Overall completion in [0, 1] including children. */
  fraction: number
  message?: string
  error?: { name: string; message: string; code?: string }
  startedAt?: number
  endedAt?: number
  children: TaskSnapshot[]
}

export interface TaskContext {
  readonly id: string
  readonly signal: AbortSignal
  /** Report absolute progress. `total` may be updated as it becomes known. */
  update(progress: number, total?: number, message?: string): void
  /** Add to the current progress. */
  advance(delta: number): void
  /**
   * Run `fn` as a child task. `weight` controls how much of the parent's bar the child
   * occupies relative to its siblings (default 1).
   */
  child<T>(name: string, fn: (ctx: TaskContext) => Promise<T>, options?: ChildOptions): Promise<T>
  throwIfAborted(): void
}

export interface ChildOptions {
  weight?: number
  params?: Record<string, string | number>
}

export interface CreateTaskOptions {
  params?: Record<string, string | number>
  /** Called with a fresh snapshot of the whole tree, throttled. */
  onUpdate?: (snapshot: TaskSnapshot) => void
  throttleMs?: number
  signal?: AbortSignal
}

export interface TaskHandle<T> {
  readonly id: string
  readonly promise: Promise<T>
  cancel(reason?: string): void
  snapshot(): TaskSnapshot
}

export class CancelledError extends Error {
  override name = 'CancelledError'
  readonly code = 'ECANCELLED'
}

let counter = 0
const nextId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`

class Node {
  readonly id = nextId()
  state: TaskState = 'pending'
  progress = 0
  total = 0
  message?: string
  error?: TaskSnapshot['error']
  startedAt?: number
  endedAt?: number
  readonly children: { node: Node; weight: number }[] = []

  constructor(
    readonly name: string,
    readonly params: Record<string, string | number> | undefined,
  ) {}

  fraction(): number {
    if (this.state === 'succeeded') return 1
    const own = this.total > 0 ? Math.min(1, this.progress / this.total) : 0
    if (this.children.length === 0) return own
    let weight = 0
    let sum = 0
    for (const c of this.children) {
      weight += c.weight
      sum += c.weight * c.node.fraction()
    }
    // Own progress counts as one extra unit of weight when the task reports any.
    if (this.total > 0) return (sum + own) / (weight + 1)
    return weight > 0 ? sum / weight : 0
  }

  snapshot(): TaskSnapshot {
    return {
      id: this.id,
      name: this.name,
      params: this.params,
      state: this.state,
      progress: this.progress,
      total: this.total,
      fraction: this.fraction(),
      message: this.message,
      error: this.error,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      children: this.children.map((c) => c.node.snapshot()),
    }
  }
}

function toError(e: unknown): TaskSnapshot['error'] {
  if (e instanceof Error) return { name: e.name, message: e.message, code: (e as { code?: string }).code }
  return { name: 'Error', message: String(e) }
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError')
}

export function createTask<T>(name: string, fn: (ctx: TaskContext) => Promise<T>, options: CreateTaskOptions = {}): TaskHandle<T> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const root = new Node(name, options.params)
  const throttleMs = options.throttleMs ?? 100

  let timer: ReturnType<typeof setTimeout> | undefined
  let lastEmit = 0
  const flush = () => {
    timer = undefined
    lastEmit = Date.now()
    options.onUpdate?.(root.snapshot())
  }
  const notify = (immediate = false) => {
    if (!options.onUpdate) return
    if (immediate) {
      if (timer) clearTimeout(timer)
      flush()
      return
    }
    if (timer) return
    const wait = Math.max(0, throttleMs - (Date.now() - lastEmit))
    timer = setTimeout(flush, wait)
  }

  async function run<R>(node: Node, work: (ctx: TaskContext) => Promise<R>): Promise<R> {
    const ctx: TaskContext = {
      id: node.id,
      signal,
      update(progress, total, message) {
        node.progress = progress
        if (total !== undefined) node.total = total
        if (message !== undefined) node.message = message
        notify()
      },
      advance(delta) {
        node.progress += delta
        notify()
      },
      child(childName, childFn, childOptions = {}) {
        const child = new Node(childName, childOptions.params)
        node.children.push({ node: child, weight: childOptions.weight ?? 1 })
        return run(child, childFn)
      },
      throwIfAborted() {
        if (signal.aborted) throw new CancelledError(String(signal.reason ?? 'Cancelled'))
      },
    }

    node.state = 'running'
    node.startedAt = Date.now()
    notify()
    try {
      ctx.throwIfAborted()
      const result = await work(ctx)
      node.state = 'succeeded'
      if (node.total > 0) node.progress = node.total
      return result
    } catch (e) {
      node.state = isAbort(e, signal) ? 'cancelled' : 'failed'
      if (node.state === 'failed') node.error = toError(e)
      throw node.state === 'cancelled' && !(e instanceof CancelledError) ? new CancelledError(String(signal.reason ?? 'Cancelled')) : e
    } finally {
      node.endedAt = Date.now()
      notify(node === root)
    }
  }

  const promise = run(root, fn)
  // Callers observe failures via `promise`; avoid unhandled rejections when they only watch snapshots.
  promise.catch(() => {})

  return {
    id: root.id,
    promise,
    cancel: (reason) => controller.abort(reason ?? 'Cancelled'),
    snapshot: () => root.snapshot(),
  }
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight. On the first failure the rest are
 * aborted (no new items start) and the promise rejects with that error once the items already
 * running have settled, so callers never clean up while work is still writing.
 */
export async function mapLimit<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number, signal: AbortSignal) => Promise<O>,
  signal?: AbortSignal,
): Promise<O[]> {
  const results: O[] = []
  const controller = new AbortController()
  const inner = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      if (inner.aborted) throw inner.reason instanceof Error ? inner.reason : new CancelledError(String(inner.reason ?? 'Cancelled'))
      const index = next++
      // oxlint-disable-next-line no-await-in-loop -- each worker runs one item at a time by design
      results[index] = await fn(items[index] as I, index, inner)
    }
  }
  let failed = false
  let failure: unknown
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    worker().catch((e: unknown) => {
      if (!failed) {
        failed = true
        failure = e
        controller.abort(e)
      }
    }),
  )
  await Promise.all(workers)
  if (failed) throw failure
  return results
}
