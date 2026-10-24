/**
 * The embedded Microsoft sign-in window (accounts spec §2.3 A). The runtime builds the
 * authorize URL (PKCE, state) and exchanges the code; main only shows the page and reports the
 * redirect. The window runs in its own persistent session partition, so Microsoft cookies never
 * mix with the app's and "pick an existing account" works across restarts.
 */
import { BrowserWindow } from 'electron'

const PARTITION = 'persist:amethyst-msa'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

let current: { win: BrowserWindow; fail: (code: string, message: string) => void } | undefined

/** Same scheme, port and path as the redirect URI; loopback host names are interchangeable. */
export function matchesRedirect(target: string, redirectUri: string): boolean {
  let a: URL
  let b: URL
  try {
    a = new URL(target)
    b = new URL(redirectUri)
  } catch {
    return false
  }
  if (a.protocol !== b.protocol || a.port !== b.port || a.pathname !== b.pathname) return false
  return a.hostname === b.hostname || (LOOPBACK.has(a.hostname) && LOOPBACK.has(b.hostname))
}

const error = (code: string, message: string) => Object.assign(new Error(message), { code })

export function openAuthWindow(url: string, redirectUri: string): Promise<string> {
  let parsed: URL
  let redirect: URL
  try {
    parsed = new URL(url)
    redirect = new URL(redirectUri)
  } catch {
    return Promise.reject(error('EINVALID_ARGUMENT', 'Bad sign-in URL'))
  }
  if (parsed.protocol !== 'https:') return Promise.reject(error('EINVALID_ARGUMENT', 'The sign-in page must be https'))
  if (redirect.protocol !== 'http:' || !LOOPBACK.has(redirect.hostname)) return Promise.reject(error('EINVALID_ARGUMENT', 'The redirect must be a loopback URL'))
  current?.fail('ECANCELLED', 'Replaced by a new sign-in window')

  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? undefined
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 600,
    show: false,
    title: 'Sign in with Microsoft',
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (current?.win === win) current = undefined
      fn()
      if (!win.isDestroyed()) win.destroy()
    }
    current = { win, fail: (code, message) => finish(() => reject(error(code, message))) }
    const intercept = (event: { preventDefault(): void }, target: string) => {
      if (!matchesRedirect(target, redirectUri)) return
      event.preventDefault()
      finish(() => resolve(target))
    }
    const contents = win.webContents
    contents.on('will-redirect', (event) => intercept(event, event.url))
    contents.on('will-navigate', (event) => intercept(event, event.url))
    // Identity pages sometimes open popups: keep them in this window, never in a new one.
    contents.setWindowOpenHandler(({ url: popup }) => {
      try {
        const u = new URL(popup)
        if (u.protocol === 'https:') void win.loadURL(popup)
        else if (matchesRedirect(popup, redirectUri)) finish(() => resolve(popup))
      } catch {
        // malformed: ignore
      }
      return { action: 'deny' }
    })
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED, which our own preventDefault() causes.
      if (isMainFrame && code !== -3 && !matchesRedirect(failedUrl, redirectUri)) finish(() => reject(error('EAUTH_WINDOW', `The sign-in page failed to load (${description})`)))
    })
    contents.on('render-process-gone', () => finish(() => reject(error('EAUTH_WINDOW', 'The sign-in page crashed'))))
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => finish(() => reject(error('ECANCELLED', 'The sign-in window was closed'))))
    win.loadURL(url).catch(() => {
      // Load failures are reported through did-fail-load.
    })
  })
}

export function closeAuthWindow(): void {
  current?.fail('ECANCELLED', 'Sign-in cancelled')
}
