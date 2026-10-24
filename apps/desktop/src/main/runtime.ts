import { join } from 'node:path'
import { app, ipcMain, MessageChannelMain, safeStorage, shell, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { CONNECT_CHANNEL, PORT_CHANNEL, ServiceRegistry, type RpcMessage } from '@shared/rpc'
import type { HostServices } from '@shared/services'
import { RUNTIME_ENV } from '@shared/paths'
import { emitMain } from './rpc/server'

const host: HostServices = {
  async encrypt(plain) {
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

  constructor() {
    this.#hostRegistry.register('host', host)
  }

  start(): void {
    ipcMain.on(CONNECT_CHANNEL, (event) => this.#connect(event.sender))
    this.#spawn()
    app.on('before-quit', () => this.stop())
  }

  stop(): void {
    this.#stopping = true
    this.#child?.kill()
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
