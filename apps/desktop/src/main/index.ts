import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerMainService, startMainRpc } from './rpc/server'
import { RuntimeSupervisor } from './runtime'
import { installAppMenu } from './menu'
import { guardNavigation, runScreenshots } from './windows'

const isDev = !app.isPackaged
const runtime = new RuntimeSupervisor()
let mainWindow: BrowserWindow | undefined

// `AMETHYST_SCREENSHOT=<dir>` (dev only): start from a fresh profile so first run and fixtures are predictable.
const screenshotDir = isDev ? process.env.AMETHYST_SCREENSHOT : undefined
if (screenshotDir) app.setPath('userData', join(screenshotDir, '.profile'))

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
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

  // `AMETHYST_SMOKE=1`: verify both RPC paths end to end, print the result, and quit. Used by CI.
  if (process.env.AMETHYST_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const result = await win.webContents.executeJavaScript(
        `Promise.all([window.amethyst.invoke('app', 'getInfo', []), window.amethyst.invoke('runtime', 'ping', [])])`,
      )
      console.log(`SMOKE ${JSON.stringify(result)}`)
      runtime.stop()
      app.exit(result.every((r: { ok: boolean }) => r.ok) ? 0 : 1)
    })
  }

  // Never let the renderer navigate away or open windows; hand external links to the OS, and
  // route the app's own `#/settings/…` URLs to the Settings window.
  guardNavigation(win.webContents)

  if (screenshotDir) {
    runScreenshots(win, screenshotDir, () => {
      runtime.stop()
      app.exit(0)
    }).catch((e) => {
      console.error('screenshot mode failed', e)
      app.exit(1)
    })
  }

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
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
  installAppMenu(() => mainWindow ?? createMainWindow())
  // Window first, runtime in parallel: nothing on the paint path waits for background services.
  createMainWindow()
  runtime.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive with no windows; quit from the menu or ⌘Q.
})
