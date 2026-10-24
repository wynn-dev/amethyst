import { join } from 'node:path'
import { app, ipcMain, MessageChannelMain, safeStorage, shell, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { CONNECT_CHANNEL, PORT_CHANNEL, ServiceRegistry, type RpcMessage } from '@shared/rpc'
import type { HostServices, ReportedError } from '@shared/services'
import { RUNTIME_ENV } from '@shared/paths'
import { closeAuthWindow, openAuthWindow } from './auth-window'
import { emitMain } from './rpc/server'

const SHUTDOWN_TIMEOUT_MS = 1_500

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
  async openExternal(url) {
    if (!/^https:\/\//i.test(url)) throw Object.assign(new Error('Only https: links can be opened'), { code: 'EINVALID_ARGUMENT' })
    await shell.openExternal(url)
  },
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

  constructor() {
    this.#hostRegistry.register('host', host)
  }

  start(): void {
    ipcMain.on(CONNECT_CHANNEL, (event) => this.#connect(event.sender))
    this.#spawn()
    // Give the runtime a brief, bounded chance to flush (e.g. consented telemetry) before quitting.
    app.on('before-quit', (event) => {
      if (this.#stopping || !this.#child) return this.stop()
      event.preventDefault()
      void this.shutdown(SHUTDOWN_TIMEOUT_MS).then(() => app.quit())
    })
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
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.postMessage({ t: 'shutdown' })
    })
    child.kill()
  }

  /** Forward a main-process error to the runtime's telemetry service, which applies consent. */
  reportError(error: ReportedError): void {
    if (this.#child && this.#ready) this.#child.postMessage({ t: 'error', source: 'main', error })
    else if (this.#pendingErrors.length < 10) this.#pendingErrors.push(error)
  }

  #spawn(): void {
    const child = utilityProcess.fork(join(import.meta.dirname, 'runtime.js'), [], {
      serviceName: 'Amethyst Runtime',
      stdio: app.isPackaged ? 'ignore' : 'inherit',
      env: {
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
      child.postMessage({ t: 'res', id: msg.id, result } satisfies RpcMessage)
    })

    child.once('spawn', () => {
      this.#ready = true
      for (const error of this.#pendingErrors) child.postMessage({ t: 'error', source: 'main', error })
      this.#pendingErrors = []
      // Attach every window that asked to connect before the runtime was up (or before a restart).
      for (const contents of this.#clients) this.#connect(contents)
    })

    child.once('exit', (code) => {
      if (this.#child === child) {
        this.#child = undefined
        this.#ready = false
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
