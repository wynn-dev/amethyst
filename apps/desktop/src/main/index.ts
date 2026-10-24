import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import type { ReportedError } from '@shared/services'
import { registerMainService, startMainRpc } from './rpc/server'
import { RuntimeSupervisor } from './runtime'
import { Updater } from './updater'

const isDev = !app.isPackaged
const runtime = new RuntimeSupervisor()
const updater = new Updater()

// Uncaught main-process errors are logged and forwarded to the runtime, whose telemetry service
// drops them unless the user enabled crash reports.
function toReported(e: unknown): ReportedError {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack }
  return { name: 'Error', message: String(e) }
}
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception in main:', e)
  runtime.reportError(toReported(e))
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main:', reason)
  runtime.reportError(toReported(reason))
})

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // `AMETHYST_SMOKE=1`: verify both RPC paths end to end, print the result, and quit. Used by CI,
  // also against the packaged app, where it additionally proves that the externalized
  // electron-updater module made it into the asar.
  if (process.env.AMETHYST_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const calls: { ok: boolean }[] = await win.webContents.executeJavaScript(
        `Promise.all(${JSON.stringify([
          ['app', 'getInfo'],
          ['updater', 'getState'],
          ['runtime', 'ping'],
          ['telemetry', 'getConsent'],
        ])}.map(([service, method]) => window.amethyst.invoke(service, method, [])))`,
      )
      const updaterModule = await import('electron-updater').then(
        () => ({ ok: true, value: 'electron-updater' }),
        (e: Error) => ({ ok: false, error: { name: e.name, message: e.message } }),
      )
      const result = [...calls, updaterModule]
      console.log(`SMOKE ${JSON.stringify(result)}`)
      runtime.stop()
      app.exit(result.every((r) => r.ok) ? 0 : 1)
    })
  }

  // Never let the renderer navigate away or open windows; hand external links to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  // The registry only dispatches to own properties, so expose the class through a plain object.
  registerMainService('updater', {
    getState: () => updater.getState(),
    check: () => updater.check(),
    quitAndInstall: () => updater.quitAndInstall(),
  })
  registerMainService('app', {
    async getInfo() {
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      }
    },
  })
  startMainRpc()
  // Window first, runtime in parallel: nothing on the paint path waits for background services.
  createMainWindow()
  runtime.start()
  updater.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// If an update has been downloaded, electron-updater installs it as the app quits.
app.on('before-quit', () => updater.stop())

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive with no windows; quit from the menu or ⌘Q.
})
