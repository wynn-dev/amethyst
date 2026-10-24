/* oxlint-disable no-await-in-loop -- fixtures are written sequentially */
/** Test fixtures: packs are built in-test with `@amethyst/zip`; downloads come from a local server. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createZip } from '@amethyst/zip'

/** Entry contents: text (UTF-8) or raw bytes. */
export type Entries = Record<string, string | Uint8Array>

export const tempDir = () => mkdtemp(path.join(tmpdir(), 'amethyst-modpack-'))

export const sha = (algo: 'sha1' | 'sha512' | 'md5', data: string | Uint8Array) => createHash(algo).update(data).digest('hex')

/** Write a zip with `@amethyst/zip`. */
export async function makeZip(file: string, entries: Entries): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  const w = createZip(file)
  for (const [name, data] of Object.entries(entries)) w.addBuffer(typeof data === 'string' ? Buffer.from(data) : data, name)
  await w.finish()
  return file
}

/**
 * Rewrite every occurrence of `from` with `to` (same byte length) in a zip's raw bytes. The
 * writer refuses unsafe names, so hostile entries are written under a placeholder and patched.
 */
export async function patchZipNames(file: string, from: string, to: string): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error('patch must keep the length')
  const bytes = await readFile(file)
  const a = Buffer.from(from)
  const b = Buffer.from(to)
  for (let i = bytes.indexOf(a); i >= 0; i = bytes.indexOf(a, i + a.length)) b.copy(bytes, i)
  await writeFile(file, bytes)
}

/** Write files under `dir`. */
export async function writeTree(dir: string, entries: Entries): Promise<void> {
  for (const [name, data] of Object.entries(entries)) {
    const p = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, data)
  }
}

export const read = (dir: string, rel: string) => readFile(path.join(dir, ...rel.split('/')), 'utf8')

/** A Modrinth `files[]` entry for `data`, downloadable from `https://cdn.modrinth.com/data/<p>/versions/<v>/<name>`. */
export function mrFile(filePath: string, data: string | Uint8Array, extra: Record<string, unknown> = {}) {
  const name = filePath.split('/').pop() as string
  return {
    path: filePath,
    hashes: { sha1: sha('sha1', data), sha512: sha('sha512', data) },
    downloads: [`https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/${name}`],
    fileSize: Buffer.byteLength(data),
    ...extra,
  }
}

/** Build a `.mrpack`. */
export async function makeMrpack(file: string, index: Record<string, unknown>, entries: Entries = {}, prefix = ''): Promise<string> {
  const full = { formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'Test Pack', files: [], dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }, ...index }
  const all: Entries = { [`${prefix}modrinth.index.json`]: JSON.stringify(full) }
  for (const [k, v] of Object.entries(entries)) all[`${prefix}${k}`] = v
  return makeZip(file, all)
}

/** Build a CurseForge pack zip. */
export async function makeCfZip(file: string, manifest: Record<string, unknown>, entries: Entries = {}, bom = false): Promise<string> {
  const full = {
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'CF Pack',
    version: '2.0.0',
    author: 'someone',
    files: [],
    overrides: 'overrides',
    ...manifest,
  }
  return makeZip(file, { 'manifest.json': `${bom ? '﻿' : ''}${JSON.stringify(full)}`, ...entries })
}

/** Minimal local HTTP server: `serve(path, bytes)`; unknown paths answer 404. Records hits. */
export interface TestServer {
  url: string
  serve(urlPath: string, data: string | Uint8Array): void
  unserve(urlPath: string): void
  hits(urlPath: string): number
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Buffer>()
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0] as string
    hits.set(p, (hits.get(p) ?? 0) + 1)
    const body = routes.get(p)
    if (!body) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('content-length', body.length)
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    serve: (p, data) => routes.set(p, Buffer.from(data)),
    unserve: (p) => routes.delete(p),
    hits: (p) => hits.get(p) ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
