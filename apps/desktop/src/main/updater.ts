/**
 * In-app updates from the rolling `nightly` GitHub release (DECISIONS.md, ui.md B14).
 *
 * - The feed is the `generic` provider from `electron-builder.yml`, baked into the app as
 *   `app-update.yml`; it serves `latest-mac.yml` and the zip.
 * - Checks run 10 s after launch and then every 4 h while the app is running. Updates download
 *   in the background and install on the next quit, or immediately via `quitAndInstall`.
 * - electron-updater is imported lazily on the first check, so it never touches startup.
 * - Signature verification stays on: on macOS, Squirrel.Mac refuses an update whose code
 *   signature doesn't satisfy the running app's designated requirement (same Developer ID team),
 *   and electron-updater checks the zip's sha512 from `latest-mac.yml`. Nothing here disables it.
 */
import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { UpdaterService, UpdaterState } from '@shared/services'
import { emitMain } from './rpc/server'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const PROGRESS_MIN_INTERVAL_MS = 250

export class Updater implements UpdaterService {
  /** Updates only make sense for a packaged, signed build; never in dev or smoke runs. */
  readonly enabled = app.isPackaged && !process.env.AMETHYST_SMOKE && process.env.AMETHYST_DISABLE_UPDATES !== '1'

  #state: UpdaterState = { status: 'idle' }
  #updater?: Promise<AppUpdater>
  #firstCheck?: NodeJS.Timeout
  #interval?: NodeJS.Timeout
  #lastProgressAt = 0
  readonly #listeners = new Set<(state: UpdaterState) => void>()

  /** The current state, synchronously (for the menu bar). */
  get state(): UpdaterState {
    return this.#state
  }

  /** Called on every state change (the menu bar shows "Restart to Update" when one is ready). */
  onChange(listener: (state: UpdaterState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Schedule the first check and the periodic check. */
  start(): void {
    if (!this.enabled || this.#firstCheck) return
    this.#firstCheck = setTimeout(() => {
      void this.check()
      this.#interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    }, FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    clearTimeout(this.#firstCheck)
    clearInterval(this.#interval)
  }

  async getState(): Promise<UpdaterState> {
    return this.#state
  }

  async check(): Promise<UpdaterState> {
    // A check is already running, or an update is on its way or waiting for a restart.
    if (!this.enabled || this.#state.status === 'checking' || this.#state.status === 'downloading' || this.#state.status === 'ready') {
      return this.#state
    }
    this.#set({ status: 'checking' })
    try {
      const updater = await this.#load()
      const result = await updater.checkForUpdates()
      // Download failures are reported through the 'error' event; don't let the promise go unhandled.
      result?.downloadPromise?.catch(() => {})
      // (The cast undoes TypeScript's narrowing from the guard above; events changed the state.)
      if ((this.#state as UpdaterState).status === 'checking') this.#set({ status: 'idle' })
    } catch (e) {
      this.#set({ status: 'error', message: errorMessage(e) })
    }
    return this.#state
  }

  async quitAndInstall(): Promise<void> {
    if (this.#state.status !== 'ready' || !this.#updater) {
      throw Object.assign(new Error('No update is ready to install'), { code: 'ENOUPDATE' })
    }
    const updater = await this.#updater
    // Reply to the renderer first; quitting closes every window.
    setImmediate(() => updater.quitAndInstall())
  }

  #load(): Promise<AppUpdater> {
    this.#updater ??= import('electron-updater').then((mod) => {
      // electron-updater is CommonJS and defines `autoUpdater` with a lazy getter, which Node's
      // named-export detection can't see; read it from the CommonJS module object.
      const updater = mod.default.autoUpdater
      updater.autoDownload = true
      updater.allowPrerelease = true
      updater.autoInstallOnAppQuit = true
      updater.allowDowngrade = false
      updater.logger = { info: () => {}, debug: () => {}, warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m) }

      updater.on('checking-for-update', () => this.#set({ status: 'checking' }))
      updater.on('update-not-available', () => this.#set({ status: 'idle' }))
      updater.on('update-available', (info) => this.#set({ status: 'downloading', percent: 0, version: info.version }))
      updater.on('download-progress', (progress) => {
        const now = Date.now()
        if (now - this.#lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
        this.#lastProgressAt = now
        const version = this.#state.status === 'downloading' ? this.#state.version : undefined
        this.#set({ status: 'downloading', percent: Math.min(100, Math.floor(progress.percent)), version })
      })
      updater.on('update-downloaded', (info) => {
        this.stop() // Nothing more to check until the user restarts.
        this.#set({ status: 'ready', version: info.version })
      })
      updater.on('error', (e) => this.#set({ status: 'error', message: errorMessage(e) }))
      return updater
    })
    return this.#updater
  }

  #set(state: UpdaterState): void {
    // An error after 'ready' is meaningful: Squirrel.Mac validates the update's code signature
    // only after electron-updater reports the download, and a rejected update must not look ready.
    this.#state = state
    emitMain('updater:state', state)
    for (const listener of this.#listeners) listener(state)
  }
}

function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  // electron-updater errors can embed whole HTTP responses; keep the first line.
  return message.split('\n')[0]!.slice(0, 300)
}
