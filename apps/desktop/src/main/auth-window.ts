/**
 * The embedded Microsoft sign-in window (accounts spec §2.3 A). The runtime builds the
 * authorize URL (PKCE, state) and exchanges the code; main only shows the page and reports the
 * redirect. The window runs in its own persistent session partition, so Microsoft cookies never
 * mix with the app's and "pick an existing account" works across restarts.
 */
import { BrowserWindow, session, shell } from 'electron'
import { classifyAuthNavigation, isSignInHost, matchesRedirect } from './auth-navigation'

export { matchesRedirect } from './auth-navigation'

const PARTITION = 'persist:amethyst-msa'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

let current: { win: BrowserWindow; fail: (code: string, message: string) => void } | undefined

const openExternal = (target: string) => void shell.openExternal(target).catch(() => {})

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
  if (parsed.protocol !== 'https:' || !isSignInHost(url)) return Promise.reject(error('EINVALID_ARGUMENT', 'The sign-in page must be a Microsoft https page'))
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
    const contents = win.webContents
    // Top-level navigations stay on Microsoft/Live/Xbox sign-in hosts; the redirect URI ends the
    // flow. A link to anything else (privacy statement, help) opens in the browser instead; a
    // server redirect to anything else is cancelled.
    const onMainFrame = (event: { preventDefault(): void; url: string; isMainFrame: boolean }, kind: 'navigate' | 'redirect') => {
      if (!event.isMainFrame) return
      const verdict = classifyAuthNavigation(event.url, redirectUri)
      if (verdict === 'allow') return
      event.preventDefault()
      if (verdict === 'redirect') finish(() => resolve(event.url))
      else if (verdict === 'external' && kind === 'navigate') openExternal(event.url)
    }
    contents.on('will-navigate', (event) => onMainFrame(event, 'navigate'))
    contents.on('will-redirect', (event) => onMainFrame(event, 'redirect'))
    // Frames (captcha, telemetry) may load any https page, but never another scheme.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) return
      if (classifyAuthNavigation(event.url, redirectUri) === 'block') event.preventDefault()
    })
    // Identity pages sometimes open popups: sign-in pages load in this window, the redirect ends
    // the flow, other https links open in the browser, and no new window is ever created.
    contents.setWindowOpenHandler(({ url: popup }) => {
      const verdict = classifyAuthNavigation(popup, redirectUri)
      if (verdict === 'allow') void win.loadURL(popup).catch(() => {})
      else if (verdict === 'redirect') finish(() => resolve(popup))
      else if (verdict === 'external') openExternal(popup)
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

/**
 * Sign the sign-in window out of Microsoft. Its cookies are not per account, so this clears the
 * whole partition: the next sign-in shows a fresh account picker.
 */
export async function clearAuthSession(): Promise<void> {
  await session.fromPartition(PARTITION).clearStorageData()
}

/** The sign-in window's session (for the proxy setting). */
export function authSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}
