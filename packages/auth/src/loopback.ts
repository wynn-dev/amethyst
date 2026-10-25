/**
 * One-shot loopback HTTP listener for the system-browser login fallback (RFC 8252 §7.3).
 *
 * The server binds to the loopback interfaces only (`127.0.0.1`, plus `[::1]` on the same port
 * when IPv6 is available), on a random free port, and advertises `http://localhost:<port>` as the
 * redirect URI. Microsoft ignores the port only for `localhost` redirect URIs, so a registered
 * `http://localhost` covers every run. `http://127.0.0.1` would need its own registration (only
 * possible through the app manifest) and `[::1]` is not supported by Microsoft at all, so we keep
 * advertising `localhost` and listen on both loopback addresses it may resolve to. The server
 * accepts exactly one redirect carrying the expected `state`, answers it with a small
 * "you can close this window" page, and shuts down. Requests with a wrong `state` or a foreign
 * `Host` header are rejected without ending the wait.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthError } from './errors'
import { parseAuthorizationResponse } from './oauth'

export interface LoopbackOptions {
  /**
   * Path of the redirect URI, e.g. `/auth`. Default `''`, giving `http://localhost:<port>`, which
   * matches an app registration of plain `http://localhost`. A non-empty path must also be
   * registered (`http://localhost/auth`), because Microsoft compares paths.
   */
  path?: string
  /** Give up after this long, rejecting with `ELOGIN_TIMEOUT` (default 10 minutes). */
  timeoutMs?: number
  /** Stop waiting and close the server, rejecting with `ECANCELLED`. */
  signal?: AbortSignal
  /** Page shown after a successful redirect. */
  successHtml?: string
  /** Page shown when the redirect carried an OAuth error. */
  failureHtml?: string
}

export interface LoopbackServer {
  readonly port: number
  /** Pass this as `redirectUri` to both the authorize request and {@link exchangeCode}. */
  readonly redirectUri: string
  /**
   * Resolve with the authorization code once a redirect with `state` arrives. Call once, right
   * after creating the authorize request. Rejects on OAuth errors, timeout or cancellation.
   */
  waitForCode(state: string): Promise<{ code: string }>
  /** Stop listening. Safe to call more than once. */
  close(): Promise<void>
}

export const DEFAULT_LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  '<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;' +
  'background:#16131d;color:#ece8f4}main{text-align:center}h1{font-size:20px;font-weight:600}</style></head>' +
  `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`

const SUCCESS_HTML = page('Signed in to Amethyst', 'You can close this window and return to Amethyst.')
const FAILURE_HTML = page('Sign-in failed', 'You can close this window. Amethyst will show what went wrong.')
const INVALID_HTML = page('Invalid sign-in link', 'This link does not belong to the current Amethyst sign-in.')

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  })
  res.end(html)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/**
 * Listen on `127.0.0.1` at a random port, and on `[::1]` at the same port when the machine has
 * IPv6 loopback (`localhost` may resolve to either). A port taken on `[::1]` picks a new one.
 */
async function listenLoopback(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server[]> {
  // oxlint-disable no-await-in-loop -- each attempt depends on the previous one
  for (let attempt = 0; ; attempt++) {
    const v4 = createServer(handler)
    await listen(v4, 0, '127.0.0.1')
    const port = (v4.address() as AddressInfo).port
    const v6 = createServer(handler)
    try {
      await listen(v6, port, '::1')
      return [v4, v6]
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' && attempt < 5) {
        await new Promise<void>((r) => v4.close(() => r()))
        continue
      }
      // No IPv6 loopback (or a persistent clash): 127.0.0.1 alone still serves most browsers.
      return [v4]
    }
  }
  // oxlint-enable no-await-in-loop
}

/** Start the listener. The returned server is already accepting connections. */
export async function startLoopbackServer(options: LoopbackOptions = {}): Promise<LoopbackServer> {
  const path = options.path ?? ''
  if (path && !path.startsWith('/')) throw new TypeError('path must start with "/"')
  const pathname = path || '/'
  if (options.signal?.aborted) throw new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED' })

  let expectedState: string | undefined
  let settled = false
  let resolveCode!: (value: { code: string }) => void
  let rejectCode!: (error: unknown) => void
  const result = new Promise<{ code: string }>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // The caller observes failures through waitForCode(); avoid unhandled rejections before that.
  result.catch(() => {})

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // Reject DNS-rebinding style requests whose Host is not our loopback origin.
    let host: URL
    try {
      host = new URL(`http://${req.headers.host ?? ''}`)
    } catch {
      send(res, 400, INVALID_HTML)
      return
    }
    if (!LOOPBACK_HOSTNAMES.has(host.hostname) || host.port !== String(port)) {
      send(res, 400, INVALID_HTML)
      return
    }
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    if (req.method !== 'GET' || url.pathname !== pathname) {
      send(res, 404, page('Not found', ''))
      return
    }
    if (settled || expectedState === undefined || url.searchParams.get('state') !== expectedState) {
      send(res, 400, INVALID_HTML)
      return
    }
    try {
      const parsed = parseAuthorizationResponse(url.toString(), { redirectUri, state: expectedState })
      if (!parsed) throw new AuthError('EMSA_NO_CODE', 'Sign-in response did not contain an authorization code')
      res.once('finish', () => finish(() => resolveCode(parsed)))
      send(res, 200, options.successHtml ?? SUCCESS_HTML)
    } catch (e) {
      res.once('finish', () => finish(() => rejectCode(e)))
      send(res, 400, options.failureHtml ?? FAILURE_HTML)
    }
    settled = true
  }

  const servers = await listenLoopback(handler)
  const port = (servers[0]!.address() as AddressInfo).port
  const redirectUri = `http://localhost:${port}${path}`

  let closed: Promise<void> | undefined
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      let open = servers.length
      for (const server of servers) {
        server.close(() => {
          if (--open === 0) resolve()
        })
        server.closeAllConnections()
      }
    })
    return closed
  }
  const finish = (settle: () => void) => {
    settled = true
    settle()
    void close()
  }
  const onAbort = () =>
    finish(() => rejectCode(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: options.signal?.reason })))
  const timer = setTimeout(
    () => finish(() => rejectCode(new AuthError('ELOGIN_TIMEOUT', 'Timed out waiting for the browser sign-in'))),
    options.timeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS,
  )
  timer.unref?.()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    port,
    redirectUri,
    waitForCode(state: string) {
      if (expectedState !== undefined) throw new Error('waitForCode() may only be called once')
      if (!state) throw new TypeError('state is required')
      expectedState = state
      return result
    },
    close,
  }
}
