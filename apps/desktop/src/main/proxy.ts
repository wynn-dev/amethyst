/**
 * Electron's own traffic (the Microsoft sign-in window, remote images in the renderer) follows
 * the launcher's proxy setting. The runtime owns the setting and calls `host.setProxy`.
 */
import type { Session } from 'electron'

type ProxyConfig = Parameters<Session['setProxy']>[0]

/** The Chromium proxy config for a `scheme://host:port` proxy, or direct for `null`. */
export function electronProxyConfig(url: string | null): ProxyConfig {
  if (!url) return { mode: 'direct' }
  const u = new URL(url)
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol) || !u.hostname) throw Object.assign(new Error('Unsupported proxy address'), { code: 'EINVALID_ARGUMENT' })
  // Loopback always goes direct in Chromium; `<local>` also keeps plain host names direct.
  return { mode: 'fixed_servers', proxyRules: `${u.protocol}//${u.host}`, proxyBypassRules: '<local>' }
}

/** Apply the proxy to `sessions`, dropping connections made under the previous setting. */
export async function applySessionProxy(sessions: readonly Pick<Session, 'setProxy' | 'closeAllConnections'>[], url: string | null): Promise<void> {
  const config = electronProxyConfig(url)
  await Promise.all(
    sessions.map(async (s) => {
      await s.setProxy(config)
      await s.closeAllConnections()
    }),
  )
}
