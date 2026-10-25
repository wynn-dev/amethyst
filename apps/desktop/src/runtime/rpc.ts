import type { MessagePortMain } from 'electron'
import { postResponse, RpcClient, ServiceRegistry, unwrap, type RpcMessage } from '@shared/rpc'
import type { HostServices, RuntimeServices } from '@shared/services'
import type { Events } from '@shared/events'

const registry = new ServiceRegistry()
const ports = new Set<MessagePortMain>()

export function registerService<K extends keyof RuntimeServices>(name: K, impl: RuntimeServices[K]): void {
  registry.register(name, impl)
}

/** Serve RPC on a renderer's port until it closes. */
export function attachPort(port: MessagePortMain): void {
  ports.add(port)
  port.on('message', async ({ data }: { data: RpcMessage }) => {
    if (data?.t !== 'req') return
    const result = await registry.dispatch(data)
    postResponse((msg) => port.postMessage(msg), data.id, result)
  })
  port.on('close', () => ports.delete(port))
  port.start()
}

/** Push an event to every connected renderer. */
export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  const msg: RpcMessage = { t: 'evt', event, payload }
  for (const port of ports) {
    try {
      port.postMessage(msg)
    } catch (e) {
      // A payload structured clone rejects must not throw into the service that emitted it.
      console.error(`cannot send event ${event}`, e)
    }
  }
}

const hostClient = new RpcClient((req) => process.parentPort.postMessage(req))

export function handleHostResponse(msg: RpcMessage): boolean {
  if (msg?.t !== 'res') return false
  hostClient.settle(msg)
  return true
}

/** Electron-only APIs borrowed from the main process (keychain, trash). */
export const host = new Proxy({} as HostServices, {
  get: (_, method: string) => (...args: unknown[]) => unwrap(hostClient.call('host', method, args)),
})
