import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createZip } from '@amethyst/zip'

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

/** In-process HTTP server for offline tests. Routes are exact paths. */
export interface TestServer {
  url: string
  /** Every request path, in order. */
  requests: string[]
  route(path: string, handler: Handler): void
  /** Serve bytes (or JSON/text) at `path`. */
  file(path: string, body: Buffer | string | object, options?: { delayMs?: number }): void
  hits(path: string): number
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>()
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    requests.push(path)
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
  const self: TestServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    route: (path, handler) => routes.set(path, handler),
    file(path, body, options = {}) {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      routes.set(path, async (req, res) => {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
        res.setHeader('content-length', data.length)
        res.statusCode = 200
        res.end(req.method === 'HEAD' ? undefined : data)
      })
    },
    hits: (path) => requests.filter((p) => p === path).length,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return self
}

export const sha1 = (data: Buffer | string) => createHash('sha1').update(data).digest('hex')
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** Read a fixture as text. */
export function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

/** Read a JSON fixture. */
export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T
}

export function tempDir(prefix = 'amethyst-installer-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Build a zip/jar in memory-backed temp file and return its bytes. */
export async function buildZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const dir = await tempDir('amethyst-zip-')
  const path = join(dir, 'out.zip')
  const zip = createZip(path)
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name)
  await zip.finish()
  return readFileSync(path)
}

/** A tiny jar with a manifest naming `mainClass`. */
export function processorJar(mainClass: string): Promise<Buffer> {
  return buildZip({ 'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nMain-Class: ${mainClass}\r\n\r\n`, 'Main.class': 'not really bytecode' })
}

/** Deterministic bytes. */
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
