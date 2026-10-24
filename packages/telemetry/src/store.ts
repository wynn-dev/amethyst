import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Consent } from './events'

/** What Amethyst stores locally about telemetry (`telemetry.json` in userData). */
export interface TelemetryState {
  /** Anonymous random UUID. Not derived from the machine or any account. */
  installId: string
  consent: Consent
  /** When the user last changed their choice (ms since epoch); absent until they decide. */
  decidedAt?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Read the stored state. A missing or corrupt file yields defaults: no consent and a fresh install
 * id (which is only persisted once the caller saves, i.e. once the user makes a choice).
 */
export async function loadTelemetryState(file: string): Promise<TelemetryState> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    raw = undefined
  }
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const consent = (data.consent && typeof data.consent === 'object' ? data.consent : {}) as Record<string, unknown>
  return {
    installId: typeof data.installId === 'string' && UUID_RE.test(data.installId) ? data.installId : randomUUID(),
    consent: { usage: consent.usage === true, crashes: consent.crashes === true },
    ...(typeof data.decidedAt === 'number' ? { decidedAt: data.decidedAt } : {}),
  }
}

/** Write atomically: a temp file in the same directory, then rename over the target. */
export async function saveTelemetryState(file: string, state: TelemetryState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
