import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { MAIN_EVENT_CHANNEL, MAIN_RPC_CHANNEL, CONNECT_CHANNEL, PORT_CHANNEL, RpcClient, type Bridge, type RpcMessage } from '@shared/rpc'
import { MAIN_SERVICES } from '@shared/services'

const mainServices = new Set<string>(MAIN_SERVICES)
const listeners = new Set<(event: string, payload: unknown) => void>()
const dispatch = (event: string, payload: unknown) => {
  for (const fn of listeners) fn(event, payload)
}

/** The DOM MessagePort as seen from the preload's typings (which are Node's, not the DOM's). */
interface Port {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: RpcMessage }) => void) | null
}

// Calls made before the runtime port arrives are queued, then flushed in order.
let port: Port | undefined
let queue: RpcMessage[] = []
const runtime = new RpcClient((req) => (port ? port.postMessage(req) : queue.push(req)))

ipcRenderer.on(PORT_CHANNEL, (event) => {
  const next = event.ports[0] as unknown as Port | undefined
  if (!next) return
  if (port) {
    // The runtime restarted: anything in flight on the old port is lost.
    runtime.failAll({ name: 'RuntimeRestarted', message: 'The background runtime restarted', code: 'ERUNTIME_RESTARTED' })
    port.close()
  }
  port = next
  port.onmessage = ({ data }) => {
    if (data.t === 'res') runtime.settle(data)
    else if (data.t === 'evt') dispatch(data.event, data.payload)
  }
  for (const req of queue) port.postMessage(req)
  queue = []
})
ipcRenderer.on(MAIN_EVENT_CHANNEL, (_, event: string, payload: unknown) => dispatch(event, payload))
ipcRenderer.send(CONNECT_CHANNEL)

const bridge: Bridge = {
  invoke: (service, method, args) =>
    mainServices.has(service) ? ipcRenderer.invoke(MAIN_RPC_CHANNEL, service, method, args) : runtime.call(service, method, args),
  on(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  platform: process.platform,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

contextBridge.exposeInMainWorld('amethyst', bridge)
