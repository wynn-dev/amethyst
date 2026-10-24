/**
 * Message handlers for running scans and parsers inside a `worker_threads` worker.
 *
 * Inside the worker:
 * ```ts
 * import { parentPort } from 'node:worker_threads'
 * import { serveScanWorker } from '@amethyst/content'
 * serveScanWorker(parentPort!)
 * ```
 * In the main process, wrap the `Worker` with {@link createScanWorkerClient}. Every argument
 * and result is plain structured-cloneable data; cancellation crosses the thread boundary as
 * a message.
 */
import { classifyError } from './errors'
import { hashFile, type HashAlgorithm } from './hash'
import { readModMetadata } from './mods/read'
import type { InstanceLoader } from './mods/types'
import { readResourcePack } from './packs/resourcepack'
import { readShaderPack } from './packs/shaderpack'
import { readLevelDat } from './saves/level'
import { createMemoryScanCache, scanContentFolder, type ContentKind, type ScanCacheRecord, type ScanResult } from './scan'

/** Serializable subset of the scan options. */
export interface WorkerScanOptions {
  hashes?: HashAlgorithm[]
  concurrency?: number
  preferLoader?: InstanceLoader
  enabledPacks?: string[]
  activeShaderPack?: string | null
}

/**
 * Handlers exposed by a scan worker. Each one takes plain data and an optional signal and
 * returns plain data. The handlers share one in-memory scan cache, created per call of
 * {@link createScanWorkerHandlers} (never module-global), so repeated scans in the same worker
 * only re-read changed files.
 */
export interface ScanWorkerHandlers {
  scan(args: { dir: string; kind: ContentKind; options?: WorkerScanOptions }, signal?: AbortSignal): Promise<ScanResult>
  readMod(args: { path: string; preferLoader?: InstanceLoader }, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof readModMetadata>>>
  readResourcePack(args: { path: string }, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof readResourcePack>>>
  readShaderPack(args: { path: string }, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof readShaderPack>>>
  readLevelDat(args: { path: string }): Promise<Awaited<ReturnType<typeof readLevelDat>>>
  hashFile(args: { path: string; algorithms?: HashAlgorithm[] }, signal?: AbortSignal): Promise<Record<string, string | number>>
  /** Seed the cache, e.g. with records persisted by the main process. */
  importCache(args: { records: [string, ScanCacheRecord][] }): Promise<{ size: number }>
  /** Export the cache so the main process can persist it. */
  exportCache(): Promise<{ records: [string, ScanCacheRecord][] }>
  clearCache(): Promise<void>
}

/** Create a fresh set of {@link ScanWorkerHandlers} with its own cache. */
export function createScanWorkerHandlers(): ScanWorkerHandlers {
  const cache = createMemoryScanCache()
  return {
    scan: ({ dir, kind, options = {} }, signal) => scanContentFolder(dir, kind, { ...options, cache, signal }),
    readMod: ({ path, preferLoader }, signal) => readModMetadata(path, { preferLoader, signal }),
    readResourcePack: ({ path }, signal) => readResourcePack(path, { signal }),
    readShaderPack: ({ path }, signal) => readShaderPack(path, { signal }),
    readLevelDat: ({ path }) => readLevelDat(path),
    hashFile: ({ path, algorithms = ['sha1'] }, signal) => hashFile(path, algorithms, { signal }),
    importCache: async ({ records }) => {
      for (const [key, record] of records) cache.set(key, record)
      return { size: cache.size }
    },
    exportCache: async () => ({ records: cache.entries() }),
    clearCache: async () => cache.clear(),
  }
}

/** Request sent to a scan worker. */
export type ScanWorkerRequest = { id: number; method: keyof ScanWorkerHandlers; args?: unknown } | { id: number; cancel: true }

/** Response sent back by a scan worker. */
export type ScanWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; problem?: string } }

/** The subset of `MessagePort` / `parentPort` / `Worker` used for messaging. */
export interface MessagePortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  off?(event: 'message', listener: (message: unknown) => void): unknown
}

/**
 * Answer {@link ScanWorkerRequest}s arriving on `port` with `handlers` (default: a fresh
 * {@link createScanWorkerHandlers}). Returns a function that stops listening.
 */
export function serveScanWorker(port: MessagePortLike, handlers: ScanWorkerHandlers = createScanWorkerHandlers()): () => void {
  const inflight = new Map<number, AbortController>()
  const listener = (raw: unknown) => {
    const msg = raw as ScanWorkerRequest
    if (typeof msg !== 'object' || msg === null || typeof msg.id !== 'number') return
    if ('cancel' in msg) {
      inflight.get(msg.id)?.abort(new Error('Cancelled'))
      return
    }
    const handler = handlers[msg.method] as ((args: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    if (typeof handler !== 'function' || !Object.hasOwn(handlers, msg.method)) {
      port.postMessage({ id: msg.id, ok: false, error: { name: 'TypeError', message: `Unknown method ${String(msg.method)}` } } satisfies ScanWorkerResponse)
      return
    }
    const controller = new AbortController()
    inflight.set(msg.id, controller)
    handler(msg.args ?? {}, controller.signal).then(
      (value) => port.postMessage({ id: msg.id, ok: true, value } satisfies ScanWorkerResponse),
      (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e))
        const code = (err as { code?: unknown }).code
        port.postMessage({
          id: msg.id,
          ok: false,
          error: { name: err.name, message: err.message, ...(typeof code === 'string' ? { code } : {}), problem: classifyError(err).code },
        } satisfies ScanWorkerResponse)
      },
    ).finally(() => inflight.delete(msg.id))
  }
  port.on('message', listener)
  return () => port.off?.('message', listener)
}

/** Error re-created on the calling side from a worker failure. */
export class ScanWorkerError extends Error {
  constructor(
    override readonly name: string,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

type Args<K extends keyof ScanWorkerHandlers> = Parameters<ScanWorkerHandlers[K]>[0]
type Result<K extends keyof ScanWorkerHandlers> = Awaited<ReturnType<ScanWorkerHandlers[K]>>

/** Typed caller for a worker running {@link serveScanWorker}. */
export interface ScanWorkerClient {
  call<K extends keyof ScanWorkerHandlers>(method: K, args: Args<K>, signal?: AbortSignal): Promise<Result<K>>
  /** Stop listening for responses; pending calls reject. */
  dispose(): void
}

/** Wrap a `Worker` (or any {@link MessagePortLike}) that runs {@link serveScanWorker}. */
export function createScanWorkerClient(port: MessagePortLike): ScanWorkerClient {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const listener = (raw: unknown) => {
    const msg = raw as ScanWorkerResponse
    const p = typeof msg === 'object' && msg !== null ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new ScanWorkerError(msg.error.name, msg.error.message, msg.error.code))
  }
  port.on('message', listener)
  return {
    call(method, args, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new ScanWorkerError('AbortError', 'The operation was aborted'))
          return
        }
        const id = nextId++
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        signal?.addEventListener('abort', () => port.postMessage({ id, cancel: true } satisfies ScanWorkerRequest), { once: true })
        port.postMessage({ id, method, args } satisfies ScanWorkerRequest)
      })
    },
    dispose() {
      port.off?.('message', listener)
      for (const p of pending.values()) p.reject(new ScanWorkerError('Error', 'Scan worker client disposed'))
      pending.clear()
    },
  }
}
