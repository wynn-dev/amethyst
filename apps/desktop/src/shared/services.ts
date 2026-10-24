/**
 * The RPC surface. Methods must be async and take/return structured-cloneable data only.
 *
 * `RuntimeServices` live in the runtime utility process; `MainServices` live in the Electron
 * main process and cover only window/OS integration. `HostServices` are Electron-only APIs
 * the runtime borrows from main (never exposed to the renderer).
 */
import type { Consent, EventProps, RendererEventName } from '@amethyst/telemetry/events'

export type { Consent as TelemetryConsent, RendererEventName } from '@amethyst/telemetry/events'

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

export interface AppService {
  getInfo(): Promise<AppInfo>
}

export interface RuntimeStatusService {
  ping(): Promise<{ pid: number; uptimeMs: number; memoryRss: number }>
}

/** An error from another process, reduced to structured-cloneable fields. */
export interface ReportedError {
  name: string
  message: string
  stack?: string
}

/**
 * Consent-gated telemetry (see docs/PRIVACY.md). Both toggles are off until the user opts in;
 * while off, nothing is sent or queued.
 */
export interface TelemetryService {
  getConsent(): Promise<Consent>
  /** Persist and apply immediately. Revoking deletes anything still queued. */
  setConsent(consent: Consent): Promise<Consent>
  /** Capture one of the few events the renderer may send. Invalid events are dropped. */
  capture<E extends RendererEventName>(event: E, props: EventProps<E>): Promise<void>
  /** Report an uncaught renderer error (`window.onerror` / `unhandledrejection`). */
  reportError(error: ReportedError): Promise<void>
}

export interface RuntimeServices {
  runtime: RuntimeStatusService
  telemetry: TelemetryService
}

export type UpdaterState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; percent: number; version?: string }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

/** In-app updates from the rolling nightly release (electron-updater). Disabled in dev builds. */
export interface UpdaterService {
  getState(): Promise<UpdaterState>
  /** Check now (downloads automatically when an update exists). Resolves with the state after the check. */
  check(): Promise<UpdaterState>
  /** Restart into the downloaded update. Throws `ENOUPDATE` unless the state is `ready`. */
  quitAndInstall(): Promise<void>
}

export interface MainServices {
  app: AppService
  updater: UpdaterService
}

export const MAIN_SERVICES = ['app', 'updater'] as const satisfies readonly (keyof MainServices)[]

export type Services = RuntimeServices & MainServices

export interface HostServices {
  /** Encrypt with the OS keychain via Electron safeStorage. Returns base64. */
  encrypt(plain: string): Promise<string>
  /** Decrypt a value produced by `encrypt`. Throws `ESECRET_UNREADABLE` when the key changed. */
  decrypt(cipher: string): Promise<string>
  /** Move a file or folder to the macOS Trash. */
  trash(path: string): Promise<void>
}
