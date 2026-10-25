import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { MAIN_EVENT_CHANNEL, MAIN_RPC_CHANNEL, CONNECT_CHANNEL, PORT_CHANNEL, RpcClient, type Bridge, type IpcStats, type RpcMessage } from '@shared/rpc'
import { MAIN_SERVICES } from '@shared/services'

/**
 * Dev flag `AMETHYST_IPC_STATS=1` (used by the benchmark): count every message and its JSON size
 * through this bridge. Off by default; when off the only cost is one `undefined` check per message.
 */
const stats = process.env.AMETHYST_IPC_STATS === '1' ? createIpcStats() : undefined

function jsonSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

function tally(table: Record<string, { count: number; bytes: number }>, key: string, bytes: number): void {
  const row = (table[key] ??= { count: 0, bytes: 0 })
  row.count++
  row.bytes += bytes
}

function createIpcStats() {
  let state: IpcStats = { sinceMs: Date.now(), channels: {}, names: {} }
  const names = new Map<number, string>()
  const size = jsonSize
  const add = tally
  return {
    count(channel: string, name: string, payload: unknown) {
      const bytes = size(payload)
      add(state.channels, channel, bytes)
      add(state.names, name, bytes)
    },
    request(id: number, name: string) {
      names.set(id, name)
    },
    response(id: number) {
      const name = names.get(id) ?? '?'
      names.delete(id)
      return `${name} (res)`
    },
    read: (): IpcStats => structuredClone(state),
    reset() {
      state = { sinceMs: Date.now(), channels: {}, names: {} }
    },
  }
}

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
const runtime = new RpcClient((req) => {
  if (stats) {
    stats.request(req.id, `${req.service}.${req.method}`)
    stats.count('runtime:req', `${req.service}.${req.method}`, req)
  }
  return port ? port.postMessage(req) : queue.push(req)
})

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
    if (stats) stats.count(`runtime:${data.t}`, data.t === 'res' ? stats.response(data.id) : data.t === 'evt' ? data.event : '?', data)
    if (data.t === 'res') runtime.settle(data)
    else if (data.t === 'evt') dispatch(data.event, data.payload)
  }
  for (const req of queue) port.postMessage(req)
  queue = []
})
ipcRenderer.on(MAIN_EVENT_CHANNEL, (_, event: string, payload: unknown) => {
  stats?.count('main:evt', event, payload)
  dispatch(event, payload)
})

function invokeMain(service: string, method: string, args: unknown[]) {
  const result = ipcRenderer.invoke(MAIN_RPC_CHANNEL, service, method, args)
  if (!stats) return result
  stats.count('main:invoke', `${service}.${method}`, args)
  return result.then((r: unknown) => {
    stats.count('main:res', `${service}.${method} (res)`, r)
    return r
  })
}
ipcRenderer.send(CONNECT_CHANNEL)

const bridge: Bridge = {
  invoke: (service, method, args) =>
    mainServices.has(service) ? invokeMain(service, method, args) : runtime.call(service, method, args),
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
  ...(stats ? { ipcStats: { read: stats.read, reset: stats.reset } } : {}),
}

contextBridge.exposeInMainWorld('amethyst', bridge)
