import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, protocol, shell } from 'electron'
import { ASSET_SCHEME } from '@shared/paths'
import type { ReportedError } from '@shared/services'
import { serveAssetRequest } from './asset-protocol'
import { registerMainService, startMainRpc } from './rpc/server'
import { RuntimeSupervisor, showHiddenWindows } from './runtime'
import { Updater } from './updater'

const isDev = !app.isPackaged
// The smoke test runs against a throwaway data root, never the user's real one.
if (process.env.AMETHYST_SMOKE) app.setPath('userData', mkdtempSync(join(tmpdir(), 'amethyst-smoke-')))
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
  // runtime, its SQLite worker and the domain services), print the result, and quit. Used by CI,
  // also against the packaged app, where it additionally proves that the externalized
  // electron-updater module made it into the asar.
  if (process.env.AMETHYST_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const calls: [string, string][] = [
        ['app', 'getInfo'],
        ['updater', 'getState'],
        ['runtime', 'ping'],
        ['telemetry', 'getConsent'],
        ['settings', 'get'],
        ['instances', 'list'],
        ['accounts', 'list'],
        ['java', 'list'],
        ['launch', 'listRunning'],
      ]
      // Needs the network on a fresh data root: an offline failure is fine, an exception is not.
      const networkCalls: [string, string][] = [['versions', 'listMinecraft']]
      const result: { ok: boolean; value?: unknown; error?: unknown }[] = await win.webContents.executeJavaScript(
        `Promise.all(${JSON.stringify(calls)}.map(([s, m]) => window.amethyst.invoke(s, m, [])))`,
      )
      const networkResult: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }[] = await win.webContents.executeJavaScript(
        `Promise.all(${JSON.stringify(networkCalls)}.map(([s, m]) => window.amethyst.invoke(s, m, [])))`,
      )
      // A rejection must be a structured RPC error (e.g. EHTTP offline), never a crash or a hang.
      const networkOk = networkResult.every((r) => r.ok || typeof r.error?.message === 'string')
      const updaterModule = await import('electron-updater').then(
        () => ({ ok: true }),
        (e: Error) => ({ ok: false, error: { name: e.name, message: e.message } }),
      )
      const summary = {
        ...Object.fromEntries(calls.map(([s, m], i) => [`${s}.${m}`, result[i]])),
        // Keep the output small: the version count, not the list.
        ...Object.fromEntries(
          networkCalls.map(([s, m], i) => {
            const r = networkResult[i]
            const items = (r?.value as { items?: unknown[] } | undefined)?.items
            return [`${s}.${m}`, r?.ok ? { ok: true, value: { versions: items?.length ?? 0 } } : r]
          }),
        ),
        'electron-updater': updaterModule,
      }
      process.stdout.write(`SMOKE ${JSON.stringify(summary)}\n`)
      const value = (name: string) => (summary as Record<string, { value?: unknown } | undefined>)[name]?.value
      const ping = value('runtime.ping') as { index?: { ok?: boolean } } | undefined
      const ok =
        result.every((r) => r.ok) &&
        updaterModule.ok &&
        ping?.index?.ok === true &&
        Array.isArray(value('instances.list')) &&
        Array.isArray(value('accounts.list')) &&
        Array.isArray(value('java.list')) &&
        Array.isArray(value('launch.listRunning')) &&
        networkOk
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
    showHiddenWindows()
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// If an update has been downloaded, electron-updater installs it as the app quits.
app.on('before-quit', () => updater.stop())

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive with no windows; quit from the menu or ⌘Q.
})
