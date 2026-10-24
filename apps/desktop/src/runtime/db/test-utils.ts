/**
 * Test helpers: run "workers" in-process over a MessageChannel, so Vitest (which cannot load
 * TypeScript worker entries) exercises the real protocols, engines and clients.
 */
import { EventEmitter } from 'node:events'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { DbClient, type WorkerLike } from './client'
import { serveDatabase } from './serve'

export interface FakeWorker extends WorkerLike {
  /** Simulate the worker dying (e.g. a native crash). */
  crash(code?: number): void
}

/** A {@link WorkerLike} whose "thread" is `serve(port)` running in this thread. */
export function fakeWorker(serve: (port: MessagePort) => void): FakeWorker {
  const { port1, port2 } = new MessageChannel()
  const events = new EventEmitter()
  port1.on('message', (m) => events.emit('message', m))
  let alive = true
  const worker: FakeWorker = {
    postMessage: (m) => {
      if (alive) port1.postMessage(m)
    },
    on(event: string, listener: (arg: never) => void) {
      events.on(event, listener as (arg: unknown) => void)
      return worker
    },
    terminate: () => {
      alive = false
      port1.close()
      port2.close()
    },
    crash: (code = 1) => {
      alive = false
      port1.close()
      port2.close()
      events.emit('exit', code)
    },
  }
  serve(port2)
  return worker
}

export const inProcessWorker = (file: string): FakeWorker => fakeWorker((port) => serveDatabase(port, { file }))

/** A {@link DbClient} backed by in-process workers. `workers` collects every spawned one. */
export function testDbClient(file: string): { client: DbClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const client = new DbClient(
    () => {
      const w = inProcessWorker(file)
      workers.push(w)
      return w
    },
    { restartDelayMs: 5 },
  )
  return { client, workers }
}
