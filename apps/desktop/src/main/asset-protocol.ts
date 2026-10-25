/**
 * Serving `amethyst-asset:` requests (registered with `protocol.handle` in `main/index.ts`).
 * No Electron imports here, so the whole path, symlink and range handling is unit tested.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { isServable, parseRange, resolveAssetPath } from './asset-path'

const realRoots = new Map<string, Promise<string>>()

function realRoot(dataRoot: string): Promise<string> {
  let p = realRoots.get(dataRoot)
  if (!p) {
    p = realpath(dataRoot).catch(() => dataRoot)
    realRoots.set(dataRoot, p)
  }
  return p
}

const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

/** Answer one asset request: 200/206 with the file, or 400/403/404/416. */
export async function serveAssetRequest(dataRoot: string, url: string, rangeHeader: string | null): Promise<Response> {
  const resolved = resolveAssetPath(dataRoot, url)
  if (!resolved.ok) return empty(resolved.status)
  let real: string
  try {
    real = await realpath(resolved.path)
  } catch {
    return empty(404)
  }
  // A symlink must not lead outside the served folders (or to a non-media file).
  const root = await realRoot(dataRoot)
  if (!isServable(root, real)) return empty(403)
  const st = await stat(real).catch(() => undefined)
  if (!st?.isFile()) return empty(404)

  const headers: Record<string, string> = {
    'content-type': resolved.mime,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    // Only Amethyst's own renderers can reach this scheme. CORS lets `crossOrigin` images (skins
    // drawn into WebGL by the 3D viewer, the 2D head canvas) read the pixels.
    'access-control-allow-origin': '*',
    // Content-hashed names never change; other URLs carry a ?v= version.
    'cache-control': resolved.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  // SVGs are only ever shown through <img>; if one is opened directly, it must not run script.
  if (resolved.mime === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"

  const range = parseRange(rangeHeader, st.size)
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } })
  const stream = range ? createReadStream(real, { start: range.start, end: range.end }) : createReadStream(real)
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${st.size}`
    headers['content-length'] = String(range.end - range.start + 1)
    return new Response(body, { status: 206, headers })
  }
  headers['content-length'] = String(st.size)
  return new Response(body, { status: 200, headers })
}
