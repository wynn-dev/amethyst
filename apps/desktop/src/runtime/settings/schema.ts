/**
 * The settings schema, defined once: every default and every validator lives here, and both
 * loading (lenient: a bad field falls back to its default) and patching (strict: a bad value
 * rejects the whole patch) are derived from it.
 */
import path from 'node:path'
import type { Settings } from '@shared/services'
import { isUnsafeEnvKey } from '../util/env'
import { isRecord, readBool, readColor, readInt, readOneOf, readStringArray, readStringRecord } from '../util/parse'

interface Leaf<T> {
  leaf: true
  def: T
  read: (v: unknown) => T | undefined
}

/** A leaf validator per value, or a nested spec per object. Keys must match `T` exactly. */
type Spec<T> = { [K in keyof T]-?: Leaf<T[K]> | (T[K] extends object ? Spec<T[K]> : never) }

const leaf = <T>(def: T, read: (v: unknown) => T | undefined): Leaf<T> => ({ leaf: true, def, read })
const bool = (def: boolean) => leaf(def, readBool)
const int = (def: number, min: number, max: number) => leaf(def, (v) => readInt(v, min, max))
const oneOf = <T extends string>(def: T, values: readonly T[]) => leaf<T>(def, (v) => readOneOf(v, values))
const text = (def: string, max = 4096) => leaf(def, (v) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : undefined))
const args = () => leaf<string[]>([], (v) => {
  const a = readStringArray(v)
  return a && a.length <= 256 && a.every((x) => x.length <= 4096 && !x.includes('\0')) ? a.filter((x) => x !== '') : undefined
})
const absolutePathOrEmpty = (def: string) => leaf(def, (v) => (typeof v === 'string' && (v === '' || (path.isAbsolute(v) && !v.includes('\0'))) ? v : undefined))
const MEDIA_FILE = /^theme-media\/[0-9a-f]{40}\.(png|jpe?g|gif|webp|mp4|m4v|webm|mov)$/

const SPEC: Spec<Settings> = {
  general: {
    developerMode: bool(false),
    streamerMode: bool(false),
    commandPaletteShortcut: text('', 64),
  },
  appearance: {
    theme: oneOf('system', ['light', 'dark', 'system']),
    accentColor: leaf('#9b5de5', readColor),
    background: {
      kind: oneOf('none', ['none', 'image', 'video']),
      file: leaf<string | null>(null, (v) => (v === null || (typeof v === 'string' && MEDIA_FILE.test(v)) ? v : undefined)),
      fit: oneOf('cover', ['cover', 'contain']),
      blur: int(0, 0, 30),
      overlay: bool(true),
    },
    blur: { card: int(20, 0, 30), sidebar: int(4, 0, 30) },
    vibrancy: bool(true),
  },
  game: {
    java: {
      policy: oneOf('auto', ['auto', 'prefer-installed', 'custom']),
      path: absolutePathOrEmpty(''),
    },
    memory: {
      mode: oneOf('unassigned', ['unassigned', 'auto', 'manual']),
      minMB: int(0, 0, 1024 * 1024),
      maxMB: int(0, 0, 1024 * 1024),
    },
    jvmArgs: args(),
    gameArgs: args(),
    env: leaf<Record<string, string>>({}, (v) => {
      const r = readStringRecord(v)
      // Code-injecting keys (DYLD_*, JAVA_TOOL_OPTIONS…) are never accepted (util/env.ts).
      return r && Object.keys(r).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !isUnsafeEnvKey(k)) ? r : undefined
    }),
    wrapperCommand: text(''),
    preLaunchCommand: text(''),
    resolution: { width: int(0, 0, 16384), height: int(0, 0, 16384), fullscreen: bool(false) },
    skipVerification: bool(false),
    hideLauncherWhileRunning: bool(true),
    openLogOnStart: bool(false),
    replaceArm64Natives: oneOf('legacy-only', ['legacy-only', 'all', 'off']),
  },
  network: {
    proxyEnabled: bool(false),
    proxyUrl: leaf('', (v) => {
      if (typeof v !== 'string') return undefined
      if (v === '') return v
      try {
        const u = new URL(v.includes('://') ? v : `http://${v}`)
        return ['http:', 'https:', 'socks5:'].includes(u.protocol) && u.hostname ? `${u.protocol}//${u.host}` : undefined
      } catch {
        return undefined
      }
    }),
    maxConnectionsPerHost: int(16, 1, 64),
    maxApiConnections: int(8, 1, 32),
  },
  updates: { autoDownload: bool(false), installOnQuit: bool(false), includePrereleases: bool(false) },
  privacy: { usageData: bool(false), crashReports: bool(false), prompted: bool(false) },
  backups: { automatic: bool(true), keep: int(5, 1, 100) },
}

export const SETTINGS_VERSION = 1

type AnySpec = { [key: string]: Leaf<unknown> | AnySpec }
const isLeaf = (s: Leaf<unknown> | AnySpec): s is Leaf<unknown> => (s as Leaf<unknown>).leaf === true

const clone = <T>(v: T): T => structuredClone(v)

function defaultsOf(spec: AnySpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(spec)) out[k] = isLeaf(s) ? clone(s.def) : defaultsOf(s)
  return out
}

export function defaultSettings(): Settings {
  return defaultsOf(SPEC as unknown as AnySpec) as unknown as Settings
}

function parseWith(spec: AnySpec, raw: unknown): Record<string, unknown> {
  const src = isRecord(raw) ? raw : {}
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(spec)) {
    if (isLeaf(s)) {
      const v = s.read(src[k])
      out[k] = v === undefined ? clone(s.def) : v
    } else out[k] = parseWith(s, src[k])
  }
  return out
}

/** Lenient load: each invalid or missing field falls back to its default; unknown keys are dropped. */
export function parseSettings(raw: unknown): Settings {
  const s = parseWith(SPEC as unknown as AnySpec, raw) as unknown as Settings
  // Cross-field rule: a manual minimum above the maximum is not usable; drop the minimum.
  if (s.game.memory.minMB > 0 && s.game.memory.maxMB > 0 && s.game.memory.minMB > s.game.memory.maxMB) s.game.memory.minMB = 0
  if (s.appearance.background.file === null && s.appearance.background.kind !== 'none') s.appearance.background.kind = 'none'
  return s
}

export interface PatchResult {
  next: Settings
  /** Dotted keys of the leaves whose value changed. */
  changed: string[]
  /** Dotted keys that were unknown or invalid. Non-empty means the patch must be rejected. */
  invalid: string[]
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function applyWith(spec: AnySpec, current: Record<string, unknown>, patch: unknown, prefix: string, out: PatchResult): Record<string, unknown> {
  const next = { ...current }
  if (!isRecord(patch)) {
    out.invalid.push(prefix || '(root)')
    return next
  }
  for (const [k, value] of Object.entries(patch)) {
    const key = prefix ? `${prefix}.${k}` : k
    const s = Object.hasOwn(spec, k) ? spec[k] : undefined
    if (!s) {
      out.invalid.push(key)
      continue
    }
    if (value === undefined) continue
    if (isLeaf(s)) {
      const v = value === null ? clone(s.def) : s.read(value)
      if (v === undefined) {
        out.invalid.push(key)
        continue
      }
      if (!equal(v, current[k])) out.changed.push(key)
      next[k] = v
    } else if (value === null) {
      const def = defaultsOf(s)
      for (const leafKey of diffKeys(s, current[k] as Record<string, unknown>, def, key)) out.changed.push(leafKey)
      next[k] = def
    } else {
      next[k] = applyWith(s, current[k] as Record<string, unknown>, value, key, out)
    }
  }
  return next
}

function diffKeys(spec: AnySpec, a: Record<string, unknown>, b: Record<string, unknown>, prefix: string): string[] {
  const out: string[] = []
  for (const [k, s] of Object.entries(spec)) {
    const key = `${prefix}.${k}`
    if (isLeaf(s)) {
      if (!equal(a?.[k], b?.[k])) out.push(key)
    } else out.push(...diffKeys(s, a?.[k] as Record<string, unknown>, b?.[k] as Record<string, unknown>, key))
  }
  return out
}

/**
 * Validate and apply a deep patch. `null` resets a key (or subtree) to its default. Returns the
 * new settings plus the changed and the invalid keys; callers must reject when `invalid` is
 * non-empty. Cross-field rules (manual memory min ≤ max) are checked on the result.
 */
export function applySettingsPatch(current: Settings, patch: unknown): PatchResult {
  const out: PatchResult = { next: current, changed: [], invalid: [] }
  const next = applyWith(SPEC as unknown as AnySpec, current as unknown as Record<string, unknown>, patch, '', out) as unknown as Settings
  const m = next.game.memory
  if (m.minMB > 0 && m.maxMB > 0 && m.minMB > m.maxMB) out.invalid.push('game.memory.minMB')
  const bg = next.appearance.background
  if (bg.kind !== 'none' && bg.file === null) out.invalid.push('appearance.background.kind')
  out.next = next
  return out
}

/** All dotted leaf keys that differ between two settings objects. */
export function changedKeys(a: Settings, b: Settings): string[] {
  return diffKeys(SPEC as unknown as AnySpec, a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, '').map((k) => k.slice(1))
}

/** Build a sparse patch object holding only `keys` (dotted) with their values from `settings`. */
export function sparsePatch(settings: Settings, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const parts = key.split('.')
    let src: unknown = settings
    let dst = out
    parts.forEach((p, i) => {
      src = (src as Record<string, unknown>)[p]
      if (i === parts.length - 1) dst[p] = clone(src)
      else dst = (dst[p] ??= {}) as Record<string, unknown>
    })
  }
  return out
}
