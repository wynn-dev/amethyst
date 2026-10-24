import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, protocol, shell } from 'electron'
import { ASSET_SCHEME } from '@shared/paths'
import { serveAssetRequest } from './asset-protocol'
import { registerMainService, startMainRpc } from './rpc/server'
import { RuntimeSupervisor } from './runtime'

const isDev = !app.isPackaged
// The smoke test runs against a throwaway data root, never the user's real one.
if (process.env.AMETHYST_SMOKE) app.setPath('userData', mkdtempSync(join(tmpdir(), 'amethyst-smoke-')))
const runtime = new RuntimeSupervisor()

// Local images and videos (icons, backgrounds, skins) are served from the data root only; see asset-path.ts.
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

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

  // `AMETHYST_SMOKE=1`: verify every RPC path end to end through the renderer bridge (main, the
  // runtime, its SQLite worker and the domain services), print the result, and quit. Used by CI.
  if (process.env.AMETHYST_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const calls: [string, string][] = [
        ['app', 'getInfo'],
        ['runtime', 'ping'],
        ['settings', 'get'],
        ['instances', 'list'],
        ['accounts', 'list'],
      ]
      const result: { ok: boolean; value?: unknown; error?: unknown }[] = await win.webContents.executeJavaScript(
        `Promise.all(${JSON.stringify(calls)}.map(([s, m]) => window.amethyst.invoke(s, m, [])))`,
      )
      const summary = Object.fromEntries(calls.map(([s, m], i) => [`${s}.${m}`, result[i]]))
      process.stdout.write(`SMOKE ${JSON.stringify(summary)}\n`)
      const ping = result[1]?.value as { index?: { ok?: boolean } } | undefined
      const ok = result.every((r) => r.ok) && ping?.index?.ok === true && Array.isArray(result[3]?.value) && Array.isArray(result[4]?.value)
      runtime.stop()
      app.exit(ok ? 0 : 1)
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
  const dataRoot = app.getPath('userData')
  protocol.handle(ASSET_SCHEME, (request) => serveAssetRequest(dataRoot, request.url, request.headers.get('range')))
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive with no windows; quit from the menu or ⌘Q.
})
