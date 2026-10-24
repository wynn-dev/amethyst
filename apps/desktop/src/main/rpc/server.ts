import { ipcMain, type WebContents } from 'electron'
import { EVENT_CHANNEL, RPC_CHANNEL, type RpcResult } from '@shared/rpc'
import type { Services } from '@shared/services'
import type { Events } from '@shared/events'

type Impl = Record<string, (...args: never[]) => Promise<unknown>>

const services = new Map<string, Impl>()
const subscribers = new Set<WebContents>()

export function registerService<K extends keyof Services>(name: K, impl: Services[K]): void {
  services.set(name, impl as unknown as Impl)
}

export function startRpcServer(): void {
  ipcMain.handle(RPC_CHANNEL, async (event, service: string, method: string, args: unknown[]): Promise<RpcResult<unknown>> => {
    subscribers.add(event.sender)
    const impl = services.get(service)
    const fn = impl && Object.hasOwn(impl, method) ? impl[method] : undefined
    if (typeof fn !== 'function') {
      return { ok: false, error: { name: 'RpcError', message: `Unknown method ${service}.${method}`, code: 'ENOMETHOD' } }
    }
    try {
      return { ok: true, value: await (fn as (...a: unknown[]) => Promise<unknown>).apply(impl, args) }
    } catch (e) {
      const err = e as Error & { code?: string }
      return { ok: false, error: { name: err.name ?? 'Error', message: err.message ?? String(e), code: err.code } }
    }
  })
}

export function trackWebContents(contents: WebContents): void {
  subscribers.add(contents)
  contents.once('destroyed', () => subscribers.delete(contents))
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  for (const contents of subscribers) {
    if (!contents.isDestroyed()) contents.send(EVENT_CHANNEL, event, payload)
  }
}
