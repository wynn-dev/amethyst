import { createQueryHandlers, isCorruption, openDatabase, quarantineDatabase } from './engine'
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

/** Rebuilds per worker lifetime after corruption shows up mid-session (bounds a failing disk). */
const MAX_RUNTIME_HEALS = 3

/**
 * Open the database and answer {@link DbRequest}s on `port` (inside the worker thread). The index
 * is a rebuildable cache: if a query hits corruption (or a missing table) mid-session, that query
 * fails, the damaged file is moved aside and a fresh, migrated database takes its place, so later
 * queries work instead of failing for the rest of the session.
 */
export function serveDatabase(port: PortLike, data: DbWorkerData, options: { now?: () => number } = {}): void {
  const started = performance.now()
  let opened
  try {
    opened = openDatabase(data.file)
  } catch (e) {
    port.postMessage({ t: 'fatal', error: toError(e) } satisfies DbResponse)
    return
  }
  let { db } = opened
  const { healed } = opened
  let handlers = createQueryHandlers(db)
  let heals = 0
  let unavailable: { name: string; message: string; code?: string } | undefined
  const heal = () => {
    heals++
    try {
      db.close()
    } catch {
      // already unusable
    }
    try {
      if (data.file !== ':memory:') quarantineDatabase(data.file, `${(options.now ?? Date.now)()}-runtime${heals}`)
      db = openDatabase(data.file, options).db
      handlers = createQueryHandlers(db)
    } catch (e) {
      unavailable = { ...toError(e), code: 'EDB_UNAVAILABLE' }
    }
  }
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
    if (unavailable) {
      port.postMessage({ t: 'result', id: msg.id, ok: false, error: unavailable } satisfies DbResponse)
      return
    }
    const handler = Object.hasOwn(handlers, msg.q) ? (handlers[msg.q as QueryName] as (args: unknown) => unknown) : undefined
    if (!handler) {
      port.postMessage({ t: 'result', id: msg.id, ok: false, error: { name: 'TypeError', message: `Unknown query ${String(msg.q)}`, code: 'EDB_UNKNOWN_QUERY' } } satisfies DbResponse)
      return
    }
    try {
      port.postMessage({ t: 'result', id: msg.id, ok: true, value: handler(msg.args) } satisfies DbResponse)
    } catch (e) {
      port.postMessage({ t: 'result', id: msg.id, ok: false, error: toError(e) } satisfies DbResponse)
      if (isCorruption(e) && heals < MAX_RUNTIME_HEALS) heal()
    }
  })
}
