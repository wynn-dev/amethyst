/**
 * The `telemetry` runtime service: renderer events limited to an allow-list, and error reports
 * from every process. All gating (consent, schema, scrubbing) happens in `@amethyst/telemetry`;
 * see docs/PRIVACY.md.
 *
 * Consent lives in the settings (`privacy.usageData` / `privacy.crashReports`), which are the
 * single source of truth; see {@link useConsentSource}. `<userData>/telemetry.json` only keeps
 * the anonymous install id.
 */
import { join } from 'node:path'
import {
  createTelemetry,
  DEFAULT_HOST,
  loadTelemetryState,
  saveTelemetryState,
  type ExceptionContext,
  type Telemetry,
} from '@amethyst/telemetry'
import type { TelemetryConsent } from '@shared/services'
import { RUNTIME_ENV } from '@shared/paths'
import type { ReportedError, TelemetryService } from '@shared/services'

const stateFile = join(process.env[RUNTIME_ENV.userData] ?? process.cwd(), 'telemetry.json')

let client: Telemetry | undefined
let appOpenedSent = false
/** Errors raised before the consent file has been read; replayed (and gated) once it is. Bounded. */
const early: [unknown, ExceptionContext][] = []

/** Where consent is read from and written to (the settings store). */
export interface ConsentSource {
  load(): Promise<TelemetryConsent>
  save(consent: TelemetryConsent): Promise<void>
}

let resolveSource!: (source: ConsentSource) => void
const source = new Promise<ConsentSource>((resolve) => (resolveSource = resolve))

/** Connect telemetry to the settings store. Nothing is captured before this is called. */
export function useConsentSource(consentSource: ConsentSource): void {
  resolveSource(consentSource)
}

const ready: Promise<Telemetry> = Promise.all([loadTelemetryState(stateFile), source]).then(async ([loaded, consentSource]) => {
  const consent = await consentSource.load()
  // Persist the install id (generated on first run) so it stays stable across launches.
  await saveTelemetryState(stateFile, { installId: loaded.installId, consent: { usage: false, crashes: false } }).catch(() => {})
  client = createTelemetry({
    // Build-time credentials, inlined by electron-vite (envPrefix AMETHYST_) into the runtime bundle.
    apiKey: import.meta.env.AMETHYST_POSTHOG_KEY,
    host: import.meta.env.AMETHYST_POSTHOG_HOST || DEFAULT_HOST,
    installId: loaded.installId,
    consent,
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

/** Apply consent changed in the settings (immediately; revoking drops anything still queued). */
export async function applyConsent(consent: TelemetryConsent): Promise<TelemetryConsent> {
  const t = await ready
  t.setConsent(consent)
  sendAppOpened(t)
  return t.getConsent()
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
    const next = { usage: consent?.usage === true, crashes: consent?.crashes === true }
    // Saving goes through the settings store, whose change event calls `applyConsent`.
    await (await source).save(next)
    return applyConsent(next)
  },

  async capture(event, props) {
    const t = await ready
    t.captureUntrusted(event, props)
  },

  async reportError(error) {
    reportError(sanitizeReported(error), { source: 'renderer', handled: false })
  },
}
