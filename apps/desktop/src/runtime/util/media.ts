/**
 * Content-sniffed image and video imports (instance icons, theme backgrounds). File types are
 * decided by magic bytes, never by name, and every file is stored under a content-hash name, so
 * two different `background.png`s can never overwrite each other.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from './errors'

export interface MediaType {
  kind: 'image' | 'video'
  ext: string
  mime: string
}

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end))

/** Identify an image or video from its first bytes (64 are plenty). SVG only when `allowSvg`. */
export function sniffMedia(head: Uint8Array, options: { allowSvg?: boolean } = {}): MediaType | undefined {
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 4) === 'PNG') return { kind: 'image', ext: '.png', mime: 'image/png' }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', ext: '.jpg', mime: 'image/jpeg' }
  if (head.length >= 6 && ascii(head, 0, 4) === 'GIF8') return { kind: 'image', ext: '.gif', mime: 'image/gif' }
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { kind: 'image', ext: '.webp', mime: 'image/webp' }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: 'video', ext: '.webm', mime: 'video/webm' }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'qt  ') return { kind: 'video', ext: '.mov', mime: 'video/quicktime' }
    if (/^(heic|heix|mif1|msf1|avif)/.test(brand)) return undefined
    return { kind: 'video', ext: '.mp4', mime: 'video/mp4' }
  }
  if (options.allowSvg) {
    const textHead = new TextDecoder().decode(head).replace(/^﻿/, '').trimStart().toLowerCase()
    if (textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('<svg'))) return { kind: 'image', ext: '.svg', mime: 'image/svg+xml' }
  }
  return undefined
}

async function readHead(file: string, bytes = 256): Promise<Uint8Array> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

async function sha1OfFile(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ImportedMedia {
  /** Absolute path of the stored copy. */
  path: string
  sha1: string
  type: MediaType
}

export interface ImportMediaOptions {
  kinds: readonly MediaType['kind'][]
  maxBytes: number
  allowSvg?: boolean
  /** File stem; default the SHA-1. */
  stem?: string
}

const unsupported = (message = 'Unsupported media type') => new AppError('EUNSUPPORTED_MEDIA', message)

function check(type: MediaType | undefined, options: ImportMediaOptions): MediaType {
  if (!type || !options.kinds.includes(type.kind)) throw unsupported()
  return type
}

/** Copy (APFS clone where possible) a local media file into `destDir` as `<sha1><ext>`. */
export async function importMediaFile(source: string, destDir: string, options: ImportMediaOptions): Promise<ImportedMedia> {
  const st = await stat(source).catch(() => undefined)
  if (!st?.isFile()) throw new AppError('ENOT_FOUND', `${source} is not a file`)
  if (st.size > options.maxBytes) throw unsupported(`The file is larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB`)
  const type = check(sniffMedia(await readHead(source), options), options)
  const sha1 = await sha1OfFile(source)
  await mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, `${options.stem ?? sha1}${type.ext}`)
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await copyFile(source, tmp, fsConstants.COPYFILE_FICLONE)
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return { path: dest, sha1, type }
}

/** Store in-memory media bytes (a decoded data URL or a download) into `destDir`. */
export async function importMediaBytes(bytes: Uint8Array, destDir: string, options: ImportMediaOptions): Promise<ImportedMedia> {
  if (bytes.length > options.maxBytes) throw unsupported(`The file is larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB`)
  const type = check(sniffMedia(bytes.subarray(0, 256), options), options)
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  await mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, `${options.stem ?? sha1}${type.ext}`)
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return { path: dest, sha1, type }
}

/** Decode a `data:<mime>;base64,<data>` URL. */
export function decodeDataUrl(url: string): Uint8Array {
  const m = /^data:[^;,]*(;[^,]*)?,(.*)$/s.exec(url)
  if (!m) throw new AppError('EINVALID_ARGUMENT', 'Not a data URL')
  const isBase64 = (m[1] ?? '').includes(';base64')
  const data = m[2] ?? ''
  return isBase64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8')
}
