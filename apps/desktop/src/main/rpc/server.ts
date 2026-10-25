import { AsyncLocalStorage } from 'node:async_hooks'
import { ipcMain, webContents, type WebContents } from 'electron'
import { MAIN_EVENT_CHANNEL, MAIN_RPC_CHANNEL, ServiceRegistry } from '@shared/rpc'
import type { MainServices } from '@shared/services'
import type { Events } from '@shared/events'

const registry = new ServiceRegistry()
const caller = new AsyncLocalStorage<WebContents>()

/** The renderer whose call is being served (for the few methods that act on the calling window). */
export function callingWebContents(): WebContents | undefined {
  return caller.getStore()
}

export function registerMainService<K extends keyof MainServices>(name: K, impl: MainServices[K]): void {
  registry.register(name, impl)
}

export function startMainRpc(): void {
  ipcMain.handle(MAIN_RPC_CHANNEL, (event, service: string, method: string, args: unknown[]) =>
    caller.run(event.sender, () => registry.dispatch({ service, method, args })),
  )
}

/** Push an event from the main process to every renderer. */
export function emitMain<K extends keyof Events>(event: K, payload: Events[K]): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(MAIN_EVENT_CHANNEL, event, payload)
  }
}
