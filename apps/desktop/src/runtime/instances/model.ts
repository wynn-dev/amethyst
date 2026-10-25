/**
 * The instance model persisted in `<instance>/.amethyst/instance.json`: lenient parsing (one bad
 * field never discards the file), strict patch validation, naming rules and runtime detection
 * from version JSONs.
 */
import path from 'node:path'
import { sanitizeFileName } from '@amethyst/content'
import type { AutoJoinServer, InstanceOverrides, InstancePatch, InstanceRuntime, InstanceUpstream, LoaderKind } from '@shared/services'
import { isUnsafeEnvKey } from '../util/env'
import { AppError, invalid } from '../util/errors'
import { asRecord, isRecord, readBool, readInt, readOneOf, readString, readStringArray, readStringRecord } from '../util/parse'

export const INSTANCE_SCHEMA_VERSION = 1

/** What `instance.json` holds. */
export interface InstanceConfig {
  id: string
  name: string
  author: string
  description: string
  /** `''`, or a path relative to the instance folder (normally `icon.png`). */
  icon: string
  homepageUrl: string
  runtime: InstanceRuntime
  versionId: string
  overrides: InstanceOverrides
  upstream: InstanceUpstream | null
  createdAt: number
  lastOpenedAt: number
  lastPlayedAt: number
  playTimeMs: number
}

export const LOADERS: readonly LoaderKind[] = ['forge', 'neoforge', 'fabric', 'quilt']
const VERSION_RE = /^[\w.+\- ]{1,64}$/
const MODRINTH_ID = /^[0-9A-Za-z]{8}$/
const MAX_TEXT = 10_000

export function emptyRuntime(): InstanceRuntime {
  return { minecraft: '', forge: '', neoforge: '', fabric: '', quilt: '' }
}

/** The loader set in a runtime (first in forge > neoforge > fabric > quilt order). */
export function loaderOf(runtime: InstanceRuntime): { kind: LoaderKind; version: string } | null {
  for (const kind of LOADERS) if (runtime[kind]) return { kind, version: runtime[kind] }
  return null
}

const readVersion = (v: unknown) => (typeof v === 'string' && (v === '' || VERSION_RE.test(v)) ? v.trim() : undefined)

/** Lenient read: invalid values become `''`; several loaders keep only the first by precedence. */
export function parseRuntime(raw: unknown): InstanceRuntime {
  const o = asRecord(raw)
  const r = emptyRuntime()
  r.minecraft = readVersion(o.minecraft) ?? ''
  let seen = false
  for (const kind of LOADERS) {
    const v = readVersion(o[kind]) ?? ''
    if (v && !seen) {
      r[kind] = v
      seen = true
    }
  }
  return r
}

function readMemory(v: unknown): InstanceOverrides['memory'] {
  if (!isRecord(v)) return undefined
  const mode = readOneOf(v.mode, ['auto', 'manual'] as const)
  const minMB = readInt(v.minMB, 0, 1024 * 1024)
  const maxMB = readInt(v.maxMB, 0, 1024 * 1024)
  if (!mode || minMB === undefined || maxMB === undefined) return undefined
  if (minMB > 0 && maxMB > 0 && minMB > maxMB) return undefined
  return { mode, minMB, maxMB }
}

function readWindow(v: unknown): InstanceOverrides['window'] {
  if (!isRecord(v)) return undefined
  const out: NonNullable<InstanceOverrides['window']> = {}
  for (const [k, raw] of Object.entries(v)) {
    if (k === 'width' || k === 'height') {
      const n = readInt(raw, 1, 16384)
      if (n === undefined) return undefined
      out[k] = n
    } else if (k === 'fullscreen') {
      const b = readBool(raw)
      if (b === undefined) return undefined
      out.fullscreen = b
    } else return undefined
  }
  return out
}

function readServer(v: unknown): AutoJoinServer | undefined {
  if (!isRecord(v)) return undefined
  const host = readString(v.host)?.trim()
  if (!host || host.length > 253 || /\s/.test(host)) return undefined
  const out: AutoJoinServer = { host }
  if (v.port !== undefined) {
    const port = readInt(v.port, 1, 65535)
    if (port === undefined) return undefined
    out.port = port
  }
  if (v.name !== undefined) {
    const name = readString(v.name)
    if (name === undefined || name.length > 128) return undefined
    out.name = name
  }
  return out
}

const argList = (v: unknown) => {
  const a = readStringArray(v)
  return a && a.length <= 256 && a.every((x) => x.length <= 4096) ? a.filter((x) => x !== '') : undefined
}
const command = (v: unknown) => (typeof v === 'string' && v.length <= 4096 && !v.includes('\0') ? v : undefined)

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * An override env. Keys that inject code ({@link isUnsafeEnvKey}: `DYLD_*`, `JAVA_TOOL_OPTIONS`…)
 * make it invalid; `lenient` (reading a file) drops just those keys instead.
 */
function readEnv(v: unknown, lenient: boolean): Record<string, string> | undefined {
  const r = readStringRecord(v)
  if (!r || !Object.keys(r).every((k) => ENV_KEY.test(k))) return undefined
  if (lenient) return Object.fromEntries(Object.entries(r).filter(([k]) => !isUnsafeEnvKey(k)))
  return Object.keys(r).some(isUnsafeEnvKey) ? undefined : r
}

/** Validators for each override; `undefined` means invalid. */
const OVERRIDES: { [K in keyof InstanceOverrides]-?: (v: unknown) => InstanceOverrides[K] | undefined } = {
  javaPath: (v) => (typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0') ? v : undefined),
  memory: readMemory,
  jvmArgs: argList,
  gameArgs: argList,
  env: (v) => readEnv(v, false),
  wrapperCommand: command,
  preLaunchCommand: command,
  window: readWindow,
  autoJoinServer: readServer,
  hideLauncherOnLaunch: readBool,
  showLogWindow: readBool,
  skipAssetVerification: readBool,
}

export function parseOverrides(raw: unknown): InstanceOverrides {
  const o = asRecord(raw)
  const out: Record<string, unknown> = {}
  for (const [k, read] of Object.entries(OVERRIDES)) {
    const v = k === 'env' ? readEnv(o[k], true) : (read as (x: unknown) => unknown)(o[k])
    if (v !== undefined) out[k] = v
  }
  return out as InstanceOverrides
}

/** JVM arguments an imported folder may keep: heap sizes, plain `-XX` flags and simple `-D` switches. */
const SAFE_IMPORTED_JVM_ARG = [/^-X(?:mx|ms|ss|mn)\d+[kKmMgGtT]?$/, /^-XX:[+-][A-Za-z0-9]+$/, /^-XX:[A-Za-z0-9]+=[\w.+-]+$/, /^-D[\w.-]+=(?:true|false|\d+)$/]
/** `-XX:<name>=…` options that run commands or read and write files. */
const UNSAFE_XX_NAME = /error|outofmemory|file|path|flags|command|agent|options|log|dump|dir/i

function isSafeImportedJvmArg(arg: string): boolean {
  if (!SAFE_IMPORTED_JVM_ARG.some((re) => re.test(arg))) return false
  const xx = /^-XX:([A-Za-z0-9]+)=/.exec(arg)
  return !xx || !UNSAFE_XX_NAME.test(xx[1] as string)
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s)

/**
 * Launch overrides of an imported folder (`.amethyst/instance.json` written elsewhere) that are
 * removed on import, because they run code: the pre-launch and wrapper commands, a pinned Java
 * binary, JVM arguments other than heap/GC flags (`-javaagent`, `-XX:OnError`, `@argfiles`…)
 * and code-injecting env keys (already dropped when the file is read). `removed` describes each
 * removed setting for the import review.
 */
export function sanitizeImportedOverrides(overrides: InstanceOverrides, rawEnv?: unknown): { overrides: InstanceOverrides; removed: string[] } {
  const out: InstanceOverrides = { ...overrides }
  const removed: string[] = []
  if (out.preLaunchCommand?.trim()) removed.push(`Pre-launch command: ${clip(out.preLaunchCommand.trim())}`)
  if (out.wrapperCommand?.trim()) removed.push(`Wrapper command: ${clip(out.wrapperCommand.trim())}`)
  if (out.javaPath) removed.push(`Java path: ${clip(out.javaPath)}`)
  delete out.preLaunchCommand
  delete out.wrapperCommand
  delete out.javaPath
  if (out.jvmArgs) {
    const drop = out.jvmArgs.filter((a) => !isSafeImportedJvmArg(a))
    if (drop.length > 0) {
      removed.push(`Java arguments: ${clip(drop.join(' '))}`)
      out.jvmArgs = out.jvmArgs.filter(isSafeImportedJvmArg)
    }
  }
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).filter(([k]) => !isUnsafeEnvKey(k)))
  const unsafeEnv = isRecord(rawEnv) ? Object.keys(rawEnv).filter(isUnsafeEnvKey) : []
  if (unsafeEnv.length > 0) removed.push(`Environment variables: ${clip(unsafeEnv.join(', '))}`)
  return { overrides: out, removed }
}

/** Validate an upstream; invalid ids are dropped. */
export function parseUpstream(raw: unknown): InstanceUpstream | null {
  if (!isRecord(raw)) return null
  const packSha1 = typeof raw.packSha1 === 'string' && /^[0-9a-f]{40}$/i.test(raw.packSha1) ? raw.packSha1.toLowerCase() : undefined
  if (raw.kind === 'modrinth' && typeof raw.projectId === 'string' && MODRINTH_ID.test(raw.projectId) && typeof raw.versionId === 'string' && MODRINTH_ID.test(raw.versionId)) {
    return { kind: 'modrinth', projectId: raw.projectId, versionId: raw.versionId, ...(packSha1 ? { packSha1 } : {}) }
  }
  const pid = readInt(raw.projectId, 1)
  const fid = readInt(raw.fileId, 1)
  if (raw.kind === 'curseforge' && pid !== undefined && fid !== undefined) return { kind: 'curseforge', projectId: pid, fileId: fid, ...(packSha1 ? { packSha1 } : {}) }
  return null
}

const text = (v: unknown, def = '') => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : def)
const time = (v: unknown) => readInt(v, 0) ?? 0

/** Read `instance.json` leniently. `fallback` supplies the id and name when they are missing. */
export function parseInstanceConfig(raw: Record<string, unknown>, fallback: { id: string; name: string }): InstanceConfig {
  const id = typeof raw.id === 'string' && /^[\w-]{6,64}$/.test(raw.id) ? raw.id : fallback.id
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 255) : fallback.name
  const icon = typeof raw.icon === 'string' && isSafeRelative(raw.icon) ? raw.icon : ''
  const homepage = typeof raw.homepageUrl === 'string' && /^https?:\/\//i.test(raw.homepageUrl) ? raw.homepageUrl.slice(0, 2048) : ''
  return {
    id,
    name,
    author: text(raw.author),
    description: text(raw.description),
    icon,
    homepageUrl: homepage,
    runtime: parseRuntime(raw.runtime),
    versionId: readVersion(raw.versionId) ?? '',
    overrides: parseOverrides(raw.overrides),
    upstream: parseUpstream(raw.upstream),
    createdAt: time(raw.createdAt),
    lastOpenedAt: time(raw.lastOpenedAt),
    lastPlayedAt: time(raw.lastPlayedAt),
    playTimeMs: time(raw.playTimeMs),
  }
}

/** A relative path that stays inside its folder (no `..`, not absolute, no NUL). */
export function isSafeRelative(rel: string): boolean {
  if (rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return false
  const norm = path.normalize(rel)
  return !norm.startsWith('..') && !norm.split(path.sep).includes('..')
}

/**
 * Validate a display name: not empty after trimming, no control characters, no leading `.`
 * (hidden folders mark soft-deleted instances), at most 255 UTF-8 bytes. Characters a folder
 * name cannot hold (`/`, `:`) are fine here; {@link folderNameFor} maps them.
 */
export function validateName(name: unknown): string {
  if (typeof name !== 'string') throw invalid('The name must be text')
  const trimmed = name.trim()
  if (!trimmed) throw new AppError('EINVALID_NAME', 'The name cannot be empty')
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new AppError('EINVALID_NAME', 'The name cannot contain control characters')
  if (trimmed.startsWith('.')) throw new AppError('EINVALID_NAME', 'The name cannot start with a dot')
  if (Buffer.byteLength(trimmed) > 255) throw new AppError('EINVALID_NAME', 'The name is too long')
  return trimmed
}

/**
 * Folder names stay this many UTF-8 bytes under the 255-byte limit, so that ` (12)` suffixes,
 * the case-only-rename temporary (`.renaming-xxxxxxxx`) and rescued-world stamps still fit.
 */
const FOLDER_NAME_BYTES = 200

/**
 * The folder name for a display name: clamped to {@link FOLDER_NAME_BYTES}, then the shared
 * {@link sanitizeFileName} rules (`/`, `\`, `:` and control characters become `_`, leading dots
 * go, NFC), then trailing dots and spaces are trimmed.
 */
export function folderNameFor(name: string): string {
  let out = name.normalize('NFC')
  while (Buffer.byteLength(out) > FOLDER_NAME_BYTES) out = [...out].slice(0, -1).join('')
  out = sanitizeFileName(out, '').replace(/[.\s]+$/, '')
  return out || 'Instance'
}

/** `<base>`, then `<base> (2)`, `<base> (3)`… avoiding `taken` (compared case-insensitively). */
export function uniqueDisplayName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.normalize('NFC').toLowerCase()))
  let candidate = base
  for (let n = 2; set.has(candidate.normalize('NFC').toLowerCase()); n++) candidate = `${base} (${n})`
  return candidate
}

/** Placeholder name from the runtime: `1.21.1` or `1.21.1-fabric0.16.5`. */
export function generatedName(runtime: InstanceRuntime): string {
  const loader = loaderOf(runtime)
  return loader ? `${runtime.minecraft}-${loader.kind}${loader.version}` : runtime.minecraft || 'Instance'
}

/** Validate a complete runtime given by the UI. */
export function validateRuntime(input: unknown, base: InstanceRuntime = emptyRuntime()): InstanceRuntime {
  if (!isRecord(input)) throw invalid('runtime must be an object')
  const next = { ...base }
  for (const [k, v] of Object.entries(input)) {
    if (k !== 'minecraft' && !(LOADERS as readonly string[]).includes(k)) throw invalid(`Unknown runtime component ${k}`)
    if (v === undefined) continue
    const value = v === null ? '' : readVersion(v)
    if (value === undefined) throw invalid(`Invalid ${k} version`, { keys: [`runtime.${k}`] })
    next[k as keyof InstanceRuntime] = value
  }
  if (!next.minecraft) throw invalid('A Minecraft version is required', { keys: ['runtime.minecraft'] })
  if (LOADERS.filter((l) => next[l]).length > 1) throw invalid('Only one mod loader can be used at a time', { keys: ['runtime'] })
  return next
}

const EDITABLE = new Set(['name', 'author', 'description', 'homepageUrl', 'runtime', 'versionId', 'overrides', 'upstream'])

/**
 * Validate and apply a patch (excluding the name, which {@link InstanceManager.rename} handles).
 * Unknown keys and edits of timestamps are rejected; a `path` key is ignored.
 */
export function applyInstancePatch(config: InstanceConfig, patch: InstancePatch): InstanceConfig {
  if (!isRecord(patch)) throw invalid('The patch must be an object')
  const next: InstanceConfig = { ...config, overrides: { ...config.overrides } }
  for (const key of Object.keys(patch)) {
    if (key === 'path' || key === 'name') continue
    if (!EDITABLE.has(key)) throw invalid(`${key} cannot be edited`, { keys: [key] })
  }
  const p = patch as Record<string, unknown>
  for (const key of ['author', 'description'] as const) {
    if (p[key] === undefined) continue
    if (p[key] !== null && typeof p[key] !== 'string') throw invalid(`Invalid ${key}`, { keys: [key] })
    next[key] = ((p[key] as string | null) ?? '').slice(0, MAX_TEXT)
  }
  if (p.homepageUrl !== undefined) {
    const v = p.homepageUrl
    if (v !== null && v !== '' && !(typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 2048)) throw invalid('Invalid homepage URL', { keys: ['homepageUrl'] })
    next.homepageUrl = (v as string | null) ?? ''
  }
  let runtimeChanged = false
  if (p.runtime !== undefined) {
    const runtime = validateRuntime(p.runtime, config.runtime)
    runtimeChanged = JSON.stringify(runtime) !== JSON.stringify(config.runtime)
    next.runtime = runtime
  }
  if (p.versionId !== undefined) {
    const v = p.versionId === null ? '' : readVersion(p.versionId)
    if (v === undefined) throw invalid('Invalid version id', { keys: ['versionId'] })
    next.versionId = v
  } else if (runtimeChanged) {
    // A pin chosen for the old runtime no longer applies.
    next.versionId = ''
  }
  if (p.overrides !== undefined) {
    if (!isRecord(p.overrides)) throw invalid('overrides must be an object', { keys: ['overrides'] })
    for (const [k, v] of Object.entries(p.overrides)) {
      const read = (OVERRIDES as Record<string, (x: unknown) => unknown>)[k]
      if (!read) throw invalid(`Unknown override ${k}`, { keys: [`overrides.${k}`] })
      if (v === undefined) continue
      if (v === null) {
        delete (next.overrides as Record<string, unknown>)[k]
        continue
      }
      if (k === 'env' && isRecord(v)) {
        const unsafe = Object.keys(v).filter(isUnsafeEnvKey)
        if (unsafe.length > 0) throw invalid(`${unsafe.join(', ')} cannot be set: it changes how Java or macOS loads code`, { keys: [`overrides.${k}`] })
      }
      const value = read(v)
      if (value === undefined) throw invalid(`Invalid value for ${k}`, { keys: [`overrides.${k}`] })
      ;(next.overrides as Record<string, unknown>)[k] = value
    }
  }
  if (p.upstream !== undefined) {
    if (p.upstream === null) next.upstream = null
    else {
      const up = parseUpstream(p.upstream)
      if (!up) throw invalid('Invalid upstream', { keys: ['upstream'] })
      next.upstream = up
    }
  }
  return next
}

/**
 * Derive runtime requirements from a version JSON's inheritance chain (public version-JSON facts):
 * the Minecraft version is the root of the chain, loaders come from their libraries.
 */
export function detectRuntimeFromVersions(chain: Record<string, unknown>[]): Partial<InstanceRuntime> | null {
  if (chain.length === 0) return null
  const root = chain.at(-1) as Record<string, unknown>
  const minecraft = readString(root.inheritsFrom) ?? readString(root.id) ?? ''
  const out: Partial<InstanceRuntime> = { minecraft }
  const gameArgs: string[] = []
  for (const v of chain) {
    const args = asRecord(v.arguments).game
    if (Array.isArray(args)) for (const a of args) if (typeof a === 'string') gameArgs.push(a)
    const libs = Array.isArray(v.libraries) ? v.libraries : []
    for (const lib of libs) {
      const name = readString(asRecord(lib).name)
      if (!name) continue
      const [group, artifact, version] = name.split(':')
      if (!version) continue
      if (group === 'net.fabricmc' && artifact === 'fabric-loader') out.fabric = version
      else if (group === 'org.quiltmc' && artifact === 'quilt-loader') out.quilt = version
      else if (group === 'net.minecraftforge' && (artifact === 'forge' || artifact === 'fmlloader' || artifact === 'minecraftforge')) {
        let v2 = version
        if (minecraft && v2.startsWith(`${minecraft}-`)) v2 = v2.slice(minecraft.length + 1)
        if (minecraft && v2.endsWith(`-${minecraft}`)) v2 = v2.slice(0, -minecraft.length - 1)
        out.forge = v2
      }
    }
  }
  const neo = gameArgs.indexOf('--fml.neoForgeVersion')
  if (neo >= 0 && gameArgs[neo + 1]) {
    out.neoforge = gameArgs[neo + 1] as string
    delete out.forge
  }
  if (out.quilt) delete out.fabric
  return out
}
