/**
 * Navigation policy of the embedded Microsoft sign-in window (pure, so it is unit-tested).
 *
 * The window shows remote pages, so its top-level navigations are limited to the hosts the
 * consumer Microsoft account flow actually uses: the `consumers` authorize endpoint on
 * login.microsoftonline.com hands over to login.live.com, which may show account.live.com
 * (consent, security info, recovery), signup.live.com (new accounts) or account.microsoft.com
 * (family safety), plus the Xbox pages that can appear for a first Xbox profile. Everything else is
 * cancelled. The loopback redirect URI is how the flow ends; it is intercepted, never loaded.
 */

/** Exact hosts the sign-in window may show. */
const EXACT_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'account.live.com',
  'signup.live.com',
  'account.microsoft.com',
  'account.xbox.com',
])

/** Host suffixes the sign-in window may show (`sisu.xboxlive.com` and other Xbox sign-in hosts). */
const HOST_SUFFIXES = ['.xboxlive.com']

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

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

/** True for an https URL on a Microsoft/Live/Xbox sign-in host (default port only). */
export function isSignInHost(target: string): boolean {
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
}

/**
 * What to do with a navigation of the sign-in window:
 * - `redirect`: the flow finished; resolve with this URL (never load it).
 * - `allow`: a sign-in page; let it load.
 * - `external`: an https page elsewhere (privacy statement, help); open it in the browser, if the user clicked it.
 * - `block`: anything else (other schemes, malformed URLs).
 */
export type AuthNavigation = 'redirect' | 'allow' | 'external' | 'block'

export function classifyAuthNavigation(target: string, redirectUri: string): AuthNavigation {
  if (matchesRedirect(target, redirectUri)) return 'redirect'
  if (isSignInHost(target)) return 'allow'
  try {
    if (new URL(target).protocol === 'https:') return 'external'
  } catch {
    // malformed
  }
  return 'block'
}
