/* oxlint-disable no-await-in-loop -- redirects and body chunks are processed sequentially by design */
import type { IncomingHttpHeaders } from 'node:http'
import type { Dispatcher } from 'undici'
import { buildDispatcher, LiveDispatcher, type PoolOptions, type ProxyConfig } from './dispatcher'
import { abortReason, HttpError, NetError, sanitizeUrl } from './errors'
import { DEFAULT_RETRY, parseRetryAfter, type RetryOptions, withRetry } from './retry'

/** Options for {@link createHttpClient}. All timeouts are in milliseconds. */
export interface HttpClientOptions {
  /** App version used in the default User-Agent (default `'0.0.0'`). */
  version?: string
  /** Full User-Agent override. Default: {@link userAgent}(`version`). */
  userAgent?: string
  /** TCP + TLS connect timeout (default 25 000). */
  connectTimeoutMs?: number
  /** Time from request sent until response headers arrive (default 25 000). */
  headersTimeoutMs?: number
  /** Idle time allowed between two body chunks; doubles as a stall detector (default 10 000). */
  bodyTimeoutMs?: number
  /** Max connections per origin, clamped to 1–64 (default 16). */
  connectionsPerHost?: number
  /** Negotiate HTTP/2 through ALPN when the server offers it (default true). */
  allowH2?: boolean
  /** Max redirects followed per request (default 5). */
  maxRedirects?: number
  /** Default retry policy for every request made through this client. */
  retry?: Partial<RetryOptions>
  /** Route requests through this proxy (loopback and `noProxy` hosts go direct). Default: none. */
  proxy?: ProxyConfig | null
  /**
   * Max buffered API reads ({@link HttpClient.json}, {@link HttpClient.text}) in flight at once,
   * clamped to 1–64 (default 16). Streaming requests and downloads are not counted.
   */
  apiConcurrency?: number
}

/** The settings {@link HttpClient.configure} can change while the client is in use. */
export type NetworkOptions = Pick<HttpClientOptions, 'connectionsPerHost' | 'proxy' | 'apiConcurrency'>

/**
 * Request headers that may follow a redirect to another origin. Everything else (credentials,
 * cookies, API keys such as CurseForge's `x-api-key`, custom tokens) is dropped, because the
 * new host must not receive it. Add names per request with {@link RequestOptions.crossOriginHeaders}.
 */
export const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'range',
  'user-agent',
])

/** Per-request options. */
export interface RequestOptions {
  /** Default `GET` (or `POST` when `body`/`json` is given). */
  method?: Dispatcher.HttpMethod
  /** Extra request headers. Names are case-insensitive. */
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** Serialised as the JSON request body, with `content-type: application/json`. */
  json?: unknown
  signal?: AbortSignal
  /**
   * Override the client's retry policy for this request, or disable retries with `false`.
   * `POST` and `PATCH` are not retried unless this is set.
   */
  retry?: Partial<RetryOptions> | false
  /**
   * Extra header names (case-insensitive) that are still sent after a redirect to another
   * origin. By default only {@link CROSS_ORIGIN_SAFE_HEADERS} are; every other header, including
   * `authorization`, `cookie` and API keys, is stripped.
   */
  crossOriginHeaders?: readonly string[]
  /** Called whenever response headers arrive (including redirects and error statuses). */
  onResponse?: (status: number) => void
  /** Called before each retry wait with its length (in addition to the policy's `onRetry`). */
  onRetryWait?: (delayMs: number) => void
}

/** Options for the buffered helpers ({@link HttpClient.json}, {@link HttpClient.text}, {@link HttpClient.bytes}). */
export interface ReadOptions extends RequestOptions {
  /** Max body size accepted, in bytes (default 32 MiB). Larger responses fail with `EBADRESPONSE`. */
  maxBytes?: number
}

/** Options for {@link HttpClient.json}. */
export interface JsonOptions<T> extends ReadOptions {
  /**
   * Validate and narrow the parsed value. Throw to reject it; the error is wrapped in an
   * `EBADRESPONSE` {@link NetError}. Without it the value is returned unchecked, so callers must
   * treat it as untrusted.
   */
  parse?: (value: unknown) => T
}

/** Streaming response body (an undici `BodyReadable`). Consume or `destroy()` it. */
export type ResponseBody = Dispatcher.ResponseData['body']

/** A successful (2xx) response whose body has not been read yet. */
export interface HttpResponse {
  /** Final URL after redirects. */
  url: string
  status: number
  headers: IncomingHttpHeaders
  body: ResponseBody
}

/** Shared HTTP client: one keep-alive undici `Agent`, retries, redirects and typed errors. */
export interface HttpClient {
  /** The resolved User-Agent sent with every request (unless overridden per request). */
  readonly userAgent: string
  /**
   * Send a request and resolve once the response headers arrive. Non-2xx statuses throw an
   * {@link HttpError} after retries (408, 429, 5xx and network errors are retried with backoff,
   * honouring `Retry-After`; other 4xx are not). The caller owns `body` and must consume or destroy it.
   */
  request(url: string, options?: RequestOptions): Promise<HttpResponse>
  /** Request and parse a JSON body. The whole exchange (including reading the body) is retried. */
  json<T = unknown>(url: string, options?: JsonOptions<T>): Promise<T>
  /** Request and decode a UTF-8 body. */
  text(url: string, options?: ReadOptions): Promise<string>
  /** Request and buffer a binary body. */
  bytes(url: string, options?: ReadOptions): Promise<Buffer>
  /**
   * The client's connection pool. It stays the same object when {@link configure} replaces the
   * pools behind it, so it can be installed as the global dispatcher for `fetch`.
   */
  readonly dispatcher: Dispatcher
  /**
   * Apply new network settings (proxy, connection limits) to later requests. Requests already
   * running finish on the old pool. Throws `TypeError` for an unusable proxy URL (nothing changes).
   */
  configure(options: NetworkOptions): void
  /** Close all pooled connections. Further requests fail. */
  close(): Promise<void>
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** The default User-Agent string: `Amethyst/<version> (+https://github.com/wynn-dev/amethyst)`. */
export function userAgent(version: string): string {
  return `Amethyst/${version} (+https://github.com/wynn-dev/amethyst)`
}

/** Abort an unwanted response body without surfacing its `AbortError` as an uncaught stream error. */
export function discardBody(body: ResponseBody): void {
  if (body.destroyed) return
  body.on('error', () => {})
  body.destroy()
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Create an HTTP client with its own connection pool. TLS certificates are always verified. */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  let network: NetworkOptions = { connectionsPerHost: options.connectionsPerHost, proxy: options.proxy ?? null, apiConcurrency: options.apiConcurrency }
  const poolOptions = (): PoolOptions => ({
    connections: clamp(network.connectionsPerHost ?? 16, 1, 64),
    allowH2: options.allowH2 ?? true,
    connectTimeout: options.connectTimeoutMs ?? 25_000,
    headersTimeout: options.headersTimeoutMs ?? 25_000,
    bodyTimeout: options.bodyTimeoutMs ?? 10_000,
  })
  const agent = new LiveDispatcher(buildDispatcher(poolOptions(), network.proxy))
  const api = new Gate(clamp(network.apiConcurrency ?? 16, 1, 64))
  const ua = options.userAgent ?? userAgent(options.version ?? '0.0.0')
  const maxRedirects = options.maxRedirects ?? 5
  const basePolicy: RetryOptions = { ...DEFAULT_RETRY, ...options.retry }

  const policyFor = (o: RequestOptions): RetryOptions => {
    if (o.retry === false) return { ...basePolicy, retries: 0 }
    // Non-idempotent requests could be applied twice, so they only retry when the caller opts in.
    const method = o.method ?? (o.body === undefined && o.json === undefined ? 'GET' : 'POST')
    if ((method === 'POST' || method === 'PATCH') && o.retry === undefined) return { ...basePolicy, retries: 0 }
    const policy = { ...basePolicy, ...o.retry }
    const wait = o.onRetryWait
    if (!wait) return policy
    const onRetry = policy.onRetry
    return {
      ...policy,
      onRetry: (info) => {
        wait(info.delayMs)
        onRetry?.(info)
      },
    }
  }

  async function requestOnce(url: string, o: RequestOptions): Promise<HttpResponse> {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v
    headers['user-agent'] ??= ua
    let body: string | Uint8Array | undefined = o.body
    if (o.json !== undefined) {
      body = JSON.stringify(o.json)
      headers['content-type'] ??= 'application/json'
    }
    let method: Dispatcher.HttpMethod = o.method ?? (body === undefined ? 'GET' : 'POST')
    let current = new URL(url)

    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'https:' && current.protocol !== 'http:') {
        throw new NetError('EBADRESPONSE', `unsupported protocol ${current.protocol}`, sanitizeUrl(current.href))
      }
      const res = await agent.request({
        origin: current.origin,
        path: current.pathname + current.search,
        method,
        headers,
        body: body ?? null,
        signal: o.signal ?? null,
      })
      const status = res.statusCode
      o.onResponse?.(status)

      if (REDIRECT_STATUSES.has(status) && res.headers.location) {
        await res.body.dump().catch(() => {})
        if (hop >= maxRedirects) throw new NetError('EBADRESPONSE', `too many redirects for ${sanitizeUrl(url)}`, sanitizeUrl(url))
        const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location
        const next = new URL(location ?? '', current)
        if (current.protocol === 'https:' && next.protocol !== 'https:') {
          throw new NetError('EBADRESPONSE', `refusing HTTPS to HTTP redirect to ${sanitizeUrl(next.href)}`, sanitizeUrl(url))
        }
        if (next.origin !== current.origin) {
          const keep = new Set((o.crossOriginHeaders ?? []).map((h) => h.toLowerCase()))
          for (const name of Object.keys(headers)) if (!CROSS_ORIGIN_SAFE_HEADERS.has(name) && !keep.has(name)) delete headers[name]
        }
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
          delete headers['content-type']
        }
        current = next
        continue
      }

      if (status < 200 || status > 299) {
        // Drain a little so the connection can be reused; larger bodies close the socket instead.
        await res.body.dump().catch(() => {})
        throw new HttpError(status, current.href, parseRetryAfter(res.headers['retry-after']))
      }
      return { url: current.href, status, headers: res.headers, body: res.body }
    }
  }

  async function request(url: string, o: RequestOptions = {}): Promise<HttpResponse> {
    try {
      return await withRetry(url, policyFor(o), o.signal, () => requestOnce(url, o))
    } catch (e) {
      if (o.signal?.aborted) throw abortReason(o.signal)
      throw e
    }
  }

  async function readAll(url: string, o: ReadOptions): Promise<Buffer> {
    const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES
    try {
      return await withRetry(url, policyFor(o), o.signal, async () => {
        const res = await requestOnce(url, o)
        const declared = Number(res.headers['content-length'])
        if (declared > maxBytes) {
          discardBody(res.body)
          throw new NetError('EBADRESPONSE', `response from ${sanitizeUrl(url)} exceeds ${maxBytes} bytes`, sanitizeUrl(url))
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of res.body as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > maxBytes) {
            discardBody(res.body)
            throw new NetError('EBADRESPONSE', `response from ${sanitizeUrl(url)} exceeds ${maxBytes} bytes`, sanitizeUrl(url))
          }
          chunks.push(chunk)
        }
        return Buffer.concat(chunks, size)
      })
    } catch (e) {
      if (o.signal?.aborted) throw abortReason(o.signal)
      throw e
    }
  }

  return {
    userAgent: ua,
    request,
    async json<T>(url: string, o: JsonOptions<T> = {}): Promise<T> {
      const buf = await api.run(o.signal, () => readAll(url, { ...o, headers: { accept: 'application/json', ...o.headers } }))
      let value: unknown
      try {
        value = JSON.parse(buf.toString('utf8'))
      } catch (e) {
        throw new NetError('EBADRESPONSE', `invalid JSON from ${sanitizeUrl(url)}`, sanitizeUrl(url), { cause: e })
      }
      if (!o.parse) return value as T
      try {
        return o.parse(value)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        throw new NetError('EBADRESPONSE', `unexpected JSON from ${sanitizeUrl(url)}: ${reason}`, sanitizeUrl(url), { cause: e })
      }
    },
    async text(url, o = {}) {
      return (await api.run(o.signal, () => readAll(url, o))).toString('utf8')
    },
    bytes: readAll,
    dispatcher: agent,
    configure(next) {
      const merged: NetworkOptions = { ...network, ...next }
      const pool = poolOptions()
      const rebuild =
        clamp(merged.connectionsPerHost ?? 16, 1, 64) !== pool.connections ||
        (merged.proxy?.url ?? '') !== (network.proxy?.url ?? '') ||
        (merged.proxy?.noProxy ?? '') !== (network.proxy?.noProxy ?? '')
      if (rebuild) {
        const built = buildDispatcher({ ...pool, connections: clamp(merged.connectionsPerHost ?? 16, 1, 64) }, merged.proxy)
        agent.replace(built)
      }
      network = merged
      api.limit = clamp(merged.apiConcurrency ?? 16, 1, 64)
    },
    close: () => agent.close(),
  }
}

/** A counting semaphore whose limit can change at any time. */
class Gate {
  #active = 0
  readonly #queue: (() => void)[] = []
  #limit: number

  constructor(limit: number) {
    this.#limit = limit
  }

  set limit(n: number) {
    this.#limit = n
    this.#pump()
  }

  async run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const i = this.#queue.indexOf(go)
          if (i >= 0) this.#queue.splice(i, 1)
          reject(abortReason(signal as AbortSignal))
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        this.#queue.push(go)
      })
    } else this.#active++
    try {
      return await fn()
    } finally {
      this.#active--
      this.#pump()
    }
  }

  #pump(): void {
    while (this.#active < this.#limit && this.#queue.length > 0) {
      this.#active++
      this.#queue.shift()?.()
    }
  }
}

let defaultClient: HttpClient | undefined

/** The process-wide client used when no `client` option is passed. Created lazily with default options. */
export function getDefaultHttpClient(): HttpClient {
  defaultClient ??= createHttpClient()
  return defaultClient
}

/**
 * Replace the process-wide client (for example at startup, to set the app version in the
 * User-Agent). The previous client is closed once its in-flight requests finish.
 */
export function setDefaultHttpClient(client: HttpClient): void {
  const previous = defaultClient
  defaultClient = client
  if (previous && previous !== client) previous.close().catch(() => {})
}
