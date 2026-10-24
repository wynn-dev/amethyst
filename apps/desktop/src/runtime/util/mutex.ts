/** A FIFO async mutex. Waiting callers can be rejected with {@link Mutex.rejectWaiting}. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve()
  readonly #waiting = new Set<(e: Error) => void>()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    this.#tail = previous.then(() => done)
    let reject!: (e: Error) => void
    const rejected = new Promise<never>((_, r) => (reject = r))
    this.#waiting.add(reject)
    try {
      await Promise.race([previous, rejected])
    } catch (e) {
      release()
      throw e
    } finally {
      this.#waiting.delete(reject)
    }
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** Reject every caller still waiting for the lock (the current holder keeps running). */
  rejectWaiting(error: Error): void {
    for (const reject of this.#waiting) reject(error)
    this.#waiting.clear()
  }
}

/** One {@link Mutex} per key, created on demand. */
export class KeyedMutex {
  readonly #locks = new Map<string, Mutex>()

  get(key: string): Mutex {
    let m = this.#locks.get(key)
    if (!m) this.#locks.set(key, (m = new Mutex()))
    return m
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.get(key).run(fn)
  }
}
