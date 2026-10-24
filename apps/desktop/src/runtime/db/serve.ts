import { createQueryHandlers, openDatabase } from './engine'
import type { DbRequest, DbResponse, DbWorkerData, QueryName } from './protocol'

/** The messaging subset of `parentPort` / `MessagePort`. */
export interface PortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  close?(): void
}

function toError(e: unknown): { name: string; message: string; code?: string } {
  if (!(e instanceof Error)) return { name: 'Error', message: String(e) }
  const code = (e as { code?: unknown }).code
  return { name: e.name, message: e.message, ...(typeof code === 'string' ? { code } : {}) }
}

/** Open the database and answer {@link DbRequest}s on `port` (inside the worker thread). */
export function serveDatabase(port: PortLike, data: DbWorkerData): void {
  const started = performance.now()
  let opened
  try {
    opened = openDatabase(data.file)
  } catch (e) {
    port.postMessage({ t: 'fatal', error: toError(e) } satisfies DbResponse)
    return
  }
  const { db, healed } = opened
  const handlers = createQueryHandlers(db)
  port.postMessage({
    t: 'ready',
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    healed,
    openMs: performance.now() - started,
  } satisfies DbResponse)

  port.on('message', (raw) => {
    const msg = raw as DbRequest
    if (msg?.t === 'close') {
      try {
        db.close()
      } finally {
        port.postMessage({ t: 'result', id: msg.id, ok: true, value: null } satisfies DbResponse)
        port.close?.()
      }
      return
    }
    if (msg?.t !== 'query') return
    const handler = Object.hasOwn(handlers, msg.q) ? (handlers[msg.q as QueryName] as (args: unknown) => unknown) : undefined
    if (!handler) {
      port.postMessage({ t: 'result', id: msg.id, ok: false, error: { name: 'TypeError', message: `Unknown query ${String(msg.q)}`, code: 'EDB_UNKNOWN_QUERY' } } satisfies DbResponse)
      return
    }
    try {
      port.postMessage({ t: 'result', id: msg.id, ok: true, value: handler(msg.args) } satisfies DbResponse)
    } catch (e) {
      port.postMessage({ t: 'result', id: msg.id, ok: false, error: toError(e) } satisfies DbResponse)
    }
  })
}
