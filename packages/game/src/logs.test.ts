import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_LOGS } from './__fixtures__/helpers'
import { LogParser, parsePlainLine, parseXmlEvent, type LogEvent } from './logs'

function parseAll(text: string | Uint8Array, chunkSize = Infinity, stream: LogEvent['stream'] = 'stdout'): LogEvent[] {
  const events: LogEvent[] = []
  const p = new LogParser(stream, (e) => events.push(e))
  const bytes = typeof text === 'string' ? Buffer.from(text) : text
  for (let i = 0; i < bytes.length; i += Math.min(chunkSize, bytes.length)) p.push(bytes.subarray(i, i + chunkSize))
  p.end()
  return events
}

describe('log4j XML output (real output of Mojang configs)', () => {
  for (const file of ['log4j-xml-1.7.txt', 'log4j-xml-1.21.txt']) {
    it(`parses ${file}, whole and in 7-byte chunks`, async () => {
      const text = await readFile(path.join(FIXTURE_LOGS, file))
      for (const size of [Infinity, 7]) {
        const events = parseAll(text, size)
        const xml = events.filter((e) => e.format === 'xml')
        expect(xml.map((e) => [e.level, e.thread, e.logger, e.message])).toEqual([
          ['INFO', 'main', 'net.minecraft.client.Minecraft', 'Setting user: Steve'],
          ['WARN', 'Render thread', 'ekk', 'Message with <xml> & "quotes" and ]]> inside'],
          ['ERROR', 'main', 'net.minecraft.client.Minecraft', 'Something failed'],
          ['INFO', 'main', 'net.minecraft.client.Minecraft', 'LWJGL Version: 3.3.3+5'],
        ])
        expect(xml[0]?.time).toBeGreaterThan(1_700_000_000_000)
        expect(xml[2]?.throwable).toBe('java.lang.RuntimeException: boom\n\tat LogDemo.main(LogDemo.java:11)')
        expect(events.at(-1)).toMatchObject({ format: 'plain', message: 'plain stdout line', level: 'INFO' })
      }
    })
  }

  it('parses log4j 2 XmlLayout events and entity-escaped messages', () => {
    const e = parseXmlEvent('<Event timeMillis="1000" thread="main" level="DEBUG" loggerName="a.B"><Message>x &lt; y &amp;&#65;</Message></Event>')
    expect(e).toMatchObject({ time: 1000, level: 'DEBUG', thread: 'main', logger: 'a.B', message: 'x < y &A' })
  })

  it('does not lose text after an unterminated event', () => {
    const events = parseAll('<log4j:Event logger="x" timestamp="1" level="INFO" thread="t">\n  <log4j:Message><![CDATA[cut')
    expect(events.map((e) => e.message)).toEqual(['<log4j:Event logger="x" timestamp="1" level="INFO" thread="t">', '  <log4j:Message><![CDATA[cut'])
  })
})

describe('plain lines', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime()
  it('parses vanilla, Forge and Fabric console formats', () => {
    expect(parsePlainLine('[11:59:58] [Render thread/WARN]: Something odd', 'stdout', undefined, now)).toMatchObject({
      time: new Date(2026, 9, 24, 11, 59, 58).getTime(),
      level: 'WARN',
      thread: 'Render thread',
      message: 'Something odd',
    })
    expect(parsePlainLine('[11:59:58] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running', 'stdout', undefined, now)).toMatchObject({
      level: 'INFO',
      thread: 'main',
      logger: 'cpw.mods.modlauncher.Launcher',
      message: 'ModLauncher running',
    })
    expect(parsePlainLine('[11:59:58] [main/INFO] (FabricLoader/GameProvider) Loading Minecraft 1.21', 'stdout', undefined, now)).toMatchObject({
      logger: 'FabricLoader',
      message: 'Loading Minecraft 1.21',
    })
    expect(parsePlainLine('2013-09-19 18:05:23 [SEVERE] Unable to launch', 'stdout', undefined, now)).toMatchObject({ level: 'ERROR', message: 'Unable to launch' })
    // A time later than now belongs to yesterday.
    expect(parsePlainLine('[23:59:59] [main/INFO]: late', 'stdout', undefined, now).time).toBe(new Date(2026, 9, 23, 23, 59, 59).getTime())
  })

  it('passes raw text through and keeps stack traces at the level of their header', () => {
    const events = parseAll('Exception in thread "main" java.lang.UnsatisfiedLinkError: boom\r\n\tat a.b(C.java:1)\nhello\n', Infinity, 'stderr')
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ['WARN', 'Exception in thread "main" java.lang.UnsatisfiedLinkError: boom'],
      ['WARN', '\tat a.b(C.java:1)'],
      ['WARN', 'hello'],
    ])
    const out = parseAll('[10:00:00] [main/ERROR]: failed\n\tat x.y(Z.java:2)\n')
    expect(out.map((e) => e.level)).toEqual(['ERROR', 'ERROR'])
  })

  it('decodes UTF-8 split across chunks', () => {
    const bytes = Buffer.from('[10:00:00] [main/INFO]: héllo — 世界\n')
    expect(parseAll(bytes, 1)[0]?.message).toBe('héllo — 世界')
  })
})
