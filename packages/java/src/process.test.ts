import { describe, expect, it } from 'vitest'
import { probeEnv, runProcess } from './process'

describe('runProcess', () => {
  it('settles on timeout even when a grandchild keeps the output pipes open', async () => {
    const started = Date.now()
    // The background `sleep` inherits stdout/stderr, so 'close' would never fire after the kill.
    const r = await runProcess('/bin/sh', ['-c', 'sleep 30 & echo started; sleep 30'], { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.stdout).toContain('started')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('settles after the process exits even when a grandchild keeps the pipes open', async () => {
    const started = Date.now()
    const r = await runProcess('/bin/sh', ['-c', 'sleep 30 & echo done; exit 3'], { timeoutMs: 20_000 })
    expect(r).toMatchObject({ code: 3, timedOut: false })
    expect(r.stdout).toContain('done')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('settles promptly when aborted', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const pending = runProcess('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    await pending
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('probeEnv', () => {
  it('strips JVM option variables and CLASSPATH', () => {
    const env = probeEnv({ PATH: '/usr/bin', JAVA_TOOL_OPTIONS: '-Dx=1.2.3', _JAVA_OPTIONS: '-Xmx1g', JDK_JAVA_OPTIONS: '-v', CLASSPATH: '/tmp', JAVA_OPTIONS: '-x' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
