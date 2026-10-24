/**
 * The runtime utility process. Owns every domain service (instances, installs, downloads,
 * resources, accounts, launch) so the Electron main thread only ever handles windows and OS
 * integration. Renderers reach it over direct MessagePorts handed out by the main process.
 */
import type { MessagePortMain } from 'electron'
import { attachPort, emit, handleHostResponse, registerService } from './rpc'

const startedAt = Date.now()

registerService('runtime', {
  async ping() {
    return { pid: process.pid, uptimeMs: Date.now() - startedAt, memoryRss: process.memoryUsage.rss() }
  },
})

process.parentPort.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const data = event.data as { t?: string }
  if (data?.t === 'connect') {
    for (const port of event.ports) attachPort(port)
    emit('runtime:ready', { at: Date.now() })
    return
  }
  handleHostResponse(event.data as never)
})
