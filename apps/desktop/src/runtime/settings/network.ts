/**
 * The network settings (`settings.network`) applied to the shared HTTP client: proxy, per-host
 * connection limit and API concurrency. They apply live: a change rebuilds the client's pools
 * (requests already running finish on the old ones) and updates Electron's own proxy (the
 * sign-in window).
 */
import type { NetworkOptions } from '@amethyst/net'
import type { Settings } from '@shared/services'
import { logger } from '../log'
import { errorMessage } from '../util/errors'

const log = logger('network')

/**
 * The client options for these settings. With the proxy on but no address, `HTTPS_PROXY` /
 * `HTTP_PROXY` from the environment are used (settings spec); `NO_PROXY` is honoured either way.
 */
export function networkOptions(s: Settings, env: NodeJS.ProcessEnv = process.env): NetworkOptions {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || ''
  const url = s.network.proxyEnabled ? s.network.proxyUrl || fromEnv : ''
  const noProxy = env.NO_PROXY || env.no_proxy || ''
  return {
    proxy: url ? { url, ...(noProxy ? { noProxy } : {}) } : null,
    connectionsPerHost: s.network.maxConnectionsPerHost,
    apiConcurrency: s.network.maxApiConnections,
  }
}

interface SettingsSource {
  readonly value: Settings
  onChange(listener: (keys: string[], settings: Settings) => void): () => void
}

/**
 * Apply the network settings to `client` now and after every change. `setElectronProxy` mirrors
 * the proxy into Electron's sessions (they start direct). Returns the unsubscribe function.
 */
export function bindNetworkSettings(
  store: SettingsSource,
  client: { configure(options: NetworkOptions): void },
  setElectronProxy?: (url: string | null) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  let electronProxy: string | null = null
  const apply = (s: Settings) => {
    const options = networkOptions(s, env)
    try {
      client.configure(options)
    } catch (e) {
      // An unusable proxy address (the schema already rejects most): keep the previous setup.
      log.warn(`cannot use the proxy ${options.proxy?.url ?? ''}: ${errorMessage(e)}`)
      return
    }
    const proxy = options.proxy?.url ?? null
    if (setElectronProxy && proxy !== electronProxy) {
      electronProxy = proxy
      setElectronProxy(proxy).catch((e: unknown) => log.warn(`cannot set the app proxy: ${errorMessage(e)}`))
    }
  }
  apply(store.value)
  return store.onChange((keys, s) => {
    if (keys.some((k) => k.startsWith('network.'))) apply(s)
  })
}
