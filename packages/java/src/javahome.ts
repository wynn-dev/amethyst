import { normalizeArch } from './release'
import { runProcess } from './process'
import type { JavaArch } from './types'

/** One JVM reported by `/usr/libexec/java_home`. */
export interface JavaHomeEntry {
  /** The JDK home (`.../Contents/Home`). */
  home: string
  version?: string
  arch?: JavaArch
  vendor?: string
  name?: string
  /** `JVMEnabled` from `-X`; absent from `-V` output. */
  enabled?: boolean
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue }

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const lower = e.toLowerCase()
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'amp') return '&'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

/**
 * Parse the XML property list subset used by `java_home -X`: arrays, dicts, keys, strings,
 * integers, reals and booleans. Returns `undefined` for malformed input.
 */
export function parsePlist(xml: string): PlistValue | undefined {
  const body = /<plist[^>]*>([\s\S]*)<\/plist>/.exec(xml)?.[1]
  if (body === undefined) return undefined
  const tokens = body.matchAll(/<(\/?)([a-zA-Z]+)\s*(\/?)>|([^<]+)/g)
  type Frame = { kind: 'array'; value: PlistValue[] } | { kind: 'dict'; value: Record<string, PlistValue>; key?: string }
  const stack: Frame[] = []
  let root: PlistValue | undefined
  let textTag: string | undefined
  let text = ''
  const push = (v: PlistValue): boolean => {
    const top = stack.at(-1)
    if (!top) {
      root = v
      return true
    }
    if (top.kind === 'array') top.value.push(v)
    else {
      if (top.key === undefined) return false
      top.value[top.key] = v
      top.key = undefined
    }
    return true
  }
  for (const t of tokens) {
    const [, close, tag, selfClose, chars] = t
    if (chars !== undefined) {
      if (textTag) text += chars
      continue
    }
    if (!tag) continue
    if (selfClose) {
      if (tag === 'true' || tag === 'false') {
        if (!push(tag === 'true')) return undefined
      } else if (tag === 'string') {
        if (!push('')) return undefined
      } else if (tag === 'array' || tag === 'dict') {
        if (!push(tag === 'array' ? [] : {})) return undefined
      }
      continue
    }
    if (!close) {
      if (tag === 'array') stack.push({ kind: 'array', value: [] })
      else if (tag === 'dict') stack.push({ kind: 'dict', value: {} })
      else {
        textTag = tag
        text = ''
      }
      continue
    }
    if (tag === 'array' || tag === 'dict') {
      const frame = stack.pop()
      if (!frame || frame.kind !== tag) return undefined
      if (!push(frame.value)) return undefined
      continue
    }
    if (tag !== textTag) return undefined
    textTag = undefined
    const value = decodeEntities(text)
    if (tag === 'key') {
      const top = stack.at(-1)
      if (top?.kind !== 'dict') return undefined
      top.key = value
    } else if (tag === 'integer' || tag === 'real') {
      if (!push(Number(value.trim()))) return undefined
    } else if (!push(value)) return undefined
  }
  return stack.length === 0 ? root : undefined
}

/** Parse `java_home -X` output (an XML plist array of dicts with `JVMHomePath` etc.). */
export function parseJavaHomeX(xml: string): JavaHomeEntry[] | undefined {
  const plist = parsePlist(xml)
  if (!Array.isArray(plist)) return undefined
  const out: JavaHomeEntry[] = []
  for (const item of plist) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const home = item.JVMHomePath
    if (typeof home !== 'string' || !home.startsWith('/')) continue
    const str = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : undefined)
    const entry: JavaHomeEntry = { home }
    const version = str('JVMVersion') ?? str('JVMPlatformVersion')
    if (version) entry.version = version
    if (str('JVMArch')) entry.arch = normalizeArch(str('JVMArch'))
    if (str('JVMVendor')) entry.vendor = str('JVMVendor')
    if (str('JVMName')) entry.name = str('JVMName')
    if (typeof item.JVMEnabled === 'boolean') entry.enabled = item.JVMEnabled
    out.push(entry)
  }
  return out
}

/**
 * Parse the human-readable `java_home -V` listing (written to **stderr**). Accepts the current
 * format, `    21.0.2 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.2" /Library/.../Contents/Home`,
 * and the pre-Big Sur one, `    1.8.0_292, x86_64:\t"AdoptOpenJDK 8"\t/Library/.../Contents/Home`.
 * Headers, the trailing default-home line and unparseable lines are skipped.
 */
export function parseJavaHomeV(text: string): JavaHomeEntry[] {
  const out: JavaHomeEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    // Entries are indented; the header and the bare default path printed after them are not.
    if (!/^\s+\S/.test(raw)) continue
    const line = raw.replace(/\s+$/, '')
    const modern = /^\s+(\S+)\s+\(([^)]*)\)\s+"(.*?)"\s+-\s+"(.*)"\s+(\/.*)$/.exec(line)
    if (modern) {
      out.push({ version: modern[1] as string, arch: normalizeArch(modern[2]), vendor: modern[3] as string, name: modern[4] as string, home: modern[5] as string })
      continue
    }
    const legacy = /^\s+([^,\s]+),\s*([\w-]+):\s*"(.*)"\s+(\/.*)$/.exec(line)
    if (legacy) {
      out.push({ version: legacy[1] as string, arch: normalizeArch(legacy[2]), name: legacy[3] as string, home: legacy[4] as string })
      continue
    }
    // Unknown layout: version first, absolute path after the last quote (or the first " /").
    const version = /^\s+([0-9][^\s,]*)/.exec(line)?.[1]
    const lastQuote = line.lastIndexOf('"')
    const tail = lastQuote >= 0 ? line.slice(lastQuote + 1).trim() : line.slice(line.indexOf(' /') + 1).trim()
    if (!version || !tail.startsWith('/')) continue
    const entry: JavaHomeEntry = { version, home: tail }
    const arch = /\((arm64e?|x86_64|i386|aarch64)\)|,\s*(arm64e?|x86_64|i386):/.exec(line)
    if (arch) entry.arch = normalizeArch(arch[1] ?? arch[2])
    out.push(entry)
  }
  return out
}

export interface JavaHomeOptions {
  /** Path of the tool (default `/usr/libexec/java_home`). */
  command?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * List JVMs known to macOS. Uses the structured `-X` plist and falls back to parsing `-V`
 * (stderr) if that fails. "Unable to find any JVMs" and a missing tool both yield `[]`.
 */
export async function listJavaHomes(options: JavaHomeOptions = {}): Promise<JavaHomeEntry[]> {
  const command = options.command ?? '/usr/libexec/java_home'
  const run = (flag: string) => runProcess(command, [flag], { timeoutMs: options.timeoutMs ?? 5000, signal: options.signal, cwd: '/' })
  const x = await run('-X')
  if (x.error) return []
  const parsed = x.code === 0 ? parseJavaHomeX(x.stdout) : undefined
  if (parsed) return parsed
  if (/unable to find any jvms/i.test(x.stderr + x.stdout)) return []
  const v = await run('-V')
  return v.error ? [] : parseJavaHomeV(v.stderr)
}
