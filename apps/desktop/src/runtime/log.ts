/**
 * Minimal runtime logger: one line per entry on stdout/stderr (inherited in dev, ignored when
 * packaged) and, once {@link setLogFile} is called, appended to `<logs>/runtime.log` (rotated
 * once at 5 MB). Silent under Vitest.
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let file: WriteStream | undefined
const MAX_BYTES = 5 * 1024 * 1024
const quiet = process.env.VITEST !== undefined

export async function setLogFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const st = await stat(filePath).catch(() => undefined)
  if (st && st.size > MAX_BYTES) await rename(filePath, `${filePath}.1`).catch(() => {})
  const stream = createWriteStream(filePath, { flags: 'a' })
  stream.on('error', () => {
    if (file === stream) file = undefined
  })
  file = stream
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (quiet) return
  const tail = extra === undefined ? '' : ` ${extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra)}`
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${tail}\n`
  if (level === 'error' || level === 'warn') process.stderr.write(line)
  else process.stdout.write(line)
  file?.write(line)
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => {
      if (process.env.AMETHYST_DEBUG) write('debug', scope, m, e)
    },
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  }
}

/** Run `fn` and log how long it took under `label`. */
export async function timed<T>(log: Logger, label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    log.info(`${label} in ${(performance.now() - start).toFixed(1)} ms`)
  }
}
