/**
 * Converts errors into PostHog's `$exception_list` format with scrubbed messages and stack frames.
 * We build the frames ourselves instead of using posthog-node's `captureException`, which reads
 * source files from disk to attach code context and keeps absolute paths.
 */
import type { Scrubber } from './scrub'

export interface StackFrame {
  platform: 'node:javascript' | 'web:javascript'
  filename: string
  function: string
  lineno?: number
  colno?: number
  in_app: boolean
}

export interface ExceptionEntry {
  type: string
  value: string
  mechanism: { type: string; handled: boolean; synthetic: boolean; exception_id: number; parent_id?: number; source?: string }
  stacktrace?: { type: 'raw'; frames: StackFrame[] }
}

/** A structured-cloneable error, as sent over RPC from other processes. */
export interface SerializedError {
  name: string
  message: string
  stack?: string
}

const MAX_FRAMES = 50
const MAX_CAUSES = 3
const MAX_MESSAGE = 1_000

/** Normalise anything thrown into a plain `{ name, message, stack }` object. */
export function serializeError(error: unknown): SerializedError & { cause?: unknown } {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message, stack: error.stack, cause: error.cause }
  }
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : safeString(error),
      stack: typeof e.stack === 'string' ? e.stack : undefined,
      cause: e.cause,
    }
  }
  return { name: 'Error', message: safeString(error) }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Strip the install location so frames read `app:///out/main/index.js` regardless of where Amethyst lives. */
function normaliseFilename(filename: string): string {
  let f = filename.replace(/^file:\/\//, '')
  const asar = f.indexOf('/app.asar/')
  if (asar !== -1) return `app:///${f.slice(asar + '/app.asar/'.length)}`
  const out = /\/(out\/(?:main|preload|renderer)\/.*)$/.exec(f)
  if (out) return `app:///${out[1]}`
  return f
}

const FRAME_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/

export function parseStack(stack: string, scrub: Scrubber, platform: StackFrame['platform']): StackFrame[] {
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    if (line.length > 1024) continue
    const m = FRAME_RE.exec(line)
    if (!m) continue
    const filename = scrub(normaliseFilename(m[2]!))
    frames.push({
      platform,
      filename,
      function: m[1] ? scrub(m[1]) : '?',
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: filename.startsWith('app:///') && !filename.includes('/node_modules/'),
    })
    if (frames.length >= MAX_FRAMES) break
  }
  // PostHog (like Sentry) expects the outermost frame first and the crashing frame last.
  return frames.toReversed()
}

export function buildExceptionList(
  error: unknown,
  scrub: Scrubber,
  options: { handled: boolean; platform: StackFrame['platform'] },
): ExceptionEntry[] {
  const list: ExceptionEntry[] = []
  let current: unknown = error
  for (let depth = 0; current != null && depth <= MAX_CAUSES; depth++) {
    const e = serializeError(current)
    const id = list.length
    let value = scrub(e.message)
    if (value.length > MAX_MESSAGE) value = value.slice(0, MAX_MESSAGE) + '…'
    const entry: ExceptionEntry = {
      type: scrub(e.name).slice(0, 100),
      value,
      mechanism:
        id === 0
          ? { type: 'generic', handled: options.handled, synthetic: false, exception_id: id }
          : { type: 'chained', handled: options.handled, synthetic: false, exception_id: id, parent_id: id - 1, source: 'cause' },
    }
    const frames = e.stack ? parseStack(e.stack, scrub, options.platform) : []
    if (frames.length) entry.stacktrace = { type: 'raw', frames }
    list.push(entry)
    current = e.cause
  }
  return list
}
