import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

export interface RecordedRequest {
  path: string
  headers: IncomingMessage['headers']
}

/** In-process HTTP server for offline tests. Routes are exact paths. */
export interface TestServer {
  url: string
  requests: RecordedRequest[]
  /** Highest number of requests in flight at the same time. */
  maxInFlight: number
  route(path: string, handler: Handler): void
  /** Requests recorded for one path. */
  hits(path: string): RecordedRequest[]
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>()
  const requests: RecordedRequest[] = []
  let inFlight = 0
  const state = { maxInFlight: 0 }
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    requests.push({ path, headers: req.headers })
    inFlight++
    state.maxInFlight = Math.max(state.maxInFlight, inFlight)
    res.on('close', () => inFlight--)
    const handler = routes.get(path)
    if (!handler) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    Promise.resolve(handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get maxInFlight() {
      return state.maxInFlight
    },
    route: (path, handler) => routes.set(path, handler),
    hits: (path) => requests.filter((r) => r.path === path),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface ServeOptions {
  /** Honour `Range` requests (default true). When false, `Accept-Ranges` is omitted and ranges are ignored. */
  ranges?: boolean
  /** Advertise `Accept-Ranges: bytes` but answer every request with a full 200. */
  lieAboutRanges?: boolean
  etag?: string
  /** Stop after sending this many bytes and keep the connection open (to simulate a stall). */
  stallAfter?: number
  /** Delay before responding, in ms. */
  delayMs?: number
}

/** Serve `data`, honouring `Range` and `If-Range` like a typical CDN. */
export function serveBytes(data: Buffer, options: ServeOptions = {}): Handler {
  const ranges = options.ranges ?? true
  const etag = options.etag ?? `"${createHash('sha1').update(data).digest('hex')}"`
  return async (req, res) => {
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
    res.setHeader('etag', etag)
    if (ranges || options.lieAboutRanges) res.setHeader('accept-ranges', 'bytes')
    let start = 0
    let end = data.length - 1
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const ifRange = req.headers['if-range']
    if (range && ranges && !options.lieAboutRanges && (!ifRange || ifRange === etag)) {
      start = Number(range[1])
      end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
      if (start >= data.length) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${data.length}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`)
    } else {
      res.statusCode = 200
    }
    const body = data.subarray(start, end + 1)
    res.setHeader('content-length', body.length)
    if (options.stallAfter !== undefined && options.stallAfter < body.length) {
      res.write(body.subarray(0, options.stallAfter))
      return
    }
    res.end(body)
  }
}

export function sha(algorithm: 'sha1' | 'sha256' | 'sha512', data: Buffer): string {
  return createHash(algorithm).update(data).digest('hex')
}

/** Deterministic pseudo-random bytes. */
export function bytes(size: number, seed = 1): Buffer {
  const buf = Buffer.allocUnsafe(size)
  let x = seed * 2654435761 || 1
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    buf[i] = x & 0xff
  }
  return buf
}
