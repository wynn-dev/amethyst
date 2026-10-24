/**
 * Typed RPC between the three processes.
 *
 * - The **renderer** talks to the **runtime** (a `utilityProcess` that owns every domain service)
 *   over a dedicated `MessagePort`, so background work never touches the Electron main thread.
 * - The renderer talks to the **main** process only for window/OS services (`MAIN_SERVICES`).
 * - The runtime calls back into main for Electron-only APIs through the `host` service.
 *
 * A service is a plain object of async methods. Calls are routed by service name, so
 * `api.instances.list()` becomes `{ t: 'req', service: 'instances', method: 'list', args: [] }`.
 */

export const CONNECT_CHANNEL = 'amethyst:connect'
export const PORT_CHANNEL = 'amethyst:port'
export const MAIN_RPC_CHANNEL = 'amethyst:rpc'
export const MAIN_EVENT_CHANNEL = 'amethyst:event'

export interface RpcError {
  name: string
  message: string
  code?: string
  /** Optional structured, cloneable details (e.g. a help `link`, `reauth`, offending `keys`). */
  details?: Record<string, unknown>
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface RpcRequest {
  t: 'req'
  id: number
  service: string
  method: string
  args: unknown[]
}

export interface RpcResponse {
  t: 'res'
  id: number
  result: RpcResult<unknown>
}

export interface RpcEvent {
  t: 'evt'
  event: string
  payload: unknown
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent

export interface Bridge {
  invoke(service: string, method: string, args: unknown[]): Promise<RpcResult<unknown>>
  on(listener: (event: string, payload: unknown) => void): () => void
  platform: string
  /** The absolute path of a dropped or picked `File` (Electron `webUtils.getPathForFile`), `''` when it has none. */
  pathForFile(file: File): string
}

export function toRpcError(e: unknown): RpcError {
  if (!(e instanceof Error)) return { name: 'Error', message: String(e) }
  const out: RpcError = { name: e.name, message: e.message, code: (e as { code?: string }).code }
  const details = errorDetails(e)
  if (details) out.details = details
  return out
}

/** Structured details of an error: its `details` object, or what its `toJSON()` adds beyond name/message/code. */
function errorDetails(e: Error): Record<string, unknown> | undefined {
  const own = (e as { details?: unknown }).details
  let raw: unknown = own
  if (raw === undefined && typeof (e as { toJSON?: unknown }).toJSON === 'function') {
    try {
      raw = (e as unknown as { toJSON(): unknown }).toJSON()
    } catch {
      return undefined
    }
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { name: _n, message: _m, code: _c, ...rest } = raw as Record<string, unknown>
  // Only plain JSON survives every boundary; drop anything structured clone would choke on.
  try {
    const plain = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
    return Object.keys(plain).length > 0 ? plain : undefined
  } catch {
    return undefined
  }
}

type Impl = Record<string, (...args: never[]) => Promise<unknown>>

/** Dispatches requests to registered service implementations. Transport-agnostic. */
export class ServiceRegistry {
  readonly #services = new Map<string, Impl>()

  register(name: string, impl: object): void {
    this.#services.set(name, impl as Impl)
  }

  async dispatch(req: Pick<RpcRequest, 'service' | 'method' | 'args'>): Promise<RpcResult<unknown>> {
    const impl = this.#services.get(req.service)
    const fn = impl && Object.hasOwn(impl, req.method) ? impl[req.method] : undefined
    if (typeof fn !== 'function') {
      return { ok: false, error: { name: 'RpcError', message: `Unknown method ${req.service}.${req.method}`, code: 'ENOMETHOD' } }
    }
    try {
      return { ok: true, value: await (fn as (...a: unknown[]) => Promise<unknown>).apply(impl, req.args) }
    } catch (e) {
      return { ok: false, error: toRpcError(e) }
    }
  }
}

/** Client half of a request/response protocol over any `postMessage`-style transport. */
export class RpcClient {
  #nextId = 1
  readonly #pending = new Map<number, (result: RpcResult<unknown>) => void>()

  constructor(private readonly send: (req: RpcRequest) => void) {}

  call(service: string, method: string, args: unknown[]): Promise<RpcResult<unknown>> {
    const id = this.#nextId++
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      try {
        this.send({ t: 'req', id, service, method, args })
      } catch (e) {
        this.#pending.delete(id)
        resolve({ ok: false, error: toRpcError(e) })
      }
    })
  }

  /** Feed a response received from the transport. */
  settle(res: RpcResponse): void {
    const resolve = this.#pending.get(res.id)
    if (!resolve) return
    this.#pending.delete(res.id)
    resolve(res.result)
  }

  /** Fail every in-flight call, e.g. when the transport dies. */
  failAll(error: RpcError): void {
    for (const resolve of this.#pending.values()) resolve({ ok: false, error })
    this.#pending.clear()
  }
}

export async function unwrap<T>(result: Promise<RpcResult<unknown>>): Promise<T> {
  const r = await result
  if (!r.ok) throw Object.assign(new Error(r.error.message), { name: r.error.name, code: r.error.code, details: r.error.details })
  return r.value as T
}
