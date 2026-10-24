/**
 * The minimal `telemetry` runtime service: consent persisted in `<userData>/telemetry.json`,
 * renderer events limited to an allow-list, and error reports from every process.
 * All gating (consent, schema, scrubbing) happens in `@amethyst/telemetry`; see docs/PRIVACY.md.
 *
 * TODO(settings): the settings service may take over persisting consent; keep this file's
 * format (`{ installId, consent, decidedAt }`) or migrate it.
 */
import { join } from 'node:path'
import {
  createTelemetry,
  DEFAULT_HOST,
  loadTelemetryState,
  saveTelemetryState,
  type ExceptionContext,
  type Telemetry,
  type TelemetryState,
} from '@amethyst/telemetry'
import { RUNTIME_ENV } from '@shared/paths'
import type { ReportedError, TelemetryService } from '@shared/services'

const stateFile = join(process.env[RUNTIME_ENV.userData] ?? process.cwd(), 'telemetry.json')

let client: Telemetry | undefined
let state: TelemetryState | undefined
let appOpenedSent = false
let saving: Promise<void> = Promise.resolve()
/** Errors raised before the consent file has been read; replayed (and gated) once it is. Bounded. */
const early: [unknown, ExceptionContext][] = []

const ready: Promise<Telemetry> = loadTelemetryState(stateFile).then((loaded) => {
  state = loaded
  client = createTelemetry({
    // Build-time credentials, inlined by electron-vite (envPrefix AMETHYST_) into the runtime bundle.
    apiKey: import.meta.env.AMETHYST_POSTHOG_KEY,
    host: import.meta.env.AMETHYST_POSTHOG_HOST || DEFAULT_HOST,
    installId: loaded.installId,
    consent: loaded.consent,
    appInfo: {
      appVersion: process.env[RUNTIME_ENV.version] ?? '0.0.0',
      osVersion: process.env[RUNTIME_ENV.osVersion] ?? 'unknown',
      arch: process.arch,
      electronVersion: process.versions.electron,
    },
  })
  for (const [error, context] of early.splice(0)) client.captureException(error, context)
  sendAppOpened(client)
  return client
})

/** Once per session, and only with usage consent: this is what DAU/MAU counts. */
function sendAppOpened(t: Telemetry): void {
  if (!appOpenedSent && t.getConsent().usage) appOpenedSent = t.capture('app_opened')
}

/** Report an error from any process. Dropped unless the user enabled crash reports. */
export function reportError(error: unknown, context: ExceptionContext): void {
  if (client) client.captureException(error, context)
  else if (early.length < 10) early.push([error, context])
}

/**
 * Remove this exact string from every future error report. The accounts service must call this
 * with each signed-in player name (docs/PRIVACY.md promises it).
 */
export function redactFromReports(value: string): void {
  void ready.then((t) => t.addSensitive(value))
}

/** Send what is queued and stop, within `timeoutMs`. Never rejects. */
export async function shutdownTelemetry(timeoutMs: number): Promise<void> {
  await client?.shutdown(timeoutMs)
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** Renderer input is untrusted: keep only bounded string fields. */
function sanitizeReported(error: unknown): ReportedError {
  const e = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
  return { name: str(e.name, 100) ?? 'Error', message: str(e.message, 2_000) ?? String(error).slice(0, 2_000), stack: str(e.stack, 16_000) }
}

export const telemetryService: TelemetryService = {
  async getConsent() {
    return (await ready).getConsent()
  },

  async setConsent(consent) {
    const t = await ready
    const next = { usage: consent?.usage === true, crashes: consent?.crashes === true }
    t.setConsent(next)
    state = { ...state!, consent: next, decidedAt: Date.now() }
    const snapshot = state
    saving = saving.then(() => saveTelemetryState(stateFile, snapshot)).catch((e) => console.error('Could not save telemetry consent', e))
    await saving
    sendAppOpened(t)
    return t.getConsent()
  },

  async capture(event, props) {
    const t = await ready
    t.captureUntrusted(event, props)
  },

  async reportError(error) {
    reportError(sanitizeReported(error), { source: 'renderer', handled: false })
  },
}
