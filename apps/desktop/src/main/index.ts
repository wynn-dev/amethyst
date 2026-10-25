import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, protocol, session } from 'electron'
import { ASSET_SCHEME } from '@shared/paths'
import type { ReportedError } from '@shared/services'
import { serveAssetRequest } from './asset-protocol'
import { dialogService, shellService, windowService } from './os-services'
import { prepareE2eDataRoot, runE2eUi } from './e2e-ui'
import { confirmQuit, installAppMenu, type AppMenu } from './menu'
import { installPermissionPolicy } from './permissions'
import { registerMainService, startMainRpc } from './rpc/server'
import { RuntimeSupervisor, showHiddenWindows } from './runtime'
import { Updater } from './updater'
import { guardNavigation, runScreenshots } from './windows'

const isDev = !app.isPackaged
// The smoke test runs against a throwaway data root, never the user's real one.
if (process.env.AMETHYST_SMOKE) app.setPath('userData', mkdtempSync(join(tmpdir(), 'amethyst-smoke-')))
const runtime = new RuntimeSupervisor()
const updater = new Updater()

// Deny web permissions (camera, microphone, geolocation…) to every session, including the sign-in
// window's; Amethyst's own pages keep only clipboard writes and notifications.
const devOrigin = isDev && process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : undefined
app.on('session-created', (s) => installPermissionPolicy(s, devOrigin))

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
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

let mainWindow: BrowserWindow | undefined
let appMenu: AppMenu | undefined

// `AMETHYST_SCREENSHOT=<dir>` (dev only): start from a fresh profile so first run and fixtures are predictable.
const screenshotDir = isDev ? process.env.AMETHYST_SCREENSHOT : undefined
if (screenshotDir) app.setPath('userData', join(screenshotDir, '.profile'))

// `AMETHYST_E2E_UI=core:<dir>` or `content:<dir>` (dev only): drive the real UI end to end in a
// temporary data root, writing screenshots to <dir> (see CONTRIBUTING.md). A bare `<dir>` means `core`.
const e2eSpec = isDev ? process.env.AMETHYST_E2E_UI : undefined
const e2eMatch = e2eSpec ? /^(core|content):(.+)$/.exec(e2eSpec) : null
const e2eDriver = e2eSpec ? (e2eMatch?.[1] ?? 'core') : undefined
const e2eDir = e2eSpec ? (e2eMatch?.[2] ?? e2eSpec) : undefined
const e2eRoot = e2eDir ? prepareE2eDataRoot() : undefined
if (e2eRoot) app.setPath('userData', e2eRoot)

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
        ['instances', 'getLayout'],
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

  // Never let the renderer navigate away or open windows; hand external links to the OS, and
  // route the app's own `#/settings/…` URLs to the Settings window.
  guardNavigation(win.webContents)

  if (e2eDir && e2eDriver === 'core') {
    runE2eUi(win, e2eDir, (ok) => {
      runtime.stop()
      app.exit(ok ? 0 : 1)
    }).catch((e) => {
      console.error('e2e UI run failed', e)
      app.exit(1)
    })
  }

  if (screenshotDir) {
    runScreenshots(win, screenshotDir, () => {
      runtime.stop()
      app.exit(0)
    }).catch((e) => {
      console.error('screenshot mode failed', e)
      app.exit(1)
    })
  }

  if (e2eDir && e2eRoot && e2eDriver === 'content') {
    void import('./e2e-content').then(({ runContentE2E }) =>
      runContentE2E(win, e2eRoot, e2eDir, (ok) => {
        runtime.stop()
        app.exit(ok ? 0 : 1)
      }),
    )
  }

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = undefined
    appMenu?.setContext({ instance: null })
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  installPermissionPolicy(session.defaultSession, devOrigin)
  const dataRoot = app.getPath('userData')
  protocol.handle(ASSET_SCHEME, (request) => serveAssetRequest(dataRoot, request.url, request.headers.get('range')))
  // The registry only dispatches to own properties, so expose the class through a plain object.
  registerMainService('updater', {
    getState: () => updater.getState(),
    check: () => updater.check(),
    async quitAndInstall() {
      if (!(await confirmQuit(runtime, 'restart'))) return
      runtime.allowQuit()
      return updater.quitAndInstall()
    },
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
  registerMainService('window', windowService(() => mainWindow, (context) => appMenu?.setContext(context)))
  registerMainService('shell', shellService)
  registerMainService('dialog', dialogService())
  startMainRpc()
  appMenu = installAppMenu({ getMainWindow: () => mainWindow ?? createMainWindow(), updater, runtime })
  runtime.setQuitGuard(() => confirmQuit(runtime))
  // Window first, runtime in parallel: nothing on the paint path waits for background services.
  createMainWindow()
  runtime.start()
  updater.start()

  app.on('activate', () => {
    showHiddenWindows()
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// If an update has been downloaded, electron-updater installs it as the app quits. (`will-quit`,
// not `before-quit`: the quit check can still cancel a quit at that point.)
app.on('will-quit', () => updater.stop())

app.on('window-all-closed', () => {
  // macOS convention: keep the app alive with no windows; quit from the menu or ⌘Q.
})
