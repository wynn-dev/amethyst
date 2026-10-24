import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const FIXTURES = new URL('.', import.meta.url).pathname

/** A fresh temp directory and a cleanup function. */
export async function tempDir(prefix = 'amethyst-java-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export const CPU_ARM64 = 0x0100000c
export const CPU_X86_64 = 0x01000007

/** A thin 64-bit Mach-O header (little-endian), padded to `size` bytes. */
export function thinMachO(cputype: number, cpusubtype = 0, size = 64): Buffer {
  const b = Buffer.alloc(Math.max(size, 32))
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(cputype, 4)
  b.writeUInt32LE(cpusubtype, 8)
  b.writeUInt32LE(2, 12) // MH_EXECUTE
  return b
}

/** A universal binary header with one slice per cputype, each `sliceSize` bytes. */
export function fatMachO(cputypes: readonly number[], sliceSize = 0x1000): Buffer {
  const headerSize = 0x1000
  const b = Buffer.alloc(headerSize + cputypes.length * sliceSize)
  b.writeUInt32BE(0xcafebabe, 0)
  b.writeUInt32BE(cputypes.length, 4)
  cputypes.forEach((cpu, i) => {
    const at = 8 + i * 20
    const offset = headerSize + i * sliceSize
    b.writeUInt32BE(cpu, at)
    b.writeUInt32BE(0, at + 4)
    b.writeUInt32BE(offset, at + 8)
    b.writeUInt32BE(sliceSize, at + 12)
    b.writeUInt32BE(12, at + 16)
    thinMachO(cpu).copy(b, offset)
  })
  return b
}

/** A minimal Java class file header (`CAFEBABE`, minor 0, major 65). */
export function classFile(): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(0xcafebabe, 0)
  b.writeUInt16BE(0, 4)
  b.writeUInt16BE(65, 6)
  return b
}

export const sha1 = (data: string | Uint8Array) => createHash('sha1').update(data).digest('hex')
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Write a file (creating parents) with an optional mode. */
export async function put(path: string, content: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  if (mode !== undefined) await chmod(path, mode)
}

/** A `bin/java` shell script that prints `-XshowSettings:properties` style output to stderr. */
export function fakeJavaScript(props: Record<string, string>, banner = 'openjdk version "21.0.7" 2025-04-15', extra = ''): string {
  const lines = ['Property settings:', ...Object.entries(props).map(([k, v]) => `    ${k} = ${v}`), '', banner]
  return `#!/bin/sh\n${extra}\ncat >&2 <<'EOF'\n${lines.join('\n')}\nEOF\nexit 0\n`
}

// --- tar writer (tests only) ---------------------------------------------------------------

export interface TarSpec {
  name: string
  type?: '0' | '1' | '2' | '5' | 'L' | 'x' | '3'
  content?: string | Uint8Array
  mode?: number
  linkname?: string
  /** Override the stored checksum (corruption tests). */
  badChecksum?: boolean
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(spec: TarSpec, size: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(spec.name.slice(0, 100), 0, 'utf8')
  h.write(octal(spec.mode ?? (spec.type === '5' ? 0o755 : 0o644), 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(size, 12), 124, 'ascii')
  h.write(octal(0, 12), 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(spec.type ?? '0', 156, 'ascii')
  if (spec.linkname) h.write(spec.linkname.slice(0, 100), 157, 'utf8')
  h.write('ustar\u000000', 257, 'latin1')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(octal(spec.badChecksum ? sum + 1 : sum, 7) + ' ', 148, 'ascii')
  return h
}

/** Build an uncompressed tar archive from entry specs. */
export function makeTar(entries: readonly TarSpec[], { terminate = true } = {}): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const body = typeof e.content === 'string' ? Buffer.from(e.content) : Buffer.from(e.content ?? new Uint8Array())
    parts.push(header(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  if (terminate) parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export const makeTarGz = (entries: readonly TarSpec[]) => gzipSync(makeTar(entries))

/** A pax extended header record. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const bytes = Buffer.byteLength(body)
  let len = bytes + 1
  while (String(len).length + bytes !== len) len = String(len).length + bytes
  return `${len}${body}`
}

// --- HTTP server ---------------------------------------------------------------------------

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

export interface TestServer {
  url: string
  hits: Map<string, number>
  route(path: string, handler: Handler | Uint8Array | string | object): void
  close(): Promise<void>
}

/** In-process HTTP server; routes are exact paths, bodies may be bytes, text or JSON. */
export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>()
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    hits.set(path, (hits.get(path) ?? 0) + 1)
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
    hits,
    route(path, body) {
      if (typeof body === 'function') routes.set(path, body as Handler)
      else {
        const bytes = typeof body === 'string' ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body))
        routes.set(path, (_req, res) => {
          res.setHeader('content-length', bytes.length)
          res.end(bytes)
        })
      }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
