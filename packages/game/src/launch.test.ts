import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/helpers'
import { launch, type LaunchProcessOptions } from './launch'
import type { LogEvent } from './logs'

let root: string
let cleanup: () => Promise<void>
beforeEach(async () => ({ dir: root, cleanup } = await tempDir()))
afterEach(() => cleanup())

/** A fake game: `node -e <script>` with the instance directory as cwd. */
const fake = (script: string, opts: LaunchProcessOptions = {}) =>
  launch({ java: process.execPath, args: ['-e', script], cwd: path.join(root, 'game'), env: { PATH: process.env.PATH ?? '' } }, opts)

const xml = (level: string, msg: string) =>
  `<log4j:Event logger="net.minecraft.client.Minecraft" timestamp="${Date.now()}" level="${level}" thread="Render thread">\\n  <log4j:Message><![CDATA[${msg}]]></log4j:Message>\\n</log4j:Event>\\n`

describe('launch', () => {
  it('streams batched structured events and detects readiness per line', async () => {
    const batches: LogEvent[][] = []
    let readyCalls = 0
    // The ready marker is split across two writes; chunk-based matching would miss it.
    const game = await fake(
      `process.stdout.write('${xml('INFO', 'Setting user: Steve')}'); process.stdout.write('[12:00:00] [Render thread/INFO]: LWJGL Ver'); setTimeout(() => { process.stdout.write('sion: 3.3.3\\n'); console.error('warn line'); }, 50)`,
      { onLog: (b) => batches.push(b), onReady: () => readyCalls++, batchMs: 20 },
    )
    expect(game.pid).toBeGreaterThan(0)
    const r = await game.exited
    expect(r).toMatchObject({ exitCode: 0, signal: null, crashed: false, killed: false, ready: true })
    expect(readyCalls).toBe(1)
    const events = batches.flat()
    expect(events.map((e) => [e.stream, e.format, e.level, e.message])).toEqual([
      ['stdout', 'xml', 'INFO', 'Setting user: Steve'],
      ['stdout', 'plain', 'INFO', 'LWJGL Version: 3.3.3'],
      ['stderr', 'plain', 'WARN', 'warn line'],
    ])
    expect(batches.length).toBeLessThan(events.length + 1)
  })

  it('finds the crash report the game announces', async () => {
    const script = `
      const fs = require('fs');
      fs.mkdirSync('crash-reports', { recursive: true });
      const p = require('path').resolve('crash-reports/crash-2026-10-24_12.00.00-client.txt');
      fs.writeFileSync(p, '---- Minecraft Crash Report ----');
      console.log('---- Minecraft Crash Report ----');
      console.log('#@!@# Game crashed! Crash report saved to: #@!@# ' + p);
      process.exit(255);`
    const r = await (await fake(script)).exited
    expect(r.exitCode).toBe(255)
    expect(r.crashed).toBe(true)
    expect(r.crashReportPath).toBe(path.join(root, 'game', 'crash-reports', 'crash-2026-10-24_12.00.00-client.txt'))
  })

  it('looks for new crash reports and hs_err_pid logs after an abnormal exit', async () => {
    // A stale report from before the launch must not be picked.
    await mkdir(path.join(root, 'game', 'crash-reports'), { recursive: true })
    const stale = path.join(root, 'game', 'crash-reports', 'crash-old-client.txt')
    await writeFile(stale, 'old')
    const { utimes } = await import('node:fs/promises')
    await utimes(stale, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const script = `
      const fs = require('fs');
      fs.writeFileSync('crash-reports/crash-new-client.txt', 'x');
      fs.writeFileSync('hs_err_pid' + process.pid + '.log', '#');
      console.error('java.lang.UnsatisfiedLinkError: /x/liblwjgl.dylib: (mach-o file, but is an incompatible architecture (have x86_64, need arm64))');
      process.exit(1);`
    const r = await (await fake(script)).exited
    expect(r).toMatchObject({ exitCode: 1, crashed: true, nativeLoadError: 'architecture' })
    expect(r.crashReportPath).toBe(path.join(root, 'game', 'crash-reports', 'crash-new-client.txt'))
    expect(r.hsErrPath).toMatch(/hs_err_pid\d+\.log$/)
  })

  it('stops gracefully with SIGTERM', async () => {
    const game = await fake(`setInterval(() => {}, 1000); console.log('up')`)
    const r = await game.kill(5000)
    expect(r).toMatchObject({ signal: 'SIGTERM', killed: true, crashed: false })
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const game = await fake(`process.on('SIGTERM', () => console.log('ignored')); setInterval(() => {}, 1000); console.log('up')`, { readyFallbackMs: 0 })
    // Let the child install its handler.
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    const r = await game.kill(200)
    expect(r).toMatchObject({ signal: 'SIGKILL', killed: true, crashed: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('kills a detached process group through the abort signal', async () => {
    const c = new AbortController()
    const game = await fake(`setInterval(() => {}, 1000)`, { signal: c.signal, detached: true })
    c.abort()
    const r = await game.exited
    expect(r).toMatchObject({ killed: true, signal: 'SIGTERM', crashed: false })
  })

  it('maps spawn failures to typed errors', async () => {
    await expect(launch({ java: path.join(root, 'no-java'), args: [], cwd: path.join(root, 'g'), env: {} })).rejects.toMatchObject({ code: 'ELAUNCH_JAVA_NOT_FOUND' })
    const notExec = path.join(root, 'java')
    await writeFile(notExec, '#!/bin/sh\n', { mode: 0o644 })
    await expect(launch({ java: notExec, args: [], cwd: path.join(root, 'g'), env: {} })).rejects.toMatchObject({ code: 'ELAUNCH_JAVA_PERMISSION' })
  })

  it('passes arguments verbatim, without a shell', async () => {
    const lines: string[] = []
    const tricky = ['$HOME', '`id`', '"q"', "'s'", 'a b', '${clientid}']
    const r = await (
      await launch(
        { java: process.execPath, args: ['-e', 'for (const a of process.argv.slice(1)) console.log(a)', ...tricky], cwd: path.join(root, 'g'), env: {} },
        { onLog: (b) => lines.push(...b.map((e) => e.message)) },
      )
    ).exited
    expect(r.exitCode).toBe(0)
    expect(lines).toEqual(tricky)
  })
})
