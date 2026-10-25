import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, MessageChannelMain, safeStorage, shell, utilityProcess, type MessagePortMain, type UtilityProcess, type WebContents } from 'electron'
import { CONNECT_CHANNEL, PORT_CHANNEL, postResponse, RpcClient, ServiceRegistry, unwrap, type RpcMessage } from '@shared/rpc'
import type { Events } from '@shared/events'
import type { HostServices, ReportedError, RuntimeServices } from '@shared/services'
import { RUNTIME_ENV } from '@shared/paths'
import { clearAuthSession, closeAuthWindow, openAuthWindow } from './auth-window'
import { emitMain } from './rpc/server'
import { mainMark } from './bench-marks'

const SHUTDOWN_TIMEOUT_MS = 1_500

/** Windows hidden while a game runs ("hide launcher while playing"); shown again afterwards. */
const hiddenWindows = new Set<BrowserWindow>()

const host: HostServices = {
  async encrypt(plain) {
    // No plaintext fallback: without the Keychain the runtime keeps credentials in memory only.
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Encryption is not available'), { code: 'ESECRET_UNAVAILABLE' })
    return safeStorage.encryptString(plain).toString('base64')
  },
  async decrypt(cipher) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (e) {
      throw Object.assign(new Error('Stored secret could not be decrypted', { cause: e }), { code: 'ESECRET_UNREADABLE' })
    }
  },
  async trash(path) {
    await shell.trashItem(path)
  },
  openAuthWindow: (url, redirectUri) => openAuthWindow(url, redirectUri),
  async closeAuthWindow() {
    closeAuthWindow()
  },
  clearAuthSession: () => clearAuthSession(),
  async openExternal(url) {
    if (!/^https:\/\//i.test(url)) throw Object.assign(new Error('Only https: links can be opened'), { code: 'EINVALID_ARGUMENT' })
    await shell.openExternal(url)
  },
  async setLauncherHidden(hidden) {
    if (hidden) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || !win.isVisible()) continue
        hiddenWindows.add(win)
        win.hide()
      }
      return
    }
    showHiddenWindows()
  },
}

/** Show the windows hidden for a running game (also when the user clicks the Dock icon). */
export function showHiddenWindows(): void {
  for (const win of hiddenWindows) if (!win.isDestroyed()) win.show()
  hiddenWindows.clear()
}

/**
 * Owns the runtime utility process: forks it, restarts it on crash with backoff, serves its
 * `host` calls, and hands each renderer a direct MessagePort to it.
 */
export class RuntimeSupervisor {
  #child?: UtilityProcess
  #ready = false
  #restarts = 0
  #stopping = false
  readonly #hostRegistry = new ServiceRegistry()
  readonly #clients = new Set<WebContents>()
  /** Main-process errors waiting for the runtime to (re)start. Bounded. */
  #pendingErrors: ReportedError[] = []
  /** Main's own connection to the runtime, like a renderer's (menu state, the quit check). */
  #port?: MessagePortMain
  #client?: RpcClient
  readonly #eventListeners = new Set<(event: keyof Events, payload: unknown) => void>()
  #quitGuard?: () => Promise<boolean>
  #quitConfirmed = false
  #confirmingQuit = false

  constructor() {
    this.#hostRegistry.register('host', host)
  }

  start(): void {
    ipcMain.on(CONNECT_CHANNEL, (event) => this.#connect(event.sender))
    this.#spawn()
    // Give the runtime a brief, bounded chance to flush (e.g. consented telemetry) before quitting.
    // The quit guard (menu.ts) asks first when downloads or a game are running.
    app.on('before-quit', (event) => {
      if (this.#stopping || !this.#child) return this.stop()
      event.preventDefault()
      if (this.#confirmingQuit) return
      this.#confirmingQuit = true
      void (async () => {
        const ok = this.#quitConfirmed || !this.#quitGuard || (await this.#quitGuard().catch(() => true))
        this.#confirmingQuit = false
        if (!ok) return
        await this.shutdown(SHUTDOWN_TIMEOUT_MS)
        app.quit()
      })()
    })
  }

  /** Ask before quitting (resolves `false` to cancel). Not consulted after {@link allowQuit}. */
  setQuitGuard(guard: () => Promise<boolean>): void {
    this.#quitGuard = guard
  }

  /** The user already confirmed (e.g. Restart to Update); the next quit doesn't ask again. */
  allowQuit(): void {
    this.#quitConfirmed = true
  }

  /** Call a runtime service from main. Rejects with `ERUNTIME_UNAVAILABLE` while it is down, or `ETIMEDOUT`. */
  call<S extends keyof RuntimeServices, M extends keyof RuntimeServices[S] & string>(
    service: S,
    method: M,
    args: unknown[] = [],
    timeoutMs = 2_000,
  ): Promise<Awaited<ReturnType<RuntimeServices[S][M] extends (...a: never[]) => unknown ? RuntimeServices[S][M] : never>>> {
    const client = this.#client
    if (!client) return Promise.reject(Object.assign(new Error('The runtime is not running'), { code: 'ERUNTIME_UNAVAILABLE' }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error(`${service}.${method} timed out`), { code: 'ETIMEDOUT' })), timeoutMs)
      unwrap<never>(client.call(service, method, args))
        .then(resolve, reject)
        .finally(() => clearTimeout(timer))
    })
  }

  /** Runtime events (the same ones renderers get). Also fires `runtime:ready` after each (re)start. */
  onEvent(listener: (event: keyof Events, payload: unknown) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  stop(): void {
    this.#stopping = true
    this.#child?.kill()
  }

  /** Ask the runtime to finish up and exit; kill it if it takes longer than `timeoutMs`. */
  async shutdown(timeoutMs: number): Promise<void> {
    this.#stopping = true
    const child = this.#child
    if (!child) return
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
      child.postMessage({ t: 'shutdown' })
    })
    if (exited) return
    // The runtime handles SIGTERM (`kill()`) by starting the same shutdown that is already stuck,
    // so escalate: a hung runtime must never outlive the app.
    child.kill()
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }

  /** Forward a main-process error to the runtime's telemetry service, which applies consent. */
  reportError(error: ReportedError): void {
    if (this.#child && this.#ready) this.#child.postMessage({ t: 'error', source: 'main', error })
    else if (this.#pendingErrors.length < 10) this.#pendingErrors.push(error)
  }

  #spawn(): void {
    mainMark('runtime-fork')
    const child = utilityProcess.fork(join(import.meta.dirname, 'runtime.js'), [], {
      serviceName: 'Amethyst Runtime',
      stdio: app.isPackaged ? 'ignore' : 'inherit',
      env: {
        // The runtime's file I/O, hashing and DNS share libuv's pool; the default 4 threads starve DNS
        // during big installs (download.md P5).
        UV_THREADPOOL_SIZE: '16',
        ...process.env,
        [RUNTIME_ENV.userData]: app.getPath('userData'),
        [RUNTIME_ENV.logs]: app.getPath('logs'),
        [RUNTIME_ENV.version]: app.getVersion(),
        [RUNTIME_ENV.osVersion]: process.getSystemVersion(),
      },
    })
    this.#child = child
    this.#ready = false

    child.on('message', async (msg: RpcMessage) => {
      if (msg?.t !== 'req') return
      const result = await this.#hostRegistry.dispatch(msg)
      postResponse((res) => child.postMessage(res), msg.id, result)
    })

    child.once('spawn', () => {
      mainMark('runtime-spawn')
      this.#ready = true
      this.#connectSelf(child)
      for (const error of this.#pendingErrors) child.postMessage({ t: 'error', source: 'main', error })
      this.#pendingErrors = []
      // Attach every window that asked to connect before the runtime was up (or before a restart).
      for (const contents of this.#clients) this.#connect(contents)
    })

    child.once('exit', (code) => {
      if (this.#child === child) {
        this.#child = undefined
        this.#ready = false
        this.#port?.close()
        this.#port = undefined
        this.#client?.failAll({ name: 'RpcError', message: 'The runtime restarted', code: 'ERUNTIME_RESTARTED' })
        this.#client = undefined
      }
      if (this.#stopping) return
      const delay = Math.min(30_000, 250 * 2 ** this.#restarts++)
      console.error(`runtime exited with code ${code}; restarting in ${delay} ms`)
      setTimeout(() => {
        this.#spawn()
        emitMain('runtime:restarted', { at: Date.now(), reason: `exit code ${code}` })
      }, delay)
    })

    // A runtime that stays up for a minute is considered healthy again.
    setTimeout(() => {
      if (this.#child === child) this.#restarts = 0
    }, 60_000).unref()
  }

  #connectSelf(child: UtilityProcess): void {
    const { port1, port2 } = new MessageChannelMain()
    const client = new RpcClient((req) => port2.postMessage(req))
    port2.on('message', ({ data }: { data: RpcMessage }) => {
      if (data?.t === 'res') client.settle(data)
      else if (data?.t === 'evt') for (const listener of this.#eventListeners) listener(data.event as keyof Events, data.payload)
    })
    port2.start()
    this.#port = port2
    this.#client = client
    child.postMessage({ t: 'connect', webContentsId: 0 }, [port1])
  }

  #connect(contents: WebContents): void {
    if (!this.#clients.has(contents)) {
      this.#clients.add(contents)
      contents.once('destroyed', () => this.#clients.delete(contents))
    }
    const child = this.#child
    if (!child || !this.#ready || contents.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ t: 'connect', webContentsId: contents.id }, [port1])
    contents.postMessage(PORT_CHANNEL, null, [port2])
  }
}
