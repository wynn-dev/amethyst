/**
 * Lenient JSON for hand-written metadata files (`fabric.mod.json`, `mcmod.info`,
 * `pack.mcmeta`). Real files contain things strict `JSON.parse` rejects; the game and the mod
 * loaders accept them, so we must too.
 */

/** Result of {@link parseLenientJson}: either a value or the (strict) parse error message. */
export type LenientJsonResult = { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string }

const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }

/** Skip whitespace and comments starting at `i`; return the index of the next significant character. */
function skipInsignificant(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2)
      i = end === -1 ? text.length : end + 1
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      break
    }
  }
  return i
}

/**
 * Rewrite near-JSON into strict JSON. Handles `//` and `/* *\/` comments, trailing commas
 * before `}` / `]`, raw control characters (newlines, tabs) inside strings, single-quoted
 * strings and a leading byte-order mark. Everything else is copied verbatim.
 */
export function repairJson(text: string): string {
  let out = ''
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === '"' || c === "'") {
      const quote = c
      out += '"'
      i++
      while (i < text.length && text[i] !== quote) {
        const s = text[i] as string
        if (s === '\\' && i + 1 < text.length) {
          const next = text[i + 1] as string
          // `\'` is not a JSON escape; inside a single-quoted string it means a plain quote.
          out += next === "'" ? "'" : s + next
          i += 2
          continue
        }
        const code = s.charCodeAt(0)
        if (code < 0x20) out += CONTROL_ESCAPES[s] ?? `\\u${code.toString(16).padStart(4, '0')}`
        else if (s === '"' && quote === "'") out += '\\"'
        else out += s
        i++
      }
      out += '"'
      i++
      continue
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipInsignificant(text, i)
      out += ' '
      continue
    }
    if (c === ',') {
      const next = skipInsignificant(text, i + 1)
      if (text[next] === '}' || text[next] === ']') {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/**
 * Parse JSON strictly first, then retry once after {@link repairJson}. Never throws. When both
 * attempts fail the error of the *strict* attempt is reported, as it points at the real problem.
 */
export function parseLenientJson(text: string): LenientJsonResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return { ok: true, value: JSON.parse(input), repaired: false }
  } catch (e) {
    try {
      return { ok: true, value: JSON.parse(repairJson(input)), repaired: true }
    } catch {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

/** A plain JSON object (not an array or null). */
export type JsonObject = Record<string, unknown>

/** True for plain objects (not arrays or null). */
export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The value as a trimmed, non-empty string, or `undefined`. Numbers are stringified. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/** The value as a finite integer, or `undefined`. Numeric strings are accepted. */
export function int(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined
}

/** Normalise a "string or array of strings" field into an array of non-empty strings. */
export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => s !== undefined)
  const s = str(v)
  return s === undefined ? [] : [s]
}
