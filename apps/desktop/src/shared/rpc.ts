/**
 * Typed RPC between the renderer and the main process.
 *
 * Every service is a plain object of async methods. The main process registers
 * implementations by name; the renderer reaches them through a proxy, so a call
 * like `api.instances.list()` becomes one `ipcRenderer.invoke('rpc', 'instances', 'list', [])`.
 *
 * Push events flow the other way on a single channel and are coalesced per animation
 * frame on the renderer side to keep IPC traffic low during downloads and installs.
 */

export const RPC_CHANNEL = 'amethyst:rpc'
export const EVENT_CHANNEL = 'amethyst:event'

/** Map of service name to its async interface. Extended per domain in `services.ts`. */
export type ServiceMap = Record<string, Record<string, (...args: never[]) => Promise<unknown>>>

/** Map of event name to payload type. Extended per domain in `events.ts`. */
export type EventMap = Record<string, unknown>

export interface RpcError {
  name: string
  message: string
  code?: string
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface Bridge {
  invoke(service: string, method: string, args: unknown[]): Promise<RpcResult<unknown>>
  on(listener: (event: string, payload: unknown) => void): () => void
  platform: string
}
