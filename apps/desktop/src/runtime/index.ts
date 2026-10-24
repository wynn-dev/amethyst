/**
 * The runtime utility process. Owns every domain service (instances, installs, downloads,
 * resources, accounts, launch) so the Electron main thread only ever handles windows and OS
 * integration. Renderers reach it over direct MessagePorts handed out by the main process.
 */
import type { MessagePortMain } from 'electron'
import type { ReportedError } from '@shared/services'
import { attachPort, emit, handleHostResponse, registerService } from './rpc'
import { reportError, shutdownTelemetry, telemetryService } from './telemetry'

const startedAt = Date.now()

/** Give consented telemetry a bounded chance to go out, then exit. */
async function exitAfterFlush(code: number, timeoutMs: number): Promise<never> {
  await shutdownTelemetry(timeoutMs)
  process.exit(code)
}

// An uncaught exception leaves the runtime in an unknown state: report it (if the user allows
// crash reports), give the report a moment to go out, then exit so main restarts us.
let exiting = false
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in runtime:', error)
  reportError(error, { source: 'runtime', handled: false, fatal: true })
  if (exiting) return
  exiting = true
  void exitAfterFlush(1, 2_000)
})
// A stray rejection is reported but not fatal.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in runtime:', reason)
  reportError(reason, { source: 'runtime', handled: false })
})

registerService('runtime', {
  async ping() {
    return { pid: process.pid, uptimeMs: Date.now() - startedAt, memoryRss: process.memoryUsage.rss() }
  },
})
registerService('telemetry', telemetryService)

process.parentPort.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const data = event.data as { t?: string; error?: ReportedError }
  if (data?.t === 'connect') {
    for (const port of event.ports) attachPort(port)
    emit('runtime:ready', { at: Date.now() })
    return
  }
  if (data?.t === 'error' && data.error) {
    reportError(data.error, { source: 'main', handled: false })
    return
  }
  if (data?.t === 'shutdown') {
    void exitAfterFlush(0, 1_000)
    return
  }
  handleHostResponse(event.data as never)
})
