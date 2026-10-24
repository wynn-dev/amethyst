import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, RPC_CHANNEL, type Bridge } from '@shared/rpc'

const bridge: Bridge = {
  invoke: (service, method, args) => ipcRenderer.invoke(RPC_CHANNEL, service, method, args),
  on(listener) {
    const handler = (_: unknown, event: string, payload: unknown) => listener(event, payload)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('amethyst', bridge)
