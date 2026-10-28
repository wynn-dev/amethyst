/**
 * Connection pools behind {@link createHttpClient}: a direct keep-alive `Agent`, optionally routed
 * through an HTTP(S) or SOCKS5 proxy, wrapped in a {@link LiveDispatcher} so the network settings
 * can change while the app runs. Requests already in flight finish on the pool they started on.
 */
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher, Socks5ProxyAgent } from 'undici'

/** A proxy for every request except loopback and `noProxy` hosts. */
export interface ProxyConfig {
  /** `http://host:port`, `https://host:port` or `socks5://host:port`. */
  url: string
  /**
   * Extra hosts that bypass the proxy, in `NO_PROXY` syntax: comma or space separated host names
   * (`example.com` also matches its subdomains, `*.example.com` only subdomains), optionally with
   * a `:port`, or `*` for everything. Loopback (`localhost`, `127.0.0.0/8`, `::1`) always bypasses.
   */
  noProxy?: string
}

/** Pool settings shared by the direct and proxied connections. */
export interface PoolOptions {
  connections: number
  allowH2: boolean
  connectTimeout: number
  headersTimeout: number
  bodyTimeout: number
}

interface NoProxyEntry {
  host: string
  port: number
  /** `*.example.com`: subdomains only. */
  wildcard: boolean
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/** Parse a `NO_PROXY`-style list. */
export function parseNoProxy(value: string): NoProxyEntry[] {
  const out: NoProxyEntry[] = []
  for (const raw of value.split(/[\s,]+/)) {
    if (!raw) continue
    let host = raw
    let port = 0
    const v6 = /^\[(.+)\](?::(\d+))?$/.exec(raw)
    if (v6) {
      host = v6[1] as string
      port = v6[2] ? Number(v6[2]) : 0
    } else {
      const m = /^([^:]+):(\d+)$/.exec(raw)
      if (m) {
        host = m[1] as string
        port = Number(m[2])
      }
    }
    const wildcard = host.startsWith('*.')
    host = host
      .replace(/^\*?\./, '')
      .replace(/\.$/, '')
      .toLowerCase()
    out.push({ host, port, wildcard })
  }
  return out
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Whether a request to `origin` goes direct rather than through the proxy. */
export function bypassesProxy(origin: string | URL, entries: readonly NoProxyEntry[]): boolean {
  const url = typeof origin === 'string' ? new URL(origin) : origin
  const host = url.hostname
    .replace(/^\[(.+)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase()
  if (isLoopback(host)) return true
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol] || 0
  for (const e of entries) {
    if (e.port && e.port !== port) continue
    if (e.host === '*') return true
    if (!e.wildcard && host === e.host) return true
    if (host.endsWith(`.${e.host}`)) return true
  }
  return false
}

/** A dispatcher made of other dispatchers: implements undici's promise and callback forms of close/destroy. */
abstract class Composite extends Dispatcher {
  protected abstract closeAll(): Promise<void>
  protected abstract destroyAll(err: Error | null): Promise<void>

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    const done = this.closeAll()
    if (!callback) return done
    // undici's callback form of close/destroy.
    // oxlint-disable-next-line promise/no-callback-in-promise
    done.then(callback, callback)
  }

  override destroy(): Promise<void>
  override destroy(err: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(a?: Error | null | (() => void), b?: () => void): Promise<void> | void {
    const callback = typeof a === 'function' ? a : b
    const done = this.destroyAll(typeof a === 'function' ? null : (a ?? null))
    if (!callback) return done
    // undici's callback form of close/destroy.
    // oxlint-disable-next-line promise/no-callback-in-promise
    done.then(callback, callback)
  }
}

/** Routes each request to the proxy or, for bypassed hosts, to the direct pool. */
class ProxyRouter extends Composite {
  readonly #direct: Agent
  readonly #proxy: Dispatcher
  readonly #noProxy: NoProxyEntry[]

  constructor(direct: Agent, proxy: Dispatcher, noProxy: NoProxyEntry[]) {
    super()
    this.#direct = direct
    this.#proxy = proxy
    this.#noProxy = noProxy
    for (const d of [direct, proxy]) forwardEvents(d, this)
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin ?? ''
    const target = bypassesProxy(origin, this.#noProxy) ? this.#direct : this.#proxy
    return target.dispatch(options, handler)
  }

  protected async closeAll(): Promise<void> {
    await Promise.all([this.#direct.close(), this.#proxy.close()])
  }

  protected async destroyAll(err: Error | null): Promise<void> {
    await Promise.all([this.#direct.destroy(err), this.#proxy.destroy(err)])
  }
}

function forwardEvents(from: Dispatcher, to: Dispatcher): void {
  for (const event of ['connect', 'disconnect', 'connectionError', 'drain'] as const) {
    const target = to as unknown as NodeJS.EventEmitter
    ;(from as unknown as NodeJS.EventEmitter).on(event, (...args: unknown[]) => target.emit(event, ...args))
  }
}

/** Build the pool for one configuration. Throws `TypeError` for an unusable proxy URL. */
export function buildDispatcher(pool: PoolOptions, proxy: ProxyConfig | null | undefined): Dispatcher {
  const agentOptions = {
    connections: pool.connections,
    allowH2: pool.allowH2,
    connectTimeout: pool.connectTimeout,
    headersTimeout: pool.headersTimeout,
    bodyTimeout: pool.bodyTimeout,
    keepAliveTimeout: 10_000,
    autoSelectFamily: true,
    // Never configurable: certificate verification stays on for every connection.
    connect: { rejectUnauthorized: true },
  }
  const direct = new Agent(agentOptions)
  if (!proxy?.url) return direct
  const url = new URL(proxy.url)
  let via: Dispatcher
  if (url.protocol === 'socks5:') {
    via = new Socks5ProxyAgent(url, {
      connections: pool.connections,
      connectTimeout: pool.connectTimeout,
      headersTimeout: pool.headersTimeout,
      bodyTimeout: pool.bodyTimeout,
      requestTls: { rejectUnauthorized: true },
    })
  } else if (url.protocol === 'http:' || url.protocol === 'https:') {
    via = new ProxyAgent({ ...agentOptions, uri: url.href, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
  } else {
    void direct.close()
    throw new TypeError(`unsupported proxy protocol ${url.protocol}`)
  }
  return new ProxyRouter(direct, via, parseNoProxy(proxy.noProxy ?? ''))
}

/**
 * A stable dispatcher whose pool can be replaced. The previous pool is closed gracefully, so
 * requests (and downloads) already running on it finish there.
 */
export class LiveDispatcher extends Composite {
  #inner: Dispatcher
  #closed = false

  constructor(inner: Dispatcher) {
    super()
    this.#inner = inner
    forwardEvents(inner, this)
  }

  get current(): Dispatcher {
    return this.#inner
  }

  /** Switch new requests to `next` and close the old pool once its requests finish. */
  replace(next: Dispatcher): void {
    if (this.#closed) {
      void next.close()
      return
    }
    const previous = this.#inner
    this.#inner = next
    forwardEvents(next, this)
    previous.close().catch(() => {})
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.#inner.dispatch(options, handler)
  }

  protected async closeAll(): Promise<void> {
    this.#closed = true
    await this.#inner.close()
  }

  protected async destroyAll(err: Error | null): Promise<void> {
    this.#closed = true
    await this.#inner.destroy(err)
  }
}

/**
 * Make `dispatcher` the process-wide one, so the built-in `fetch` (used by the marketplace,
 * sign-in and telemetry clients) goes through the same proxy and pools.
 */
export function installGlobalDispatcher(dispatcher: Dispatcher): void {
  setGlobalDispatcher(dispatcher)
}
