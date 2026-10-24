import type { ReportedError } from '@shared/services'
import { api } from './rpc'

const MAX_REPORTS_PER_SESSION = 20

function toReported(value: unknown): ReportedError {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return { name: 'Error', message: typeof value === 'string' ? value : String(value) }
}

/**
 * Forward uncaught renderer errors to the runtime's telemetry service, which drops them unless
 * the user enabled crash reports. Duplicates and error storms are cut off here to keep IPC quiet.
 */
export function installErrorReporting(): void {
  const seen = new Set<string>()
  const report = (value: unknown) => {
    const error = toReported(value)
    const key = `${error.name}:${error.message}`
    if (seen.has(key) || seen.size >= MAX_REPORTS_PER_SESSION) return
    seen.add(key)
    api.telemetry.reportError(error).catch(() => {})
  }
  window.addEventListener('error', (event) => report(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => report(event.reason))
}
