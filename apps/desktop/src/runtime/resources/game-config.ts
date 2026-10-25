/* oxlint-disable no-await-in-loop -- config files are tried in priority order */
/**
 * The game-side switches for packs: `options.txt` (enabled resource packs) and the shader mod's
 * config (`config/iris.properties`, `config/oculus.properties` or OptiFine's
 * `optionsshaders.txt`). Edits keep every other line verbatim and are written atomically.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { disableResourcePack, enableResourcePack, orderResourcePacks, readOptionsFile, writeOptionsFile } from '@amethyst/content'

export type ShaderLoader = 'iris' | 'oculus' | 'optifine'

const SHADER_FILES: Record<ShaderLoader, string> = {
  iris: 'config/iris.properties',
  oculus: 'config/oculus.properties',
  optifine: 'optionsshaders.txt',
}

/** Decode `\uXXXX` escapes of a `.properties` value. */
function unescape(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))).replace(/\\(.)/g, '$1')
}

/** Escape non-ASCII as `\uXXXX` (the `.properties` convention). */
function escape(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (ch.length > 1) for (const unit of ch.split('')) out += `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
    else out += code > 0x7e || code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch
  }
  return out
}

/** Read one key of a `.properties` text (split on the first `=` only). */
export function getProperty(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#!]/.test(line)) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() === key) return unescape(line.slice(eq + 1).trim())
  }
  return undefined
}

/** Set keys in a `.properties` text, keeping every other line and comment verbatim. */
export function setProperties(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const pending = new Map(Object.entries(values))
  const out = lines.map((line) => {
    if (/^\s*[#!]/.test(line)) return line
    const eq = line.indexOf('=')
    if (eq < 0) return line
    const key = line.slice(0, eq).trim()
    if (!pending.has(key)) return line
    const v = pending.get(key) as string
    pending.delete(key)
    return `${key}=${escape(v)}`
  })
  for (const [k, v] of pending) out.push(`${k}=${escape(v)}`)
  return `${out.join(eol)}${eol}`
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/** The active shader pack's file name, from whichever shader mod config exists. `null`: shaders off. */
export async function readActiveShaderPack(instanceDir: string): Promise<string | null> {
  for (const loader of ['iris', 'oculus', 'optifine'] as const) {
    const text = await readFile(path.join(instanceDir, SHADER_FILES[loader]), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const pack = getProperty(text, 'shaderPack')
    if (loader !== 'optifine' && getProperty(text, 'enableShaders') === 'false') return null
    return pack && pack !== 'OFF' && pack !== '(internal)' ? pack : null
  }
  return null
}

/** Select (or with `null`, turn off) the shader pack for the given shader mod. */
export async function writeActiveShaderPack(instanceDir: string, loader: ShaderLoader, pack: string | null): Promise<void> {
  const file = path.join(instanceDir, SHADER_FILES[loader])
  const text = await readFile(file, 'utf8').catch(() => '')
  const values: Record<string, string> = loader === 'optifine' ? { shaderPack: pack ?? 'OFF' } : { shaderPack: pack ?? '', enableShaders: pack ? 'true' : 'false' }
  await writeAtomic(file, setProperties(text, values))
}

/** The shader mod among enabled mod ids, if any. */
export function shaderLoaderFor(modIds: Iterable<string>): ShaderLoader | null {
  const ids = new Set([...modIds].map((id) => id.toLowerCase()))
  if (ids.has('iris')) return 'iris'
  if (ids.has('oculus')) return 'oculus'
  if (ids.has('optifine') || ids.has('optifabric')) return 'optifine'
  return null
}

/** The `resourcePacks` list of `options.txt` (bottom-to-top priority). */
export async function readEnabledPacks(instanceDir: string): Promise<string[]> {
  return (await readOptionsFile(path.join(instanceDir, 'options.txt')).catch(() => undefined))?.resourcePacks ?? []
}

/** Enable or disable resource packs by their `file/<name>` ids, keeping every other option. */
export async function setPacksEnabled(instanceDir: string, ids: string[], enabled: boolean): Promise<void> {
  const file = path.join(instanceDir, 'options.txt')
  const options = await readOptionsFile(file)
  let list = options.resourcePacks
  for (const id of ids) list = enabled ? enableResourcePack(list, id) : disableResourcePack(list, id)
  options.resourcePacks = list
  await writeOptionsFile(file, options)
}

/**
 * Set the enabled file packs and their order (`topFirst`: highest priority first), keeping
 * built-in and mod packs where they are. `vanilla` is added at the bottom of an empty list, as the
 * game does.
 */
export async function setPackOrder(instanceDir: string, topFirst: string[]): Promise<void> {
  const file = path.join(instanceDir, 'options.txt')
  const options = await readOptionsFile(file)
  let list = orderResourcePacks(options.resourcePacks, topFirst)
  if (topFirst.length > 0 && list.length === topFirst.length) list = ['vanilla', ...list]
  options.resourcePacks = list
  await writeOptionsFile(file, options)
}
