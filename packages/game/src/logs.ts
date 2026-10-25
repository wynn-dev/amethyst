/**
 * Parsing the game's console output into structured log events.
 *
 * Mojang's log4j configs (`client-1.7.xml`, `client-1.12.xml`, `client-1.21.2.xml`) switch the
 * console to an XML layout:
 *
 * ```xml
 * <log4j:Event logger="net.minecraft.client.Minecraft" timestamp="1792869037534" level="INFO" thread="main">
 *   <log4j:Message><![CDATA[Setting user: Steve]]></log4j:Message>
 *   <log4j:Throwable><![CDATA[java.lang.RuntimeException: boom ...]]></log4j:Throwable>
 * </log4j:Event>
 * ```
 *
 * (`]]>` inside a message is written as `]]>]]&gt;<![CDATA[`.) Loaders that replace the config
 * (modern Forge, NeoForge) and the JVM itself print plain lines, which are parsed with the common
 * `[HH:mm:ss] [thread/LEVEL] [logger]: message` patterns or passed through as raw text.
 * Input is decoded as UTF-8 across chunk boundaries and handled line by line.
 */

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export interface LogEvent {
  /** Epoch milliseconds. */
  time: number
  level: LogLevel
  thread?: string
  logger?: string
  message: string
  /** Stack trace attached to the event (XML layout only). */
  throwable?: string
  stream: 'stdout' | 'stderr'
  /** `xml` for log4j events, `plain` for parsed or raw text lines. */
  format: 'xml' | 'plain'
}

const MAX_XML_EVENT = 1 << 20
/** Longest unterminated line kept in memory; longer runs without a newline are emitted in pieces. */
export const MAX_PARTIAL_LINE = 64 * 1024

const LEVELS: Record<string, LogLevel> = {
  TRACE: 'TRACE',
  FINEST: 'TRACE',
  FINER: 'TRACE',
  DEBUG: 'DEBUG',
  FINE: 'DEBUG',
  INFO: 'INFO',
  CONFIG: 'INFO',
  WARN: 'WARN',
  WARNING: 'WARN',
  ERROR: 'ERROR',
  SEVERE: 'ERROR',
  FATAL: 'FATAL',
}

function toLevel(s: string | undefined, fallback: LogLevel): LogLevel {
  return (s && LEVELS[s.toUpperCase()]) || fallback
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? whole
  })
}

/** Text content of an element body: CDATA sections verbatim, everything else entity-decoded. */
function textContent(body: string): string {
  let out = ''
  let i = 0
  while (i < body.length) {
    const start = body.indexOf('<![CDATA[', i)
    if (start === -1) {
      out += decodeEntities(body.slice(i))
      break
    }
    out += decodeEntities(body.slice(i, start))
    const end = body.indexOf(']]>', start + 9)
    if (end === -1) {
      out += body.slice(start + 9)
      break
    }
    out += body.slice(start + 9, end)
    i = end + 3
  }
  return out
}

function element(xml: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const open = xml.indexOf(`<${name}`)
    if (open === -1) continue
    const gt = xml.indexOf('>', open)
    if (gt === -1) continue
    if (xml[gt - 1] === '/') return ''
    const close = xml.indexOf(`</${name}>`, gt)
    if (close === -1) continue
    return textContent(xml.slice(gt + 1, close))
  }
  return undefined
}

/** Parse one complete `<log4j:Event>` (or log4j 2 `<Event>`) element. */
export function parseXmlEvent(xml: string, stream: LogEvent['stream'] = 'stdout'): LogEvent | undefined {
  const head = /<(?:log4j:)?Event\b([^>]*)>/.exec(xml)
  if (!head) return undefined
  const attrs: Record<string, string> = {}
  for (const m of (head[1] as string).matchAll(/([\w:]+)="([^"]*)"/g)) attrs[m[1] as string] = decodeEntities(m[2] as string)
  let time = Number(attrs.timestamp ?? attrs.timeMillis)
  if (!Number.isFinite(time)) {
    const instant = /<Instant\b[^>]*epochSecond="(\d+)"[^>]*?(?:nanoOfSecond="(\d+)")?/.exec(xml)
    time = instant ? Number(instant[1]) * 1000 + Math.floor(Number(instant[2] ?? 0) / 1e6) : Date.now()
  }
  const message = element(xml, ['log4j:Message', 'Message']) ?? ''
  const throwable = element(xml, ['log4j:Throwable', 'Thrown'])
  const event: LogEvent = { time, level: toLevel(attrs.level, 'INFO'), message, stream, format: 'xml' }
  const thread = attrs.thread
  const logger = attrs.logger ?? attrs.loggerName
  if (thread) event.thread = thread
  if (logger) event.logger = logger
  if (throwable) event.throwable = throwable.replace(/\n$/, '')
  return event
}

// [12:34:56] [Render thread/INFO]: msg
// [12:34:56] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: msg   (Forge)
// [12:34:56] [main/INFO] (FabricLoader/GameProvider) msg                   (Fabric)
const PLAIN = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\] \[([^\]]*?)\/([A-Za-z]+)\](?: \[([^\]]+)\]| \(([^)]+)\))?:? ?(.*)$/
// 2013-09-19 18:05:23 [INFO] msg   (1.6 and older)
const OLD = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[([A-Za-z]+)\] (?:\[([^\]]+)\] )?(.*)$/
const CONTINUATION = /^(\s|at |Caused by:|\.\.\. \d+ more)/

function todayAt(h: number, m: number, s: number, ms: number, now: number): number {
  const d = new Date(now)
  d.setHours(h, m, s, ms)
  let t = d.getTime()
  // A time "in the future" was logged before midnight.
  if (t > now + 60_000) t -= 86_400_000
  return t
}

/** Parse a plain console line. Lines without a recognised header get `fallbackLevel`. */
export function parsePlainLine(line: string, stream: LogEvent['stream'] = 'stdout', fallbackLevel: LogLevel = stream === 'stderr' ? 'WARN' : 'INFO', now = Date.now()): LogEvent {
  const m = PLAIN.exec(line)
  if (m) {
    const event: LogEvent = {
      time: todayAt(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), now),
      level: toLevel(m[6], fallbackLevel),
      thread: m[5] as string,
      message: m[9] as string,
      stream,
      format: 'plain',
    }
    const logger = m[7] ?? m[8]
    if (logger) event.logger = logger.split('/')[0] as string
    return event
  }
  const o = OLD.exec(line)
  if (o) {
    const t = Date.parse(`${o[1]}T${o[2]}`)
    const event: LogEvent = { time: Number.isFinite(t) ? t : now, level: toLevel(o[3], fallbackLevel), message: o[5] as string, stream, format: 'plain' }
    if (o[4]) event.logger = o[4]
    return event
  }
  return { time: now, level: fallbackLevel, message: line, stream, format: 'plain' }
}

/**
 * Incremental parser for one output stream. Feed chunks with {@link LogParser.push}; call
 * {@link LogParser.end} when the stream closes to flush a trailing partial line.
 */
export class LogParser {
  #decoder = new TextDecoder('utf-8')
  #partial = ''
  #xml: string[] | undefined
  #xmlBytes = 0
  #lastLevel: LogLevel | undefined

  constructor(
    readonly stream: LogEvent['stream'],
    private readonly onEvent: (event: LogEvent) => void,
  ) {}

  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true })
    const lines = (this.#partial + text).split('\n')
    this.#partial = lines.pop() ?? ''
    for (const line of lines) this.#line(line.endsWith('\r') ? line.slice(0, -1) : line)
    // A child writing without newlines must not grow memory without bound.
    while (this.#partial.length > MAX_PARTIAL_LINE) {
      this.#line(this.#partial.slice(0, MAX_PARTIAL_LINE))
      this.#partial = this.#partial.slice(MAX_PARTIAL_LINE)
    }
  }

  end(): void {
    const rest = this.#partial + this.#decoder.decode()
    this.#partial = ''
    if (rest !== '') this.#line(rest)
    if (this.#xml) this.#flushBrokenXml()
  }

  #emit(event: LogEvent): void {
    this.#lastLevel = event.level
    this.onEvent(event)
  }

  #flushBrokenXml(): void {
    const lines = this.#xml ?? []
    this.#xml = undefined
    this.#xmlBytes = 0
    for (const l of lines) this.#plain(l)
  }

  #plain(line: string): void {
    const fallback = this.#lastLevel && CONTINUATION.test(line) ? this.#lastLevel : undefined
    this.#emit(parsePlainLine(line, this.stream, fallback))
  }

  #line(line: string): void {
    if (this.#xml) {
      this.#xml.push(line)
      this.#xmlBytes += line.length
      if (/<\/(?:log4j:)?Event>/.test(line)) {
        const xml = this.#xml.join('\n')
        this.#xml = undefined
        this.#xmlBytes = 0
        const event = parseXmlEvent(xml, this.stream)
        if (event) this.#emit(event)
      } else if (this.#xmlBytes > MAX_XML_EVENT) {
        this.#flushBrokenXml()
      }
      return
    }
    const trimmed = line.trimStart()
    if (/^<(?:log4j:)?Event\b/.test(trimmed)) {
      if (/<\/(?:log4j:)?Event>|\/>\s*$/.test(trimmed)) {
        const event = parseXmlEvent(trimmed, this.stream)
        if (event) this.#emit(event)
        return
      }
      this.#xml = [line]
      this.#xmlBytes = line.length
      return
    }
    if (line === '') return
    this.#plain(line)
  }
}
